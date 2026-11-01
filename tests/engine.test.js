// Physiology engine tests. Run with:  node tests/engine.test.js   (no dependencies)
var SimEngine = require('../static/js/sim-engine.js');
var Engine = SimEngine.Engine;

var pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) pass++; else fail++;
    console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail !== undefined ? '  [' + detail + ']' : ''));
}
function run(params, seconds, seed) {
    var e = new Engine({ seed: seed || 7, params: params });
    for (var t = 0; t < seconds * 1000; t += 16) e.advance(16);
    return e;
}
function near(a, b, tol) { return a != null && Math.abs(a - b) <= tol; }
function r1(x) { return x == null ? x : Math.round(x * 10) / 10; }
function noNaN(e) {
    for (var ch in e.buf) for (var i = 0; i < e.buf[ch].length; i++) if (!isFinite(e.buf[ch][i])) return ch;
    return null;
}
function rrList(e) { var r = []; for (var i = 1; i < e.rTimes.length; i++) r.push(e.rTimes[i] - e.rTimes[i - 1]); return r; }
function cv(a) { var m = a.reduce(function (s, x) { return s + x; }, 0) / a.length;
    var v = a.reduce(function (s, x) { return s + (x - m) * (x - m); }, 0) / a.length; return Math.sqrt(v) / m; }

// --- Sinus rhythm & BP self-calibration ---
var e = run({ rhythm: 'nsr', rate: 75, sys: 120, dia: 80 }, 40);
var m = e.measured();
check('NSR 75: HR counted from QRS', near(m.hr, 75, 3), r1(m.hr));
check('NSR 75: pulse rate from pleth', near(m.pr, 75, 3), r1(m.pr));
check('NSR 75: pleth valid', m.plethValid);
check('NSR 75: ABP converges to 120/80', near(m.abpSys, 120, 5) && near(m.abpDia, 80, 5), r1(m.abpSys) + '/' + r1(m.abpDia));
check('NSR 75: MAP ~ 93', near(m.abpMap, 93, 6), r1(m.abpMap));
check('NSR: EtCO2 ~ 35', near(m.etco2, 35, 2.5), r1(m.etco2));
check('no NaN in any channel', noNaN(e) === null, noNaN(e));

e = run({ rhythm: 'nsr', rate: 140, sys: 85, dia: 45 }, 40);
m = e.measured();
check('Sinus tachy 140 with 85/45: ABP converges', near(m.abpSys, 85, 5) && near(m.abpDia, 45, 5), r1(m.abpSys) + '/' + r1(m.abpDia));
e = run({ rhythm: 'nsr', rate: 45, sys: 180, dia: 100 }, 50);
m = e.measured();
check('Brady 45 with 180/100: ABP converges', near(m.abpSys, 180, 7) && near(m.abpDia, 100, 7), r1(m.abpSys) + '/' + r1(m.abpDia));

// BP change mid-run follows within ~15 s
e = run({ rhythm: 'nsr', rate: 80, sys: 120, dia: 80 }, 20);
e.set({ sys: 70, dia: 40 }); for (var t = 0; t < 15000; t += 16) e.advance(16);
m = e.measured();
check('BP target change 120/80 -> 70/40 tracked', near(m.abpSys, 70, 6) && near(m.abpDia, 40, 6), r1(m.abpSys) + '/' + r1(m.abpDia));

// Irregular rhythms: averaged ABP still settles on the set values
(function () { // AF numbers fluctuate beat to beat like a real monitor; their average over time should match
    var e = new Engine({ seed: 9, params: { rhythm: 'afib', rate: 110, sys: 120, dia: 80 } }), s = 0, d = 0, n = 0;
    for (var t = 0; t < 80000; t += 16) { e.advance(16); if (t > 20000 && t % 992 === 0) { var mm = e.measured(); s += mm.abpSys; d += mm.abpDia; n++; } }
    check('AF: ABP averaged over a minute ~ set 120/80', near(s / n, 120, 6) && near(d / n, 80, 6), r1(s / n) + '/' + r1(d / n));
})();
e = run({ rhythm: 'avb2_type1', rate: 75, sys: 120, dia: 80 }, 60); m = e.measured();
check('Wenckebach: averaged ABP ~ set 120/80', near(m.abpSys, 120, 8) && near(m.abpDia, 80, 8), r1(m.abpSys) + '/' + r1(m.abpDia));

