'use strict';
/**
 * chat.js — Team Chat routes for Wesbell Dispatch
 * GET  /api/chat/history?channel=general   — last 100 messages
 * POST /api/chat/send                       — post a message (text + optional base64 image)
 * DELETE /api/chat/message/:id             — delete own message (dispatchers/admin can delete any)
 *
 * WS broadcast on send: { type: 'chat', payload: { id, at, channel, role, name, text, imageData } }
 */
const { Router } = require('express');
const { run, get, all } = require('../db');
const { requireXHR } = require('../middleware');
const { wsBroadcast } = require('../ws');
const { audit } = require('../helpers');

const router = Router();

// ── Roles allowed to use chat ──────────────────────────────────────────────────
const CHAT_ROLES = new Set(['dispatcher', 'management', 'admin', 'dock']);

function requireChat(req, res, next) {
  const s = require('../auth').getSession(req);
  if (!s || !CHAT_ROLES.has(s.role)) return res.status(401).json({ error: 'Not authorized' });
  req._session = s;
  next();
}

// Role display names
const ROLE_LABEL = {
  dispatcher: 'Dispatcher',
  dock:       'Dock',
  management: 'Management',
  admin:      'Admin',
};

// ── GET /api/chat/history ─────────────────────────────────────────────────────
router.get('/api/chat/history', requireChat, async (req, res) => {
  try {
    const channel = String(req.query.channel || 'general').slice(0, 32).replace(/[^a-z0-9_-]/gi, '');
    const rows = await all(
      `SELECT id, at, channel, role, name, text, imageData
         FROM chat_messages
        WHERE channel = ?
        ORDER BY at DESC
        LIMIT 100`,
      [channel]
    );
    // Return oldest-first to the client
    res.json({ messages: rows.reverse() });
  } catch (e) {
    console.error('[chat] history error:', e.message);
    res.status(500).json({ error: 'Failed to load messages' });
  }
});

// ── POST /api/chat/send ───────────────────────────────────────────────────────
router.post('/api/chat/send', requireXHR, requireChat, async (req, res) => {
  try {
    const s       = req._session;
    const channel = String(req.body.channel || 'general').slice(0, 32).replace(/[^a-z0-9_-]/gi, '');
    const text    = String(req.body.text || '').trim().slice(0, 2000);
    const name    = ROLE_LABEL[s.role] || s.role;

    // Optional base64 image — cap at ~4 MB (base64 overhead ~33%)
    let imageData = null;
    if (req.body.imageData) {
      const raw = String(req.body.imageData);
      if (raw.length > 5_500_000) return res.status(413).json({ error: 'Image too large (max ~4 MB)' });
      // Validate it's a data URI
      if (!/^data:image\/(png|jpe?g|gif|webp);base64,/.test(raw)) {
        return res.status(400).json({ error: 'Invalid image format' });
      }
      imageData = raw;
    }

    if (!text && !imageData) return res.status(400).json({ error: 'Message is empty' });

    const at = Date.now();
    const r  = await run(
      `INSERT INTO chat_messages (at, channel, role, name, text, imageData)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [at, channel, s.role, name, text, imageData]
    );

    const msg = { id: r.lastID, at, channel, role: s.role, name, text, imageData };
    wsBroadcast('chat', msg);

    await audit(req, s.role, 'chat_send', 'chat_message', String(r.lastID), { channel, textLen: text.length, hasImage: !!imageData });

    res.json({ ok: true, message: msg });
  } catch (e) {
    console.error('[chat] send error:', e.message);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// ── DELETE /api/chat/message/:id ──────────────────────────────────────────────
router.delete('/api/chat/message/:id', requireXHR, requireChat, async (req, res) => {
  try {
    const s  = req._session;
    const id = parseInt(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });

    const row = await get(`SELECT id, role FROM chat_messages WHERE id = ?`, [id]);
    if (!row) return res.status(404).json({ error: 'Not found' });

    const canDelete = s.role === 'admin' || s.role === 'management' || row.role === s.role;
    if (!canDelete) return res.status(403).json({ error: 'Cannot delete this message' });

    await run(`DELETE FROM chat_messages WHERE id = ?`, [id]);
    wsBroadcast('chat_delete', { id });

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Delete failed' });
  }
});

module.exports = router;
