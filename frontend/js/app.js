import { CONFIG } from './config.js';
import { fetchDevices, normalizeDevices, conditionFor } from './api.js';

const $ = (id) => document.getElementById(id);
const state = { devices: [], threshold: initialThreshold(), belowOnly: false, selectedId: null, map: null, markers: new Map(), refreshing: false };

function initialThreshold() {
  try {
    const saved = Number(localStorage.getItem('soundscape-threshold-db'));
    return saved >= 55 && saved <= 105 && saved % 5 === 0 ? saved : CONFIG.DEFAULT_THRESHOLD_DB;
  } catch { return CONFIG.DEFAULT_THRESHOLD_DB; }
}
function saveThreshold(value) { try { localStorage.setItem('soundscape-threshold-db', String(value)); } catch { /* private mode */ } }
function formatNumber(value, digits = 0) { return value === null || value === undefined ? '—' : Number(value).toFixed(digits); }
function formatReading(value, suffix, digits = 0) { return value === null || value === undefined ? '—' : `${formatNumber(value, digits)} ${suffix}`; }
function relativeTime(iso) {
  if (!iso) return 'Update time unknown';
  const secs = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
  if (secs < 15) return 'Updated just now';
  if (secs < 60) return `Updated ${secs} sec ago`;
  const mins = Math.floor(secs / 60);
  return mins < 60 ? `Updated ${mins} min ago` : `Updated ${Math.floor(mins / 60)} h ago`;
}
function statusLabel(condition) { return condition === 'under' ? 'At/below limit' : condition === 'over' ? 'Above limit' : 'Unavailable'; }
function getSelected() { return state.devices.find((dev) => dev.id === state.selectedId) ?? null; }

function setConnection(status) {
  const el = $('connection-badge');
  el.className = `connection-badge connection-badge--${status}`;
  el.textContent = CONFIG.DATA_MODE === 'demo' ? 'SIMULATION · NO LIVE SENSORS' : status === 'error' ? 'API DISCONNECTED' : status === 'loading' ? 'CONNECTING…' : 'API CONNECTED';
}
function banner(message, type = 'info') {
  const el = $('message-banner');
  el.hidden = !message;
  el.className = `message-banner message-banner--${type}`;
  el.textContent = message || '';
}

function initMap() {
  if (!window.L) {
    $('map-fallback').hidden = false;
    $('map').classList.add('map-unavailable');
    $('reset-map').disabled = true;
    return;
  }
  const L = window.L;
  state.map = L.map('map', { scrollWheelZoom: false, zoomControl: true }).setView(CONFIG.MAP_CENTER, CONFIG.MAP_ZOOM);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19,
  }).addTo(state.map);
  $('reset-map').addEventListener('click', () => state.map.setView(CONFIG.MAP_CENTER, CONFIG.MAP_ZOOM));
}

function markerIcon(device, condition, selected, dimmed) {
  const L = window.L;
  const glyph = condition === 'under' ? '✓' : condition === 'over' ? '!' : '–';
  const number = device.noise_avg === null || condition === 'unavailable' ? '—' : String(Math.round(device.noise_avg));
  const css = `sensor-pin sensor-pin--${condition}${selected ? ' sensor-pin--selected' : ''}${dimmed ? ' sensor-pin--dim' : ''}`;
  return L.divIcon({ className: 'leaflet-sensor-icon', html: `<div class="${css}"><span class="pin-glyph" aria-hidden="true">${glyph}</span><strong>${number}</strong><small>dB</small></div>`, iconSize: [84, 44], iconAnchor: [42, 22], popupAnchor: [0, -22] });
}
function renderMap() {
  if (!state.map) return;
  const L = window.L;
  const present = new Set(state.devices.map((d) => d.id));
  for (const [id, marker] of state.markers) {
    if (!present.has(id)) { state.map.removeLayer(marker); state.markers.delete(id); }
  }
  for (const device of state.devices) {
    const condition = conditionFor(device, state.threshold);
    const dimmed = state.belowOnly && condition !== 'under';
    const icon = markerIcon(device, condition, device.id === state.selectedId, dimmed);
    let marker = state.markers.get(device.id);
    if (!marker) {
      marker = L.marker([device.latitude, device.longitude], { icon, keyboard: true, title: `${device.name}: ${statusLabel(condition)}` });
      marker.on('click', () => selectDevice(device.id, false));
      marker.addTo(state.map);
      state.markers.set(device.id, marker);
    } else {
      marker.setLatLng([device.latitude, device.longitude]);
      marker.setIcon(icon);
    }
    marker.setZIndexOffset(device.id === state.selectedId ? 900 : 0);
    const el = marker.getElement();
    if (el) el.setAttribute('aria-label', `${device.name}: ${formatReading(device.noise_avg, 'dB')}. ${statusLabel(condition)}`);
  }
}

function renderStats() {
  const reporting = state.devices.filter((d) => conditionFor(d, state.threshold) !== 'unavailable');
  const under = reporting.filter((d) => conditionFor(d, state.threshold) === 'under');
  const lowest = reporting.reduce((min, d) => !min || d.noise_avg < min.noise_avg ? d : min, null);
  $('stat-total').textContent = String(reporting.length);
  const physical = reporting.filter((d) => d.source === 'physical').length;
  const simulated = reporting.filter((d) => d.source === 'simulated').length;
  $('stat-source-split').textContent = `${physical} physical · ${simulated} simulated`;
  $('stat-under').textContent = `${under.length} / ${reporting.length}`;
  $('stat-lowest').textContent = lowest ? `${Math.round(lowest.noise_avg)} dB` : '—';
  $('stat-lowest-name').textContent = lowest ? lowest.name : 'No recent readings';
}

