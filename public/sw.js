importScripts('/idb-helpers.js');
// Service Worker — cache-first for static assets, segment caching for video proxy
var STATIC_CACHE = 'my-youtube-static-v12';
var SEGMENT_CACHE = 'my-youtube-segments-v5';
var IMAGE_CACHE = 'my-youtube-images-v1';
var APP_SHELL_CACHE = 'my-youtube-shell-v1';
var MAX_SEGMENT_CACHE_SIZE = 200; // max cached segment responses
var MAX_IMAGE_CACHE_SIZE = 500; // max cached poster/thumb responses

var STATIC_ASSETS = [
  '/idb-helpers.js',
  '/app.js',
  '/style.css',
  '/native-player-engine.js',
  '/fonts/roboto.css',
  '/fonts/roboto-latin.woff2',
  '/manifest.json',
  '/favicon.svg'
];
var NETWORK_FIRST_STATIC = [
  '/idb-helpers.js',
  '/app.js',
  '/native-player-engine.js'
];

// Strip auth token from URL so cached content is token-agnostic.
// This way segments/MPDs cached during online play are found during offline play
// regardless of which token (or no token) the player uses.
function stripToken(urlStr) {
  return urlStr.replace(/[?&]token=[^&]*/g, '').replace(/\?$/, '');
}

