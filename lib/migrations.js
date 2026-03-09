'use strict';
/**
 * Database migrations for Wesbell Dispatch.
 *
 * Each entry = { version: N, description: '...', up: async (run) => { ... } }
 * Migrations are applied in order, exactly once, tracked in the `migrations` table.
 * Never edit or remove an applied migration — add a new one instead.
 */

const MIGRATIONS = [
  {
    version: 1,
    description: 'Initial schema — core tables',
    up: async (run) => {
      await run(`CREATE TABLE IF NOT EXISTS trailers(
        trailer TEXT PRIMARY KEY,
        direction TEXT,
        status TEXT,
        door TEXT,
        note TEXT,
        dropType TEXT,
        carrierType TEXT DEFAULT '',
        updatedAt INTEGER,
        omwAt INTEGER DEFAULT NULL,
        omwEta INTEGER DEFAULT NULL,
        doorAt INTEGER DEFAULT NULL
      )`);
      await run(`CREATE TABLE IF NOT EXISTS doorblocks(
        door TEXT PRIMARY KEY,
        note TEXT NOT NULL DEFAULT '',
        setAt INTEGER NOT NULL DEFAULT 0
      )`);
      await run(`CREATE TABLE IF NOT EXISTS dockplates(
        door TEXT PRIMARY KEY,
        status TEXT,
        note TEXT,
        updatedAt INTEGER
      )`);
      await run(`CREATE TABLE IF NOT EXISTS confirmations(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER,
        trailer TEXT,
        door TEXT,
        action TEXT,
        ip TEXT,
        userAgent TEXT
      )`);
      await run(`CREATE TABLE IF NOT EXISTS audit(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER,
        actorRole TEXT,
        action TEXT,
        entityType TEXT,
        entityId TEXT,
        details TEXT,
        ip TEXT,
        userAgent TEXT
      )`);
      await run(`CREATE TABLE IF NOT EXISTS push_subscriptions(
        endpoint TEXT PRIMARY KEY,
        subscription TEXT,
        createdAt INTEGER
      )`);
      await run(`CREATE TABLE IF NOT EXISTS issue_reports(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER,
        trailer TEXT,
        door TEXT,
        note TEXT,
        photo_data TEXT,
        photo_mime TEXT,
        ip TEXT,
        userAgent TEXT
      )`);
      await run(`CREATE TABLE IF NOT EXISTS pins(
        role TEXT PRIMARY KEY,
        salt BLOB,
        hash BLOB,
        iter INTEGER
      )`);
      await run(`CREATE TABLE IF NOT EXISTS logs(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER,
        level TEXT,
        context TEXT,
        message TEXT,
        detail TEXT
      )`);
      await run(`CREATE TABLE IF NOT EXISTS door_reservations(
        door TEXT PRIMARY KEY,
        trailer TEXT NOT NULL,
        carrierType TEXT NOT NULL DEFAULT 'Outside',
        reservedAt INTEGER NOT NULL,
        expiresAt INTEGER NOT NULL
      )`);
    },
  },

  {
    version: 2,
    description: 'Add carrierType column to trailers if missing (pre-v3 upgrade)',
    up: async (run) => {
      // Safe to fail if column already exists — SQLite doesn't support IF NOT EXISTS on ALTER
      try { await run(`ALTER TABLE trailers ADD COLUMN carrierType TEXT DEFAULT ''`); } catch {}
      try { await run(`ALTER TABLE trailers ADD COLUMN omwAt INTEGER DEFAULT NULL`); } catch {}
      try { await run(`ALTER TABLE trailers ADD COLUMN omwEta INTEGER DEFAULT NULL`); } catch {}
      try { await run(`ALTER TABLE trailers ADD COLUMN doorAt INTEGER DEFAULT NULL`); } catch {}
      try { await run(`ALTER TABLE confirmations ADD COLUMN action TEXT`); } catch {}
    },
  },

  {
    version: 3,
    description: 'Performance indexes',
    up: async (run) => {
      await run(`CREATE INDEX IF NOT EXISTS idx_trailers_status    ON trailers(status)`);
      await run(`CREATE INDEX IF NOT EXISTS idx_trailers_updatedAt ON trailers(updatedAt DESC)`);
      await run(`CREATE INDEX IF NOT EXISTS idx_audit_at           ON audit(at DESC)`);
      await run(`CREATE INDEX IF NOT EXISTS idx_audit_entityId     ON audit(entityId)`);
      await run(`CREATE INDEX IF NOT EXISTS idx_audit_action       ON audit(action)`);
      await run(`CREATE INDEX IF NOT EXISTS idx_reservations_exp   ON door_reservations(expiresAt)`);
      await run(`CREATE INDEX IF NOT EXISTS idx_issues_at          ON issue_reports(at DESC)`);
      await run(`CREATE INDEX IF NOT EXISTS idx_issues_trailer     ON issue_reports(trailer)`);
    },
  },

  {
    version: 4,
    description: 'Seed default dockplates for doors 28–42',
    up: async (run, all) => {
      await run(`DELETE FROM dockplates WHERE CAST(door AS INTEGER) < 28`);
      const existing = new Set((await all(`SELECT door FROM dockplates`)).map(r => r.door));
      for (let d = 28; d <= 42; d++) {
        const door = String(d);
        if (!existing.has(door)) {
          await run(
            `INSERT INTO dockplates(door,status,note,updatedAt) VALUES(?,?,?,?)`,
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
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        trailer TEXT NOT NULL,
        zone TEXT NOT NULL,
        event TEXT NOT NULL,
        lat REAL,
        lng REAL,
        ip TEXT
      )`);
      await run(`CREATE INDEX IF NOT EXISTS idx_geofence_trailer ON geofence_events(trailer)`);
      await run(`CREATE INDEX IF NOT EXISTS idx_geofence_at ON geofence_events(at DESC)`);
    },
  },

  {
    version: 6,
    description: 'Add qr_scans table for streamlined QR automation tracking',
    up: async (run) => {
      await run(`CREATE TABLE IF NOT EXISTS qr_scans(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        trailer TEXT NOT NULL,
        door TEXT,
        action TEXT NOT NULL,
        scannedBy TEXT DEFAULT 'driver',
        ip TEXT
      )`);
      await run(`CREATE INDEX IF NOT EXISTS idx_qr_trailer ON qr_scans(trailer)`);
    },
  },

  {
    version: 7,
    description: 'Multi-location support — locations table + location_id on scoped tables',
    up: async (run, all) => {
      // Locations master table
      await run(`CREATE TABLE IF NOT EXISTS locations(
        id   INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        slug TEXT NOT NULL UNIQUE,
        doors_from INTEGER NOT NULL DEFAULT 28,
        doors_to   INTEGER NOT NULL DEFAULT 42,
        timezone   TEXT NOT NULL DEFAULT 'America/Toronto',
        active     INTEGER NOT NULL DEFAULT 1,
        createdAt  INTEGER NOT NULL DEFAULT 0
      )`);

      // Seed a default "Milton" location — maps existing single-location data
      const existing = await all(`SELECT id FROM locations LIMIT 1`);
      if (!existing.length) {
        await run(
          `INSERT INTO locations(name,slug,doors_from,doors_to,timezone,active,createdAt)
           VALUES(?,?,?,?,?,?,?)`,
          ['Milton', 'milton', 28, 42, 'America/Toronto', 1, Date.now()]
        );
      }

      // Add location_id to scoped tables — safe no-op if column already exists
      for (const tbl of ['trailers','dockplates','doorblocks','door_reservations','confirmations','audit','issue_reports','geofence_events']) {
        try { await run(`ALTER TABLE ${tbl} ADD COLUMN location_id INTEGER NOT NULL DEFAULT 1`); } catch {}
      }

      // Back-fill all existing rows to location 1 (Milton)
      for (const tbl of ['trailers','dockplates','doorblocks','door_reservations','confirmations','audit','issue_reports']) {
        try { await run(`UPDATE ${tbl} SET location_id=1 WHERE location_id IS NULL OR location_id=0`); } catch {}
      }

      // Indexes
      await run(`CREATE INDEX IF NOT EXISTS idx_trailers_loc    ON trailers(location_id)`);
      await run(`CREATE INDEX IF NOT EXISTS idx_audit_loc       ON audit(location_id)`);
      await run(`CREATE INDEX IF NOT EXISTS idx_issues_loc      ON issue_reports(location_id)`);
      await run(`CREATE INDEX IF NOT EXISTS idx_dockplates_loc  ON dockplates(location_id)`);
      await run(`CREATE INDEX IF NOT EXISTS idx_doorblocks_loc  ON doorblocks(location_id)`);
      await run(`CREATE INDEX IF NOT EXISTS idx_reservations_loc ON door_reservations(location_id)`);

      // Re-seed dockplates for location 1 so door range is correct
      const plates = new Set((await all(`SELECT door FROM dockplates WHERE location_id=1`)).map(r=>r.door));
      for (let d = 28; d <= 42; d++) {
        const door = String(d);
        if (!plates.has(door)) {
          await run(`INSERT INTO dockplates(door,status,note,updatedAt,location_id) VALUES(?,?,?,?,?)`,
            [door, 'Unknown', '', Date.now(), 1]);
        }
      }
    },
  },

  {
    version: 8,
    description: 'Add messages table for Team Chat',
    up: async (run) => {
      await run(`CREATE TABLE IF NOT EXISTS messages (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        at          INTEGER NOT NULL,
        channel     TEXT    NOT NULL DEFAULT 'general',
        role        TEXT    NOT NULL DEFAULT 'dispatcher',
        sender      TEXT    NOT NULL DEFAULT '',
        body        TEXT    NOT NULL DEFAULT '',
        reply_to    INTEGER,
        reactions   TEXT,
        photo_data  TEXT,
        photo_mime  TEXT,
        location_id INTEGER NOT NULL DEFAULT 1
      )`);
      await run(`CREATE INDEX IF NOT EXISTS idx_messages_channel_loc ON messages(channel, location_id)`);
      await run(`CREATE INDEX IF NOT EXISTS idx_messages_at          ON messages(at DESC)`);
      await run(`CREATE INDEX IF NOT EXISTS idx_messages_loc         ON messages(location_id)`);
    },
  },
];

/**
 * runMigrations(db, run, get, all)
 * Applies all pending migrations in order against the open db connection.
 */
async function runMigrations(run, get, all) {
  // Ensure migrations tracking table exists
  await run(`CREATE TABLE IF NOT EXISTS migrations(
    version INTEGER PRIMARY KEY,
    description TEXT,
    appliedAt INTEGER
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
        `INSERT INTO migrations(version, description, appliedAt) VALUES(?,?,?)`,
        [m.version, m.description, Date.now()]
      );
      console.log(`[DB] Migration ${m.version} applied ✓`);
    } catch (err) {
      console.error(`[DB] Migration ${m.version} FAILED:`, err.message);
      throw err;  // halt startup — do not run on a broken schema
    }
  }
}

module.exports = { MIGRATIONS, runMigrations };
