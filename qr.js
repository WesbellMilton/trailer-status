/**
 * qr.js — Wesbell Dispatch QR component
 *
 * Provides:
 *  1. QR SCANNER — uses jsQR (loaded from CDN) to scan via device camera.
 *     Decodes wb:// deep-links and calls a handler with { trailer, action, door }.
 *
 *  2. QR GENERATOR — builds a wb:// deep-link URL and renders it as a QR code
 *     using the lightweight qrcode.js library (loaded from CDN).
 *
 *  3. DOCK SCAN SHORTCUT — keyboard/barcode-scanner input field that auto-
 *     advances a trailer to the next logical status.
 */
import { apiPost, apiJson } from '../api.js';
import { store }            from '../state.js';

// ── CDN loader helper ─────────────────────────────────────────────────────────
function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement('script');
    s.src = src; s.onload = resolve; s.onerror = reject;
    document.head.appendChild(s);
  });
}

const JSQR_CDN   = 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.min.js';
const QRCODE_CDN = 'https://cdn.jsdelivr.net/npm/qrcode@1.5.3/build/qrcode.min.js';

// ── Deep-link format ──────────────────────────────────────────────────────────
// QR codes encode a regular HTTPS URL:
//   https://<host>/driver?qr=1&trailer=5312&action=arrive
//   https://<host>/driver?qr=1&trailer=5312&action=door/34
//   https://<host>/driver?qr=1&trailer=5312&action=depart
//
// The server also supports /api/qr/scan for direct API scanning by dock terminals.

function parseQrUrl(rawText) {
  try {
    const url    = new URL(rawText, location.href);
    const trailer = url.searchParams.get('trailer');
    const action  = url.searchParams.get('action')  || 'arrive';
    const door    = url.searchParams.get('door')     || '';
    if (!trailer) return null;
    return { trailer: trailer.toUpperCase(), action, door };
  } catch {
    // Try plain "TRAILER:ACTION" format from laser scanners
    const m = rawText.match(/^([A-Z0-9\-_. ]{1,20}):([a-z_/]+)$/i);
    if (m) return { trailer: m[1].toUpperCase(), action: m[2].toLowerCase(), door: '' };
    // Just a trailer number — default to arrive
    if (/^[A-Z0-9\-_. ]{1,20}$/i.test(rawText.trim()))
      return { trailer: rawText.trim().toUpperCase(), action: 'arrive', door: '' };
    return null;
  }
}

// ── 1. QR SCANNER ─────────────────────────────────────────────────────────────
let _scanActive    = false;
let _scanVideo     = null;
let _scanCanvas    = null;
let _scanCtx       = null;
let _scanAnimFrame = null;
let _scanHandler   = null;

export async function startQrScanner(videoEl, canvasEl, onResult) {
  if (_scanActive) return;
  await loadScript(JSQR_CDN);
  _scanVideo   = videoEl;
  _scanCanvas  = canvasEl;
  _scanCtx     = canvasEl.getContext('2d');
  _scanHandler = onResult;
  _scanActive  = true;

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
    });
    videoEl.srcObject = stream;
    await videoEl.play();
    _scanLoop();
  } catch (e) {
    _scanActive = false;
    throw new Error('Camera access denied: ' + e.message);
  }
}

export function stopQrScanner() {
  _scanActive = false;
  if (_scanAnimFrame) { cancelAnimationFrame(_scanAnimFrame); _scanAnimFrame = null; }
  if (_scanVideo?.srcObject) {
    _scanVideo.srcObject.getTracks().forEach(t => t.stop());
    _scanVideo.srcObject = null;
  }
}

function _scanLoop() {
  if (!_scanActive) return;
  _scanAnimFrame = requestAnimationFrame(_scanLoop);
  if (!_scanVideo || _scanVideo.readyState < 2) return;

  _scanCanvas.width  = _scanVideo.videoWidth;
  _scanCanvas.height = _scanVideo.videoHeight;
  _scanCtx.drawImage(_scanVideo, 0, 0, _scanCanvas.width, _scanCanvas.height);

  const imageData = _scanCtx.getImageData(0, 0, _scanCanvas.width, _scanCanvas.height);
  // jsQR is loaded globally from CDN
  const code = window.jsQR?.(imageData.data, imageData.width, imageData.height, {
    inversionAttempts: 'dontInvert',
  });

  if (code?.data) {
    const parsed = parseQrUrl(code.data);
    if (parsed && _scanHandler) {
      stopQrScanner();
      _scanHandler(parsed);
    }
  }
}

