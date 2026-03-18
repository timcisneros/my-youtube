// Service Worker — cache-first for static assets, segment caching for video proxy
var STATIC_CACHE = 'my-youtube-static-v4';
var SEGMENT_CACHE = 'my-youtube-segments-v3';
var IMAGE_CACHE = 'my-youtube-images-v1';
var MAX_SEGMENT_CACHE_SIZE = 200; // max cached segment responses
var MAX_IMAGE_CACHE_SIZE = 500; // max cached poster/thumb responses

var STATIC_ASSETS = [
  '/app.js',
  '/style.css',
  '/player-engine.js',
  '/fonts/roboto.css',
  '/fonts/roboto-latin.woff2',
  '/vendor/shaka/shaka-player.compiled.js'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(STATIC_CACHE).then(function (cache) {
      return cache.addAll(STATIC_ASSETS);
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      var keep = [STATIC_CACHE, SEGMENT_CACHE, IMAGE_CACHE];
      return Promise.all(
        keys.filter(function (k) { return keep.indexOf(k) === -1; })
            .map(function (k) { return caches.delete(k); })
      );
    })
  );
  self.clients.claim();
});

// Evict oldest entries when segment cache exceeds limit
function trimSegmentCache() {
  caches.open(SEGMENT_CACHE).then(function (cache) {
    cache.keys().then(function (keys) {
      if (keys.length > MAX_SEGMENT_CACHE_SIZE) {
        // Delete oldest entries (first in list)
        var toDelete = keys.length - MAX_SEGMENT_CACHE_SIZE;
        for (var i = 0; i < toDelete; i++) {
          cache.delete(keys[i]);
        }
      }
    });
  });
}

self.addEventListener('fetch', function (event) {
  var url = new URL(event.request.url);

  // Only handle same-origin
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/auth/')) return;

  // Poster/thumbnail images: cache-first (immutable per video)
  if (url.pathname.match(/^\/api\/stream\/[^/]+\/(poster|thumb)$/) || url.pathname.match(/^\/channel\/[^/]+\/avatar$/)) {
    event.respondWith(
      caches.open(IMAGE_CACHE).then(function (cache) {
        return cache.match(event.request).then(function (cached) {
          if (cached) return cached;
          return fetch(event.request).then(function (response) {
            if (response.ok) {
              cache.put(event.request, response.clone());
              // Trim image cache
              cache.keys().then(function (keys) {
                if (keys.length > MAX_IMAGE_CACHE_SIZE) {
                  for (var i = 0; i < keys.length - MAX_IMAGE_CACHE_SIZE; i++) cache.delete(keys[i]);
                }
              });
            }
            return response;
          });
        });
      })
    );
    return;
  }

  // Video segment proxy: cache successful 200/206 responses for re-watches
  // Match /api/stream/{videoId}/proxy/{itag} with range requests
  if (url.pathname.match(/^\/api\/stream\/[^/]+\/proxy\/\d+$/)) {
    // Build a cache key that includes the Range header so different byte ranges
    // are stored and matched separately (Cache API Vary support is unreliable)
    var range = event.request.headers.get('Range') || '';
    var cacheUrl = event.request.url + (range ? '?_r=' + encodeURIComponent(range) : '');
    var cacheKey = new Request(cacheUrl);
    event.respondWith(
      caches.open(SEGMENT_CACHE).then(function (cache) {
        return cache.match(cacheKey).then(function (cached) {
          if (cached) return cached;
          return fetch(event.request).then(function (response) {
            if (response.status === 200) {
              cache.put(cacheKey, response.clone());
              trimSegmentCache();
            }
            return response;
          });
        });
      })
    );
    return;
  }

  // Skip remaining API routes
  if (url.pathname.startsWith('/api/')) return;

  // Cache-first for known static assets and vendor files
  var isStatic = STATIC_ASSETS.indexOf(url.pathname) !== -1
    || url.pathname.startsWith('/vendor/');

  if (isStatic) {
    event.respondWith(
      caches.match(event.request).then(function (cached) {
        if (cached) {
          // Revalidate in background
          fetch(event.request).then(function (response) {
            if (response.ok) {
              caches.open(STATIC_CACHE).then(function (cache) {
                cache.put(event.request, response);
              });
            }
          }).catch(function () {});
          return cached;
        }
        return fetch(event.request).then(function (response) {
          if (response.ok) {
            var clone = response.clone();
            caches.open(STATIC_CACHE).then(function (cache) {
              cache.put(event.request, clone);
            });
          }
          return response;
        });
      })
    );
  }
});
