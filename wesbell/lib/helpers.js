'use strict';
const { run }        = require('./db');
const { MAX_LOGS, WEBHOOK_URL } = require('./config');
const { ipOf }       = require('./middleware');

async function logEvent(level, context, message, detail = '') {
  try {
    await run(
      `INSERT INTO logs(at,level,context,message,detail) VALUES(?,?,?,?,?)`,
      [Date.now(), level, context, message, String(detail).slice(0, 500)]
    );
    await run(
      `DELETE FROM logs WHERE id NOT IN (SELECT id FROM logs ORDER BY at DESC LIMIT ?)`,
      [MAX_LOGS]
    );
  } catch {}
}

async function audit(req, actorRole, action, entityType, entityId, details) {
  let d = '';
  try { d = JSON.stringify(details || {}); } catch {}
  await run(
    `INSERT INTO audit(at,"actorRole",action,"entityType","entityId",details,ip,"userAgent")
     VALUES(?,?,?,?,?,?,?,?)`,
    [Date.now(), actorRole || 'unknown', action, entityType, entityId, d,
     ipOf(req), req.headers['user-agent'] || '']
  );
}

async function fireWebhook(event, data) {
  if (!WEBHOOK_URL) return;
  try {
    const body = JSON.stringify({ event, data, at: Date.now(), source: 'wesbell-dispatch' });
    const url  = new URL(WEBHOOK_URL);
    const mod  = url.protocol === 'https:' ? require('https') : require('http');
    await new Promise((resolve, reject) => {
      const req = mod.request(WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, res => { res.resume(); resolve(); });
      req.on('error', reject);
      req.setTimeout(5000, () => req.destroy());
      req.write(body);
      req.end();
    });
  } catch (e) { logEvent('warn', 'webhook', `Webhook failed for ${event}`, e.message); }
}

module.exports = { logEvent, audit, fireWebhook, ipOf };
