const express = require("express");
const http = require("http");
const path = require("path");
const WebSocket = require("ws");
const sqlite3 = require("sqlite3").verbose();
const crypto = require("crypto");
const axios = require("axios");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // for form POST /login
app.use(express.static(__dirname));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

/* =========================
   CONFIG
========================= */
const APP_VERSION = process.env.APP_VERSION || "2.2.0";

const DISPATCHER_PIN = String(process.env.DISPATCHER_PIN || "1234");
const DOCK_PIN = String(process.env.DOCK_PIN || "789");
const LINK_SIGNING_SECRET = String(process.env.LINK_SIGNING_SECRET || "change_me");

/**
 * SQLite path:
 * - local default: ./data.db
 * - Render persistent disk: set DB_PATH=/var/data/data.db
 */
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "data.db");
const db = new sqlite3.Database(DB_PATH);

// In-memory caches
let trailers = {};       // { trailer: {direction,status,door,note,updatedAt} }
let confirmations = [];  // latest first
let dockPlates = {};     // { "18": {status:"OK|Service|Unknown", note:"", updatedAt} }

/* =========================
   GEOTAB LITE (Last GPS)
========================= */
let geotabCreds = null;
let geotabLastAuth = 0;

let geotabPositionsCache = [];
let geotabPositionsLastFetch = 0;

const GEOTAB_CACHE_MS = Number(process.env.GEOTAB_CACHE_MS || 30000);

function geotabConfigured() {
  return !!(
    process.env.GEOTAB_SERVER &&
    process.env.GEOTAB_DB &&
    process.env.GEOTAB_USER &&
    process.env.GEOTAB_PASS
  );
}

async function geotabAuthenticate() {
  if (!geotabConfigured()) throw new Error("Geotab not configured");

  // Re-auth every 30 mins (safe)
  const now = Date.now();
  if (geotabCreds && (now - geotabLastAuth) < (30 * 60 * 1000)) return geotabCreds;

  const serverUrl = String(process.env.GEOTAB_SERVER).replace(/\/+$/, "");
  const database = process.env.GEOTAB_DB;
  const userName = process.env.GEOTAB_USER;
  const password = process.env.GEOTAB_PASS;

  const resp = await axios.post(
    `${serverUrl}/apiv1`,
    { method: "Authenticate", params: { database, userName, password } },
    { timeout: 15000 }
  );

  geotabCreds = resp.data?.result;
  geotabLastAuth = now;

  if (!geotabCreds) throw new Error("Geotab auth failed");
  return geotabCreds;
}

async function geotabGet(typeName, search = null) {
  const serverUrl = String(process.env.GEOTAB_SERVER).replace(/\/+$/, "");
  const credentials = await geotabAuthenticate();

  const payload = {
    method: "Get",
    params: { typeName, credentials }
  };
  if (search) payload.params.search = search;

  const resp = await axios.post(`${serverUrl}/apiv1`, payload, { timeout: 15000 });
  return Array.isArray(resp.data?.result) ? resp.data.result : [];
}

/**
 * Pull last known GPS per vehicle.
 * DeviceStatusInfo often contains latitude/longitude/dateTime/speed/isDriving
 */
async function fetchGeotabLastPositions() {
  const now = Date.now();

  if ((now - geotabPositionsLastFetch) < GEOTAB_CACHE_MS && geotabPositionsCache.length) {
    return geotabPositionsCache;
  }

  const rows = await geotabGet("DeviceStatusInfo");

  const cleaned = rows
    .map(r => ({
      deviceId: r.device?.id || "",
      name: r.device?.name || "",
      dateTime: r.dateTime || "",
      latitude: r.latitude,
      longitude: r.longitude,
      speed: r.speed,
      isDriving: r.isDriving
    }))
    .filter(x => Number.isFinite(x.latitude) && Number.isFinite(x.longitude));

  geotabPositionsCache = cleaned;
  geotabPositionsLastFetch = now;

  return cleaned;
}

