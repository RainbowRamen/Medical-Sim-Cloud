# Changelog

## Phase 2 — Sound

### Why sound sometimes didn't play on phones
- **Cause:** iOS and Android only allow sound that starts from a tap. The Advanced monitor started its sound about 3 seconds after the power-on tap, from a timer, which iOS refuses. Sound then stayed off until something else woke the phone's audio, such as the volume buttons. The audio was also created when the page loaded, before any tap.
- **Fix:** sound now starts inside the power-on tap, and every later touch, click or key re-wakes it. So if the phone suspends audio (screen lock, a call, switching apps), the next touch brings it back. When the page comes back into view it tries to resume on its own.
- **"TAP FOR SOUND" badge:** if the browser still blocks sound, a flashing badge appears in the header. Tapping anywhere fixes it.
- **Silent switch:** on iOS the audio session is set to "playback", so alarms are heard even with the ringer switch on silent. Older iOS versions use a fallback that does the same.

### One shared sound module: `static/js/sim-audio.js`
- **Used by both monitors**, so sounds behave identically in each.
- **Scheduled on the audio clock**, not with timers, so pulses keep exact timing even when the page is busy.
- **A limiter on the output** stops alarms and beeps clipping when they overlap.

### Alarms follow IEC 60601-1-8
| Priority | Burst | Pulse | Repeats |
|---|---|---|---|
| High | 10 pulses: x-x-x--x-x, pause 0.4 s, x-x-x--x-x | 100 ms | every 5.0 s (2.6 s gap) |
| Medium | 3 pulses: x-x-x | 180 ms | every 4.8 s (4.0 s gap) |
| Low (available) | 2 pulses | 180 ms | every 16 s |

- **Tone:** 523 Hz fundamental with four harmonics, all within the required ±15 dB.
- **Loudness:** high is about 4 dB louder than medium.
- **Escalation:** when an alarm escalates (e.g. HR high, then VF) the high pattern starts immediately.
- **Pausing:** paused alarms stop at once. The Spot Check monitor gives a quiet reminder pulse every 30 s while paused.
- **Volume floor:** alarm volume can't be turned down to 0 (minimum level 1). QRS volume can.
- **Visual signals:**
  - High priority flashes red at 2 Hz.
  - Medium flashes yellow at 0.6 Hz.
  - The header badge turns yellow for medium alarms on both monitors.

### QRS / pulse tone
- **One short tone per beat**, in time with the R wave. On Spot Check it follows the pulse.
- **Pitch follows SpO₂:** one semitone lower for each 1% drop (880 Hz at 100%, about 494 Hz at 90%). A harmonic keeps low pitches audible on phone speakers. With no valid SpO₂ reading the pitch stays fixed.
- **Defibrillator shock:** now a short broadband thump that's audible on small speakers.

### Other
- The displayed HR now follows rate changes faster: it averages the last 6 beats, and the engine plans 1 s ahead instead of 2 s.
- New test file: `node tests/audio.test.js` checks the alarm patterns against the standard's limits.

### How to test on devices (iPhone/iPad especially)
1. Open a monitor and tap power. You should hear QRS beeps straight away, including with the ringer switch on silent.
2. Lock the phone for 30 s, unlock it, and return to the browser. Sound should continue. If "TAP FOR SOUND" appears, one tap should fix it.
3. Switch to another app and back: same result.
4. Set HR to 140. You should hear 3-pulse medium bursts, and the HR block flashes yellow slowly.
5. Choose VF. The 10-pulse high alarm should start immediately, with a fast red flash.
6. Press Pause Alarms. Sound stops at once and returns after 2 minutes or when pressed again.
7. Drop SpO₂ from 98 toward 85. The beep pitch should fall clearly.
8. Change the master volume from the controller. The monitor volume should follow.

## Phase 1 — Waveform engine

### New: a physiology engine shared by the monitor and controller
- **New file `static/js/sim-engine.js`.** It models the heart in three layers:
  - atrial activity (P waves, flutter, fibrillation),
  - ventricular complexes,
  - the mechanical beat each complex produces.
  
  Breathing drives the respiration and CO₂ waves. All signals are generated on the clock at 250 Hz, never per screen frame.
