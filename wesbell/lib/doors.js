'use strict';
const { run, all }            = require('./db');
const { RESERVATION_TTL_MS }  = require('./config');
const { broadcastTrailers }   = require('./ws');

async function getOccupiedDoorSet(excludeTrailer = null, locationId = 1) {
  const occupied = await all(
    `SELECT door FROM trailers WHERE door IS NOT NULL AND door != '' AND status NOT IN ('Departed','') AND location_id=?${excludeTrailer ? ' AND trailer != ?' : ''}`,
    excludeTrailer ? [locationId, excludeTrailer] : [locationId]
  );
  const blocks   = await all(`SELECT door FROM doorblocks WHERE location_id=?`, [locationId]);
  const reserved = await all(`SELECT door FROM door_reservations WHERE expiresAt > ? AND location_id=?`, [Date.now(), locationId]);
  return new Set([
    ...occupied.map(r => String(r.door)),
    ...blocks.map(r => String(r.door)),
    ...reserved.map(r => String(r.door)),
  ]);
}

async function pickBestDoor(excludeTrailer = null, locationId = 1) {
  const occupiedSet = await getOccupiedDoorSet(excludeTrailer, locationId);
  const plates      = await all(`SELECT door,status FROM dockplates WHERE location_id=?`, [locationId]);
  const plateMap    = {};
  plates.forEach(p => { plateMap[String(p.door)] = p.status; });

  // Get door range for this location
  const { get: dbGet } = require('./db');
  const loc = await dbGet(`SELECT doors_from,doors_to FROM locations WHERE id=?`, [locationId]).catch(() => null);
  const from = loc?.doors_from ?? 28;
  const to   = loc?.doors_to   ?? 42;

  const candidates = [];
  for (let d = from; d <= to; d++) {
    const ds = String(d);
    if (occupiedSet.has(ds)) continue;
    const ps = plateMap[ds] || 'Unknown';
    if (ps === 'Out of Order') continue;
    candidates.push({ door: ds, priority: ps === 'OK' ? 0 : ps === 'Unknown' ? 1 : 2 });
  }
  candidates.sort((a, b) => a.priority - b.priority);
  return candidates[0]?.door || null;
}

async function reserveDoor(door, trailer, carrierType, holdMinutes = null, locationId = 1) {
  const now = Date.now();
  const expiresAt = holdMinutes
    ? now + (holdMinutes * 60_000)
    : now + RESERVATION_TTL_MS;
  await run(
    `INSERT INTO door_reservations(door,trailer,carrierType,reservedAt,expiresAt,location_id)
     VALUES(?,?,?,?,?,?)
     ON CONFLICT(door) DO UPDATE SET
       trailer=excluded.trailer,
       carrierType=excluded.carrierType,
       reservedAt=excluded.reservedAt,
       expiresAt=excluded.expiresAt,
       location_id=excluded.location_id`,
    [door, trailer, carrierType, now, expiresAt, locationId]
  );
}

const releaseReservation = trailer =>
  run(`DELETE FROM door_reservations WHERE trailer=?`, [trailer]);

/**
 * extendReservation(trailer, etaMinutes)
 * Called on every location update. Sets expiry = now + ETA + 5 min grace.
 * This keeps the door held for exactly as long as the driver needs.
 */
async function extendReservation(trailer, etaMinutes) {
  const graceMs  = 5 * 60_000;   // 5 min grace after ETA
  const holdMs   = (etaMinutes * 60_000) + graceMs;
  const expiresAt = Date.now() + holdMs;
  await run(
    `UPDATE door_reservations SET expiresAt=? WHERE trailer=?`,
    [expiresAt, trailer]
  );
}

async function cleanupExpiredReservations() {
  const r = await run(`DELETE FROM door_reservations WHERE expiresAt <= ?`, [Date.now()]);
  if (r.changes > 0) {
    console.log(`[reservations] Cleaned up ${r.changes} expired reservation(s)`);
    await broadcastTrailers();
  }
}
setInterval(cleanupExpiredReservations, 2 * 60_000).unref();

module.exports = { getOccupiedDoorSet, pickBestDoor, reserveDoor, releaseReservation, extendReservation, cleanupExpiredReservations };
