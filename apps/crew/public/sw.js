/* global self, caches, fetch, URL */
const CACHE = 'euroteranga-crew-shell-v2';
const SHELL = ['/', '/connexion', '/session'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))),
      ),
  );
  self.clients.claim();
});

self.addEventListener('message', (event) => {
  if (event.data?.type !== 'CACHE_STATIC_ASSETS' || !Array.isArray(event.data.urls)) return;
  const allowed = event.data.urls.filter((value) => {
    try {
      const url = new URL(value);
      return url.origin === self.location.origin && url.pathname.startsWith('/_next/static/');
    } catch {
      return false;
    }
  });
  event.waitUntil(
    caches.open(CACHE).then(async (cache) => {
      await Promise.all(
        allowed.map(async (value) => {
          try {
            const response = await fetch(value, { credentials: 'same-origin' });
            if (response.ok) await cache.put(value, response);
          } catch {
            // Best-effort static cache warming only.
          }
        }),
      );
    }),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/v1/') || url.pathname.startsWith('/api/')) return;

  if (url.pathname.startsWith('/_next/static/') || url.pathname.endsWith('.svg')) {
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ||
          fetch(request).then((response) => {
            if (response.ok && response.type === 'basic') {
              const copy = response.clone();
              void caches.open(CACHE).then((cache) => cache.put(request, copy));
            }
            return response;
          }),
      ),
    );
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(async () => (await caches.match(request)) || (await caches.match('/'))),
    );
  }
});
