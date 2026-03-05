// sw.js — Wesbell Dispatch Service Worker v4.0.0
const CACHE_NAME = "wesbell-v4.0.0"; // Updated to match your new system version
const ASSETS_TO_CACHE = [
  "/",
  "/index.html",
  "/style.css",
  "/app.js",
  "/manifest.json",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=DM+Sans:wght@400;500;600&family=Outfit:wght@300;400;600;700&display=swap"
];

// 1. INSTALL: Force the new version immediately
self.addEventListener("install", evt => {
  evt.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      console.log("SW: Caching App Shell");
      // Use cache.addAll but catch individual failures so the whole SW doesn't crash
      return Promise.allSettled(ASSETS_TO_CACHE.map(url => cache.add(url)));
    })
  );
  self.skipWaiting();
});

// 2. ACTIVATE: Cleanup old versions
self.addEventListener("activate", evt => {
  evt.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
      );
    }).then(() => self.clients.claim())
  );
});

// 3. FETCH: Smart Strategy
self.addEventListener("fetch", evt => {
  const url = new URL(evt.request.url);

  // RULE 1: Standard API & WebSocket bypass
  if (evt.request.method !== "GET" || url.pathname.startsWith("/api/") || url.origin !== self.location.origin) {
    return;
  }

  // RULE 2: Stale-While-Revalidate for UI Assets
  // This makes the tablet load the UI "instantly" from cache while updating in background
  evt.respondWith(
    caches.match(evt.request).then(cachedRes => {
      const fetchPromise = fetch(evt.request).then(networkRes => {
        // Update cache with fresh version
        if (networkRes.ok) {
          const cacheCopy = networkRes.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(evt.request, cacheCopy));
        }
        return networkRes;
      }).catch(() => {
        // Silently fail fetch if offline
      });

      return cachedRes || fetchPromise;
    })
  );
});

// 4. PUSH: Enhanced for Driver Assignments
self.addEventListener("push", evt => {
  if (!evt.data) return;
  let data = {};
  try { data = evt.data.json(); } catch (e) { data = { title: "Wesbell", body: evt.data.text() }; }

  evt.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      tag: data.tag || "wb-alert",
      renotify: true,
      // Vibrate pattern: Long, Short, Long (distinguishable in a loud warehouse)
      vibrate: [300, 100, 300],
      data: data.data || {}
    })
  );
});

// 5. CLICK: Navigate to specific screen if data is present
self.addEventListener("notificationclick", evt => {
  evt.notification.close();
  const targetUrl = evt.notification.data.url || "/";

  evt.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then(cs => {
      const existing = cs.find(c => c.url.includes(self.location.origin));
      if (existing) {
        existing.navigate(targetUrl);
        return existing.focus();
      }
      return clients.openWindow(targetUrl);
    })
  );
});
