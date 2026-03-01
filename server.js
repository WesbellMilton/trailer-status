// server.js
// Wesbell Dispatch / Dock / Driver / Supervisor (single index.html, role auth, sqlite storage, WS realtime)

const express = require("express");
const http = require("http");
const path = require("path");
const WebSocket = require("ws");
const sqlite3 = require("sqlite3").verbose();
const crypto = require("crypto");

// ---------------- CONFIG ----------------
const APP_VERSION = process.env.APP_VERSION || "3.0.0";
const PORT = process.env.PORT || 3000;
const DB_FILE = process.env.DB_FILE || path.join(__dirname, "wesbell.db");
const COOKIE_NAME = process.env.COOKIE_NAME || "wb_session";
const IS_PROD = process.env.NODE_ENV === "production";

// ---------------- HELPERS ----------------
const now = () => Date.now();
const randHex = (n = 24) => crypto.randomBytes(n).toString("hex");
const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");

function getIP(req) {
  const xf = req.headers["x-forwarded-for"];
  const raw = (Array.isArray(xf) ? xf[0] : xf) || req.socket.remoteAddress || "";
  return String(raw).split(",")[0].trim();
}

function safeStr(v, max = 200) {
  v = (v ?? "").toString().trim();
  if (v.length > max) v = v.slice(0, max);
  return v;
}

function normalizeDoor(door) {
  const d = safeStr(door, 8);
  if (!d) return "";
  // allow numeric doors only
  const n = parseInt(d, 10);
  if (!Number.isFinite(n)) return "";
  return String(n);
}

function normalizeTrailer(trailer) {
  // allow alnum and dash (some fleets use letters)
  let t = safeStr(trailer, 24).toUpperCase();
  t = t.replace(/[^A-Z0-9-]/g, "");
  return t;
}

function isSameOrigin(req) {
  // Simple CSRF mitigation: for state-changing requests, require same-origin OR no origin (curl/postman).
  const origin = req.headers.origin;
  if (!origin) return true;
  const host = req.headers.host;
  if (!host) return false;
  try {
    const o = new URL(origin);
    return o.host === host;
  } catch {
    return false;
  }
}

function pbkdf2Hash(pin, saltHex) {
  const salt = Buffer.from(saltHex, "hex");
  const out = crypto.pbkdf2Sync(String(pin), salt, 120000, 32, "sha256");
  return out.toString("hex");
}

function newPinRecord(pin) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = pbkdf2Hash(pin, salt);
  return { salt, hash };
}

// ---------------- DB ----------------
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
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}
function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}

async function initDb() {
  await run(`
    CREATE TABLE IF NOT EXISTS trailers(
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
    CREATE TABLE IF NOT EXISTS dockplates(
      door TEXT PRIMARY KEY,
      status TEXT,
      note TEXT,
      updatedAt INTEGER
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS confirmations(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER,
      trailer TEXT,
      door TEXT,
      ip TEXT,
      userAgent TEXT
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS audit(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER,
      actorRole TEXT,
      action TEXT,
      entityType TEXT,
      entityId TEXT,
      details TEXT,
      ip TEXT
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS pins(
      role TEXT PRIMARY KEY,
      salt TEXT,
      hash TEXT,
      updatedAt INTEGER
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS sessions(
      token TEXT PRIMARY KEY,
      role TEXT,
      createdAt INTEGER,
      lastSeen INTEGER
    )
  `);

  // Ensure default plate rows (18–42) exist (optional)
  for (let d = 18; d <= 42; d++) {
    const door = String(d);
    await run(
      `INSERT OR IGNORE INTO dockplates(door,status,note,updatedAt) VALUES(?,?,?,?)`,
      [door, "Unknown", "", now()]
    );
  }

  // Set default PINs if missing (change ASAP)
  const defaults = {
    dispatcher: process.env.DEFAULT_DISPATCHER_PIN || "1111",
    dock: process.env.DEFAULT_DOCK_PIN || "2222",
    supervisor: process.env.DEFAULT_SUPERVISOR_PIN || "3333",
  };
  for (const role of Object.keys(defaults)) {
    const exists = await get(`SELECT role FROM pins WHERE role=?`, [role]);
    if (!exists) {
      const rec = newPinRecord(defaults[role]);
      await run(`INSERT INTO pins(role,salt,hash,updatedAt) VALUES(?,?,?,?)`, [
        role,
        rec.salt,
        rec.hash,
        now(),
      ]);
      await auditLog("system", "pin_seeded", "pin", role, { role }, "127.0.0.1");
    }
  }
}

