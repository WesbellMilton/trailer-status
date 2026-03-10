'use strict';
const { Pool, types } = require('pg');
const { runMigrations } = require('./migrations');

// ── INT8 type parser ──────────────────────────────────────────────────────────
// By default pg returns BIGINT/BIGSERIAL/COUNT(*) as JS strings to avoid
// precision loss for very large numbers.  All our ids and timestamps fit
// comfortably in a JS number (safe integers up to 2^53).  Parsing them as
// numbers keeps the rest of the codebase simple and avoids JSON.stringify
// throwing on BigInt values.
types.setTypeParser(20, (val) => parseInt(val, 10));   // int8 / bigint / bigserial

// ── Connection pool ───────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on('error', (err) => console.error('[DB] Pool error:', err.message));

// ── Placeholder conversion ────────────────────────────────────────────────────
// SQLite uses ? — Postgres uses $1, $2 ...  All callers pass params as arrays
// so this conversion means NO route file needs to change.
function toPositional(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

// ── run(sql, params) → { lastID, changes } ───────────────────────────────────
// Only appends RETURNING id for INSERT statements — appending to CREATE TABLE,
// CREATE INDEX, ALTER TABLE, UPDATE, DELETE, or DO-blocks causes a parse error.
const run = async (sql, p = []) => {
  const trimmed = sql.trimStart().toUpperCase();
  const isInsert = trimmed.startsWith('INSERT');
  const alreadyReturning = trimmed.includes('RETURNING');

  const pgSql = toPositional(sql) + (isInsert && !alreadyReturning ? ' RETURNING id' : '');

  try {
    const result = await pool.query(pgSql, p);
    return {
      lastID : result.rows[0]?.id ?? null,
      changes: result.rowCount,
    };
  } catch (err) {
    // INSERT into a table with no 'id' column (TEXT-keyed tables like pins, trailers, etc.)
    // Retry without RETURNING — lastID will be null, which is fine for those tables.
    if (isInsert && !alreadyReturning && err.message.includes('"id"')) {
      const result = await pool.query(toPositional(sql), p);
      return { lastID: null, changes: result.rowCount };
    }
    throw err;
  }
};

// ── get(sql, params) → single row or undefined ────────────────────────────────
const get = async (sql, p = []) => {
  const result = await pool.query(toPositional(sql), p);
  return result.rows[0];
};

// ── all(sql, params) → array of rows ─────────────────────────────────────────
const all = async (sql, p = []) => {
  const result = await pool.query(toPositional(sql), p);
  return result.rows;
};

// ── initDb ────────────────────────────────────────────────────────────────────
async function initDb() {
  const client = await pool.connect();
  client.release();
  console.log('[DB] Connected to PostgreSQL');

  await runMigrations(run, get, all);

  const { ENV_PINS, PIN_MIN_LEN } = require('./config');
  const { setPin, genTempPin } = require('./auth');
  for (const role of ['dispatcher', 'dock', 'management', 'admin']) {
    const row    = await get(`SELECT role FROM pins WHERE role=?`, [role]);
    const envPin = ENV_PINS[role] && ENV_PINS[role].length >= PIN_MIN_LEN ? ENV_PINS[role] : null;
    if (!row)        { await setPin(role, envPin || genTempPin()); console.log(`[SECURITY] ${role} PIN initialised`); }
    else if (envPin) { await setPin(role, envPin); console.log(`[SECURITY] ${role} PIN synced from env`); }
  }
}

// checkpoint is a no-op in Postgres (WAL managed server-side)
const checkpoint = () => Promise.resolve();

module.exports = { pool, run, get, all, initDb, checkpoint };
