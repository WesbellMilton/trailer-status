/**
 * state.js — Wesbell Dispatch client state store
 *
 * Single source of truth for all shared UI state.
 * Components subscribe to slices; the store notifies only affected subscribers.
 *
 * Usage:
 *   import { store } from './state.js';
 *   store.subscribe('trailers', (trailers) => renderBoard(trailers));
 *   store.set('trailers', newData);
 *   const role = store.get('role');
 */

const _state = {
  role          : null,
  version       : '',
  trailers      : {},
  dockPlates    : {},
  doorBlocks    : {},
  confirmations : [],
  shiftNote     : { text: '', setAt: 0, setBy: '' },
  wsOnline      : false,
  geofenceZones : [],
};

const _subscribers = {};   // key → Set<fn>

export const store = {
  // ── Read ───────────────────────────────────────────────────────────────────
  get(key) { return _state[key]; },

  getAll() { return { ..._state }; },

  // ── Write ─────────────────────────────────────────────────────────────────
  set(key, value) {
    _state[key] = value;
    this._notify(key, value);
  },

  patch(key, partial) {
    _state[key] = { ..._state[key], ...partial };
    this._notify(key, _state[key]);
  },

  // ── Subscribe ─────────────────────────────────────────────────────────────
  /**
   * subscribe(key, fn) → unsubscribe()
   * fn is called immediately with the current value, then on every change.
   */
  subscribe(key, fn) {
    if (!_subscribers[key]) _subscribers[key] = new Set();
    _subscribers[key].add(fn);
    fn(_state[key]);   // initial call
    return () => _subscribers[key].delete(fn);
  },

  // ── Internal ──────────────────────────────────────────────────────────────
  _notify(key, value) {
    (_subscribers[key] || new Set()).forEach(fn => {
      try { fn(value); } catch (e) { console.error(`[store] subscriber error on "${key}":`, e); }
    });
  },
};

// ── Computed helpers (derive from state, do not subscribe internally) ─────────
export function getOccupiedDoors() {
  const trailers  = store.get('trailers') || {};
  const doorBlocks = store.get('doorBlocks') || {};
  const occupied  = new Set();
  for (const [, t] of Object.entries(trailers)) {
    if (t.door && !['Departed', ''].includes(t.status)) occupied.add(String(t.door));
  }
  for (const door of Object.keys(doorBlocks)) occupied.add(String(door));
  return occupied;
}

export function getTrailersByStatus(status) {
  const trailers = store.get('trailers') || {};
  return Object.entries(trailers)
    .filter(([, t]) => t.status === status)
    .map(([id, t]) => ({ id, ...t }));
}

export function getActiveTrailers() {
  const trailers = store.get('trailers') || {};
  const INACTIVE = new Set(['Departed', '']);
  return Object.entries(trailers)
    .filter(([, t]) => !INACTIVE.has(t.status))
    .map(([id, t]) => ({ id, ...t }));
}
