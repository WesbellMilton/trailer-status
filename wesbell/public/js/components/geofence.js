/**
 * geofence.js — client-side geofencing component
 *
 * Tracks the driver's GPS position, computes ETA, detects zone entry/exit,
 * sends updates to /api/driver/location, and auto-triggers arrive when
 * the server signals autoTriggered=true.
 */
import { apiPost }  from '../api.js';
import { store }    from '../state.js';

// ── Zone definitions (mirrors server config, loaded via /api/geofence/zones) ──
let ZONES = [];

// ── State ─────────────────────────────────────────────────────────────────────
let _trailer     = null;
let _watcher     = null;
let _interval    = null;
let _lastLat     = null;
let _lastLng     = null;
let _inZones     = new Set();
let _onArrive    = null;     // callback(door) when geofence auto-arrive fires
let _onEta       = null;     // callback(eta) when ETA updates

const SEND_INTERVAL_MS = 30_000;   // send GPS every 30 s while active
const MIN_ACCURACY_M   = 150;      // ignore fix if accuracy worse than 150 m

// ── Public API ────────────────────────────────────────────────────────────────
export function initGeofence({ onArrive, onEta } = {}) {
  _onArrive = onArrive || null;
  _onEta    = onEta    || null;

  // Load zone config from server
  fetch('/api/geofence/zones', { headers: { 'X-Requested-With': 'XMLHttpRequest' } })
    .then(r => r.ok ? r.json() : [])
    .then(zones => { ZONES = zones; })
    .catch(() => {});
}

export function startTracking(trailer) {
  stopTracking();
  _trailer = trailer;

  if (!navigator.geolocation) return;

  _watcher = navigator.geolocation.watchPosition(
    pos => _onPosition(pos),
    () => {},
    { enableHighAccuracy: true, maximumAge: 15_000, timeout: 20_000 }
  );

  // Also poll on a fixed interval in case watchPosition stalls
  _interval = setInterval(() => {
    if (_lastLat !== null) _sendLocation();
  }, SEND_INTERVAL_MS);

  updateGpsCard('requesting');
}

export function stopTracking() {
  if (_watcher !== null) { navigator.geolocation.clearWatch(_watcher); _watcher = null; }
  if (_interval !== null) { clearInterval(_interval); _interval = null; }
  _trailer  = null;
  _lastLat  = null;
  _lastLng  = null;
  _inZones  = new Set();
  updateGpsCard('hidden');
}

export function updateGpsCard(state) {
  const card  = document.getElementById('ts-gps-card');
  const icon  = document.getElementById('ts-gps-icon');
  const title = document.getElementById('ts-gps-title');
  const desc  = document.getElementById('ts-gps-desc');
  if (!card) return;
  if (state === 'requesting') {
    card.style.display = 'flex'; icon.textContent = '📡';
    title.textContent = 'Getting location…'; title.style.color = 'var(--cyan,#18d4e8)';
    desc.textContent = 'One moment…';
  } else if (state === 'active') {
    card.style.display = 'flex'; icon.textContent = '📡';
    title.textContent = 'Location sharing on'; title.style.color = 'var(--green,#19e09a)';
    desc.textContent = 'Dispatch can see your ETA in real time';
  } else if (state === 'denied') {
    card.style.display = 'flex'; icon.textContent = '🚫';
    title.textContent = 'Location off'; title.style.color = 'var(--amber,#f5a623)';
    desc.textContent = 'Enable location for accurate ETA';
  } else {
    card.style.display = 'none';
  }
}

// ── Internal ──────────────────────────────────────────────────────────────────
function _onPosition(pos) {
  if (!_trailer) return;
  if (pos.coords.accuracy > MIN_ACCURACY_M) return;   // skip noisy fix

  _lastLat = pos.coords.latitude;
  _lastLng = pos.coords.longitude;
  updateGpsCard('active');
  _sendLocation();
}

async function _sendLocation() {
  if (!_trailer || _lastLat === null) return;
  try {
    const eta = _estimateEta();
    const res = await apiPost('/api/driver/location', {
      trailer: _trailer, lat: _lastLat, lng: _lastLng, eta,
    });

    if (res.eta != null && _onEta) _onEta(res.eta);

    // Server-side geofence triggered auto-arrive
    if (res.autoTriggered && res.door) {
      if (_onArrive) _onArrive(res.door);
      stopTracking();
      return;
    }

    // Client-side zone transition detection (supplementary)
    const nowZones   = new Set(res.zones || []);
    const newEntries = [...nowZones].filter(z => !_inZones.has(z));
    const exits      = [..._inZones].filter(z => !nowZones.has(z));

    if (newEntries.includes('depot')) {
      window.dispatchEvent(new CustomEvent('wb:geofence:enter', { detail: { zone: 'depot', trailer: _trailer } }));
    }
    if (exits.includes('depot')) {
      window.dispatchEvent(new CustomEvent('wb:geofence:exit', { detail: { zone: 'depot', trailer: _trailer } }));
    }
    _inZones = nowZones;

  } catch (e) {
    console.warn('[geofence] location send failed:', e.message);
  }
}

function _estimateEta() {
  if (_lastLat === null || !ZONES.length) return null;
  const depot = ZONES.find(z => z.id === 'depot');
  if (!depot) return null;
  const km  = haversineKm(_lastLat, _lastLng, depot.lat, depot.lng);
  return Math.max(1, Math.round(km / (40 / 60)));
}

// ── Geometry ──────────────────────────────────────────────────────────────────
export function haversineKm(lat1, lng1, lat2, lng2) {
  const R    = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a    =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
