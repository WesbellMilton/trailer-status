// server.js — Wesbell Dispatch v3.5.0
const express = require("express");
const http    = require("http");
const path    = require("path");
const fs      = require("fs");
const WebSocket = require("ws");
const sqlite3 = require("sqlite3").verbose();
const crypto  = require("crypto");
const zlib    = require("zlib");

const app = express();
// Serve static files (index.html, app.js, style.css, manifest, icons, sw.js)
app.use(express.static(__dirname));
// Prevent uncaught errors from crashing the whole server
process.on('uncaughtException',  err  => { console.error('[CRASH] uncaughtException:', err); logEvent('error','crash','uncaughtException', String(err?.stack||err)).catch(()=>{}); });
process.on('unhandledRejection', reason => { console.error('[CRASH] unhandledRejection:', reason); logEvent('error','crash','unhandledRejection', String(reason?.stack||reason)).catch(()=>{}); });
// Skip compression for binary/static assets that can break if gzipped incorrectly
const u = (req.url || "").toLowerCase();
if (
  u.startsWith("/icons/") ||
  u.endsWith(".png") || u.endsWith(".jpg") || u.endsWith(".jpeg") ||
  u.endsWith(".ico") || u.endsWith(".webmanifest") ||
  u.endsWith(".woff") || u.endsWith(".woff2")
) return next();
// ── Gzip compression ──────────────────────────────────────────────────────
app.use((req, res, next) => {
  const ae = req.headers["accept-encoding"] || "";
  if (!ae.includes("gzip")) return next();
  const orig = res.json.bind(res);
  res.json = (data) => {
    const buf = Buffer.from(JSON.stringify(data));
    zlib.gzip(buf, (err, compressed) => {
      if (err || buf.length < 1024) return orig(data);
      res.setHeader("Content-Encoding", "gzip");
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Vary", "Accept-Encoding");
      res.end(compressed);
    });
  };
  next();
});

// ── Security headers ───────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  next();
});

// ── Request timeout (30s) ──────────────────────────────────────────────────
app.use((req, res, next) => {
  const t = setTimeout(() => {
    if (!res.headersSent) res.status(503).send("Request timeout");
  }, 30000);
  res.on("finish", () => clearTimeout(t));
  res.on("close",  () => clearTimeout(t));
  next();
});

// ── Login rate limiting ────────────────────────────────────────────────────
const loginAttempts = new Map(); // ip -> {count, resetAt}
function checkLoginRate(ip) {
  const now = Date.now();
  let entry = loginAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + 60000 };
    loginAttempts.set(ip, entry);
  }
  entry.count++;
  return entry.count <= 15; // 15 attempts per minute
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of loginAttempts) if (now > e.resetAt) loginAttempts.delete(ip);
}, 120000);

app.use(express.json({ limit: "6mb" }));
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
// Use persistent disk if available (Render mounts at /var/data), then /tmp, never ephemeral app dir
const DB_FILE = process.env.DB_FILE || (() => {
  const fs = require("fs"), p = require("path");
  for (const candidate of ["/var/data/wesbell.sqlite", "/tmp/wesbell.sqlite"]) {
    try { fs.mkdirSync(p.dirname(candidate), { recursive: true }); return candidate; } catch {}
  }
  return p.join(__dirname, "wesbell.sqlite");
})();
const APP_VERSION = process.env.APP_VERSION || "3.5.0";
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
console.log("[DB] Using database at:", DB_FILE);
const db = new sqlite3.Database(DB_FILE);
const run = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, function (e) { e ? rej(e) : res(this); }));
const get = (sql, p = []) => new Promise((res, rej) => db.get(sql, p, (e, r) => { e ? rej(e) : res(r); }));
const all = (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => { e ? rej(e) : res(r); }));