- **New file `static/js/wave-renderer.js`.** It draws each wave at true speed: 25 mm/s for ECG, pleth and ABP, and 6.25 mm/s for respiration and CO₂. Speed is the same on 60 Hz and 120 Hz screens, and traces are sharp on high-resolution phones and tablets.
- **New test file `tests/engine.test.js`** with 46 physiology checks. Run it with `node tests/engine.test.js`; it needs nothing installed.

### Rhythms
- **All 15 rhythms rebuilt** with lead II shapes: P waves, QRS width per rhythm, and T waves whose QT interval shortens as the rate rises.
- **AF:** truly irregular, no P waves, fibrillatory baseline.
- **Flutter:** saw-tooth waves near 300/min, conducted 2:1 at 150 and 4:1 at 75.
- **2nd-degree blocks:** Wenckebach lengthens the PR then drops a beat; Mobitz II keeps a constant PR with a sudden dropped beat.
- **Complete heart block:** P waves at about 75/min run independently of a wide escape rhythm.
- **PVCs:** premature and wide, with a compensatory pause and a weak pulse.

### What each rhythm does to the other channels
- **Pulse beat by beat:** each ventricular beat produces a pulse sized by its filling time, so in AF the pulse size varies and weak beats can be missed (a pulse deficit).
- **Pulseless rhythms (VF, asystole, PEA, pulseless VT, agonal):**
  - The pleth goes flat.
  - SpO₂ shows `-?-` with **NO PULSE**.
  - The arterial line falls to a flat ~15 mmHg.
  - NIBP measurements fail with **NBP FAILED**.
