const express = require("express");
const http = require("http");
const path = require("path");
const WebSocket = require("ws");
const sqlite3 = require("sqlite3").verbose();
const crypto = require("crypto");
const pkg = require("./package.json");

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

/* ================================
   CONFIG
================================ */

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "data.db");

// Pins (as requested)
const PINS = {
  dispatcher: "1234",
  dock: "789",
};

// Session config
const SESSION_SECRET =
  process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");

// 7 days session
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const db = new sqlite3.Database(DB_PATH);

// In-memory caches
let trailers = {};        // trailer -> {direction,status,door,note,updatedAt}
let confirmations = [];   // latest 200
let dockPlates = {};      // "18".."42" -> {status:"OK"|"Service", note, updatedAt}

/* ================================
   HELPERS
================================ */

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

function normalizeDoorPlate(input) {
  const raw = String(input ?? "").trim().toUpperCase();
  if (!raw) return "";
  const m = raw.match(/(\d{1,3})/);
  return m ? m[1] : raw;
}

function normalizeStatus(input) {
  return String(input ?? "").replace(/\s+/g, " ").trim();
}

function isPlateInRange(doorStr) {
  const n = Number(doorStr);
  return Number.isFinite(n) && n >= 18 && n <= 42;
}

function computeStats(board) {
  const stats = {
    total: 0,
    byStatus: { Incoming: 0, Loading: 0, "Dock Ready": 0, Ready: 0, Departed: 0 },
    byDirection: { Inbound: 0, Outbound: 0, "Cross Dock": 0 },
  };

  for (const [, v] of Object.entries(board)) {
    stats.total += 1;
    if (v.status && stats.byStatus[v.status] !== undefined) stats.byStatus[v.status] += 1;
    if (v.direction && stats.byDirection[v.direction] !== undefined) stats.byDirection[v.direction] += 1;
  }
  return stats;
}

/* ================================
   COOKIE + SESSION (HMAC)
================================ */