async function auditLog(actorRole, action, entityType, entityId, detailsObj, ip) {
  let details = "";
  try {
    details = JSON.stringify(detailsObj || {});
  } catch {
    details = "{}";
  }
  await run(
    `INSERT INTO audit(at,actorRole,action,entityType,entityId,details,ip) VALUES(?,?,?,?,?,?,?)`,
    [now(), actorRole || "—", action || "—", entityType || "—", entityId || "—", details, ip || ""]
  );
}

async function getStateObject() {
  const rows = await all(`SELECT * FROM trailers ORDER BY updatedAt DESC`);
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

async function getDockPlatesObject() {
  const rows = await all(`SELECT * FROM dockplates ORDER BY CAST(door AS INT) ASC`);
  const obj = {};
  for (const r of rows) {
    obj[r.door] = { status: r.status || "Unknown", note: r.note || "", updatedAt: r.updatedAt || 0 };
  }
  return obj;
}

async function getConfirmations(limit = 200) {
  const rows = await all(
    `SELECT at,trailer,door,ip,userAgent FROM confirmations ORDER BY at DESC LIMIT ?`,
    [limit]
  );
  return rows.map((r) => ({
    at: r.at,
    trailer: r.trailer || "",
    door: r.door || "",
    ip: r.ip || "",
    userAgent: r.userAgent || "",
  }));
}

// ---------------- AUTH ----------------
async function readSession(req) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return null;
  const row = await get(`SELECT token,role FROM sessions WHERE token=?`, [token]);
  if (!row) return null;
  await run(`UPDATE sessions SET lastSeen=? WHERE token=?`, [now(), token]).catch(() => {});
  return { token: row.token, role: row.role };
}

function requireRole(...roles) {
  return async (req, res, next) => {
    try {
      if (!isSameOrigin(req)) return res.status(403).send("Bad origin");
      const sess = await readSession(req);
      if (!sess || !roles.includes(sess.role)) return res.status(401).send("Unauthorized");
      req.user = sess;
      next();
    } catch (e) {
      res.status(500).send("Auth error");
    }
  };
}

// ---------------- APP ----------------
const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "200kb" }));
app.use(express.urlencoded({ extended: true }));
app.use(require("cookie-parser")());

// ---- Serve the same index.html for all app routes ----
const INDEX_FILE = path.join(__dirname, "index.html");
app.get(["/", "/dock", "/driver", "/supervisor"], (req, res) => res.sendFile(INDEX_FILE));

// ---- Simple login page (you can replace with your own login.html later) ----
app.get("/login", (req, res) => {
  const expired = req.query.expired ? `<div style="margin:10px 0;color:#ef4444;">Session expired. Log in again.</div>` : "";
  res.type("html").send(`
<!doctype html><html><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Login</title>
<style>
  body{background:#080d18;color:#e8f0ff;font-family:system-ui;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:16px;}
  .card{width:420px;max-width:100%;background:#0f1a2e;border:1px solid #263756;border-radius:12px;padding:18px;box-shadow:0 18px 60px rgba(0,0,0,.55);}
  h1{margin:0 0 8px;font-size:18px;}
  p{margin:0 0 14px;color:#93a4c7;font-size:13px;}
  label{display:block;margin:10px 0 6px;font-size:11px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#5a7099;}
  select,input{width:100%;padding:10px 12px;border-radius:10px;border:1px solid #263756;background:#0d1525;color:#e8f0ff;font-size:14px;outline:none;}
  button{margin-top:14px;width:100%;padding:12px;border-radius:10px;border:1px solid #2563eb;background:#1d4ed8;color:#fff;font-weight:900;cursor:pointer;}
  .hint{margin-top:10px;color:#5a7099;font-size:12px;}
</style></head><body>
<div class="card">
  <h1>Wesbell Dispatch Login</h1>
  <p>Enter your role PIN to enable editing tools.</p>
  ${expired}
  <form method="POST" action="/login">
    <label>Role</label>
    <select name="role">
      <option value="dispatcher">Dispatcher</option>
      <option value="dock">Dock</option>
      <option value="supervisor">Supervisor</option>
    </select>
    <label>PIN</label>
    <input name="pin" type="password" inputmode="numeric" autocomplete="current-password" placeholder="••••" required />
    <button type="submit">Log In</button>
  </form>
  <div class="hint">Tip: Supervisor can change PINs inside /supervisor.</div>
</div>
</body></html>`);
});

