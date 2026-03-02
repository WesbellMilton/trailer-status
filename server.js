// server.js — Wesbell Dispatch
// FIXES:
//   1. /api/driver/drop: carrierType was never declared → ReferenceError crash
//   2. /api/shunt: removed "driver" from requireRole (drivers have no session); route now public like /api/driver/drop
//   3. /api/clear: added "dispatcher" to allowed roles (UI shows button to dispatchers)
//   4. loadTrailersObject: carrierType now included in returned object

const express = require("express");
const http = require("http");
const path = require("path");
const WebSocket = require("ws");
const sqlite3 = require("sqlite3").verbose();
const crypto = require("crypto");

const app = express();
app.use(express.json({ limit: "200kb" }));
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const DB_FILE = process.env.DB_FILE || path.join(__dirname, "wesbell.sqlite");
const APP_VERSION = process.env.APP_VERSION || "3.2.0";
const PIN_MIN_LEN = 4;
const SESSION_TTL_MS = 1000 * 60 * 60 * 12;
const COOKIE_NAME = "wb_session";

const ENV_PINS = {
  dispatcher: process.env.DISPATCHER_PIN || "",
  dock:       process.env.DOCK_PIN       || "",
  supervisor: process.env.SUPERVISOR_PIN || "",
  admin:      process.env.ADMIN_PIN      || "",
};

function requireXHR(req, res, next) {
  const h = (req.get("X-Requested-With") || "").toLowerCase();
  if (h !== "xmlhttprequest") return res.status(400).send("Bad request");
  next();
}

/* ── DB ── */
const db = new sqlite3.Database(DB_FILE);
const run = (sql, p=[]) => new Promise((res,rej) => db.run(sql,p,function(e){e?rej(e):res(this);}));
const get = (sql, p=[]) => new Promise((res,rej) => db.get(sql,p,(e,r)=>{e?rej(e):res(r);}));
const all = (sql, p=[]) => new Promise((res,rej) => db.all(sql,p,(e,r)=>{e?rej(e):res(r);}));

/* ── VAPID / PUSH ── */
const VAPID_FILE = process.env.VAPID_FILE || path.join(__dirname, "vapid.json");
let VAPID_KEYS = null;
const pushSubs = new Map();

let _trailersCache = null;
let _platesCache   = null;
async function getTrailersCache() { if(!_trailersCache) _trailersCache=await loadTrailersObject(); return _trailersCache; }
async function getPlatesCache()   { if(!_platesCache)   _platesCache=await loadDockPlatesObject(); return _platesCache; }
function invalidateTrailers() { _trailersCache = null; }
function invalidatePlates()   { _platesCache   = null; }

function loadOrGenVapid() {
  const fs = require("fs");
  try {
    if (fs.existsSync(VAPID_FILE)) {
      VAPID_KEYS = JSON.parse(fs.readFileSync(VAPID_FILE,"utf8"));
      console.log("[VAPID] Loaded existing keys"); return;
    }
  } catch {}
  try {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ec",{
      namedCurve:"P-256",
      publicKeyEncoding:{type:"spki",format:"der"},
      privateKeyEncoding:{type:"pkcs8",format:"der"},
    });
    const pubRaw = publicKey.slice(26);
    let privRaw;
    for(let i=0;i<privateKey.length-34;i++){
      if(privateKey[i]===0x04&&privateKey[i+1]===0x20){ privRaw=privateKey.slice(i+2,i+34); break; }
    }
    if(!privRaw) throw new Error("Could not extract private key bytes");
    VAPID_KEYS = { publicKey:pubRaw.toString("base64url"), privateKey:privRaw.toString("base64url") };
    fs.writeFileSync(VAPID_FILE, JSON.stringify(VAPID_KEYS));
    console.log("[VAPID] Generated new key pair");
  } catch(e) { console.error("[VAPID] Key generation failed:",e.message); }
}

const b64url    = buf => Buffer.isBuffer(buf)?buf.toString("base64url"):Buffer.from(buf).toString("base64url");
const fromb64url = s  => Buffer.from(s,"base64url");

async function hkdf(salt,ikm,info,len){
  const prk = crypto.createHmac("sha256",salt).update(ikm).digest();
  const t   = crypto.createHmac("sha256",prk).update(Buffer.concat([info,Buffer.alloc(1,1)])).digest();
  return t.slice(0,len);
}

async function buildVapidJWT(audience){
  const header = b64url(JSON.stringify({typ:"JWT",alg:"ES256"}));
  const now    = Math.floor(Date.now()/1000);
  const payload= b64url(JSON.stringify({aud:audience,exp:now+12*3600,sub:"mailto:dispatch@wesbell.com"}));
  const sigInput=`${header}.${payload}`;
  const privBytes=fromb64url(VAPID_KEYS.privateKey);
  const privKey=crypto.createPrivateKey({
    key:Buffer.concat([
      Buffer.from("308187020100301306072a8648ce3d020106082a8648ce3d030107046d306b0201010420","hex"),
      privBytes,
      Buffer.from("a144034200","hex"),
      fromb64url(VAPID_KEYS.publicKey),
    ]),
    format:"der", type:"pkcs8",
  });
  const sig=crypto.sign(null,Buffer.from(sigInput),{key:privKey,dsaEncoding:"ieee-p1363"});
  return `${sigInput}.${b64url(sig)}`;
}

async function encryptPushPayload(plaintext,keys){
  const serverKeys=crypto.generateKeyPairSync("ec",{namedCurve:"P-256"});
  const serverPubRaw=serverKeys.publicKey.export({type:"spki",format:"der"}).slice(26);
  const clientPubRaw=fromb64url(keys.p256dh);
  const authSecret=fromb64url(keys.auth);
  const clientPub=crypto.createPublicKey({
    key:Buffer.concat([Buffer.from("3059301306072a8648ce3d020106082a8648ce3d030107034200","hex"),clientPubRaw]),
    format:"der",type:"spki",
  });
  const sharedSecret=crypto.diffieHellman({privateKey:serverKeys.privateKey,publicKey:clientPub});
  const prk=await hkdf(authSecret,sharedSecret,Buffer.concat([Buffer.from("WebPush: info\x00"),clientPubRaw,
