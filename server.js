const express = require("express");
const http = require("http");
const path = require("path");
const WebSocket = require("ws");

const app = express();
app.use(express.json());

// ✅ Serve static files from /public
app.use(express.static(path.join(__dirname, "public")));

// ✅ Force homepage to load public/index.html
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// -----------------------------
// In-memory trailer storage
// { "TR123": { status, dockDoor, notes, updatedAt } }
// -----------------------------
let trailers = {};

// -----------------------------
// WebSocket broadcast helper
// -----------------------------
function broadcast(type, payload) {
  const message = JSON.stringify({ type, payload });

  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

// Send full state on new connection
wss.on("connection", (ws) => {
  ws.send(JSON.stringify({ type: "state", payload: trailers }));
});

// -----------------------------
// API ROUTES
// -----------------------------

// Get current state
app.get("/api/state", (req, res) => {
  res.json(trailers);
});

// Add or update trailer
app.post("/api/upsert", (req, res) => {
  const trailer = String(req.body.trailer || "").trim();
  const status = String(req.body.status || "").trim();
  const dockDoor = String(req.body.dockDoor || "").trim();
  const notes = String(req.body.notes || "").trim();

  if (!trailer) {
    return res.status(400).json({ error: "Trailer required" });
  }

  if (!["Incoming", "Loading", "Ready"].includes(status)) {
    return res.status(400).json({ error: "Invalid status" });
  }

  const prevStatus = trailers[trailer]?.status || null;

  trailers[trailer] = {
    status,
    dockDoor,
    notes,
    updatedAt: Date.now(),
  };

  broadcast("upsert", {
    trailer,
    ...trailers[trailer],
    prevStatus,
  });

  res.json({ ok: true });
});

// Check-in (Incoming only, don’t overwrite existing)
app.post("/api/checkin", (req, res) => {
  const trailer = String(req.body.trailer || "").trim();

  if (!trailer) {
    return res.status(400).json({ error: "Trailer required" });
  }

  if (!trailers[trailer]) {
    trailers[trailer] = {
      status: "Incoming",
      dockDoor: "",
      notes: "",
      updatedAt: Date.now(),
    };

    broadcast("upsert", {
      trailer,
      ...trailers[trailer],
      prevStatus: null,
    });
  }

  res.json({ ok: true });
});

// Delete trailer
app.post("/api/delete", (req, res) => {
  const trailer = String(req.body.trailer || "").trim();

  if (!trailer) {
    return res.status(400).json({ error: "Trailer required" });
  }

  if (trailers[trailer]) {
    delete trailers[trailer];
    broadcast("delete", { trailer });
  }

  res.json({ ok: true });
});

// Clear all
app.post("/api/clear", (req, res) => {
  trailers = {};
  broadcast("state", trailers);
  res.json({ ok: true });
});

// -----------------------------
// Start server (Render compatible)
// -----------------------------
const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(✅ Server running on port ${PORT});
});
