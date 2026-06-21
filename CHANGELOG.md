# Changelog

All notable changes to this project are documented here. This project follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.1] - 2026-06-21

### Fixed
- Mode switches could show as generic "Switch 1/2/3" in the Home app after re-pairing. Switched
  to the canonical `ConfiguredName` pattern (declare as optional + set a plain writable value, no
  `onGet` override) so the Home app reliably reads the real names and user renames survive restarts.

## [1.2.0] - 2026-06-21

### Added
- **Dedicated Fan accessory** with an **Auto ⇄ Manual** toggle plus a Low/Med/High speed
  slider, mirroring the GE app's Auto/Low/Medium/High fan settings.

### Changed
- Fan speed moved off the thermostat's rotation-speed slider — Apple's Home app never
  rendered it there — onto its own Fan service on the same accessory (it groups with the AC).
- Restored-accessory service changes are now persisted via `updatePlatformAccessories`, so
  added services and removed characteristics survive Homebridge restarts.

### Removed
- The unused `RotationSpeed` characteristic on the HeaterCooler (the Home app never showed it).

## [1.1.0] - 2026-06-19

### Added
- **Adaptive temperature range** read from the unit (`0x7B06`) instead of a hard-coded
  64–86 °F, falling back to 64–86 °F when the unit doesn't report one.
- **Experimental heat/cool support**: when a unit reports a heating setpoint (`0x7002`), the
  plugin also exposes a Heat thermostat mode, a heating setpoint, and a Heat switch.
  ⚠️ Untested on real heat hardware — please [open an issue](https://github.com/fabricore-eng/homebridge-ge-ac/issues) with results.

### Changed
- Honest compatibility scoping in the README/description: built and tested only on the
  cooling-only GE Profile **AHTT06BC**; other GE Wi-Fi window ACs are likely but unverified.
- The per-model "available modes" ERD (`0x7B00`) is deliberately ignored — GE window ACs
  report a value that doesn't match the documented bitmask.

## [1.0.0] - 2026-06-19

### Added
- Initial release: HomeKit control of GE SmartHQ Wi-Fi window air conditioners over GE's
  realtime **WebSocket** channel — setpoint/mode/fan writes the appliance actually honors
  (REST writes are accepted but silently dropped on this AC line).
- **HeaterCooler** thermostat: on/off, target temperature, current temperature, with the
  slider grid aligned to whole Fahrenheit degrees so both 64 °F and the maximum set cleanly.
- **Named mode switches**: Cool, Fan Only, Energy Saver, Dry — each sets `ConfiguredName`, so
  HomeKit never shows "Switch 1–5".
- **Fan speed** control and **live state updates** pushed from the WebSocket subscription, so
  changes made in the GE app or on the unit reflect in HomeKit in real time.
- Resilience: app-level keepalive, OAuth token refresh ahead of expiry, and
  exponential-backoff auto-reconnect.

[1.2.1]: https://github.com/fabricore-eng/homebridge-ge-ac/releases/tag/v1.2.1
[1.2.0]: https://github.com/fabricore-eng/homebridge-ge-ac/releases/tag/v1.2.0
[1.1.0]: https://github.com/fabricore-eng/homebridge-ge-ac/releases/tag/v1.1.0
[1.0.0]: https://github.com/fabricore-eng/homebridge-ge-ac/releases/tag/v1.0.0
