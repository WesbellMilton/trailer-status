// server.js — Wesbell Dispatch v3.2.0
const express = require("express");
const http = require("http");
const path = require("path");
const WebSocket = require("ws");
const sqlite3 = require("sqlite3").verbose();
const crypto = require("crypto");

const app = express();
app.use(express.json({ limit: "6mb" }));
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const DB_FILE = process.env.DB_FILE || path.join(__dirname, "wesbell.sqlite");
const APP_VERSION = process.env.APP_VERSION || "3.2.0";
const PIN_MIN_LEN = 4;
const SESSION_TTL_MS = 1000 * 60 * 60 * 12;
const COOKIE_NAME = "wb_session";

const ENV_PINS = {
  dispatcher: process.env.DISPATCHER_PIN || "",
  dock:       process.env.DOCK_PIN       || "",
  management: process.env.MANAGEMENT_PIN || "",
  admin:      process.env.ADMIN_PIN      || "",
};

function requireXHR(req, res, next) {
  if ((req.get("X-Requested-With") || "").toLowerCase() !== "xmlhttprequest")
    return res.status(400).send("Bad request");
  next();
}

/* ══════════════════════════════════════════
   DB
══════════════════════════════════════════ */
const db = new sqlite3.Database(DB_FILE);
const run = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, function (e) { e ? rej(e) : res(this); }));
const get = (sql, p = []) => new Promise((res, rej) => db.get(sql, p, (e, r) => { e ? rej(e) : res(r); }));
const all = (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => { e ? rej(e) : res(r); }));

/* ══════════════════════════════════════════
   CACHES
══════════════════════════════════════════ */
let _trailersCache = null;
let _platesCache   = null;
function invalidateTrailers() { _trailersCache = null; }
function invalidatePlates()   { _platesCache   = null; }
async function getTrailersCache() { if (!_trailersCache) _trailersCache = await loadTrailersObject(); return _trailersCache; }
async function getPlatesCache()   { if (!_platesCache)   _platesCache   = await loadDockPlatesObject(); return _platesCache; }

/* ══════════════════════════════════════════
   VAPID / PUSH
══════════════════════════════════════════ */
const VAPID_FILE = process.env.VAPID_FILE || path.join(__dirname, "vapid.json");
let VAPID_KEYS = null;
const pushSubs = new Map();

function loadOrGenVapid() {
  const fs = require("fs");
  try {
    if (fs.existsSync(VAPID_FILE)) {
      VAPID_KEYS = JSON.parse(fs.readFileSync(VAPID_FILE, "utf8"));
      console.log("[VAPID] Loaded existing keys");
      return;
    }
  } catch {}
  try {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", {
      namedCurve: "P-256",
      publicKeyEncoding:  { type: "spki",  format: "der" },
      privateKeyEncoding: { type: "pkcs8", format: "der" },
    });
    const pubRaw = publicKey.slice(26);
    let privRaw;
    for (let i = 0; i < privateKey.length - 34; i++) {
      if (privateKey[i] === 0x04 && privateKey[i + 1] === 0x20) {
        privRaw = privateKey.slice(i + 2, i + 34);
        break;
      }
    }
    if (!privRaw) throw new Error("Could not extract private key bytes");
    VAPID_KEYS = {
      publicKey:  pubRaw.toString("base64url"),
      privateKey: privRaw.toString("base64url"),
    };
    fs.writeFileSync(VAPID_FILE, JSON.stringify(VAPID_KEYS));
    console.log("[VAPID] Generated new key pair");
  } catch (e) {
    console.error("[VAPID] Key generation failed:", e.message);
  }
}

const b64url    = buf => Buffer.isBuffer(buf) ? buf.toString("base64url") : Buffer.from(buf).toString("base64url");
const fromb64url = s  => Buffer.from(s, "base64url");

async function hkdf(salt, ikm, info, len) {
  const prk = crypto.createHmac("sha256", salt).update(ikm).digest();
  const t   = crypto.createHmac("sha256", prk).update(Buffer.concat([info, Buffer.alloc(1, 1)])).digest();
  return t.slice(0, len);
}

