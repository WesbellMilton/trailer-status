// server.js
const express = require("express");
const http = require("http");
const path = require("path");
const WebSocket = require("ws");
const sqlite3 = require("sqlite3").verbose();

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

// simple request logging
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

/**
 * SQLite DB path:
 * - Local default: ./data.db
 * - Render persistent disk: set DB_PATH=/var/data/data.db
 */
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "data.db");
const db = new sqlite3.Database(DB_PATH);

// ===== SIMPLE ROLE PINS (set these in Render env vars) =====
// DISPATCHER_PIN=1234
// DOCK_PIN=2222
const PINS = {
  dispatcher: String(process.env.DISPATCHER_PIN || "1234"),
  dock: String(process.env.DOCK_PIN || "2222"),
};

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

// ===== Permissions helpers =====
function getRoleFromPin(req) {
  const pin = String(req.headers["x-role-pin"] || "");
  if (!pin) return null;
  if (pin === PINS.dispatcher) return "dispatcher";
  if (pin === PINS.dock) return "dock";
  return null;
}

function requireAnyRole(roles) {
  return (req, res, next) => {
    const role = getRoleFromPin(req);
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

  // Safe upgrade for older DBs
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
      door TEXT PRIMARY KEY,      -- "18".."42"
      status TEXT NOT NULL,       -- "OK" or "Service"
      note TEXT NOT NULL DEFAULT '',
      updatedAt INTEGER NOT NULL
    )
  `);

  await reloadCachesFromDb();
}

async function reloadCachesFromDb() {
  // trailers
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

  // confirmations
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

  // dock plates
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
app.get("/health", (req, res) => res.json({ ok: true, db: DB_PATH }));

/* ================================
   API: STATE + STATS (PUBLIC VIEW)
================================ */
app.get("/api/state", (req, res) => res.json(trailers));
app.get("/api/stats", (req, res) => res.json(computeStats(trailers)));

/* ================================
   API: DOCK PLATES
   ✅ Dispatcher AND Dock can update
================================ */
app.get("/api/dockplates", (req, res) => res.json(dockPlates));

app.post("/api/dockplates/set", requireAnyRole(["dock", "dispatcher"]), async (req, res) => {
  try {
    const door = normalizeDoorPlate(cleanStr(req.body?.door, 20));
    const status = cleanStr(req.body?.status, 20);
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
   SAFETY CONFIRM (PUBLIC)
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
      `INSERT INTO confirmations (at, trailer, door, ip, userAgent) VALUES (?, ?, ?, ?, ?)`,
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

app.get("/api/confirmations", (req, res) => res.json(confirmations));

/* ================================
   API: UPSERT TRAILER
   ✅ Dispatcher can do all
   ✅ Dock can ONLY set status to Loading / Dock Ready
   ✅ Dock cannot change door/direction/note (server-enforced)
================================ */
app.post("/api/upsert", requireAnyRole(["dispatcher", "dock"]), async (req, res) => {
  try {
    const role = req.role; // injected by middleware

    const trailer = cleanStr(req.body?.trailer, 20);
    const directionIn = cleanStr(req.body?.direction, 30);
    const statusIn = cleanStr(req.body?.status, 30);
    const doorRaw = cleanStr(req.body?.door, 20);
    const noteIn = cleanStr(req.body?.note, 200);

    if (!trailer) return res.status(400).send("Trailer required");

    const allowedDir = ["Inbound", "Outbound", "Cross Dock"];
    const allowedStatus = ["Incoming", "Loading", "Dock Ready", "Ready", "Departed"];

    if (!allowedStatus.includes(statusIn)) return res.status(400).send("Invalid status");
    if (role === "dispatcher" && !allowedDir.includes(directionIn)) {
      return res.status(400).send("Invalid direction");
    }

    const prev = trailers[trailer] || {};

    // ===== Dock restrictions (server enforced) =====
    // Dock can ONLY set status to Loading or Dock Ready
    if (role === "dock") {
      const dockAllowed = ["Loading", "Dock Ready"];
      if (!dockAllowed.includes(statusIn)) {
        return res.status(403).send('Dock can only set status to "Loading" or "Dock Ready".');
      }
    }

    // door is plate number (18-42)
    let finalDoor = prev.door || "";
    if (role === "dispatcher") {
      if (doorRaw !== "") {
        const parsed = normalizeDoorPlate(doorRaw);
        if (parsed && !isPlateInRange(parsed)) return res.status(400).send("Door must be 18-42");
        finalDoor = parsed;
      }
    } // dock cannot change door

    // direction
    let finalDirection = prev.direction || "Inbound";
    if (role === "dispatcher") {
      finalDirection = directionIn;
    } // dock cannot change direction

    // note
    let finalNote = prev.note || "";
    if (role === "dispatcher") {
      finalNote = (noteIn !== "") ? noteIn : finalNote;
    } // dock cannot change trailer note

    // RULE: Dispatcher can only set Ready if previously Dock Ready
    if (role === "dispatcher" && statusIn === "Ready" && prev.status !== "Dock Ready") {
      return res.status(400).send('Approval rule: "Ready" requires prior "Dock Ready".');
    }

    const updatedAt = Date.now();

    await dbRun(
      `INSERT INTO trailers (trailer, direction, status, door, note, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(trailer) DO UPDATE SET
         direction=excluded.direction,
         status=excluded.status,
         door=excluded.door,
         note=excluded.note,
         updatedAt=excluded.updatedAt`,
      [trailer, finalDirection, statusIn, finalDoor, finalNote, updatedAt]
    );

    trailers[trailer] = {
      direction: finalDirection,
      status: statusIn,
      door: finalDoor || "",
      note: finalNote || "",
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
   AUTO-CLEAN DEPARTED
================================ */
setInterval(async () => {
  try {
    const cutoff = Date.now() - 15 * 60 * 1000; // 15 minutes
    await dbRun(`DELETE FROM trailers WHERE status='Departed' AND updatedAt < ?`, [cutoff]);

    await reloadCachesFromDb();
    broadcast("state", trailers);
    broadcast("stats", computeStats(trailers));
    broadcast("dockplates", dockPlates);
  } catch (err) {
    console.error("Auto-clean error:", err);
  }
}, 60 * 1000);

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
      console.log("Dispatcher: /");
      console.log("Dock: /dock");
      console.log("Driver: /driver");
      console.log("SQLite DB:", DB_PATH);
    });
  })
  .catch((err) => {
    console.error("DB init failed:", err);
    process.exit(1);
  });
