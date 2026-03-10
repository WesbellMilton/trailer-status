'use strict';
const { all } = require('./db');

// ── In-memory caches (keyed by locationId) ────────────────────────────────────
const _trailersCache = new Map(); // locationId|'all' → object
const _platesCache   = new Map(); // locationId|'all' → object
const _blocksCache   = new Map(); // locationId|'all' → object

const invalidateTrailers = (locationId = null) => {
  if (locationId) _trailersCache.delete(locationId);
  else _trailersCache.clear();
};
const invalidatePlates = (locationId = null) => {
  if (locationId) _platesCache.delete(locationId);
  else _platesCache.clear();
};
const invalidateBlocks = (locationId = null) => {
  if (locationId) _blocksCache.delete(locationId);
  else _blocksCache.clear();
};

// ── Loaders ───────────────────────────────────────────────────────────────────
async function loadTrailersObject(locationId = null) {
  const rows = locationId
    ? await all(`SELECT * FROM trailers WHERE location_id=?`, [locationId])
    : await all(`SELECT * FROM trailers`);
  const obj = {};
  for (const r of rows) {
    obj[r.trailer] = {
      direction  : r.direction   || '',
      status     : r.status      || '',
      door       : r.door        || '',
      note       : r.note        || '',
      dropType   : r.dropType    || '',
      carrierType: r.carrierType || '',
      updatedAt  : r.updatedAt   || 0,
      omwAt      : r.omwAt       ?? null,
      omwEta     : r.omwEta      ?? null,
      doorAt     : r.doorAt      ?? null,
      locationId : r.location_id || 1,
    };
  }
  return obj;
}

async function loadDockPlatesObject(locationId = null) {
  const rows = locationId
    ? await all(`SELECT * FROM dockplates WHERE location_id=? ORDER BY CAST(door AS INTEGER) ASC`, [locationId])
    : await all(`SELECT * FROM dockplates ORDER BY CAST(door AS INTEGER) ASC`);
  const obj = {};
  for (const r of rows) {
    obj[r.door] = { status: r.status || 'Unknown', note: r.note || '', updatedAt: r.updatedAt || 0 };
  }
  return obj;
}

async function loadDoorBlocksObject(locationId = null) {
  const rows = locationId
    ? await all(`SELECT * FROM doorblocks WHERE location_id=?`, [locationId])
    : await all(`SELECT * FROM doorblocks`);
  const obj = {};
  rows.forEach(r => { obj[r.door] = { note: r.note, setAt: r.setAt }; });
  return obj;
}

// ── Cached getters ────────────────────────────────────────────────────────────
async function getTrailersCache(locationId = null) {
  const key = locationId || 'all';
  if (!_trailersCache.has(key)) _trailersCache.set(key, await loadTrailersObject(locationId));
  return _trailersCache.get(key);
}
async function getPlatesCache(locationId = null) {
  const key = locationId || 'all';
  if (!_platesCache.has(key)) _platesCache.set(key, await loadDockPlatesObject(locationId));
  return _platesCache.get(key);
}
async function getBlocksCache(locationId = null) {
  const key = locationId || 'all';
  if (!_blocksCache.has(key)) _blocksCache.set(key, await loadDoorBlocksObject(locationId));
  return _blocksCache.get(key);
}

const loadConfirmations = (limit = 250, locationId = null) =>
  locationId
    ? all(`SELECT at,trailer,door,action,ip,userAgent FROM confirmations WHERE location_id=? ORDER BY at DESC LIMIT ?`, [locationId, limit])
    : all(`SELECT at,trailer,door,action,ip,userAgent FROM confirmations ORDER BY at DESC LIMIT ?`, [limit]);

module.exports = {
  invalidateTrailers, invalidatePlates, invalidateBlocks,
  loadTrailersObject, loadDockPlatesObject, loadDoorBlocksObject,
  getTrailersCache, getPlatesCache, getBlocksCache,
  loadConfirmations,
};
