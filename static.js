'use strict';
const { Router } = require('express');
const path = require('path');
const fs   = require('fs');
const { guardPage } = require('../auth');

const router   = Router();
const ROOT_DIR = path.join(__dirname, '..', '..');   // project root

const SAFE_FILES = /^\/(app\.js|style\.css|sw2?\.js|manifest\.json|favicon\.ico|favicon-\d+\.png|icon-\d+\.png|icon-[\w-]+\.png|apple-touch-icon\.png|icons\/icon-[\w-]+\.png|splash\/splash-[\w-]+\.png|js\/[\w./-]+\.js)$/;

router.use((req, res, next) => {
  if (req.path === '/sw.js' || req.path === '/sw2.js') {
    res.setHeader('Service-Worker-Allowed', '/');
    res.setHeader('Content-Type', 'application/javascript');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    const swFile = req.path === '/sw2.js' ? 'sw2.js' : 'sw.js';
    return res.sendFile(path.join(ROOT_DIR, swFile), err => { if (err && !res.headersSent) res.status(404).end(); });
  }
  if (req.path === '/manifest.json') res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  if (!SAFE_FILES.test(req.path)) return next();
  if (/\.(png|ico)$/.test(req.path)) res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
  if (/\.(js|css)$/.test(req.path))  res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  res.sendFile(path.join(ROOT_DIR, req.path.replace(/\/\.\./g, '')), err => { if (err && !res.headersSent) res.status(404).end(); });
});

// ── Index ─────────────────────────────────────────────────────────────────────
const INDEX_FILE = path.join(ROOT_DIR, 'index.html');
const sendIndex  = (_, res) => {
  try {
    let html = fs.readFileSync(INDEX_FILE, 'utf8');
    html = html.replace('</head>',
      '<style>body,body::before,body::after{background-image:none!important;background:var(--bg)!important}' +
      '#dispatchView,#dockView,#managementView,#driverView{background-image:none!important}</style></head>'
    );
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.send(html);
  } catch { res.sendFile(INDEX_FILE); }
};

router.get('/',           guardPage(['dispatcher', 'management', 'admin']), sendIndex);
router.get('/dock',       guardPage(['dock', 'dispatcher', 'management', 'admin', '__driver__']), sendIndex);
router.get('/driver',     guardPage(['__driver__', 'dock', 'dispatcher', 'management', 'admin']), sendIndex);
router.get('/management', guardPage(['management', 'admin']), sendIndex);
router.get('/login',      require('./login'));

module.exports = router;
