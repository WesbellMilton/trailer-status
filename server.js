const express = require("express");
const http = require("http");
const path = require("path");
const WebSocket = require("ws");

const app = express();
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// In-memory storage
let trailers = {}; // { "1850": { status:"Incoming", notes:"...", updatedAt: 123 } }

// Serve the single HTML file at /
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// Helpful: confirm server is alive
app.get("/health", (req, res) => res.json({ ok: true }));

function broadcast(type, payload) {
  const msg = JSON.stringify({ type, payload });
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  }
}

wss.on("connection", (ws) => {
  ws.send(JSON.stringify({ type: "state", payload: trailers }));
});

// API: get full state
app.get("/api/state", (req, res) => {
  res.json(trailers);
});

// API: add/update
app.post("/api/upsert", (req, res) => {
  const trailer = String(req.body.trailer || "").trim();
  const status = String(req.body.status || "").trim();
  const notes = String(req.body.notes || "").trim();

  if (!trailer) return res.status(400).json({ error: "Trailer required" });
  if (!["Incoming", "Loading", "Ready"].includes(status)) {
    return res.status(400).json({ error: "Invalid status" });
  }

  const prevStatus = trailers[trailer]?.status || null;

  trailers[trailer] = {
    status,
    notes,
    updatedAt: Date.now(),
  };

  broadcast("upsert", { trailer, ...trailers[trailer], prevStatus });
  res.json({ ok: true });
});

// API: delete
app.post("/api/delete", (req, res) => {
  const trailer = String(req.body.trailer || "").trim();
  if (!trailer) return res.status(400).json({ error: "Trailer required" });

  if (trailers[trailer]) {
    delete trailers[trailer];
    broadcast("delete", { trailer });
  }
  res.json({ ok: true });
});

// API: clear all
app.post("/api/clear", (req, res) => {
  trailers = {};
  broadcast("state", trailers);
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Running on port", PORT));
