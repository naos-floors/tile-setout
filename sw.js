/* Offline cache for Naos Tile Set-out. Bump VERSION when files change. */
const VERSION = 'tso-v1.1.0';
const FILES = ['./', './index.html', './manifest.webmanifest', './css/app.css',
  './js/geometry.js', './js/store.js', './js/render.js', './js/ai.js', './js/pdf-export.js', './js/app.js',
  './vendor/polygon-clipping.umd.min.js', './vendor/jspdf.umd.min.js', './vendor/pdf.min.js', './vendor/pdf.worker.min.js',
  './icons/icon-180.png', './icons/icon-192.png', './icons/icon-512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(VERSION).then(c => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return; // API calls go straight to the network
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(hit => {
    const net = fetch(e.request).then(r => { if (r.ok) { const cp = r.clone(); caches.open(VERSION).then(c => c.put(e.request, cp)); } return r; }).catch(() => hit);
    return hit || net;
  }));
});
