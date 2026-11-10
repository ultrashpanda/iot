# Proposed REST contract (frontend ↔ backend)

This is a **proposal** for the backend team, **not an implemented endpoint**.
The frontend needs only one read-only endpoint for the MVP. MQTT, encryption,
SQLite, and simulation stay with the backend team.

## GET /api/devices

Response `200 OK`, `Content-Type: application/json`:

```json
{
  "devices": [
    {
      "id": "node-01",
      "name": "North campsite",
      "latitude": 55.607,
      "longitude": 12.071,
      "noise_avg": 76,
      "noise_peak": 89,
      "temperature": 18.5,
      "humidity": 63,
      "battery_voltage": 3.92,
      "status": "online",
      "source": "physical",
      "last_updated": "2026-11-10T08:30:00Z"
    },
    {
      "id": "sim-01",
      "name": "Demo monitoring point",
      "latitude": 55.608,
      "longitude": 12.072,
      "noise_avg": 68,
      "noise_peak": 78,
      "temperature": 17.3,
      "humidity": 57,
      "battery_voltage": 3.86,
      "status": "online",
      "source": "simulated",
      "last_updated": "2026-11-10T08:30:00Z"
    }
  ]
}
```

### Field rules

| Field | Type | Meaning |
|---|---|---|
| `id` | non-empty string | Stable, unique ID; important for updating markers |
| `name` | string | Human-readable place name, can default to `id` |
| `latitude`, `longitude` | numbers | WGS84 decimal degrees; stored at deployment |
| `noise_avg`, `noise_peak` | number or `null` | Approximate sound pressure level in dB (not certified dB(A)) |
| `temperature` | number or `null` | Degrees Celsius |
| `humidity` | number or `null` | Relative humidity (%) |
| `battery_voltage` | number or `null` | Volts |
| `status` | `online` / `offline` | Backend-assessed device availability |
| `source` | `physical` / `simulated` | Always distinguish genuine and simulated readings |
| `last_updated` | UTC ISO 8601 string | Time of latest measurement (not API response time) |

All measurements use decoded physical units rather than raw MCU byte values.
Missing optional measurements should be `null` and display as `—`.
The frontend treats missing/stale (>15 min) timestamps or offline status as
**unavailable**, not as a quiet area. The threshold is a **client-side preference**;
changing it does not send a LoRaWAN downlink or change device firmware.

### Expected behavior

- The same endpoint returns **both real and simulated** devices in one array.
- Device IDs and coordinates should remain stable between 5-second polls.
- When a sensor stops reporting, keep its record with `status: "offline"`, or
  preserve an old `last_updated` so the interface can visibly mark it stale.
- The backend simulator should produce at least **20 simulated devices**,
  with updates roughly every **5 seconds** (MVP acceptance test).
- When the backend is reachable on a different origin, configure CORS there or
  reverse-proxy the API under the same origin. The frontend never accesses MQTT.
- No authentication is needed for the read-only public measurements endpoint
  in this MVP; a future staff/downlink interface would need access controls.

### To connect the frontend

Edit `js/config.js`:

```js
DATA_MODE: 'api',
API_URL: '/api/devices', // or 'http://localhost:8080/api/devices'
```

Only `js/api.js` should need changes if the backend uses a different JSON schema.
