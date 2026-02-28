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

/* ── CONFIG ── */
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8"));
const APP_VERSION = process.env.APP_VERSION || pkg.version;
const LINK_SIGNING_SECRET = String(process.env.LINK_SIGNING_SECRET || "");

if (!LINK_SIGNING_SECRET || LINK_SIGNING_SECRET === "change_me") {
  if (process.env.NODE_ENV === "production") { console.error("FATAL: LINK_SIGNING_SECRET must be set."); process.exit(1); }
  else console.warn("WARNING: LINK_SIGNING_SECRET unset. Set before production.");
}

function hashPin(pin) {
  return crypto.createHmac("sha256", LINK_SIGNING_SECRET || "dev-only-secret").update(String(pin)).digest("hex");
}

// PIN hashes — stored in memory, can be updated at runtime by supervisor
let PIN_HASHES = {
  dispatcher: process.env.DISPATCHER_PIN_HASH || (process.env.DISPATCHER_PIN ? hashPin(process.env.DISPATCHER_PIN) : hashPin("1234")),
  dock:       process.env.DOCK_PIN_HASH       || (process.env.DOCK_PIN       ? hashPin(process.env.DOCK_PIN)       : hashPin("789")),
  supervisor: process.env.SUPERVISOR_PIN_HASH || (process.env.SUPERVISOR_PIN ? hashPin(process.env.SUPERVISOR_PIN) : hashPin("sup123")),
};

function verifyPin(input, hash) {
  const h = hashPin(String(input));
  try { return crypto.timingSafeEqual(Buffer.from(h,"hex"), Buffer.from(hash,"hex")); } catch { return false; }
}

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "data.db");
try { const d=path.dirname(DB_PATH); if(d&&d!=="."&&d!==__dirname) fs.mkdirSync(d,{recursive:true}); } catch(e) { console.error("DB dir error:",e); }

const db = new sqlite3.Database(DB_PATH);
let trailers={}, confirmations=[], dockPlates={};

/* ── RATE LIMITER ── */
const rlStore = new Map();
function rateLimit(windowMs, max) {
  return (req, res, next) => {
    const key=getIp(req), now=Date.now();
    let e=rlStore.get(key);
    if(!e||now>e.resetAt){ e={count:0,resetAt:now+windowMs}; rlStore.set(key,e); }
    if(++e.count>max){ res.setHeader("Retry-After",Math.ceil((e.resetAt-now)/1000)); return res.status(429).send("Too many requests."); }
    next();
  };
}
setInterval(()=>{ const now=Date.now(); for(const[k,e] of rlStore) if(now>e.resetAt) rlStore.delete(k); },5*60*1000).unref();

/* ── HELPERS ── */
function broadcast(type,payload){ const m=JSON.stringify({type,payload}); for(const c of wss.clients) if(c.readyState===WebSocket.OPEN) c.send(m); }
function cleanStr(v,max){ const s=String(v??"").trim(); return s.length>max?s.slice(0,max):s; }
function normalizeDoor(v){ const r=String(v??"").trim(); if(!r) return ""; const m=r.match(/(\d{1,3})/); return m?m[1]:r; }
function getIp(req){ return req.headers["x-forwarded-for"]?.split(",")[0]?.trim()||req.socket.remoteAddress||""; }
function parseCookies(h){ const o={}; String(h||"").split(";").forEach(p=>{ const[k,...r]=p.trim().split("="); if(k) o[k]=decodeURIComponent(r.join("=")||""); }); return o; }
function sign(v){ return crypto.createHmac("sha256",LINK_SIGNING_SECRET||"dev-only-secret").update(v).digest("hex"); }

const IS_PROD = process.env.NODE_ENV==="production";

function setAuthCookie(res,role){
  const ts=Date.now(), base=`${role}|${ts}`, sig=sign(base), val=encodeURIComponent(`${base}|${sig}`);
  res.setHeader("Set-Cookie",[`auth=${val}; Path=/; HttpOnly; SameSite=Lax${IS_PROD?"; Secure":""}`]);
}
function clearAuthCookie(res){ res.setHeader("Set-Cookie",["auth=; Path=/; Max-Age=0; SameSite=Lax"]); }

