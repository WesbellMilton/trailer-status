'use strict';
const http      = require('http');
const WebSocket = require('ws');
const { getTrailersCache, getPlatesCache, getBlocksCache, loadConfirmations } = require('./cache');

let _app = null;   // set via init()
let _wss = null;
let _server = null;

function init(expressApp) {
  _app    = expressApp;
  _server = http.createServer(_app);
  _wss    = new WebSocket.Server({ server: _server });

  _wss.on('connection', async ws => {
    ws.on('error', () => {});
    const safeSend = msg => { try { if (ws.readyState === WebSocket.OPEN) ws.send(msg); } catch {} };
    ws.isAlive = true;
    ws.on('pong',    () => { ws.isAlive = true; });
    ws.on('message', () => { ws.isAlive = true; });

    const heartbeat = setInterval(() => {
      if (!ws.isAlive) { clearInterval(heartbeat); try { ws.terminate(); } catch {} return; }
      ws.isAlive = false;
      try { ws.ping(); } catch {}
      safeSend(JSON.stringify({ type: 'ping' }));
    }, 20_000);

    ws.on('close', () => clearInterval(heartbeat));

    const { APP_VERSION } = require('./config');
    try { safeSend(JSON.stringify({ type: 'version',       payload: { version: APP_VERSION } })); } catch {}
    try { safeSend(JSON.stringify({ type: 'state',         payload: await require('./cache').loadTrailersObject() })); } catch {}
    try { safeSend(JSON.stringify({ type: 'dockplates',    payload: await require('./cache').loadDockPlatesObject() })); } catch {}
    try { safeSend(JSON.stringify({ type: 'doorblocks',    payload: await require('./cache').loadDoorBlocksObject() })); } catch {}
    try { safeSend(JSON.stringify({ type: 'confirmations', payload: await loadConfirmations(250) })); } catch {}
  });

  // Terminate stale clients every 30 s
  setInterval(() => {
    for (const client of _wss.clients)
      if (client.readyState === WebSocket.CLOSING || client.readyState === WebSocket.CLOSED)
        try { client.terminate(); } catch {}
  }, 30_000).unref();

  return { server: _server, wss: _wss };
}

// ── Broadcast helpers ─────────────────────────────────────────────────────────
function wsBroadcast(type, payload) {
  if (!_wss) return;
  const msg = JSON.stringify({ type, payload });
  for (const client of _wss.clients)
    if (client.readyState === WebSocket.OPEN)
      try { client.send(msg); } catch {}
}

// Debounced trailer broadcast — collapses rapid-fire calls within 80 ms
let _broadcastTimer = null;
function broadcastTrailers() {
  return new Promise(resolve => {
    if (_broadcastTimer) clearTimeout(_broadcastTimer);
    _broadcastTimer = setTimeout(async () => {
      _broadcastTimer = null;
      try {
        require('./cache').invalidateTrailers();
        wsBroadcast('state', await getTrailersCache());
      } catch (e) { console.error('[WS] broadcastTrailers:', e.message); }
      resolve();
    }, 80);
  });
}

async function broadcastPlates() {
  try { require('./cache').invalidatePlates(); wsBroadcast('dockplates', await getPlatesCache()); }
  catch (e) { console.error('[WS] broadcastPlates:', e.message); }
}
async function broadcastBlocks() {
  try { require('./cache').invalidateBlocks(); wsBroadcast('doorblocks', await getBlocksCache()); }
  catch (e) { console.error('[WS] broadcastBlocks:', e.message); }
}
async function broadcastConfirmations() {
  try { wsBroadcast('confirmations', await loadConfirmations(250)); }
  catch (e) { console.error('[WS] broadcastConfirmations:', e.message); }
}

module.exports = {
  init,
  get wss() { return _wss; },
  get server() { return _server; },
  wsBroadcast, broadcastTrailers, broadcastPlates, broadcastBlocks, broadcastConfirmations,
};
