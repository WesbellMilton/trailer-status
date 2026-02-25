const express = require("express");
const http = require("http");
const path = require("path");
const WebSocket = require("ws");

const app = express();
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// state: { "TR123": { status, dockDoor, notes, updatedAt } }
let trailers = {};

function broadcast(type, payload) {
  const msg = JSON.stringify({ type, payload });
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  }
}

wss.on("connection", (ws) => {
  ws.send(JSON.stringify({ type: "state", payload: trailers }));
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/api/ping", (req, res) => {
  res.json({ ok: true, time: Date.now() });
});

app.get("/api/state", (req, res) => {
  res.json(trailers);
});

app.post("/api/upsert", (req, res) => {
  const trailer = String(req.body.trailer || "").trim();
  const status = String(req.body.status || "Incoming").trim();
  const dockDoor = String(req.body.dockDoor || "").trim();
  const notes = String(req.body.notes || "").trim();

  if (!trailer) return res.status(400).json({ error: "Trailer required" });

  const prevStatus = trailers[trailer] ? trailers[trailer].status : null;

  trailers[trailer] = { status, dockDoor, notes, updatedAt: Date.now() };

  broadcast("upsert", { trailer, ...trailers[trailer], prevStatus });
  res.json({ ok: true });
});

app.post("/api/delete", (req, res) => {
  const trailer = String(req.body.trailer || "").trim();
  if (!trailer) return res.status(400).json({ error: "Trailer required" });

  delete trailers[trailer];
  broadcast("delete", { trailer });
  res.json({ ok: true });
});

app.post("/api/clear", (req, res) => {
  trailers = {};
  broadcast("state", trailers);
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Running on port", PORT));