function base64urlEncode(buf) {
  return Buffer.from(buf).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
function base64urlDecode(str) {
  str = String(str || "").replaceAll("-", "+").replaceAll("_", "/");
  while (str.length % 4) str += "=";
  return Buffer.from(str, "base64").toString("utf8");
}

function signToken(payloadObj) {
  const payload = base64urlEncode(JSON.stringify(payloadObj));
  const sig = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("base64");
  const sigUrl = sig.replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  return `${payload}.${sigUrl}`;
}

function verifyToken(token) {
  const t = String(token || "");
  const parts = t.split(".");
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;

  const expected = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("base64");
  const expectedUrl = expected.replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

  // timing safe compare
  const a = Buffer.from(sig);
  const b = Buffer.from(expectedUrl);
  if (a.length !== b.length) return null;
  if (!crypto.timingSafeEqual(a, b)) return null;

  let obj;
  try {
    obj = JSON.parse(base64urlDecode(payload));
  } catch {
    return null;
  }

  if (!obj || !obj.r || !obj.exp) return null;
  if (Date.now() > obj.exp) return null;

  return obj; // { r: "dispatcher"|"dock", exp: number }
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  const out = {};
  header.split(";").forEach((part) => {
    const i = part.indexOf("=");
    if (i === -1) return;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}

function setSessionCookie(res, token) {
  const isProd = (process.env.NODE_ENV || "").toLowerCase() === "production";
  const pieces = [
    `session=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  if (isProd) pieces.push("Secure");
  res.setHeader("Set-Cookie", pieces.join("; "));
}

function clearSessionCookie(res) {
  const isProd = (process.env.NODE_ENV || "").toLowerCase() === "production";
  const pieces = [
    "session=",
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
  ];
  if (isProd) pieces.push("Secure");
  res.setHeader("Set-Cookie", pieces.join("; "));
}

// Backward compatible (old header PIN)
function getRoleFromPinHeader(req) {
  const pin = String(req.headers["x-role-pin"] || "").trim();
  if (!pin) return null;
  if (pin === PINS.dispatcher) return "dispatcher";
  if (pin === PINS.dock) return "dock";
  return null;
}

// Primary: session cookie
function getRole(req) {
  const cookies = parseCookies(req);
  const token = cookies.session;
  const verified = verifyToken(token);
  if (verified?.r) return verified.r;

  // fallback
  return getRoleFromPinHeader(req);
}

function requireAnyRole(roles) {
  return (req, res, next) => {
    const role = getRole(req);
    if (!role || !roles.includes(role)) return res.status(403).send("Unauthorized");
    req.role = role;
    next();
  };
}

function requireRole(role) {
  return requireAnyRole([role]);
}

/* ================================
   SQLITE PROMISE HELPERS
================================ */

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

/* ================================
   DB INIT + CACHE LOAD
================================ */

async function initDb() {
  await dbRun(`PRAGMA journal_mode = WAL;`);
  await dbRun(`PRAGMA synchronous = NORMAL;`);

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

  await dbRun(`ALTER TABLE trailers ADD COLUMN note TEXT NOT NULL DEFAULT ''`).catch(() => {});

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
    CREATE TABLE IF NOT EXISTS dockplates (
      door TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      updatedAt INTEGER NOT NULL
    )
  `);

  await reloadCachesFromDb();
}

async function reloadCachesFromDb() {
  const trailerRows = await dbAll(`
    SELECT trailer, direction, status, door, note, updatedAt
    FROM trailers
  `);
  trailers = {};
  for (const r of trailerRows) {
    trailers[r.trailer] = {
      direction: r.direction,
      status: r.status,
      door: r.door || "",
      note: r.note || "",
      updatedAt: r.updatedAt || 0,
    };
  }

  const confRows = await dbAll(`
    SELECT at, trailer, door, ip, userAgent
    FROM confirmations
    ORDER BY id DESC
    LIMIT 200
  `);
  confirmations = confRows.map((r) => ({
    at: r.at,
    trailer: r.trailer || "",
    door: r.door || "",
    ip: r.ip || "",
    userAgent: r.userAgent || "",
  }));

  const plateRows = await dbAll(`SELECT door, status, note, updatedAt FROM dockplates`);
  dockPlates = {};
  for (const r of plateRows) {
    const door = normalizeDoorPlate(r.door);
    if (!door) continue;
    dockPlates[door] = {
      status: r.status,
      note: r.note || "",
      updatedAt: r.updatedAt || 0,
    };
  }
}

/* ================================
   PAGES
================================ */

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.get("/dock", (req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.get("/driver", (req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.get("/geotab", (req, res) => {
  res.send(`
    <!doctype html>
    <html>
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>Geotab</title>
      <style>
        body{margin:0;background:#0b1430;}
        iframe{width:100vw;height:100vh;border:0;}
      </style>
    </head>
    <body>
      <iframe src="YOUR_GEOTAB_URL_HERE"></iframe>
    </body>
    </html>
  `);
});

/* ================================
   AUTH API
================================ */

// Front-end calls this to check if already logged in
app.get("/api/whoami", (req, res) => {
  const role = getRole(req);
  res.json({ role: role || null });
});

// Login once → sets session cookie
app.post("/api/login", (req, res) => {
  const pin = String(req.body?.pin || "").trim();
  let role = null;
  if (pin === PINS.dispatcher) role = "dispatcher";
  else if (pin === PINS.dock) role = "dock";

  if (!role) return res.status(401).send("Invalid PIN");

  const token = signToken({ r: role, exp: Date.now() + SESSION_TTL_MS });
  setSessionCookie(res, token);
  res.json({ ok: true, role });
});

app.post("/api/logout", (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

/* ================================
   API: READ (PUBLIC)
================================ */

app.get("/health", (req, res) => res.json({ ok: true, db: DB_PATH }));
app.get("/api/version", (req, res) => res.json({ version: pkg.version }));

app.get("/api/state", (req, res) => res.json(trailers));
app.get("/api/stats", (req, res) => res.json(computeStats(trailers)));
app.get("/api/dockplates", (req, res) => res.json(dockPlates));
app.get("/api/confirmations", (req, res) => res.json(confirmations));

/* ================================
   API: DOCK PLATES WRITE (Dock + Dispatcher)
================================ */

app.post("/api/dockplates/set", requireAnyRole(["dock", "dispatcher"]), async (req, res) => {
  try {
    const door = normalizeDoorPlate(cleanStr(req.body?.door, 20));
    const status = normalizeStatus(cleanStr(req.body?.status, 20));
    const note = cleanStr(req.body?.note, 200);

    if (!door) return res.status(400).send("Door required");
    if (!isPlateInRange(door)) return res.status(400).send("Door must be 18-42");

    const allowed = ["OK", "Service"];
    if (!allowed.includes(status)) return res.status(400).send("Invalid status");

    const updatedAt = Date.now();

    await dbRun(
      `INSERT INTO dockplates (door, status, note, updatedAt)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(door) DO UPDATE SET
         status=excluded.status,
         note=excluded.note,
         updatedAt=excluded.updatedAt`,
      [door, status, note, updatedAt]
    );

    dockPlates[door] = { status, note, updatedAt };
    broadcast("dockplates", dockPlates);

    res.json({ ok: true });
  } catch (err) {
    console.error("dockplates/set error:", err);
    res.status(500).send("Server error");
  }
});

/* ================================
   API: SAFETY CONFIRM (PUBLIC)
================================ */

app.post("/api/confirm-safety", async (req, res) => {
  try {
    const trailer = cleanStr(req.body?.trailer, 20);
    const door = cleanStr(req.body?.door, 20);
    const loadSecured = !!req.body?.loadSecured;
    const dockPlateUp = !!req.body?.dockPlateUp;

    if (!loadSecured || !dockPlateUp) {
      return res.status(400).send("Both confirmations required");
    }

    const ip =
      (req.headers["x-forwarded-for"]?.split(",")[0]?.trim()) ||
      req.socket.remoteAddress ||
      "";

    const at = Date.now();
    const userAgent = req.headers["user-agent"] || "";

    await dbRun(
      `INSERT INTO confirmations (at, trailer, door, ip, userAgent)
       VALUES (?, ?, ?, ?, ?)`,
      [at, trailer, door, ip, userAgent]
    );

    const confRows = await dbAll(`
      SELECT at, trailer, door, ip, userAgent
      FROM confirmations
      ORDER BY id DESC
      LIMIT 200
    `);

    confirmations = confRows.map((r) => ({
      at: r.at,
      trailer: r.trailer || "",
      door: r.door || "",
      ip: r.ip || "",
      userAgent: r.userAgent || "",
    }));

    broadcast("confirmations", confirmations);
    res.json({ ok: true });
  } catch (err) {
    console.error("confirm-safety error:", err);
    res.status(500).send("Server error");
  }
});

/* ================================
   API: UPSERT TRAILER
   - Dispatcher: full control
   - Dock: ONLY Loading / Dock Ready (no direction/door/note edits, no create)
================================ */

app.post("/api/upsert", requireAnyRole(["dispatcher", "dock"]), async (req, res) => {
  try {
    const role = req.role;

    const trailer = cleanStr(req.body?.trailer, 20);
    const statusIn = normalizeStatus(cleanStr(req.body?.status, 30));
    const directionIn = cleanStr(req.body?.direction, 30);
    const doorRaw = cleanStr(req.body?.door, 20);
    const noteIn = cleanStr(req.body?.note, 200);

    if (!trailer) return res.status(400).send("Trailer required");

    const allowedStatus = ["Incoming", "Loading", "Dock Ready", "Ready", "Departed"];
    if (!allowedStatus.includes(statusIn)) return res.status(400).send("Invalid status");

    const prev = trailers[trailer];

    // Dock rules
    if (role === "dock") {
      if (!prev) return res.status(403).send("Dock cannot add new trailers. Dispatch must create trailer first.");

      const dockAllowed = ["Loading", "Dock Ready"];
      if (!dockAllowed.includes(statusIn)) {
        return res.status(403).send('Dock can only set status to "Loading" or "Dock Ready".');
      }

      const updatedAt = Date.now();

      await dbRun(
        `UPDATE trailers SET status=?, updatedAt=? WHERE trailer=?`,
        [statusIn, updatedAt, trailer]
      );

      trailers[trailer] = { ...prev, status: statusIn, updatedAt };

      broadcast("state", trailers);
      broadcast("stats", computeStats(trailers));
      return res.json({ ok: true });
    }

    // Dispatcher rules
    const allowedDir = ["Inbound", "Outbound", "Cross Dock"];
    if (!allowedDir.includes(directionIn)) return res.status(400).send("Invalid direction");

    const door = doorRaw ? normalizeDoorPlate(doorRaw) : (prev?.door || "");
    if (door && !isPlateInRange(door)) return res.status(400).send("Door must be 18-42");

    // Approval rule: Ready requires Dock Ready
    if (statusIn === "Ready" && prev && prev.status !== "Dock Ready") {
      return res.status(400).send('Approval rule: "Ready" requires prior "Dock Ready".');
    }

    const updatedAt = Date.now();
    const finalNote = noteIn !== "" ? noteIn : (prev?.note || "");

    await dbRun(
      `INSERT INTO trailers (trailer, direction, status, door, note, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(trailer) DO UPDATE SET
         direction=excluded.direction,
         status=excluded.status,
         door=excluded.door,
         note=excluded.note,
         updatedAt=excluded.updatedAt`,
      [trailer, directionIn, statusIn, door || "", finalNote, updatedAt]
    );

    trailers[trailer] = {
      direction: directionIn,
      status: statusIn,
      door: door || "",
      note: finalNote,
      updatedAt,
    };

    broadcast("state", trailers);
    broadcast("stats", computeStats(trailers));
    res.json({ ok: true });
  } catch (err) {
    console.error("upsert error:", err);
    res.status(500).send("Server error");
  }
});

/* ================================
   DELETE / CLEAR (DISPATCHER ONLY)
================================ */

app.post("/api/delete", requireRole("dispatcher"), async (req, res) => {
  try {
    const trailer = cleanStr(req.body?.trailer, 20);
    if (!trailer) return res.status(400).send("Trailer required");

    await dbRun(`DELETE FROM trailers WHERE trailer = ?`, [trailer]);

    delete trailers[trailer];

    broadcast("state", trailers);
    broadcast("stats", computeStats(trailers));
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

    broadcast("state", trailers);
    broadcast("stats", computeStats(trailers));
    res.json({ ok: true });
  } catch (err) {
    console.error("clear error:", err);
    res.status(500).send("Server error");
  }
});

/* ================================
   WEBSOCKET
================================ */

wss.on("connection", (ws) => {
  ws.send(JSON.stringify({ type: "state", payload: trailers }));
  ws.send(JSON.stringify({ type: "confirmations", payload: confirmations }));
  ws.send(JSON.stringify({ type: "stats", payload: computeStats(trailers) }));
  ws.send(JSON.stringify({ type: "dockplates", payload: dockPlates }));
});

/* ================================
   START
================================ */

const PORT = process.env.PORT || 3000;

initDb()
  .then(() => {
    server.listen(PORT, () => {
      console.log("Running on port", PORT);
      console.log("Dispatcher: /  (PIN 1234)");
      console.log("Dock: /dock       (PIN 789)");
      console.log("Driver: /driver   (no PIN)");
      console.log("Geotab: /geotab");
      console.log("SQLite DB:", DB_PATH);
    });
  })
  .catch((err) => {
    console.error("DB init failed:", err);
    process.exit(1);
  });
