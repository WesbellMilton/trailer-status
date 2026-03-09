'use strict';
const { Router } = require('express');
const {
  getSession, newSession, setSessionCookie, clearSessionCookie,
  verifyPin, sessions,
} = require('../auth');
const { requireXHR, checkLoginRate, ipOf } = require('../middleware');
const { audit } = require('../helpers');
const { APP_VERSION, ROLE_HOME } = require('../config');

const router = Router();

router.get('/api/whoami', async (req, res) => {
  const s = getSession(req);
  const role = s?.role || null;
  const locationId = s?.locationId || 1;
  const freeRoam = !role || role === 'admin' || role === 'management';
  // Include door range for the session's location so clients don't hardcode 28–42
  let doorsFrom = 28, doorsTo = 42;
  try {
    const { get: dbGet } = require('../db');
    const loc = await dbGet(`SELECT doors_from, doors_to FROM locations WHERE id=?`, [locationId]);
    if (loc) { doorsFrom = loc.doors_from; doorsTo = loc.doors_to; }
  } catch {}
  res.json({ role, locationId, doorsFrom, doorsTo, version: APP_VERSION, redirectTo: freeRoam ? null : (ROLE_HOME[role] || '/') });
});

router.post('/api/login', requireXHR, async (req, res) => {
  const ip = ipOf(req);
  if (!checkLoginRate(ip)) return res.status(429).send('Too many login attempts. Try again in a minute.');
  try {
    const role       = String(req.body.role || '').toLowerCase();
    const pin        = String(req.body.pin  || '');
    const locationId = parseInt(req.body.locationId) || 1;
    if (!['dispatcher', 'dock', 'management', 'admin'].includes(role))
      return res.status(400).send('Invalid role');
    if (pin.length < 4) return res.status(400).send('PIN too short');
    // Validate location exists
    const { get: dbGet } = require('../db');
    const loc = await dbGet(`SELECT id FROM locations WHERE id=? AND active=1`, [locationId]);
    if (!loc) return res.status(400).send('Invalid location');
    const ok = await verifyPin(role, pin);
    await audit(req, role, ok ? 'login_success' : 'login_failed', 'auth', role, { locationId });
    if (!ok) return res.status(401).send('Invalid PIN');
    const existing = getSession(req);
    if (existing?.sid) sessions.delete(existing.sid);
    const sid = newSession(role, locationId);
    setSessionCookie(res, sid);
    res.json({ ok: true, role, locationId, version: APP_VERSION });
  } catch { res.status(500).send('Login error'); }
});

router.post('/api/logout', requireXHR, (req, res) => {
  const s = getSession(req);
  if (s?.sid) sessions.delete(s.sid);
  clearSessionCookie(res);
  res.json({ ok: true });
});

module.exports = router;
