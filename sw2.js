/**
 * WESBELL DISPATCH & DRIVER PORTAL - SERVICE WORKER (sw2.js)
 * v4.0.0 - Optimized for instant load and unreliable warehouse Wi-Fi.
 */

const CACHE_NAME = "wesbell-v4.0.0"; 
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

// 1. INSTALL: Populate cache with App Shell
self.addEventListener("install", evt => {
  evt.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      console.log("SW2: Caching App Shell Assets");
      // Use Promise.allSettled to ensure one missing icon doesn't break the whole SW
      return Promise.allSettled(ASSETS_TO_CACHE.map(url => cache.add(url)));
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
      clients.forEach(client => client.postMessage({ type: "SW_UPDATED", version: CACHE_NAME }));
    })
  );
});

// 3. FETCH: Stale-While-Revalidate for Assets, Network-Only for API
self.addEventListener("fetch", evt => {
  const url = new URL(evt.request.url);

  // RULE A: API Passthrough (Always Network)
  // We NEVER cache trailer state or dispatcher actions.
  if (evt.request.method !== "GET" || url.pathname.startsWith("/api/")) {
    return;
  }

  // RULE B: Stale-While-Revalidate for UI Assets
  // This makes the tablet load the UI "instantly" while updating in background.
  evt.respondWith(
    caches.match(evt.request).then(cachedRes => {
      const fetchPromise = fetch(evt.request).then(networkRes => {
        if (networkRes && networkRes.status === 200) {
          const cacheCopy = networkRes.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(evt.request, cacheCopy));
        }
        return networkRes;
      }).catch(() => {
        // Silently fail if offline, the cachedRes (if any) is already being returned
      });

      return cachedRes || fetchPromise;
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
    tag: data.tag || "wb-dispatch",
    renotify: true,
    vibrate: [200, 100, 200], // Stronger pulse for noisy dock environments
    data: data.data || {},
  };

  evt.waitUntil(
    self.registration.showNotification(data.title || "Wesbell Dispatch", options)
  );
});

// 5. NOTIFICATION CLICK: Smart Redirection
self.addEventListener("notificationclick", evt => {
  evt.notification.close();
  // Allow the push data to specify a path (e.g., /dock)
  const targetPath = evt.notification.data.url || "/";

  evt.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then(cs => {
      const existing = cs.find(c => new URL(c.url).pathname === targetPath);
      if (existing) return existing.focus();
      return clients.openWindow(targetPath);
    })
  );
});
