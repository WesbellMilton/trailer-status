// sw.js — DEPRECATED stub
// This service worker has been superseded by sw2.js.
// Any browser that previously registered sw.js will activate this stub,
// which immediately unregisters itself so sw2.js can take over cleanly.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", evt => {
  evt.waitUntil(
    self.registration.unregister()
      .then(() => self.clients.matchAll({ type: "window" }))
      .then(clients => clients.forEach(c => c.navigate(c.url)))
  );
});
