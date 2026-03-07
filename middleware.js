'use strict';
const zlib = require('zlib');
const { LOGIN_RATE_MAX, DRIVER_RATE_MAX } = require('./config');

// ── IP helper ─────────────────────────────────────────────────────────────────
const ipOf = req => {
  const xf = req.headers['x-forwarded-for'];
  return xf ? String(xf).split(',')[0].trim() : (req.socket.remoteAddress || '');
};

// ── Rate limiter factory ──────────────────────────────────────────────────────
function makeRateLimiter(maxPerMin) {
  const attempts = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [ip, e] of attempts) if (now > e.resetAt) attempts.delete(ip);
  }, 120_000).unref();

  return function check(ip) {
    const now = Date.now();
    let e = attempts.get(ip);
    if (!e || now > e.resetAt) { e = { count: 0, resetAt: now + 60_000 }; attempts.set(ip, e); }
    return ++e.count <= maxPerMin;
  };
}

const checkLoginRate  = makeRateLimiter(LOGIN_RATE_MAX);
const checkDriverRate = makeRateLimiter(DRIVER_RATE_MAX);

function requireDriverRate(req, res, next) {
  if (!checkDriverRate(ipOf(req)))
    return res.status(429).send('Too many requests. Try again in a minute.');
  next();
}

// ── requireXHR ────────────────────────────────────────────────────────────────
function requireXHR(req, res, next) {
  if ((req.get('X-Requested-With') || '').toLowerCase() !== 'xmlhttprequest')
    return res.status(400).send('Bad request');
  next();
}

// ── Request timeout (30 s) ────────────────────────────────────────────────────
function requestTimeout(req, res, next) {
  const t = setTimeout(() => {
    if (!res.headersSent) res.status(503).send('Request timeout');
  }, 30_000);
  res.on('finish', () => clearTimeout(t));
  res.on('close',  () => clearTimeout(t));
  next();
}

// ── Gzip ──────────────────────────────────────────────────────────────────────
function gzip(req, res, next) {
  const ae = req.headers['accept-encoding'] || '';
  if (!ae.includes('gzip')) return next();
  const orig = res.json.bind(res);
  res.json = data => {
    const buf = Buffer.from(JSON.stringify(data));
    if (buf.length < 1024) return orig(data);
    zlib.gzip(buf, (err, compressed) => {
      if (err) return orig(data);
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Vary', 'Accept-Encoding');
      res.end(compressed);
    });
  };
  next();
}

// ── Security headers (CSP, XFO, etc.) ─────────────────────────────────────────
function securityHeaders(req, res, next) {
  res.removeHeader('X-Powered-By');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(self),camera=(self)');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net; " +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://fonts.gstatic.com; " +
    "font-src 'self' https://fonts.gstatic.com; " +
    "img-src 'self' data: blob:; " +
    "connect-src 'self' wss: ws:; " +
    "worker-src 'self'; " +
    "frame-ancestors 'none';"
  );
  next();
}

module.exports = {
  ipOf,
  checkLoginRate, checkDriverRate,
  requireDriverRate, requireXHR,
  requestTimeout, gzip, securityHeaders,
};