- **HR is counted from the QRS complexes.** Dropped beats lower it, VF shows `-?-` (it can't be counted), and asystole shows 0. The SpO₂ block now also shows the **pulse rate (PR)** from the pleth, so PEA and pulse deficits are visible.
- **Arterial line (ABP):**
  - Fast upstroke, sharp peak, dicrotic notch, then diastolic run-off.
  - The numbers settle on the set systolic and diastolic, including in AF and 2nd-degree block.
  - MAP is measured from the trace (about 40% of the way from diastolic to systolic, as in a real radial line).
  - Pressure falls during long pauses.
- **Capnogram:** box shape with steep sides. EtCO₂ is measured breath by breath, and reads 0 after 20 s of apnoea.
  - New **Obstructive** shape (shark-fin) for bronchospasm, asthma and anaphylaxis scenarios.
  - When pulseless without CPR, EtCO₂ falls toward zero over about a minute, because no blood is reaching the lungs. With CPR it shows the value you set, which lets you represent CPR quality. ROSC brings it back.
- **CPR:** compressions at ~110/min show on the ECG, pleth, arterial line (~75/15), respiration and capnogram. Compressions are not counted as a pulse.
- **Shock:** the ECG saturates and recovers, with a brief disturbance on the pleth and ABP.

### Controller
- **Choosing a rhythm sets typical defaults:** HR snaps to the rhythm's usual rate (VT 180, complete heart block 35, VF `---`) and the new **Pulse** switch to its default. Both can be changed before pressing UPDATE.
- **Pulse switch**, for example VT with or without a pulse, or a PEA scenario.
- **Capnogram shape buttons** (Normal / Obstructive) on the EtCO₂ card.
- **One message builder** now produces every vitals message, so trend steps and normal updates always send the same fields.

### Spot Check
- **No pulse:** a pulse of 0 shows **NO PULSE**, SpO₂ shows `---`, and a high-priority alarm sounds.
- **BP without a pulse** gives **NO READING**.

### Colours
- EtCO₂ is now yellow, and respiration and NIBP are white-grey (the agreed Philips/GE-style palette). Per-waveform colour choice comes in Phase 3.

### How to test on devices
1. Start an Advanced session. Turn on HR, SpO₂, RR, NIBP and temperature, then add ABP and EtCO₂ from the dock.
2. Step through each rhythm. When you select one, HR and Pulse should jump to its defaults on the controller; then press UPDATE.
3. **PEA:** the ECG keeps counting, SpO₂ shows `-?-` NO PULSE, and the arterial line goes flat. Press NIBP: it should fail.
4. **VF with CPR on:** compression waves should appear. Set EtCO₂ to about 15 to represent good CPR.
5. **ROSC:** choose NSR with Pulse on. Within a few seconds the pulse, SpO₂ and arterial pressure should return.
6. **AF:** the pulse should vary beat to beat, and PR may read slightly below HR.
7. **NSR with frequent ectopics:** wide PVCs should appear with a pause after each and a small pleth pulse.
8. **EtCO₂ Obstructive:** the capnogram should become shark-fin shaped.
9. **Spot Check ARREST preset:** NO PULSE and `---` with an alarm. Start BP: it should give NO READING.

## Phase 0 — Safety net and bug fixes

### Deployment
- **Pinned `requirements.txt`.** gunicorn 26 removed the eventlet worker. With unpinned requirements, the next deploy would have installed it and failed to start if Render's start command uses `--worker-class eventlet`. Everything is now pinned to versions tested on Python 3.11 and 3.13, with both `gunicorn --worker-class eventlet -w 1 app:app` and `python app.py`.
- `python app.py` no longer runs in debug mode unless `FLASK_DEBUG=1` is set.

### Server (`app.py`)
- **Monitors catch up after reconnecting.** The server keeps the latest state for each room and resends it when a monitor joins. A phone that locks, loses Wi-Fi or is reloaded comes back showing the current scenario instead of blanks. One-off events (shock, NIBP trigger) are not replayed. RESET clears the stored state.

### Advanced monitor (`monitor_adv.html`)
- HR, SpO₂, RR, EtCO₂, ABP, NIBP and temperature can now be set to **0**. Previously 0 was ignored and the old value stayed.
- Turning every parameter off **no longer sends the monitor back to the power screen**. Only RESET does that.
- **The controller's OFF button now works.** It returns the monitor to the power screen and keeps the scenario, so powering back on carries on from the same point.
- **New alarms:**
  - ABP, EtCO₂ and NIBP now alarm when outside their limits.
  - VF, VT and asystole now raise a high-priority alarm even if the HR number is within limits.
- **NIBP alarm limits** can be adjusted in the NIBP settings, with defaults for each patient type.
- The NIBP auto-cycle buttons no longer depend on a browser-specific global.
- **Limit labels:**
  - The EtCO₂ limit label shows the real limits. It was being overwritten every frame.
  - The ABP and NIBP limit labels now follow the patient type.
- No beeps or alarm tones while the monitor is on the power screen.
- **The screen stays awake** while the monitor is on, where supported (iOS 18.4+, Chrome Android).

### Advanced controller (`controller_adv.html`)
- **RESET, NORMAL and trends no longer crash.** These buttons threw an error before sending anything because the EtCO₂ card's id didn't match what the code looked for (`etco2_card` vs `card_etco2`).
- Trend updates no longer replace a value of 0 with the slider position.
- The ectopic frequency always reaches the monitor. It is now sent as `ectopic_freq` everywhere.

### Spot Check monitor (`monitor.html`)
- The OFF button now returns the monitor to the standby screen.
- The screen stays awake while the monitor is on.

### Landing page
- Removed "RR" from the Spot Check feature list, because Spot Check doesn't display respiratory rate.

### How to test on devices
1. Start an Advanced session with the monitor on one phone and the controller on another. Power on the monitor.
2. Set HR to 0 and press UPDATE. The monitor should show 0.
3. Lock the monitor phone for about 30 seconds, then unlock it. It should still show the scenario, and the screen should not have dimmed while it was on.
4. Reload the monitor page and power it on. It should pick up the current values.
5. Choose VF with HR around 100. The monitor should raise a high-priority alarm.
6. Turn on ABP and EtCO₂. Set the BP to 60/40 and EtCO₂ to 15. Both blocks should alarm.
7. Turn every parameter off and press UPDATE. The monitor should stay powered on.
8. Press NORMAL and then UPDATE. Normal vitals should appear.
9. Start a trend that includes EtCO₂. It should run, and its ✕ should cancel it.
10. Press RESET. The monitor should return to the power screen.
11. In a Spot Check session, press OFF on the controller. The monitor should return to the standby screen.
