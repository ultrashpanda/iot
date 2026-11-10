import { CONFIG } from './config.js';
import { getDemoData } from './demo.js';

/** The only module that knows where measurements come from. */
export async function fetchDevices() {
  if (CONFIG.DATA_MODE === 'demo') return getDemoData();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(CONFIG.API_URL, { headers: { Accept: 'application/json' }, cache: 'no-store', signal: controller.signal });
    if (!response.ok) throw new Error(`API returned HTTP ${response.status}`);
    const data = await response.json();
    if (!data || !Array.isArray(data.devices)) throw new Error('Expected JSON with a devices array');
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

function validNumber(value, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) return null;
  return value;
}

/** Discards bad coordinates, tolerates missing optional sensor readings. */
export function normalizeDevices(rawDevices) {
  const seen = new Set();
  return rawDevices.flatMap((raw) => {
    if (!raw || typeof raw.id !== 'string' || !raw.id.trim() || seen.has(raw.id)) return [];
    const latitude = validNumber(raw.latitude, -90, 90);
    const longitude = validNumber(raw.longitude, -180, 180);
    if (latitude === null || longitude === null) return [];
    seen.add(raw.id);
    const dateMs = Date.parse(raw.last_updated ?? '');
    return [{
      id: raw.id,
      name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : raw.id,
      latitude, longitude,
      noise_avg: validNumber(raw.noise_avg, 0, 150),
      noise_peak: validNumber(raw.noise_peak, 0, 150),
      temperature: validNumber(raw.temperature, -60, 80),
      humidity: validNumber(raw.humidity, 0, 100),
      battery_voltage: validNumber(raw.battery_voltage, 0, 24),
      source: raw.source === 'simulated' ? 'simulated' : raw.source === 'physical' ? 'physical' : 'unknown',
      status: raw.status === 'offline' ? 'offline' : 'online',
      last_updated: Number.isFinite(dateMs) ? new Date(dateMs).toISOString() : null,
    }];
  });
}

export function conditionFor(device, threshold, now = Date.now()) {
  const observed = device.last_updated ? Date.parse(device.last_updated) : NaN;
  if (device.status === 'offline' || !Number.isFinite(observed) || now - observed > CONFIG.STALE_AFTER_MS || observed > now + 60 * 1000 || device.noise_avg === null) return 'unavailable';
  return device.noise_avg <= threshold ? 'under' : 'over';
}
