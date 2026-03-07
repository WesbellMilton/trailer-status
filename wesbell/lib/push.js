'use strict';
const crypto = require('crypto');
const fs     = require('fs');
const { VAPID_FILE } = require('./config');
const { run, all }   = require('./db');

let VAPID_KEYS = null;
const pushSubs = new Map();

// ── VAPID ─────────────────────────────────────────────────────────────────────
function loadOrGenVapid() {
  try {
    if (fs.existsSync(VAPID_FILE)) {
      VAPID_KEYS = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8'));
      console.log('[VAPID] Loaded existing keys');
      return;
    }
  } catch {}
  try {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', {
      namedCurve: 'P-256',
      publicKeyEncoding:  { type: 'spki',  format: 'der' },
      privateKeyEncoding: { type: 'pkcs8', format: 'der' },
    });
    const pubRaw = publicKey.slice(26);
    let privRaw;
    for (let i = 0; i < privateKey.length - 34; i++) {
      if (privateKey[i] === 0x04 && privateKey[i + 1] === 0x20) {
        privRaw = privateKey.slice(i + 2, i + 34); break;
      }
    }
    if (!privRaw) throw new Error('Could not extract private key bytes');
    VAPID_KEYS = { publicKey: pubRaw.toString('base64url'), privateKey: privRaw.toString('base64url') };
    fs.writeFileSync(VAPID_FILE, JSON.stringify(VAPID_KEYS));
    console.log('[VAPID] Generated new key pair');
  } catch (e) { console.error('[VAPID] Key generation failed:', e.message); }
}

async function loadSubscriptions() {
  const subs = await all(`SELECT endpoint,subscription FROM push_subscriptions`);
  for (const s of subs) { try { pushSubs.set(s.endpoint, JSON.parse(s.subscription)); } catch {} }
  console.log(`[PUSH] Loaded ${pushSubs.size} push subscriptions`);
}

// ── Crypto helpers ────────────────────────────────────────────────────────────
const b64url    = buf => Buffer.isBuffer(buf) ? buf.toString('base64url') : Buffer.from(buf).toString('base64url');
const fromb64url = s  => Buffer.from(s, 'base64url');

async function hkdf(salt, ikm, info, len) {
  const prk = crypto.createHmac('sha256', salt).update(ikm).digest();
  return crypto.createHmac('sha256', prk).update(Buffer.concat([info, Buffer.alloc(1, 1)])).digest().slice(0, len);
}

async function buildVapidJWT(audience) {
  const header = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const now    = Math.floor(Date.now() / 1000);
  const payload = b64url(JSON.stringify({ aud: audience, exp: now + 12 * 3600, sub: 'mailto:dispatch@wesbell.com' }));
  const sigInput = `${header}.${payload}`;
  const privKey = crypto.createPrivateKey({
    key: Buffer.concat([
      Buffer.from('308187020100301306072a8648ce3d020106082a8648ce3d030107046d306b0201010420', 'hex'),
      fromb64url(VAPID_KEYS.privateKey),
      Buffer.from('a144034200', 'hex'),
      fromb64url(VAPID_KEYS.publicKey),
    ]),
    format: 'der', type: 'pkcs8',
  });
  const sig = crypto.sign(null, Buffer.from(sigInput), { key: privKey, dsaEncoding: 'ieee-p1363' });
  return `${sigInput}.${b64url(sig)}`;
}

async function encryptPushPayload(plaintext, keys) {
  const serverKeys  = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const serverPubRaw = serverKeys.publicKey.export({ type: 'spki', format: 'der' }).slice(26);
  const clientPubRaw = fromb64url(keys.p256dh);
  const authSecret   = fromb64url(keys.auth);
  const clientPub    = crypto.createPublicKey({
    key: Buffer.concat([Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex'), clientPubRaw]),
    format: 'der', type: 'spki',
  });
  const sharedSecret = crypto.diffieHellman({ privateKey: serverKeys.privateKey, publicKey: clientPub });
  const prk   = await hkdf(authSecret, sharedSecret, Buffer.concat([Buffer.from('WebPush: info\x00'), clientPubRaw, serverPubRaw]), 32);
  const salt  = crypto.randomBytes(16);
  const cek   = await hkdf(salt, prk, Buffer.concat([Buffer.from('Content-Encoding: aes128gcm\x00'), Buffer.alloc(1, 1)]), 16);
  const nonce = await hkdf(salt, prk, Buffer.concat([Buffer.from('Content-Encoding: nonce\x00'),     Buffer.alloc(1, 1)]), 12);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const msg    = Buffer.concat([Buffer.from(plaintext), Buffer.alloc(1, 2)]);
  const encrypted = Buffer.concat([cipher.update(msg), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.alloc(1, serverPubRaw.length), serverPubRaw, encrypted]);
}

async function sendPush(subscription, payload) {
  const { endpoint, keys } = subscription;
  const url  = new URL(endpoint);
  const jwt  = await buildVapidJWT(`${url.protocol}//${url.host}`);
  const body = await encryptPushPayload(payload, keys);
  const https = require('https');
  return new Promise((resolve, reject) => {
    const req = https.request(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `vapid t=${jwt},k=${VAPID_KEYS.publicKey}`,
        'Content-Type': 'application/octet-stream',
        'Content-Encoding': 'aes128gcm',
        TTL: '86400',
        'Content-Length': body.length,
      },
    }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.write(body); req.end();
  });
}

async function broadcastPush(title, body, data) {
  if (!VAPID_KEYS || pushSubs.size === 0) return;
  const payload = JSON.stringify({ title, body, data: data || {} });
  const dead = [];
  for (const [endpoint, sub] of pushSubs) {
    try {
      const s = await sendPush(sub, payload);
      if (s === 410 || s === 404) dead.push(endpoint);
    } catch {}
  }
  if (dead.length) {
    dead.forEach(ep => pushSubs.delete(ep));
    await run(
      `DELETE FROM push_subscriptions WHERE endpoint IN (${dead.map(() => '?').join(',')})`,
      dead
    ).catch(() => {});
  }
}

module.exports = {
  get VAPID_KEYS() { return VAPID_KEYS; },
  pushSubs,
  loadOrGenVapid, loadSubscriptions,
  broadcastPush,
};
