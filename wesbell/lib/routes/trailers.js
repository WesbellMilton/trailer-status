'use strict';
const { Router } = require('express');
const crypto = require('crypto');
const { run, get } = require('../db');
const { getTrailersCache, invalidateTrailers } = require('../cache');
const { requireXHR } = require('../middleware');
const { requireDockStatusAllowed: _rds, requireRole: _rr } = require('../auth');
const { audit, logEvent, fireWebhook } = require('../helpers');
const { broadcastTrailers, wsBroadcast } = require('../ws');
const { broadcastPush } = require('../push');

const router = Router();

router.get('/api/state', async (req, res) => {
  try {
    const data = await getTrailersCache();
    const etag = `"${crypto.createHash('md5').update(JSON.stringify(data)).digest('hex').slice(0, 8)}"`;
    if (req.headers['if-none-match'] === etag) return res.status(304).end();
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'no-cache');
    res.json(data);
  } catch { res.status(500).send('State error'); }
});

router.post('/api/upsert', requireXHR, _rds, async (req, res) => {
  const actor = req.user?.role || 'unknown';
  try {
    const trailer = String(req.body.trailer || '').trim().toUpperCase();
    if (!trailer)           return res.status(400).send('Missing trailer');
    if (trailer.length > 20) return res.status(400).send('Trailer number too long');
    if (!/^[A-Z0-9\-_. ]+$/.test(trailer)) return res.status(400).send('Invalid trailer number');

    const existing = await get(`SELECT * FROM trailers WHERE trailer=?`, [trailer]);
    const now = Date.now();
    const direction   = req.body.direction   !== undefined ? String(req.body.direction   || '').trim() : (existing?.direction   || '');
    const status      = req.body.status      !== undefined ? String(req.body.status      || '').trim() : (existing?.status      || '');
    const door        = req.body.door        !== undefined ? String(req.body.door        || '').trim() : (existing?.door        || '');
    const note        = req.body.note        !== undefined ? String(req.body.note        || '').trim().slice(0, 200) : (existing?.note || '');
    const dropType    = req.body.dropType    !== undefined ? String(req.body.dropType    || '').trim() : (existing?.dropType    || '');
    const carrierType = req.body.carrierType !== undefined ? String(req.body.carrierType || '').trim() : (existing?.carrierType || '');

    if (actor === 'dock') {
      const onlyStatus = req.body.status !== undefined &&
        req.body.direction === undefined && req.body.door === undefined &&
        req.body.note === undefined && req.body.dropType === undefined;
      if (!onlyStatus) return res.status(403).send('Dock can only update trailer status');
      if (!['Loading', 'Dock Ready'].includes(status)) return res.status(403).send('Dock can only set Loading or Dock Ready');
    }

    const isDriverDrop = req.body.flow === 'drop' && carrierType.toLowerCase() === 'wesbell';
    const finalStatus  = isDriverDrop ? 'Incoming' : status;
    const allowed = ['Incoming', 'Dropped', 'Loading', 'Dock Ready', 'Ready', 'Departed', ''];
    if (!allowed.includes(finalStatus)) return res.status(400).send('Invalid status');

    const doorAt = (door && door !== existing?.door) ? now : (existing?.doorAt || null);
    await run(
      `INSERT INTO trailers(trailer,direction,status,door,note,"dropType","carrierType","updatedAt","doorAt")
       VALUES(?,?,?,?,?,?,?,?,?)
       ON CONFLICT(trailer) DO UPDATE SET
         direction=excluded.direction,status=excluded.status,door=excluded.door,
         note=excluded.note,"dropType"=excluded."dropType","carrierType"=excluded."carrierType",
         "updatedAt"=excluded."updatedAt","doorAt"=COALESCE(trailers."doorAt",excluded."doorAt")`,
      [trailer, direction, finalStatus, door, note, dropType, carrierType, now, doorAt]
    );

    await audit(req, actor, existing ? 'trailer_update' : 'trailer_create', 'trailer', trailer,
      { direction, status: finalStatus, door, dropType, note });
    if (req.body.status !== undefined || isDriverDrop)
      await audit(req, actor, 'trailer_status_set', 'trailer', trailer, { status: finalStatus });

    if (finalStatus !== (existing?.status)) {
      if (finalStatus === 'Ready') {
        wsBroadcast('notify', { kind: 'ready', trailer, door: door || '' });
        broadcastPush('🟢 Trailer Ready', `Trailer ${trailer} is ready${door ? ' at door ' + door : ''}`, { trailer, door }).catch(() => {});
        fireWebhook('trailer.ready', { trailer, door, actor });
      } else if (finalStatus === 'Dock Ready') fireWebhook('trailer.dock_ready', { trailer, door, actor });
      else if (finalStatus === 'Departed')     fireWebhook('trailer.departed',   { trailer, door, actor });
      else if (finalStatus === 'Loading')      fireWebhook('trailer.loading',    { trailer, door, actor });
    }

    await logEvent('info', 'upsert', `${actor} set ${trailer} → ${finalStatus}`, `door=${door || '—'}`);
    await broadcastTrailers();
    res.json({ ok: true });
  } catch { res.status(500).send('Upsert failed'); }
});