function getRoleFromReq(req){
  if(String(req.path||"").toLowerCase().startsWith("/driver")) return "driver";
  const cookies=parseCookies(req.headers.cookie), auth=cookies.auth; if(!auth) return null;
  const decoded=decodeURIComponent(auth), parts=decoded.split("|"); if(parts.length!==3) return null;
  const[role,ts,sig]=parts;
  if(!["dispatcher","dock","supervisor"].includes(role)) return null;
  if(sign(`${role}|${ts}`)!==sig) return null;
  const age=Date.now()-Number(ts||0);
  if(!Number.isFinite(age)||age>12*60*60*1000) return null;
  return role;
}

function requireRole(r){ return (req,res,next)=>{ if(getRoleFromReq(req)===r) return next(); res.status(401).send("Unauthorized"); }; }
function requireAnyRole(roles){ return (req,res,next)=>{ const r=getRoleFromReq(req); if(r&&roles.includes(r)) return next(); res.status(401).send("Unauthorized"); }; }
function requireCsrf(req,res,next){ if(req.headers["x-requested-with"]!=="XMLHttpRequest") return res.status(403).send("CSRF check failed"); next(); }

function dbRun(sql,p=[]){ return new Promise((res,rej)=>db.run(sql,p,function(e){ if(e)rej(e); else res(this); })); }
function dbAll(sql,p=[]){ return new Promise((res,rej)=>db.all(sql,p,(e,r)=>{ if(e)rej(e); else res(r); })); }

async function auditLog({actorRole,action,entityType,entityId,details,ip,userAgent}){
  await dbRun(`INSERT INTO audit_log(at,actorRole,action,entityType,entityId,details,ip,userAgent) VALUES(?,?,?,?,?,?,?,?)`,
    [Date.now(),actorRole||"",action||"",entityType||"",entityId||"",JSON.stringify(details||{}),ip||"",userAgent||""]);
}

/* ── DB INIT ── */
async function initDb(){
  await dbRun(`PRAGMA journal_mode=WAL;`);
  await dbRun(`PRAGMA synchronous=NORMAL;`);
  await dbRun(`CREATE TABLE IF NOT EXISTS trailers(trailer TEXT PRIMARY KEY,direction TEXT NOT NULL,status TEXT NOT NULL,door TEXT NOT NULL DEFAULT '',note TEXT NOT NULL DEFAULT '',dropType TEXT NOT NULL DEFAULT '',updatedAt INTEGER NOT NULL)`);
  await dbRun(`ALTER TABLE trailers ADD COLUMN dropType TEXT NOT NULL DEFAULT ''`).catch(()=>{});
  await dbRun(`CREATE TABLE IF NOT EXISTS confirmations(id INTEGER PRIMARY KEY AUTOINCREMENT,at INTEGER NOT NULL,trailer TEXT NOT NULL DEFAULT '',door TEXT NOT NULL DEFAULT '',ip TEXT NOT NULL DEFAULT '',userAgent TEXT NOT NULL DEFAULT '')`);
  await dbRun(`CREATE TABLE IF NOT EXISTS dock_plates(door TEXT PRIMARY KEY,status TEXT NOT NULL DEFAULT 'Unknown',note TEXT NOT NULL DEFAULT '',updatedAt INTEGER NOT NULL)`);
  await dbRun(`CREATE TABLE IF NOT EXISTS audit_log(id INTEGER PRIMARY KEY AUTOINCREMENT,at INTEGER NOT NULL,actorRole TEXT NOT NULL,action TEXT NOT NULL,entityType TEXT NOT NULL,entityId TEXT NOT NULL,details TEXT NOT NULL,ip TEXT NOT NULL,userAgent TEXT NOT NULL)`);
  for(let d=18;d<=42;d++) await dbRun(`INSERT INTO dock_plates(door,status,note,updatedAt) VALUES(?,'Unknown','',?) ON CONFLICT(door) DO NOTHING`,[String(d),Date.now()]);
  await reloadCaches();
}