async function buildVapidJWT(audience) {
  const header  = b64url(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const now     = Math.floor(Date.now() / 1000);
  const payload = b64url(JSON.stringify({ aud: audience, exp: now + 12 * 3600, sub: "mailto:dispatch@wesbell.com" }));
  const sigInput = `${header}.${payload}`;
  const privBytes = fromb64url(VAPID_KEYS.privateKey);
  const privKey = crypto.createPrivateKey({
    key: Buffer.concat([
      Buffer.from("308187020100301306072a8648ce3d020106082a8648ce3d030107046d306b0201010420", "hex"),
      privBytes,
      Buffer.from("a144034200", "hex"),
      fromb64url(VAPID_KEYS.publicKey),
    ]),
    format: "der", type: "pkcs8",
  });
  const sig = crypto.sign(null, Buffer.from(sigInput), { key: privKey, dsaEncoding: "ieee-p1363" });
  return `${sigInput}.${b64url(sig)}`;
}

async function encryptPushPayload(plaintext, keys) {
  const serverKeys   = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const serverPubRaw = serverKeys.publicKey.export({ type: "spki", format: "der" }).slice(26);
  const clientPubRaw = fromb64url(keys.p256dh);
  const authSecret   = fromb64url(keys.auth);
  const clientPub = crypto.createPublicKey({
    key: Buffer.concat([
      Buffer.from("3059301306072a8648ce3d020106082a8648ce3d030107034200", "hex"),
      clientPubRaw,
    ]),
    format: "der", type: "spki",
  });
  const sharedSecret = crypto.diffieHellman({ privateKey: serverKeys.privateKey, publicKey: clientPub });
  const prk  = await hkdf(authSecret, sharedSecret, Buffer.concat([Buffer.from("WebPush: info\x00"), clientPubRaw, serverPubRaw]), 32);
  const salt = crypto.randomBytes(16);
  const cek  = await hkdf(salt, prk, Buffer.concat([Buffer.from("Content-Encoding: aes128gcm\x00"), Buffer.alloc(1, 1)]), 16);
  const nonce= await hkdf(salt, prk, Buffer.concat([Buffer.from("Content-Encoding: nonce\x00"),    Buffer.alloc(1, 1)]), 12);
  const cipher    = crypto.createCipheriv("aes-128-gcm", cek, nonce);
  const msg       = Buffer.concat([Buffer.from(plaintext), Buffer.alloc(1, 2)]);
  const encrypted = Buffer.concat([cipher.update(msg), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.alloc(1, serverPubRaw.length), serverPubRaw, encrypted]);
}

async function sendPush(subscription, payload) {
  const { endpoint, keys } = subscription;
  const url       = new URL(endpoint);
  const audience  = `${url.protocol}//${url.host}`;
  const jwt       = await buildVapidJWT(audience);
  const authHeader = `vapid t=${jwt},k=${VAPID_KEYS.publicKey}`;
  const encrypted  = await encryptPushPayload(payload, keys);
  const https = require("https");
  return new Promise((resolve, reject) => {
    const req = https.request(endpoint, {
      method: "POST",
      headers: {
        "Authorization":    authHeader,
        "Content-Type":     "application/octet-stream",
        "Content-Encoding": "aes128gcm",
        "TTL":              "86400",
        "Content-Length":   encrypted.length,
      },
    }, res => { res.resume(); resolve(res.statusCode); });
    req.on("error", reject);
    req.write(encrypted);
    req.end();
  });
}

async function broadcastPush(title, body, data) {
  if (!VAPID_KEYS || pushSubs.size === 0) return;
  const payload = JSON.stringify({ title, body, data: data || {} });
  const dead = [];
  for (const [endpoint, sub] of pushSubs) {
    try {
      const status = await sendPush(sub, payload);
      if (status === 410 || status === 404) dead.push(endpoint);
    } catch {}
  }
  if (dead.length) {
    dead.forEach(ep => pushSubs.delete(ep));
    const ph = dead.map(() => "?").join(",");
    await run(`DELETE FROM push_subscriptions WHERE endpoint IN (${ph})`, dead).catch(() => {});
  }
}

/* ══════════════════════════════════════════
   DB INIT
══════════════════════════════════════════ */
async function initDb() {
  await run(`CREATE TABLE IF NOT EXISTS trailers (
    trailer TEXT PRIMARY KEY, direction TEXT, status TEXT, door TEXT,
    note TEXT, dropType TEXT, carrierType TEXT DEFAULT '', updatedAt INTEGER
  )`);
  await run(`CREATE TABLE IF NOT EXISTS dockplates (
    door TEXT PRIMARY KEY, status TEXT, note TEXT, updatedAt INTEGER
  )`);
  await run(`CREATE TABLE IF NOT EXISTS confirmations (
    id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, trailer TEXT,
    door TEXT, action TEXT, ip TEXT, userAgent TEXT
  )`);
  await run(`CREATE TABLE IF NOT EXISTS audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, actorRole TEXT,
    action TEXT, entityType TEXT, entityId TEXT, details TEXT, ip TEXT, userAgent TEXT
  )`);
  await run(`CREATE TABLE IF NOT EXISTS push_subscriptions (
    endpoint TEXT PRIMARY KEY, subscription TEXT, createdAt INTEGER
  )`);
  await run(`CREATE TABLE IF NOT EXISTS issue_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, trailer TEXT,
    door TEXT, note TEXT, photo_data TEXT, photo_mime TEXT, ip TEXT, userAgent TEXT
  )`);
  await run(`CREATE TABLE IF NOT EXISTS pins (
    role TEXT PRIMARY KEY, salt BLOB, hash BLOB, iter INTEGER
  )`);

  // Migrations (safe to re-run)
  await run(`DELETE FROM dockplates WHERE CAST(door AS INTEGER) < 28`);
  try { await run(`ALTER TABLE confirmations ADD COLUMN action TEXT`); }      catch {}
  try { await run(`ALTER TABLE trailers ADD COLUMN carrierType TEXT DEFAULT ''`); } catch {}

  // Seed dock plate doors 28–42
  const existingPlates = new Set((await all(`SELECT door FROM dockplates`)).map(r => r.door));
  for (let d = 28; d <= 42; d++) {
    const door = String(d);
    if (!existingPlates.has(door))
      await run(`INSERT INTO dockplates(door,status,note,updatedAt) VALUES(?,?,?,?)`, [door, "Unknown", "", Date.now()]);
  }

  // Seed PINs
  for (const role of ["dispatcher", "dock", "management", "admin"]) {
    const row = await get(`SELECT role FROM pins WHERE role=?`, [role]);
    if (!row) {
      const pin = ENV_PINS[role] && ENV_PINS[role].length >= PIN_MIN_LEN ? ENV_PINS[role] : genTempPin();
      await setPin(role, pin);
      console.log(`[SECURITY] Initial ${role} PIN: ${pin}  ← change immediately`);
    }
  }
}

function genTempPin() { return String(crypto.randomInt(100000, 1000000)); }

function pbkdf2Hash(pin, salt, iter = 140000) {
  return new Promise((res, rej) =>
    crypto.pbkdf2(pin, salt, iter, 32, "sha256", (e, d) => e ? rej(e) : res(d))
  );
}

async function setPin(role, pin) {
  const salt = crypto.randomBytes(16), iter = 140000;
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
  const candidate = await pbkdf2Hash(pin, row.salt, row.iter || 140000);
  if (candidate.length !== row.hash.length) return false;
  return crypto.timingSafeEqual(candidate, row.hash);
}

/* ══════════════════════════════════════════
   SESSIONS
══════════════════════════════════════════ */
const sessions = new Map();
// Prune expired sessions every 30 minutes to prevent memory leak
setInterval(() => {
  const now = Date.now();
  for (const [sid, s] of sessions.entries()) if (s.exp < now) sessions.delete(sid);
}, 30 * 60 * 1000).unref();

function newSession(role) {
  const sid = crypto.randomBytes(24).toString("hex");
  sessions.set(sid, { role, exp: Date.now() + SESSION_TTL_MS });
  return sid;
}

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || "").split(";").forEach(p => {
    const i = p.indexOf("=");
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
  const secure = process.env.NODE_ENV === "production";
  res.setHeader("Set-Cookie",
    `${COOKIE_NAME}=${encodeURIComponent(sid)}; Path=/; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`
  );
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function requireRole(roles) {
  return (req, res, next) => {
    const s = getSession(req);
    if (!s) return res.status(401).send("Unauthorized");
    if (s.role !== "admin" && !roles.includes(s.role)) return res.status(401).send("Unauthorized");
    req.user = { role: s.role };
    next();
  };
}

// Driver endpoints — accessible without any session (personal phones, no login)
// But if a session IS present it must NOT be a dock or dispatcher (they shouldn't
// be submitting driver actions)
function requireDriverAccess(req, res, next) {
  const s = getSession(req);
  if (s && ["dock","dispatcher","management","admin"].includes(s.role)) {
    return res.status(403).send("Driver endpoint — not accessible from this role");
  }
  next();
}

// Issue reports can come from drivers (no session) OR dock/dispatcher/management/admin
function requireIssueAccess(req, res, next) {
  next();
}

// Dock workers can only advance status through dock-appropriate transitions.
// Dispatchers/admin can do anything. This prevents a dock worker from e.g.
// marking a trailer Ready or Departed by hitting the API directly.
function requireDockStatusAllowed(req, res, next) {
  const s = getSession(req);
  if (!s) return res.status(401).send("Unauthorized");
  req.user = { role: s.role }; // populate req.user so handlers can read actor role
  // Admin, dispatcher, and management have full status control
  if (["admin","dispatcher","management"].includes(s.role)) return next();
  if (s.role === "dock") {
    const status = req.body?.status;
    const DOCK_ALLOWED = ["Loading", "Dock Ready"]; // dock workers may only set these
    if (status && !DOCK_ALLOWED.includes(status)) {
      return res.status(403).send(`Dock role cannot set status: ${status}`);
    }
    return next();
  }
  return res.status(403).send("Unauthorized");
}

/* ══════════════════════════════════════════
   HELPERS
══════════════════════════════════════════ */
function ipOf(req) {
  const xf = req.headers["x-forwarded-for"];
  return xf ? String(xf).split(",")[0].trim() : req.socket.remoteAddress || "";
}

async function audit(req, actorRole, action, entityType, entityId, details) {
  let d = ""; try { d = JSON.stringify(details || {}); } catch {}
  await run(
    `INSERT INTO audit(at,actorRole,action,entityType,entityId,details,ip,userAgent) VALUES(?,?,?,?,?,?,?,?)`,
    [Date.now(), actorRole || "unknown", action, entityType, entityId, d, ipOf(req), req.headers["user-agent"] || ""]
  );
}

async function loadTrailersObject() {
  const rows = await all(`SELECT * FROM trailers`);
  const obj = {};
  for (const r of rows) {
    obj[r.trailer] = {
      direction:   r.direction   || "",
      status:      r.status      || "",
      door:        r.door        || "",
      note:        r.note        || "",
      dropType:    r.dropType    || "",
      carrierType: r.carrierType || "",
      updatedAt:   r.updatedAt   || 0,
    };
  }
  return obj;
}

async function loadDockPlatesObject() {
  const rows = await all(`SELECT * FROM dockplates ORDER BY CAST(door AS INTEGER) ASC`);
  const obj = {};
  for (const r of rows) obj[r.door] = { status: r.status || "Unknown", note: r.note || "", updatedAt: r.updatedAt || 0 };
  return obj;
}

async function loadConfirmations(limit = 250) {
  return all(`SELECT at,trailer,door,action,ip,userAgent FROM confirmations ORDER BY at DESC LIMIT ?`, [limit]);
}

/* ══════════════════════════════════════════
   WEBSOCKET
══════════════════════════════════════════ */
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

function wsBroadcast(type, payload) {
  const msg = JSON.stringify({ type, payload });
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      try { client.send(msg); } catch { /* stale socket */ }
    }
  }
}

async function broadcastTrailers() {
  try { invalidateTrailers(); wsBroadcast("state",         await getTrailersCache()); }
  catch(e) { console.error("[WS] broadcastTrailers:", e.message); }
}
async function broadcastPlates() {
  try { invalidatePlates();   wsBroadcast("dockplates",    await getPlatesCache()); }
  catch(e) { console.error("[WS] broadcastPlates:", e.message); }
}
async function broadcastConfirmations() {
  try {                       wsBroadcast("confirmations", await loadConfirmations(250)); }
  catch(e) { console.error("[WS] broadcastConfirmations:", e.message); }
}

