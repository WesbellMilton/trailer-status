// sw2.js — Wesbell Dispatch Service Worker
// Integrated with Network-First Strategy + Real-Time API Passthrough

const CACHE_NAME = "wesbell-v3.6.5";
const ASSETS_TO_CACHE = [
  "/",
  "/index.html",
  "/style.css",
  "/app.js",
  "/manifest.json",
  "/icons/icon-192.png",
  "/icons/icon-512.png"
];

// 1. INSTALL: Populate cache with App Shell
self.addEventListener("install", evt => {
  evt.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      console.log("SW2: Caching App Shell Assets");
      return cache.addAll(ASSETS_TO_CACHE);
    })
  );
  self.skipWaiting();
});

// 2. ACTIVATE: Cleanup old caches and notify app.js
self.addEventListener("activate", evt => {
  evt.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
      );
    }).then(() => self.clients.claim())
  );

  // Notify clients (app.js) to reload for the new version
  evt.waitUntil(
    self.clients.matchAll({ type: "window" }).then(clients => {
      clients.forEach(client => client.postMessage({ type: "SW_UPDATED" }));
    })
  );
});

// 3. FETCH: Network-First with Cache-Fallback
self.addEventListener("fetch", evt => {
  const url = new URL(evt.request.url);

  // Skip non-GET requests (POSTs must hit network)
  if (evt.request.method !== "GET" || url.origin !== self.location.origin) return;

  // CRITICAL: Passthrough for Real-time API data
  // We NEVER want to serve a cached version of the trailer board.
  if (url.pathname.startsWith("/api/")) {
    return; 
  }

  // For static assets (CSS, JS, HTML), try Network first, fallback to Cache
  evt.respondWith(
    fetch(evt.request)
      .then(networkRes => {
        // If network is successful, update cache with the fresh version
        return caches.open(CACHE_NAME).then(cache => {
          cache.put(evt.request, networkRes.clone());
          return networkRes;
        });
      })
      .catch(() => {
        // If offline, serve from cache
        return caches.match(evt.request);
      })
  );
});

// 4. PUSH: Handle Dispatcher/Driver Alerts
self.addEventListener("push", evt => {
  if (!evt.data) return;
  let data = {};
  try { 
    data = evt.data.json(); 
  } catch { 
    data = { title: "Wesbell Dispatch", body: evt.data.text() }; 
  }

  const options = {
    body: data.body || "",
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    tag: "wb-dispatch",
    renotify: true,
    vibrate: [100, 50, 100],
    data: data.data || {},
  };

  evt.waitUntil(
    self.registration.showNotification(data.title || "Wesbell Dispatch", options)
  );
});

// 5. NOTIFICATION CLICK: Focus existing app window
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
