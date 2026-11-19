# SoundScape — mobile-first IoT festival map

A standalone frontend: HTML, CSS, JavaScript, MapLibre GL, Nginx and Docker. No backend code is bundled. Source map features are taken from the user-provided OpenStreetMap export and are referenced by GPS coordinates.

## Features
- Version 5.6: text symbols replaced by a small set of vector line icons (`js/icons.js`: speaker, waveform, thermometer, droplet, Wi-Fi, battery, gauge, crosshair, compass needle…), crisp on every device; the app logo symbol is now a centred vector (same as the poster logo). `TEST_POSITIONS` is back in `js/config.js`.
- Version 5.4: the place sheet's *More details* also shows **Estimated battery** (`battery_estimate_pct`) and **Battery voltage** (`battery_voltage`, shown as "Not measured" while the backend sends null). Note: the Team 3 contract describes the battery estimate as staff information.
- Version 5.3: the app always reads the real nodes from the backend (`API_URL`, default `/api/devices` = same origin as in the Team 3 contract). The **Simulated nodes** button adds the 14 simulated nodes on top; they carry a dashed **SIM** tag on the map and "Simulated" in the place sheet. If the backend is unreachable the status chip says so and the simulated nodes still work. While simulated nodes (or `TEST_POSITIONS`) are on, the draggable demo position is available. `DATA_MODE` and `?mode=` were removed; use `SIMULATED_BUTTON` / `SIMULATED_ON_START` in `js/config.js`.
- Version 5.2: `TEST_POSITIONS` in `js/config.js` (tests only) shows a real node at a chosen festival position while keeping all its real measurements; the place sheet says it is a test position and shows the real coordinates. While the list is not empty the draggable demo position is also available in `api` mode. Nodes outside the festival map are reported by an orange "outside the map" chip (tap it to see their name, id and position). Keep `TEST_POSITIONS: {}` for the real festival.
- Version 5.1: only the *Quietest spot* shortcut is kept. API responses are normalised (numbers sent as strings are accepted, unknown `status` counts as offline, devices without id/coordinates are skipped). `?mode=demo` / `?mode=api` in the page address overrides `DATA_MODE` for testing.
- Version 5.0: map engine switched from Leaflet to MapLibre GL (bundled in `vendor/maplibre/`, needs WebGL). The basemap is drawn as vector layers straight from `data/festival.geojson` (no pre-rendered SVG any more). Sensor places are soft coloured sound "blobs" sized in metres (louder = larger), with the dB value on top and the name when zoomed in. Routes follow mapped roads and paths (graph built from the OSM extract) and only cut across open fields for short stretches or when the path detour is much longer (`OFFROAD_FACTOR` in `js/config.js`). While navigating the map turns heading-up so the next stretch of the route points up; the compass button switches north-up / heading-up. Remaining distance is shown, and the route is recomputed when you are more than ~35 m off it. In demo mode, *Start navigation* simulates walking along the route so rotation can be tested on a PC.
- Version 4.2: Leaflet 1.9.4 is bundled in `vendor/leaflet/` instead of loaded from unpkg. The previous `leaflet.css` integrity hash was wrong, so browsers rejected the stylesheet and the map broke (empty green map, tiny location dot, misplaced markers). A visible warning now appears if the Leaflet CSS ever fails to load.
- Version 4.1: cache-busting (`?v=` on every CSS/JS/data URL — bump it in `index.html` and the JS imports on each release), relative asset paths, `serve.py` no-cache local server, taller basemap so routes fit above the route panel, festival overview when the demo position starts automatically.
- Version 4: map locked to the drawn basemap (`MAP_BOUNDS`): the minimum zoom always fills the screen, so no empty background is ever visible; basemap widened around the festival. Sensor nodes are plain coloured circles with the dB value, names appear when zoomed in (`LABEL_ZOOM`) or when selected. 14 simulated nodes placed on estimated Roskilde Festival locations (edit in `js/api.js`). Clear pulsing GPS dot; in demo mode a draggable demo position is used automatically when GPS is denied or outside the festival. GPS timeouts no longer stop tracking. Routing: railway only crossable at mapped crossings, noise penalty based on absolute level + your limit, smoothed lines, both routes compared (time and estimated dB), navigation follows you and detects arrival.
- Version 3: one vector basemap, continuous fractional mouse-wheel zoom, prominent 48px GPS dot, explicit SIM marker badges and sensor count, and no-cache static responses.
- Version 2: batched map line rendering, smoother fractional zoom, automatic GPS on opening, and 14 explicitly simulated devices in demo mode.
- GPS outside the festival never recenters to an empty map. Press **Demo** on the map to test a simulated festival position; press **GPS** to switch back. This toggle is available only in demo mode.
- Clean OSM-based geography (roads/paths, mapped water, greenery), sensor markers from the REST API, location tracking and responsive mobile bottom sheet.
- User-adjustable noise limit stored locally; quietest/loudest shortcut; simulated sensor status clearly shown.
- Compact/expanded node detail sheet. `crowd_source: networks` is displayed only as **Wi-Fi networks detected**, not people. Battery is intentionally hidden.
- Estimated **Fastest** and **Quieter** paths, computed locally with a bounded grid and A*. Current mapped water polygons are excluded. Quieter applies an approximate noise penalty near valid sensors. Does not account for event closures, fences, non-water barriers or unknown terrain. It is NOT reliable safety/navigation advice.
- GPS with permission over HTTPS; optional explicit **Try demo location** for testing.

