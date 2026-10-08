// FlashDesk service worker — versioned precache with fresh navigations.
// Static assets come from the current content-hashed cache. HTML navigations
// prefer the network so an installed PWA does not remain pinned to an old shell.

const CACHE = 'flashdesk-b81d4062c5';
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
  'usage-tracker.js',
  'backup.js',
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

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
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

  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      try {
        const response = await fetch(req, { cache: 'no-store' });
        if (response.ok) await cache.put(req, response.clone());
        return response;
      } catch {
        return (await cache.match(req, { ignoreSearch: true }))
          || (await cache.match('./index.html'))
          || (await cache.match('./'));
      }
    })());
    return;
  }

  event.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit;
      return fetch(req);
    })
  );
});