// --- AF ---
e = run({ rhythm: 'afib', rate: 110 }, 60);
m = e.measured();
var rrs = rrList(e);
check('AF: irregular R-R (CV > 0.12)', cv(rrs) > 0.12, r1(cv(rrs) * 100) + '%');
check('AF: mean ventricular rate ~110', near(m.hr, 110, 20), r1(m.hr));
check('AF: pulse rate <= heart rate (pulse deficit possible)', m.pr != null && m.pr <= m.hr + 3, r1(m.pr) + ' vs ' + r1(m.hr));

// --- Blocks ---
function ratioVtoP(rhythm) {
    var e = run({ rhythm: rhythm, rate: 75 }, 40);
    var tEnd = e.tComputed;
    var ps = e.aEvents.filter(function (a) { return a.t > tEnd - 2900 && a.t < tEnd - 400; }).length;
    var vs = e.vEvents.filter(function (v) { return v.t > tEnd - 2900 + 150 && v.t < tEnd - 400 + 350; }).length;
    return { e: e, ps: ps, vs: vs };
}
e = run({ rhythm: 'avb2_type1', rate: 75 }, 40); m = e.measured();
check('Wenckebach: ventricular rate ~3/4 of atrial', near(m.hr, 75 * 0.75, 8), r1(m.hr));
e = run({ rhythm: 'avb2_type2', rate: 75 }, 40); m = e.measured();
check('Mobitz II: ventricular rate ~3/4 of atrial', near(m.hr, 75 * 0.75, 8), r1(m.hr));
e = run({ rhythm: 'avb1', rate: 70 }, 30); m = e.measured();
check('1st degree: all beats conducted', near(m.hr, 70, 3), r1(m.hr));
e = run({ rhythm: 'avb3', rate: 35 }, 40); m = e.measured();
var pRate = (function () { var a = e.aEvents.map(function (x) { return x.t; }).filter(function (x) { return x < e.tComputed; });
    return 60000 * (a.length - 1) / (a[a.length - 1] - a[0]); })();
check('CHB: ventricular escape ~35', near(m.hr, 35, 4), r1(m.hr));
check('CHB: atria independent ~75', near(pRate, 75, 6), r1(pRate));

e = run({ rhythm: 'aflutter', rate: 150 }, 30); m = e.measured();
check('Flutter 2:1 at 150', near(m.hr, 150, 6), r1(m.hr));
e = run({ rhythm: 'svt', rate: 180 }, 30); m = e.measured();
check('SVT 180', near(m.hr, 180, 6), r1(m.hr));

// --- Arrest rhythms ---
e = run({ rhythm: 'vf', pulse: false, sys: 120, dia: 80 }, 30); m = e.measured();
check('VF: HR indeterminate', m.hr === null);
check('VF: no pleth pulse', !m.plethValid && m.pr === null);
check('VF: arterial line flat', m.abpSys - m.abpDia < 3, r1(m.abpSys) + '/' + r1(m.abpDia));
e = run({ rhythm: 'asystole', pulse: false }, 20); m = e.measured();
check('Asystole: HR 0', m.hr === 0, m.hr);
e = run({ rhythm: 'pea', rate: 50, pulse: false }, 30); m = e.measured();
check('PEA: ECG still counts ~50', near(m.hr, 50, 3), r1(m.hr));
check('PEA: no pulse on pleth or art line', !m.plethValid && m.abpSys - m.abpDia < 3);
e = run({ rhythm: 'vt', rate: 180, pulse: true }, 30); m = e.measured();
check('VT with pulse: weak pulse present', m.plethValid && m.perfusing, r1(m.pr));
e = run({ rhythm: 'vt', rate: 180, pulse: false }, 30); m = e.measured();
check('Pulseless VT: no pulse', !m.plethValid && !m.perfusing);
e = run({ rhythm: 'agonal', rate: 18, pulse: false }, 40); m = e.measured();
check('Agonal: slow rate', m.hr > 8 && m.hr < 30, r1(m.hr));
e = run({ rhythm: 'nsr', rate: 0 }, 20); m = e.measured();
check('Rate 0 is asystole-like (HR 0)', m.hr === 0, m.hr);