app.post("/login", async (req, res) => {
  try {
    if (!isSameOrigin(req)) return res.status(403).send("Bad origin");
    const role = safeStr(req.body.role, 20).toLowerCase();
    const pin = safeStr(req.body.pin, 64);
    if (!["dispatcher", "dock", "supervisor"].includes(role)) return res.status(400).send("Bad role");
    if (!pin) return res.status(400).send("Missing PIN");

    const row = await get(`SELECT salt,hash FROM pins WHERE role=?`, [role]);
    if (!row) return res.status(401).send("Unauthorized");

    const calc = pbkdf2Hash(pin, row.salt);
    if (calc !== row.hash) {
      await auditLog(role, "login_failed", "session", "*", { role }, getIP(req));
      return res.status(401).type("html").send(`<p style="font-family:system-ui">Bad PIN. <a href="/login">Try again</a></p>`);
    }

    const token = randHex(24);
    await run(`INSERT INTO sessions(token,role,createdAt,lastSeen) VALUES(?,?,?,?)`, [
      token,
      role,
      now(),
      now(),
    ]);

    // cookie
    res.cookie(COOKIE_NAME, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: IS_PROD, // set true behind https
      maxAge: 1000 * 60 * 60 * 12, // 12h
      path: "/",
    });

    await auditLog(role, "login_ok", "session", "*", { role }, getIP(req));

    // redirect
    if (role === "dock") return res.redirect("/dock");
    if (role === "supervisor") return res.redirect("/supervisor");
    return res.redirect("/");
  } catch (e) {
    res.status(500).send("Login error");
  }
});

// ---------------- API ----------------
app.get("/api/whoami", async (req, res) => {
  try {
    const sess = await readSession(req);
    res.json({ role: sess?.role || null, version: APP_VERSION });
  } catch {
    res.json({ role: null, version: APP_VERSION });
  }
});

app.post("/api/logout", async (req, res) => {
  try {
    if (!isSameOrigin(req)) return res.status(403).send("Bad origin");
    const token = req.cookies?.[COOKIE_NAME];
    if (token) await run(`DELETE FROM sessions WHERE token=?`, [token]).catch(() => {});
    res.clearCookie(COOKIE_NAME, { path: "/" });
    res.json({ ok: true });
  } catch {
    res.json({ ok: true });
  }
});

app.get("/api/state", async (req, res) => {
  try {
    const state = await getStateObject();
    res.json(state);
  } catch (e) {
    res.status(500).send("DB error");
  }
});

