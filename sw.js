// sw.js — Wesbell Dispatch Service Worker
// Clears all caches and unregisters on load to force fresh assets
self.addEventListener("install",e=>{self.skipWaiting()});
self.addEventListener("activate",e=>{
  e.waitUntil(
    caches.keys()
      .then(k=>Promise.all(k.map(c=>caches.delete(c))))
      .then(()=>self.clients.claim())
      .then(()=>self.clients.matchAll({type:"window"}).then(cs=>cs.forEach(c=>c.postMessage({type:"SW_UPDATED"}))))
  );
});
self.addEventListener("fetch",e=>{
  const u=new URL(e.request.url);
  if(e.request.method!=="GET"||u.origin!==self.location.origin)return;
  e.respondWith(fetch(e.request));
});
self.addEventListener("push",e=>{
  if(!e.data)return;
  let d={};
  try{d=e.data.json()}catch{d={title:"Wesbell Dispatch",body:e.data.text()}}
  e.waitUntil(self.registration.showNotification(d.title||"Wesbell Dispatch",{
    body:d.body||"",icon:"/icons/icon-192.png",badge:"/icons/icon-192.png",
    tag:"wb-dispatch",renotify:true,data:d.data||{}
  }));
});
self.addEventListener("notificationclick",e=>{
  e.notification.close();
  e.waitUntil(
    clients.matchAll({type:"window",includeUncontrolled:true}).then(cs=>{
      const w=cs.find(c=>c.url.includes(self.location.origin));
      return w?w.focus():clients.openWindow("/");
    })
  );
});
