// RUNTIME_ASSET_URLS_START
var RUNTIME_ASSET_URLS = {"idbHelpers":"/idb-helpers.js?v=f509fbe85d8f0f5d","app":"/app.js?v=5edeb2d1c7587568","style":"/style.css?v=62271afa29cabc1c","nativePlayer":"/native-player-engine.min.js?v=37d6fa388cca6b61","playerTelemetry":"/player-telemetry.min.js?v=38f6d2ea55cc9638","playerPage":"/player-page.min.js?v=3810de4333900e54","revision":"d4da007e480dd675"};
// RUNTIME_ASSET_URLS_END
importScripts(RUNTIME_ASSET_URLS.idbHelpers);
// Service Worker — cache-first for static assets, segment caching for video proxy
var STATIC_CACHE = 'my-youtube-static-' + RUNTIME_ASSET_URLS.revision;
var SEGMENT_CACHE = 'my-youtube-segments-v7';
var IMAGE_CACHE = 'my-youtube-images-v1';
var RUNTIME_CACHE = 'my-youtube-runtime-v2';
var OFFLINE_CACHE = 'my-youtube-offline-v1';
var MAX_SEGMENT_CACHE_SIZE = 200; // max cached segment responses
var MAX_SEGMENT_CACHE_BYTES = 256 * 1024 * 1024;
var MAX_CACHEABLE_MEDIA_OBJECT_BYTES = 8 * 1024 * 1024;
var MAX_CACHEABLE_PLAYLIST_BYTES = 2 * 1024 * 1024;
var MAX_IMAGE_CACHE_SIZE = 500; // max cached poster/thumb responses
var MAX_RUNTIME_CACHE_SIZE = 100;
var segmentPutsSinceTrim = 0;
var segmentBytesSinceTrim = 0;
var segmentCacheLedger = null;
var segmentCacheLedgerPromise = null;
var imagePutsSinceTrim = 0;
var offlineFormatMetaCache = new Map();
var offlineFormatMetaInflight = new Map();
var MAX_OFFLINE_FORMAT_META_CACHE_SIZE = 256;
var OFFLINE_FORMAT_META_TTL_MS = 5 * 60 * 1000;
var OFFLINE_FORMAT_META_NEGATIVE_TTL_MS = 30 * 1000;
var MAX_OFFLINE_RANGE_BYTES = 16 * 1024 * 1024;

function cacheOfflineFormatMeta(formatKey, meta) {
  offlineFormatMetaCache.delete(formatKey);
  offlineFormatMetaCache.set(formatKey, {
    meta: meta || null,
    expiresAt: Date.now() + (meta ? OFFLINE_FORMAT_META_TTL_MS : OFFLINE_FORMAT_META_NEGATIVE_TTL_MS)
  });
  while (offlineFormatMetaCache.size > MAX_OFFLINE_FORMAT_META_CACHE_SIZE) {
    offlineFormatMetaCache.delete(offlineFormatMetaCache.keys().next().value);
  }
  return meta || null;
}

function invalidateOfflineFormatMeta(prefix) {
  offlineFormatMetaCache.forEach(function (_entry, key) {
    if (key.indexOf(prefix) === 0) offlineFormatMetaCache.delete(key);
  });
}

function getOfflineFormatMeta(formatKey) {
  var cached = offlineFormatMetaCache.get(formatKey);
  if (cached && cached.expiresAt > Date.now()) {
    offlineFormatMetaCache.delete(formatKey);
    offlineFormatMetaCache.set(formatKey, cached);
    return Promise.resolve(cached.meta);
  }
  offlineFormatMetaCache.delete(formatKey);
  if (offlineFormatMetaInflight.has(formatKey)) return offlineFormatMetaInflight.get(formatKey);
  if (typeof IDBHelpers === 'undefined' || !IDBHelpers.getMeta) return Promise.resolve(null);
  var lookup = IDBHelpers.getMeta(formatKey)
    .then(function (meta) { return cacheOfflineFormatMeta(formatKey, meta); })
    .catch(function () { return cacheOfflineFormatMeta(formatKey, null); })
    .then(function (meta) {
      offlineFormatMetaInflight.delete(formatKey);
      return meta;
    }, function (error) {
      offlineFormatMetaInflight.delete(formatKey);
      throw error;
    });
  offlineFormatMetaInflight.set(formatKey, lookup);
  return lookup;
}

