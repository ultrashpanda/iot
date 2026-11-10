/** Frontend mock source ONLY. It never impersonates live festival measurements. */
const START = Date.now();
const labels = [
  'North campsite', 'East meadow', 'South campsite', 'West campsite',
  'Quiet corner A', 'Walkway north', 'Tent village', 'Rest point west',
  'Central path', 'Food area', 'Rest point east', 'Green field',
  'Entrance path', 'Camp avenue', 'West meadow', 'South path',
  'Quiet corner B', 'Open lawn', 'Camp crossing', 'Outer meadow',
];
const center = { lat: 55.607, lng: 12.071 };

function fixedLocations(count) {
  return Array.from({ length: count }, (_, index) => {
    // Deterministic *fictional* positions for the UI test. NOT official campsites.
    const ring = Math.floor(index / 7) + 1;
    const angle = index * 2.39996;
    const radius = 0.0018 + ring * 0.00125;
    return {
      id: `sim-${String(index + 1).padStart(2, '0')}`,
      name: labels[index] ?? `Simulated area ${index + 1}`,
      latitude: Number((center.lat + Math.cos(angle) * radius).toFixed(6)),
      longitude: Number((center.lng + Math.sin(angle) * radius * 1.8).toFixed(6)),
      baseNoise: [62, 72, 87, 81, 59, 75, 94, 65, 82, 88, 68, 77, 90, 84, 71, 97, 61, 73, 86, 69][index % 20],
    };
  });
}

const sites = fixedLocations(20);

/** Returns exactly the same structure as the proposed GET /api/devices. */
export async function getDemoData() {
  const now = Date.now();
  const tick = Math.floor((now - START) / 5000);
  return {
    devices: sites.map((site, index) => {
      const jitter = Math.sin(tick * 0.83 + index * 1.7) * 3.7 + Math.cos(tick * 0.35 + index) * 1.2;
      const noise = Math.round(Math.max(48, Math.min(112, site.baseNoise + jitter)));
      const offline = index === 18; // exercises the stale/unavailable UI
      return {
        id: site.id,
        name: site.name,
        latitude: site.latitude,
        longitude: site.longitude,
        noise_avg: noise,
        noise_peak: noise + 6 + (index % 11),
        temperature: Number((16.8 + (index % 6) * 0.7 + Math.sin(tick / 6 + index) * 0.4).toFixed(1)),
        humidity: Math.round(50 + (index % 6) * 5 + Math.sin(tick / 8 + index) * 3),
        battery_voltage: Number((3.75 + (index % 6) * 0.06).toFixed(2)),
        status: offline ? 'offline' : 'online',
        source: 'simulated',
        last_updated: new Date(now - (offline ? 35 * 60 * 1000 : (index % 3) * 1000)).toISOString(),
      };
    }),
  };
}