## Launch locally without Docker
From the app folder:
```sh
python serve.py
```
Then open `http://localhost:8080` (not `file://`). `serve.py` is a plain Python static server with browser caching disabled.

## Launch the frontend Docker container
```sh
docker build --no-cache -t soundscape-frontend .
docker run --rm --name soundscape-frontend -p 8080:80 soundscape-frontend
```
Open http://localhost:8080. This is completely separate from the backend container.

## Connect to the backend
Edit `js/config.js`:
```js
API_URL: '/api/devices',        // same origin when the backend container serves the app
SIMULATED_BUTTON: true,         // false hides the "Simulated nodes" button (e.g. at the festival)
SIMULATED_ON_START: false,
```
Backend needs HTTPS and **CORS** allowing the frontend website's origin if the browser requests the API on a different origin. No localhost backend address is suitable for external users. Backend must return the JSON described in `SoundScape-Messages-Team3-Frontend.md` and should not expose private TTN credentials to the browser. API requests repeat every 5 seconds.

## GPS and navigation cautions
Geolocation needs browser authorization and a secure context (HTTPS in deployment, localhost during development). The route calculator operates only inside the OSM export bounds, avoids **mapped water only**, and assumes other cells are traversable. Unmapped ponds, closed gates, fences, crowd controls, roads and temporary festival stages may make routes unsafe or inaccessible. Avoid presenting this as guaranteed navigation. For actual visitor-facing navigation, obtain the festival's approved walkable-area map before enabling routes.

A user can explore the estimated route via a visibly fake demo start when GPS is unavailable. Non-current, sleeping, or offline devices do not influence navigation or the quietest/loudest shortcut. Simulated readings can be used for a demo if no real readings are online; they are visibly labeled.

## Map source
OpenStreetMap contributors © OpenStreetMap: https://www.openstreetmap.org/copyright. ODbL attribution is included on screen. `data/festival.geojson` is a simplified thematic extraction from `map.osm`. See `build_soundscape_data.py` at the archive root if included.

## Files
- `js/config.js` — API mode and URL, reference bounds
- `js/api.js` — REST contract and local demo
- `js/map.js` — MapLibre map, sound blobs, labels, location and route layers
- `js/routing.js` — path-network + open-field A* routing, noise penalty, route progress/bearing
- `js/app.js` — UI, bottom sheets and GPS
- `js/icons.js` — vector line icons used across the UI
- `vendor/maplibre/` — MapLibre GL JS 4.7.1 (BSD-3-Clause, see LICENSE.txt)
- `serve.py` — local no-cache test server
- `data/festival.geojson` — georeferenced OSM extracted features
