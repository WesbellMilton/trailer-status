const CACHE_NAME = "wesbell-v3.6.5";
const ASSETS = ["/", "/index.html", "/app.js", "/style.css", "/manifest.json"];

self.addEventListener("install", e => e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(ASSETS))));
self.addEventListener("activate", e => e.waitUntil(caches.keys().then(ks => Promise.all(ks.map(k => k !== CACHE_NAME && caches.delete(k))))));

self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});