function cacheKeyWithRange(request) {
  var range = request.headers.get('Range') || '';
  var baseUrl = stripToken(request.url);
  var cacheUrl = baseUrl + (range ? (baseUrl.indexOf('?') === -1 ? '?' : '&') + '_r=' + encodeURIComponent(range) : '');
  return new Request(cacheUrl);
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

function putHlsProxyResponse(cache, cacheKey, response) {
  if (response.status === 206) {
    return response.clone().arrayBuffer().then(function (buf) {
      var headers = new Headers(response.headers);
      headers.delete('Content-Range');
      headers.set('Content-Length', String(buf.byteLength));
      return cache.put(cacheKey, new Response(buf, {
        status: 200,
        headers: headers
      }));
    });
  }
  if (response.ok) return cache.put(cacheKey, response.clone());
  return Promise.resolve();
}

self.addEventListener('install', function (event) {
  event.waitUntil(
    Promise.all([
      caches.open(STATIC_CACHE).then(function (cache) {
        return cache.addAll(STATIC_ASSETS);
      }),
      caches.open(APP_SHELL_CACHE).then(function (cache) {
        return cache.add('/offline');
      })
    ])
  );
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      var keep = [STATIC_CACHE, SEGMENT_CACHE, IMAGE_CACHE, APP_SHELL_CACHE];
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
    if (typeof IDBHelpers !== 'undefined') {
      IDBHelpers.deleteAllForVideo(delVideoId);
    }
    var delWatchUrl = self.location.origin + '/watch?v=' + delVideoId;
    var delMpdUrl = self.location.origin + '/api/stream/' + delVideoId + '/dash.mpd';
    caches.open(APP_SHELL_CACHE).then(function (cache) {
      cache.delete(new Request(delWatchUrl));
      cache.delete(new Request(delMpdUrl));
    });
    return;
  }

  if (event.data.type !== 'cache-offline-bundle') return;
  var bundle = event.data.bundle;
  if (!bundle || !bundle.videoId) return;

  var watchPageHtml = buildOfflineWatchPage(bundle);
  var watchUrl = self.location.origin + '/watch?v=' + bundle.videoId;
  var mpdUrl = self.location.origin + '/api/stream/' + bundle.videoId + '/dash.mpd';

  caches.open(APP_SHELL_CACHE).then(function (cache) {
    // Cache the offline watch page
    cache.put(new Request(watchUrl), new Response(watchPageHtml, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    }));
    // Cache the MPD (token-stripped key)
    if (bundle.mpd) {
      cache.put(new Request(mpdUrl), new Response(bundle.mpd, {
        status: 200,
        headers: {
          'Content-Type': 'application/dash+xml',
          'X-SW-Cached': '1',
          'X-SW-Cache': '1',
          'X-SW-Source': 'offline-bundle',
          'X-SW-Offline': '1'
        }
      }));
    }
  });

  // Cache poster if not already cached
  var posterUrl = '/api/stream/' + bundle.videoId + '/poster';
  caches.open(IMAGE_CACHE).then(function (cache) {
    cache.match(posterUrl).then(function (cached) {
      if (!cached) {
        fetch(posterUrl).then(function (resp) {
          if (resp.ok) cache.put(posterUrl, resp);
        }).catch(function () {});
      }
    });
  });
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
    + '  <link rel="stylesheet" href="/style.css">\n'
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
    + '<script src="/native-player-engine.js?v=12"><\/script>\n'
    + '<script src="/idb-helpers.js"><\/script>\n'
    + '<script src="/app.js"><\/script>\n'
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
          caches.open(APP_SHELL_CACHE).then(function (cache) {
            cache.put(event.request, clone);
          });
        }
        return response;
      }).catch(function () {
        return caches.open(APP_SHELL_CACHE).then(function (cache) {
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
          caches.open(APP_SHELL_CACHE).then(function (cache) {
            cache.put(mpdCacheKey, clone);
          });
        }
        return response;
      }).catch(function () {
        return caches.open(APP_SHELL_CACHE).then(function (cache) {
          return cache.match(mpdCacheKey).then(function (cached) {
            if (!cached) return new Response('', { status: 503 });
            var online = self.navigator && 'onLine' in self.navigator ? self.navigator.onLine : false;
            return withSourceHeaders(cached, 'app-shell', !online);
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
      caches.open(APP_SHELL_CACHE).then(function (cache) {
        return fetch(event.request).then(function (response) {
          if (response.ok) cache.put(hlsPlaylistCacheKey, response.clone());
          return response;
        }).catch(function () {
          return cache.match(hlsPlaylistCacheKey).then(function (cached) {
            if (!cached) return new Response('', {
              status: 503,
              headers: {
                'X-SW-Cached': '0',
                'X-SW-Offline': '1',
                'X-SW-Source': 'miss'
              }
            });
            var online = self.navigator && 'onLine' in self.navigator ? self.navigator.onLine : false;
            return withSourceHeaders(cached, 'app-shell', !online);
          });
        });
      })
    );
    return;
  }

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
          }).catch(function () {
            return new Response('', { status: 503 });
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
    event.respondWith(
      caches.open(SEGMENT_CACHE).then(function (cache) {
        return cache.match(hlsProxyCacheKey).then(function (cached) {
          if (cached) return withSourceHeaders(cached, 'segment-cache', false);
          return fetch(event.request).then(function (response) {
            if (response.ok || response.status === 206) {
              putHlsProxyResponse(cache, hlsProxyCacheKey, response).then(trimSegmentCache).catch(function () {});
            }
            return response;
          }).catch(function () {
            return cache.match(hlsProxyCacheKey).then(function (retry) {
              return retry ? withSourceHeaders(retry, 'segment-cache', true) : new Response('', {
                status: 503,
                headers: {
                  'X-SW-Cached': '0',
                  'X-SW-Offline': '1',
                  'X-SW-Source': 'miss'
                }
              });
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
              cache.put(cacheKey, response.clone());
              trimSegmentCache();
            }
            return response;
          }).catch(function () {
            return new Response('', { status: 503 });
          });
        });
      })
    );
    return;
  }

  // DASH format segments: check IDB chunks first (durable, zero-copy Blob.slice),
  // then fall back to Cache API, then network.
  if (url.pathname.match(/^\/api\/stream\/[^/]+\/fmt\/\d+$/)) {
    var fmtParts = url.pathname.match(/^\/api\/stream\/([^/]+)\/fmt\/(\d+)$/);
    var fmtVideoId = fmtParts ? fmtParts[1] : '';
    var fmtFormatId = fmtParts ? fmtParts[2] : '';
    var fmtIdbKey = fmtVideoId + ':' + fmtFormatId;
    var fmtCacheKey = new Request(stripToken(event.request.url));
    var fmtRange = event.request.headers.get('Range');
    event.respondWith(
      // 1. Check IDB for chunk-based format data
      (typeof IDBHelpers !== 'undefined' ? IDBHelpers.getMeta(fmtIdbKey) : Promise.resolve(null))
        .then(function (meta) {
          if (!meta || !meta.downloadedChunks || !meta.chunkSize) return null;
          var ct = meta.contentType || 'application/octet-stream';
          var totalSize = meta.totalSize || 0;

          // Range request — serve from chunks
          if (fmtRange) {
            var rangeMatch = fmtRange.match(/^bytes=(\d+)-(\d*)$/);
            if (rangeMatch && totalSize > 0) {
              var start = parseInt(rangeMatch[1], 10);
              var end = rangeMatch[2] ? parseInt(rangeMatch[2], 10) : totalSize - 1;
              if (end >= totalSize) end = totalSize - 1;
              return IDBHelpers.getChunksForRange(fmtIdbKey, start, end, meta).then(function (blob) {
                if (!blob) return null; // missing chunks — fall through
                return new Response(blob, {
                  status: 206,
                  headers: {
                    'Content-Type': ct,
                    'Content-Length': String(blob.size),
                    'Content-Range': 'bytes ' + start + '-' + end + '/' + totalSize,
                    'Accept-Ranges': 'bytes',
                    'X-SW-Cached': '1',
                    'X-SW-Cache': '1',
                    'X-SW-Source': 'idb',
                    'X-SW-Offline': '1'
                  }
                });
              });
            }
          }

          // No Range + fully downloaded — serve all chunks as 200
          if (meta.done) {
            return IDBHelpers.getAllChunks(fmtIdbKey, meta).then(function (blob) {
              if (!blob) return null;
              return new Response(blob, {
                status: 200,
                headers: {
                  'Content-Type': ct,
                  'X-SW-Cached': '1',
                  'X-SW-Cache': '1',
                  'X-SW-Source': 'idb',
                  'X-SW-Offline': '1'
                }
              });
            });
          }

          return null; // partial download, no Range — can't serve
        })
        .then(function (idbResponse) {
          if (idbResponse) return idbResponse;
          // 2. Fall through to Cache API
          return caches.open(SEGMENT_CACHE).then(function (cache) {
            return cache.match(fmtCacheKey).then(function (cached) {
              if (cached) {
                if (fmtRange && cached.status === 200) {
                  var cacheRangeMatch = fmtRange.match(/^bytes=(\d+)-(\d*)$/);
                  if (cacheRangeMatch) {
                    return cached.arrayBuffer().then(function (buf) {
                      var s = parseInt(cacheRangeMatch[1], 10);
                      var e = cacheRangeMatch[2] ? parseInt(cacheRangeMatch[2], 10) : buf.byteLength - 1;
                      if (e >= buf.byteLength) e = buf.byteLength - 1;
                      var sl = buf.slice(s, e + 1);
                      return new Response(sl, {
                        status: 206,
                        headers: {
                          'Content-Type': cached.headers.get('Content-Type') || 'application/octet-stream',
                          'Content-Length': String(sl.byteLength),
                          'Content-Range': 'bytes ' + s + '-' + e + '/' + buf.byteLength,
                          'Accept-Ranges': 'bytes',
                          'X-SW-Cached': '1',
                          'X-SW-Cache': '1',
                          'X-SW-Source': 'segment-cache',
                          'X-SW-Offline': '1'
                        }
                      });
                    });
                  }
                }
                return withSourceHeaders(cached, 'segment-cache', false);
              }
              // 3. Network
              return fetch(event.request).then(function (response) {
                if (response.status === 200) {
                  cache.put(fmtCacheKey, response.clone());
                  trimSegmentCache();
                }
                return response;
              }).catch(function () {
                return cache.match(fmtCacheKey).then(function (retry) {
                  return retry ? withSourceHeaders(retry, 'segment-cache', true) : new Response('', {
                    status: 503,
                    headers: {
                      'X-SW-Cached': '0',
                      'X-SW-Offline': '1',
                      'X-SW-Source': 'miss'
                    }
                  });
                });
              });
            });
          });
        })
        .catch(function () {
          // IDB error — fall through to network
          return fetch(event.request).catch(function () {
            return new Response('', {
              status: 503,
              headers: {
                'X-SW-Cached': '0',
                'X-SW-Offline': '1',
                'X-SW-Source': 'miss'
              }
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
    // Runtime JavaScript must update on the first online reload. Cache-first
    // here used to execute the previous player for one or more navigations,
    // even after a playback fix had been deployed.
    if (NETWORK_FIRST_STATIC.indexOf(url.pathname) !== -1) {
      event.respondWith(
        fetch(event.request).then(function (response) {
          if (response.ok) {
            var clone = response.clone();
            caches.open(STATIC_CACHE).then(function (cache) {
              cache.put(event.request, clone);
            });
          }
          return response;
        }).catch(function () {
          return caches.match(event.request);
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
