// server.js (FULL CLEAN) — Inbound/Outbound + WebSocket + Shared State
const express = require("express");
const http = require("http");
const path = require("path");
const WebSocket = require("ws");

const app = express();
app.use(express.json());

// ---- Serve the single index.html from repo root ----
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// (Optional) quick health check
app.get("/health", (req, res) => res.json({ ok: true }));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Shared in-memory storage
// { "TR123": { type:"Inbound", status:"Arrived", updatedAt: 123456789 } }
let trailers = {};

// ---- WebSocket broadcast helper ----
function broadcast(type, payload) {
  const msg = JSON.stringify({ type, payload });
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  }
}

// ---- WebSocket: send full state on connect ----
wss.on("connection", (ws) => {
  ws.send(JSON.stringify({ type: "state", payload: trailers }));
});

// ---- API: fallback polling state ----
app.get("/api/state", (req, res) => res.json(trailers));

// ---- API: add/update trailer (Inbound/Outbound) ----
app.post("/api/upsert", (req, res) => {
  const trailer = String(req.body.trailer || "").trim();
  const type = String(req.body.type || "").trim();
  const status = String(req.body.status || "").trim();

  if (!trailer) return res.status(400).json({ error: "Trailer required" });
  if (!["Inbound", "Outbound"].includes(type)) {
    return res.status(400).json({ error: "Invalid type" });
  }

  const inboundStatuses = ["Arrived", "Door Assigned", "Unloading", "Staged", "Completed"];
  const outboundStatuses = ["Scheduled", "Loading", "Sealed", "Released"];
  const validStatuses = type === "Inbound" ? inboundStatuses : outboundStatuses;

  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: "Invalid status" });
  }

  const prevStatus = trailers[trailer]?.status || null;

  trailers[trailer] = {
    type,
    status,
    updatedAt: Date.now()
  };

  broadcast("upsert", { trailer, ...trailers[trailer], prevStatus });
  res.json({ ok: true });
});

// ---- API: delete trailer ----
app.post("/api/delete", (req, res) => {
  const trailer = String(req.body.trailer || "").trim();
  if (!trailer) return res.status(400).json({ error: "Trailer required" });

  if (trailers[trailer]) {
    delete trailers[trailer];
    broadcast("delete", { trailer });
  }

  res.json({ ok: true });
});

// ---- API: clear all ----
app.post("/api/clear", (req, res) => {
  trailers = {};
  broadcast("state", trailers);
  res.json({ ok: true });
});

// ---- Start server ----
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Running on port", PORT));
