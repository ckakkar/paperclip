# Changelog

All notable changes to this project are documented here. This project follows [Semantic Versioning](https://semver.org).

## 0.2.0 (2026-11-04)

Built from what a real 2025 Samsung split AC (SmartThings model DA-AC-RAC-01011, sold in India) reports to SmartThings.

- **Fan tile**: a separate fan control with Low, Medium, High and Turbo speeds and an Auto toggle. The AC tile's own speed slider now uses the same four speeds. Turn off `fanTile` to go back to one slider with Auto as its lowest step.
- **Swing on newer units**: supports `samsungce.airConditionerAirFlowDirection` (up/down and left/right swing), which 2023+ units use in place of `fanOscillationMode`. Adds optional **Swing Up/Down** and **Swing Left/Right** switches.
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
