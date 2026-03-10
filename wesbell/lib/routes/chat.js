'use strict';
const { Router } = require('express');
const { getSession } = require('../auth');
const { run, get, all } = require('../db');
const { wsBroadcastToLocation } = require('../ws');

const router = Router();
const MAX_PHOTO_BYTES = 4 * 1024 * 1024;

const CHANNEL_ROLES = {
  general  : ['dispatcher','dock','management','admin','driver'],
  dispatch : ['dispatcher','management','admin'],
  dock     : ['dock','dispatcher','management','admin'],
  drivers  : ['dispatcher','dock','management','admin','driver'],
  overnight: ['dispatcher','dock','management','admin'],
};
const VALID_CHANNELS = Object.keys(CHANNEL_ROLES);
const canAccess = (role, ch) => !!(role && (CHANNEL_ROLES[ch]||[]).includes(role));

// ── Auth helper ───────────────────────────────────────────────────────────────
// Note: messages table is created by migration v8 in migrations.js
function requireChat(req, res, next) {
  const s = getSession(req);
  if (!s?.role) return res.status(401).send('Not authenticated');
  req.chatRole  = s.role;
  req.chatLocId = s.locationId || 1;
  next();
}

function roleName(r) {
  return { dispatcher:'Dispatcher', dock:'Dock', management:'Management', admin:'Admin', driver:'Driver' }[r] || 'User';
}

function parseRow(r) {
  return {
    id        : r.id,
    at        : r.at,
    channel   : r.channel,
    role      : r.role,
    sender    : r.sender,
    body      : r.body,
    reply_to  : r.reply_to  || null,
    reactions : r.reactions ? JSON.parse(r.reactions) : {},
    has_photo : !!(r.has_photo || r.photo_data),
    photo_mime: r.photo_mime || null,
  };
}

// ── GET /api/chat/channels ────────────────────────────────────────────────────
// Returns channels the current role can access + unread counts since ?since=
router.get('/api/chat/channels', requireChat, async (req, res) => {
  try {
    const accessible = VALID_CHANNELS.filter(c => canAccess(req.chatRole, c));
    const since      = Number(req.query.since) || 0;
    const counts     = {};
    for (const ch of accessible) {
      const row = await get(
        `SELECT COUNT(*) as cnt FROM messages WHERE channel=? AND location_id=? AND at>?`,
        [ch, req.chatLocId, since]
      );
      counts[ch] = row?.cnt || 0;
    }
    res.json({ channels: accessible, unread: counts });
  } catch (e) {
    console.error('[chat/channels]', e.message);
    res.status(500).send('Channels failed');
  }
});

// ── GET /api/chat/history ─────────────────────────────────────────────────────
// Query params: channel, limit (max 100), before (message id cursor)
router.get('/api/chat/history', requireChat, async (req, res) => {
  try {
    const channel = VALID_CHANNELS.includes(req.query.channel) ? req.query.channel : 'general';
    if (!canAccess(req.chatRole, channel)) return res.status(403).send('No access');
    const limit  = Math.min(100, Math.max(1, Number(req.query.limit)  || 50));
    const before = Number(req.query.before) || Number.MAX_SAFE_INTEGER;
    let rows;
    try {
      rows = await all(
        `SELECT id, at, channel, role, sender, body, reply_to, reactions, photo_mime,
                (CASE WHEN photo_data IS NOT NULL THEN 1 ELSE 0 END) as has_photo
         FROM messages
         WHERE channel=? AND location_id=? AND id<?
         ORDER BY at DESC LIMIT ?`,
        [channel, req.chatLocId, before, limit]
      );
    } catch {
      // Fallback if newer columns don't exist yet
      rows = await all(
        `SELECT id, at, channel, role, sender, body FROM messages
         WHERE channel=? AND location_id=? AND id<?
         ORDER BY at DESC LIMIT ?`,
        [channel, req.chatLocId, before, limit]
      );
    }
    res.json(rows.reverse().map(parseRow));
  } catch (e) {
    console.error('[chat/history]', e.message);
    res.status(500).send('History failed');
  }
});

