// sw.js — Wesbell Dispatch Service Worker
// Clears all caches and unregisters on load to force fresh assets

self.addEventListener("install", evt => {
  self.skipWaiting();
});

self.addEventListener("activate", evt => {
  evt.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.map(k => caches.delete(k))))
      .then(() => self.clients.claim())
      .then(() => {
        // Tell all clients to reload
        return self.clients.matchAll({ type: "window" }).then(clients => {
          clients.forEach(client => client.postMessage({ type: "SW_UPDATED" }));
        });
      })
  );
});

// Network-only — never serve from cache
self.addEventListener("fetch", evt => {
  const url = new URL(evt.request.url);
  if (evt.request.method !== "GET" || url.origin !== self.location.origin) return;
  // Let everything go straight to network
  evt.respondWith(fetch(evt.request));
});

// Keep push notifications working
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