/* ══════════════════════════════════════════
   STATIC / VIEWS
══════════════════════════════════════════ */
app.use(express.static(path.join(__dirname)));
// Serve ONLY image assets from project root (icons + splash screens)
// Uses an allowlist so server.js, .env, sqlite, etc. are never exposed
const ASSET_ALLOWLIST = /^\/(icon-[\w-]+\.png|apple-touch-icon\.png|favicon\.ico|splash\/splash-[\w-]+\.png)$/;
app.get(ASSET_ALLOWLIST, (req, res) => {
  const safePath = path.join(__dirname, req.path.replace(/\/\.\./g, ""));
  res.setHeader("Cache-Control", "public, max-age=604800, immutable");
  res.sendFile(safePath, err => { if (err && !res.headersSent) res.status(404).end(); });
});
app.get("/sw.js", (req, res) => {
  res.setHeader("Service-Worker-Allowed", "/");
  res.setHeader("Content-Type", "application/javascript");
  res.sendFile(path.join(__dirname, "sw.js"));
});

const INDEX_FILE = path.join(__dirname, "index.html");
const sendIndex  = (_, res) => res.sendFile(INDEX_FILE);

/* ── ROLE → ALLOWED PATHS ── */
const ROLE_HOME = {
  dispatcher: "/",
  admin:      "/",
  dock:       "/dock",
  management: "/management",
  // drivers have no session — they always land on /driver
};

// Returns the canonical home path for a role (or null for unauthenticated driver)
function roleHome(role) { return ROLE_HOME[role] || null; }

// Middleware: enforce that a logged-in role can only view their own page.
// Drivers (no session) are always allowed on /driver only.
function guardPage(allowedRoles) {
  return (req, res, next) => {
    const s = getSession(req);
    const role = s?.role || null;

    // No session — allow if page accepts unauthenticated (__driver__), otherwise login
    if (!role) {
      if (allowedRoles.includes("__driver__")) return next();
      return res.redirect(302, `/login?from=${encodeURIComponent(req.path)}`);
    }

    // Admin goes anywhere, no questions asked
    if (role === "admin") return next();

    // Management can go anywhere authenticated pages exist
    if (role === "management") return next();

    // Dispatcher can view board, dock, and driver pages
    if (role === "dispatcher") return next();

    // Dock workers locked to /dock and /driver only
    if (role === "dock") {
      if (allowedRoles.includes("dock")) return next();
      return res.redirect(302, "/dock");
    }

    // Any other authenticated role — send home
    const home = roleHome(role);
    return res.redirect(302, home || "/");
  };
}

