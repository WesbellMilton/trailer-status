// Wesbell Dispatch — Service Worker for Web Push
self.addEventListener("push", evt => {
  let data = {};
  try { data = evt.data.json(); } catch {}
  const title = data.title || "Wesbell Dispatch";
  const body  = data.body  || "Update on your trailer.";
  evt.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      tag: "wesbell-" + (data.data?.trailer || "notify"),
      renotify: true,
      data: data.data || {},
      actions: [{ action: "view", title: "Open Portal" }],
    })
  );
});

self.addEventListener("notificationclick", evt => {
  evt.notification.close();
  const url = "/driver";
  evt.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
      for (const c of list) {
        if (c.url.includes("/driver") && "focus" in c) return c.focus();
      }
      return clients.openWindow(url);
    })
  );
});
