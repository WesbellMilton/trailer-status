'use strict';
const { Router } = require('express');
const { run } = require('../db');
const { requireXHR, requireDriverRate } = require('../middleware');
const push = require('../push');

const router = Router();

router.get('/api/push/vapid-public-key', (req, res) => {
  if (!push.VAPID_KEYS) return res.status(503).send('VAPID not ready');
  res.json({ publicKey: push.VAPID_KEYS.publicKey });
});

router.post('/api/push/subscribe', requireXHR, requireDriverRate, async (req, res) => {
  try {
    const sub = req.body;
    if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth)
      return res.status(400).send('Invalid subscription');
    push.pushSubs.set(sub.endpoint, sub);
    await run(
      `INSERT INTO push_subscriptions(endpoint,subscription,createdAt) VALUES(?,?,?)
       ON CONFLICT(endpoint) DO UPDATE SET subscription=excluded.subscription`,
      [sub.endpoint, JSON.stringify(sub), Date.now()]
    );
    res.json({ ok: true });
  } catch { res.status(500).send('Subscribe failed'); }
});

router.post('/api/push/unsubscribe', requireXHR, async (req, res) => {
  try {
    const { endpoint } = req.body;
    if (endpoint) {
      push.pushSubs.delete(endpoint);
      await run(`DELETE FROM push_subscriptions WHERE endpoint=?`, [endpoint]);
    }
    res.json({ ok: true });
  } catch { res.status(500).send('Unsubscribe failed'); }
});

module.exports = router;