app.get("/login", (req, res) => {
  const expired  = req.query.expired === "1";
  const fromPath = req.query.from || "";

  // Drivers never need login — send straight to /driver
  if (fromPath.includes("/driver")) return res.redirect(302, "/driver");

  // Already authenticated — bounce to their home page
  if (!expired) {
    const s = getSession(req);
    if (s?.role) return res.redirect(302, ROLE_HOME[s.role] || "/");
  }

  const isDock = fromPath.includes("/dock");
  const isSup  = fromPath.includes("/management");

  const roleOptions = isDock
    ? `<option value="dock" selected>Dock</option>`
    : isSup
    ? `<option value="management" selected>Management</option><option value="admin">&#9889; Admin</option>`
    : `<option value="dispatcher" selected>Dispatcher</option><option value="dock">Dock</option><option value="management">Management</option><option value="admin">&#9889; Admin</option>`;

  const contextBadge = isDock
    ? `<div class="ctx-badge ctx-dock">&#127981; Dock sign-in</div>`
    : isSup
    ? `<div class="ctx-badge ctx-mgmt">&#128202; Management sign-in</div>`
    : "";

  const expiredBanner = expired
    ? `<div class="ctx-badge ctx-err">&#9888; Session expired &#8212; please sign in again.</div>`
    : "";

  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover"/>
<title>Wesbell Dispatch</title>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=DM+Mono:wght@400;500&family=DM+Sans:wght@400;500;600&display=swap" rel="stylesheet"/>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#070a0f;--s0:#0c1018;--s1:#101620;--s2:#151e2a;
  --b0:#1a2535;--b1:#1f2e42;--b2:#263650;
  --t0:#e8eef8;--t1:#8a9db8;--t2:#4a5e78;--t3:#293848;
  --amber:#f0a030;--amber-d:#c07020;
  --cyan:#20c0d0;--green:#20d090;--red:#e84848;
  --mono:'DM Mono',monospace;--sans:'DM Sans',system-ui,sans-serif;--display:'Bebas Neue',sans-serif;
}
html{height:100%;-webkit-font-smoothing:antialiased}
body{min-height:100vh;background:var(--bg);color:var(--t0);font-family:var(--sans);display:grid;grid-template-columns:1fr 380px;overflow:hidden}
body::before{content:"";position:fixed;inset:0;z-index:0;pointer-events:none;background-image:url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.04'/%3E%3C/svg%3E");opacity:.5}
/* ── Dashboard ── */
.dashboard{position:relative;z-index:1;display:flex;flex-direction:column;padding:44px 52px 36px;background:linear-gradient(135deg,#070c14 0%,#0a1020 60%,#08111c 100%);border-right:1px solid var(--b0);overflow:hidden}
.dashboard::after{content:"";position:absolute;top:-80px;left:-80px;width:600px;height:600px;background:radial-gradient(ellipse at center,rgba(240,160,48,.055) 0%,transparent 70%);pointer-events:none}
.db-brand{display:flex;align-items:center;gap:12px;margin-bottom:44px;position:relative;z-index:1}
.db-mark{width:40px;height:40px;border-radius:10px;background:linear-gradient(135deg,var(--amber) 0%,var(--amber-d) 100%);display:flex;align-items:center;justify-content:center;font-family:var(--mono);font-size:15px;font-weight:700;color:#000;box-shadow:0 4px 16px rgba(240,120,0,.3);flex-shrink:0}
.db-name{font-family:var(--mono);font-size:13px;font-weight:600;letter-spacing:.1em;color:var(--t0)}
.db-sub{font-size:10px;color:var(--t2);letter-spacing:.08em;margin-top:1px}
.clock-wrap{position:relative;z-index:1;margin-bottom:8px}
.clock-time{font-family:var(--display);font-size:clamp(80px,9vw,130px);line-height:.9;color:var(--t0);letter-spacing:.01em;text-shadow:0 0 60px rgba(240,160,48,.12)}
.colon{color:var(--amber);animation:blink 1s step-start infinite}
@keyframes blink{0%,49%{opacity:1}50%,100%{opacity:.2}}
.clock-secs{font-size:.52em;color:var(--t2);margin-left:4px;vertical-align:baseline}
.clock-ampm{font-family:var(--mono);font-size:clamp(13px,1.5vw,20px);color:var(--amber);letter-spacing:.1em;margin-left:6px;vertical-align:super}
.date-row{display:flex;align-items:baseline;gap:12px;margin-bottom:36px;position:relative;z-index:1}
.date-day{font-family:var(--display);font-size:clamp(26px,3.5vw,42px);color:var(--t1);letter-spacing:.04em}
.date-full{font-family:var(--mono);font-size:clamp(11px,1vw,13px);color:var(--t2);letter-spacing:.06em;text-transform:uppercase}
.divider{height:1px;background:linear-gradient(90deg,var(--b1) 0%,transparent 100%);margin-bottom:32px;position:relative;z-index:1}
/* Weather */
.weather-block{display:flex;align-items:flex-start;gap:20px;margin-bottom:36px;position:relative;z-index:1;min-height:60px}
.weather-icon{font-size:48px;line-height:1;flex-shrink:0}
.weather-temp{font-family:var(--display);font-size:clamp(36px,4.5vw,56px);color:var(--t0);line-height:1}
.weather-unit{font-family:var(--mono);font-size:15px;color:var(--t2);vertical-align:super}
.weather-desc{font-family:var(--mono);font-size:11px;color:var(--t1);letter-spacing:.06em;text-transform:uppercase;margin-top:4px}
.weather-meta{display:flex;gap:14px;margin-top:7px}
.wm{font-family:var(--mono);font-size:11px;color:var(--t2)}
.wm span{color:var(--t1)}
.weather-msg{font-family:var(--mono);font-size:12px;color:var(--t3);letter-spacing:.04em;padding:8px 0}
/* Calendar */
.cal-wrap{flex:1;position:relative;z-index:1}
.cal-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px}
.cal-month{font-family:var(--display);font-size:clamp(20px,2.5vw,30px);color:var(--t1);letter-spacing:.06em}
.cal-year{font-family:var(--mono);font-size:12px;color:var(--t2);letter-spacing:.08em}
.cal-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:4px}
.cal-dow{font-family:var(--mono);font-size:9px;letter-spacing:.08em;color:var(--t3);text-align:center;padding:3px 0 7px;text-transform:uppercase}
.cal-cell{aspect-ratio:1;display:flex;align-items:center;justify-content:center;font-family:var(--mono);font-size:clamp(10px,1.1vw,12px);color:var(--t2);border-radius:5px}
.cal-cell.other{color:var(--t3)}
.cal-cell.today{background:var(--amber);color:#000;font-weight:700;box-shadow:0 2px 10px rgba(240,160,48,.35)}
/* Footer */
.db-footer{position:relative;z-index:1;display:flex;align-items:center;gap:8px;margin-top:20px;padding-top:14px;border-top:1px solid var(--b0)}
.live-dot{width:5px;height:5px;border-radius:50%;background:var(--green);box-shadow:0 0 6px var(--green);animation:beat 2.4s ease-in-out infinite}
@keyframes beat{0%,100%{box-shadow:0 0 0 0 rgba(32,208,144,.6)}50%{box-shadow:0 0 0 5px rgba(32,208,144,0)}}
.footer-txt{font-family:var(--mono);font-size:10px;color:var(--t2);letter-spacing:.06em}
/* ── Login Panel ── */
.login-panel{position:relative;z-index:1;display:flex;flex-direction:column;justify-content:center;padding:48px 40px;background:var(--s0);overflow-y:auto}
.lp-brand{display:flex;align-items:center;gap:10px;margin-bottom:40px}
.lp-mark{width:36px;height:36px;border-radius:9px;background:linear-gradient(135deg,var(--amber),var(--amber-d));display:flex;align-items:center;justify-content:center;font-family:var(--mono);font-size:13px;font-weight:700;color:#000;box-shadow:0 3px 12px rgba(240,120,0,.25);flex-shrink:0}
.lp-name{font-family:var(--mono);font-size:12px;font-weight:600;letter-spacing:.1em;color:var(--t1)}
.lp-sub2{font-size:9px;color:var(--t2);letter-spacing:.08em;margin-top:1px}
.lp-heading{font-family:var(--display);font-size:36px;color:var(--t0);letter-spacing:.04em;margin-bottom:4px}
.lp-tagline{font-family:var(--mono);font-size:11px;color:var(--t2);letter-spacing:.06em;margin-bottom:32px}
.ctx-badge{padding:8px 12px;border-radius:6px;font-family:var(--mono);font-size:11px;letter-spacing:.04em;margin-bottom:14px}
.ctx-dock{background:rgba(32,192,208,.08);border:1px solid rgba(32,192,208,.2);color:var(--cyan)}
.ctx-mgmt{background:rgba(240,160,48,.08);border:1px solid rgba(240,160,48,.2);color:var(--amber)}
.ctx-err{background:rgba(232,72,72,.08);border:1px solid rgba(232,72,72,.2);color:var(--red)}
.fl{display:block;font-family:var(--mono);font-size:10px;font-weight:500;text-transform:uppercase;letter-spacing:.1em;color:var(--t2);margin:0 0 7px}
.fi{width:100%;padding:14px 16px;border-radius:8px;border:1px solid var(--b1);background:var(--s1);color:var(--t0);font-family:var(--mono);font-size:16px;outline:none;-webkit-appearance:none;transition:border-color .15s,box-shadow .15s;margin-bottom:16px}
.fi:focus{border-color:var(--amber);box-shadow:0 0 0 3px rgba(240,160,48,.1)}
.fi::placeholder{color:var(--t3)}
.sign-btn{width:100%;padding:15px;border-radius:10px;border:1px solid rgba(240,160,48,.3);background:rgba(240,160,48,.1);color:var(--amber);font-family:var(--mono);font-size:14px;font-weight:500;letter-spacing:.08em;cursor:pointer;touch-action:manipulation;transition:all .15s;margin-top:4px;display:flex;align-items:center;justify-content:center;gap:10px}
.sign-btn:hover{background:rgba(240,160,48,.18);border-color:rgba(240,160,48,.5)}
.sign-btn:active{transform:scale(.99)}
.sign-btn:disabled{opacity:.5;cursor:not-allowed;transform:none}
.arrow{transition:transform .15s}
.sign-btn:hover .arrow{transform:translateX(3px)}
.err-msg{display:none;padding:10px 12px;border-radius:6px;background:rgba(232,72,72,.08);border:1px solid rgba(232,72,72,.2);color:var(--red);font-family:var(--mono);font-size:12px;letter-spacing:.03em;margin-top:12px}
.err-msg.show{display:block}
.lp-hint{font-family:var(--mono);font-size:10px;color:var(--t3);letter-spacing:.04em;text-align:center;margin-top:20px;line-height:1.6}
/* ── Mobile ── */
@media(max-width:768px){
  body{grid-template-columns:1fr;grid-template-rows:auto auto;overflow-y:auto;height:auto;min-height:100vh}
  .dashboard{padding:24px 20px 20px;border-right:none;border-bottom:1px solid var(--b0)}
  .db-brand{margin-bottom:20px}
  .clock-time{font-size:clamp(54px,15vw,80px)}
  .date-row{margin-bottom:18px}
  .divider{margin-bottom:16px}
  .weather-block{margin-bottom:14px}
  .cal-wrap{display:none}
  .db-footer{margin-top:4px}
  .login-panel{padding:28px 20px 36px;min-height:auto}
  .lp-brand{margin-bottom:22px}
  .lp-heading{font-size:26px}
  .lp-tagline{margin-bottom:22px}
}
@media(max-width:480px){
  .dashboard{padding:18px 16px 16px}
  .db-brand{margin-bottom:16px}
  .clock-time{font-size:clamp(46px,16vw,70px)}
  .date-row{margin-bottom:14px;gap:8px}
  .weather-block{margin-bottom:12px}
  .weather-icon{font-size:34px}
  .weather-temp{font-size:clamp(28px,8vw,42px)}
  .divider{margin-bottom:12px}
  .db-footer{display:none}
  .login-panel{padding:20px 16px 30px}
  .lp-brand{margin-bottom:16px}
  .lp-heading{font-size:22px}
  .lp-tagline{font-size:10px;margin-bottom:18px}
  .fi{font-size:16px!important;padding:13px 14px}
  .sign-btn{padding:14px;font-size:13px}
}
@media(max-width:360px){
  .dashboard{padding:14px}
  .clock-time{font-size:clamp(40px,17vw,60px)}
  .divider{display:none}
  .login-panel{padding:16px 14px 26px}
}
@supports(padding:env(safe-area-inset-top)){
  .dashboard{padding-top:max(44px,calc(18px + env(safe-area-inset-top)))}
  @media(max-width:768px){
    .dashboard{padding-top:max(24px,calc(12px + env(safe-area-inset-top)))}
    .login-panel{padding-bottom:max(36px,calc(14px + env(safe-area-inset-bottom)))}
  }
}
/* ── Animations ── */
@keyframes fadeUp{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
.db-brand{animation:fadeUp .35s ease both}
.clock-wrap{animation:fadeUp .35s .07s ease both}
.date-row{animation:fadeUp .35s .12s ease both}
.divider{animation:fadeUp .3s .16s ease both}
.weather-block{animation:fadeUp .35s .2s ease both}
.cal-wrap{animation:fadeUp .35s .25s ease both}
.db-footer{animation:fadeUp .3s .3s ease both}
.login-panel{animation:fadeUp .35s .08s ease both}
</style>
</head>
<body>

<div class="dashboard">
  <div class="db-brand">
    <div class="db-mark">W</div>
    <div><div class="db-name">WESBELL</div><div class="db-sub">DISPATCH SYSTEM</div></div>
  </div>
  <div class="clock-wrap">
    <span class="clock-time"><span id="ch">--</span><span class="colon">:</span><span id="cm">--</span><span class="clock-secs" id="cs">--</span></span><span class="clock-ampm" id="ca"></span>
  </div>
  <div class="date-row">
    <span class="date-day" id="dd"></span>
    <span class="date-full" id="df"></span>
  </div>
  <div class="divider"></div>
  <div class="weather-block" id="wb"><div class="weather-msg">Fetching weather&hellip;</div></div>
  <div class="cal-wrap" id="cal"></div>
  <div class="db-footer">
    <div class="live-dot"></div>
    <div class="footer-txt" id="ft">WESBELL DISPATCH</div>
  </div>
</div>

<div class="login-panel">
  <div class="lp-brand">
    <div class="lp-mark">W</div>
    <div><div class="lp-name">WESBELL</div><div class="lp-sub2">DISPATCH</div></div>
  </div>
  <div class="lp-heading">SIGN IN</div>
  <div class="lp-tagline">ENTER YOUR ROLE &amp; PIN TO CONTINUE</div>
  ${contextBadge}
  ${expiredBanner}
  <label class="fl" for="role">Role</label>
  <select id="role" class="fi">${roleOptions}</select>
  <label class="fl" for="pin">PIN</label>
  <input id="pin" class="fi" type="password" inputmode="numeric" placeholder="&bull;&bull;&bull;&bull;&bull;&bull;" autocomplete="current-password"/>
  <div class="err-msg" id="em"></div>
  <button class="sign-btn" id="go"><span>SIGN IN</span><span class="arrow">&rarr;</span></button>
  <div class="lp-hint">Contact management if you need a PIN.</div>
</div>

<script>
(function(){
  // Clock
  function tick(){
    var n=new Date(),h=n.getHours(),m=n.getMinutes(),s=n.getSeconds(),ap=h>=12?"PM":"AM";
    h=h%12||12;
    document.getElementById("ch").textContent=String(h).padStart(2,"0");
    document.getElementById("cm").textContent=String(m).padStart(2,"0");
    document.getElementById("cs").textContent=String(s).padStart(2,"0");
    document.getElementById("ca").textContent=ap;
  }
  tick(); setInterval(tick,1000);

  // Date
  var now=new Date();
  var DAYS=["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
  var MONTHS=["January","February","March","April","May","June","July","August","September","October","November","December"];
  document.getElementById("dd").textContent=DAYS[now.getDay()];
  document.getElementById("df").textContent=MONTHS[now.getMonth()]+" "+now.getDate()+", "+now.getFullYear();
  document.getElementById("ft").textContent="WESBELL DISPATCH \u00b7 "+DAYS[now.getDay()].toUpperCase();

  // Calendar
  var y=now.getFullYear(),mo=now.getMonth();
  var first=new Date(y,mo,1).getDay(),dim=new Date(y,mo+1,0).getDate(),dipm=new Date(y,mo,0).getDate();
  var h='<div class="cal-head"><span class="cal-month">'+MONTHS[mo].toUpperCase()+'</span><span class="cal-year">'+y+'</span></div>';
  h+='<div class="cal-grid">';
  ["SU","MO","TU","WE","TH","FR","SA"].forEach(function(d){h+='<div class="cal-dow">'+d+'</div>';});
  for(var i=first-1;i>=0;i--) h+='<div class="cal-cell other">'+(dipm-i)+'</div>';
  for(var d=1;d<=dim;d++) h+='<div class="cal-cell'+(d===now.getDate()?" today":"")+'">'+d+'</div>';
  var filled=first+dim,rem=filled%7===0?0:7-(filled%7);
  for(var d=1;d<=rem;d++) h+='<div class="cal-cell other">'+d+'</div>';
  h+='</div>';
  document.getElementById("cal").innerHTML=h;

  // Weather via Open-Meteo (no key needed)
  var WMO={0:"☀️",1:"🌤",2:"⛅",3:"☁️",45:"🌫",48:"🌫",51:"🌦",53:"🌦",55:"🌧",61:"🌧",63:"🌧",65:"🌧",71:"🌨",73:"❄️",75:"❄️",80:"🌦",81:"🌦",82:"⛈",95:"⛈",96:"⛈",99:"⛈"};
  var DESC={0:"Clear sky",1:"Mainly clear",2:"Partly cloudy",3:"Overcast",45:"Fog",48:"Icy fog",51:"Light drizzle",53:"Drizzle",55:"Heavy drizzle",61:"Light rain",63:"Rain",65:"Heavy rain",71:"Light snow",73:"Snow",75:"Heavy snow",80:"Light showers",81:"Showers",82:"Violent showers",95:"Thunderstorm",96:"Thunderstorm w/ hail",99:"Heavy thunderstorm"};
  if(navigator.geolocation){
    navigator.geolocation.getCurrentPosition(function(pos){
      var lat=pos.coords.latitude,lon=pos.coords.longitude;
      fetch("https://api.open-meteo.com/v1/forecast?latitude="+lat+"&longitude="+lon+"&current=temperature_2m,weathercode,windspeed_10m,relative_humidity_2m&temperature_unit=celsius&windspeed_unit=kmh&timezone=auto")
      .then(function(r){return r.json();})
      .then(function(d){
        var c=d.current,code=c.weathercode,icon=WMO[code]||"\ud83c\udf21",desc=DESC[code]||"",temp=Math.round(c.temperature_2m),wind=Math.round(c.windspeed_10m),hum=Math.round(c.relative_humidity_2m);
        document.getElementById("wb").innerHTML=
          '<div class="weather-icon">'+icon+'</div>'+
          '<div><div><span class="weather-temp">'+temp+'</span><span class="weather-unit">\u00b0C</span></div>'+
          '<div class="weather-desc">'+desc+'</div>'+
          '<div class="weather-meta"><div class="wm">\ud83d\udca8 <span>'+wind+' km/h</span></div><div class="wm">\ud83d\udca7 <span>'+hum+'%</span></div></div></div>';
      }).catch(function(){document.getElementById("wb").innerHTML='<div class="weather-msg">Weather unavailable</div>';});
    },function(){document.getElementById("wb").innerHTML='<div class="weather-msg">Enable location for weather</div>';},{timeout:8000});
  } else {
    document.getElementById("wb").innerHTML='<div class="weather-msg">Weather unavailable</div>';
  }

  // Login
  var ROLE_HOME={dispatcher:"/",admin:"/",dock:"/dock",management:"/management"};
  var btn=document.getElementById("go"),em=document.getElementById("em");
  function doLogin(){
    var role=document.getElementById("role").value,pin=document.getElementById("pin").value;
    if(!pin){em.textContent="Enter your PIN.";em.classList.add("show");return;}
    btn.disabled=true;btn.innerHTML="<span>SIGNING IN\u2026</span>";em.classList.remove("show");
    fetch("/api/login",{method:"POST",headers:{"Content-Type":"application/json","X-Requested-With":"XMLHttpRequest"},body:JSON.stringify({role:role,pin:pin})})
    .then(function(r){
      if(!r.ok){r.text().then(function(t){em.textContent=t;em.classList.add("show");});return;}
      location.href=ROLE_HOME[role]||"/";
    }).catch(function(){em.textContent="Connection error. Try again.";em.classList.add("show");})
    .finally(function(){btn.disabled=false;btn.innerHTML="<span>SIGN IN</span><span class=\"arrow\">&rarr;</span>";});
  }
  btn.addEventListener("click",doLogin);
  document.getElementById("pin").addEventListener("keydown",function(e){if(e.key==="Enter")doLogin();});
  document.getElementById("pin").focus();
})();
</script>
</body>
</html>`);
});

app.get("/",           guardPage(["dispatcher","management","admin"]),              sendIndex);
app.get("/dock",       guardPage(["dock","dispatcher","management","admin","__driver__"]), sendIndex);
app.get("/driver",     guardPage(["__driver__","dock","dispatcher","management","admin"]), sendIndex);
app.get("/management", guardPage(["management","admin"]),                              sendIndex);

/* ══════════════════════════════════════════
   API — AUTH
══════════════════════════════════════════ */
app.get("/api/whoami", (req, res) => {
  const s = getSession(req);
  const role = s?.role || null;
  // Admin and management can visit any page freely — no redirect hint
  // Other roles get redirected to their home if they land on the wrong page
  const freeRoam = !role || role === "admin" || role === "management";
  const redirectTo = freeRoam ? null : (ROLE_HOME[role] || "/");
  res.json({ role, version: APP_VERSION, redirectTo });
});

/* ══════════════════════════════════════════
   RATE LIMITING — LOGIN
══════════════════════════════════════════ */
const loginAttempts = new Map(); // ip → { count, resetAt }
const LOGIN_MAX     = 5;         // attempts before lockout
const LOGIN_WINDOW  = 60_000;    // 1 minute window
const LOGIN_LOCKOUT = 5 * 60_000;// 5 minute lockout after exceeding max

// Prune stale entries every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, v] of loginAttempts.entries()) if (v.resetAt < now) loginAttempts.delete(ip);
}, 10 * 60_000).unref();

function checkLoginRate(ip) {
  const now = Date.now();
  let entry = loginAttempts.get(ip);
  if (!entry || entry.resetAt < now) {
    entry = { count: 0, resetAt: now + LOGIN_WINDOW };
    loginAttempts.set(ip, entry);
  }
  entry.count++;
  if (entry.count > LOGIN_MAX) {
    // Extend lockout on each additional attempt
    entry.resetAt = now + LOGIN_LOCKOUT;
    return { blocked: true, retryAfter: Math.ceil((entry.resetAt - now) / 1000) };
  }
  return { blocked: false, remaining: LOGIN_MAX - entry.count };
}

function resetLoginRate(ip) {
  loginAttempts.delete(ip);
}

app.post("/api/login", requireXHR, async (req, res) => {
  try {
    const ip = ipOf(req);
    const rate = checkLoginRate(ip);
    if (rate.blocked) {
      return res.status(429).send(`Too many attempts. Try again in ${rate.retryAfter}s.`);
    }
    const role = String(req.body.role || "").toLowerCase();
    const pin  = String(req.body.pin  || "");
    if (!["dispatcher","dock","management","admin"].includes(role)) return res.status(400).send("Invalid role");
    if (pin.length < PIN_MIN_LEN) return res.status(400).send("PIN too short");
    const ok = await verifyPin(role, pin);
    await audit(req, role, ok ? "login_success" : "login_failed", "auth", role, {});
    if (!ok) return res.status(401).send("Invalid PIN");
    resetLoginRate(ip); // Clear counter on successful login
    const existing = getSession(req);
    if (existing?.sid) sessions.delete(existing.sid);
    const sid = newSession(role);
    setSessionCookie(res, sid);
    res.json({ ok: true, role, version: APP_VERSION });
  } catch (e) { res.status(500).send("Login error"); }
});

app.post("/api/logout", requireXHR, (req, res) => {
  const s = getSession(req);
  if (s?.sid) sessions.delete(s.sid);
  clearSessionCookie(res);
  res.json({ ok: true });
});

/* ══════════════════════════════════════════
   API — TRAILERS
══════════════════════════════════════════ */
app.get("/api/state", async (req, res) => res.json(await loadTrailersObject()));

app.post("/api/upsert", requireXHR, requireDockStatusAllowed, async (req, res) => {
  const actor = req.user.role;
  try {
    const trailer = String(req.body.trailer || "").trim();
    if (!trailer) return res.status(400).send("Missing trailer");

    const existing = await get(`SELECT * FROM trailers WHERE trailer=?`, [trailer]);
    const now = Date.now();

    const direction   = req.body.direction   !== undefined ? String(req.body.direction   || "").trim() : (existing?.direction   || "");
    const status      = req.body.status      !== undefined ? String(req.body.status      || "").trim() : (existing?.status      || "");
    const door        = req.body.door        !== undefined ? String(req.body.door        || "").trim() : (existing?.door        || "");
    const note        = req.body.note        !== undefined ? String(req.body.note        || "").trim() : (existing?.note        || "");
    const dropType    = req.body.dropType    !== undefined ? String(req.body.dropType    || "").trim() : (existing?.dropType    || "");
    const carrierType = req.body.carrierType !== undefined ? String(req.body.carrierType || "").trim() : (existing?.carrierType || "");

    if (actor === "dock") {
      const onlyStatus =
        req.body.status    !== undefined &&
        req.body.direction === undefined &&
        req.body.door      === undefined &&
        req.body.note      === undefined &&
        req.body.dropType  === undefined;
      if (!onlyStatus) return res.status(403).send("Dock can only update trailer status");
      if (!["Loading","Dock Ready"].includes(status)) return res.status(403).send("Dock can only set Loading or Dock Ready");
    }

    // Auto-set Incoming for Wesbell drops from driver portal
    const isDriverDrop = req.body.flow === "drop" && carrierType.toLowerCase() === "wesbell";
    const finalStatus  = isDriverDrop ? "Incoming" : status;

    const allowed = ["Incoming","Dropped","Loading","Dock Ready","Ready","Departed",""];
    if (!allowed.includes(finalStatus)) return res.status(400).send("Invalid status");

    await run(
      `INSERT INTO trailers(trailer,direction,status,door,note,dropType,carrierType,updatedAt)
       VALUES(?,?,?,?,?,?,?,?)
       ON CONFLICT(trailer) DO UPDATE SET
         direction=excluded.direction, status=excluded.status, door=excluded.door,
         note=excluded.note, dropType=excluded.dropType, carrierType=excluded.carrierType,
         updatedAt=excluded.updatedAt`,
      [trailer, direction, finalStatus, door, note, dropType, carrierType, now]
    );

    await audit(req, actor, existing ? "trailer_update" : "trailer_create", "trailer", trailer, { direction, status: finalStatus, door, dropType, note });
    if (req.body.status !== undefined || isDriverDrop) await audit(req, actor, "trailer_status_set", "trailer", trailer, { status: finalStatus });

    if (finalStatus === "Ready" && ["dispatcher","management","admin"].includes(actor)) {
      wsBroadcast("notify", { kind: "ready", trailer, door: door || "" });
      broadcastPush("🟢 Trailer Ready", `Trailer ${trailer} is ready${door ? " at door " + door : ""}`, { trailer, door }).catch(() => {});
    }

    await broadcastTrailers();
    res.json({ ok: true });
  } catch (e) { res.status(500).send("Upsert failed"); }
});

app.post("/api/delete", requireXHR, requireRole(["dispatcher","management","admin"]), async (req, res) => {
  const actor = req.user.role;
  try {
    const trailer = String(req.body.trailer || "").trim();
    if (!trailer) return res.status(400).send("Missing trailer");
    await run(`DELETE FROM trailers WHERE trailer=?`, [trailer]);
    await audit(req, actor, "trailer_delete", "trailer", trailer, {});
    await broadcastTrailers();
    res.json({ ok: true });
  } catch (e) { res.status(500).send("Delete failed"); }
});

app.post("/api/clear", requireXHR, requireRole(["dispatcher","management","admin"]), async (req, res) => {
  const actor = req.user.role;
  try {
    await run(`DELETE FROM trailers`);
    await audit(req, actor, "trailer_clear_all", "trailer", "*", {});
    await broadcastTrailers();
    res.json({ ok: true });
  } catch (e) { res.status(500).send("Clear failed"); }
});

/* ══════════════════════════════════════════
   API — DOCK PLATES
══════════════════════════════════════════ */
app.get("/api/dockplates", async (req, res) => res.json(await loadDockPlatesObject()));

app.post("/api/dockplates/set", requireXHR, requireRole(["dock","dispatcher","management","admin"]), async (req, res) => {
  const actor = req.user.role;
  try {
    const door   = String(req.body.door   || "").trim();
    const status = String(req.body.status || "Unknown").trim();
    const note   = String(req.body.note   || "").trim();
    const dNum = Number(door);
    if (!Number.isFinite(dNum) || dNum < 28 || dNum > 42) return res.status(400).send("Invalid door");
    if (!["OK","Service","Unknown"].includes(status)) return res.status(400).send("Invalid plate status");
    await run(
      `INSERT INTO dockplates(door,status,note,updatedAt) VALUES(?,?,?,?)
       ON CONFLICT(door) DO UPDATE SET status=excluded.status,note=excluded.note,updatedAt=excluded.updatedAt`,
      [door, status, note, Date.now()]
    );
    await audit(req, actor, "plate_set", "dockplate", door, { status, note });
    await broadcastPlates();
    res.json({ ok: true });
  } catch (e) { res.status(500).send("Dock plate set failed"); }
});

/* ══════════════════════════════════════════
   API — DRIVER
══════════════════════════════════════════ */
app.get("/api/driver/assignment", async (req, res) => {
  try {
    const trailer = String(req.query.trailer || "").trim();
    if (!trailer) return res.status(400).send("Missing trailer");
    const row = await get(`SELECT door,direction,status,dropType FROM trailers WHERE trailer=?`, [trailer]);
    if (!row) return res.json({ found: false });
    if (!["Incoming","Dropped","Loading","Dock Ready","Ready"].includes(row.status)) return res.json({ found: false });
    res.json({ found: true, door: row.door || "", direction: row.direction || "", status: row.status || "", dropType: row.dropType || "" });
  } catch (e) { res.status(500).send("Lookup failed"); }
});

app.post("/api/driver/drop",       requireXHR, requireDriverAccess, async (req, res) => {
  try {
    const trailer     = String(req.body.trailer     || "").trim();
    const door        = String(req.body.door        || "").trim();
    const dropType    = String(req.body.dropType    || "Empty").trim();
    const carrierType = String(req.body.carrierType || "Wesbell").trim();

    if (!trailer) return res.status(400).send("Missing trailer");
    if (door) {
      const dNum = Number(door);
      if (!Number.isFinite(dNum) || dNum < 18 || dNum > 42) return res.status(400).send("Invalid door (18–42)");
    }
    if (!["Empty","Loaded"].includes(dropType)) return res.status(400).send("Invalid drop type");

    const existing  = await get(`SELECT * FROM trailers WHERE trailer=?`, [trailer]);
    const now       = Date.now();
    const direction = existing?.direction || "Inbound";

    // Duplicate guard: warn if trailer is already active on the board
    // Allow force=true to bypass (set by client after user confirms)
    const ACTIVE_STATUSES = ["Incoming","Dropped","Loading","Dock Ready","Ready"];
    if (existing && ACTIVE_STATUSES.includes(existing.status) && !req.body.force) {
      return res.status(409).json({
        duplicate: true,
        trailer,
        currentStatus: existing.status,
        currentDoor:   existing.door || null,
        message: `Trailer ${trailer} is already on the board (${existing.status}${existing.door ? " at door " + existing.door : ""}). Submit again to overwrite.`,
      });
    }

    // Auto-assign door if none provided
    let assignedDoor = door;
    if (!assignedDoor) {
      const occupied = await all(
        `SELECT door FROM trailers WHERE door IS NOT NULL AND door != '' AND status NOT IN ('Departed','') AND trailer != ?`,
        [trailer]
      );
      const occupiedSet = new Set(occupied.map(r => String(r.door)));
      for (let d = 28; d <= 42; d++) {
        if (!occupiedSet.has(String(d))) { assignedDoor = String(d); break; }
      }
    }

    // Driver drops always land as Incoming
    await run(
      `INSERT INTO trailers(trailer,direction,status,door,note,dropType,carrierType,updatedAt)
       VALUES(?,?,?,?,?,?,?,?)
       ON CONFLICT(trailer) DO UPDATE SET
         direction=excluded.direction, status=excluded.status, door=excluded.door,
         dropType=excluded.dropType, carrierType=excluded.carrierType, updatedAt=excluded.updatedAt`,
      [trailer, direction, "Incoming", assignedDoor || "", existing?.note || "", dropType, carrierType, now]
    );

    await audit(req, "driver", "driver_drop", "trailer", trailer, { door: assignedDoor || "", dropType, carrierType });
    await broadcastTrailers();
    res.json({ ok: true, door: assignedDoor || null });
  } catch (e) { res.status(500).send("Drop failed"); }
});

app.post("/api/crossdock/pickup",  requireXHR, requireDriverAccess, async (req, res) => {
  try {
    const trailer = String(req.body.trailer || "").trim();
    const door    = String(req.body.door    || "").trim();
    if (!trailer) return res.status(400).send("Missing trailer");
    const dNum = Number(door);
    if (!Number.isFinite(dNum) || dNum < 18 || dNum > 42) return res.status(400).send("Invalid door (18–42)");
    const existing = await get(`SELECT * FROM trailers WHERE trailer=?`, [trailer]);
    // Status is intentionally preserved here — Departed is set by /api/confirm-safety
    // after the driver completes the safety checklist. This two-step design means
    // if the driver drops connection after pickup but before safety, the trailer
    // stays visible on the board rather than disappearing silently.
    await run(
      `INSERT INTO trailers(trailer,direction,status,door,note,dropType,updatedAt)
       VALUES(?,?,?,?,?,?,?)
       ON CONFLICT(trailer) DO UPDATE SET door=excluded.door,updatedAt=excluded.updatedAt`,
      [trailer, existing?.direction || "Cross Dock", existing?.status || "Ready", door, existing?.note || "", existing?.dropType || "", Date.now()]
    );
    await audit(req, "driver", "crossdock_pickup", "trailer", trailer, { door });
    await broadcastTrailers();
    res.json({ ok: true });
  } catch (e) { res.status(500).send("Cross dock pickup failed"); }
});

app.post("/api/crossdock/offload", requireXHR, requireDriverAccess, async (req, res) => {
  try {
    const trailer = String(req.body.trailer || "").trim();
    const door    = String(req.body.door    || "").trim();
    if (!trailer) return res.status(400).send("Missing trailer");
    const dNum = Number(door);
    if (!Number.isFinite(dNum) || dNum < 18 || dNum > 42) return res.status(400).send("Invalid door (18–42)");
    const existing = await get(`SELECT * FROM trailers WHERE trailer=?`, [trailer]);
    // Duplicate guard: warn if trailer is already active (not Departed) with a different door
    const ACTIVE_STATUSES = ["Incoming","Dropped","Loading","Dock Ready","Ready"];
    if (existing && ACTIVE_STATUSES.includes(existing.status) && existing.door && existing.door !== door && !req.body.force) {
      return res.status(409).json({
        duplicate: true,
        trailer,
        currentStatus: existing.status,
        currentDoor:   existing.door,
        message: `Trailer ${trailer} is already active at door ${existing.door} (${existing.status}). Submit again to overwrite.`,
      });
    }
    await run(
      `INSERT INTO trailers(trailer,direction,status,door,note,dropType,updatedAt)
       VALUES(?,?,?,?,?,?,?)
       ON CONFLICT(trailer) DO UPDATE SET door=excluded.door,status=excluded.status,dropType=excluded.dropType,updatedAt=excluded.updatedAt`,
      [trailer, existing?.direction || "Cross Dock", "Dropped", door, existing?.note || "", "Loaded", Date.now()]
    );
    await audit(req, "driver", "crossdock_offload", "trailer", trailer, { door });
    await broadcastTrailers();
    res.json({ ok: true });
  } catch (e) { res.status(500).send("Cross dock offload failed"); }
});

app.post("/api/shunt", requireXHR, async (req, res) => {
  try {
    const session = getSession(req);
    const actor   = session?.role || "driver";

    if (session && !["dispatcher","dock","management","admin"].includes(session.role))
      return res.status(403).send("Unauthorized");

    const trailer = String(req.body.trailer || "").trim();
    const door    = String(req.body.door    || "").trim();
    if (!trailer) return res.status(400).send("Missing trailer");
    if (!door)    return res.status(400).send("Missing door");
    const dNum = Number(door);
    if (!Number.isFinite(dNum) || dNum < 28 || dNum > 42) return res.status(400).send("Invalid door (28–42)");

    const existing = await get(`SELECT * FROM trailers WHERE trailer=?`, [trailer]);
    if (!existing) return res.status(404).send("Trailer not found");

    const now = Date.now();
    await run(`UPDATE trailers SET door=?,status='Dropped',updatedAt=? WHERE trailer=?`, [door, now, trailer]);
    await audit(req, actor, "trailer_shunt", "trailer", trailer, { fromDoor: existing.door || "—", toDoor: door });
    await broadcastTrailers();
    res.json({ ok: true, door });
  } catch (e) { res.status(500).send("Shunt failed"); }
});

/* ══════════════════════════════════════════
   API — PUSH
══════════════════════════════════════════ */
app.get("/api/push/vapid-public-key", (req, res) => {
  if (!VAPID_KEYS) return res.status(503).send("VAPID not ready");
  res.json({ publicKey: VAPID_KEYS.publicKey });
});

app.post("/api/push/subscribe", requireXHR, async (req, res) => {
  try {
    const sub = req.body;
    if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) return res.status(400).send("Invalid subscription");
    pushSubs.set(sub.endpoint, sub);
    await run(
      `INSERT INTO push_subscriptions(endpoint,subscription,createdAt) VALUES(?,?,?)
       ON CONFLICT(endpoint) DO UPDATE SET subscription=excluded.subscription`,
      [sub.endpoint, JSON.stringify(sub), Date.now()]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).send("Subscribe failed"); }
});

app.post("/api/push/unsubscribe", requireXHR, async (req, res) => {
  try {
    const { endpoint } = req.body;
    if (endpoint) {
      pushSubs.delete(endpoint);
      await run(`DELETE FROM push_subscriptions WHERE endpoint=?`, [endpoint]);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).send("Unsubscribe failed"); }
});

/* ══════════════════════════════════════════
   API — AUDIT
══════════════════════════════════════════ */
app.get("/api/audit", requireRole(["dispatcher","management","admin"]), async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(500, Number(req.query.limit || 200)));
    const rows = await all(
      `SELECT at,actorRole,action,entityType,entityId,details,ip,userAgent FROM audit ORDER BY at DESC LIMIT ?`,
      [limit]
    );
    res.json(rows.map(r => {
      let details = {}; try { details = r.details ? JSON.parse(r.details) : {}; } catch {}
      return { ...r, details };
    }));
  } catch (e) { res.status(500).send("Audit failed"); }
});

/* ══════════════════════════════════════════
   API — MANAGEMENT PIN MANAGEMENT
══════════════════════════════════════════ */
app.post("/api/management/set-pin", requireXHR, requireRole(["management","admin"]), async (req, res) => {
  const actor = req.user.role;
  try {
    const role = String(req.body.role || "").toLowerCase();
    const pin  = String(req.body.pin  || "");
    if (!["dispatcher","dock","management","admin"].includes(role)) return res.status(400).send("Invalid role");
    // Only admin can change the admin PIN
    if (role === "admin" && actor !== "admin") return res.status(403).send("Only admin can change the admin PIN");
    if (pin.length < PIN_MIN_LEN) return res.status(400).send("PIN too short");
    await setPin(role, pin);
    for (const [sid, s] of sessions.entries()) if (s.role === role) sessions.delete(sid);
    await audit(req, actor, "pin_changed", "auth", role, {});
    res.json({ ok: true });
  } catch (e) { res.status(500).send("Set PIN failed"); }
});

/* ══════════════════════════════════════════
   API — SAFETY CONFIRM
══════════════════════════════════════════ */
app.post("/api/confirm-safety", requireXHR, requireDriverAccess, async (req, res) => {
  try {
    const trailer    = String(req.body.trailer    || "").trim();
    const door       = String(req.body.door       || "").trim();
    const loadSecured = !!req.body.loadSecured;
    const dockPlateUp = !!req.body.dockPlateUp;
    if (!loadSecured || !dockPlateUp) return res.status(400).send("Both confirmations required");
    const action = String(req.body.action || "safety").trim();
    const at = Date.now();
    if (action === "xdock_pickup" && trailer)
      await run(`UPDATE trailers SET status='Departed',updatedAt=? WHERE trailer=?`, [at, trailer]);
    await run(
      `INSERT INTO confirmations(at,trailer,door,action,ip,userAgent) VALUES(?,?,?,?,?,?)`,
      [at, trailer || "", door || "", action, ipOf(req), req.headers["user-agent"] || ""]
    );
    await audit(req, "driver", "safety_confirmed", "safety", trailer || "-", { trailer, door, action, loadSecured, dockPlateUp });
    await broadcastTrailers();
    await broadcastConfirmations();
    res.json({ ok: true });
  } catch (e) { res.status(500).send("Confirm failed"); }
});

/* ══════════════════════════════════════════
   API — ISSUE REPORTS
══════════════════════════════════════════ */

// Max ~4 MB base64 image
const MAX_PHOTO_BYTES = 4 * 1024 * 1024;

app.post("/api/report-issue", requireXHR, requireIssueAccess, async (req, res) => {
  // Allow drivers (no session) and all authenticated roles to file issue reports
  const s = getSession(req);
  const actorRole = s?.role || "driver";
  try {
    const trailer  = String(req.body.trailer  || "").trim();
    const door     = String(req.body.door     || "").trim();
    const note     = String(req.body.note     || "").trim().slice(0, 1000);
    const photoData = req.body.photo_data ? String(req.body.photo_data) : null;
    const photoMime = req.body.photo_mime ? String(req.body.photo_mime).slice(0, 32) : null;

    if (!trailer) return res.status(400).send("Missing trailer");

    // Validate image data if provided
    if (photoData) {
      if (!photoMime || !photoMime.startsWith("image/"))
        return res.status(400).send("Invalid photo MIME type");
      // Check base64 size (each char ≈ 0.75 bytes)
      if (photoData.length * 0.75 > MAX_PHOTO_BYTES)
        return res.status(413).send("Photo too large (max 4 MB)");
    }

    const at = Date.now();
    const result = await run(
      `INSERT INTO issue_reports(at,trailer,door,note,photo_data,photo_mime,ip,userAgent)
       VALUES(?,?,?,?,?,?,?,?)`,
      [at, trailer, door, note, photoData || null, photoMime || null,
       ipOf(req), req.headers["user-agent"] || ""]
    );
    await audit(req, actorRole, "issue_reported", "trailer", trailer, { door, hasPhoto: !!photoData, note: note.slice(0, 80) });
    broadcastPush("⚠️ Issue Report", `Trailer ${trailer}${door ? " at door " + door : ""}${note ? ": " + note.slice(0, 60) : ""}`, { trailer, door }).catch(() => {});
    res.json({ ok: true, id: result.lastID });
  } catch (e) { res.status(500).send("Report failed"); }
});

app.get("/api/issue-reports", requireRole(["dispatcher","management","admin"]), async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(200, Number(req.query.limit || 50)));
    const rows = await all(
      `SELECT id,at,trailer,door,note,photo_data,photo_mime,ip FROM issue_reports ORDER BY at DESC LIMIT ?`,
      [limit]
    );
    res.json(rows);
  } catch (e) { res.status(500).send("Fetch failed"); }
});

app.get("/api/issue-reports/:id/photo", requireRole(["dispatcher","management","admin"]), async (req, res) => {
  try {
    const row = await get(`SELECT photo_data,photo_mime FROM issue_reports WHERE id=?`, [req.params.id]);
    if (!row || !row.photo_data) return res.status(404).send("No photo");
    const buf = Buffer.from(row.photo_data, "base64");
    res.setHeader("Content-Type", row.photo_mime || "image/jpeg");
    res.setHeader("Cache-Control", "private, max-age=86400");
    res.send(buf);
  } catch (e) { res.status(500).send("Fetch failed"); }
});


wss.on("connection", async ws => {
  try {
    ws.send(JSON.stringify({ type: "version",       payload: { version: APP_VERSION } }));
    ws.send(JSON.stringify({ type: "state",         payload: await loadTrailersObject() }));
    ws.send(JSON.stringify({ type: "dockplates",    payload: await loadDockPlatesObject() }));
    ws.send(JSON.stringify({ type: "confirmations", payload: await loadConfirmations(250) }));
  } catch {}
});

/* ══════════════════════════════════════════
   START
══════════════════════════════════════════ */
initDb()
  .then(async () => {
    loadOrGenVapid();
    const subs = await all(`SELECT endpoint,subscription FROM push_subscriptions`);
    for (const s of subs) {
      try { pushSubs.set(s.endpoint, JSON.parse(s.subscription)); } catch {}
    }
    console.log(`[PUSH] Loaded ${pushSubs.size} push subscriptions`);
  })
  .then(() => {
    server.listen(PORT, () => {
      console.log(`Wesbell Dispatch v${APP_VERSION} running on http://localhost:${PORT}`);
      console.log(`DB: ${DB_FILE}`);
    });
  })
  .catch(e => { console.error("DB init failed:", e); process.exit(1); });
