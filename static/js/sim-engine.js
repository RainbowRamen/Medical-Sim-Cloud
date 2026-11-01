/*
 * SimEngine — physiology and signal generation for the patient monitor simulator.
 *
 * Everything is driven by time (milliseconds of simulation clock), never by frame rate.
 * The heart is modelled in three layers, the way a real monitor "sees" it:
 *   - atrial activity    : P waves (sinus / independent), flutter sawtooth, fibrillation f-waves
 *   - ventricular events : QRS + T complexes with rhythm-specific morphology
 *   - mechanical beats   : each ventricular event may eject blood (pulse strength 0..1),
 *                          which drives the pleth and the arterial pressure (ABP)
 * Breathing drives the impedance respiration wave and the capnogram.
 *
 * Signals are computed at 250 Hz into ring buffers that the renderer draws from.
 * No DOM access: runs in the browser (window.SimEngine) and in Node for tests.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.SimEngine = factory();
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    var STEP = 4;          // ms per sample (250 Hz)
    var BUF = 4096;        // ring buffer length in samples (~16 s)
    var LOOKAHEAD = 1000;  // schedule cardiac/breath events this far ahead (ms) — enough for P waves before each QRS
    var EJECT_DELAY = 180; // R peak -> arterial upstroke at the radial artery (ms)
    var PLETH_DELAY = 250; // R peak -> start of finger pleth pulse (ms)
    var PV = 15;           // arterial pressure with no circulation (mmHg)

    // ------------------------------------------------------------------
    // Rhythm library. Shared with the controller for defaults and labels.
    // rate: default rate the controller snaps to (null = not applicable)
    // pulse: whether the rhythm perfuses by default
    // ------------------------------------------------------------------
    var RHYTHMS = {
        nsr:             { name: 'Normal Sinus Rhythm', short: 'NSR', mode: 'sinus', rate: 75, pulse: true,
                           desc: 'Regular, P before every QRS, PR 0.12–0.20 s, narrow QRS.' },
        svt:             { name: 'Supraventricular Tachycardia', short: 'SVT', mode: 'regular', kind: 'narrow', rate: 180, pulse: true,
                           desc: 'Regular narrow-complex tachycardia, P waves not visible.' },
        afib:            { name: 'Atrial Fibrillation', short: 'A-FIB', mode: 'fib', rate: 110, pulse: true, abpComp: { pp: 0.9, tau: 1.4 },
                           desc: 'Irregularly irregular, no P waves, fibrillatory baseline. Pulse varies beat to beat (pulse deficit).' },
        aflutter:        { name: 'Atrial Flutter', short: 'A-FLUTTER', mode: 'flutter', rate: 150, pulse: true,
                           desc: 'Sawtooth flutter waves ~300/min with fixed block (2:1 at 150, 4:1 at 75).' },
        junctional:      { name: 'Junctional Rhythm', short: 'JUNCTIONAL', mode: 'regular', kind: 'junctional', rate: 50, pulse: true,
                           desc: 'Narrow QRS, inverted P just before the QRS, rate 40–60.' },
        avb1:            { name: '1st Degree AV Block', short: 'AVB 1°', mode: 'sinus', rate: 70, pulse: true,
                           desc: 'PR > 0.20 s (here ~0.32 s), every P conducted.' },
        avb2_type1:      { name: '2nd Degree AV Block Type I (Wenckebach)', short: 'AVB 2° T1', mode: 'sinus', rate: 75, pulse: true, vRatio: 0.75,
                           desc: 'PR lengthens beat by beat until a P is not conducted (4:3). Rate set = atrial rate.' },
        avb2_type2:      { name: '2nd Degree AV Block Type II (Mobitz II)', short: 'AVB 2° T2', mode: 'sinus', rate: 75, pulse: true, vRatio: 0.75,
                           desc: 'Constant PR with a sudden non-conducted P (4:3). Rate set = atrial rate.' },
        avb3:            { name: '3rd Degree (Complete) Heart Block', short: 'AVB 3°', mode: 'chb', rate: 35, pulse: true, critical: true,
                           desc: 'P waves (~75/min) and wide escape complexes march independently. Rate set = ventricular rate.' },
        vt:              { name: 'Ventricular Tachycardia', short: 'V-TACH', mode: 'regular', kind: 'vt', rate: 180, pulse: false, critical: true,
                           desc: 'Wide, regular, monomorphic. Can be with or without a pulse — set Pulse accordingly.' },
        vf:              { name: 'Ventricular Fibrillation', short: 'V-FIB', mode: 'vf', rate: null, pulse: false, critical: true,
                           desc: 'Chaotic, no QRS complexes, no output.' },
        asystole:        { name: 'Asystole', short: 'ASYSTOLE', mode: 'none', rate: 0, pulse: false, critical: true,
                           desc: 'No electrical activity. Check leads and gain.' },
        pea:             { name: 'Pulseless Electrical Activity', short: 'P.E.A', mode: 'sinus', rate: 50, pulse: false, critical: true,
                           desc: 'Organised electrical activity without a pulse: no pleth, flat arterial line.' },
        idioventricular: { name: 'Idioventricular Rhythm', short: 'IDIOVENT', mode: 'regular', kind: 'wide', rate: 35, pulse: true, critical: true,
                           desc: 'Wide QRS, no P waves, rate 20–40.' },
        agonal:          { name: 'Agonal Rhythm', short: 'AGONAL', mode: 'irregular', kind: 'agonal', rate: 18, pulse: false, critical: true,
                           desc: 'Slow, irregular, broad bizarre complexes of falling amplitude. Usually pulseless.' }
    };

    // Rhythms that can carry PVCs when ectopics are switched on
    var ECTOPIC_MODES = { sinus: true, fib: true };

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------
    function mulberry32(a) {
        return function () {
            a |= 0; a = a + 0x6D2B79F5 | 0;
            var t = Math.imul(a ^ a >>> 15, 1 | a);
            t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
            return ((t ^ t >>> 14) >>> 0) / 4294967296;
        };
    }
    function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }
    // Asymmetric Gaussian bump
    function bump(t, mu, s1, s2) { var x = (t - mu) / (t < mu ? s1 : s2); return Math.exp(-0.5 * x * x); }
    // QT shortens with heart rate (Bazett), bounded to sensible limits
    function qtFor(rr) { return clamp(400 * Math.sqrt(rr / 1000), 240, 480); }
    // Left-ventricular ejection time shortens with heart rate (Weissler)
    function lvetFor(rr) { return clamp(413 - 1.7 * (60000 / rr), 150, 330); }
    // Frank–Starling: a longer filling time gives a bigger beat (normalised to 1 at ~75 bpm)
    function fillFactor(rr) { return clamp((1 - Math.exp(-rr / 400)) / (1 - Math.exp(-800 / 400)), 0.15, 1.25); }

    // Radial arterial pulse for one beat, 0 = foot of the upstroke, 1 = systolic peak.
    // Fast upstroke, sharp peak, fall to the dicrotic notch at end-ejection (L), dicrotic wave.
    var NOTCH = 0.42;      // notch height as a fraction of pulse pressure
    var SYS_WIN = 90;      // ms after end-ejection before pure diastolic run-off takes over
    function arterialShape(x, L) {
        var tp = clamp(0.3 * L, 70, 110), base;
        if (x <= 0) base = 0;
        else if (x < tp) base = 1 - Math.pow(1 - x / tp, 2.2);
        else if (x < L) base = 1 - (1 - NOTCH) * (1 - Math.pow(1 - (x - tp) / (L - tp), 1.6));
        else base = NOTCH;
        return base - 0.06 * bump(x, L + 6, 9, 12) + 0.07 * bump(x, L + 42, 18, 26);
    }

    // QRS-T complex templates: [amplitude mV, offset from R ms, left sigma, right sigma]
    function complexFor(kind, rr, polarity) {
        var qt = qtFor(rr), tp = 0.82 * qt - 40;
        switch (kind) {
            case 'junctional':
                return [[-0.12, -62, 13, 13], [-0.12, -28, 9, 9], [1.25, 0, 9, 11], [-0.32, 26, 10, 10], [0.30, tp, 0.13 * qt, 0.075 * qt]];
            case 'wide':
                return [[1.05, 0, 24, 34], [-0.55, 75, 28, 32], [-0.38, tp + 30, 0.14 * qt, 0.09 * qt]];
            case 'vt':
                return [[1.4, 0, 30, 36], [-0.9, 82, 32, 34], [-0.35, tp + 20, 0.13 * qt, 0.09 * qt]];
            case 'pvc':
                return polarity > 0
                    ? [[1.6, 0, 22, 30], [-0.75, 72, 26, 30], [-0.5, tp + 25, 0.14 * qt, 0.09 * qt]]
                    : [[0.22, -40, 14, 14], [-1.45, 30, 30, 32], [0.5, tp + 35, 0.14 * qt, 0.09 * qt]];
            case 'agonal':
                return [[0.75, 0, 45, 65], [-0.38, 125, 50, 60], [-0.2, tp + 70, 0.16 * qt, 0.12 * qt]];
            default: // narrow (normal conduction), lead II
                return [[-0.12, -28, 9, 9], [1.25, 0, 9, 11], [-0.32, 26, 10, 10], [0.32, tp, 0.13 * qt, 0.075 * qt]];
        }
    }
    // Mechanical efficiency of each beat type (before filling-time effects)
    var KIND_OUTPUT = { narrow: 1, junctional: 0.95, wide: 0.8, vt: 0.5, pvc: 0.35, agonal: 0.3 };

    // ------------------------------------------------------------------
    // Engine
    // ------------------------------------------------------------------
    function Engine(opts) {
        opts = opts || {};
        this.rand = opts.seed != null ? mulberry32(opts.seed) : Math.random;
        this.p = {
            rhythm: 'nsr', rate: 75, pulse: true,
            ectopic: false, ectopicFreq: 'medium',
            artifact: 'normal', resp: 16, etco2: 35, co2Shape: 'normal',
            sys: 120, dia: 80, cpr: false
        };
        if (opts.params) this._assign(opts.params);

        this.tComputed = 0;   // time of the last computed sample
        this.now = 0;         // simulation clock
        this.sampleCount = 0; // samples written so far (sample i is at time i*STEP)
        this.buf = {};
        var self = this;
        ['ecg', 'pleth', 'abp', 'resp', 'co2'].forEach(function (k) { self.buf[k] = new Float32Array(BUF); });

        // event lists
        this.vEvents = []; this.aEvents = []; this.breaths = []; this.compressions = [];
        this.plethPulses = [];
        // detected timings
        this.rTimes = []; this.prTimes = []; this.beatQueue = []; this.pulseQueue = [];
        this.lastPerfusing = -1e9;

        this._resetCardiacSchedule(0);
        this.nextBreath = 500; this.breathSched = 0;
        this.nextCompression = 0;
        this.pvcPolarity = this.rand() < 0.5 ? 1 : -1;
        this.pvcCountdown = this._pvcInterval();

        // continuous oscillators
        this.fPhase = 0;                    // flutter
        this.afPh = [0, 1.3, 2.1];          // fibrillation waves
        this.vfPh = [0, 0.7, 1.9];          // VF
        this.ecgLP = 0;                     // monitor bandwidth filter
        this.plethEma = 0; this.plethInit = false;
        this.circ = 1;                      // circulation (drives EtCO2 when pulseless)
        this.shockT = -1e9;
        this.co2End = 0; this.co2PeakCur = 0; this.curBreath = null; this.etco2Last = null; this.lastBreathT = -1e9;

        // arterial pressure: current beat template + exponential diastolic run-off
        this.abpBeat = null; this.decayFrom = this.p.dia; this.decayT = 0; this.tau = 1500; this.Pcur = this.p.dia;
        this.abpWin = null; this.abpDisp = null;
        this.lastEjection = -1e9;
    }

    Engine.prototype._assign = function (o) {
        for (var k in o) if (o.hasOwnProperty(k) && o[k] !== undefined && this.p.hasOwnProperty(k)) this.p[k] = o[k];
    };

    // Update parameters. A rhythm change takes effect almost immediately (the next beat).
    Engine.prototype.set = function (o) {
        var oldRhythm = this.p.rhythm, oldEct = this.p.ectopic;
        this._assign(o);
        if (!RHYTHMS[this.p.rhythm]) this.p.rhythm = 'nsr';
        if (this.p.rhythm !== oldRhythm) this._rhythmChanged();
        if (this.p.ectopic && !oldEct) this.pvcCountdown = this._pvcInterval();
    };

    Engine.prototype.shock = function () { this.shockT = this.tComputed; };

    Engine.prototype._rhythmChanged = function () {
        this.rTimes = [];                  // the monitor relearns the rate for the new rhythm
        this.rhythmChangeT = this.tComputed;
        var cut = this.tComputed + 40;
        this.vEvents = this.vEvents.filter(function (e) { return e.t <= cut; });
        this.aEvents = this.aEvents.filter(function (e) { return e.t <= cut; });
        this._resetCardiacSchedule(cut + 200);
    };

    Engine.prototype._resetCardiacSchedule = function (t0) {
        this.nextP = t0 + 100; this.nextV = t0 + 250; this.cardSched = t0;
        this.cycle = 0; this.blockNext = false; this.lastVT = null;
    };

    Engine.prototype._pvcInterval = function () {
        var r = this.rand();
        switch (this.p.ectopicFreq) {
            case 'low': return 10 + Math.floor(r * 11);
            case 'frequent': return 1 + Math.floor(r * 2);
            default: return 5 + Math.floor(r * 4);
        }
    };

    Engine.prototype._gauss = function () { // standard normal
        var u = Math.max(1e-9, this.rand()), v = this.rand();
        return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    };

    Engine.prototype._addV = function (t, kind, amp) {
        var rr = this.lastVT != null ? clamp(t - this.lastVT, 200, 4000) : 60000 / Math.max(20, this.p.rate || 60);
        this.lastVT = t;
        var base = (KIND_OUTPUT[kind] || 0.8) * fillFactor(rr);
        this.vEvents.push({ t: t, kind: kind, amp: amp || 1, rr: rr, comps: complexFor(kind, rr, this.pvcPolarity),
                            qt: qtFor(rr), base: base, lvet: lvetFor(rr), counted: false, mech: false, strength: 0 });
    };

    // Schedule cardiac events up to time `until`
    Engine.prototype._scheduleCardiac = function (until) {
        var guard = 0;
        while (this.cardSched < until && guard++ < 200) this._scheduleOne(until);
    };

    Engine.prototype._scheduleOne = function (until) {
        var R = RHYTHMS[this.p.rhythm], rate = this.p.rate, hrv = 1 + 0.03 * (this.rand() - 0.5);
        var mode = R.mode;
        if (mode === 'vf' || mode === 'none' || (!(rate > 4) && mode !== 'chb')) {
            this.cardSched = until; this.nextP = until; this.nextV = until; return;
        }
        var rr = 60000 / rate;
        if (mode === 'sinus') {
            var pc = this.nextP, pr;
            this.aEvents.push({ t: pc, amp: 0.15 });
            var k = this.cycle % 4;
            switch (this.p.rhythm) {
                case 'avb1': pr = 320; break;
                case 'avb2_type1': pr = [200, 280, 330, null][k]; break;
                case 'avb2_type2': pr = [180, 180, 180, null][k]; break;
                default: pr = 160;
            }
            if (this.blockNext) { pr = null; this.blockNext = false; } // P hidden in the PVC: not conducted
            if (pr != null) {
                var tR = pc + pr - 10;
                this._addV(tR, 'narrow');
                this._maybePVC(tR, rr * hrv, true);
            }
            this.cycle++;
            this.nextP = pc + rr * hrv;
            this.cardSched = pc;
        } else if (mode === 'chb') {
            var aRR = 60000 / 75 * (1 + 0.04 * (this.rand() - 0.5));
            if (!(rate > 4)) this.nextV = Infinity;
            if (this.nextP <= this.nextV) {
                this.aEvents.push({ t: this.nextP, amp: 0.15 });
                this.nextP += aRR;
            } else {
                this._addV(this.nextV, 'wide');
                this.nextV += rr * (1 + 0.02 * (this.rand() - 0.5));
            }
            this.cardSched = Math.min(this.nextP, this.nextV);
        } else if (mode === 'fib') {
            var t = this.nextV;
            this._addV(t, 'narrow');
            var irr = clamp(rr * Math.exp(0.22 * this._gauss()), Math.max(280, rr * 0.5), rr * 1.8);
            this._maybePVC(t, irr, false);
            this.nextV = t + irr;
            this.cardSched = t;
        } else if (mode === 'flutter') {
            // Ventricles follow every n-th flutter wave; flutter rate stays near 300/min
            var n = Math.max(2, Math.round(300 / rate));
            this.flutterCycle = rr / n;
            this._addV(this.nextV, 'narrow');
            this.cardSched = this.nextV;
            this.nextV += rr;
        } else if (mode === 'regular') {
            this._addV(this.nextV, R.kind);
            this.cardSched = this.nextV;
            this.nextV += rr * (1 + 0.015 * (this.rand() - 0.5));
        } else if (mode === 'irregular') {
            this._addV(this.nextV, R.kind, 0.55 + 0.45 * this.rand());
            this.cardSched = this.nextV;
            this.nextV += rr * (0.7 + 0.6 * this.rand());
        }
    };

    // Premature ventricular complex after the beat at tR (coupling ~60% of the cycle)
    Engine.prototype._maybePVC = function (tR, rr, compensatory) {
        if (!this.p.ectopic || !ECTOPIC_MODES[RHYTHMS[this.p.rhythm].mode]) return;
        if (--this.pvcCountdown > 0) return;
        this.pvcCountdown = this._pvcInterval();
        this._addV(tR + clamp(0.6 * rr, 300, 900), 'pvc');
        if (compensatory) this.blockNext = true; // the next sinus P falls in the refractory period
        else this.nextV = Math.max(this.nextV, tR + rr * 1.6); // AF: pause after the PVC
    };

    Engine.prototype._scheduleBreaths = function (until) {
        var guard = 0;
        while (this.breathSched < until && guard++ < 100) {
            var rr = this.p.resp;
            if (!(rr >= 1)) { this.breathSched = until; this.nextBreath = until; return; }
            var cyc = 60000 / rr;
            var b = { t: this.nextBreath, cycle: cyc, ti: Math.min(cyc / 3, 1500) };
            this.breaths.push(b);
            this.breathSched = b.t;
            this.nextBreath = b.t + cyc;
        }
    };

    // Advance the simulation clock by dt ms and compute all samples up to it
    Engine.prototype.advance = function (dt) {
        this.now += dt;
        this._scheduleCardiac(this.now + LOOKAHEAD);
        this._scheduleBreaths(this.now + LOOKAHEAD);
        while (this.tComputed + STEP <= this.now) {
            this.tComputed += STEP;
            this._computeSample(this.tComputed);
        }
        this._prune();
    };

    Engine.prototype._prune = function () {
        var old = this.tComputed - 3000;
        if (this.vEvents.length > 40) this.vEvents = this.vEvents.filter(function (e) { return e.t > old; });
        if (this.aEvents.length > 40) this.aEvents = this.aEvents.filter(function (e) { return e.t > old; });
        if (this.breaths.length > 20) this.breaths = this.breaths.filter(function (b) { return b.t + b.cycle * 2 > old; });
        if (this.compressions.length > 20) this.compressions = this.compressions.filter(function (c) { return c > old; });
        if (this.plethPulses.length > 20) this.plethPulses = this.plethPulses.filter(function (q) { return q.t > old; });
        var keep = this.tComputed - 15000;
        while (this.rTimes.length && this.rTimes[0] < keep) this.rTimes.shift();
        while (this.prTimes.length && this.prTimes[0] < keep) this.prTimes.shift();
    };

    // ------------------------------------------------------------------
    // One sample of every channel at time t
    // ------------------------------------------------------------------
    Engine.prototype._computeSample = function (t) {
        var p = this.p, R = RHYTHMS[p.rhythm], i, e;

        // --- CPR compressions (~110/min) ---
        if (p.cpr) {
            if (this.nextCompression < t - 1000) this.nextCompression = t;
            while (this.nextCompression <= t) {
                this.compressions.push(this.nextCompression);
                this.nextCompression += 545 + 20 * (this.rand() - 0.5);
            }
        }
        var comp = 0;
        for (i = this.compressions.length - 1; i >= 0; i--) {
            var cx = (t - this.compressions[i]) / 545;
            if (cx >= 0 && cx < 1) { comp = cx < 0.45 ? Math.sin(Math.PI * cx / 0.45) : 0; break; }
        }

        // --- ventricular events: count R waves, start ejections ---
        for (i = 0; i < this.vEvents.length; i++) {
            e = this.vEvents[i];
            if (!e.counted && t >= e.t) {
                e.counted = true;
                this.rTimes.push(e.t);
                this.beatQueue.push({ t: e.t, kind: e.kind });
            }
            if (!e.mech && t >= e.t + EJECT_DELAY) {
                e.mech = true;
                e.strength = p.pulse ? e.base : 0;
                if (e.strength > 0.02) {
                    this._startEjection(t, e);
                    this.plethPulses.push({ t: e.t + PLETH_DELAY, amp: e.strength, sc: clamp(Math.sqrt(e.rr / 857), 0.6, 1.25), seen: false });
                    if (e.strength > 0.3) this.lastPerfusing = t;
                }
            }
        }

        // --- ECG (lead II, mV) ---
        var ecg = 0;
        if (R.mode === 'sinus' || R.mode === 'chb') {
            for (i = 0; i < this.aEvents.length; i++) {
                e = this.aEvents[i];
                if (t > e.t - 90 && t < e.t + 90) ecg += e.amp * bump(t, e.t, 22, 22);
            }
        } else if (R.mode === 'flutter') {
            this.fPhase = (this.fPhase + STEP / (this.flutterCycle || 200)) % 1;
            var ph = this.fPhase, saw = ph < 0.8 ? -(ph / 0.8) : -1 + (ph - 0.8) / 0.2;
            ecg += 0.3 * (saw + 0.5);
        } else if (R.mode === 'fib') {
            var fb = [5.3, 6.9, 8.4], fa = [0.045, 0.035, 0.03], f = 0;
            for (i = 0; i < 3; i++) {
                this.afPh[i] += 2 * Math.PI * fb[i] * (1 + 0.15 * Math.sin(2 * Math.PI * t / (3000 + i * 1100))) * STEP / 1000;
                f += fa[i] * Math.sin(this.afPh[i]);
            }
            ecg += f * (0.8 + 0.4 * Math.sin(2 * Math.PI * t / 4100));
        } else if (R.mode === 'vf') {
            var vb = [4.3, 5.7, 7.2], va = [1, 0.6, 0.35], v = 0;
            for (i = 0; i < 3; i++) {
                this.vfPh[i] += 2 * Math.PI * vb[i] * (1 + 0.2 * Math.sin(2 * Math.PI * t / (1700 + i * 900))) * STEP / 1000;
                v += va[i] * Math.sin(this.vfPh[i]);
            }
            var amp = 0.55 * (0.6 + 0.4 * Math.sin(2 * Math.PI * t / 2700)) * (0.8 + 0.2 * Math.sin(2 * Math.PI * t / 1300));
            ecg += amp * v / 1.4;
        }
        for (i = 0; i < this.vEvents.length; i++) {
            e = this.vEvents[i];
            if (t < e.t - 120 || t > e.t + e.qt + 300) continue;
            for (var c = 0; c < e.comps.length; c++) {
                var cp = e.comps[c];
                ecg += e.amp * cp[0] * bump(t, e.t + cp[1], cp[2], cp[3]);
            }
        }
        // baseline wander with breathing, low-level noise, CPR and shock artefacts
        ecg += 0.03 * Math.sin(2 * Math.PI * t / (60000 / Math.max(6, p.resp || 12)));
        ecg += (this.rand() + this.rand() + this.rand() - 1.5) * 0.012;
        if (comp) ecg += 0.7 * (comp - 0.3);
        var ds = t - this.shockT;
        if (ds >= 0 && ds < 2500) ecg += 4 * Math.exp(-ds / 160) * Math.min(1, ds / 12) - 0.5 * Math.exp(-ds / 700) * Math.min(1, ds / 40);
        // monitor-mode bandwidth (~40 Hz) softens the sharpest corners
        this.ecgLP += 0.63 * (ecg - this.ecgLP);

        // --- breathing ---
        var br = null;
        for (i = this.breaths.length - 1; i >= 0; i--) if (this.breaths[i].t <= t) { br = this.breaths[i]; break; }
        var resp = 0, co2 = 0, bx = br ? t - br.t : 1e9;
        if (br !== this.curBreath) {          // a new breath: the previous one's peak is the EtCO2
            if (this.curBreath) this.etco2Last = this.co2PeakCur;
            this.curBreath = br; this.co2PeakCur = 0;
        }
        // circulation: CO2 only reaches the lungs if blood is moving (own pulse or CPR)
        var circTarget = (t - this.lastPerfusing < 4000) || p.cpr ? 1 : 0.1;
        this.circ += (circTarget - this.circ) * STEP / (circTarget > this.circ ? 6000 : 20000);
        var level = Math.max(0, p.etco2) * this.circ;
        if (br && bx < br.cycle * 1.3 + 2000) {
            var ti = br.ti, te = br.cycle - ti;
            if (bx < ti) resp = 0.5 - 0.5 * Math.cos(Math.PI * bx / ti);
            else resp = Math.exp(-(bx - ti) / (0.28 * te)) * (bx < br.cycle * 1.3 ? 1 : Math.exp(-(bx - br.cycle * 1.3) / 400));
            // capnogram: inspiration flushes CO2 to zero; expiration rises (phase II) to a plateau (phase III)
            if (bx < ti) co2 = this.co2End * Math.exp(-bx / 35);
            else {
                var xe = bx - ti, k = p.co2Shape === 'obstructive' ? 0.35 * te : 55;
                co2 = level * (1 - Math.exp(-xe / k)) * (1 + 0.04 * Math.min(1, xe / te));
                if (bx > br.cycle * 1.15) co2 *= Math.exp(-(bx - br.cycle * 1.15) / 700); // apnoea: sample line clears
                this.co2End = co2;
                if (co2 > this.co2PeakCur) this.co2PeakCur = co2;
            }
            if (comp) co2 += 1.5 * comp * (co2 > 2 ? 1 : 0);
        }
        this.lastBreathT = br ? br.t : -1e9;
        if (comp) resp += 0.25 * comp;

        // --- pleth (finger), arbitrary units, baseline-removed like a real monitor ---
        var perf = p.artifact === 'low_perfusion' ? 0.25 : 1;
        var respMod = 1 + 0.08 * Math.sin(2 * Math.PI * t / (60000 / Math.max(6, p.resp || 12)));
        var raw = 0;
        for (i = 0; i < this.plethPulses.length; i++) {
            var q = this.plethPulses[i], x = t - q.t, s = q.sc;
            if (x < -20 || x > 1400 * s) continue;
            raw += q.amp * (bump(x, 135 * s, 55 * s, 120 * s) + 0.3 * bump(x, 390 * s, 80 * s, 110 * s));
            if (!q.seen && x >= 135 * s) {
                q.seen = true;
                if (q.amp * perf >= 0.2) { this.prTimes.push(t); this.pulseQueue.push({ t: t, amp: q.amp }); }
            }
        }
        raw = raw * perf * respMod;
        if (comp) raw += 0.45 * comp;
        if (!this.plethInit) { this.plethEma = raw; this.plethInit = true; }
        this.plethEma += (raw - this.plethEma) * STEP / 2500;
        var pleth = raw - this.plethEma;
        if (p.artifact === 'noise') pleth += (this.rand() - 0.5) * 0.45 + (this.rand() < 0.01 ? (this.rand() - 0.5) * 1.6 : 0);
        else if (p.artifact === 'motion') pleth += 0.6 * Math.sin(2 * Math.PI * t / 900) + 0.35 * Math.sin(2 * Math.PI * t / 2300 + 1);
        if (ds >= 0 && ds < 1500) pleth += 0.8 * Math.exp(-ds / 250) * Math.sin(ds / 40);

        // --- arterial pressure (mmHg) ---
        var P, ab = this.abpBeat;
        if (ab && t - ab.t <= ab.L + SYS_WIN) {
            P = ab.start + ab.A * arterialShape(t - ab.t, ab.L);
            if (t - ab.t > ab.L + SYS_WIN - STEP) {
                this.decayFrom = P; this.decayT = t; this.abpBeat = null;
                // Diastolic run-off aimed at the set diastolic by the usual next beat, from wherever the
                // pressure actually is, so a changed target settles within a beat or two.
                var g = this.runoff;
                this.tau = P - PV > (g.dia - PV) * 1.02
                    ? clamp(g.k * g.Td / Math.log((P - PV) / (g.dia - PV)), 80, 20000)
                    : 20000; // below target: hold, the next beat lifts it
            }
        } else {
            P = PV + (this.decayFrom - PV) * Math.exp(-(t - this.decayT) / this.tau);
        }
        this.Pcur = P;
        var abp = P;
        if (comp) abp += 62 * comp;
        if (ds >= 0 && ds < 1500) abp += 6 * Math.exp(-ds / 300) * Math.sin(ds / 50);
        this._trackAbp(abp);

        // --- write ---
        var idx = this.sampleCount % BUF;
        this.buf.ecg[idx] = this.ecgLP;
        this.buf.pleth[idx] = pleth;
        this.buf.abp[idx] = abp;
        this.buf.resp[idx] = resp;
        this.buf.co2[idx] = co2;
        this.sampleCount++;
    };

    Engine.prototype._startEjection = function (t, e) {
        // close the previous beat's measurement window and self-calibrate toward the target BP
        var w = this.abpWin;
        if (w && w.n > 10) {
            var beat = { sys: w.max, dia: w.min, map: w.sum / w.n };
            this.abpDisp = this.abpDisp ? {
                sys: this.abpDisp.sys + 0.4 * (beat.sys - this.abpDisp.sys),
                dia: this.abpDisp.dia + 0.4 * (beat.dia - this.abpDisp.dia),
                map: this.abpDisp.map + 0.4 * (beat.map - this.abpDisp.map)
            } : beat;
        }
        this.abpWin = { max: -1e9, min: 1e9, sum: 0, n: 0 };
        this.lastEjection = t;

        // Size the beat so the rhythm's usual beat at the set rate gives exactly the set sys/dia.
        // Stronger/weaker beats (filling time, PVCs, AF) then vary around it naturally.
        var p = this.p, R = RHYTHMS[p.rhythm];
        // usual ventricular interval: in 2nd-degree block only 3 of 4 P waves conduct
        var rrNom = 60000 / clamp(p.rate || 60, 20, 250) / (R.vRatio || 1);
        var normKind = R.mode === 'chb' ? 'wide' : (R.kind || 'narrow');
        var norm = (KIND_OUTPUT[normKind] || 1) * fillFactor(rrNom);
        var dia = Math.max(PV + 1, p.dia), PPt = Math.max(4, p.sys - p.dia);
        // Irregular rhythms (AF): fixed compensation so the long-run average matches the set values
        var comp = R.abpComp || { pp: 1, tau: 1 };
        this.abpBeat = { t: t, L: e.lvet, start: this.Pcur, A: PPt * comp.pp * e.strength / norm };
        // Diastolic run-off target for this beat (time constant is set when diastole starts)
        var Lnom = lvetFor(rrNom);
        this.runoff = { Td: Math.max(40, rrNom - Lnom - SYS_WIN), dia: dia, k: comp.tau };
    };

    Engine.prototype._trackAbp = function (v) {
        var w = this.abpWin;
        if (!w) return;
        if (v > w.max) w.max = v;
        if (v < w.min) w.min = v;
        w.sum += v; w.n++;
    };

    // ------------------------------------------------------------------
    // Readouts
    // ------------------------------------------------------------------
    Engine.prototype.get = function (ch, sampleIndex) { return this.buf[ch][sampleIndex % BUF]; };
    Engine.prototype.oldestSample = function () { return Math.max(0, this.sampleCount - BUF + 1); };

    function rateFrom(times, now, maxIntervals, staleMs) {
        if (times.length < 2) return null;
        var last = times[times.length - 1];
        var n = Math.min(maxIntervals, times.length - 1), sum = 0, used = 0;
        for (var i = times.length - 1; i > times.length - 1 - n; i--) {
            if (times[i - 1] < now - 12000) break;
            sum += times[i] - times[i - 1]; used++;
        }
        if (!used) return null;
        var rr = sum / used;
        if (now - last > Math.max(staleMs, 2.5 * rr)) return 0;
        return 60000 / rr;
    }

    // Values a real monitor would display, derived from the signals themselves
    Engine.prototype.measured = function () {
        var t = this.tComputed, p = this.p, R = RHYTHMS[p.rhythm];
        var out = {};
        // Heart rate from counted QRS complexes. VF cannot be counted.
        if (R.mode === 'vf') out.hr = null;
        else {
            var hr = rateFrom(this.rTimes, t, 6, 6000);  // average of the last 6 beats
            var lastR = this.rTimes.length ? this.rTimes[this.rTimes.length - 1] : Math.max(-1e9, this.rhythmChangeT || -1e9);
            out.hr = hr == null ? (t - lastR > 6000 ? 0 : null) : hr;
        }
        // Pulse rate from the pleth; needs a few detected pulses
        var recent = this.prTimes.filter(function (x) { return x > t - 8000; });
        out.plethValid = recent.length >= 3 && (t - recent[recent.length - 1] < 4000);
        out.pr = out.plethValid ? rateFrom(this.prTimes, t, 6, 4000) : null;
        out.perfusing = t - this.lastPerfusing < 4000;
        // Arterial pressure: averaged beat values, or the raw window when there are no beats (arrest, CPR)
        if (this.abpDisp && t - this.lastEjection < 3000) {
            out.abpSys = this.abpDisp.sys; out.abpDia = this.abpDisp.dia; out.abpMap = this.abpDisp.map;
        } else {
            var n = Math.min(this.sampleCount, 3000 / STEP), mx = -1e9, mn = 1e9, sm = 0;
            for (var i = this.sampleCount - n; i < this.sampleCount; i++) {
                var v = this.buf.abp[i % BUF]; if (v > mx) mx = v; if (v < mn) mn = v; sm += v;
            }
            out.abpSys = n ? mx : PV; out.abpDia = n ? mn : PV; out.abpMap = n ? sm / n : PV;
        }
        // EtCO2: peak of the last breath, 0 after a long apnoea
        out.etco2 = (t - this.lastBreathT > 20000 || this.etco2Last == null) ? 0 : this.etco2Last;
        return out;
    };

    Engine.prototype.drainBeats = function () { var q = this.beatQueue; this.beatQueue = []; return q; };
    Engine.prototype.drainPulses = function () { var q = this.pulseQueue; this.pulseQueue = []; return q; };

    return { Engine: Engine, RHYTHMS: RHYTHMS, STEP: STEP, BUF: BUF };
}));
