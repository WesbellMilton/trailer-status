'use strict';
/**
 * Database migrations for Wesbell Dispatch — PostgreSQL edition.
 *
 * Converted from SQLite:
 *   INTEGER PRIMARY KEY AUTOINCREMENT  → BIGSERIAL PRIMARY KEY
 *   BLOB                               → BYTEA
 *   INTEGER (booleans/timestamps)      → BIGINT
 *   INSERT OR IGNORE                   → INSERT … ON CONFLICT DO NOTHING
 *   CAST(x AS INTEGER)                 → x::int
 *
 * Never edit or remove applied migrations — add new ones at the bottom.
 */

const MIGRATIONS = [
  {
    version: 1,
    description: 'Initial schema — core tables',
    up: async (run) => {
      await run(`CREATE TABLE IF NOT EXISTS trailers(
        trailer     TEXT PRIMARY KEY,
        direction   TEXT,
        status      TEXT,
        door        TEXT,
        note        TEXT,
        "dropType"  TEXT,
        "carrierType" TEXT DEFAULT '',
        "updatedAt" BIGINT,
        "omwAt"     BIGINT DEFAULT NULL,
        "omwEta"    BIGINT DEFAULT NULL,
        "doorAt"    BIGINT DEFAULT NULL
      )`);
      await run(`CREATE TABLE IF NOT EXISTS doorblocks(
        door  TEXT PRIMARY KEY,
        note  TEXT NOT NULL DEFAULT '',
        "setAt" BIGINT NOT NULL DEFAULT 0
      )`);
      await run(`CREATE TABLE IF NOT EXISTS dockplates(
        door      TEXT PRIMARY KEY,
        status    TEXT,
        note      TEXT,
        "updatedAt" BIGINT
      )`);
      await run(`CREATE TABLE IF NOT EXISTS confirmations(
        id        BIGSERIAL PRIMARY KEY,
        at        BIGINT,
        trailer   TEXT,
        door      TEXT,
        action    TEXT,
        ip        TEXT,
        "userAgent" TEXT
      )`);
      await run(`CREATE TABLE IF NOT EXISTS audit(
        id          BIGSERIAL PRIMARY KEY,
        at          BIGINT,
        "actorRole" TEXT,
        action      TEXT,
        "entityType" TEXT,
        "entityId"  TEXT,
        details     TEXT,
        ip          TEXT,
        "userAgent" TEXT
      )`);
      await run(`CREATE TABLE IF NOT EXISTS push_subscriptions(
        endpoint     TEXT PRIMARY KEY,
        subscription TEXT,
        "createdAt"  BIGINT
      )`);
      await run(`CREATE TABLE IF NOT EXISTS issue_reports(
        id          BIGSERIAL PRIMARY KEY,
        at          BIGINT,
        trailer     TEXT,
        door        TEXT,
        note        TEXT,
        photo_data  TEXT,
        photo_mime  TEXT,
        ip          TEXT,
        "userAgent" TEXT
      )`);
      await run(`CREATE TABLE IF NOT EXISTS pins(
        role TEXT PRIMARY KEY,
        salt BYTEA,
        hash BYTEA,
        iter INTEGER
      )`);
      await run(`CREATE TABLE IF NOT EXISTS logs(
        id      BIGSERIAL PRIMARY KEY,
        at      BIGINT,
        level   TEXT,
        context TEXT,
        message TEXT,
        detail  TEXT
      )`);
      await run(`CREATE TABLE IF NOT EXISTS door_reservations(
        door         TEXT PRIMARY KEY,
        trailer      TEXT NOT NULL,
        "carrierType" TEXT NOT NULL DEFAULT 'Outside',
        "reservedAt" BIGINT NOT NULL,
        "expiresAt"  BIGINT NOT NULL
      )`);
    },
  },

  {
    version: 2,
    description: 'Add carrierType/omw/doorAt columns to trailers if missing (pre-v3 upgrade)',
    up: async (run) => {
      // PostgreSQL: use DO $$ blocks for safe column additions
      const safeAdd = (tbl, col, type) =>
        run(`DO $$ BEGIN ALTER TABLE ${tbl} ADD COLUMN ${col} ${type}; EXCEPTION WHEN duplicate_column THEN NULL; END $$`);
      await safeAdd('trailers', '"carrierType"', "TEXT DEFAULT ''");
      await safeAdd('trailers', '"omwAt"', 'BIGINT DEFAULT NULL');
      await safeAdd('trailers', '"omwEta"', 'BIGINT DEFAULT NULL');
      await safeAdd('trailers', '"doorAt"', 'BIGINT DEFAULT NULL');
      await safeAdd('confirmations', 'action', 'TEXT');
    },
  },

  {
    version: 3,
    description: 'Performance indexes',
    up: async (run) => {
      await run(`CREATE INDEX IF NOT EXISTS idx_trailers_status    ON trailers(status)`);
      await run(`CREATE INDEX IF NOT EXISTS idx_trailers_updatedAt ON trailers("updatedAt" DESC)`);
      await run(`CREATE INDEX IF NOT EXISTS idx_audit_at           ON audit(at DESC)`);
      await run(`CREATE INDEX IF NOT EXISTS idx_audit_entityId     ON audit("entityId")`);
      await run(`CREATE INDEX IF NOT EXISTS idx_audit_action       ON audit(action)`);
      await run(`CREATE INDEX IF NOT EXISTS idx_reservations_exp   ON door_reservations("expiresAt")`);
      await run(`CREATE INDEX IF NOT EXISTS idx_issues_at          ON issue_reports(at DESC)`);
      await run(`CREATE INDEX IF NOT EXISTS idx_issues_trailer     ON issue_reports(trailer)`);
    },
  },

  {
    version: 4,
    description: 'Seed default dockplates for doors 28–42',
    up: async (run, all) => {
      await run(`DELETE FROM dockplates WHERE door::int < 28`);
      const existing = new Set((await all(`SELECT door FROM dockplates`)).map(r => r.door));
      for (let d = 28; d <= 42; d++) {
        const door = String(d);
        if (!existing.has(door)) {
          await run(
            `INSERT INTO dockplates(door,status,note,"updatedAt") VALUES(?,?,?,?)`,
            [door, 'Unknown', '', Date.now()]
          );
        }
      }
    },
  },

  {
    version: 5,
    description: 'Add geofence_events table for driver proximity tracking',
    up: async (run) => {
      await run(`CREATE TABLE IF NOT EXISTS geofence_events(
        id      BIGSERIAL PRIMARY KEY,
        at      BIGINT NOT NULL,
        trailer TEXT NOT NULL,
        zone    TEXT NOT NULL,
        event   TEXT NOT NULL,
        lat     REAL,
        lng     REAL,
        ip      TEXT
      )`);
      await run(`CREATE INDEX IF NOT EXISTS idx_geofence_trailer ON geofence_events(trailer)`);
      await run(`CREATE INDEX IF NOT EXISTS idx_geofence_at ON geofence_events(at DESC)`);
    },
  },

  {
    version: 6,
    description: 'Add qr_scans table for QR automation tracking',
    up: async (run) => {
      await run(`CREATE TABLE IF NOT EXISTS qr_scans(
        id          BIGSERIAL PRIMARY KEY,
        at          BIGINT NOT NULL,
        trailer     TEXT NOT NULL,
        door        TEXT,
        action      TEXT NOT NULL,
        "scannedBy" TEXT DEFAULT 'driver',
        ip          TEXT
      )`);
      await run(`CREATE INDEX IF NOT EXISTS idx_qr_trailer ON qr_scans(trailer)`);
    },
  },

  {
    version: 7,
    description: 'Multi-location support — locations table + location_id on scoped tables',
    up: async (run, all) => {
      await run(`CREATE TABLE IF NOT EXISTS locations(
        id          BIGSERIAL PRIMARY KEY,
        name        TEXT NOT NULL,
        slug        TEXT NOT NULL UNIQUE,
        doors_from  INTEGER NOT NULL DEFAULT 28,
        doors_to    INTEGER NOT NULL DEFAULT 42,
        timezone    TEXT NOT NULL DEFAULT 'America/Toronto',
        active      INTEGER NOT NULL DEFAULT 1,
        "createdAt" BIGINT NOT NULL DEFAULT 0
      )`);

      const existing = await all(`SELECT id FROM locations LIMIT 1`);
      if (!existing.length) {
        await run(
          `INSERT INTO locations(name,slug,doors_from,doors_to,timezone,active,"createdAt") VALUES(?,?,?,?,?,?,?)`,
          ['Milton', 'milton', 28, 42, 'America/Toronto', 1, Date.now()]
        );
      }

      const safeAdd = (tbl, col, type) =>
        run(`DO $$ BEGIN ALTER TABLE ${tbl} ADD COLUMN ${col} ${type}; EXCEPTION WHEN duplicate_column THEN NULL; END $$`);

      for (const tbl of ['trailers','dockplates','doorblocks','door_reservations','confirmations','audit','issue_reports','geofence_events']) {
        await safeAdd(tbl, 'location_id', 'INTEGER NOT NULL DEFAULT 1');
      }

      for (const tbl of ['trailers','dockplates','doorblocks','door_reservations','confirmations','audit','issue_reports']) {
        await run(`UPDATE ${tbl} SET location_id=1 WHERE location_id IS NULL OR location_id=0`);
      }

      await run(`CREATE INDEX IF NOT EXISTS idx_trailers_loc     ON trailers(location_id)`);
      await run(`CREATE INDEX IF NOT EXISTS idx_audit_loc        ON audit(location_id)`);
      await run(`CREATE INDEX IF NOT EXISTS idx_issues_loc       ON issue_reports(location_id)`);
      await run(`CREATE INDEX IF NOT EXISTS idx_dockplates_loc   ON dockplates(location_id)`);
      await run(`CREATE INDEX IF NOT EXISTS idx_doorblocks_loc   ON doorblocks(location_id)`);
      await run(`CREATE INDEX IF NOT EXISTS idx_reservations_loc ON door_reservations(location_id)`);

      const plates = new Set((await all(`SELECT door FROM dockplates WHERE location_id=1`)).map(r => r.door));
      for (let d = 28; d <= 42; d++) {
        const door = String(d);
        if (!plates.has(door)) {
          await run(`INSERT INTO dockplates(door,status,note,"updatedAt",location_id) VALUES(?,?,?,?,?)`,
            [door, 'Unknown', '', Date.now(), 1]);
        }
      }
    },
  },

  {
    version: 8,
    description: 'Team chat — messages table',
    up: async (run) => {
      await run(`CREATE TABLE IF NOT EXISTS messages(
        id          BIGSERIAL PRIMARY KEY,
        at          BIGINT NOT NULL,
        channel     TEXT NOT NULL DEFAULT 'general',
        role        TEXT NOT NULL,
        sender      TEXT NOT NULL,
        body        TEXT NOT NULL DEFAULT '',
        reply_to    BIGINT DEFAULT NULL,
        reactions   TEXT DEFAULT '{}',
        photo_data  TEXT DEFAULT NULL,
        photo_mime  TEXT DEFAULT NULL,
        location_id INTEGER NOT NULL DEFAULT 1
      )`);
      await run(`CREATE INDEX IF NOT EXISTS idx_messages_channel_loc ON messages(channel, location_id)`);
      await run(`CREATE INDEX IF NOT EXISTS idx_messages_at          ON messages(at DESC)`);
      await run(`CREATE INDEX IF NOT EXISTS idx_messages_loc         ON messages(location_id)`);
    },
  },
];

async function runMigrations(run, get, all) {
  // PostgreSQL version of migrations tracking table
  await run(`CREATE TABLE IF NOT EXISTS migrations(
    version     INTEGER PRIMARY KEY,
    description TEXT,
    "appliedAt" BIGINT
  )`);

  const applied = new Set(
    (await all(`SELECT version FROM migrations`)).map(r => r.version)
  );

  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    console.log(`[DB] Applying migration ${m.version}: ${m.description}`);
    try {
      await m.up(run, all);
      await run(
        `INSERT INTO migrations(version, description, "appliedAt") VALUES(?,?,?)`,
        [m.version, m.description, Date.now()]
      );
      console.log(`[DB] Migration ${m.version} applied ✓`);
    } catch (err) {
      console.error(`[DB] Migration ${m.version} FAILED:`, err.message);
      throw err;
    }
  }
}

module.exports = { MIGRATIONS, runMigrations };