app.post("/api/upsert", requireRole("dispatcher", "dock"), async (req, res) => {
  try {
    const ip = getIP(req);
    const actorRole = req.user.role;

    const trailer = normalizeTrailer(req.body.trailer);
    if (!trailer) return res.status(400).send("Missing trailer");

    // fetch existing for notify logic
    const prev = await get(`SELECT status,door FROM trailers WHERE trailer=?`, [trailer]);

    // dock can only set status shortcuts (but allow dispatcher-style fields too if you want)
    let direction = safeStr(req.body.direction, 20);
    let status = safeStr(req.body.status, 20);
    let door = normalizeDoor(req.body.door);
    let note = safeStr(req.body.note, 300);
    let dropType = safeStr(req.body.dropType, 20);

    if (actorRole === "dock") {
      // in your UI, dock sends only {trailer,status}
      // so keep existing values if not provided
      const cur = await get(`SELECT direction,door,note,dropType FROM trailers WHERE trailer=?`, [trailer]);
      direction = direction || cur?.direction || "";
      door = door || cur?.door || "";
      note = note || cur?.note || "";
      dropType = dropType || cur?.dropType || "";
    }

    const updatedAt = now();

    await run(
      `INSERT INTO trailers(trailer,direction,status,door,note,dropType,updatedAt)
       VALUES(?,?,?,?,?,?,?)
       ON CONFLICT(trailer) DO UPDATE SET
         direction=COALESCE(excluded.direction, trailers.direction),
         status=COALESCE(excluded.status, trailers.status),
         door=COALESCE(excluded.door, trailers.door),
         note=COALESCE(excluded.note, trailers.note),
         dropType=COALESCE(excluded.dropType, trailers.dropType),
         updatedAt=excluded.updatedAt
      `,
      [trailer, direction || "", status || "", door || "", note || "", dropType || "", updatedAt]
    );

    const action = prev ? "trailer_update" : "trailer_create";
    await auditLog(actorRole, action, "trailer", trailer, { direction, status, door, note, dropType }, ip);

    // broadcast new state
    broadcastAll("state", await getStateObject());
    broadcastAll("version", { version: APP_VERSION });

    // notify if became READY (your UI listens for notify.kind==="ready")
    const newStatus = status || prev?.status || "";
    const becameReady = prev?.status !== "Ready" && newStatus === "Ready";
    if (becameReady) {
      broadcastAll("notify", { kind: "ready", trailer, door: door || prev?.door || "" });
    }

    res.json({ ok: true });
  } catch (e) {
    res.status(500).send("Upsert error");
  }
});

app.post("/api/delete", requireRole("dispatcher"), async (req, res) => {
  try {
    const ip = getIP(req);
    const trailer = normalizeTrailer(req.body.trailer);
    if (!trailer) return res.status(400).send("Missing trailer");
    await run(`DELETE FROM trailers WHERE trailer=?`, [trailer]);
    await auditLog("dispatcher", "trailer_delete", "trailer", trailer, {}, ip);
    broadcastAll("state", await getStateObject());
    res.json({ ok: true });
  } catch (e) {
    res.status(500).send("Delete error");
  }
});

app.post("/api/clear", requireRole("dispatcher"), async (req, res) => {
  try {
    const ip = getIP(req);
    await run(`DELETE FROM trailers`);
    await auditLog("dispatcher", "trailer_clear_all", "trailer", "*", {}, ip);
    broadcastAll("state", await getStateObject());
    res.json({ ok: true });
  } catch (e) {
    res.status(500).send("Clear error");
  }
});

app.get("/api/dockplates", async (req, res) => {
  try {
    res.json(await getDockPlatesObject());
  } catch {
    res.status(500).send("DB error");
  }
});

app.post("/api/dockplates/set", requireRole("dispatcher", "dock"), async (req, res) => {
  try {
    const ip = getIP(req);
    const door = normalizeDoor(req.body.door);
    const status = safeStr(req.body.status, 20) || "Unknown";
    const note = safeStr(req.body.note, 120);
    if (!door) return res.status(400).send("Missing door");

    await run(
      `INSERT INTO dockplates(door,status,note,updatedAt) VALUES(?,?,?,?)
       ON CONFLICT(door) DO UPDATE SET status=excluded.status, note=excluded.note, updatedAt=excluded.updatedAt`,
      [door, status, note, now()]
    );
    await auditLog(req.user.role, "plate_set", "dockplate", door, { status, note }, ip);

    broadcastAll("dockplates", await getDockPlatesObject());
    res.json({ ok: true });
  } catch (e) {
    res.status(500).send("Plate set error");
  }
});

// Driver drop (public; no login)
app.post("/api/driver/drop", async (req, res) => {
  try {
    if (!isSameOrigin(req)) return res.status(403).send("Bad origin");
    const ip = getIP(req);

    const trailer = normalizeTrailer(req.body.trailer);
    const door = normalizeDoor(req.body.door);
    const dropType = safeStr(req.body.dropType, 20);

    if (!trailer) return res.status(400).send("Missing trailer");
    if (!door) return res.status(400).send("Missing door");

    // keep existing direction if present
    const cur = await get(`SELECT direction,note FROM trailers WHERE trailer=?`, [trailer]);
    const direction = cur?.direction || "Inbound";

    await run(
      `INSERT INTO trailers(trailer,direction,status,door,note,dropType,updatedAt)
       VALUES(?,?,?,?,?,?,?)
       ON CONFLICT(trailer) DO UPDATE SET
         direction=excluded.direction,
         status=excluded.status,
         door=excluded.door,
         dropType=excluded.dropType,
         updatedAt=excluded.updatedAt`,
      [trailer, direction, "Dropped", door, cur?.note || "", dropType || "", now()]
    );

    await auditLog("driver", "driver_drop", "trailer", trailer, { door, dropType }, ip);

    broadcastAll("state", await getStateObject());
    res.json({ ok: true });
  } catch (e) {
    res.status(500).send("Driver drop error");
  }
});

