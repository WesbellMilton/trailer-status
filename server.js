const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const WebSocket = require("ws");
const sqlite3 = require("sqlite3").verbose();
const crypto = require("crypto");

const app = express();
app.set("trust proxy", true);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

/* =========================
   CONFIG
========================= */
const APP_VERSION = process.env.APP_VERSION || "2.3.0";
const DISPATCHER_PIN = String(process.env.DISPATCHER_PIN || "1234");
const DOCK_PIN = String(process.env.DOCK_PIN || "789");
const LINK_SIGNING_SECRET = String(process.env.LINK_SIGNING_SECRET || "change_me");

/**
 * SQLite path:
 * - local default: ./data.db
 * - Render persistent disk: set DB_PATH=/var/data/data.db
 */
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "data.db");

// Ensure DB directory exists if using a mounted disk path
try {
  const dir = path.dirname(DB_PATH);
  if (dir && dir !== "." && dir !== __dirname) fs.mkdirSync(dir, { recursive: true });
} catch (e) {
  console.error("Failed to ensure DB directory:", e);
}

const db = new sqlite3.Database(DB_PATH);

// In-memory caches
let trailers = {};
let confirmations = [];
let dockPlates = {};

/* =========================
   HELPERS
========================= */
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

function normalizeDoor(v) {
  const raw = String(v ?? "").trim();
  if (!raw) return "";
  const m = raw.match(/(\d{1,3})/);
  return m ? m[1] : raw;
}

function getIp(req) {
  return (
    (req.headers["x-forwarded-for"]?.split(",")[0]?.trim()) ||
    req.socket.remoteAddress ||
    ""
  );
}

function parseCookies(cookieHeader) {
  const out = {};
  const raw = String(cookieHeader || "");
  raw.split(";").forEach((part) => {
    const [k, ...rest] = part.trim().split("=");
    if (!k) return;
    out[k] = decodeURIComponent(rest.join("=") || "");
  });
  return out;
}

function sign(val) {
  return crypto.createHmac("sha256", LINK_SIGNING_SECRET).update(val).digest("hex");
}

function setAuthCookie(res, role) {
  const ts = Date.now();
  const base = `${role}|${ts}`;
  const sig = sign(base);
  const value = encodeURIComponent(`${base}|${sig}`);
  res.setHeader("Set-Cookie", [`auth=${value}; Path=/; HttpOnly; SameSite=Lax`]);
}

function clearAuthCookie(res) {
  res.setHeader("Set-Cookie", [`auth=; Path=/; Max-Age=0; SameSite=Lax`]);
}

function getRoleFromReq(req) {
  if (String(req.path || "").toLowerCase().startsWith("/driver")) return "driver";

  const cookies = parseCookies(req.headers.cookie);
  const auth = cookies.auth;
  if (!auth) return null;

  const decoded = decodeURIComponent(auth);
  const parts = decoded.split("|");
  if (parts.length !== 3) return null;

  const role = parts[0];
  const ts = parts[1];
  const sig = parts[2];

  if (role !== "dispatcher" && role !== "dock") return null;

  const base = `${role}|${ts}`;
  if (sign(base) !== sig) return null;

  const ageMs = Date.now() - Number(ts || 0);
  if (!Number.isFinite(ageMs) || ageMs > 12 * 60 * 60 * 1000) return null;

  return role;
}

function requireRole(roleNeeded) {
  return (req, res, next) => {
    const role = getRoleFromReq(req);
    if (role === roleNeeded) return next();
    return res.status(401).send("Unauthorized");
  };
}

function requireAnyRole(roles) {
  return (req, res, next) => {
    const role = getRoleFromReq(req);
    if (role && roles.includes(role)) return next();
    return res.status(401).send("Unauthorized");
  };
}

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

