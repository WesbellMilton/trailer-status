/**
 * ws-client.js — WebSocket client
 * Connects to the server, receives state updates, writes to the store.
 */
import { store } from './state.js';

let _ws         = null;
let _retryCount = 0;
let _onConnectCallbacks = [];

export function onWsConnect(fn) { _onConnectCallbacks.push(fn); }

export function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  _ws = new WebSocket(`${proto}//${location.host}`);

  _ws.onopen = () => {
    _retryCount = 0;
    store.set('wsOnline', true);
    _onConnectCallbacks.forEach(fn => { try { fn(); } catch {} });
  };

  _ws.onclose = () => {
    store.set('wsOnline', false);
    const base   = Math.min(30_000, 1_000 * 2 ** _retryCount++);
    const jitter = Math.random() * 500;
    setTimeout(connectWs, Math.round(base + jitter));
  };

  _ws.onerror = () => {};   // onclose fires after onerror

  _ws.onmessage = evt => {
    let msg;
    try { msg = JSON.parse(evt.data); } catch { return; }
    const { type, payload } = msg;

    switch (type) {
      case 'state':         store.set('trailers',      payload); break;
      case 'dockplates':    store.set('dockPlates',    payload); break;
      case 'doorblocks':    store.set('doorBlocks',    payload); break;
      case 'confirmations': store.set('confirmations', payload); break;
      case 'version':       store.set('version',       payload?.version || ''); break;
      case 'shift_note':    store.set('shiftNote',     payload); break;
      case 'location':
        // Broadcast location updates — let geofence component handle
        window.dispatchEvent(new CustomEvent('wb:location', { detail: payload }));
        break;
      case 'omw':
      case 'arrive':
        window.dispatchEvent(new CustomEvent('wb:arrival', { detail: payload }));
        break;
      case 'notify':
        window.dispatchEvent(new CustomEvent('wb:notify', { detail: payload }));
        break;
      case 'ping':
        break;   // keepalive — no-op
      default:
        window.dispatchEvent(new CustomEvent(`wb:ws:${type}`, { detail: payload }));
    }
  };
}

export function wsSend(type, payload) {
  if (_ws?.readyState === WebSocket.OPEN) {
    try { _ws.send(JSON.stringify({ type, payload })); } catch {}
  }
}
