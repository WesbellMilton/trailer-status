'use strict';
const { Router } = require('express');
const { run, get, all } = require('../db');
const { audit }                = require('../helpers');
const { broadcastTrailers, wsBroadcast } = require('../ws');
const { broadcastPush }        = require('../push');
const { pickBestDoor, reserveDoor, releaseReservation } = require('../doors');
const { processLocation }      = require('../geofence');
const { fireWebhook }          = require('../helpers');

const { requireXHR, requireDriverRate } = require('../middleware');
const { requireDriverAccess } = require('../auth');

const router = Router();

// ── /api/driver/omw ───────────────────────────────────────────────────────────
router.post('/api/driver/omw', requireXHR, requireDriverRate, async (req, res) => {
  try {
    const trailer = String(req.body.trailer || '').trim().toUpperCase();
    const eta     = parseInt(req.body.eta) || null;
    if (!trailer)           return res.status(400).send('Missing trailer number');
    if (trailer.length > 20) return res.status(400).send('Trailer number too long');

    const existing = await get(`SELECT * FROM trailers WHERE trailer=?`, [trailer]);
    const ACTIVE   = ['Incoming', 'Dropped', 'Loading', 'Dock Ready', 'Ready'];
    if (existing && ACTIVE.includes(existing.status))
      return res.json({ ok: true, door: existing.door || '', alreadyActive: true, status: existing.status });

    const assignedDoor = await pickBestDoor(trailer);
    if (!assignedDoor) return res.status(409).send('No doors available right now. Please ask dispatch.');
    await reserveDoor(assignedDoor, trailer, 'Wesbell');

    const note = eta ? `ETA ~${eta} min` : 'On my way';
    const now  = Date.now();
    await run(
      `INSERT INTO trailers(trailer,direction,status,door,note,dropType,carrierType,updatedAt,omwAt,omwEta)
       VALUES(?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(trailer) DO UPDATE SET
         direction=excluded.direction,status=excluded.status,door=excluded.door,
         note=excluded.note,dropType=excluded.dropType,carrierType=excluded.carrierType,
         updatedAt=excluded.updatedAt,omwAt=excluded.omwAt,omwEta=excluded.omwEta`,
      [trailer, 'Inbound', 'Incoming', assignedDoor, note, 'Loaded', 'Wesbell', now, now, eta]
    );
    await audit(req, 'driver', 'omw', 'trailer', trailer, { door: assignedDoor, eta });
    await broadcastTrailers();
    broadcastPush('🚛 Driver On My Way', `Trailer ${trailer} → Door ${assignedDoor}${eta ? ` · ETA ~${eta} min` : ''}`,
      { type: 'omw', trailer, door: assignedDoor }).catch(() => {});
    wsBroadcast('omw', { trailer, door: assignedDoor, eta, at: now });
    fireWebhook('driver.omw', { trailer, door: assignedDoor, eta });
    res.json({ ok: true, door: assignedDoor, alreadyActive: false });
  } catch (e) { console.error('[omw]', e); res.status(500).send('OMW failed'); }
});

// ── /api/driver/assignment ────────────────────────────────────────────────────
router.get('/api/driver/assignment', async (req, res) => {
  try {
    const trailer = String(req.query.trailer || '').trim().toUpperCase();
    if (!trailer) return res.status(400).send('Missing trailer');
    const row = await get(`SELECT door,direction,status,dropType FROM trailers WHERE trailer=?`, [trailer]);
    if (!row) return res.json({ found: false });
    if (!['Incoming', 'Dropped', 'Loading', 'Dock Ready', 'Ready'].includes(row.status))
      return res.json({ found: false });
    res.json({ found: true, door: row.door || '', direction: row.direction || '', status: row.status || '', dropType: row.dropType || '' });
  } catch { res.status(500).send('Lookup failed'); }
});

