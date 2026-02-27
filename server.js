require("dotenv").config();

const express = require("express");
const http = require("http");
const path = require("path");
const WebSocket = require("ws");
const sqlite3 = require("sqlite3").verbose();
const helmet = require("helmet");
const compression = require("compression");

const app = express();

// Allow inline <script> in index.html (CSP off)
app.use(
  helmet({
    contentSecurityPolicy: false
  })
);

app.use(compression());
app.use(express.json());
app.use(express.static(__dirname));

// Simple request logging
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

// In-memory caches (fast rendering + websocket payload)
let trailers = {};
let confirmations = [];
let dockPlates = {}; // door -> {status, note, updatedAt}

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

function computeStats(board) {
  const stats = {
    total: 0,
    byStatus: { Incoming: 0, Loading: 0, "Dock Ready": 0, Ready: 0, Departed: 0 },
    byDirection: { Inbound: 0, Outbound: 0, "Cross Dock": 0 }
  };

  for (const [, v] of Object.entries(board)) {
    stats.total += 1;
    if (v.status && stats.byStatus[v.status] !== undefined) stats.byStatus[v.status] += 1;
    if (v.direction && stats.byDirection[v.direction] !== undefined) stats.byDirection[v.direction] += 1;
  }
  return stats;
}

// Prevent stale index.html from being cached
function noCache(res) {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
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
   DB INIT + CACHE RELOAD
================================ */

async function initDb() {
  await dbRun(`PRAGMA journal_mode = WAL;`);
  await dbRun(`PRAGMA synchronous = NORMAL;`);

  // Trailers (with trailer note)
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

  // Upgrade older DBs safely
  await dbRun(`ALTER TABLE trailers ADD COLUMN note TEXT NOT NULL DEFAULT ''`).catch(() => {});

  // Driver confirmations
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

  // Dock plate maintenance (door-level)
  await dbRun(`
    CREATE TABLE IF NOT EXISTS dockplates (
      door TEXT PRIMARY KEY,
      status TEXT NOT NULL,          -- "OK" or "Service"
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
      updatedAt: r.updatedAt || 0
    };
  }

  const confRows = await dbAll(`
    SELECT at, trailer, door, ip, userAgent
    FROM confirmations
    ORDER BY id DESC
    LIMIT 200
  `);

  confirmations = confRows.map(r => ({
    at: r.at,
    trailer: r.trailer || "",
    door: r.door || "",
    ip: r.ip || "",
    userAgent: r.userAgent || ""
  }));

  const plateRows = await dbAll(`SELECT door, status, note, updatedAt FROM dockplates`);
  dockPlates = {};
  for (const r of plateRows) {
    dockPlates[String(r.door || "").toUpperCase()] = {
      status: r.status,
      note: r.note || "",
      updatedAt: r.updatedAt || 0
    };
  }
}

/* ================================
   ROUTES
================================ */

// Dispatcher
app.get("/", (req, res) => {
  noCache(res);
  res.sendFile(path.join(__dirname, "index.html"));
});

// Driver
app.get("/driver", (req, res) => {
  noCache(res);
  res.sendFile(path.join(__dirname, "index.html"));
});

// Dock
app.get("/dock", (req, res) => {
  noCache(res);
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/health", (req, res) => {
  res.json({ ok: true, db: DB_PATH });
});

// APIs
app.get("/api/state", (req, res) => res.json(trailers));
app.get("/api/stats", (req, res) => res.json(computeStats(trailers)));
app.get("/api/confirmations", (req, res) => res.json(confirmations));
app.get("/api/dockplates", (req, res) => res.json(dockPlates));

/* ================================
   DOCK PLATES (MAINTENANCE)
================================ */

app.post("/api/dockplates/set", async (req, res) => {
  try {
    const door = cleanStr(req.body?.door, 20).toUpperCase();
    const status = cleanStr(req.body?.status, 20);
    const note = cleanStr(req.body?.note, 200);

    if (!door) return res.status(400).send("Door required");

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

// Management view (read-only)
app.get("/maintenance", (req, res) => {
  res.send(`
    <html>
    <head>
      <meta name="viewport" content="width=device-width,initial-scale=1"/>
      <title>Maintenance - Dock Plates</title>
      <style>
        body{font-family:system-ui;background:#0b1220;color:#eaf0ff;margin:0;padding:20px}
        h1{margin:0 0 8px 0}
        .muted{color:#a9b4d0;font-size:13px}
        table{width:100%;border-collapse:collapse;margin-top:12px}
        th,td{padding:10px;border-bottom:1px solid #263454;text-align:left;font-size:13px}
        th{color:#a9b4d0;font-size:12px}
        .ok{color:#22c55e;font-weight:900}
        .svc{color:#f59e0b;font-weight:900}
      </style>
    </head>
    <body>
      <h1>Dock Plate Status</h1>
      <div class="muted">Door-level plate status + notes (latest). Auto refresh every 5s.</div>

      <table>
        <thead>
          <tr><th>Door</th><th>Status</th><th>Plate Note</th><th>Last Updated</th></tr>
        </thead>
        <tbody id="tb"></tbody>
      </table>

      <script>
        async function load(){
          const res = await fetch('/api/dockplates');
          const data = await res.json();
          const rows = Object.entries(data).sort((a,b)=>a[0].localeCompare(b[0]));
          const tb = document.getElementById('tb');
          tb.innerHTML = '';
          rows.forEach(([door, v])=>{
            const tr = document.createElement('tr');
            const when = v.updatedAt ? new Date(v.updatedAt).toLocaleString() : '';
            const cls = v.status === 'OK' ? 'ok' : 'svc';
            tr.innerHTML =
              '<td><b>'+door+'</b></td>'+
              '<td class="'+cls+'">'+v.status+'</td>'+
              '<td>'+(v.note||'')+'</td>'+
              '<td>'+when+'</td>';
            tb.appendChild(tr);
          });
          if(rows.length===0){
            tb.innerHTML = '<tr><td colspan="4" style="color:#a9b4d0;">No dock plate reports yet.</td></tr>';
          }
        }
        load();
        setInterval(load, 5000);
      </script>
    </body>
    </html>
  `);
});

/* ================================
   SAFETY CONFIRM (PERSISTED)
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

    confirmations = confRows.map(r => ({
      at: r.at,
      trailer: r.trailer || "",
      door: r.door || "",
      ip: r.ip || "",
      userAgent: r.userAgent || ""
    }));

    broadcast("confirmations", confirmations);
    res.json({ ok: true });
  } catch (err) {
    console.error("confirm-safety error:", err);
    res.status(500).send("Server error");
  }
});

/* ================================
   UPSERT TRAILER (PERSISTED + NOTE)
================================ */

app.post("/api/upsert", async (req, res) => {
  try {
    const trailer = cleanStr(req.body?.trailer, 20);
    const direction = cleanStr(req.body?.direction, 30);
    const status = cleanStr(req.body?.status, 30);
    const door = cleanStr(req.body?.door, 20);
    const note = cleanStr(req.body?.note, 200);

    if (!trailer) return res.status(400).send("Trailer required");

    const allowedDir = ["Inbound", "Outbound", "Cross Dock"];
    const allowedStatus = ["Incoming", "Loading", "Dock Ready", "Ready", "Departed"];

    if (!allowedDir.includes(direction)) return res.status(400).send("Invalid direction");
    if (!allowedStatus.includes(status)) return res.status(400).send("Invalid status");

    // Preserve old note if caller sends empty (so dropdown changes don't wipe notes)
    const prev = trailers[trailer] || {};
    const finalNote = (note !== "") ? note : (prev.note || "");

    // Preserve old door if caller sends empty
    const finalDoor = (door !== "") ? door : (prev.door || "");

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
      [trailer, direction, status, finalDoor, finalNote, updatedAt]
    );

    trailers[trailer] = {
      direction,
      status,
      door: finalDoor || "",
      note: finalNote || "",
      updatedAt
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
   DELETE / CLEAR
================================ */

app.post("/api/delete", async (req, res) => {
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

app.post("/api/clear", async (req, res) => {
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
   SUPERVISOR PAGE
================================ */

app.get("/supervisor", (req, res) => {
  res.send(`
    <html>
    <head>
      <meta name="viewport" content="width=device-width,initial-scale=1"/>
      <title>Supervisor - Confirmations</title>
      <style>
        body{font-family:system-ui;background:#0b1220;color:#eaf0ff;margin:0;padding:20px}
        h1{margin:0 0 10px 0}
        table{width:100%;border-collapse:collapse;margin-top:12px}
        th,td{padding:10px;border-bottom:1px solid #263454;text-align:left;font-size:13px}
        th{color:#a9b4d0;font-size:12px}
      </style>
    </head>
    <body>
      <h1>Driver Safety Confirmations</h1>
      <div style="color:#a9b4d0;font-size:13px;">Live log (latest first)</div>
      <table>
        <thead>
          <tr><th>Time</th><th>Trailer</th><th>Door</th><th>IP</th></tr>
        </thead>
        <tbody id="tb"></tbody>
      </table>
      <script>
        async function load(){
          const res = await fetch('/api/confirmations');
          const data = await res.json();
          const tb = document.getElementById('tb');
          tb.innerHTML = '';
          data.forEach(x=>{
            const tr = document.createElement('tr');
            const t = new Date(x.at).toLocaleString();
            tr.innerHTML =
              '<td>'+t+'</td>'+
              '<td>'+(x.trailer||'')+'</td>'+
              '<td>'+(x.door||'')+'</td>'+
              '<td>'+(x.ip||'')+'</td>';
            tb.appendChild(tr);
          });
          if(data.length===0){
            tb.innerHTML = '<tr><td colspan="4" style="color:#a9b4d0;">No confirmations yet.</td></tr>';
          }
        }
        load();
        setInterval(load, 3000);
      </script>
    </body>
    </html>
  `);
});

/* ================================
   AUTO-ARCHIVE DEPARTED
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
      console.log("Supervisor: /supervisor");
      console.log("Maintenance: /maintenance");
      console.log("SQLite DB:", DB_PATH);
    });
  })
  .catch((err) => {
    console.error("DB init failed:", err);
    process.exit(1);
  });