var STATIC_ASSETS = [
  RUNTIME_ASSET_URLS.idbHelpers,
  RUNTIME_ASSET_URLS.app,
  RUNTIME_ASSET_URLS.style,
  '/fonts/roboto.css',
  '/fonts/roboto-latin.woff2',
  '/manifest.json',
  '/favicon.svg'
];
var VERSIONED_RUNTIME_ASSETS = [
  RUNTIME_ASSET_URLS.idbHelpers,
  RUNTIME_ASSET_URLS.app,
  RUNTIME_ASSET_URLS.style,
  RUNTIME_ASSET_URLS.nativePlayer,
  RUNTIME_ASSET_URLS.playerTelemetry,
  RUNTIME_ASSET_URLS.playerPage
];
var STATIC_PATHS = [
  '/idb-helpers.js',
  '/app.js',
  '/native-player-engine.js',
  '/native-player-engine.min.js',
  '/player-telemetry.js',
  '/player-telemetry.min.js',
  '/player-page.js',
  '/player-page.min.js',
  '/style.css',
  '/fonts/roboto.css',
  '/fonts/roboto-latin.woff2',
  '/manifest.json',
  '/favicon.svg'
];

// Strip auth token from URL so cached content is token-agnostic.
// This way segments/MPDs cached during online play are found during offline play
// regardless of which token (or no token) the player uses.
function stripToken(urlStr) {
  try {
    var url = new URL(urlStr, self.location.origin);
    url.searchParams.delete('token');
    return url.href;
  } catch (e) {
    return urlStr.replace(/[?&]token=[^&]*/g, '').replace(/\?$/, '');
  }
}

function cacheKeyWithRange(request) {
  var range = request.headers.get('Range') || '';
  var baseUrl = stripToken(request.url);
  var cacheUrl = baseUrl + (range ? (baseUrl.indexOf('?') === -1 ? '?' : '&') + '_r=' + encodeURIComponent(range) : '');
  return new Request(cacheUrl);
}

function requestRequiresRevalidation(request) {
  if (!request) return false;
  var directive = request.headers && request.headers.get
    ? String(request.headers.get('Cache-Control') || '').toLowerCase()
    : '';
  return request.cache === 'reload'
    || request.cache === 'no-store'
    || /(?:^|,)\s*(?:no-cache|no-store|max-age=0)\s*(?:,|$)/.test(directive);
}

function withSourceHeaders(response, source, offline) {
  var headers = new Headers(response.headers);
  headers.set('X-SW-Cached', '1');
  headers.set('X-SW-Cache', '1');
  headers.set('X-SW-Source', source);
  if (offline) headers.set('X-SW-Offline', '1');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: headers
  });
}

// Synthetic 503 for network-unreachable cache misses. X-SW-Offline is only stamped
// when the browser itself is offline — when the server is down but the browser is
// online, the player must see a plain server error so its network-hold/probe
// recovery engages (an X-SW-Offline stamp would veto the hold and stall playback).
function networkMissResponse() {
  // Do not claim the browser is offline unless the worker can positively observe it.
  // Older worker implementations may not expose Navigator.onLine.
  var offline = !!(self.navigator && 'onLine' in self.navigator && self.navigator.onLine === false);
  var headers = {
    'X-SW-Cached': '0',
    'X-SW-Source': 'miss'
  };
  if (offline) headers['X-SW-Offline'] = '1';
  return new Response('', { status: 503, headers: headers });
}

function responseBytes(response) {
  var markedHeader = response && response.headers && response.headers.get('X-SW-Cache-Bytes');
  if (markedHeader !== null && markedHeader !== '') {
    var marked = Number(markedHeader);
    if (Number.isFinite(marked) && marked >= 0) return marked;
  }
  var declaredHeader = response && response.headers && response.headers.get('Content-Length');
  if (declaredHeader !== null && declaredHeader !== '') {
    var declared = Number(declaredHeader);
    if (Number.isFinite(declared) && declared >= 0) return declared;
  }
  return -1;
}

function loadSegmentCacheLedger(cache) {
  if (segmentCacheLedger) return Promise.resolve(segmentCacheLedger);
  if (segmentCacheLedgerPromise) return segmentCacheLedgerPromise;
  segmentCacheLedgerPromise = cache.keys().then(function (keys) {
    return Promise.all(keys.map(function (key) {
      return cache.match(key).then(function (response) {
        return { key: key, url: key.url, bytes: responseBytes(response) };
      });
    }));
  }).then(function (entries) {
    segmentCacheLedger = entries;
    return entries;
  }).catch(function (error) {
    segmentCacheLedgerPromise = null;
    throw error;
  });
  return segmentCacheLedgerPromise;
}

function recordSegmentCacheWrite(cache, cacheKey, response) {
  return loadSegmentCacheLedger(cache).then(function (entries) {
    var url = cacheKey.url || String(cacheKey);
    for (var i = entries.length - 1; i >= 0; i--) {
      if (entries[i].url === url) entries.splice(i, 1);
    }
    entries.push({ key: cacheKey, url: url, bytes: responseBytes(response) });
  });
}

