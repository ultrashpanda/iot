# Soundscape — accessible festival noise map

**Team 3 · Frontend only** | DTU 34365 IoT prototyping · Autumn 2026

A responsive website using **HTML, CSS, vanilla JavaScript, and Leaflet 1.9.4**.
No React, Vite, Node build, npm, or bundling required.

## What is implemented

- OpenStreetMap / Leaflet map with interactive sensor markers and a keyboard-accessible location list.
- 20 **clearly labeled simulated** nodes. **There are currently 0 physical nodes connected.**
- Automatic updates every 5 seconds without reloading the page.
- Average and peak sound, temperature, **humidity**, battery voltage, source and last-update time.
- A personal noise threshold (default 80 dB) persisted in browser local storage.
- Threshold categories using numeric labels, symbols and colors (never color alone).
- Readable mobile layout, focus indicators, semantic landmarks and an accessible location list.
- Clear notes about hearing exposure and the limitations of approximate sound measurements.
- A narrow API integration point to replace the mock data without redesigning the page.

## Run the website (Windows / macOS / Linux)

From the **`frontend/`** directory:

```bash
python -m http.server 8000
```

Then visit **http://localhost:8000** in your browser.

On Windows, `py -m http.server 8000` also works.

Do **not** open `index.html` via `file://`: ES modules are loaded over HTTP.
The browser needs Internet access for Leaflet CDN assets and OpenStreetMap tiles.

## Demo mode and real backend

By default, `js/config.js` sets `DATA_MODE: 'demo'`. This mode uses frontend-generated
fake measurements, and the UI displays a permanent, explicit simulation notice.
No MCU, TTN account, Docker, or backend is required for frontend development.

When the backend team is ready:

1. Agree on the response fields in [API_CONTRACT.md](./API_CONTRACT.md).
2. Set `DATA_MODE: 'api'` in `js/config.js`.
3. Set `API_URL` to the backend's actual URL (`/api/devices` if same-origin).
4. Reload. The same map handles real (`source: "physical"`) and simulated (`source: "simulated"`) devices side-by-side.

When API mode fails, the UI reports an error; it does **not** silently present fake data as live.

## File structure

```text
frontend/
├── index.html        # page / semantics
├── styles.css        # responsive design / accessible states
├── js/
│   ├── config.js     # mode, API URL, refresh interval
│   ├── demo.js       # 20 frontend test devices
│   ├── api.js        # data source + validation
│   └── app.js        # map, UI, threshold, selection, polling
├── API_CONTRACT.md   # proposed contract for backend team
└── README.md         # this file
```

## Quick manual QA

- [ ] Open the page with no hardware: banner states simulation and 20 sites appear.
- [ ] Wait 5 seconds: readings change without a page reload.
- [ ] Click a marker: detail section changes (includes humidity).
- [ ] Click a location in the list: map centers on it.
- [ ] Set threshold to 65 dB: marker icons and counts change.
- [ ] Enable "Below my limit only": location list filters; other map pins dim.
- [ ] Reload: the threshold is preserved.
- [ ] Resize to ~375 px wide: no horizontal scrolling; touch targets remain usable.
- [ ] Tab through controls: visible keyboard focus and usable location list.
- [ ] Set API mode without a backend: visible error (never silent fake data).

## Scope boundaries

Only files under `frontend/` belong to this part of the project.
This work does not implement TTN, backend simulation, MQTT, encryption, SQLite,
LoRaWAN downlinks, or microcontroller code.

The initial map positions are **fictional demonstration coordinates**, not official
Roskilde campsite positions. A future real deployment should use verified device locations.
The personal threshold is a visual preference, **not an assessed safety limit**.
