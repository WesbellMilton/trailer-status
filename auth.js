'use strict';
const crypto = require('crypto');
const { run, get } = require('./db');
const { SESSION_TTL_MS, COOKIE_NAME, PIN_MIN_LEN, ROLE_HOME, IS_PROD } = require('./config');

// ── Session store ─────────────────────────────────────────────────────────────
const sessions = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [sid, s] of sessions) if (s.exp < now) sessions.delete(sid);
}, 30 * 60 * 1000).unref();

function newSession(role) {
  const sid = crypto.randomBytes(24).toString('hex');
  sessions.set(sid, { role, exp: Date.now() + SESSION_TTL_MS });
  return sid;
}

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i > -1) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

function getSession(req) {
  const sid = parseCookies(req)[COOKIE_NAME];
  if (!sid) return null;
  const s = sessions.get(sid);
  if (!s) return null;
  if (Date.now() > s.exp) { sessions.delete(sid); return null; }
  return { sid, ...s };
}

function setSessionCookie(res, sid) {
  res.setHeader('Set-Cookie',
    `${COOKIE_NAME}=${encodeURIComponent(sid)}; Path=/; HttpOnly; SameSite=Lax${IS_PROD ? '; Secure' : ''}`
  );
}
function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

// ── PIN hashing ───────────────────────────────────────────────────────────────
const genTempPin = () => String(crypto.randomInt(100_000, 1_000_000));

function pbkdf2Hash(pin, salt, iter = 140_000) {
  return new Promise((res, rej) =>
    crypto.pbkdf2(pin, salt, iter, 32, 'sha256', (e, d) => e ? rej(e) : res(d))
  );
}

async function setPin(role, pin) {
  const salt = crypto.randomBytes(16);
  const iter = 140_000;
  const hash = await pbkdf2Hash(pin, salt, iter);
  await run(
    `INSERT INTO pins(role,salt,hash,iter) VALUES(?,?,?,?)
     ON CONFLICT(role) DO UPDATE SET salt=excluded.salt,hash=excluded.hash,iter=excluded.iter`,
    [role, salt, hash, iter]
  );
}

async function verifyPin(role, pin) {
  const row = await get(`SELECT salt,hash,iter FROM pins WHERE role=?`, [role]);
  if (!row) return false;
  const candidate = await pbkdf2Hash(pin, row.salt, row.iter || 140_000);
  if (candidate.length !== row.hash.length) return false;
  return crypto.timingSafeEqual(candidate, row.hash);
}

// ── Middleware ────────────────────────────────────────────────────────────────
function requireRole(roles) {
  return (req, res, next) => {
    const s = getSession(req);
    if (!s) return res.status(401).send('Unauthorized');
    if (s.role !== 'admin' && !roles.includes(s.role)) return res.status(401).send('Unauthorized');
    req.user = { role: s.role };
    next();
  };
}

function requireDriverAccess(req, res, next) {
  const s = getSession(req);
  if (s?.role === 'dock') return res.status(403).send('Not accessible from dock role');
  next();
}

function requireDockStatusAllowed(req, res, next) {
  const s = getSession(req);
  if (!s) return res.status(401).send('Unauthorized');
  req.user = { role: s.role };
  if (['admin', 'dispatcher', 'management'].includes(s.role)) return next();
  if (s.role === 'dock') {
    const status = req.body?.status;
    if (status && !['Loading', 'Dock Ready'].includes(status))
      return res.status(403).send(`Dock role cannot set status: ${status}`);
    return next();
  }
  return res.status(403).send('Unauthorized');
}

function guardPage(allowedRoles) {
  return (req, res, next) => {
    const s    = getSession(req);
    const role = s?.role || null;
    if (!role) {
      return allowedRoles.includes('__driver__')
        ? next()
        : res.redirect(302, `/login?from=${encodeURIComponent(req.path)}`);
    }
    if (role === 'admin' || role === 'management' || role === 'dispatcher') return next();
    if (role === 'dock') return allowedRoles.includes('dock') ? next() : res.redirect(302, '/dock');
    return res.redirect(302, ROLE_HOME[role] || '/');
  };
}

module.exports = {
  sessions, newSession, getSession,
  setSessionCookie, clearSessionCookie,
  genTempPin, setPin, verifyPin,
  requireRole, requireDriverAccess, requireDockStatusAllowed, guardPage,
};
