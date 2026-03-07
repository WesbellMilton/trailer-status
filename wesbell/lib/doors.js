'use strict';
const { run, all }            = require('./db');
const { RESERVATION_TTL_MS }  = require('./config');
const { broadcastTrailers }   = require('./ws');

async function getOccupiedDoorSet(excludeTrailer = null) {
  const occupied = await all(
    `SELECT door FROM trailers WHERE door IS NOT NULL AND door != '' AND status NOT IN ('Departed','')${excludeTrailer ? ' AND trailer != ?' : ''}`,
    excludeTrailer ? [excludeTrailer] : []
  );
  const blocks   = await all(`SELECT door FROM doorblocks`);
  const reserved = await all(`SELECT door FROM door_reservations WHERE expiresAt > ?`, [Date.now()]);
  return new Set([
    ...occupied.map(r => String(r.door)),
    ...blocks.map(r => String(r.door)),
    ...reserved.map(r => String(r.door)),
  ]);
}

async function pickBestDoor(excludeTrailer = null) {
  const occupiedSet = await getOccupiedDoorSet(excludeTrailer);
  const plates      = await all(`SELECT door,status FROM dockplates`);
  const plateMap    = {};
  plates.forEach(p => { plateMap[String(p.door)] = p.status; });

  const candidates = [];
  for (let d = 28; d <= 42; d++) {
    const ds = String(d);
    if (occupiedSet.has(ds)) continue;
    const ps = plateMap[ds] || 'Unknown';
    if (ps === 'Out of Order') continue;
    candidates.push({ door: ds, priority: ps === 'OK' ? 0 : ps === 'Unknown' ? 1 : 2 });
  }
  candidates.sort((a, b) => a.priority - b.priority);
  return candidates[0]?.door || null;
}

async function reserveDoor(door, trailer, carrierType, holdMinutes = null) {
  const now = Date.now();
  // If holdMinutes provided, use that + 5 min grace; otherwise use config TTL
  const expiresAt = holdMinutes
    ? now + (holdMinutes * 60_000)
    : now + RESERVATION_TTL_MS;
  await run(
    `INSERT INTO door_reservations(door,trailer,carrierType,reservedAt,expiresAt)
     VALUES(?,?,?,?,?)
     ON CONFLICT(door) DO UPDATE SET
       trailer=excluded.trailer,
       carrierType=excluded.carrierType,
       reservedAt=excluded.reservedAt,
       expiresAt=excluded.expiresAt`,
    [door, trailer, carrierType, now, expiresAt]
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
  // Also log it for debugging
  console.log(`[doors] ${trailer} door held until +${Math.round(holdMs/60000)}min (ETA ${etaMinutes}m + 5m grace)`);
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
