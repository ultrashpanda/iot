# backend

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
   cd backend
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

Other downlinks (scan time, blink, sleep, wake), Google geolocation from port 2, Docker.