function readResponseBufferBounded(response, maxBytes) {
  var declared = responseBytes(response);
  if (declared > maxBytes) return Promise.resolve(null);
  if (!response.body || !response.body.getReader) return Promise.resolve(null);
  var reader = response.body.getReader();
  var chunks = [];
  var total = 0;
  function readNext() {
    return reader.read().then(function (result) {
      if (result.done) {
        var combined = new Uint8Array(total);
        var offset = 0;
        chunks.forEach(function (chunk) {
          combined.set(chunk, offset);
          offset += chunk.byteLength;
        });
        return combined.buffer;
      }
      total += result.value.byteLength;
      if (total > maxBytes) {
        // Do not await cancellation of a cloned/teed body: its sibling is the
        // response being returned to the player and may still be consuming.
        reader.cancel('service-worker-media-object-too-large').catch(function () {});
        return null;
      }
      chunks.push(result.value);
      return readNext();
    });
  }
  return readNext();
}

function putBoundedMediaResponse(cache, cacheKey, response) {
  if (response.status === 206) {
    if (responseBytes(response) > MAX_CACHEABLE_MEDIA_OBJECT_BYTES) return Promise.resolve(false);
    return readResponseBufferBounded(response.clone(), MAX_CACHEABLE_MEDIA_OBJECT_BYTES).then(function (buf) {
      if (!buf) return false;
      var headers = new Headers(response.headers);
      headers.delete('Content-Range');
      headers.set('Content-Length', String(buf.byteLength));
      headers.set('X-SW-Cache-Bytes', String(buf.byteLength));
      return cache.put(cacheKey, new Response(buf, {
        status: 200,
        headers: headers
      })).then(function () { return true; });
    });
  }
  var bytes = responseBytes(response);
  if (!response.ok || bytes < 0 || bytes > MAX_CACHEABLE_MEDIA_OBJECT_BYTES) return Promise.resolve(false);
  var clone = response.clone();
  var headers = new Headers(clone.headers);
  headers.set('X-SW-Cache-Bytes', String(bytes));
  return cache.put(cacheKey, new Response(clone.body, {
    status: clone.status,
    statusText: clone.statusText,
    headers: headers
  })).then(function () { return true; });
}

function stampPlaylistBodyToken(body, requestUrl) {
  var token = '';
  try { token = new URL(requestUrl).searchParams.get('token') || ''; } catch (e) {}
  if (!token) return body;
  return body.replace(/\/api\/stream\/[^\s"]+/g, function (value) {
    try {
      var url = new URL(value, self.location.origin);
      url.searchParams.set('token', token);
      return url.pathname + url.search + url.hash;
    } catch (e) {
      return value;
    }
  });
}

function cachedHlsPlaylistResponse(response, requestUrl) {
  return response.text().then(function (body) {
    var headers = new Headers(response.headers);
    headers.set('X-SW-Cached', '1');
    headers.set('X-SW-Cache', '1');
    headers.set('X-SW-Source', 'hls-playlist-cache');
    var offline = !!(self.navigator && 'onLine' in self.navigator && self.navigator.onLine === false);
    if (offline) headers.set('X-SW-Offline', '1');
    return new Response(stampPlaylistBodyToken(body, requestUrl), {
      status: response.status,
      statusText: response.statusText,
      headers: headers
    });
  });
}

self.addEventListener('install', function (event) {
  event.waitUntil(
    Promise.all([
      caches.open(STATIC_CACHE).then(function (cache) {
        return cache.addAll(STATIC_ASSETS);
      }),
      caches.open(RUNTIME_CACHE).then(function (cache) {
        return cache.add('/offline');
      })
    ])
  );
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      var keep = [STATIC_CACHE, SEGMENT_CACHE, IMAGE_CACHE, RUNTIME_CACHE, OFFLINE_CACHE];
      return Promise.all(
        keys.filter(function (k) { return keep.indexOf(k) === -1; })
            .map(function (k) { return caches.delete(k); })
      );
    })
  );
  self.clients.claim();
});

