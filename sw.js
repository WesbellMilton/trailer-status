// sw.js — Wesbell Dispatch Service Worker
// Cache-first for app shell assets, network-first for API/WS
const CACHE_NAME = "wb-dispatch-v5";
const CACHE_VERSION_KEY = "wb-cache-ver";

// Assets to cache immediately on install (app shell)
const PRECACHE = [
  "/",
  "/dock",
  "/driver",
  "/management",
  "/app.js",
  "/style.css",
  "/manifest.json",
  "/icon-192.png",
  "/apple-touch-icon.png",
];

// Patterns that should always go to network (never serve stale)
const NETWORK_ONLY = [
  /^\/api\//,
  /^\/login/,
];

// ── Install: precache app shell ──
self.addEventListener("install", evt => {
  self.skipWaiting();
  evt.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(PRECACHE).catch(() => {}))
  );
});

// ── Activate: evict old caches ──
self.addEventListener("activate", evt => {
  evt.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// ── Fetch: stale-while-revalidate for shell, network-only for API ──
self.addEventListener("fetch", evt => {
  const { request } = evt;
  const url = new URL(request.url);

  // Non-GET or cross-origin — let it pass through
  if (request.method !== "GET" || url.origin !== self.location.origin) return;

  // Network-only patterns (API, login page)
  if (NETWORK_ONLY.some(p => p.test(url.pathname))) return;

  // App shell: cache-first with background revalidation
  evt.respondWith(
    caches.open(CACHE_NAME).then(async cache => {
      const cached = await cache.match(request);
      const fetchPromise = fetch(request).then(res => {
        if (res && res.status === 200 && res.type !== "opaque") {
          cache.put(request, res.clone());
        }
        return res;
      }).catch(() => null);

      // Return cached immediately if available, else wait for network
      return cached || fetchPromise;
    })
  );
});

// ── Push notifications ──
self.addEventListener("push", evt => {
  if (!evt.data) return;
  let data = {};
  try { data = evt.data.json(); } catch { data = { title: "Wesbell Dispatch", body: evt.data.text() }; }
  evt.waitUntil(
    self.registration.showNotification(data.title || "Wesbell Dispatch", {
      body: data.body || "",
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      tag: "wb-dispatch",
      renotify: true,
      data: data.data || {},
    })
  );
});

self.addEventListener("notificationclick", evt => {
  evt.notification.close();
  evt.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then(cs => {
      const existing = cs.find(c => c.url.includes(self.location.origin));
      if (existing) return existing.focus();
      return clients.openWindow("/");
    })
  );
});
