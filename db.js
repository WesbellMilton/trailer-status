'use strict';
const sqlite3 = require('sqlite3').verbose();
const { DB_FILE } = require('./config');
const { runMigrations } = require('./migrations');

console.log('[DB] Using database at:', DB_FILE);
const db = new sqlite3.Database(DB_FILE);

// ── Promisified helpers ───────────────────────────────────────────────────────
const run = (sql, p = []) => new Promise((res, rej) =>
  db.run(sql, p, function (e) { e ? rej(e) : res(this); })
);
const get = (sql, p = []) => new Promise((res, rej) =>
  db.get(sql, p, (e, r) => e ? rej(e) : res(r))
);
const all = (sql, p = []) => new Promise((res, rej) =>
  db.all(sql, p, (e, r) => e ? rej(e) : res(r))
);

// ── Initialise: WAL + PRAGMAs + migrations ───────────────────────────────────
async function initDb() {
  // WAL mode: concurrent reads during writes, much faster under load
  await run('PRAGMA journal_mode=WAL');
  await run('PRAGMA synchronous=NORMAL');
  await run('PRAGMA cache_size=-16000');   // 16 MB page cache
  await run('PRAGMA temp_store=MEMORY');
  await run('PRAGMA foreign_keys=ON');

  await runMigrations(run, get, all);

  // Initialise default PINs (done here so auth.js can depend on db being ready)
  const { ENV_PINS, PIN_MIN_LEN } = require('./config');
  const { setPin, genTempPin } = require('./auth');
  for (const role of ['dispatcher', 'dock', 'management', 'admin']) {
    const row    = await get(`SELECT role FROM pins WHERE role=?`, [role]);
    const envPin = ENV_PINS[role] && ENV_PINS[role].length >= PIN_MIN_LEN ? ENV_PINS[role] : null;
    if (!row) { await setPin(role, envPin || genTempPin()); console.log(`[SECURITY] ${role} PIN initialised`); }
    else if (envPin) { await setPin(role, envPin); console.log(`[SECURITY] ${role} PIN synced from env`); }
  }
}

// ── WAL checkpoint (used before backup) ──────────────────────────────────────
const checkpoint = () => new Promise((res, rej) =>
  db.run('PRAGMA wal_checkpoint(TRUNCATE)', err => err ? rej(err) : res())
);

module.exports = { db, run, get, all, initDb, checkpoint };
