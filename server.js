// server.js — Wesbell Dispatch (WS realtime + Web Push)
const express = require("express");
const http = require("http");
const path = require("path");
const WebSocket = require("ws");
const crypto = require("crypto");
const cookieParser = require("cookie-parser");
const webpush = require("web-push");

const app = express();
app.use(express.json({ limit: "300kb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Serve /public at ROOT (so /sw.js works)
const PUBLIC_DIR = path.join(__dirname, "public");
app.use(express.static(PUBLIC_DIR));

// ─────────────────────────────────────────────
// Simple in-memory state (swap to SQLite later if you want)
// ─────────────────────────────────────────────
let trailers = {};        // { [trailerNum]: {direction,status,door,note,dropType,carrierType,updatedAt} }
let dockPlates = {};      // { [door]: {status,note,updatedAt} }
let confirmations = [];   // array of {at,trailer,door,action,ip}

const VERSION = "5.0.0";

// ─────────────────────────────────────────────
// Very-light auth (PINs + session cookie)
// - Replace with your SQLite/session system later if needed
// ─────────────────────────────────────────────
const COOKIE_NAME = "wb_session";
const SESSIONS = new Map(); // sid -> { role, createdAt }
const PINS = {
  dispatcher: process.env.PIN_DISPATCHER || "1111",
  dock:       process.env.PIN_DOCK       || "2222",
  supervisor: process.env.PIN_SUPERVISOR || "3333",
  admin:      process.env.PIN_ADMIN      || "9999"
};

function makeSid() {
  return crypto.randomBytes(24).toString("hex");
}

function getRole(req) {
  const sid = req.cookies[COOKIE_NAME];
  if (!sid) return null;
  const s = SESSIONS.get(sid);
  return s?.role || null;
}

function requireRole(roles) {
  return (req, res, next) => {
    const role = getRole(req);
    if (!role) return res.status(401).json({ error: "not_authenticated" });
    if (Array.isArray(roles) && roles.length && !roles.includes(role)) {
      return res.status(403).json({ error: "forbidden" });
    }
    req.role = role;
    next();
  };
}

// ─────────────────────────────────────────────
// Web Push (VAPID)
// - IMPORTANT: set env vars in Render:
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT
// - OR run once locally to generate a pair (see note below)
// ─────────────────────────────────────────────
const VAPID_PUBLIC_KEY  = process.env.VAPID_PUBLIC_KEY  || "";
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "";
const VAPID_SUBJECT     = process.env.VAPID_SUBJECT     || "mailto:dispatch@example.com";

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
} else {
  console.warn("⚠️ Web Push disabled: missing VAPID keys (VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY).");
}

// store subscriptions in memory
const PUSH_SUBS = new Map(); // endpoint -> subscription json

// ─────────────────────────────────────────────
// HTTP routes
// ─────────────────────────────────────────────

// Single-page app routes all serve index.html
const SPA_ROUTES = ["/", "/dock", "/driver", "/supervisor", "/login"];
SPA_ROUTES.forEach((r) => {
  app.get(r, (req, res) => res.sendFile(path.join(PUBLIC_DIR, "index.html")));
});

// Auth APIs
app.post("/api/login", (req, res) => {
  const { role, pin } = req.body || {};
  if (!role || !pin) return res.status(400).json({ error: "missing_fields" });
  const expected = PINS[String(role).toLowerCase()];
  if (!expected || String(pin) !== String(expected)) return res.status(401).json({ error: "bad_pin" });

  const sid = makeSid();
  SESSIONS.set(sid, { role: String(role).toLowerCase(), createdAt: Date.now() });
  res.cookie(COOKIE_NAME, sid, {
    httpOnly: true,
    sameSite: "lax",
    secure: false // Render uses HTTPS at edge; ok if false here, but you can set true if you prefer
  });
  res.json({ ok: true, role: String(role).toLowerCase() });
});

app.post("/api/logout", (req, res) => {
  const sid = req.cookies[COOKIE_NAME];
  if (sid) SESSIONS.delete(sid);
  res.clearCookie(COOKIE_NAME);
  res.json({ ok: true });
});

app.get("/api/whoami", (req, res) => {
  const role = getRole(req);
  res.json({ role, version: VERSION });
});

// State APIs
app.get("/api/state", (req, res) => res.json(trailers));
app.get("/api/dockplates", (req, res) => res.json(dockPlates));
app.get("/api/confirmations", (req, res) => res.json(confirmations));

// Driver assignment lookup
app.get("/api/driver/assignment", (req, res) => {
  const t = String(req.query.trailer || "").trim();
  if (!t) return res.json({ found: false });
  const r = trailers[t];
  if (!r) return res.json({ found: false });
  res.json({ found: true, trailer: t, door: r.door || "", direction: r.direction || "", status: r.status || "" });
});

// Upsert trailer (dispatcher/admin/dock can change statuses; your UI already gates it)
app.post("/api/upsert", requireRole(["dispatcher", "dock", "admin", "supervisor"]), (req, res) => {
  const role = req.role;
  const { trailer } = req.body || {};
  const t = String(trailer || "").trim();
  if (!t) return res.status(400).json({ error: "trailer_required" });

  const before = trailers[t] || {};
  const next = {
    ...before,
    ...cleanTrailerPatch(req.body || {}),
    updatedAt: Date.now()
  };
  trailers[t] = next;

  broadcastWS({ type: "state", payload: trailers });
  broadcastWS({ type: "version", payload: { version: VERSION } });

  // If this transition becomes READY, broadcast a notify + push
  if (before.status !== "Ready" && next.status === "Ready") {
    const payload = { kind: "ready", trailer: t, door: next.door || "" };
    broadcastWS({ type: "notify", payload });
    sendPushToAll({
      title: "Trailer Ready",
      body: `${t} is READY${next.door ? ` at door ${next.door}` : ""}.`,
      url: "/driver"
    });
  }

  audit(role, "trailer_update", "trailer", t, { patch: req.body });
  res.json({ ok: true });
});

function cleanTrailerPatch(body) {
  const patch = {};
  ["direction", "status", "door", "note", "dropType", "carrierType"].forEach((k) => {
    if (body[k] !== undefined) patch[k] = String(body[k] ?? "").trim();
  });
  return patch;
}

app.post("/api/delete", requireRole(["dispatcher", "admin"]), (req, res) => {
  const t = String(req.body?.trailer || "").trim();
  if (!t) return res.status(400).json({ error: "trailer_required" });
  delete trailers[t];
  broadcastWS({ type: "state", payload: trailers });
  audit(req.role, "trailer_delete", "trailer", t, {});
  res.json({ ok: true });
});

app.post("/api/clear", requireRole(["dispatcher", "admin"]), (req, res) => {
  trailers = {};
  broadcastWS({ type: "state", payload: trailers });
  audit(req.role, "trailer_clear_all", "trailer", "*", {});
  res.json({ ok: true });
});

// Shunt trailer (move to a new door)
app.post("/api/shunt", requireRole(["dispatcher", "admin", "dock"]), (req, res) => {
  const t = String(req.body?.trailer || "").trim();
  const door = String(req.body?.door || "").trim();
  if (!t || !door) return res.status(400).json({ error: "missing_fields" });

  const before = trailers[t] || { direction: "Inbound", status: "Dropped" };
  trailers[t] = {
    ...before,
    door,
    status: "Dropped",
    updatedAt: Date.now()
  };

  broadcastWS({ type: "state", payload: trailers });
  audit(req.role, "trailer_update", "trailer", t, { shuntTo: door });
  res.json({ ok: true });
});

// Driver drop endpoint (no auth needed)
app.post("/api/driver/drop", (req, res) => {
  const { trailer, door, dropType, carrierType } = req.body || {};
  const t = String(trailer || "").trim();
  let d = String(door || "").trim();
  if (!t) return res.status(400).json({ error: "trailer_required" });

  // auto-assign door if not provided
  if (!d) d = pickFreeDoor() || "";

  const existing = trailers[t] || {};
  trailers[t] = {
    ...existing,
    trailer: t,
    direction: existing.direction || "Inbound",
    status: "Dropped",
    door: d,
    dropType: String(dropType || existing.dropType || "").trim(),
    carrierType: String(carrierType || existing.carrierType || "").trim(),
    updatedAt: Date.now()
  };

  broadcastWS({ type: "state", payload: trailers });
  audit("driver", "driver_drop", "trailer", t, { door: d, dropType, carrierType });
  res.json({ ok: true, door: d });
});

function pickFreeDoor() {
  const occupied = new Set();
  Object.values(trailers).forEach((r) => {
    if (r?.door && r.status !== "Departed") occupied.add(String(r.door));
  });
  for (let d = 28; d <= 42; d++) {
    const ds = String(d);
    if (!occupied.has(ds)) return ds;
  }
  return null;
}

// Cross dock endpoints
app.post("/api/crossdock/pickup", (req, res) => {
  const t = String(req.body?.trailer || "").trim();
  const door = String(req.body?.door || "").trim();
  if (!t || !door) return res.status(400).json({ error: "missing_fields" });
  audit("driver", "crossdock_pickup", "trailer", t, { door });
  res.json({ ok: true });
});

app.post("/api/crossdock/offload", (req, res) => {
  const t = String(req.body?.trailer || "").trim();
  const door = String(req.body?.door || "").trim();
  if (!t || !door) return res.status(400).json({ error: "missing_fields" });

  const existing = trailers[t] || {};
  trailers[t] = {
    ...existing,
    direction: "Cross Dock",
    status: existing.status || "Dropped",
    door,
    updatedAt: Date.now()
  };

  broadcastWS({ type: "state", payload: trailers });
  audit("driver", "crossdock_offload", "trailer", t, { door });
  res.json({ ok: true });
});

// Safety confirmation
app.post("/api/confirm-safety", (req, res) => {
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "";
  const { trailer, door, action } = req.body || {};
  confirmations.unshift({
    at: Date.now(),
    trailer: String(trailer || "").trim(),
    door: String(door || "").trim(),
    action: String(action || "").trim(),
    ip: String(ip)
  });
  confirmations = confirmations.slice(0, 500);
  broadcastWS({ type: "confirmations", payload: confirmations });
  audit("driver", "safety_confirmed", "confirm", String(trailer || ""), { door, action });
  res.json({ ok: true });
});

// Dock plates
app.post("/api/dockplates/set", requireRole(["dispatcher", "dock", "admin"]), (req, res) => {
  const door = String(req.body?.door || "").trim();
  const status = String(req.body?.status || "Unknown").trim();
  const note = String(req.body?.note || "").trim();
  if (!door) return res.status(400).json({ error: "door_required" });

  dockPlates[door] = { status, note, updatedAt: Date.now() };
  broadcastWS({ type: "dockplates", payload: dockPlates });
  audit(req.role, "plate_set", "plate", door, { status, note });
  res.json({ ok: true });
});

// Push endpoints
app.get("/api/push/vapid-public-key", (req, res) => {
  if (!VAPID_PUBLIC_KEY) return res.status(503).json({ error: "push_disabled_no_vapid" });
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

app.post("/api/push/subscribe", (req, res) => {
  const sub = req.body;
  if (!sub?.endpoint) return res.status(400).json({ error: "bad_subscription" });
  PUSH_SUBS.set(sub.endpoint, sub);
  res.json({ ok: true });
});

app.post("/api/push/unsubscribe", (req, res) => {
  const endpoint = String(req.body?.endpoint || "");
  if (endpoint) PUSH_SUBS.delete(endpoint);
  res.json({ ok: true });
});

// Audit feed (simple)
let AUDIT = []; // newest first
app.get("/api/audit", requireRole(["dispatcher", "admin", "supervisor"]), (req, res) => {
  const limit = Math.max(1, Math.min(500, parseInt(req.query.limit || "200", 10)));
  res.json(AUDIT.slice(0, limit));
});

function audit(actorRole, action, entityType, entityId, details) {
  const ip = ""; // keep simple, can add x-forwarded-for later
  AUDIT.unshift({
    at: Date.now(),
    actorRole,
    action,
    entityType,
    entityId,
    details: details || {},
    ip
  });
  AUDIT = AUDIT.slice(0, 1000);
}

// ─────────────────────────────────────────────
// WebSocket realtime
// ─────────────────────────────────────────────
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

function broadcastWS(msgObj) {
  const msg = JSON.stringify(msgObj);
  wss.clients.forEach((c) => {
    if (c.readyState === WebSocket.OPEN) c.send(msg);
  });
}

wss.on("connection", (ws) => {
  ws.send(JSON.stringify({ type: "version", payload: { version: VERSION } }));
  ws.send(JSON.stringify({ type: "state", payload: trailers }));
  ws.send(JSON.stringify({ type: "dockplates", payload: dockPlates }));
  ws.send(JSON.stringify({ type: "confirmations", payload: confirmations }));
});

// ─────────────────────────────────────────────
// Push helper
// ─────────────────────────────────────────────
async function sendPushToAll({ title, body, url }) {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return;
  const payload = JSON.stringify({ title, body, url });

  const subs = Array.from(PUSH_SUBS.values());
  await Promise.allSettled(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(sub, payload);
      } catch (e) {
        // If subscription is dead, remove it
        if (e?.statusCode === 410 || e?.statusCode === 404) {
          PUSH_SUBS.delete(sub.endpoint);
        }
      }
    })
  );
}

// ─────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("✅ Server running on port", PORT));

/*
VAPID NOTE (LOCAL):
You can generate keys once with:
  node -e "const webpush=require('web-push'); console.log(webpush.generateVAPIDKeys())"
Then set in Render env vars:
  VAPID_PUBLIC_KEY=...
  VAPID_PRIVATE_KEY=...
  VAPID_SUBJECT=mailto:you@company.com
*/
