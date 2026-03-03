// server.js — Wesbell Dispatch v3.2.0
const express = require("express");
const http = require("http");
const path = require("path");
const WebSocket = require("ws");
const sqlite3 = require("sqlite3").verbose();
const crypto = require("crypto");

const app = express();
app.use(express.json({ limit: "200kb" }));
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
  supervisor: process.env.SUPERVISOR_PIN || "",
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
  for (const role of ["dispatcher", "dock", "supervisor", "admin"]) {
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
  if (s && ["dock","dispatcher","supervisor"].includes(s.role)) {
    return res.status(403).send("Driver endpoint — not accessible from this role");
  }
  next();
}

// Dock workers can only advance status through dock-appropriate transitions.
// Dispatchers/admin can do anything. This prevents a dock worker from e.g.
// marking a trailer Ready or Departed by hitting the API directly.
function requireDockStatusAllowed(req, res, next) {
  const s = getSession(req);
  if (!s) return res.status(401).send("Unauthorized");
  if (s.role === "admin" || s.role === "dispatcher") return next();
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
  for (const client of wss.clients)
    if (client.readyState === WebSocket.OPEN) client.send(msg);
}

async function broadcastTrailers()      { invalidateTrailers(); wsBroadcast("state",         await getTrailersCache()); }
async function broadcastPlates()        { invalidatePlates();   wsBroadcast("dockplates",    await getPlatesCache()); }
async function broadcastConfirmations() {                       wsBroadcast("confirmations", await loadConfirmations(250)); }

/* ══════════════════════════════════════════
   STATIC / VIEWS
══════════════════════════════════════════ */
app.use(express.static(path.join(__dirname, "public")));
app.get("/sw.js", (req, res) => {
  res.setHeader("Service-Worker-Allowed", "/");
  res.setHeader("Content-Type", "application/javascript");
  res.sendFile(path.join(__dirname, "sw.js"));
});

const INDEX_FILE = path.join(__dirname, "public", "index.html");
const sendIndex  = (_, res) => res.sendFile(INDEX_FILE);

/* ── ROLE → ALLOWED PATHS ── */
const ROLE_HOME = {
  dispatcher: "/",
  admin:      "/",
  dock:       "/dock",
  supervisor: "/supervisor",
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

    // No session — only /driver is accessible unauthenticated
    if (!role) {
      if (allowedRoles.includes("__driver__")) return next();
      // Authenticated roles hitting /driver → redirect to their home
      return res.redirect(302, "/driver");
    }

    // Logged-in user hitting the wrong page → redirect to their home
    if (!allowedRoles.includes(role)) {
      const home = roleHome(role);
      if (home) return res.redirect(302, home);
      return res.redirect(302, "/");
    }

    next();
  };
}

app.get("/login", (req, res) => {
  const expired  = req.query.expired === "1";
  const fromPath = req.query.from || req.get("Referer") || "";
  
  // Detect context from where they're trying to go
  // /dock?expired=1 → pre-select dock, hide other roles
  // /driver has no login (no session needed for driver view)
  const isDock  = fromPath.includes("/dock");
  const isSup   = fromPath.includes("/supervisor");
  
  // Build role options — dock workers only see "Dock", supervisors see more
  const roleOptions = isDock
    ? `<option value="dock" selected>Dock</option>`
    : isSup
    ? `<option value="supervisor" selected>Supervisor</option><option value="admin">⚡ Admin</option>`
    : `<option value="dispatcher" selected>Dispatcher</option><option value="dock">Dock</option><option value="supervisor">Supervisor</option><option value="admin">⚡ Admin</option>`;

  const contextMsg = isDock
    ? `<div style="padding:8px 10px;border-radius:6px;background:rgba(32,192,208,.08);border:1px solid rgba(32,192,208,.2);color:#20c0d0;font-size:12px;margin-bottom:10px;">🏭 Dock sign-in</div>`
    : isSup
    ? `<div style="padding:8px 10px;border-radius:6px;background:rgba(240,160,48,.08);border:1px solid rgba(240,160,48,.2);color:#f0a030;font-size:12px;margin-bottom:10px;">📊 Supervisor sign-in</div>`
    : "";

  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(`<!doctype html><html><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover"/>
<title>Wesbell Sign In</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0a0d12;color:#e2e8f2;font-family:system-ui,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:16px}
.card{width:100%;max-width:360px;background:#121820;border:1px solid #1a2232;border-radius:14px;padding:22px;box-shadow:0 12px 48px rgba(0,0,0,.7)}
.brand{display:flex;align-items:center;gap:10px;margin-bottom:18px}
.brand-mark{width:32px;height:32px;border-radius:8px;background:linear-gradient(135deg,#f0a030,#c04800);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;color:#000;flex-shrink:0}
.brand-name{font-size:14px;font-weight:600;letter-spacing:.06em}
.brand-sub{font-size:10px;color:#4a5a72;letter-spacing:.06em}
label{display:block;font-size:11px;font-weight:500;text-transform:uppercase;letter-spacing:.08em;margin:14px 0 6px;color:#4a5a72}
input,select{width:100%;padding:13px 14px;border-radius:8px;border:1px solid #213040;background:#0e1218;color:#e2e8f2;font-size:16px;outline:none;-webkit-appearance:none;transition:border-color .15s}
input:focus,select:focus{border-color:#f0a030;box-shadow:0 0 0 3px rgba(240,160,48,.1)}
.err{display:none;padding:9px 12px;border-radius:6px;background:rgba(232,72,72,.1);border:1px solid rgba(232,72,72,.25);color:#e84848;font-size:13px;margin-top:10px}
.err.show{display:block}
button{width:100%;padding:14px;border-radius:10px;border:1px solid rgba(240,160,48,.25);background:rgba(240,160,48,.09);color:#f0a030;font-size:15px;font-weight:700;margin-top:16px;cursor:pointer;touch-action:manipulation;letter-spacing:.03em;transition:background .15s}
button:active{background:rgba(240,160,48,.18)}
.hint{color:#2d3d52;font-size:11px;margin-top:12px;line-height:1.5;text-align:center}
</style></head><body>
<div class="card">
  <div class="brand">
    <div class="brand-mark">W</div>
    <div><div class="brand-name">WESBELL</div><div class="brand-sub">DISPATCH</div></div>
  </div>
  ${contextMsg}
  ${expired ? `<div style="padding:8px 10px;border-radius:6px;background:rgba(232,72,72,.08);border:1px solid rgba(232,72,72,.2);color:#e84848;font-size:12px;margin-bottom:10px;">⚠ Session expired — please sign in again.</div>` : ""}
  <label>Role</label>
  <select id="role">${roleOptions}</select>
  <label>PIN</label>
  <input id="pin" type="password" inputmode="numeric" placeholder="Enter PIN" autocomplete="current-password"/>
  <div class="err" id="errMsg"></div>
  <button id="go">Sign In →</button>
  <div class="hint">Contact your supervisor if you don't have a PIN.</div>
</div>
<script>
const ROLE_HOME = {dispatcher:"/",admin:"/",dock:"/dock",supervisor:"/supervisor"};
const btn = document.getElementById("go");
const err = document.getElementById("errMsg");
async function doLogin() {
  const role = document.getElementById("role").value;
  const pin  = document.getElementById("pin").value;
  if (!pin) { err.textContent = "Enter your PIN."; err.classList.add("show"); return; }
  btn.disabled = true; btn.textContent = "Signing in…";
  err.classList.remove("show");
  try {
    const res = await fetch("/api/login", {
      method:"POST",
      headers:{"Content-Type":"application/json","X-Requested-With":"XMLHttpRequest"},
      body:JSON.stringify({role,pin})
    });
    if (!res.ok) { err.textContent = await res.text(); err.classList.add("show"); return; }
    location.href = ROLE_HOME[role] || "/";
  } catch(e) {
    err.textContent = "Connection error. Try again."; err.classList.add("show");
  } finally {
    btn.disabled = false; btn.textContent = "Sign In →";
  }
}
btn.addEventListener("click", doLogin);
document.getElementById("pin").addEventListener("keydown", e => { if(e.key==="Enter") doLogin(); });
document.getElementById("pin").focus();
</script></body></html>`);
});

