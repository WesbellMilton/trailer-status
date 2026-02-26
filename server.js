require("dotenv").config();

const express = require("express");
const http = require("http");
const path = require("path");
const WebSocket = require("ws");
const sqlite3 = require("sqlite3").verbose();
const helmet = require("helmet");
const compression = require("compression");

const app = express();

/* ================================
   SECURITY (FIXED)
   Disable CSP so inline JS works
================================ */
app.use(
  helmet({
    contentSecurityPolicy: false
  })
);

app.use(compression());
app.use(express.json());
app.use(express.static(__dirname));

/* ================================
   SIMPLE LOGGING
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

// For Render persistent disk:
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "data.db");
const db = new sqlite3.Database(DB_PATH);

let trailers = {};
let confirmations = [];

/* ================================
   DB HELPERS
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

// Dispatcher
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// Driver
app.get("/driver", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// Supervisor log
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
        }
        load();
        setInterval(load, 3000);
      </script>
    </body>
    </html>
  `);
});

app.get("/api/state", (req, res) => res.json(trailers));
app.get("/api/confirmations", (req, res) => res.json(confirmations));

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
    if (!allowedDir.includes
