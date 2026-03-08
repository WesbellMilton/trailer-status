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

  const show = () => self.registration.showNotification(data.title || "Wesbell Dispatch", {
    body: data.body || "",
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    tag: "wb-dispatch",
    renotify: true,
    data: data.data || {},
  });

  const pushTrailer = (data.data?.trailer || "").toUpperCase();

  // If no trailer in payload — always show (system/dispatch notification)
  if (!pushTrailer) { evt.waitUntil(show()); return; }

  evt.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(cs => {
      // Ask each open client whether this trailer belongs to it
      const checks = cs.map(client =>
        new Promise(resolve => {
          const ch = new MessageChannel();
          ch.port1.onmessage = e => resolve(e.data);
          // Timeout after 400ms — if no reply, assume non-driver (show it)
          setTimeout(() => resolve({ role: "unknown" }), 400);
          client.postMessage({ type: "PUSH_TRAILER_CHECK", trailer: pushTrailer }, [ch.port2]);
        })
      );
      return Promise.all(checks).then(replies => {
        // Show if: any client is not a driver (dispatch/dock/admin always see all)
        //      OR: any driver client claims this trailer
        const hasNonDriver  = replies.some(r => r.role && r.role !== "driver");
        const isMyTrailer   = replies.some(r => r.role === "driver" && r.trailer === pushTrailer);
        const noClients     = cs.length === 0;
        if (noClients || hasNonDriver || isMyTrailer) return show();
        // Driver is open but this isn't their trailer — suppress
      });
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

// ── Keep-Alive: ping server every 14 min to prevent Render free-tier spin-down ──
// Render spins down after 15 min of inactivity. 14 min pings keep it warm.
function keepAlive() {
  fetch('/api/ping', { method: 'GET', cache: 'no-store' }).catch(() => {});
}
setInterval(keepAlive, 14 * 60 * 1000);
keepAlive(); // ping immediately on SW install/activate
