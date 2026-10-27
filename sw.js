const cache_name = 'reading-v13';
const assets = ['/', '/index.html', '/style.css', '/app.js', '/platform.js', '/telegram.js', '/icon.svg', '/icon-192.png', '/icon-512.png', '/manifest.webmanifest', '/sample.fb2'];
self.addEventListener('install', event => event.waitUntil(caches.open(cache_name).then(cache => cache.addAll(assets)).then(() => self.skipWaiting())));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  // Читаем только текущую версию: глобальный caches.match может вернуть старую оболочку.
  event.respondWith(fetch(event.request).catch(async () => {
    const cache = await caches.open(cache_name);
    return await cache.match(event.request) || (event.request.mode === 'navigate' ? await cache.match('/') : Response.error());
  }));
});
