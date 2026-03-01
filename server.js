// server.js
// Wesbell Dispatch - single-page multi-role board + WS live updates + PIN auth + SQLite persistence

const express = require("express");
const http = require("http");
const path = require("path");
const WebSocket = require("ws");
const sqlite3 = require("sqlite3").verbose();
const crypto = require("crypto");

const app = express();
app.use(express.json({ limit: "200kb" }));
app.use(express.urlencoded({ extended: true }));

/* =========================
   CONFIG
========================= */
const PORT = process.env.PORT || 3000;
const DB_FILE = process.env.DB_FILE || path.join(__dirname, "wesbell.sqlite");
const APP_VERSION = process.env.APP_VERSION || "3.2.0";

const PIN_MIN_LEN = 4;

// Basic session config (in-memory sessions)
const SESSION_TTL_MS = 1000 * 60 * 60 * 12; // 12 hours
const COOKIE_NAME = "wb_session";

// Optional first-run default PINs (override via env)
const ENV_PINS = {
  dispatcher: process.env.DISPATCHER_PIN || "",
  dock: process.env.DOCK_PIN || "",
  supervisor: process.env.SUPERVISOR_PIN || "",
};

// Simple anti-CSRF header check for state-changing requests
function requireXHR(req, res, next) {
  const h = (req.get("X-Requested-With") || "").toLowerCase();
  if (h !== "xmlhttprequest") return res.status(400).send("Bad request");
  next();
}

/* =========================
   DB
========================= */
const db = new sqlite3.Database(DB_FILE);

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}
function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}
function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

async function initDb() {
  await run(`
    CREATE TABLE IF NOT EXISTS trailers (
      trailer TEXT PRIMARY KEY,
      direction TEXT,
      status TEXT,
      door TEXT,
      note TEXT,
      dropType TEXT,
      updatedAt INTEGER
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS dockplates (
      door TEXT PRIMARY KEY,
      status TEXT,
      note TEXT,
      updatedAt INTEGER
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS confirmations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER,
      trailer TEXT,
      door TEXT,
      ip TEXT,
      userAgent TEXT
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER,
      actorRole TEXT,
      action TEXT,
      entityType TEXT,
      entityId TEXT,
      details TEXT,
      ip TEXT,
      userAgent TEXT
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS pins (
      role TEXT PRIMARY KEY,
      salt BLOB,
      hash BLOB,
      iter INTEGER
    )
  `);

  // Seed dock doors 18–42 if missing
  for (let d = 18; d <= 42; d++) {
    const door = String(d);
    const exists = await get(`SELECT door FROM dockplates WHERE door=?`, [door]);
    if (!exists) {
      await run(
        `INSERT INTO dockplates (door,status,note,updatedAt) VALUES (?,?,?,?)`,
        [door, "Unknown", "", Date.now()]
      );
    }
  }

  // Seed PINs if none exist
  for (const role of ["dispatcher", "dock", "supervisor"]) {
    const row = await get(`SELECT role FROM pins WHERE role=?`, [role]);
    if (!row) {
      const pin =
        ENV_PINS[role] && ENV_PINS[role].length >= PIN_MIN_LEN
          ? ENV_PINS[role]
          : genTempPin();
      await setPin(role, pin);
      console.log(`[SECURITY] Initial ${role} PIN set to: ${pin}`);
      console.log(`[SECURITY] Change it in Supervisor → PIN Management ASAP.`);
    }
  }
}

function genTempPin() {
  // Cryptographically secure 6-digit PIN
  return String(crypto.randomInt(100000, 1000000));
}

function pbkdf2Hash(pin, salt, iter = 140000) {
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(pin, salt, iter, 32, "sha256", (err, derived) => {
      if (err) reject(err);
      else resolve(derived);
    });
  });
}

async function setPin(role, pin) {
  const salt = crypto.randomBytes(16);
  const iter = 140000;
  const hash = await pbkdf2Hash(pin, salt, iter);
  await run(
    `INSERT INTO pins(role,salt,hash,iter) VALUES(?,?,?,?)
     ON CONFLICT(role) DO UPDATE SET salt=excluded.salt, hash=excluded.hash, iter=excluded.iter`,
    [role, salt, hash, iter]
  );
}

async function verifyPin(role, pin) {
  const row = await get(`SELECT salt, hash, iter FROM pins WHERE role=?`, [role]);
  if (!row) return false;
  const salt = row.salt;
  const iter = row.iter || 140000;
  const hash = row.hash;
  const candidate = await pbkdf2Hash(pin, salt, iter);
  if (candidate.length !== hash.length) return false;
  return crypto.timingSafeEqual(candidate, hash);
}

