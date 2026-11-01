// Checks the alarm sound definitions against IEC 60601-1-8. Run with:  node tests/audio.test.js
var A = require('../static/js/sim-audio.js');
var pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) pass++; else fail++;
    console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail !== undefined ? '  [' + detail + ']' : ''));
}
function within(x, lo, hi) { return x >= lo - 1e-9 && x <= hi + 1e-9; }
function gaps(p) { var g = []; for (var i = 1; i < p.starts.length; i++) g.push(+(p.starts[i] - (p.starts[i - 1] + p.td)).toFixed(3)); return g; }

var H = A.PATTERNS.high, M = A.PATTERNS.medium, L = A.PATTERNS.low;

// High priority
check('HIGH: 10 pulses per burst', H.starts.length === 10);
check('HIGH: pulse duration 75–200 ms', within(H.td, 0.075, 0.2), H.td);
var hg = gaps(H), x = hg[0];
check('HIGH: pulse spacing x within 50–125 ms', within(x, 0.05, 0.125), x);
check('HIGH: groups of 3+2 (gap after 3rd pulse = 2x + td)', Math.abs(hg[2] - (2 * x + H.td)) < 0.005 && Math.abs(hg[7] - (2 * x + H.td)) < 0.005, hg.join(','));
check('HIGH: two groups of five separated by 0.35–1.30 s', within(hg[4], 0.35, 1.3), hg[4]);
check('HIGH: pulses inside each group evenly spaced', [0, 1, 3, 5, 6, 8].every(function (i) { return Math.abs(hg[i] - x) < 0.005; }));
check('HIGH: interburst interval 2.5–15 s', within(H.interburst, 2.5, 15), H.interburst);

// Medium priority
check('MEDIUM: 3 pulses per burst', M.starts.length === 3);
check('MEDIUM: pulse duration 125–250 ms', within(M.td, 0.125, 0.25), M.td);
check('MEDIUM: pulse spacing 125–250 ms', gaps(M).every(function (g) { return within(g, 0.125, 0.25); }), gaps(M).join(','));
check('MEDIUM: interburst interval 2.5–30 s', within(M.interburst, 2.5, 30), M.interburst);

// Low priority
check('LOW: 1–2 pulses per burst', L.starts.length >= 1 && L.starts.length <= 2);
check('LOW: pulse duration 125–250 ms', within(L.td, 0.125, 0.25));
check('LOW: repeats no more often than every 15 s', L.interburst > 15);

// Spectrum and loudness
check('Fundamental 150–1000 Hz', within(A.ALARM_F0, 150, 1000), A.ALARM_F0);
var harm = A.ALARM_HARMONICS.slice(1).map(function (a, i) { return { f: A.ALARM_F0 * (i + 2), db: 20 * Math.log10(a / A.ALARM_HARMONICS[0]) }; });
check('At least 4 harmonics in 300–4000 Hz', harm.filter(function (h) { return within(h.f, 300, 4000); }).length >= 4, harm.map(function (h) { return Math.round(h.f); }).join(','));
check('Harmonics within ±15 dB of the fundamental', harm.every(function (h) { return Math.abs(h.db) <= 15; }), harm.map(function (h) { return h.db.toFixed(1); }).join(','));
check('High louder than medium, medium louder than low', H.level > M.level && M.level > L.level);
check('Level steps 3–6 dB', [20 * Math.log10(H.level / M.level), 20 * Math.log10(M.level / L.level)].every(function (d) { return within(d, 3, 6); }),
      [20 * Math.log10(H.level / M.level), 20 * Math.log10(M.level / L.level)].map(function (d) { return d.toFixed(1); }).join(', '));

// QRS tone pitch
check('QRS pitch falls with SpO2', A.qrsPitch(100) > A.qrsPitch(95) && A.qrsPitch(95) > A.qrsPitch(90) && A.qrsPitch(90) > A.qrsPitch(80));
check('QRS pitch: one semitone per 1 %', Math.abs(A.qrsPitch(99) / A.qrsPitch(100) - Math.pow(2, -1 / 12)) < 1e-9);
check('QRS pitch stays audible on phone speakers at 80 % (fundamental >= 250 Hz)', A.qrsPitch(80) >= 250, Math.round(A.qrsPitch(80)) + ' Hz');
check('QRS pitch without valid SpO2 is fixed', A.qrsPitch(null) === A.qrsPitch(undefined));

console.log('\n' + pass + '/' + (pass + fail) + ' passed');
process.exit(fail ? 1 : 0);
