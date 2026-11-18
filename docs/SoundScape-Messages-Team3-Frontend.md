# SoundScape: What the node data means for the app (Team 3, frontend)

DTU 34365 IoT Prototyping · 12 Nov 2026

This guide explains what each node measures, how often it sends, and what every field in `GET /api/devices` means and how it should be shown. You never see raw bytes. The backend decodes everything into real units first.

---

## 1. Where the numbers come from

```
Node (sensors) ──LoRa──▶ TTN ──MQTT──▶ backend (decode, store, rules) ──▶ GET /api/devices ──▶ app
```

* Each node wakes up, measures for about 10 s, scans Wi-Fi, sends one small message and sleeps.
* **Default: one message every 5 min. Demo: every 1 min.** Values in the app only change that often for real nodes, even though you poll every 5 s.
* Simulated devices update every ~5 s, so they look much livelier than real ones.
* Real nodes can be put to **sleep** remotely. They then send only a short check-in (default every 30 min) and no measurements.

---

## 2. What a node measures

| Measurement | Sensor | Precision | Notes |
|---|---|---|---|
| Average sound | MAX4466 mic | 0.5 dB | Average over 10 s. Approximate dB SPL, **not** certified dB(A) |
| Peak sound | MAX4466 mic | 0.5 dB | Loudest moment in those 10 s. Max 127.5 dB |
| Crowd count | ESP-01 Wi-Fi scan | whole number | **Demo: number of Wi-Fi networks, not people** |
| Temperature | DHT22 | 0.1 °C | |
| Humidity | DHT22 | 1 % | |
| Position | Phone GPS at installation, checked by Wi-Fi | ~tens of m | Can be flagged "might have moved" |

Not measured: **battery voltage**. The backend sends an estimate instead (section 4).

---

## 3. The API: `GET /api/devices`

Your draft contract is the base. Fields marked **NEW** were added after talking to the hardware team and need your OK.

```json
{
  "generated_at": "2026-11-12T14:32:05Z",
  "devices": [
    {
      "id": "1-soundscape-device",
      "name": "North campsite",
      "latitude": 55.6185,
      "longitude": 12.0890,
      "might_have_moved": false,
      "noise_avg": 78.5,
      "noise_peak": 94.0,
      "noise_clipped": false,
      "crowd_count": 26,
      "crowd_source": "networks",
      "temperature": 8.3,
      "humidity": 63,
      "battery_voltage": null,
      "battery_estimate_pct": 82,
      "status": "online",
      "source": "physical",
      "last_updated": "2026-11-12T14:30:12Z"
    },
    {
      "id": "2-soundscape-device",
      "name": "East campsite",
      "latitude": 55.6152,
      "longitude": 12.0821,
      "might_have_moved": true,
      "noise_avg": 120.0,
      "noise_peak": 127.5,
      "noise_clipped": true,
      "crowd_count": null,
      "crowd_source": "networks",
      "temperature": null,
      "humidity": null,
      "battery_voltage": null,
      "battery_estimate_pct": null,
      "status": "sleeping",
      "source": "physical",
      "last_updated": "2026-11-12T13:58:40Z"
    },
    {
      "id": "sim-01",
      "name": "Demo monitoring point",
      "latitude": 55.6080,
      "longitude": 12.0720,
      "might_have_moved": false,
      "noise_avg": 68.0,
      "noise_peak": 78.5,
      "noise_clipped": false,
      "crowd_count": 14,
      "crowd_source": "networks",
      "temperature": 17.3,
      "humidity": 57,
      "battery_voltage": null,
      "battery_estimate_pct": 95,
      "status": "online",
      "source": "simulated",
      "last_updated": "2026-11-12T14:32:01Z"
    }
  ]
}
```

### Field reference

| Field | Type | Meaning | How to show it |
|---|---|---|---|
| `generated_at` | ISO 8601 string | Server time of this response | Use it, not the phone clock, to judge how old `last_updated` is |
| `id` | string | Stable unique ID | Key for updating markers |
| `name` | string | Place name, defaults to `id` | Marker label |
| `latitude`, `longitude` | string | WGS84 degrees | GeoJSON order is `[longitude, latitude]` |
| `might_have_moved` **NEW** | boolean | Wi-Fi check disagrees with the stored position | Small warning: "Position may be out of date" |
| `noise_avg` | float or null | dB, 0.5 dB steps | Main value, compare to the user's limit |
| `noise_peak` | float or null | dB | Secondary value |
| `noise_clipped` **NEW** | boolean | Sound was louder than the mic can measure | Show the peak as "≥ 127.5 dB" or "at least" |
| `crowd_count` **NEW** | int or null | Wi-Fi count | See `crowd_source` |
| `crowd_source` **NEW** | `networks` / `phones` | What the count means | `networks`: **don't show as people**, or hide it. `phones`: show as low/medium/high, never as a headcount |
| `temperature` | float or null | °C | `—` when null |
| `humidity` | int or null | % | `—` when null |
| `battery_voltage` | null | Not measured yet | Hide |
| `battery_estimate_pct` **NEW** | int or null | Estimate since the batteries went in | Label "Estimated battery". Staff info, not for visitors |
| `status` | `online` / `offline` / `sleeping` **NEW** | See section 4 | |
| `source` | `physical` / `simulated` | Real or fake | Always visibly different |
| `last_updated` | ISO 8601 string or null | Time of the latest measurement | null = never reported |

---

## 4. Status rules (set by the backend)

| Status | Means | Show as |
|---|---|---|
| `online` | Heard within 3 missed messages (15 min at the default interval) | Normal marker with values |
| `sleeping` **NEW** | Put to sleep on purpose, still checking in | Grey marker, "Paused", **no noise values**, not a quiet area |
| `offline` | Not heard for too long, or never | "Unavailable", **not a quiet area** |

A sleeping node keeps its last measurement in `noise_avg` etc., but it is old. Don't use it to suggest quiet areas.

---

## 5. Handling missing and odd values

* A sensor that failed sends `null`, not 0. Show `—`. Never treat a null noise value as quiet.
* All keys are always present, even when the value is `null`.
* Times are ISO 8601 UTC with `Z`. Convert to Danish time in the browser.
* Numbers come in real units with no scaling needed. Round for display yourself (for example 78.5 → "79 dB" is fine).
* New fields may be added later. Please ignore any field you don't know, so the app doesn't break.

---

## 6. Accessibility reminders tied to the data

* Never show noise by colour alone: show the dB value, a text label, and an icon or pattern.
* The personal noise limit lives in the browser. Changing it does **not** change anything on the node.
* `noise_clipped` means "very loud", so make sure it shows as the loudest level.
* Offline, sleeping and stale nodes must look clearly different from quiet ones.

---

## 7. Connecting

* The backend container also serves your static files, so the app and API share an origin and there is no CORS setup.
* In `js/config.js`: `DATA_MODE: 'api'`, `API_URL: '/api/devices'`.
* Poll every 5 s.

---

## 8. Questions back to you

1. OK with the **NEW** fields, or should some be left out for the MVP?
2. Should the crowd count be hidden completely while `crowd_source` is `networks`?
3. Do you want a separate staff view for `battery_estimate_pct` and downlinks later?