/* ══════════════════════════════════════════
   CACHES
══════════════════════════════════════════ */
let _trailersCache = null;
let _platesCache   = null;
let _blocksCache   = null;
function invalidateTrailers() { _trailersCache = null; }
function invalidatePlates()   { _platesCache   = null; }
function invalidateBlocks()   { _blocksCache   = null; }
async function getTrailersCache() { if (!_trailersCache) _trailersCache = await loadTrailersObject(); return _trailersCache; }
async function getPlatesCache()   { if (!_platesCache)   _platesCache   = await loadDockPlatesObject(); return _platesCache; }
async function loadDoorBlocksObject() { const rows = await all(`SELECT * FROM doorblocks`); const o = {}; rows.forEach(r => o[r.door] = { note: r.note, setAt: r.setAt }); return o; }
async function getBlocksCache()   { if (!_blocksCache)   _blocksCache   = await loadDoorBlocksObject(); return _blocksCache; }

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
    note TEXT, dropType TEXT, carrierType TEXT DEFAULT '', updatedAt INTEGER,
    omwAt INTEGER DEFAULT NULL, omwEta INTEGER DEFAULT NULL, doorAt INTEGER DEFAULT NULL
  )`);
  await run(`CREATE TABLE IF NOT EXISTS doorblocks (
    door      TEXT PRIMARY KEY,
    note      TEXT NOT NULL DEFAULT '',
    setAt     INTEGER NOT NULL DEFAULT 0
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
  await run(`CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER, level TEXT, context TEXT, message TEXT, detail TEXT
  )`);
  await run(`CREATE TABLE IF NOT EXISTS door_reservations (
    door       TEXT PRIMARY KEY,
    trailer    TEXT NOT NULL,
    carrierType TEXT NOT NULL DEFAULT 'Outside',
    reservedAt INTEGER NOT NULL,
    expiresAt  INTEGER NOT NULL
  )`);

// Safe column migrations (no-op if column exists)
db.run('ALTER TABLE trailers ADD COLUMN omwAt INTEGER DEFAULT NULL', ()=>{});
db.run('ALTER TABLE trailers ADD COLUMN omwEta INTEGER DEFAULT NULL', ()=>{});
db.run('ALTER TABLE trailers ADD COLUMN doorAt INTEGER DEFAULT NULL', ()=>{});


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

  // Seed PINs — env vars always win so Render config takes effect on every deploy
  for (const role of ["dispatcher", "dock", "management", "admin"]) {
    const row = await get(`SELECT role FROM pins WHERE role=?`, [role]);
    const envPin = ENV_PINS[role] && ENV_PINS[role].length >= PIN_MIN_LEN ? ENV_PINS[role] : null;
    if (!row) {
      // First boot: use env var or generate a random PIN
      const pin = envPin || genTempPin();
      await setPin(role, pin);
      console.log(`[SECURITY] ${role} PIN initialised`);
    } else if (envPin) {
      // Env var is set — always sync to DB so redeploys apply it immediately
      await setPin(role, envPin);
      console.log(`[SECURITY] ${role} PIN synced from environment`);
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
  if (s?.role === "dock") return res.status(403).send("Not accessible from dock role");
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

// Structured error log (visible in app)
const MAX_LOGS = 500;
async function logEvent(level, context, message, detail = "") {
  try {
    await run(`INSERT INTO logs(at,level,context,message,detail) VALUES(?,?,?,?,?)`,
      [Date.now(), level, context, message, String(detail).slice(0, 500)]);
    await run(`DELETE FROM logs WHERE id NOT IN (SELECT id FROM logs ORDER BY at DESC LIMIT ?)`, [MAX_LOGS]);
  } catch { /* never throw from logger */ }
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
      omwAt:       r.omwAt       || null,
      omwEta:      r.omwEta      || null,
      doorAt:      r.doorAt      || null,
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

/* =========================
   WEBSOCKET (AUTH + STREAMS + HEARTBEAT)
========================= */

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

function wsBroadcast(type, payload) {
  // Backward-safe: sockets without _streams will still receive everything.
  const msg = JSON.stringify({ type, payload });

  for (const client of wss.clients) {
    if (client.readyState !== WebSocket.OPEN) continue;

    const streams = client._streams; // Set<string> | undefined
    if (streams && !streams.has(type)) continue;

    try { client.send(msg); } catch {}
  }
}
async function broadcastTrailers() {
  try {
    invalidateTrailers();
    wsBroadcast("state", await getTrailersCache());
  } catch (e) {
    console.error("[WS] broadcastTrailers:", e?.message || e);
  }
}
// ----- Role detection from session cookie or WS path -----
function wsRoleFromReq(req) {
  // 1) Try session cookie (same as HTTP)
  try {
    const s = getSession(req);
    if (s?.role) return s.role;
  } catch {}

  // 2) Allow drivers WITHOUT login only if they connect to /ws/driver
  // (This is important: plain ws://host/ will NOT equal /driver)
  const url = String(req?.url || "").toLowerCase();
  if (url.startsWith("/ws/driver")) return "driver";

  return null;
}

// ----- Stream permissions by role -----
function streamsForRole(role) {
  // IMPORTANT: include all possible role strings you use in your login
  if (role === "driver") return new Set(["state", "doorblocks"]);

  if (role === "dock") return new Set(["state", "dockplates", "doorblocks"]);

  if (
    role === "dispatch" ||
    role === "dispatcher" ||
    role === "supervisor" ||
    role === "management" ||
    role === "admin"
  ) {
    return new Set(["state", "dockplates", "doorblocks", "confirmations"]);
  }

  // Safe minimum
  return new Set(["state"]);
}

// ----- Initial snapshot sender (never throws) -----
async function wsSendInitial(ws) {
  const streams = ws._streams || new Set();

  // Hello (optional)
  try {
    ws.send(JSON.stringify({ type: "hello", payload: { role: ws._role } }));
  } catch {}

  // State snapshot
  try {
    if (streams.has("state") && typeof getTrailersCache === "function") {
      ws.send(JSON.stringify({ type: "state", payload: await getTrailersCache() }));
    }
  } catch {}

  // Dock plates snapshot
  try {
    if (streams.has("dockplates") && typeof getPlatesCache === "function") {
      ws.send(JSON.stringify({ type: "dockplates", payload: await getPlatesCache() }));
    }
  } catch {}

  // Door blocks snapshot
  try {
    if (streams.has("doorblocks") && typeof getBlocksCache === "function") {
      ws.send(JSON.stringify({ type: "doorblocks", payload: await getBlocksCache() }));
    }
  } catch {}

  // Confirmations snapshot (optional; only if your function exists)
  try {
    if (streams.has("confirmations") && typeof loadConfirmations === "function") {
      ws.send(JSON.stringify({ type: "confirmations", payload: await loadConfirmations(250) }));
    }
  } catch {}
}

// ----- Connection handler (AUTH + SUBSCRIBE) -----
wss.on("connection", async (ws, req) => {
  try {
    const role = wsRoleFromReq(req);
/* =========================
   WEBSOCKET KEEPALIVE
========================= */

setInterval(() => {

  for (const ws of wss.clients) {

    if (ws.readyState !== WebSocket.OPEN) continue;

    try {
      ws.send(JSON.stringify({ type: "ping" }));
    } catch {}

  }

}, 25000);
    // Block unknown users (prevents outside connections from receiving your board)
    if (!role) {
      try { ws.close(1008, "Unauthorized"); } catch {}
      return;
    }

    ws._role = role;
    ws._streams = streamsForRole(role);

    // Heartbeat tracking
    ws.isAlive = true;
    ws.on("pong", () => { ws.isAlive = true; });

    ws.on("error", () => {});
    ws.on("close", () => {});

    await wsSendInitial(ws);
  } catch (e) {
    try { ws.close(1011, "Server error"); } catch {}
  }
});

// ----- Heartbeat cleanup (prevents zombie sockets) -----
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      try { ws.terminate(); } catch {}
      continue;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, 30000).unref?.();

/* ══════════════════════════════════════════
   DOOR RESERVATION HELPERS
══════════════════════════════════════════ */
const RESERVATION_TTL_MS = 30 * 60 * 1000; // 30 minutes

// Get all currently occupied/reserved/blocked doors as a Set
async function getOccupiedDoorSet(excludeTrailer = null) {
  const occupied = await all(
    `SELECT door FROM trailers WHERE door IS NOT NULL AND door != ''
     AND status NOT IN ('Departed','')${excludeTrailer ? " AND trailer != ?" : ""}`,
    excludeTrailer ? [excludeTrailer] : []
  );
  const blocks   = await all(`SELECT door FROM doorblocks`);
  const reserved = await all(
    `SELECT door FROM door_reservations WHERE expiresAt > ?`, [Date.now()]
  );
  return new Set([
    ...occupied.map(r => String(r.door)),
    ...blocks.map(r => String(r.door)),
    ...reserved.map(r => String(r.door)),
  ]);
}

// Pick the best available door (28–42), respecting dockplates status
async function pickBestDoor(excludeTrailer = null) {
  const occupiedSet = await getOccupiedDoorSet(excludeTrailer);
  // Prefer doors whose dockplate is OK (not Service / Out of Order)
  const plates = await all(`SELECT door, status FROM dockplates`);
  const plateMap = {};
  plates.forEach(p => { plateMap[String(p.door)] = p.status; });
  // Sort: OK plates first, then Unknown, skip Service/OOO
  const candidates = [];
  for (let d = 28; d <= 42; d++) {
    const ds = String(d);
    if (occupiedSet.has(ds)) continue;
    const plateStatus = plateMap[ds] || 'Unknown';
    if (plateStatus === 'Out of Order') continue; // never assign
    candidates.push({ door: ds, priority: plateStatus === 'OK' ? 0 : plateStatus === 'Unknown' ? 1 : 2 });
  }
  candidates.sort((a, b) => a.priority - b.priority);
  return candidates[0]?.door || null;
}

// Reserve a door for a trailer (overwrites any existing reservation for that door)
async function reserveDoor(door, trailer, carrierType) {
  const now = Date.now();
  await run(
    `INSERT INTO door_reservations(door, trailer, carrierType, reservedAt, expiresAt)
     VALUES(?,?,?,?,?)
     ON CONFLICT(door) DO UPDATE SET
       trailer=excluded.trailer, carrierType=excluded.carrierType,
       reservedAt=excluded.reservedAt, expiresAt=excluded.expiresAt`,
    [door, trailer, carrierType, now, now + RESERVATION_TTL_MS]
  );
}

// Release reservation for a door (call when trailer is Dropped or departed)
async function releaseReservation(trailer) {
  await run(`DELETE FROM door_reservations WHERE trailer=?`, [trailer]);
}

// Cleanup expired reservations and broadcast if anything changed
async function cleanupExpiredReservations() {
  const result = await run(`DELETE FROM door_reservations WHERE expiresAt <= ?`, [Date.now()]);
  if (result.changes > 0) {
    console.log(`[reservations] Cleaned up ${result.changes} expired reservation(s)`);
    await broadcastTrailers();
  }
}

// Run cleanup every 2 minutes
setInterval(cleanupExpiredReservations, 2 * 60 * 1000);

async function broadcastPlates() {
  try { invalidatePlates();   wsBroadcast("dockplates",    await getPlatesCache()); }
  catch(e) { console.error("[WS] broadcastPlates:", e.message); }
}
async function broadcastBlocks() {
  try { invalidateBlocks();   wsBroadcast("doorblocks",    await getBlocksCache()); }
  catch(e) { console.error("[WS] broadcastBlocks:", e.message); }
}
async function broadcastConfirmations() {
  try {                       wsBroadcast("confirmations", await loadConfirmations(250)); }
  catch(e) { console.error("[WS] broadcastConfirmations:", e.message); }
}

/* =========================
   STATIC / VIEWS
========================= */

// Safe static file serving — allowlist regex, never exposes server.js/sqlite/vapid
const SAFE_FILES =
  /^\/(app\.js|style\.css|sw\.js|sw2\.js|manifest\.json|manifest\.webmanifest|icons\/[a-z0-9._-]+\.(png|ico|webp)|splash\/[a-z0-9._-]+\.png)$/i;

app.use((req, res, next) => {
  // Service workers need correct headers + must be at scope "/"
  if (req.path === "/sw.js" || req.path === "/sw2.js") {
    const file = req.path === "/sw2.js" ? "sw2.js" : "sw.js";
    res.setHeader("Service-Worker-Allowed", "/");
    res.type("application/javascript");
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    return res.sendFile(path.join(__dirname, file), err => {
      if (err && !res.headersSent) res.status(404).end();
    });
  }

  // Allowlist everything else
  if (SAFE_FILES.test(req.path)) return next();

  // Block any other direct file access
  return res.status(404).end();
});

// Only after the allowlist gate:
app.use(express.static(__dirname, {
  etag: true,
  lastModified: true,
  maxAge: "0", // keep fresh while you iterate
}));
const INDEX_FILE = path.join(__dirname, "index.html");
const _indexHtmlCache = {};
const sendIndex = (_, res) => {
  try {
    let html = require("fs").readFileSync(INDEX_FILE, "utf8");
    html = html.replace("</head>", '<style>body,body::before,body::after{background-image:none!important;background:var(--bg)!important}#dispatchView,#dockView,#managementView,#driverView{background-image:none!important}</style></head>');
    res.setHeader("Content-Type","text/html; charset=utf-8");
    res.setHeader("Cache-Control","no-cache, no-store, must-revalidate");
    res.send(html);
  } catch(e) { res.sendFile(INDEX_FILE); }
};

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

  if (fromPath.includes("/driver")) return res.redirect(302, "/driver");

  if (!expired) {
    const s = getSession(req);
    if (s?.role) return res.redirect(302, ROLE_HOME[s.role] || "/");
  }

  const isDock = fromPath.includes("/dock");
  const isSup  = fromPath.includes("/management");

  // ── DOCK: simple friendly login ──────────────────────────────────────────
  if (isDock) {
    res.setHeader("content-type", "text/html; charset=utf-8");
    const expiredHtml = expired ? '<div class="exp-banner">Session expired — sign in again</div>' : "";
    return res.end(`<!doctype html><html lang="en"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover"/>
<title>Wesbell Dock</title>
<script>if("serviceWorker"in navigator){navigator.serviceWorker.getRegistrations().then(rs=>rs.forEach(r=>r.unregister()));}</script>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@500;700&family=DM+Mono:wght@500&display=swap" rel="stylesheet"/>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#060b10;--card:#0d1620;--border:#1a2535;--amber:#f0a030;--cyan:#20c0d0;--red:#e84848;--t0:#e8eef8;--t1:#8a9db8;--t2:#4a5e78;--mono:"DM Mono",monospace;--sans:"DM Sans",system-ui,sans-serif}
html,body{height:100%;-webkit-font-smoothing:antialiased}
body{background:var(--bg);color:var(--t0);font-family:var(--sans);display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px;min-height:100vh;gap:0}
.logo{font-family:var(--mono);font-size:11px;letter-spacing:.15em;color:var(--t2);text-transform:uppercase;margin-bottom:32px;display:flex;align-items:center;gap:10px}
.logo-mark{width:32px;height:32px;border-radius:8px;background:linear-gradient(135deg,var(--amber),#c07020);display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;color:#000}
.heading{font-family:var(--mono);font-size:clamp(28px,8vw,42px);font-weight:700;color:var(--t0);letter-spacing:.04em;text-align:center;margin-bottom:6px}
.sub{font-family:var(--mono);font-size:12px;color:var(--t2);letter-spacing:.08em;text-align:center;margin-bottom:36px}
.exp-banner{background:rgba(232,72,72,.1);border:1px solid rgba(232,72,72,.25);color:var(--red);font-family:var(--mono);font-size:12px;letter-spacing:.04em;padding:10px 16px;border-radius:8px;margin-bottom:20px;text-align:center;width:100%;max-width:340px}
.card{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:28px 24px;width:100%;max-width:340px}
.pin-label{font-family:var(--mono);font-size:10px;font-weight:500;letter-spacing:.12em;text-transform:uppercase;color:var(--t2);margin-bottom:10px;display:block}
.pin-input{width:100%;padding:18px 16px;border-radius:10px;border:2px solid var(--border);background:#080f18;color:var(--t0);font-family:var(--mono);font-size:28px;font-weight:700;letter-spacing:.2em;text-align:center;outline:none;-webkit-appearance:none;transition:border-color .15s;margin-bottom:20px}
.pin-input:focus{border-color:var(--cyan)}
.pin-input::placeholder{color:var(--t2);letter-spacing:.1em;font-size:20px}
.sign-btn{width:100%;padding:18px;border-radius:12px;border:none;background:linear-gradient(135deg,var(--cyan),#18a0ae);color:#000;font-family:var(--mono);font-size:15px;font-weight:700;letter-spacing:.08em;cursor:pointer;touch-action:manipulation;transition:opacity .15s,transform .1s;-webkit-tap-highlight-color:transparent}
.sign-btn:active{opacity:.85;transform:scale(.98)}
.sign-btn:disabled{opacity:.4;cursor:not-allowed}
.err-msg{display:none;margin-top:14px;color:var(--red);font-family:var(--mono);font-size:12px;letter-spacing:.04em;text-align:center}
.err-msg.show{display:block}
.hint{font-family:var(--mono);font-size:10px;color:var(--t2);text-align:center;margin-top:20px;letter-spacing:.04em}
@keyframes fadeUp{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
.logo{animation:fadeUp .3s ease both}
.heading{animation:fadeUp .3s .06s ease both}
.sub{animation:fadeUp .3s .1s ease both}
.card{animation:fadeUp .3s .14s ease both}
</style></head><body>
<div class="logo"><div class="logo-mark">W</div>WESBELL DISPATCH</div>
<div class="heading">DOCK LOGIN</div>
<div class="sub">ENTER YOUR DOCK PIN</div>
${expiredHtml}
<div class="card">
  <label class="pin-label" for="pin">PIN</label>
  <input id="pin" class="pin-input" type="password" inputmode="numeric" placeholder="- - - -" autocomplete="current-password" maxlength="12"/>
  <button class="sign-btn" id="go">SIGN IN</button>
  <div class="err-msg" id="em"></div>
</div>
<div class="hint">Contact management if you need a PIN.</div>
<script>
(function(){
  var btn=document.getElementById("go"),pin=document.getElementById("pin"),em=document.getElementById("em");
  function doLogin(){
    var p=pin.value.trim();
    if(!p){em.textContent="Enter your PIN.";em.classList.add("show");return;}
    btn.disabled=true;btn.textContent="SIGNING IN...";em.classList.remove("show");
    fetch("/api/login",{method:"POST",headers:{"Content-Type":"application/json","X-Requested-With":"XMLHttpRequest"},body:JSON.stringify({role:"dock",pin:p})})
    .then(function(r){if(!r.ok){r.text().then(function(t){em.textContent=t;em.classList.add("show");});return;}location.href="/dock";})
    .catch(function(){em.textContent="Connection error.";em.classList.add("show");})
    .finally(function(){btn.disabled=false;btn.textContent="SIGN IN";});
  }
  btn.addEventListener("click",doLogin);
  pin.addEventListener("keydown",function(e){if(e.key==="Enter")doLogin();});
  pin.focus();
})();
</script></body></html>`);
  }

  // ── DISPATCHER / MANAGEMENT / ADMIN: full dashboard login ────────────────
  const roleOptions = isSup
    ? '<option value="management" selected>Management</option><option value="admin">&#9889; Admin</option>'
    : '<option value="dispatcher" selected>Dispatcher</option><option value="dock">Dock</option><option value="management">Management</option><option value="admin">&#9889; Admin</option>';

  const expiredBanner = expired
    ? '<div class="ctx-badge ctx-err">&#9888; Session expired &#8212; please sign in again.</div>'
    : "";

  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(`<!doctype html><html lang="en"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover"/>
<title>Wesbell Dispatch</title>
<script>if("serviceWorker"in navigator){navigator.serviceWorker.getRegistrations().then(rs=>rs.forEach(r=>r.unregister()));}</script>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=DM+Mono:wght@400;500&family=DM+Sans:wght@400;500;600&display=swap" rel="stylesheet"/>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#070a0f;--s0:#0c1018;--s1:#101620;
  --b0:#1a2535;--b1:#1f2e42;
  --t0:#e8eef8;--t1:#8a9db8;--t2:#4a5e78;--t3:#293848;
  --amber:#f0a030;--amber-d:#c07020;
  --cyan:#20c0d0;--green:#20d090;--red:#e84848;
  --mono:"DM Mono",monospace;--sans:"DM Sans",system-ui,sans-serif;--display:"Bebas Neue",sans-serif;
}
html{height:100%;-webkit-font-smoothing:antialiased}
body{min-height:100vh;background:var(--bg);color:var(--t0);font-family:var(--sans);display:grid;grid-template-columns:1fr 380px;overflow:hidden}
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
.wm span{color:var(--t1)}
.cal-wrap{flex:1;position:relative;z-index:1}
.cal-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px}
.cal-month{font-family:var(--display);font-size:clamp(20px,2.5vw,30px);color:var(--t1);letter-spacing:.06em}
.cal-year{font-family:var(--mono);font-size:12px;color:var(--t2);letter-spacing:.08em}
.cal-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:4px}
.cal-dow{font-family:var(--mono);font-size:9px;letter-spacing:.08em;color:var(--t3);text-align:center;padding:3px 0 7px;text-transform:uppercase}
.cal-cell{aspect-ratio:1;display:flex;align-items:center;justify-content:center;font-family:var(--mono);font-size:clamp(10px,1.1vw,12px);color:var(--t2);border-radius:5px}
.cal-cell.other{color:var(--t3)}
.cal-cell.today{background:var(--amber);color:#000;font-weight:700;box-shadow:0 2px 10px rgba(240,160,48,.35)}
.db-footer{position:relative;z-index:1;display:flex;align-items:center;gap:8px;margin-top:20px;padding-top:14px;border-top:1px solid var(--b0)}
.live-dot{width:5px;height:5px;border-radius:50%;background:var(--green);box-shadow:0 0 6px var(--green);animation:beat 2.4s ease-in-out infinite}
@keyframes beat{0%,100%{box-shadow:0 0 0 0 rgba(32,208,144,.6)}50%{box-shadow:0 0 0 5px rgba(32,208,144,0)}}
.footer-txt{font-family:var(--mono);font-size:10px;color:var(--t2);letter-spacing:.06em}
/* ── Login Panel ── */
.login-panel{position:relative;z-index:1;display:flex;flex-direction:column;justify-content:flex-start;padding:40px 40px 36px;padding-top:max(40px,env(safe-area-inset-top,40px));background:var(--s0);overflow-y:auto}
.lp-brand{display:flex;align-items:center;gap:10px;margin-bottom:32px}
.lp-mark{width:36px;height:36px;border-radius:9px;background:linear-gradient(135deg,var(--amber),var(--amber-d));display:flex;align-items:center;justify-content:center;font-family:var(--mono);font-size:13px;font-weight:700;color:#000;box-shadow:0 3px 12px rgba(240,120,0,.25);flex-shrink:0}
.lp-name{font-family:var(--mono);font-size:12px;font-weight:600;letter-spacing:.1em;color:var(--t1)}
.lp-sub2{font-size:9px;color:var(--t2);letter-spacing:.08em;margin-top:1px}
.lp-heading{font-family:var(--display);font-size:36px;color:var(--t0);letter-spacing:.04em;margin-bottom:4px}
.lp-tagline{font-family:var(--mono);font-size:11px;color:var(--t2);letter-spacing:.06em;margin-bottom:28px}
.ctx-badge{padding:8px 12px;border-radius:6px;font-family:var(--mono);font-size:11px;letter-spacing:.04em;margin-bottom:14px}
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
  body{grid-template-columns:1fr;grid-template-rows:auto 1fr;overflow-y:auto;height:auto;min-height:100vh}
  .dashboard{padding:20px 20px 16px;border-right:none;border-bottom:1px solid var(--b0);flex-direction:row;flex-wrap:wrap;align-items:center;gap:12px 20px}
  .db-brand{margin-bottom:0;flex:1 0 auto}
  .clock-wrap{order:-1;flex:0 0 100%;margin-bottom:0}
  .clock-time{font-size:clamp(48px,14vw,72px)}
  .clock-secs{display:none}
  .date-row{flex:0 0 100%;margin-bottom:0}
  .divider{display:none}
              .cal-wrap{display:none}
  .db-footer{flex:0 0 100%;margin-top:8px;padding-top:8px}
  .login-panel{padding:28px 20px max(28px,env(safe-area-inset-bottom,28px));justify-content:flex-start}
  .lp-brand{margin-bottom:20px}
}
@media(max-width:480px){
  .dashboard{padding:14px 16px 12px;gap:8px 16px}
  .clock-time{font-size:clamp(40px,16vw,60px)}
    .login-panel{padding:20px 16px max(24px,env(safe-area-inset-bottom,24px))}
  .lp-brand{margin-bottom:16px}
  .lp-heading{font-size:28px}
  .lp-tagline{font-size:10px;margin-bottom:20px}
  .fi{font-size:16px!important;padding:13px 14px}
  .sign-btn{padding:14px;font-size:13px}
}
@keyframes fadeUp{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
.db-brand,.clock-wrap,.date-row,.cal-wrap,.db-footer{animation:fadeUp .3s ease both}
.login-panel{animation:fadeUp .3s .06s ease both}
</style></head><body>
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

  <div class="cal-wrap" id="cal"></div>
  <div class="db-footer"><div class="live-dot"></div><div class="footer-txt" id="ft">WESBELL DISPATCH</div></div>
</div>
<div class="login-panel">
  <div class="lp-brand">
    <div class="lp-mark">W</div>
    <div><div class="lp-name">WESBELL</div><div class="lp-sub2">DISPATCH</div></div>
  </div>
  <div class="lp-heading">SIGN IN</div>
  <div class="lp-tagline">ENTER YOUR ROLE &amp; PIN TO CONTINUE</div>
  ${expiredBanner}
  <label class="fl" for="role">Role</label>
  <select id="role" class="fi">${roleOptions}</select>
  <label class="fl" for="pin">PIN</label>
  <input id="pin" class="fi" type="password" inputmode="numeric" placeholder="&bull;&bull;&bull;&bull;&bull;&bull;" autocomplete="current-password"/>
  <div class="err-msg" id="em"></div>
  <button class="sign-btn" id="go"><span id="btn-lbl">SIGN IN</span><span class="arrow">&rarr;</span></button>
  <div class="lp-hint">Contact management if you need a PIN.</div>
</div>
<script>
(function(){
  var DAYS=["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
  var MONTHS=["January","February","March","April","May","June","July","August","September","October","November","December"];
  var now=new Date();
  function tick(){var n=new Date(),h=n.getHours(),m=n.getMinutes(),s=n.getSeconds(),ap=h>=12?"PM":"AM";h=h%12||12;document.getElementById("ch").textContent=String(h).padStart(2,"0");document.getElementById("cm").textContent=String(m).padStart(2,"0");document.getElementById("cs").textContent=String(s).padStart(2,"0");document.getElementById("ca").textContent=ap;}
  tick();setInterval(tick,1000);
  document.getElementById("dd").textContent=DAYS[now.getDay()];
  document.getElementById("df").textContent=MONTHS[now.getMonth()]+" "+now.getDate()+", "+now.getFullYear();
  document.getElementById("ft").textContent="WESBELL DISPATCH \u00b7 "+DAYS[now.getDay()].toUpperCase();
  (function(){var y=now.getFullYear(),mo=now.getMonth(),first=new Date(y,mo,1).getDay(),dim=new Date(y,mo+1,0).getDate(),dipm=new Date(y,mo,0).getDate(),c="",i,d;
  c+='<div class="cal-head"><span class="cal-month">'+MONTHS[mo].toUpperCase()+'</span><span class="cal-year">'+y+'</span></div><div class="cal-grid">';
  ["SU","MO","TU","WE","TH","FR","SA"].forEach(function(x){c+='<div class="cal-dow">'+x+'</div>';});
  for(i=first-1;i>=0;i--)c+='<div class="cal-cell other">'+(dipm-i)+'</div>';
  for(d=1;d<=dim;d++)c+='<div class="cal-cell'+(d===now.getDate()?" today":"")+'" >'+d+'</div>';
  var rem=(first+dim)%7===0?0:7-(first+dim)%7;for(d=1;d<=rem;d++)c+='<div class="cal-cell other">'+d+'</div>';
  c+='</div>';document.getElementById("cal").innerHTML=c;})();
      var ROLE_HOME={dispatcher:"/",admin:"/",dock:"/dock",management:"/management"};
  var btn=document.getElementById("go"),lbl=document.getElementById("btn-lbl"),em=document.getElementById("em");
  function doLogin(){
    var role=document.getElementById("role").value,pin=document.getElementById("pin").value;
    if(!pin){em.textContent="Enter your PIN.";em.classList.add("show");return;}
    btn.disabled=true;lbl.textContent="SIGNING IN...";em.classList.remove("show");
    fetch("/api/login",{method:"POST",headers:{"Content-Type":"application/json","X-Requested-With":"XMLHttpRequest"},body:JSON.stringify({role:role,pin:pin})})
    .then(function(r){if(!r.ok){r.text().then(function(t){em.textContent=t;em.classList.add("show");});return;}location.href=ROLE_HOME[role]||"/";})
    .catch(function(){em.textContent="Connection error. Try again.";em.classList.add("show");})
    .finally(function(){btn.disabled=false;lbl.textContent="SIGN IN";});
  }
  btn.addEventListener("click",doLogin);
  document.getElementById("pin").addEventListener("keydown",function(e){if(e.key==="Enter")doLogin();});
  document.getElementById("pin").focus();
})();
</script></body></html>`);
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
// Rate limiting removed — no lockout

app.post("/api/login", requireXHR, async (req, res) => {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
  if (!checkLoginRate(ip)) return res.status(429).send("Too many login attempts. Try again in a minute.");
  try {
    const role = String(req.body.role || "").toLowerCase();
    const pin  = String(req.body.pin  || "");
    if (!["dispatcher","dock","management","admin"].includes(role)) return res.status(400).send("Invalid role");
    if (pin.length < PIN_MIN_LEN) return res.status(400).send("PIN too short");
    const ok = await verifyPin(role, pin);
    await audit(req, role, ok ? "login_success" : "login_failed", "auth", role, {});
    if (!ok) return res.status(401).send("Invalid PIN");
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
app.get("/api/state", async (req, res) => {
  try {
    const data = await getTrailersCache();
    const etag = `"${crypto.createHash("md5").update(JSON.stringify(data)).digest("hex").slice(0,8)}"`;
    if (req.headers["if-none-match"] === etag) return res.status(304).end();
    res.setHeader("ETag", etag);
    res.setHeader("Cache-Control", "no-cache");
    res.json(data);
  } catch(e) { res.status(500).send("State error"); }
});

app.post("/api/upsert", requireXHR, requireDockStatusAllowed, async (req, res) => {
  const actor = req.user?.role || req.session?.role || "unknown";
  try {
    const trailer = String(req.body.trailer || "").trim().toUpperCase();
    if (!trailer) return res.status(400).send("Missing trailer");
    if (trailer.length > 20) return res.status(400).send("Trailer number too long");
    if (!/^[A-Z0-9\-_. ]+$/.test(trailer)) return res.status(400).send("Invalid trailer number");

    const existing = await get(`SELECT * FROM trailers WHERE trailer=?`, [trailer]);
    const now = Date.now();

    const direction   = req.body.direction   !== undefined ? String(req.body.direction   || "").trim() : (existing?.direction   || "");
    const status      = req.body.status      !== undefined ? String(req.body.status      || "").trim() : (existing?.status      || "");
    const door        = req.body.door        !== undefined ? String(req.body.door        || "").trim() : (existing?.door        || "");
    const note        = req.body.note        !== undefined ? String(req.body.note        || "").trim().slice(0,200) : (existing?.note        || "");
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

    const doorAt = (door && door !== existing?.door) ? now : (existing?.doorAt || null);
    await run(
      `INSERT INTO trailers(trailer,direction,status,door,note,dropType,carrierType,updatedAt,doorAt)
       VALUES(?,?,?,?,?,?,?,?,?)
       ON CONFLICT(trailer) DO UPDATE SET
         direction=excluded.direction, status=excluded.status, door=excluded.door,
         note=excluded.note, dropType=excluded.dropType, carrierType=excluded.carrierType,
         updatedAt=excluded.updatedAt, doorAt=COALESCE(trailers.doorAt,excluded.doorAt)`,
      [trailer, direction, finalStatus, door, note, dropType, carrierType, now, doorAt]
    );

    await audit(req, actor, existing ? "trailer_update" : "trailer_create", "trailer", trailer, { direction, status: finalStatus, door, dropType, note });
    if (req.body.status !== undefined || isDriverDrop) await audit(req, actor, "trailer_status_set", "trailer", trailer, { status: finalStatus });

    if (finalStatus !== (existing?.status)) {
      if (finalStatus === "Ready") {
        wsBroadcast("notify", { kind: "ready", trailer, door: door || "" });
        broadcastPush("🟢 Trailer Ready", `Trailer ${trailer} is ready${door ? " at door " + door : ""}`, { trailer, door }).catch(() => {});
        fireWebhook("trailer.ready", { trailer, door, actor });
      } else if (finalStatus === "Dock Ready") {
        fireWebhook("trailer.dock_ready", { trailer, door, actor });
      } else if (finalStatus === "Departed") {
        fireWebhook("trailer.departed", { trailer, door, actor });
      } else if (finalStatus === "Loading") {
        fireWebhook("trailer.loading", { trailer, door, actor });
      }
    }
    await logEvent("info", "upsert", `${actor} set ${trailer} → ${finalStatus}`, `door=${door||"—"}`);
    await broadcastTrailers();
    res.json({ ok: true });
  } catch (e) {
  console.error("[/api/upsert] failed:", e);
  return res.status(500).json({
    ok: false,
    error: String(e && (e.message || e) || "unknown error")
  });
}
});

app.post("/api/delete", requireXHR, requireRole(["dispatcher","management","admin"]), async (req, res) => {
  const actor = req.user?.role || req.session?.role || "unknown";
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
  const actor = req.user?.role || req.session?.role || "unknown";
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
// Door occupancy block — mark a door occupied without a trailer
app.get("/api/doorblocks", async (req, res) => { try { res.json(await loadDoorBlocksObject()); } catch(e) { res.status(500).send("Doorblocks error"); } });

app.post("/api/doorblock/set", requireXHR, requireRole(["dock","dispatcher","management","admin"]), async (req, res) => {
  try {
    const door = String(req.body.door || "");
    const note = String(req.body.note || "").slice(0, 120);
    if (!door || isNaN(parseInt(door)) || parseInt(door)<28 || parseInt(door)>42) return res.status(400).send("Invalid door");
    await run(`INSERT INTO doorblocks(door,note,setAt) VALUES(?,?,?) ON CONFLICT(door) DO UPDATE SET note=excluded.note,setAt=excluded.setAt`,
      [door, note, Date.now()]);
    const actor = req.session?.role || "unknown";
    await audit(req, actor, "doorblock_set", "doorblock", door, { note });
    await broadcastBlocks();
    res.json({ ok: true });
  } catch(e) { res.status(500).send("Doorblock set failed"); }
});

app.post("/api/doorblock/clear", requireXHR, requireRole(["dock","dispatcher","management","admin"]), async (req, res) => {
  try {
    const door = String(req.body.door || "");
    if (!door) return res.status(400).send("Missing door");
    await run(`DELETE FROM doorblocks WHERE door=?`, [door]);
    const actor = req.session?.role || "unknown";
    await audit(req, actor, "doorblock_clear", "doorblock", door, {});
    await broadcastBlocks();
    res.json({ ok: true });
  } catch(e) { res.status(500).send("Doorblock clear failed"); }
});

app.get("/api/dockplates", async (req, res) => { try { res.json(await loadDockPlatesObject()); } catch(e) { res.status(500).send("Plates error"); } });

app.post("/api/dockplates/set", requireXHR, requireRole(["dock","dispatcher","management","admin"]), async (req, res) => {
  try {
    const actor  = req.user?.role || req.session?.role || "unknown";
    const door   = String(req.body.door   || "").trim();
    const status = String(req.body.status || "Unknown").trim();
    const note   = String(req.body.note   || "").trim();
    const dNum = Number(door);
    if (!Number.isFinite(dNum) || dNum < 28 || dNum > 42) return res.status(400).send("Invalid door");
    if (!["OK","Service","Out of Order","Unknown"].includes(status)) return res.status(400).send("Invalid plate status");
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
// ── On My Way — Wesbell driver notifies they're inbound, gets a door immediately ──
app.post("/api/driver/omw", requireXHR, async (req, res) => {
  try {
    const trailer = String(req.body.trailer || "").trim().toUpperCase();
    const eta     = parseInt(req.body.eta) || null;
    if (!trailer) return res.status(400).send("Missing trailer number");
    if (trailer.length > 20) return res.status(400).send("Trailer number too long");

    const existing = await get(`SELECT * FROM trailers WHERE trailer=?`, [trailer]);
    const ACTIVE   = ["Incoming","Dropped","Loading","Dock Ready","Ready"];

    // Already active — return current assignment
    if (existing && ACTIVE.includes(existing.status)) {
      return res.json({ ok: true, door: existing.door || "", alreadyActive: true, status: existing.status });
    }

    // Pick best available door respecting blocks, dockplates, existing reservations
    const assignedDoor = await pickBestDoor(trailer);
    if (!assignedDoor) return res.status(409).send("No doors available right now. Please ask dispatch.");

    // Reserve the door — auto-expires in 30 min if driver never drops
    await reserveDoor(assignedDoor, trailer, "Wesbell");

    const note = eta ? `ETA ~${eta} min` : "On my way";
    const now  = Date.now();

    await run(
      `INSERT INTO trailers(trailer,direction,status,door,note,dropType,carrierType,updatedAt,omwAt,omwEta)
       VALUES(?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(trailer) DO UPDATE SET
         direction=excluded.direction, status=excluded.status, door=excluded.door,
         note=excluded.note, dropType=excluded.dropType, carrierType=excluded.carrierType,
         updatedAt=excluded.updatedAt, omwAt=excluded.omwAt, omwEta=excluded.omwEta`,
      [trailer, "Inbound", "Incoming", assignedDoor, note, "Loaded", "Wesbell", now, now, eta]
    );

    await audit(req, "driver", "omw", "trailer", trailer, { door: assignedDoor, eta });
    await broadcastTrailers();
    // Push notification to dispatcher
    broadcastPush("🚛 Driver On My Way", `Trailer ${trailer} → Door ${assignedDoor}${eta ? ` · ETA ~${eta} min` : ""}`, { type: "omw", trailer, door: assignedDoor });
    wsBroadcast("omw", { trailer, door: assignedDoor, eta, at: now });
    fireWebhook("driver.omw", { trailer, door: assignedDoor, eta });
    res.json({ ok: true, door: assignedDoor, alreadyActive: false });
  } catch (e) { console.error("[omw]", e); res.status(500).send("OMW failed"); }
});

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

// ── QR Scan Arrival — any driver scans QR on arrival, gets a door ──
// ── Available doors — for driver door picker ──
app.get("/api/available-doors", async (req, res) => {
  try {
    const excludeTrailer = String(req.query.trailer || "").trim().toUpperCase() || null;
    const occupiedSet = await getOccupiedDoorSet(excludeTrailer);
    const plates = await all(`SELECT door, status FROM dockplates`);
    const plateMap = {};
    plates.forEach(p => { plateMap[String(p.door)] = p.status; });
    const doors = [];
    for (let d = 28; d <= 42; d++) {
      const ds = String(d);
      const plateStatus = plateMap[ds] || "Unknown";
      if (plateStatus === "Out of Order") continue;
      doors.push({
        door: ds,
        available: !occupiedSet.has(ds),
        plateStatus,
      });
    }
    res.json({ doors });
  } catch (e) { res.status(500).send("Available doors error"); }
});

app.post("/api/driver/arrive", requireXHR, async (req, res) => {
  try {
    const trailer     = String(req.body.trailer     || "").trim().toUpperCase();
    const carrierType = String(req.body.carrierType || "Outside").trim();
    const dropType    = String(req.body.dropType    || "Loaded").trim();
    const direction   = String(req.body.direction   || "Inbound").trim();

    if (!trailer) return res.status(400).send("Missing trailer number");
    if (trailer.length > 20) return res.status(400).send("Trailer number too long");

    const existing = await get(`SELECT * FROM trailers WHERE trailer=?`, [trailer]);
    const ACTIVE   = ["Incoming","Dropped","Loading","Dock Ready","Ready"];

    // If Wesbell driver already has OMW reservation, confirm that door
    if (existing && ACTIVE.includes(existing.status) && existing.door) {
      // Release the reservation since they've arrived
      await releaseReservation(trailer);
      return res.json({ ok: true, door: existing.door, alreadyActive: true, status: existing.status });
    }

    // Pick best available door
    const assignedDoor = await pickBestDoor(trailer);
    if (!assignedDoor) return res.status(409).send("No doors available. Please ask dispatch.");

    // Reserve with 30-min TTL in case they never drop
    await reserveDoor(assignedDoor, trailer, carrierType);

    const now = Date.now();
    await run(
      `INSERT INTO trailers(trailer,direction,status,door,note,dropType,carrierType,updatedAt,doorAt)
       VALUES(?,?,?,?,?,?,?,?,?)
       ON CONFLICT(trailer) DO UPDATE SET
         direction=excluded.direction, status=excluded.status, door=excluded.door,
         dropType=excluded.dropType, carrierType=excluded.carrierType, updatedAt=excluded.updatedAt,
         doorAt=excluded.doorAt`,
      [trailer, direction, "Incoming", assignedDoor, "", dropType, carrierType, now, now]
    );

    await audit(req, "driver", "arrive", "trailer", trailer, { door: assignedDoor, carrierType });
    broadcastPush("✅ Driver Arrived", `Trailer ${trailer} at Door ${assignedDoor}`, { type: "arrive", trailer, door: assignedDoor });
    wsBroadcast("arrive", { trailer, door: assignedDoor, at: now });
    fireWebhook("driver.arrived", { trailer, door: assignedDoor });
    await broadcastTrailers();
    res.json({ ok: true, door: assignedDoor, alreadyActive: false });
  } catch (e) { console.error("[arrive]", e); res.status(500).send("Arrival failed"); }
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
      if (!Number.isFinite(dNum) || dNum < 28 || dNum > 42) return res.status(400).send("Invalid door (28–42)");
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

    // No auto-assign — dispatcher assigns door manually
    let assignedDoor = door || "";

    // Driver drops always land as Incoming
    await run(
      `INSERT INTO trailers(trailer,direction,status,door,note,dropType,carrierType,updatedAt)
       VALUES(?,?,?,?,?,?,?,?)
       ON CONFLICT(trailer) DO UPDATE SET
         direction=excluded.direction, status=excluded.status, door=excluded.door,
         dropType=excluded.dropType, carrierType=excluded.carrierType, updatedAt=excluded.updatedAt`,
      [trailer, direction, "Incoming", assignedDoor || "", existing?.note || "", dropType, carrierType, now]
    );

    // Release door reservation — driver has physically arrived and dropped
    await releaseReservation(trailer);
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
    if (!Number.isFinite(dNum) || dNum < 28 || dNum > 42) return res.status(400).send("Invalid door (28–42)");
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
    if (!Number.isFinite(dNum) || dNum < 28 || dNum > 42) return res.status(400).send("Invalid door (28–42)");
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

app.get("/api/shift-summary", requireRole(["dispatcher","management","admin"]), async (req, res) => {
  try {
    const hours = parseInt(req.query.hours) || 12;
    const since = Date.now() - hours * 3600 * 1000;
    const events = await all(`SELECT * FROM audit WHERE at > ? ORDER BY at DESC LIMIT 500`, [since]);
    const trailerRows = await all(`SELECT * FROM trailers`);
    const active = trailerRows.filter(r => !["Departed",""].includes(r.status||""));
    const departed = trailerRows.filter(r => r.status === "Departed");
    const byStatus = {};
    events.filter(e => e.action === "trailer_status_set").forEach(e => {
      try { const dd = JSON.parse(e.details||"{}"); byStatus[dd.status] = (byStatus[dd.status]||0)+1; } catch{}
    });
    const issues = await all(`SELECT id,at,trailer,door,note FROM issue_reports WHERE at > ? ORDER BY at DESC`, [since]);
    res.json({
      hours, since,
      active: active.length, departed: departed.length, total: trailerRows.length,
      byStatus,
      issues: issues.length,
      confirmations: events.filter(e=>e.action==="confirm_safety").length,
      omw: events.filter(e=>e.action==="omw").length,
      arrivals: events.filter(e=>e.action==="arrive").length,
      issueList: issues,
      recentEvents: events.slice(0,60).map(e=>({
        at:e.at, action:e.action, actor:e.actorRole, entity:e.entityId,
        details: (()=>{try{return JSON.parse(e.details||"{}");}catch{return {};}})()
      }))
    });
  } catch(e){ console.error("[shift-summary]",e); res.status(500).send("Failed"); }
});


/* ══════════════════════════════════════════
   HEALTH CHECK
══════════════════════════════════════════ */
app.get("/health", async (req, res) => {
  try {
    await get("SELECT 1");
    const mem = process.memoryUsage();
    res.json({
      status: "ok",
      version: APP_VERSION,
      uptime: Math.floor(process.uptime()),
      db: DB_FILE,
      memory: { rss: Math.round(mem.rss/1024/1024) + "MB", heap: Math.round(mem.heapUsed/1024/1024) + "MB" },
      wsClients: wss?.clients?.size || 0,
      sessions: sessions.size,
    });
  } catch(e) { res.status(503).json({ status: "error", error: e.message }); }
});

/* ══════════════════════════════════════════
   SERVER LOGS
══════════════════════════════════════════ */
app.get("/api/logs", requireRole(["admin"]), async (req, res) => {
  try {
    const rows = await all(`SELECT * FROM logs ORDER BY at DESC LIMIT 200`);
    res.json(rows);
  } catch(e) { res.status(500).send("Failed"); }
});

/* ══════════════════════════════════════════
   CSV EXPORT
══════════════════════════════════════════ */
app.get("/api/export/trailers.csv", requireRole(["dispatcher","management","admin"]), async (req, res) => {
  try {
    const rows = await all(`SELECT * FROM trailers ORDER BY updatedAt DESC`);
    const headers = ["trailer","direction","status","door","note","dropType","carrierType","updatedAt","doorAt","omwAt","omwEta"];
    const fmt = v => v == null ? "" : String(v).replace(/"/g, '""');
    const csv = [
      headers.join(","),
      ...rows.map(r => headers.map(h => `"${fmt(r[h])}"`).join(","))
    ].join("\n");
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="trailers-${new Date().toISOString().slice(0,10)}.csv"`);
    res.send(csv);
  } catch(e) { res.status(500).send("Export failed"); }
});

app.get("/api/export/audit.csv", requireRole(["management","admin"]), async (req, res) => {
  try {
    const hours = parseInt(req.query.hours) || 24;
    const since = Date.now() - hours * 3600000;
    const rows = await all(`SELECT * FROM audit WHERE at > ? ORDER BY at DESC`, [since]);
    const headers = ["id","at","actorRole","action","entityType","entityId","details","ip"];
    const fmt = v => v == null ? "" : String(v).replace(/"/g, '""');
    const csv = [
      headers.join(","),
      ...rows.map(r => headers.map(h => `"${fmt(r[h])}"`).join(","))
    ].join("\n");
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="audit-${new Date().toISOString().slice(0,10)}.csv"`);
    res.send(csv);
  } catch(e) { res.status(500).send("Export failed"); }
});

/* ══════════════════════════════════════════
   WEBHOOK SUPPORT
══════════════════════════════════════════ */
const WEBHOOK_URL = process.env.WEBHOOK_URL || "";
async function fireWebhook(event, data) {
  if (!WEBHOOK_URL) return;
  try {
    const body = JSON.stringify({ event, data, at: Date.now(), source: "wesbell-dispatch" });
    const url = new URL(WEBHOOK_URL);
    const mod = url.protocol === "https:" ? require("https") : require("http");
    await new Promise((resolve, reject) => {
      const req = mod.request(WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
      }, res => { res.resume(); resolve(); });
      req.on("error", reject);
      req.setTimeout(5000, () => req.destroy());
      req.write(body); req.end();
    });
  } catch(e) { logEvent("warn","webhook",`Webhook failed for ${event}`, e.message); }
}

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
  const actor = req.user?.role || req.session?.role || "unknown";
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
      await releaseReservation(trailer); // free the door reservation on departure
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
  ws.on("error", () => {}); // absorb socket errors, prevent crash
  const safeSend = msg => { try { if (ws.readyState === WebSocket.OPEN) ws.send(msg); } catch {} };

  // Heartbeat — ping every 20s to keep connection alive through Render / reverse-proxy idle timeouts
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });
  ws.on("message", () => { ws.isAlive = true; });
  const heartbeat = setInterval(() => {
    if (!ws.isAlive) { clearInterval(heartbeat); try { ws.terminate(); } catch {} return; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
    safeSend(JSON.stringify({ type: "ping" })); // JSON keepalive so client watchdog resets
  }, 20000);
  ws.on("close", () => clearInterval(heartbeat));

  try { safeSend(JSON.stringify({ type: "version",       payload: { version: APP_VERSION } })); } catch {}
  try { safeSend(JSON.stringify({ type: "state",         payload: await loadTrailersObject() })); } catch {}
  try { safeSend(JSON.stringify({ type: "dockplates",    payload: await loadDockPlatesObject() })); } catch {}
  try { safeSend(JSON.stringify({ type: "doorblocks",    payload: await loadDoorBlocksObject() })); } catch {}
  try { safeSend(JSON.stringify({ type: "confirmations", payload: await loadConfirmations(250) })); } catch {}
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

    // ── Auto-archive departed trailers older than 24h ──────────────────────
    async function archiveDeparted() {
      try {
        const cutoff = Date.now() - 24 * 3600 * 1000;
        const res = await run(`DELETE FROM trailers WHERE status='Departed' AND updatedAt < ?`, [cutoff]);
        if (res.changes > 0) {
          invalidateTrailers();
          await broadcastTrailers();
          await logEvent("info","archive",`Auto-archived ${res.changes} departed trailers`);
          console.log(`[ARCHIVE] Removed ${res.changes} old departed trailers`);
        }
      } catch(e) { logEvent("error","archive","Auto-archive failed", e.message); }
    }
    setInterval(archiveDeparted, 3600 * 1000); // every hour
    archiveDeparted(); // run once on startup

    // ── Hourly SQLite backup ───────────────────────────────────────────────
    async function backupDb() {
      try {
        const backupDir = path.dirname(DB_FILE);
        const backupFile = path.join(backupDir, "wesbell-backup.sqlite");
        // Use SQLite backup API via file copy (safe with WAL)
        db.run("PRAGMA wal_checkpoint(TRUNCATE)");
        fs.copyFileSync(DB_FILE, backupFile);
        await logEvent("info","backup","DB backup completed", backupFile);
        console.log(`[BACKUP] DB backed up to ${backupFile}`);
      } catch(e) { logEvent("error","backup","DB backup failed", e.message); console.error("[BACKUP]", e.message); }
    }
    setInterval(backupDb, 3600 * 1000); // every hour

    // ── Graceful shutdown ──────────────────────────────────────────────────
    let shuttingDown = false;
    async function gracefulShutdown(signal) {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`[SHUTDOWN] ${signal} received — closing gracefully`);
      await logEvent("info","shutdown",`Server shutting down (${signal})`).catch(()=>{});
      // Close WebSocket connections
      for (const client of wss.clients) {
        try { client.close(1001, "Server shutting down"); } catch {}
      }
      // Stop accepting new connections
      server.close(() => {
        db.close(() => {
          console.log("[SHUTDOWN] Complete");
          process.exit(0);
        });
      });
      // Force exit after 10s
      setTimeout(() => { console.error("[SHUTDOWN] Forced exit"); process.exit(1); }, 10000);
    }
    process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
    process.on("SIGINT",  () => gracefulShutdown("SIGINT"));

    // ── WebSocket dead client cleanup ──────────────────────────────────────
    setInterval(() => {
      for (const client of wss.clients) {
        if (client.readyState === WebSocket.CLOSING || client.readyState === WebSocket.CLOSED) {
          try { client.terminate(); } catch {}
        }
      }
    }, 30000);

  })
  .catch(e => { console.error("DB init failed:", e); process.exit(1); });