// ── POST /api/chat/send ───────────────────────────────────────────────────────
// Body: { channel, body, sender?, reply_to?, photo_data?, photo_mime? }
router.post('/api/chat/send', requireChat, async (req, res) => {
  try {
    const channel   = VALID_CHANNELS.includes(req.body.channel) ? req.body.channel : 'general';
    if (!canAccess(req.chatRole, channel)) return res.status(403).send('No access');
    const body      = String(req.body.body    || '').trim().slice(0, 1000);
    const sender    = String(req.body.sender  || '').trim().slice(0, 60) || roleName(req.chatRole);
    const reply_to  = req.body.reply_to ? Number(req.body.reply_to) : null;
    const photoData = req.body.photo_data || null;
    const photoMime = req.body.photo_mime || null;

    if (!body && !photoData) return res.status(400).send('Empty message');

    if (photoData) {
      if (!photoMime?.startsWith('image/'))          return res.status(400).send('Invalid photo type');
      if (photoData.length * 0.75 > MAX_PHOTO_BYTES) return res.status(413).send('Photo too large (max 4 MB)');
    }

    if (reply_to) {
      const parent = await get(
        `SELECT id FROM messages WHERE id=? AND channel=? AND location_id=?`,
        [reply_to, channel, req.chatLocId]
      );
      if (!parent) return res.status(400).send('Invalid reply_to');
    }

    const at = Date.now();
    let result;
    try {
      result = await run(
        `INSERT INTO messages(at,channel,role,sender,body,reply_to,photo_data,photo_mime,location_id)
         VALUES(?,?,?,?,?,?,?,?,?)`,
        [at, channel, req.chatRole, sender, body || '', reply_to, photoData, photoMime, req.chatLocId]
      );
    } catch {
      // Fallback for older schema
      result = await run(
        `INSERT INTO messages(at,channel,role,sender,body,location_id) VALUES(?,?,?,?,?,?)`,
        [at, channel, req.chatRole, sender, body || '', req.chatLocId]
      );
    }

    const msg = {
      id        : result.lastID,
      at,
      channel,
      role      : req.chatRole,
      sender,
      body      : body || '',
      reply_to,
      reactions : {},
      has_photo : !!photoData,
      photo_mime: photoMime,
    };

    wsBroadcastToLocation(req.chatLocId, 'chat', { type: 'message', data: msg });
    res.json({ ok: true, id: result.lastID });
  } catch (e) {
    console.error('[chat/send]', e.message);
    res.status(500).send('Send failed');
  }
});

// ── POST /api/chat/react ──────────────────────────────────────────────────────
// Body: { id, emoji }
router.post('/api/chat/react', requireChat, async (req, res) => {
  try {
    const id    = Number(req.body.id);
    const emoji = String(req.body.emoji || '').trim();
    const ALLOWED = ['👍','✅','👀','⚠️','🚛','🔧','🔴','🟢','📦','🕐','💯','❓','🙏','🔥','💪','😅'];

    if (!id || !ALLOWED.includes(emoji)) return res.status(400).send('Invalid');

    const row = await get(
      `SELECT reactions, channel, location_id FROM messages WHERE id=? AND location_id=?`,
      [id, req.chatLocId]
    );
    if (!row) return res.status(404).send('Not found');
    if (!canAccess(req.chatRole, row.channel)) return res.status(403).send('No access');

    const reactions = row.reactions ? JSON.parse(row.reactions) : {};
    if (!reactions[emoji]) reactions[emoji] = [];
    const idx = reactions[emoji].indexOf(req.chatRole);
    if (idx === -1) reactions[emoji].push(req.chatRole);
    else            reactions[emoji].splice(idx, 1);
    if (!reactions[emoji].length) delete reactions[emoji];

    await run(`UPDATE messages SET reactions=? WHERE id=?`, [JSON.stringify(reactions), id]);
    wsBroadcastToLocation(req.chatLocId, 'chat', { type: 'reaction', data: { id, reactions } });
    res.json({ ok: true, reactions });
  } catch (e) {
    console.error('[chat/react]', e.message);
    res.status(500).send('React failed');
  }
});

