// Carnet de tirs : fonctionne hors ligne. Change VERSION à chaque mise à jour des fichiers.
const VERSION = "carnet-tirs-v19";
const CORE = ["./", "./index.html", "./manifest.webmanifest", "./icon-192.png", "./icon-512.png", "./apple-touch-icon.png", "./jspdf.umd.min.js", "./supabase.min.js"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(CORE)));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))));
});
self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  if (new URL(req.url).origin !== self.location.origin && !/fonts\.(googleapis|gstatic)\.com/.test(req.url)) return;
  if (req.mode === "navigate") {
    // Page : réseau d'abord (pour les mises à jour), sinon la copie hors ligne
    e.respondWith(fetch(req,{cache:"no-store"}).then(r => { const copy = r.clone(); caches.open(VERSION).then(c => c.put("./index.html", copy)); return r; })
      .catch(() => caches.match("./index.html").then(r => r || caches.match("./"))));
    return;
  }
  // Autres fichiers (icônes, polices) : copie locale d'abord
  e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(r => {
    if (r && (r.ok || r.type === "opaque")) { const copy = r.clone(); caches.open(VERSION).then(c => c.put(req, copy)); }
    return r;
  })));
});
