/*
 * SimAudio — shared sound for both monitors.
 *
 * Reliability on phones and tablets:
 *  - iOS and Android only allow sound that was started from a tap. The audio context is
 *    created/resumed inside the power-on tap, and again on EVERY later touch, click or key,
 *    so a context the system suspended (screen lock, phone call, app switch) recovers on the
 *    next touch instead of staying silent.
 *  - When the page becomes visible again it tries to resume on its own; if the browser
 *    refuses, onBlockedChange() tells the page to show a "tap for sound" hint.
 *  - On iOS the audio session is set to "playback" (or a silent media element is played once),
 *    so alarms are heard even with the ringer switch on silent.
 *  - Every sound is scheduled on the audio clock, never with setTimeout, so pulses keep their
 *    timing even when the page is busy.
 *
 * Alarm sounds follow IEC 60601-1-8 (auditory alarm signals):
 *  - HIGH:   10 pulses per burst in two groups of five (x-x-x--x-x ... x-x-x--x-x), pulse 75–200 ms
 *  - MEDIUM: 3 pulses per burst, pulse 125–250 ms
 *  - LOW:    2 pulses per burst, repeating no more often than every 15 s
 *  - each pulse: fundamental 150–1000 Hz with 4+ harmonics within ±15 dB, rise 10–20 % of pulse
 *  - high is louder than medium, medium louder than low
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory(null);
    else root.SimAudio = factory(root);
}(typeof self !== 'undefined' ? self : this, function (win) {
    'use strict';

    // ---------------- IEC 60601-1-8 burst patterns (all times in seconds) ----------------
    // HIGH: pulse td = 0.10 s, gap x = 0.08 s.
    //   3rd->4th gap = 2x + td = 0.26 s; 5th->6th gap = 0.40 s (0.35–1.30); interburst 2.6 s (2.5–15)
    // MEDIUM: td = 0.18 s, gap y = 0.15 s; interburst 4.0 s (2.5–30)
    // LOW: td = 0.18 s, gap 0.15 s; interburst 16 s (> 15)
    var PATTERNS = {
        high:   { td: 0.10, starts: [0, 0.18, 0.36, 0.72, 0.90, 1.40, 1.58, 1.76, 2.12, 2.30], interburst: 2.6, level: 1.0 },
        medium: { td: 0.18, starts: [0, 0.33, 0.66], interburst: 4.0, level: 0.6 },   // ~4.4 dB below high
        low:    { td: 0.18, starts: [0, 0.33], interburst: 16, level: 0.38 }          // ~4 dB below medium
    };
    Object.keys(PATTERNS).forEach(function (k) {
        var p = PATTERNS[k]; p.duration = p.starts[p.starts.length - 1] + p.td;
    });
    var ALARM_F0 = 523.25;                          // C5 fundamental
    var ALARM_HARMONICS = [1, 0.5, 0.35, 0.25, 0.2]; // f0..5f0: -6, -9, -12, -14 dB re fundamental
    var QRS_HARMONICS = [1, 0.3];                   // 2nd harmonic keeps low pitches audible on phone speakers

    // QRS/pulse tone pitch falls as SpO2 falls: one semitone per 1 % below 100 % (880 Hz at 100 %).
    // null = no valid saturation -> neutral fixed pitch.
    function qrsPitch(spo2) {
        if (spo2 == null || isNaN(spo2)) return 660;
        var s = Math.max(60, Math.min(100, spo2));
        return 880 * Math.pow(2, -(100 - s) / 12);
    }

    // In Node (tests) only the pure data is exported
    if (!win) return { PATTERNS: PATTERNS, ALARM_F0: ALARM_F0, ALARM_HARMONICS: ALARM_HARMONICS, qrsPitch: qrsPitch };

    var AC = win.AudioContext || win.webkitAudioContext;
    var ctx = null, master = null, alarmBus = null, qrsBus = null, limiter = null;
    var alarmWave = null, qrsWave = null;
    var vol = { master: 0.5, qrs: 0.5, alarm: 0.5 };
    var alarm = { priority: 'none', nextBurst: 0, nodes: [] };
    var blocked = true, blockedListeners = [];
    var silentEl = null, sessionSet = false;

    function setBlocked(b) {
        if (b === blocked) return;
        blocked = b;
        blockedListeners.forEach(function (fn) { try { fn(b); } catch (e) { } });
    }

    function build() {
        ctx = new AC();
        limiter = ctx.createDynamicsCompressor();   // keeps alarms + beeps from clipping
        limiter.threshold.value = -6; limiter.ratio.value = 12; limiter.attack.value = 0.003; limiter.release.value = 0.1;
        master = ctx.createGain(); master.gain.value = vol.master;
        alarmBus = ctx.createGain(); alarmBus.gain.value = vol.alarm;
        qrsBus = ctx.createGain(); qrsBus.gain.value = vol.qrs;
        alarmBus.connect(master); qrsBus.connect(master); master.connect(limiter); limiter.connect(ctx.destination);
        alarmWave = periodicWave(ALARM_HARMONICS);
        qrsWave = periodicWave(QRS_HARMONICS);
        ctx.onstatechange = function () { setBlocked(ctx.state !== 'running'); };
        alarm.nextBurst = 0;
    }

    function periodicWave(h) {
        var real = new Float32Array(h.length + 1), imag = new Float32Array(h.length + 1);
        for (var i = 0; i < h.length; i++) imag[i + 1] = h[i];
        return ctx.createPeriodicWave(real, imag);
    }

    // Tiny silent WAV, played once in a tap: moves iOS Safari to the "playback" audio session
    // so sound is not muted by the ringer switch (fallback when navigator.audioSession is missing).
    function silentWavUrl() {
        var n = 800, b = new Uint8Array(44 + n), dv = new DataView(b.buffer);
        function str(o, s) { for (var i = 0; i < s.length; i++) b[o + i] = s.charCodeAt(i); }
        str(0, 'RIFF'); dv.setUint32(4, 36 + n, true); str(8, 'WAVEfmt '); dv.setUint32(16, 16, true);
        dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); dv.setUint32(24, 8000, true); dv.setUint32(28, 8000, true);
        dv.setUint16(32, 1, true); dv.setUint16(34, 8, true); str(36, 'data'); dv.setUint32(40, n, true);
        for (var i = 44; i < b.length; i++) b[i] = 128;
        var s = ''; for (var j = 0; j < b.length; j++) s += String.fromCharCode(b[j]);
        return 'data:audio/wav;base64,' + win.btoa(s);
    }

    function setPlaybackSession() {
        if (sessionSet) return;
        sessionSet = true;
        try {
            if (win.navigator.audioSession) { win.navigator.audioSession.type = 'playback'; return; }
        } catch (e) { }
        try {
            silentEl = win.document.createElement('audio');
            silentEl.setAttribute('playsinline', ''); silentEl.setAttribute('x-webkit-airplay', 'deny');
            silentEl.preload = 'auto'; silentEl.src = silentWavUrl();
            var p = silentEl.play(); if (p && p.catch) p.catch(function () { });
        } catch (e) { }
    }

    /** Call from inside a user gesture (tap/click/key). Safe to call often. */
    function unlock() {
        if (!AC) return;
        setPlaybackSession();
        if (!ctx) build();
        if (ctx.state !== 'running') {
            var p = ctx.resume();
            if (p && p.then) p.then(function () { setBlocked(ctx.state !== 'running'); }, function () { });
        }
        // A one-sample silent buffer started inside the gesture "kicks" WebKit's output
        try {
            var buf = ctx.createBuffer(1, 1, 22050), src = ctx.createBufferSource();
            src.buffer = buf; src.connect(ctx.destination); src.start(0);
        } catch (e) { }
        setBlocked(ctx.state !== 'running');
    }

    /** Resume without a gesture (works on desktop/Android, may be refused on iOS). */
    function tryResume() {
        if (!ctx || ctx.state === 'running' || ctx.state === 'closed') return;
        var p = ctx.resume();
        if (p && p.then) p.then(function () { setBlocked(ctx.state !== 'running'); }, function () { setBlocked(true); });
    }

    function running() { return !!ctx && ctx.state === 'running'; }

    // ---------------- sounds ----------------
    function tone(bus, wave, freq, t, dur, level, rise, fall) {
        var o = ctx.createOscillator(), g = ctx.createGain();
        o.setPeriodicWave(wave);
        o.frequency.setValueAtTime(freq, t);
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(level, t + rise);
        g.gain.setValueAtTime(level, t + Math.max(rise, dur - fall));
        g.gain.linearRampToValueAtTime(0, t + dur);
        o.connect(g); g.connect(bus);
        o.start(t); o.stop(t + dur + 0.02);
        o.onended = function () { try { g.disconnect(); } catch (e) { } };
        return o;
    }

    /** QRS / pulse beep. spo2: valid saturation (pitch follows it) or null. */
    function beep(spo2) {
        if (!running() || vol.qrs <= 0) return;
        var t = ctx.currentTime + 0.005;
        var o = ctx.createOscillator(), g = ctx.createGain();
        o.setPeriodicWave(qrsWave);
        o.frequency.setValueAtTime(qrsPitch(spo2), t);
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(0.35, t + 0.005);
        g.gain.setTargetAtTime(0, t + 0.04, 0.025);    // short "blip", ~100 ms audible
        o.connect(g); g.connect(qrsBus);
        o.start(t); o.stop(t + 0.16);
        o.onended = function () { try { g.disconnect(); } catch (e) { } };
    }

    /** Defibrillator discharge: a short broadband thump (audible on small speakers). */
    function shock() {
        if (!running()) return;
        var t = ctx.currentTime + 0.005, len = Math.floor(ctx.sampleRate * 0.35);
        var buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
        for (var i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (ctx.sampleRate * 0.06));
        var src = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
        src.buffer = buf; f.type = 'bandpass'; f.frequency.value = 900; f.Q.value = 0.7; g.gain.value = 0.9;
        src.connect(f); f.connect(g); g.connect(master);
        src.start(t);
    }

    // ---------------- alarm sequencer ----------------
    function scheduleBurst(p, t0) {
        var pat = PATTERNS[p];
        var rise = 0.15 * pat.td, fall = 0.15 * pat.td;   // rise time 10–20 % of pulse duration
        for (var i = 0; i < pat.starts.length; i++) {
            alarm.nodes.push({ t: t0 + pat.starts[i], node: tone(alarmBus, alarmWave, ALARM_F0, t0 + pat.starts[i], pat.td, 0.5 * pat.level, rise, fall) });
        }
    }

    function cancelScheduled() {
        var now = ctx ? ctx.currentTime : 0;
        alarm.nodes.forEach(function (n) { if (n.t > now) { try { n.node.stop(); } catch (e) { } } });
        alarm.nodes = [];
    }

    /** Set the active alarm priority: 'high' | 'medium' | 'low' | 'none' (none also = audio paused). */
    function setAlarm(priority) {
        if (!PATTERNS[priority]) priority = 'none';
        if (priority === alarm.priority) return;
        // Escalation or change: drop what's queued and start the new pattern right away
        cancelScheduled();
        alarm.priority = priority;
        alarm.nextBurst = 0;
        tick();
    }

    function tick() {
        if (!running()) return;
        var now = ctx.currentTime;
        alarm.nodes = alarm.nodes.filter(function (n) { return n.t > now - 1; });
        if (alarm.priority === 'none' || vol.alarm <= 0) return;
        var pat = PATTERNS[alarm.priority];
        if (alarm.nextBurst < now + 0.03) alarm.nextBurst = Math.max(alarm.nextBurst, now + 0.05);
        while (alarm.nextBurst < now + 0.25) {          // schedule a little ahead on the audio clock
            scheduleBurst(alarm.priority, alarm.nextBurst);
            alarm.nextBurst += pat.duration + pat.interburst;
        }
    }

    /** Single quiet pulse: optional IEC "reminder signal" while alarm audio is paused. */
    function reminder() {
        if (!running() || vol.alarm <= 0) return;
        var td = PATTERNS.low.td;
        tone(alarmBus, alarmWave, ALARM_F0, ctx.currentTime + 0.01, td, 0.5 * PATTERNS.low.level, 0.15 * td, 0.15 * td);
    }

    // ---------------- volumes (0..1) ----------------
    function ramp(node, v) { if (node && ctx) node.gain.setTargetAtTime(v, ctx.currentTime, 0.02); }
    function setMasterVolume(v) { vol.master = Math.max(0, Math.min(1, v)); ramp(master, vol.master); }
    function setQrsVolume(v) { vol.qrs = Math.max(0, Math.min(1, v)); ramp(qrsBus, vol.qrs); }
    function setAlarmVolume(v) { vol.alarm = Math.max(0, Math.min(1, v)); ramp(alarmBus, vol.alarm); }

    // ---------------- lifecycle ----------------
    var started = false;
    function init() {
        if (started) return; started = true;
        // Every interaction re-unlocks: recovers from iOS/Android suspending the audio
        ['pointerdown', 'touchend', 'mousedown', 'keydown'].forEach(function (ev) {
            win.document.addEventListener(ev, unlock, { capture: true, passive: true });
        });
        win.document.addEventListener('visibilitychange', function () {
            if (win.document.visibilityState === 'visible') {
                tryResume();
                // if the browser still refuses after a moment, the page will ask for a tap
                win.setTimeout(function () { setBlocked(!running()); }, 400);
            }
        });
        win.setInterval(function () {
            if (ctx && ctx.state !== 'running' && win.document.visibilityState === 'visible') tryResume();
            tick();
        }, 100);
    }

    return {
        init: init, unlock: unlock, isRunning: running,
        isBlocked: function () { return blocked; },
        onBlockedChange: function (fn) { blockedListeners.push(fn); },
        beep: beep, shock: shock, reminder: reminder, setAlarm: setAlarm, tick: tick,
        setMasterVolume: setMasterVolume, setQrsVolume: setQrsVolume, setAlarmVolume: setAlarmVolume,
        getVolumes: function () { return { master: vol.master, qrs: vol.qrs, alarm: vol.alarm }; },
        PATTERNS: PATTERNS, ALARM_F0: ALARM_F0, ALARM_HARMONICS: ALARM_HARMONICS, qrsPitch: qrsPitch,
        _ctx: function () { return ctx; }   // for tests
    };
}));
