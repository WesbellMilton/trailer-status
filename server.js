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
app.set('trust proxy', 1); // Render sits behind a load balancer — read real IP from X-Forwarded-For
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
app.use(require('./lib/routes/static'));   // static + page routes last

// ── WebSocket ─────────────────────────────────────────────────────────────────
const ws           = require('./lib/ws');
const { server }   = ws.init(app);

// ── DB + startup ──────────────────────────────────────────────────────────────
const { initDb, db, checkpoint } = require('./lib/db');
const push = require('./lib/push');

initDb()
  .then(async () => {
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
    // FIX: delay first run 10 s so DB is fully ready; run every hour at :00
    setTimeout(() => {
      archiveDeparted();
      setInterval(archiveDeparted, 3_600_000);
    }, 10_000);

    // ── Auto-depart ───────────────────────────────────────────────────────────
    // Advances 'Dock Ready' trailers to 'Departed' after AUTO_DEPART_MINUTES.
    // Disabled when AUTO_DEPART_MINUTES === 0 (default).
    async function runAutoDepart() {
      const { AUTO_DEPART_MINUTES } = require('./lib/config');
      if (!AUTO_DEPART_MINUTES || AUTO_DEPART_MINUTES <= 0) return;
      try {
        const { all, run: dbRun } = require('./lib/db');
        const { broadcastTrailers, wsBroadcast } = require('./lib/ws');
        const { broadcastPush }  = require('./lib/push');
        const { audit, logEvent, fireWebhook } = require('./lib/helpers');
        const { invalidateTrailers } = require('./lib/cache');
        const cutoff = Date.now() - AUTO_DEPART_MINUTES * 60_000;
        const due = await all(
          `SELECT trailer, door FROM trailers WHERE status='Dock Ready' AND updatedAt <= ?`,
          [cutoff]
        );
        if (!due.length) return;
        const now = Date.now();
        for (const { trailer, door } of due) {
          await dbRun(
            `UPDATE trailers SET status='Departed', updatedAt=? WHERE trailer=? AND status='Dock Ready'`,
            [now, trailer]
          );
          wsBroadcast('notify', { kind: 'departed', trailer, door: door || '', auto: true });
          broadcastPush('🚪 Auto-Departed', `${trailer}${door ? ' — Door ' + door + ' now free' : ' has departed'}`, { trailer, door }).catch(() => {});
          fireWebhook('trailer.departed', { trailer, door, actor: 'auto-depart' });
          await audit(null, 'auto-depart', 'trailer_status_set', 'trailer', trailer, { status: 'Departed', trigger: 'auto', minutesSinceDockReady: AUTO_DEPART_MINUTES });
          await logEvent('info', 'auto-depart', `Auto-departed ${trailer} after ${AUTO_DEPART_MINUTES} min in Dock Ready`, `door=${door || '—'}`);
          console.log(`[AUTO-DEPART] ${trailer} -> Departed (door ${door || '-'})`);
        }
        invalidateTrailers();
        await broadcastTrailers();
      } catch (e) {
        require('./lib/helpers').logEvent('error', 'auto-depart', 'Auto-depart job failed', e.message);
        console.error('[AUTO-DEPART]', e.message);
      }
    }
    // Check every 2 minutes; first run after 15 s
    setTimeout(() => {
      runAutoDepart();
      setInterval(runAutoDepart, 2 * 60_000);
    }, 15_000);

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
    // FIX: stagger backup 30 min after archive to avoid simultaneous I/O
    setTimeout(() => {
      backupDb();
      setInterval(backupDb, 3_600_000);
    }, 30 * 60_000);

    // FIX: WAL checkpoint every 30 min — prevents WAL file growing unbounded
    setInterval(async () => {
      try { await checkpoint(); }
      catch (e) { console.error('[WAL] Checkpoint failed:', e.message); }
    }, 30 * 60_000).unref();

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