/* =========================
   SESSIONS (memory)
========================= */
const sessions = new Map(); // sid -> {role, exp}

function newSession(role) {
  const sid = crypto.randomBytes(24).toString("hex");
  sessions.set(sid, { role, exp: Date.now() + SESSION_TTL_MS });
  return sid;
}

function parseCookies(req) {
  const h = req.headers.cookie || "";
  const out = {};
  h.split(";").forEach((p) => {
    const i = p.indexOf("=");
    if (i > -1) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

function getSession(req) {
  const cookies = parseCookies(req);
  const sid = cookies[COOKIE_NAME];
  if (!sid) return null;
  const s = sessions.get(sid);
  if (!s) return null;
  if (Date.now() > s.exp) {
    sessions.delete(sid);
    return null;
  }
  return { sid, ...s };
}

function setSessionCookie(res, sid) {
  const secure = process.env.NODE_ENV === "production";
  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=${encodeURIComponent(sid)}; Path=/; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`
  );
}

function clearSessionCookie(res) {
  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
  );
}

function requireRole(roles) {
  return (req, res, next) => {
    const s = getSession(req);
    if (!s || !roles.includes(s.role)) return res.status(401).send("Unauthorized");
    req.user = { role: s.role };
    next();
  };
}

/* =========================
   AUDIT / STATE HELPERS
========================= */
function ipOf(req) {
  const xf = req.headers["x-forwarded-for"];
  if (xf) return String(xf).split(",")[0].trim();
  return req.socket.remoteAddress || "";
}

async function audit(req, actorRole, action, entityType, entityId, details) {
  const at = Date.now();
  const ip = ipOf(req);
  const ua = req.headers["user-agent"] || "";
  let d = "";
  try { d = JSON.stringify(details || {}); } catch { d = ""; }
  await run(
    `INSERT INTO audit(at,actorRole,action,entityType,entityId,details,ip,userAgent)
     VALUES(?,?,?,?,?,?,?,?)`,
    [at, actorRole || "unknown", action, entityType, entityId, d, ip, ua]
  );
}

async function loadTrailersObject() {
  const rows = await all(`SELECT * FROM trailers`);
  const obj = {};
  for (const r of rows) {
    obj[r.trailer] = {
      direction: r.direction || "",
      status: r.status || "",
      door: r.door || "",
      note: r.note || "",
      dropType: r.dropType || "",
      updatedAt: r.updatedAt || 0,
    };
  }
  return obj;
}

async function loadDockPlatesObject() {
  const rows = await all(`SELECT * FROM dockplates ORDER BY CAST(door AS INTEGER) ASC`);
  const obj = {};
  for (const r of rows) {
    obj[r.door] = {
      status: r.status || "Unknown",
      note: r.note || "",
      updatedAt: r.updatedAt || 0,
    };
  }
  return obj;
}

async function loadConfirmations(limit = 250) {
  return all(
    `SELECT at,trailer,door,ip,userAgent FROM confirmations ORDER BY at DESC LIMIT ?`,
    [limit]
  );
}

/* =========================
   WEBSOCKET
========================= */
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

function wsBroadcast(type, payload) {
  const msg = JSON.stringify({ type, payload });
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  }
}

async function broadcastAll() {
  wsBroadcast("state", await loadTrailersObject());
  wsBroadcast("dockplates", await loadDockPlatesObject());
  wsBroadcast("confirmations", await loadConfirmations(250));
  wsBroadcast("version", { version: APP_VERSION });
}

/* =========================
   STATIC FILES + VIEWS
========================= */
app.use(express.static(path.join(__dirname, "public")));
const INDEX_FILE = path.join(__dirname, "public", "index.html");

function sendIndex(req, res) {
  res.sendFile(INDEX_FILE);
}

// Minimal /login page (PIN entry)
app.get("/login", (req, res) => {
  const expired = req.query.expired
    ? `<div style="margin:10px 0;color:#e84848;">Session expired. Please sign in again.</div>`
    : "";
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(`<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Wesbell Login</title>
<style>
  body{margin:0;background:#0a0d12;color:#e2e8f2;font-family:system-ui;padding:22px}
  .card{max-width:380px;margin:40px auto;background:#121820;border:1px solid #1a2232;border-radius:12px;padding:18px}
  label{display:block;font-size:12px;margin:10px 0 6px;color:#8a9bb5}
  input,select{width:100%;padding:12px;border-radius:10px;border:1px solid #213040;background:#0e1218;color:#e2e8f2;font-size:16px}
  button{width:100%;padding:12px;border-radius:10px;border:1px solid rgba(240,160,48,.2);background:rgba(240,160,48,.09);color:#f0a030;font-weight:700;margin-top:14px;cursor:pointer}
  .muted{color:#4a5a72;font-size:12px;margin-top:10px;line-height:1.5}
</style>
</head>
<body>
  <div class="card">
    <h2 style="margin:0 0 8px;font-size:18px;">Wesbell Dispatch</h2>
    <div class="muted">Sign in with your role PIN to unlock controls.</div>
    ${expired}
    <label>Role</label>
    <select id="role">
      <option value="dispatcher">Dispatcher</option>
      <option value="dock">Dock</option>
      <option value="supervisor">Supervisor</option>
    </select>
    <label>PIN</label>
    <input id="pin" type="password" inputmode="numeric" placeholder="Enter PIN" />
    <button id="go">Sign In</button>
    <div class="muted">Tip: Supervisor can reset PINs in Supervisor → PIN Management.</div>
  </div>
<script>
document.getElementById("go").onclick = async () => {
  const role = document.getElementById("role").value;
  const pin = document.getElementById("pin").value;
  const res = await fetch("/api/login", {
    method:"POST",
    headers:{ "Content-Type":"application/json","X-Requested-With":"XMLHttpRequest" },
    body: JSON.stringify({ role, pin })
  });
  if(!res.ok){ alert(await res.text()); return; }
  location.href = role==="supervisor" ? "/supervisor" : (role==="dock" ? "/dock" : "/");
};
document.getElementById("pin").addEventListener("keydown", (e)=>{ if(e.key==="Enter") document.getElementById("go").click(); });
</script>
</body></html>`);
});

// Serve the single-page app for these routes
app.get("/", sendIndex);
app.get("/dock", sendIndex);
app.get("/driver", sendIndex);
app.get("/supervisor", sendIndex);

/* =========================
   API
========================= */

// whoami
app.get("/api/whoami", (req, res) => {
  const s = getSession(req);
  res.json({ role: s?.role || null, version: APP_VERSION });
});

// login
app.post("/api/login", requireXHR, async (req, res) => {
  try {
    const role = String(req.body.role || "").toLowerCase();
    const pin = String(req.body.pin || "");
    if (!["dispatcher", "dock", "supervisor"].includes(role)) return res.status(400).send("Invalid role");
    if (pin.length < PIN_MIN_LEN) return res.status(400).send("PIN too short");

    const ok = await verifyPin(role, pin);
    await audit(req, role, ok ? "login_success" : "login_failed", "auth", role, {});
    if (!ok) return res.status(401).send("Invalid PIN");

    // Invalidate any existing session for this browser before issuing a new one
    const existing = getSession(req);
    if (existing?.sid) sessions.delete(existing.sid);

    const sid = newSession(role);
    setSessionCookie(res, sid);
    res.json({ ok: true, role, version: APP_VERSION });
  } catch (e) {
    res.status(500).send("Login error");
  }
});

// logout
app.post("/api/logout", requireXHR, (req, res) => {
  const s = getSession(req);
  if (s?.sid) sessions.delete(s.sid);
  clearSessionCookie(res);
  res.json({ ok: true });
});

// get trailers state
app.get("/api/state", async (req, res) => {
  res.json(await loadTrailersObject());
});

// upsert trailer (dispatcher/dock/supervisor)
app.post("/api/upsert", requireXHR, requireRole(["dispatcher", "dock", "supervisor"]), async (req, res) => {
  const actor = req.user.role;
  try {
    const trailer = String(req.body.trailer || "").trim();
    if (!trailer) return res.status(400).send("Missing trailer");

    const existing = await get(`SELECT * FROM trailers WHERE trailer=?`, [trailer]);
    const now = Date.now();

    const direction = (req.body.direction !== undefined) ? String(req.body.direction || "").trim() : (existing?.direction || "");
    const status    = (req.body.status !== undefined)    ? String(req.body.status || "").trim()    : (existing?.status || "");
    const door      = (req.body.door !== undefined)      ? String(req.body.door || "").trim()      : (existing?.door || "");
    const note      = (req.body.note !== undefined)      ? String(req.body.note || "").trim()      : (existing?.note || "");
    const dropType  = (req.body.dropType !== undefined)  ? String(req.body.dropType || "").trim()  : (existing?.dropType || "");

    // Role restrictions:
    // - dock can ONLY change status to Loading / Dock Ready (no other field writes)
    if (actor === "dock") {
      const onlyStatus =
        req.body.status !== undefined &&
        req.body.direction === undefined &&
        req.body.door === undefined &&
        req.body.note === undefined &&
        req.body.dropType === undefined;

      if (!onlyStatus) return res.status(403).send("Dock can only update trailer status");
      if (!["Loading", "Dock Ready"].includes(status)) return res.status(403).send("Dock can only set Loading or Dock Ready");
    }

    const allowed = ["Incoming", "Dropped", "Loading", "Dock Ready", "Ready", "Departed", ""];
    if (!allowed.includes(status)) return res.status(400).send("Invalid status");

    await run(
      `INSERT INTO trailers(trailer,direction,status,door,note,dropType,updatedAt)
       VALUES(?,?,?,?,?,?,?)
       ON CONFLICT(trailer) DO UPDATE SET
        direction=excluded.direction,
        status=excluded.status,
        door=excluded.door,
        note=excluded.note,
        dropType=excluded.dropType,
        updatedAt=excluded.updatedAt`,
      [trailer, direction, status, door, note, dropType, now]
    );

    const action = existing ? "trailer_update" : "trailer_create";
    await audit(req, actor, action, "trailer", trailer, { direction, status, door, dropType, note });

    if (req.body.status !== undefined) {
      await audit(req, actor, "trailer_status_set", "trailer", trailer, { status });
    }

    // Notify when dispatcher/supervisor sets Ready
    if (status === "Ready" && (actor === "dispatcher" || actor === "supervisor")) {
      wsBroadcast("notify", { kind: "ready", trailer, door: door || "" });
    }

    await broadcastAll();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).send("Upsert failed");
  }
});

// delete trailer (dispatcher/supervisor)
app.post("/api/delete", requireXHR, requireRole(["dispatcher", "supervisor"]), async (req, res) => {
  const actor = req.user.role;
  try {
    const trailer = String(req.body.trailer || "").trim();
    if (!trailer) return res.status(400).send("Missing trailer");
    await run(`DELETE FROM trailers WHERE trailer=?`, [trailer]);
    await audit(req, actor, "trailer_delete", "trailer", trailer, {});
    await broadcastAll();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).send("Delete failed");
  }
});

// clear all (supervisor only — too destructive for dispatcher)
app.post("/api/clear", requireXHR, requireRole(["supervisor"]), async (req, res) => {
  const actor = req.user.role;
  try {
    await run(`DELETE FROM trailers`);
    await audit(req, actor, "trailer_clear_all", "trailer", "*", {});
    await broadcastAll();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).send("Clear failed");
  }
});

// dock plates get
app.get("/api/dockplates", async (req, res) => {
  res.json(await loadDockPlatesObject());
});

// dock plates set (dock/dispatcher/supervisor)
app.post("/api/dockplates/set", requireXHR, requireRole(["dock", "dispatcher", "supervisor"]), async (req, res) => {
  const actor = req.user.role;
  try {
    const door = String(req.body.door || "").trim();
    const status = String(req.body.status || "Unknown").trim();
    const note = String(req.body.note || "").trim();

    const dNum = Number(door);
    if (!Number.isFinite(dNum) || dNum < 18 || dNum > 42) return res.status(400).send("Invalid door");
    if (!["OK", "Service", "Unknown"].includes(status)) return res.status(400).send("Invalid plate status");

    await run(
      `INSERT INTO dockplates(door,status,note,updatedAt) VALUES(?,?,?,?)
       ON CONFLICT(door) DO UPDATE SET status=excluded.status, note=excluded.note, updatedAt=excluded.updatedAt`,
      [door, status, note, Date.now()]
    );
    await audit(req, actor, "plate_set", "dockplate", door, { status, note });
    await broadcastAll();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).send("Dock plate set failed");
  }
});

// driver assignment lookup — no auth required
// Returns the dispatcher-assigned door for a given trailer
// so the driver portal can auto-populate the door field.
app.get("/api/driver/assignment", async (req, res) => {
  try {
    const trailer = String(req.query.trailer || "").trim();
    if (!trailer) return res.status(400).send("Missing trailer");

    const row = await get(
      `SELECT door, direction, status, dropType FROM trailers WHERE trailer=?`,
      [trailer]
    );

    if (!row) return res.json({ found: false });

    // Only surface an assignment if the trailer is in an active state
    // where a door has been assigned but not yet departed.
    const activeStatuses = ["Incoming", "Dropped", "Loading", "Dock Ready", "Ready"];
    if (!activeStatuses.includes(row.status)) {
      return res.json({ found: false });
    }

    res.json({
      found: true,
      door: row.door || "",
      direction: row.direction || "",
      status: row.status || "",
      dropType: row.dropType || "",
    });
  } catch (e) {
    res.status(500).send("Lookup failed");
  }
});

// driver drop (no login required)
app.post("/api/driver/drop", requireXHR, async (req, res) => {
  try {
    const trailer = String(req.body.trailer || "").trim();
    const door = String(req.body.door || "").trim();
    const dropType = String(req.body.dropType || "Empty").trim();

    if (!trailer) return res.status(400).send("Missing trailer");
    const dNum = Number(door);
    if (!Number.isFinite(dNum) || dNum < 18 || dNum > 42) return res.status(400).send("Invalid door (18–42)");
    if (!["Empty", "Loaded"].includes(dropType)) return res.status(400).send("Invalid drop type");

    const existing = await get(`SELECT * FROM trailers WHERE trailer=?`, [trailer]);
    const now = Date.now();
    const direction = existing?.direction || "Inbound";

    await run(
      `INSERT INTO trailers(trailer,direction,status,door,note,dropType,updatedAt)
       VALUES(?,?,?,?,?,?,?)
       ON CONFLICT(trailer) DO UPDATE SET
        direction=excluded.direction,
        status=excluded.status,
        door=excluded.door,
        dropType=excluded.dropType,
        updatedAt=excluded.updatedAt`,
      [trailer, direction, "Dropped", door, existing?.note || "", dropType, now]
    );

    await audit(req, "driver", "driver_drop", "trailer", trailer, { door, dropType });
    await broadcastAll();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).send("Drop failed");
  }
});

// safety confirmation (no login required)
app.post("/api/confirm-safety", requireXHR, async (req, res) => {
  try {
    const trailer = String(req.body.trailer || "").trim();
    const door = String(req.body.door || "").trim();
    const loadSecured = !!req.body.loadSecured;
    const dockPlateUp = !!req.body.dockPlateUp;
    if (!loadSecured || !dockPlateUp) return res.status(400).send("Both confirmations required");

    const at = Date.now();
    await run(
      `INSERT INTO confirmations(at,trailer,door,ip,userAgent) VALUES(?,?,?,?,?)`,
      [at, trailer || "", door || "", ipOf(req), req.headers["user-agent"] || ""]
    );
    await audit(req, "driver", "safety_confirmed", "safety", trailer || "-", { trailer, door, loadSecured, dockPlateUp });

    await broadcastAll();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).send("Confirm failed");
  }
});

// audit log (dispatcher/supervisor)
app.get("/api/audit", requireRole(["dispatcher", "supervisor"]), async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(500, Number(req.query.limit || 200)));
    const rows = await all(
      `SELECT at,actorRole,action,entityType,entityId,details,ip,userAgent
       FROM audit ORDER BY at DESC LIMIT ?`,
      [limit]
    );
    const out = rows.map((r) => {
      let details = {};
      try { details = r.details ? JSON.parse(r.details) : {}; } catch {}
      return { ...r, details };
    });
    res.json(out);
  } catch (e) {
    res.status(500).send("Audit failed");
  }
});

// supervisor set-pin
app.post("/api/supervisor/set-pin", requireXHR, requireRole(["supervisor"]), async (req, res) => {
  const actor = req.user.role;
  try {
    const role = String(req.body.role || "").toLowerCase();
    const pin = String(req.body.pin || "");
    if (!["dispatcher", "dock", "supervisor"].includes(role)) return res.status(400).send("Invalid role");
    if (pin.length < PIN_MIN_LEN) return res.status(400).send("PIN too short");

    await setPin(role, pin);

    // Invalidate only sessions for the affected role — not the supervisor's own session
    for (const [sid, s] of sessions.entries()) {
      if (s.role === role) sessions.delete(sid);
    }

    await audit(req, actor, "pin_changed", "auth", role, {});
    await broadcastAll();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).send("Set PIN failed");
  }
});

/* =========================
   WS CONNECTION
========================= */
wss.on("connection", async (ws) => {
  try {
    ws.send(JSON.stringify({ type: "version", payload: { version: APP_VERSION } }));
    ws.send(JSON.stringify({ type: "state", payload: await loadTrailersObject() }));
    ws.send(JSON.stringify({ type: "dockplates", payload: await loadDockPlatesObject() }));
    ws.send(JSON.stringify({ type: "confirmations", payload: await loadConfirmations(250) }));
  } catch {}
});

/* =========================
   START
========================= */
initDb()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`Wesbell Dispatch running on http://localhost:${PORT}`);
      console.log(`DB: ${DB_FILE}`);
    });
  })
  .catch((e) => {
    console.error("DB init failed:", e);
    process.exit(1);
  });