// ── /api/available-doors ──────────────────────────────────────────────────────
router.get('/api/available-doors', async (req, res) => {
  try {
    const { getOccupiedDoorSet } = require('../doors');
    const excludeTrailer = String(req.query.trailer || '').trim().toUpperCase() || null;
    const occupiedSet    = await getOccupiedDoorSet(excludeTrailer);
    const plates         = await all(`SELECT door,status FROM dockplates`);
    const plateMap       = {};
    plates.forEach(p => { plateMap[String(p.door)] = p.status; });
    const doors = [];
    for (let d = 28; d <= 42; d++) {
      const ds = String(d), ps = plateMap[ds] || 'Unknown';
      if (ps === 'Out of Order') continue;
      doors.push({ door: ds, available: !occupiedSet.has(ds), plateStatus: ps });
    }
    res.json({ doors });
  } catch { res.status(500).send('Available doors error'); }
});

// ── /api/driver/arrive ────────────────────────────────────────────────────────
router.post('/api/driver/arrive', requireXHR, requireDriverRate, async (req, res) => {
  try {
    const trailer     = String(req.body.trailer     || '').trim().toUpperCase();
    const carrierType = String(req.body.carrierType || 'Outside').trim();
    const dropType    = String(req.body.dropType    || 'Loaded').trim();
    const direction   = String(req.body.direction   || 'Inbound').trim();
    if (!trailer)           return res.status(400).send('Missing trailer number');
    if (trailer.length > 20) return res.status(400).send('Trailer number too long');

    const existing = await get(`SELECT * FROM trailers WHERE trailer=?`, [trailer]);
    const ACTIVE   = ['Incoming', 'Dropped', 'Loading', 'Dock Ready', 'Ready'];
    if (existing && ACTIVE.includes(existing.status) && existing.door) {
      await releaseReservation(trailer);
      return res.json({ ok: true, door: existing.door, alreadyActive: true, status: existing.status });
    }

    const assignedDoor = await pickBestDoor(trailer);
    if (!assignedDoor) return res.status(409).send('No doors available. Please ask dispatch.');
    await reserveDoor(assignedDoor, trailer, carrierType);

    const now         = Date.now();
    const useDropType = existing?.dropType || dropType;
    const useDirection = existing?.direction || direction;
    await run(
      `INSERT INTO trailers(trailer,direction,status,door,note,dropType,carrierType,updatedAt,doorAt)
       VALUES(?,?,?,?,?,?,?,?,?)
       ON CONFLICT(trailer) DO UPDATE SET
         direction=excluded.direction,status=excluded.status,door=excluded.door,
         dropType=excluded.dropType,carrierType=excluded.carrierType,
         updatedAt=excluded.updatedAt,doorAt=excluded.doorAt`,
      [trailer, useDirection, 'Incoming', assignedDoor, existing?.note || '', useDropType, carrierType, now, now]
    );
    await releaseReservation(trailer);
    await audit(req, 'driver', 'arrive', 'trailer', trailer, { door: assignedDoor, carrierType });
    broadcastPush('✅ Driver Arrived', `Trailer ${trailer} at Door ${assignedDoor}`, { type: 'arrive', trailer, door: assignedDoor });
    wsBroadcast('arrive', { trailer, door: assignedDoor, at: now });
    fireWebhook('driver.arrived', { trailer, door: assignedDoor });
    await broadcastTrailers();
    res.json({ ok: true, door: assignedDoor, alreadyActive: false });
  } catch (e) { console.error('[arrive]', e); res.status(500).send('Arrival failed'); }
});

