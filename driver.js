'use strict';
const { Router } = require('express');
const { run, get, all } = require('../db');
const { audit }                = require('../helpers');
const { broadcastTrailers, wsBroadcast } = require('../ws');
const { broadcastPush }        = require('../push');
const { pickBestDoor, reserveDoor, releaseReservation, extendReservation } = require('../doors');
const { processLocation }      = require('../geofence');
const { fireWebhook }          = require('../helpers');

const { requireXHR, requireDriverRate } = require('../middleware');
const { requireDriverAccess } = require('../auth');

const router = Router();

// ── /api/driver/eta  (pre-fetch road ETA before OMW submit) ──────────────────
router.get('/api/driver/eta', requireDriverRate, async (req, res) => {
  try {
    const lat = parseFloat(req.query.lat);
    const lng = parseFloat(req.query.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng))
      return res.status(400).send('Invalid coordinates');
    if (lat < 41.5 || lat > 57 || lng < -96 || lng > -74)
      return res.status(400).send('Coordinates out of range');
    const { getEtaMinutes, haversineKm, GEOFENCE_ZONES } = require('../geofence');
    const depot = GEOFENCE_ZONES.find(z => z.id === 'depot');
    if (!depot) return res.status(500).send('No depot configured');
    const eta        = await getEtaMinutes(lat, lng, depot);
    const distanceKm = haversineKm(lat, lng, depot.lat, depot.lng);
    res.json({ ok: true, eta, distanceKm: Math.round(distanceKm * 10) / 10 });
  } catch (e) { console.error('[driver/eta]', e); res.status(500).send('ETA failed'); }
});

