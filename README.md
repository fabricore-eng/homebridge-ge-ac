# homebridge-ge-ac

A [Homebridge](https://homebridge.io) plugin for **GE SmartHQ Wi‑Fi window air conditioners**,
exposing them to HomeKit with **reliable** setpoint, mode, and fan control over GE's realtime
WebSocket channel.

> **Compatibility — please read.** This was built and **tested on one unit**: the GE Profile
> ClearView **AHTT06BC** (a *cooling‑only* window AC). The SmartHQ protocol and ERD codes are shared
> across GE's smart window/room AC line, so it will **probably** work on similar GE Wi‑Fi window ACs —
> but anything beyond the AHTT06BC is **unverified**. How it adapts:
> - **Temperature range** is read from the unit (`0x7B06`) — no longer hard‑coded — falling back to
>   64–86 °F if the unit doesn't report one.
> - **Cooling-only units** (no heating setpoint reported) get a Cool thermostat + Cool/Fan/Energy‑Saver/Dry
>   switches. This is the **tested** path.
> - **Heat/cool units** — ⚠️ **experimental, untested.** If the unit reports a heating setpoint
>   (`0x7002`), the plugin also exposes a Heat thermostat mode, a heating setpoint, and a Heat switch.
>   No heat‑capable unit was available to test, and the heat setpoint encoding is assumed to match the
>   (verified) cool one. **If you have a heat/cool GE smart AC, please test and
>   [open an issue](https://github.com/fabricore-eng/homebridge-ge-ac/issues) with what works or breaks.**
> - **Modes**: the per‑model "available modes" ERD (`0x7B00`) is **deliberately ignored** — GE window
>   ACs report a value that doesn't match the documented bitmask. The standard four switches are always
>   shown; an `Auto` operation mode (if a unit uses it) isn't represented in the thermostat.
> - **Swing** isn't exposed; **portable** and **split / mini‑split** ACs use a different ERD layout
>   and are **not** expected to work.
>
> Reports for any other model (works / doesn't + the model number) via a
> [GitHub issue](https://github.com/fabricore-eng/homebridge-ge-ac/issues) are very welcome — that's
> how this grows beyond one unit.

## Why this exists

GE's SmartHQ appliances expose two interfaces:

- a **REST** API that works fine for *reading* ERD values, and
- a persistent authenticated **WebSocket** ("pseudo‑MQTT") channel that the GE app — and the
  reference Python library [`simbaja/gehome`](https://github.com/simbaja/gehome) — use for
  *control*.

Existing Homebridge SmartHQ plugins write setpoints over **REST**. On at least the ClearView
window-AC line, the backend *accepts* those REST writes (`200 OK`) but silently never relays them
to the unit — so the temperature you set in HomeKit snaps right back. This plugin sends writes over
the **WebSocket** channel (`setErd`), which the appliance actually honors. Confirmed end‑to‑end:
the unit echoes the change back on `publish#erd`.

## Features

- Proper **HeaterCooler** thermostat — on/off, target temperature (64–86 °F), current temperature.
  Setpoint changes **stick**.
- **Mode switches** with real names: Cool, Fan Only, Energy Saver, Dry. (No bogus "Heat" — these
  are cooling-only units. Each switch sets `ConfiguredName`, so HomeKit never shows "Switch 1–5".)
- **Fan speed** via the rotation-speed slider (Auto / Low / Med / High).
- **Live updates** — state is pushed from the WebSocket subscription, so HomeKit reflects changes
  made in the GE app or on the unit, in real time.
- Resilient: app‑level keepalive, OAuth token refresh ahead of expiry, and exponential‑backoff
  auto‑reconnect.

## Install

```bash
npm install -g homebridge-ge-ac     # or install a local checkout: npm install /path/to/homebridge-ge-ac
```

Then add the platform via the Homebridge UI (search "GE Profile AC") or in `config.json`:

```json
{
  "platforms": [
    {
      "platform": "GEProfileAC",
      "name": "Air Conditioner",
      "username": "you@example.com",
      "password": "your-smarthq-password"
    }
  ]
}
```

- `username` / `password` — the same credentials you use in the GE **SmartHQ** app. The AC must
  already be set up and online in that app.
- `macAddress` *(optional)* — only needed if more than one appliance is on the account; otherwise
  the air conditioner is auto-detected.

Running it as a **child bridge** (Homebridge UI → Bridge Settings) is recommended for isolation.

## How it works

| Concern | Approach |
| --- | --- |
| Auth | OAuth2 authorization-code flow scripted through the Brillion login form (`/oauth2/auth` → `g_authenticate` → `/oauth2/token`), then `GET /v1/websocket` for the signed socket endpoint + `userId`. |
| Transport | One WebSocket: `subscribe` to `/appliance/*/erd/*`, list appliances, pull full ERD state, then receive live `publish#erd` updates. |
| Writes | `setErd` over the socket — `{kind:"websocket#api", method:"POST", path:"/v1/appliance/{mac}/erd/{code}", body:{kind:"appliance#erdListEntry", …, value}}`, acked by echoed `id`. |
| Encoding | Target temp ERD `0x7003` = 2‑byte big‑endian °F (`72 → "0048"`); mode `0x7A01`, power `0x7A0F`, ambient `0x7A02`, fan `0x7A00`. |

See [`dev/`](dev/) for the standalone proof-of-concept (`poc-setpoint.js`) and module smoke test
(`smoke.js`) used to validate the WebSocket write path before building the plugin.

## Credits

The GE SmartHQ / Brillion protocol details (OAuth flow, WebSocket envelopes, ERD codes and
encodings) were derived from the excellent [`simbaja/gehome`](https://github.com/simbaja/gehome)
Python library. This plugin is an independent JavaScript implementation.

## License

ISC — see [LICENSE](LICENSE).
