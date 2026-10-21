'use strict';
const VERSION = 'travel-expense-shell-v2';
const CACHE = `${VERSION}-static`;
const SHELL = [
  '/',
  '/index.html',
  '/styles.css',
  '/assets/main.js',
  '/assets/api.js',
  '/assets/auth.js',
  '/assets/app.js',
  '/assets/admin.js',
  '/assets/charts.js',
  '/assets/ledger.js',
  '/assets/footprint.js',
  '/assets/places-picker.js',
  '/assets/offline.js',
  '/assets/offline-ui.js',
  '/assets/html2canvas.min.js',
  '/manifest.webmanifest',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/maskable-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(SHELL);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key.startsWith('travel-expense-shell-') && key !== CACHE).map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || request.method !== 'GET') return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/share/')) return;

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        if (response && response.ok) {
          const cache = await caches.open(CACHE);
          cache.put('/index.html', response.clone());
        }
        return response;
      } catch (e) {
        return (await caches.match('/index.html')) || new Response('离线状态：应用外壳尚未缓存。请先联网打开一次。', {
          status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' }
        });
      }
    })());
    return;
  }

  if (url.pathname.startsWith('/assets/') || url.pathname === '/styles.css' || url.pathname.startsWith('/icons/')) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(request);
      const network = fetch(request).then(response => {
        if (response && response.ok) cache.put(request, response.clone());
        return response;
      }).catch(() => null);
      return cached || await network || new Response('', { status: 504 });
    })());
  }
});
