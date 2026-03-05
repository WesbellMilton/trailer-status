// sw.js — Wesbell Dispatch Service Worker
const CACHE_NAME = "wesbell-v3.6.5"; // Increment this when you push updates
const ASSETS_TO_CACHE = [
  "/",
  "/index.html",
  "/style.css",
  "/app.js",
  "/manifest.json",
  "/icons/icon-192.png",
  "/icons/icon-512.png"
];

// 1. INSTALL: Cache the "App Shell" so the UI works offline
self.addEventListener("install", evt => {
  evt.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      console.log("SW: Caching App Shell Assets");
      return cache.addAll(ASSETS_TO_CACHE);
    })
  );
  self.skipWaiting();
});

// 2. ACTIVATE: Clean up old caches and force clients to reload
self.addEventListener("activate", evt => {
  evt.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
      );
    }).then(() => self.clients.claim())
  );
  
  // Notify app.js that a new version is ready to be used
  evt.waitUntil(
    self.clients.matchAll({ type: "window" }).then(clients => {
      clients.forEach(client => client.postMessage({ type: "SW_UPDATED" }));
    })
  );
});

// 3. FETCH: Network-First Strategy (with Cache Fallback)
self.addEventListener("fetch", evt => {
  const url = new URL(evt.request.url);

  // RULE 1: Skip non-GET requests (POST, PUT, DELETE)
  if (evt.request.method !== "GET" || url.origin !== self.location.origin) return;

  // RULE 2: ALWAYS go to network for API calls (Never cache trailer state)
  if (url.pathname.startsWith("/api/")) {
    return; // Browser handles this normally via network
  }

  // RULE 3: For App Assets (CSS, JS, HTML), try Network first, then Cache
  evt.respondWith(
    fetch(evt.request)
      .then(networkRes => {
        // If network is good, update cache with the fresh version
        return caches.open(CACHE_NAME).then(cache => {
          cache.put(evt.request, networkRes.clone());
          return networkRes;
        });
      })
      .catch(() => {
        // If network fails (Offline), serve from the cache
        return caches.match(evt.request);
      })
  );
});

// 4. PUSH: Handle Dispatch & Driver Notifications
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

// 5. NOTIFICATION CLICK: Focus existing window or open new one
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
