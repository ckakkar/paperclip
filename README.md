# Paperclip

[![npm](https://badgen.net/npm/v/homebridge-paperclip)](https://www.npmjs.com/package/homebridge-paperclip)
[![CI](https://github.com/ckakkar/paperclip/actions/workflows/ci.yml/badge.svg)](https://github.com/ckakkar/paperclip/actions/workflows/ci.yml)
[![License](https://badgen.net/badge/license/Apache-2.0/blue)](LICENSE)

**Paperclip** (`homebridge-paperclip`) is a [Homebridge](https://homebridge.io) plugin that puts Samsung
air conditioners in Apple Home. It works with WindFree and other models you already control in the
SmartThings app. You can then use the Home app, Control Center, Siri and a HomePod, with automations
and away-from-home control through your home hub.

It was written for, and tested on, a Samsung **AR50H18D1ZHNNA** (1.5 t split AC sold in India, SmartThings
model `DA-AC-RAC-01011`). It works with any Samsung room AC that shows up in SmartThings.

```
iPhone / Watch / HomePod ──HomeKit──▶ Homebridge + Paperclip (Mac, Pi…) ──HTTPS──▶ SmartThings ──▶ Samsung AC
```

## What you get

The AC's page in the Home app follows the Samsung SmartThings app: a temperature dial with **Off / Cool / Auto**, then a **Fan**
control and the mode toggles right under it (Turbo, Quiet, Sleep, Dry). It's one tile in the room, like a native AC.

> Apple fixes the mode menu to Off, Cool, Auto and Heat, for HomeKit and Matter accessories alike. Samsung's **Dry** therefore
> appears as a toggle under the dial (the menu shows Cool while it runs), and **Fan** mode is what you get when you turn the Fan
> on while the AC is off.

| In the Home app | Samsung feature |
|---|---|
| On / off | Power |
| Cool · Auto (· Heat on heat pumps) | AC mode, limited to the modes your unit reports |
| Target temperature | Set point, using your unit's own range (16–30 °C on most models) |
| Current temperature | Indoor temperature sensor |
| **Fan** (inside the AC) | Low → Medium → High → Turbo, an **Auto** toggle and **Oscillate**. Fan on while the AC is off = fan-only mode |
| **Filter** (inside the AC) | Filter life left, and an alert when it needs cleaning |
| Humidity (inside the AC) | Indoor humidity, if the unit measures it |
| **Turbo**, **Quiet**, **Sleep**, WindFree… | Samsung's optional modes, whichever your unit supports. Only one runs at a time, only while the AC is on, and Turbo only in Cool |
| **Dry** | Dehumidify. Turning it off returns the AC to its previous mode |
| Display, Beep, Auto Clean, Swing Up/Down, Swing Left/Right | Optional, off by default, also inside the AC |

Paperclip only adds a control when your AC actually reports it, so you don't get tiles that always say "No Response".

## Requirements

- An AC that already works in the **SmartThings** app
- **Homebridge** 1.8 or newer (2.x recommended) with the Homebridge UI, running on a computer that stays on
- Node.js 22, 24 or 26
- For control away from home and for automations: a **home hub** (HomePod, HomePod mini or Apple TV)

## Install

In the Homebridge UI, open **Plugins**, search for **Paperclip** and click **Install**. From a terminal:

```bash
npm install -g homebridge-paperclip
```

To try the latest code straight from GitHub:

```bash
npm install -g github:ckakkar/paperclip
```

## Connect to SmartThings (once)

Open **Plugins → Paperclip → Settings** in the Homebridge UI. The settings page has two steps:

1. **Create Paperclip's SmartThings app.** Make a [personal access token](https://account.smartthings.com/tokens)
   with every scope ticked and paste it in. Paperclip uses it once to create a private OAuth app in your
   account, then discards it.
2. **Authorize.** Click *Open SmartThings sign-in*, pick the location your AC is in and tap *Authorize*.
   You land on a plain `httpbin.org` page. Copy its full address and paste it back into the settings page.

That's it. Paperclip renews its sign-in automatically from then on. Click **Save**, restart Homebridge if
it asks, and your AC appears in the Home app.

<details>
<summary><b>If step 1 fails:</b> create the app with the SmartThings CLI instead</summary>

```bash
brew install smartthingscommunity/smartthings/smartthings     # or see github.com/SmartThingsCommunity/smartthings-cli
npx homebridge-paperclip app-definition > paperclip-app.json   # the settings page also shows this JSON
smartthings apps:create -i paperclip-app.json                  # opens a browser to sign in
```

Copy the **OAuth Client Id** and **OAuth Client Secret** it prints into the *I already have a Client ID*
tab, then continue with step 2. SmartThings shows the secret only once.
</details>

<details>
<summary>No Homebridge UI? Use the terminal</summary>

```bash
npx homebridge-paperclip setup              # same two steps, in the terminal
npx homebridge-paperclip setup -U /var/lib/homebridge   # if Homebridge keeps its files elsewhere
```
</details>

### Why so many steps?

SmartThings personal access tokens made after 30 December 2024 stop working after **24 hours**. The only
way to stay signed in is OAuth, which needs an app registered in your account. SmartThings also refuses
`localhost` redirect addresses, so the code comes back on a public echo page (`httpbin.org`) that just
shows the address it was opened with.

## Siri and HomePod

Once the AC is in a room in the Home app, any HomePod or iPhone can control it:

- "Hey Siri, turn on the bedroom AC"
- "Hey Siri, set the bedroom AC to 24 degrees"
- "Hey Siri, turn on WindFree" (use whatever name the switch has in the Home app)
- "Hey Siri, what's the temperature in the bedroom?"

Automations ("turn the AC on at 10 pm", "turn it off when I leave") run on your home hub.

## Settings

All of these are in the settings page below the connection steps. Defaults are in brackets.

| Key | | |
|---|---|---|
| `pollInterval` | `20` | Seconds between status refreshes (10–600). Commands are always sent immediately. |
| `optionalModeSwitches` | all | Samsung modes as switches: `windFree`, `windFreeSleep`, `sleep`, `quiet`, `speed` (Turbo), `smart`, `comfort`, `longWind`. Only supported ones appear. |
| `fanTile` | `true` | Fan control inside the AC: speed, Auto and Oscillate. |
| `swingDirectionSwitches` | `false` | Swing Up/Down and Swing Left/Right switches on the Modes accessory. |
| `filterStatus` | `true` | Filter life and cleaning alert. |
| `beepSwitch` | `false` | Turn the indoor unit's beep on or off. |
| `dryModeSwitch` | `true` | Dry (dehumidify) switch. |
| `fanModeSwitch` | `false` | Fan Only switch. Not needed with the Fan control. |
| `humiditySensor` | `true` | Humidity sensor tile. |
| `displaySwitch` | `false` | Indoor unit display light. |
| `autoCleanSwitch` | `false` | Auto Clean switch. |
| `swingMode` | `"all"` | What "Oscillate" turns on: `all`, `vertical` or `horizontal`. |
| `excludeDevices` | `[]` | Device names or IDs to leave out of HomeKit. |
| `removeStaleAccessories` | `true` | Remove ACs that were deleted from SmartThings. |
| `requestTimeout` | `15` | Seconds before a SmartThings request is abandoned. |

A minimal `config.json` entry (the settings page writes this for you):

```json
{ "platform": "Paperclip", "name": "Paperclip" }
```

Credentials are **not** stored in `config.json`. They live in `<homebridge storage>/paperclip/credentials.json`,
readable only by the Homebridge user, because SmartThings rotates the refresh token every time it renews.

## Command-line helper

```bash
npx homebridge-paperclip devices        # list ACs and what each one supports
npx homebridge-paperclip status         # raw SmartThings status (attach this to bug reports)
npx homebridge-paperclip doctor         # check the sign-in, the connection and whether the AC is online
npx homebridge-paperclip disconnect     # forget the SmartThings sign-in
```

Add `-U <path>` if your Homebridge storage folder isn't `~/.homebridge`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Log says "Not connected to SmartThings yet" | Finish the two steps in the settings page. No restart needed afterwards. |
| "SmartThings no longer accepts Paperclip's sign-in" | The refresh token expired (Homebridge was off for 30+ days) or access was revoked. Click **Reconnect**. |
| Connected, but "0 air conditioners" | You authorized a different SmartThings location. Click **Reconnect** and pick the one with your AC. |
| Step 1 says the token is missing permissions | Make a new token with *every* scope ticked, or use the CLI route above. |
| The tile says "No Response" | SmartThings or your internet was unreachable for three refreshes in a row. It recovers by itself. Check that the AC is online in the SmartThings app. |
| Changes take a few seconds to show | Paperclip shows your change immediately, then confirms it with SmartThings about 3 s later. Changes made on the remote show up within `pollInterval`. |
| The AC stops responding after the Homebridge machine switches networks | Set Homebridge's mDNS advertiser to **Ciao** (Homebridge UI → Settings → mDNS Advertiser, or `"advertiser": "ciao"` in the `bridge` block). It re-announces the bridge when the network changes; `bonjour-hap` doesn't and logs `EADDRNOTAVAIL`. HomeKit only reaches the bridge while it shares a network with your home hub. |
| Safari won't quit while the Homebridge UI is open | The UI's Terminal asks before closing a session you typed in. Add `"terminal": { "hideWarning": true }` to the UI's `config` block to turn that prompt off. |
| WindFree, Sleep or Turbo turns itself off | Samsung only allows these in some modes (usually Cool), so changing the mode cancels them. Only one can be on at a time. |
| "Turbo" appears twice | **Turbo switch** = Samsung's fast-cooling mode. **Turbo fan speed** = the top of the Fan tile's slider. They're separate settings on the AC too. |

Run Homebridge in debug mode (`-D`, or the *Debug* toggle in the UI) to log every SmartThings request.

## Development

```bash
git clone https://github.com/ckakkar/paperclip && cd paperclip
npm install
npm run check        # lint, typecheck, tests and build
npm link             # make your working copy visible to a local Homebridge
```

`PAPERCLIP_API_URL=http://127.0.0.1:8080/v1` points the plugin and CLI at a fake SmartThings server for local testing.

## Credits

Paperclip is its own code, informed by three Apache-2.0 projects. See [NOTICE](NOTICE).

- [homebridge-samsung-windfree-ac](https://github.com/igorxmath/homebridge-samsung-windfree-ac): Samsung capability names and the inverted display-light command
- [homebridge-smartthings-oauth](https://github.com/aziz66/homebridge-smartthings): the SmartThings OAuth wizard approach
- [homebridge-samsung-rac](https://github.com/Dean151/homebridge-samsung-rac): HeaterCooler mapping for dry and fan-only modes (it uses the older local API on port 8888, which this unit doesn't have)

Not affiliated with Samsung, SmartThings or Apple.

## License

[Apache-2.0](LICENSE)