// ── GET /api/chat/photo/:id ───────────────────────────────────────────────────
router.get('/api/chat/photo/:id', requireChat, async (req, res) => {
  try {
    const row = await get(
      `SELECT photo_data, photo_mime, channel FROM messages WHERE id=? AND location_id=?`,
      [req.params.id, req.chatLocId]
    );
    if (!row?.photo_data) return res.status(404).send('No photo');
    if (!canAccess(req.chatRole, row.channel)) return res.status(403).send('No access');
    res.setHeader('Content-Type',    row.photo_mime || 'image/jpeg');
    res.setHeader('Cache-Control',   'private, max-age=86400');
    res.send(Buffer.from(row.photo_data, 'base64'));
  } catch (e) {
    console.error('[chat/photo]', e.message);
    res.status(500).send('Photo failed');
  }
});

// ── DELETE /api/chat/message/:id ──────────────────────────────────────────────
// Admin only — deletes a message
router.delete('/api/chat/message/:id', requireChat, async (req, res) => {
  try {
    const msgId = Number(req.params.id);
    if (!msgId) return res.status(400).send('Invalid id');
    // Admins can delete any message; others can only delete their own
    const existing = await get(
      `SELECT role, sender FROM messages WHERE id=? AND location_id=?`,
      [msgId, req.chatLocId]
    );
    if (!existing) return res.status(404).send('Not found');
    const isOwn = (existing.role === req.chatRole);
    if (req.chatRole !== 'admin' && !isOwn) return res.status(403).send('Cannot delete others\' messages');
    const result = await run(
      `DELETE FROM messages WHERE id=? AND location_id=?`,
      [msgId, req.chatLocId]
    );
    if (!result.changes) return res.status(404).send('Not found');
    wsBroadcastToLocation(req.chatLocId, 'chat', { type: 'deleted', data: { id: msgId } });
    res.json({ ok: true });
  } catch (e) {
    console.error('[chat/delete]', e.message);
    res.status(500).send('Delete failed');
  }
});

// ── GET /api/chat/search ──────────────────────────────────────────────────────
// Query params: q (search term), channel (optional)
router.get('/api/chat/search', requireChat, async (req, res) => {
  try {
    const q       = String(req.query.q || '').trim();
    const channel = req.query.channel && VALID_CHANNELS.includes(req.query.channel)
                    ? req.query.channel : null;
    if (!q) return res.status(400).send('Query required');

    let rows;
    if (channel) {
      if (!canAccess(req.chatRole, channel)) return res.status(403).send('No access');
      rows = await all(
        `SELECT id,at,channel,role,sender,body,reply_to,reactions,photo_mime,
                (CASE WHEN photo_data IS NOT NULL THEN 1 ELSE 0 END) as has_photo
         FROM messages WHERE channel=? AND location_id=? AND body LIKE ?
         ORDER BY at DESC LIMIT 50`,
        [channel, req.chatLocId, `%${q}%`]
      );
    } else {
      const accessible = VALID_CHANNELS.filter(c => canAccess(req.chatRole, c));
      rows = await all(
        `SELECT id,at,channel,role,sender,body,reply_to,reactions,photo_mime,
                (CASE WHEN photo_data IS NOT NULL THEN 1 ELSE 0 END) as has_photo
         FROM messages
         WHERE channel IN (${accessible.map(() => '?').join(',')}) AND location_id=? AND body LIKE ?
         ORDER BY at DESC LIMIT 50`,
        [...accessible, req.chatLocId, `%${q}%`]
      );
    }
    res.json(rows.map(parseRow));
  } catch (e) {
    console.error('[chat/search]', e.message);
    res.status(500).send('Search failed');
  }
});

// ── GET /api/chat/stats ───────────────────────────────────────────────────────
// Returns message counts per channel — used by analytics dashboard
router.get('/api/chat/stats', requireChat, async (req, res) => {
  try {
    if (!['admin','management','dispatcher'].includes(req.chatRole)) return res.status(403).send('No access');
    const rows = await all(
      `SELECT channel, COUNT(*) as message_count, MAX(at) as last_message
       FROM messages WHERE location_id=?
       GROUP BY channel ORDER BY channel`,
      [req.chatLocId]
    );
    res.json({ stats: rows });
  } catch (e) {
    console.error('[chat/stats]', e.message);
    res.status(500).send('Stats failed');
  }
});

module.exports = router;
