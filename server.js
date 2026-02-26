require("dotenv").config();

const express = require("express");
const http = require("http");
const path = require("path");
const WebSocket = require("ws");
const sqlite3 = require("sqlite3").verbose();
const helmet = require("helmet");
const compression = require("compression");

const app = express();
app.use(helmet());
app.use(compression());
app.use(express.json());
app.use(express.static(__dirname));

/* ================================
   LOGGING
================================ */
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

/* ================================
   DATABASE
================================ */

// For Render: set DB_PATH=/var/data/data.db
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "data.db");
const db = new sqlite3.Database(DB_PATH);

let trailers = {};
let confirmations = [];

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
  const rows = await dbAll(`SELECT * FROM trailers`);
  trailers = {};
  rows.forEach(r => {
    trailers[r.trailer] = {
      direction: r.direction,
      status: r.status,
      door: r.door,
      updatedAt: r.updatedAt
    };
  });

  const conf = await dbAll(`
    SELECT at, trailer, door, ip, userAgent
    FROM confirmations
    ORDER BY id DESC
    LIMIT 200
  `);

  confirmations = conf;
}

/* ================================
   HELPERS
================================ */

function broadcast(type, payload) {
  const msg = JSON.stringify({ type, payload });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
}

function cleanStr(v, maxLen) {
  const s = String(v ?? "").trim();
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

function computeStats(board) {
  const stats = {
    total: 0,
    byStatus: { Incoming: 0, Loading: 0, Ready: 0, Departed: 0 }
  };

  Object.values(board).forEach(v => {
    stats.total++;
    if (stats.byStatus[v.status] !== undefined)
      stats.byStatus[v.status]++;
  });

  return stats;
}

/* ================================
   ROUTES
================================ */

// Dispatcher board
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// Driver link (clean)
app.get("/driver", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// Supervisor log
app.get("/supervisor", (req, res) => {
  res.sendFile(path.join(__dirname, "supervisor.html"));
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

app.get("/api/confirmations", (req, res) => {
  res.json(confirmations);
});

/* ================================
   UPSERT TRAILER
================================ */

app.post("/api/upsert", async (req, res) => {
  try {
    const trailer = cleanStr(req.body.trailer, 20);
    const direction = cleanStr(req.body.direction, 30);
    const status = cleanStr(req.body.status, 30);
    const door = cleanStr(req.body.door, 20);
    const updatedAt = Date.now();

    const allowedDir = ["Inbound","Outbound","Cross Dock"];
    const allowedStatus = ["Incoming","Loading","Ready","Departed"];

    if (!trailer) return res.status(400).send("Trailer required");
    if (!allowedDir.includes(direction)) return res.status(400).send("Invalid direction");
    if (!allowedStatus.includes(status)) return res.status(400).send("Invalid status");

    await dbRun(`
      INSERT INTO trailers (trailer,direction,status,door,updatedAt)
      VALUES (?,?,?,?,?)
      ON CONFLICT(trailer) DO UPDATE SET
        direction=excluded.direction,
        status=excluded.status,
        door=excluded.door,
        updatedAt=excluded.updatedAt
    `, [trailer,direction,status,door,updatedAt]);

    trailers[trailer] = { direction, status, door, updatedAt };

    broadcast("state", trailers);
    broadcast("stats", computeStats(trailers));

    res.json({ ok:true });
  } catch (err) {
    console.error(err);
    res.status(500).send("Server error");
  }
});

/* ================================
   SAFETY CONFIRMATION
================================ */

app.post("/api/confirm-safety", async (req, res) => {
  try {
    const trailer = cleanStr(req.body.trailer, 20);
    const door = cleanStr(req.body.door, 20);

    const loadSecured = !!req.body.loadSecured;
    const dockPlateUp = !!req.body.dockPlateUp;

    if (!loadSecured || !dockPlateUp)
      return res.status(400).send("Both confirmations required");

    const at = Date.now();
    const ip =
      req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
      req.socket.remoteAddress || "";
    const userAgent = req.headers["user-agent"] || "";

    await dbRun(`
      INSERT INTO confirmations (at,trailer,door,ip,userAgent)
      VALUES (?,?,?,?,?)
    `, [at,trailer,door,ip,userAgent]);

    await reloadCaches();

    broadcast("confirmations", confirmations);

    res.json({ ok:true });
  } catch (err) {
    console.error(err);
    res.status(500).send("Server error");
  }
});

/* ================================
   DELETE / CLEAR
================================ */

app.post("/api/delete", async (req, res) => {
  try {
    const trailer = cleanStr(req.body.trailer, 20);
    await dbRun(`DELETE FROM trailers WHERE trailer=?`, [trailer]);
    delete trailers[trailer];
    broadcast("state", trailers);
    res.json({ ok:true });
  } catch (err) {
    res.status(500).send("Server error");
  }
});

app.post("/api/clear", async (req, res) => {
  try {
    await dbRun(`DELETE FROM trailers`);
    trailers = {};
    broadcast("state", trailers);
    res.json({ ok:true });
  } catch (err) {
    res.status(500).send("Server error");
  }
});

/* ================================
   AUTO ARCHIVE (15 min)
================================ */

setInterval(async () => {
  const cutoff = Date.now() - 15 * 60 * 1000;
  await dbRun(`DELETE FROM trailers WHERE status='Departed' AND updatedAt < ?`, [cutoff]);
  await reloadCaches();
  broadcast("state", trailers);
}, 60 * 1000);

/* ================================
   WEBSOCKET
================================ */

wss.on("connection", ws => {
  ws.send(JSON.stringify({ type:"state", payload:trailers }));
  ws.send(JSON.stringify({ type:"stats", payload:computeStats(trailers) }));
  ws.send(JSON.stringify({ type:"confirmations", payload:confirmations }));
});

/* ================================
   START
================================ */

const PORT = process.env.PORT || 3000;

initDb().then(() => {
  server.listen(PORT, () => {
    console.log("Running on port", PORT);
    console.log("Driver link: /driver");
    console.log("Supervisor link: /supervisor");
    console.log("DB path:", DB_PATH);
  });
});