// Handle messages from the client
self.addEventListener('message', function (event) {
  if (!event.data) return;

  // Delete offline video data from IDB + caches
  if (event.data.type === 'delete-offline-video') {
    var delVideoId = event.data.videoId;
    if (!delVideoId) return;
    var idbDelete = typeof IDBHelpers !== 'undefined'
      ? IDBHelpers.deleteAllForVideo(delVideoId)
      : Promise.resolve();
    invalidateOfflineFormatMeta(delVideoId + ':');
    idbDelete = idbDelete.then(function (result) {
      invalidateOfflineFormatMeta(delVideoId + ':');
      return result;
    });
    var delWatchUrl = self.location.origin + '/watch?v=' + delVideoId;
    var delMpdUrl = self.location.origin + '/api/stream/' + delVideoId + '/dash.mpd';
    event.waitUntil(Promise.all([
      idbDelete,
      caches.open(OFFLINE_CACHE).then(function (cache) {
        return Promise.all([
          cache.delete(new Request(delWatchUrl)),
          cache.delete(new Request(delMpdUrl)),
          cache.delete(new Request(self.location.origin + '/api/stream/' + delVideoId + '/poster'))
        ]);
      }),
      caches.open(RUNTIME_CACHE).then(function (cache) {
        return Promise.all([
          cache.delete(new Request(delWatchUrl)),
          cache.delete(new Request(delMpdUrl))
        ]);
      })
    ]));
    return;
  }

  if (event.data.type !== 'cache-offline-bundle') return;
  var bundle = event.data.bundle;
  if (!bundle || !bundle.videoId) return;
  (bundle.formats || []).forEach(function (formatId) {
    invalidateOfflineFormatMeta(bundle.videoId + ':' + formatId);
  });
  var bundleTask = Promise.resolve().then(function () {

    var watchPageHtml = buildOfflineWatchPage(bundle);
    var watchUrl = self.location.origin + '/watch?v=' + bundle.videoId;
    var mpdUrl = self.location.origin + '/api/stream/' + bundle.videoId + '/dash.mpd';
    var posterUrl = self.location.origin + '/api/stream/' + bundle.videoId + '/poster';

    return caches.open(OFFLINE_CACHE).then(function (cache) {
      var writes = [cache.put(new Request(watchUrl), new Response(watchPageHtml, {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      }))];
      if (bundle.mpd) {
        writes.push(cache.put(new Request(mpdUrl), new Response(bundle.mpd, {
          status: 200,
          headers: {
            'Content-Type': 'application/dash+xml',
            'X-SW-Cached': '1',
            'X-SW-Cache': '1',
            'X-SW-Source': 'offline-bundle',
            'X-SW-Offline': '1'
          }
        })));
      }
      writes.push(fetch(posterUrl).then(function (resp) {
        return resp.ok ? cache.put(new Request(posterUrl), resp) : undefined;
      }).catch(function () {}));
      return Promise.all(writes);
    });
  });
  event.waitUntil(bundleTask.then(function () {
    if (event.ports && event.ports[0]) event.ports[0].postMessage({ ok: true });
  }).catch(function (error) {
    if (event.ports && event.ports[0]) event.ports[0].postMessage({ ok: false, error: String(error && error.message || error) });
    throw error;
  }));
});

