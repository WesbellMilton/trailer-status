const express = require("express");
const path = require("path");

const app = express();
app.use(express.json());

// ---------- Serve index.html ----------
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// ---------- Health check ----------
app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// ---------- In-memory shared board (same for everyone) ----------
let trailers = {}; 
// trailers = {
//   "TR123": { direction: "Inbound", status: "Incoming", updatedAt: 1700000000000 }
// }

// ---------- API ----------
app.get("/api/state", (req, res) => {
  res.json(trailers);
});

app.post("/api/upsert", (req, res) => {
  const trailer = String(req.body.trailer || "").trim();
  const direction = String(req.body.direction || "Inbound").trim();
  const status = String(req.body.status || "Incoming").trim();

  if (!trailer) return res.status(400).json({ error: "Trailer required" });

  const allowedDirections = ["Inbound", "Outbound", "Cross Dock"];
  const allowedStatuses = ["Incoming", "Loading", "Ready"];

  if (!allowedDirections.includes(direction)) {
    return res.status(400).json({ error: "Invalid direction" });
  }
  if (!allowedStatuses.includes(status)) {
    return res.status(400).json({ error: "Invalid status" });
  }

  trailers[trailer] = { direction, status, updatedAt: Date.now() };
  res.json({ ok: true });
});

app.post("/api/delete", (req, res) => {
  const trailer = String(req.body.trailer || "").trim();
  if (!trailer) return res.status(400).json({ error: "Trailer required" });

  delete trailers[trailer];
  res.json({ ok: true });
});

app.post("/api/clear", (req, res) => {
  trailers = {};
  res.json({ ok: true });
});

// IMPORTANT: Render provides PORT (often 10000)
const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log("Running on port", PORT);
});
