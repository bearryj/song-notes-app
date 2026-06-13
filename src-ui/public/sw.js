const CACHE_NAME = 'song-notes-v1';

const ASSETS_TO_CACHE = [
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
  './modules/metro.js'
];

// Install: cache core assets
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS_TO_CACHE))
  );
  self.skipWaiting();
});

// Activate: clean old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

// Fetch: network-first for data, cache-first for static assets
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Only handle same-origin requests
  if (url.origin !== self.location.origin) return;

  // Network-first for API calls and song data
  if (url.pathname.includes('/songs') || url.pathname.includes('/api')) {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // Cache-first for static assets
  event.respondWith(
    caches.match(event.request).then(cached => cached || fetch(event.request))
  );
});
