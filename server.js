/**
 * server.js — Wesbell Dispatch v3.6.0
 * Modular entry point. All logic lives in lib/.
 */
'use strict';

const express = require('express');
const fs      = require('fs');
const path    = require('path');

// ── Crash guards ──────────────────────────────────────────────────────────────
process.on('uncaughtException',  e => { console.error('[CRASH] uncaughtException:', e);  logSafe('crash', String(e?.stack || e)); });
process.on('unhandledRejection', e => { console.error('[CRASH] unhandledRejection:', e); logSafe('crash', String(e?.stack || e)); });
function logSafe(context, detail) {
  try { require('./lib/helpers').logEvent('error', 'crash', context, detail).catch(() => {}); } catch {}
}

// ── App ───────────────────────────────────────────────────────────────────────
const app = express();
const { PORT, APP_VERSION } = require('./lib/config');

// ── Middleware (order matters) ────────────────────────────────────────────────
const mw = require('./lib/middleware');
app.use(mw.gzip);
app.use(mw.securityHeaders);
app.use(mw.requestTimeout);
app.use(express.json({ limit: '6mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Routes ────────────────────────────────────────────────────────────────────
app.use(require('./lib/routes/auth'));
app.use(require('./lib/routes/trailers'));
app.use(require('./lib/routes/dock'));
app.use(require('./lib/routes/driver'));
app.use(require('./lib/routes/push'));
app.use(require('./lib/routes/admin'));
app.use(require('./lib/routes/reports'));
app.use(require('./lib/routes/chat'));      // team chat
app.use(require('./lib/routes/static'));   // static + page routes last

// ── WebSocket ─────────────────────────────────────────────────────────────────
const ws           = require('./lib/ws');
const { server }   = ws.init(app);

// ── DB + startup ──────────────────────────────────────────────────────────────
const { initDb, db, checkpoint } = require('./lib/db');
const push = require('./lib/push');

initDb()
  .then(async () => {
    // Ensure chat_messages table exists (safe to run every startup)
    const { run: dbRun } = require('./lib/db');
    await dbRun(`CREATE TABLE IF NOT EXISTS chat_messages (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      at        INTEGER NOT NULL,
      channel   TEXT    NOT NULL DEFAULT 'general',
      role      TEXT    NOT NULL,
      name      TEXT    NOT NULL,
      text      TEXT    NOT NULL DEFAULT '',
      imageData TEXT
    )`);
    await dbRun(`CREATE INDEX IF NOT EXISTS idx_chat_channel_at ON chat_messages(channel, at)`);
    push.loadOrGenVapid();
    await push.loadSubscriptions();
  })
  .then(() => {
    server.listen(PORT, () => {
      console.log(`Wesbell Dispatch v${APP_VERSION} → http://localhost:${PORT}`);
      console.log(`DB: ${require('./lib/config').DB_FILE}`);
    });

    // ── Scheduled jobs ────────────────────────────────────────────────────────
    async function archiveDeparted() {
      try {
        const { run } = require('./lib/db');
        const { invalidateTrailers } = require('./lib/cache');
        const { broadcastTrailers }  = require('./lib/ws');
        const { logEvent }           = require('./lib/helpers');
        const cutoff = Date.now() - 24 * 3_600_000;
        const r      = await run(`DELETE FROM trailers WHERE status='Departed' AND updatedAt < ?`, [cutoff]);
        if (r.changes > 0) {
          invalidateTrailers();
          await broadcastTrailers();
          await logEvent('info', 'archive', `Auto-archived ${r.changes} departed trailers`);
          console.log(`[ARCHIVE] Removed ${r.changes} old departed trailers`);
        }
      } catch (e) { require('./lib/helpers').logEvent('error', 'archive', 'Auto-archive failed', e.message); }
    }
    setInterval(archiveDeparted, 3_600_000);
    archiveDeparted();

    async function backupDb() {
      try {
        const backupFile = path.join(path.dirname(require('./lib/config').DB_FILE), 'wesbell-backup.sqlite');
        await checkpoint();
        fs.copyFileSync(require('./lib/config').DB_FILE, backupFile);
        await require('./lib/helpers').logEvent('info', 'backup', 'DB backup completed', backupFile);
        console.log(`[BACKUP] DB backed up to ${backupFile}`);
      } catch (e) {
        require('./lib/helpers').logEvent('error', 'backup', 'DB backup failed', e.message);
        console.error('[BACKUP]', e.message);
      }
    }
    setInterval(backupDb, 3_600_000);

    // ── Graceful shutdown ─────────────────────────────────────────────────────
    let shuttingDown = false;
    async function gracefulShutdown(signal) {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`[SHUTDOWN] ${signal} received — closing gracefully`);
      await require('./lib/helpers').logEvent('info', 'shutdown', `Server shutting down (${signal})`).catch(() => {});
      const { wss } = require('./lib/ws');
      for (const client of wss.clients) try { client.close(1001, 'Server shutting down'); } catch {}
      server.close(() => {
        db.close(() => { console.log('[SHUTDOWN] Complete'); process.exit(0); });
      });
      setTimeout(() => { console.error('[SHUTDOWN] Forced exit'); process.exit(1); }, 10_000);
    }
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
  })
  .catch(e => { console.error('DB init failed:', e); process.exit(1); });