// ── /api/driver/drop ──────────────────────────────────────────────────────────
router.post('/api/driver/drop', requireXHR, requireDriverRate, requireDriverAccess, async (req, res) => {
  try {
    const trailer     = String(req.body.trailer     || '').trim().toUpperCase();
    const door        = String(req.body.door        || '').trim();
    const dropType    = String(req.body.dropType    || 'Empty').trim();
    const carrierType = String(req.body.carrierType || 'Wesbell').trim();
    if (!trailer)           return res.status(400).send('Missing trailer');
    if (trailer.length > 20) return res.status(400).send('Trailer number too long');
    if (!/^[A-Z0-9\-_. ]+$/.test(trailer)) return res.status(400).send('Invalid trailer number');
    if (door) { const dNum = Number(door); if (!Number.isFinite(dNum) || dNum < 28 || dNum > 42) return res.status(400).send('Invalid door (28–42)'); }
    if (!['Empty', 'Loaded'].includes(dropType)) return res.status(400).send('Invalid drop type');

    const existing = await get(`SELECT * FROM trailers WHERE trailer=?`, [trailer]);
    const now = Date.now();
    const ACTIVE = ['Incoming', 'Dropped', 'Loading', 'Dock Ready', 'Ready'];
    if (existing && ACTIVE.includes(existing.status) && !req.body.force) {
      return res.status(409).json({
        duplicate: true, trailer, currentStatus: existing.status, currentDoor: existing.door || null,
        message: `Trailer ${trailer} is already on the board (${existing.status}${existing.door ? ' at door ' + existing.door : ''}). Submit again to overwrite.`,
      });
    }

    const dropStatus = door ? 'Incoming' : (carrierType === 'Outside' ? 'Dropped' : 'Incoming');
    await run(
      `INSERT INTO trailers(trailer,direction,status,door,note,dropType,carrierType,updatedAt)
       VALUES(?,?,?,?,?,?,?,?)
       ON CONFLICT(trailer) DO UPDATE SET
         direction=excluded.direction,status=excluded.status,door=excluded.door,
         dropType=excluded.dropType,carrierType=excluded.carrierType,updatedAt=excluded.updatedAt`,
      [trailer, existing?.direction || 'Inbound', dropStatus, door || '', existing?.note || '', dropType, carrierType, now]
    );
    await releaseReservation(trailer);
    await audit(req, 'driver', 'driver_drop', 'trailer', trailer, { door: door || '', dropType, carrierType });
    if (dropStatus === 'Dropped')
      broadcastPush('📦 Outside Carrier Drop', `Trailer ${trailer} dropped to yard — needs door assignment`, { trailer }).catch(() => {});
    await broadcastTrailers();
    res.json({ ok: true, door: door || null });
  } catch { res.status(500).send('Drop failed'); }
});

// ── /api/crossdock/pickup ─────────────────────────────────────────────────────
router.post('/api/crossdock/pickup', requireXHR, requireDriverRate, requireDriverAccess, async (req, res) => {
  try {
    const trailer = String(req.body.trailer || '').trim().toUpperCase();
    const door    = String(req.body.door    || '').trim();
    if (!trailer)            return res.status(400).send('Missing trailer');
    if (trailer.length > 20) return res.status(400).send('Trailer number too long');
    if (!/^[A-Z0-9\-_. ]+$/.test(trailer)) return res.status(400).send('Invalid trailer number');
    const dNum = Number(door);
    if (!Number.isFinite(dNum) || dNum < 28 || dNum > 42) return res.status(400).send('Invalid door (28–42)');
    const existing = await get(`SELECT * FROM trailers WHERE trailer=?`, [trailer]);
    await run(
      `INSERT INTO trailers(trailer,direction,status,door,note,dropType,updatedAt)
       VALUES(?,?,?,?,?,?,?)
       ON CONFLICT(trailer) DO UPDATE SET door=excluded.door,updatedAt=excluded.updatedAt`,
      [trailer, existing?.direction || 'Cross Dock', existing?.status || 'Ready', door, existing?.note || '', existing?.dropType || '', Date.now()]
    );
    await audit(req, 'driver', 'crossdock_pickup', 'trailer', trailer, { door });
    await broadcastTrailers();
    res.json({ ok: true });
  } catch { res.status(500).send('Cross dock pickup failed'); }
});