function buildOfflineWatchPage(bundle) {
  var title = (bundle.title || 'Video').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  var channelTitle = (bundle.channelTitle || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return '<!DOCTYPE html>\n'
    + '<html lang="en">\n'
    + '<head>\n'
    + '  <meta charset="utf-8">\n'
    + '  <meta name="viewport" content="width=device-width, initial-scale=1">\n'
    + '  <title>' + title + '</title>\n'
    + '  <link rel="stylesheet" href="' + RUNTIME_ASSET_URLS.style + '">\n'
    + '  <link rel="manifest" href="/manifest.json">\n'
    + '  <link rel="icon" href="/favicon.svg" type="image/svg+xml">\n'
    + '</head>\n'
    + '<body>\n'
    + '<nav class="main-nav">\n'
    + '  <div class="nav-left">\n'
    + '    <a href="/" class="nav-logo">my-youtube</a>\n'
    + '    <a href="/">Today</a>\n'
    + '    <a href="/explore">Explore</a>\n'
    + '    <a href="/subscriptions">Subscriptions</a>\n'
    + '    <a href="/downloads">Downloads</a>\n'
    + '    <a href="/queue">Queue</a>\n'
    + '  </div>\n'
    + '  <div class="nav-right"><div class="nav-status"></div></div>\n'
    + '</nav>\n'
    + '<main class="player-page">\n'
    + '  <div id="player-container" class="player-container">\n'
    + '    <video id="player" poster="/api/stream/' + bundle.videoId + '/poster"></video>\n'
    + '  </div>\n'
    + '  <div class="video-info-section">\n'
    + '    <h1 class="video-title">' + title + '</h1>\n'
    + '    <div class="video-channel">' + channelTitle + '</div>\n'
    + '  </div>\n'
    + '</main>\n'
    + '<script src="' + RUNTIME_ASSET_URLS.playerTelemetry + '"><\/script>\n'
    + '<script src="' + RUNTIME_ASSET_URLS.nativePlayer + '"><\/script>\n'
    + '<script src="' + RUNTIME_ASSET_URLS.idbHelpers + '"><\/script>\n'
    + '<script src="' + RUNTIME_ASSET_URLS.app + '"><\/script>\n'
    + '<script>\n'
    + '(function() {\n'
    + '  var container = document.getElementById("player-container");\n'
    + '  var video = document.getElementById("player");\n'
    + '  if (!container || !video || !window.PlayerEngine) return;\n'
    + '  var engine = new PlayerEngine(video, { videoId: "' + bundle.videoId + '", streamToken: "' + bundle.streamToken + '" });\n'
    + '  window._playerEngine = engine;\n'
    + '  window._player = engine.getPlayer();\n'
    + '  engine.init().then(function () { return engine.load(); }).catch(function (err) { console.error("[player-engine] offline load failed:", err); });\n'
    + '})();\n'
    + '<\/script>\n'
    + '</body>\n'
    + '</html>';
}

// Evict oldest entries until both the entry and persisted-byte budgets hold.
// Every v7 media write carries a trusted X-SW-Cache-Bytes marker; legacy or
// unknown-size responses are removed instead of silently escaping the budget.
function trimSegmentCache() {
  return caches.open(SEGMENT_CACHE).then(function (cache) {
    return Promise.all([
      loadSegmentCacheLedger(cache),
      self.navigator && self.navigator.storage && self.navigator.storage.estimate
        ? self.navigator.storage.estimate().catch(function () { return null; })
        : Promise.resolve(null)
    ]).then(function (values) {
      var entries = values[0];
      var estimate = values[1];
      var quotaPressure = estimate && estimate.quota > 0 && estimate.usage / estimate.quota > 0.8;
      var totalBytes = 0;
      entries.forEach(function (entry) {
        if (entry.bytes >= 0) totalBytes += entry.bytes;
      });
      var targetCount = quotaPressure ? Math.floor(MAX_SEGMENT_CACHE_SIZE * 0.75) : MAX_SEGMENT_CACHE_SIZE;
      var targetBytes = quotaPressure ? Math.floor(MAX_SEGMENT_CACHE_BYTES * 0.75) : MAX_SEGMENT_CACHE_BYTES;
      var deletes = [];
      var deleteCount = 0;
      var retained = [];
      for (var i = 0; i < entries.length; i++) {
        var entry = entries[i];
        var remainingCount = entries.length - deleteCount;
        if (entry.bytes < 0 || remainingCount > targetCount || totalBytes > targetBytes) {
          deletes.push(cache.delete(entry.key));
          deleteCount++;
          if (entry.bytes > 0) totalBytes -= entry.bytes;
        } else {
          retained.push(entry);
        }
      }
      if (deleteCount > 0) {
        entries.splice(0, entries.length);
        Array.prototype.push.apply(entries, retained);
      }
      segmentBytesSinceTrim = 0;
      return Promise.all(deletes);
    });
  });
}

function maybeTrimSegmentCache(cache, cacheKey, response) {
  segmentPutsSinceTrim++;
  var contentLength = response && Number(response.headers && response.headers.get('Content-Length'));
  if (contentLength > 0) segmentBytesSinceTrim += contentLength;
  var overByteBudget = segmentBytesSinceTrim >= MAX_SEGMENT_CACHE_BYTES;
  recordSegmentCacheWrite(cache, cacheKey, response).then(function () {
    if (segmentPutsSinceTrim < 20 && !overByteBudget) return;
    segmentPutsSinceTrim = 0;
    return trimSegmentCache();
  }).catch(function () {});
}

function trimRuntimeCache(cache) {
  return cache.keys().then(function (keys) {
    var removable = keys.filter(function (key) {
      var path = new URL(key.url).pathname;
      return path !== '/offline' && path !== '/downloads';
    });
    var excess = Math.max(0, keys.length - MAX_RUNTIME_CACHE_SIZE);
    return Promise.all(removable.slice(0, excess).map(function (key) { return cache.delete(key); }));
  });
}

function maybeTrimImageCache(cache) {
  imagePutsSinceTrim++;
  if (imagePutsSinceTrim < 25) return;
  imagePutsSinceTrim = 0;
  cache.keys().then(function (keys) {
    if (keys.length > MAX_IMAGE_CACHE_SIZE) {
      for (var i = 0; i < keys.length - MAX_IMAGE_CACHE_SIZE; i++) cache.delete(keys[i]);
    }
  });
}

// Check if a request is a navigation (HTML page request)
function isNavigationRequest(request) {
  if (request.mode === 'navigate') return true;
  var accept = request.headers.get('Accept') || '';
  return accept.indexOf('text/html') !== -1 && request.method === 'GET';
}

// Check if a URL is an offline-capable page (downloads or watch)
function isOfflineCapablePage(url) {
  return url.pathname === '/downloads' || (url.pathname === '/watch' && url.search.indexOf('v=') !== -1);
}

self.addEventListener('fetch', function (event) {
  var url = new URL(event.request.url);

  // Only handle same-origin
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/auth/')) return;

  // Navigation requests: network-first with offline fallback
  if (isNavigationRequest(event.request)) {
    event.respondWith(
      fetch(event.request).then(function (response) {
        if (response.ok && (isOfflineCapablePage(url) || url.pathname === '/offline')) {
          var clone = response.clone();
          caches.open(RUNTIME_CACHE).then(function (cache) {
            cache.put(event.request, clone).then(function () { return trimRuntimeCache(cache); });
          });
        }
        return response;
      }).catch(function () {
        return caches.open(OFFLINE_CACHE).then(function (offlineCache) {
          return offlineCache.match(event.request).then(function (durable) {
            if (durable) return durable;
            return caches.open(RUNTIME_CACHE).then(function (cache) {
              return cache.match(event.request).then(function (cached) {
            if (cached) return cached;
            // Serving /offline as fallback — mark with header so client can detect
            return cache.match('/offline').then(function (offlinePage) {
              if (!offlinePage) {
                return new Response('<h1>Offline</h1>', {
                  status: 503,
                  headers: { 'Content-Type': 'text/html' }
                });
              }
              return offlinePage.text().then(function (body) {
                return new Response(body, {
                  status: 200,
                  headers: {
                    'Content-Type': 'text/html; charset=utf-8',
                    'X-SW-Fallback': '1'
                  }
                });
              });
            });
              });
            });
          });
        });
      })
    );
    return;
  }

  // DASH MPD manifests: network-first with cache fallback
  // Cache by pathname only (strip token) so offline playback works
  if (url.pathname.match(/^\/api\/stream\/[^/]+\/dash\.mpd$/)) {
    var mpdCacheKey = new Request(url.origin + url.pathname);
    event.respondWith(
      fetch(event.request).then(function (response) {
        if (response.ok) {
          var clone = response.clone();
          caches.open(RUNTIME_CACHE).then(function (cache) {
            cache.put(mpdCacheKey, clone).then(function () { return trimRuntimeCache(cache); });
          });
        }
        return response;
      }).catch(function () {
        return caches.open(OFFLINE_CACHE).then(function (offlineCache) {
          return offlineCache.match(mpdCacheKey).then(function (durable) {
            if (durable) return withSourceHeaders(durable, 'offline-bundle', true);
            return caches.open(RUNTIME_CACHE).then(function (cache) {
              return cache.match(mpdCacheKey).then(function (cached) {
            if (!cached) return new Response('', { status: 503 });
            var online = self.navigator && 'onLine' in self.navigator ? self.navigator.onLine : false;
                return withSourceHeaders(cached, 'runtime', !online);
              });
            });
          });
        });
      })
    );
    return;
  }

  // HLS playlists: network-first with cache fallback, matching DASH MPD behavior.
  if (url.pathname.match(/^\/api\/stream\/[^/]+\/hls\.m3u8$/) || url.pathname.match(/^\/api\/stream\/[^/]+\/hls\/[^/]+\.m3u8$/)) {
    var hlsPlaylistCacheKey = new Request(stripToken(event.request.url));
    event.respondWith(
      caches.open(RUNTIME_CACHE).then(function (cache) {
        return fetch(event.request).then(function (response) {
          if (response.ok) cache.put(hlsPlaylistCacheKey, response.clone()).then(function () { return trimRuntimeCache(cache); });
          return response;
        }).catch(function () {
          return cache.match(hlsPlaylistCacheKey).then(function (cached) {
            if (!cached) return networkMissResponse();
            var online = self.navigator && 'onLine' in self.navigator ? self.navigator.onLine : false;
            return withSourceHeaders(cached, 'runtime', !online);
          });
        });
      })
    );
    return;
  }

  // Poster/thumbnail images: cache-first (immutable per video)
  if (url.pathname.match(/^\/api\/stream\/[^/]+\/(poster|thumb)$/) || url.pathname.match(/^\/channel\/[^/]+\/avatar$/)) {
    event.respondWith(
      caches.open(OFFLINE_CACHE).then(function (offlineCache) {
        return offlineCache.match(event.request).then(function (durable) {
          if (durable) return durable;
          return caches.open(IMAGE_CACHE).then(function (cache) {
            return cache.match(event.request).then(function (cached) {
          if (cached) return cached;
          return fetch(event.request).then(function (response) {
            if (response.ok) {
              cache.put(event.request, response.clone());
              maybeTrimImageCache(cache);
            }
            return response;
          }).catch(function () {
            return new Response('', { status: 503 });
          });
            });
          });
        });
      })
    );
    return;
  }

  // HLS proxied sub-manifests and fMP4 segments. Cache by token-stripped URL plus Range,
  // since HLS byte-range media requests share one object URL across many segments.
  if (url.pathname.match(/^\/api\/stream\/[^/]+\/hls-proxy$/)) {
    var hlsProxyCacheKey = cacheKeyWithRange(event.request);
    // Playlist URLs are marked by the server-side manifest rewriter. Keep them
    // network-first so live windows always advance. Only finalized VOD
    // playlists are retained as an offline fallback; media segments and keys
    // continue through the cache-first branch below.
    if (url.searchParams.get('kind') === 'playlist') {
      event.respondWith(
        caches.open(SEGMENT_CACHE).then(function (cache) {
          return fetch(event.request).then(function (response) {
            if (!response.ok) return response;
            return readResponseBufferBounded(response.clone(), MAX_CACHEABLE_PLAYLIST_BYTES).then(function (buffer) {
              if (!buffer) return response;
              var body = new TextDecoder().decode(buffer);
              if (body.indexOf('#EXT-X-ENDLIST') !== -1) {
                var headers = new Headers(response.headers);
                var playlistBytes = new TextEncoder().encode(body).byteLength;
                headers.set('Content-Length', String(playlistBytes));
                headers.set('X-SW-Cache-Bytes', String(playlistBytes));
                cache.put(hlsProxyCacheKey, new Response(body, {
                  status: response.status,
                  statusText: response.statusText,
                  headers: headers
                })).then(function () { maybeTrimSegmentCache(cache, hlsProxyCacheKey, response); }).catch(function () {});
              } else {
                cache.delete(hlsProxyCacheKey).catch(function () {});
              }
              return response;
            }, function () { return response; });
          }).catch(function () {
            return cache.match(hlsProxyCacheKey).then(function (cached) {
              return cached ? cachedHlsPlaylistResponse(cached, event.request.url) : networkMissResponse();
            });
          });
        })
      );
      return;
    }
    if (requestRequiresRevalidation(event.request)) {
      event.respondWith(
        caches.open(SEGMENT_CACHE).then(function (cache) {
          return fetch(event.request).then(function (response) {
            if (response.ok || response.status === 206) {
              putBoundedMediaResponse(cache, hlsProxyCacheKey, response).then(function (stored) {
                if (stored) maybeTrimSegmentCache(cache, hlsProxyCacheKey, response);
              }).catch(function () {});
            }
            return response;
          }).catch(function () {
            return cache.match(hlsProxyCacheKey).then(function (cached) {
              return cached ? withSourceHeaders(cached, 'segment-cache', true) : networkMissResponse();
            });
          });
        })
      );
      return;
    }
    event.respondWith(
      caches.open(SEGMENT_CACHE).then(function (cache) {
        return cache.match(hlsProxyCacheKey).then(function (cached) {
          if (cached) return withSourceHeaders(cached, 'segment-cache', false);
          return fetch(event.request).then(function (response) {
            if (response.ok || response.status === 206) {
              putBoundedMediaResponse(cache, hlsProxyCacheKey, response).then(function (stored) {
                if (stored) maybeTrimSegmentCache(cache, hlsProxyCacheKey, response);
              }).catch(function () {});
            }
            return response;
          }).catch(function () {
            return cache.match(hlsProxyCacheKey).then(function (retry) {
              return retry ? withSourceHeaders(retry, 'segment-cache', true) : networkMissResponse();
            });
          });
        });
      })
    );
    return;
  }

  // Video segment proxy: cache successful 200 responses for re-watches
  // Match /api/stream/{videoId}/proxy/{itag} with range requests
  // Cache keys strip the auth token so segments work offline with any/no token
  if (url.pathname.match(/^\/api\/stream\/[^/]+\/proxy\/\d+$/)) {
    var cacheKey = cacheKeyWithRange(event.request);
    event.respondWith(
      caches.open(SEGMENT_CACHE).then(function (cache) {
        return cache.match(cacheKey).then(function (cached) {
          if (cached) return withSourceHeaders(cached, 'segment-cache', false);
          return fetch(event.request).then(function (response) {
            if (response.status === 200) {
              putBoundedMediaResponse(cache, cacheKey, response).then(function (stored) {
                if (stored) maybeTrimSegmentCache(cache, cacheKey, response);
              }).catch(function () {});
            }
            return response;
          }).catch(function () {
            return networkMissResponse();
          });
        });
      })
    );
    return;
  }

  // DASH format segments: check durable IDB chunks first, then use network.
  if (url.pathname.match(/^\/api\/stream\/[^/]+\/fmt\/\d+$/)) {
    var fmtParts = url.pathname.match(/^\/api\/stream\/([^/]+)\/fmt\/(\d+)$/);
    var fmtVideoId = fmtParts ? fmtParts[1] : '';
    var fmtFormatId = fmtParts ? fmtParts[2] : '';
    var fmtIdbKey = fmtVideoId + ':' + fmtFormatId;
    var fmtRange = event.request.headers.get('Range');
    // Explicit offline downloads are already persisted in chunked IndexedDB.
    // Bypass Cache Storage so the same multi-hundred-megabyte format is never
    // retained twice in the browser.
    if (url.searchParams.get('offline') === '1') {
      event.respondWith(fetch(event.request).catch(function () { return networkMissResponse(); }));
      return;
    }
    event.respondWith(
      // 1. Check IDB for chunk-based format data
      // One indexed metadata lookup per format is cached with bounded LRU/TTL
      // state. This avoids both a transaction per media range and materializing
      // the complete offline library when the worker starts.
      getOfflineFormatMeta(fmtIdbKey)
        .then(function (meta) {
          if (!meta || !meta.done || !meta.downloadedChunks || !meta.chunkSize) return null;
          var ct = meta.contentType || 'application/octet-stream';
          var totalSize = meta.totalSize || 0;

          // Range request — serve from chunks
          if (fmtRange) {
            var rangeMatch = fmtRange.match(/^bytes=(\d+)-(\d*)$/);
            if (rangeMatch && totalSize > 0) {
              var start = parseInt(rangeMatch[1], 10);
              var end = rangeMatch[2] ? parseInt(rangeMatch[2], 10) : totalSize - 1;
              if (start >= totalSize || end < start) {
                return new Response('', {
                  status: 416,
                  headers: { 'Content-Range': 'bytes */' + totalSize }
                });
              }
              if (end >= totalSize) end = totalSize - 1;
              // Bound memory and IndexedDB work even when a client asks for an
              // open-ended or whole-file range.
              end = Math.min(end, start + MAX_OFFLINE_RANGE_BYTES - 1);
              var rangeStream = IDBHelpers.createChunkStream(fmtIdbKey, start, end, meta);
              return new Response(rangeStream, {
                status: 206,
                headers: {
                  'Content-Type': ct,
                  'Content-Length': String(end - start + 1),
                  'Content-Range': 'bytes ' + start + '-' + end + '/' + totalSize,
                  'Accept-Ranges': 'bytes',
                  'X-SW-Cached': '1',
                  'X-SW-Cache': '1',
                  'X-SW-Source': 'idb',
                  'X-SW-Offline': '1'
                }
              });
            }
          }

          // No Range + fully downloaded — serve all chunks as 200
          if (meta.done) {
            var fullStream = IDBHelpers.createChunkStream(fmtIdbKey, 0, totalSize - 1, meta);
            return new Response(fullStream, {
              status: 200,
              headers: {
                'Content-Type': ct,
                'Content-Length': String(totalSize),
                'X-SW-Cached': '1',
                'X-SW-Cache': '1',
                'X-SW-Source': 'idb',
                'X-SW-Offline': '1'
              }
            });
          }

          return null; // partial download, no Range — can't serve
        })
        .then(function (idbResponse) {
          if (idbResponse) return idbResponse;
          // 2. Normal online playback is network-only here. Explicit offline
          // formats live in IndexedDB; caching whole 200 responses made every
          // range read allocate the entire video and duplicated offline bytes.
          return fetch(event.request).catch(function () { return networkMissResponse(); });
        })
        .catch(function () {
          // IDB error — fall through to network
          return fetch(event.request).catch(function () {
            return networkMissResponse();
          });
        })
    );
    return;
  }

  // Skip remaining API routes
  if (url.pathname.startsWith('/api/')) return;

  // Cache-first for known static assets and vendor files
  var isStatic = STATIC_PATHS.indexOf(url.pathname) !== -1
    || url.pathname.startsWith('/vendor/');

  if (isStatic) {
    var runtimeVersion = url.searchParams.get('v');
    var versionedRuntime = !!runtimeVersion
      && VERSIONED_RUNTIME_ASSETS.indexOf(url.pathname + url.search) !== -1;
    if (versionedRuntime) {
      event.respondWith(
        caches.match(event.request).then(function (cached) {
          if (cached) return cached;
          return fetch(event.request).then(function (response) {
            if (response.ok) {
              var clone = response.clone();
              caches.open(STATIC_CACHE).then(function (cache) {
                cache.put(event.request, clone);
              });
            }
            return response;
          }).catch(function () {
            return caches.match(event.request);
          });
        })
      );
      return;
    }
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
