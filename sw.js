/* sw.js — service worker (push + basic cache) */

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open("wb-cache-v1").then((cache) =>
      cache.addAll(["/", "/index.html", "/style.css", "/app.js"])
    )
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  // network-first for API, cache-first for static
  if (req.url.includes("/api/")) return;
  event.respondWith(
    caches.match(req).then((cached) => cached || fetch(req))
  );
});

self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch {}
  const title = data.title || "Wesbell Dispatch";
  const options = {
    body: data.body || "Update available.",
    data: { url: data.url || "/" }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification?.data?.url || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const c of clients) {
        if ("focus" in c) {
          c.navigate(url);
          return c.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