// ── /api/crossdock/offload ────────────────────────────────────────────────────
router.post('/api/crossdock/offload', requireXHR, requireDriverRate, requireDriverAccess, async (req, res) => {
  try {
    const trailer = String(req.body.trailer || '').trim().toUpperCase();
    const door    = String(req.body.door    || '').trim();
    if (!trailer)            return res.status(400).send('Missing trailer');
    if (trailer.length > 20) return res.status(400).send('Trailer number too long');
    if (!/^[A-Z0-9\-_. ]+$/.test(trailer)) return res.status(400).send('Invalid trailer number');
    const dNum = Number(door);
    if (!Number.isFinite(dNum) || dNum < 28 || dNum > 42) return res.status(400).send('Invalid door (28–42)');
    const existing = await get(`SELECT * FROM trailers WHERE trailer=?`, [trailer]);
    const ACTIVE   = ['Incoming', 'Dropped', 'Loading', 'Dock Ready', 'Ready'];
    if (existing && ACTIVE.includes(existing.status) && existing.door && existing.door !== door && !req.body.force) {
      return res.status(409).json({
        duplicate: true, trailer, currentStatus: existing.status, currentDoor: existing.door,
        message: `Trailer ${trailer} is already active at door ${existing.door} (${existing.status}). Submit again to overwrite.`,
      });
    }
    await run(
      `INSERT INTO trailers(trailer,direction,status,door,note,dropType,updatedAt)
       VALUES(?,?,?,?,?,?,?)
       ON CONFLICT(trailer) DO UPDATE SET door=excluded.door,status=excluded.status,dropType=excluded.dropType,updatedAt=excluded.updatedAt`,
      [trailer, existing?.direction || 'Cross Dock', 'Dropped', door, existing?.note || '', 'Loaded', Date.now()]
    );
    await audit(req, 'driver', 'crossdock_offload', 'trailer', trailer, { door });
    await broadcastTrailers();
    res.json({ ok: true });
  } catch { res.status(500).send('Cross dock offload failed'); }
});

// ── /api/driver/location (GPS + geofencing) ────────────────────────────────────
router.post('/api/driver/location', requireXHR, requireDriverRate, async (req, res) => {
  try {
    const trailer = String(req.body.trailer || '').trim().toUpperCase();
    const lat     = parseFloat(req.body.lat);
    const lng     = parseFloat(req.body.lng);
    const eta     = req.body.eta != null ? parseInt(req.body.eta) : null;
    if (!trailer || !Number.isFinite(lat) || !Number.isFinite(lng))
      return res.status(400).send('Invalid payload');
    // Ontario bounding box guard
    if (lat < 41.5 || lat > 57 || lng < -96 || lng > -74)
      return res.status(400).send('Coordinates out of range');

    const row = await get(`SELECT status,door FROM trailers WHERE trailer=?`, [trailer]);
    if (!row || !['Incoming'].includes(row.status))
      return res.json({ ok: true, ignored: true });

    if (eta != null)
      await run(`UPDATE trailers SET omwEta=?,updatedAt=? WHERE trailer=? AND status='Incoming'`, [eta, Date.now(), trailer]);

    const { zones, eta: computedEta, autoTriggered } = await processLocation({ trailer, lat, lng, req });

    // If geofence says auto-arrive, fire the arrive logic
    if (autoTriggered && !row.door) {
      const { pickBestDoor, reserveDoor, releaseReservation } = require('../doors');
      const assignedDoor = await pickBestDoor(trailer);
      if (assignedDoor) {
        const now = Date.now();
        await reserveDoor(assignedDoor, trailer, 'Wesbell');
        await run(
          `UPDATE trailers SET door=?,status='Incoming',doorAt=?,updatedAt=? WHERE trailer=?`,
          [assignedDoor, now, now, trailer]
        );
        await releaseReservation(trailer);
        await audit(req, 'driver', 'geofence_arrive', 'trailer', trailer, { door: assignedDoor, zones });
        broadcastPush('📍 Driver Entered Yard', `Auto-assigned Door ${assignedDoor} to ${trailer}`,
          { type: 'geofence_arrive', trailer, door: assignedDoor }).catch(() => {});
        wsBroadcast('arrive', { trailer, door: assignedDoor, at: now, auto: true });
        await broadcastTrailers();
        return res.json({ ok: true, autoTriggered: true, door: assignedDoor, zones, eta: computedEta });
      }
    }

    res.json({ ok: true, autoTriggered: false, zones, eta: computedEta });
  } catch (e) { console.error('[location]', e); res.status(500).send('Location update failed'); }
});