async function auditLog({ actorRole, action, entityType, entityId, details, ip, userAgent }) {
  const at = Date.now();
  await dbRun(
    `INSERT INTO audit_log (at, actorRole, action, entityType, entityId, details, ip, userAgent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      at,
      actorRole || "",
      action || "",
      entityType || "",
      entityId || "",
      JSON.stringify(details || {}),
      ip || "",
      userAgent || ""
    ]
  );
}

/* =========================
   DB INIT + CACHE LOAD
========================= */
async function initDb() {
  await dbRun(`PRAGMA journal_mode=WAL;`);
  await dbRun(`PRAGMA synchronous=NORMAL;`);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS trailers (
      trailer TEXT PRIMARY KEY,
      direction TEXT NOT NULL,
      status TEXT NOT NULL,
      door TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      dropType TEXT NOT NULL DEFAULT '',
      updatedAt INTEGER NOT NULL
    )
  `);

  // Safe migration
  await dbRun(`ALTER TABLE trailers ADD COLUMN dropType TEXT NOT NULL DEFAULT ''`).catch(() => {});

  await dbRun(`
    CREATE TABLE IF NOT EXISTS confirmations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL,
      trailer TEXT NOT NULL DEFAULT '',
      door TEXT NOT NULL DEFAULT '',
      ip TEXT NOT NULL DEFAULT '',
      userAgent TEXT NOT NULL DEFAULT ''
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS dock_plates (
      door TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'Unknown',
      note TEXT NOT NULL DEFAULT '',
      updatedAt INTEGER NOT NULL
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL,
      actorRole TEXT NOT NULL,
      action TEXT NOT NULL,
      entityType TEXT NOT NULL,
      entityId TEXT NOT NULL,
      details TEXT NOT NULL,
      ip TEXT NOT NULL,
      userAgent TEXT NOT NULL
    )
  `);

  // Seed plates 18..42
  for (let d = 18; d <= 42; d++) {
    await dbRun(
      `INSERT INTO dock_plates (door, status, note, updatedAt)
       VALUES (?, 'Unknown', '', ?)
       ON CONFLICT(door) DO NOTHING`,
      [String(d), Date.now()]
    );
  }

  await reloadCachesFromDb();
}

async function reloadCachesFromDb() {
  const trows = await dbAll(`SELECT trailer, direction, status, door, note, dropType, updatedAt FROM trailers`);
  trailers = {};
  for (const r of trows) {
    trailers[r.trailer] = {
      direction: r.direction,
      status: r.status,
      door: r.door || "",
      note: r.note || "",
      dropType: r.dropType || "",
      updatedAt: r.updatedAt || 0
    };
  }

  const crows = await dbAll(`
    SELECT at, trailer, door, ip, userAgent
    FROM confirmations
    ORDER BY id DESC
    LIMIT 200
  `);
  confirmations = crows.map(r => ({
    at: r.at,
    trailer: r.trailer || "",
    door: r.door || "",
    ip: r.ip || "",
    userAgent: r.userAgent || ""
  }));

  const prows = await dbAll(`SELECT door, status, note, updatedAt FROM dock_plates`);
  dockPlates = {};
  for (const r of prows) {
    dockPlates[String(r.door)] = {
      status: r.status || "Unknown",
      note: r.note || "",
      updatedAt: r.updatedAt || 0
    };
  }
}

/* =========================
   PAGES
========================= */
app.get("/login", (req, res) => {
  res.send(`
<!doctype html>
<html>
<head>
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Login</title>
  <style>
    body{font-family:system-ui;background:#0b1220;color:#eaf0ff;margin:0;display:flex;justify-content:center;align-items:center;height:100vh}
    .card{width:340px;background:rgba(255,255,255,.04);border:1px solid rgba(120,145,220,.18);border-radius:14px;padding:18px}
    h2{margin:0 0 6px 0}
    .sub{color:#a7b2d3;font-size:12px;margin-bottom:12px}
    input{width:100%;padding:12px;border-radius:12px;border:1px solid rgba(120,145,220,.18);background:#0c132a;color:#fff}
    button{width:100%;padding:12px;border-radius:12px;border:1px solid rgba(120,145,220,.18);background:rgba(99,102,241,.25);color:#fff;font-weight:900;margin-top:10px;cursor:pointer}
    .hint{margin-top:10px;font-size:12px;color:#a7b2d3}
    a{color:#b7c5ff}
  </style>
</head>
<body>
  <div class="card">
    <h2>Wesbell Login</h2>
    <div class="sub">Dispatcher & Dock require PIN. Driver is public.</div>
    <form method="POST" action="/login">
      <input name="pin" placeholder="Enter PIN" autocomplete="off" required />
      <button type="submit">Login</button>
    </form>
    <div class="hint">Driver link: <a href="/driver">/driver</a></div>
  </div>
</body>
</html>
  `);
});

