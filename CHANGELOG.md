# Changelog

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
