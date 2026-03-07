'use strict';
const { Router } = require('express');
const { all, get, run } = require('../db');
const { requireXHR } = require('../middleware');
const { requireRole, sessions, setPin } = require('../auth');
const { audit, logEvent } = require('../helpers');
const { wsBroadcast } = require('../ws');
const { GEOFENCE_ZONES } = require('../geofence');

const router = Router();

// ── Locations ─────────────────────────────────────────────────────────────────

// GET all locations
router.get('/api/admin/locations', requireRole(['admin']), async (req, res) => {
  try {
    const locs = await all(`SELECT * FROM locations ORDER BY id ASC`);
    res.json(locs);
  } catch { res.status(500).send('Failed'); }
});

// POST create location
router.post('/api/admin/locations', requireXHR, requireRole(['admin']), async (req, res) => {
  try {
    const name       = String(req.body.name       || '').trim().slice(0, 80);
    const slug       = String(req.body.slug       || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40);
    const doors_from = parseInt(req.body.doors_from) || 28;
    const doors_to   = parseInt(req.body.doors_to)   || 42;
    const timezone   = String(req.body.timezone   || 'America/Toronto').trim().slice(0, 60);
    if (!name || !slug) return res.status(400).send('Name and slug required');
    if (doors_from >= doors_to) return res.status(400).send('Invalid door range');
    const existing = await get(`SELECT id FROM locations WHERE slug=?`, [slug]);
    if (existing) return res.status(409).send('Slug already in use');
    const r = await run(
      `INSERT INTO locations(name,slug,doors_from,doors_to,timezone,active,createdAt) VALUES(?,?,?,?,?,1,?)`,
      [name, slug, doors_from, doors_to, timezone, Date.now()]
    );
    const newId = r.lastID;
    // Seed dockplates for new location
    for (let d = doors_from; d <= doors_to; d++) {
      await run(`INSERT OR IGNORE INTO dockplates(door,status,note,updatedAt,location_id) VALUES(?,?,?,?,?)`,
        [String(d), 'Unknown', '', Date.now(), newId]);
    }
    await audit(req, 'admin', 'location_create', 'location', slug, { name, slug, doors_from, doors_to });
    res.json({ ok: true, id: newId });
  } catch (e) { console.error('[location create]', e); res.status(500).send('Failed'); }
});

// PATCH update location
router.patch('/api/admin/locations/:id', requireXHR, requireRole(['admin']), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).send('Invalid id');
    const existing = await get(`SELECT * FROM locations WHERE id=?`, [id]);
    if (!existing) return res.status(404).send('Not found');
    const name     = String(req.body.name     || existing.name).trim().slice(0, 80);
    const timezone = String(req.body.timezone || existing.timezone).trim().slice(0, 60);
    const active   = req.body.active !== undefined ? (req.body.active ? 1 : 0) : existing.active;
    await run(`UPDATE locations SET name=?,timezone=?,active=? WHERE id=?`, [name, timezone, active, id]);
    await audit(req, 'admin', 'location_update', 'location', existing.slug, { name, timezone, active });
    res.json({ ok: true });
  } catch { res.status(500).send('Failed'); }
});

// GET cross-location board overview (admin only)
router.get('/api/admin/overview', requireRole(['admin']), async (req, res) => {
  try {
    const locs = await all(`SELECT * FROM locations WHERE active=1 ORDER BY id ASC`);
    const result = await Promise.all(locs.map(async loc => {
      const trailers = await all(`SELECT status FROM trailers WHERE location_id=?`, [loc.id]);
      const byStatus = {};
      trailers.forEach(t => { byStatus[t.status] = (byStatus[t.status] || 0) + 1; });
      const issues = await all(`SELECT COUNT(*) as cnt FROM issue_reports WHERE location_id=? AND at > ?`,
        [loc.id, Date.now() - 24 * 3_600_000]);
      return {
        id: loc.id, name: loc.name, slug: loc.slug, timezone: loc.timezone,
        total: trailers.length, byStatus, openIssues: issues[0]?.cnt || 0,
      };
    }));
    res.json(result);
  } catch { res.status(500).send('Failed'); }
});

// GET audit log (cross-location for admin, location-scoped for others)
router.get('/api/audit', requireRole(['dispatcher', 'management', 'admin']), async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(500, Number(req.query.limit || 200)));
    const locationId = req.user.role === 'admin' && req.query.locationId
      ? Number(req.query.locationId) : req.user.locationId;
    const rows = req.user.role === 'admin' && !req.query.locationId
      ? await all(`SELECT * FROM audit ORDER BY at DESC LIMIT ?`, [limit])
      : await all(`SELECT * FROM audit WHERE location_id=? ORDER BY at DESC LIMIT ?`, [locationId, limit]);
    res.json(rows);
  } catch { res.status(500).send('Audit failed'); }
});


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
    const sumLocId = req.user?.role === 'admin' ? null : (req.user?.locationId || null);
    const events = await all(
      sumLocId
        ? `SELECT * FROM audit WHERE location_id=? AND at > ? ORDER BY at DESC LIMIT 500`
        : `SELECT * FROM audit WHERE at > ? ORDER BY at DESC LIMIT 500`,
      sumLocId ? [sumLocId, since] : [since]
    );
    const trailerRows = await all(
      sumLocId ? `SELECT * FROM trailers WHERE location_id=?` : `SELECT * FROM trailers`,
      sumLocId ? [sumLocId] : []
    );
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

// Public: resolve location slug → id (used by driver QR code)
router.get('/api/locations/by-slug/:slug', async (req, res) => {
  try {
    const slug = String(req.params.slug || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
    const loc = await get(`SELECT id, name, slug, doors_from, doors_to FROM locations WHERE slug=? AND active=1`, [slug]);
    if (!loc) return res.status(404).json({ error: 'Location not found' });
    res.json(loc);
  } catch { res.status(500).send('Failed'); }
});

// Public: depot coordinates for driver geolocation ETA calculation
router.get('/api/depot-coords', (req, res) => {
  const { GEOFENCE_ZONES } = require('../geofence');
  const depot = GEOFENCE_ZONES.find(z => z.id === 'depot');
  if (!depot) return res.json({ lat: 43.5048, lng: -79.8880 });
  res.json({ lat: depot.lat, lng: depot.lng });
});

module.exports = router;