app.get("/",           guardPage(["dispatcher","admin"]),          sendIndex);
app.get("/dock",       guardPage(["dock","admin"]),                 sendIndex);
app.get("/driver",     guardPage(["__driver__"]),                   sendIndex);
app.get("/supervisor", guardPage(["supervisor","admin"]),           sendIndex);

/* ══════════════════════════════════════════
   API — AUTH
══════════════════════════════════════════ */
app.get("/api/whoami", (req, res) => {
  const s = getSession(req);
  const role = s?.role || null;
  const redirectTo = role ? (ROLE_HOME[role] || "/") : "/driver";
  res.json({ role, version: APP_VERSION, redirectTo });
});

app.post("/api/login", requireXHR, async (req, res) => {
  try {
    const role = String(req.body.role || "").toLowerCase();
    const pin  = String(req.body.pin  || "");
    if (!["dispatcher","dock","supervisor","admin"].includes(role)) return res.status(400).send("Invalid role");
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

    if (finalStatus === "Ready" && ["dispatcher","supervisor","admin"].includes(actor)) {
      wsBroadcast("notify", { kind: "ready", trailer, door: door || "" });
      broadcastPush("🟢 Trailer Ready", `Trailer ${trailer} is ready${door ? " at door " + door : ""}`, { trailer, door }).catch(() => {});
    }

    await broadcastTrailers();
    res.json({ ok: true });
  } catch (e) { res.status(500).send("Upsert failed"); }
});

app.post("/api/delete", requireXHR, requireRole(["dispatcher","supervisor","admin"]), async (req, res) => {
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

app.post("/api/clear", requireXHR, requireRole(["dispatcher","supervisor","admin"]), async (req, res) => {
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

app.post("/api/dockplates/set", requireXHR, requireRole(["dock","dispatcher","supervisor","admin"]), async (req, res) => {
  const actor = req.user.role;
  try {
    const door   = String(req.body.door   || "").trim();
    const status = String(req.body.status || "Unknown").trim();
    const note   = String(req.body.note   || "").trim();
    const dNum = Number(door);
    if (!Number.isFinite(dNum) || dNum < 18 || dNum > 42) return res.status(400).send("Invalid door");
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

    if (session && !["dispatcher","dock","admin"].includes(session.role))
      return res.status(403).send("Unauthorized");

    const trailer = String(req.body.trailer || "").trim();
    const door    = String(req.body.door    || "").trim();
    if (!trailer) return res.status(400).send("Missing trailer");
    if (!door)    return res.status(400).send("Missing door");

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
app.get("/api/audit", requireRole(["dispatcher","supervisor","admin"]), async (req, res) => {
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
   API — SUPERVISOR PIN MANAGEMENT
══════════════════════════════════════════ */
app.post("/api/supervisor/set-pin", requireXHR, requireRole(["supervisor","admin"]), async (req, res) => {
  const actor = req.user.role;
  try {
    const role = String(req.body.role || "").toLowerCase();
    const pin  = String(req.body.pin  || "");
    if (!["dispatcher","dock","supervisor","admin"].includes(role)) return res.status(400).send("Invalid role");
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
   WEBSOCKET — ON CONNECT
══════════════════════════════════════════ */
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