// ── 2. QR GENERATOR ──────────────────────────────────────────────────────────
/**
 * generateQr(canvasEl, { trailer, action, door })
 * Renders a QR code onto the provided canvas element.
 */
export async function generateQr(canvasEl, { trailer, action = 'arrive', door = '' }) {
  await loadScript(QRCODE_CDN);
  const params = new URLSearchParams({ qr: '1', trailer, action });
  if (door) params.set('door', door);
  const url = `${location.origin}/driver?${params.toString()}`;

  // Use global QRCode from CDN
  await window.QRCode?.toCanvas(canvasEl, url, {
    width       : 220,
    margin      : 2,
    color       : { dark: '#e8eef8', light: '#0c1018' },
    errorCorrectionLevel: 'M',
  });
  return url;
}

/**
 * generateQrDataUrl({ trailer, action, door }) → Promise<string>
 * Returns a data URL for embedding in an <img>.
 */
export async function generateQrDataUrl({ trailer, action = 'arrive', door = '' }) {
  await loadScript(QRCODE_CDN);
  const params = new URLSearchParams({ qr: '1', trailer, action });
  if (door) params.set('door', door);
  const url = `${location.origin}/driver?${params.toString()}`;
  return window.QRCode?.toDataURL(url, {
    width: 300, margin: 2,
    color: { dark: '#e8eef8', light: '#0c1018' },
  });
}

// ── 3. DOCK SCAN SHORTCUT (keyboard / USB barcode reader) ────────────────────
const STATUS_FLOW = {
  Incoming  : { to: 'Loading',    label: '→ Loading'    },
  Dropped   : { to: 'Loading',    label: '→ Loading'    },
  Loading   : { to: 'Dock Ready', label: '→ Dock Ready' },
  'Dock Ready': { to: 'Ready',    label: '→ Ready'      },
  Ready     : { to: 'Departed',   label: '→ Departed'   },
};

/**
 * initDockScan(inputEl, toast, onStatusChange)
 * Wires a keyboard/scanner input field.
 * On Enter, looks up the trailer in the store and advances to next status.
 */
export function initDockScan(inputEl, toast, onStatusChange) {
  if (!inputEl) return;

  async function doScan() {
    const raw   = (inputEl.value || '').trim();
    const parsed = parseQrUrl(raw);
    const trailerNum = parsed?.trailer || raw.toUpperCase();
    if (!trailerNum) return;

    const trailers = store.get('trailers') || {};
    const record   = trailers[trailerNum];

    if (parsed?.action && parsed.action !== 'arrive') {
      // Direct action from QR
      await _handleQrAction(parsed, toast);
      inputEl.value = '';
      return;
    }

    if (!record) { toast?.(`⚠ ${trailerNum} not on board`, 'warn'); inputEl.value = ''; return; }

    const nx = STATUS_FLOW[record.status];
    if (!nx) { toast?.(`${trailerNum} is already ${record.status}`, 'info'); inputEl.value = ''; return; }

    try {
      await apiPost('/api/upsert', { trailer: trailerNum, status: nx.to });
      toast?.(`✓ ${trailerNum} ${nx.label}`, 'ok');
      onStatusChange?.();
    } catch (e) { toast?.(`Error: ${e.message}`, 'err'); }
    inputEl.value = '';
  }

  inputEl.addEventListener('keydown', e => { if (e.key === 'Enter') doScan(); });
}

async function _handleQrAction(parsed, toast) {
  try {
    const res = await apiPost('/api/qr/scan', {
      trailer: parsed.trailer, action: parsed.action, door: parsed.door, scannedBy: 'dock',
    });
    toast?.(`✓ ${parsed.trailer} · ${parsed.action}`, 'ok');
    return res;
  } catch (e) {
    toast?.(`QR error: ${e.message}`, 'err');
  }
}

// ── Auto-handle QR on page load ────────────────────────────────────────────────
export function checkQrAutoLoad() {
  const params = new URLSearchParams(location.search);
  if (!params.has('qr')) return null;
  const trailer = params.get('trailer');
  const action  = params.get('action') || 'arrive';
  const door    = params.get('door')   || '';
  if (!trailer) return null;
  // Clean URL without reloading
  const clean = location.pathname;
  history.replaceState({}, '', clean);
  return { trailer: trailer.toUpperCase(), action, door };
}
