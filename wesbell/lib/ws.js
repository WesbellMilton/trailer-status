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

  _wss.on('connection', async (ws, req) => {
    ws.on('error', () => {});
    const safeSend = msg => { try { if (ws.readyState === WebSocket.OPEN) ws.send(msg); } catch {} };
    ws.isAlive = true;
    ws.locationId = 1; // default — updated when client sends identify message
    ws.on('pong',    () => { ws.isAlive = true; });
    ws.on('message', raw => {
      ws.isAlive = true;
      // Client sends { type:'identify', locationId:N } immediately after connect
      try {
        const msg = JSON.parse(raw);
        if (msg.type === 'identify' && msg.locationId) {
          ws.locationId = Number(msg.locationId) || 1;
        }
      } catch {}
    });

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

  // Terminate stale clients every 30 s — also catches unresponsive OPEN sockets
  setInterval(() => {
    let alive=0, dead=0;
    for (const client of _wss.clients) {
      if (client.readyState === WebSocket.CLOSING || client.readyState === WebSocket.CLOSED) {
        try { client.terminate(); } catch {}
        dead++;
      } else {
        alive++;
      }
    }
    if (dead > 0) console.log(`[WS] swept ${dead} dead client(s), ${alive} alive`);
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

// Location-scoped broadcast — only sends to clients at the given location
function wsBroadcastToLocation(locationId, type, payload) {
  if (!_wss) return;
  const msg = JSON.stringify({ type, payload });
  for (const client of _wss.clients)
    if (client.readyState === WebSocket.OPEN && (client.locationId === locationId || client.locationId === 0))
      try { client.send(msg); } catch {}
}

// Debounced trailer broadcast — collapses rapid-fire calls within 80 ms
const _broadcastTimers = new Map(); // locationId → timer
function broadcastTrailers(locationId = null) {
  return new Promise(resolve => {
    const key = locationId || 'all';
    if (_broadcastTimers.has(key)) clearTimeout(_broadcastTimers.get(key));
    _broadcastTimers.set(key, setTimeout(async () => {
      _broadcastTimers.delete(key);
      try {
        const cache = require('./cache');
        if (locationId) {
          cache.invalidateTrailers(locationId);
          const data = await cache.getTrailersCache(locationId);
          wsBroadcastToLocation(locationId, 'state', data);
        } else {
          cache.invalidateTrailers();
          wsBroadcast('state', await cache.getTrailersCache());
        }
      } catch (e) { console.error('[WS] broadcastTrailers:', e.message); }
      resolve();
    }, 80));
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
  wsBroadcast, wsBroadcastToLocation,
  broadcastTrailers, broadcastPlates, broadcastBlocks, broadcastConfirmations,
};
