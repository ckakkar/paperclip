# Changelog

All notable changes to this project are documented here. This project follows [Semantic Versioning](https://semver.org).

## 0.4.1 (2026-11-05)

- Retry finding the AC every 2 minutes at most (was 10) after a network outage, so it comes back soon after the Homebridge machine rejoins a network.
- README: how to keep Homebridge working when the machine moves between networks (use the Ciao mDNS advertiser).

## 0.4.0 (2026-11-04)

- **One tile per AC.** The separate Settings/Modes accessory is gone. Its switches (Display, Beep, Auto Clean, swing axes) now sit inside the AC's tile with the mode toggles, and the old accessory is removed from HomeKit.
- Toggles follow the Samsung app's order: Turbo, Quiet, Sleep, then Dry and the settings.
- **Dry shows as Cool** in the mode menu, not Auto, and the AC reads as cooling. Samsung's Dry is a dehumidifying cool, and Auto is now a real choice in the menu.

## 0.3.0 (2026-11-04)

Closer to the Samsung SmartThings app's own page.

- **Auto in the mode menu**: the Home app only lists Auto when an AC has both heating and cooling thresholds, so both are now present and mirror Samsung's single setpoint.
- **Mode toggles with the AC**: Dry, Sleep, Quiet and Turbo sit under the dial again, with short names. Display, Beep, Auto Clean and the swing-axis switches move to a separate **Settings** accessory.
- **Turbo only while cooling**: Samsung's Turbo (fast cooling) can only be turned on in Cool mode, and no mode toggle turns on while the AC is off. The Home app flips the switch back and the log says why. Changing the mode away from Cool turns the Turbo switch off right away.
- The AC's control is named after the unit instead of the Home app's generic "Heater-Cooler".

## 0.2.0 (2026-11-04)

Built from what a real 2025 Samsung split AC (SmartThings model DA-AC-RAC-01011, sold in India) reports to SmartThings.

- **Native layout**: the AC's tile now holds only the thermostat, a **Fan** control and filter status. Mode switches (Sleep, Quiet, Turbo, Dry, Display…) move to a separate **Modes** accessory, with short names ("Sleep", not "Samsung Room A/C Sleep"). Names you change in the Home app are kept.
- **Fan control**: Low, Medium, High and Turbo, an Auto toggle and Oscillate. Turning the Fan on while the AC is off runs fan-only mode; turning it off turns the unit off. Turn off `fanTile` to go back to one slider on the AC with Auto as its lowest step.
- **Swing on newer units**: supports `samsungce.airConditionerAirFlowDirection` (up/down and left/right swing), which 2023+ units use in place of `fanOscillationMode`. Optional **Swing Up/Down** and **Swing Left/Right** switches (`swingDirectionSwitches`, off by default).
- **Samsung modes on by default**: every mode the unit supports gets a switch (for example Sleep, Quiet and Turbo). The "speed" option is now labelled **Turbo**, as on the remote.
- **Fan Only** works on units that call the mode `fan`.
- **Filter life**: a filter tile with remaining life and a "clean filter" alert, from `custom.dustFilter`. Resetting it in HomeKit resets the counter.
- **Beep switch** (`beepSwitch`, off by default).
- Log lines say "display on" or "beep off" instead of "on()" and "off()".

## 0.1.0 (2026-11-03)

First release.

- Samsung air conditioners from SmartThings appear in HomeKit as a heater/cooler tile: power, mode, target and current temperature, fan speed and swing.
- Only shows modes, fan speeds and features the unit reports, and skips capabilities it marks as disabled.
- Optional switches for WindFree (and other Samsung modes), Dry, Fan Only, Display light and Auto Clean, plus a humidity sensor.
- Settings page in the Homebridge UI that creates the SmartThings OAuth app and signs in, with no terminal needed.
- Renews the OAuth sign-in automatically and saves the rotated refresh token to a file only the Homebridge user can read.
- Sends Home app changes made close together (power, mode, temperature) as one SmartThings request, and keeps the new values on screen until SmartThings confirms them.
- Backs off on rate limits and shows "No Response" only after repeated failures.
- `homebridge-paperclip` CLI: `setup`, `devices`, `status`, `doctor`, `app-definition`, `disconnect`.
