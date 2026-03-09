'use strict';
const { Router } = require('express');
const { requireRole, requireDriverAccess, getSession } = require('../auth');
const { run, get, all } = require('../db');
const { wsBroadcastToLocation } = require('../ws');
const { audit } = require('../helpers');
const { ipOf } = require('../middleware');

const router = Router();

// ── Channel access map ────────────────────────────────────────────────────────
// Which roles can read/post to which channels
const CHANNEL_ROLES = {
  general  : ['dispatcher', 'dock', 'management', 'admin', 'driver'],
  dispatch : ['dispatcher', 'management', 'admin'],
  dock     : ['dock', 'dispatcher', 'management', 'admin'],
  drivers  : ['dispatcher', 'dock', 'management', 'admin', 'driver'],
};

const VALID_CHANNELS = Object.keys(CHANNEL_ROLES);

function canAccessChannel(role, channel) {
  if (!role) return false;
  return (CHANNEL_ROLES[channel] || []).includes(role);
}

// ── Middleware: any logged-in role (including driver via session) ───────────
function requireChat(req, res, next) {
  const s = getSession(req);
  if (!s?.role) return res.status(401).send('Not authenticated');
  req.chatRole   = s.role;
  req.chatLocId  = s.locationId || 1;
  next();
}

// ── GET /api/chat/history?channel=general&before=<id>&limit=50 ───────────────
router.get('/api/chat/history', requireChat, async (req, res) => {
  try {
    const channel = VALID_CHANNELS.includes(req.query.channel) ? req.query.channel : 'general';
    if (!canAccessChannel(req.chatRole, channel)) return res.status(403).send('No access to channel');
    const limit  = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    const before = Number(req.query.before) || Number.MAX_SAFE_INTEGER;
    const rows = await all(
      `SELECT id, at, channel, role, sender, body
       FROM messages
       WHERE channel=? AND location_id=? AND id<?
       ORDER BY at DESC LIMIT ?`,
      [channel, req.chatLocId, before, limit]
    );
    res.json(rows.reverse()); // chronological order
  } catch { res.status(500).send('History fetch failed'); }
});

// ── POST /api/chat/send ───────────────────────────────────────────────────────
router.post('/api/chat/send', requireChat, async (req, res) => {
  try {
    const channel = VALID_CHANNELS.includes(req.body.channel) ? req.body.channel : 'general';
    if (!canAccessChannel(req.chatRole, channel)) return res.status(403).send('No access to channel');
    const body   = String(req.body.body || '').trim().slice(0, 1000);
    const sender = String(req.body.sender || '').trim().slice(0, 60) || roleName(req.chatRole);
    if (!body) return res.status(400).send('Empty message');

    const at = Date.now();
    const result = await run(
      `INSERT INTO messages(at, channel, role, sender, body, location_id) VALUES(?,?,?,?,?,?)`,
      [at, channel, req.chatRole, sender, body, req.chatLocId]
    );
    const msg = { id: result.lastID, at, channel, role: req.chatRole, sender, body };
    wsBroadcastToLocation(req.chatLocId, 'chat', msg);

    res.json({ ok: true, id: result.lastID });
  } catch { res.status(500).send('Send failed'); }
});

// ── GET /api/chat/channels ────────────────────────────────────────────────────
// Returns list of channels accessible to the caller with unread counts
router.get('/api/chat/channels', requireChat, async (req, res) => {
  try {
    const accessible = VALID_CHANNELS.filter(c => canAccessChannel(req.chatRole, c));
    const since = Number(req.query.since) || 0;
    const counts = {};
    for (const ch of accessible) {
      const row = await get(
        `SELECT COUNT(*) as cnt FROM messages WHERE channel=? AND location_id=? AND at>?`,
        [ch, req.chatLocId, since]
      );
      counts[ch] = row?.cnt || 0;
    }
    res.json({ channels: accessible, unread: counts });
  } catch { res.status(500).send('Channels fetch failed'); }
});

function roleName(role) {
  const names = { dispatcher: 'Dispatcher', dock: 'Dock', management: 'Management', admin: 'Admin', driver: 'Driver' };
  return names[role] || 'User';
}

module.exports = router;