router.post('/api/delete', requireXHR, _rr(['dispatcher', 'management', 'admin']), async (req, res) => {
  const actor = req.user?.role || 'unknown';
  try {
    const trailer = String(req.body.trailer || '').trim().toUpperCase();
    if (!trailer) return res.status(400).send('Missing trailer');
    await run(`DELETE FROM trailers WHERE trailer=?`, [trailer]);
    await audit(req, actor, 'trailer_delete', 'trailer', trailer, {});
    await broadcastTrailers();
    res.json({ ok: true });
  } catch { res.status(500).send('Delete failed'); }
});

router.post('/api/clear', requireXHR, _rr(['dispatcher', 'management', 'admin']), async (req, res) => {
  const actor = req.user?.role || 'unknown';
  try {
    await run(`DELETE FROM trailers`);
    await audit(req, actor, 'trailer_clear_all', 'trailer', '*', {});
    await broadcastTrailers();
    res.json({ ok: true });
  } catch { res.status(500).send('Clear failed'); }
});

// Shunt (authenticated staff)
router.post('/api/shunt', requireXHR, async (req, res) => {
  try {
    const { getSession } = require('../auth');
    const session = getSession(req);
    if (!session) return res.status(401).send('Unauthorized');
    const actor = session.role;
    if (!['dispatcher', 'dock', 'management', 'admin'].includes(actor))
      return res.status(403).send('Unauthorized');
    const trailer = String(req.body.trailer || '').trim().toUpperCase();
    const door    = String(req.body.door    || '').trim();
    if (!trailer) return res.status(400).send('Missing trailer');
    if (!door)    return res.status(400).send('Missing door');
    const dNum = Number(door);
    if (!Number.isFinite(dNum) || dNum < 28 || dNum > 42) return res.status(400).send('Invalid door (28–42)');
    const existing = await get(`SELECT * FROM trailers WHERE trailer=?`, [trailer]);
    if (!existing) return res.status(404).send('Trailer not found');
    await run(`UPDATE trailers SET door=?,status='Dropped',"updatedAt"=? WHERE trailer=?`, [door, Date.now(), trailer]);
    await audit(req, actor, 'trailer_shunt', 'trailer', trailer, { fromDoor: existing.door || '—', toDoor: door });
    await broadcastTrailers();
    res.json({ ok: true, door });
  } catch { res.status(500).send('Shunt failed'); }
});

// Load status board
router.get('/api/load-status', _rr(['dispatcher', 'management', 'admin', 'dock']), async (req, res) => {
  try {
    const { all } = require('../db');
    const rows = await all(`SELECT * FROM trailers WHERE status NOT IN ('Departed','') ORDER BY "updatedAt" DESC`);
    const result = await Promise.all(rows.map(async r => {
      const lastChange = await get(
        `SELECT at FROM audit WHERE entityId=? AND action='trailer_status_set' ORDER BY at DESC LIMIT 1`,
        [r.trailer]
      );
      return {
        trailer: r.trailer, status: r.status, door: r.door || '', direction: r.direction || '',
        dropType: r.dropType || '', carrierType: r.carrierType || '',
        updatedAt: r.updatedAt, doorAt: r.doorAt || null, omwAt: r.omwAt || null, omwEta: r.omwEta || null,
        statusSince: lastChange?.at || r.updatedAt,
        timeInStatusMs: Date.now() - (lastChange?.at || r.updatedAt),
      };
    }));
    res.json(result);
  } catch (e) { console.error('[load-status]', e); res.status(500).send('Load status failed'); }
});

// Status history
router.get('/api/status-history/:trailer', async (req, res) => {
  try {
    const { all } = require('../db');
    const trailer = String(req.params.trailer || '').trim().toUpperCase();
    if (!trailer) return res.status(400).send('Missing trailer');
    const events = await all(
      `SELECT at,actorRole,action,details FROM audit
       WHERE entityId=? AND (action='trailer_status_set' OR action='trailer_create' OR action='trailer_update'
         OR action='omw' OR action='arrive' OR action='driver_drop' OR action='crossdock_pickup'
         OR action='crossdock_offload' OR action='trailer_shunt' OR action='safety_confirmed')
       ORDER BY at ASC`,
      [trailer]
    );
    const current = await get(`SELECT * FROM trailers WHERE trailer=?`, [trailer]);
    const timeline = [];
    let lastStatus = null;
    for (const e of events) {
      let details = {}; try { details = e.details ? JSON.parse(e.details) : {}; } catch {}
      const sts  = details.status || null;
      const door = details.door || details.toDoor || null;
      if (sts && sts === lastStatus) continue;
      if (sts) lastStatus = sts;
      timeline.push({ at: e.at, action: e.action, actorRole: e.actorRole, status: sts, door, details });
    }
    const withDurations = timeline.map((e, i) => ({
      ...e,
      durationMs: i < timeline.length - 1 ? timeline[i + 1].at - e.at : Date.now() - e.at,
    }));
    res.json({ trailer, current: current || null, timeline: withDurations });
  } catch (err) { console.error('[status-history]', err); res.status(500).send('History failed'); }
});

module.exports = router;
