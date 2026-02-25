const express = require("express");
const http = require("http");
const path = require("path");
const WebSocket = require("ws");

const app = express();
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

let trailers = {}; // { "TR123": {status,dockDoor,notes,updatedAt} }

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/api/ping", (req, res) => {
  res.json({ ok: true, time: Date.now() });
});

function broadcast(type, payload) {
  const msg = JSON.stringify({ type, payload });
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  });
}

wss.on("connection", (ws) => {
  ws.send(JSON.stringify({ type: "state", payload: trailers }));
});

app.get("/api/state", (req, res) => res.json(trailers));

app.post("/api/upsert", (req, res) => {
  const trailer = String(req.body.trailer || "").trim();
  const status = String(req.body.status || "").trim();
  const dockDoor = String(req.body.dockDoor || "").trim();
  const notes = String(req.body.notes || "").trim();

  if (!trailer || !status) return res.status(400).json({ error: "Missing trailer or status" });

  const prevStatus = trailers[trailer] ? trailers[trailer].status : null;

  trailers[trailer] = { status, dockDoor, notes, updatedAt: Date.now() };

  broadcast("upsert", { trailer, status, dockDoor, notes, updatedAt: trailers[trailer].updatedAt, prevStatus });
  res.json({ ok: true });
});

app.post("/api/delete", (req, res) => {
  const trailer = String(req.body.trailer || "").trim();
  if (!trailer) return res.status(400).json({ error: "Missing trailer" });

  if (trailers[trailer]) delete trailers[trailer];
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
