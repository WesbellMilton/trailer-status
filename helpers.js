'use strict';
const { run }        = require('./db');
const { MAX_LOGS, WEBHOOK_URL } = require('./config');
const { ipOf }       = require('./middleware');

// FIX: log prune is O(n) full-table scan — run it periodically instead of on every write.
// Pruning once per hour is sufficient; MAX_LOGS is a ceiling not a hard real-time cap.
async function _pruneLogs() {
  try {
    await run(
      `DELETE FROM logs WHERE id NOT IN (SELECT id FROM logs ORDER BY at DESC LIMIT ?)`,
      [MAX_LOGS]
    );
  } catch {}
}
setInterval(_pruneLogs, 3_600_000).unref(); // hourly, non-blocking

async function logEvent(level, context, message, detail = '') {
  try {
    await run(
      `INSERT INTO logs(at,level,context,message,detail) VALUES(?,?,?,?,?)`,
      [Date.now(), level, context, message, String(detail).slice(0, 500)]
    );
  } catch {}
}

async function audit(req, actorRole, action, entityType, entityId, details) {
  let d = '';
  try { d = JSON.stringify(details || {}); } catch {}
  await run(
    `INSERT INTO audit(at,actorRole,action,entityType,entityId,details,ip,userAgent)
     VALUES(?,?,?,?,?,?,?,?)`,
    [Date.now(), actorRole || 'unknown', action, entityType, entityId, d,
     ipOf(req), req.headers['user-agent'] || '']
  );
}

// FIX: webhook had no retry — silently dropped on transient failure.
// Now retries once after 2 s before giving up.
function _doWebhookRequest(body) {
  const url = new URL(WEBHOOK_URL);
  const mod = url.protocol === 'https:' ? require('https') : require('http');
  return new Promise((resolve, reject) => {
    const req = mod.request(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => { res.resume(); resolve(); });
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(new Error('timeout')); });
    req.write(body);
    req.end();
  });
}

async function fireWebhook(event, data) {
  if (!WEBHOOK_URL) return;
  const body = JSON.stringify({ event, data, at: Date.now(), source: 'wesbell-dispatch' });
  try {
    await _doWebhookRequest(body);
  } catch {
    // Retry once after 2 s
    await new Promise(r => setTimeout(r, 2000));
    try {
      await _doWebhookRequest(body);
    } catch (e2) {
      logEvent('warn', 'webhook', `Webhook failed for ${event} (2 attempts)`, e2.message);
    }
  }
}

module.exports = { logEvent, audit, fireWebhook, ipOf };
