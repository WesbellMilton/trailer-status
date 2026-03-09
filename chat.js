'use strict';
const { Router } = require('express');
const { requireRole, requireDriverAccess, getSession } = require('../auth');
const { run, get, all } = require('../db');
const { wsBroadcastToLocation } = require('../ws');
const { ipOf } = require('../middleware');

const router = Router();
const MAX_PHOTO_BYTES = 4 * 1024 * 1024;

const CHANNEL_ROLES = {
  general  : ['dispatcher','dock','management','admin','driver'],
  dispatch : ['dispatcher','management','admin'],
  dock     : ['dock','dispatcher','management','admin'],
  drivers  : ['dispatcher','dock','management','admin','driver'],
};
const VALID_CHANNELS = Object.keys(CHANNEL_ROLES);
const canAccess = (role, ch) => !!(role && (CHANNEL_ROLES[ch]||[]).includes(role));

function requireChat(req, res, next) {
  const s = getSession(req);
  if (!s?.role) return res.status(401).send('Not authenticated');
  req.chatRole  = s.role;
  req.chatLocId = s.locationId || 1;
  next();
}

function roleName(r) {
  return {dispatcher:'Dispatcher',dock:'Dock',management:'Management',admin:'Admin',driver:'Driver'}[r]||'User';
}

function parseRow(r) {
  return {
    id: r.id, at: r.at, channel: r.channel, role: r.role, sender: r.sender, body: r.body,
    reply_to: r.reply_to||null,
    reactions: r.reactions ? JSON.parse(r.reactions) : {},
    has_photo: !!(r.has_photo||r.photo_data),
    photo_mime: r.photo_mime||null,
  };
}

router.get('/api/chat/history', requireChat, async (req, res) => {
  try {
    const channel = VALID_CHANNELS.includes(req.query.channel) ? req.query.channel : 'general';
    if (!canAccess(req.chatRole, channel)) return res.status(403).send('No access');
    const limit  = Math.min(100, Math.max(1, Number(req.query.limit)||50));
    const before = Number(req.query.before)||Number.MAX_SAFE_INTEGER;
    const rows = await all(
      `SELECT id,at,channel,role,sender,body,reply_to,reactions,photo_mime,
              (CASE WHEN photo_data IS NOT NULL THEN 1 ELSE 0 END) as has_photo
       FROM messages WHERE channel=? AND location_id=? AND id<? ORDER BY at DESC LIMIT ?`,
      [channel, req.chatLocId, before, limit]
    );
    res.json(rows.reverse().map(parseRow));
  } catch(e){ console.error('[chat]',e.message); res.status(500).send('History failed'); }
});

router.post('/api/chat/send', requireChat, async (req, res) => {
  try {
    const channel  = VALID_CHANNELS.includes(req.body.channel) ? req.body.channel : 'general';
    if (!canAccess(req.chatRole, channel)) return res.status(403).send('No access');
    const body     = String(req.body.body||'').trim().slice(0,1000);
    const sender   = String(req.body.sender||'').trim().slice(0,60)||roleName(req.chatRole);
    const reply_to = req.body.reply_to ? Number(req.body.reply_to) : null;
    const photoData= req.body.photo_data||null;
    const photoMime= req.body.photo_mime||null;
    if (!body && !photoData) return res.status(400).send('Empty message');
    if (photoData) {
      if (!photoMime?.startsWith('image/')) return res.status(400).send('Invalid photo type');
      if (photoData.length*0.75 > MAX_PHOTO_BYTES) return res.status(413).send('Photo too large (max 4MB)');
    }
    if (reply_to) {
      const parent = await get(`SELECT id FROM messages WHERE id=? AND channel=? AND location_id=?`,[reply_to,channel,req.chatLocId]);
      if (!parent) return res.status(400).send('Invalid reply_to');
    }
    const at = Date.now();
    const result = await run(
      `INSERT INTO messages(at,channel,role,sender,body,reply_to,photo_data,photo_mime,location_id) VALUES(?,?,?,?,?,?,?,?,?)`,
      [at,channel,req.chatRole,sender,body||'',reply_to,photoData,photoMime,req.chatLocId]
    );
    const msg = {id:result.lastID,at,channel,role:req.chatRole,sender,body:body||'',reply_to,reactions:{},has_photo:!!photoData,photo_mime:photoMime};
    wsBroadcastToLocation(req.chatLocId,'chat',{type:'message',data:msg});
    res.json({ok:true,id:result.lastID});
  } catch(e){ console.error('[chat]',e.message); res.status(500).send('Send failed'); }
});

router.post('/api/chat/react', requireChat, async (req, res) => {
  try {
    const id    = Number(req.body.id);
    const emoji = String(req.body.emoji||'').trim();
    const ALLOWED = ['👍','✅','👀','⚠️','🚛','🔧'];
    if (!id || !ALLOWED.includes(emoji)) return res.status(400).send('Invalid');
    const row = await get(`SELECT reactions,channel,location_id FROM messages WHERE id=? AND location_id=?`,[id,req.chatLocId]);
    if (!row) return res.status(404).send('Not found');
    if (!canAccess(req.chatRole,row.channel)) return res.status(403).send('No access');
    const reactions = row.reactions ? JSON.parse(row.reactions) : {};
    if (!reactions[emoji]) reactions[emoji]=[];
    const idx = reactions[emoji].indexOf(req.chatRole);
    if (idx===-1) reactions[emoji].push(req.chatRole);
    else reactions[emoji].splice(idx,1);
    if (!reactions[emoji].length) delete reactions[emoji];
    await run(`UPDATE messages SET reactions=? WHERE id=?`,[JSON.stringify(reactions),id]);
    wsBroadcastToLocation(req.chatLocId,'chat',{type:'reaction',data:{id,reactions}});
    res.json({ok:true,reactions});
  } catch(e){ console.error('[chat]',e.message); res.status(500).send('React failed'); }
});

router.get('/api/chat/photo/:id', requireChat, async (req, res) => {
  try {
    const row = await get(`SELECT photo_data,photo_mime,channel FROM messages WHERE id=? AND location_id=?`,[req.params.id,req.chatLocId]);
    if (!row?.photo_data) return res.status(404).send('No photo');
    if (!canAccess(req.chatRole,row.channel)) return res.status(403).send('No access');
    res.setHeader('Content-Type',row.photo_mime||'image/jpeg');
    res.setHeader('Cache-Control','private, max-age=86400');
    res.send(Buffer.from(row.photo_data,'base64'));
  } catch(e){ console.error('[chat]',e.message); res.status(500).send('Photo failed'); }
});

router.get('/api/chat/channels', requireChat, async (req, res) => {
  try {
    const accessible = VALID_CHANNELS.filter(c=>canAccess(req.chatRole,c));
    const since = Number(req.query.since)||0;
    const counts = {};
    for (const ch of accessible) {
      const row = await get(`SELECT COUNT(*) as cnt FROM messages WHERE channel=? AND location_id=? AND at>?`,[ch,req.chatLocId,since]);
      counts[ch] = row?.cnt||0;
    }
    res.json({channels:accessible,unread:counts});
  } catch(e){ console.error('[chat]',e.message); res.status(500).send('Channels failed'); }
});

module.exports = router;
