const CACHE_NAME = 'song-notes-v1';
const ASSETS = [
  './',
  './index.html',
  './app.js',
  './css/base.css',
  './css/views.css',
  './css/editor.css',
  './css/gallery.css',
  './css/theme.css',
  './css/setlist.css',
  './css/share.css',
  './css/plugins.css',
  './css/metronome.css',
  './css/stats.css',
  './css/tags.css',
  './css/picker.css',
  './css/extras.css',
  './manifest.json',
  './icon-192.svg'
];

// Install: cache all static assets
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

// Activate: clean up old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(key => key !== CACHE_NAME)
            .map(key => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

// Fetch: network-first for API calls, cache-first for static assets
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle same-origin requests
  if (url.origin !== self.location.origin) return;

  // Network-first strategy (user data, dynamic content)
  if (url.pathname.includes('/api/') || request.method !== 'GET') {
    event.respondWith(networkFirst(request));
    return;
  }

  // Cache-first strategy (static assets)
  event.respondWith(cacheFirst(request));
});

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    // Fallback to index.html for navigation requests (SPA)
    if (request.mode === 'navigate') {
      return caches.match('./index.html');
    }
    return new Response('Offline', { status: 503, statusText: 'Offline' });
  }
}

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    return cached || new Response('Offline', { status: 503, statusText: 'Offline' });
  }
}
