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
      // Optional extras from the backend (null in demo mode).
      battery_pct: validNumber(raw.battery_estimate_pct, 0, 100),
      crowd_count: validNumber(raw.crowd_count, 0, 65535),
      crowd_source: raw.crowd_source === 'networks' ? 'networks' : 'phones',
      rssi: validNumber(raw.rssi, -200, 0),
      interval_min: validNumber(raw.interval_min, 1, 240),
      might_have_moved: raw.might_have_moved === true,
      position_source: typeof raw.position_source === 'string' ? raw.position_source : null,
      position_accuracy_m: validNumber(raw.position_accuracy_m, 0, 1e7),
      pending_interval_min: validNumber(raw.pending_interval_min, 1, 240),
      pending_reboot: raw.pending_reboot === true,
      checkin_min: validNumber(raw.checkin_min, 1, 255),
      sleep_minutes_left: validNumber(raw.sleep_minutes_left, 0, 65535),
      pending_sleep_min: validNumber(raw.pending_sleep_min, 0, 65535),
      pending_sleep_checkin_min: validNumber(raw.pending_sleep_checkin_min, 1, 255),
      pending_wake: raw.pending_wake === true,
      reboot_supported: typeof raw.reboot_supported === 'boolean' ? raw.reboot_supported : null,
      firmware: typeof raw.firmware === 'string' ? raw.firmware : null,
      source: raw.source === 'simulated' ? 'simulated' : raw.source === 'physical' ? 'physical' : 'unknown',
      status: raw.status === 'offline' ? 'offline' : raw.status === 'sleeping' ? 'sleeping' : 'online',
      last_updated: Number.isFinite(dateMs) ? new Date(dateMs).toISOString() : null,
    }];
  });
}

async function postCommand(id, command, body) {
  const response = await fetch(`${CONFIG.API_URL}/${encodeURIComponent(id)}/${command}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}),
  });
  if (!response.ok) throw new Error((await response.text()) || `HTTP ${response.status}`);
}
/** Asks the backend to send an interval downlink to a real node. */
export const setUplinkInterval = (id, minutes) => postCommand(id, 'interval', { minutes });
/** Sleep for `minutes` (0 = until woken), checking in every `checkinMin` minutes. */
export const sleepNode = (id, minutes, checkinMin) => postCommand(id, 'sleep', { minutes, checkin_min: checkinMin });
/** Wake a sleeping node (delivered after its next check-in), or cancel a queued sleep. */
export const wakeNode = (id) => postCommand(id, 'wake');
/** Asks the backend to send a restart downlink (firmware v0.8+). */
export const restartNode = (id) => postCommand(id, 'reboot');

export function conditionFor(device, threshold, now = Date.now()) {
  const observed = device.last_updated ? Date.parse(device.last_updated) : NaN;
  if (device.status === 'offline' || device.status === 'sleeping' || !Number.isFinite(observed) || now - observed > CONFIG.STALE_AFTER_MS || observed > now + 60 * 1000 || device.noise_avg === null) return 'unavailable';
  return device.noise_avg <= threshold ? 'under' : 'over';
}