// ── /api/driver/shunt ─────────────────────────────────────────────────────────
router.post('/api/driver/shunt', requireXHR, requireDriverRate, async (req, res) => {
  try {
    const trailer = String(req.body.trailer || '').trim().toUpperCase();
    const door    = String(req.body.door || req.body.newDoor || '').trim();
    if (!trailer) return res.status(400).send('Missing trailer');
    if (!door)    return res.status(400).send('Missing door');
    const dNum = Number(door);
    if (!Number.isFinite(dNum) || dNum < 28 || dNum > 42) return res.status(400).send('Invalid door (28–42)');
    const existing = await get(`SELECT door FROM trailers WHERE trailer=?`, [trailer]);
    await run(`UPDATE trailers SET door=?,status='Dropped',updatedAt=? WHERE trailer=?`, [door, Date.now(), trailer]);
    await audit(req, 'driver', 'trailer_shunt', 'trailer', trailer, { fromDoor: existing?.door || '—', toDoor: door });
    await broadcastTrailers();
    res.json({ ok: true, door });
  } catch (e) { console.error('[driver/shunt]', e); res.status(500).send('Shunt failed'); }
});

// ── /api/confirm-safety ────────────────────────────────────────────────────────
router.post('/api/confirm-safety', requireXHR, requireDriverAccess, async (req, res) => {
  try {
    const trailer     = String(req.body.trailer    || '').trim().toUpperCase();
    const door        = String(req.body.door       || '').trim();
    const loadSecured = !!req.body.loadSecured;
    const dockPlateUp = !!req.body.dockPlateUp;
    if (!loadSecured || !dockPlateUp) return res.status(400).send('Both confirmations required');
    const action = String(req.body.action || 'safety').trim();
    const at     = Date.now();
    if ((action === 'xdock_pickup' || action === 'xdock_offload' || action === 'depart') && trailer) {
      await run(`UPDATE trailers SET status='Departed',updatedAt=? WHERE trailer=?`, [at, trailer]);
      await releaseReservation(trailer);
      require('../cache').invalidateTrailers();
    }
    await run(
      `INSERT INTO confirmations(at,trailer,door,action,ip,userAgent) VALUES(?,?,?,?,?,?)`,
      [at, trailer || '', door || '', action, require('../middleware').ipOf(req), req.headers['user-agent'] || '']
    );
    await audit(req, 'driver', 'safety_confirmed', 'safety', trailer || '-',
      { trailer, door, action, loadSecured, dockPlateUp });
    await broadcastTrailers();
    await require('../ws').broadcastConfirmations();
    res.json({ ok: true });
  } catch { res.status(500).send('Confirm failed'); }
});

// ── /api/qr/scan — streamlined QR scan intake ────────────────────────────────
/**
 * Called when a QR code is scanned at a dock terminal or by a driver.
 * Payload: { trailer, door?, action, scannedBy? }
 * Supported actions: 'arrive', 'depart', 'status/<status>', 'door/<n>'
 */
