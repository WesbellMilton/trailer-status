'use strict';
const path = require('path');
const fs   = require('fs');

const PORT        = process.env.PORT || 3000;
const APP_VERSION = process.env.APP_VERSION || '3.7.0';
const NODE_ENV    = process.env.NODE_ENV || 'development';
const IS_PROD     = NODE_ENV === 'production';

// ── Database ──────────────────────────────────────────────────────────────────
const DB_FILE = process.env.DB_FILE || (() => {
  for (const candidate of ['/var/data/wesbell.sqlite', '/tmp/wesbell.sqlite']) {
    try { fs.mkdirSync(path.dirname(candidate), { recursive: true }); return candidate; } catch {}
  }
  return path.join(__dirname, '..', 'wesbell.sqlite');
})();

// ── Auth ──────────────────────────────────────────────────────────────────────
const PIN_MIN_LEN    = 4;
const SESSION_TTL_MS = 1000 * 60 * 60 * 12;   // 12 h
const COOKIE_NAME    = 'wb_session';
const ENV_PINS = {
  dispatcher : process.env.DISPATCHER_PIN || '',
  dock       : process.env.DOCK_PIN       || '',
  management : process.env.MANAGEMENT_PIN || '',
  admin      : process.env.ADMIN_PIN      || '',
};

// ── Push / VAPID ──────────────────────────────────────────────────────────────
const VAPID_FILE = process.env.VAPID_FILE || path.join(__dirname, '..', 'vapid.json');

// ── Reservations ─────────────────────────────────────────────────────────────
const RESERVATION_TTL_MS = 30 * 60 * 1000;   // 30 min

// ── Geofencing ────────────────────────────────────────────────────────────────
// All distances in km.  Zones are checked in order; first match wins.
const GEOFENCE_ZONES = [
  {
    id      : 'depot',
    label   : 'Wesbell Yard',
    lat     : parseFloat(process.env.DEPOT_LAT  || '43.5048'),
    lng     : parseFloat(process.env.DEPOT_LNG  || '-79.8880'),
    // radiusKm checked as circle (fallback when no polygon)
    radiusKm: parseFloat(process.env.DEPOT_RADIUS_KM || '0.3'),
    // Polygon vertices [lat,lng] — takes priority when non-empty.
    // Set via env as JSON string: DEPOT_POLYGON='[[43.505,-79.890],[43.505,-79.886],...]'
    polygon : JSON.parse(process.env.DEPOT_POLYGON || '[]'),
    // What to auto-trigger when a driver enters this zone while status==="Incoming"
    autoAction: 'arrive',
  },
  {
    id      : 'approach',
    label   : 'Approach Zone',
    lat     : parseFloat(process.env.DEPOT_LAT || '43.5048'),
    lng     : parseFloat(process.env.DEPOT_LNG || '-79.8880'),
    radiusKm: parseFloat(process.env.APPROACH_RADIUS_KM || '2.0'),
    polygon : [],
    autoAction: 'eta_update',  // just update ETA estimate, no arrive trigger
  },
];

// ── Rate limits ───────────────────────────────────────────────────────────────
const LOGIN_RATE_MAX  = 15;   // per minute per IP
const DRIVER_RATE_MAX = 30;   // per minute per IP

// ── Misc ──────────────────────────────────────────────────────────────────────
const ROLE_HOME = { dispatcher: '/', admin: '/', dock: '/dock', management: '/management' };
const MAX_LOGS  = 500;
const WEBHOOK_URL = process.env.WEBHOOK_URL || '';

module.exports = {
  PORT, APP_VERSION, NODE_ENV, IS_PROD,
  DB_FILE, PIN_MIN_LEN, SESSION_TTL_MS, COOKIE_NAME, ENV_PINS,
  VAPID_FILE, RESERVATION_TTL_MS, GEOFENCE_ZONES,
  LOGIN_RATE_MAX, DRIVER_RATE_MAX,
  ROLE_HOME, MAX_LOGS, WEBHOOK_URL,
};