// ── /api/driver/omw ───────────────────────────────────────────────────────────
router.post('/api/driver/omw', requireXHR, requireDriverRate, async (req, res) => {
  try {
    const trailer = String(req.body.trailer || '').trim().toUpperCase();
    if (!trailer)            return res.status(400).send('Missing trailer number');
    if (trailer.length > 20) return res.status(400).send('Trailer number too long');

    // Accept GPS position for road-accurate ETA at booking time
    const lat = req.body.lat != null ? parseFloat(req.body.lat) : null;
    const lng = req.body.lng != null ? parseFloat(req.body.lng) : null;
    const hasGps = Number.isFinite(lat) && Number.isFinite(lng)
      && lat >= 41.5 && lat <= 57 && lng >= -96 && lng <= -74;

    // Compute road ETA if GPS provided, otherwise fall back to client hint or default
    let eta = parseInt(req.body.eta) || null;
    if (hasGps) {
      try {
        const { getEtaMinutes, GEOFENCE_ZONES } = require('../geofence');
        const depot = GEOFENCE_ZONES.find(z => z.id === 'depot');
        if (depot) eta = await getEtaMinutes(lat, lng, depot);
      } catch { /* keep client eta */ }
    }

    const existing = await get(`SELECT * FROM trailers WHERE trailer=?`, [trailer]);
    const ACTIVE   = ['Incoming', 'Dropped', 'Loading', 'Dock Ready', 'Ready'];
    if (existing && ACTIVE.includes(existing.status))
      return res.json({ ok: true, door: existing.door || '', alreadyActive: true, status: existing.status });

    const locId = req.user?.locationId || 1;
    const assignedDoor = await pickBestDoor(trailer, locId);
    if (!assignedDoor) return res.status(409).send('No doors available right now. Please ask dispatch.');
    // Hold door for ETA + 5 min grace (minimum 35 min if no ETA given)
    const holdMinutes  = eta ? eta + 5 : 35;
    await reserveDoor(assignedDoor, trailer, 'Wesbell', holdMinutes, locId);

    const note = eta ? `ETA ~${eta} min` : 'On my way';
    const now  = Date.now();
    await run(
      `INSERT INTO trailers(trailer,direction,status,door,note,dropType,carrierType,updatedAt,omwAt,omwEta,location_id)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(trailer) DO UPDATE SET
         direction=excluded.direction,status=excluded.status,door=excluded.door,
         note=excluded.note,dropType=excluded.dropType,carrierType=excluded.carrierType,
         updatedAt=excluded.updatedAt,omwAt=excluded.omwAt,omwEta=excluded.omwEta`,
      [trailer, 'Inbound', 'Incoming', assignedDoor, note, 'Loaded', 'Wesbell', now, now, eta, req.user?.locationId || 1]
    );
    await audit(req, 'driver', 'omw', 'trailer', trailer, { door: assignedDoor, eta });
    await broadcastTrailers(req.user?.locationId || 1);
    broadcastPush('🚛 Driver On My Way', `Trailer ${trailer} → Door ${assignedDoor}${eta ? ` · ETA ~${eta} min` : ''}`,
      { type: 'omw', trailer, door: assignedDoor }).catch(() => {});
    wsBroadcast('omw', { trailer, door: assignedDoor, eta, at: now });
    fireWebhook('driver.omw', { trailer, door: assignedDoor, eta });
    res.json({ ok: true, door: assignedDoor, alreadyActive: false, eta });
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
    const { getSession } = require('../auth');
    const { get: dbGet } = require('../db');
    const s = getSession(req);
    const locationId = s?.locationId || Number(req.query.locationId || 1);
    const excludeTrailer = String(req.query.trailer || '').trim().toUpperCase() || null;
    const occupiedSet    = await getOccupiedDoorSet(excludeTrailer, locationId);
    const plates         = await require('../db').all(`SELECT door,status FROM dockplates WHERE location_id=?`, [locationId]);
    const plateMap       = {};
    plates.forEach(p => { plateMap[String(p.door)] = p.status; });
    const loc = await dbGet(`SELECT doors_from,doors_to FROM locations WHERE id=?`, [locationId]).catch(() => null);
    const from = loc?.doors_from ?? 28;
    const to   = loc?.doors_to   ?? 42;
    const doors = [];
    for (let d = from; d <= to; d++) {
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

    const locId = req.user?.locationId || 1;
    const assignedDoor = await pickBestDoor(trailer, locId);
    if (!assignedDoor) return res.status(409).send('No doors available. Please ask dispatch.');
    await reserveDoor(assignedDoor, trailer, carrierType, null, locId);

    const now         = Date.now();
    const useDropType = existing?.dropType || dropType;
    const useDirection = existing?.direction || direction;
    await run(
      `INSERT INTO trailers(trailer,direction,status,door,note,dropType,carrierType,updatedAt,doorAt,location_id)
       VALUES(?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(trailer) DO UPDATE SET
         direction=excluded.direction,status=excluded.status,door=excluded.door,
         dropType=excluded.dropType,carrierType=excluded.carrierType,
         updatedAt=excluded.updatedAt,doorAt=excluded.doorAt`,
      [trailer, useDirection, 'Incoming', assignedDoor, existing?.note || '', useDropType, carrierType, now, now, req.user?.locationId || 1]
    );
    await releaseReservation(trailer);
    await audit(req, 'driver', 'arrive', 'trailer', trailer, { door: assignedDoor, carrierType });
    broadcastPush('✅ Driver Arrived', `Trailer ${trailer} at Door ${assignedDoor}`, { type: 'arrive', trailer, door: assignedDoor }).catch(() => {});
    wsBroadcast('arrive', { trailer, door: assignedDoor, at: now });
    wsBroadcast('notify', { kind: 'arrive', trailer, door: assignedDoor });
    fireWebhook('driver.arrived', { trailer, door: assignedDoor });
    await broadcastTrailers(req.user?.locationId || 1);
    res.json({ ok: true, door: assignedDoor, alreadyActive: false });
  } catch (e) { console.error('[arrive]', e); res.status(500).send('Arrival failed'); }
});

// ── /api/driver/ext-drop  (outside carrier — no trailer number needed) ────────
router.post('/api/driver/ext-drop', requireXHR, requireDriverRate, async (req, res) => {
  try {
    const carrier = String(req.body.carrier || 'Other').trim();
    const prefix  = String(req.body.prefix  || 'EXT').trim().toUpperCase().slice(0, 4);
    const CARRIERS = ['Apex','Gardewine','Manitoulin','TForce','XPO','Other'];
    if (!CARRIERS.includes(carrier)) return res.status(400).send('Invalid carrier');

    // Generate ref code: PREFIX-YYYYMMDD-NN (NN = sequential count for today)
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const pattern = `${prefix}-${today}-%`;
    const existing = await get(
      `SELECT COUNT(*) as cnt FROM trailers WHERE trailer LIKE ?`, [pattern]
    );
    const seq = String((existing?.cnt || 0) + 1).padStart(2, '0');
    const refCode = `${prefix}-${today}-${seq}`;

    const now  = Date.now();
    const extLocId = req.user?.locationId || 1;
    const door = await pickBestDoor(refCode, extLocId) || '';
    if (door) await reserveDoor(door, refCode, carrier, 35, extLocId);

    const status = door ? 'Incoming' : 'Dropped';
    await run(
      `INSERT INTO trailers(trailer,direction,status,door,note,dropType,carrierType,updatedAt,location_id)
       VALUES(?,?,?,?,?,?,?,?,?)
       ON CONFLICT(trailer) DO UPDATE SET
         status=excluded.status,door=excluded.door,
         carrierType=excluded.carrierType,updatedAt=excluded.updatedAt`,
      [refCode, 'Inbound', status, door, '', 'Loaded', carrier, now, req.user?.locationId || 1]
    );
    await audit(req, 'driver', 'ext_drop', 'trailer', refCode, { carrier, door, refCode });

    if (door) {
      broadcastPush(`📦 ${carrier} Drop`, `${refCode} → Door ${door} (auto-assigned)`, { trailer: refCode, door }).catch(() => {});
      wsBroadcast('notify', { kind: 'drop', trailer: refCode, door, carrierType: carrier, autoAssigned: true });
    } else {
      broadcastPush(`📦 ${carrier} Drop`, `${refCode} dropped — needs door assignment`, { trailer: refCode }).catch(() => {});
      wsBroadcast('notify', { kind: 'drop', trailer: refCode, door: '', carrierType: carrier, autoAssigned: false });
    }

    await broadcastTrailers(req.user?.locationId || 1);
    res.json({ ok: true, refCode, door, carrier });
  } catch (e) { console.error('[ext-drop]', e); res.status(500).send('Drop failed'); }
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

    // Auto-assign door for loaded outside carrier drops (same as OMW)
    // Empty drops go to Dropped — nothing to load yet, no door needed
    let assignedDoor = door || '';
    const needsAutoAssign = !door && carrierType === 'Outside' && dropType === 'Loaded';
    const dropLocId = req.user?.locationId || 1;
    if (needsAutoAssign) {
      assignedDoor = await pickBestDoor(trailer, dropLocId) || '';
      if (assignedDoor) await reserveDoor(assignedDoor, trailer, 'Outside', 35, dropLocId);
    }

    const dropStatus = assignedDoor ? 'Incoming' : (carrierType === 'Outside' ? 'Dropped' : 'Incoming');
    await run(
      `INSERT INTO trailers(trailer,direction,status,door,note,dropType,carrierType,updatedAt,location_id)
       VALUES(?,?,?,?,?,?,?,?,?)
       ON CONFLICT(trailer) DO UPDATE SET
         direction=excluded.direction,status=excluded.status,door=excluded.door,
         dropType=excluded.dropType,carrierType=excluded.carrierType,updatedAt=excluded.updatedAt`,
      [trailer, existing?.direction || 'Inbound', dropStatus, assignedDoor, existing?.note || '', dropType, carrierType, now, req.user?.locationId || 1]
    );
    await releaseReservation(trailer);
    await audit(req, 'driver', 'driver_drop', 'trailer', trailer, { door: assignedDoor, dropType, carrierType, autoAssigned: needsAutoAssign });
    if (needsAutoAssign && assignedDoor) {
      broadcastPush('📦 Outside Carrier Drop', `Trailer ${trailer} → Door ${assignedDoor} (auto-assigned)`, { trailer, door: assignedDoor }).catch(() => {});
      wsBroadcast('notify', { kind: 'drop', trailer, door: assignedDoor, carrierType, autoAssigned: true });
    } else if (dropStatus === 'Dropped') {
      broadcastPush('📦 Outside Carrier Drop', `Trailer ${trailer} dropped to yard — needs door assignment`, { trailer }).catch(() => {});
      wsBroadcast('notify', { kind: 'drop', trailer, door: '', carrierType, autoAssigned: false });
    }
    await broadcastTrailers(req.user?.locationId || 1);
    res.json({ ok: true, door: assignedDoor || null, autoAssigned: needsAutoAssign });
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
      `INSERT INTO trailers(trailer,direction,status,door,note,dropType,updatedAt,location_id)
       VALUES(?,?,?,?,?,?,?,?)
       ON CONFLICT(trailer) DO UPDATE SET door=excluded.door,updatedAt=excluded.updatedAt`,
      [trailer, existing?.direction || 'Cross Dock', existing?.status || 'Ready', door, existing?.note || '', existing?.dropType || '', Date.now(), req.user?.locationId || 1]
    );
    await audit(req, 'driver', 'crossdock_pickup', 'trailer', trailer, { door });
    await broadcastTrailers(req.user?.locationId || 1);
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
      `INSERT INTO trailers(trailer,direction,status,door,note,dropType,updatedAt,location_id)
       VALUES(?,?,?,?,?,?,?,?)
       ON CONFLICT(trailer) DO UPDATE SET door=excluded.door,status=excluded.status,dropType=excluded.dropType,updatedAt=excluded.updatedAt`,
      [trailer, existing?.direction || 'Cross Dock', 'Dropped', door, existing?.note || '', 'Loaded', Date.now(), req.user?.locationId || 1]
    );
    await audit(req, 'driver', 'crossdock_offload', 'trailer', trailer, { door });
    await broadcastTrailers(req.user?.locationId || 1);
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

    // Extend door reservation: ETA + 5 min grace, recomputed on every ping
    const liveEta = computedEta ?? eta;
    if (liveEta != null) {
      await extendReservation(trailer, liveEta).catch(() => {});
      // Also persist the computed ETA so dispatch board shows accurate value
      if (computedEta != null && computedEta !== eta)
        await run(`UPDATE trailers SET omwEta=?,updatedAt=? WHERE trailer=? AND status='Incoming'`, [computedEta, Date.now(), trailer]);
    }

    // If geofence says auto-arrive, fire the arrive logic
    if (autoTriggered && !row.door) {
      const { pickBestDoor, reserveDoor, releaseReservation } = require('../doors');
      const geoLocId = req.user?.locationId || 1;
      const assignedDoor = await pickBestDoor(trailer, geoLocId);
      if (assignedDoor) {
        const now = Date.now();
        await reserveDoor(assignedDoor, trailer, 'Wesbell', null, geoLocId);
        await run(
          `UPDATE trailers SET door=?,status='Incoming',doorAt=?,updatedAt=? WHERE trailer=?`,
          [assignedDoor, now, now, trailer]
        );
        await releaseReservation(trailer);
        await audit(req, 'driver', 'geofence_arrive', 'trailer', trailer, { door: assignedDoor, zones });
        broadcastPush('📍 Driver Entered Yard', `Auto-assigned Door ${assignedDoor} to ${trailer}`,
          { type: 'geofence_arrive', trailer, door: assignedDoor }).catch(() => {});
        wsBroadcast('arrive', { trailer, door: assignedDoor, at: now, auto: true });
        await broadcastTrailers(req.user?.locationId || 1);
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
    await broadcastTrailers(req.user?.locationId || 1);
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
      `INSERT INTO confirmations(at,trailer,door,action,ip,userAgent,location_id) VALUES(?,?,?,?,?,?,?)`,
      [at, trailer || '', door || '', action, require('../middleware').ipOf(req), req.headers['user-agent'] || '', req.user?.locationId || 1]
    );
    await audit(req, 'driver', 'safety_confirmed', 'safety', trailer || '-',
      { trailer, door, action, loadSecured, dockPlateUp });
    await broadcastTrailers(req.user?.locationId || 1);
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
        const qrLocId = req.user?.locationId || 1;
        const assignedDoor = await pickBestDoor(trailer, qrLocId);
        if (!assignedDoor) return res.status(409).send('No doors available.');
        await reserveDoor(assignedDoor, trailer, 'Wesbell', null, qrLocId);
        await run(
          `INSERT INTO trailers(trailer,direction,status,door,note,dropType,carrierType,updatedAt,doorAt,location_id)
           VALUES(?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(trailer) DO UPDATE SET
             direction=excluded.direction,status=excluded.status,door=excluded.door,
             carrierType=excluded.carrierType,updatedAt=excluded.updatedAt,doorAt=excluded.doorAt`,
          [trailer, existing?.direction || 'Inbound', 'Incoming', assignedDoor, existing?.note || '',
           existing?.dropType || 'Loaded', 'Wesbell', now, now, req.user?.locationId || 1]
        );
        await releaseReservation(trailer);
        await broadcastTrailers(req.user?.locationId || 1);
        result = { door: assignedDoor };
      }

    } else if (action === 'depart') {
      await run(`UPDATE trailers SET status='Departed',updatedAt=? WHERE trailer=?`, [now, trailer]);
      await releaseReservation(trailer);
      await broadcastTrailers(req.user?.locationId || 1);
      result = { departed: true };

    } else if (action.startsWith('status/')) {
      const newStatus = action.slice(7);
      const allowed   = ['Incoming', 'Dropped', 'Loading', 'Dock Ready', 'Ready', 'Departed'];
      if (!allowed.includes(newStatus)) return res.status(400).send('Invalid status');
      await run(`UPDATE trailers SET status=?,updatedAt=? WHERE trailer=?`, [newStatus, now, trailer]);
      await broadcastTrailers(req.user?.locationId || 1);
      result = { status: newStatus };

    } else if (action.startsWith('door/')) {
      const newDoor = action.slice(5);
      const dNum    = Number(newDoor);
      if (!Number.isFinite(dNum) || dNum < 28 || dNum > 42) return res.status(400).send('Invalid door');
      await run(`UPDATE trailers SET door=?,updatedAt=? WHERE trailer=?`, [newDoor, now, trailer]);
      await broadcastTrailers(req.user?.locationId || 1);
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
