# Changelog

All notable changes to this project are documented here. This project follows [Semantic Versioning](https://semver.org).

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
