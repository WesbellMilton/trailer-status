// sw.js — Wesbell Dispatch Service Worker v3.2.0

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", evt => evt.waitUntil(self.clients.claim()));

self.addEventListener("push", evt => {
  let data = {};
  try { data = evt.data.json(); } catch {}

  const title   = data.title || "Wesbell Dispatch";
  const body    = data.body  || "Update on your trailer.";
  const trailer = data.data?.trailer || "";

  evt.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon:      "/icon-192.png",
      badge:     "/icon-96.png",
      tag:       "wesbell-" + (trailer || "notify"),
      renotify:  true,
      vibrate:   [120, 60, 120],
      data:      data.data || {},
    })
  );
});

self.addEventListener("notificationclick", evt => {
  evt.notification.close();
  evt.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
      const driverTab = list.find(c => new URL(c.url).pathname.startsWith("/driver"));
      if (driverTab && "focus" in driverTab) return driverTab.focus();
      return clients.openWindow("/driver");
    })
  );
});