app.post("/login", (req, res) => {
  const pin = String(req.body?.pin || "").trim();

  if (pin === DISPATCHER_PIN) {
    setAuthCookie(res, "dispatcher");
    return res.redirect("/");
  }
  if (pin === DOCK_PIN) {
    setAuthCookie(res, "dock");
    return res.redirect("/dock");
  }

  res.status(401).send("Invalid PIN");
});

app.post("/api/logout", (req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});

app.get("/api/whoami", (req, res) => {
  const role = getRoleFromReq(req);
  res.json({ role: role || null, version: APP_VERSION });
});

app.get("/api/version", (req, res) => {
  res.json({ version: APP_VERSION });
});

app.get("/", (req, res) => {
  const role = getRoleFromReq(req);
  if (role !== "dispatcher") return res.redirect("/login");
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/dock", (req, res) => {
  const role = getRoleFromReq(req);
  if (role !== "dock") return res.redirect("/login");
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/driver", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/health", (req, res) => res.json({ ok: true, db: DB_PATH, version: APP_VERSION }));

/* =========================
   APIs: STATE
========================= */
app.get("/api/state", (req, res) => {
  res.json(trailers);
});

/* =========================
   APIs: DOCK PLATES
========================= */
app.get("/api/dockplates", (req, res) => {
  res.json(dockPlates);
});

app.post("/api/dockplates/set", requireAnyRole(["dispatcher", "dock"]), async (req, res) => {
  try {
    const role = getRoleFromReq(req);
    const door = normalizeDoor(req.body?.door);
    const status = cleanStr(req.body?.status, 20);
    const note = cleanStr(req.body?.note, 120);

    const allowed = ["OK", "Service", "Unknown"];
    if (!door) return res.status(400).send("Door required");
    if (!/^\d+$/.test(door)) return res.status(400).send("Invalid door");
    const doorNum = Number(door);
    if (doorNum < 18 || doorNum > 42) return res.status(400).send("Door must be 18-42");
    if (!allowed.includes(status)) return res.status(400).send("Invalid status");

    const updatedAt = Date.now();
    await dbRun(
      `INSERT INTO dock_plates (door, status, note, updatedAt)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(door) DO UPDATE SET status=excluded.status, note=excluded.note, updatedAt=excluded.updatedAt`,
      [door, status, note, updatedAt]
    );

    dockPlates[door] = { status, note, updatedAt };

    await auditLog({
      actorRole: role,
      action: "plate_set",
      entityType: "dock_plate",
      entityId: door,
      details: { status, note },
      ip: getIp(req),
      userAgent: req.headers["user-agent"] || ""
    });

    broadcast("dockplates", dockPlates);
    res.json({ ok: true });
  } catch (err) {
    console.error("dockplates/set error:", err);
    res.status(500).send("Server error");
  }
});

/* =========================
   APIs: DRIVER DROP (public)
========================= */
app.post("/api/driver/drop", async (req, res) => {
  try {
    const trailer = cleanStr(req.body?.trailer, 20);
    const door = normalizeDoor(req.body?.door);
    const dropType = cleanStr(req.body?.dropType, 12); // Empty | Loaded

    if (!trailer) return res.status(400).send("Trailer required");
    if (!door) return res.status(400).send("Door required");
    if (!/^\d+$/.test(door)) return res.status(400).send("Invalid door");
    const dn = Number(door);
    if (dn < 18 || dn > 42) return res.status(400).send("Door must be 18-42");
    if (!["Empty", "Loaded"].includes(dropType)) return res.status(400).send("Invalid drop type");

    const prev = trailers[trailer] || null;

    const updatedAt = Date.now();
    const next = {
      direction: prev?.direction || "Inbound",
      status: "Dropped",
      door,
      note: prev?.note || "",
      dropType,
      updatedAt
    };

    await dbRun(
      `INSERT INTO trailers (trailer, direction, status, door, note, dropType, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(trailer) DO UPDATE SET
         direction=excluded.direction,
         status=excluded.status,
         door=excluded.door,
         note=excluded.note,
         dropType=excluded.dropType,
         updatedAt=excluded.updatedAt`,
      [trailer, next.direction, next.status, next.door, next.note, next.dropType, updatedAt]
    );

    trailers[trailer] = next;

    await auditLog({
      actorRole: "driver",
      action: "driver_drop",
      entityType: "trailer",
      entityId: trailer,
      details: { door, dropType },
      ip: getIp(req),
      userAgent: req.headers["user-agent"] || ""
    });

    broadcast("state", trailers);
    res.json({ ok: true });
  } catch (err) {
    console.error("driver/drop error:", err);
    res.status(500).send("Server error");
  }
});

/* =========================
   APIs: CONFIRM SAFETY (driver)
========================= */
app.post("/api/confirm-safety", async (req, res) => {
  try {
    const trailer = cleanStr(req.body?.trailer, 20);
    const door = normalizeDoor(req.body?.door);
    const loadSecured = !!req.body?.loadSecured;
    const dockPlateUp = !!req.body?.dockPlateUp;

    if (!loadSecured || !dockPlateUp) {
      return res.status(400).send("Both confirmations required");
    }

    const ip = getIp(req);
    const at = Date.now();
    const userAgent = req.headers["user-agent"] || "";

    await dbRun(
      `INSERT INTO confirmations (at, trailer, door, ip, userAgent) VALUES (?, ?, ?, ?, ?)`,
      [at, trailer || "", door || "", ip, userAgent]
    );

    const crows = await dbAll(`
      SELECT at, trailer, door, ip, userAgent
      FROM confirmations
      ORDER BY id DESC
      LIMIT 200
    `);
    confirmations = crows.map(r => ({
      at: r.at,
      trailer: r.trailer || "",
      door: r.door || "",
      ip: r.ip || "",
      userAgent: r.userAgent || ""
    }));

    await auditLog({
      actorRole: "driver",
      action: "safety_confirmed",
      entityType: "trailer",
      entityId: trailer || "",
      details: { trailer, door, loadSecured: true, dockPlateUp: true },
      ip,
      userAgent
    });

    broadcast("confirmations", confirmations);
    res.json({ ok: true });
  } catch (err) {
    console.error("confirm-safety error:", err);
    res.status(500).send("Server error");
  }
});

/* =========================
   APIs: UPSERT TRAILER
========================= */
app.post("/api/upsert", async (req, res) => {
  try {
    const role = getRoleFromReq(req);
    if (!role) return res.status(401).send("Unauthorized");

    const trailer = cleanStr(req.body?.trailer, 20);
    if (!trailer) return res.status(400).send("Trailer required");

    const prev = trailers[trailer] || null;
    if (!prev) {
      if (role === "dock") return res.status(403).send("Dock cannot add trailers");
    }

    const allowedDir = ["Inbound", "Outbound", "Cross Dock"];
    const allowedStatus = ["Incoming", "Loading", "Dock Ready", "Ready", "Departed", "Dropped"];

    // Dock: status only
    if (role === "dock") {
      const status = cleanStr(req.body?.status, 30);
      if (!["Loading", "Dock Ready"].includes(status)) {
        return res.status(403).send("Dock can only set Loading or Dock Ready");
      }

      const updatedAt = Date.now();
      const next = {
        direction: prev.direction,
        status,
        door: prev.door,
        note: prev.note || "",
        dropType: prev.dropType || "",
        updatedAt
      };

      await dbRun(
        `INSERT INTO trailers (trailer, direction, status, door, note, dropType, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(trailer) DO UPDATE SET
           direction=excluded.direction,
           status=excluded.status,
           door=excluded.door,
           note=excluded.note,
           dropType=excluded.dropType,
           updatedAt=excluded.updatedAt`,
        [trailer, next.direction, next.status, next.door || "", next.note || "", next.dropType || "", updatedAt]
      );

      trailers[trailer] = next;

      await auditLog({
        actorRole: role,
        action: "trailer_status_set",
        entityType: "trailer",
        entityId: trailer,
        details: { from: prev.status, to: status },
        ip: getIp(req),
        userAgent: req.headers["user-agent"] || ""
      });

      broadcast("state", trailers);
      return res.json({ ok: true });
    }

    // Dispatcher: full control
    if (role !== "dispatcher") return res.status(403).send("Forbidden");

    const direction = cleanStr(req.body?.direction, 30) || (prev?.direction || "Inbound");
    const status = cleanStr(req.body?.status, 30) || (prev?.status || "Incoming");
    const door = normalizeDoor(req.body?.door ?? prev?.door ?? "");
    const note = cleanStr(req.body?.note, 160);
    const dropType = cleanStr(req.body?.dropType, 12) || (prev?.dropType || "");

    if (!allowedDir.includes(direction)) return res.status(400).send("Invalid direction");
    if (!allowedStatus.includes(status)) return res.status(400).send("Invalid status");

    if (door) {
      if (!/^\d+$/.test(door)) return res.status(400).send("Invalid door");
      const dn = Number(door);
      if (dn < 18 || dn > 42) return res.status(400).send("Door must be 18-42");
    }

    const updatedAt = Date.now();
    const next = { direction, status, door: door || "", note: note || "", dropType, updatedAt };

    await dbRun(
      `INSERT INTO trailers (trailer, direction, status, door, note, dropType, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(trailer) DO UPDATE SET
         direction=excluded.direction,
         status=excluded.status,
         door=excluded.door,
         note=excluded.note,
         dropType=excluded.dropType,
         updatedAt=excluded.updatedAt`,
      [trailer, direction, status, next.door, next.note, next.dropType, updatedAt]
    );

    trailers[trailer] = next;

    await auditLog({
      actorRole: role,
      action: prev ? "trailer_update" : "trailer_create",
      entityType: "trailer",
      entityId: trailer,
      details: { prev, next },
      ip: getIp(req),
      userAgent: req.headers["user-agent"] || ""
    });

    broadcast("state", trailers);

    if (prev?.status !== "Ready" && status === "Ready") {
      broadcast("notify", { kind: "ready", trailer, door: next.door || "" });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("upsert error:", err);
    res.status(500).send("Server error");
  }
});

/* =========================
   DELETE / CLEAR (dispatcher only)
========================= */
app.post("/api/delete", requireRole("dispatcher"), async (req, res) => {
  try {
    const trailer = cleanStr(req.body?.trailer, 20);
    if (!trailer) return res.status(400).send("Trailer required");

    const prev = trailers[trailer] || null;

    await dbRun(`DELETE FROM trailers WHERE trailer = ?`, [trailer]);
    delete trailers[trailer];

    await auditLog({
      actorRole: "dispatcher",
      action: "trailer_delete",
      entityType: "trailer",
      entityId: trailer,
      details: { prev },
      ip: getIp(req),
      userAgent: req.headers["user-agent"] || ""
    });

    broadcast("state", trailers);
    res.json({ ok: true });
  } catch (err) {
    console.error("delete error:", err);
    res.status(500).send("Server error");
  }
});

app.post("/api/clear", requireRole("dispatcher"), async (req, res) => {
  try {
    await dbRun(`DELETE FROM trailers`);
    trailers = {};

    await auditLog({
      actorRole: "dispatcher",
      action: "trailer_clear_all",
      entityType: "trailer",
      entityId: "*",
      details: {},
      ip: getIp(req),
      userAgent: req.headers["user-agent"] || ""
    });

    broadcast("state", trailers);
    res.json({ ok: true });
  } catch (err) {
    console.error("clear error:", err);
    res.status(500).send("Server error");
  }
});

/* =========================
   WEBSOCKET
========================= */
wss.on("connection", (ws) => {
  ws.send(JSON.stringify({ type: "state", payload: trailers }));
  ws.send(JSON.stringify({ type: "dockplates", payload: dockPlates }));
  ws.send(JSON.stringify({ type: "confirmations", payload: confirmations }));
  ws.send(JSON.stringify({ type: "version", payload: { version: APP_VERSION } }));
});

/* =========================
   START + GRACEFUL SHUTDOWN
========================= */
const PORT = process.env.PORT || 3000;

function shutdown(signal) {
  console.log(`\n${signal} received. Shutting down...`);
  try { wss.clients.forEach((c) => { try { c.close(); } catch {} }); } catch {}
  server.close(() => {
    db.close(() => {
      console.log("Closed HTTP + SQLite. Bye.");
      process.exit(0);
    });
  });
  setTimeout(() => process.exit(1), 4000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

initDb()
  .then(() => {
    server.listen(PORT, () => {
      console.log("Running on port", PORT);
      console.log("SQLite DB:", DB_PATH);
      console.log("Version:", APP_VERSION);
    });
  })
  .catch((err) => {
    console.error("DB init failed:", err);
    process.exit(1);
  });
