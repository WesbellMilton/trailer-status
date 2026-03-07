'use strict';
const { Router } = require('express');
const { all, get } = require('../db');
const { requireXHR } = require('../middleware');
const { requireRole, sessions, setPin } = require('../auth');
const { audit, logEvent } = require('../helpers');
const { wsBroadcast } = require('../ws');
const { GEOFENCE_ZONES } = require('../geofence');

const router = Router();

// ── Shift notes ───────────────────────────────────────────────────────────────
let _shiftNote = { text: '', setAt: 0, setBy: '' };
// Restore from DB on startup
(async () => {
  try {
    const r = await get(`SELECT message,context,at FROM logs WHERE context='shift_note' ORDER BY at DESC LIMIT 1`);
    if (r) _shiftNote = { text: r.message || '', setAt: r.at || 0, setBy: '' };
  } catch {}
})();

router.get('/api/shift-note', (req, res) => {
  res.json({ text: _shiftNote.text, setAt: _shiftNote.setAt, setBy: _shiftNote.setBy });
});

router.post('/api/shift-note', requireXHR, requireRole(['dispatcher', 'management', 'admin']), async (req, res) => {
  const actor = req.user?.role || 'unknown';
  const text  = String(req.body.text || '').trim().slice(0, 500);
  if (text && /<script/i.test(text)) return res.status(400).send('Invalid note content');
  _shiftNote = { text, setAt: Date.now(), setBy: actor };
  await logEvent('info', 'shift_note', text, actor);
  await audit(req, actor, 'shift_note_set', 'system', 'shift', { text: text.slice(0, 80) });
  wsBroadcast('shift_note', { text, setAt: _shiftNote.setAt, setBy: actor });
  res.json({ ok: true });
});

// ── Shift summary ─────────────────────────────────────────────────────────────
router.get('/api/shift-summary', requireRole(['dispatcher', 'management', 'admin']), async (req, res) => {
  try {
    const hours  = parseInt(req.query.hours) || 12;
    const since  = Date.now() - hours * 3_600_000;
    const events = await all(`SELECT * FROM audit WHERE at > ? ORDER BY at DESC LIMIT 500`, [since]);
    const trailerRows = await all(`SELECT * FROM trailers`);
    const active  = trailerRows.filter(r => !['Departed', ''].includes(r.status || ''));
    const byStatus = {};
    events.filter(e => e.action === 'trailer_status_set').forEach(e => {
      try { const dd = JSON.parse(e.details || '{}'); byStatus[dd.status] = (byStatus[dd.status] || 0) + 1; } catch {}
    });
    const issues = await all(`SELECT id,at,trailer,door,note FROM issue_reports WHERE at > ? ORDER BY at DESC`, [since]);
    // Geofence events in window
    const geoEvents = await all(`SELECT * FROM geofence_events WHERE at > ? ORDER BY at DESC LIMIT 200`, [since]).catch(() => []);
    res.json({
      hours, since,
      active: active.length, departed: trailerRows.filter(r => r.status === 'Departed').length, total: trailerRows.length,
      byStatus, issues: issues.length, confirmations: events.filter(e => e.action === 'safety_confirmed').length,
      omw: events.filter(e => e.action === 'omw').length, arrivals: events.filter(e => e.action === 'arrive').length,
      geofenceArrivals: geoEvents.filter(e => e.event === 'enter' && e.zone === 'depot').length,
      issueList: issues,
      recentEvents: events.slice(0, 60).map(e => ({
        at: e.at, action: e.action, actor: e.actorRole, entity: e.entityId,
        details: (() => { try { return JSON.parse(e.details || '{}'); } catch { return {}; } })(),
      })),
    });
  } catch (e) { console.error('[shift-summary]', e); res.status(500).send('Failed'); }
});

// ── PIN management ────────────────────────────────────────────────────────────
router.post('/api/management/set-pin', requireXHR, requireRole(['management', 'admin']), async (req, res) => {
  const actor = req.user?.role || 'unknown';
  try {
    const role = String(req.body.role || '').toLowerCase();
    const pin  = String(req.body.pin  || '');
    if (!['dispatcher', 'dock', 'management', 'admin'].includes(role)) return res.status(400).send('Invalid role');
    if (role === 'admin' && actor !== 'admin') return res.status(403).send('Only admin can change the admin PIN');
    if (pin.length < 4) return res.status(400).send('PIN too short');
    await setPin(role, pin);
    for (const [sid, s] of sessions.entries()) if (s.role === role) sessions.delete(sid);
    await audit(req, actor, 'pin_changed', 'auth', role, {});
    res.json({ ok: true });
  } catch { res.status(500).send('Set PIN failed'); }
});

// ── Geofence zones (read-only — configure via env) ────────────────────────────
router.get('/api/geofence/zones', requireRole(['dispatcher', 'management', 'admin']), (req, res) => {
  res.json(GEOFENCE_ZONES.map(z => ({
    id: z.id, label: z.label, lat: z.lat, lng: z.lng,
    radiusKm: z.radiusKm, hasPolygon: z.polygon.length > 0, autoAction: z.autoAction,
  })));
});

// ── Geofence events log ───────────────────────────────────────────────────────
router.get('/api/geofence/events', requireRole(['dispatcher', 'management', 'admin']), async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(500, Number(req.query.limit || 100)));
    const rows  = await all(`SELECT * FROM geofence_events ORDER BY at DESC LIMIT ?`, [limit]);
    res.json(rows);
  } catch { res.status(500).send('Geofence events failed'); }
});

module.exports = router;
