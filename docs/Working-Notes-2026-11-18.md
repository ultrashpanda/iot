# Working notes, 18 Nov 2026

What was set up on 18 Nov, what is still open, and what we learned on the way. The how-to for
running things is in [`backend-alt/README.md`](../backend-alt/README.md) and [`mcu/README.md`](../mcu/README.md).

## 1. Where things stand

| Part | State |
|---|---|
| `mcu/` | Firmware **v0.8** (remote restart, downlink `06`). Merged, **not tested on hardware**. PR #8 (TJv4) fixed missing `config.h` defines, so it compiles now. |
| Node 1 (`1-soundscape-device`) | Runs **v0.7**, which reports itself as **0.6** on port 4 (typo fixed in v0.8). |
| `backend-alt/` | Works end to end with node 1: TTN uplinks over MQTT, decoding, SQLite, map. |
| Wi-Fi geolocation | Works: 5 routers → Google fix ±18 m, position correct. |
| Interval downlink | TTN accepted `01 02` (2 min) at 12:33. Whether the node applied it was **not confirmed yet**. |
| Restart button | In the web UI, enabled only for nodes on firmware 0.8+. |
| Sleep / wake | In the web UI (downlinks `04` / `05`, every firmware version). Not tested on a node yet. |
| `backend/` | Untouched, left for the backend team's own code. |
| `frontend/` | Hide simulated switch, slim header, phones / battery % / signal, interval and restart controls. |

Seen once: node 1 restarted on its own (`port 2 #0` right after the interval downlink was queued).
Cause unknown. The port 4 reset cause of the next boot will tell (0x08 watchdog, 0x04 brown-out,
0x01 power-on).

## 2. To do

- [ ] **Team 1:** flash v0.8 on one node, send `06` from the TTN console, check it restarts and
      reports `fw 0.8` and reset cause `0x08`. Then flash the other nodes.
- [ ] Confirm the 2 min interval test. Then **set node 1 back to 10 min** (2 min breaks TTN fair use).
- [ ] **Backend team:** upload their own code to `backend/`, including the original `uplink.rs`
      (the only GitHub copy is the extended one in `backend-alt/src/uplink.rs`).
- [ ] **Team 1:** update stale paths in `Roskilde-Node-Message-Protocol.md`
      (`roskilde_node_demo/`, `ttn/payload_formatter.js`, `server/send_downlink.py`) and note that
      the server now uses MQTT, not a webhook.
- [ ] Delete merged branches on GitHub (Branches page): `feat/backend-mvp`, `feat/backend-alt`,
      `feat/frontend-mvp`, `feat/fw-v0.8-reboot`, `feat/hide-simulated`, `feat/mcu-firmware`.
- [ ] Optional: `backend-alt/devices.json` with each node's installation position (fallback when
      fewer than 3 routers are visible).
- [ ] Test sleep and wake on node 1: sleep 30 min with check-in 5 min, then wake.
- [ ] Not built yet: UI for the scan time and blink downlinks; Docker.

## 3. Keys (no secrets in this file)

| Key | What for | Where it goes |
|---|---|---|
| TTN **API key** (`NNSXS....`) | Server reads uplinks and sends downlinks | `backend-alt/.env` → `TTN_API_KEY` |
| TTN **OTAA keys** (AppEUI, AppKey, DevEUI) | Node joins TTN over LoRa, one set per node | `secrets.h`, flashed into the node |
| **Google** API key | Wi-Fi geolocation | `backend-alt/.env` → `GOOGLE_API_KEY` |

- The TTN API key needs **Read application traffic** and **Write downlink application traffic**.
  `NotAuthorized` on connect means wrong key, wrong app id or missing rights. OTAA keys do not work there.
- The Google key needs the **Geolocation API** enabled and must **not** be restricted to websites
  (referrers): the server calls Google directly.
- `secrets.h` is never in git (`.gitignore`). It is at the **root of the Teams folder**: copy it into
  `mcu/Roskilde_Node/` before flashing, with the values of that node.
- Node 1's AppKey was shared outside the TTN console once. Rotating it in TTN (and reflashing) is optional.

## 4. TTN and radio limits

Per node: **30 s of airtime per day** and **10 downlinks per day** (TTN fair use), plus the legal
**1 % duty cycle** in EU868. Minimum uplink interval for the 11 byte port 1 message:

| SF | Airtime | Minimum interval |
|---|---|---|
| SF7 | 0.06 s | 3 min |
| SF8 | 0.11 s | 6 min |
| SF9 | 0.21 s | 10 min |
| SF10 | 0.37 s | 18 min |
| SF11 | 0.74 s | 36 min |
| SF12 | 1.48 s | 75 min |

- The SF is shown in TTN → Live data → uplink. `config.h` has `LORA_DR 0` (SF12), used when the SF7 join fails.
- 5 min is fine only at SF7. 1 and 2 min are for short debugging.
- Firmware v0.7 already uses ~3 downlinks per day (~6 on a boot day), so ~4 to 7 are left for commands.
- A downlink arrives only after the node's next uplink (class A). A rejoin can drop queued downlinks.

## 5. Things we learned

- **Quick node test:** power-cycling a node makes it send port 2 (Wi-Fi scan) and port 4 (boot info)
  within ~1 min, instead of waiting for the interval.
- The server only gets uplinks while it is connected to TTN; earlier ones are not replayed.
- The server log now has the time and TTN's downlink events: `queued` → `sent` → applied on the next uplink.
  No `queued` means TTN refused it; `failed` prints TTN's reason.
- Firmware v0.3+ sends **11 bytes** on port 1 (battery added) and has a port 4. Team 2's original
  `uplink.rs` only read 8 bytes; `backend-alt` reads both. Keep `protocol.h` and the decoder in step.
- Firmware cannot be updated over LoRa. Flashing needs the node on USB (settings in `mcu/README.md`).
- macOS zsh: don't paste commands with `# comments`, they break.
- If the web page looks half updated, reload with Cmd + Shift + R (the server now sends `no-cache`).

## 6. Teams folder after the clean-up

`IoT prototyping - General` keeps only what is not in GitHub: Word files (`Minimun viable prototype...docx`,
`Other things/`), `Loop paragraph.loop`, `secrets.h`, plus `Arduino-Node-Programming/` (v0.7). Removed
there because they are in GitHub: `Roskilde Node Hardware Map.html`, `uplink.rs`
(SharePoint's recycle bin still has them).
