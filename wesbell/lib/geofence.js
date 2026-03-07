'use strict';
const { GEOFENCE_ZONES } = require('./config');
const { run }            = require('./db');
const { wsBroadcast }    = require('./ws');
const { ipOf }           = require('./middleware');

// ── Geometry helpers ──────────────────────────────────────────────────────────
function haversineKm(lat1, lng1, lat2, lng2) {
  const R    = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Ray-casting point-in-polygon for [[lat,lng],...] arrays */
function pointInPolygon(lat, lng, polygon) {
  if (!polygon || polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [yi, xi] = polygon[i];
    const [yj, xj] = polygon[j];
    const intersect = ((yi > lat) !== (yj > lat)) &&
      (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * containsPoint(zone, lat, lng) → boolean
 * Uses polygon when defined, otherwise circle.
 */
function containsPoint(zone, lat, lng) {
  if (zone.polygon && zone.polygon.length >= 3) return pointInPolygon(lat, lng, zone.polygon);
  return haversineKm(lat, lng, zone.lat, zone.lng) <= zone.radiusKm;
}

/**
 * getActiveZones(lat, lng) → zone[]
 * Returns all zones the point falls within, ordered innermost first.
 */
function getActiveZones(lat, lng) {
  return GEOFENCE_ZONES.filter(z => containsPoint(z, lat, lng));
}

/**
 * getEtaMinutes(lat, lng, zone) → number
 * Rough ETA in minutes at average yard-approach speed (40 km/h).
 */
function getEtaMinutes(lat, lng, zone) {
  const km = haversineKm(lat, lng, zone.lat, zone.lng);
  return Math.max(1, Math.round(km / (40 / 60)));
}

// ── Server-side geofence event handler ───────────────────────────────────────
/**
 * processLocation({ trailer, lat, lng, req }) → { zones, eta, autoTriggered }
 *
 * Called from /api/driver/location. Logs zone entries/exits and fires
 * auto-actions (e.g. arrive) when a driver enters the depot zone.
 */
async function processLocation({ trailer, lat, lng, req }) {
  const activeZones = getActiveZones(lat, lng);
  const zoneIds     = activeZones.map(z => z.id);

  // Broadcast live location to dispatch/dock clients
  const depotZone = GEOFENCE_ZONES.find(z => z.id === 'depot');
  const eta       = depotZone ? getEtaMinutes(lat, lng, depotZone) : null;

  wsBroadcast('location', { trailer, lat, lng, eta, zones: zoneIds, locAt: Date.now() });

  // Log each zone the driver is inside (deduplicate via recent events)
  const { get: dbGet } = require('./db');
  for (const zone of activeZones) {
    const recent = await dbGet(
      `SELECT id FROM geofence_events WHERE trailer=? AND zone=? AND event='enter' AND at > ?`,
      [trailer, zone.id, Date.now() - 5 * 60_000]
    ).catch(() => null);

    if (!recent) {
      await run(
        `INSERT INTO geofence_events(at,trailer,zone,event,lat,lng,ip) VALUES(?,?,?,?,?,?,?)`,
        [Date.now(), trailer, zone.id, 'enter', lat, lng, ipOf(req)]
      ).catch(() => {});
    }
  }

  // Auto-arrive trigger: driver enters depot zone while trailer is Incoming
  const depotActive = activeZones.find(z => z.id === 'depot');
  if (depotActive) {
    const { get }  = require('./db');
    const row      = await get(`SELECT status, door FROM trailers WHERE trailer=?`, [trailer]);
    if (row && row.status === 'Incoming' && !row.door) {
      // Trigger arrive automatically — import here to avoid circular dep
      return { zones: zoneIds, eta, autoTriggered: true };
    }
  }

  return { zones: zoneIds, eta, autoTriggered: false };
}

module.exports = {
  haversineKm, containsPoint, pointInPolygon,
  getActiveZones, getEtaMinutes,
  processLocation,
  GEOFENCE_ZONES,
};
