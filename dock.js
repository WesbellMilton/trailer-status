'use strict';
const { Router } = require('express');
const { run } = require('../db');
const { loadDoorBlocksObject, loadDockPlatesObject } = require('../cache');
const { requireXHR } = require('../middleware');
const { requireRole } = require('../auth');
const { audit }  = require('../helpers');
const { broadcastBlocks, broadcastPlates } = require('../ws');

const router = Router();

router.get('/api/doorblocks', async (req, res) => {
  try {
    const { getSession } = require('../auth');
    const s = getSession(req);
    res.json(await loadDoorBlocksObject(s?.locationId || null));
  } catch { res.status(500).send('Doorblocks error'); }
});

router.post('/api/doorblock/set', requireXHR, requireRole(['dock', 'dispatcher', 'management', 'admin']), async (req, res) => {
  try {
    const door = String(req.body.door || '');
    const note = String(req.body.note || '').slice(0, 120);
    if (!door || isNaN(parseInt(door)) || parseInt(door) < 28 || parseInt(door) > 42)
      return res.status(400).send('Invalid door');
    const dbLocId = req.user?.locationId || 1;
    await run(`INSERT INTO doorblocks(door,note,setAt,location_id) VALUES(?,?,?,?)
               ON CONFLICT(door) DO UPDATE SET note=excluded.note,setAt=excluded.setAt`,
      [door, note, Date.now(), dbLocId]);
    await audit(req, req.user?.role || 'unknown', 'doorblock_set', 'doorblock', door, { note });
    await broadcastBlocks();
    res.json({ ok: true });
  } catch { res.status(500).send('Doorblock set failed'); }
});

router.post('/api/doorblock/clear', requireXHR, requireRole(['dock', 'dispatcher', 'management', 'admin']), async (req, res) => {
  try {
    const door = String(req.body.door || '');
    if (!door) return res.status(400).send('Missing door');
    await run(`DELETE FROM doorblocks WHERE door=?`, [door]);
    await audit(req, req.user?.role || 'unknown', 'doorblock_clear', 'doorblock', door, {});
    await broadcastBlocks();
    res.json({ ok: true });
  } catch { res.status(500).send('Doorblock clear failed'); }
});

router.get('/api/dockplates', async (req, res) => {
  try {
    const { getSession } = require('../auth');
    const s = getSession(req);
    res.json(await loadDockPlatesObject(s?.locationId || null));
  } catch { res.status(500).send('Plates error'); }
});

router.post('/api/dockplates/set', requireXHR, requireRole(['dock', 'dispatcher', 'management', 'admin']), async (req, res) => {
  try {
    const actor  = req.user?.role || 'unknown';
    const door   = String(req.body.door   || '').trim();
    const status = String(req.body.status || 'Unknown').trim();
    const note   = String(req.body.note   || '').trim();
    const dNum   = Number(door);
    if (!Number.isFinite(dNum) || dNum < 28 || dNum > 42) return res.status(400).send('Invalid door');
    if (!['OK', 'Service', 'Out of Order', 'Unknown'].includes(status)) return res.status(400).send('Invalid plate status');
    const dpLocId = req.user?.locationId || 1;
    await run(`INSERT INTO dockplates(door,status,note,updatedAt,location_id) VALUES(?,?,?,?,?)
               ON CONFLICT(door) DO UPDATE SET status=excluded.status,note=excluded.note,updatedAt=excluded.updatedAt`,
      [door, status, note, Date.now(), dpLocId]);
    await audit(req, actor, 'plate_set', 'dockplate', door, { status, note });
    await broadcastPlates();
    res.json({ ok: true });
  } catch { res.status(500).send('Dock plate set failed'); }
});

module.exports = router;