async function reloadCaches(){
  const tr=await dbAll(`SELECT trailer,direction,status,door,note,dropType,updatedAt FROM trailers`);
  trailers={}; for(const r of tr) trailers[r.trailer]={direction:r.direction,status:r.status,door:r.door||"",note:r.note||"",dropType:r.dropType||"",updatedAt:r.updatedAt||0};
  const cr=await dbAll(`SELECT at,trailer,door,ip,userAgent FROM confirmations ORDER BY id DESC LIMIT 200`);
  confirmations=cr.map(r=>({at:r.at,trailer:r.trailer||"",door:r.door||"",ip:r.ip||"",userAgent:r.userAgent||""}));
  const pr=await dbAll(`SELECT door,status,note,updatedAt FROM dock_plates`);
  dockPlates={}; for(const r of pr) dockPlates[String(r.door)]={status:r.status||"Unknown",note:r.note||"",updatedAt:r.updatedAt||0};
}

/* ── LOGIN PAGE ── */
app.get("/login",(req,res)=>{
  const exp=req.query.expired==="1";
  res.send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Login – Wesbell</title>
  <style>body{font-family:system-ui;background:#0b1220;color:#eaf0ff;margin:0;display:flex;justify-content:center;align-items:center;height:100vh}
  .card{width:340px;background:rgba(255,255,255,.04);border:1px solid rgba(120,145,220,.18);border-radius:14px;padding:18px}
  h2{margin:0 0 6px}input{width:100%;padding:12px;border-radius:12px;border:1px solid rgba(120,145,220,.18);background:#0c132a;color:#fff;box-sizing:border-box;}
  button{width:100%;padding:12px;border-radius:12px;border:none;background:rgba(99,102,241,.55);color:#fff;font-weight:900;margin-top:10px;cursor:pointer;font-size:15px;}
  .sub,.hint{color:#a7b2d3;font-size:12px;margin-bottom:10px}a{color:#b7c5ff}
  .banner{background:rgba(239,68,68,.18);border:1px solid rgba(239,68,68,.35);border-radius:10px;padding:8px 10px;font-size:13px;margin-bottom:10px;}</style>
  </head><body><div class="card"><h2>Wesbell Login</h2>
  ${exp?`<div class="banner">Session expired. Please log in again.</div>`:""}
  <div class="sub">Dispatcher, Dock &amp; Supervisor require a PIN. Driver is public.</div>
  <form method="POST" action="/login"><input name="pin" type="password" placeholder="Enter PIN" autocomplete="current-password" required /><button type="submit">Login</button></form>
  <div class="hint">Driver link: <a href="/driver">/driver</a></div></div></body></html>`);
});

app.post("/login", rateLimit(15*60*1000,20), (req,res)=>{
  const pin=String(req.body?.pin||"").trim();
  if(verifyPin(pin,PIN_HASHES.dispatcher)){ setAuthCookie(res,"dispatcher"); return res.redirect("/"); }
  if(verifyPin(pin,PIN_HASHES.dock)){       setAuthCookie(res,"dock");       return res.redirect("/dock"); }
  if(verifyPin(pin,PIN_HASHES.supervisor)){ setAuthCookie(res,"supervisor"); return res.redirect("/supervisor"); }
  res.status(401).send("Invalid PIN");
});

app.post("/api/logout", requireCsrf, (req,res)=>{ clearAuthCookie(res); res.json({ok:true}); });
app.get("/api/whoami", (req,res)=>res.json({role:getRoleFromReq(req)||null,version:APP_VERSION}));
app.get("/api/version", (req,res)=>res.json({version:APP_VERSION}));

app.get("/",(req,res)=>{ if(getRoleFromReq(req)!=="dispatcher") return res.redirect("/login"); res.sendFile(path.join(__dirname,"index.html")); });
app.get("/dock",(req,res)=>{ if(getRoleFromReq(req)!=="dock") return res.redirect("/login"); res.sendFile(path.join(__dirname,"index.html")); });
app.get("/driver",(req,res)=>res.sendFile(path.join(__dirname,"index.html")));
app.get("/supervisor",(req,res)=>{ if(getRoleFromReq(req)!=="supervisor") return res.redirect("/login"); res.sendFile(path.join(__dirname,"index.html")); });
app.get("/health",(req,res)=>res.json({ok:true,db:DB_PATH,version:APP_VERSION}));

/* ── STATE ── */
app.get("/api/state",(req,res)=>res.json(trailers));

/* ── AUDIT ── */
app.get("/api/audit", requireAnyRole(["dispatcher","supervisor"]), async(req,res)=>{
  try{
    const limit=Math.min(parseInt(req.query.limit||"200",10),500);
    const rows=await dbAll(`SELECT id,at,actorRole,action,entityType,entityId,details,ip,userAgent FROM audit_log ORDER BY id DESC LIMIT ?`,[limit]);
    res.json(rows.map(r=>({...r,details:(()=>{try{return JSON.parse(r.details);}catch{return {};}})()})));
  }catch(e){console.error("audit:",e);res.status(500).send("Server error");}
});

/* ── DOCK PLATES ── */
app.get("/api/dockplates",(req,res)=>res.json(dockPlates));

app.post("/api/dockplates/set", requireCsrf, requireAnyRole(["dispatcher","dock"]), async(req,res)=>{
  try{
    const role=getRoleFromReq(req), door=normalizeDoor(req.body?.door), status=cleanStr(req.body?.status,20), note=cleanStr(req.body?.note,120);
    if(!door) return res.status(400).send("Door required");
    if(!/^\d+$/.test(door)) return res.status(400).send("Invalid door");
    const dn=Number(door); if(dn<18||dn>42) return res.status(400).send("Door 18-42");
    if(!["OK","Service","Unknown"].includes(status)) return res.status(400).send("Invalid status");
    const updatedAt=Date.now();
    await dbRun(`INSERT INTO dock_plates(door,status,note,updatedAt) VALUES(?,?,?,?) ON CONFLICT(door) DO UPDATE SET status=excluded.status,note=excluded.note,updatedAt=excluded.updatedAt`,[door,status,note,updatedAt]);
    dockPlates[door]={status,note,updatedAt};
    await auditLog({actorRole:role,action:"plate_set",entityType:"dock_plate",entityId:door,details:{status,note},ip:getIp(req),userAgent:req.headers["user-agent"]||""});
    broadcast("dockplates",dockPlates); res.json({ok:true});
  }catch(e){console.error("dockplates/set:",e);res.status(500).send("Server error");}
});

/* ── SUPERVISOR: SET PIN ── */
app.post("/api/supervisor/set-pin", requireCsrf, requireRole("supervisor"), async(req,res)=>{
  try{
    const role=cleanStr(req.body?.role,20), pin=cleanStr(req.body?.pin,100);
    if(!["dispatcher","dock","supervisor"].includes(role)) return res.status(400).send("Invalid role");
    if(pin.length<4) return res.status(400).send("PIN too short");
    PIN_HASHES[role]=hashPin(pin);
    await auditLog({actorRole:"supervisor",action:"pin_changed",entityType:"auth",entityId:role,details:{},ip:getIp(req),userAgent:req.headers["user-agent"]||""});
    res.json({ok:true});
  }catch(e){console.error("set-pin:",e);res.status(500).send("Server error");}
});

/* ── DRIVER DROP ── */
app.post("/api/driver/drop", requireCsrf, rateLimit(10*60*1000,30), async(req,res)=>{
  try{
    const trailer=cleanStr(req.body?.trailer,20), door=normalizeDoor(req.body?.door), dropType=cleanStr(req.body?.dropType,12);
    if(!trailer) return res.status(400).send("Trailer required");
    if(!door)    return res.status(400).send("Door required");
    if(!/^\d+$/.test(door)) return res.status(400).send("Invalid door");
    const dn=Number(door); if(dn<18||dn>42) return res.status(400).send("Door 18-42");
    if(!["Empty","Loaded"].includes(dropType)) return res.status(400).send("Invalid drop type");
    const prev=trailers[trailer]||null, updatedAt=Date.now();
    const next={direction:prev?.direction||"Inbound",status:"Dropped",door,note:prev?.note||"",dropType,updatedAt};
    await dbRun(`INSERT INTO trailers(trailer,direction,status,door,note,dropType,updatedAt) VALUES(?,?,?,?,?,?,?) ON CONFLICT(trailer) DO UPDATE SET direction=excluded.direction,status=excluded.status,door=excluded.door,note=excluded.note,dropType=excluded.dropType,updatedAt=excluded.updatedAt`,
      [trailer,next.direction,next.status,next.door,next.note,next.dropType,updatedAt]);
    trailers[trailer]=next;
    await auditLog({actorRole:"driver",action:"driver_drop",entityType:"trailer",entityId:trailer,details:{door,dropType},ip:getIp(req),userAgent:req.headers["user-agent"]||""});
    broadcast("state",trailers); res.json({ok:true});
  }catch(e){console.error("driver/drop:",e);res.status(500).send("Server error");}
});

/* ── CONFIRM SAFETY ── */
app.post("/api/confirm-safety", requireCsrf, rateLimit(10*60*1000,60), async(req,res)=>{
  try{
    const trailer=cleanStr(req.body?.trailer,20), door=normalizeDoor(req.body?.door);
    const loadSecured=!!req.body?.loadSecured, dockPlateUp=!!req.body?.dockPlateUp;
    if(!loadSecured||!dockPlateUp) return res.status(400).send("Both confirmations required");
    const ip=getIp(req), at=Date.now(), ua=req.headers["user-agent"]||"";
    await dbRun(`INSERT INTO confirmations(at,trailer,door,ip,userAgent) VALUES(?,?,?,?,?)`,[at,trailer||"",door||"",ip,ua]);
    const cr=await dbAll(`SELECT at,trailer,door,ip,userAgent FROM confirmations ORDER BY id DESC LIMIT 200`);
    confirmations=cr.map(r=>({at:r.at,trailer:r.trailer||"",door:r.door||"",ip:r.ip||"",userAgent:r.userAgent||""}));
    await auditLog({actorRole:"driver",action:"safety_confirmed",entityType:"trailer",entityId:trailer||"",details:{trailer,door,loadSecured:true,dockPlateUp:true},ip,userAgent:ua});
    broadcast("confirmations",confirmations); res.json({ok:true});
  }catch(e){console.error("confirm-safety:",e);res.status(500).send("Server error");}
});

/* ── UPSERT TRAILER ── */
app.post("/api/upsert", requireCsrf, async(req,res)=>{
  try{
    const role=getRoleFromReq(req); if(!role) return res.status(401).send("Unauthorized");
    const trailer=cleanStr(req.body?.trailer,20); if(!trailer) return res.status(400).send("Trailer required");
    const prev=trailers[trailer]||null;
    if(!prev&&role==="dock") return res.status(403).send("Dock cannot add trailers");

    if(role==="dock"){
      const status=cleanStr(req.body?.status,30);
      if(!["Loading","Dock Ready"].includes(status)) return res.status(403).send("Dock can only set Loading or Dock Ready");
      const updatedAt=Date.now(), next={direction:prev.direction,status,door:prev.door,note:prev.note||"",dropType:prev.dropType||"",updatedAt};
      await dbRun(`INSERT INTO trailers(trailer,direction,status,door,note,dropType,updatedAt) VALUES(?,?,?,?,?,?,?) ON CONFLICT(trailer) DO UPDATE SET direction=excluded.direction,status=excluded.status,door=excluded.door,note=excluded.note,dropType=excluded.dropType,updatedAt=excluded.updatedAt`,
        [trailer,next.direction,next.status,next.door||"",next.note||"",next.dropType||"",updatedAt]);
      trailers[trailer]=next;
      await auditLog({actorRole:role,action:"trailer_status_set",entityType:"trailer",entityId:trailer,details:{from:prev.status,to:status},ip:getIp(req),userAgent:req.headers["user-agent"]||""});
      broadcast("state",trailers); return res.json({ok:true});
    }

    if(role!=="dispatcher") return res.status(403).send("Forbidden");
    const direction=cleanStr(req.body?.direction,30)||prev?.direction||"Inbound";
    const status=cleanStr(req.body?.status,30)||prev?.status||"Incoming";
    const door=normalizeDoor(req.body?.door??prev?.door??"");
    const note=cleanStr(req.body?.note,160), dropType=cleanStr(req.body?.dropType,12)||prev?.dropType||"";
    if(!["Inbound","Outbound","Cross Dock"].includes(direction)) return res.status(400).send("Invalid direction");
    if(!["Incoming","Loading","Dock Ready","Ready","Departed","Dropped"].includes(status)) return res.status(400).send("Invalid status");
    if(!["","Empty","Loaded"].includes(dropType)) return res.status(400).send("Invalid drop type");
    if(door){ if(!/^\d+$/.test(door)) return res.status(400).send("Invalid door"); const dn=Number(door); if(dn<18||dn>42) return res.status(400).send("Door 18-42"); }
    const updatedAt=Date.now(), next={direction,status,door:door||"",note:note||"",dropType,updatedAt};
    await dbRun(`INSERT INTO trailers(trailer,direction,status,door,note,dropType,updatedAt) VALUES(?,?,?,?,?,?,?) ON CONFLICT(trailer) DO UPDATE SET direction=excluded.direction,status=excluded.status,door=excluded.door,note=excluded.note,dropType=excluded.dropType,updatedAt=excluded.updatedAt`,
      [trailer,direction,status,next.door,next.note,next.dropType,updatedAt]);
    trailers[trailer]=next;
    await auditLog({actorRole:role,action:prev?"trailer_update":"trailer_create",entityType:"trailer",entityId:trailer,details:{prev,next},ip:getIp(req),userAgent:req.headers["user-agent"]||""});
    broadcast("state",trailers);
    if(prev?.status!=="Ready"&&status==="Ready") broadcast("notify",{kind:"ready",trailer,door:next.door||""});
    res.json({ok:true});
  }catch(e){console.error("upsert:",e);res.status(500).send("Server error");}
});

/* ── DELETE / CLEAR ── */
app.post("/api/delete", requireCsrf, requireRole("dispatcher"), async(req,res)=>{
  try{
    const trailer=cleanStr(req.body?.trailer,20); if(!trailer) return res.status(400).send("Trailer required");
    const prev=trailers[trailer]||null;
    await dbRun(`DELETE FROM trailers WHERE trailer=?`,[trailer]); delete trailers[trailer];
    await auditLog({actorRole:"dispatcher",action:"trailer_delete",entityType:"trailer",entityId:trailer,details:{prev},ip:getIp(req),userAgent:req.headers["user-agent"]||""});
    broadcast("state",trailers); res.json({ok:true});
  }catch(e){console.error("delete:",e);res.status(500).send("Server error");}
});

app.post("/api/clear", requireCsrf, requireRole("dispatcher"), async(req,res)=>{
  try{
    await dbRun(`DELETE FROM trailers`); trailers={};
    await auditLog({actorRole:"dispatcher",action:"trailer_clear_all",entityType:"trailer",entityId:"*",details:{},ip:getIp(req),userAgent:req.headers["user-agent"]||""});
    broadcast("state",trailers); res.json({ok:true});
  }catch(e){console.error("clear:",e);res.status(500).send("Server error");}
});

/* ── WEBSOCKET ── */
wss.on("connection",ws=>{
  ws.send(JSON.stringify({type:"state",payload:trailers}));
  ws.send(JSON.stringify({type:"dockplates",payload:dockPlates}));
  ws.send(JSON.stringify({type:"confirmations",payload:confirmations}));
  ws.send(JSON.stringify({type:"version",payload:{version:APP_VERSION}}));
});

/* ── START ── */
const PORT = process.env.PORT||3000;

function shutdown(sig){
  console.log(`\n${sig} received. Shutting down…`);
  try{ wss.clients.forEach(c=>{ try{c.close();}catch{} }); }catch{}
  server.close(()=>{ db.run("PRAGMA wal_checkpoint(FULL)",()=>{ db.close(()=>{ console.log("Closed. Bye."); process.exit(0); }); }); });
  setTimeout(()=>process.exit(1),6000).unref();
}
process.on("SIGINT",()=>shutdown("SIGINT"));
process.on("SIGTERM",()=>shutdown("SIGTERM"));

initDb().then(()=>{ server.listen(PORT,()=>{ console.log("Port:",PORT,"| DB:",DB_PATH,"| v",APP_VERSION); }); }).catch(e=>{ console.error("DB init failed:",e); process.exit(1); });
