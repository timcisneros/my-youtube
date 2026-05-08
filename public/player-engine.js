/**
 * PlayerEngine — wraps Shaka Player with a custom HTTP plugin that
 * owns the entire network layer for the single-proxy architecture.
 *
 * Recovery model: our HTTP scheme plugin replaces Shaka's built-in
 * fetch plugin. Every request goes through our code. When the server
 * is unreachable (network error, 401, 5xx), the plugin holds the
 * request internally and waits for the probe to confirm recovery.
 * Then it re-stamps the token and retries the fetch — returning only
 * successful responses to Shaka. Shaka never sees a network error,
 * never exhausts retries, never re-fetches the manifest, never clears
 * the buffer. The video plays from buffer during the outage and
 * resumes seamlessly when the server returns.
 *
 * Emits events so the UI layer can react without managing Shaka internals.
 */
(function () {
  'use strict';

  function PlayerEngine(videoElement, opts) {
    this.video = videoElement;
    this.videoId = opts.videoId;
    this.streamToken = opts.streamToken || '';
    this.manifestUrl = '/api/stream/' + opts.videoId + '/dash.mpd?token=' + this.streamToken;
    this.isLive = false;

    // State
    this._serverDown = false;
    this._recovering = false;  // decode-error reload in progress
    this.lastGoodTime = 0;
    this.videoUnavailable = false;
    this.destroyed = false;

    // Held requests — resolve functions for plugin fetches waiting
    // for the server to come back. Released by _exitServerDown.
    this._heldRequests = [];

    // Internal
    this._listeners = {};
    this._player = new shaka.Player();
    this._finalVia = '';
  }

  // --- Event emitter ---

  PlayerEngine.prototype.on = function (event, fn) {
    if (!this._listeners[event]) this._listeners[event] = [];
    this._listeners[event].push(fn);
    return this;
  };

  PlayerEngine.prototype.off = function (event, fn) {
    var list = this._listeners[event];
    if (!list) return this;
    if (!fn) { this._listeners[event] = []; return this; }
    this._listeners[event] = list.filter(function (f) { return f !== fn; });
    return this;
  };

  PlayerEngine.prototype.emit = function (event, data) {
    var list = this._listeners[event];
    if (!list) return;
    for (var i = 0; i < list.length; i++) {
      try { list[i](data); } catch (e) { console.error('[player-engine] listener error:', e); }
    }
  };

  // --- Initialization ---

  PlayerEngine.prototype.init = function () {
    var self = this;
    var player = this._player;

    var attachPromise = player.attach(this.video);

    // --- Custom HTTP plugin ---
    // Replaces Shaka's built-in http_fetch_plugin. Every HTTP request
    // goes through our code, giving us full control over hold, retry,
    // token stamping, and error handling. Shaka only ever receives
    // successful responses.

    function stampUri(uri) {
      if (!self.streamToken || uri.indexOf('/api/stream/') === -1) return uri;
      var base = uri.replace(/[?&]token=[^&]*/, '');
      return base + (base.indexOf('?') === -1 ? '?' : '&') + 'token=' + self.streamToken;
    }

    function waitForServer() {
      if (!self._serverDown) return Promise.resolve();
      return new Promise(function (resolve) {
        self._heldRequests.push(resolve);
      });
    }

    function httpPlugin(uri, request, requestType, progressUpdated, headersReceived) {
      var startTime = Date.now();
      var abortController = new AbortController();
      var aborted = false;

      function doFetch() {
        if (aborted) {
          return Promise.reject(new shaka.util.Error(
            shaka.util.Error.Severity.RECOVERABLE,
            shaka.util.Error.Category.NETWORK,
            shaka.util.Error.Code.OPERATION_ABORTED
          ));
        }

        var fetchUri = stampUri(uri);
        var init = {
          method: request.method || 'GET',
          headers: {},
          signal: abortController.signal
        };

        var reqHeaders = request.headers || {};
        for (var key in reqHeaders) {
          if (reqHeaders.hasOwnProperty(key)) {
            init.headers[key] = reqHeaders[key];
          }
        }
        if (request.body) init.body = request.body;

        return fetch(fetchUri, init).then(function (response) {
          // 401, 403, or 5xx — server problem, hold and retry.
          // 403 included because it can mean an expired CDN URL that the
          // server-side circuit breaker failed to refresh.
          if (response.status === 401 || response.status === 403 || response.status >= 500) {
            if (!self._serverDown) {
              self._enterServerDown(response.status === 401 ? 'token-expired' : 'server-error');
            }
            return waitForServer().then(doFetch);
          }

          // Capture metadata from manifest responses
          if (requestType === shaka.net.NetworkingEngine.RequestType.MANIFEST) {
            var via = response.headers.get('x-stream-via');
            if (via) {
              self._finalVia = via;
              self.emit('via', via);
            }
            // If a local download exists, tell the UI the downloaded height
            // so it can pin ABR to that resolution (instant playback from disk)
            var dlHeight = response.headers.get('x-downloaded-height');
            if (dlHeight) {
              self.emit('downloaded-height', parseInt(dlHeight, 10));
            }
          }

          // Build Shaka response with progress reporting
          var responseHeaders = {};
          response.headers.forEach(function (value, key) {
            responseHeaders[key] = value;
          });
          if (headersReceived) headersReceived(responseHeaders);

          var contentLength = parseInt(response.headers.get('Content-Length') || '0', 10);

          // Stream body chunks for accurate ABR bandwidth estimation
          if (response.body && typeof response.body.getReader === 'function') {
            var reader = response.body.getReader();
            var chunks = [];
            var loaded = 0;

            function pump() {
              return reader.read().then(function (result) {
                if (result.done) {
                  var total = 0;
                  for (var i = 0; i < chunks.length; i++) total += chunks[i].length;
                  var combined = new Uint8Array(total);
                  var offset = 0;
                  for (var j = 0; j < chunks.length; j++) {
                    combined.set(chunks[j], offset);
                    offset += chunks[j].length;
                  }
                  return {
                    uri: response.url || fetchUri,
                    originalUri: uri,
                    data: combined.buffer,
                    status: response.status,
                    headers: responseHeaders,
                    timeMs: Date.now() - startTime
                  };
                }
                chunks.push(result.value);
                loaded += result.value.length;
                if (progressUpdated) {
                  progressUpdated(Date.now() - startTime, loaded, contentLength);
                }
                return pump();
              });
            }
            return pump();
          }

          // Fallback for responses without ReadableStream
          return response.arrayBuffer().then(function (data) {
            if (progressUpdated) {
              progressUpdated(Date.now() - startTime, data.byteLength, data.byteLength);
            }
            return {
              uri: response.url || fetchUri,
              originalUri: uri,
              data: data,
              status: response.status,
              headers: responseHeaders,
              timeMs: Date.now() - startTime
            };
          });
        }).catch(function (err) {
          // Abort — propagate without retry
          if (aborted || err.name === 'AbortError') {
            throw new shaka.util.Error(
              shaka.util.Error.Severity.RECOVERABLE,
              shaka.util.Error.Category.NETWORK,
              shaka.util.Error.Code.OPERATION_ABORTED
            );
          }
          // Network error — hold and retry
          if (!self._serverDown) {
            self._enterServerDown('network-error');
          }
          return waitForServer().then(doFetch);
        });
      }

      // If already in serverDown, wait before first attempt
      var promise = (self._serverDown ? waitForServer() : Promise.resolve()).then(doFetch);

      return new shaka.util.AbortableOperation(promise, function () {
        aborted = true;
        abortController.abort();
        return Promise.resolve();
      });
    }

    // Register our plugin at APPLICATION priority — overrides Shaka's
    // built-in http_fetch_plugin for all http/https requests.
    var APP = shaka.net.NetworkingEngine.PluginPriority.APPLICATION;
    shaka.net.NetworkingEngine.registerScheme('http', httpPlugin, APP);
    shaka.net.NetworkingEngine.registerScheme('https', httpPlugin, APP);

    // Configuration — no request/response filters needed. The plugin
    // handles token stamping, error detection, and via capture.
    player.configure({
      abr: {
        enabled: true,
        useNetworkInformation: true,
        defaultBandwidthEstimate: 3000000,
        switchInterval: 2,
        bandwidthUpgradeTarget: 0.85,
        bandwidthDowngradeTarget: 0.95,
        restrictions: {}
      },
      streaming: {
        bufferingGoal: 30,
        rebufferingGoal: 0.3,
        bufferBehind: 60,
        segmentPrefetchLimit: 2,
        retryParameters: {
          maxAttempts: 3,
          baseDelay: 300,
          backoffFactor: 2,
          timeout: 30000
        }
      },
      manifest: {
        retryParameters: {
          maxAttempts: 2,
          baseDelay: 1000,
          backoffFactor: 2,
          timeout: 60000
        }
      }
    });

    // Shaka error handler — suppressed. All network errors are handled
    // by our plugin. Only non-network errors (parsing, buffer) log here.
    player.addEventListener('error', function (event) {
      var error = event.detail;
      if (error && !self._serverDown && !self._recovering) {
        console.debug('[player-engine] shaka error cat=' + error.category + ' code=' + error.code);
      }
    });

    // Video element error recovery — handles decode errors, media
    // errors, etc. independent of Shaka and our network layer.
    this.video.addEventListener('error', function () {
      var e = self.video.error;
      if (!e || self.destroyed || self._serverDown || self._recovering) return;
      self._recovering = true;
      var pos = self.video.currentTime || self.lastGoodTime || 0;
      console.log('[player-engine] video error code=' + e.code + ', reloading at ' + pos.toFixed(1) + 's');
      self._player.unload().then(function () {
        return self._player.load(self.manifestUrl, pos > 1 ? pos : undefined);
      }).then(function () {
        self.video.play().catch(function () {});
        self._recovering = false;
      }).catch(function () {
        self._recovering = false;
        if (!self._serverDown) {
          self._enterServerDown('reload-failed');
        }
      });
    });

    return attachPromise;
  };

  // --- Public API ---

  PlayerEngine.prototype.getPlayer = function () { return this._player; };
  PlayerEngine.prototype.getVia = function () { return this._finalVia; };

  PlayerEngine.prototype.load = function (url) {
    return this._player.load(url || this.manifestUrl);
  };

  PlayerEngine.prototype.configure = function () {
    return this._player.configure.apply(this._player, arguments);
  };

  PlayerEngine.prototype.setLive = function (live) { this.isLive = live; };

  // True when the engine is in any recovery state (server down or decode reload)
  PlayerEngine.prototype.isRecovering = function () {
    return this._serverDown || this._recovering;
  };

  // --- Server down / recovery ---
  // The plugin holds requests internally when serverDown is true.
  // enterServerDown starts the probe; exitServerDown releases held
  // requests so the plugin retries its fetches with a fresh token.

  PlayerEngine.prototype._enterServerDown = function (reason) {
    if (this._serverDown || this.destroyed) return;
    this._serverDown = true;
    this.lastGoodTime = this.video.currentTime || this.lastGoodTime || 0;
    console.log('[player-engine] server down (' + reason + '), lastGoodTime=' + this.lastGoodTime.toFixed(1));
    this.emit('server-down', reason);
    this._startServerProbe();
  };

  PlayerEngine.prototype._startServerProbe = function () {
    if (this._serverProbeTimer) return;
    var self = this;
    var startTime = Date.now();
    this._serverElapsedTimer = setInterval(function () {
      if (!self._serverDown) { clearInterval(self._serverElapsedTimer); return; }
      self.emit('server-down-elapsed', Math.floor((Date.now() - startTime) / 1000));
    }, 1000);

    function probe() {
      if (!self._serverDown || self.destroyed) return;
      fetch(self.manifestUrl, { method: 'HEAD' })
        .then(function (r) {
          if (!self._serverDown) return;
          if (r.status === 401) {
            self._refreshToken();
          } else if (r.ok && !r.headers.get('X-SW-Cache')) {
            self._exitServerDown();
          }
        })
        .catch(function () {})
        .then(function () {
          if (!self._serverDown || self.destroyed) return;
          self._serverProbeTimer = setTimeout(probe, 3000 + Math.random() * 2000);
        });
    }
    probe();
  };

  PlayerEngine.prototype._stopServerProbe = function () {
    if (this._serverProbeTimer) { clearTimeout(this._serverProbeTimer); this._serverProbeTimer = null; }
    if (this._serverElapsedTimer) { clearInterval(this._serverElapsedTimer); this._serverElapsedTimer = null; }
  };

  PlayerEngine.prototype._exitServerDown = function () {
    if (!this._serverDown) return;
    this._serverDown = false;
    this._stopServerProbe();
    this.lastGoodTime = Math.max(this.lastGoodTime, this.video.currentTime || 0);
    console.log('[player-engine] server back, releasing ' + this._heldRequests.length + ' held requests');

    // Release all held plugin fetches — each one loops back into
    // doFetch() which re-stamps the token and retries the request.
    var held = this._heldRequests;
    this._heldRequests = [];
    for (var i = 0; i < held.length; i++) held[i]();

    this.emit('server-up');
    this.emit('recovery-end', {
      method: 'seamless',
      time: this.video.currentTime,
      via: this._finalVia
    });
  };

  // --- Token refresh ---
  PlayerEngine.prototype._refreshToken = function () {
    if (this._refreshingToken) return;
    this._refreshingToken = true;
    var self = this;
    fetch('/watch/token?v=' + encodeURIComponent(this.videoId))
      .then(function (r) {
        if (!r.ok) throw new Error('Token refresh failed: ' + r.status);
        return r.json();
      })
      .then(function (data) {
        if (!data.token) throw new Error('No token in response');
        self._refreshingToken = false;
        self.streamToken = data.token;
        self.manifestUrl = '/api/stream/' + self.videoId + '/dash.mpd?token=' + data.token;
        self.emit('token-refreshed', data.token);
      })
      .catch(function () {
        self._refreshingToken = false;
        self._stopServerProbe();
        self._serverDown = false;
        self.emit('auth-expired');
      });
  };

  // --- Buffer helpers ---

  PlayerEngine.prototype._getBufferEnd = function () {
    var buf = this.video.buffered;
    if (!buf.length) return 0;
    return buf.end(buf.length - 1);
  };

  PlayerEngine.prototype._getBufferAhead = function () {
    var buf = this.video.buffered;
    var ct = this.video.currentTime;
    for (var i = 0; i < buf.length; i++) {
      if (ct >= buf.start(i) - 0.5 && ct <= buf.end(i)) {
        return buf.end(i) - ct;
      }
    }
    return 0;
  };

  // --- Cleanup ---

  PlayerEngine.prototype.destroy = function () {
    this.destroyed = true;
    this._serverDown = false;
    this._recovering = false;
    this._heldRequests = [];
    this._stopServerProbe();
    if (this._player) {
      try { this._player.destroy(); } catch (e) {}
      this._player = null;
    }
    this._listeners = {};
  };

  // --- Stall watchdog integration ---

  PlayerEngine.prototype.reportStall = function () {
    if (this._serverDown) return;
    this._enterServerDown('stall');
  };

  // Export
  window.PlayerEngine = PlayerEngine;
})();
