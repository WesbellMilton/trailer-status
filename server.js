const express = require("express");
const http = require("http");
const path = require("path");
const WebSocket = require("ws");

const app = express();
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// In-memory shared board (same for all users)
// trailers = {
//   "1850": { direction:"Inbound", status:"Incoming", door:"D12", eta:"09:30", notes:"Paperwork", updatedBy:"Chris", updatedAt: 123 }
// }
let trailers = {};

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
    byDirection: { Inbound: 0, Outbound: 0, "Cross Dock": 0 },
    byStatus: { Incoming: 0, Loading: 0, Ready: 0 }
  };

  for (const [, v] of Object.entries(board)) {
    stats.total += 1;
    if (v.direction && stats.byDirection[v.direction] !== undefined) stats.byDirection[v.direction] += 1;
    if (v.status && stats.byStatus[v.status] !== undefined) stats.byStatus[v.status] += 1;
  }
  return stats;
}

// Serve the ONE index.html from repo root
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// Health check (easy testing)
app.get("/health", (req, res) => res.json({ ok: true }));

// API
app.get("/api/state", (req, res) => {
  res.json(trailers);
});

// Counts endpoint (for top KPI bar later)
app.get("/api/stats", (req, res) => {
  res.json(computeStats(trailers));
});

app.post("/api/upsert", (req, res) => {
  const trailer = cleanStr(req.body?.trailer, 20);
  const direction = cleanStr(req.body?.direction, 30);
  const status = cleanStr(req.body?.status, 30);

  // NEW optional fields (safe defaults)
  const door = cleanStr(req.body?.door, 20);         // e.g. "D12", "Yard A"
  const eta = cleanStr(req.body?.eta, 40);           // e.g. "09:30" or ISO string
  const notes = cleanStr(req.body?.notes, 120);      // short notes
  const updatedBy = cleanStr(req.body?.updatedBy, 30); // initials/name

  if (!trailer) return res.status(400).send("Trailer required");

  const allowedDir = ["Inbound", "Outbound", "Cross Dock"];
  const allowedStatus = ["Incoming", "Loading", "Ready"];

  // Keep existing validation (but don’t break old clients)
  if (!allowedDir.includes(direction)) return res.status(400).send("Invalid direction");
  if (!allowedStatus.includes(status)) return res.status(400).send("Invalid status");

  const prev = trailers[trailer] || {};

  trailers[trailer] = {
    direction,
    status,
    door: door || prev.door || "",
    eta: eta || prev.eta || "",
    notes: notes || prev.notes || "",
    updatedBy: updatedBy || prev.updatedBy || "",
    updatedAt: Date.now()
  };

  broadcast("state", trailers);
  broadcast("stats", computeStats(trailers));
  res.json({ ok: true, trailer, record: trailers[trailer] });
});

app.post("/api/delete", (req, res) => {
  const trailer = cleanStr(req.body?.trailer, 20);
  if (!trailer) return res.status(400).send("Trailer required");

  delete trailers[trailer];
  broadcast("state", trailers);
  broadcast("stats", computeStats(trailers));
  res.json({ ok: true });
});

app.post("/api/clear", (req, res) => {
  trailers = {};
  broadcast("state", trailers);
  broadcast("stats", computeStats(trailers));
  res.json({ ok: true });
});

// WebSocket: send full state on connect
wss.on("connection", (ws) => {
  ws.send(JSON.stringify({ type: "state", payload: trailers }));
  ws.send(JSON.stringify({ type: "stats", payload: computeStats(trailers) }));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("Running on port", PORT);
});
