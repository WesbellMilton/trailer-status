// server.js — Wesbell Dispatch v4.0.0 (Tesla UI Integrated)
// ... (Your existing imports and Gzip/Security middleware remain the same) ...

// ── Fixed Driver OMW Route ──
app.post("/api/driver/omw", requireXHR, async (req, res) => {
  try {
    const trailer = String(req.body.trailer || "").trim().toUpperCase();
    const eta = parseInt(req.body.eta) || null;
    const carrierType = String(req.body.carrierType || "Wesbell"); // Ensure carrier is logged

    if (!trailer) return res.status(400).send("Missing trailer number");
    
    // Security: Only Wesbell drivers can use OMW (Pre-assignment)
    if (carrierType !== "Wesbell") {
      return res.status(403).send("Pre-assignment is for internal drivers only.");
    }

    const assignedDoor = await pickBestDoor(trailer);
    if (!assignedDoor) return res.status(409).send("No doors available. See Dispatch.");

    await reserveDoor(assignedDoor, trailer, "Wesbell");
    const now = Date.now();
    
    await run(`INSERT INTO trailers(trailer,direction,status,door,note,carrierType,updatedAt,omwAt,omwEta) 
               VALUES(?,?,?,?,?,?,?,?,?) 
               ON CONFLICT(trailer) DO UPDATE SET 
               status=excluded.status, door=excluded.door, note=excluded.note, 
               updatedAt=excluded.updatedAt, omwAt=excluded.omwAt`,
               [trailer, "Inbound", "Incoming", assignedDoor, `ETA ~${eta} min`, "Wesbell", now, now, eta]);

    await audit(req, "driver", "omw", "trailer", trailer, { door: assignedDoor, eta });
    await broadcastTrailers();
    
    // WebSocket notification for Dispatcher
    wsBroadcast("omw", { trailer, door: assignedDoor, eta, at: now });
    res.json({ ok: true, door: assignedDoor });
  } catch (e) { res.status(500).send("OMW failed"); }
});

// ── Fixed Driver Arrive Route ──
app.post("/api/driver/arrive", requireXHR, async (req, res) => {
  try {
    const trailer = String(req.body.trailer || "").trim().toUpperCase();
    if (!trailer) return res.status(400).send("Missing trailer");

    // Check if dispatch already assigned them a door manually
    const existing = await get(`SELECT * FROM trailers WHERE trailer=?`, [trailer]);
    if (existing && existing.door && ["Incoming", "Dropped", "Loading"].includes(existing.status)) {
      return res.json({ ok: true, door: existing.door, alreadyActive: true });
    }

    const assignedDoor = await pickBestDoor(trailer);
    if (!assignedDoor) return res.status(409).send("No doors available. See Dispatch.");

    const now = Date.now();
    await run(`INSERT INTO trailers(trailer, direction, status, door, updatedAt, doorAt) 
               VALUES(?,?,?,?,?,?) 
               ON CONFLICT(trailer) DO UPDATE SET 
               status=excluded.status, door=excluded.door, updatedAt=excluded.updatedAt, doorAt=excluded.doorAt`,
               [trailer, "Inbound", "Incoming", assignedDoor, now, now]);

    await releaseReservation(trailer);
    await audit(req, "driver", "arrive", "trailer", trailer, { door: assignedDoor });
    await broadcastTrailers();
    res.json({ ok: true, door: assignedDoor });
  } catch (e) { res.status(500).send("Arrival failed"); }
});

// ── Fixed Safety Confirmation (Handles Cross Dock Completion) ──
app.post("/api/confirm-safety", requireXHR, requireDriverAccess, async (req, res) => {
  try {
    const { trailer, door, action, loadSecured, dockPlateUp } = req.body;
    
    if (!loadSecured || !dockPlateUp) return res.status(400).send("Safety checks incomplete");

    const now = Date.now();
    
    // If they were doing a Cross Dock Pickup, mark as Departed
    if (action === "xdock_pickup" || action === "depart") {
      await run(`UPDATE trailers SET status='Departed', updatedAt=? WHERE trailer=?`, [now, trailer]);
      await releaseReservation(trailer);
    }

    await run(`INSERT INTO confirmations(at, trailer, door, action, ip, userAgent) VALUES(?,?,?,?,?,?)`,
               [now, trailer || "", door || "", action || "safety", ipOf(req), req.headers["user-agent"]]);

    await audit(req, "driver", "safety_confirmed", "trailer", trailer || "-", { action });
    await broadcastTrailers();
    await broadcastConfirmations();
    res.json({ ok: true });
  } catch (e) { res.status(500).send("Safety confirmation failed"); }
});

// ── Improved DB Backup Routine ──
async function backupDb() {
  try {
    const backupFile = path.join(path.dirname(DB_FILE), "wesbell-backup.sqlite");
    // Ensure all WAL data is written to the main DB file before copying
    db.run("PRAGMA wal_checkpoint(FULL)", (err) => {
      if (!err) {
        fs.copyFileSync(DB_FILE, backupFile);
        console.log(`[BACKUP] Success: ${backupFile}`);
      }
    });
  } catch (e) { console.error("[BACKUP] Failed", e.message); }
}

// ... (Rest of your server.js remains the same) ...