// Safety confirmations (public; no login)
app.post("/api/confirm-safety", async (req, res) => {
  try {
    if (!isSameOrigin(req)) return res.status(403).send("Bad origin");
    const ip = getIP(req);
    const ua = safeStr(req.headers["user-agent"], 180);

    const trailer = normalizeTrailer(req.body.trailer);
    const door = normalizeDoor(req.body.door);

    const loadSecured = !!req.body.loadSecured;
    const dockPlateUp = !!req.body.dockPlateUp;
    if (!loadSecured || !dockPlateUp) return res.status(400).send("Missing confirmations");

    await run(
      `INSERT INTO confirmations(at,trailer,door,ip,userAgent) VALUES(?,?,?,?,?)`,
      [now(), trailer || "", door || "", ip, ua]
    );
    await auditLog("driver", "safety_confirmed", "safety", trailer || "*", { trailer, door }, ip);

    broadcastAll("confirmations", await getConfirmations(200));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).send("Confirm error");
  }
});

app.get("/api/audit", requireRole("dispatcher", "supervisor"), async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(500, parseInt(req.query.limit || "200", 10) || 200));
    const rows = await all(
      `SELECT at,actorRole,action,entityType,entityId,details,ip FROM audit ORDER BY at DESC LIMIT ?`,
      [limit]
    );
    res.json(
      rows.map((r) => ({
        at: r.at,
        actorRole: r.actorRole,
        action: r.action,
        entityType: r.entityType,
        entityId: r.entityId,
        details: (() => {
          try {
            return JSON.parse(r.details || "{}");
          } catch {
            return {};
          }
        })(),
        ip: r.ip || "",
      }))
    );
  } catch (e) {
    res.status(500).send("Audit error");
  }
});

app.post("/api/supervisor/set-pin", requireRole("supervisor"), async (req, res) => {
  try {
    const ip = getIP(req);
    const role = safeStr(req.body.role, 20).toLowerCase();
    const pin = safeStr(req.body.pin, 64);

    if (!["dispatcher", "dock", "supervisor"].includes(role)) return res.status(400).send("Bad role");
    if (!pin || pin.length < 4) return res.status(400).send("PIN too short");

    const rec = newPinRecord(pin);
    await run(
      `INSERT INTO pins(role,salt,hash,updatedAt) VALUES(?,?,?,?)
       ON CONFLICT(role) DO UPDATE SET salt=excluded.salt, hash=excluded.hash, updatedAt=excluded.updatedAt`,
      [role, rec.salt, rec.hash, now()]
    );

    // kill sessions for that role (force re-login)
    await run(`DELETE FROM sessions WHERE role=?`, [role]).catch(() => {});

    await auditLog("supervisor", "pin_changed", "pin", role, { role }, ip);
    broadcastAll("version", { version: APP_VERSION });

    res.json({ ok: true });
  } catch (e) {
    res.status(500).send("PIN error");
  }
});

// ---------------- WEBSOCKET ----------------
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

function wsSend(ws, type, payload) {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type, payload }));
}

function broadcastAll(type, payload) {
  const msg = JSON.stringify({ type, payload });
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  }
}

wss.on("connection", async (ws) => {
  // On connect, send full current state
  try {
    wsSend(ws, "version", { version: APP_VERSION });
    wsSend(ws, "state", await getStateObject());
    wsSend(ws, "dockplates", await getDockPlatesObject());
    wsSend(ws, "confirmations", await getConfirmations(200));
  } catch {}
});

// ---------------- START ----------------
initDb()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`Wesbell Dispatch running on port ${PORT} (v${APP_VERSION})`);
      console.log(`DB: ${DB_FILE}`);
    });
  })
  .catch((e) => {
    console.error("DB init failed:", e);
    process.exit(1);
  });