router.post('/api/qr/scan', requireXHR, requireDriverRate, async (req, res) => {
  try {
    const trailer   = String(req.body.trailer   || '').trim().toUpperCase();
    const door      = String(req.body.door      || '').trim();
    const action    = String(req.body.action    || '').trim().toLowerCase();
    const scannedBy = String(req.body.scannedBy || 'driver').trim();

    if (!trailer) return res.status(400).send('Missing trailer');
    if (trailer.length > 20 || !/^[A-Z0-9\-_. ]+$/.test(trailer))
      return res.status(400).send('Invalid trailer number');

    const existing = await get(`SELECT * FROM trailers WHERE trailer=?`, [trailer]);
    const now      = Date.now();
    let result     = {};

    if (action === 'arrive') {
      // Replicate arrive logic inline to keep it atomic
      const ACTIVE = ['Incoming', 'Dropped', 'Loading', 'Dock Ready', 'Ready'];
      if (existing && ACTIVE.includes(existing.status) && existing.door) {
        result = { door: existing.door, alreadyActive: true };
      } else {
        const assignedDoor = await pickBestDoor(trailer);
        if (!assignedDoor) return res.status(409).send('No doors available.');
        await reserveDoor(assignedDoor, trailer, 'Wesbell');
        await run(
          `INSERT INTO trailers(trailer,direction,status,door,note,dropType,carrierType,updatedAt,doorAt)
           VALUES(?,?,?,?,?,?,?,?,?)
           ON CONFLICT(trailer) DO UPDATE SET
             direction=excluded.direction,status=excluded.status,door=excluded.door,
             carrierType=excluded.carrierType,updatedAt=excluded.updatedAt,doorAt=excluded.doorAt`,
          [trailer, existing?.direction || 'Inbound', 'Incoming', assignedDoor, existing?.note || '',
           existing?.dropType || 'Loaded', 'Wesbell', now, now]
        );
        await releaseReservation(trailer);
        await broadcastTrailers();
        result = { door: assignedDoor };
      }

    } else if (action === 'depart') {
      await run(`UPDATE trailers SET status='Departed',updatedAt=? WHERE trailer=?`, [now, trailer]);
      await releaseReservation(trailer);
      await broadcastTrailers();
      result = { departed: true };

    } else if (action.startsWith('status/')) {
      const newStatus = action.slice(7);
      const allowed   = ['Incoming', 'Dropped', 'Loading', 'Dock Ready', 'Ready', 'Departed'];
      if (!allowed.includes(newStatus)) return res.status(400).send('Invalid status');
      await run(`UPDATE trailers SET status=?,updatedAt=? WHERE trailer=?`, [newStatus, now, trailer]);
      await broadcastTrailers();
      result = { status: newStatus };

    } else if (action.startsWith('door/')) {
      const newDoor = action.slice(5);
      const dNum    = Number(newDoor);
      if (!Number.isFinite(dNum) || dNum < 28 || dNum > 42) return res.status(400).send('Invalid door');
      await run(`UPDATE trailers SET door=?,updatedAt=? WHERE trailer=?`, [newDoor, now, trailer]);
      await broadcastTrailers();
      result = { door: newDoor };

    } else {
      return res.status(400).send(`Unknown QR action: ${action}`);
    }

    // Log the scan
    await run(
      `INSERT INTO qr_scans(at,trailer,door,action,scannedBy,ip) VALUES(?,?,?,?,?,?)`,
      [now, trailer, result.door || door || '', action, scannedBy, require('../middleware').ipOf(req)]
    );
    await audit(req, scannedBy, `qr_${action}`, 'trailer', trailer, { ...result, door: result.door || door });

    res.json({ ok: true, trailer, ...result });
  } catch (e) { console.error('[qr/scan]', e); res.status(500).send('QR scan failed'); }
});

// ── /api/qr/generate — return QR data URL for a trailer/door action ──────────
router.get('/api/qr/generate', async (req, res) => {
  try {
    const trailer = String(req.query.trailer || '').trim().toUpperCase();
    const action  = String(req.query.action  || 'arrive').trim();
    const door    = String(req.query.door    || '').trim();
    if (!trailer) return res.status(400).send('Missing trailer');
    // Return a deep-link URL the client can encode as a QR code
    const params  = new URLSearchParams({ trailer, action });
    if (door) params.set('door', door);
    const url = `/driver?qr=1&${params.toString()}`;
    res.json({ url, trailer, action, door });
  } catch { res.status(500).send('QR generate failed'); }
});

module.exports = router;
