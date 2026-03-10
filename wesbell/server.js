/**
 * server.js — Wesbell Dispatch v3.7.0
 * Modular entry point. All logic lives in lib/.
 * PostgreSQL edition — SQLite removed.
 */
'use strict';

const express = require('express');

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
app.use(require('./lib/routes/chat'));
app.use(require('./lib/routes/static'));

// ── WebSocket ─────────────────────────────────────────────────────────────────
const ws         = require('./lib/ws');
const { server } = ws.init(app);

// ── DB + startup ──────────────────────────────────────────────────────────────
const { initDb } = require('./lib/db');
const push       = require('./lib/push');

initDb()
  .then(async () => {
    push.loadOrGenVapid();
    await push.loadSubscriptions();
  })
  .then(() => {
    server.listen(PORT, () => {
      console.log(`Wesbell Dispatch v${APP_VERSION} → http://localhost:${PORT}`);
      console.log(`DB: PostgreSQL`);
    });

    // ── Auto-archive departed trailers (every hour) ───────────────────────────
    async function archiveDeparted() {
      try {
        const { run }                = require('./lib/db');
        const { invalidateTrailers } = require('./lib/cache');
        const { broadcastTrailers }  = require('./lib/ws');
        const { logEvent }           = require('./lib/helpers');
        const cutoff = Date.now() - 24 * 3_600_000;
        const r = await run(`DELETE FROM trailers WHERE status='Departed' AND "updatedAt" < ?`, [cutoff]);
        if (r.changes > 0) {
          invalidateTrailers();
          await broadcastTrailers();
          await logEvent('info', 'archive', `Auto-archived ${r.changes} departed trailers`);
          console.log(`[ARCHIVE] Removed ${r.changes} old departed trailers`);
        }
      } catch (e) {
        require('./lib/helpers').logEvent('error', 'archive', 'Auto-archive failed', e.message);
      }
    }
    setInterval(archiveDeparted, 3_600_000);
    archiveDeparted();

    // ── Graceful shutdown ─────────────────────────────────────────────────────
    let shuttingDown = false;
    async function gracefulShutdown(signal) {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`[SHUTDOWN] ${signal} received — closing gracefully`);
      await require('./lib/helpers').logEvent('info', 'shutdown', `Server shutting down (${signal})`).catch(() => {});
      const { wss }  = require('./lib/ws');
      const { pool } = require('./lib/db');
      for (const client of wss.clients) try { client.close(1001, 'Server shutting down'); } catch {}
      server.close(async () => {
        try { await pool.end(); } catch {}
        console.log('[SHUTDOWN] Complete');
        process.exit(0);
      });
      setTimeout(() => { console.error('[SHUTDOWN] Forced exit'); process.exit(1); }, 10_000);
    }
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
  })
  .catch(e => { console.error('DB init failed:', e); process.exit(1); });
