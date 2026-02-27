const express = require("express");
const http = require("http");
const path = require("path");
const WebSocket = require("ws");
const sqlite3 = require("sqlite3").verbose();
const pkg = require("./package.json");

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

/* ================================
   CONFIG
================================ */

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "data.db");

const PINS = {
  dispatcher: "1234",
  dock: "789"
};

const db = new sqlite3.Database(DB_PATH);

let trailers = {};
let confirmations = [];
let dockPlates = {};

/* ================================
   HELPERS
================================ */

function cleanStr(v, maxLen){
  const s = String(v ?? "").trim();
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

function normalizeDoor(input){
  const m = String(input ?? "").match(/(\d+)/);
  return m ? m[1] : "";
}

function broadcast(type, payload){
  const msg = JSON.stringify({ type, payload });
  wss.clients.forEach(c=>{
    if(c.readyState === WebSocket.OPEN){
      c.send(msg);
    }
  });
}

function getRole(req){
  const pin = String(req.headers["x-role-pin"] || "").trim();
  if(pin === PINS.dispatcher) return "dispatcher";
  if(pin === PINS.dock) return "dock";
  return null;
}

function requireRole(roles){
  return (req,res,next)=>{
    const role = getRole(req);
    if(!role || !roles.includes(role)){
      return res.status(403).send("Unauthorized");
    }
    req.role = role;
    next();
  };
}

function dbRun(sql, params=[]){
  return new Promise((resolve,reject)=>{
    db.run(sql, params, function(err){
      if(err) reject(err);
      else resolve(this);
    });
  });
}

function dbAll(sql, params=[]){
  return new Promise((resolve,reject)=>{
    db.all(sql, params, (err,rows)=>{
      if(err) reject(err);
      else resolve(rows);
    });
  });
}

/* ================================
   INIT DB
================================ */

async function initDb(){
  await dbRun(`PRAGMA journal_mode=WAL;`);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS trailers (
      trailer TEXT PRIMARY KEY,
      direction TEXT NOT NULL,
      status TEXT NOT NULL,
      door TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      updatedAt INTEGER NOT NULL
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS dockplates (
      door TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      updatedAt INTEGER NOT NULL
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS confirmations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL,
      trailer TEXT,
      door TEXT,
      ip TEXT,
      userAgent TEXT
    )
  `);

  await loadCache();
}

async function loadCache(){
  const rows = await dbAll(`SELECT * FROM trailers`);
  trailers = {};
  rows.forEach(r=>{
    trailers[r.trailer] = {
      direction:r.direction,
      status:r.status,
      door:r.door,
      note:r.note,
      updatedAt:r.updatedAt
    };
  });

  const plates = await dbAll(`SELECT * FROM dockplates`);
  dockPlates = {};
  plates.forEach(p=>{
    dockPlates[p.door] = {
      status:p.status,
      note:p.note,
      updatedAt:p.updatedAt
    };
  });

  const conf = await dbAll(`
    SELECT at,trailer,door,ip,userAgent
    FROM confirmations
    ORDER BY id DESC
    LIMIT 200
  `);
  confirmations = conf;
}

/* ================================
   ROUTES
================================ */

app.get("/", (_,res)=>res.sendFile(path.join(__dirname,"index.html")));
app.get("/dock", (_,res)=>res.sendFile(path.join(__dirname,"index.html")));
app.get("/driver", (_,res)=>res.sendFile(path.join(__dirname,"index.html")));

app.get("/health", (_,res)=>res.json({ok:true,db:DB_PATH}));
app.get("/api/version", (_,res)=>res.json({version:pkg.version}));

app.get("/api/state", (_,res)=>res.json(trailers));
app.get("/api/dockplates", (_,res)=>res.json(dockPlates));
app.get("/api/confirmations", (_,res)=>res.json(confirmations));

/* ================================
   UPSERT TRAILER
================================ */

app.post("/api/upsert", requireRole(["dispatcher","dock"]), async (req,res)=>{
  try{
    const role = req.role;
    const trailer = cleanStr(req.body.trailer,20);
    const status = cleanStr(req.body.status,30);
    const direction = cleanStr(req.body.direction,30);
    const door = normalizeDoor(req.body.door);
    const note = cleanStr(req.body.note,200);

    if(!trailer) return res.status(400).send("Trailer required");

    const allowedStatus = ["Incoming","Loading","Dock Ready","Ready","Departed"];
    if(!allowedStatus.includes(status))
      return res.status(400).send("Invalid status");

    const prev = trailers[trailer];

    if(role === "dock"){
      if(!prev)
        return res.status(403).send("Dock cannot create trailers");

      if(!["Loading","Dock Ready"].includes(status))
        return res.status(403).send("Dock can only set Loading or Dock Ready");

      await dbRun(
        `UPDATE trailers SET status=?, updatedAt=? WHERE trailer=?`,
        [status, Date.now(), trailer]
      );

      trailers[trailer] = {...prev,status,updatedAt:Date.now()};
    }

    if(role === "dispatcher"){
      if(status === "Ready" && prev && prev.status !== "Dock Ready")
        return res.status(400).send("Approval rule: Dock Ready required");

      await dbRun(`
        INSERT INTO trailers (trailer,direction,status,door,note,updatedAt)
        VALUES (?,?,?,?,?,?)
        ON CONFLICT(trailer) DO UPDATE SET
          direction=excluded.direction,
          status=excluded.status,
          door=excluded.door,
          note=excluded.note,
          updatedAt=excluded.updatedAt
      `,
      [trailer,direction,status,door||"",note,Date.now()]);

      trailers[trailer] = {
        direction,status,door:door||"",note,updatedAt:Date.now()
      };
    }

    broadcast("state",trailers);
    res.json({ok:true});

  }catch(e){
    console.error(e);
    res.status(500).send("Server error");
  }
});

/* ================================
   DOCK PLATES
================================ */

app.post("/api/dockplates/set", requireRole(["dispatcher","dock"]), async (req,res)=>{
  const door = normalizeDoor(req.body.door);
  const status = cleanStr(req.body.status,20);
  const note = cleanStr(req.body.note,200);

  if(!door || Number(door)<18 || Number(door)>42)
    return res.status(400).send("Door must be 18-42");

  if(!["OK","Service"].includes(status))
    return res.status(400).send("Invalid status");

  await dbRun(`
    INSERT INTO dockplates (door,status,note,updatedAt)
    VALUES (?,?,?,?)
    ON CONFLICT(door) DO UPDATE SET
      status=excluded.status,
      note=excluded.note,
      updatedAt=excluded.updatedAt
  `,[door,status,note,Date.now()]);

  dockPlates[door] = {status,note,updatedAt:Date.now()};
  broadcast("dockplates",dockPlates);
  res.json({ok:true});
});

/* ================================
   SAFETY CONFIRM
================================ */

app.post("/api/confirm-safety", async (req,res)=>{
  const trailer = cleanStr(req.body.trailer,20);
  const door = cleanStr(req.body.door,20);
  const loadSecured = !!req.body.loadSecured;
  const dockPlateUp = !!req.body.dockPlateUp;

  if(!loadSecured || !dockPlateUp)
    return res.status(400).send("Both confirmations required");

  await dbRun(`
    INSERT INTO confirmations (at,trailer,door,ip,userAgent)
    VALUES (?,?,?,?,?)
  `,
  [Date.now(),trailer,door,
   req.socket.remoteAddress,
   req.headers["user-agent"]]);

  res.json({ok:true});
});

/* ================================
   GEOTAB EMBED
================================ */

app.get("/geotab",(req,res)=>{
  res.send(`
    <!doctype html>
    <html>
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>Geotab</title>
      <style>
        body{margin:0;background:#0b1430;}
        iframe{width:100vw;height:100vh;border:0;}
      </style>
    </head>
    <body>
      <iframe src="https://my.geotab.com/login.html"></iframe>
    </body>
    </html>
  `);
});

/* ================================
   WEBSOCKET
================================ */

wss.on("connection",(ws)=>{
  ws.send(JSON.stringify({type:"state",payload:trailers}));
  ws.send(JSON.stringify({type:"dockplates",payload:dockPlates}));
});

/* ================================
   START
================================ */

const PORT = process.env.PORT || 3000;

initDb().then(()=>{
  server.listen(PORT,()=>{
    console.log("Running on port",PORT);
    console.log("Dispatcher PIN: 1234");
    console.log("Dock PIN: 789");
  });
});
