const express = require("express");
const http = require("http");
const path = require("path");
const WebSocket = require("ws");

const app = express();
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// In-memory storage
let trailers = {};

// ---------- Serve root index.html ----------
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// ---------- WebSocket ----------
function broadcast(type, payload) {
  const msg = JSON.stringify({ type, payload });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
}

wss.on("connection", (ws) => {
  ws.send(JSON.stringify({ type: "state", payload: trailers }));
});

// ---------- API ----------
app.get("/api/state", (req, res) => {
  res.json(trailers);
});

app.post("/api/upsert", (req, res) => {
  const { trailer, status, dockDoor, notes } = req.body;

  if (!trailer || !status) {
    return res.status(400).json({ error: "Missing trailer or status" });
  }

  const prevStatus = trailers[trailer]?.status || null;

  trailers[trailer] = {
    status,
    dockDoor,
    notes,
    updatedAt: Date.now()
  };

  broadcast("upsert", {
    trailer,
    ...trailers[trailer],
    prevStatus
  });

  res.json({ ok: true });
});

app.post("/api/delete", (req, res) => {
  const { trailer } = req.body;

  if (!trailer) return res.status(400).json({ error: "Missing trailer" });

  delete trailers[trailer];
  broadcast("delete", { trailer });

  res.json({ ok: true });
});

app.post("/api/clear", (req, res) => {
  trailers = {};
  broadcast("state", trailers);
  res.json({ ok: true });
});

// ---------- Start ----------
const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