function makeLocationButton(device) {
  const condition = conditionFor(device, state.threshold);
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `location-row${device.id === state.selectedId ? ' is-selected' : ''}`;
  btn.dataset.deviceId = device.id;
  btn.setAttribute('aria-pressed', String(device.id === state.selectedId));
  const left = document.createElement('span'); left.className = 'location-left';
  const marker = document.createElement('span'); marker.className = `row-state row-state--${condition}`;
  marker.textContent = condition === 'under' ? '✓' : condition === 'over' ? '!' : '–';
  marker.setAttribute('aria-hidden', 'true');
  const texts = document.createElement('span'); texts.className = 'location-text';
  const name = document.createElement('strong'); name.textContent = device.name;
  const detail = document.createElement('small'); detail.textContent = `${statusLabel(condition)} · ${device.source === 'simulated' ? 'Simulated' : device.source === 'physical' ? 'Physical node' : 'Source unknown'}`;
  texts.append(name, detail); left.append(marker, texts);
  const reading = document.createElement('span'); reading.className = 'location-value';
  reading.textContent = condition === 'unavailable' ? '—' : formatNumber(device.noise_avg);
  const suffix = document.createElement('small'); suffix.textContent = ' dB'; reading.append(suffix);
  btn.append(left, reading);
  btn.addEventListener('click', () => selectDevice(device.id, true));
  return btn;
}
function renderList() {
  const active = document.activeElement;
  const focusedId = active?.closest?.('[data-device-id]')?.dataset.deviceId ?? null;
  const filtered = state.devices
    .filter((d) => !state.belowOnly || conditionFor(d, state.threshold) === 'under')
    .sort((a, b) => {
      const ca = conditionFor(a, state.threshold) === 'unavailable' ? 1 : 0;
      const cb = conditionFor(b, state.threshold) === 'unavailable' ? 1 : 0;
      return ca - cb || (a.noise_avg ?? Infinity) - (b.noise_avg ?? Infinity);
    });
  $('location-list').replaceChildren(...filtered.map(makeLocationButton));
  $('list-count').textContent = `${filtered.length} of ${state.devices.length} locations`;
  $('list-empty').hidden = filtered.length > 0;
  if (focusedId) {
    const target = Array.from($('location-list').children).find((node) => node.dataset.deviceId === focusedId);
    target?.focus({ preventScroll: true });
  }
}
function renderDetail() {
  const d = getSelected();
  if (!d) return;
  const condition = conditionFor(d, state.threshold);
  $('detail-title').textContent = d.name;
  $('detail-status').className = `detail-status detail-status--${condition}`;
  $('detail-status').textContent = statusLabel(condition);
  $('detail-avg').textContent = formatReading(d.noise_avg, 'dB');
  $('detail-peak').textContent = formatReading(d.noise_peak, 'dB');
  $('detail-temp').textContent = formatReading(d.temperature, '°C', 1);
  $('detail-humidity').textContent = formatReading(d.humidity, '%', 0);
  $('detail-battery').textContent = formatReading(d.battery_voltage, 'V', 2);
  $('detail-source').textContent = d.source === 'simulated' ? 'Simulated reading · illustrative location' : d.source === 'physical' ? 'Physical sensor · prototype measurement' : 'Sensor source unspecified';
  $('detail-time').textContent = relativeTime(d.last_updated);
}
function renderEverything() { renderThresholdWarning(); renderStats(); renderMap(); renderList(); renderDetail(); }
function renderThresholdWarning() { $('threshold-warning').hidden = state.threshold <= 80; }
function selectDevice(id, moveMap) {
  state.selectedId = id;
  renderMap(); renderList(); renderDetail();
  const d = getSelected();
  if (moveMap && d && state.map) state.map.panTo([d.latitude, d.longitude], { animate: true });
}

async function refresh() {
  if (state.refreshing) return;
  state.refreshing = true;
  $('refresh-button').disabled = true;
  try {
    const response = await fetchDevices();
    state.devices = normalizeDevices(response.devices);
    if (!state.devices.some((d) => d.id === state.selectedId)) {
      state.selectedId = state.devices.find((d) => conditionFor(d, state.threshold) !== 'unavailable')?.id ?? state.devices[0]?.id ?? null;
    }
    renderEverything();
    $('last-refresh').textContent = `Refreshed ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
    setConnection('connected');
    banner(CONFIG.DATA_MODE === 'demo' ? 'Demo mode: all locations, coordinates and readings are simulated. No physical sensors are connected yet.' : '', 'info');
  } catch (err) {
    setConnection('error');
    banner(`Could not update measurements: ${err.message}. Previously loaded readings, if any, may be outdated.`, 'error');
    console.error('Device data refresh failed:', err);
  } finally {
    state.refreshing = false;
    $('refresh-button').disabled = false;
  }
}

function init() {
  $('threshold').value = String(state.threshold);
  $('threshold-output').textContent = String(state.threshold);
  $('threshold').addEventListener('input', (event) => {
    state.threshold = Number(event.target.value);
    $('threshold-output').textContent = String(state.threshold);
    saveThreshold(state.threshold);
    renderEverything();
  });
  $('below-only').addEventListener('change', (event) => {
    state.belowOnly = event.target.checked;
    renderMap(); renderList();
  });
  $('refresh-button').addEventListener('click', refresh);
  initMap();
  setConnection('loading');
  refresh();
  setInterval(refresh, CONFIG.REFRESH_MS);
  // Refresh "updated X min ago" even when API is disconnected.
  setInterval(() => { if (!state.refreshing) { renderStats(); renderMap(); renderDetail(); } }, 30_000);
}
init();
