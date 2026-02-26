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
//   "1850": { direction:"Inbound", status:"Incoming", door:"D12", updatedAt: 123 }
// }
let trailers = {};

// NEW: store driver safety confirmations (latest first)
let confirmations = [];
// confirmations = [
//   { at: 123, trailer:"1850", door:"D12", ip:"", userAgent:"" }
// ];

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

// NEW: Safety confirm endpoints
app.post("/api/confirm-safety", (req, res) => {
  const trailer = cleanStr(req.body?.trailer, 20); // optional (can be blank)
  const door = cleanStr(req.body?.door, 20);       // optional (can be blank)
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

  // keep last 200
  confirmations = confirmations.slice(0, 200);

  broadcast("confirmations", confirmations);
  res.json({ ok: true });
});

app.get("/api/confirmations", (req, res) => {
  res.json(confirmations);
});

app.post("/api/upsert", (req, res) => {
  const trailer = cleanStr(req.body?.trailer, 20);
  const direction = cleanStr(req.body?.direction, 30);
  const status = cleanStr(req.body?.status, 30);

  // Dock Door / Spot
  const door = cleanStr(req.body?.door, 20); // e.g., "D12", "Yard A"

  if (!trailer) return res.status(400).send("Trailer required");

  const allowedDir = ["Inbound", "Outbound", "Cross Dock"];
  const allowedStatus = ["Incoming", "Loading", "Ready"];

  if (!allowedDir.includes(direction)) return res.status(400).send("Invalid direction");
  if (!allowedStatus.includes(status)) return res.status(400).send("Invalid status");

  const prev = trailers[trailer] || {};

  trailers[trailer] = {
    direction,
    status,
    // keep previous door if not provided
    door: door || prev.door || "",
    updatedAt: Date.now()
  };

  broadcast("state", trailers);
  res.json({ ok: true });
});

app.post("/api/delete", (req, res) => {
  const trailer = cleanStr(req.body?.trailer, 20);
  if (!trailer) return res.status(400).send("Trailer required");

  delete trailers[trailer];
  broadcast("state", trailers);
  res.json({ ok: true });
});

app.post("/api/clear", (req, res) => {
  trailers = {};
  broadcast("state", trailers);
  res.json({ ok: true });
});

// WebSocket: send full state + confirmations on connect
wss.on("connection", (ws) => {
  ws.send(JSON.stringify({ type: "state", payload: trailers }));
  ws.send(JSON.stringify({ type: "confirmations", payload: confirmations }));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("Running on port", PORT);
});
