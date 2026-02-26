const express = require("express");
const http = require("http");
const path = require("path");
const WebSocket = require("ws");
const sqlite3 = require("sqlite3").verbose();

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

/* ================================
   REQUEST LOGGING
================================ */

app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

/* ================================
   SQLITE SETUP
================================ */

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "data.db");
const db = new sqlite3.Database(DB_PATH);

let trailers = {};
let confirmations = [];

/* ================================
   HELPERS
================================ */

function broadcast(type, payload) {
  const msg = JSON.stringify({ type, payload });
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  }
}

function cleanStr(v, maxLen) {
  const s = String(v ?? "").trim();
  if (!s) return "";
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

function computeStats(board) {
  const stats = {
    total: 0,
    byStatus: { Incoming: 0, Loading: 0, Ready: 0, Departed: 0 },
    byDirection: { Inbound: 0, Outbound: 0, "Cross Dock": 0 }
  };

  for (const [, v] of Object.entries(board)) {
    stats.total++;
    if (stats.byStatus[v.status] !== undefined) stats.byStatus[v.status]++;
    if (stats.byDirection[v.direction] !== undefined) stats.byDirection[v.direction]++;
  }

  return stats;
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

/* ================================
   DATABASE INIT
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

  await reloadCaches();
}

async function reloadCaches() {
  const trailerRows = await dbAll(`SELECT * FROM trailers`);
  trailers = {};
  trailerRows.forEach(r => {
    trailers[r.trailer] = {
      direction: r.direction,
      status: r.status,
      door: r.door,
      updatedAt: r.updatedAt
    };
  });

  const confRows = await dbAll(`
    SELECT at, trailer, door, ip, userAgent
    FROM confirmations
    ORDER BY id DESC
    LIMIT 200
  `);

  confirmations = confRows.map(r => ({
    at: r.at,
    trailer: r.trailer,
    door: r.door,
    ip: r.ip,
    userAgent: r.userAgent
  }));
}

/* ================================
   ROUTES
================================ */

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/health", (req, res) => {
  res.json({ ok: true, db: DB_PATH });
});

app.get("/api/state", (req, res) => {
  res.json(trailers);
});

app.get("/api/stats", (req, res) => {
  res.json(computeStats(trailers));
});

/* ---------- SAFETY CONFIRM ---------- */

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

    await reloadCaches();
    broadcast("confirmations", confirmations);

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).send("Server error");
  }
});

/* ---------- UPSERT TRAILER ---------- */

app.post("/api/upsert", async (req, res) => {
  try {
    const trailer = cleanStr(req.body?.trailer, 20);
    const direction = cleanStr(req.body?.direction, 30);
    const status = cleanStr(req.body?.status, 30);
    const door = cleanStr(req.body?.door, 20);

    if (!trailer) return res.status(400).send("Trailer required");

    const allowedDir = ["Inbound", "Outbound", "Cross Dock"];
    const allowedStatus = ["Incoming", "Loading", "Ready", "Departed"];

    if (!allowedDir.includes(direction)) return res.status(400).send("Invalid direction");
    if (!allowedStatus.includes(status)) return res.status(400).send("Invalid status");

    const updatedAt = Date.now();

    await dbRun(`
      INSERT INTO trailers (trailer, direction, status, door, updatedAt)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(trailer) DO UPDATE SET
        direction=excluded.direction,
        status=excluded.status,
        door=excluded.door,
        updatedAt=excluded.updatedAt
    `, [trailer, direction, status, door, updatedAt]);

    await reloadCaches();
    broadcast("state", trailers);
    broadcast("stats", computeStats(trailers));

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).send("Server error");
  }
});

/* ---------- DELETE TRAILER ---------- */

app.post("/api/delete", async (req, res) => {
  try {
    const trailer = cleanStr(req.body?.trailer, 20);
    if (!trailer) return res.status(400).send("Trailer required");

    await dbRun(`DELETE FROM trailers WHERE trailer = ?`, [trailer]);
    await reloadCaches();

    broadcast("state", trailers);
    broadcast("stats", computeStats(trailers));

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).send("Server error");
  }
});

/* ---------- CLEAR BOARD ---------- */

app.post("/api/clear", async (req, res) => {
  try {
    await dbRun(`DELETE FROM trailers`);
    await reloadCaches();

    broadcast("state", trailers);
    broadcast("stats", computeStats(trailers));

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).send("Server error");
  }
});

/* ================================
   AUTO-ARCHIVE DEPARTED (15 MIN)
================================ */

setInterval(async () => {
  try {
    const cutoff = Date.now() - (15 * 60 * 1000);
    await dbRun(
      `DELETE FROM trailers WHERE status = 'Departed' AND updatedAt < ?`,
      [cutoff]
    );

    await reloadCaches();
    broadcast("state", trailers);
    broadcast("stats", computeStats(trailers));
  } catch (err) {
    console.error("Auto-archive error:", err);
  }
}, 60 * 1000);

/* ================================
   WEBSOCKET
================================ */

wss.on("connection", (ws) => {
  ws.send(JSON.stringify({ type: "state", payload: trailers }));
  ws.send(JSON.stringify({ type: "confirmations", payload: confirmations }));
  ws.send(JSON.stringify({ type: "stats", payload: computeStats(trailers) }));
});

/* ================================
   START SERVER
================================ */

const PORT = process.env.PORT || 3000;

initDb()
  .then(() => {
    server.listen(PORT, () => {
      console.log("Running on port", PORT);
      console.log("SQLite DB:", DB_PATH);
    });
  })
  .catch((err) => {
    console.error("DB init failed:", err);
    process.exit(1);
  });
