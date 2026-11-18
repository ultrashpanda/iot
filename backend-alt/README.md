# backend-alt

Alternative backend MVP, kept apart from `backend/` so that folder stays free for the backend
team's own code. It works end to end with the real nodes.


Receives the nodes' uplinks from TTN over MQTT, decodes them, stores them in SQLite and serves
`GET /api/devices` plus the frontend on the same origin. Includes a simulator with 20 fake devices.

```
TTN (MQTT) ─┐
            ├─▶ decode (uplink.rs) ─▶ store (SQLite + memory) ─▶ GET /api/devices ─▶ map
Simulator ──┘
```

Model and rules: [`docs/SoundScape-Messages-Team2-Backend.md`](../docs/SoundScape-Messages-Team2-Backend.md).

## Run on your computer (macOS / Linux)

1. Install Rust once: `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`
2. Configure:
   ```bash
   cd backend-alt
   cp .env.example .env                     # then paste your TTN API key into .env
   cp devices.example.json devices.json     # optional: real positions of the nodes
   ```
3. Start: `cargo run` (the first build takes 1 to 2 minutes)
4. Open **http://localhost:8080**

Without `TTN_API_KEY` only the simulator runs. With it, the log shows every real uplink:

```
[ttn] subscribed, waiting for uplinks
[uplink] 1-soundscape-device port 1 #42: 62.0 dB avg, 87.0 dB peak, crowd Some(26), Some(21.6) °C, Some(41) %, battery Some(86)
```

Real nodes send every 10 min (firmware default), so wait for the next uplink. The simulated
ones update every 5 s. Set `SIMULATOR_DEVICES=0` in `.env` to see only real nodes.

When the backend serves the frontend, it switches `DATA_MODE` to `'api'` on the fly, so
`frontend/js/config.js` does not need editing.

## Node positions

1. `devices.json`: installation position per node (phone GPS). This is the first position.
2. Wi-Fi geolocation: at every power-up the node sends the routers it sees (port 2). With
   `GOOGLE_API_KEY` in `.env`, the backend asks the Google Geolocation API and moves the marker.
   Needs 3 or more routers and an accuracy of 250 m or better; a fix more than 100 m from the
   previous position marks the node as "might have moved". Results are kept in `ap_scans`.
3. Neither: the marker gets a placeholder spot near the map centre.

The Google key must have the Geolocation API enabled and must **not** be restricted to websites
(referrers), because the server calls Google directly.

## Commands for a real node

Select a real node on the map. Under the measurements:

- **Uplink interval** + **Apply** → downlink `01 mm` (`POST /api/devices/{id}/interval`).
- **Restart node** (click twice) → downlink `06` (`POST /api/devices/{id}/reboot`). Needs
  firmware v0.8 or later; the button is disabled for nodes that report an older version on port 4.

The backend keeps the node's TTN downlink queue: a new interval replaces a queued one, a restart
always goes last, and TTN delivers one command after each uplink.

## Change a node's uplink interval

Select a real node on the map, pick an interval under the measurements and press **Apply**.
The backend sends downlink `01 mm` to TTN (`POST /api/devices/{id}/interval`). TTN delivers it
after the node's next uplink, so the panel shows it as pending until then.

The TTN API key needs the right **Write downlink application traffic**. Mind TTN fair use
(30 s airtime per node per day): at SF12 keep the interval at 75 min or more.

## Files

| File | |
|---|---|
| `src/uplink.rs` | Byte decoder (Team 2's reference, extended for firmware v0.3+: 11 byte port 1, battery, port 4) |
| `src/ttn.rs` | TTN MQTT client, TTN JSON → `RawUplink` |
| `src/geo.rs` | Google Geolocation API call, distance |
| `src/simulator.rs` | Fake devices that send real encoded bytes |
| `src/store.rs` | Device state, SQLite, online / sleeping / offline rules, API JSON |
| `src/api.rs` | HTTP routes and static frontend |
| `devices.json` | Installation position and name per TTN device id |

## Data

Every real uplink is kept raw in `soundscape.db` (table `uplinks`), decoded values in
`measurements`. On start the raw rows are replayed, so the map shows the last state right away.
Delete the file to start fresh.

## Tests

`cargo test` (decoder vectors from the Team 2 doc and from the firmware's `protocol.h`).

## Not done yet

Other downlinks (scan time, blink, sleep, wake), Docker.
