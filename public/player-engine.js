/**
 * PlayerEngine — wraps Shaka Player with application-level overrides
 * for single-proxy architecture (all segments from one host).
 *
 * Handles: recovery state machine, request policy, error classification,
 * server probing, retryStreaming cascade.
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
    this.recovering = false;
    this.networkTrouble = false;
    this.recoveryTransition = false;
    this.lastGoodTime = 0;
    this.retryActive = false;
    this.videoUnavailable = false;
    this.destroyed = false;

    // Internal
    this._retryResolved = false;
    this._retryGen = 0;
    this._probeTimer = null;
    this._elapsedTimer = null;
    this._listeners = {};
    this._player = new shaka.Player();
    this._finalVia = '';
    this._rebufferCount = 0;
    this._retryStartTime = 0;
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

    // 1. Request policy: block during recovery + append stream token
    player.getNetworkingEngine().registerRequestFilter(function (type, request) {
      if (self.recovering) {
        return Promise.reject(new shaka.util.Error(
          shaka.util.Error.Severity.RECOVERABLE,
          shaka.util.Error.Category.NETWORK,
          shaka.util.Error.Code.OPERATION_ABORTED
        ));
      }
      // Timeout during retry — if segments are blocked for >10s, force reload
      if (self.retryActive && self._retryStartTime && Date.now() - self._retryStartTime > 10000) {
        self._onRetryFailed(0);
        return Promise.reject(new shaka.util.Error(
          shaka.util.Error.Severity.RECOVERABLE,
          shaka.util.Error.Category.NETWORK,
          shaka.util.Error.Code.OPERATION_ABORTED
        ));
      }
      // Append stream token to all segment/manifest requests to our server
      if (self.streamToken && request.uris && request.uris.length) {
        for (var i = 0; i < request.uris.length; i++) {
          var uri = request.uris[i];
          if (uri.indexOf('/api/stream/') !== -1 && uri.indexOf('token=') === -1) {
            request.uris[i] = uri + (uri.indexOf('?') === -1 ? '?' : '&') + 'token=' + self.streamToken;
          }
        }
      }
    });

    // 2. Response filter: capture stream-via metadata
    player.getNetworkingEngine().registerResponseFilter(function (type, response) {
      if (type === shaka.net.NetworkingEngine.RequestType.MANIFEST) {
        var via = response.headers['x-stream-via'];
        if (via) {
          self._finalVia = via;
          self.emit('via', via);
        }
      }
    });

    // 3. Configuration
    player.configure({
      abr: {
        enabled: true,
        defaultBandwidthEstimate: 3000000,
        switchInterval: 2,
        bandwidthUpgradeTarget: 0.7,
        bandwidthDowngradeTarget: 0.4,
        restrictions: { minHeight: 360 }
      },
      streaming: {
        bufferingGoal: 30,
        rebufferingGoal: 0.3,
        bufferBehind: 60,
        segmentPrefetchLimit: 5,
        retryParameters: {
          maxAttempts: 3,
          baseDelay: 200,
          backoffFactor: 2,
          timeout: 10000
        },
        failureCallback: function (error) {
          if (error.category === 1) {
            // Always upgrade network errors to FATAL — in every state:
            // - Normal: triggers recovery via error handler
            // - Recovering: request filter blocks, this handles stragglers
            // - Retry active: prevents variant cycling during retryStreaming
            error.severity = 2;
            if (!self.recovering && !self.retryActive) {
              // Set recovering immediately so the request filter blocks
              // on the very next tick — before recover() does full setup
              self.recovering = true;
              // Defer full recovery setup to next microtask so we return
              // from this callback synchronously (Shaka expects that)
              Promise.resolve().then(function () {
                self.recovering = false;
                self.recover('network failure code=' + error.code);
              });
            }
            if (!self.networkTrouble) {
              self.networkTrouble = true;
              self.emit('network-trouble', true);
            }
          }
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

    // 4. Error handler
    player.addEventListener('error', function (event) {
      var error = event.detail;
      if (!error) return;
      if (self.destroyed || self.recovering) return;
      // Emergency quality drop after repeated rebuffers
      if (error.category === 1) {
        self._rebufferCount++;
        if (self._rebufferCount >= 3) {
          try {
            player.configure({ abr: { restrictions: { maxHeight: 360 } } });
            self.emit('emergency-quality-drop');
          } catch (e) {}
        }
      }
      if (error.severity === 2 || error.category === 3) {
        if (self.retryActive) {
          self._onRetryFailed(error.code);
        } else {
          self.recover('error cat=' + error.category + ' code=' + error.code);
        }
      }
    });

    // 5. Bound handlers — created once, reused across recovery cycles
    this._boundTrackTime = function () {
      if (self.video.currentTime > 0) self.lastGoodTime = self.video.currentTime;
    };
    this._boundProbe = function () { self._probeServer(); };
    this._boundOnVisible = function () { if (!document.hidden) self._probeServer(); };

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

  PlayerEngine.prototype.clearNetworkTrouble = function () {
    if (!this.networkTrouble) return;
    this.networkTrouble = false;
    this.emit('network-trouble-cleared');
  };

  // --- Recovery state machine ---

  PlayerEngine.prototype.recover = function (reason, keepTime) {
    if (this.recovering || this.destroyed || this.videoUnavailable) return;

    this._cleanupAll();

    this.recovering = true;
    if (!keepTime) this.lastGoodTime = this.video.currentTime || 0;

    this.video.addEventListener('timeupdate', this._boundTrackTime);

    this.emit('recovery-start', {
      reason: reason,
      lastGoodTime: this.lastGoodTime
    });

    // Probe immediately, then on interval + events
    this._probeServer();
    this._probeTimer = setInterval(this._boundProbe, 5000);
    window.addEventListener('online', this._boundProbe);
    document.addEventListener('visibilitychange', this._boundOnVisible);

    // Elapsed counter
    var engine = this;
    var startTime = Date.now();
    this._elapsedTimer = setInterval(function () {
      if (!engine.recovering) { clearInterval(engine._elapsedTimer); return; }
      var elapsed = Math.floor((Date.now() - startTime) / 1000);
      engine.emit('recovery-elapsed', elapsed);
    }, 1000);
  };

  PlayerEngine.prototype._probeServer = function () {
    if (!this.recovering) return;
    if (!navigator.onLine) return;
    var self = this;
    fetch('/api/stream/' + this.videoId + '/prefetch')
      .then(function (r) {
        if (!self.recovering) return;
        if (r.ok || r.status === 204) {
          // Server is back — resume immediately. retryStreaming() refills
          // the buffer alongside what's already playing. If the server goes
          // down again, failureCallback catches it from the failed segment
          // fetch. No need to wait for buffer drain or keep probing.
          self._cleanupProbes();
          self._doResume();
        }
      })
      .catch(function () {});
  };

  PlayerEngine.prototype._doResume = function () {
    // Keep _boundTrackTime — lastGoodTime stays fresh for fallback

    this.recovering = false;
    this.retryActive = true;
    this._retryResolved = false;
    this._retryStartTime = Date.now();
    var gen = ++this._retryGen;

    this.emit('retry-start');

    var accepted;
    try {
      accepted = this._player.retryStreaming();
    } catch (e) {
      this.retryActive = false;
      this._doFullReload();
      return;
    }

    if (!accepted) {
      this.retryActive = false;
      this._doFullReload();
      return;
    }

    var self = this;
    this._onRetryPlaying = function () { self._onRetrySuccess(); };
    this._onRetryCanplay = function () {
      if (self.video.readyState >= 3) self._onRetrySuccess();
    };
    this.video.addEventListener('playing', this._onRetryPlaying);
    this.video.addEventListener('canplay', this._onRetryCanplay);

    // Buffer growth check — detect silent retryStreaming failure
    // Take two snapshots 2s apart to measure growth rate, not just absolute position
    var bufSnapshot = this._getBufferEnd();
    setTimeout(function () {
      if (gen !== self._retryGen || !self.retryActive || self._retryResolved) return;
      var midSnapshot = self._getBufferEnd();
      setTimeout(function () {
        if (gen !== self._retryGen || !self.retryActive || self._retryResolved) return;
        var growth = self._getBufferEnd() - midSnapshot;
        if (growth < 0.3) {
          self._onRetryFailed(0);
        }
      }, 2000);
    }, 2000);
  };

  PlayerEngine.prototype._onRetrySuccess = function () {
    if (this._retryResolved) return;
    this._retryResolved = true;
    this._cleanupRetry();
    this.video.removeEventListener('timeupdate', this._boundTrackTime);
    this.networkTrouble = false;

    this.emit('recovery-end', {
      method: 'retry',
      time: this.video.currentTime,
      via: this._finalVia
    });
  };

  PlayerEngine.prototype._onRetryFailed = function (code) {
    if (!this.retryActive || this._retryResolved) return;
    this._cleanupRetry();
    this.video.removeEventListener('timeupdate', this._boundTrackTime);
    this.emit('retry-failed', code);
    this._doFullReload();
  };

  PlayerEngine.prototype._doFullReload = function () {
    if (this.recoveryTransition || this.destroyed) return;
    var resumeTime = this.lastGoodTime;
    this.recoveryTransition = true;

    this.emit('reload-start', resumeTime);
    this.emit('freeze-frame');

    var self = this;
    this._player.unload().then(function () {
      return self._player.load(self.manifestUrl);
    }).then(function () {
      if (resumeTime > 1 && !self.isLive) self.video.currentTime = resumeTime;

      function finish() {
        if (!self.recoveryTransition) return;
        self.recoveryTransition = false;
        self.networkTrouble = false;
        self.video.play().catch(function () {});
        self.emit('unfreeze-frame');
        self.emit('recovery-end', {
          method: 'reload',
          time: resumeTime,
          via: self._finalVia
        });
      }

      self.video.addEventListener('seeked', finish, { once: true });
      setTimeout(function () { if (self.recoveryTransition) finish(); }, 5000);
    }).catch(function (err) {
      if (self.destroyed) return;
      self.recoveryTransition = false;
      self.emit('unfreeze-frame');
      self.emit('fatal', {
        time: resumeTime,
        error: err
      });
    });
  };


  // --- Buffer helpers ---

  PlayerEngine.prototype._getBufferEnd = function () {
    var buf = this.video.buffered;
    if (!buf.length) return 0;
    return buf.end(buf.length - 1);
  };

  // --- Cleanup ---

  PlayerEngine.prototype._cleanupProbes = function () {
    if (this._probeTimer) { clearInterval(this._probeTimer); this._probeTimer = null; }
    if (this._elapsedTimer) { clearInterval(this._elapsedTimer); this._elapsedTimer = null; }
    window.removeEventListener('online', this._boundProbe);
    document.removeEventListener('visibilitychange', this._boundOnVisible);
  };

  PlayerEngine.prototype._cleanupRetry = function () {
    this.retryActive = false;
    this._retryResolved = false;
    if (this._onRetryPlaying) { this.video.removeEventListener('playing', this._onRetryPlaying); this._onRetryPlaying = null; }
    if (this._onRetryCanplay) { this.video.removeEventListener('canplay', this._onRetryCanplay); this._onRetryCanplay = null; }
  };

  PlayerEngine.prototype._cleanupAll = function () {
    this._cleanupProbes();
    this._cleanupRetry();
    this.video.removeEventListener('timeupdate', this._boundTrackTime);
    this.emit('unfreeze-frame');
  };

  PlayerEngine.prototype.destroy = function () {
    this.destroyed = true;
    this.recovering = false;
    this.retryActive = false;
    this.recoveryTransition = false;
    this._cleanupAll();
    // Remove global listeners that may have been added during recovery
    if (this._boundProbe) {
      window.removeEventListener('online', this._boundProbe);
      document.removeEventListener('visibilitychange', this._boundOnVisible);
    }
    if (this._player) {
      try { this._player.destroy(); } catch (e) {}
      this._player = null;
    }
    this._listeners = {};
  };

  // --- Seek during recovery ---

  PlayerEngine.prototype.seekDuringRecovery = function (time) {
    this.lastGoodTime = time;
  };

  // --- Stall watchdog integration ---

  PlayerEngine.prototype.reportStall = function () {
    if (this.retryActive) {
      this._onRetryFailed(0);
    } else if (!this.recovering) {
      this.recover('stall');
    }
  };

  // Export
  window.PlayerEngine = PlayerEngine;
})();