/* =========================
   HELPERS
========================= */
function broadcast(type, payload) {
  const msg = JSON.stringify({ type, payload });
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  }
}

function cleanStr(v, maxLen) {
  const s = String(v ?? "").trim();
  if (!s) return "";
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

function normalizeDoor(v) {
  const raw = String(v ?? "").trim();
  if (!raw) return "";
  const m = raw.match(/(\d{1,3})/);
  return m ? m[1] : raw;
}

function getIp(req) {
  return (
    (req.headers["x-forwarded-for"]?.split(",")[0]?.trim()) ||
    req.socket.remoteAddress ||
    ""
  );
}

function parseCookies(cookieHeader) {
  const out = {};
  const raw = String(cookieHeader || "");
  raw.split(";").forEach((part) => {
    const [k, ...rest] = part.trim().split("=");
    if (!k) return;
    out[k] = decodeURIComponent(rest.join("=") || "");
  });
  return out;
}

function sign(val) {
  return crypto.createHmac("sha256", LINK_SIGNING_SECRET).update(val).digest("hex");
}

function setAuthCookie(res, role) {
  // auth = role|ts|sig
  const ts = Date.now();
  const base = `${role}|${ts}`;
  const sig = sign(base);
  const value = encodeURIComponent(`${base}|${sig}`);
  res.setHeader("Set-Cookie", [`auth=${value}; Path=/; HttpOnly; SameSite=Lax`]);
}

function clearAuthCookie(res) {
  res.setHeader("Set-Cookie", [`auth=; Path=/; Max-Age=0; SameSite=Lax`]);
}

function getRoleFromReq(req) {
  // Driver is public (no cookie needed)
  if (String(req.path || "").toLowerCase().startsWith("/driver")) return "driver";

  const cookies = parseCookies(req.headers.cookie);
  const auth = cookies.auth;
  if (!auth) return null;

  const decoded = decodeURIComponent(auth);
  const parts = decoded.split("|");
  if (parts.length !== 3) return null;

  const role = parts[0];
  const ts = parts[1];
  const sig = parts[2];

  if (role !== "dispatcher" && role !== "dock") return null;

  const base = `${role}|${ts}`;
  if (sign(base) !== sig) return null;

  // expire after 12 hours
  const ageMs = Date.now() - Number(ts || 0);
  if (!Number.isFinite(ageMs) || ageMs > 12 * 60 * 60 * 1000) return null;

  return role;
}

function requireRole(roleNeeded) {
  return (req, res, next) => {
    const role = getRoleFromReq(req);
    if (role === roleNeeded) return next();
    return res.status(401).send("Unauthorized");
  };
}

function requireAnyRole(roles) {
  return (req, res, next) => {
    const role = getRoleFromReq(req);
    if (role && roles.includes(role)) return next();
    return res.status(401).send("Unauthorized");
  };
}

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

async function auditLog({ actorRole, action, entityType, entityId, details, ip, userAgent }) {
  const at = Date.now();
  await dbRun(
    `INSERT INTO audit_log (at, actorRole, action, entityType, entityId, details, ip, userAgent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      at,
      actorRole || "",
      action || "",
      entityType || "",
      entityId || "",
      JSON.stringify(details || {}),
      ip || "",
      userAgent || ""
    ]
  );
}

/* =========================
   DB INIT + CACHE LOAD
========================= */
async function initDb() {
  await dbRun(`PRAGMA journal_mode=WAL;`);
  await dbRun(`PRAGMA synchronous=NORMAL;`);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS trailers (
      trailer TEXT PRIMARY KEY,
      direction TEXT NOT NULL,
      status TEXT NOT NULL,
      door TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      updatedAt INTEGER NOT NULL
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS confirmations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL,
      trailer TEXT NOT NULL DEFAULT '',
      door TEXT NOT NULL DEFAULT '',
      ip TEXT NOT NULL DEFAULT '',
      userAgent TEXT NOT NULL DEFAULT ''
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS dock_plates (
      door TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'Unknown',
      note TEXT NOT NULL DEFAULT '',
      updatedAt INTEGER NOT NULL
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL,
      actorRole TEXT NOT NULL,
      action TEXT NOT NULL,
      entityType TEXT NOT NULL,
      entityId TEXT NOT NULL,
      details TEXT NOT NULL,
      ip TEXT NOT NULL,
      userAgent TEXT NOT NULL
    )
  `);

  // Seed plates 18..42 if missing
  for (let d = 18; d <= 42; d++) {
    await dbRun(
      `INSERT INTO dock_plates (door, status, note, updatedAt)
       VALUES (?, 'Unknown', '', ?)
       ON CONFLICT(door) DO NOTHING`,
      [String(d), Date.now()]
    );
  }

  await reloadCachesFromDb();
}

async function reloadCachesFromDb() {
  const trows = await dbAll(`SELECT trailer, direction, status, door, note, updatedAt FROM trailers`);
  trailers = {};
  for (const r of trows) {
    trailers[r.trailer] = {
      direction: r.direction,
      status: r.status,
      door: r.door || "",
      note: r.note || "",
      updatedAt: r.updatedAt || 0
    };
  }

  const crows = await dbAll(`
    SELECT at, trailer, door, ip, userAgent
    FROM confirmations
    ORDER BY id DESC
    LIMIT 200
  `);
  confirmations = crows.map(r => ({
    at: r.at,
    trailer: r.trailer || "",
    door: r.door || "",
    ip: r.ip || "",
    userAgent: r.userAgent || ""
  }));

  const prows = await dbAll(`SELECT door, status, note, updatedAt FROM dock_plates`);
  dockPlates = {};
  for (const r of prows) {
    dockPlates[String(r.door)] = {
      status: r.status || "Unknown",
      note: r.note || "",
      updatedAt: r.updatedAt || 0
    };
  }
}

/* =========================
   PAGES
========================= */
app.get("/login", (req, res) => {
  res.send(`
<!doctype html>
<html>
<head>
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Login</title>
  <style>
    body{font-family:system-ui;background:#0b1220;color:#eaf0ff;margin:0;display:flex;justify-content:center;align-items:center;height:100vh}
    .card{width:340px;background:rgba(255,255,255,.04);border:1px solid rgba(120,145,220,.18);border-radius:14px;padding:18px}
    h2{margin:0 0 6px 0}
    .sub{color:#a7b2d3;font-size:12px;margin-bottom:12px}
    input{width:100%;padding:12px;border-radius:12px;border:1px solid rgba(120,145,220,.18);background:#0c132a;color:#fff}
    button{width:100%;padding:12px;border-radius:12px;border:1px solid rgba(120,145,220,.18);background:rgba(99,102,241,.25);color:#fff;font-weight:900;margin-top:10px;cursor:pointer}
    .hint{margin-top:10px;font-size:12px;color:#a7b2d3}
    a{color:#b7c5ff}
  </style>
</head>
<body>
  <div class="card">
    <h2>Wesbell Login</h2>
    <div class="sub">Dispatcher & Dock require PIN. Driver is public.</div>
    <form method="POST" action="/login">
      <input name="pin" placeholder="Enter PIN" autocomplete="off" required />
      <button type="submit">Login</button>
    </form>
    <div class="hint">Driver link: <a href="/driver">/driver</a></div>
  </div>
</body>
</html>
  `);
});

app.post("/login", (req, res) => {
  const pin = String(req.body?.pin || "").trim();

  if (pin === DISPATCHER_PIN) {
    setAuthCookie(res, "dispatcher");
    return res.redirect("/");
  }
  if (pin === DOCK_PIN) {
    setAuthCookie(res, "dock");
    return res.redirect("/dock");
  }

  res.status(401).send("Invalid PIN");
});

app.post("/api/logout", (req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});

app.get("/api/whoami", (req, res) => {
  const role = getRoleFromReq(req);
  res.json({ role: role || null, version: APP_VERSION });
});

app.get("/api/version", (req, res) => {
  res.json({ version: APP_VERSION });
});

// Main pages
app.get("/", (req, res) => {
  const role = getRoleFromReq(req);
  if (role !== "dispatcher") return res.redirect("/login");
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/dock", (req, res) => {
  const role = getRoleFromReq(req);
  if (role !== "dock") return res.redirect("/login");
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/driver", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/health", (req, res) =>
  res.json({ ok: true, db: DB_PATH, version: APP_VERSION })
);

/* =========================
   APIs: STATE
========================= */
app.get("/api/state", (req, res) => {
  res.json(trailers);
});

/* =========================
   APIs: DOCK PLATES
========================= */
app.get("/api/dockplates", (req, res) => {
  res.json(dockPlates);
});

app.post("/api/dockplates/set", requireAnyRole(["dispatcher", "dock"]), async (req, res) => {
  try {
    const role = getRoleFromReq(req);
    const door = normalizeDoor(req.body?.door);
    const status = cleanStr(req.body?.status, 20); // OK | Service | Unknown
    const note = cleanStr(req.body?.note, 120);

    const allowed = ["OK", "Service", "Unknown"];
    if (!door) return res.status(400).send("Door required");
    if (!/^\d+$/.test(door)) return res.status(400).send("Invalid door");
    const doorNum = Number(door);
    if (doorNum < 18 || doorNum > 42) return res.status(400).send("Door must be 18-42");
    if (!allowed.includes(status)) return res.status(400).send("Invalid status");

    const updatedAt = Date.now();
    await dbRun(
      `INSERT INTO dock_plates (door, status, note, updatedAt)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(door) DO UPDATE SET status=excluded.status, note=excluded.note, updatedAt=excluded.updatedAt`,
      [door, status, note, updatedAt]
    );

    dockPlates[door] = { status, note, updatedAt };

    await auditLog({
      actorRole: role,
      action: "plate_set",
      entityType: "dock_plate",
      entityId: door,
      details: { status, note },
      ip: getIp(req),
      userAgent: req.headers["user-agent"] || ""
    });

    broadcast("dockplates", dockPlates);
    res.json({ ok: true });
  } catch (err) {
    console.error("dockplates/set error:", err);
    res.status(500).send("Server error");
  }
});

/* =========================
   APIs: GEOTAB LITE
   (Dispatcher + Dock only)
========================= */
app.get("/api/geotab/positions", requireAnyRole(["dispatcher", "dock"]), async (req, res) => {
  try {
    if (!geotabConfigured()) {
      return res.status(400).send("Geotab not configured (missing env vars)");
    }
    const data = await fetchGeotabLastPositions();
    res.json(data);
  } catch (err) {
    console.error("Geotab positions error:", err?.response?.data || err.message);
    res.status(500).send("Geotab positions failed");
  }
});

/* =========================
   APIs: CONFIRM SAFETY (driver)
========================= */
app.post("/api/confirm-safety", async (req, res) => {
  try {
    const trailer = cleanStr(req.body?.trailer, 20);
    const door = normalizeDoor(req.body?.door);
    const loadSecured = !!req.body?.loadSecured;
    const dockPlateUp = !!req.body?.dockPlateUp;

    if (!loadSecured || !dockPlateUp) {
      return res.status(400).send("Both confirmations required");
    }

    const ip = getIp(req);
    const at = Date.now();
    const userAgent = req.headers["user-agent"] || "";

    await dbRun(
      `INSERT INTO confirmations (at, trailer, door, ip, userAgent) VALUES (?, ?, ?, ?, ?)`,
      [at, trailer || "", door || "", ip, userAgent]
    );

    const crows = await dbAll(`
      SELECT at, trailer, door, ip, userAgent
      FROM confirmations
      ORDER BY id DESC
      LIMIT 200
    `);
    confirmations = crows.map(r => ({
      at: r.at,
      trailer: r.trailer || "",
      door: r.door || "",
      ip: r.ip || "",
      userAgent: r.userAgent || ""
    }));

    await auditLog({
      actorRole: "driver",
      action: "safety_confirmed",
      entityType: "trailer",
      entityId: trailer || "",
      details: { trailer, door, loadSecured: true, dockPlateUp: true },
      ip,
      userAgent
    });

    broadcast("confirmations", confirmations);
    res.json({ ok: true });
  } catch (err) {
    console.error("confirm-safety error:", err);
    res.status(500).send("Server error");
  }
});

/* =========================
   APIs: UPSERT TRAILER
   - Dispatcher: full control
   - Dock: can ONLY set status Loading / Dock Ready (cannot add trailer)
========================= */
app.post("/api/upsert", async (req, res) => {
  try {
    const role = getRoleFromReq(req); // dispatcher | dock | driver | null
    if (!role) return res.status(401).send("Unauthorized");
    if (role === "driver") return res.status(403).send("Drivers cannot update trailers");

    const trailer = cleanStr(req.body?.trailer, 20);
    if (!trailer) return res.status(400).send("Trailer required");

    const prev = trailers[trailer] || null;
    if (!prev && role === "dock") return res.status(403).send("Dock cannot add trailers");

    const allowedDir = ["Inbound", "Outbound", "Cross Dock"];
    const allowedStatus = ["Incoming", "Loading", "Dock Ready", "Ready", "Departed"];

    // Dock: ONLY status Loading / Dock Ready
    if (role === "dock") {
      const status = cleanStr(req.body?.status, 30);
      if (!["Loading", "Dock Ready"].includes(status)) {
        return res.status(403).send("Dock can only set Loading or Dock Ready");
      }

      const updatedAt = Date.now();
      const next = {
        direction: prev.direction,
        status,
        door: prev.door,
        note: prev.note || "",
        updatedAt
      };

      await dbRun(
        `INSERT INTO trailers (trailer, direction, status, door, note, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(trailer) DO UPDATE SET
           direction=excluded.direction,
           status=excluded.status,
           door=excluded.door,
           note=excluded.note,
           updatedAt=excluded.updatedAt`,
        [trailer, next.direction, next.status, next.door || "", next.note || "", updatedAt]
      );

      trailers[trailer] = next;

      await auditLog({
        actorRole: role,
        action: "trailer_status_set",
        entityType: "trailer",
        entityId: trailer,
        details: { from: prev.status, to: status },
        ip: getIp(req),
        userAgent: req.headers["user-agent"] || ""
      });

      broadcast("state", trailers);
      res.json({ ok: true });
      return;
    }

    // Dispatcher: full upsert
    const direction = cleanStr(req.body?.direction, 30) || (prev?.direction || "Inbound");
    const status = cleanStr(req.body?.status, 30) || (prev?.status || "Incoming");
    const door = normalizeDoor(req.body?.door ?? prev?.door ?? "");
    const note = cleanStr(req.body?.note, 160) || (prev?.note || "");

    if (!allowedDir.includes(direction)) return res.status(400).send("Invalid direction");
    if (!allowedStatus.includes(status)) return res.status(400).send("Invalid status");

    // enforce door range when provided
    if (door) {
      if (!/^\d+$/.test(door)) return res.status(400).send("Invalid door");
      const dn = Number(door);
      if (dn < 18 || dn > 42) return res.status(400).send("Door must be 18-42");
    }

    const updatedAt = Date.now();
    const next = { direction, status, door: door || "", note: note || "", updatedAt };

    await dbRun(
      `INSERT INTO trailers (trailer, direction, status, door, note, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(trailer) DO UPDATE SET
         direction=excluded.direction,
         status=excluded.status,
         door=excluded.door,
         note=excluded.note,
         updatedAt=excluded.updatedAt`,
      [trailer, direction, status, next.door, next.note, updatedAt]
    );

    trailers[trailer] = next;

    await auditLog({
      actorRole: "dispatcher",
      action: prev ? "trailer_update" : "trailer_create",
      entityType: "trailer",
      entityId: trailer,
      details: { prev, next },
      ip: getIp(req),
      userAgent: req.headers["user-agent"] || ""
    });

    broadcast("state", trailers);

    // notify when becomes Ready
    if (prev?.status !== "Ready" && status === "Ready") {
      broadcast("notify", { kind: "ready", trailer, door: next.door || "" });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("upsert error:", err);
    res.status(500).send("Server error");
  }
});

/* =========================
   APIs: DELETE / CLEAR (dispatcher only)
========================= */
app.post("/api/delete", requireRole("dispatcher"), async (req, res) => {
  try {
    const trailer = cleanStr(req.body?.trailer, 20);
    if (!trailer) return res.status(400).send("Trailer required");

    const prev = trailers[trailer] || null;

    await dbRun(`DELETE FROM trailers WHERE trailer = ?`, [trailer]);
    delete trailers[trailer];

    await auditLog({
      actorRole: "dispatcher",
      action: "trailer_delete",
      entityType: "trailer",
      entityId: trailer,
      details: { prev },
      ip: getIp(req),
      userAgent: req.headers["user-agent"] || ""
    });

    broadcast("state", trailers);
    res.json({ ok: true });
  } catch (err) {
    console.error("delete error:", err);
    res.status(500).send("Server error");
  }
});

app.post("/api/clear", requireRole("dispatcher"), async (req, res) => {
  try {
    await dbRun(`DELETE FROM trailers`);
    trailers = {};

    await auditLog({
      actorRole: "dispatcher",
      action: "trailer_clear_all",
      entityType: "trailer",
      entityId: "*",
      details: {},
      ip: getIp(req),
      userAgent: req.headers["user-agent"] || ""
    });

    broadcast("state", trailers);
    res.json({ ok: true });
  } catch (err) {
    console.error("clear error:", err);
    res.status(500).send("Server error");
  }
});

/* =========================
   APIs: AUDIT LOG (dispatcher only)
========================= */
app.get("/api/audit", requireRole("dispatcher"), async (req, res) => {
  try {
    const rows = await dbAll(
      `SELECT at, actorRole, action, entityType, entityId, details
       FROM audit_log
       ORDER BY id DESC
       LIMIT 250`
    );
    res.json(rows.map(r => ({
      at: r.at,
      actorRole: r.actorRole,
      action: r.action,
      entityType: r.entityType,
      entityId: r.entityId,
      details: (() => { try { return JSON.parse(r.details || "{}"); } catch { return {}; } })()
    })));
  } catch (err) {
    console.error("audit error:", err);
    res.status(500).send("Server error");
  }
});

/* =========================
   WEBSOCKET
========================= */
wss.on("connection", (ws) => {
  ws.send(JSON.stringify({ type: "state", payload: trailers }));
  ws.send(JSON.stringify({ type: "dockplates", payload: dockPlates }));
  ws.send(JSON.stringify({ type: "confirmations", payload: confirmations }));
  ws.send(JSON.stringify({ type: "version", payload: { version: APP_VERSION } }));
});

/* =========================
   START
========================= */
const PORT = process.env.PORT || 3000;

initDb()
  .then(() => {
    server.listen(PORT, () => {
      console.log("Running on port", PORT);
      console.log("SQLite DB:", DB_PATH);
      console.log("Version:", APP_VERSION);
      console.log("Geotab configured:", geotabConfigured());
    });
  })
  .catch((err) => {
    console.error("DB init failed:", err);
    process.exit(1);
  });
