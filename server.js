const express = require("express");
const http = require("http");
const path = require("path");
const WebSocket = require("ws");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// In-memory data (simple). For restart-proof storage, I can add SQLite.
let trailers = {}; // { "TR123": { status: "Incoming", updatedAt: 123456789 } }

function broadcast(type, payload) {
  const msg = JSON.stringify({ type, payload });
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  }
}

wss.on("connection", (ws) => {
  // Send current state immediately
  ws.send(JSON.stringify({ type: "state", payload: trailers }));
});

app.get("/api/state", (req, res) => res.json(trailers));

app.post("/api/upsert", (req, res) => {
  const trailer = String(req.body.trailer || "").trim();
  const status = String(req.body.status || "").trim();

  if (!trailer) return res.status(400).json({ error: "Trailer required" });
  if (!["Incoming", "Loading", "Ready"].includes(status)) {
    return res.status(400).json({ error: "Invalid status" });
  }

  const prev = trailers[trailer]?.status;
  trailers[trailer] = { status, updatedAt: Date.now() };

  broadcast("upsert", { trailer, ...trailers[trailer], prevStatus: prev || null });
  res.json({ ok: true });
});

app.post("/api/checkin", (req, res) => {
  const trailer = String(req.body.trailer || "").trim();
  if (!trailer) return res.status(400).json({ error: "Trailer required" });

  // Don’t overwrite if already exists
  if (!trailers[trailer]) {
    trailers[trailer] = { status: "Incoming", updatedAt: Date.now() };
    broadcast("upsert", { trailer, ...trailers[trailer], prevStatus: null });
  }

  res.json({ ok: true });
});

app.post("/api/delete", (req, res) => {
  const trailer = String(req.body.trailer || "").trim();
  if (!trailer) return res.status(400).json({ error: "Trailer required" });

  if (trailers[trailer]) {
    delete trailers[trailer];
    broadcast("delete", { trailer });
  }
  res.json({ ok: true });
});

app.post("/api/clear", (req, res) => {
  trailers = {};
  broadcast("state", trailers);
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Running on port", PORT));
