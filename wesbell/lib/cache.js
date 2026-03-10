'use strict';
const { all } = require('./db');

// ── In-memory caches ──────────────────────────────────────────────────────────
let _trailers = null;
let _plates   = null;
let _blocks   = null;

const invalidateTrailers = () => { _trailers = null; };
const invalidatePlates   = () => { _plates   = null; };
const invalidateBlocks   = () => { _blocks   = null; };

// ── Loaders ───────────────────────────────────────────────────────────────────
async function loadTrailersObject() {
  const rows = await all(`SELECT * FROM trailers`);
  const obj  = {};
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
    };
  }
  return obj;
}

async function loadDockPlatesObject() {
  const rows = await all(`SELECT * FROM dockplates ORDER BY CAST(door AS INTEGER) ASC`);
  const obj  = {};
  for (const r of rows) {
    obj[r.door] = { status: r.status || 'Unknown', note: r.note || '', updatedAt: r.updatedAt || 0 };
  }
  return obj;
}

async function loadDoorBlocksObject() {
  const rows = await all(`SELECT * FROM doorblocks`);
  const obj  = {};
  rows.forEach(r => { obj[r.door] = { note: r.note, setAt: r.setAt }; });
  return obj;
}

// ── Cached getters ────────────────────────────────────────────────────────────
async function getTrailersCache() {
  if (!_trailers) _trailers = await loadTrailersObject();
  return _trailers;
}
async function getPlatesCache() {
  if (!_plates) _plates = await loadDockPlatesObject();
  return _plates;
}
async function getBlocksCache() {
  if (!_blocks) _blocks = await loadDoorBlocksObject();
  return _blocks;
}

const loadConfirmations = (limit = 250) =>
  all(`SELECT at,trailer,door,action,ip,"userAgent" FROM confirmations ORDER BY at DESC LIMIT ?`, [limit]);

module.exports = {
  invalidateTrailers, invalidatePlates, invalidateBlocks,
  loadTrailersObject, loadDockPlatesObject, loadDoorBlocksObject,
  getTrailersCache, getPlatesCache, getBlocksCache,
  loadConfirmations,
};
