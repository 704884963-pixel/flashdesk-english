// FlashDesk service worker — cache-first over a versioned precache.
// Every asset is precached and the cache name is a content hash stamped by
// build.js, so "cache-first" can never serve a stale mix of assets.

const CACHE = 'flashdesk-4139f08713';
const ASSETS = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'audio-cache.js',
  'batch-import.js',
  'article-utils.js',
  'article-store.js',
  'ai-learning.js',
  'logic.js',
  'store.js',
  'default-data.json',
  'manifest.webmanifest',
  'icon-180.png',
  'icon-192.png',
  'icon-512.png',
  'fonts/bricolage.woff2',
  'fonts/public-sans.woff2',
  'fonts/spline-mono.woff2',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k.startsWith('flashdesk-') && k !== CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => {
      if (hit) return hit;
      return fetch(req).catch(() => {
        if (req.mode === 'navigate') return caches.match('./index.html');
        throw new Error('offline and not cached');
      });
    })
  );
});
