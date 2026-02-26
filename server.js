const express = require("express");
const http = require("http");
const path = require("path");
const WebSocket = require("ws");

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

// Simple request logging
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

/* ================================
   IN-MEMORY STORAGE
================================ */

let trailers = {};
// {
//   "1850": { direction:"Inbound", status:"Incoming", door:"D12", updatedAt: 123 }
// }

let confirmations = [];
// [
//   { at: 123, trailer:"1850", door:"D12", ip:"", userAgent:"" }
// ]

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

function computeStats(board){
  const stats = {
    total: 0,
    byStatus: { Incoming: 0, Loading: 0, Ready: 0 },
    byDirection: { Inbound: 0, Outbound: 0, "Cross Dock": 0 }
  };

  for (const [, v] of Object.entries(board)){
    stats.total += 1;
    if (v.status && stats.byStatus[v.status] !== undefined)
      stats.byStatus[v.status] += 1;

    if (v.direction && stats.byDirection[v.direction] !== undefined)
      stats.byDirection[v.direction] += 1;
  }

  return stats;
}

/* ================================
   ROUTES
================================ */

// Root
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// Health check
app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// State
app.get("/api/state", (req, res) => {
  res.json(trailers);
});

// Stats
app.get("/api/stats", (req, res) => {
  res.json(computeStats(trailers));
});

// Safety confirmations API
app.post("/api/confirm-safety", (req, res) => {
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

  confirmations.unshift({
    at: Date.now(),
    trailer,
    door,
    ip,
    userAgent: req.headers["user-agent"] || ""
  });

  confirmations = confirmations.slice(0, 200);

  broadcast("confirmations", confirmations);
  res.json({ ok: true });
});

app.get("/api/confirmations", (req, res) => {
  res.json(confirmations);
});

// Upsert trailer
app.post("/api/upsert", (req, res) => {
  const trailer = cleanStr(req.body?.trailer, 20);
  const direction = cleanStr(req.body?.direction, 30);
  const status = cleanStr(req.body?.status, 30);
  const door = cleanStr(req.body?.door, 20);

  if (!trailer) return res.status(400).send("Trailer required");

  const allowedDir = ["Inbound", "Outbound", "Cross Dock"];
  const allowedStatus = ["Incoming", "Loading", "Ready"];

  if (!allowedDir.includes(direction))
    return res.status(400).send("Invalid direction");

  if (!allowedStatus.includes(status))
    return res.status(400).send("Invalid status");

  const prev = trailers[trailer] || {};

  trailers[trailer] = {
    direction,
    status,
    door: door || prev.door || "",
    updatedAt: Date.now()
  };

  broadcast("state", trailers);
  broadcast("stats", computeStats(trailers));
  res.json({ ok: true });
});

// Delete trailer
app.post("/api/delete", (req, res) => {
  const trailer = cleanStr(req.body?.trailer, 20);
  if (!trailer) return res.status(400).send("Trailer required");

  delete trailers[trailer];

  broadcast("state", trailers);
  broadcast("stats", computeStats(trailers));
  res.json({ ok: true });
});

// Clear board
app.post("/api/clear", (req, res) => {
  trailers = {};

  broadcast("state", trailers);
  broadcast("stats", computeStats(trailers));
  res.json({ ok: true });
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
      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>Trailer</th>
            <th>Door</th>
            <th>IP</th>
            <th>User Agent</th>
          </tr>
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
              '<td>'+(x.ip||'')+'</td>'+
              '<td style="max-width:400px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">'+(x.userAgent||'')+'</td>';
            tb.appendChild(tr);
          });
        }
        load();
        setInterval(load,3000);
      </script>
    </body>
    </html>
  `);
});

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
server.listen(PORT, () => {
  console.log("Running on port", PORT);
});
