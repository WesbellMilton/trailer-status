// sw.js — Wesbell Dispatch Service Worker
const CACHE_NAME = "wesbell-v3.6.0";
const ASSETS_TO_CACHE = [
  "/",
  "/index.html",
  "/style.css",
  "/app.js",
  "/manifest.json",
  "/icons/icon-192.png"
];

// 1. Install Event: Cache essential assets immediately
self.addEventListener("install", evt => {
  evt.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      console.log("SW: Caching App Shell");
      return cache.addAll(ASSETS_TO_CACHE);
    })
  );
  self.skipWaiting();
});

// 2. Activate Event: Clean up old versions and force reload
self.addEventListener("activate", evt => {
  evt.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
      );
    }).then(() => self.clients.claim())
  );
  
  // Notify app.js that a new version is active
  evt.waitUntil(
    self.clients.matchAll({ type: "window" }).then(clients => {
      clients.forEach(client => client.postMessage({ type: "SW_UPDATED" }));
    })
  );
});

// 3. Fetch Event: Network-First with Cache-Fallback
self.addEventListener("fetch", evt => {
  const url = new URL(evt.request.url);

  // Skip non-GET requests and external URLs
  if (evt.request.method !== "GET" || url.origin !== self.location.origin) return;

  // For API calls, go strictly to network (never cache real-time data)
  if (url.pathname.startsWith("/api/")) {
    return; 
  }

  evt.respondWith(
    fetch(evt.request)
      .then(networkResponse => {
        // If network works, update the cache with the new version
        return caches.open(CACHE_NAME).then(cache => {
          cache.put(evt.request, networkResponse.clone());
          return networkResponse;
        });
      })
      .catch(() => {
        // If network fails (Offline), look for the file in cache
        return caches.match(evt.request);
      })
  );
});

// 4. Push Notifications: Handle incoming alerts
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
    actions: [
      { action: 'open', title: 'Open Dashboard' }
    ]
  };

  evt.waitUntil(
    self.registration.showNotification(data.title || "Wesbell Dispatch", options)
  );
});

// 5. Notification Interaction
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
