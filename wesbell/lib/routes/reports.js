'use strict';
const { Router } = require('express');
const { run, get, all, db } = require('../db');
const path = require('path');
const fs   = require('fs');
const { requireXHR, ipOf } = require('../middleware');
const { requireRole, requireDriverAccess } = require('../auth');
const { audit, logEvent } = require('../helpers');
const { broadcastPush } = require('../push');
const { APP_VERSION, DB_FILE } = require('../config');

const router  = Router();
const MAX_PHOTO_BYTES = 4 * 1024 * 1024;

// ── Issue reports ─────────────────────────────────────────────────────────────
router.post('/api/report-issue', requireXHR, async (req, res) => {
  const s = require('../auth').getSession(req);
  const actorRole = s?.role || 'driver';
  try {
    const trailer   = String(req.body.trailer  || '').trim().toUpperCase();
    const door      = String(req.body.door     || '').trim();
    const note      = String(req.body.note     || '').trim().slice(0, 500);
    const photoData = req.body.photo_data ? String(req.body.photo_data) : null;
    const photoMime = req.body.photo_mime ? String(req.body.photo_mime).slice(0, 32) : null;
    if (!trailer) return res.status(400).send('Missing trailer');
    if (note && /<script/i.test(note)) return res.status(400).send('Invalid note content');
    if (photoData) {
      if (!photoMime || !photoMime.startsWith('image/')) return res.status(400).send('Invalid photo MIME type');
      if (photoData.length * 0.75 > MAX_PHOTO_BYTES) return res.status(413).send('Photo too large (max 4 MB)');
    }
    const at = Date.now();
    const result = await run(
      `INSERT INTO issue_reports(at,trailer,door,note,photo_data,photo_mime,ip,"userAgent") VALUES(?,?,?,?,?,?,?,?)`,
      [at, trailer, door, note, photoData || null, photoMime || null, ipOf(req), req.headers['user-agent'] || '']
    );
    await audit(req, actorRole, 'issue_reported', 'trailer', trailer,
      { door, hasPhoto: !!photoData, note: note.slice(0, 80) });
    broadcastPush('⚠️ Issue Report',
      `Trailer ${trailer}${door ? ' at door ' + door : ''}${note ? ': ' + note.slice(0, 60) : ''}`,
      { trailer, door }
    ).catch(() => {});
    res.json({ ok: true, id: result.lastID });
  } catch { res.status(500).send('Report failed'); }
});

router.get('/api/issue-reports', requireRole(['dispatcher', 'management', 'admin']), async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(200, Number(req.query.limit || 50)));
    const rows  = await all(
      `SELECT id,at,trailer,door,note,photo_mime,ip,(CASE WHEN photo_data IS NOT NULL THEN 1 ELSE 0 END) as has_photo
       FROM issue_reports ORDER BY at DESC LIMIT ?`,
      [limit]
    );
    res.json(rows);
  } catch { res.status(500).send('Fetch failed'); }
});

router.get('/api/issue-reports/:id/photo', requireRole(['dispatcher', 'management', 'admin']), async (req, res) => {
  try {
    const row = await get(`SELECT photo_data,photo_mime FROM issue_reports WHERE id=?`, [req.params.id]);
    if (!row || !row.photo_data) return res.status(404).send('No photo');
    res.setHeader('Content-Type', row.photo_mime || 'image/jpeg');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.send(Buffer.from(row.photo_data, 'base64'));
  } catch { res.status(500).send('Fetch failed'); }
});

// ── Audit ─────────────────────────────────────────────────────────────────────
router.get('/api/audit', requireRole(['dispatcher', 'management', 'admin']), async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(500, Number(req.query.limit || 200)));
    const rows  = await all(
      `SELECT at,"actorRole",action,"entityType","entityId",details,ip,"userAgent" FROM audit ORDER BY at DESC LIMIT ?`,
      [limit]
    );
    res.json(rows.map(r => {
      let details = {}; try { details = r.details ? JSON.parse(r.details) : {}; } catch {}
      return { ...r, details };
    }));
  } catch { res.status(500).send('Audit failed'); }
});

// ── CSV exports ────────────────────────────────────────────────────────────────
router.get('/api/export/trailers.csv', requireRole(['dispatcher', 'management', 'admin']), async (req, res) => {
  try {
    const rows    = await all(`SELECT * FROM trailers ORDER BY "updatedAt" DESC`);
    const headers = ['trailer', 'direction', 'status', 'door', 'note', 'dropType', 'carrierType', 'updatedAt', 'doorAt', 'omwAt', 'omwEta'];
    const fmt     = v => v == null ? '' : String(v).replace(/"/g, '""');
    const csv     = [headers.join(','), ...rows.map(r => headers.map(h => `"${fmt(r[h])}"`).join(','))].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="trailers-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
  } catch { res.status(500).send('Export failed'); }
});

router.get('/api/export/audit.csv', requireRole(['management', 'admin']), async (req, res) => {
  try {
    const hours = parseInt(req.query.hours) || 24;
    const rows  = await all(`SELECT * FROM audit WHERE at > ? ORDER BY at DESC`, [Date.now() - hours * 3_600_000]);
    const headers = ['id', 'at', 'actorRole', 'action', 'entityType', 'entityId', 'details', 'ip'];
    const fmt     = v => v == null ? '' : String(v).replace(/"/g, '""');
    const csv     = [headers.join(','), ...rows.map(r => headers.map(h => `"${fmt(r[h])}"`).join(','))].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="audit-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
  } catch { res.status(500).send('Export failed'); }
});

// ── Server logs ────────────────────────────────────────────────────────────────
router.get('/api/logs', requireRole(['admin']), async (req, res) => {
  try { res.json(await all(`SELECT * FROM logs ORDER BY at DESC LIMIT 200`)); } catch { res.status(500).send('Failed'); }
});

// ── Health ────────────────────────────────────────────────────────────────────
router.get('/health', async (req, res) => {
  try {
    await get('SELECT 1');
    const mem = process.memoryUsage();
    const { wss } = require('../ws');
    res.json({
      status: 'ok', version: APP_VERSION, uptime: Math.floor(process.uptime()),
      db: DB_FILE,
      memory: { rss: Math.round(mem.rss / 1024 / 1024) + 'MB', heap: Math.round(mem.heapUsed / 1024 / 1024) + 'MB' },
      wsClients: wss?.clients?.size || 0,
      sessions: require('../auth').sessions.size,
    });
  } catch (e) { res.status(503).json({ status: 'error', error: e.message }); }
});

module.exports = router;