// --- CPR and EtCO2 coupling ---
e = run({ rhythm: 'vf', pulse: false, cpr: true, etco2: 18 }, 40); m = e.measured();
check('CPR: compressions generate arterial pressure', m.abpSys > 50 && m.abpDia < 30, r1(m.abpSys) + '/' + r1(m.abpDia));
check('CPR: EtCO2 shows the set CPR value', near(m.etco2, 18, 2), r1(m.etco2));
check('CPR: compressions are not counted as a pulse', !m.plethValid);
e = run({ rhythm: 'vf', pulse: false, cpr: false, etco2: 35 }, 60); m = e.measured();
check('Pulseless, no CPR: EtCO2 falls toward zero', m.etco2 < 12, r1(m.etco2));
e = run({ rhythm: 'nsr', rate: 75, resp: 0, etco2: 35 }, 40); m = e.measured();
check('Apnoea: EtCO2 reads 0', m.etco2 === 0, m.etco2);
e = run({ rhythm: 'nsr', rate: 75, resp: 12, etco2: 50, co2Shape: 'obstructive' }, 30); m = e.measured();
check('Obstructive capnogram still reaches set EtCO2', near(m.etco2, 50, 6), r1(m.etco2));

// --- Ectopics ---
e = new Engine({ seed: 7, params: { rhythm: 'nsr', rate: 70, ectopic: true, ectopicFreq: 'medium' } });
var kinds = { pvc: 0, narrow: 0 };
for (t = 0; t < 60000; t += 16) { e.advance(16); e.drainBeats().forEach(function (b) { kinds[b.kind]++; }); }
check('PVCs appear at "medium" (every 5-8 beats)', kinds.pvc >= 6 && kinds.pvc <= 14, kinds.pvc + ' PVCs / ' + kinds.narrow + ' normal');
var pvcs = e.vEvents.filter(function (v) { return v.kind === 'pvc' && v.t < e.tComputed; });
var allV = e.vEvents.filter(function (v) { return v.t < e.tComputed; }).sort(function (a, b) { return a.t - b.t; });
var comp = pvcs.length && (function () {
    var i = allV.indexOf(pvcs[0]); if (i < 1 || i >= allV.length - 1) return true;
    var before = allV[i].t - allV[i - 1].t, after = allV[i + 1].t - allV[i].t, rr = 60000 / 70;
    return before < rr * 0.8 && Math.abs((before + after) - 2 * rr) < 0.15 * rr;
})();
check('PVC is premature with a compensatory pause', pvcs.length === 0 || comp);
check('PVC gives a weaker pulse', pvcs.every(function (v) { return v.strength < 0.5; }));
e = new Engine({ seed: 11, params: { rhythm: 'nsr', rate: 70, ectopic: true, ectopicFreq: 'frequent' } });
kinds = { pvc: 0, narrow: 0 };
for (t = 0; t < 30000; t += 16) { e.advance(16); e.drainBeats().forEach(function (b) { kinds[b.kind]++; }); }
check('Frequent PVCs (bigeminy-like)', kinds.pvc >= kinds.narrow * 0.4, kinds.pvc + ' PVCs / ' + kinds.narrow + ' normal');

// --- Rhythm change takes effect quickly ---
e = run({ rhythm: 'nsr', rate: 75 }, 10);
e.set({ rhythm: 'vf', pulse: false }); for (t = 0; t < 1000; t += 16) e.advance(16);
check('Rhythm change: no QRS scheduled after switching to VF', e.vEvents.filter(function (v) { return v.t > e.tComputed; }).length === 0);
e.set({ rhythm: 'nsr', rate: 75, pulse: true }); for (t = 0; t < 12000; t += 16) e.advance(16);
m = e.measured();
check('ROSC: rate and pulse return', near(m.hr, 75, 4) && m.plethValid, r1(m.hr));
check('no NaN after rhythm changes, shock', (e.shock(), e.advance(2000), noNaN(e) === null));

// --- Frame-rate independence: same sim time, different step sizes ---
var a = run({ rhythm: 'nsr', rate: 75 }, 20, 3);
var b = new Engine({ seed: 3, params: { rhythm: 'nsr', rate: 75 } });
for (t = 0; t < 20000; t += 8) b.advance(8);
check('Same signal at 60 Hz and 120 Hz frame rates', a.sampleCount === b.sampleCount && a.get('ecg', a.sampleCount - 1) === b.get('ecg', b.sampleCount - 1));

console.log('\n' + pass + '/' + (pass + fail) + ' passed');
process.exit(fail ? 1 : 0);
