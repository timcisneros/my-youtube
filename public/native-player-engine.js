/**
 * PlayerEngine — native-first playback engine.
 *
 * The public API intentionally preserves the old player adapter shape so the
 * player UI can migrate without a redesign.
 */
(function () {
  'use strict';

  var BUFFER_AHEAD = 30;
  var BUFFER_BEHIND = 60;
  var MIN_BUFFER_AHEAD = 12;
  var ABR_SWITCH_COOLDOWN_MS = 4000;
  var ABR_UPGRADE_BUFFER = 14;
  var ABR_DOWNGRADE_BUFFER = 4;
  var LIVE_TARGET_LATENCY = 6;
  var LIVE_MAX_LATENCY = 18;
  var LIVE_STABLE_START_LATENCY = 60;
  var LIVE_BUFFER_AHEAD = 36;
  var LIVE_STARTUP_ABR_FACTOR = 0.35;
  var LIVE_STABLE_ABR_FACTOR = 0.55;
  var LIVE_STARTUP_MAX_HEIGHT = 480;
  var LIVE_UPGRADE_HOLDOFF_MS = 180000;
  var MAX_GAP_JUMP = 0.75;
  var STARTUP_BUFFER_GOAL = 4;
  var MAX_CONCURRENT_MEDIA_REQUESTS = 3;
  var SOURCEBUFFER_WATCHDOG_MS = 1200;
  var SEGMENT_BUSY_WATCHDOG_MS = 2500;

  function PlayerEngine(videoElement, opts) {
    this.video = videoElement;
    this.videoId = opts.videoId;
    this.streamToken = opts.streamToken || '';
    this.manifestUrl = '/api/stream/' + opts.videoId + '/dash.mpd?token=' + this.streamToken;
    this.isLive = false;
    this.videoUnavailable = false;
    this.destroyed = false;
    this.lastGoodTime = 0;

    this._listeners = {};
    this._serverDown = false;
    this._recovering = false;
    this._heldRequests = [];
    this._networkHoldStartedAt = 0;
    this._cleanups = [];
    this._initialized = false;
    this._provider = null;
    this._providerName = '';
    this._finalVia = '';
    this._state = 'idle';
    this._fallbackReason = '';
    this._nativeTerminalReason = '';
    this._loadStartedAt = 0;
    this._offlinePlayback = false;
    this._manifestFromServiceWorker = false;
    this._lastOfflineError = '';
    this.recovering = false;
    this.recoveryTransition = false;
    this.networkTrouble = false;
    this._networkingEngine = new NativeNetworkingEngine(this);
    this._player = new PlayerAdapter(this);
    this._telemetry = new PlayerTelemetry(this);
  }

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

  PlayerEngine.prototype._addCleanup = function (fn) {
    if (typeof fn === 'function') this._cleanups.push(fn);
    return fn;
  };

  PlayerEngine.prototype._runCleanups = function () {
    var cleanups = this._cleanups.splice(0);
    for (var i = cleanups.length - 1; i >= 0; i--) {
      try { cleanups[i](); } catch (e) {}
    }
  };

  PlayerEngine.prototype._listen = function (target, event, fn, opts) {
    if (!target || !target.addEventListener || !target.removeEventListener) return fn;
    target.addEventListener(event, fn, opts);
    this._addCleanup(function () { target.removeEventListener(event, fn, opts); });
    return fn;
  };

  PlayerEngine.prototype._clearHeldRequests = function (reason) {
    var held = this._heldRequests.splice(0);
    if (this._networkingEngine && this._networkingEngine.stats) this._networkingEngine.stats.networkHeldRequestCount = 0;
    var err = new Error(reason || 'player-unloaded');
    for (var i = 0; i < held.length; i++) held[i](err);
  };

  PlayerEngine.prototype.init = function () {
    var self = this;
    if (this._initialized) return Promise.resolve();
    this._initialized = true;
    this._telemetry.attach();
    this._listen(this.video, 'timeupdate', function () {
      if (!self.video.seeking && !self.video.paused && isFinite(self.video.currentTime)) {
        self.lastGoodTime = self.video.currentTime;
      }
    });
    this._listen(this.video, 'error', function () {
      var e = self.video.error;
      if (!e || self.destroyed || self._serverDown || self._recovering) return;
      console.warn('[player-engine] video error code=' + e.code + ' provider=' + self._providerName);
      self._telemetry.record('video-error', { lastError: 'video-error-' + e.code });
      if (self._provider && self._provider.handleVideoError) {
        self._setRecovering(true);
        self._provider.handleVideoError(e).then(function () {
          if (self.destroyed) return;
          self._setRecovering(false);
          self._telemetry.record('recovery', { lastError: 'video-error-' + e.code });
          self.emit('recovery-end', { method: 'native', time: self.video.currentTime, via: self._finalVia });
        }).catch(function () {
          if (self.destroyed) return;
          self._setRecovering(false);
          self._completeNativeTerminalError(nativeTerminalError(self._provider, 'video-error-' + e.code)).catch(function (terminalErr) {
            console.error('[player-engine] native terminal failed:', terminalErr);
          });
        });
      }
    });
    return Promise.resolve();
  };

  PlayerEngine.prototype.getPlayer = function () { return this._player; };
  PlayerEngine.prototype.getVia = function () { return this._finalVia; };
  PlayerEngine.prototype.configure = function () { return this._player.configure.apply(this._player, arguments); };
  PlayerEngine.prototype.setTextController = function (controller) { this._textController = controller; };
  PlayerEngine.prototype.setLive = function (live) { this.isLive = live; };
  PlayerEngine.prototype.isRecovering = function () { return this._serverDown || this._recovering; };

  PlayerEngine.prototype.load = function (url, startTime, mimeType) {
    var self = this;
    url = url || this.manifestUrl;
    this._pendingLoadStartTime = isFinite(Number(startTime)) && Number(startTime) >= 0 ? Number(startTime) : null;
    this.setLive(false);
    this._loadStartedAt = performance.now();
    this._nativeTerminalReason = '';
    this._telemetry.record('load-start');
    this._setState('loading');
    return Promise.resolve().then(function () {
      return self._loadNative(url, mimeType);
    }).then(function () {
      return seekToStartTime(self, startTime);
    }).catch(function (err) {
      if (err && err.serverError) throw err;
      if (self._shouldKeepNativeOffline(err)) throw err;
      if (isNativeTerminalError(err)) return self._completeNativeTerminalError(err);
      if (isNativeLoadTerminalError(err)) return self._completeNativeTerminalError(nativeTerminalError(self._provider, err && err.message ? err.message : 'native-load-failed'));
      return self._completeNativeTerminalError(nativeTerminalError(self._provider, err && err.message ? err.message : 'native-load-failed'));
    }).then(function (value) {
      self._pendingLoadStartTime = null;
      return value;
    });
  };

  PlayerEngine.prototype._loadNative = function (url, mimeType) {
    var self = this;
    this._destroyProvider();
    if (isLikelyNativeUrl(url) || isHlsMimeType(mimeType)) {
      if ((/\.m3u8(\?|$)/i.test(url) || isHlsMimeType(mimeType)) && shouldUseFirstPartyHls(url)) {
        this._provider = new NativeHlsProvider(this, stampUri(this, url));
        this._providerName = this._provider.name;
        window._playerProvider = this._providerName;
        console.log('[player-engine] provider=' + this._providerName + ' mode=hls');
        return this._provider.load();
      }
      if ((/\.m3u8(\?|$)/i.test(url) || isHlsMimeType(mimeType)) && !canPlayNativeHls(this.video)) {
        if (!window.MediaSource) throw new Error('mse-unavailable');
        this._provider = new NativeHlsProvider(this, stampUri(this, url));
        this._providerName = this._provider.name;
        window._playerProvider = this._providerName;
        console.log('[player-engine] provider=' + this._providerName + ' mode=hls');
        return this._provider.load();
      }
      this._provider = new NativeUrlProvider(this, url, isHlsMimeType(mimeType) ? 'hls' : undefined);
      this._providerName = this._provider.name;
      window._playerProvider = this._providerName;
      console.log('[player-engine] provider=' + this._providerName);
      return this._provider.load();
    }
    return fetchManifest(self, url).then(function (manifest) {
      self._recordManifestSource(manifest);
      self._finalVia = manifest.via || self._finalVia;
      if (manifest.via) self.emit('via', manifest.via);
      if (manifest.downloadedHeight) self.emit('downloaded-height', manifest.downloadedHeight);
        if (manifest.json) {
        var hlsUrl = manifest.json.hls ? stampUri(self, manifest.json.hls) : '';
        var progressiveUrl = manifest.json.progressive ? stampUri(self, manifest.json.progressive) : '';
        if (hlsUrl && shouldUseFirstPartyHls(hlsUrl)) {
          if (!window.MediaSource) throw new Error('mse-unavailable');
          self._finalVia = (manifest.json.via || 'yt-dlp') + '/hls';
          self.emit('via', self._finalVia);
          self._provider = new NativeHlsProvider(self, hlsUrl);
          self._providerName = self._provider.name;
          window._playerProvider = self._providerName;
          console.log('[player-engine] provider=' + self._providerName + ' mode=hls');
          return self._provider.load();
        }
        if (hlsUrl && canPlayNativeHls(self.video)) {
          self._finalVia = (manifest.json.via || 'yt-dlp') + '/hls';
          self.emit('via', self._finalVia);
          self._provider = new NativeUrlProvider(self, hlsUrl, 'hls');
          self._providerName = self._provider.name;
          window._playerProvider = self._providerName;
          console.log('[player-engine] provider=' + self._providerName + ' mode=hls');
          return self._provider.load();
        }
        if (hlsUrl && !progressiveUrl) {
          if (!window.MediaSource) throw new Error('mse-unavailable');
          self._finalVia = (manifest.json.via || 'yt-dlp') + '/hls';
          self.emit('via', self._finalVia);
          self._provider = new NativeHlsProvider(self, hlsUrl);
          self._providerName = self._provider.name;
          window._playerProvider = self._providerName;
          console.log('[player-engine] provider=' + self._providerName + ' mode=hls');
          return self._provider.load();
        }
        if (progressiveUrl) {
          self._finalVia = (manifest.json.via || 'yt-dlp') + '/progressive';
          self.emit('via', self._finalVia);
          self._provider = new NativeUrlProvider(self, progressiveUrl, 'progressive');
          self._providerName = self._provider.name;
          window._playerProvider = self._providerName;
          console.log('[player-engine] provider=' + self._providerName + ' mode=progressive');
          return self._provider.load();
        }
        var jsonErr = new Error(manifest.json.error || 'No suitable formats found');
        jsonErr.serverError = true;
        jsonErr.permanent = /live event|Premieres in|not currently live/i.test(jsonErr.message);
        if (manifest.json.scheduledStart) jsonErr.scheduledStart = manifest.json.scheduledStart;
        throw jsonErr;
      }
      if (!window.MediaSource) throw new Error('mse-unavailable');
      self._provider = new NativeDashProvider(self, manifest.url, manifest.text);
      self._providerName = self._provider.name;
      window._playerProvider = self._providerName;
      console.log('[player-engine] provider=native-dash');
      return self._provider.load();
    });
  };

  PlayerEngine.prototype._completeNativeTerminalError = function (err) {
    var reason = err && err.message ? err.message : 'native-unsupported';
    this._nativeTerminalReason = reason;
    if (this._provider) {
      this._provider.lastError = reason;
      this._provider.fatalError = reason;
      this._provider.nativeUnsupportedReason = reason;
    } else {
      this._providerName = this._providerName || 'native-terminal';
      window._playerProvider = this._providerName;
    }
    this._setState('error');
    this._telemetry.record('native-unsupported', {
      lastError: reason,
      hlsEncryptionMethod: err && err.hlsEncryptionMethod ? err.hlsEncryptionMethod : '',
      hlsKeyFormat: err && err.hlsKeyFormat ? err.hlsKeyFormat : ''
    });
    return Promise.resolve();
  };

  PlayerEngine.prototype._recordManifestSource = function (manifest) {
    var fromSw = !!(manifest && (manifest.swCached || manifest.swOffline || manifest.swSource));
    if (!fromSw) return;
    this._manifestFromServiceWorker = true;
    this._offlinePlayback = !!(manifest.swOffline || !isOnline());
  };

  PlayerEngine.prototype._recordOfflineSource = function (source, offline, cached) {
    if (cached) this._offlinePlayback = true;
    if (offline) this._offlinePlayback = true;
    if (source === 'miss') this._lastOfflineError = 'offline-cache-miss';
  };

  PlayerEngine.prototype._recordOfflineError = function (err) {
    this._offlinePlayback = true;
    this._lastOfflineError = err && err.message ? err.message : 'offline-native-playback-error';
  };

  PlayerEngine.prototype._shouldKeepNativeOffline = function (err) {
    if (this._offlinePlayback || this._manifestFromServiceWorker || !isOnline()) {
      this._recordOfflineError(err);
      return true;
    }
    return false;
  };

  PlayerEngine.prototype._setState = function (state) {
    if (this._state === state) return;
    this._state = state;
    this.recovering = state === 'recovering';
    this.recoveryTransition = state === 'recovering' || state === 'seeking';
    this.networkTrouble = this._serverDown;
    console.debug('[player-engine] state=' + state + ' provider=' + (this._providerName || 'none'));
  };

  PlayerEngine.prototype._setRecovering = function (recovering) {
    this._recovering = recovering;
    this._setState(recovering ? 'recovering' : 'ready');
  };

  PlayerEngine.prototype.seekDuringRecovery = function (targetTime) {
    this.lastGoodTime = targetTime;
    if (this._provider && this._provider.seekDuringRecovery) {
      this._provider.seekDuringRecovery(targetTime);
    } else {
      this.video.currentTime = targetTime;
    }
  };

  PlayerEngine.prototype._destroyProvider = function () {
    if (this._provider) {
      try { this._provider.destroy(); } catch (e) {}
      this._provider = null;
    }
  };

  PlayerEngine.prototype._enterServerDown = function (reason) {
    if (this._serverDown || this.destroyed) return;
    this._serverDown = true;
    this.networkTrouble = true;
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
    this.networkTrouble = false;
    this._stopServerProbe();
    this.lastGoodTime = Math.max(this.lastGoodTime, this.video.currentTime || 0);
    console.log('[player-engine] server back, releasing ' + this._heldRequests.length + ' held requests');
    var held = this._heldRequests;
    this._heldRequests = [];
    for (var i = 0; i < held.length; i++) held[i]();
    this.emit('server-up');
    this.emit('recovery-end', { method: 'seamless', time: this.video.currentTime, via: this._finalVia });
  };

  PlayerEngine.prototype._waitForServerRecovery = function () {
    var self = this;
    if (!this._serverDown) return Promise.resolve();
    return new Promise(function (resolve, reject) {
      self._heldRequests.push(function (err) {
        if (err) {
          reject(err);
          return;
        }
        if (self.destroyed) {
          reject(new Error('player-destroyed'));
          return;
        }
        resolve();
      });
    });
  };

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
        if (self._serverDown) self._exitServerDown();
      })
      .catch(function () {
        self._refreshingToken = false;
        self._stopServerProbe();
        self._serverDown = false;
        self.emit('auth-expired');
      });
  };

  PlayerEngine.prototype._getBufferAhead = function () {
    return getBufferAhead(this.video);
  };

  PlayerEngine.prototype.unload = function () {
    this._stopServerProbe();
    this._clearHeldRequests('player-unloaded');
    this._serverDown = false;
    this._recovering = false;
    this.recovering = false;
    this.recoveryTransition = false;
    this.networkTrouble = false;
    this._networkHoldStartedAt = 0;
    this._fallbackReason = '';
    this._destroyProvider();
    this._providerName = '';
    window._playerProvider = '';
    if (this._textController) {
      try { this._textController.setTextTrackVisibility(false); } catch (e) {}
      if ('activeTrackId' in this._textController) this._textController.activeTrackId = '';
    }
    clearMediaElement(this.video);
    this._setState('idle');
    return Promise.resolve();
  };

  PlayerEngine.prototype.destroy = function () {
    if (this.destroyed) return;
    this._telemetry.record('unload-summary');
    this._telemetry.flush();
    this.destroyed = true;
    this._setState('destroyed');
    this._serverDown = false;
    this._recovering = false;
    this.recovering = false;
    this.recoveryTransition = false;
    this.networkTrouble = false;
    this._stopServerProbe();
    this._clearHeldRequests('player-destroyed');
    this._networkHoldStartedAt = 0;
    this._destroyProvider();
    this._runCleanups();
    this._telemetry.destroy();
    this._listeners = {};
  };

  PlayerEngine.prototype.reportStall = function () {
    if (this._serverDown) return;
    this._telemetry.record('stall-report');
    if (this._provider && this._provider.reportStall) {
      this._provider.reportStall();
      return;
    }
    this._enterServerDown('stall');
  };

  function PlayerTelemetry(engine) {
    this.engine = engine;
    this.events = [];
    this.attached = false;
    this.flushTimer = 0;
    this.firstFrameAt = 0;
    this.destroyed = false;
    this.unloadSummaryRecorded = false;
    this._onLoadedData = null;
    this._onError = null;
    this._onPageHide = null;
    this._onBeforeUnload = null;
  }

  PlayerTelemetry.prototype.attach = function () {
    if (this.attached || this.destroyed) return;
    this.attached = true;
    var self = this;
    var video = this.engine.video;
    this._onLoadedData = function () {
      if (!self.firstFrameAt) {
        self.firstFrameAt = performance.now();
        self.record('first-frame');
      }
    };
    this._onError = function () {
      var err = video.error;
      self.record('fatal-error', { lastError: err ? 'video-error-' + err.code : 'video-error' });
    };
    this._onPageHide = this._onBeforeUnload = function () {
      self.record('unload-summary');
      self.flush();
    };
    video.addEventListener('loadeddata', this._onLoadedData);
    video.addEventListener('error', this._onError);
    window.addEventListener('pagehide', this._onPageHide);
    window.addEventListener('beforeunload', this._onBeforeUnload);
  };

  PlayerTelemetry.prototype.record = function (type, extra) {
    if (window.__disablePlayerTelemetry || this.destroyed) return;
    if (type === 'unload-summary') {
      if (this.unloadSummaryRecorded) return;
      this.unloadSummaryRecorded = true;
    }
    var engine = this.engine;
    if (!engine || engine.destroyed && type !== 'unload-summary') return;
    var stats = {};
    try { stats = engine._player.getStats() || {}; } catch (e) {}
    var active = stats.activeVariant || {};
    var event = {
      type: type,
      videoId: engine.videoId || '',
      provider: stats.provider || engine._providerName || '',
      mode: stats.mode || '',
      fallbackReason: stats.fallbackReason || engine._fallbackReason || '',
      transmuxerProvider: stats.transmuxerProvider || '',
      transmuxedSegmentCount: stats.transmuxedSegmentCount || 0,
      lastError: stats.lastError || '',
      lastHttpStatus: stats.lastHttpStatus || 0,
      activeHeight: active.height || 0,
      bandwidthEstimate: stats.bandwidthEstimate || 0,
      bufferAhead: stats.bufferAhead || 0,
      activeAudio: stats.activeAudio || null,
      activeTextTrack: stats.activeTextTrack || null,
      rebufferCount: stats.rebufferCount || 0,
      rebufferDuration: stats.rebufferDuration || 0,
      recoveryCount: stats.recoveryCount || 0,
      mediaFetchRetryCount: stats.mediaFetchRetryCount || 0,
      mediaUrlRefreshCount: stats.mediaUrlRefreshCount || 0,
      networkHoldCount: stats.networkHoldCount || 0,
      networkResumeCount: stats.networkResumeCount || 0,
      networkHoldMs: stats.networkHoldMs || 0,
      networkHoldReason: stats.networkHoldReason || "",
      lastRecoveryReason: stats.lastRecoveryReason || '',
      manifestRefreshReason: stats.manifestRefreshReason || '',
      offlinePlayback: !!stats.offlinePlayback,
      manifestFromServiceWorker: !!stats.manifestFromServiceWorker,
      segmentCacheHitCount: stats.segmentCacheHitCount || 0,
      segmentCacheMissCount: stats.segmentCacheMissCount || 0,
      lastOfflineError: stats.lastOfflineError || '',
      droppedFrames: stats.droppedFrames || 0,
      totalFrames: stats.totalFrames || 0,
      startupMs: engine._loadStartedAt ? Math.round(performance.now() - engine._loadStartedAt) : 0,
      firstFrameMs: this.firstFrameAt && engine._loadStartedAt ? Math.round(this.firstFrameAt - engine._loadStartedAt) : 0,
      at: engine.video && isFinite(engine.video.currentTime) ? engine.video.currentTime : 0,
      ts: Date.now()
    };
    if (extra) merge(event, extra);
    this.events.push(event);
    if (this.events.length > 30) this.events.splice(0, this.events.length - 30);
    this.scheduleFlush();
  };

  PlayerTelemetry.prototype.scheduleFlush = function () {
    var self = this;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(function () {
      self.flushTimer = 0;
      self.flush();
    }, 500);
  };

  PlayerTelemetry.prototype.flush = function () {
    if (!this.events.length || window.__disablePlayerTelemetry) return;
    if (!isOnline()) return;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = 0;
    }
    var payload = JSON.stringify({ events: this.events.splice(0, 20) });
    try {
      if (navigator.sendBeacon) {
        var blob = new Blob([payload], { type: 'application/json' });
        if (navigator.sendBeacon('/api/player-events', blob)) return;
      }
    } catch (e) {}
    try {
      fetch('/api/player-events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        keepalive: true
      }).catch(function () {});
    } catch (e) {}
  };

  PlayerTelemetry.prototype.destroy = function () {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = 0;
    }
    var video = this.engine && this.engine.video;
    if (video && this._onLoadedData) video.removeEventListener('loadeddata', this._onLoadedData);
    if (video && this._onError) video.removeEventListener('error', this._onError);
    if (this._onPageHide) window.removeEventListener('pagehide', this._onPageHide);
    if (this._onBeforeUnload) window.removeEventListener('beforeunload', this._onBeforeUnload);
    this._onLoadedData = null;
    this._onError = null;
    this._onPageHide = null;
    this._onBeforeUnload = null;
    this.attached = false;
    this.events = [];
  };

  function PlayerAdapter(engine) {
    this.engine = engine;
    this.events = {};
    this.config = {
      abr: {
        enabled: true,
        useNetworkInformation: true,
        defaultBandwidthEstimate: 3000000,
        bandwidthUpgradeTarget: 0.85,
        bandwidthDowngradeTarget: 0.95,
        restrictions: {}
      },
      streaming: {
        maxConcurrentRequests: MAX_CONCURRENT_MEDIA_REQUESTS,
        bufferingGoal: BUFFER_AHEAD,
        rebufferingGoal: 0.3,
        bufferBehind: BUFFER_BEHIND,
        startupBufferGoal: STARTUP_BUFFER_GOAL,
        seekBufferGoal: STARTUP_BUFFER_GOAL,
        retryParameters: {
          maxAttempts: 3,
          baseDelay: 250,
          backoffFactor: 2
        }
      },
      manifest: { availabilityWindowOverride: null },
      drm: { servers: {}, clearKeys: {} }
    };
    this.playbackRateChangeCount = 0;
    this.lastPlaybackRate = engine && engine.video && isFinite(engine.video.playbackRate) ? engine.video.playbackRate : 1;
    this.iframePreviewRequestCount = 0;
    this.iframePreviewSuccessCount = 0;
    this.iframePreviewMissCount = 0;
    this.lastIFramePreviewTime = -1;
    this.lastIFramePreviewTrackId = '';
  }

  PlayerAdapter.prototype.load = function (url, startTime, mimeType) {
    return this.engine.load(url, startTime, mimeType);
  };

  PlayerAdapter.prototype.configure = function (keyOrConfig, value) {
    if (typeof keyOrConfig === 'string') {
      setPath(this.config, keyOrConfig, value);
    } else if (keyOrConfig) {
      merge(this.config, keyOrConfig);
    }
    if (this.engine._provider && this.engine._provider.configure) {
      this.engine._provider.configure(this.config);
    }
  };

  PlayerAdapter.prototype.getConfiguration = function () {
    return clonePlain(this.config);
  };

  PlayerAdapter.prototype.getNetworkingEngine = function () {
    return this.engine._networkingEngine;
  };

  PlayerAdapter.prototype.getPlaybackRate = function () {
    var rate = this.engine && this.engine.video ? Number(this.engine.video.playbackRate) : 1;
    return isFinite(rate) && rate > 0 ? rate : 1;
  };

  PlayerAdapter.prototype.setPlaybackRate = function (rate) {
    rate = Number(rate);
    if (!isFinite(rate)) return this.getPlaybackRate();
    rate = clamp(rate, 0.25, 2);
    var previous = this.getPlaybackRate();
    try { this.engine.video.playbackRate = rate; } catch (e) {}
    var current = this.getPlaybackRate();
    if (Math.abs(current - previous) > 0.001) {
      this.playbackRateChangeCount++;
      this.lastPlaybackRate = current;
      if (this.engine && this.engine._telemetry) this.engine._telemetry.record('playback-rate-change', { playbackRate: current });
      this.emit('ratechange', { playbackRate: current });
    }
    return current;
  };

  PlayerAdapter.prototype.trickPlay = function (rate) {
    return this.setPlaybackRate(rate);
  };

  PlayerAdapter.prototype.cancelTrickPlay = function () {
    return this.setPlaybackRate(1);
  };

  PlayerAdapter.prototype.getVariantTracks = function () {
    return this.engine._provider && this.engine._provider.getVariantTracks
      ? this.engine._provider.getVariantTracks()
      : [];
  };

  PlayerAdapter.prototype.getActiveVariantTrack = function () {
    return this.engine._provider && this.engine._provider.getActiveVariantTrack
      ? this.engine._provider.getActiveVariantTrack()
      : null;
  };

  PlayerAdapter.prototype.getAudioTracks = function () {
    return this.engine._provider && this.engine._provider.getAudioTracks
      ? this.engine._provider.getAudioTracks()
      : [];
  };

  PlayerAdapter.prototype.getActiveAudioTrack = function () {
    return this.engine._provider && this.engine._provider.getActiveAudioTrack
      ? this.engine._provider.getActiveAudioTrack()
      : null;
  };

  PlayerAdapter.prototype.selectAudioTrack = function (track) {
    if (this.engine._provider && this.engine._provider.selectAudioTrack) {
      this.engine._provider.selectAudioTrack(track);
    }
  };

  PlayerAdapter.prototype.getTextTracks = function () {
    var tracks = this.engine._textController ? this.engine._textController.getTextTracks() : [];
    if (this.engine._provider && this.engine._provider.getTextTracks) {
      tracks = tracks.concat(this.engine._provider.getTextTracks());
    }
    return tracks;
  };

  PlayerAdapter.prototype.getActiveTextTrack = function () {
    var active = this.engine._textController ? this.engine._textController.getActiveTextTrack() : null;
    if (active) return active;
    return this.engine._provider && this.engine._provider.getActiveTextTrack ? this.engine._provider.getActiveTextTrack() : null;
  };

  PlayerAdapter.prototype.selectTextTrack = function (track) {
    if (this.engine._textController) {
      var controllerTracks = this.engine._textController.getTextTracks();
      var controllerMatch = controllerTracks.find(function (item) { return item.id === track.id; });
      if (controllerMatch) return this.engine._textController.selectTextTrack(track);
    }
    return this.engine._provider && this.engine._provider.selectTextTrack
      ? this.engine._provider.selectTextTrack(track)
      : Promise.resolve();
  };

  PlayerAdapter.prototype.setTextTrackVisibility = function (visible) {
    var providerPromise = this.engine._provider && this.engine._provider.setTextTrackVisibility
      ? this.engine._provider.setTextTrackVisibility(visible)
      : Promise.resolve();
    if (this.engine._textController) {
      return Promise.resolve(this.engine._textController.setTextTrackVisibility(visible)).then(function () { return providerPromise; });
    }
    return providerPromise;
  };

  PlayerAdapter.prototype.getStats = function () {
    var stats = this.engine._provider && this.engine._provider.getStats
      ? this.engine._provider.getStats()
      : {};
    if (!this.engine._provider && this.engine._nativeTerminalReason) {
      stats.provider = this.engine._providerName || 'native-terminal';
      stats.mode = 'native-terminal';
      stats.fallbackReason = '';
      stats.lastError = this.engine._nativeTerminalReason;
      stats.fatalError = this.engine._nativeTerminalReason;
      stats.nativeUnsupportedReason = this.engine._nativeTerminalReason;
    }
    stats = mergeNetworkStats(this.engine, stats || {});
    stats.playbackRate = this.getPlaybackRate();
    stats.playbackRateChangeCount = this.playbackRateChangeCount || 0;
    stats.lastPlaybackRate = this.lastPlaybackRate || stats.playbackRate;
    stats.iframePreviewRequestCount = this.iframePreviewRequestCount || 0;
    stats.iframePreviewSuccessCount = this.iframePreviewSuccessCount || 0;
    stats.iframePreviewMissCount = this.iframePreviewMissCount || 0;
    stats.lastIFramePreviewTime = isFinite(this.lastIFramePreviewTime) ? this.lastIFramePreviewTime : -1;
    stats.lastIFramePreviewTrackId = this.lastIFramePreviewTrackId || '';
    return stats;
  };

  PlayerAdapter.prototype.getIFrameTracks = function () {
    return this.engine._provider && this.engine._provider.getIFrameTracks
      ? this.engine._provider.getIFrameTracks()
      : [];
  };

  PlayerAdapter.prototype.getIFramePreview = function (time, trackId) {
    var self = this;
    this.iframePreviewRequestCount++;
    this.lastIFramePreviewTime = isFinite(Number(time)) ? Number(time) : -1;
    this.lastIFramePreviewTrackId = trackId || '';
    var promise = this.engine._provider && this.engine._provider.getIFramePreview
      ? this.engine._provider.getIFramePreview(time, trackId)
      : Promise.resolve(null);
    return Promise.resolve(promise).then(function (preview) {
      if (preview) self.iframePreviewSuccessCount++;
      else self.iframePreviewMissCount++;
      return preview;
    }, function (err) {
      self.iframePreviewMissCount++;
      throw err;
    });
  };

  PlayerAdapter.prototype.getBufferedInfo = function () {
    if (this.engine._provider && this.engine._provider.getBufferedInfo) {
      return this.engine._provider.getBufferedInfo();
    }
    return getBufferedInfoFor(this.engine.video, null, null);
  };

  PlayerAdapter.prototype.getPlayheadTime = function () {
    return this.engine && this.engine.video && isFinite(this.engine.video.currentTime)
      ? this.engine.video.currentTime
      : 0;
  };

  PlayerAdapter.prototype.getPresentationStartTime = function () {
    var range = this.getLiveRange();
    return range && isFinite(range.start) ? range.start : 0;
  };

  PlayerAdapter.prototype.seekRange = function () {
    if (this.engine._provider && this.engine._provider.seekRange) {
      return this.engine._provider.seekRange();
    }
    var range = this.getLiveRange();
    if (range && range.end > range.start) return range;
    return mediaSeekRange(this.engine.video);
  };

  PlayerAdapter.prototype.beginSeek = function (targetTime) {
    if (this.engine._provider && this.engine._provider.beginSeek) {
      return this.engine._provider.beginSeek(targetTime);
    }
    if (this.engine && this.engine._setState) this.engine._setState('seeking');
    return isFinite(Number(targetTime)) ? Number(targetTime) : (this.engine.video.currentTime || 0);
  };

  PlayerAdapter.prototype.commitSeek = function (targetTime) {
    if (this.engine._provider && this.engine._provider.commitSeek) {
      return this.engine._provider.commitSeek(targetTime);
    }
    var target = isFinite(Number(targetTime)) ? Number(targetTime) : (this.engine.video.currentTime || 0);
    try { this.engine.video.currentTime = target; } catch (e) {}
    return this.engine.video.currentTime || target;
  };

  PlayerAdapter.prototype.cancelSeek = function () {
    if (this.engine._provider && this.engine._provider.cancelSeek) {
      return this.engine._provider.cancelSeek();
    }
    if (this.engine && this.engine._setState && !this.engine._serverDown) this.engine._setState('ready');
  };

  PlayerAdapter.prototype.endSeek = function () {
    if (this.engine._provider && this.engine._provider.endSeek) {
      return this.engine._provider.endSeek();
    }
    if (this.engine && this.engine._setState && !this.engine._serverDown) this.engine._setState('ready');
  };

  PlayerAdapter.prototype.selectVariantTrack = function (track, clearBuffer) {
    if (this.engine._provider && this.engine._provider.selectVariantTrack) {
      this.engine._provider.selectVariantTrack(track, clearBuffer);
    }
  };

  PlayerAdapter.prototype.getAssetUri = function () {
    return this.engine._provider && this.engine._provider.isAdaptive ? this.engine._assetUri : null;
  };

  PlayerAdapter.prototype.isLive = function () {
    return this.engine._provider && this.engine._provider.isLive ? this.engine._provider.isLive() : false;
  };

  PlayerAdapter.prototype.getLiveRange = function () {
    return this.engine._provider && this.engine._provider.getLiveRange ? this.engine._provider.getLiveRange() : null;
  };

  PlayerAdapter.prototype.seekToLiveEdge = function () {
    if (this.engine._provider && this.engine._provider.seekToLiveEdge) {
      this.engine._provider.seekToLiveEdge();
    }
  };

  PlayerAdapter.prototype.addEventListener = function (event, fn) {
    if (!this.events[event]) this.events[event] = [];
    this.events[event].push(fn);
  };

  PlayerAdapter.prototype.removeEventListener = function (event, fn) {
    var list = this.events[event];
    if (!list) return;
    this.events[event] = list.filter(function (f) { return f !== fn; });
  };

  PlayerAdapter.prototype.emit = function (event, detail) {
    if (this.engine && this.engine._telemetry) {
      if (event === 'loaded') this.engine._telemetry.record('loaded');
      if (event === 'variantchanged') this.engine._telemetry.record('quality-switch');
      if (event === 'audiotrackchanged') this.engine._telemetry.record('audio-switch');
      if (event === 'texttrackchanged') this.engine._telemetry.record('caption-switch');
    }
    var list = this.events[event] || [];
    for (var i = 0; i < list.length; i++) {
      try { list[i]({ type: event, detail: detail }); } catch (e) {}
    }
  };

  PlayerAdapter.prototype.destroy = function () {
    this.engine.destroy();
    return Promise.resolve();
  };

  PlayerAdapter.prototype.unload = function () {
    return this.engine.unload();
  };

  function NativeNetworkingEngine(engine) {
    this.engine = engine;
    this.requestFilters = [];
    this.responseFilters = [];
    this.stats = {
      requestCount: 0,
      manifestRequestCount: 0,
      segmentRequestCount: 0,
      licenseRequestCount: 0,
      keyRequestCount: 0,
      otherRequestCount: 0,
      lastRequestType: '',
      lastStatus: 0,
      filterErrorCount: 0,
      totalRequestMs: 0,
      networkHoldCount: 0,
      networkHeldRequestCount: 0,
      networkResumeCount: 0,
      networkHoldReason: "",
      networkHoldMs: 0
    };
    this.RequestType = NativeNetworkingEngine.RequestType;
  }

  NativeNetworkingEngine.RequestType = {
    MANIFEST: 'MANIFEST',
    SEGMENT: 'SEGMENT',
    LICENSE: 'LICENSE',
    KEY: 'KEY',
    OTHER: 'OTHER'
  };

  NativeNetworkingEngine.prototype.registerRequestFilter = function (filter) {
    if (typeof filter === 'function' && this.requestFilters.indexOf(filter) === -1) this.requestFilters.push(filter);
  };

  NativeNetworkingEngine.prototype.unregisterRequestFilter = function (filter) {
    removeItem(this.requestFilters, filter);
  };

  NativeNetworkingEngine.prototype.clearAllRequestFilters = function () {
    this.requestFilters = [];
  };

  NativeNetworkingEngine.prototype.registerResponseFilter = function (filter) {
    if (typeof filter === 'function' && this.responseFilters.indexOf(filter) === -1) this.responseFilters.push(filter);
  };

  NativeNetworkingEngine.prototype.unregisterResponseFilter = function (filter) {
    removeItem(this.responseFilters, filter);
  };

  NativeNetworkingEngine.prototype.clearAllResponseFilters = function () {
    this.responseFilters = [];
  };

  NativeNetworkingEngine.prototype.request = function (type, request, opts) {
    var self = this;
    opts = opts || {};
    type = type || NativeNetworkingEngine.RequestType.OTHER;
    request = normalizeNetworkRequest(request);
    var started = performance.now();
    this._recordRequestStart(type);
    return applyNetworkFilters(this.requestFilters, type, request, "request", this).then(function () {
      return self._attemptRequest(type, request, opts, started);
    });
  };

  NativeNetworkingEngine.prototype._attemptRequest = function (type, request, opts, started) {
    var self = this;
    var uri = request.uris && request.uris.length ? request.uris[0] : "";
    var fetchUri = stampUri(this.engine, uri);
    var init = {
      method: request.method || "GET",
      headers: request.headers || {}
    };
    if (opts.signal) init.signal = opts.signal;
    if (request.body != null) init.body = request.body;
    return fetch(fetchUri, init).then(function (resp) {
      return resp.arrayBuffer().then(function (data) {
        var elapsed = Math.max(0, performance.now() - started);
        var response = {
          uri: resp.url || fetchUri,
          originalUri: uri,
          data: data,
          status: resp.status,
          headers: headersToObject(resp.headers),
          timeMs: elapsed
        };
        self._recordResponse(type, resp.status, elapsed);
        if (shouldHoldNetworkResponse(self.engine, type, response, opts)) {
          return self._holdAndRetry(type, request, opts, started, networkHoldReasonForStatus(resp.status), resp.status);
        }
        return applyNetworkFilters(self.responseFilters, type, response, "response", self).then(function () {
          return response;
        });
      });
    }).catch(function (err) {
      if (err && err.name === "AbortError") throw err;
      if (shouldHoldNetworkError(self.engine, type, err, opts)) {
        return self._holdAndRetry(type, request, opts, started, "network-error", 0);
      }
      throw err;
    });
  };

  NativeNetworkingEngine.prototype._holdAndRetry = function (type, request, opts, started, reason, status) {
    var self = this;
    var holdStarted = performance.now();
    this._recordNetworkHold(reason, status);
    if (status === 401 && this.engine && this.engine._refreshToken) this.engine._refreshToken();
    if (this.engine && this.engine._enterServerDown) this.engine._enterServerDown(reason);
    if (this.engine && this.engine._telemetry) this.engine._telemetry.record("server-down", { networkHoldReason: reason, lastHttpStatus: status || 0 });
    if (!this.engine || !this.engine._waitForServerRecovery) throw new Error(reason || "network-hold-unavailable");
    return this.engine._waitForServerRecovery().then(function () {
      self._recordNetworkResume(holdStarted);
      if (self.engine && self.engine._telemetry) self.engine._telemetry.record("server-up", { networkHoldReason: reason, lastHttpStatus: status || 0 });
      return self._attemptRequest(type, request, opts, started);
    });
  };

  NativeNetworkingEngine.prototype._recordRequestStart = function (type) {
    this.stats.requestCount++;
    this.stats.lastRequestType = type;
    if (type === NativeNetworkingEngine.RequestType.MANIFEST) this.stats.manifestRequestCount++;
    else if (type === NativeNetworkingEngine.RequestType.SEGMENT) this.stats.segmentRequestCount++;
    else if (type === NativeNetworkingEngine.RequestType.LICENSE) this.stats.licenseRequestCount++;
    else if (type === NativeNetworkingEngine.RequestType.KEY) this.stats.keyRequestCount++;
    else this.stats.otherRequestCount++;
  };

  NativeNetworkingEngine.prototype._recordResponse = function (type, status, elapsed) {
    this.stats.lastRequestType = type;
    this.stats.lastStatus = status || 0;
    this.stats.totalRequestMs += elapsed || 0;
  };

  NativeNetworkingEngine.prototype._recordFilterError = function () {
    this.stats.filterErrorCount++;
  };

  NativeNetworkingEngine.prototype._recordNetworkHold = function (reason) {
    this.stats.networkHoldCount++;
    this.stats.networkHeldRequestCount++;
    this.stats.networkHoldReason = reason || "network-error";
  };

  NativeNetworkingEngine.prototype._recordNetworkResume = function (holdStarted) {
    this.stats.networkResumeCount++;
    this.stats.networkHeldRequestCount = Math.max(0, (this.stats.networkHeldRequestCount || 0) - 1);
    this.stats.networkHoldMs += Math.max(0, performance.now() - (holdStarted || performance.now()));
  };

  function NativeUrlProvider(engine, url, mode) {
    this.engine = engine;
    this.video = engine.video;
    this.url = url;
    this.mode = mode || (url.indexOf('.m3u8') !== -1 ? 'hls' : 'progressive');
    this.name = 'native-url';
    this.isAdaptive = false;
    this.retryCount = 0;
    this.recoveryCount = 0;
    this.rebufferCount = 0;
    this.rebufferStartedAt = 0;
    this.rebufferDuration = 0;
    this.lastError = '';
    this.fatalError = '';
    this.nativeUnsupportedReason = '';
    this.assetUri = '';
  }

  NativeUrlProvider.prototype.load = function () {
    var self = this;
    if (this.mode === 'hls' && !canPlayNativeHls(this.video)) return Promise.reject(new Error('hls-unsupported'));
    this.assetUri = stampUri(this.engine, this.url);
    this.video.src = this.assetUri;
    this.video.load();
    return new Promise(function (resolve, reject) {
      function cleanup() {
        self.video.removeEventListener('loadedmetadata', onLoaded);
        self.video.removeEventListener('error', onError);
      }
      function onLoaded() {
        cleanup();
        self.video.addEventListener('waiting', self._boundWaiting = function () { self._onWaiting(); });
        self.video.addEventListener('playing', self._boundPlaying = function () { self._onPlaying(); });
        self.video.addEventListener('error', self._boundRuntimeError = function () { self._onRuntimeError(); });
        self.engine._setState('ready');
        self.engine._player.emit('loaded');
        resolve();
      }
      function onError() {
        if (self.retryCount < 1) {
          self.retryCount++;
          self.recoveryCount++;
          self.lastError = 'native-url-load-error';
          var pos = self.video.currentTime || self.engine.lastGoodTime || 0;
          self.video.src = stampUri(self.engine, self.url);
          self.video.load();
          if (pos > 0) {
            self.video.addEventListener('loadedmetadata', function restoreTime() {
              try { self.video.currentTime = pos; } catch (e) {}
            }, { once: true });
          }
          return;
        }
        cleanup();
        self.lastError = 'native-url-error';
        self.fatalError = 'native-url-error';
        reject(nativeTerminalError(self, 'native-url-error'));
      }
      self.video.addEventListener('loadedmetadata', onLoaded);
      self.video.addEventListener('error', onError);
    });
  };

  NativeUrlProvider.prototype.destroy = function () {
    if (this._boundWaiting) this.video.removeEventListener('waiting', this._boundWaiting);
    if (this._boundPlaying) this.video.removeEventListener('playing', this._boundPlaying);
    if (this._boundRuntimeError) this.video.removeEventListener('error', this._boundRuntimeError);
    this.video.removeAttribute('src');
    this.video.load();
  };

  NativeUrlProvider.prototype.getVariantTracks = function () {
    var h = this.video.videoHeight || 0;
    return h ? [{ id: 'native', height: h, active: true }] : [];
  };

  NativeUrlProvider.prototype.getActiveVariantTrack = function () {
    var h = this.video.videoHeight || 0;
    return h ? { id: 'native', height: h, active: true } : null;
  };

  NativeUrlProvider.prototype.getAudioTracks = function () {
    return [{ id: 'native', active: true, language: '', label: 'Default', bandwidth: 0, codecs: '', audioSamplingRate: 0 }];
  };

  NativeUrlProvider.prototype.getActiveAudioTrack = function () {
    return this.getAudioTracks()[0];
  };

  NativeUrlProvider.prototype.getBufferedInfo = function () {
    return getBufferedInfoFor(this.video, null, null);
  };

  NativeUrlProvider.prototype.getStats = function () {
    var quality = this.video.getVideoPlaybackQuality ? this.video.getVideoPlaybackQuality() : null;
    var bufferedInfo = this.getBufferedInfo();
    var bufferedSummary = summarizeBufferedInfo(bufferedInfo);
    return {
      provider: this.name,
      mode: this.mode,
      isLive: this.isLive(),
      assetUri: this.assetUri || this.url,
      fallbackReason: this.engine ? (this.engine._fallbackReason || '') : '',
      bufferAhead: getBufferAhead(this.video),
      bufferedRangeCount: bufferedSummary.count,
      bufferedStart: bufferedSummary.start,
      bufferedEnd: bufferedSummary.end,
      activeVariant: this.getActiveVariantTrack(),
      activeAudio: this.getActiveAudioTrack(),
      audioTrackCount: this.getAudioTracks().length,
      activeTextTrack: this.engine && this.engine._player ? this.engine._player.getActiveTextTrack() : null,
      textTrackCount: this.engine && this.engine._player ? this.engine._player.getTextTracks().length : 0,
      droppedFrames: quality ? quality.droppedVideoFrames : 0,
      totalFrames: quality ? quality.totalVideoFrames : 0,
      rebufferCount: this.rebufferCount,
      rebufferDuration: this.rebufferDuration + (this.rebufferStartedAt ? (performance.now() - this.rebufferStartedAt) / 1000 : 0),
      recoveryCount: this.recoveryCount,
      quotaRecoveries: this.quotaRecoveries,
      lastError: this.lastError,
      lastHttpStatus: 0,
      offlinePlayback: !!(this.engine && this.engine._offlinePlayback),
      manifestFromServiceWorker: !!(this.engine && this.engine._manifestFromServiceWorker),
      segmentCacheHitCount: 0,
      segmentCacheMissCount: 0,
      lastOfflineError: this.engine ? (this.engine._lastOfflineError || '') : '',
      nativeUnsupportedReason: this.nativeUnsupportedReason || '',
      fatalError: this.fatalError
    };
  };

  NativeUrlProvider.prototype.isLive = function () {
    if (this.mode === 'hls' && !isFinite(this.video.duration)) return true;
    return !!(this.engine && this.engine.isLive);
  };

  NativeUrlProvider.prototype._onWaiting = function () {
    if (this.rebufferStartedAt || this.video.paused || this.video.seeking) return;
    this.rebufferStartedAt = performance.now();
    this.rebufferCount++;
    this.lastError = getBufferAhead(this.video) < 0.5 ? 'buffer-underrun' : this.lastError;
    this.engine._telemetry.record('rebuffer-start');
  };

  NativeUrlProvider.prototype._onPlaying = function () {
    if (!this.rebufferStartedAt) return;
    this.rebufferDuration += (performance.now() - this.rebufferStartedAt) / 1000;
    this.rebufferStartedAt = 0;
    this.engine._telemetry.record('rebuffer-end');
  };

  NativeUrlProvider.prototype._onRuntimeError = function () {
    if (this.retryCount < 1) {
      this.retryCount++;
      this.recoveryCount++;
      this.lastError = 'native-url-runtime-error';
      this.engine._telemetry.record('recovery', { lastError: this.lastError });
      var pos = this.video.currentTime || this.engine.lastGoodTime || 0;
      this.video.src = stampUri(this.engine, this.url);
      this.video.load();
      try { if (pos > 0) this.video.currentTime = pos; } catch (e) {}
      return;
    }
    this.fatalError = 'native-url-error';
    this.lastError = 'native-url-error';
    if (this.engine && this.engine._completeNativeTerminalError) {
      this.engine._completeNativeTerminalError(nativeTerminalError(this, 'native-url-error'));
    }
  };

  function NativeHlsProvider(engine, playlistUrl) {
    this.engine = engine;
    this.video = engine.video;
    this.playlistUrl = playlistUrl;
    this.name = 'native-hls';
    this.isAdaptive = true;
    this.mediaSource = null;
    this.objectUrl = '';
    this.sb = null;
    this.audioSb = null;
    this.mimeType = '';
    this.audioMimeType = '';
    this.variants = [];
    this.activeVariant = null;
    this.audioRenditions = [];
    this.subtitleRenditions = [];
    this.activeAudio = null;
    this.segments = [];
    this.initSegment = null;
    this.audioSegments = [];
    this.audioInitSegment = null;
    this.activeRanges = {};
    this.controllers = [];
    this.destroyed = false;
    this.bandwidth = engine._player.config.abr.defaultBandwidthEstimate || 3000000;
    this.bandwidthSamples = 0;
    this.lastBandwidthSample = 0;
    this.rebufferCount = 0;
    this.rebufferStartedAt = 0;
    this.rebufferDuration = 0;
    this.recoveryCount = 0;
    this.appendFailures = 0;
    this.quotaRecoveries = 0;
    this.stallReports = 0;
    this.stallRecoveryStage = 0;
    this.gapJumpCount = 0;
    this.lastGapSize = 0;
    this.blacklisted = {};
    this.capabilityProbeCount = 0;
    this.unsupportedCapabilityCount = 0;
    this.unsupportedVideoCount = 0;
    this.unsupportedAudioCount = 0;
    this.lastError = '';
    this.lastHttpStatus = 0;
    this.playlistRefreshCount = 0;
    this.liveLowBufferRefreshCount = 0;
    this.liveRefreshInFlight = false;
    this.lastLiveRefreshStartedAt = 0;
    this.mediaFetchCompletedCount = 0;
    this.mediaFetchRetryCount = 0;
    this.mediaFetchTotalMs = 0;
    this.mediaUrlRefreshCount = 0;
    this.segmentCacheHitCount = 0;
    this.segmentCacheMissCount = 0;
    this.lastOfflineError = '';
    this.lastServiceWorkerSource = '';
    this.schedulerDrainCount = 0;
    this.schedulerBackpressureCount = 0;
    this.sourceBufferAbortCount = 0;
    this.startupBufferComplete = false;
    this.startupBufferStartedAt = 0;
    this.startupBufferMs = 0;
    this.seekBufferPending = false;
    this.seekBufferReadyCount = 0;
    this.seekCount = 0;
    this.seekCancelCount = 0;
    this.seekAbortCount = 0;
    this.lastSeekTarget = 0;
    this.lastSeekStartedAt = 0;
    this.lastSeekMs = 0;
    this._lastSeekHandledTarget = null;
    this._lastSeekHandledAt = 0;
    this.lastSwitchReason = 'startup';
    this.liveWindow = null;
    this.liveLatency = 0;
    this.atLiveEdge = false;
    this.startupLiveTarget = null;
    this.liveStartupCandidate = false;
    this.liveStableSince = 0;
    this.liveWindowDriftRecoveryCount = 0;
    this.vodEndOfStreamCount = 0;
    this.mediaSequence = 0;
    this.discontinuitySequence = 0;
    this.discontinuityCount = 0;
    this.playlistRefreshFailed = false;
    this.manifestCompatibilityWarnings = [];
    this.tsTransmuxer = null;
    this.tsVideoTransmuxer = null;
    this.tsAudioTransmuxer = null;
    this.tsTransmuxers = { video: null, audio: null };
    this.tsTransmuxerProvider = '';
    this.tsTransmuxerLoadMs = 0;
    this.transmuxedSegmentCount = 0;
    this.transmuxedVideoSegmentCount = 0;
    this.transmuxedAudioSegmentCount = 0;
    this.isTsPlaylist = false;
    this.muxedTsAudio = false;
    this.hlsKeyCache = {};
    this.encryptedSegmentCount = 0;
    this.keyFetchCount = 0;
    this.keyCacheHitCount = 0;
    this.lastDecryptionError = '';
    this.hlsEncryptionMethod = '';
    this.hlsKeyFormat = '';
    this.nativeUnsupportedReason = '';
    this.fatalError = '';
    this.nativeRecoveryAttemptCount = 0;
    this.nativeRecoverySuccessCount = 0;
    this.lastNativeRecoveryReason = '';
    this.nativeRecoveryInProgress = false;
    this.nativeRecoveryReasons = {};
    this.activeTextTrackId = '';
    this.textTrackVisibility = false;
    this.textCueCache = {};
    this.textLoadStates = {};
    this.lastTextTrackError = '';
    this.timelineRegions = [];
    this.timelineRegionKeys = {};
    this.lastTimelineRegion = null;
    this.sessionData = [];
    this.sessionDataCount = 0;
    this.hlsChapterCount = 0;
    this.lastHlsChapterError = '';
    this.manifestStartTime = null;
    this.lowLatencyPlaylist = false;
    this.partialSegmentCount = 0;
    this.partialSegmentRequestCount = 0;
    this.partialSegmentAppendCount = 0;
    this.partialSegmentFallbackCount = 0;
    this.preloadHintRequestCount = 0;
    this.preloadHintCount = 0;
    this.renditionReportCount = 0;
    this.skippedSegmentCount = 0;
    this.iframeVariantCount = 0;
    this.iframePlaylists = {};
    this.iframePlaylistRequestCount = 0;
    this.iframeSegmentCount = 0;
    this.lastIFramePlaylistError = '';
    this.imageVariants = [];
    this.imageVariantCount = 0;
    this.imagePlaylists = {};
    this.imagePlaylistRequestCount = 0;
    this.imageSegmentCount = 0;
    this.lastImagePlaylistError = '';
    this.contentSteeringUri = '';
    this.contentSteeringReloadUri = '';
    this.contentSteeringPathwayId = '';
    this.contentSteeringPriority = [];
    this.contentSteeringTtl = 0;
    this.contentSteeringExpiresAt = 0;
    this.contentSteeringRequestCount = 0;
    this.contentSteeringSwitchCount = 0;
    this.lastContentSteeringError = '';
  }

  NativeHlsProvider.prototype.load = function () {
    var self = this;
    this.engine._assetUri = this.playlistUrl;
    return this._fetchPlaylistText(this.playlistUrl).then(function (text) {
      var parsed = parseHlsPlaylist(text, self.playlistUrl);
      if (parsed.unsupportedEncryption) throw hlsUnsupportedEncryptionError(self, parsed);
      self.iframeVariants = parsed.iframeVariants || [];
      self.iframeVariantCount = self.iframeVariants.length;
      self.imageVariants = parsed.imageVariants || [];
      self.imageVariantCount = self.imageVariants.length;
      self.sessionData = parsed.sessionData || [];
      self.sessionDataCount = self.sessionData.length;
      self.contentSteeringUri = parsed.contentSteeringUri || '';
      self.contentSteeringPathwayId = parsed.contentSteeringPathwayId || '';
      self.manifestCompatibilityWarnings = mergeUnique(self.manifestCompatibilityWarnings, parsed.warnings || []);
      var chapterPromise = self._loadHlsChapters(parsed);
      if (parsed.variants.length) {
        self.liveStartupCandidate = true;
        self.audioRenditions = parsed.audioRenditions;
        self.subtitleRenditions = parsed.subtitleRenditions.concat(parsed.closedCaptionRenditions || []);
        self.variants = parsed.variants.map(function (variant) {
          var rawCodecs = variant.codecs || '';
          variant.kind = 'video';
          variant.mimeType = 'video/mp4';
          variant.rawCodecs = rawCodecs;
          variant.audioCodecs = audioCodecsOnly(rawCodecs);
          variant.codecs = videoCodecsOnly(rawCodecs) || rawCodecs;
          return variant;
        }).sort(compareVideoReps);
        self.audioRenditions.forEach(function (rendition) {
          var rawCodecs = rendition.codecs || parsed.codecs || '';
          rendition.kind = 'audio';
          rendition.mimeType = 'audio/mp4';
          rendition.rawCodecs = rawCodecs;
          rendition.codecs = audioCodecsOnly(rawCodecs) || rawCodecs || 'mp4a.40.2';
          rendition.asr = 44100;
        });
        return chapterPromise.then(function () {
          return self._probeCapabilities(self.variants.concat(self.audioRenditions));
        }).then(function () {
          self.unsupportedVideoCount = self.variants.filter(function (variant) { return !MediaSource.isTypeSupported(mime(variant)); }).length;
          self.unsupportedAudioCount = self.audioRenditions.filter(function (rendition) { return !MediaSource.isTypeSupported(mime(rendition)); }).length;
          self.unsupportedCapabilityCount = self.variants.concat(self.audioRenditions).filter(function (rep) { return !capabilityAllowed(self, rep); }).length;
          return self._refreshContentSteering('initial');
        }).then(function () {
          self.activeVariant = self.chooseVariant();
          if (!self.activeVariant) throw nativeTerminalError(self, 'hls-no-supported-video');
          self.activeAudio = self._chooseAudioRendition(self.activeVariant);
          if (self.activeVariant.audioGroup && !self.activeAudio) throw nativeTerminalError(self, 'hls-no-supported-audio');
          return self._loadStartupMediaPlaylists();
        });
      }
      self.variants = [{ id: 'hls', url: self.playlistUrl, bandwidth: 0, height: 0, codecs: parsed.codecs || 'avc1.42c01f,mp4a.40.2', active: true }];
      self.variants[0].kind = 'video';
      self.variants[0].mimeType = 'video/mp4';
      self.variants[0].rawCodecs = self.variants[0].codecs;
      self.variants[0].audioCodecs = audioCodecsOnly(self.variants[0].rawCodecs);
      self.variants[0].codecs = videoCodecsOnly(self.variants[0].rawCodecs) || self.variants[0].codecs;
      self.activeVariant = self.variants[0];
      self.subtitleRenditions = (parsed.subtitleRenditions || []).concat(parsed.closedCaptionRenditions || []);
      return chapterPromise.then(function () {
        return self._loadMediaPlaylist(text, self.playlistUrl);
      });
    }).then(function () {
      return new Promise(function (resolve, reject) {
        self.mediaSource = new MediaSource();
        self.objectUrl = URL.createObjectURL(self.mediaSource);
        self.video.src = self.objectUrl;
        self.mediaSource.addEventListener('sourceopen', function () {
          self._open().then(resolve).catch(reject);
        }, { once: true });
      });
    });
  };

  NativeHlsProvider.prototype._loadMediaPlaylist = function (text, url) {
    var parsed = parseHlsPlaylist(text, url);
    if (parsed.unsupportedEncryption) throw hlsUnsupportedEncryptionError(this, parsed);
    var isTs = hasMpegTsSegments(parsed.segments);
    if (!parsed.map && !isTs) throw new Error('hls-playlist-unsupported');
    if (!parsed.segments.length) throw new Error('hls-playlist-unsupported');
    this.segments = mergeSegmentState(this.segments, parsed.segments) || parsed.segments;
    this.initSegment = parsed.map;
    this.isTsPlaylist = isTs;
    this.lowLatencyPlaylist = !!parsed.lowLatencyPlaylist;
    this.partialSegmentCount = parsed.partialSegmentCount || 0;
    this.partTargetDuration = parsed.partTargetDuration || 0;
    this.preloadHints = parsed.preloadHints || [];
    this.serverControl = parsed.serverControl || null;
    this.preloadHintCount = parsed.preloadHints ? parsed.preloadHints.length : 0;
    this.renditionReportCount = parsed.renditionReports ? parsed.renditionReports.length : 0;
    this.skippedSegmentCount = parsed.skippedSegmentCount || 0;
    this.manifestCompatibilityWarnings = mergeUnique(this.manifestCompatibilityWarnings, parsed.warnings || []);
    this.duration = parsed.duration;
    this.live = !parsed.endList;
    this.liveStartupCandidate = this.live && !this.startupBufferComplete;
    this.manifestStartTime = manifestStartTimeFor(parsed.start, this.liveWindow || (parsed.segments.length ? { start: parsed.segments[0].start, end: parsed.segments[parsed.segments.length - 1].end } : null), parsed.duration);
    this.mediaSequence = parsed.mediaSequence || 0;
    this.discontinuitySequence = parsed.discontinuitySequence || 0;
    this.discontinuityCount = parsed.discontinuityCount || 0;
    this.targetDuration = parsed.targetDuration || this.targetDuration || 2;
    this.mediaPlaylistUrl = url;
    this.liveWindow = this.segments.length ? {
      start: this.segments[0].start,
      end: this.segments[this.segments.length - 1].end
    } : null;
    this.manifestStartTime = manifestStartTimeFor(parsed.start, this.liveWindow, parsed.duration);
    this._addTimelineRegions(hlsRegionsForDateRanges(parsed.dateRanges || [], this.segments));
    this.playlistRefreshCount++;
    this.playlistRefreshFailed = false;
    var rawCodecs = (this.activeVariant && (this.activeVariant.rawCodecs || this.activeVariant.codecs)) || parsed.codecs || 'avc1.42c01f';
    var codecs = videoCodecsOnly(rawCodecs) || rawCodecs;
    this.mimeType = 'video/mp4; codecs="' + codecs + '"';
    if (!MediaSource.isTypeSupported(this.mimeType)) throw new Error('hls-codec-unsupported');
    this.muxedTsAudio = !!(isTs && this.activeVariant && !this.activeVariant.audioGroup && (this.activeVariant.audioCodecs || audioCodecsOnly(rawCodecs)));
    if (this.muxedTsAudio) {
      var audioCodecs = this.activeVariant.audioCodecs || audioCodecsOnly(rawCodecs) || 'mp4a.40.2';
      this.audioMimeType = 'audio/mp4; codecs="' + audioCodecs + '"';
      if (!MediaSource.isTypeSupported(this.audioMimeType)) throw new Error('hls-audio-codec-unsupported');
    }
    if (isTs) {
      return this._ensureTsTransmuxer('video', codecs).then(function () {
        return this.muxedTsAudio ? this._ensureTsTransmuxer('audio', this.activeVariant.audioCodecs || audioCodecsOnly(rawCodecs) || 'mp4a.40.2') : Promise.resolve();
      }.bind(this));
    }
  };

  NativeHlsProvider.prototype._loadAudioPlaylist = function (text, url) {
    var parsed = parseHlsPlaylist(text, url);
    if (parsed.unsupportedEncryption) throw hlsUnsupportedEncryptionError(this, parsed);
    var isTs = hasMpegTsSegments(parsed.segments);
    if ((!parsed.map && !isTs) || !parsed.segments.length) throw new Error(isTs ? 'hls-mpegts-unsupported' : 'hls-audio-playlist-unsupported');
    if (!this.activeAudio) throw new Error('hls-audio-unavailable');
    this.activeAudio.segments = mergeSegmentState(this.activeAudio.segments, parsed.segments) || parsed.segments;
    this.activeAudio.initSegment = parsed.map;
    this.activeAudio.isTsPlaylist = isTs;
    this.activeAudio.lowLatencyPlaylist = !!parsed.lowLatencyPlaylist;
    this.activeAudio.partialSegmentCount = parsed.partialSegmentCount || 0;
    this.activeAudio.partTargetDuration = parsed.partTargetDuration || 0;
    this.activeAudio.preloadHints = parsed.preloadHints || [];
    this.activeAudio.serverControl = parsed.serverControl || null;
    this.activeAudio.preloadHintCount = parsed.preloadHints ? parsed.preloadHints.length : 0;
    this.activeAudio.renditionReportCount = parsed.renditionReports ? parsed.renditionReports.length : 0;
    this.activeAudio.skippedSegmentCount = parsed.skippedSegmentCount || 0;
    this.manifestCompatibilityWarnings = mergeUnique(this.manifestCompatibilityWarnings, parsed.warnings || []);
    this.activeAudio.targetDuration = parsed.targetDuration || this.targetDuration || 2;
    this.activeAudio.mediaSequence = parsed.mediaSequence || 0;
    this.activeAudio.discontinuitySequence = parsed.discontinuitySequence || 0;
    this.activeAudio.discontinuityCount = parsed.discontinuityCount || 0;
    this.activeAudio.playlistUrl = url;
    this.audioSegments = this.activeAudio.segments;
    this.audioInitSegment = this.activeAudio.initSegment;
    var codecs = this.activeAudio.codecs || audioCodecsOnly((this.activeVariant && this.activeVariant.codecs) || '') || 'mp4a.40.2';
    this.audioMimeType = 'audio/mp4; codecs="' + codecs + '"';
    if (!MediaSource.isTypeSupported(this.audioMimeType)) throw new Error('hls-audio-codec-unsupported');
    if (isTs) return this._ensureTsTransmuxer('audio', codecs);
  };

  NativeHlsProvider.prototype._loadStartupMediaPlaylists = function () {
    var self = this;
    var attempts = 0;
    var maxAttempts = Math.max(1, (this.variants || []).length);
    function attempt() {
      if (!self.activeVariant) throw nativeTerminalError(self, 'hls-no-supported-video');
      attempts++;
      return self._fetchPlaylistText(self.activeVariant.url).then(function (mediaText) {
        return self._loadMediaPlaylist(mediaText, self.activeVariant.url);
      }).then(function () {
        if (!self.activeAudio || !self.activeAudio.url) return;
        return self._fetchPlaylistText(self.activeAudio.url).then(function (audioText) {
          return self._loadAudioPlaylist(audioText, self.activeAudio.url);
        });
      }).catch(function (err) {
        if (!isRefreshableRequestError(err)) throw err;
        if (attempts >= maxAttempts) {
          if (self.startupMasterReloaded) throw err;
          self.startupMasterReloaded = true;
          return self._reloadMasterPlaylist().then(function () {
            attempts = 0;
            maxAttempts = Math.max(1, (self.variants || []).length);
            self.activeVariant = self.chooseVariant();
            if (!self.activeVariant) throw err;
            self.activeAudio = self._chooseAudioRendition(self.activeVariant);
            self.lastSwitchReason = 'startup-master-refresh';
            return attempt();
          });
        }
        if (self.activeVariant) self.blacklisted[self.activeVariant.id] = true;
        self.lastError = err && err.message ? err.message : 'hls-startup-playlist-failed';
        self.lastSwitchReason = 'startup-playlist-fallback';
        self.activeVariant = self.chooseVariant();
        if (!self.activeVariant) throw err;
        self.activeAudio = self._chooseAudioRendition(self.activeVariant);
        if (self.activeVariant.audioGroup && !self.activeAudio) throw nativeTerminalError(self, 'hls-no-supported-audio');
        return attempt();
      });
    }
    return attempt();
  };

  NativeHlsProvider.prototype._reloadMasterPlaylist = function () {
    var self = this;
    return this._fetchPlaylistText(this.playlistUrl).then(function (text) {
      var parsed = parseHlsPlaylist(text, self.playlistUrl);
      if (parsed.unsupportedEncryption) throw hlsUnsupportedEncryptionError(self, parsed);
      if (!parsed.variants.length) throw new Error('hls-master-refresh-no-variants');
      self.iframeVariants = parsed.iframeVariants || [];
      self.iframeVariantCount = self.iframeVariants.length;
      self.imageVariants = parsed.imageVariants || [];
      self.imageVariantCount = self.imageVariants.length;
      self.sessionData = parsed.sessionData || [];
      self.sessionDataCount = self.sessionData.length;
      self.contentSteeringUri = parsed.contentSteeringUri || '';
      self.contentSteeringPathwayId = parsed.contentSteeringPathwayId || '';
      self.manifestCompatibilityWarnings = mergeUnique(self.manifestCompatibilityWarnings, parsed.warnings || []);
      self.audioRenditions = parsed.audioRenditions;
      self.subtitleRenditions = parsed.subtitleRenditions.concat(parsed.closedCaptionRenditions || []);
      self.variants = parsed.variants.map(function (variant) {
        var rawCodecs = variant.codecs || '';
        variant.kind = 'video';
        variant.mimeType = 'video/mp4';
        variant.rawCodecs = rawCodecs;
        variant.audioCodecs = audioCodecsOnly(rawCodecs);
        variant.codecs = videoCodecsOnly(rawCodecs) || rawCodecs;
        return variant;
      }).sort(compareVideoReps);
      self.audioRenditions.forEach(function (rendition) {
        var rawCodecs = rendition.codecs || parsed.codecs || '';
        rendition.kind = 'audio';
        rendition.mimeType = 'audio/mp4';
        rendition.rawCodecs = rawCodecs;
        rendition.codecs = audioCodecsOnly(rawCodecs) || rawCodecs || 'mp4a.40.2';
        rendition.asr = 44100;
      });
      self.blacklisted = {};
      return self._probeCapabilities(self.variants.concat(self.audioRenditions)).then(function () {
        self.unsupportedVideoCount = self.variants.filter(function (variant) { return !MediaSource.isTypeSupported(mime(variant)); }).length;
        self.unsupportedAudioCount = self.audioRenditions.filter(function (rendition) { return !MediaSource.isTypeSupported(mime(rendition)); }).length;
        self.unsupportedCapabilityCount = self.variants.concat(self.audioRenditions).filter(function (rep) { return !capabilityAllowed(self, rep); }).length;
        return self._refreshContentSteering('master-refresh');
      });
    });
  };

  NativeHlsProvider.prototype._open = function () {
    var self = this;
    this.mediaSource.duration = this.live ? Infinity : (this.duration || NaN);
    this.sb = this.mediaSource.addSourceBuffer(this.mimeType);
    this.sb.mode = 'segments';
    if (this.audioInitSegment || this.muxedTsAudio || (this.activeAudio && this.activeAudio.isTsPlaylist)) {
      this.audioSb = this.mediaSource.addSourceBuffer(this.audioMimeType);
      this.audioSb.mode = 'segments';
    }
    this.video.addEventListener('waiting', this._boundWaiting = function () { self._onWaiting(); });
    this.video.addEventListener('playing', this._boundPlaying = function () { self._onPlaying(); });
    this.video.addEventListener('timeupdate', this._boundTick = function () { self._tick(); });
    this.video.addEventListener('seeking', this._boundSeeking = function () {
      self._onSeek();
    });
    var initPromise = this.initSegment
      ? this._fetchRange(this.initSegment.url, this.initSegment.range, { phase: 'metadata' }).then(function (initData) {
        return appendBuffer(self.sb, initData);
      })
      : Promise.resolve();
    return initPromise.then(function () {
      if (!self.audioInitSegment || !self.audioSb) return;
      return self._fetchRange(self.audioInitSegment.url, self.audioInitSegment.range, { phase: 'metadata' }).then(function (initData) {
        return appendBuffer(self.audioSb, initData);
      });
    }).then(function () {
      if (self.live && self.liveWindow) {
        self.startupLiveTarget = self._defaultLiveStartTime();
        if (self.video.currentTime < self.liveWindow.start || self.video.currentTime < self.startupLiveTarget - 0.5) {
          try { self.video.currentTime = self.startupLiveTarget; } catch (e) {}
        }
      }
      if (self.engine._pendingLoadStartTime == null && isFinite(self.manifestStartTime)) {
        try { self.video.currentTime = self.manifestStartTime; } catch (e) {}
      }
      self.startupBufferStartedAt = performance.now();
      if (self.live) self._schedulePlaylistRefresh();
      self._tick(true);
      self.engine._player.emit('loaded');
      self.engine._player.emit('trackschanged');
      self.engine._setState('ready');
    });
  };

  NativeHlsProvider.prototype._tick = function (force) {
    if (this.destroyed || !this.sb || !this.segments.length) return;
    this._updateLivePositionStats();
    this._jumpSmallGap();
    var ahead = getBufferAhead(this.video);
    this._maybeRefreshLiveLowBuffer(ahead);
    if (this._recoverLiveWindowDrift(ahead)) return;
    if (!force && ahead >= this._bufferAheadGoal()) return;
    if (!this.manualTrackId) this._maybeSwitchAuto();
    this._scheduleMediaRequests(!this.startupBufferComplete ? this._startupBufferGoal() : this._bufferAheadGoal());
    this._trim();
    this._checkBufferMilestones();
  };

  NativeHlsProvider.prototype._scheduleMediaRequests = function (windowGoal) {
    if (this.destroyed) return;
    var tracks = this._mediaTracks();
    for (var t = 0; t < tracks.length; t++) this._drainAppendQueue(tracks[t]);
    var capacity = this._maxConcurrentMediaRequests() - countKeys(this.activeRanges);
    if (capacity <= 0) {
      this.schedulerBackpressureCount++;
      return;
    }
    var candidates = this._buildSegmentCandidates(windowGoal, tracks);
    for (var i = 0; i < candidates.length && capacity > 0; i++) {
      if (this._startSegmentFetch(candidates[i].track, candidates[i].seg)) capacity--;
    }
    for (var j = 0; j < tracks.length; j++) this._drainAppendQueue(tracks[j]);
  };

  NativeHlsProvider.prototype._mediaTracks = function () {
    this._videoTrack = this._videoTrack || { id: 'video', kind: 'video', segments: [], sb: null };
    this._videoTrack.segments = hlsPlayableSegments(this, this, this.segments);
    this._videoTrack.sb = this.sb;
    var tracks = [this._videoTrack];
    if (this.activeAudio && this.audioSb && this.audioSegments.length) {
      this.activeAudio.kind = 'audio';
      this.activeAudio.segments = hlsPlayableSegments(this, this.activeAudio, this.audioSegments);
      this.activeAudio.sb = this.audioSb;
      tracks.push(this.activeAudio);
    }
    return tracks;
  };

  NativeHlsProvider.prototype._buildSegmentCandidates = function (windowGoal, tracks) {
    var ct = this._schedulerTime();
    if (this.live && this.liveWindow && ct < this.liveWindow.start) ct = this.liveWindow.start;
    var goal = windowGoal || this._bufferAheadGoal();
    var target = ct + goal;
    var readyGoal = Math.min(goal, this._bufferAheadGoal());
    var candidates = [];
    tracks = tracks || this._mediaTracks();
    for (var i = 0; i < tracks.length; i++) {
      var track = tracks[i];
      for (var j = 0; j < track.segments.length; j++) {
        var seg = track.segments[j];
        if (seg.state === 'expired' || seg.end <= ct - 0.5 || seg.start >= target || isSegmentBusyOrDone(seg)) continue;
        candidates.push({ track: track, seg: seg, priority: segmentPriority(seg, ct, readyGoal) });
      }
    }
    return candidates.sort(function (a, b) {
      if (a.priority !== b.priority) return a.priority - b.priority;
      if (a.seg.start !== b.seg.start) return a.seg.start - b.seg.start;
      return a.track.kind === 'video' ? -1 : 1;
    });
  };

  NativeHlsProvider.prototype._startSegmentFetch = function (track, seg) {
    var self = this;
    if (!track || !seg || isSegmentBusyOrDone(seg)) return false;
    var rangeKey = track.id + ':' + segmentKey(seg);
    if (this.activeRanges[rangeKey]) return false;
    this.activeRanges[rangeKey] = true;
    seg.state = 'fetching';
    seg._fetchStartedAt = performance.now();
    if (seg._hlsPart) this.partialSegmentRequestCount++;
    if (seg._hlsPreloadHint) this.preloadHintRequestCount++;
    this._fetchRange(seg.url, seg.range, { phase: 'media' }).then(function (data) {
      return self._decryptSegmentIfNeeded(seg, data).then(function (plainData) {
        delete self.activeRanges[rangeKey];
        seg.state = 'fetched';
        seg._data = plainData;
        var elapsed = Math.max(1, performance.now() - (seg._fetchStartedAt || performance.now()));
        self.mediaFetchCompletedCount++;
        self.mediaFetchTotalMs += elapsed;
        if (seg.duration > 0 && elapsed > 0) {
          self._recordBandwidthSample(plainData.byteLength || 0, elapsed);
        }
        self._drainAppendQueue(track);
        self._tick();
      });
    }).catch(function (err) {
      delete self.activeRanges[rangeKey];
      delete seg._fetchStartedAt;
      if (err.name === 'AbortError') return;
      if (seg._hlsPart || seg._hlsPreloadHint) {
        seg.state = 'failed';
        seg.appended = false;
        self.partialSegmentFallbackCount++;
        if (seg._parentSegment) {
          seg._parentSegment.state = 'pending';
          seg._parentSegment.appended = false;
        }
        self._tick(true);
        return;
      }
      if (!seg._nativeRecovered && isRefreshableRequestError(err)) {
        seg._nativeRecovered = true;
        seg.state = 'recovering';
        self._recoverMediaRequest(err).then(function () {
          if (self.destroyed) return;
          seg.state = '';
          seg.appended = false;
          self._tick(true);
        }).catch(function (refreshErr) {
          seg.state = 'failed';
          self._handleFatal(refreshErr);
        });
        return;
      }
      seg.state = 'failed';
      self._handleFatal(err);
    });
    return true;
  };

  NativeHlsProvider.prototype._decryptSegmentIfNeeded = function (seg, data) {
    if (!seg || !seg.key || seg.key.method !== 'AES-128') return Promise.resolve(data);
    var self = this;
    return this._fetchHlsKey(seg.key).then(function (rawKey) {
      var iv = seg.key.iv || hlsDefaultIv(seg.mediaSequence || 0);
      return crypto.subtle.importKey('raw', rawKey, { name: 'AES-CBC' }, false, ['decrypt']).then(function (key) {
        return crypto.subtle.decrypt({ name: 'AES-CBC', iv: iv }, key, data);
      });
    }).then(function (plain) {
      self.encryptedSegmentCount++;
      self.lastDecryptionError = '';
      return plain;
    }).catch(function (err) {
      self.lastDecryptionError = err && err.message ? err.message : 'hls-decrypt-failed';
      self.lastError = self.lastDecryptionError;
      throw new Error('hls-decrypt-failed');
    });
  };

  NativeHlsProvider.prototype._fetchHlsKey = function (keyInfo) {
    var self = this;
    var cacheKey = keyInfo && keyInfo.uri ? keyInfo.uri : '';
    if (!cacheKey) return Promise.reject(new Error('hls-key-uri-missing'));
    if (this.hlsKeyCache[cacheKey]) {
      this.keyCacheHitCount++;
      return Promise.resolve(this.hlsKeyCache[cacheKey]);
    }
    var controller = new AbortController();
    this.controllers.push(controller);
    return nativeNetworkRequest(this.engine, NativeNetworkingEngine.RequestType.KEY, {
      uris: [cacheKey],
      method: 'GET',
      headers: {}
    }, { signal: controller.signal }).then(function (resp) {
      removeItem(self.controllers, controller);
      var swInfo = readServiceWorkerSource(resp);
      self._recordServiceWorkerFetch(swInfo, 'key');
      if (!networkResponseOk(resp)) {
        self.lastHttpStatus = resp.status;
        if (swInfo.offline) self._recordOfflineHttpError(resp.status);
        throw rangeHttpError(resp.status);
      }
      return resp.data;
    }).then(function (rawKey) {
      if (!rawKey || rawKey.byteLength !== 16) throw new Error('hls-key-invalid');
      self.keyFetchCount++;
      self.hlsKeyCache[cacheKey] = rawKey;
      return rawKey;
    }).catch(function (err) {
      removeItem(self.controllers, controller);
      if (err.name === 'AbortError') throw abortError();
      throw err;
    });
  };

  NativeHlsProvider.prototype._drainAppendQueue = function (track) {
    var self = this;
    track = track || this._mediaTracks()[0];
    if (!track || !track.sb || track._appending) return false;
    if (track.sb.updating && !recoverStuckSourceBuffer(this, track)) return false;
    var next = nextFetchedSegmentForAppend(track, this.video.currentTime || 0);
    if (!next) return false;
    track._appending = true;
    next.state = 'appending';
    next._appendStartedAt = performance.now();
    var data = next._data;
    delete next._data;
    hlsAppendSegmentWithWatchdog(self, track, next, data).then(function () {
      next.state = 'appended';
      next.appended = true;
      if (next._hlsPart || next._hlsPreloadHint) self.partialSegmentAppendCount++;
      delete next._appendStartedAt;
      delete next._fetchStartedAt;
      track._appending = false;
      self.appendFailures = 0;
      self.stallReports = 0;
      self.stallRecoveryStage = 0;
      self.schedulerDrainCount++;
      self._alignHlsBufferedTarget();
      self.engine._player.emit('adaptation');
      self._drainAppendQueue(track);
      self._maybeEndVodStream();
      self._tick();
    }).catch(function (err) {
      track._appending = false;
      if (err.name !== 'AbortError') {
        next.state = 'failed';
        next.appended = false;
        delete next._appendStartedAt;
        if (isHlsTsTerminalError(err)) {
          self._completeNativeRuntimeTerminal(err.message || 'hls-first-party-ts-transmuxer-unavailable');
          return;
        }
        self._handleAppendFailure(track, err);
      }
    });
    return true;
  };

  NativeHlsProvider.prototype._appendSegmentData = function (track, seg, data) {
    var self = this;
    var isTsAudioTrack = track.kind === 'audio' && track.isTsPlaylist;
    var prepareDiscontinuity = this._prepareDiscontinuityAppend || function () { return Promise.resolve(); };
    var appendPromise = prepareDiscontinuity.call(this, track, seg).then(function () {
      return self.isTsPlaylist && track.kind === 'video'
      ? this._transmuxTsSegment(track, seg, data, 'video').then(function (output) {
        var chain = self._appendTransmuxedOutput(track.sb, output, track, seg);
        if (self.muxedTsAudio && self.audioSb) {
          chain = chain.then(function () {
            self._muxedAudioTrack = self._muxedAudioTrack || { id: 'muxed-audio', kind: 'audio', sb: self.audioSb };
            self._muxedAudioTrack.sb = self.audioSb;
            return self._prepareDiscontinuityAppend(self._muxedAudioTrack, seg);
          }).then(function () {
            return self._transmuxTsSegment(track, seg, data, 'audio').then(function (audioOutput) {
              return self._appendTransmuxedOutput(self.audioSb, audioOutput, self._muxedAudioTrack, seg);
            });
          });
        }
        return chain;
      })
      : (isTsAudioTrack
        ? this._transmuxTsSegment(track, seg, data, 'audio').then(function (output) {
          return self._appendTransmuxedOutput(track.sb, output, track, seg);
        })
        : appendBuffer(track.sb, data, null, hlsFmp4TimestampOffset(self, track, seg)));
    }.bind(this));
    return appendPromise.catch(function (err) {
      if (!isQuotaExceeded(err)) throw err;
      self.quotaRecoveries++;
      self.lastError = 'quota-exceeded';
      if (self.engine && self.engine._telemetry) self.engine._telemetry.record('recovery', { lastError: 'quota-exceeded' });
      return self._recoverQuota(track, data, seg).catch(function (retryErr) {
        seg.state = 'failed';
        throw retryErr;
      });
    });
  };

  NativeHlsProvider.prototype._maybeEndVodStream = function () {
    if (this.live || !this.mediaSource || this.mediaSource.readyState !== 'open') return false;
    if ((this.sb && this.sb.updating) || (this.audioSb && this.audioSb.updating)) return false;
    if (!segmentsAppendedThroughEnd(this.segments, this.duration)) return false;
    if (this.activeAudio && this.audioSegments.length && !segmentsAppendedThroughEnd(this.audioSegments, this.duration)) return false;
    try {
      this.mediaSource.endOfStream();
      this.vodEndOfStreamCount++;
      return true;
    } catch (e) {
      return false;
    }
  };

  NativeHlsProvider.prototype._prepareDiscontinuityAppend = function (track, seg) {
    if (!track || !track.sb || !seg) return Promise.resolve();
    var sequence = seg.discontinuitySequence || 0;
    var previous = track._lastAppendDiscontinuitySequence;
    var boundary = previous != null && previous !== sequence;
    if (!boundary && !seg.discontinuity) {
      if (previous == null) track._lastAppendDiscontinuitySequence = sequence;
      return Promise.resolve();
    }
    track._lastAppendDiscontinuitySequence = sequence;
    if (track.sb.updating) return waitForSourceBufferIdle(track.sb);
    try {
      if (track.sb.abort) track.sb.abort();
    } catch (e) {}
    return Promise.resolve();
  };

  NativeHlsProvider.prototype._appendTransmuxedOutput = function (sb, output, track, seg) {
    var self = this;
    var chain = Promise.resolve();
    if (output.init && output.init.byteLength) chain = chain.then(function () { return appendBuffer(sb, output.init); });
    if (output.data && output.data.byteLength) chain = chain.then(function () {
      return appendBuffer(sb, output.data, null, hlsLiveTimestampOffset(self, track, seg));
    });
    return chain.then(function () {
      self._alignTsStartupTime();
    });
  };

  NativeHlsProvider.prototype._alignTsStartupTime = function () {
    if (!this.isTsPlaylist || this.startupBufferComplete || !this.video || !this.video.buffered.length) return;
    var start = this.video.buffered.start(0);
    if (start > 0 && (this.video.currentTime || 0) < start - 0.05) {
      try { this.video.currentTime = start; } catch (e) {}
    }
  };

  NativeHlsProvider.prototype._schedulerTime = function () {
    if (this.live && this.liveWindow) {
      if (this.seekBufferPending && isFinite(this.lastSeekTarget)) return this._clampSeekTarget(this.lastSeekTarget);
      if (!this.startupBufferComplete && isFinite(this.startupLiveTarget)) return this._clampSeekTarget(this.startupLiveTarget);
    }
    return this.video.currentTime || 0;
  };

  NativeHlsProvider.prototype._alignHlsBufferedTarget = function () {
    if (!this.live || !this.video || !this.video.buffered || !this.video.buffered.length) return;
    var target = this.seekBufferPending && isFinite(this.lastSeekTarget)
      ? this._clampSeekTarget(this.lastSeekTarget)
      : (!this.startupBufferComplete && isFinite(this.startupLiveTarget) ? this._clampSeekTarget(this.startupLiveTarget) : NaN);
    if (!isFinite(target) || !bufferedContains(this.video.buffered, target)) return;
    if (Math.abs((this.video.currentTime || 0) - target) > 0.25) {
      try { this.video.currentTime = target; } catch (e) {}
    }
  };

  NativeHlsProvider.prototype._recoverLiveWindowDrift = function (ahead) {
    if (!this.live || !this.liveWindow || !this.video || this.video.seeking) return false;
    var ct = this.video.currentTime || 0;
    var ranges = bufferedRanges(this.video.buffered);
    var bufferedEnd = ranges.length ? ranges[ranges.length - 1].end : 0;
    var windowStart = this.liveWindow.start || 0;
    var expiredPlayhead = ct < windowStart - 0.25;
    var expiredBuffer = ahead < MIN_BUFFER_AHEAD && bufferedEnd > 0 && bufferedEnd < windowStart - 0.25;
    if (!expiredPlayhead && !expiredBuffer) return false;

    var target = this._defaultLiveStartTime();
    target = this._clampSeekTarget ? this._clampSeekTarget(target) : clamp(target, windowStart, this.liveWindow.end || windowStart);
    if (!isFinite(target)) target = windowStart;
    try { this.video.currentTime = target; } catch (e) {}
    this.liveWindowDriftRecoveryCount++;
    this.seekBufferPending = true;
    this.lastSeekTarget = target;
    this.lastError = 'hls-live-window-drift';
    if (this.engine && this.engine._telemetry) this.engine._telemetry.record('recovery', { lastError: this.lastError });
    markSegmentsForTime(this, target, Math.max(2, this._bufferAheadGoal()));
    if (this.activeAudio) markSegmentsForTime(this.activeAudio, target, Math.max(2, this._bufferAheadGoal()));
    this._scheduleMediaRequests(this._seekBufferGoal());
    return true;
  };

  NativeHlsProvider.prototype._ensureTsTransmuxer = function (contentType, codecs) {
    var self = this;
    if (contentType === 'audio' && this.tsAudioTransmuxer) return Promise.resolve();
    if (contentType !== 'audio' && this.tsVideoTransmuxer) return Promise.resolve();
    var started = performance.now();
    return createTsTransmuxerAdapter(contentType, codecs).then(function (adapter) {
      self.tsTransmuxers[contentType === 'audio' ? 'audio' : 'video'] = adapter;
      if (contentType === 'audio') self.tsAudioTransmuxer = adapter;
      else self.tsVideoTransmuxer = adapter;
      self.tsTransmuxer = self.tsVideoTransmuxer || self.tsAudioTransmuxer;
      self.tsTransmuxerProvider = adapter.provider;
      if (!self.tsTransmuxerLoadMs) self.tsTransmuxerLoadMs = Math.max(1, performance.now() - started);
      if (self.manifestCompatibilityWarnings.indexOf('hls-ts-transmuxed') === -1) self.manifestCompatibilityWarnings.push('hls-ts-transmuxed');
    });
  };

  NativeHlsProvider.prototype._transmuxTsSegment = function (track, seg, data, contentType) {
    var adapter = contentType === 'audio' ? this.tsAudioTransmuxer : this.tsVideoTransmuxer;
    if (!adapter) return Promise.reject(new Error('hls-ts-transmuxer-unavailable'));
    var self = this;
    return adapter.transmux(data, {
      activeVariant: this.activeVariant,
      contentType: contentType,
      segment: seg,
      track: track
    }).then(function (output) {
      self.transmuxedSegmentCount++;
      if (contentType === 'audio') self.transmuxedAudioSegmentCount++;
      else self.transmuxedVideoSegmentCount++;
      return normalizeTransmuxOutput(output);
    });
  };

  NativeHlsProvider.prototype._recoverQuota = function (track, data, seg) {
    var self = this;
    var removeEnd = Math.max(0, (this.video.currentTime || 0) - 5);
    return Promise.all([
      this.sb ? removeBufferBefore(this.sb, removeEnd) : Promise.resolve(),
      this.audioSb ? removeBufferBefore(this.audioSb, removeEnd) : Promise.resolve()
    ]).then(function () {
      if (self.isTsPlaylist && track.kind === 'video') {
        return self._transmuxTsSegment(track, seg || {}, data, 'video').then(function (output) {
          return self._appendTransmuxedOutput(track.sb, output, track, seg || {});
        });
      }
      if (track.kind === 'audio' && track.isTsPlaylist) {
        return self._transmuxTsSegment(track, seg || {}, data, 'audio').then(function (output) {
          return self._appendTransmuxedOutput(track.sb, output, track, seg || {});
        });
      }
      return appendBuffer(track.sb, data);
    }).catch(function (err) {
      if (!isQuotaExceeded(err) || track.kind !== 'video') throw err;
      var lower = self._lowerVariant();
      if (!lower) throw err;
      if (self.activeVariant) self.blacklisted[self.activeVariant.id] = true;
      self._switchVariant(lower, true, 'quota-recovery');
      throw abortError();
    });
  };

  NativeHlsProvider.prototype._handleAppendFailure = function (track, err) {
    this.appendFailures++;
    this.lastError = err && err.message ? err.message : 'hls-append-failed';
    var recoveryReason = track.kind === 'video' ? 'hls-video-append' : 'hls-audio-append';
    this.nativeRecoveryReasons = this.nativeRecoveryReasons || {};
    if (this._tryNativeRecovery && !this.nativeRecoveryReasons[recoveryReason]) {
      this._tryNativeRecovery(recoveryReason).then(function () {}).catch(function () {});
      return;
    }
    if (track.kind === 'video') {
      if (this.activeVariant) this.blacklisted[this.activeVariant.id] = true;
      var lower = this._lowerVariant();
      if (lower) {
        this._switchVariant(lower, true, 'append-recovery');
        return;
      }
      this._completeNativeRuntimeTerminal('hls-video-append-exhausted');
      return;
    }
    if (this.appendFailures >= 2) this._completeNativeRuntimeTerminal('hls-audio-append-failed');
  };

  NativeHlsProvider.prototype._completeNativeRuntimeTerminal = function (reason) {
    this.lastError = reason || this.lastError || 'hls-runtime-exhausted';
    this.fatalError = this.lastError;
    this.nativeUnsupportedReason = this.lastError;
    if (this.engine && this.engine._completeNativeTerminalError) {
      this.engine._completeNativeTerminalError(nativeTerminalError(this, this.lastError));
    }
  };

  NativeHlsProvider.prototype._tryNativeRecovery = function (reason) {
    if (this.destroyed || this.nativeRecoveryInProgress) return Promise.resolve(false);
    this.nativeRecoveryInProgress = true;
    this.nativeRecoveryAttemptCount++;
    this.recoveryCount++;
    this.lastNativeRecoveryReason = reason;
    this.nativeRecoveryReasons = this.nativeRecoveryReasons || {};
    this.nativeRecoveryReasons[reason] = true;
    this.lastError = reason;
    if (this.engine && this.engine._telemetry) this.engine._telemetry.record('recovery', { lastError: reason });
    var self = this;
    var currentTime = this.video.currentTime || 0;
    try { this._abortRequests(); } catch (e) {}
    markSegmentsForTime(this, currentTime, Math.max(2, this._bufferAheadGoal()));
    if (this.activeAudio) markSegmentsForTime(this.activeAudio, currentTime, Math.max(2, this._bufferAheadGoal()));
    var chain = Promise.all([
      this.sb ? resetSourceBuffer(this.sb, currentTime) : Promise.resolve(),
      this.audioSb ? resetSourceBuffer(this.audioSb, currentTime) : Promise.resolve()
    ]).then(function () {
      var initChain = Promise.resolve();
      if (self.initSegment && self.sb) {
        initChain = initChain.then(function () {
          return self._fetchRange(self.initSegment.url, self.initSegment.range, { phase: 'metadata' }).then(function (initData) {
            return appendBuffer(self.sb, initData);
          });
        });
      }
      if (self.audioInitSegment && self.audioSb) {
        initChain = initChain.then(function () {
          return self._fetchRange(self.audioInitSegment.url, self.audioInitSegment.range, { phase: 'metadata' }).then(function (initData) {
            return appendBuffer(self.audioSb, initData);
          });
        });
      }
      return initChain;
    }).then(function () {
      self.nativeRecoverySuccessCount++;
      self.appendFailures = 0;
      self.stallReports = 0;
      self.nativeRecoveryInProgress = false;
      self._tick(true);
      return true;
    }).catch(function (err) {
      self.nativeRecoveryInProgress = false;
      self.lastError = err && err.message ? err.message : reason + '-failed';
      return false;
    });
    return chain;
  };

  NativeHlsProvider.prototype._recoverMediaRequest = function (err) {
    var reason = err && err.message ? err.message : 'hls-media-request-failed';
    this.mediaUrlRefreshCount++;
    this.recoveryCount++;
    this.lastError = reason;
    if (err && err.status) this.lastHttpStatus = err.status;
    return this._refreshMediaPlaylist('media-error');
  };

  NativeHlsProvider.prototype._refreshMediaPlaylist = function () {
    var self = this;
    if (!this.activeVariant || !this.activeVariant.url) return Promise.reject(new Error('hls-refresh-unavailable'));
    return this._refreshContentSteering('refresh').then(function () {
      self._applyContentSteeringToActiveVariant();
      return self._fetchPlaylistText(self.activeVariant.url);
    }).then(function (mediaText) {
      return self._loadMediaPlaylist(mediaText, self.activeVariant.url);
    }).then(function () {
      if (!self.activeAudio || !self.activeAudio.url) return;
      return self._fetchPlaylistText(self.activeAudio.url).then(function (audioText) {
        return self._loadAudioPlaylist(audioText, self.activeAudio.url);
      });
    });
  };

  NativeHlsProvider.prototype._maybeRefreshLiveLowBuffer = function (ahead) {
    if (!this.live || !this.liveWindow || this.destroyed || this.liveRefreshInFlight) return;
    var currentTime = this.video.currentTime || 0;
    var nearEdge = this.liveWindow.end - currentTime <= Math.max(MIN_BUFFER_AHEAD, LIVE_TARGET_LATENCY + 2);
    if (!nearEdge || ahead >= MIN_BUFFER_AHEAD) return;
    var now = performance.now();
    var minInterval = Math.max(500, (this.targetDuration || 2) * 500);
    if (this.lastLiveRefreshStartedAt && now - this.lastLiveRefreshStartedAt < minInterval) return;
    this.liveRefreshInFlight = true;
    this.lastLiveRefreshStartedAt = now;
    this.liveLowBufferRefreshCount++;
    var self = this;
    this._refreshMediaPlaylist('live-low-buffer').then(function () {
      self._evictExpiredLiveSegmentState();
      self.playlistRefreshFailed = false;
      self.liveRefreshInFlight = false;
      self._tick(true);
    }).catch(function (err) {
      self.liveRefreshInFlight = false;
      self.lastError = err && err.message ? err.message : 'hls-live-low-buffer-refresh-failed';
      self.playlistRefreshFailed = true;
    });
  };

  NativeHlsProvider.prototype._schedulePlaylistRefresh = function () {
    var self = this;
    if (this.destroyed || !this.live) return;
    clearTimeout(this.playlistRefreshTimer);
    this.playlistRefreshTimer = setTimeout(function () {
      self._refreshMediaPlaylist('live').then(function () {
        self._evictExpiredLiveSegmentState();
        self._tick(true);
        self._schedulePlaylistRefresh();
      }).catch(function (err) {
        self.lastError = err && err.message ? err.message : 'hls-live-refresh-failed';
        self.playlistRefreshFailed = true;
        self._schedulePlaylistRefresh();
      });
    }, Math.max(1000, (this.targetDuration || 2) * 1000));
  };

  NativeHlsProvider.prototype._evictExpiredLiveSegmentState = function () {
    if (!this.liveWindow) return;
    for (var i = 0; i < this.segments.length; i++) {
      if (this.segments[i].end < this.liveWindow.start - 0.1) {
        this.segments[i].state = 'expired';
        this.segments[i].appended = false;
      }
    }
    if (this.activeAudio && this.activeAudio.segments) {
      for (var j = 0; j < this.activeAudio.segments.length; j++) {
        if (this.activeAudio.segments[j].end < this.liveWindow.start - 0.1) {
          this.activeAudio.segments[j].state = 'expired';
          this.activeAudio.segments[j].appended = false;
        }
      }
    }
  };

  NativeHlsProvider.prototype._trim = function () {
    if (!this.sb) return;
    trimBuffer(this.sb, Math.max(0, (this.video.currentTime || 0) - this._bufferBehindGoal()));
    if (this.audioSb) trimBuffer(this.audioSb, Math.max(0, (this.video.currentTime || 0) - this._bufferBehindGoal()));
  };

  NativeHlsProvider.prototype._checkBufferMilestones = function () {
    var goal = this.seekBufferPending ? this._seekBufferGoal() : this._startupBufferGoal();
    var ready = getBufferAhead(this.video) >= Math.min(goal, this._bufferAheadGoal());
    if (ready && !this.startupBufferComplete) {
      this.startupBufferComplete = true;
      this.liveStartupCandidate = false;
      this.startupBufferMs = this.startupBufferStartedAt ? performance.now() - this.startupBufferStartedAt : 0;
      if (this.engine && this.engine._telemetry) this.engine._telemetry.record('startup-buffer-ready', { startupBufferMs: this.startupBufferMs });
    }
    if (ready && this.seekBufferPending) {
      this.seekBufferPending = false;
      this.seekBufferReadyCount++;
      if (this.engine && this.engine._telemetry) this.engine._telemetry.record('seek-buffer-ready');
    }
  };

  NativeHlsProvider.prototype._abortRequests = function () {
    var cancelled = this.controllers.length + countKeys(this.activeRanges);
    resetActiveSegmentRequests(this);
    if (this.activeAudio) resetActiveSegmentRequests(this.activeAudio);
    this.activeRanges = {};
    this._appending = false;
    for (var i = 0; i < this.controllers.length; i++) {
      try { this.controllers[i].abort(); } catch (e) {}
    }
    this.controllers = [];
    return cancelled;
  };

  NativeHlsProvider.prototype._handleFatal = function (err) {
    if (this.destroyed) return;
    this.lastError = err && err.message ? err.message : 'hls-media-error';
    if (err && err.status) this.lastHttpStatus = err.status;
    this._completeNativeRuntimeTerminal(this.lastError);
  };

  NativeHlsProvider.prototype._bufferAheadGoal = function () {
    var cfg = this.engine._player.config.streaming || {};
    var goal = Math.max(1, cfg.bufferingGoal || BUFFER_AHEAD);
    return this.live ? Math.max(goal, LIVE_BUFFER_AHEAD) : goal;
  };

  NativeHlsProvider.prototype._startupBufferGoal = function () {
    var cfg = this.engine._player.config.streaming || {};
    return Math.max(1, cfg.startupBufferGoal || STARTUP_BUFFER_GOAL);
  };

  NativeHlsProvider.prototype._seekBufferGoal = function () {
    var cfg = this.engine._player.config.streaming || {};
    return Math.max(1, cfg.seekBufferGoal || STARTUP_BUFFER_GOAL);
  };

  NativeHlsProvider.prototype._maxConcurrentMediaRequests = function () {
    var cfg = this.engine._player.config.streaming || {};
    return Math.max(1, cfg.maxConcurrentRequests || MAX_CONCURRENT_MEDIA_REQUESTS);
  };

  NativeHlsProvider.prototype._bufferBehindGoal = function () {
    var cfg = this.engine._player.config.streaming || {};
    return Math.max(0, cfg.bufferBehind == null ? BUFFER_BEHIND : cfg.bufferBehind);
  };

  NativeHlsProvider.prototype._defaultLiveStartTime = function () {
    if (!this.liveWindow) return this.video.currentTime || 0;
    var goal = Math.max(LIVE_STABLE_START_LATENCY, LIVE_MAX_LATENCY, this._bufferAheadGoal ? this._bufferAheadGoal() + 30 : LIVE_BUFFER_AHEAD + 30);
    return Math.max(this.liveWindow.start, this.liveWindow.end - goal);
  };

  NativeHlsProvider.prototype._updateLivePositionStats = function () {
    if (!this.live || !this.liveWindow) {
      this.liveLatency = 0;
      this.atLiveEdge = false;
      return;
    }
    this.liveLatency = Math.max(0, this.liveWindow.end - (this.video.currentTime || 0));
    this.atLiveEdge = this.liveLatency <= LIVE_TARGET_LATENCY + 1;
  };

  NativeHlsProvider.prototype.getLiveRange = function () {
    return this.liveWindow ? { start: this.liveWindow.start, end: this.liveWindow.end } : null;
  };

  NativeHlsProvider.prototype.seekRange = function () {
    return this.getLiveRange() || mediaSeekRange(this.video);
  };

  NativeHlsProvider.prototype.seekToLiveEdge = function () {
    if (!this.liveWindow) return;
    this.commitSeek(Math.max(this.liveWindow.start, this.liveWindow.end - LIVE_TARGET_LATENCY));
  };

  NativeHlsProvider.prototype._clampSeekTarget = function (targetTime) {
    var requested = isFinite(Number(targetTime)) ? Number(targetTime) : (this.video.currentTime || 0);
    var target = requested;
    if (this.live && this.liveWindow) target = clamp(target, this.liveWindow.start, this.liveWindow.end);
    if (this.live && this.liveWindow && requested > this.liveWindow.start + 0.001 && requested <= this.liveWindow.end && this.segments && this.segments.length) {
      target = hlsSeekTargetInsideSegment(this, target);
    }
    return target;
  };

  NativeHlsProvider.prototype.beginSeek = function (targetTime) {
    var target = this._clampSeekTarget(targetTime);
    this.lastSeekTarget = target;
    this.lastSeekStartedAt = performance.now();
    this.seekBufferPending = true;
    if (this.engine && this.engine._setState) this.engine._setState('seeking');
    return target;
  };

  NativeHlsProvider.prototype.commitSeek = function (targetTime) {
    var target = this.beginSeek(targetTime);
    this.seekCount++;
    try { this.video.currentTime = target; } catch (e) {}
    this._onSeek(target);
    return target;
  };

  NativeHlsProvider.prototype.cancelSeek = function () {
    this.seekCancelCount++;
    this.seekBufferPending = false;
    this.lastSeekStartedAt = 0;
    if (this.engine && this.engine._setState && !this.engine._serverDown) this.engine._setState('ready');
  };

  NativeHlsProvider.prototype.endSeek = function () {
    if (this.lastSeekStartedAt) this.lastSeekMs = performance.now() - this.lastSeekStartedAt;
    this.lastSeekStartedAt = 0;
    if (this.engine && this.engine._setState && !this.engine._serverDown) this.engine._setState('ready');
  };

  NativeHlsProvider.prototype.seekDuringRecovery = function (targetTime) {
    this.commitSeek(targetTime);
  };

  NativeHlsProvider.prototype._onSeek = function (targetTime) {
    if (this.destroyed) return;
    var target = this._clampSeekTarget(targetTime == null ? this.video.currentTime : targetTime);
    var now = performance.now();
    if (this._lastSeekHandledTarget !== null && Math.abs(target - this._lastSeekHandledTarget) <= 0.05 && now - this._lastSeekHandledAt < 100) return;
    this._lastSeekHandledTarget = target;
    this._lastSeekHandledAt = now;
    if (Math.abs(target - (this.video.currentTime || 0)) > 0.05) {
      try { this.video.currentTime = target; } catch (e) {}
    }
    this.lastSeekTarget = target;
    this.seekBufferPending = true;
    if (this.engine && this.engine._setState) this.engine._setState('seeking');
    var cancelled = this._abortRequests();
    if (cancelled > 0) this.seekAbortCount += cancelled;
    markSegmentsForTime(this, target, Math.max(2, this._seekBufferGoal()));
    if (this.activeAudio) markSegmentsForTime(this.activeAudio, target, Math.max(2, this._seekBufferGoal()));
    this._tick(true);
    var self = this;
    setTimeout(function () {
      if (!self.destroyed && !self.engine._serverDown) self.engine._setState('ready');
    }, 250);
  };

  NativeHlsProvider.prototype._jumpSmallGap = function () {
    var gap = nextBufferedGap(this.video);
    if (!gap || gap.size <= 0 || gap.size > MAX_GAP_JUMP) return false;
    try {
      this.video.currentTime = gap.start + 0.01;
      this.gapJumpCount++;
      this.lastGapSize = gap.size;
      this.lastError = 'gap-jump';
      if (this.engine && this.engine._telemetry) this.engine._telemetry.record('gap-jump', { lastGapSize: gap.size });
      this._tick(true);
      return true;
    } catch (e) {
      return false;
    }
  };

  NativeHlsProvider.prototype.reportStall = function () {
    this._tick(true);
    if (getBufferAhead(this.video) >= 0.5) return;
    if (this._jumpSmallGap()) return;
    this.stallReports++;
    this.lastError = 'stall';
    if (this.engine && this.engine._telemetry) this.engine._telemetry.record('recovery', { lastError: 'stall' });
    if (this.stallRecoveryStage === 0) {
      this.stallRecoveryStage = 1;
      markSegmentsForTime(this, this.video.currentTime || 0, Math.max(2, this._bufferAheadGoal()));
      if (this.activeAudio) markSegmentsForTime(this.activeAudio, this.video.currentTime || 0, Math.max(2, this._bufferAheadGoal()));
      this._tick(true);
      return;
    }
    if (this.stallRecoveryStage === 1 && this.activeVariant) {
      this.nativeRecoveryReasons = this.nativeRecoveryReasons || {};
      if (this._tryNativeRecovery && !this.nativeRecoveryReasons['hls-stall']) {
        this.stallRecoveryStage = 2;
        this._tryNativeRecovery('hls-stall').then(function () {}).catch(function () {});
        return;
      }
      var lower = this._lowerVariant();
      if (lower) {
        this.stallRecoveryStage = 3;
        this.blacklisted[this.activeVariant.id] = true;
        this._switchVariant(lower, true, 'stall-recovery');
        return;
      }
    }
    if (this.stallReports >= 3) this._completeNativeRuntimeTerminal('hls-stall-exhausted');
  };

  NativeHlsProvider.prototype._fetchRange = function (url, range, opts) {
    var self = this;
    opts = opts || {};
    var retry = effectiveRetryParameters(this);
    var attempts = opts.attempts || retry.maxAttempts;
    var attempt = opts.attempt || 1;
    var controller = new AbortController();
    this.controllers.push(controller);
    var headers = {};
    if (range) headers.Range = 'bytes=' + range.start + '-' + range.end;
    return nativeNetworkRequest(this.engine, NativeNetworkingEngine.RequestType.SEGMENT, {
      uris: [url],
      method: 'GET',
      headers: headers
    }, { signal: controller.signal, forceNetworkHold: opts.forceNetworkHold || attempt >= attempts }).then(function (resp) {
      removeItem(self.controllers, controller);
      var swInfo = readServiceWorkerSource(resp);
      self._recordServiceWorkerFetch(swInfo, 'segment');
      if (resp.status === 401 || resp.status === 403 || resp.status === 404 || resp.status === 410 || resp.status === 416 || resp.status >= 500) {
        self.lastHttpStatus = resp.status;
        if (swInfo.offline) self._recordOfflineHttpError(resp.status);
        throw rangeHttpError(resp.status);
      }
      if (!networkResponseOk(resp) && resp.status !== 206) {
        self.lastHttpStatus = resp.status;
        if (swInfo.offline) self._recordOfflineHttpError(resp.status);
        throw rangeHttpError(resp.status);
      }
      return resp.data;
    }).catch(function (err) {
      removeItem(self.controllers, controller);
      if (err.name === 'AbortError') throw abortError();
      if (attempt < attempts && isTransientRequestError(err)) {
        self.recoveryCount++;
        self.mediaFetchRetryCount++;
        self.lastError = err && err.message ? err.message : 'hls-range-retry';
        return wait(retryDelay(retry, attempt)).then(function () {
          return self._fetchRange(url, range, {
            phase: opts.phase,
            attempts: attempts,
            attempt: attempt + 1
          });
        });
      }
      self.lastError = err && err.message ? err.message : 'hls-range-error';
      throw err;
    });
  };

  NativeHlsProvider.prototype._fetchPlaylistText = function (url) {
    var self = this;
    return fetchText(this.engine, url, function (swInfo) {
      self._recordServiceWorkerFetch(swInfo, 'manifest');
    }).catch(function (err) {
      if (err && /^manifest-http-/.test(err.message || '') && self.engine && self.engine._offlinePlayback) {
        self.lastOfflineError = 'offline-' + err.message;
        self.engine._recordOfflineError(new Error(self.lastOfflineError));
      }
      throw err;
    });
  };

  NativeHlsProvider.prototype._refreshContentSteering = function (reason) {
    var uri = this.contentSteeringReloadUri || this.contentSteeringUri;
    if (!uri) return Promise.resolve(false);
    var now = performance.now();
    if (reason !== 'initial' && this.contentSteeringExpiresAt && now < this.contentSteeringExpiresAt) return Promise.resolve(false);
    var self = this;
    this.contentSteeringRequestCount++;
    return nativeNetworkRequest(this.engine, NativeNetworkingEngine.RequestType.MANIFEST, {
      uris: [uri],
      method: 'GET',
      headers: {}
    }).then(function (resp) {
      if (resp.status === 401 || resp.status === 403 || resp.status === 404 || resp.status === 410 || resp.status >= 500 || !networkResponseOk(resp)) {
        throw new Error('content-steering-http-' + resp.status);
      }
      var data = JSON.parse(arrayBufferToString(resp.data));
      var priority = Array.isArray(data['PATHWAY-PRIORITY']) ? data['PATHWAY-PRIORITY'].map(String) : [];
      var ttl = Number(data.TTL);
      var reloadUri = data['RELOAD-URI'] ? resolveUrl(String(data['RELOAD-URI']), uri) : '';
      self.contentSteeringPriority = priority;
      self.contentSteeringTtl = isFinite(ttl) && ttl > 0 ? ttl : 0;
      self.contentSteeringExpiresAt = self.contentSteeringTtl ? performance.now() + self.contentSteeringTtl * 1000 : 0;
      self.contentSteeringReloadUri = reloadUri || self.contentSteeringReloadUri;
      self.lastContentSteeringError = '';
      var previous = self.contentSteeringPathwayId || '';
      self._chooseContentSteeringPathway(priority);
      if (previous && self.contentSteeringPathwayId && previous !== self.contentSteeringPathwayId) self.contentSteeringSwitchCount++;
      return true;
    }).catch(function (err) {
      self.lastContentSteeringError = err && err.message ? err.message : 'content-steering-failed';
      return false;
    });
  };

  NativeHlsProvider.prototype._chooseContentSteeringPathway = function (priority) {
    priority = priority || this.contentSteeringPriority || [];
    for (var i = 0; i < priority.length; i++) {
      if (this.variants.some(function (variant) { return variant.pathwayId === priority[i] && capabilityAllowed(this, variant) && !variantRestricted(this, variant); }, this)) {
        this.contentSteeringPathwayId = priority[i];
        return;
      }
    }
  };

  NativeHlsProvider.prototype._recordServiceWorkerFetch = function (swInfo, phase) {
    if (!swInfo) return;
    if (swInfo.source) this.lastServiceWorkerSource = swInfo.source;
    if (phase === 'segment') {
      if (swInfo.cached) this.segmentCacheHitCount++;
      if (swInfo.offline && !swInfo.cached) {
        this.segmentCacheMissCount++;
        this.lastOfflineError = 'offline-cache-miss';
      }
    }
    if (swInfo.cached || swInfo.offline || swInfo.source) {
      this.engine._recordOfflineSource(swInfo.source, swInfo.offline, swInfo.cached);
      if (phase === 'manifest') this.engine._recordManifestSource(swInfo);
    }
  };

  NativeHlsProvider.prototype._recordOfflineHttpError = function (status) {
    this.lastOfflineError = 'offline-segment-http-' + status;
    if (this.engine) this.engine._recordOfflineError(new Error(this.lastOfflineError));
  };

  NativeHlsProvider.prototype._probeCapabilities = function (reps) {
    var self = this;
    reps = reps || [];
    if (!navigator.mediaCapabilities || !navigator.mediaCapabilities.decodingInfo) {
      reps.forEach(function (rep) { rep.capability = defaultCapability(rep); });
      return Promise.resolve();
    }
    return Promise.all(reps.map(function (rep) {
      self.capabilityProbeCount++;
      return navigator.mediaCapabilities.decodingInfo(mediaCapabilityConfig(rep)).then(function (info) {
        rep.capability = {
          probed: true,
          supported: info.supported !== false,
          smooth: info.smooth !== false,
          powerEfficient: info.powerEfficient === true
        };
      }).catch(function () {
        rep.capability = defaultCapability(rep);
      });
    })).then(function () {});
  };

  NativeHlsProvider.prototype._isCapabilityAllowed = function (rep) {
    if (!rep || !rep.mimeType || !rep.codecs || !MediaSource.isTypeSupported(mime(rep))) return false;
    var cap = rep.capability || defaultCapability(rep);
    rep.capability = cap;
    return cap.supported !== false && cap.smooth !== false;
  };

  NativeHlsProvider.prototype._recordBandwidthSample = function (byteLength, elapsedMs) {
    var sample = (byteLength * 8 * 1000) / Math.max(1, elapsedMs);
    if (!isFinite(sample) || sample <= 0) return;
    this.lastBandwidthSample = sample;
    this.bandwidthSamples++;
    this.bandwidth = this.bandwidth ? (this.bandwidth * 0.7 + sample * 0.3) : sample;
  };

  NativeHlsProvider.prototype._candidateVariants = function () {
    var filtered = this.variants.filter(function (variant) {
      return !this.blacklisted[variant.id] && variantSelectable(this, variant);
    }, this);
    filtered = filterVariantsForContentSteering(this, filtered);
    if (filtered.length) return filtered;
    return filterVariantsForContentSteering(this, this.variants.filter(function (variant) { return !this.blacklisted[variant.id] && capabilityAllowed(this, variant); }, this));
  };

  NativeHlsProvider.prototype._filterVariantsForContentSteering = function (variants) {
    return filterVariantsForContentSteering(this, variants);
  };

  NativeHlsProvider.prototype._applyContentSteeringToActiveVariant = function () {
    if (!this.activeVariant || this.manualTrackId || !this.contentSteeringPathwayId) return;
    if (this.activeVariant.pathwayId === this.contentSteeringPathwayId) return;
    var next = this.chooseVariant();
    if (!next || next === this.activeVariant || next.pathwayId !== this.contentSteeringPathwayId) return;
    this.activeVariant = next;
    this.activeAudio = this._chooseAudioRendition(next) || this.activeAudio;
    this.contentSteeringSwitchCount++;
    this.lastSwitchReason = 'content-steering';
    this.engine._player.emit('variantchanged');
  };

  NativeHlsProvider.prototype._viewportMaxHeight = function () {
    var abr = this.engine._player.config.abr || {};
    var cfg = abr.restrictions || {};
    if (abr.ignoreViewportSize || cfg.ignoreViewportSize) return Infinity;
    var rect = this.video.getBoundingClientRect ? this.video.getBoundingClientRect() : null;
    var cssHeight = rect && rect.height ? rect.height : this.video.clientHeight;
    if (!cssHeight || cssHeight < 1) return Infinity;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var target = cssHeight * dpr * 1.25;
    if (target <= 360) return 360;
    if (target <= 480) return 480;
    if (target <= 720) return 720;
    if (target <= 1080) return 1080;
    return Infinity;
  };

  NativeHlsProvider.prototype._chooseForBudget = function (candidates, budgetFactor) {
    if (!candidates || !candidates.length) return null;
    var sorted = candidates.slice().sort(function (a, b) {
      var heightDiff = (a.height || 0) - (b.height || 0);
      if (heightDiff) return heightDiff;
      return capabilityPreferenceScore(a) - capabilityPreferenceScore(b);
    });
    if (this.activeVariant) {
      var family = codecFamily(this.activeVariant.codecs);
      var sameFamily = sorted.filter(function (variant) { return codecFamily(variant.codecs) === family; });
      if (sameFamily.length) sorted = sameFamily;
    }
    var budget = effectiveBandwidthEstimate(this) * budgetFactor;
    var chosen = sorted[0];
    for (var i = 0; i < sorted.length; i++) {
      if ((sorted[i].bandwidth || 0) <= budget && isBetterCandidate(sorted[i], chosen)) chosen = sorted[i];
    }
    return chosen;
  };

  NativeHlsProvider.prototype.chooseVariant = function () {
    var candidates = this._candidateVariants();
    if (!candidates.length) return null;
    if (this.manualTrackId) {
      var manual = candidates.find(function (variant) { return variant.id === this.manualTrackId; }, this);
      if (manual) return manual;
    }
    var conservativeLiveStartup = this.live || this.liveStartupCandidate;
    if (conservativeLiveStartup) {
      var capped = candidates.filter(function (variant) { return !variant.height || variant.height <= LIVE_STARTUP_MAX_HEIGHT; });
      if (capped.length) candidates = capped;
    }
    var chosen = this._chooseForBudget(candidates, conservativeLiveStartup ? LIVE_STARTUP_ABR_FACTOR : 0.8);
    for (var i = 0; i < this.variants.length; i++) this.variants[i].active = this.variants[i] === chosen;
    return chosen;
  };

  NativeHlsProvider.prototype._lowerVariant = function () {
    if (!this.activeVariant) return null;
    var currentHeight = this.activeVariant.height || Infinity;
    var family = codecFamily(this.activeVariant.codecs);
    var candidates = this.variants.filter(function (variant) {
      return !this.blacklisted[variant.id] && capabilityAllowed(this, variant) && variant !== this.activeVariant && (variant.height || 0) < currentHeight && codecFamily(variant.codecs) === family;
    }, this);
    if (!candidates.length) {
      candidates = this.variants.filter(function (variant) {
        return !this.blacklisted[variant.id] && capabilityAllowed(this, variant) && variant !== this.activeVariant && (variant.height || 0) < currentHeight;
      }, this);
    }
    candidates.sort(function (a, b) { return (b.height || 0) - (a.height || 0); });
    return candidates[0] || null;
  };

  NativeHlsProvider.prototype._restoreVariantState = function (variant, audio) {
    if (!variant) return;
    this.activeVariant = variant;
    this.activeAudio = audio || this.activeAudio;
    for (var i = 0; i < this.variants.length; i++) this.variants[i].active = this.variants[i] === variant;
    for (var j = 0; j < this.audioRenditions.length; j++) this.audioRenditions[j].active = this.audioRenditions[j] === this.activeAudio;
  };

  NativeHlsProvider.prototype._chooseAudioRendition = function (variant) {
    if (!variant || !variant.audioGroup) return null;
    var group = this.audioRenditions.filter(function (item) { return item.groupId === variant.audioGroup; });
    group = group.filter(function (item) { return capabilityAllowed(this, item); }, this);
    if (!group.length) return null;
    var chosen = group.find(function (item) { return item.defaultTrack; }) || group[0];
    for (var i = 0; i < this.audioRenditions.length; i++) this.audioRenditions[i].active = this.audioRenditions[i] === chosen;
    return chosen;
  };

  NativeHlsProvider.prototype._switchVariant = function (variant, clearBuffer, reason) {
    if (!variant || this.destroyed || this.activeVariant === variant) return;
    var self = this;
    var previousVariant = this.activeVariant;
    var previousAudio = this.activeAudio;
    this._abortRequests();
    this.activeVariant = variant;
    for (var i = 0; i < this.variants.length; i++) this.variants[i].active = this.variants[i] === variant;
    this.activeAudio = this._chooseAudioRendition(variant) || this.activeAudio;
    this.lastSwitchReason = reason || (clearBuffer ? 'manual' : 'auto');
    this.engine._player.emit('variantchanged');
    this._refreshMediaPlaylist('variant-switch').then(function () {
      if (clearBuffer) {
        markSegmentsUnappended(self);
        return resetSourceBuffer(self.sb, self.video.currentTime).then(function () {
          return self._fetchRange(self.initSegment.url, self.initSegment.range, { phase: 'metadata' });
        }).then(function (initData) {
          return appendBuffer(self.sb, initData);
        }).then(function () {
          if (!self.audioInitSegment || !self.audioSb) return;
          return self._fetchRange(self.audioInitSegment.url, self.audioInitSegment.range, { phase: 'metadata' }).then(function (initData) {
            return appendBuffer(self.audioSb, initData);
          });
        });
      }
    }).then(function () {
      self._tick(true);
    }).catch(function (err) {
      self._restoreVariantState(previousVariant, previousAudio);
      self.lastError = err && err.message ? err.message : 'hls-variant-switch-failed';
      if (reason === 'quota-recovery' || reason === 'append-recovery' || reason === 'stall-recovery') self._handleFatal(err);
      else self._tick(true);
    });
  };

  NativeHlsProvider.prototype._maybeSwitchAuto = function () {
    if (!this.engine._player.config.abr.enabled || this.variants.length < 2 || !this.activeVariant) return;
    var now = performance.now();
    if (this.lastSwitchAt && now - this.lastSwitchAt < ABR_SWITCH_COOLDOWN_MS) return;
    var ahead = getBufferAhead(this.video);
    var previous = this.activeVariant;
    var previousBandwidth = this.bandwidth;
    if (this.bandwidthSamples < 2 && ahead >= ABR_DOWNGRADE_BUFFER) {
      this.bandwidth = Math.max(this.bandwidth || 0, this.engine._player.config.abr.defaultBandwidthEstimate || 3000000);
    }
    var stableLiveCandidate = this.live && ahead >= Math.min(this._bufferAheadGoal(), LIVE_BUFFER_AHEAD) * 0.75 && this.liveLatency >= LIVE_STABLE_START_LATENCY * 0.5;
    if (stableLiveCandidate) {
      if (!this.liveStableSince) this.liveStableSince = now;
    } else {
      this.liveStableSince = 0;
    }
    var stableLive = stableLiveCandidate && this.liveStableSince && now - this.liveStableSince >= LIVE_UPGRADE_HOLDOFF_MS;
    var normalFactor = this.live ? (stableLive ? LIVE_STABLE_ABR_FACTOR : LIVE_STARTUP_ABR_FACTOR) : 0.8;
    var candidates = this._candidateVariants();
    if (this.live && !stableLive) {
      var capped = candidates.filter(function (variant) { return !variant.height || variant.height <= LIVE_STARTUP_MAX_HEIGHT; });
      if (capped.length) candidates = capped;
    }
    var chosen = this._chooseForBudget(candidates, this.bandwidthSamples < 2 || ahead >= MIN_BUFFER_AHEAD ? normalFactor : 0.55);
    var reason = 'bandwidth';
    if (ahead < ABR_DOWNGRADE_BUFFER && this.bandwidthSamples >= 2) {
      this.bandwidth = previousBandwidth;
      var lowBufferCandidates = this._candidateVariants();
      if (this.live) {
        var lowBufferCapped = lowBufferCandidates.filter(function (variant) { return !variant.height || variant.height <= LIVE_STARTUP_MAX_HEIGHT; });
        if (lowBufferCapped.length) lowBufferCandidates = lowBufferCapped;
      }
      chosen = this._chooseForBudget(lowBufferCandidates, 0.35);
      reason = 'low-buffer';
    }
    this.bandwidth = previousBandwidth;
    if (!chosen || chosen === previous) return;
    this.lastSwitchAt = now;
    if (chosen.height < previous.height || ahead >= ABR_UPGRADE_BUFFER) this._switchVariant(chosen, false, reason);
  };

  NativeHlsProvider.prototype.selectVariantTrack = function (track, clearBuffer) {
    var variant = this.variants.find(function (item) { return item.id === track.id || item.height === track.height; });
    if (!variant || !variantSelectable(this, variant)) return;
    this.manualTrackId = variant.id;
    this.engine._player.config.abr.enabled = false;
    this.lastSwitchAt = performance.now();
    this._switchVariant(variant, clearBuffer !== false, 'manual');
  };

  NativeHlsProvider.prototype.configure = function () {
    if (!this.manualTrackId) this._maybeSwitchAuto();
  };

  NativeHlsProvider.prototype.getVariantTracks = function () {
    var self = this;
    return this.variants.map(function (variant) {
      var restricted = variantRestricted(self, variant);
      return {
        id: variant.id,
        bandwidth: variant.bandwidth || 0,
        width: variant.width || 0,
        height: variant.height || 0,
        codecs: variant.codecs || '',
        pathwayId: variant.pathwayId || '',
        codecFamily: codecFamily(variant.codecs),
        capabilityStatus: capabilityStatus(variant.capability || defaultCapability(variant)),
        supported: capabilityAllowed(self, variant),
        restricted: restricted,
        selectable: capabilityAllowed(self, variant) && !restricted,
        smooth: !(variant.capability && variant.capability.smooth === false),
        powerEfficient: !!(variant.capability && variant.capability.powerEfficient === true),
        active: !!variant.active
      };
    });
  };

  NativeHlsProvider.prototype.getActiveVariantTrack = function () {
    var tracks = this.getVariantTracks();
    for (var i = 0; i < tracks.length; i++) if (tracks[i].active) return tracks[i];
    return tracks[0] || null;
  };

  NativeHlsProvider.prototype.getAudioTracks = function () {
    if (this.audioRenditions.length) {
      var self = this;
      return this.audioRenditions.map(function (rendition) {
        return {
          id: rendition.id,
          active: !!rendition.active,
          language: rendition.language || '',
          label: rendition.label || rendition.language || rendition.id,
          bandwidth: rendition.bandwidth || 0,
          codecs: rendition.codecs || '',
          capabilityStatus: capabilityStatus(rendition.capability || defaultCapability(rendition)),
          supported: capabilityAllowed(self, rendition),
          smooth: !(rendition.capability && rendition.capability.smooth === false),
          powerEfficient: !!(rendition.capability && rendition.capability.powerEfficient === true),
          groupId: rendition.groupId || ''
        };
      });
    }
    return [{ id: 'hls', active: true, language: '', label: 'Default', bandwidth: 0, codecs: '' }];
  };

  NativeHlsProvider.prototype.getActiveAudioTrack = function () {
    var tracks = this.getAudioTracks();
    for (var i = 0; i < tracks.length; i++) if (tracks[i].active) return tracks[i];
    return tracks[0];
  };

  NativeHlsProvider.prototype.selectAudioTrack = function (track) {
    var rendition = this.audioRenditions.find(function (item) { return item.id === track.id || item.language === track.language; });
    if (!rendition || rendition === this.activeAudio || this.destroyed) return;
    var self = this;
    var previousAudio = this.activeAudio;
    this._abortRequests();
    this.activeAudio = rendition;
    for (var i = 0; i < this.audioRenditions.length; i++) this.audioRenditions[i].active = this.audioRenditions[i] === rendition;
    this._fetchPlaylistText(rendition.url).then(function (audioText) {
      return self._loadAudioPlaylist(audioText, rendition.url);
    }).then(function () {
      if (!self.audioSb) {
        self.audioSb = self.mediaSource.addSourceBuffer(self.audioMimeType);
        self.audioSb.mode = 'segments';
      }
      return resetSourceBuffer(self.audioSb, self.video.currentTime).then(function () {
        if (!self.audioInitSegment) return;
        return self._fetchRange(self.audioInitSegment.url, self.audioInitSegment.range, { phase: 'metadata' }).then(function (initData) {
          return appendBuffer(self.audioSb, initData);
        });
      });
    }).then(function () {
      self.engine._player.emit('audiotrackchanged', self.getActiveAudioTrack());
      self._tick(true);
    }).catch(function (err) {
      self.activeAudio = previousAudio;
      for (var i = 0; i < self.audioRenditions.length; i++) self.audioRenditions[i].active = self.audioRenditions[i] === previousAudio;
      self.lastError = err && err.message ? err.message : 'hls-audio-switch-failed';
      self._tick(true);
    });
  };

  NativeHlsProvider.prototype.getTextTracks = function () {
    return this.subtitleRenditions.map(function (rendition) {
      return textTrackForRep({
        id: rendition.id,
        language: rendition.language,
        label: rendition.label,
        mimeType: rendition.mimeType || 'text/vtt',
        roles: ['subtitle'],
        accessibility: [],
        url: rendition.url,
        source: rendition.source || 'native-hls',
        embedded: !!rendition.embedded,
        instreamId: rendition.instreamId || '',
        supported: rendition.supported === false ? false : isSupportedTextMime(rendition.mimeType || 'text/vtt'),
        renderSupported: rendition.renderSupported === false ? false : isRenderableTextMime(rendition.mimeType || 'text/vtt'),
        loadState: rendition.loadState
      }, !!rendition.active);
    });
  };

  NativeHlsProvider.prototype.getActiveTextTrack = function () {
    var tracks = this.getTextTracks();
    for (var i = 0; i < tracks.length; i++) if (tracks[i].active) return tracks[i];
    return null;
  };

  NativeHlsProvider.prototype.selectTextTrack = function (track) {
    var rendition = (this.subtitleRenditions || []).find(function (item) { return item.id === track.id || item.language === track.language; });
    if (!rendition || rendition.supported === false || rendition.renderSupported === false || rendition.embedded) return Promise.resolve();
    return selectNativeTextTrack(this, rendition, function (active) {
      for (var i = 0; i < this.subtitleRenditions.length; i++) this.subtitleRenditions[i].active = active && this.subtitleRenditions[i] === rendition;
      this.activeTextTrackId = active ? rendition.id : '';
    });
  };

  NativeHlsProvider.prototype.setTextTrackVisibility = function (visible) {
    this.textTrackVisibility = !!visible;
    if (!visible) {
      for (var i = 0; i < this.subtitleRenditions.length; i++) this.subtitleRenditions[i].active = false;
      this.activeTextTrackId = '';
      clearNativeTextOverlay(this);
    } else {
      updateNativeTextOverlay(this);
    }
    this.engine._player.emit('texttrackchanged', this.getActiveTextTrack());
    return Promise.resolve();
  };

  NativeHlsProvider.prototype.getIFrameTracks = function () {
    var iframeTracks = (this.iframeVariants || []).map(function (variant) {
      return {
        id: variant.id,
        url: variant.url || '',
        bandwidth: variant.bandwidth || 0,
        width: variant.width || 0,
        height: variant.height || 0,
        codecs: variant.codecs || '',
        pathwayId: variant.pathwayId || '',
        iframeOnly: true,
        imageOnly: false,
        thumbnailType: 'iframe',
        loaded: !!(this.iframePlaylists && this.iframePlaylists[variant.id])
      };
    }, this);
    var imageTracks = (this.imageVariants || []).map(function (variant) {
      return {
        id: variant.id,
        url: variant.url || '',
        bandwidth: variant.bandwidth || 0,
        width: variant.width || 0,
        height: variant.height || 0,
        codecs: variant.codecs || '',
        pathwayId: variant.pathwayId || '',
        iframeOnly: false,
        imageOnly: true,
        thumbnailType: 'image',
        loaded: !!(this.imagePlaylists && this.imagePlaylists[variant.id])
      };
    }, this);
    return iframeTracks.concat(imageTracks);
  };

  NativeHlsProvider.prototype.getIFramePreview = function (time, trackId) {
    var self = this;
    var track = chooseIFrameTrack(this, trackId);
    if (!track) return Promise.resolve(null);
    var loadPlaylist = track.imageOnly ? this._loadImagePlaylist(track) : this._loadIFramePlaylist(track);
    return loadPlaylist.then(function (playlist) {
      var segment = nearestIFrameSegment(playlist.segments || [], Number(time) || 0);
      if (!segment) return null;
      return {
        track: {
          id: track.id,
          bandwidth: track.bandwidth || 0,
          width: track.width || 0,
          height: track.height || 0,
          codecs: track.codecs || '',
          pathwayId: track.pathwayId || '',
          iframeOnly: !track.imageOnly,
          imageOnly: !!track.imageOnly,
          thumbnailType: track.imageOnly ? 'image' : 'iframe'
        },
        start: segment.start || 0,
        end: segment.end || segment.start || 0,
        duration: segment.duration || 0,
        url: segment.url || '',
        range: segment.range || null,
        tiles: segment.tiles || null,
        imageOnly: !!track.imageOnly,
        thumbnailType: track.imageOnly ? 'image' : 'iframe',
        mediaSequence: segment.mediaSequence || 0
      };
    }).catch(function (err) {
      self.lastIFramePlaylistError = err && err.message ? err.message : 'hls-iframe-playlist-failed';
      return null;
    });
  };

  NativeHlsProvider.prototype._loadIFramePlaylist = function (track) {
    if (!track || !track.url) return Promise.reject(new Error('hls-iframe-track-unavailable'));
    this.iframePlaylists = this.iframePlaylists || {};
    if (this.iframePlaylists[track.id]) return Promise.resolve(this.iframePlaylists[track.id]);
    var self = this;
    this.iframePlaylistRequestCount++;
    return this._fetchPlaylistText(track.url).then(function (text) {
      var playlistUrl = resolveUrl(track.url, window.location && window.location.href ? window.location.href : self.playlistUrl);
      var parsed = parseHlsPlaylist(text, playlistUrl);
      if (parsed.unsupportedEncryption) throw new Error(parsed.unsupportedEncryptionReason || 'hls-iframe-encrypted-unsupported');
      if (hasMpegTsSegments(parsed.segments)) throw new Error('hls-iframe-mpegts-unsupported');
      if (!parsed.segments.length) throw new Error('hls-iframe-playlist-empty');
      var playlist = {
        trackId: track.id,
        url: track.url,
        segments: parsed.segments,
        map: parsed.map || null,
        duration: parsed.duration || 0,
        mediaSequence: parsed.mediaSequence || 0
      };
      self.iframePlaylists[track.id] = playlist;
      self.iframeSegmentCount += parsed.segments.length;
      self.lastIFramePlaylistError = '';
      return playlist;
    }).catch(function (err) {
      self.lastIFramePlaylistError = err && err.message ? err.message : 'hls-iframe-playlist-failed';
      throw err;
    });
  };

  NativeHlsProvider.prototype._loadImagePlaylist = function (track) {
    if (!track || !track.url) return Promise.reject(new Error('hls-image-track-unavailable'));
    this.imagePlaylists = this.imagePlaylists || {};
    if (this.imagePlaylists[track.id]) return Promise.resolve(this.imagePlaylists[track.id]);
    var self = this;
    this.imagePlaylistRequestCount++;
    return this._fetchPlaylistText(track.url).then(function (text) {
      var playlistUrl = resolveUrl(track.url, window.location && window.location.href ? window.location.href : self.playlistUrl);
      var parsed = parseHlsPlaylist(text, playlistUrl);
      if (parsed.unsupportedEncryption) throw new Error(parsed.unsupportedEncryptionReason || 'hls-image-encrypted-unsupported');
      if (!parsed.segments.length) throw new Error('hls-image-playlist-empty');
      var playlist = {
        trackId: track.id,
        url: track.url,
        segments: parsed.segments,
        duration: parsed.duration || 0,
        mediaSequence: parsed.mediaSequence || 0,
        imagesOnly: !!parsed.imagesOnly
      };
      self.imagePlaylists[track.id] = playlist;
      self.imageSegmentCount += parsed.segments.length;
      self.lastImagePlaylistError = '';
      return playlist;
    }).catch(function (err) {
      self.lastImagePlaylistError = err && err.message ? err.message : 'hls-image-playlist-failed';
      throw err;
    });
  };

  NativeHlsProvider.prototype._loadHlsChapters = function (parsed) {
    var self = this;
    var refs = hlsChapterSessionData(parsed && parsed.sessionData);
    if (!refs.length) {
      this.hlsChapterCount = 0;
      this.lastHlsChapterError = '';
      return Promise.resolve();
    }
    return Promise.all(refs.map(function (ref) {
      if (ref.value) {
        try {
          return Promise.resolve(parseHlsChapterRegions(ref.value, ref));
        } catch (err) {
          return Promise.reject(err);
        }
      }
      if (!ref.uri) return Promise.resolve([]);
      return fetchText(self.engine, ref.uri).then(function (text) {
        return parseHlsChapterRegions(text, ref);
      });
    })).then(function (lists) {
      var regions = [];
      for (var i = 0; i < lists.length; i++) regions = regions.concat(lists[i] || []);
      self.hlsChapterCount = regions.length;
      self.lastHlsChapterError = '';
      self._addTimelineRegions(regions);
    }).catch(function (err) {
      self.hlsChapterCount = 0;
      self.lastHlsChapterError = err && err.message ? err.message : 'hls-chapters-load-failed';
    });
  };

  NativeHlsProvider.prototype.isLive = function () {
    return !!this.live;
  };

  NativeHlsProvider.prototype.getBufferedInfo = function () {
    return getBufferedInfoFor(this.video, this.audioSb, this.sb);
  };

  NativeHlsProvider.prototype.getStats = function () {
    var quality = this.video.getVideoPlaybackQuality ? this.video.getVideoPlaybackQuality() : null;
    var bufferedInfo = getBufferedInfoFor(this.video, this.audioSb, this.sb);
    var bufferedSummary = summarizeBufferedInfo(bufferedInfo);
    return {
      provider: this.name,
      mode: 'hls',
      isLive: this.isLive(),
      assetUri: this.playlistUrl,
      bandwidthEstimate: Math.round(this.bandwidth || 0),
      bufferAhead: getBufferAhead(this.video),
      bufferedRangeCount: bufferedSummary.count,
      bufferedStart: bufferedSummary.start,
      bufferedEnd: bufferedSummary.end,
      activeVariant: this.getActiveVariantTrack(),
      activeAudio: this.getActiveAudioTrack(),
      audioTrackCount: this.getAudioTracks().length,
      activeTextTrack: this.engine && this.engine._player ? this.engine._player.getActiveTextTrack() : null,
      textTrackCount: this.engine && this.engine._player ? this.engine._player.getTextTracks().length : 0,
      nativeAudioTrackCount: this.audioRenditions.length || 1,
      nativeTextTrackCount: this.subtitleRenditions.length,
      lastTextTrackError: this.lastTextTrackError || '',
      timelineRegionCount: this.timelineRegions ? this.timelineRegions.length : 0,
      lastTimelineRegion: this.lastTimelineRegion || null,
      sessionDataCount: this.sessionDataCount || 0,
      hlsChapterCount: this.hlsChapterCount || 0,
      lastHlsChapterError: this.lastHlsChapterError || '',
      manifestStartTime: isFinite(this.manifestStartTime) ? this.manifestStartTime : null,
      abrEnabled: !!(this.engine && this.engine._player && this.engine._player.config.abr.enabled),
      activeRestrictions: activeAbrRestrictions(this),
      restrictedVariantCount: restrictedVariantCount(this, this.variants),
      effectiveRetryMaxAttempts: effectiveRetryParameters(this).maxAttempts,
      effectiveRetryBaseDelay: effectiveRetryParameters(this).baseDelay,
      unsupportedVideoCount: this.unsupportedVideoCount,
      unsupportedAudioCount: this.unsupportedAudioCount,
      capabilityProbeCount: this.capabilityProbeCount,
      unsupportedCapabilityCount: this.unsupportedCapabilityCount,
      fallbackReason: this.engine ? (this.engine._fallbackReason || '') : '',
      rebufferCount: this.rebufferCount,
      rebufferDuration: this.rebufferDuration + (this.rebufferStartedAt ? (performance.now() - this.rebufferStartedAt) / 1000 : 0),
      recoveryCount: this.recoveryCount,
      appendFailureCount: this.appendFailures,
      quotaRecoveries: this.quotaRecoveries,
      stallReports: this.stallReports,
      stallRecoveryStage: this.stallRecoveryStage,
      gapJumpCount: this.gapJumpCount,
      lastGapSize: this.lastGapSize,
      lastError: this.lastError,
      lastHttpStatus: this.lastHttpStatus,
      playlistRefreshCount: this.playlistRefreshCount,
      liveLowBufferRefreshCount: this.liveLowBufferRefreshCount || 0,
      liveWindowDriftRecoveryCount: this.liveWindowDriftRecoveryCount || 0,
      vodEndOfStreamCount: this.vodEndOfStreamCount || 0,
      liveRefreshInFlight: !!this.liveRefreshInFlight,
      mediaFetchCompletedCount: this.mediaFetchCompletedCount,
      mediaFetchRetryCount: this.mediaFetchRetryCount,
      mediaFetchTotalMs: this.mediaFetchTotalMs,
      offlinePlayback: !!(this.engine && this.engine._offlinePlayback),
      manifestFromServiceWorker: !!(this.engine && this.engine._manifestFromServiceWorker),
      segmentCacheHitCount: this.segmentCacheHitCount || 0,
      segmentCacheMissCount: this.segmentCacheMissCount || 0,
      lastOfflineError: this.lastOfflineError || (this.engine && this.engine._lastOfflineError) || '',
      lastServiceWorkerSource: this.lastServiceWorkerSource,
      bandwidthSamples: this.bandwidthSamples,
      lastBandwidthSample: Math.round(this.lastBandwidthSample || 0),
      mediaUrlRefreshCount: this.mediaUrlRefreshCount,
      playlistMediaSequence: this.mediaSequence || 0,
      discontinuitySequence: this.discontinuitySequence || 0,
      discontinuityCount: this.discontinuityCount || 0,
      playlistRefreshFailed: !!this.playlistRefreshFailed,
      schedulerQueueDepth: appendQueueDepth(this.sb),
      schedulerBackpressureCount: this.schedulerBackpressureCount,
      schedulerDrainCount: this.schedulerDrainCount,
      sourceBufferAbortCount: this.sourceBufferAbortCount || 0,
      startupBufferComplete: this.startupBufferComplete,
      startupBufferMs: this.startupBufferMs,
      seekBufferPending: !!this.seekBufferPending,
      seekBufferReadyCount: this.seekBufferReadyCount || 0,
      seekCount: this.seekCount || 0,
      seekCancelCount: this.seekCancelCount || 0,
      seekAbortCount: this.seekAbortCount || 0,
      lastSeekTarget: this.lastSeekTarget || 0,
      lastSeekMs: this.lastSeekMs || 0,
      effectiveSeekBufferGoal: this._seekBufferGoal ? this._seekBufferGoal() : STARTUP_BUFFER_GOAL,
      lastSwitchReason: this.lastSwitchReason,
      transmuxedSegmentCount: this.transmuxedSegmentCount,
      transmuxedVideoSegmentCount: this.transmuxedVideoSegmentCount,
      transmuxedAudioSegmentCount: this.transmuxedAudioSegmentCount,
      transmuxerProvider: this.tsTransmuxerProvider,
      transmuxerLoadMs: this.tsTransmuxerLoadMs,
      muxedTsAudio: !!this.muxedTsAudio,
      encryptedSegmentCount: this.encryptedSegmentCount,
      hlsKeyFetchCount: this.keyFetchCount,
      hlsKeyCacheHitCount: this.keyCacheHitCount,
      lastDecryptionError: this.lastDecryptionError,
      hlsEncryptionMethod: this.hlsEncryptionMethod || '',
      hlsKeyFormat: this.hlsKeyFormat || '',
      nativeUnsupportedReason: this.nativeUnsupportedReason || '',
      nativeRecoveryAttemptCount: this.nativeRecoveryAttemptCount || 0,
      nativeRecoverySuccessCount: this.nativeRecoverySuccessCount || 0,
      lastNativeRecoveryReason: this.lastNativeRecoveryReason || '',
      liveWindow: this.getLiveRange(),
      liveWindowStart: this.liveWindow ? this.liveWindow.start : 0,
      liveWindowEnd: this.liveWindow ? this.liveWindow.end : 0,
      liveLatency: this.liveLatency,
      atLiveEdge: this.atLiveEdge,
      effectiveBufferingGoal: this._bufferAheadGoal(),
      effectiveBufferBehind: this._bufferBehindGoal(),
      lowLatencyPlaylist: !!this.lowLatencyPlaylist,
      partialSegmentCount: this.partialSegmentCount || 0,
      partialSegmentRequestCount: this.partialSegmentRequestCount || 0,
      partialSegmentAppendCount: this.partialSegmentAppendCount || 0,
      partialSegmentFallbackCount: this.partialSegmentFallbackCount || 0,
      preloadHintRequestCount: this.preloadHintRequestCount || 0,
      preloadHintCount: this.preloadHintCount || 0,
      renditionReportCount: this.renditionReportCount || 0,
      skippedSegmentCount: this.skippedSegmentCount || 0,
      iframeVariantCount: this.iframeVariantCount || 0,
      iframePlaylistRequestCount: this.iframePlaylistRequestCount || 0,
      iframeSegmentCount: this.iframeSegmentCount || 0,
      iframeTracks: this.getIFrameTracks ? this.getIFrameTracks() : [],
      lastIFramePlaylistError: this.lastIFramePlaylistError || '',
      imageVariantCount: this.imageVariantCount || 0,
      imagePlaylistRequestCount: this.imagePlaylistRequestCount || 0,
      imageSegmentCount: this.imageSegmentCount || 0,
      lastImagePlaylistError: this.lastImagePlaylistError || '',
      contentSteeringUri: this.contentSteeringUri || '',
      contentSteeringReloadUri: this.contentSteeringReloadUri || '',
      contentSteeringPathwayId: this.contentSteeringPathwayId || '',
      contentSteeringPriority: this.contentSteeringPriority || [],
      contentSteeringTtl: this.contentSteeringTtl || 0,
      contentSteeringRequestCount: this.contentSteeringRequestCount || 0,
      contentSteeringSwitchCount: this.contentSteeringSwitchCount || 0,
      lastContentSteeringError: this.lastContentSteeringError || '',
      manifestCompatibilityWarnings: this.manifestCompatibilityWarnings,
      droppedFrames: quality ? quality.droppedVideoFrames : 0,
      totalFrames: quality ? quality.totalVideoFrames : 0,
      fatalError: this.fatalError || ''
    };
  };

  NativeHlsProvider.prototype._onWaiting = function () {
    if (this.rebufferStartedAt || this.video.paused || this.video.seeking) return;
    this.rebufferStartedAt = performance.now();
    this.rebufferCount++;
    this.engine._telemetry.record('rebuffer-start');
  };

  NativeHlsProvider.prototype._onPlaying = function () {
    if (!this.rebufferStartedAt) return;
    this.rebufferDuration += (performance.now() - this.rebufferStartedAt) / 1000;
    this.rebufferStartedAt = 0;
    this.engine._telemetry.record('rebuffer-end');
  };

  NativeHlsProvider.prototype._addTimelineRegions = function (regions) {
    addTimelineRegions(this, regions);
  };

  NativeHlsProvider.prototype.destroy = function () {
    this.destroyed = true;
    clearTimeout(this.playlistRefreshTimer);
    if (this._boundWaiting) this.video.removeEventListener('waiting', this._boundWaiting);
    if (this._boundPlaying) this.video.removeEventListener('playing', this._boundPlaying);
    if (this._boundTick) this.video.removeEventListener('timeupdate', this._boundTick);
    if (this._boundNativeTextCueUpdate) {
      this.video.removeEventListener('timeupdate', this._boundNativeTextCueUpdate);
      this.video.removeEventListener('seeking', this._boundNativeTextCueUpdate);
    }
    if (this._boundSeeking) this.video.removeEventListener('seeking', this._boundSeeking);
    this.controllers.forEach(function (controller) { try { controller.abort(); } catch (e) {} });
    this.controllers = [];
    try { if (this.mediaSource && this.mediaSource.readyState === 'open') this.mediaSource.endOfStream(); } catch (e) {}
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
  };

  function NativeDashProvider(engine, manifestUrl, manifestText) {
    this.engine = engine;
    this.video = engine.video;
    this.manifestUrl = manifestUrl;
    this.manifestText = manifestText;
    this.name = 'native-dash';
    this.isAdaptive = true;
    this.mediaSource = null;
    this.objectUrl = '';
    this.audio = null;
    this.audioReps = [];
    this.videoReps = [];
    this.activeVideo = null;
    this.blacklisted = {};
    this.abortController = null;
    this.destroyed = false;
    this.fillTimer = null;
    this.pendingSeek = 0;
    this.bandwidth = engine._player.config.abr.defaultBandwidthEstimate || 3000000;
    this.manualTrackId = null;
    this.controllers = [];
    this.requestGeneration = 0;
    this.appendFailures = 0;
    this.activeRanges = {};
    this.lastSwitchAt = 0;
    this.lastSwitchReason = 'startup';
    this.lastBandwidthSample = 0;
    this.bandwidthSamples = 0;
    this.recoveryCount = 0;
    this.rebufferCount = 0;
    this.rebufferStartedAt = 0;
    this.rebufferDuration = 0;
    this.lastError = '';
    this.lastHttpStatus = 0;
    this.stallReports = 0;
    this.stallRecoveryStage = 0;
    this.quotaRecoveries = 0;
    this.unsupportedVideoCount = 0;
    this.unsupportedAudioCount = 0;
    this.live = false;
    this.liveWindow = null;
    this.liveLatency = 0;
    this.atLiveEdge = false;
    this.manifestRefreshCount = 0;
    this.manifestRefreshFailed = false;
    this.minimumUpdatePeriod = 0;
    this.manifestRefreshTimer = null;
    this.gapJumpCount = 0;
    this.lastGapSize = 0;
    this.capabilityProbeCount = 0;
    this.unsupportedCapabilityCount = 0;
    this.startupBufferComplete = false;
    this.startupBufferStartedAt = 0;
    this.startupBufferMs = 0;
    this.firstPlayableRange = null;
    this.seekBufferPending = false;
    this.seekBufferReadyCount = 0;
    this.seekCount = 0;
    this.seekCancelCount = 0;
    this.seekAbortCount = 0;
    this.lastSeekTarget = 0;
    this.lastSeekStartedAt = 0;
    this.lastSeekMs = 0;
    this._lastSeekHandledTarget = null;
    this._lastSeekHandledAt = 0;
    this.requestCancellationCount = 0;
    this.mediaFetchCompletedCount = 0;
    this.mediaFetchTotalMs = 0;
    this.mediaFetchRetryCount = 0;
    this.mediaUrlRefreshCount = 0;
    this.lastRecoveryReason = '';
    this.manifestRefreshReason = '';
    this.schedulerBackpressureCount = 0;
    this.lastSchedulerBackpressureAt = 0;
    this.schedulerDrainCount = 0;
    this.periodCount = 0;
    this.manifestProfile = '';
    this.manifestCompatibilityWarnings = [];
    this.textReps = [];
    this.imageReps = [];
    this.imageRepCount = 0;
    this.activeTextTrackId = '';
    this.textTrackVisibility = false;
    this.textCueCache = {};
    this.textLoadStates = {};
    this.lastTextTrackError = '';
    this.segmentCacheHitCount = 0;
    this.segmentCacheMissCount = 0;
    this.lastOfflineError = '';
    this.nativeRecoveryAttemptCount = 0;
    this.nativeRecoverySuccessCount = 0;
    this.lastNativeRecoveryReason = '';
    this.nativeRecoveryInProgress = false;
    this.nativeRecoveryReasons = {};
    this.periodTransitionCount = 0;
    this.sourceBufferRebuildAttemptCount = 0;
    this.sourceBufferRebuildSuccessCount = 0;
    this.lastPeriodTransitionReason = '';
    this.lastPeriodTransitionError = '';
    this.drmInfo = null;
    this.mediaKeys = null;
    this.drmSessions = [];
    this.drmSessionCount = 0;
    this.drmLicenseRequestCount = 0;
    this.lastDrmError = '';
    this.nativeUnsupportedReason = '';
    this.fatalError = '';
    this.timelineRegions = [];
    this.timelineRegionKeys = {};
    this.lastTimelineRegion = null;
    this.manifestStartTime = null;
    this.imageSegmentCount = 0;
    this.vodEndOfStreamCount = 0;
  }

  NativeDashProvider.prototype.load = function () {
    var self = this;
    var parsed = parseMPD(this.manifestText, this.manifestUrl);
    this.duration = parsed.duration;
    this.live = parsed.type === 'dynamic';
    this.minimumUpdatePeriod = parsed.minimumUpdatePeriod || 0;
    this.liveWindow = parsed.liveWindow || null;
    this.periodCount = parsed.periodCount || 0;
    this.manifestProfile = parsed.profile || '';
    this.manifestCompatibilityWarnings = parsed.warnings || [];
    this.textReps = parsed.text || [];
    this.imageReps = parsed.images || [];
    this.imageRepCount = this.imageReps.length;
    this.imageSegmentCount = this.imageReps.reduce(function (count, rep) { return count + ((rep.segments && rep.segments.length) || (rep.templateSegments && rep.templateSegments.length) || 0); }, 0);
    addTimelineRegions(this, parsed.timelineRegions || []);
    this.engine.setLive(this.live);
    this.unsupportedVideoCount = parsed.video.filter(function (rep) { return !isSupportedRepresentation(rep); }).length;
    this.unsupportedAudioCount = parsed.audio.filter(function (rep) { return !isSupportedRepresentation(rep); }).length;
    var supportedVideo = parsed.video.filter(function (rep) { return isSupportedRepresentation(rep); });
    var supportedAudio = parsed.audio.filter(function (rep) { return isSupportedRepresentation(rep); });
    return this._probeCapabilities(supportedVideo.concat(supportedAudio)).then(function () {
    self.videoReps = supportedVideo.filter(function (rep) { return self._isCapabilityAllowed(rep); });
    self.audioReps = supportedAudio.filter(function (rep) { return self._isCapabilityAllowed(rep); });
    self.unsupportedCapabilityCount = supportedVideo.concat(supportedAudio).length - self.videoReps.length - self.audioReps.length;
    if (self.unsupportedCapabilityCount > 0) {
      self.engine._telemetry.record('capability-skip', { unsupportedCapabilityCount: self.unsupportedCapabilityCount });
    }
    self.audioReps.sort(function (a, b) { return compareAudioReps(a, b); });
    self.audio = self.audioReps[0] || null;
    if (!self.videoReps.length) throw nativeTerminalError(self, 'dash-no-supported-video');
    if (!self.audio) throw nativeTerminalError(self, 'dash-no-supported-audio');
    self.videoReps.sort(function (a, b) { return compareVideoReps(a, b); });
    self.activeVideo = self.chooseVideoRep();
    self.startupBufferStartedAt = performance.now();
    console.log('[native-dash] selected video id=' + self.activeVideo.id + ' height=' + self.activeVideo.height + ' codec=' + self.activeVideo.codecs);

    self.engine._assetUri = self.manifestUrl;
    return self._ensureDrmReady().then(function () {
    return new Promise(function (resolve, reject) {
      self.mediaSource = new MediaSource();
      self.objectUrl = URL.createObjectURL(self.mediaSource);
      self.video.src = self.objectUrl;
      self.mediaSource.addEventListener('sourceopen', function () {
        self._open().then(function () {
          self.engine._player.emit('loaded');
          self.engine._player.emit('trackschanged');
          self.engine._setState('ready');
          resolve();
        }).catch(reject);
      }, { once: true });
    });
    });
    });
  };

  NativeDashProvider.prototype._open = function () {
    var self = this;
    this.mediaSource.duration = this.live ? Infinity : (this.duration || NaN);
    this.videoSb = this.mediaSource.addSourceBuffer(mime(this.activeVideo));
    this.audioSb = this.mediaSource.addSourceBuffer(mime(this.audio));
    this.videoMime = mime(this.activeVideo);
    this.audioMime = mime(this.audio);
    this.videoSb.mode = 'segments';
    this.audioSb.mode = 'segments';
    this.video.addEventListener('timeupdate', this._boundTick = function () { self._tick(); });
    this.video.addEventListener('seeking', this._boundSeek = function () {
      self._onSeek();
    });
    this.video.addEventListener('waiting', this._boundWaiting = function () { self._onWaiting(); });
    this.video.addEventListener('playing', this._boundPlaying = function () { self._onPlaying(); });
    return Promise.all([
      this._prepareRep(this.activeVideo),
      this._prepareRep(this.audio)
    ]).then(function () {
      return appendBuffer(self.videoSb, self.activeVideo.initData);
    }).then(function () {
      self.activeVideo._appendedInitKey = self.activeVideo.generationKey || generationKeyForRep(self.activeVideo);
      return appendBuffer(self.audioSb, self.audio.initData);
    }).then(function () {
      self.audio._appendedInitKey = self.audio.generationKey || generationKeyForRep(self.audio);
      if (self.live) self._startNearLiveEdge();
      self._tick(true);
      self.fillTimer = setInterval(function () { self._tick(); }, 1000);
      self._scheduleManifestRefresh();
    });
  };

  NativeDashProvider.prototype._ensureDrmReady = function () {
    var drmInfo = chooseDrmInfo([this.activeVideo, this.audio], this.engine._player.config.drm || {});
    if (!drmInfo) return Promise.resolve();
    this.drmInfo = drmInfo;
    if (!drmInfo.keySystem) {
      this.lastDrmError = 'dash-drm-unsupported';
      return Promise.reject(new Error(this.lastDrmError));
    }
    if (drmInfo.keySystem === 'com.widevine.alpha' && !drmInfo.licenseServerUrl) {
      this.lastDrmError = 'dash-widevine-license-unconfigured';
      return Promise.reject(dashNativeTerminalError(this, this.lastDrmError));
    }
    if (drmInfo.keySystem === 'com.microsoft.playready') {
      this.lastDrmError = 'dash-playready-unsupported';
      return Promise.reject(dashNativeTerminalError(this, this.lastDrmError));
    }
    if (drmInfo.keySystem !== 'org.w3.clearkey' && drmInfo.keySystem !== 'com.widevine.alpha') {
      this.lastDrmError = 'dash-drm-keysystem-unsupported';
      return Promise.reject(new Error(this.lastDrmError));
    }
    var clearKeys = normalizedClearKeys((this.engine._player.config.drm || {}).clearKeys || {});
    if (drmInfo.keySystem === 'org.w3.clearkey' && !drmInfo.licenseServerUrl && !countKeys(clearKeys)) {
      this.lastDrmError = 'dash-clearkey-license-unconfigured';
      return Promise.reject(new Error(this.lastDrmError));
    }
    if (!navigator.requestMediaKeySystemAccess) {
      this.lastDrmError = 'dash-eme-unavailable';
      return Promise.reject(new Error(this.lastDrmError));
    }
    var self = this;
    var config = {
      initDataTypes: ['cenc', 'keyids'],
      videoCapabilities: this.activeVideo ? [{ contentType: mime(this.activeVideo) }] : [],
      audioCapabilities: this.audio ? [{ contentType: mime(this.audio) }] : []
    };
    return navigator.requestMediaKeySystemAccess(drmInfo.keySystem, [config]).then(function (access) {
      return access.createMediaKeys();
    }).then(function (mediaKeys) {
      self.mediaKeys = mediaKeys;
      return self.video.setMediaKeys ? self.video.setMediaKeys(mediaKeys) : Promise.resolve();
    }).then(function () {
      self._boundEncrypted = function (event) { self._onEncrypted(event); };
      self.video.addEventListener('encrypted', self._boundEncrypted);
      self.engine._telemetry.record('drm-ready', { drmKeySystem: drmInfo.keySystem });
    }).catch(function (err) {
      self.lastDrmError = err && err.message ? err.message : 'dash-drm-setup-failed';
      throw new Error(self.lastDrmError);
    });
  };

  NativeDashProvider.prototype._onEncrypted = function (event) {
    if (!this.mediaKeys || !this.drmInfo) return;
    var session = this.mediaKeys.createSession();
    var self = this;
    this.drmSessions.push(session);
    this.drmSessionCount = this.drmSessions.length;
    session.addEventListener('message', function (messageEvent) {
      self._handleDrmMessage(session, messageEvent.message).catch(function (err) {
        self._completeDrmTerminalError(err && err.message ? err.message : 'dash-drm-license-failed');
      });
    });
    session.generateRequest(event.initDataType || 'cenc', event.initData).catch(function (err) {
      self._completeDrmTerminalError(err && err.message ? err.message : 'dash-drm-request-failed');
    });
  };

  NativeDashProvider.prototype._completeDrmTerminalError = function (reason) {
    this.lastDrmError = reason || 'dash-drm-runtime-failed';
    this.lastError = this.lastDrmError;
    this.fatalError = this.lastDrmError;
    this.nativeUnsupportedReason = this.lastDrmError;
    if (this.engine && this.engine._completeNativeTerminalError) {
      this.engine._completeNativeTerminalError(dashNativeTerminalError(this, this.lastDrmError));
    }
  };

  NativeDashProvider.prototype._handleDrmMessage = function (session, message) {
    var self = this;
    this.drmLicenseRequestCount++;
    if (this.drmInfo && this.drmInfo.keySystem === 'org.w3.clearkey') {
      var keys = clearKeyJwkSet((this.engine._player.config.drm || {}).clearKeys || {});
      if (!keys.keys.length) return Promise.reject(new Error('dash-clearkey-license-unconfigured'));
      return session.update(new TextEncoder().encode(JSON.stringify(keys))).then(function () {
        self.lastDrmError = '';
      });
    }
    if (!this.drmInfo || !this.drmInfo.licenseServerUrl) return Promise.reject(new Error('dash-drm-license-unconfigured'));
    return nativeNetworkRequest(this.engine, NativeNetworkingEngine.RequestType.LICENSE, {
      uris: [this.drmInfo.licenseServerUrl],
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: message
    }).then(function (resp) {
      if (!networkResponseOk(resp)) throw rangeHttpError(resp.status);
      return resp.data;
    }).then(function (license) {
      return session.update(license);
    }).then(function () {
      self.lastDrmError = '';
    });
  };

  NativeDashProvider.prototype._prepareRep = function (rep) {
    var self = this;
    if (rep.initData && rep.segments) return Promise.resolve(rep);
    if (rep.initUrl && rep.segments) {
      return this._fetchRange(rep.initUrl, rep.initRange || null, { measureBandwidth: false, phase: 'metadata' }).then(function (initData) {
        rep.initData = initData;
        cacheInitData(rep, rep.generationKey || generationKeyForRep(rep), initData);
        if (!rep.duration && rep.segments.length) rep.duration = rep.segments[rep.segments.length - 1].end;
        return rep;
      }).catch(function (err) {
        self.engine._enterServerDown('segmentlist-fetch');
        throw err;
      });
    }
    if (rep.initUrl && rep.templateSegments) {
      return this._fetchRange(rep.initUrl, null, { measureBandwidth: false, phase: 'metadata' }).then(function (initData) {
        rep.initData = initData;
        cacheInitData(rep, rep.generationKey || generationKeyForRep(rep), initData);
        rep.segments = rep.templateSegments.slice();
        if (!rep.duration && rep.segments.length) rep.duration = rep.segments[rep.segments.length - 1].end;
        return rep;
      }).catch(function (err) {
        self.engine._enterServerDown('template-fetch');
        throw err;
      });
    }
    return Promise.all([
      this._fetchRange(rep.baseUrl, rep.initRange, { measureBandwidth: false, phase: 'metadata' }),
      this._fetchRange(rep.baseUrl, rep.indexRange, { measureBandwidth: false, phase: 'metadata' })
    ]).then(function (parts) {
      rep.initData = parts[0];
      cacheInitData(rep, rep.generationKey || generationKeyForRep(rep), parts[0]);
      rep.segments = parseSidx(parts[1], rep.indexRange.end).map(function (segment) {
        segment.url = rep.baseUrl;
        return segment;
      });
      if (!rep.segments.length) throw new Error('empty-sidx-' + rep.id);
      if (!rep.duration && rep.segments.length) rep.duration = rep.segments[rep.segments.length - 1].end;
      return rep;
    }).catch(function (err) {
      self.engine._enterServerDown('range-fetch');
      throw err;
    });
  };

  NativeDashProvider.prototype._fetchRange = function (url, range, opts) {
    var self = this;
    opts = opts || {};
    var generation = opts.generation || this.requestGeneration;
    var retry = effectiveRetryParameters(this);
    var attempts = opts.attempts || retry.maxAttempts;
    var attempt = opts.attempt || 1;
    var phase = opts.phase || 'media';
    var controller = new AbortController();
    this.controllers.push(controller);
    var started = performance.now();
    var headers = {};
    if (range) headers.Range = 'bytes=' + range.start + '-' + range.end;
    return nativeNetworkRequest(this.engine, NativeNetworkingEngine.RequestType.SEGMENT, {
      uris: [url],
      method: 'GET',
      headers: headers
    }, { signal: controller.signal, forceNetworkHold: opts.forceNetworkHold || (attempt >= attempts && phase === 'media') }).then(function (resp) {
      removeItem(self.controllers, controller);
      if (generation !== self.requestGeneration) throw abortError();
      var swInfo = readServiceWorkerSource(resp);
      if (swInfo.cached) self.segmentCacheHitCount++;
      if (swInfo.offline && !swInfo.cached) {
        self.segmentCacheMissCount++;
        self.lastOfflineError = 'offline-cache-miss';
      }
      if (swInfo.cached || swInfo.offline || swInfo.source) {
        self.engine._recordOfflineSource(swInfo.source, swInfo.offline, swInfo.cached);
      }
      if (resp.status === 401 || resp.status === 403 || resp.status >= 500) {
        self.lastHttpStatus = resp.status;
        if (swInfo.offline) {
          self.lastOfflineError = 'offline-segment-http-' + resp.status;
          self.engine._recordOfflineError(new Error(self.lastOfflineError));
        }
        if (phase !== 'media') self.engine._enterServerDown(resp.status === 401 ? 'token-expired' : 'server-error');
        if (phase === 'media' && resp.status === 401) self.engine._refreshToken();
        throw rangeHttpError(resp.status);
      }
      if (resp.status === 408 || resp.status === 429) {
        self.lastHttpStatus = resp.status;
        throw rangeHttpError(resp.status);
      }
      if (!networkResponseOk(resp) && resp.status !== 206) {
        self.lastHttpStatus = resp.status;
        if (swInfo.offline) {
          self.lastOfflineError = 'offline-segment-http-' + resp.status;
          self.engine._recordOfflineError(new Error(self.lastOfflineError));
        }
        throw rangeHttpError(resp.status);
      }
      var buf = resp.data;
      if (generation !== self.requestGeneration) throw abortError();
      if (opts.measureBandwidth !== false) {
        var elapsed = Math.max(1, performance.now() - started);
        self._recordBandwidthSample(buf.byteLength, elapsed);
      }
      return buf;
    }).catch(function (err) {
      removeItem(self.controllers, controller);
      if (err.name === 'AbortError' || generation !== self.requestGeneration) throw abortError();
      if (attempt < attempts && isTransientRequestError(err)) {
        var delay = retryDelay(retry, attempt);
        self._recordRangeRecovery(err);
        console.warn('[native-dash] retrying range request attempt=' + (attempt + 1) + ' reason=' + err.message);
        return wait(delay).then(function () {
          return self._fetchRange(url, range, {
            generation: generation,
            measureBandwidth: opts.measureBandwidth,
            phase: phase,
            attempts: attempts,
            attempt: attempt + 1
          });
        });
      }
      self._recordRangeError(err);
      throw err;
    });
  };

  NativeDashProvider.prototype._recordRangeRecovery = function (err) {
    this.recoveryCount++;
    this.mediaFetchRetryCount++;
    this.lastError = err && err.message ? err.message : 'range-retry';
    this.lastRecoveryReason = this.lastError;
    if (err && err.status) this.lastHttpStatus = err.status;
  };

  NativeDashProvider.prototype._recordRangeError = function (err) {
    this.lastError = err && err.message ? err.message : 'range-error';
    if (err && err.status) this.lastHttpStatus = err.status;
  };

  NativeDashProvider.prototype._recordBandwidthSample = function (byteLength, elapsedMs) {
    var sample = (byteLength * 8 * 1000) / Math.max(1, elapsedMs);
    if (!isFinite(sample) || sample <= 0) return;
    this.lastBandwidthSample = sample;
    this.bandwidthSamples++;
    this.bandwidth = this.bandwidth ? (this.bandwidth * 0.7 + sample * 0.3) : sample;
  };

  NativeDashProvider.prototype._probeCapabilities = function (reps) {
    var self = this;
    if (!navigator.mediaCapabilities || !navigator.mediaCapabilities.decodingInfo) {
      reps.forEach(function (rep) { rep.capability = defaultCapability(rep); });
      return Promise.resolve();
    }
    return Promise.all(reps.map(function (rep) {
      self.capabilityProbeCount++;
      return navigator.mediaCapabilities.decodingInfo(mediaCapabilityConfig(rep)).then(function (info) {
        rep.capability = {
          probed: true,
          supported: info.supported !== false,
          smooth: info.smooth !== false,
          powerEfficient: info.powerEfficient === true
        };
      }).catch(function () {
        rep.capability = defaultCapability(rep);
      });
    })).then(function () {});
  };

  NativeDashProvider.prototype._isCapabilityAllowed = function (rep) {
    var cap = rep.capability || defaultCapability(rep);
    rep.capability = cap;
    return cap.supported !== false && cap.smooth !== false;
  };

  NativeDashProvider.prototype._tick = function (force) {
    if (this.destroyed || !this.activeVideo || !this.audio) return;
    if (this.live) this._updateLivePositionStats();
    this._jumpSmallGap();
    var ahead = getBufferAhead(this.video);
    if (!force && ahead >= this._bufferAheadGoal()) return;
    this._maybeSwitchAuto();
    if (!this.startupBufferComplete || this.seekBufferPending) {
      this._scheduleMediaRequests(this.seekBufferPending ? this._seekBufferGoal() : this._startupBufferGoal());
    } else {
      this._scheduleMediaRequests();
    }
    this._trim();
    this._checkBufferMilestones();
  };

  NativeDashProvider.prototype._appendNext = function (rep, sb, windowGoal) {
    if (!rep || !sb) return;
    this._scheduleMediaRequests(windowGoal, [{ rep: rep, sb: sb }]);
  };

  NativeDashProvider.prototype._scheduleMediaRequests = function (windowGoal, tracks) {
    if (this.destroyed) return;
    tracks = tracks || [
      { rep: this.activeVideo, sb: this.videoSb },
      { rep: this.audio, sb: this.audioSb }
    ];
    for (var i = 0; i < tracks.length; i++) this._drainAppendQueue(tracks[i].rep, tracks[i].sb);
    var capacity = this._maxConcurrentMediaRequests() - countKeys(this.activeRanges);
    if (capacity <= 0) {
      this.schedulerBackpressureCount = (this.schedulerBackpressureCount || 0) + 1;
      var now = performance.now();
      if (this.engine && this.engine._telemetry && (!this.lastSchedulerBackpressureAt || now - this.lastSchedulerBackpressureAt > 1000)) {
        this.lastSchedulerBackpressureAt = now;
        this.engine._telemetry.record('scheduler-backpressure', {
          mediaFetchInFlightCount: countKeys(this.activeRanges)
        });
      }
      return;
    }
    var candidates = this._buildSegmentCandidates(windowGoal, tracks);
    for (var j = 0; j < candidates.length && capacity > 0; j++) {
      if (this._startSegmentFetch(candidates[j].rep, candidates[j].sb, candidates[j].seg)) capacity--;
    }
    for (var k = 0; k < tracks.length; k++) this._drainAppendQueue(tracks[k].rep, tracks[k].sb);
  };

  NativeDashProvider.prototype._buildSegmentCandidates = function (windowGoal, tracks) {
    var ct = this.video.currentTime || 0;
    if (this.live && this.liveWindow && ct < this.liveWindow.start) ct = this.liveWindow.start;
    var target = ct + (windowGoal || this._bufferAheadGoal());
    var readyGoal = Math.min(windowGoal || this._bufferAheadGoal(), this._bufferAheadGoal());
    var candidates = [];
    tracks = tracks || [
      { rep: this.activeVideo, sb: this.videoSb },
      { rep: this.audio, sb: this.audioSb }
    ];
    for (var i = 0; i < tracks.length; i++) {
      var rep = tracks[i].rep;
      if (!rep || !rep.segments) continue;
      for (var j = 0; j < rep.segments.length; j++) {
        var seg = rep.segments[j];
        if (seg.state === 'expired' || seg.end <= ct - 0.5 || seg.start >= target || isSegmentBusyOrDone(seg)) continue;
        candidates.push({
          rep: rep,
          sb: tracks[i].sb,
          seg: seg,
          priority: segmentPriority(seg, ct, readyGoal)
        });
      }
    }
    candidates.sort(function (a, b) {
      if (a.priority !== b.priority) return a.priority - b.priority;
      if (a.seg.start !== b.seg.start) return a.seg.start - b.seg.start;
      if (a.rep.kind !== b.rep.kind) return a.rep.kind === 'video' ? -1 : 1;
      return String(a.rep.id).localeCompare(String(b.rep.id));
    });
    return candidates;
  };

  NativeDashProvider.prototype._startSegmentFetch = function (rep, sb, next) {
    var self = this;
    if (!rep || !sb || !next) return false;
    var ct = this.video.currentTime || 0;
    if (next.state === 'expired' || next.end <= ct - 0.5 || isSegmentBusyOrDone(next)) return false;
    var rangeKey = next.range
      ? rep.id + ':' + next.range.start + '-' + next.range.end
      : rep.id + ':' + next.url;
    if (this.activeRanges[rangeKey]) return false;
    this.activeRanges[rangeKey] = true;
    next.state = 'fetching';
    next._fetchStartedAt = performance.now();
    this._fetchRange(next.url || rep.baseUrl, next.range || null, {
      generation: this.requestGeneration,
      measureBandwidth: rep.kind === 'video',
      phase: 'media'
    }).then(function (data) {
      delete self.activeRanges[rangeKey];
      next.state = 'fetched';
      next._data = data;
      var elapsed = Math.max(1, performance.now() - (next._fetchStartedAt || performance.now()));
      self.mediaFetchCompletedCount++;
      self.mediaFetchTotalMs += elapsed;
      if (self.engine && self.engine._telemetry) self.engine._telemetry.record('media-fetch-complete', {
        mediaFetchMs: elapsed,
        mediaFetchInFlightCount: countKeys(self.activeRanges)
      });
      self._drainAppendQueue(rep, sb);
      self._tick();
    }).catch(function (err) {
      delete self.activeRanges[rangeKey];
      delete next._fetchStartedAt;
      if (err.name !== 'AbortError') {
        if (self._shouldRefreshAfterMediaError(err, next)) {
          next._nativeRecovered = true;
          next.state = 'recovering';
          next.appended = false;
          self._recoverMediaRequest(rep, err).then(function () {
            if (self.destroyed) return;
            next.state = '';
            next.appended = false;
            self._tick(true);
          }).catch(function (refreshErr) {
            next.state = 'failed';
            next.appended = false;
            self._handleAppendFailure(rep, refreshErr);
          });
          return;
        }
        next.state = 'failed';
        next.appended = false;
        self._handleAppendFailure(rep, err);
      }
    });
    return true;
  };

  NativeDashProvider.prototype._shouldRefreshAfterMediaError = function (err, seg) {
    if (!err || !seg || seg._nativeRecovered) return false;
    if (this.destroyed || err.name === 'AbortError') return false;
    if (this.engine && this.engine._offlinePlayback) return false;
    return isRefreshableRequestError(err);
  };

  NativeDashProvider.prototype._recoverMediaRequest = function (rep, err) {
    var reason = err && err.message ? err.message : 'media-request-failed';
    this.mediaUrlRefreshCount++;
    this.recoveryCount++;
    this.lastRecoveryReason = reason;
    this.manifestRefreshReason = 'media-error';
    this.lastError = reason;
    if (err && err.status) this.lastHttpStatus = err.status;
    if (this.engine && this.engine._telemetry) {
      this.engine._telemetry.record('recovery', {
        lastError: reason,
        mediaUrlRefreshCount: this.mediaUrlRefreshCount
      });
    }
    console.warn('[native-dash] refreshing manifest after media error rep=' + (rep && rep.id ? rep.id : '') + ' reason=' + reason);
    return this._refreshPlaybackManifest('media-error');
  };

  NativeDashProvider.prototype._drainAppendQueue = function (rep, sb) {
    var self = this;
    if (!rep || !rep.segments || !sb || sb.updating || rep._appending) return false;
    var next = nextFetchedSegmentForAppend(rep, this.video.currentTime || 0);
    if (!next) return false;
    rep._appending = true;
    next.state = 'appending';
    var data = next._data;
    delete next._data;
    this._appendSegmentData(rep, sb, next, data).then(function () {
      next.state = 'appended';
      next.appended = true;
      delete next._fetchStartedAt;
      rep._appending = false;
      self.appendFailures = 0;
      self.stallReports = 0;
      self.stallRecoveryStage = 0;
      self.engine._player.emit('adaptation');
      self.schedulerDrainCount++;
      if (self.engine && self.engine._telemetry) self.engine._telemetry.record('scheduler-drain', {
        schedulerQueueDepth: self._schedulerQueueDepth()
      });
      self._drainAppendQueue(rep, sb);
      self._maybeEndVodStream();
      self._tick();
    }).catch(function (err) {
      rep._appending = false;
      if (err.name !== 'AbortError') {
        next.state = 'failed';
        next.appended = false;
        self._handleAppendFailure(rep, err);
      }
    });
    return true;
  };

  NativeDashProvider.prototype._maybeEndVodStream = function () {
    if (this.live || !this.mediaSource || this.mediaSource.readyState !== 'open') return false;
    if ((this.videoSb && this.videoSb.updating) || (this.audioSb && this.audioSb.updating)) return false;
    if (!this.activeVideo || !segmentsAppendedThroughEnd(this.activeVideo.segments, this.duration)) return false;
    if (this.audio && !segmentsAppendedThroughEnd(this.audio.segments, this.duration)) return false;
    try {
      this.mediaSource.endOfStream();
      this.vodEndOfStreamCount++;
      return true;
    } catch (e) {
      return false;
    }
  };

  NativeDashProvider.prototype._selectNextSegment = function (rep, currentTime, targetTime) {
    if (!rep || !rep.segments) return null;
    var candidates = rep.segments.filter(function (seg) {
      return seg.state !== 'expired' && seg.end > currentTime - 0.5 && seg.start < targetTime && !isSegmentBusyOrDone(seg);
    });
    if (!candidates.length) return null;
    candidates.sort(function (a, b) {
      var aDistance = Math.max(0, a.start - currentTime);
      var bDistance = Math.max(0, b.start - currentTime);
      if (aDistance !== bDistance) return aDistance - bDistance;
      return a.start - b.start;
    });
    return candidates[0];
  };

  NativeDashProvider.prototype._appendSegmentData = function (rep, sb, seg, data) {
    var self = this;
    var prepare = this._prepareSegmentGeneration ? this._prepareSegmentGeneration(rep, sb, seg) : Promise.resolve();
    return prepare.then(function () {
      var activeSb = rep && rep.kind === 'audio' ? self.audioSb : self.videoSb;
      return appendBuffer(activeSb || sb, data, seg.appendWindow);
    }).catch(function (err) {
      if (!isQuotaExceeded(err)) throw err;
      self.quotaRecoveries++;
      self.lastError = 'quota-exceeded';
      self.engine._telemetry.record('recovery', { lastError: 'quota-exceeded' });
      return self._recoverQuota(rep, sb, data).catch(function (retryErr) {
        seg.state = 'failed';
        throw retryErr;
      });
    });
  };

  NativeDashProvider.prototype._prepareSegmentGeneration = function (rep, sb, seg) {
    if (!rep || !seg) return Promise.resolve();
    var key = seg.generationKey || rep.generationKey || generationKeyForRep(rep);
    var nextMime = segmentMime(seg, rep);
    var currentMime = rep.kind === 'audio' ? this.audioMime : this.videoMime;
    var self = this;
    var chain = Promise.resolve();
    if (nextMime && nextMime !== currentMime) {
      if (!window.MediaSource || !MediaSource.isTypeSupported(nextMime)) {
        this.lastPeriodTransitionReason = 'unsupported-codec';
        this.lastPeriodTransitionError = 'dash-period-codec-change-unsupported';
        return Promise.reject(new Error('dash-period-codec-change-unsupported'));
      }
      var typeRep = {
        mimeType: seg.mimeType || rep.mimeType,
        codecs: seg.codecs || rep.codecs
      };
      chain = chain.then(function () {
        var change = rep.kind === 'audio' ? self._changeAudioTypeIfNeeded(typeRep) : self._changeVideoTypeIfNeeded(typeRep);
        return change.then(function () {
          self.periodTransitionCount = (self.periodTransitionCount || 0) + 1;
          self.lastPeriodTransitionReason = 'changeType';
          self.lastPeriodTransitionError = '';
        }).catch(function (err) {
          return self._rebuildSourceBufferForPeriod(rep, sb, seg, nextMime, err).catch(function (rebuildErr) {
            self.lastPeriodTransitionError = rebuildErr && rebuildErr.message ? rebuildErr.message : 'dash-period-codec-change-unsupported';
            throw new Error('dash-period-codec-change-unsupported');
          });
        });
      });
    }
    return chain.then(function () {
      if (rep._appendedInitKey === key) return;
      return self._initDataForSegment(rep, seg).then(function (initData) {
        var activeSb = rep && rep.kind === 'audio' ? self.audioSb : self.videoSb;
        return appendBuffer(activeSb || sb, initData, seg.appendWindow).then(function () {
          rep._appendedInitKey = key;
        });
      });
    });
  };

  NativeDashProvider.prototype._rebuildSourceBufferForPeriod = function (rep, sb, seg, nextMime, previousError) {
    if (!rep || !sb || !seg || !nextMime) return Promise.reject(new Error('dash-period-codec-change-unsupported'));
    if (!this.mediaSource || this.mediaSource.readyState !== 'open' || !this.mediaSource.addSourceBuffer || !this.mediaSource.removeSourceBuffer) {
      return Promise.reject(new Error('dash-period-sourcebuffer-rebuild-unavailable'));
    }
    var self = this;
    var kind = rep.kind === 'audio' ? 'audio' : 'video';
    this.periodTransitionCount = (this.periodTransitionCount || 0) + 1;
    this.sourceBufferRebuildAttemptCount = (this.sourceBufferRebuildAttemptCount || 0) + 1;
    this.lastPeriodTransitionReason = previousError && previousError.message ? previousError.message : 'sourcebuffer-rebuild';
    this.lastPeriodTransitionError = '';
    if (this.engine && this.engine._telemetry) {
      this.engine._telemetry.record('recovery', {
        lastError: 'dash-period-sourcebuffer-rebuild',
        periodTransitionReason: this.lastPeriodTransitionReason
      });
    }
    return waitForSourceBufferIdle(sb).then(function () {
      try {
        if (sb.abort && !sb.updating) sb.abort();
      } catch (e) {}
      try {
        self.mediaSource.removeSourceBuffer(sb);
      } catch (e) {
        throw new Error('dash-period-sourcebuffer-rebuild-failed');
      }
      var replacement;
      try {
        replacement = self.mediaSource.addSourceBuffer(nextMime);
        replacement.mode = 'segments';
      } catch (e) {
        throw new Error('dash-period-sourcebuffer-rebuild-failed');
      }
      if (kind === 'audio') {
        self.audioSb = replacement;
        self.audioMime = nextMime;
      } else {
        self.videoSb = replacement;
        self.videoMime = nextMime;
      }
      markSegmentsUnappended(rep);
      rep._appendedInitKey = '';
      self.sourceBufferRebuildSuccessCount = (self.sourceBufferRebuildSuccessCount || 0) + 1;
      self.lastPeriodTransitionReason = 'sourcebuffer-rebuild';
      self.lastPeriodTransitionError = '';
      return replacement;
    });
  };

  NativeDashProvider.prototype._initDataForSegment = function (rep, seg) {
    var key = seg.generationKey || rep.generationKey || generationKeyForRep(rep);
    rep._initDataByKey = rep._initDataByKey || {};
    if (rep._initDataByKey[key]) return Promise.resolve(rep._initDataByKey[key]);
    var initUrl = seg.initUrl || rep.initUrl;
    var initRange = seg.initRange || rep.initRange || null;
    if (!initUrl && rep.baseUrl && rep.initRange) initUrl = rep.baseUrl;
    if (!initUrl) return Promise.reject(new Error('dash-period-init-missing'));
    var self = this;
    return this._fetchRange(initUrl, initRange, { measureBandwidth: false, phase: 'metadata' }).then(function (initData) {
      cacheInitData(rep, key, initData);
      return initData;
    }).catch(function (err) {
      self.engine._enterServerDown('period-init-fetch');
      throw err;
    });
  };

  NativeDashProvider.prototype._recoverQuota = function (rep, sb, data) {
    var self = this;
    var removeEnd = Math.max(0, (this.video.currentTime || 0) - 5);
    return Promise.all([
      removeBufferBefore(this.videoSb, removeEnd),
      removeBufferBefore(this.audioSb, removeEnd)
    ]).then(function () {
      return appendBuffer(sb, data);
    }).catch(function (err) {
      if (!isQuotaExceeded(err) || rep.kind !== 'video') throw err;
      var lower = self._lowerVideoRep();
      if (!lower) throw err;
      self.blacklisted[rep.id] = true;
      self._switchVideo(lower, true, 'quota-recovery');
      throw abortError();
    });
  };

  NativeDashProvider.prototype._handleAppendFailure = function (rep, err) {
    this.appendFailures++;
    this._recordRangeError(err);
    if (err && err.message === 'dash-period-codec-change-unsupported') {
      this.lastPeriodTransitionError = err.message;
      this._completeNativeRuntimeTerminal('dash-period-codec-change-unsupported');
      return;
    }
    var recoveryReason = rep.kind === 'video' ? 'native-video-append' : 'native-audio-append';
    this.nativeRecoveryReasons = this.nativeRecoveryReasons || {};
    if (this._tryNativeRecovery && !this.nativeRecoveryReasons[recoveryReason]) {
      this._tryNativeRecovery(recoveryReason).then(function () {}).catch(function () {});
      return;
    }
    if (rep.kind === 'video') {
      this.blacklisted[rep.id] = true;
      console.warn('[native-dash] append error for video id=' + rep.id + ', switching representation:', err.message);
      try {
        this._switchVideo(this.chooseVideoRep(), true);
      } catch (e) {
        this._completeNativeRuntimeTerminal('native-video-append-exhausted');
      }
      return;
    }
    if (this.appendFailures >= 2) this._completeNativeRuntimeTerminal('native-audio-append-failed');
  };

  NativeDashProvider.prototype._completeNativeRuntimeTerminal = function (reason) {
    this.lastError = reason || this.lastError || 'dash-runtime-exhausted';
    this.fatalError = this.lastError;
    this.nativeUnsupportedReason = this.lastError;
    if (this.engine && this.engine._completeNativeTerminalError) {
      this.engine._completeNativeTerminalError(nativeTerminalError(this, this.lastError));
    }
  };

  NativeDashProvider.prototype._tryNativeRecovery = function (reason) {
    if (this.destroyed || this.nativeRecoveryInProgress) return Promise.resolve(false);
    this.nativeRecoveryInProgress = true;
    this.nativeRecoveryAttemptCount++;
    this.recoveryCount++;
    this.lastNativeRecoveryReason = reason;
    this.nativeRecoveryReasons = this.nativeRecoveryReasons || {};
    this.nativeRecoveryReasons[reason] = true;
    this.lastError = reason;
    if (this.engine && this.engine._telemetry) this.engine._telemetry.record('recovery', { lastError: reason });
    var self = this;
    var currentTime = this.video.currentTime || 0;
    try { this._abortRequests(); } catch (e) {}
    if (this.activeVideo) {
      markSegmentsForTime(this.activeVideo, currentTime, Math.max(2, this._bufferAheadGoal()));
      this.activeVideo._appendedInitKey = '';
    }
    if (this.audio) {
      markSegmentsForTime(this.audio, currentTime, Math.max(2, this._bufferAheadGoal()));
      this.audio._appendedInitKey = '';
    }
    return Promise.all([
      this.videoSb ? resetSourceBuffer(this.videoSb, currentTime) : Promise.resolve(),
      this.audioSb ? resetSourceBuffer(this.audioSb, currentTime) : Promise.resolve()
    ]).then(function () {
      var chain = Promise.resolve();
      if (self.videoSb && self.activeVideo && self.activeVideo.initData) {
        chain = chain.then(function () {
          return self._changeVideoTypeIfNeeded(self.activeVideo).then(function () {
            return appendBuffer(self.videoSb, self.activeVideo.initData);
          }).then(function () {
            self.activeVideo._appendedInitKey = self.activeVideo.generationKey || generationKeyForRep(self.activeVideo);
          });
        });
      }
      if (self.audioSb && self.audio && self.audio.initData) {
        chain = chain.then(function () {
          return self._changeAudioTypeIfNeeded(self.audio).then(function () {
            return appendBuffer(self.audioSb, self.audio.initData);
          }).then(function () {
            self.audio._appendedInitKey = self.audio.generationKey || generationKeyForRep(self.audio);
          });
        });
      }
      return chain;
    }).then(function () {
      self.nativeRecoverySuccessCount++;
      self.appendFailures = 0;
      self.stallReports = 0;
      self.nativeRecoveryInProgress = false;
      self._tick(true);
      return true;
    }).catch(function (err) {
      self.nativeRecoveryInProgress = false;
      self.lastError = err && err.message ? err.message : reason + '-failed';
      return false;
    });
  };

  NativeDashProvider.prototype._maybeSwitchAuto = function () {
    if (!this.engine._player.config.abr.enabled || this.manualTrackId) return;
    var ahead = getBufferAhead(this.video);
    var current = this.activeVideo;
    var candidates = this._candidateVideos();
    if (!candidates.length) return;
    var previousBandwidth = this.bandwidth;
    var now = performance.now();
    var allowUpgrade = ahead >= ABR_UPGRADE_BUFFER && now - this.lastSwitchAt >= ABR_SWITCH_COOLDOWN_MS;
    if (this.bandwidthSamples < 2 && ahead >= ABR_DOWNGRADE_BUFFER) {
      this.bandwidth = Math.max(this.bandwidth || 0, this.engine._player.config.abr.defaultBandwidthEstimate || 3000000);
    }
    var chosen = this._chooseForBudget(candidates, this.bandwidthSamples < 2 || ahead >= MIN_BUFFER_AHEAD ? 0.8 : 0.55);
    var reason = 'bandwidth';

    if (ahead < ABR_DOWNGRADE_BUFFER && this.bandwidthSamples >= 2) {
      this.bandwidth = previousBandwidth;
      chosen = this._chooseForBudget(candidates, 0.45);
      reason = 'low-buffer';
    }
    this.bandwidth = previousBandwidth;

    if (chosen.id !== current.id && (chosen.height < current.height || allowUpgrade)) {
      this._switchVideo(chosen, false, reason);
    }
  };

  NativeDashProvider.prototype._candidateVideos = function () {
    var playable = this.videoReps.filter(function (rep) {
      return !this.blacklisted[rep.id] && capabilityAllowed(this, rep);
    }, this);
    var filtered = playable.filter(function (rep) {
      return !variantRestricted(this, rep);
    }, this);
    if (filtered.length) return filtered;
    return playable;
  };

  NativeDashProvider.prototype.chooseVideoRep = function () {
    var candidates = this._candidateVideos();
    if (!candidates.length) throw new Error('no-video-representations-after-blacklist');
    if (this.manualTrackId) {
      var manual = candidates.find(function (rep) { return rep.id === this.manualTrackId; }, this);
      if (manual) return manual;
    }
    return this._chooseForBudget(candidates, 0.8);
  };

  NativeDashProvider.prototype._lowerVideoRep = function () {
    if (!this.activeVideo) return null;
    var currentHeight = this.activeVideo.height || 0;
    var family = codecFamily(this.activeVideo.codecs);
    var candidates = this.videoReps.filter(function (rep) {
      return !this.blacklisted[rep.id] && rep.id !== this.activeVideo.id && (rep.height || 0) < currentHeight && codecFamily(rep.codecs) === family;
    }, this);
    if (!candidates.length) {
      candidates = this.videoReps.filter(function (rep) {
        return !this.blacklisted[rep.id] && rep.id !== this.activeVideo.id && (rep.height || 0) < currentHeight;
      }, this);
    }
    candidates.sort(function (a, b) { return (b.height || 0) - (a.height || 0); });
    return candidates[0] || null;
  };

  NativeDashProvider.prototype._chooseForBudget = function (candidates, budgetFactor) {
    var sorted = candidates.slice().sort(function (a, b) {
      var heightDiff = (a.height || 0) - (b.height || 0);
      if (heightDiff) return heightDiff;
      return capabilityPreferenceScore(a) - capabilityPreferenceScore(b);
    });
    if (this.activeVideo) {
      var family = codecFamily(this.activeVideo.codecs);
      var sameFamily = sorted.filter(function (rep) { return codecFamily(rep.codecs) === family; });
      if (sameFamily.length) sorted = sameFamily;
    }
    var budget = effectiveBandwidthEstimate(this) * budgetFactor;
    var chosen = sorted[0];
    for (var i = 0; i < sorted.length; i++) {
      if ((sorted[i].bandwidth || 0) <= budget && isBetterCandidate(sorted[i], chosen)) chosen = sorted[i];
    }
    return chosen;
  };

  NativeDashProvider.prototype._viewportMaxHeight = function () {
    var cfg = this.engine._player.config.abr || {};
    var restrictions = cfg.restrictions || {};
    if (cfg.ignoreViewportSize || restrictions.ignoreViewportSize) return Infinity;
    var rect = this.video.getBoundingClientRect ? this.video.getBoundingClientRect() : null;
    var cssHeight = rect && rect.height ? rect.height : this.video.clientHeight;
    if (!cssHeight || cssHeight < 1) return Infinity;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var target = cssHeight * dpr * 1.25;
    if (target <= 360) return 360;
    if (target <= 480) return 480;
    if (target <= 720) return 720;
    if (target <= 1080) return 1080;
    return Infinity;
  };

  NativeDashProvider.prototype._switchVideo = function (rep, clearBuffer, reason) {
    if (!rep || rep.id === this.activeVideo.id || this.destroyed) return;
    var self = this;
    if (clearBuffer) this._abortRequests();
    this.activeVideo = rep;
    this.lastSwitchAt = performance.now();
    this.lastSwitchReason = reason || (clearBuffer ? 'manual' : 'auto');
    this.engine._player.emit('variantchanged');
    console.log('[native-dash] selected video id=' + rep.id + ' height=' + rep.height + ' codec=' + rep.codecs + ' reason=' + this.lastSwitchReason);
    this._prepareRep(rep).then(function () {
      if (clearBuffer) {
        markSegmentsUnappended(rep);
        return resetSourceBuffer(self.videoSb, self.video.currentTime).then(function () {
          return self._changeVideoTypeIfNeeded(rep);
        }).then(function () {
          return appendBuffer(self.videoSb, rep.initData).then(function () {
            rep._appendedInitKey = rep.generationKey || generationKeyForRep(rep);
          });
        });
      }
      return self._changeVideoTypeIfNeeded(rep).then(function () {
        return appendBuffer(self.videoSb, rep.initData).then(function () {
          rep._appendedInitKey = rep.generationKey || generationKeyForRep(rep);
        }).catch(function () {});
      });
    }).then(function () {
      self._tick(true);
    }).catch(function (err) {
      self.blacklisted[rep.id] = true;
      console.warn('[native-dash] switch failed id=' + rep.id + ': ' + err.message);
    });
  };

  NativeDashProvider.prototype._changeVideoTypeIfNeeded = function (rep) {
    var nextMime = mime(rep);
    if (nextMime === this.videoMime) return Promise.resolve();
    if (!this.videoSb.changeType) return Promise.reject(new Error('sourcebuffer-changeType-unavailable'));
    try {
      this.videoSb.changeType(nextMime);
      this.videoMime = nextMime;
      return Promise.resolve();
    } catch (e) {
      return Promise.reject(e);
    }
  };

  NativeDashProvider.prototype.configure = function () {
    if (!this.manualTrackId) this._maybeSwitchAuto();
  };

  NativeDashProvider.prototype.getVariantTracks = function () {
    var active = this.activeVideo;
    var self = this;
    return this.videoReps.map(function (rep) {
      var cap = rep.capability || defaultCapability(rep);
      var restricted = variantRestricted(self, rep);
      return {
        id: rep.id,
        height: rep.height || 0,
        width: rep.width || 0,
        bandwidth: rep.bandwidth || 0,
        codecs: rep.codecs || '',
        codecFamily: codecFamily(rep.codecs),
        capabilityStatus: capabilityStatus(cap),
        supported: cap.supported !== false,
        restricted: restricted,
        selectable: cap.supported !== false && cap.smooth !== false && !restricted,
        smooth: cap.smooth !== false,
        powerEfficient: cap.powerEfficient === true,
        active: active && rep.id === active.id
      };
    });
  };

  NativeDashProvider.prototype.getActiveVariantTrack = function () {
    var rep = this.activeVideo;
    if (!rep) return null;
    return {
      id: rep.id,
      height: rep.height || 0,
      width: rep.width || 0,
      bandwidth: rep.bandwidth || 0,
      codecs: rep.codecs || '',
      codecFamily: codecFamily(rep.codecs),
      capabilityStatus: capabilityStatus(rep.capability || defaultCapability(rep)),
      supported: !(rep.capability && rep.capability.supported === false),
      restricted: variantRestricted(this, rep),
      selectable: variantSelectable(this, rep),
      smooth: !(rep.capability && rep.capability.smooth === false),
      powerEfficient: !!(rep.capability && rep.capability.powerEfficient === true),
      active: true
    };
  };

  NativeDashProvider.prototype.selectVariantTrack = function (track, clearBuffer) {
    var rep = this.videoReps.find(function (r) { return r.id === track.id || r.height === track.height; });
    if (!rep || !variantSelectable(this, rep)) return;
    this.manualTrackId = rep.id;
    this.engine._player.config.abr.enabled = false;
    this._switchVideo(rep, clearBuffer !== false, 'manual');
  };

  NativeDashProvider.prototype.getAudioTracks = function () {
    var active = this.audio;
    return this.audioReps.map(function (rep) {
      return audioTrackForRep(rep, active && rep.id === active.id);
    });
  };

  NativeDashProvider.prototype.getActiveAudioTrack = function () {
    return this.audio ? audioTrackForRep(this.audio, true) : null;
  };

  NativeDashProvider.prototype.selectAudioTrack = function (track) {
    var rep = this.audioReps.find(function (r) { return r.id === track.id || r.language === track.language; });
    if (!rep || this.destroyed || this.audio && rep.id === this.audio.id) return;
    this._switchAudio(rep);
  };

  NativeDashProvider.prototype.getTextTracks = function () {
    var activeId = this.activeTextTrackId;
    return (this.textReps || []).map(function (rep) {
      return textTrackForRep(rep, activeId && rep.id === activeId);
    });
  };

  NativeDashProvider.prototype.getActiveTextTrack = function () {
    var rep = (this.textReps || []).find(function (item) { return item.id === this.activeTextTrackId; }, this);
    return rep ? textTrackForRep(rep, true) : null;
  };

  NativeDashProvider.prototype.selectTextTrack = function (track) {
    var rep = (this.textReps || []).find(function (item) { return item.id === track.id || item.language === track.language; });
    if (!rep || rep.supported === false) return Promise.resolve();
    return selectNativeTextTrack(this, rep, function (active) {
      this.activeTextTrackId = active ? rep.id : '';
    });
  };

  NativeDashProvider.prototype.setTextTrackVisibility = function (visible) {
    this.textTrackVisibility = !!visible;
    if (!visible) {
      this.activeTextTrackId = '';
      clearNativeTextOverlay(this);
    } else {
      updateNativeTextOverlay(this);
    }
    this.engine._player.emit('texttrackchanged', this.getActiveTextTrack());
    return Promise.resolve();
  };

  NativeDashProvider.prototype.getIFrameTracks = function () {
    return (this.imageReps || []).map(function (rep) {
      return {
        id: rep.id,
        url: rep.baseUrl || rep.url || rep.initUrl || '',
        bandwidth: rep.bandwidth || 0,
        width: rep.width || 0,
        height: rep.height || 0,
        codecs: rep.codecs || '',
        pathwayId: '',
        iframeOnly: false,
        imageOnly: true,
        thumbnailType: 'dash-image',
        source: 'native-dash',
        loaded: true
      };
    });
  };

  NativeDashProvider.prototype.getIFramePreview = function (time, trackId) {
    var reps = this.imageReps || [];
    if (!reps.length) return Promise.resolve(null);
    var rep = reps[0];
    if (trackId) {
      var explicit = reps.find(function (item) { return item.id === trackId; });
      if (explicit) rep = explicit;
    }
    var segments = rep.segments || rep.templateSegments || [];
    var segment = nearestIFrameSegment(segments, Number(time) || 0);
    if (!segment) return Promise.resolve(null);
    return Promise.resolve({
      track: {
        id: rep.id,
        bandwidth: rep.bandwidth || 0,
        width: rep.width || 0,
        height: rep.height || 0,
        codecs: rep.codecs || '',
        iframeOnly: false,
        imageOnly: true,
        thumbnailType: 'dash-image',
        source: 'native-dash'
      },
      start: segment.start || 0,
      end: segment.end || segment.start || 0,
      duration: segment.duration || Math.max(0, (segment.end || 0) - (segment.start || 0)),
      url: segment.url || rep.baseUrl || rep.url || '',
      range: segment.range || null,
      tiles: segment.tiles || null,
      imageOnly: true,
      thumbnailType: 'dash-image',
      mediaSequence: segment.mediaSequence || 0
    });
  };

  NativeDashProvider.prototype._switchAudio = function (rep) {
    var self = this;
    this._abortRequests();
    this.audio = rep;
    this.engine._player.emit('audiotrackchanged', this.getActiveAudioTrack());
    console.log('[native-dash] selected audio id=' + rep.id + ' lang=' + (rep.language || '') + ' codec=' + rep.codecs);
    this._prepareRep(rep).then(function () {
      markSegmentsUnappended(rep);
      return resetSourceBuffer(self.audioSb, self.video.currentTime);
    }).then(function () {
      return self._changeAudioTypeIfNeeded(rep);
    }).then(function () {
      return appendBuffer(self.audioSb, rep.initData).then(function () {
        rep._appendedInitKey = rep.generationKey || generationKeyForRep(rep);
      });
    }).then(function () {
      self._tick(true);
    }).catch(function (err) {
      self.lastError = err && err.message ? err.message : 'audio-switch-failed';
      console.warn('[native-dash] audio switch failed id=' + rep.id + ': ' + self.lastError);
    });
  };

  NativeDashProvider.prototype._changeAudioTypeIfNeeded = function (rep) {
    var nextMime = mime(rep);
    if (nextMime === this.audioMime) return Promise.resolve();
    if (!this.audioSb.changeType) return Promise.reject(new Error('sourcebuffer-changeType-unavailable'));
    try {
      this.audioSb.changeType(nextMime);
      this.audioMime = nextMime;
      return Promise.resolve();
    } catch (e) {
      return Promise.reject(e);
    }
  };

  NativeDashProvider.prototype.isLive = function () {
    return !!this.live;
  };

  NativeDashProvider.prototype.getLiveRange = function () {
    var range = this._effectiveLiveWindow ? this._effectiveLiveWindow() : this.liveWindow;
    return range ? { start: range.start, end: range.end } : null;
  };

  NativeDashProvider.prototype.seekRange = function () {
    return this.getLiveRange() || mediaSeekRange(this.video);
  };

  NativeDashProvider.prototype.getBufferedInfo = function () {
    return getBufferedInfoFor(this.video, this.audioSb, this.videoSb);
  };

  NativeDashProvider.prototype.seekToLiveEdge = function () {
    if (!this.live) return;
    var range = this._effectiveLiveWindow ? this._effectiveLiveWindow() : this.liveWindow;
    if (!range) return;
    this.commitSeek(Math.max(range.start, range.end - LIVE_TARGET_LATENCY));
    this._updateLivePositionStats();
  };

  NativeDashProvider.prototype.getStats = function () {
    var quality = this.video.getVideoPlaybackQuality ? this.video.getVideoPlaybackQuality() : null;
    var bufferedInfo = getBufferedInfoFor(this.video, this.audioSb, this.videoSb);
    var bufferedSummary = summarizeBufferedInfo(bufferedInfo);
    return {
      provider: this.name,
      mode: 'dash',
      isLive: this.isLive ? this.isLive() : false,
      assetUri: this.manifestUrl,
      bandwidthEstimate: Math.round(this.bandwidth || 0),
      lastBandwidthSample: Math.round(this.lastBandwidthSample || 0),
      bufferAhead: getBufferAhead(this.video),
      bufferedRangeCount: bufferedSummary.count,
      bufferedStart: bufferedSummary.start,
      bufferedEnd: bufferedSummary.end,
      effectiveBufferingGoal: this._bufferAheadGoal ? this._bufferAheadGoal() : BUFFER_AHEAD,
      effectiveRebufferingGoal: this._rebufferingGoal ? this._rebufferingGoal() : 0.3,
      effectiveBufferBehind: this._bufferBehindGoal ? this._bufferBehindGoal() : BUFFER_BEHIND,
      effectiveAvailabilityWindowOverride: this._availabilityWindowOverride ? this._availabilityWindowOverride() : 0,
      activeVariant: this.getActiveVariantTrack(),
      activeAudio: this.audio ? {
        id: this.audio.id,
        bandwidth: this.audio.bandwidth || 0,
        codecs: this.audio.codecs || '',
        audioSamplingRate: this.audio.asr || 0,
        language: this.audio.language || '',
        label: this.audio.label || '',
        roles: this.audio.roles || [],
        accessibility: this.audio.accessibility || [],
        channels: this.audio.channels || ''
      } : null,
      audioTrackCount: this.audioReps ? this.audioReps.length : (this.audio ? 1 : 0),
      activeTextTrack: this.engine && this.engine._player ? this.engine._player.getActiveTextTrack() : null,
      textTrackCount: this.engine && this.engine._player ? this.engine._player.getTextTracks().length : 0,
      nativeTextTrackCount: this.textReps ? this.textReps.length : 0,
      lastTextTrackError: this.lastTextTrackError || '',
      timelineRegionCount: this.timelineRegions ? this.timelineRegions.length : 0,
      lastTimelineRegion: this.lastTimelineRegion || null,
      imageVariantCount: this.imageRepCount || 0,
      imageSegmentCount: this.imageSegmentCount || 0,
      iframeTracks: this.getIFrameTracks ? this.getIFrameTracks() : [],
      manifestStartTime: isFinite(this.manifestStartTime) ? this.manifestStartTime : null,
      drmKeySystem: this.drmInfo ? this.drmInfo.keySystem : '',
      drmLicenseServerConfigured: !!(this.drmInfo && this.drmInfo.licenseServerUrl),
      drmSessionCount: this.drmSessionCount || 0,
      drmLicenseRequestCount: this.drmLicenseRequestCount || 0,
      lastDrmError: this.lastDrmError || '',
      nativeUnsupportedReason: this.nativeUnsupportedReason || '',
      abrEnabled: !!(this.engine && this.engine._player && this.engine._player.config.abr.enabled),
      activeRestrictions: activeAbrRestrictions(this),
      restrictedVariantCount: restrictedVariantCount(this, this.videoReps),
      effectiveRetryMaxAttempts: effectiveRetryParameters(this).maxAttempts,
      effectiveRetryBaseDelay: effectiveRetryParameters(this).baseDelay,
      unsupportedVideoCount: this.unsupportedVideoCount,
      unsupportedAudioCount: this.unsupportedAudioCount,
      lastSwitchReason: this.lastSwitchReason,
      fallbackReason: this.engine ? (this.engine._fallbackReason || '') : '',
      rebufferCount: this.rebufferCount,
      rebufferDuration: this.rebufferDuration + (this.rebufferStartedAt ? (performance.now() - this.rebufferStartedAt) / 1000 : 0),
      recoveryCount: this.recoveryCount,
      lastError: this.lastError,
      lastHttpStatus: this.lastHttpStatus,
      gapJumpCount: this.gapJumpCount,
      lastGapSize: this.lastGapSize,
      activeCodecFamily: this.activeVideo ? codecFamily(this.activeVideo.codecs) : '',
      capabilityProbeCount: this.capabilityProbeCount,
      unsupportedCapabilityCount: this.unsupportedCapabilityCount,
      startupBufferComplete: this.startupBufferComplete,
      startupBufferMs: this.startupBufferMs,
      firstPlayableRange: this.firstPlayableRange,
      inFlightRequestCount: countKeys(this.activeRanges),
      pendingSegmentCount: this._pendingSegmentCount ? this._pendingSegmentCount() : 0,
      appendQueueDepth: appendQueueDepth(this.videoSb) + appendQueueDepth(this.audioSb),
      requestCancellationCount: this.requestCancellationCount,
      seekBufferPending: !!this.seekBufferPending,
      seekBufferReadyCount: this.seekBufferReadyCount || 0,
      seekCount: this.seekCount || 0,
      seekCancelCount: this.seekCancelCount || 0,
      seekAbortCount: this.seekAbortCount || 0,
      lastSeekTarget: this.lastSeekTarget || 0,
      lastSeekMs: this.lastSeekMs || 0,
      effectiveSeekBufferGoal: this._seekBufferGoal ? this._seekBufferGoal() : STARTUP_BUFFER_GOAL,
      schedulerQueueDepth: this._schedulerQueueDepth ? this._schedulerQueueDepth() : 0,
      mediaFetchInFlightCount: countKeys(this.activeRanges),
      mediaFetchCompletedCount: this.mediaFetchCompletedCount || 0,
      mediaFetchCancelledCount: this.requestCancellationCount || 0,
      mediaFetchRetryCount: this.mediaFetchRetryCount || 0,
      mediaUrlRefreshCount: this.mediaUrlRefreshCount || 0,
      vodEndOfStreamCount: this.vodEndOfStreamCount || 0,
      mediaFetchAverageMs: this.mediaFetchCompletedCount ? this.mediaFetchTotalMs / this.mediaFetchCompletedCount : 0,
      schedulerBackpressureCount: this.schedulerBackpressureCount || 0,
      schedulerDrainCount: this.schedulerDrainCount || 0,
      nativeRecoveryAttemptCount: this.nativeRecoveryAttemptCount || 0,
      nativeRecoverySuccessCount: this.nativeRecoverySuccessCount || 0,
      lastNativeRecoveryReason: this.lastNativeRecoveryReason || '',
      periodTransitionCount: this.periodTransitionCount || 0,
      sourceBufferRebuildAttemptCount: this.sourceBufferRebuildAttemptCount || 0,
      sourceBufferRebuildSuccessCount: this.sourceBufferRebuildSuccessCount || 0,
      lastPeriodTransitionReason: this.lastPeriodTransitionReason || '',
      lastPeriodTransitionError: this.lastPeriodTransitionError || '',
      periodCount: this.periodCount || 0,
      manifestProfile: this.manifestProfile || '',
      manifestCompatibilityWarnings: this.manifestCompatibilityWarnings || [],
      lastRecoveryReason: this.lastRecoveryReason || '',
      manifestRefreshReason: this.manifestRefreshReason || '',
      liveLatency: this.liveLatency,
      liveWindowStart: this._effectiveLiveWindow && this._effectiveLiveWindow() ? this._effectiveLiveWindow().start : (this.liveWindow ? this.liveWindow.start : 0),
      liveWindowEnd: this._effectiveLiveWindow && this._effectiveLiveWindow() ? this._effectiveLiveWindow().end : (this.liveWindow ? this.liveWindow.end : 0),
      atLiveEdge: this.atLiveEdge,
      manifestRefreshCount: this.manifestRefreshCount,
      manifestRefreshFailed: this.manifestRefreshFailed,
      offlinePlayback: !!(this.engine && this.engine._offlinePlayback),
      manifestFromServiceWorker: !!(this.engine && this.engine._manifestFromServiceWorker),
      segmentCacheHitCount: this.segmentCacheHitCount || 0,
      segmentCacheMissCount: this.segmentCacheMissCount || 0,
      lastOfflineError: this.lastOfflineError || (this.engine ? (this.engine._lastOfflineError || '') : ''),
      fatalError: this.fatalError || '',
      droppedFrames: quality ? quality.droppedVideoFrames : 0,
      totalFrames: quality ? quality.totalVideoFrames : 0
    };
  };

  NativeDashProvider.prototype.handleVideoError = function () {
    try {
      var pos = this.engine.lastGoodTime || this.video.currentTime || 0;
      if (this.activeVideo) this.blacklisted[this.activeVideo.id] = true;
      var next = this.chooseVideoRep();
      this.video.currentTime = pos;
      this._switchVideo(next, true);
      return Promise.resolve();
    } catch (e) {
      return Promise.reject(e);
    }
  };

  NativeDashProvider.prototype._clampSeekTarget = function (targetTime) {
    var target = isFinite(Number(targetTime)) ? Number(targetTime) : (this.video.currentTime || 0);
    var range = this._effectiveLiveWindow ? this._effectiveLiveWindow() : this.liveWindow;
    if (this.live && range) target = clamp(target, range.start, range.end);
    return target;
  };

  NativeDashProvider.prototype.beginSeek = function (targetTime) {
    var target = this._clampSeekTarget(targetTime);
    this.lastSeekTarget = target;
    this.lastSeekStartedAt = performance.now();
    this.seekBufferPending = true;
    if (this.engine && this.engine._setState) this.engine._setState('seeking');
    return target;
  };

  NativeDashProvider.prototype.commitSeek = function (targetTime) {
    var target = this.beginSeek(targetTime);
    this.seekCount++;
    try { this.video.currentTime = target; } catch (e) {}
    this._onSeek(target);
    return target;
  };

  NativeDashProvider.prototype.cancelSeek = function () {
    this.seekCancelCount++;
    this.seekBufferPending = false;
    this.lastSeekStartedAt = 0;
    if (this.engine && this.engine._setState && !this.engine._serverDown) this.engine._setState('ready');
  };

  NativeDashProvider.prototype.endSeek = function () {
    if (this.lastSeekStartedAt) this.lastSeekMs = performance.now() - this.lastSeekStartedAt;
    this.lastSeekStartedAt = 0;
    if (this.engine && this.engine._setState && !this.engine._serverDown) this.engine._setState('ready');
  };

  NativeDashProvider.prototype.seekDuringRecovery = function (targetTime) {
    this.commitSeek(targetTime);
  };

  NativeDashProvider.prototype._onSeek = function (targetTime) {
    if (this.destroyed) return;
    var target = this._clampSeekTarget(targetTime == null ? this.video.currentTime : targetTime);
    var now = performance.now();
    if (this._lastSeekHandledTarget !== null && Math.abs(target - this._lastSeekHandledTarget) <= 0.05 && now - this._lastSeekHandledAt < 100) return;
    this._lastSeekHandledTarget = target;
    this._lastSeekHandledAt = now;
    if (Math.abs(target - (this.video.currentTime || 0)) > 0.05) {
      try { this.video.currentTime = target; } catch (e) {}
    }
    this.engine._setState('seeking');
    this.pendingSeek++;
    this.lastSeekTarget = target;
    this.seekBufferPending = true;
    var cancelled = this._abortRequests();
    if (cancelled > 0) this.seekAbortCount += cancelled;
    markSegmentsForTime(this.activeVideo, target, Math.max(2, this._seekBufferGoal()));
    markSegmentsForTime(this.audio, target, Math.max(2, this._seekBufferGoal()));
    this._tick(true);
    var self = this;
    setTimeout(function () {
      if (!self.destroyed && !self.engine._serverDown) self.engine._setState('ready');
    }, 250);
  };

  NativeDashProvider.prototype._onWaiting = function () {
    if (this.destroyed || this.rebufferStartedAt || this.video.paused || this.video.seeking) return;
    if (this._jumpSmallGap()) return;
    this.rebufferStartedAt = performance.now();
    this.rebufferCount++;
    this.lastError = getBufferAhead(this.video) < 0.5 ? 'buffer-underrun' : this.lastError;
    this.engine._telemetry.record('rebuffer-start');
    console.debug('[native-dash] rebuffer start bufferAhead=' + getBufferAhead(this.video).toFixed(2));
  };

  NativeDashProvider.prototype._onPlaying = function () {
    if (!this.rebufferStartedAt) return;
    this.rebufferDuration += (performance.now() - this.rebufferStartedAt) / 1000;
    this.rebufferStartedAt = 0;
    this.stallReports = 0;
    this.stallRecoveryStage = 0;
    this.engine._telemetry.record('rebuffer-end');
    console.debug('[native-dash] rebuffer end bufferAhead=' + getBufferAhead(this.video).toFixed(2));
  };

  NativeDashProvider.prototype._addTimelineRegions = function (regions) {
    addTimelineRegions(this, regions);
  };

  NativeDashProvider.prototype._abortRequests = function () {
    var cancelled = this.controllers.length + countKeys(this.activeRanges);
    if (cancelled > 0) {
      this.requestCancellationCount += cancelled;
      if (this.engine && this.engine._telemetry) this.engine._telemetry.record('request-cancel', { cancelledRequests: cancelled });
    }
    this.requestGeneration++;
    resetActiveSegmentRequests(this.activeVideo);
    resetActiveSegmentRequests(this.audio);
    this.activeRanges = {};
    for (var i = 0; i < this.controllers.length; i++) {
      try { this.controllers[i].abort(); } catch (e) {}
    }
    this.controllers = [];
    return cancelled;
  };

  NativeDashProvider.prototype._bufferAheadGoal = function () {
    var cfg = this.engine._player.config.streaming || {};
    return Math.max(1, cfg.bufferingGoal || BUFFER_AHEAD);
  };

  NativeDashProvider.prototype._rebufferingGoal = function () {
    var cfg = this.engine._player.config.streaming || {};
    if (cfg.rebufferingGoal == null) return 0.3;
    return Math.max(0, cfg.rebufferingGoal);
  };

  NativeDashProvider.prototype._startupBufferGoal = function () {
    var cfg = this.engine._player.config.streaming || {};
    return Math.max(1, cfg.startupBufferGoal || STARTUP_BUFFER_GOAL);
  };

  NativeDashProvider.prototype._seekBufferGoal = function () {
    var cfg = this.engine._player.config.streaming || {};
    return Math.max(1, cfg.seekBufferGoal || STARTUP_BUFFER_GOAL);
  };

  NativeDashProvider.prototype._maxConcurrentMediaRequests = function () {
    var cfg = this.engine._player.config.streaming || {};
    return Math.max(1, cfg.maxConcurrentRequests || MAX_CONCURRENT_MEDIA_REQUESTS);
  };

  NativeDashProvider.prototype._bufferBehindGoal = function () {
    var cfg = this.engine._player.config.streaming || {};
    return Math.max(0, cfg.bufferBehind == null ? BUFFER_BEHIND : cfg.bufferBehind);
  };

  NativeDashProvider.prototype._availabilityWindowOverride = function () {
    var cfg = this.engine._player.config.manifest || {};
    var value = cfg.availabilityWindowOverride;
    if (value == null) return 0;
    value = Number(value);
    return value > 0 || value === Infinity ? value : 0;
  };

  NativeDashProvider.prototype._effectiveLiveWindow = function () {
    if (!this.liveWindow) return null;
    var override = this._availabilityWindowOverride();
    if (!override || override === Infinity) return { start: this.liveWindow.start, end: this.liveWindow.end };
    return {
      start: Math.max(0, this.liveWindow.end - override),
      end: this.liveWindow.end
    };
  };

  NativeDashProvider.prototype._trim = function () {
    var behind = this._bufferBehindGoal();
    if (!behind || this.videoSb.updating || this.audioSb.updating) return;
    var removeEnd = (this.video.currentTime || 0) - behind;
    if (removeEnd <= 0) return;
    trimBuffer(this.videoSb, removeEnd);
    trimBuffer(this.audioSb, removeEnd);
  };

  NativeDashProvider.prototype._checkBufferMilestones = function () {
    var range = playableRangeAround(this.video);
    if (range && !this.firstPlayableRange) this.firstPlayableRange = range;
    var readyGoal = this.seekBufferPending
      ? (this._seekBufferGoal ? this._seekBufferGoal() : STARTUP_BUFFER_GOAL)
      : (this._startupBufferGoal ? this._startupBufferGoal() : STARTUP_BUFFER_GOAL);
    var ready = getBufferAhead(this.video) >= Math.min(readyGoal, this._bufferAheadGoal());
    if (ready && !this.startupBufferComplete) {
      this.startupBufferComplete = true;
      this.startupBufferMs = this.startupBufferStartedAt ? performance.now() - this.startupBufferStartedAt : 0;
      this.engine._telemetry.record('startup-buffer-ready', { startupBufferMs: this.startupBufferMs });
    }
    if (ready && this.seekBufferPending) {
      this.seekBufferPending = false;
      this.seekBufferReadyCount++;
      this.engine._telemetry.record('seek-buffer-ready');
    }
  };

  NativeDashProvider.prototype._pendingSegmentCount = function () {
    var count = 0;
    count += pendingSegments(this.activeVideo);
    count += pendingSegments(this.audio);
    return count;
  };

  NativeDashProvider.prototype._schedulerQueueDepth = function () {
    var count = 0;
    count += fetchedSegments(this.activeVideo);
    count += fetchedSegments(this.audio);
    return count;
  };

  NativeDashProvider.prototype._jumpSmallGap = function () {
    var gap = nextBufferedGap(this.video);
    if (!gap || gap.size <= 0 || gap.size > MAX_GAP_JUMP) return false;
    try {
      this.video.currentTime = gap.start + 0.01;
      this.gapJumpCount++;
      this.lastGapSize = gap.size;
      this.lastError = 'gap-jump';
      this.engine._telemetry.record('gap-jump', { lastGapSize: gap.size });
      this._tick(true);
      return true;
    } catch (e) {
      return false;
    }
  };

  NativeDashProvider.prototype._startNearLiveEdge = function () {
    this._updateLiveWindowFromReps();
    if (!this.liveWindow) return;
    var start = Math.max(this.liveWindow.start, this.liveWindow.end - LIVE_TARGET_LATENCY);
    if (!this.video.currentTime || this.video.currentTime < this.liveWindow.start || this.video.currentTime > this.liveWindow.end) {
      try { this.video.currentTime = start; } catch (e) {}
    }
    this._updateLivePositionStats();
  };

  NativeDashProvider.prototype._updateLiveWindowFromReps = function () {
    var reps = [];
    if (this.activeVideo) reps.push(this.activeVideo);
    if (this.audio) reps.push(this.audio);
    var start = Infinity;
    var end = 0;
    for (var i = 0; i < reps.length; i++) {
      var segs = reps[i].segments || reps[i].templateSegments || [];
      if (!segs.length) continue;
      start = Math.min(start, segs[0].start || 0);
      end = Math.max(end, segs[segs.length - 1].end || 0);
    }
    if (start !== Infinity && end > start) this.liveWindow = { start: start, end: end };
  };

  NativeDashProvider.prototype._updateLivePositionStats = function () {
    this._updateLiveWindowFromReps();
    var liveRange = this._effectiveLiveWindow();
    if (!liveRange) return;
    var edge = liveRange.end;
    this.liveLatency = Math.max(0, edge - (this.video.currentTime || 0));
    this.atLiveEdge = this.liveLatency <= LIVE_TARGET_LATENCY + 1;
    if ((this.video.currentTime || 0) < liveRange.start - 0.1) {
      try { this.video.currentTime = liveRange.start; } catch (e) {}
    }
    if (!this.video.seeking && getBufferAhead(this.video) > 2 && this.liveLatency > LIVE_MAX_LATENCY) {
      try {
        this.video.currentTime = Math.max(liveRange.start, edge - LIVE_TARGET_LATENCY);
        this.liveLatency = Math.max(0, edge - (this.video.currentTime || 0));
        this.atLiveEdge = true;
        this.engine._telemetry.record('recovery', { lastError: 'live-edge-drift' });
      } catch (e) {}
    }
  };

  NativeDashProvider.prototype._scheduleManifestRefresh = function () {
    var self = this;
    if (!this.live || this.destroyed || !this.minimumUpdatePeriod) return;
    if (this.manifestRefreshTimer) clearTimeout(this.manifestRefreshTimer);
    this.manifestRefreshTimer = setTimeout(function () {
      self._refreshManifest().then(function () {
        self._scheduleManifestRefresh();
      }).catch(function () {
        self._scheduleManifestRefresh();
      });
    }, Math.max(1000, this.minimumUpdatePeriod * 1000));
  };

  NativeDashProvider.prototype._refreshPlaybackManifest = function (reason, swallowErrors) {
    var self = this;
    if (this.destroyed) return Promise.resolve();
    return fetchManifest(this.engine, this.manifestUrl).then(function (manifest) {
      var parsed = parseMPD(manifest.text || self.manifestText, manifest.url || self.manifestUrl);
      self.manifestText = manifest.text || self.manifestText;
      self.manifestRefreshReason = reason || (parsed.type === 'dynamic' ? 'live' : 'manual');
      self.minimumUpdatePeriod = parsed.minimumUpdatePeriod || self.minimumUpdatePeriod;
      self.liveWindow = parsed.liveWindow || self.liveWindow;
      self.manifestCompatibilityWarnings = mergeUnique(self.manifestCompatibilityWarnings || [], parsed.warnings || []);
      addTimelineRegions(self, parsed.timelineRegions || []);
      if (parsed.type === 'dynamic') {
        mergeLiveReps(self.videoReps, parsed.video);
        mergeLiveReps(self.audioReps, parsed.audio);
      } else {
        mergeStaticReps(self.videoReps, parsed.video);
        mergeStaticReps(self.audioReps, parsed.audio);
      }
      if (self.live) {
        self._updateLiveWindowFromReps();
        self._evictExpiredLiveSegmentState();
      }
      self.manifestRefreshCount++;
      self.manifestRefreshFailed = false;
      self.engine._telemetry.record('manifest-refresh', {
        manifestRefreshReason: self.manifestRefreshReason,
        liveLatency: self.liveLatency,
        liveWindowStart: self.liveWindow ? self.liveWindow.start : 0,
        liveWindowEnd: self.liveWindow ? self.liveWindow.end : 0
      });
      self._tick(true);
    }).catch(function (err) {
      self.manifestRefreshFailed = true;
      self.recoveryCount++;
      self.lastError = err && err.message ? err.message : 'manifest-refresh-failed';
      self.engine._telemetry.record('recovery', { lastError: self.lastError });
      console.warn('[native-dash] manifest refresh failed: ' + self.lastError);
      if (!swallowErrors) throw err;
    });
  };

  NativeDashProvider.prototype._refreshManifest = function () {
    if (!this.live) return Promise.resolve();
    return NativeDashProvider.prototype._refreshPlaybackManifest.call(this, 'live', true);
  };

  NativeDashProvider.prototype._evictExpiredLiveSegmentState = function () {
    if (!this.liveWindow) return;
    evictExpiredSegments(this.videoReps, this.liveWindow.start);
    evictExpiredSegments(this.audioReps, this.liveWindow.start);
  };

  NativeDashProvider.prototype.reportStall = function () {
    this._tick(true);
    if (getBufferAhead(this.video) < 0.5) {
      if (this._jumpSmallGap && this._jumpSmallGap()) return;
      this.stallReports++;
      this.lastError = 'stall';
      this.engine._telemetry.record('recovery', { lastError: 'stall' });
      if (this.stallRecoveryStage === 0) {
        this.stallRecoveryStage = 1;
        markSegmentsForTime(this.activeVideo, this.video.currentTime, Math.max(2, this._bufferAheadGoal()));
        markSegmentsForTime(this.audio, this.video.currentTime, Math.max(2, this._bufferAheadGoal()));
        this._tick(true);
        return;
      }
      if (this.stallRecoveryStage === 1 && this.activeVideo) {
        this.nativeRecoveryReasons = this.nativeRecoveryReasons || {};
        if (this._tryNativeRecovery && !this.nativeRecoveryReasons['native-stall']) {
          this.stallRecoveryStage = 2;
          this._tryNativeRecovery('native-stall').then(function () {}).catch(function () {});
          return;
        }
        var lower = this._lowerVideoRep();
        if (lower) {
          this.stallRecoveryStage = 3;
          this.blacklisted[this.activeVideo.id] = true;
          this._switchVideo(lower, true, 'stall-recovery');
          return;
        }
      }
      if (this.stallReports >= 3) {
        this._completeNativeRuntimeTerminal('native-stall-exhausted');
      }
    }
  };

  NativeDashProvider.prototype.destroy = function () {
    this.destroyed = true;
    if (this.fillTimer) clearInterval(this.fillTimer);
    if (this.manifestRefreshTimer) clearTimeout(this.manifestRefreshTimer);
    this._abortRequests();
    if (this._boundTick) this.video.removeEventListener('timeupdate', this._boundTick);
    if (this._boundSeek) this.video.removeEventListener('seeking', this._boundSeek);
    if (this._boundNativeTextCueUpdate) {
      this.video.removeEventListener('timeupdate', this._boundNativeTextCueUpdate);
      this.video.removeEventListener('seeking', this._boundNativeTextCueUpdate);
    }
    if (this._boundEncrypted) this.video.removeEventListener('encrypted', this._boundEncrypted);
    for (var i = 0; i < this.drmSessions.length; i++) {
      try { this.drmSessions[i].close(); } catch (e) {}
    }
    this.drmSessions = [];
    if (this._boundWaiting) this.video.removeEventListener('waiting', this._boundWaiting);
    if (this._boundPlaying) this.video.removeEventListener('playing', this._boundPlaying);
    try {
      if (this.mediaSource && this.mediaSource.readyState === 'open') this.mediaSource.endOfStream();
    } catch (e) {}
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
  };

  function fetchManifest(engine, url) {
    if (url.indexOf('data:') === 0) {
      return Promise.resolve(decodeDataUri(url)).then(function (text) {
        return { url: url, text: text };
      });
    }
    return nativeNetworkRequest(engine, NativeNetworkingEngine.RequestType.MANIFEST, {
      uris: [url],
      method: 'GET',
      headers: {}
    }).then(function (networkResp) {
      if (networkResp.status === 401 || networkResp.status === 403 || networkResp.status >= 500) {
        throw new Error('manifest-http-' + networkResp.status);
      }
      var ct = headerValue(networkResp.headers, 'content-type') || '';
      var via = headerValue(networkResp.headers, 'x-stream-via') || '';
      var downloadedHeight = parseInt(headerValue(networkResp.headers, 'x-downloaded-height') || '0', 10);
      var swInfo = readServiceWorkerSource(networkResp);
      if (ct.indexOf('json') !== -1) {
        return merge({ url: networkResp.uri || url, json: JSON.parse(arrayBufferToString(networkResp.data)), via: via, downloadedHeight: downloadedHeight }, swInfo);
      }
      return merge({ url: networkResp.uri || url, text: arrayBufferToString(networkResp.data), via: via, downloadedHeight: downloadedHeight }, swInfo);
    });
  }

  function fetchText(engine, url, onSource) {
    return nativeNetworkRequest(engine, NativeNetworkingEngine.RequestType.MANIFEST, {
      uris: [url],
      method: 'GET',
      headers: {}
    }).then(function (resp) {
      var swInfo = readServiceWorkerSource(resp);
      if (onSource) onSource(swInfo);
      if (resp.status === 401 || resp.status === 403 || resp.status === 404 || resp.status === 410 || resp.status >= 500) {
        throw new Error('manifest-http-' + resp.status);
      }
      if (!networkResponseOk(resp)) throw new Error('manifest-http-' + resp.status);
      return arrayBufferToString(resp.data);
    });
  }

  function parseHlsPlaylist(text, playlistUrl) {
    var lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
    var variants = [];
    var iframeVariants = [];
    var imageVariants = [];
    var audioRenditions = [];
    var subtitleRenditions = [];
    var closedCaptionRenditions = [];
    var sessionData = [];
    var segments = [];
    var pendingParts = [];
    var preloadHints = [];
    var renditionReports = [];
    var serverControl = null;
    var partTargetDuration = 0;
    var skippedSegmentCount = 0;
    var contentSteeringUri = '';
    var contentSteeringPathwayId = '';
    var warnings = [];
    var map = null;
    var encrypted = false;
    var unsupportedEncryption = false;
    var unsupportedEncryptionReason = '';
    var encryptionMethod = '';
    var keyFormat = '';
    var currentKey = null;
    var discontinuity = false;
    var discontinuityCount = 0;
    var discontinuitySequence = 0;
    var currentDiscontinuitySequence = 0;
    var pendingDiscontinuity = false;
    var endList = false;
    var targetDuration = 0;
    var mediaSequence = 0;
    var pendingDuration = 0;
    var imageTiles = null;
    var duration = 0;
    var timeline = 0;
    var nextRange = null;
    var lastRangeEnd = -1;
    var playlistCodecs = '';
    var startInfo = null;
    var dateRanges = [];
    var pendingProgramDateTimeMs = NaN;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) continue;
      if (line.indexOf('#EXT-X-MEDIA-SEQUENCE') === 0) {
        mediaSequence = parseInt(line.split(':')[1] || '0', 10) || 0;
        if (!segments.length && targetDuration > 0) timeline = mediaSequence * targetDuration;
      } else if (line.indexOf('#EXT-X-STREAM-INF') === 0) {
        var attrs = hlsAttrs(line);
        var uri = nextHlsUri(lines, i + 1);
        if (uri) {
          var res = String(attrs.RESOLUTION || '').match(/(\d+)x(\d+)/);
          var codecs = unquote(attrs.CODECS || '');
          variants.push({
            id: String(variants.length),
            url: resolveUrl(uri, playlistUrl),
            bandwidth: parseInt(attrs.BANDWIDTH || attrs['AVERAGE-BANDWIDTH'] || '0', 10) || 0,
            width: res ? parseInt(res[1], 10) : 0,
            height: res ? parseInt(res[2], 10) : 0,
            codecs: codecs,
          audioGroup: unquote(attrs.AUDIO || ''),
          subtitleGroup: unquote(attrs.SUBTITLES || ''),
          closedCaptions: unquote(attrs['CLOSED-CAPTIONS'] || ''),
          pathwayId: unquote(attrs['PATHWAY-ID'] || ''),
          active: false
          });
          if (codecs) playlistCodecs = codecs;
        }
      } else if (line.indexOf('#EXT-X-I-FRAME-STREAM-INF') === 0) {
        var iframeAttrs = hlsAttrs(line);
        var iframeUri = unquote(iframeAttrs.URI || '');
        if (iframeUri) {
          var iframeRes = String(iframeAttrs.RESOLUTION || '').match(/(\d+)x(\d+)/);
          var iframeCodecs = unquote(iframeAttrs.CODECS || '');
          iframeVariants.push({
            id: 'iframe-' + iframeVariants.length,
            url: resolveUrl(iframeUri, playlistUrl),
            bandwidth: parseInt(iframeAttrs.BANDWIDTH || iframeAttrs['AVERAGE-BANDWIDTH'] || '0', 10) || 0,
            width: iframeRes ? parseInt(iframeRes[1], 10) : 0,
            height: iframeRes ? parseInt(iframeRes[2], 10) : 0,
            codecs: iframeCodecs,
            pathwayId: unquote(iframeAttrs['PATHWAY-ID'] || ''),
            iframeOnly: true
          });
          if (iframeCodecs && !playlistCodecs) playlistCodecs = iframeCodecs;
        }
      } else if (line.indexOf('#EXT-X-IMAGE-STREAM-INF') === 0) {
        var imageAttrs = hlsAttrs(line);
        var imageUri = unquote(imageAttrs.URI || '');
        if (imageUri) {
          var imageRes = String(imageAttrs.RESOLUTION || '').match(/(\d+)x(\d+)/);
          var imageCodecs = unquote(imageAttrs.CODECS || '');
          imageVariants.push({
            id: 'image-' + imageVariants.length,
            url: resolveUrl(imageUri, playlistUrl),
            bandwidth: parseInt(imageAttrs.BANDWIDTH || imageAttrs['AVERAGE-BANDWIDTH'] || '0', 10) || 0,
            width: imageRes ? parseInt(imageRes[1], 10) : 0,
            height: imageRes ? parseInt(imageRes[2], 10) : 0,
            codecs: imageCodecs,
            pathwayId: unquote(imageAttrs['PATHWAY-ID'] || ''),
            imageOnly: true
          });
        }
      } else if (line.indexOf('#EXT-X-MEDIA') === 0) {
        var mediaAttrs = hlsAttrs(line);
        var type = String(mediaAttrs.TYPE || '').toUpperCase();
        var mediaUri = unquote(mediaAttrs.URI || '');
        var mediaItem = {
          id: unquote(mediaAttrs['GROUP-ID'] || '') + ':' + unquote(mediaAttrs.NAME || String(audioRenditions.length + subtitleRenditions.length)),
          groupId: unquote(mediaAttrs['GROUP-ID'] || ''),
          name: unquote(mediaAttrs.NAME || ''),
          label: unquote(mediaAttrs.NAME || ''),
          language: unquote(mediaAttrs.LANGUAGE || ''),
          url: mediaUri ? resolveUrl(mediaUri, playlistUrl) : '',
          codecs: unquote(mediaAttrs.CODECS || ''),
          defaultTrack: String(mediaAttrs.DEFAULT || '').toUpperCase() === 'YES',
          autoselect: String(mediaAttrs.AUTOSELECT || '').toUpperCase() === 'YES',
          active: false
        };
        mediaItem.pathwayId = unquote(mediaAttrs['PATHWAY-ID'] || '');
        if (type === 'AUDIO' && mediaItem.url) audioRenditions.push(mediaItem);
        if (type === 'SUBTITLES' && mediaItem.url) {
          mediaItem.mimeType = /ttml|xml/i.test(mediaItem.url) ? 'application/ttml+xml' : 'text/vtt';
          subtitleRenditions.push(mediaItem);
        }
        if (type === 'CLOSED-CAPTIONS') {
          mediaItem.id = mediaItem.groupId + ':' + unquote(mediaAttrs['INSTREAM-ID'] || mediaAttrs.NAME || String(closedCaptionRenditions.length));
          mediaItem.url = '';
          mediaItem.mimeType = 'application/cea-608';
          mediaItem.source = 'native-hls-cea';
          mediaItem.embedded = true;
          mediaItem.instreamId = unquote(mediaAttrs['INSTREAM-ID'] || '');
          mediaItem.supported = false;
          mediaItem.renderSupported = false;
          closedCaptionRenditions.push(mediaItem);
        }
      } else if (line.indexOf('#EXT-X-SESSION-DATA') === 0) {
        var sessionAttrs = hlsAttrs(line);
        var sessionUri = unquote(sessionAttrs.URI || '');
        sessionData.push({
          dataId: unquote(sessionAttrs['DATA-ID'] || ''),
          value: unquote(sessionAttrs.VALUE || ''),
          uri: sessionUri ? resolveUrl(sessionUri, playlistUrl) : '',
          language: unquote(sessionAttrs.LANGUAGE || ''),
          raw: clonePlain(sessionAttrs)
        });
      } else if (line.indexOf('#EXT-X-MAP') === 0) {
        var mapAttrs = hlsAttrs(line);
        map = {
          url: resolveUrl(unquote(mapAttrs.URI || ''), playlistUrl),
          range: hlsByteRange(unquote(mapAttrs.BYTERANGE || ''), -1)
        };
      } else if (line.indexOf('#EXT-X-KEY') === 0) {
        var keyAttrs = hlsAttrs(line);
        var method = String(keyAttrs.METHOD || '').toUpperCase();
        encryptionMethod = method;
        if (method === 'NONE') {
          currentKey = null;
        } else if (method === 'AES-128') {
          var keyFormat = unquote(keyAttrs.KEYFORMAT || 'identity');
          keyFormat = keyFormat || 'identity';
          var keyUri = unquote(keyAttrs.URI || '');
          var iv = unquote(keyAttrs.IV || '');
          encrypted = true;
          if (keyFormat && keyFormat !== 'identity') {
            unsupportedEncryption = true;
            unsupportedEncryptionReason = 'hls-keyformat-unsupported';
          } else if (!keyUri) {
            unsupportedEncryption = true;
            unsupportedEncryptionReason = 'hls-key-uri-missing';
          } else {
            currentKey = {
              method: 'AES-128',
              uri: resolveUrl(keyUri, playlistUrl),
              iv: iv ? hlsIvBytes(iv) : null
            };
            if (iv && !currentKey.iv) {
              unsupportedEncryption = true;
              unsupportedEncryptionReason = 'hls-iv-invalid';
            }
          }
        } else {
          keyFormat = unquote(keyAttrs.KEYFORMAT || 'identity') || 'identity';
          encrypted = true;
          unsupportedEncryption = true;
          unsupportedEncryptionReason = method === 'SAMPLE-AES' ? 'hls-sample-aes-unsupported' : 'hls-encrypted-unsupported';
        }
      } else if (line.indexOf('#EXT-X-START') === 0) {
        var startAttrs = hlsAttrs(line);
        var offset = parseFloat(unquote(startAttrs['TIME-OFFSET'] || ''));
        if (isFinite(offset)) {
          startInfo = {
            timeOffset: offset,
            precise: String(unquote(startAttrs.PRECISE || '')).toUpperCase() === 'YES'
          };
        }
      } else if (line.indexOf('#EXT-X-SERVER-CONTROL') === 0) {
        var serverAttrs = hlsAttrs(line);
        serverControl = {
          canSkipUntil: parseFloat(unquote(serverAttrs['CAN-SKIP-UNTIL'] || '')),
          canSkipDateRanges: String(unquote(serverAttrs['CAN-SKIP-DATERANGES'] || '')).toUpperCase() === 'YES',
          holdBack: parseFloat(unquote(serverAttrs['HOLD-BACK'] || '')),
          partHoldBack: parseFloat(unquote(serverAttrs['PART-HOLD-BACK'] || '')),
          canBlockReload: String(unquote(serverAttrs['CAN-BLOCK-RELOAD'] || '')).toUpperCase() === 'YES'
        };
      } else if (line.indexOf('#EXT-X-PART-INF') === 0) {
        var partInfAttrs = hlsAttrs(line);
        partTargetDuration = parseFloat(unquote(partInfAttrs['PART-TARGET'] || '')) || 0;
      } else if (line.indexOf('#EXT-X-PART') === 0) {
        var partAttrs = hlsAttrs(line);
        var partUri = unquote(partAttrs.URI || '');
        if (partUri) {
          pendingParts.push({
            url: resolveUrl(partUri, playlistUrl),
            duration: parseFloat(unquote(partAttrs.DURATION || '')) || 0,
            independent: String(unquote(partAttrs.INDEPENDENT || '')).toUpperCase() === 'YES',
            gap: String(unquote(partAttrs.GAP || '')).toUpperCase() === 'YES',
            range: hlsByteRange(unquote(partAttrs.BYTERANGE || ''), -1)
          });
        }
      } else if (line.indexOf('#EXT-X-PRELOAD-HINT') === 0) {
        var hintAttrs = hlsAttrs(line);
        var hintUri = unquote(hintAttrs.URI || '');
        preloadHints.push({
          type: unquote(hintAttrs.TYPE || ''),
          url: hintUri ? resolveUrl(hintUri, playlistUrl) : '',
          byteRangeStart: parseInt(unquote(hintAttrs['BYTERANGE-START'] || ''), 10),
          byteRangeLength: parseInt(unquote(hintAttrs['BYTERANGE-LENGTH'] || ''), 10)
        });
      } else if (line.indexOf('#EXT-X-RENDITION-REPORT') === 0) {
        var reportAttrs = hlsAttrs(line);
        var reportUri = unquote(reportAttrs.URI || '');
        renditionReports.push({
          url: reportUri ? resolveUrl(reportUri, playlistUrl) : '',
          lastMsn: parseInt(unquote(reportAttrs['LAST-MSN'] || ''), 10),
          lastPart: parseInt(unquote(reportAttrs['LAST-PART'] || ''), 10)
        });
      } else if (line.indexOf('#EXT-X-SKIP') === 0) {
        var skipAttrs = hlsAttrs(line);
        var skipped = parseInt(unquote(skipAttrs['SKIPPED-SEGMENTS'] || '0'), 10) || 0;
        skippedSegmentCount += skipped;
        if (skipped > 0) warnings = mergeUnique(warnings, ['hls-delta-update-skipped-segments']);
      } else if (line.indexOf('#EXT-X-CONTENT-STEERING') === 0) {
        var steeringAttrs = hlsAttrs(line);
        var steeringUri = unquote(steeringAttrs['SERVER-URI'] || '');
        contentSteeringUri = steeringUri ? resolveUrl(steeringUri, playlistUrl) : '';
        contentSteeringPathwayId = unquote(steeringAttrs['PATHWAY-ID'] || '');
      } else if (line.indexOf('#EXT-X-DATERANGE') === 0) {
        var dateRange = hlsDateRange(line);
        if (dateRange) dateRanges.push(dateRange);
      } else if (line.indexOf('#EXT-X-IMAGES-ONLY') === 0) {
        imageTiles = imageTiles || {};
      } else if (line.indexOf('#EXT-X-TILES') === 0) {
        imageTiles = hlsTiles(line);
      } else if (line.indexOf('#EXT-X-PROGRAM-DATE-TIME') === 0) {
        pendingProgramDateTimeMs = Date.parse(line.slice(line.indexOf(':') + 1).trim());
      } else if (line.indexOf('#EXT-X-DISCONTINUITY-SEQUENCE') === 0) {
        discontinuitySequence = parseInt(line.split(':')[1] || '0', 10) || 0;
        currentDiscontinuitySequence = discontinuitySequence;
      } else if (line.indexOf('#EXT-X-DISCONTINUITY') === 0) {
        discontinuity = true;
        discontinuityCount++;
        currentDiscontinuitySequence++;
        pendingDiscontinuity = true;
      } else if (line.indexOf('#EXT-X-TARGETDURATION') === 0) {
        targetDuration = parseFloat(line.split(':')[1] || '0') || 0;
        if (!segments.length && mediaSequence > 0 && targetDuration > 0) timeline = mediaSequence * targetDuration;
      } else if (line.indexOf('#EXT-X-MEDIA-SEQUENCE') === 0) {
        mediaSequence = parseInt(line.split(':')[1] || '0', 10) || 0;
        if (!segments.length && targetDuration > 0) timeline = mediaSequence * targetDuration;
      } else if (line.indexOf('#EXT-X-ENDLIST') === 0) {
        endList = true;
      } else if (line.indexOf('#EXTINF') === 0) {
        pendingDuration = parseFloat((line.split(':')[1] || '').split(',')[0]) || 0;
      } else if (line.indexOf('#EXT-X-BYTERANGE') === 0) {
        nextRange = hlsByteRange(line.split(':')[1] || '', lastRangeEnd);
      } else if (line.charAt(0) !== '#') {
        var range = nextRange;
        if (range) lastRangeEnd = range.end;
        var segment = {
          start: timeline,
          end: timeline + pendingDuration,
          duration: pendingDuration,
          mediaSequence: mediaSequence + segments.length,
          discontinuity: pendingDiscontinuity,
          discontinuitySequence: currentDiscontinuitySequence,
          url: resolveUrl(line, playlistUrl),
          range: range
        };
        if (imageTiles) segment.tiles = imageTiles;
        if (pendingParts.length) {
          segment.parts = normalizeHlsParts(pendingParts, segment);
          pendingParts = [];
        }
        if (currentKey) segment.key = currentKey;
        if (isFinite(pendingProgramDateTimeMs)) segment.programDateTimeMs = pendingProgramDateTimeMs;
        segments.push(segment);
        if (isFinite(pendingProgramDateTimeMs)) pendingProgramDateTimeMs += pendingDuration * 1000;
        timeline += pendingDuration;
        duration = timeline;
        pendingDuration = 0;
        nextRange = null;
        pendingDiscontinuity = false;
      }
    }
    return {
      variants: variants,
      iframeVariants: iframeVariants,
      imageVariants: imageVariants,
      audioRenditions: audioRenditions,
      subtitleRenditions: subtitleRenditions,
      closedCaptionRenditions: closedCaptionRenditions,
      sessionData: sessionData,
      segments: segments,
      preloadHints: preloadHints,
      renditionReports: renditionReports,
      serverControl: serverControl,
      partTargetDuration: partTargetDuration,
      partialSegmentCount: segments.reduce(function (count, segment) { return count + ((segment.parts && segment.parts.length) || 0); }, 0) + pendingParts.length,
      skippedSegmentCount: skippedSegmentCount,
      lowLatencyPlaylist: !!(partTargetDuration || preloadHints.length || renditionReports.length || pendingParts.length || serverControl),
      imagesOnly: !!imageTiles,
      contentSteeringUri: contentSteeringUri,
      contentSteeringPathwayId: contentSteeringPathwayId,
      warnings: warnings,
      map: map,
      encrypted: encrypted,
      unsupportedEncryption: unsupportedEncryption,
      unsupportedEncryptionReason: unsupportedEncryptionReason,
      encryptionMethod: encryptionMethod,
      keyFormat: keyFormat,
      discontinuity: discontinuity,
      discontinuitySequence: discontinuitySequence,
      discontinuityCount: discontinuityCount,
      endList: endList,
      targetDuration: targetDuration,
      mediaSequence: mediaSequence,
      duration: duration,
      start: startInfo,
      dateRanges: dateRanges,
      codecs: playlistCodecs
    };
  }

  function hlsUnsupportedEncryptionError(provider, parsed) {
    var reason = parsed.unsupportedEncryptionReason || 'hls-encrypted-unsupported';
    var err = nativeTerminalError(provider, reason);
    err.hlsEncryptionMethod = parsed.encryptionMethod || '';
    err.hlsKeyFormat = parsed.keyFormat || '';
    if (provider) {
      provider.hlsEncryptionMethod = err.hlsEncryptionMethod;
      provider.hlsKeyFormat = err.hlsKeyFormat;
    }
    return err;
  }

  function dashNativeTerminalError(provider, reason) {
    var err = nativeTerminalError(provider, reason || 'dash-native-unsupported');
    err.drmKeySystem = provider && provider.drmInfo ? provider.drmInfo.keySystem : '';
    if (provider) {
      provider.lastDrmError = err.message;
    }
    return err;
  }

  function nativeTerminalError(provider, reason) {
    var err = new Error(reason || 'native-unsupported');
    err.nativeTerminal = true;
    if (provider) {
      provider.lastError = err.message;
      provider.fatalError = err.message;
      provider.nativeUnsupportedReason = err.message;
    }
    return err;
  }

  function isNativeTerminalError(err) {
    return !!(err && err.nativeTerminal);
  }

  function isNativeLoadTerminalError(err) {
    var reason = err && err.message ? err.message : 'native-load-failed';
    if (reason === 'native-load-failed' || reason === 'mse-unavailable') return true;
    if (isHlsTsTerminalError(err)) return true;
    if (/^manifest-http-\d+/.test(reason)) return true;
    if (/Failed to fetch|NetworkError|Load failed/i.test(reason)) return true;
    if (/JSON|Unexpected token|Unexpected end/i.test(reason)) return true;
    return false;
  }

  function isHlsTsTerminalError(err) {
    var reason = err && err.message ? err.message : '';
    return /^hls-first-party-ts-/.test(reason) || /^hls-ts-transmuxer-/.test(reason);
  }

  function nextHlsUri(lines, start) {
    for (var i = start; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) continue;
      return line.charAt(0) === '#' ? '' : line;
    }
    return '';
  }

  function hlsAttrs(line) {
    var text = line.slice(line.indexOf(':') + 1);
    var attrs = {};
    var re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
    var m;
    while ((m = re.exec(text)) !== null) attrs[m[1]] = m[2];
    return attrs;
  }

  function hlsDateRange(line) {
    var attrs = hlsAttrs(line);
    var id = unquote(attrs.ID || '');
    var startDate = unquote(attrs['START-DATE'] || '');
    var startMs = Date.parse(startDate);
    if (!id || !isFinite(startMs)) return null;
    var endDate = unquote(attrs['END-DATE'] || '');
    var endMs = Date.parse(endDate);
    var duration = parseFloat(unquote(attrs.DURATION || ''));
    var plannedDuration = parseFloat(unquote(attrs['PLANNED-DURATION'] || ''));
    var custom = {};
    for (var key in attrs) {
      if (!attrs.hasOwnProperty(key)) continue;
      if (/^(ID|CLASS|START-DATE|END-DATE|DURATION|PLANNED-DURATION|END-ON-NEXT)$/i.test(key)) continue;
      custom[key] = unquote(attrs[key]);
    }
    return {
      id: id,
      class: unquote(attrs.CLASS || ''),
      startDate: startDate,
      endDate: endDate,
      startDateMs: startMs,
      endDateMs: isFinite(endMs) ? endMs : NaN,
      duration: isFinite(duration) ? duration : 0,
      plannedDuration: isFinite(plannedDuration) ? plannedDuration : 0,
      endOnNext: String(unquote(attrs['END-ON-NEXT'] || '')).toUpperCase() === 'YES',
      customAttributes: custom,
      startTime: 0,
      endTime: 0
    };
  }

  function hlsTiles(line) {
    var attrs = hlsAttrs(line);
    var resolution = String(unquote(attrs.RESOLUTION || '')).match(/(\d+)x(\d+)/);
    var layout = String(unquote(attrs.LAYOUT || '')).match(/(\d+)x(\d+)/);
    var duration = parseFloat(unquote(attrs.DURATION || ''));
    return {
      width: resolution ? parseInt(resolution[1], 10) : 0,
      height: resolution ? parseInt(resolution[2], 10) : 0,
      columns: layout ? parseInt(layout[1], 10) : 0,
      rows: layout ? parseInt(layout[2], 10) : 0,
      duration: isFinite(duration) ? duration : 0
    };
  }

  function hlsByteRange(value, lastEnd) {
    var m = String(value || '').match(/^(\d+)(?:@(\d+))?$/);
    if (!m) return null;
    var length = parseInt(m[1], 10);
    var start = m[2] ? parseInt(m[2], 10) : lastEnd + 1;
    return { start: start, end: start + length - 1 };
  }

  function hlsIvBytes(value) {
    var hex = String(value || '').replace(/^0x/i, '');
    if (!/^[0-9a-fA-F]{32}$/.test(hex)) return null;
    var out = new Uint8Array(16);
    for (var i = 0; i < 16; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return out;
  }

  function hlsDefaultIv(mediaSequence) {
    var out = new Uint8Array(16);
    var seq = Math.max(0, mediaSequence || 0);
    out[12] = (seq >>> 24) & 255;
    out[13] = (seq >>> 16) & 255;
    out[14] = (seq >>> 8) & 255;
    out[15] = seq & 255;
    return out;
  }

  function unquote(value) {
    return String(value || '').replace(/^"|"$/g, '');
  }

  function videoCodecsOnly(codecs) {
    return String(codecs || '').split(',').map(function (item) { return item.trim(); }).filter(function (item) {
      return /^(avc|hev|hvc|vp0?9|av01)/i.test(item);
    }).join(',');
  }

  function audioCodecsOnly(codecs) {
    return String(codecs || '').split(',').map(function (item) { return item.trim(); }).filter(function (item) {
      return /^(mp4a|ac-3|ec-3|opus)/i.test(item);
    }).join(',');
  }

  function hasMpegTsSegments(segments) {
    return (segments || []).some(function (seg) { return /\.ts(\?|$)/i.test(seg.url || ''); });
  }

  function readServiceWorkerSource(resp) {
    if (!resp || !resp.headers) return { swCached: false, swOffline: false, swSource: '' };
    var cached = headerValue(resp.headers, 'x-sw-cached') === '1' || headerValue(resp.headers, 'x-sw-cache') === '1';
    var offline = headerValue(resp.headers, 'x-sw-offline') === '1';
    var source = headerValue(resp.headers, 'x-sw-source') || '';
    return {
      swCached: cached,
      swOffline: offline,
      swSource: source,
      cached: cached,
      offline: offline,
      source: source
    };
  }

  function headerValue(headers, name) {
    if (!headers || !name) return '';
    if (headers.get) return headers.get(name) || '';
    var lower = String(name).toLowerCase();
    for (var key in headers) {
      if (Object.prototype.hasOwnProperty.call(headers, key) && String(key).toLowerCase() === lower) return headers[key];
    }
    return '';
  }

  function headersToObject(headers) {
    var out = {};
    if (!headers) return out;
    if (headers.forEach) {
      headers.forEach(function (value, key) { out[key.toLowerCase()] = value; });
    }
    return out;
  }

  function networkResponseOk(resp) {
    return !!resp && resp.status >= 200 && resp.status < 300;
  }

  function networkHoldReasonForStatus(status) {
    if (status === 401) return "token-expired";
    if (status === 403) return "server-error";
    if (status >= 500) return "server-error";
    return "network-error";
  }

  function shouldHoldNetworkResponse(engine, type, response, opts) {
    if (!response || opts && opts.disableNetworkHold) return false;
    if (!(response.status === 401 || response.status === 403 || response.status >= 500)) return false;
    var swInfo = readServiceWorkerSource(response);
    if (swInfo && swInfo.offline) return false;
    return shouldHoldNetworkRequest(engine, type, opts);
  }

  function shouldHoldNetworkError(engine, type, err, opts) {
    if (opts && opts.disableNetworkHold) return false;
    if (!err || err.name === "AbortError") return false;
    return shouldHoldNetworkRequest(engine, type, opts) && /network|Failed to fetch|Load failed/i.test(err.message || "");
  }

  function shouldHoldNetworkRequest(engine, type, opts) {
    if (!engine || engine.destroyed || !engine._waitForServerRecovery || !isOnline()) return false;
    if (type !== NativeNetworkingEngine.RequestType.MANIFEST && type !== NativeNetworkingEngine.RequestType.SEGMENT && type !== NativeNetworkingEngine.RequestType.KEY && type !== NativeNetworkingEngine.RequestType.LICENSE) return false;
    return !!(opts && opts.forceNetworkHold) || !!engine._serverDown;
  }

  function arrayBufferToString(data) {
    if (typeof data === 'string') return data;
    return new TextDecoder().decode(data || new ArrayBuffer(0));
  }

  function normalizeNetworkRequest(request) {
    request = request || {};
    return {
      uris: request.uris ? request.uris.slice() : (request.uri ? [request.uri] : []),
      method: request.method || 'GET',
      headers: clonePlain(request.headers || {}),
      body: request.body == null ? null : request.body
    };
  }

  function nativeNetworkRequest(engine, type, request, opts) {
    if (engine && engine._networkingEngine && engine._networkingEngine.request) {
      return engine._networkingEngine.request(type, request, opts);
    }
    request = normalizeNetworkRequest(request);
    var uri = request.uris && request.uris.length ? request.uris[0] : '';
    var init = {
      method: request.method || 'GET',
      headers: request.headers || {}
    };
    if (opts && opts.signal) init.signal = opts.signal;
    if (request.body != null) init.body = request.body;
    var fetchUri = engine ? stampUri(engine, uri) : uri;
    var started = performance.now();
    return fetch(fetchUri, init).then(function (resp) {
      return resp.arrayBuffer().then(function (data) {
        return {
          uri: resp.url || fetchUri,
          originalUri: uri,
          data: data,
          status: resp.status,
          headers: headersToObject(resp.headers),
          timeMs: Math.max(0, performance.now() - started)
        };
      });
    });
  }

  function applyNetworkFilters(filters, type, target, phase, networking) {
    var chain = Promise.resolve();
    (filters || []).forEach(function (filter) {
      chain = chain.then(function () {
        return Promise.resolve(filter(type, target));
      });
    });
    return chain.catch(function (err) {
      networking._recordFilterError();
      var wrapped = new Error(phase === 'request' ? 'native-network-request-filter-failed' : 'native-network-response-filter-failed');
      wrapped.originalError = err;
      throw wrapped;
    });
  }

  function mergeNetworkStats(engine, stats) {
    var out = clonePlain(stats || {});
    var networkStats = engine && engine._networkingEngine ? engine._networkingEngine.stats : {};
    out.networkingRequestCount = networkStats.requestCount || 0;
    out.networkingManifestRequestCount = networkStats.manifestRequestCount || 0;
    out.networkingSegmentRequestCount = networkStats.segmentRequestCount || 0;
    out.networkingLicenseRequestCount = networkStats.licenseRequestCount || 0;
    out.networkingKeyRequestCount = networkStats.keyRequestCount || 0;
    out.networkingOtherRequestCount = networkStats.otherRequestCount || 0;
    out.lastNetworkingRequestType = networkStats.lastRequestType || '';
    out.lastNetworkingStatus = networkStats.lastStatus || 0;
    out.networkingFilterErrorCount = networkStats.filterErrorCount || 0;
    out.networkingTotalRequestMs = Math.round(networkStats.totalRequestMs || 0);
    out.networkHoldCount = networkStats.networkHoldCount || 0;
    out.networkHeldRequestCount = networkStats.networkHeldRequestCount || 0;
    out.networkResumeCount = networkStats.networkResumeCount || 0;
    out.networkHoldReason = networkStats.networkHoldReason || "";
    out.networkHoldMs = Math.round(networkStats.networkHoldMs || 0);
    return out;
  }

  function isOnline() {
    return !('navigator' in window) || !('onLine' in navigator) || navigator.onLine;
  }

  function decodeDataUri(uri) {
    var comma = uri.indexOf(',');
    if (comma === -1) throw new Error('bad-data-uri');
    var meta = uri.slice(5, comma);
    var data = uri.slice(comma + 1);
    if (/;base64/i.test(meta)) {
      var binary = atob(data);
      var bytes = new Uint8Array(binary.length);
      for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return new TextDecoder('utf-8').decode(bytes);
    }
    return decodeURIComponent(data.replace(/\+/g, '%20'));
  }

  function base64ToBytes(value) {
    var clean = String(value || '').replace(/\s+/g, '');
    if (!clean) return null;
    var binary = atob(clean);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function hexToBase64Url(value) {
    var hex = String(value || '').replace(/-/g, '').replace(/^0x/i, '').toLowerCase();
    if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2) return '';
    var binary = '';
    for (var i = 0; i < hex.length; i += 2) binary += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  function normalizeKid(value) {
    return String(value || '').replace(/^0x/i, '').replace(/-/g, '').toLowerCase();
  }

  function drmKeySystemForScheme(schemeIdUri) {
    var scheme = String(schemeIdUri || '').toLowerCase();
    if (scheme.indexOf('edef8ba9-79d6-4ace-a3c8-27dcd51d21ed') !== -1) return 'com.widevine.alpha';
    if (scheme.indexOf('9a04f079-9840-4286-ab92-e65be0885f95') !== -1) return 'com.microsoft.playready';
    if (scheme.indexOf('e2719d58-a985-b3c9-781a-b030af78d30e') !== -1) return 'org.w3.clearkey';
    if (scheme.indexOf('mp4protection') !== -1) return '';
    return '';
  }

  function parseContentProtectionList(nodes) {
    var infos = [];
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      var schemeIdUri = node.getAttribute('schemeIdUri') || '';
      var keySystem = drmKeySystemForScheme(schemeIdUri);
      var psshNode = directChild(node, 'pssh');
      var laurlNode = directChild(node, 'Laurl') || directChild(node, 'LA_URL');
      var info = {
        keySystem: keySystem,
        schemeIdUri: schemeIdUri,
        defaultKid: normalizeKid(node.getAttribute('cenc:default_KID') || node.getAttribute('default_KID') || node.getAttribute('defaultKid') || ''),
        pssh: psshNode ? base64ToBytes(psshNode.textContent || '') : null,
        licenseServerUrl: laurlNode ? (laurlNode.getAttribute('licenseUrl') || laurlNode.getAttribute('Lic_URL') || laurlNode.textContent.trim()) : ''
      };
      if (info.keySystem || info.defaultKid || info.pssh) infos.push(info);
    }
    return infos;
  }

  function mergeDrmInfos(a, b) {
    var out = [];
    (a || []).concat(b || []).forEach(function (info) {
      var key = (info.keySystem || '') + '|' + (info.schemeIdUri || '') + '|' + (info.defaultKid || '');
      for (var i = 0; i < out.length; i++) {
        if (((out[i].keySystem || '') + '|' + (out[i].schemeIdUri || '') + '|' + (out[i].defaultKid || '')) === key) return;
      }
      out.push(info);
    });
    return out;
  }

  function normalizedClearKeys(clearKeys) {
    var out = {};
    for (var kid in (clearKeys || {})) {
      if (!clearKeys.hasOwnProperty(kid)) continue;
      var normalizedKid = normalizeKid(kid);
      var normalizedKey = normalizeKid(clearKeys[kid]);
      if (normalizedKid && normalizedKey) out[normalizedKid] = normalizedKey;
    }
    return out;
  }

  function clearKeyJwkSet(clearKeys) {
    var normalized = normalizedClearKeys(clearKeys);
    var keys = [];
    for (var kid in normalized) {
      if (!normalized.hasOwnProperty(kid)) continue;
      keys.push({ kty: 'oct', kid: hexToBase64Url(kid), k: hexToBase64Url(normalized[kid]) });
    }
    return { keys: keys };
  }

  function chooseDrmInfo(reps, drmConfig) {
    var infos = [];
    (reps || []).forEach(function (rep) { infos = infos.concat(rep && rep.drmInfos ? rep.drmInfos : []); });
    if (!infos.length) return null;
    var servers = (drmConfig && drmConfig.servers) || {};
    var priority = ['org.w3.clearkey', 'com.widevine.alpha', 'com.microsoft.playready'];
    for (var p = 0; p < priority.length; p++) {
      for (var i = 0; i < infos.length; i++) {
        if (infos[i].keySystem !== priority[p]) continue;
        return {
          keySystem: infos[i].keySystem,
          schemeIdUri: infos[i].schemeIdUri || '',
          defaultKid: infos[i].defaultKid || '',
          pssh: infos[i].pssh || null,
          licenseServerUrl: servers[infos[i].keySystem] || infos[i].licenseServerUrl || ''
        };
      }
    }
    return infos[0].keySystem ? infos[0] : { keySystem: '', schemeIdUri: infos[0].schemeIdUri || '', defaultKid: infos[0].defaultKid || '', pssh: infos[0].pssh || null, licenseServerUrl: '' };
  }

  function parseMPD(text, manifestUrl) {
    var doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.querySelector('parsererror')) throw new Error('mpd-parse-failed');
    var mpd = doc.documentElement;
    var type = mpd.getAttribute('type') || 'static';
    if (type !== 'static' && type !== 'dynamic') throw new Error('dash-mpd-type-unsupported');
    var warnings = [];
    var profile = mpd.getAttribute('profiles') || '';
    var duration = parseDuration(mpd.getAttribute('mediaPresentationDuration'));
    var minimumUpdatePeriod = parseDuration(mpd.getAttribute('minimumUpdatePeriod'));
    var timeShiftBufferDepth = parseDuration(mpd.getAttribute('timeShiftBufferDepth'));
    var availabilityStartTime = Date.parse(mpd.getAttribute('availabilityStartTime') || '');
    var publishTime = Date.parse(mpd.getAttribute('publishTime') || '');
    var periodNodes = directChildren(mpd, 'Period');
    if (type === 'dynamic') {
      if (!mpd.getAttribute('availabilityStartTime')) throw new Error('dash-live-ast-missing');
    }
    var reps = [];
    var textReps = [];
    var imageReps = [];
    var timelineRegions = [];
    var mpdBase = directChildText(mpd, 'BaseURL');
    var mpdTemplate = directChild(mpd, 'SegmentTemplate');
    var mpdList = segmentListChain([], directChild(mpd, 'SegmentList'));
    var mpdSegmentBase = segmentListChain([], directChild(mpd, 'SegmentBase'));
    var periods = periodNodes.length ? periodNodes : [mpd];
    for (var p = 0; p < periods.length; p++) {
      var period = periods[p];
      var periodStart = period.localName === 'Period' ? parseDuration(period.getAttribute('start')) : 0;
      if (!isFinite(periodStart)) periodStart = inferPeriodStart(periods, p);
      var periodDuration = period.localName === 'Period' ? parseDuration(period.getAttribute('duration')) : duration;
      var periodEnd = isFinite(periodDuration) ? periodStart + periodDuration : inferPeriodEnd(periods, p, duration);
      if (!isFinite(periodDuration) && isFinite(periodEnd)) periodDuration = periodEnd - periodStart;
      timelineRegions = timelineRegions.concat(parseDashEventStreams(period, periodStart));
      var periodBase = resolveBaseUrl(mpdBase, directChildText(period, 'BaseURL'), manifestUrl);
      var periodDirectTemplate = directChild(period, 'SegmentTemplate');
      var periodDirectList = directChild(period, 'SegmentList');
      var periodDirectSegmentBase = directChild(period, 'SegmentBase');
      var periodTemplate = periodDirectTemplate || (periodDirectList ? null : mpdTemplate);
      var periodList = segmentListChain(periodDirectTemplate ? [] : mpdList, periodDirectList);
      var periodSegmentBase = segmentListChain(periodDirectTemplate || periodDirectList ? [] : mpdSegmentBase, periodDirectSegmentBase);
      var sets = period.querySelectorAll('AdaptationSet');
      for (var i = 0; i < sets.length; i++) {
      var set = sets[i];
      var setDrmInfos = parseContentProtectionList(directChildren(set, 'ContentProtection'));
      var setMime = set.getAttribute('mimeType') || '';
      var setBase = resolveBaseUrl(periodBase, directChildText(set, 'BaseURL'), manifestUrl);
      var setDirectTemplate = directChild(set, 'SegmentTemplate');
      var setDirectList = directChild(set, 'SegmentList');
      var setDirectSegmentBase = directChild(set, 'SegmentBase');
      var setTemplate = setDirectTemplate || (setDirectList ? null : periodTemplate);
      var setList = segmentListChain(setDirectTemplate ? [] : periodList, setDirectList);
      var setSegmentBase = segmentListChain(setDirectTemplate || setDirectList ? [] : periodSegmentBase, setDirectSegmentBase);
      var setRoles = descriptorValues(set, 'Role');
      var setAccessibility = descriptorValues(set, 'Accessibility');
      var setLabel = directChildText(set, 'Label') || set.getAttribute('label') || '';
      var setChannels = descriptorValues(set, 'AudioChannelConfiguration');
      var repNodes = set.querySelectorAll('Representation');
      for (var j = 0; j < repNodes.length; j++) {
        var r = repNodes[j];
        var repDrmInfos = mergeDrmInfos(setDrmInfos, parseContentProtectionList(directChildren(r, 'ContentProtection')));
        var baseText = resolveBaseUrl(setBase, directChildText(r, 'BaseURL'), manifestUrl);
        var repDirectSegmentBase = directChild(r, 'SegmentBase');
        var repDirectTemplate = directChild(r, 'SegmentTemplate');
        var repDirectList = directChild(r, 'SegmentList');
        var segTemplate = repDirectTemplate || (repDirectList ? null : setTemplate);
        var segList = segmentListChain(repDirectTemplate ? [] : setList, repDirectList);
        var segmentBaseChain = segmentListChain(repDirectTemplate || repDirectList ? [] : setSegmentBase, repDirectSegmentBase);
        var segBase = segmentBaseChain.length ? segmentBaseChain[segmentBaseChain.length - 1] : null;
        var init = segmentBaseChain.length ? inheritedDirectChild(segmentBaseChain, 'Initialization') : null;
        var mimeType = r.getAttribute('mimeType') || setMime;
        var codecs = r.getAttribute('codecs') || '';
        var kind = mimeType.indexOf('audio/') === 0 ? 'audio' : (isTextMime(mimeType) ? 'text' : (isImageMime(mimeType) ? 'image' : 'video'));
        var language = r.getAttribute('lang') || set.getAttribute('lang') || '';
        var label = directChildText(r, 'Label') || r.getAttribute('label') || setLabel || language || '';
        var roles = mergeUnique(setRoles, descriptorValues(r, 'Role'));
        var accessibility = mergeUnique(setAccessibility, descriptorValues(r, 'Accessibility'));
        var channels = (descriptorValues(r, 'AudioChannelConfiguration')[0] || setChannels[0] || '');
        var rep = {
          id: r.getAttribute('id') || String(j),
          kind: kind,
          mimeType: mimeType,
          codecs: codecs,
          bandwidth: parseInt(r.getAttribute('bandwidth') || '0', 10),
          width: parseInt(r.getAttribute('width') || '0', 10),
          height: parseInt(r.getAttribute('height') || '0', 10),
          tilesHorizontal: r.getAttribute('tilesHorizontal') || r.getAttribute('tileColumns') || '',
          tilesVertical: r.getAttribute('tilesVertical') || r.getAttribute('tileRows') || '',
          asr: parseInt(r.getAttribute('audioSamplingRate') || '0', 10),
          language: language,
          label: label,
        roles: roles,
        accessibility: accessibility,
        channels: channels,
          periodIndex: p,
          source: kind === 'text' ? 'native-dash' : '',
          drmInfos: repDrmInfos
        };
        textReps = textReps.concat(parseDashCeaTextTracks(set, r, rep));
        if (kind === 'text') {
          rep.supported = isSupportedTextMime(mimeType);
          rep.renderSupported = isRenderableTextMime(mimeType);
          rep.url = directChildText(r, 'BaseURL')
            ? resolveBaseUrl(setBase, directChildText(r, 'BaseURL'), manifestUrl)
            : (directChildText(set, 'BaseURL') ? setBase : '');
          textReps.push(rep);
          continue;
        }
        if (kind === 'image') {
          rep.source = 'native-dash';
          if (segTemplate) {
            var imageTemplateData = parseSegmentTemplate(segTemplate, rep, baseText, manifestUrl, isFinite(periodDuration) ? periodDuration : duration, type, periodStart, periodEnd, warnings, {
              availabilityStartTime: availabilityStartTime,
              publishTime: publishTime,
              timeShiftBufferDepth: timeShiftBufferDepth,
              minimumUpdatePeriod: minimumUpdatePeriod
            });
            if (imageTemplateData) {
              rep.initUrl = imageTemplateData.initUrl;
              rep.templateSegments = imageTemplateData.segments.map(function (segment) { return annotateImageSegment(segment, rep); });
              imageReps.push(rep);
            }
            continue;
          }
          if (segList) {
            var imageListData = parseSegmentList(segList, rep, baseText, manifestUrl, isFinite(periodDuration) ? periodDuration : duration, periodStart, periodEnd, warnings);
            if (imageListData) {
              rep.initUrl = imageListData.initUrl;
              rep.initRange = imageListData.initRange;
              rep.segments = imageListData.segments.map(function (segment) { return annotateImageSegment(segment, rep); });
              imageReps.push(rep);
            }
            continue;
          }
          if (segBase && init && baseText) {
            rep.baseUrl = resolveUrl(baseText, manifestUrl);
            rep.initRange = parseRange(init.getAttribute('range'));
            rep.indexRange = parseRange(inheritedAttr(segmentBaseChain, 'indexRange'));
            imageReps.push(rep);
          }
          continue;
        }
        if (segBase && init) {
          if (!baseText) continue;
          rep.baseUrl = resolveUrl(baseText, manifestUrl);
          rep.initRange = parseRange(init.getAttribute('range'));
          rep.indexRange = parseRange(inheritedAttr(segmentBaseChain, 'indexRange'));
          rep.generationKey = generationKeyForRep(rep);
          rep.periodGenerations = [periodGenerationForRep(rep)];
          reps.push(rep);
          continue;
        }
        if (segTemplate) {
          var templateData = parseSegmentTemplate(segTemplate, rep, baseText, manifestUrl, isFinite(periodDuration) ? periodDuration : duration, type, periodStart, periodEnd, warnings, {
            availabilityStartTime: availabilityStartTime,
            publishTime: publishTime,
            timeShiftBufferDepth: timeShiftBufferDepth,
            minimumUpdatePeriod: minimumUpdatePeriod
          });
          if (templateData) {
            rep.initUrl = templateData.initUrl;
            rep.templateSegments = templateData.segments;
            annotateSegmentGeneration(rep, rep.templateSegments, rep.initUrl, rep.initRange || null);
            reps.push(rep);
          }
          continue;
        }
        if (segList) {
          var listData = parseSegmentList(segList, rep, baseText, manifestUrl, isFinite(periodDuration) ? periodDuration : duration, periodStart, periodEnd, warnings);
          if (listData) {
            rep.initUrl = listData.initUrl;
            rep.initRange = listData.initRange;
            rep.segments = listData.segments;
            annotateSegmentGeneration(rep, rep.segments, rep.initUrl, rep.initRange || null);
            reps.push(rep);
          }
        }
      }
    }
    }
    if (!reps.length && doc.querySelector('SegmentTemplate')) throw new Error(type === 'dynamic' ? 'dash-live-template-unsupported' : 'dash-template-unsupported');
    if (!reps.length && doc.querySelector('SegmentList')) throw new Error('dash-segmentlist-unsupported');
    reps = mergePeriodRepresentations(reps, warnings);
    var liveWindow = type === 'dynamic' ? liveWindowForReps(reps, timeShiftBufferDepth) : null;
    return {
      type: type,
      duration: duration,
      periodCount: periods.length,
      profile: profile,
      warnings: warnings,
      minimumUpdatePeriod: isFinite(minimumUpdatePeriod) ? minimumUpdatePeriod : 5,
      timeShiftBufferDepth: isFinite(timeShiftBufferDepth) ? timeShiftBufferDepth : 0,
      liveWindow: liveWindow,
      timelineRegions: timelineRegions,
      video: reps.filter(function (r) { return r.kind === 'video'; }),
      audio: reps.filter(function (r) { return r.kind === 'audio'; }),
      text: mergeTextRepresentations(textReps),
      images: mergeImageRepresentations(imageReps)
    };
  }

  function parseSegmentTemplate(node, rep, baseText, manifestUrl, duration, mpdType, periodStart, periodEnd, warnings, liveContext) {
    var initPattern = node.getAttribute('initialization') || '';
    var mediaPattern = node.getAttribute('media') || '';
    if (!mediaPattern || (!initPattern && rep.kind !== 'image')) return null;
    var timescale = parseInt(node.getAttribute('timescale') || '1', 10) || 1;
    var startNumber = parseInt(node.getAttribute('startNumber') || '1', 10) || 1;
    var pto = parseInt(node.getAttribute('presentationTimeOffset') || '0', 10) || 0;
    var base = resolveUrl(baseText || '', manifestUrl);
    var timeline = directChild(node, 'SegmentTimeline');
    var segments = timeline
      ? templateTimelineSegments(timeline, mediaPattern, rep, base, timescale, startNumber, pto, periodStart || 0, periodEnd, duration, warnings)
      : (mpdType === 'dynamic'
        ? dynamicTemplateNumberSegments(node, mediaPattern, rep, base, timescale, startNumber, pto, periodStart || 0, periodEnd, liveContext || {}, warnings)
        : templateNumberSegments(node, mediaPattern, rep, base, timescale, startNumber, duration, periodStart || 0, periodEnd));
    if (!segments.length) return null;
    return {
      initUrl: initPattern ? resolveUrl(expandTemplateUrl(initPattern, rep, startNumber, 0), base) : '',
      segments: segments
    };
  }

  function annotateImageSegment(segment, rep) {
    segment = clonePlain(segment);
    segment.imageOnly = true;
    segment.thumbnailType = 'dash-image';
    segment.tiles = dashImageTiles(rep);
    return segment;
  }

  function dashImageTiles(rep) {
    return {
      width: rep.width || 0,
      height: rep.height || 0,
      columns: parseInt(rep.tilesHorizontal || rep.tileColumns || '0', 10) || 0,
      rows: parseInt(rep.tilesVertical || rep.tileRows || '0', 10) || 0,
      duration: 0
    };
  }

  function parseSegmentList(nodes, rep, baseText, manifestUrl, duration, periodStart, periodEnd, warnings) {
    var chain = Array.isArray(nodes) ? nodes.filter(Boolean) : [nodes].filter(Boolean);
    if (!chain.length) return null;
    var base = resolveUrl(baseText || '', manifestUrl);
    for (var b = 0; b < chain.length; b++) {
      var listBase = directChildText(chain[b], 'BaseURL');
      if (listBase) base = resolveBaseUrl(base, listBase, manifestUrl);
    }
    var init = inheritedDirectChild(chain, 'Initialization');
    if (!init) return null;
    var initSource = init.getAttribute('sourceURL') || '';
    var initUrl = initSource ? resolveUrl(initSource, base) : base;
    var initRange = parseOptionalRange(init.getAttribute('range'));
    var urls = inheritedDirectChildren(chain, 'SegmentURL');
    if (!urls.length) return null;
    var timescale = parseInt(inheritedAttr(chain, 'timescale') || '1', 10) || 1;
    var listDuration = parseInt(inheritedAttr(chain, 'duration') || '0', 10);
    var seconds = listDuration ? listDuration / timescale : 0;
    if (!seconds && isFinite(duration) && duration > 0) {
      seconds = duration / urls.length;
      if (warnings) warnings.push('segmentlist-duration-derived');
    }
    if (!seconds || !isFinite(seconds)) return null;
    var segments = [];
    for (var i = 0; i < urls.length; i++) {
      var nodeUrl = urls[i];
      var media = nodeUrl.getAttribute('media') || '';
      var mediaRange = parseOptionalRange(nodeUrl.getAttribute('mediaRange'));
      var start = (periodStart || 0) + i * seconds;
      var end = Math.min((periodStart || 0) + duration, start + seconds);
      if (!isFinite(end)) end = start + seconds;
      segments.push({
        start: start,
        end: end,
        url: media ? resolveUrl(media, base) : base,
        range: mediaRange || null,
        periodIndex: rep.periodIndex || 0,
        appendWindow: appendWindow(periodStart, periodEnd)
      });
    }
    return {
      initUrl: initUrl,
      initRange: initRange,
      segments: segments
    };
  }

  function segmentListChain(parent, node) {
    var chain = parent ? parent.slice() : [];
    if (node) chain.push(node);
    return chain;
  }

  function inheritedAttr(chain, name) {
    for (var i = chain.length - 1; i >= 0; i--) {
      if (chain[i] && chain[i].hasAttribute(name)) return chain[i].getAttribute(name);
    }
    return '';
  }

  function inheritedDirectChild(chain, name) {
    for (var i = chain.length - 1; i >= 0; i--) {
      var child = directChild(chain[i], name);
      if (child) return child;
    }
    return null;
  }

  function inheritedDirectChildren(chain, name) {
    for (var i = chain.length - 1; i >= 0; i--) {
      var children = directChildren(chain[i], name);
      if (children.length) return children;
    }
    return [];
  }

  function templateNumberSegments(node, pattern, rep, base, timescale, startNumber, duration, periodStart, periodEnd) {
    var segmentDuration = parseInt(node.getAttribute('duration') || '0', 10);
    if (!segmentDuration || !duration || !isFinite(duration)) return [];
    var seconds = segmentDuration / timescale;
    var count = Math.ceil(duration / seconds);
    var segments = [];
    for (var i = 0; i < count; i++) {
      var number = startNumber + i;
      var start = (periodStart || 0) + i * seconds;
      segments.push({
        start: start,
        end: Math.min((periodStart || 0) + duration, start + seconds),
        url: resolveUrl(expandTemplateUrl(pattern, rep, number, i * segmentDuration), base),
        periodIndex: rep.periodIndex || 0,
        appendWindow: appendWindow(periodStart, periodEnd)
      });
    }
    return segments;
  }

  function dynamicTemplateNumberSegments(node, pattern, rep, base, timescale, startNumber, presentationTimeOffset, periodStart, periodEnd, liveContext, warnings) {
    var segmentDuration = parseInt(node.getAttribute('duration') || '0', 10);
    if (!segmentDuration) return [];
    var seconds = segmentDuration / timescale;
    if (!seconds || !isFinite(seconds)) return [];
    var nowMs = isFinite(liveContext.publishTime) ? liveContext.publishTime : Date.now();
    if (!isFinite(liveContext.availabilityStartTime)) return [];
    var presentationNow = Math.max(periodStart, (nowMs - liveContext.availabilityStartTime) / 1000);
    var periodBoundary = isFinite(periodEnd) ? periodEnd : presentationNow;
    var windowDepth = isFinite(liveContext.timeShiftBufferDepth) && liveContext.timeShiftBufferDepth > 0
      ? liveContext.timeShiftBufferDepth
      : Math.max(seconds * 3, (isFinite(liveContext.minimumUpdatePeriod) ? liveContext.minimumUpdatePeriod : 5) * 3);
    var windowEnd = Math.min(periodBoundary, presentationNow);
    var windowStart = Math.max(periodStart, windowEnd - windowDepth);
    var firstIndex = Math.max(0, Math.floor((windowStart - periodStart) / seconds));
    var lastIndex = Math.max(firstIndex, Math.ceil((windowEnd - periodStart) / seconds) - 1);
    if (lastIndex - firstIndex > 59) firstIndex = lastIndex - 59;
    var segments = [];
    for (var i = firstIndex; i <= lastIndex; i++) {
      var start = periodStart + i * seconds;
      var end = Math.min(periodBoundary, start + seconds);
      if (end <= start) continue;
      var time = (i * segmentDuration) + (presentationTimeOffset || 0);
      segments.push({
        start: start,
        end: end,
        url: resolveUrl(expandTemplateUrl(pattern, rep, startNumber + i, time), base),
        periodIndex: rep.periodIndex || 0,
        appendWindow: appendWindow(periodStart, periodEnd)
      });
    }
    if (segments.length && warnings && warnings.indexOf('dynamic-number-template-window-derived') === -1) {
      warnings.push('dynamic-number-template-window-derived');
    }
    return segments;
  }

  function templateTimelineSegments(timeline, pattern, rep, base, timescale, startNumber, presentationTimeOffset, periodStart, periodEnd, duration, warnings) {
    var nodes = timeline.querySelectorAll('S');
    var segments = [];
    var time = 0;
    var number = startNumber;
    var boundary = isFinite(periodEnd) ? periodEnd : (isFinite(duration) ? periodStart + duration : NaN);
    for (var i = 0; i < nodes.length; i++) {
      var s = nodes[i];
      if (s.getAttribute('t') != null) time = parseInt(s.getAttribute('t'), 10);
      var d = parseInt(s.getAttribute('d') || '0', 10);
      var repeat = parseInt(s.getAttribute('r') || '0', 10);
      if (!d) continue;
      if (repeat < 0) {
        if (!isFinite(boundary)) throw new Error('dash-template-unbounded-repeat');
        var startAt = periodStart + ((time - (presentationTimeOffset || 0)) / timescale);
        repeat = Math.max(0, Math.ceil((boundary - startAt) / (d / timescale)) - 1);
        if (warnings) warnings.push('segmenttimeline-negative-repeat-expanded');
      }
      for (var j = 0; j <= repeat; j++) {
        var start = periodStart + ((time - (presentationTimeOffset || 0)) / timescale);
        var end = periodStart + ((time + d - (presentationTimeOffset || 0)) / timescale);
        if (isFinite(boundary) && start >= boundary) break;
        segments.push({
          start: start,
          end: isFinite(boundary) ? Math.min(boundary, end) : end,
          url: resolveUrl(expandTemplateUrl(pattern, rep, number, time), base),
          periodIndex: rep.periodIndex || 0,
          appendWindow: appendWindow(periodStart, periodEnd)
        });
        time += d;
        number++;
      }
    }
    return segments;
  }

  function expandTemplateUrl(pattern, rep, number, time) {
    return String(pattern)
      .replace(/\$RepresentationID\$/g, rep.id)
      .replace(/\$Bandwidth\$/g, String(rep.bandwidth || 0))
      .replace(/\$Number(?:%0(\d+)d)?\$/g, function (_, width) { return padNumber(number, parseInt(width || '0', 10)); })
      .replace(/\$Time\$/g, String(time || 0));
  }

  function padNumber(value, width) {
    var text = String(value);
    while (text.length < width) text = '0' + text;
    return text;
  }

  function directChild(node, tag) {
    for (var i = 0; i < node.children.length; i++) {
      if (node.children[i].localName === tag) return node.children[i];
    }
    return null;
  }

  function directChildren(node, tag) {
    var out = [];
    for (var i = 0; i < node.children.length; i++) {
      if (node.children[i].localName === tag) out.push(node.children[i]);
    }
    return out;
  }

  function directChildText(node, tag) {
    var child = directChild(node, tag);
    return child ? child.textContent.trim() : '';
  }

  function parseDashEventStreams(period, periodStart) {
    var regions = [];
    var streams = directChildren(period, 'EventStream');
    for (var i = 0; i < streams.length; i++) {
      var stream = streams[i];
      var timescale = parseInt(stream.getAttribute('timescale') || '1', 10) || 1;
      var scheme = stream.getAttribute('schemeIdUri') || '';
      var value = stream.getAttribute('value') || '';
      var events = directChildren(stream, 'Event');
      for (var j = 0; j < events.length; j++) {
        var event = events[j];
        var presentationTime = parseFloat(event.getAttribute('presentationTime') || '0') || 0;
        var duration = parseFloat(event.getAttribute('duration') || '0') || 0;
        var startTime = (periodStart || 0) + (presentationTime / timescale);
        var eventDuration = duration / timescale;
        var messageData = event.getAttribute('messageData') || event.textContent || '';
        regions.push({
          id: event.getAttribute('id') || scheme + ':' + value + ':' + startTime + ':' + j,
          schemeIdUri: scheme,
          value: value,
          startTime: startTime,
          endTime: startTime + eventDuration,
          eventElement: messageData,
          source: 'dash-eventstream'
        });
      }
    }
    return regions;
  }

  function descriptorValues(node, tag) {
    var values = [];
    var children = directChildren(node, tag);
    for (var i = 0; i < children.length; i++) {
      var value = children[i].getAttribute('value') || children[i].getAttribute('schemeIdUri') || children[i].textContent.trim();
      if (value) values.push(value);
    }
    return values;
  }

  function mergeUnique(a, b) {
    var out = [];
    (a || []).concat(b || []).forEach(function (value) {
      if (value && out.indexOf(value) === -1) out.push(value);
    });
    return out;
  }

  function isTextMime(mimeType) {
    return /^(text\/|application\/(ttml|vtt))/i.test(mimeType || '') && mimeType.indexOf('audio/') !== 0 && mimeType.indexOf('video/') !== 0;
  }

  function isImageMime(mimeType) {
    return /^image\//i.test(mimeType || '');
  }

  function isSupportedTextMime(mimeType) {
    return /text\/vtt|application\/vtt|application\/ttml\+xml/i.test(mimeType || '');
  }

  function isVttTextMime(mimeType) {
    return /text\/vtt|application\/vtt/i.test(mimeType || '');
  }

  function isTtmlTextMime(mimeType) {
    return /application\/ttml\+xml|ttml|xml/i.test(mimeType || '');
  }

  function isRenderableTextMime(mimeType) {
    return isVttTextMime(mimeType) || isTtmlTextMime(mimeType);
  }

  function parseVttTime(value) {
    var parts = String(value || '').trim().replace(',', '.').split(':');
    if (parts.length < 2) return NaN;
    var seconds = parseFloat(parts.pop());
    var minutes = parseInt(parts.pop(), 10);
    var hours = parts.length ? parseInt(parts.pop(), 10) : 0;
    if (!isFinite(seconds) || !isFinite(minutes) || !isFinite(hours)) return NaN;
    return hours * 3600 + minutes * 60 + seconds;
  }

  function parseVttCues(text) {
    var lines = String(text || '').replace(/^\uFEFF/, '').replace(/\r/g, '').split('\n');
    var cues = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line || /^WEBVTT($|\s)/i.test(line)) continue;
      if (/^(NOTE|STYLE|REGION)($|\s)/i.test(line)) {
        while (i + 1 < lines.length && lines[i + 1].trim()) i++;
        continue;
      }
      if (line.indexOf('-->') === -1 && i + 1 < lines.length && lines[i + 1].indexOf('-->') !== -1) {
        line = lines[++i].trim();
      }
      if (line.indexOf('-->') === -1) continue;
      var timing = line.split(/\s+-->\s+/);
      if (timing.length < 2) continue;
      var start = parseVttTime(timing[0]);
      var end = parseVttTime(timing[1].split(/\s+/)[0]);
      var cueLines = [];
      while (i + 1 < lines.length && lines[i + 1].trim()) cueLines.push(lines[++i]);
      if (!isFinite(start) || !isFinite(end) || end <= start) continue;
      var cueText = cueLines.join('\n')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .trim();
      cues.push({ start: start, end: end, text: cueText });
    }
    return cues;
  }

  function parseTtmlTime(value) {
    if (!value) return NaN;
    var text = String(value).trim();
    var clock = text.match(/^(\d+):(\d{2}):(\d{2})(?:[.,](\d+))?$/);
    if (clock) {
      return parseInt(clock[1], 10) * 3600
        + parseInt(clock[2], 10) * 60
        + parseInt(clock[3], 10)
        + parseFloat('0.' + (clock[4] || '0'));
    }
    var offset = text.match(/^([\d.]+)(h|m|s|ms)$/);
    if (!offset) return NaN;
    var n = parseFloat(offset[1]);
    if (!isFinite(n)) return NaN;
    if (offset[2] === 'h') return n * 3600;
    if (offset[2] === 'm') return n * 60;
    if (offset[2] === 'ms') return n / 1000;
    return n;
  }

  function parseTtmlCues(text) {
    var cues = [];
    var doc = new DOMParser().parseFromString(String(text || ''), 'application/xml');
    if (doc.querySelector('parsererror')) return cues;
    var nodes = doc.querySelectorAll('p');
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      var start = parseTtmlTime(node.getAttribute('begin'));
      var end = parseTtmlTime(node.getAttribute('end'));
      var dur = parseTtmlTime(node.getAttribute('dur'));
      if (!isFinite(end) && isFinite(start) && isFinite(dur)) end = start + dur;
      var cueText = (node.textContent || '').replace(/\s+/g, ' ').trim();
      if (!isFinite(start) || !isFinite(end) || end <= start || !cueText) continue;
      cues.push({ start: start, end: end, text: cueText });
    }
    return cues;
  }

  function parseNativeTextCues(text, mimeType) {
    return isTtmlTextMime(mimeType) ? parseTtmlCues(text) : parseVttCues(text);
  }

  function nativeTextOverlay() {
    if (!document || !document.querySelector) return null;
    return document.querySelector('.custom-caption-container') || document.getElementById('caption-overlay');
  }

  function nativeActiveTextRep(provider) {
    var id = provider.activeTextTrackId;
    if (!id) {
      var activeRendition = (provider.subtitleRenditions || []).find(function (item) { return item.active; });
      id = activeRendition ? activeRendition.id : '';
    }
    return (provider.textReps || provider.subtitleRenditions || []).find(function (item) { return item.id === id; }) || null;
  }

  function ensureNativeTextState(provider) {
    if (!provider.textCueCache) provider.textCueCache = {};
    if (!provider.textLoadStates) provider.textLoadStates = {};
  }

  function updateNativeTextOverlay(provider) {
    ensureNativeTextState(provider);
    var rep = nativeActiveTextRep(provider);
    var overlay = nativeTextOverlay();
    if (!rep || !provider.textTrackVisibility) {
      if (overlay) overlay.textContent = '';
      window._captionsVisible = false;
      return;
    }
    var cues = provider.textCueCache[rep.id] || [];
    window._captionCues = cues;
    window._captionsVisible = true;
    if (!overlay) return;
    var time = provider.video ? provider.video.currentTime || 0 : 0;
    var activeCue = cues.find(function (cue) { return time >= cue.start && time < cue.end; });
    overlay.textContent = activeCue ? activeCue.text : '';
  }

  function clearNativeTextOverlay(provider) {
    if (provider) provider.textTrackVisibility = false;
    var overlay = nativeTextOverlay();
    if (overlay) overlay.textContent = '';
    window._captionCues = null;
    window._captionsVisible = false;
  }

  function installNativeTextUpdater(provider) {
    if (!provider.video || provider._boundNativeTextCueUpdate) return;
    provider._boundNativeTextCueUpdate = function () { updateNativeTextOverlay(provider); };
    provider.video.addEventListener('timeupdate', provider._boundNativeTextCueUpdate);
    provider.video.addEventListener('seeking', provider._boundNativeTextCueUpdate);
  }

  function selectNativeTextTrack(provider, rep, setActive) {
    ensureNativeTextState(provider);
    provider.textTrackVisibility = true;
    if (setActive) setActive.call(provider, true);
    provider.lastTextTrackError = '';
    installNativeTextUpdater(provider);
    if (!isRenderableTextMime(rep.mimeType || '')) {
      rep.loadState = 'unsupported';
      rep.renderSupported = false;
      provider.textLoadStates[rep.id] = 'unsupported';
      provider.lastTextTrackError = 'text-track-render-unsupported';
      updateNativeTextOverlay(provider);
      provider.engine._player.emit('texttrackchanged', provider.getActiveTextTrack());
      return Promise.resolve();
    }
    rep.renderSupported = true;
    if (provider.textCueCache[rep.id]) {
      rep.loadState = 'loaded';
      provider.textLoadStates[rep.id] = 'loaded';
      updateNativeTextOverlay(provider);
      provider.engine._player.emit('texttrackchanged', provider.getActiveTextTrack());
      return Promise.resolve();
    }
    rep.loadState = 'loading';
    provider.textLoadStates[rep.id] = 'loading';
    provider.engine._player.emit('texttrackchanged', provider.getActiveTextTrack());
    return fetch(stampUri(provider.engine, rep.url)).then(function (res) {
      if (!res.ok) throw new Error('http-' + res.status);
      return res.text();
    }).then(function (text) {
      provider.textCueCache[rep.id] = parseNativeTextCues(text, rep.mimeType || '');
      rep.loadState = 'loaded';
      provider.textLoadStates[rep.id] = 'loaded';
      updateNativeTextOverlay(provider);
      provider.engine._player.emit('texttrackchanged', provider.getActiveTextTrack());
    }).catch(function (err) {
      rep.loadState = 'error';
      provider.textLoadStates[rep.id] = 'error';
      provider.lastTextTrackError = err && err.message ? err.message : 'text-track-load-failed';
      provider.textCueCache[rep.id] = [];
      updateNativeTextOverlay(provider);
      provider.engine._player.emit('texttrackchanged', provider.getActiveTextTrack());
    });
  }

  function inferPeriodStart(periods, index) {
    var start = 0;
    for (var i = 0; i < index; i++) {
      var explicit = parseDuration(periods[i].getAttribute('start'));
      if (isFinite(explicit)) start = explicit;
      var duration = parseDuration(periods[i].getAttribute('duration'));
      if (isFinite(duration)) start += duration;
    }
    return start;
  }

  function inferPeriodEnd(periods, index, duration) {
    for (var i = index + 1; i < periods.length; i++) {
      var explicit = parseDuration(periods[i].getAttribute('start'));
      if (isFinite(explicit)) return explicit;
      var inferred = inferPeriodStart(periods, i);
      if (isFinite(inferred) && inferred > 0) return inferred;
    }
    return isFinite(duration) ? duration : NaN;
  }

  function resolveBaseUrl(parentBase, childBase, manifestUrl) {
    var parent = parentBase ? resolveUrl(parentBase, manifestUrl) : manifestUrl;
    return childBase ? resolveUrl(childBase, parent) : parentBase || '';
  }

  function appendWindow(start, end) {
    if (!isFinite(start) && !isFinite(end)) return null;
    return {
      start: isFinite(start) ? Math.max(0, start) : 0,
      end: isFinite(end) ? end : Infinity
    };
  }

  function annotateSegmentGeneration(rep, segments, initUrl, initRange) {
    rep.generationKey = generationKeyForRep(rep);
    rep.periodGenerations = [periodGenerationForRep(rep)];
    for (var i = 0; i < (segments || []).length; i++) {
      segments[i].generationKey = rep.generationKey;
      segments[i].mimeType = rep.mimeType;
      segments[i].codecs = rep.codecs;
      segments[i].initUrl = initUrl || rep.initUrl || '';
      segments[i].initRange = initRange || rep.initRange || null;
    }
  }

  function generationKeyForRep(rep) {
    var range = rep && rep.initRange ? ':' + rep.initRange.start + '-' + rep.initRange.end : '';
    return [
      rep && rep.kind || '',
      rep && rep.id || '',
      'p' + (rep && rep.periodIndex != null ? rep.periodIndex : 0),
      rep && rep.mimeType || '',
      rep && rep.codecs || '',
      rep && (rep.initUrl || rep.baseUrl) || '',
      range
    ].join('|');
  }

  function periodGenerationForRep(rep) {
    return {
      key: rep.generationKey || generationKeyForRep(rep),
      periodIndex: rep.periodIndex || 0,
      mimeType: rep.mimeType || '',
      codecs: rep.codecs || '',
      initUrl: rep.initUrl || rep.baseUrl || '',
      initRange: rep.initRange || null
    };
  }

  function mergePeriodGenerations(current, next) {
    var out = (current || []).slice();
    for (var i = 0; i < (next || []).length; i++) {
      var exists = false;
      for (var j = 0; j < out.length; j++) {
        if (out[j].key === next[i].key) {
          exists = true;
          break;
        }
      }
      if (!exists) out.push(next[i]);
    }
    out.sort(function (a, b) { return (a.periodIndex || 0) - (b.periodIndex || 0); });
    return out;
  }

  function cacheInitData(rep, key, data) {
    rep._initDataByKey = rep._initDataByKey || {};
    rep._initDataByKey[key] = data;
  }

  function mergePeriodRepresentations(reps, warnings) {
    var byKey = {};
    var merged = [];
    for (var i = 0; i < reps.length; i++) {
      var rep = reps[i];
      rep.generationKey = rep.generationKey || generationKeyForRep(rep);
      rep.periodGenerations = rep.periodGenerations || [periodGenerationForRep(rep)];
      var key = rep.kind + ':' + rep.id;
      var existing = byKey[key];
      if (!existing) {
        byKey[key] = rep;
        merged.push(rep);
        continue;
      }
      if (existing.mimeType !== rep.mimeType || existing.codecs !== rep.codecs) {
        if (warnings && warnings.indexOf('dash-multiperiod-codec-transition') === -1) warnings.push('dash-multiperiod-codec-transition');
      }
      existing.periodGenerations = mergePeriodGenerations(existing.periodGenerations, rep.periodGenerations);
      if (existing.templateSegments && rep.templateSegments) {
        existing.templateSegments = existing.templateSegments.concat(rep.templateSegments);
        existing.templateSegments.sort(function (a, b) { return a.start - b.start; });
      }
      if (existing.segments && rep.segments) {
        existing.segments = existing.segments.concat(rep.segments);
        existing.segments.sort(function (a, b) { return a.start - b.start; });
      }
    }
    return merged;
  }

  function mergeTextRepresentations(reps) {
    var byKey = {};
    var merged = [];
    for (var i = 0; i < reps.length; i++) {
      var rep = reps[i];
      var key = rep.id || [rep.language, rep.label, rep.mimeType].join(':');
      if (!byKey[key]) {
        byKey[key] = rep;
        merged.push(rep);
      }
    }
    return merged;
  }

  function mergeImageRepresentations(reps) {
    var byKey = {};
    var merged = [];
    for (var i = 0; i < reps.length; i++) {
      var rep = reps[i];
      var key = rep.id || [rep.mimeType, rep.baseUrl || rep.url || rep.initUrl].join(':');
      if (!byKey[key]) {
        byKey[key] = rep;
        merged.push(rep);
      }
    }
    return merged;
  }

  function liveWindowForReps(reps, timeShiftBufferDepth) {
    var start = Infinity;
    var end = 0;
    for (var i = 0; i < reps.length; i++) {
      var segs = reps[i].templateSegments || [];
      if (!segs.length) continue;
      start = Math.min(start, segs[0].start || 0);
      end = Math.max(end, segs[segs.length - 1].end || 0);
    }
    if (start === Infinity || end <= start) return null;
    if (isFinite(timeShiftBufferDepth) && timeShiftBufferDepth > 0) {
      start = Math.max(start, end - timeShiftBufferDepth);
    }
    return { start: start, end: end };
  }

  function parseSidx(buffer, indexEnd) {
    var dv = new DataView(buffer);
    var pos = 0;
    var size = dv.getUint32(pos); pos += 4;
    var type = readType(dv, pos); pos += 4;
    if (type !== 'sidx') throw new Error('sidx-missing');
    if (size === 1) pos += 8;
    var version = dv.getUint8(pos); pos += 4;
    pos += 4; // reference_ID
    var timescale = dv.getUint32(pos); pos += 4;
    var firstOffset = 0;
    if (version === 0) {
      pos += 4;
      firstOffset = dv.getUint32(pos);
      pos += 4;
    } else {
      pos += 8;
      var high = dv.getUint32(pos);
      var low = dv.getUint32(pos + 4);
      firstOffset = high * 4294967296 + low;
      pos += 8;
    }
    pos += 2;
    var count = dv.getUint16(pos); pos += 2;
    var byteStart = indexEnd + 1 + firstOffset;
    var time = 0;
    var segments = [];
    for (var i = 0; i < count; i++) {
      var ref = dv.getUint32(pos); pos += 4;
      var refType = ref >>> 31;
      var refSize = ref & 0x7fffffff;
      var dur = dv.getUint32(pos); pos += 4;
      pos += 4;
      if (refType === 0 && refSize > 0) {
        var seconds = dur / timescale;
        segments.push({
          start: time,
          end: time + seconds,
          range: { start: byteStart, end: byteStart + refSize - 1 }
        });
        time += seconds;
        byteStart += refSize;
      }
    }
    return segments;
  }

  function parseRange(value) {
    var m = String(value || '').match(/^(\d+)-(\d+)$/);
    if (!m) throw new Error('bad-range');
    return { start: parseInt(m[1], 10), end: parseInt(m[2], 10) };
  }

  function parseOptionalRange(value) {
    return value ? parseRange(value) : null;
  }

  function parseDuration(value) {
    var m = String(value || '').match(/^PT(?:(\d+)H)?(?:(\d+)M)?([\d.]+)S$/);
    if (!m) return NaN;
    return (parseInt(m[1] || '0', 10) * 3600) + (parseInt(m[2] || '0', 10) * 60) + parseFloat(m[3] || '0');
  }

  function appendBuffer(sb, data, appendWindow, timestampOffset) {
    return queueSourceBuffer(sb, function () {
      return waitForSourceBufferIdle(sb).then(function () {
        return new Promise(function (resolve, reject) {
          var timeoutId = 0;
          function cleanup() {
            if (timeoutId) clearTimeout(timeoutId);
            sb.removeEventListener('updateend', onEnd);
            sb.removeEventListener('error', onError);
          }
          function onEnd() { cleanup(); resolve(); }
          function onError() { cleanup(); reject(new Error('sourcebuffer-error')); }
          sb.addEventListener('updateend', onEnd);
          sb.addEventListener('error', onError);
          try {
            if (appendWindow) {
              if (appendWindow.end > sb.appendWindowStart) sb.appendWindowEnd = appendWindow.end;
              sb.appendWindowStart = appendWindow.start;
              sb.appendWindowEnd = appendWindow.end;
            }
            if (isFinite(timestampOffset) && Math.abs((sb.timestampOffset || 0) - timestampOffset) > 0.001) {
              sb.timestampOffset = timestampOffset;
            }
            sb.appendBuffer(data);
            timeoutId = setTimeout(function () {
              cleanup();
              if (!sb.updating) resolve();
              else reject(new Error('sourcebuffer-timeout'));
            }, SOURCEBUFFER_WATCHDOG_MS);
          } catch (e) { cleanup(); reject(e); }
        });
      });
    });
  }

  function resetSourceBuffer(sb, currentTime) {
    if (!sb.buffered.length) return Promise.resolve();
    return queueSourceBuffer(sb, function () {
      return waitForSourceBufferIdle(sb).then(function () {
        return new Promise(function (resolve) {
          function done() {
            sb.removeEventListener('updateend', done);
            resolve();
          }
          sb.addEventListener('updateend', done);
          try { sb.remove(0, Math.max(0, currentTime + 1)); } catch (e) { done(); }
        });
      });
    });
  }

  function trimBuffer(sb, removeEnd) {
    removeBufferBefore(sb, removeEnd).catch(function () {});
  }

  function removeBufferBefore(sb, removeEnd) {
    if (!sb || !sb.buffered.length || removeEnd <= 0) return Promise.resolve();
    return queueSourceBuffer(sb, function () {
      return waitForSourceBufferIdle(sb).then(function () {
        if (!sb.buffered.length || sb.buffered.start(0) >= removeEnd) return Promise.resolve();
        return new Promise(function (resolve) {
          function done() {
            sb.removeEventListener('updateend', done);
            resolve();
          }
          sb.addEventListener('updateend', done);
          try { sb.remove(sb.buffered.start(0), Math.min(removeEnd, sb.buffered.end(0))); } catch (e) { done(); }
        });
      });
    });
  }

  function queueSourceBuffer(sb, op) {
    var previous = sb._nativeQueue || Promise.resolve();
    sb._nativeQueueDepth = (sb._nativeQueueDepth || 0) + 1;
    var next = previous.catch(function () {}).then(op);
    sb._nativeQueue = next.catch(function () {}).then(function () {
      sb._nativeQueueDepth = Math.max(0, (sb._nativeQueueDepth || 1) - 1);
    });
    return next;
  }

  function appendQueueDepth(sb) {
    return sb && sb._nativeQueueDepth ? sb._nativeQueueDepth : 0;
  }

  function waitForSourceBufferIdle(sb) {
    if (!sb.updating) return Promise.resolve();
    return new Promise(function (resolve) {
      var timeoutId = 0;
      function done() {
        if (timeoutId) clearTimeout(timeoutId);
        sb.removeEventListener('updateend', done);
        resolve();
      }
      sb.addEventListener('updateend', done);
      timeoutId = setTimeout(done, SOURCEBUFFER_WATCHDOG_MS);
    });
  }

  function clonePlain(value) {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) {
      var arr = [];
      for (var i = 0; i < value.length; i++) arr.push(clonePlain(value[i]));
      return arr;
    }
    var out = {};
    for (var key in value) {
      if (Object.prototype.hasOwnProperty.call(value, key)) out[key] = clonePlain(value[key]);
    }
    return out;
  }

  function addTimelineRegions(provider, regions) {
    if (!provider.timelineRegions) provider.timelineRegions = [];
    if (!provider.timelineRegionKeys) provider.timelineRegionKeys = {};
    regions = regions || [];
    for (var i = 0; i < regions.length; i++) {
      var region = normalizeTimelineRegion(regions[i]);
      if (!region) continue;
      var key = timelineRegionKey(region);
      if (provider.timelineRegionKeys[key]) continue;
      provider.timelineRegionKeys[key] = true;
      provider.timelineRegions.push(region);
      provider.lastTimelineRegion = region;
      if (provider.engine && provider.engine._player) provider.engine._player.emit('timelineregionadded', region);
    }
  }

  function normalizeTimelineRegion(region) {
    if (!region) return null;
    var start = Number(region.startTime);
    if (!isFinite(start)) start = 0;
    var end = Number(region.endTime);
    if (!isFinite(end) || end < start) end = start;
    return {
      id: region.id || '',
      schemeIdUri: region.schemeIdUri || '',
      value: region.value || '',
      startTime: start,
      endTime: end,
      eventElement: region.eventElement || '',
      customAttributes: region.customAttributes || {},
      source: region.source || ''
    };
  }

  function timelineRegionKey(region) {
    return [region.source, region.schemeIdUri, region.value, region.id, region.startTime, region.endTime].join('|');
  }

  function hlsRegionsForDateRanges(dateRanges, segments) {
    var regions = [];
    var origin = hlsProgramDateOrigin(segments || []);
    for (var i = 0; i < (dateRanges || []).length; i++) {
      var item = dateRanges[i];
      var start = origin ? origin.time + ((item.startDateMs - origin.ms) / 1000) : ((segments && segments[0] && segments[0].start) || 0);
      var end = isFinite(item.endDateMs) && origin
        ? origin.time + ((item.endDateMs - origin.ms) / 1000)
        : start + (item.duration || item.plannedDuration || 0);
      regions.push({
        id: item.id,
        schemeIdUri: 'urn:ietf:rfc:8216:ext-x-daterange',
        value: item.class || '',
        startTime: start,
        endTime: end,
        eventElement: item.startDate || '',
        customAttributes: item.customAttributes || {},
        source: 'hls-daterange'
      });
    }
    return regions;
  }

  function hlsChapterSessionData(sessionData) {
    var refs = [];
    for (var i = 0; i < (sessionData || []).length; i++) {
      var item = sessionData[i] || {};
      if (String(item.dataId || '').toLowerCase() !== 'com.apple.hls.chapters') continue;
      refs.push(item);
    }
    return refs;
  }

  function parseHlsChapterRegions(text, ref) {
    var parsed = JSON.parse(String(text || '[]'));
    var chapters = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.chapters) ? parsed.chapters : []);
    var regions = [];
    for (var i = 0; i < chapters.length; i++) {
      var chapter = chapters[i] || {};
      var start = Number(chapter.startTime != null ? chapter.startTime : (chapter.start != null ? chapter.start : chapter.time));
      var end = Number(chapter.endTime != null ? chapter.endTime : chapter.end);
      var chapterDuration = Number(chapter.duration);
      if (!isFinite(start)) continue;
      if (!isFinite(end)) end = isFinite(chapterDuration) ? start + chapterDuration : start;
      regions.push({
        id: String(chapter.id || chapter.title || ('chapter-' + i)),
        schemeIdUri: 'com.apple.hls.chapters',
        value: chapter.title || chapter.name || '',
        startTime: start,
        endTime: end,
        eventElement: chapter.title || chapter.name || '',
        customAttributes: {
          language: (ref && ref.language) || chapter.language || '',
          uri: (ref && ref.uri) || '',
          image: chapter.image || chapter.uri || ''
        },
        source: 'hls-session-data'
      });
    }
    return regions;
  }

  function parseDashCeaTextTracks(set, repNode, rep) {
    var nodes = directChildren(set, 'Accessibility').concat(directChildren(repNode, 'Accessibility'));
    var tracks = [];
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      var scheme = String(node.getAttribute('schemeIdUri') || '').toLowerCase();
      var value = node.getAttribute('value') || node.textContent.trim() || '';
      var isCea608 = scheme.indexOf('cea-608') !== -1 || /^cc\d/i.test(value);
      var isCea708 = scheme.indexOf('cea-708') !== -1 || /^service\d/i.test(value);
      if (!isCea608 && !isCea708) continue;
      var parts = value ? value.split(/[;,]/) : [isCea608 ? 'CC1' : 'SERVICE1'];
      for (var p = 0; p < parts.length; p++) {
        var part = parts[p].trim();
        if (!part) continue;
        var split = part.split('=');
        var instreamId = split[0].trim();
        var language = (split[1] || rep.language || '').trim();
        tracks.push({
          id: 'cea:' + (rep.id || 'rep') + ':' + instreamId,
          kind: 'text',
          mimeType: isCea708 ? 'application/cea-708' : 'application/cea-608',
          language: language,
          label: language || instreamId,
          roles: ['caption'],
          accessibility: [node.getAttribute('schemeIdUri') || value],
          source: 'native-dash-cea',
          embedded: true,
          instreamId: instreamId,
          supported: false,
          renderSupported: false,
          loadState: 'embedded'
        });
      }
    }
    return tracks;
  }

  function hlsProgramDateOrigin(segments) {
    for (var i = 0; i < segments.length; i++) {
      if (isFinite(segments[i].programDateTimeMs)) return { ms: segments[i].programDateTimeMs, time: segments[i].start || 0 };
    }
    return null;
  }

  function manifestStartTimeFor(startInfo, range, duration) {
    if (!startInfo || !range) return null;
    var offset = Number(startInfo.timeOffset);
    if (!isFinite(offset)) return null;
    var start = offset >= 0 ? range.start + offset : range.end + offset;
    if (!isFinite(start) && isFinite(duration)) start = offset >= 0 ? offset : duration + offset;
    if (!isFinite(start)) return null;
    return clamp(start, range.start || 0, range.end || Math.max(0, duration || 0));
  }

  function seekToStartTime(engine, startTime) {
    var target = Number(startTime);
    if (!isFinite(target) || target < 0) return Promise.resolve();
    try {
      var range = engine._player && engine._player.seekRange ? engine._player.seekRange() : mediaSeekRange(engine.video);
      if (range && range.end >= range.start) {
        target = clamp(target, range.start, range.end);
      }
      engine.video.currentTime = target;
    } catch (e) {}
    return Promise.resolve();
  }

  function mediaSeekRange(video) {
    if (!video) return { start: 0, end: 0 };
    var duration = Number(video.duration);
    if (isFinite(duration) && duration > 0) return { start: 0, end: duration };
    try {
      if (video.seekable && video.seekable.length) {
        return {
          start: video.seekable.start(0),
          end: video.seekable.end(video.seekable.length - 1)
        };
      }
    } catch (e) {}
    return { start: 0, end: 0 };
  }

  function clearMediaElement(video) {
    if (!video) return;
    try { video.pause(); } catch (e) {}
    try { video.removeAttribute('src'); } catch (e) {}
    try { video.load(); } catch (e) {}
  }

  function getBufferedInfoFor(video, audioSb, videoSb) {
    var total = bufferedRanges(video && video.buffered);
    var audio = audioSb ? bufferedRanges(audioSb.buffered) : total.slice();
    var videoRanges = videoSb ? bufferedRanges(videoSb.buffered) : total.slice();
    return {
      total: total,
      audio: audio,
      video: videoRanges,
      text: []
    };
  }

  function bufferedRanges(timeRanges) {
    var ranges = [];
    if (!timeRanges) return ranges;
    try {
      for (var i = 0; i < timeRanges.length; i++) {
        var start = timeRanges.start(i);
        var end = timeRanges.end(i);
        if (!isFinite(start) || !isFinite(end) || end <= start) continue;
        ranges.push({ start: start, end: end });
      }
    } catch (e) {}
    ranges.sort(function (a, b) { return a.start - b.start; });
    return mergeBufferedRanges(ranges);
  }

  function mergeBufferedRanges(ranges) {
    var merged = [];
    for (var i = 0; i < ranges.length; i++) {
      var range = ranges[i];
      var last = merged[merged.length - 1];
      if (last && range.start <= last.end + 0.05) {
        last.end = Math.max(last.end, range.end);
      } else {
        merged.push({ start: range.start, end: range.end });
      }
    }
    return merged;
  }

  function summarizeBufferedInfo(info) {
    var ranges = info && info.total ? info.total : [];
    if (!ranges.length) return { count: 0, start: 0, end: 0 };
    return {
      count: ranges.length,
      start: ranges[0].start,
      end: ranges[ranges.length - 1].end
    };
  }

  function getBufferAhead(video) {
    var buf = video.buffered;
    var ct = video.currentTime || 0;
    for (var i = 0; i < buf.length; i++) {
      if (ct >= buf.start(i) - 0.5 && ct <= buf.end(i)) return buf.end(i) - ct;
    }
    return 0;
  }

  function bufferedContains(ranges, time) {
    if (!ranges || !isFinite(time)) return false;
    try {
      for (var i = 0; i < ranges.length; i++) {
        if (time >= ranges.start(i) - 0.05 && time <= ranges.end(i) - 0.05) return true;
      }
    } catch (e) {}
    return false;
  }

  function segmentBuffered(video, seg) {
    if (!video || !video.buffered || !seg || !isFinite(seg.start) || !isFinite(seg.end)) return false;
    var probe = Math.max(seg.start, seg.end - 0.1);
    return bufferedContains(video.buffered, probe);
  }

  function playableRangeAround(video) {
    var buf = video.buffered;
    var ct = video.currentTime || 0;
    for (var i = 0; i < buf.length; i++) {
      if (ct >= buf.start(i) - 0.5 && ct <= buf.end(i) + 0.05) {
        return { start: buf.start(i), end: buf.end(i) };
      }
    }
    return null;
  }

  function nextBufferedGap(video) {
    var buf = video.buffered;
    var ct = video.currentTime || 0;
    for (var i = 0; i < buf.length; i++) {
      var start = buf.start(i);
      var end = buf.end(i);
      if (ct >= start - 0.05 && ct <= end) return null;
      if (start > ct) {
        return { start: start, size: start - ct };
      }
    }
    return null;
  }

  function markSegmentsUnappended(rep) {
    if (!rep || !rep.segments) return;
    for (var i = 0; i < rep.segments.length; i++) {
      rep.segments[i].appended = false;
      rep.segments[i].state = 'pending';
    }
  }

  function markSegmentsForTime(rep, time, ahead) {
    if (!rep || !rep.segments) return;
    for (var i = 0; i < rep.segments.length; i++) {
      var seg = rep.segments[i];
      if (seg.end < time - 1 || seg.start > time + ahead) {
        seg.appended = false;
        seg.state = 'pending';
        resetHlsPartState(seg);
      } else if (seg.state === 'failed') {
        seg.state = 'pending';
        seg.appended = false;
        resetHlsPartState(seg);
      } else if (!seg.appended && (!seg.state || seg.state === 'idle')) {
        seg.state = 'pending';
      }
    }
  }

  function isSegmentBusyOrDone(seg) {
    return seg.appended || seg.state === 'fetching' || seg.state === 'fetched' || seg.state === 'appending' || seg.state === 'appended';
  }

  function segmentsAppendedThroughEnd(segments, duration) {
    if (!segments || !segments.length) return false;
    var expectedEnd = isFinite(duration) && duration > 0 ? duration : segments[segments.length - 1].end;
    var appendedEnd = 0;
    for (var i = 0; i < segments.length; i++) {
      var seg = segments[i];
      if (seg.end < 0.05) continue;
      if (!seg.appended && seg.state !== 'appended') return false;
      appendedEnd = Math.max(appendedEnd, seg.end || 0);
    }
    return appendedEnd >= expectedEnd - 0.25;
  }

  function segmentPriority(seg, currentTime, readyGoal) {
    if (currentTime >= seg.start - 0.05 && currentTime < seg.end + 0.05) return 0;
    if (seg.start < currentTime + readyGoal) return 1;
    return 2 + Math.max(0, seg.start - currentTime);
  }

  function nextFetchedSegmentForAppend(rep, currentTime) {
    if (!rep || !rep.segments) return null;
    var fetched = rep.segments.filter(function (seg) {
      return seg.state === 'fetched' && seg._data && seg.end > currentTime - 0.5;
    }).sort(function (a, b) {
      return a.start - b.start;
    });
    for (var i = 0; i < fetched.length; i++) {
      if (!hasEarlierFetchedOrFetching(rep, fetched[i], currentTime)) return fetched[i];
    }
    return null;
  }

  function hasEarlierFetchedOrFetching(rep, seg, currentTime) {
    var now = performance.now();
    for (var i = 0; i < rep.segments.length; i++) {
      var other = rep.segments[i];
      if (other === seg || other.state === 'expired' || other.end <= currentTime - 0.5 || other.start >= seg.start) continue;
      if (other.state === 'fetching' || other.state === 'appending') {
        var startedAt = other.state === 'fetching' ? other._fetchStartedAt : other._appendStartedAt;
        if (startedAt && now - startedAt > SEGMENT_BUSY_WATCHDOG_MS) {
          other.state = 'pending';
          other.appended = false;
          delete other._data;
          delete other._fetchStartedAt;
          delete other._appendStartedAt;
          continue;
        }
        return true;
      }
      if (other.state === 'fetched') return true;
    }
    return false;
  }

  function resetActiveSegmentRequests(rep) {
    if (!rep || !rep.segments) return;
    rep._appending = false;
    for (var i = 0; i < rep.segments.length; i++) {
      var seg = rep.segments[i];
      if (seg.state === 'fetching' || seg.state === 'fetched' || seg.state === 'appending') {
        seg.state = 'pending';
        seg.appended = false;
        delete seg._data;
        delete seg._fetchStartedAt;
      }
      resetActiveHlsPartRequests(seg);
    }
  }

  function resetHlsPartState(seg) {
    if (!seg || !seg.parts) return;
    for (var i = 0; i < seg.parts.length; i++) {
      seg.parts[i].appended = false;
      seg.parts[i].state = 'pending';
      delete seg.parts[i]._data;
      delete seg.parts[i]._fetchStartedAt;
    }
  }

  function resetActiveHlsPartRequests(seg) {
    if (!seg || !seg.parts) return;
    for (var i = 0; i < seg.parts.length; i++) {
      var part = seg.parts[i];
      if (part.state === 'fetching' || part.state === 'fetched' || part.state === 'appending') {
        part.state = 'pending';
        part.appended = false;
        delete part._data;
        delete part._fetchStartedAt;
      }
    }
  }

  function pendingSegments(rep) {
    if (!rep || !rep.segments) return 0;
    var count = 0;
    for (var i = 0; i < rep.segments.length; i++) {
      if (rep.segments[i].state !== 'expired' && !isSegmentBusyOrDone(rep.segments[i])) count++;
    }
    return count;
  }

  function fetchedSegments(rep) {
    if (!rep || !rep.segments) return 0;
    var count = 0;
    for (var i = 0; i < rep.segments.length; i++) {
      if (rep.segments[i].state === 'fetched') count++;
    }
    return count;
  }

  function countKeys(obj) {
    var count = 0;
    for (var key in (obj || {})) {
      if (obj.hasOwnProperty(key)) count++;
    }
    return count;
  }

  function mergeLiveReps(existing, fresh) {
    var byId = {};
    for (var i = 0; i < fresh.length; i++) byId[fresh[i].id] = fresh[i];
    for (var j = 0; j < existing.length; j++) {
      var next = byId[existing[j].id];
      if (!next || !next.templateSegments) continue;
      mergeRepMetadata(existing[j], next);
      var oldByKey = {};
      var oldSegments = existing[j].segments || existing[j].templateSegments || [];
      for (var k = 0; k < oldSegments.length; k++) oldByKey[segmentKey(oldSegments[k])] = oldSegments[k];
      var merged = next.templateSegments.map(function (seg) {
        var old = oldByKey[segmentKey(seg)];
        if (old) {
          seg.appended = old.appended;
          seg.state = old.state;
        }
        return seg;
      });
      existing[j].templateSegments = merged;
      existing[j].segments = merged;
    }
  }

  function mergeStaticReps(existing, fresh) {
    var byId = {};
    for (var i = 0; i < fresh.length; i++) byId[fresh[i].id] = fresh[i];
    for (var j = 0; j < existing.length; j++) {
      var current = existing[j];
      var next = byId[current.id];
      if (!next || current.mimeType !== next.mimeType || current.codecs !== next.codecs) continue;
      mergeRepMetadata(current, next);
      current.baseUrl = next.baseUrl || current.baseUrl;
      current.initUrl = next.initUrl || current.initUrl;
      current.initRange = next.initRange || current.initRange;
      current.indexRange = next.indexRange || current.indexRange;
      current.templateSegments = mergeSegmentState(current.templateSegments || current.segments, next.templateSegments || next.segments);
      if (next.templateSegments) current.segments = current.templateSegments;
      else if (next.segments) current.segments = mergeSegmentState(current.segments, next.segments);
    }
  }

  function mergeSegmentState(oldSegments, freshSegments) {
    if (!freshSegments || !freshSegments.length) return oldSegments || freshSegments;
    var oldByKey = {};
    oldSegments = oldSegments || [];
    for (var i = 0; i < oldSegments.length; i++) oldByKey[segmentKey(oldSegments[i])] = oldSegments[i];
    return freshSegments.map(function (seg) {
      var old = oldByKey[segmentKey(seg)];
      if (old) {
        if (old.state === 'fetching' || old.state === 'fetched' || old.state === 'appending') {
          old.start = seg.start;
          old.end = seg.end;
          old.duration = seg.duration;
          old.mediaSequence = seg.mediaSequence;
          old.discontinuity = seg.discontinuity;
          old.discontinuitySequence = seg.discontinuitySequence;
          old.url = seg.url;
          old.range = seg.range;
          old.parts = seg.parts || old.parts;
          old.key = seg.key || old.key;
          if (isFinite(seg.programDateTimeMs)) old.programDateTimeMs = seg.programDateTimeMs;
          mergeHlsPartState(old, seg);
          return old;
        }
        seg.appended = old.appended;
        if (old.state === 'fetched' && old._data) {
          seg.state = old.state;
          seg._data = old._data;
        } else {
          seg.state = old.state === 'failed' || old.state === 'recovering' || old.state === 'fetching' || old.state === 'fetched' ? '' : old.state;
        }
        mergeHlsPartState(old, seg);
      }
      return seg;
    });
  }

  function mergeHlsPartState(oldSeg, freshSeg) {
    if (!oldSeg || !freshSeg || !oldSeg.parts || !freshSeg.parts) return;
    var oldByKey = {};
    for (var i = 0; i < oldSeg.parts.length; i++) oldByKey[segmentKey(oldSeg.parts[i])] = oldSeg.parts[i];
    for (var j = 0; j < freshSeg.parts.length; j++) {
      var old = oldByKey[segmentKey(freshSeg.parts[j])];
      if (!old) continue;
      freshSeg.parts[j].appended = old.appended;
      freshSeg.parts[j].state = old.state === 'recovering' || old.state === 'fetching' ? '' : old.state;
    }
  }

  function normalizeHlsParts(parts, segment) {
    var out = [];
    var t = segment.start || 0;
    for (var i = 0; i < parts.length; i++) {
      var part = parts[i];
      var duration = part.duration || 0;
      part.start = t;
      part.end = t + duration;
      part.mediaSequence = segment.mediaSequence;
      part.partIndex = i;
      part.discontinuity = !!(segment.discontinuity && i === 0);
      part.discontinuitySequence = segment.discontinuitySequence || 0;
      part.key = segment.key || null;
      part._hlsPart = true;
      part._parentSegment = segment;
      if (!part.range && segment.range) part.range = null;
      out.push(part);
      t += duration;
    }
    return out;
  }

  function hlsPlayableSegments(provider, track, segments) {
    if (!segments || !segments.length) return segments || [];
    if (!provider || !provider.live || !track || track.isTsPlaylist || provider.isTsPlaylist && track.kind === 'video') return segments;
    var lowLatency = track.lowLatencyPlaylist || provider.lowLatencyPlaylist;
    if (!lowLatency) return segments;
    var out = [];
    var ct = provider.video && isFinite(provider.video.currentTime) ? provider.video.currentTime : 0;
    var liveEnd = provider.liveWindow ? provider.liveWindow.end : 0;
    var nearLiveEdge = liveEnd && liveEnd - ct <= Math.max(LIVE_TARGET_LATENCY + 2, provider._bufferAheadGoal ? provider._bufferAheadGoal() : BUFFER_AHEAD);
    for (var i = 0; i < segments.length; i++) {
      var seg = segments[i];
      var parts = seg.parts || [];
      var usableParts = lowLatency && parts.length && nearLiveEdge && firstUsableHlsPart(parts);
      if (usableParts && !seg.appended && seg.state !== 'appended') {
        var failedPart = parts.some(function (part) { return part.state === 'failed'; });
        if (!failedPart) {
          for (var p = 0; p < parts.length; p++) out.push(parts[p]);
          continue;
        }
      }
      out.push(seg);
    }
    appendHlsPreloadHint(provider, track, out);
    return out;
  }

  function firstUsableHlsPart(parts) {
    if (!parts || !parts.length) return false;
    return !!parts[0].independent;
  }

  function appendHlsPreloadHint(provider, track, out) {
    if (!provider || !track || track.kind !== 'video' || !provider.live || !provider.lowLatencyPlaylist) return;
    if (!provider.serverControl || !provider.serverControl.canBlockReload) return;
    if (provider.isTsPlaylist || getBufferAhead(provider.video) >= Math.min(1, provider._startupBufferGoal ? provider._startupBufferGoal() : 1)) return;
    var hints = provider.preloadHints || [];
    for (var i = 0; i < hints.length; i++) {
      var hint = hints[i];
      if (String(hint.type || '').toUpperCase() !== 'PART' || !hint.url) continue;
      var length = isFinite(hint.byteRangeLength) ? hint.byteRangeLength : NaN;
      var start = isFinite(hint.byteRangeStart) ? hint.byteRangeStart : NaN;
      var range = isFinite(start) && isFinite(length) && length > 0 ? { start: start, end: start + length - 1 } : null;
      provider._preloadHintSegment = provider._preloadHintSegment || {};
      var key = hint.url + (range ? ':' + range.start + '-' + range.end : '');
      var seg = provider._preloadHintSegment[key];
      if (!seg) {
        var liveEnd = provider.liveWindow ? provider.liveWindow.end : 0;
        var duration = provider.partTargetDuration || 0.25;
        seg = provider._preloadHintSegment[key] = {
          start: liveEnd,
          end: liveEnd + duration,
          duration: duration,
          mediaSequence: provider.mediaSequence + (provider.segments ? provider.segments.length : 0),
          discontinuitySequence: provider.discontinuitySequence || 0,
          url: hint.url,
          range: range,
          _hlsPreloadHint: true,
          _hlsPart: true
        };
      }
      if (!isSegmentBusyOrDone(seg) && seg.state !== 'failed') out.push(seg);
      break;
    }
  }

  function createTsTransmuxerAdapter(contentType, codecs) {
    var factory = window.__nativeTsTransmuxerFactory;
    if (typeof factory === 'function') {
      return Promise.resolve(factory({
        codecs: codecs,
        contentType: contentType,
        mimeType: 'video/mp2t; codecs="' + codecs + '"'
      })).then(function (adapter) {
        return normalizeTsTransmuxerAdapter(adapter);
      });
    }
    if (window.__enableFirstPartyTsTransmuxer) return Promise.resolve(new FirstPartyTsTransmuxerAdapter(contentType, codecs));
    if (firstPartyTsTransmuxerSupported(contentType, codecs)) return Promise.resolve(new FirstPartyTsTransmuxerAdapter(contentType, codecs));
    return Promise.reject(new Error('hls-first-party-ts-transmuxer-unavailable'));
  }

  function firstPartyTsTransmuxerSupported(contentType, codecs) {
    var normalized = String(codecs || '').toLowerCase();
    if (contentType === 'audio') return /^mp4a(\.|$)/.test(normalized);
    return /^(avc1|avc3)(\.|$)/.test(normalized);
  }

  function normalizeTsTransmuxerAdapter(adapter) {
    if (!adapter || typeof adapter.transmux !== 'function') throw new Error('hls-first-party-ts-transmuxer-invalid');
    if (!adapter.provider) adapter.provider = 'first-party-ts';
    return adapter;
  }

  function FirstPartyTsTransmuxerAdapter(contentType, codecs) {
    this.provider = 'first-party-ts';
    this.contentType = contentType;
    this.codecs = codecs;
    this.lastDemux = null;
    this.sequenceNumber = 1;
  }

  FirstPartyTsTransmuxerAdapter.prototype.transmux = function (data, context) {
    this.lastDemux = demuxMpegTs(data);
    if (this.contentType === 'video') {
      return Promise.resolve(remuxH264ToFragmentedMp4(this.lastDemux, {
        codecs: this.codecs,
        height: context && context.activeVariant ? context.activeVariant.height : 0,
        sequenceNumber: this.sequenceNumber++,
        width: context && context.activeVariant ? context.activeVariant.width : 0
      }));
    }
    if (this.contentType === 'audio') {
      return Promise.resolve(remuxAacToFragmentedMp4(this.lastDemux, {
        codecs: this.codecs,
        sequenceNumber: this.sequenceNumber++
      }));
    }
    return Promise.reject(new Error('hls-first-party-ts-remuxer-unavailable'));
  };

  function normalizeTransmuxOutput(output) {
    if (output && output.data) return output;
    return { data: output, init: null };
  }

  function remuxH264ToFragmentedMp4(demux, options) {
    var track = firstTrackOfType(demux, 'video');
    if (!track || !track.pes.length) throw new Error('hls-first-party-ts-no-video');
    var samples = h264SamplesFromPes(track.pes);
    if (!samples.length) throw new Error('hls-first-party-ts-no-video-samples');
    var sps = null;
    var pps = null;
    for (var i = 0; i < samples.length; i++) {
      for (var j = 0; j < samples[i].nalUnits.length; j++) {
        var nal = samples[i].nalUnits[j];
        if (nal.type === 7 && !sps) sps = nal.data;
        if (nal.type === 8 && !pps) pps = nal.data;
      }
    }
    if (!sps || !pps) throw new Error('hls-first-party-ts-missing-avc-config');
    var width = options.width || 0;
    var height = options.height || 0;
    var timescale = 90000;
    var init = concatUint8Arrays([
      mp4Box('ftyp', mp4String('iso6'), mp4Uint32(1), mp4String('iso6'), mp4String('mp41')),
      mp4Moov({
        duration: 0,
        height: height,
        id: 1,
        pps: pps,
        sps: sps,
        timescale: timescale,
        width: width
      })
    ]);
    return {
      init: init.buffer,
      data: mp4VideoFragment({
        baseDecodeTime: 0,
        samples: samples,
        sequenceNumber: options.sequenceNumber || 1,
        timescale: timescale,
        trackId: 1
      }).buffer
    };
  }

  function firstTrackOfType(demux, type) {
    var tracks = demux && demux.tracks ? demux.tracks : [];
    for (var i = 0; i < tracks.length; i++) {
      if (tracks[i].type === type) return tracks[i];
    }
    return null;
  }

  function h264SamplesFromPes(pesList) {
    var samples = [];
    for (var i = 0; i < pesList.length; i++) {
      var pes = pesList[i];
      var units = h264NalUnits(pes.data).filter(function (nal) { return nal.type !== 9; });
      if (!units.length) continue;
      var dataParts = [];
      var size = 0;
      var keyframe = false;
      for (var j = 0; j < units.length; j++) {
        var unit = units[j].data;
        dataParts.push(mp4Uint32(unit.length), unit);
        size += 4 + unit.length;
        if (units[j].type === 5) keyframe = true;
      }
      samples.push({
        data: concatUint8Arrays(dataParts),
        dts: pes.dts === null ? pes.pts : pes.dts,
        duration: 0,
        keyframe: keyframe,
        nalUnits: units,
        pts: pes.pts,
        size: size
      });
    }
    for (var k = 0; k < samples.length; k++) {
      if (k + 1 < samples.length && samples[k].dts !== null && samples[k + 1].dts !== null) samples[k].duration = Math.max(1, Math.round((samples[k + 1].dts - samples[k].dts) * 90000));
      else samples[k].duration = k > 0 ? samples[k - 1].duration : 90000;
    }
    return samples;
  }

  function remuxAacToFragmentedMp4(demux, options) {
    var track = firstTrackOfType(demux, 'audio');
    if (!track || !track.pes.length) throw new Error('hls-first-party-ts-no-audio');
    var samples = aacSamplesFromPes(track.pes);
    if (!samples.length) throw new Error('hls-first-party-ts-no-audio-samples');
    var config = samples[0].config;
    var init = concatUint8Arrays([
      mp4Box('ftyp', mp4String('iso6'), mp4Uint32(1), mp4String('iso6'), mp4String('mp41')),
      mp4Moov({
        channelCount: config.channelConfig || 2,
        codecs: options.codecs || 'mp4a.40.2',
        duration: 0,
        id: 1,
        sampleRate: config.sampleRate || 44100,
        sampleRateIndex: config.sampleRateIndex,
        timescale: config.sampleRate || 44100,
        type: 'audio'
      })
    ]);
    return {
      init: init.buffer,
      data: mp4AudioFragment({
        baseDecodeTime: 0,
        samples: samples,
        sequenceNumber: options.sequenceNumber || 1,
        timescale: config.sampleRate || 44100,
        trackId: 1
      }).buffer
    };
  }

  function aacSamplesFromPes(pesList) {
    var samples = [];
    for (var i = 0; i < pesList.length; i++) {
      var pes = pesList[i];
      var frames = pes.adtsFrames || parseAdtsFrames(pes.data);
      if (!frames.length) continue;
      for (var j = 0; j < frames.length; j++) {
        var frame = frames[j];
        var payload = pes.data.subarray(frame.payloadOffset, frame.offset + frame.length);
        samples.push({
          config: frame,
          data: payload,
          dts: pes.dts === null ? pes.pts : pes.dts,
          duration: 1024,
          keyframe: true,
          pts: pes.pts,
          size: payload.length
        });
      }
    }
    return samples;
  }

  function mp4VideoFragment(info) {
    var mdatPayload = concatUint8Arrays(info.samples.map(function (sample) { return sample.data; }));
    var moof = mp4Moof(info, 0);
    moof = mp4Moof(info, moof.length + 8);
    return concatUint8Arrays([moof, mp4Box('mdat', mdatPayload)]);
  }

  function mp4AudioFragment(info) {
    var mdatPayload = concatUint8Arrays(info.samples.map(function (sample) { return sample.data; }));
    var moof = mp4Moof(info, 0);
    moof = mp4Moof(info, moof.length + 8);
    return concatUint8Arrays([moof, mp4Box('mdat', mdatPayload)]);
  }

  function mp4Moof(info, dataOffset) {
    return mp4Box('moof',
      mp4FullBox('mfhd', 0, 0, mp4Uint32(info.sequenceNumber)),
      mp4Box('traf',
        mp4FullBox('tfhd', 0, 0x020000, mp4Uint32(info.trackId)),
        mp4FullBox('tfdt', 1, 0, mp4Uint64(info.baseDecodeTime)),
        mp4Trun(info.samples, dataOffset)
      )
    );
  }

  function mp4Trun(samples, dataOffset) {
    var parts = [mp4Uint32(samples.length), mp4Uint32(dataOffset)];
    for (var i = 0; i < samples.length; i++) {
      var sample = samples[i];
      parts.push(
        mp4Uint32(sample.duration || 90000),
        mp4Uint32(sample.size),
        mp4Uint32(sample.keyframe ? 0x02000000 : 0x01010000)
      );
    }
    return mp4FullBox.apply(null, ['trun', 0, 0x000701].concat(parts));
  }

  function mp4Moov(track) {
    return mp4Box('moov',
      mp4Mvhd(track.timescale, track.duration),
      mp4Trak(track),
      mp4Box('mvex', mp4FullBox('trex', 0, 0, mp4Uint32(track.id), mp4Uint32(1), mp4Uint32(0), mp4Uint32(0), mp4Uint32(0)))
    );
  }

  function mp4Mvhd(timescale, duration) {
    return mp4FullBox('mvhd', 0, 0,
      mp4Uint32(0), mp4Uint32(0), mp4Uint32(timescale), mp4Uint32(duration),
      mp4Uint32(0x00010000), mp4Uint16(0x0100), mp4Uint16(0), mp4Uint32(0), mp4Uint32(0),
      mp4Uint32(0x00010000), mp4Uint32(0), mp4Uint32(0), mp4Uint32(0),
      mp4Uint32(0x00010000), mp4Uint32(0), mp4Uint32(0), mp4Uint32(0),
      mp4Uint32(0x40000000), mp4Uint32(0), mp4Uint32(0), mp4Uint32(0),
      mp4Uint32(0), mp4Uint32(0), mp4Uint32(0), mp4Uint32(2)
    );
  }

  function mp4Trak(track) {
    var isAudio = track.type === 'audio';
    return mp4Box('trak',
      mp4Tkhd(track),
      mp4Box('mdia',
        mp4FullBox('mdhd', 0, 0, mp4Uint32(0), mp4Uint32(0), mp4Uint32(track.timescale), mp4Uint32(track.duration), mp4Uint16(0x55c4), mp4Uint16(0)),
        mp4FullBox('hdlr', 0, 0, mp4Uint32(0), mp4String(isAudio ? 'soun' : 'vide'), mp4Uint32(0), mp4Uint32(0), mp4Uint32(0), mp4String(isAudio ? 'SoundHandler' : 'VideoHandler'), new Uint8Array([0])),
        mp4Box('minf',
          isAudio ? mp4FullBox('smhd', 0, 0, mp4Uint16(0), mp4Uint16(0)) : mp4FullBox('vmhd', 0, 1, mp4Uint16(0), mp4Uint16(0), mp4Uint16(0), mp4Uint16(0)),
          mp4Dinf(),
          mp4Stbl(track)
        )
      )
    );
  }

  function mp4Tkhd(track) {
    return mp4FullBox('tkhd', 0, 0x000007,
      mp4Uint32(0), mp4Uint32(0), mp4Uint32(track.id), mp4Uint32(0), mp4Uint32(track.duration),
      mp4Uint32(0), mp4Uint32(0), mp4Uint16(0), mp4Uint16(0), mp4Uint16(0), mp4Uint16(0),
      mp4Uint32(0x00010000), mp4Uint32(0), mp4Uint32(0), mp4Uint32(0),
      mp4Uint32(0x00010000), mp4Uint32(0), mp4Uint32(0), mp4Uint32(0),
      mp4Uint32(0x40000000), mp4Uint32((track.width || 0) << 16), mp4Uint32((track.height || 0) << 16)
    );
  }

  function mp4Dinf() {
    return mp4Box('dinf', mp4FullBox('dref', 0, 0, mp4Uint32(1), mp4FullBox('url ', 0, 1)));
  }

  function mp4Stbl(track) {
    return mp4Box('stbl',
      mp4Box('stsd', mp4Uint32(0), mp4Uint32(1), track.type === 'audio' ? mp4Mp4a(track) : mp4Avc1(track)),
      mp4FullBox('stts', 0, 0, mp4Uint32(0)),
      mp4FullBox('stsc', 0, 0, mp4Uint32(0)),
      mp4FullBox('stsz', 0, 0, mp4Uint32(0), mp4Uint32(0)),
      mp4FullBox('stco', 0, 0, mp4Uint32(0))
    );
  }

  function mp4Avc1(track) {
    var sampleEntryHeader = concatUint8Arrays([
      new Uint8Array(6), mp4Uint16(1), new Uint8Array(16), mp4Uint16(track.width || 0), mp4Uint16(track.height || 0),
      mp4Uint32(0x00480000), mp4Uint32(0x00480000), mp4Uint32(0), mp4Uint16(1), new Uint8Array(32),
      mp4Uint16(0x0018), mp4Uint16(0xffff)
    ]);
    return mp4Box('avc1', sampleEntryHeader, mp4AvcC(track.sps, track.pps), mp4Box('btrt', mp4Uint32(0), mp4Uint32(0), mp4Uint32(0)));
  }

  function mp4AvcC(sps, pps) {
    return mp4Box('avcC', new Uint8Array([
      1, sps[1] || 0x42, sps[2] || 0, sps[3] || 0x1f, 0xff, 0xe1,
      (sps.length >> 8) & 0xff, sps.length & 0xff
    ]), sps, new Uint8Array([1, (pps.length >> 8) & 0xff, pps.length & 0xff]), pps);
  }

  function mp4Mp4a(track) {
    var sampleEntryHeader = concatUint8Arrays([
      new Uint8Array(6), mp4Uint16(1), mp4Uint32(0), mp4Uint32(0),
      mp4Uint16(track.channelCount || 2), mp4Uint16(16), mp4Uint16(0), mp4Uint16(0),
      mp4Uint32((track.sampleRate || 44100) << 16)
    ]);
    return mp4Box('mp4a', sampleEntryHeader, mp4Esds(track));
  }

  function mp4Esds(track) {
    var asc = audioSpecificConfig(track);
    return mp4FullBox('esds', 0, 0, new Uint8Array([
      0x03, 25, 0x00, 0x01, 0x00,
      0x04, 17, 0x40, 0x15, 0x00, 0x00, 0x00,
      0x00, 0x01, 0xf4, 0x00,
      0x00, 0x01, 0xf4, 0x00,
      0x05, 2, asc[0], asc[1],
      0x06, 1, 2
    ]));
  }

  function audioSpecificConfig(track) {
    var objectType = audioObjectTypeFromCodecs(track.codecs) || 2;
    var sampleRateIndex = track.sampleRateIndex == null ? 4 : track.sampleRateIndex;
    var channelConfig = track.channelCount || 2;
    return new Uint8Array([
      ((objectType & 0x1f) << 3) | ((sampleRateIndex >> 1) & 0x07),
      ((sampleRateIndex & 0x01) << 7) | ((channelConfig & 0x0f) << 3)
    ]);
  }

  function audioObjectTypeFromCodecs(codecs) {
    var match = /mp4a\.40\.(\d+)/i.exec(codecs || '');
    return match ? Number(match[1]) : 0;
  }

  function mp4Box(type) {
    var payloads = Array.prototype.slice.call(arguments, 1).map(toUint8Array);
    var size = 8;
    for (var i = 0; i < payloads.length; i++) size += payloads[i].length;
    return concatUint8Arrays([mp4Uint32(size), mp4String(type)].concat(payloads));
  }

  function mp4FullBox(type, version, flags) {
    var header = new Uint8Array([version & 0xff, (flags >> 16) & 0xff, (flags >> 8) & 0xff, flags & 0xff]);
    return mp4Box.apply(null, [type, header].concat(Array.prototype.slice.call(arguments, 3)));
  }

  function mp4String(value) {
    var out = new Uint8Array(value.length);
    for (var i = 0; i < value.length; i++) out[i] = value.charCodeAt(i) & 0xff;
    return out;
  }

  function mp4Uint16(value) {
    var out = new Uint8Array(2);
    out[0] = (value >> 8) & 0xff;
    out[1] = value & 0xff;
    return out;
  }

  function mp4Uint32(value) {
    var out = new Uint8Array(4);
    value = value >>> 0;
    out[0] = (value >>> 24) & 0xff;
    out[1] = (value >>> 16) & 0xff;
    out[2] = (value >>> 8) & 0xff;
    out[3] = value & 0xff;
    return out;
  }

  function mp4Uint64(value) {
    var high = Math.floor(value / 4294967296);
    var low = value >>> 0;
    return concatUint8Arrays([mp4Uint32(high), mp4Uint32(low)]);
  }

  function demuxMpegTs(data) {
    var bytes = toUint8Array(data);
    var state = {
      pmtPid: -1,
      streams: {},
      pesByPid: {},
      tracks: {},
      packetCount: 0,
      invalidSyncCount: 0
    };
    for (var offset = 0; offset + 188 <= bytes.length; offset += 188) {
      if (bytes[offset] !== 0x47) {
        state.invalidSyncCount++;
        continue;
      }
      state.packetCount++;
      parseTsPacket(bytes, offset, state);
    }
    for (var pid in state.pesByPid) flushPes(pid, state);
    var tracks = [];
    for (var trackPid in state.tracks) tracks.push(state.tracks[trackPid]);
    tracks.sort(function (a, b) { return a.pid - b.pid; });
    return {
      packetCount: state.packetCount,
      invalidSyncCount: state.invalidSyncCount,
      pmtPid: state.pmtPid,
      tracks: tracks
    };
  }

  function parseTsPacket(bytes, offset, state) {
    var payloadUnitStart = !!(bytes[offset + 1] & 0x40);
    var pid = ((bytes[offset + 1] & 0x1f) << 8) | bytes[offset + 2];
    var adaptationFieldControl = (bytes[offset + 3] >> 4) & 0x03;
    var payloadOffset = offset + 4;
    if (adaptationFieldControl === 0 || adaptationFieldControl === 2) return;
    if (adaptationFieldControl === 3) payloadOffset += 1 + (bytes[payloadOffset] || 0);
    if (payloadOffset >= offset + 188) return;
    if (pid === 0) {
      parsePat(bytes, payloadOffset, offset + 188, payloadUnitStart, state);
      return;
    }
    if (pid === state.pmtPid) {
      parsePmt(bytes, payloadOffset, offset + 188, payloadUnitStart, state);
      return;
    }
    if (!state.streams[pid]) return;
    if (payloadUnitStart) flushPes(pid, state);
    var payload = bytes.subarray(payloadOffset, offset + 188);
    if (!state.pesByPid[pid]) state.pesByPid[pid] = [];
    state.pesByPid[pid].push(payload);
  }

  function parsePat(bytes, start, end, payloadUnitStart, state) {
    if (payloadUnitStart) start += (bytes[start] || 0) + 1;
    if (start + 12 > end || bytes[start] !== 0x00) return;
    var sectionLength = ((bytes[start + 1] & 0x0f) << 8) | bytes[start + 2];
    var sectionEnd = Math.min(end, start + 3 + sectionLength - 4);
    for (var pos = start + 8; pos + 4 <= sectionEnd; pos += 4) {
      var programNumber = (bytes[pos] << 8) | bytes[pos + 1];
      if (programNumber) state.pmtPid = ((bytes[pos + 2] & 0x1f) << 8) | bytes[pos + 3];
    }
  }

  function parsePmt(bytes, start, end, payloadUnitStart, state) {
    if (payloadUnitStart) start += (bytes[start] || 0) + 1;
    if (start + 12 > end || bytes[start] !== 0x02) return;
    var sectionLength = ((bytes[start + 1] & 0x0f) << 8) | bytes[start + 2];
    var sectionEnd = Math.min(end, start + 3 + sectionLength - 4);
    var programInfoLength = ((bytes[start + 10] & 0x0f) << 8) | bytes[start + 11];
    for (var pos = start + 12 + programInfoLength; pos + 5 <= sectionEnd;) {
      var streamType = bytes[pos];
      var pid = ((bytes[pos + 1] & 0x1f) << 8) | bytes[pos + 2];
      var esInfoLength = ((bytes[pos + 3] & 0x0f) << 8) | bytes[pos + 4];
      if (streamType === 0x1b) state.streams[pid] = { pid: pid, streamType: streamType, type: 'video' };
      else if (streamType === 0x0f) state.streams[pid] = { pid: pid, streamType: streamType, type: 'audio' };
      pos += 5 + esInfoLength;
    }
  }

  function flushPes(pid, state) {
    var chunks = state.pesByPid[pid];
    if (!chunks || !chunks.length) return;
    delete state.pesByPid[pid];
    var stream = state.streams[pid];
    if (!stream) return;
    var data = concatUint8Arrays(chunks);
    var pes = parsePes(data);
    if (!pes) return;
    var track = state.tracks[pid];
    if (!track) {
      track = state.tracks[pid] = {
        pid: Number(pid),
        streamType: stream.streamType,
        type: stream.type,
        pes: [],
        nalTypes: [],
        adtsFrames: 0
      };
    }
    if (stream.type === 'video') {
      pes.nalTypes = h264NalTypes(pes.data);
      mergeUniqueInPlace(track.nalTypes, pes.nalTypes);
    } else if (stream.type === 'audio') {
      pes.adtsFrames = parseAdtsFrames(pes.data);
      track.adtsFrames += pes.adtsFrames.length;
    }
    track.pes.push(pes);
  }

  function parsePes(data) {
    if (data.length < 9 || data[0] !== 0 || data[1] !== 0 || data[2] !== 1) return null;
    var flags = data[7] || 0;
    var headerLength = data[8] || 0;
    var payloadOffset = 9 + headerLength;
    var pts = null;
    var dts = null;
    if ((flags & 0x80) && data.length >= 14) pts = parsePts(data, 9);
    if ((flags & 0x40) && data.length >= 19) dts = parsePts(data, 14);
    return {
      streamId: data[3],
      pts: pts,
      dts: dts === null ? pts : dts,
      data: data.subarray(payloadOffset),
      dataLength: Math.max(0, data.length - payloadOffset)
    };
  }

  function parsePts(data, offset) {
    return (((data[offset] & 0x0e) * 536870912)
      + (data[offset + 1] * 4194304)
      + ((data[offset + 2] & 0xfe) * 16384)
      + (data[offset + 3] * 128)
      + ((data[offset + 4] & 0xfe) / 2)) / 90000;
  }

  function h264NalTypes(data) {
    var types = [];
    var units = h264NalUnits(data);
    for (var i = 0; i < units.length; i++) types.push(units[i].type);
    return types;
  }

  function h264NalUnits(data) {
    var units = [];
    var starts = h264StartCodes(data);
    for (var i = 0; i < starts.length; i++) {
      var start = starts[i].offset + starts[i].length;
      var end = i + 1 < starts.length ? starts[i + 1].offset : data.length;
      while (end > start && data[end - 1] === 0) end--;
      if (start < end) {
        units.push({
          data: data.subarray(start, end),
          type: data[start] & 0x1f
        });
      }
    }
    return units;
  }

  function h264StartCodes(data) {
    var starts = [];
    for (var i = 0; i + 3 < data.length; i++) {
      if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
        starts.push({ offset: i, length: 3 });
        i += 2;
      } else if (i + 4 < data.length && data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 0 && data[i + 3] === 1) {
        starts.push({ offset: i, length: 4 });
        i += 3;
      }
    }
    return starts;
  }

  function parseAdtsFrames(data) {
    var frames = [];
    var sampleRates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
    for (var i = 0; i + 7 <= data.length;) {
      if (data[i] !== 0xff || (data[i + 1] & 0xf0) !== 0xf0) {
        i++;
        continue;
      }
      var protectionAbsent = data[i + 1] & 1;
      var profile = ((data[i + 2] >> 6) & 0x03) + 1;
      var sampleRateIndex = (data[i + 2] >> 2) & 0x0f;
      var channelConfig = ((data[i + 2] & 1) << 2) | ((data[i + 3] >> 6) & 0x03);
      var frameLength = ((data[i + 3] & 0x03) << 11) | (data[i + 4] << 3) | ((data[i + 5] >> 5) & 0x07);
      if (frameLength < (protectionAbsent ? 7 : 9) || i + frameLength > data.length) break;
      var headerLength = protectionAbsent ? 7 : 9;
      frames.push({
        offset: i,
        length: frameLength,
        headerLength: headerLength,
        payloadOffset: i + headerLength,
        profile: profile,
        sampleRate: sampleRates[sampleRateIndex] || 44100,
        sampleRateIndex: sampleRateIndex,
        channelConfig: channelConfig
      });
      i += frameLength;
    }
    return frames;
  }

  function toUint8Array(data) {
    if (data instanceof Uint8Array) return data;
    return new Uint8Array(data || 0);
  }

  function concatUint8Arrays(chunks) {
    var length = 0;
    for (var i = 0; i < chunks.length; i++) length += chunks[i].length;
    var out = new Uint8Array(length);
    var offset = 0;
    for (var j = 0; j < chunks.length; j++) {
      out.set(chunks[j], offset);
      offset += chunks[j].length;
    }
    return out;
  }

  function mergeUniqueInPlace(target, source) {
    for (var i = 0; i < source.length; i++) {
      if (target.indexOf(source[i]) === -1) target.push(source[i]);
    }
  }

  function chooseIFrameTrack(provider, trackId) {
    var tracks = [];
    if (provider && provider.iframeVariants) tracks = tracks.concat(provider.iframeVariants);
    if (provider && provider.imageVariants) tracks = tracks.concat(provider.imageVariants);
    if (!tracks.length) return null;
    if (trackId) {
      var explicit = tracks.find(function (track) { return track.id === trackId; });
      if (explicit) return explicit;
    }
    var pathwayId = provider.contentSteeringPathwayId || (provider.activeVariant && provider.activeVariant.pathwayId) || '';
    var candidates = pathwayId ? tracks.filter(function (track) { return !track.pathwayId || track.pathwayId === pathwayId; }) : tracks.slice();
    if (!candidates.length) candidates = tracks.slice();
    candidates.sort(function (a, b) {
      var ah = a.height || 0;
      var bh = b.height || 0;
      if (ah !== bh) return bh - ah;
      return (b.bandwidth || 0) - (a.bandwidth || 0);
    });
    return candidates[0] || null;
  }

  function nearestIFrameSegment(segments, time) {
    if (!segments || !segments.length) return null;
    var best = null;
    for (var i = 0; i < segments.length; i++) {
      var seg = segments[i];
      if (seg.start <= time && (seg.end > time || !best)) best = seg;
      if (seg.start > time) return best || seg;
    }
    return best || segments[segments.length - 1];
  }

  function filterVariantsForContentSteering(provider, variants) {
    if (!variants || !variants.length || !provider || !provider.contentSteeringPathwayId) return variants || [];
    var steered = variants.filter(function (variant) { return variant.pathwayId === provider.contentSteeringPathwayId; });
    return steered.length ? steered : variants;
  }

  function mergeRepMetadata(current, next) {
    current.periodGenerations = mergePeriodGenerations(current.periodGenerations, next.periodGenerations);
    current._initDataByKey = current._initDataByKey || {};
    var nextInit = next._initDataByKey || {};
    for (var key in nextInit) {
      if (nextInit.hasOwnProperty(key) && !current._initDataByKey[key]) current._initDataByKey[key] = nextInit[key];
    }
    if (!current.generationKey) current.generationKey = next.generationKey || generationKeyForRep(current);
  }

  function evictExpiredSegments(reps, windowStart) {
    for (var i = 0; i < reps.length; i++) {
      if (!reps[i].segments) continue;
      for (var j = 0; j < reps[i].segments.length; j++) {
        if (reps[i].segments[j].end < windowStart - 0.1) {
          reps[i].segments[j].appended = false;
          reps[i].segments[j].state = 'expired';
        }
      }
    }
  }

  function segmentKey(seg) {
    var range = seg.range ? ':' + seg.range.start + '-' + seg.range.end : '';
    var hlsSeq = seg.mediaSequence != null ? ':ms' + seg.mediaSequence + ':ds' + (seg.discontinuitySequence || 0) : '';
    var hlsPart = seg.partIndex != null ? ':part' + seg.partIndex : (seg._hlsPreloadHint ? ':preload' : '');
    return (seg.url || String(seg.start)) + range + hlsSeq + hlsPart;
  }

  function hlsFmp4TimestampOffset(provider, track, seg) {
    if (!provider || !provider.live || provider.isTsPlaylist || !track || track.isTsPlaylist || !seg) return NaN;
    return hlsLiveTimestampOffset(provider, track, seg);
  }

  function hlsLiveTimestampOffset(provider, track, seg) {
    if (!provider || !provider.live || !track || !seg) return NaN;
    if (!isFinite(seg.start) || seg.start < 0) return NaN;
    return seg.start;
  }

  function hlsAppendSegmentWithWatchdog(provider, track, seg, data) {
    var append = provider._appendSegmentData(track, seg, data);
    return new Promise(function (resolve, reject) {
      var done = false;
      var timeoutId = setTimeout(function () {
        if (done) return;
        done = true;
        if (segmentBuffered(provider.video, seg)) {
          resolve();
        } else {
          reject(new Error('hls-append-timeout'));
        }
      }, SOURCEBUFFER_WATCHDOG_MS * 2);
      append.then(function (value) {
        if (done) return;
        done = true;
        clearTimeout(timeoutId);
        resolve(value);
      }).catch(function (err) {
        if (done) return;
        done = true;
        clearTimeout(timeoutId);
        reject(err);
      });
    });
  }

  function recoverStuckSourceBuffer(provider, track) {
    if (!track || !track.sb || !track.sb.updating) {
      if (track) track._sourceBufferUpdatingSince = 0;
      return true;
    }
    var now = performance.now();
    track._sourceBufferUpdatingSince = track._sourceBufferUpdatingSince || now;
    if (now - track._sourceBufferUpdatingSince < SOURCEBUFFER_WATCHDOG_MS) return false;
    try {
      if (track.sb.abort) track.sb.abort();
      if (provider) {
        provider.sourceBufferAbortCount = (provider.sourceBufferAbortCount || 0) + 1;
        provider.lastError = 'sourcebuffer-abort';
      }
    } catch (e) {}
    track._sourceBufferUpdatingSince = 0;
    return !track.sb.updating;
  }

  function hlsSeekTargetInsideSegment(provider, target) {
    var segments = provider && provider.segments ? provider.segments : [];
    if (!segments.length || !isFinite(target)) return target;
    for (var i = 0; i < segments.length; i++) {
      var seg = segments[i];
      if (!isFinite(seg.start) || !isFinite(seg.end) || seg.end <= seg.start) continue;
      if (target >= seg.start - 0.05 && target < seg.end - 0.1) {
        return clamp(target, seg.start + 0.05, seg.end - 0.1);
      }
      if (Math.abs(target - seg.end) <= 0.1) {
        var next = segments[i + 1];
        if (next && isFinite(next.start) && isFinite(next.end) && next.end > next.start) {
          return clamp(next.start + 0.05, next.start + 0.05, next.end - 0.1);
        }
        return clamp(target, seg.start + 0.05, seg.end - 0.1);
      }
    }
    return target;
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function isQuotaExceeded(err) {
    return !!(err && (err.name === 'QuotaExceededError' || /quota/i.test(err.message || '')));
  }

  function removeItem(list, item) {
    var idx = list.indexOf(item);
    if (idx !== -1) list.splice(idx, 1);
  }

  function wait(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function abortError() {
    var err = new Error('request-aborted');
    err.name = 'AbortError';
    return err;
  }

  function rangeHttpError(status) {
    var err = new Error('range-http-' + status);
    err.status = status;
    return err;
  }

  function isTransientRequestError(err) {
    return !!(err && /network|range-http-(401|403|404|408|410|416|429|5\d\d)|Failed to fetch|Load failed/i.test(err.message || ''));
  }

  function isRefreshableRequestError(err) {
    return !!(err && /(range|manifest)-http-(403|404|410|416|5\d\d)|Failed to fetch|Load failed|network/i.test(err.message || ''));
  }

  function mime(rep) {
    return rep.mimeType + '; codecs="' + rep.codecs + '"';
  }

  function segmentMime(seg, rep) {
    return (seg.mimeType || rep.mimeType) + '; codecs="' + (seg.codecs || rep.codecs) + '"';
  }

  function codecFamily(codecs) {
    return String(codecs || '').split('.')[0].toLowerCase();
  }

  function defaultCapability(rep) {
    return {
      probed: false,
      supported: true,
      smooth: true,
      powerEfficient: codecFamily(rep.codecs) === 'avc1' || codecFamily(rep.codecs) === 'mp4a'
    };
  }

  function capabilityAllowed(provider, rep) {
    if (provider && provider._isCapabilityAllowed) return provider._isCapabilityAllowed(rep);
    var cap = rep.capability || defaultCapability(rep);
    rep.capability = cap;
    return cap.supported !== false && cap.smooth !== false;
  }

  function activeAbrRestrictions(provider) {
    var abr = provider && provider.engine && provider.engine._player ? provider.engine._player.config.abr || {} : {};
    var cfg = abr.restrictions || {};
    return {
      minHeight: cfg.minHeight || 0,
      maxHeight: cfg.maxHeight == null ? 0 : cfg.maxHeight,
      minBandwidth: cfg.minBandwidth || 0,
      maxBandwidth: cfg.maxBandwidth == null ? 0 : cfg.maxBandwidth,
      ignoreViewportSize: !!(abr.ignoreViewportSize || cfg.ignoreViewportSize)
    };
  }

  function variantRestricted(provider, rep) {
    if (!rep) return false;
    var cfg = activeAbrRestrictions(provider);
    var maxHeight = cfg.maxHeight || Infinity;
    var viewportMax = provider && provider._viewportMaxHeight ? provider._viewportMaxHeight() : Infinity;
    maxHeight = Math.min(maxHeight, viewportMax);
    if (rep.height && cfg.minHeight && rep.height < cfg.minHeight) return true;
    if (rep.height && isFinite(maxHeight) && rep.height > maxHeight) return true;
    if (rep.bandwidth && cfg.minBandwidth && rep.bandwidth < cfg.minBandwidth) return true;
    if (rep.bandwidth && cfg.maxBandwidth && rep.bandwidth > cfg.maxBandwidth) return true;
    return false;
  }

  function variantSelectable(provider, rep) {
    return capabilityAllowed(provider, rep) && !variantRestricted(provider, rep);
  }

  function restrictedVariantCount(provider, reps) {
    var count = 0;
    (reps || []).forEach(function (rep) { if (variantRestricted(provider, rep)) count++; });
    return count;
  }

  function capabilityStatus(cap) {
    if (!cap) return 'unknown';
    if (cap.supported === false) return 'unsupported';
    if (cap.smooth === false) return 'not-smooth';
    if (cap.powerEfficient === true) return 'power-efficient';
    return cap.probed ? 'supported' : 'unknown';
  }

  function capabilityPreferenceScore(rep) {
    var cap = rep.capability || defaultCapability(rep);
    var score = 0;
    if (cap.supported === false || cap.smooth === false) return -1000;
    if (cap.smooth === true) score += 20;
    if (cap.powerEfficient === true) score += 10;
    var family = codecFamily(rep.codecs);
    if (family === 'avc1') score += 5;
    if (family === 'av01') score -= cap.probed ? 0 : 2;
    return score;
  }

  function effectiveBandwidthEstimate(provider) {
    var abr = provider && provider.engine && provider.engine._player ? provider.engine._player.config.abr || {} : {};
    if (provider && !provider.bandwidthSamples && abr.useNetworkInformation !== false && navigator.connection && navigator.connection.downlink) {
      return navigator.connection.downlink * 1000000;
    }
    return (provider && provider.bandwidth) || abr.defaultBandwidthEstimate || 3000000;
  }

  function effectiveRetryParameters(provider) {
    var streaming = provider && provider.engine && provider.engine._player ? provider.engine._player.config.streaming || {} : {};
    var retry = streaming.retryParameters || {};
    return {
      maxAttempts: Math.max(1, retry.maxAttempts == null ? 3 : retry.maxAttempts),
      baseDelay: Math.max(0, retry.baseDelay == null ? 250 : retry.baseDelay),
      backoffFactor: Math.max(1, retry.backoffFactor == null ? 2 : retry.backoffFactor)
    };
  }

  function retryDelay(retry, attempt) {
    return retry.baseDelay * Math.pow(retry.backoffFactor, Math.max(0, attempt - 1));
  }

  function isBetterCandidate(next, current) {
    if (!current) return true;
    var nextHeight = next.height || 0;
    var currentHeight = current.height || 0;
    if (nextHeight !== currentHeight) return nextHeight > currentHeight;
    var scoreDiff = capabilityPreferenceScore(next) - capabilityPreferenceScore(current);
    if (scoreDiff !== 0) return scoreDiff > 0;
    return (next.bandwidth || 0) > (current.bandwidth || 0);
  }

  function compareVideoReps(a, b) {
    var heightDiff = (a.height || 0) - (b.height || 0);
    if (heightDiff) return heightDiff;
    var scoreDiff = capabilityPreferenceScore(a) - capabilityPreferenceScore(b);
    if (scoreDiff) return scoreDiff;
    return (a.bandwidth || 0) - (b.bandwidth || 0);
  }

  function mediaCapabilityConfig(rep) {
    var cfg = { type: 'media-source' };
    if (rep.kind === 'audio') {
      cfg.audio = {
        contentType: mime(rep),
        channels: '2',
        bitrate: rep.bandwidth || 128000,
        samplerate: rep.asr || 44100
      };
    } else {
      cfg.video = {
        contentType: mime(rep),
        width: rep.width || 640,
        height: rep.height || 360,
        bitrate: rep.bandwidth || 1000000,
        framerate: 30
      };
    }
    return cfg;
  }

  function compareAudioReps(a, b) {
    var aMain = hasRole(a, 'main') && !hasAnyRole(a, ['commentary', 'description', 'alternate']);
    var bMain = hasRole(b, 'main') && !hasAnyRole(b, ['commentary', 'description', 'alternate']);
    if (aMain !== bMain) return aMain ? -1 : 1;
    var aSecondary = hasAnyRole(a, ['commentary', 'description', 'alternate']);
    var bSecondary = hasAnyRole(b, ['commentary', 'description', 'alternate']);
    if (aSecondary !== bSecondary) return aSecondary ? 1 : -1;
    var aDefault = /^(en|eng)$/i.test(a.language || '') || /english/i.test(a.label || '');
    var bDefault = /^(en|eng)$/i.test(b.language || '') || /english/i.test(b.label || '');
    if (aDefault !== bDefault) return aDefault ? -1 : 1;
    return (b.bandwidth || 0) - (a.bandwidth || 0);
  }

  function audioTrackForRep(rep, active) {
    return {
      id: rep.id,
      active: !!active,
      language: rep.language || '',
      label: rep.label || rep.language || rep.id,
      bandwidth: rep.bandwidth || 0,
      codecs: rep.codecs || '',
      audioSamplingRate: rep.asr || 0,
      roles: rep.roles || [],
      accessibility: rep.accessibility || [],
      channels: rep.channels || ''
    };
  }

  function textTrackForRep(rep, active) {
    return {
      id: rep.id,
      active: !!active,
      source: rep.source || 'native-dash',
      language: rep.language || '',
      label: rep.label || rep.language || rep.id,
      mimeType: rep.mimeType || '',
      roles: rep.roles || [],
      accessibility: rep.accessibility || [],
      kind: rep.roles && rep.roles.length ? rep.roles[0] : 'subtitles',
      url: rep.url || '',
      embedded: !!rep.embedded,
      instreamId: rep.instreamId || '',
      supported: rep.supported !== false,
      renderSupported: rep.renderSupported !== false && isRenderableTextMime(rep.mimeType || ''),
      error: rep.error || '',
      loadState: rep.loadState || 'idle'
    };
  }

  function hasRole(rep, role) {
    role = String(role || '').toLowerCase();
    return (rep.roles || []).some(function (value) { return String(value).toLowerCase() === role; });
  }

  function hasAnyRole(rep, roles) {
    for (var i = 0; i < roles.length; i++) {
      if (hasRole(rep, roles[i])) return true;
    }
    return false;
  }

  function isSupported(mimeType, codecs) {
    return !!(mimeType && codecs && window.MediaSource && MediaSource.isTypeSupported(mimeType + '; codecs="' + codecs + '"'));
  }

  function isSupportedRepresentation(rep) {
    if (!isSupported(rep.mimeType, rep.codecs)) return false;
    var generations = rep.periodGenerations || [];
    for (var i = 0; i < generations.length; i++) {
      if (!isSupported(generations[i].mimeType || rep.mimeType, generations[i].codecs || rep.codecs)) return false;
    }
    return true;
  }

  function resolveUrl(value, base) {
    try { return new URL(value, base).toString(); } catch (e) { return value; }
  }

  function readType(dv, pos) {
    return String.fromCharCode(dv.getUint8(pos), dv.getUint8(pos + 1), dv.getUint8(pos + 2), dv.getUint8(pos + 3));
  }

  function stampUri(engine, uri) {
    if (!engine.streamToken || uri.indexOf('/api/stream/') === -1) return uri;
    return stampToken(uri, engine.streamToken);
  }

  function stampToken(uri, token) {
    if (!token || uri.indexOf('/api/stream/') === -1) return uri;
    var hashIndex = uri.indexOf('#');
    var hash = hashIndex === -1 ? '' : uri.slice(hashIndex);
    var withoutHash = hashIndex === -1 ? uri : uri.slice(0, hashIndex);
    var queryIndex = withoutHash.indexOf('?');
    if (queryIndex === -1) return withoutHash + '?token=' + encodeURIComponent(token) + hash;
    var path = withoutHash.slice(0, queryIndex);
    var query = withoutHash.slice(queryIndex + 1);
    var parts = query.split('&').filter(function (part) {
      return part && part.split('=')[0] !== 'token';
    });
    parts.push('token=' + encodeURIComponent(token));
    return path + '?' + parts.join('&') + hash;
  }

  function isLikelyNativeUrl(url) {
    return /\.(m3u8|mp4|m4v|webm)(\?|$)/i.test(url);
  }

  function shouldUseFirstPartyHls(url) {
    return !!(window.MediaSource && url && url.indexOf('/api/stream/') !== -1 && /\.m3u8(\?|$)/i.test(url));
  }

  function isHlsMimeType(mimeType) {
    return /mpegurl|vnd\.apple\.mpegurl/i.test(mimeType || '');
  }

  function canPlayNativeHls(video) {
    if (!video || !video.canPlayType) return false;
    return !!(
      video.canPlayType('application/vnd.apple.mpegurl') ||
      video.canPlayType('application/x-mpegURL') ||
      video.canPlayType('audio/mpegurl')
    );
  }

  function setPath(obj, path, value) {
    var parts = path.split('.');
    var cur = obj;
    for (var i = 0; i < parts.length - 1; i++) {
      if (!cur[parts[i]]) cur[parts[i]] = {};
      cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = value;
  }

  function merge(target, src) {
    for (var key in src) {
      if (!src.hasOwnProperty(key)) continue;
      if (src[key] && typeof src[key] === 'object' && !Array.isArray(src[key])) {
        if (!target[key]) target[key] = {};
        merge(target[key], src[key]);
      } else {
        target[key] = src[key];
      }
    }
    return target;
  }

  window.PlayerEngine = PlayerEngine;
  window.NativeUrlProviderForTest = {
    load: NativeUrlProvider.prototype.load,
    getStats: NativeUrlProvider.prototype.getStats,
    _onRuntimeError: NativeUrlProvider.prototype._onRuntimeError,
    isLive: NativeUrlProvider.prototype.isLive,
    getBufferedInfo: NativeUrlProvider.prototype.getBufferedInfo,
    getVariantTracks: NativeUrlProvider.prototype.getVariantTracks,
    getActiveVariantTrack: NativeUrlProvider.prototype.getActiveVariantTrack,
    getAudioTracks: NativeUrlProvider.prototype.getAudioTracks,
    getActiveAudioTrack: NativeUrlProvider.prototype.getActiveAudioTrack
  };
  window.NativeDashProviderForTest = {
    _candidateVideos: NativeDashProvider.prototype._candidateVideos,
    _chooseForBudget: NativeDashProvider.prototype._chooseForBudget,
    _appendSegmentData: NativeDashProvider.prototype._appendSegmentData,
    _handleAppendFailure: NativeDashProvider.prototype._handleAppendFailure,
    _completeNativeRuntimeTerminal: NativeDashProvider.prototype._completeNativeRuntimeTerminal,
    _tryNativeRecovery: NativeDashProvider.prototype._tryNativeRecovery,
    _prepareSegmentGeneration: NativeDashProvider.prototype._prepareSegmentGeneration,
    _rebuildSourceBufferForPeriod: NativeDashProvider.prototype._rebuildSourceBufferForPeriod,
    _initDataForSegment: NativeDashProvider.prototype._initDataForSegment,
    _changeVideoTypeIfNeeded: NativeDashProvider.prototype._changeVideoTypeIfNeeded,
    _changeAudioTypeIfNeeded: NativeDashProvider.prototype._changeAudioTypeIfNeeded,
    _lowerVideoRep: NativeDashProvider.prototype._lowerVideoRep,
    _recoverQuota: NativeDashProvider.prototype._recoverQuota,
    _selectNextSegment: NativeDashProvider.prototype._selectNextSegment,
    _scheduleMediaRequests: NativeDashProvider.prototype._scheduleMediaRequests,
    _buildSegmentCandidates: NativeDashProvider.prototype._buildSegmentCandidates,
    _startSegmentFetch: NativeDashProvider.prototype._startSegmentFetch,
    _drainAppendQueue: NativeDashProvider.prototype._drainAppendQueue,
    _checkBufferMilestones: NativeDashProvider.prototype._checkBufferMilestones,
    _bufferAheadGoal: NativeDashProvider.prototype._bufferAheadGoal,
    _rebufferingGoal: NativeDashProvider.prototype._rebufferingGoal,
    _startupBufferGoal: NativeDashProvider.prototype._startupBufferGoal,
    _seekBufferGoal: NativeDashProvider.prototype._seekBufferGoal,
    _bufferBehindGoal: NativeDashProvider.prototype._bufferBehindGoal,
    _availabilityWindowOverride: NativeDashProvider.prototype._availabilityWindowOverride,
    _effectiveLiveWindow: NativeDashProvider.prototype._effectiveLiveWindow,
    _trim: NativeDashProvider.prototype._trim,
    _pendingSegmentCount: NativeDashProvider.prototype._pendingSegmentCount,
    _schedulerQueueDepth: NativeDashProvider.prototype._schedulerQueueDepth,
    _abortRequests: NativeDashProvider.prototype._abortRequests,
    _probeCapabilities: NativeDashProvider.prototype._probeCapabilities,
    _isCapabilityAllowed: NativeDashProvider.prototype._isCapabilityAllowed,
    _ensureDrmReady: NativeDashProvider.prototype._ensureDrmReady,
    _onEncrypted: NativeDashProvider.prototype._onEncrypted,
    _completeDrmTerminalError: NativeDashProvider.prototype._completeDrmTerminalError,
    _handleDrmMessage: NativeDashProvider.prototype._handleDrmMessage,
    _jumpSmallGap: NativeDashProvider.prototype._jumpSmallGap,
    _refreshManifest: NativeDashProvider.prototype._refreshManifest,
    _updateLiveWindowFromReps: NativeDashProvider.prototype._updateLiveWindowFromReps,
    _updateLivePositionStats: NativeDashProvider.prototype._updateLivePositionStats,
    _evictExpiredLiveSegmentState: NativeDashProvider.prototype._evictExpiredLiveSegmentState,
    _switchAudio: NativeDashProvider.prototype._switchAudio,
    _maybeSwitchAuto: NativeDashProvider.prototype._maybeSwitchAuto,
    _recordBandwidthSample: NativeDashProvider.prototype._recordBandwidthSample,
    _recordRangeRecovery: NativeDashProvider.prototype._recordRangeRecovery,
    _recordRangeError: NativeDashProvider.prototype._recordRangeError,
    _fetchRange: NativeDashProvider.prototype._fetchRange,
    _prepareRep: NativeDashProvider.prototype._prepareRep,
    _viewportMaxHeight: NativeDashProvider.prototype._viewportMaxHeight,
    chooseVideoRep: NativeDashProvider.prototype.chooseVideoRep,
    getAudioTracks: NativeDashProvider.prototype.getAudioTracks,
    getActiveAudioTrack: NativeDashProvider.prototype.getActiveAudioTrack,
    getTextTracks: NativeDashProvider.prototype.getTextTracks,
    getActiveTextTrack: NativeDashProvider.prototype.getActiveTextTrack,
    selectTextTrack: NativeDashProvider.prototype.selectTextTrack,
    setTextTrackVisibility: NativeDashProvider.prototype.setTextTrackVisibility,
    getVariantTracks: NativeDashProvider.prototype.getVariantTracks,
    getActiveVariantTrack: NativeDashProvider.prototype.getActiveVariantTrack,
    getIFrameTracks: NativeDashProvider.prototype.getIFrameTracks,
    getIFramePreview: NativeDashProvider.prototype.getIFramePreview,
    getLiveRange: NativeDashProvider.prototype.getLiveRange,
    getBufferedInfo: NativeDashProvider.prototype.getBufferedInfo,
    _addTimelineRegions: NativeDashProvider.prototype._addTimelineRegions,
    getStats: NativeDashProvider.prototype.getStats,
    reportStall: NativeDashProvider.prototype.reportStall,
    beginSeek: NativeDashProvider.prototype.beginSeek,
    commitSeek: NativeDashProvider.prototype.commitSeek,
    cancelSeek: NativeDashProvider.prototype.cancelSeek,
    endSeek: NativeDashProvider.prototype.endSeek,
    _onSeek: NativeDashProvider.prototype._onSeek,
    _clampSeekTarget: NativeDashProvider.prototype._clampSeekTarget,
    seekToLiveEdge: NativeDashProvider.prototype.seekToLiveEdge,
    selectAudioTrack: NativeDashProvider.prototype.selectAudioTrack,
    selectVariantTrack: NativeDashProvider.prototype.selectVariantTrack,
    parseMPD: parseMPD,
    parseHlsPlaylist: parseHlsPlaylist,
    parseTtmlCues: parseTtmlCues,
    compareAudioReps: compareAudioReps
  };
  window.NativeHlsProviderForTest = {
    _appendSegmentData: NativeHlsProvider.prototype._appendSegmentData,
    _recoverQuota: NativeHlsProvider.prototype._recoverQuota,
    _handleAppendFailure: NativeHlsProvider.prototype._handleAppendFailure,
    _handleFatal: NativeHlsProvider.prototype._handleFatal,
    _completeNativeRuntimeTerminal: NativeHlsProvider.prototype._completeNativeRuntimeTerminal,
    _tryNativeRecovery: NativeHlsProvider.prototype._tryNativeRecovery,
    _probeCapabilities: NativeHlsProvider.prototype._probeCapabilities,
    _isCapabilityAllowed: NativeHlsProvider.prototype._isCapabilityAllowed,
    _candidateVariants: NativeHlsProvider.prototype._candidateVariants,
    _chooseForBudget: NativeHlsProvider.prototype._chooseForBudget,
    _lowerVariant: NativeHlsProvider.prototype._lowerVariant,
    _fetchRange: NativeHlsProvider.prototype._fetchRange,
    _fetchPlaylistText: NativeHlsProvider.prototype._fetchPlaylistText,
    _recordServiceWorkerFetch: NativeHlsProvider.prototype._recordServiceWorkerFetch,
    _recordOfflineHttpError: NativeHlsProvider.prototype._recordOfflineHttpError,
    _drainAppendQueue: NativeHlsProvider.prototype._drainAppendQueue,
    _ensureTsTransmuxer: NativeHlsProvider.prototype._ensureTsTransmuxer,
    _transmuxTsSegment: NativeHlsProvider.prototype._transmuxTsSegment,
    _jumpSmallGap: NativeHlsProvider.prototype._jumpSmallGap,
    reportStall: NativeHlsProvider.prototype.reportStall,
    chooseVariant: NativeHlsProvider.prototype.chooseVariant,
    getVariantTracks: NativeHlsProvider.prototype.getVariantTracks,
    selectVariantTrack: NativeHlsProvider.prototype.selectVariantTrack,
    getIFrameTracks: NativeHlsProvider.prototype.getIFrameTracks,
    getIFramePreview: NativeHlsProvider.prototype.getIFramePreview,
    _loadIFramePlaylist: NativeHlsProvider.prototype._loadIFramePlaylist,
    _loadImagePlaylist: NativeHlsProvider.prototype._loadImagePlaylist,
    getTextTracks: NativeHlsProvider.prototype.getTextTracks,
    getActiveTextTrack: NativeHlsProvider.prototype.getActiveTextTrack,
    selectTextTrack: NativeHlsProvider.prototype.selectTextTrack,
    setTextTrackVisibility: NativeHlsProvider.prototype.setTextTrackVisibility,
    getBufferedInfo: NativeHlsProvider.prototype.getBufferedInfo,
    getLiveRange: NativeHlsProvider.prototype.getLiveRange,
    seekToLiveEdge: NativeHlsProvider.prototype.seekToLiveEdge,
    _addTimelineRegions: NativeHlsProvider.prototype._addTimelineRegions,
    beginSeek: NativeHlsProvider.prototype.beginSeek,
    commitSeek: NativeHlsProvider.prototype.commitSeek,
    cancelSeek: NativeHlsProvider.prototype.cancelSeek,
    endSeek: NativeHlsProvider.prototype.endSeek,
    _onSeek: NativeHlsProvider.prototype._onSeek,
    _clampSeekTarget: NativeHlsProvider.prototype._clampSeekTarget,
    _seekBufferGoal: NativeHlsProvider.prototype._seekBufferGoal,
    _checkBufferMilestones: NativeHlsProvider.prototype._checkBufferMilestones,
    _abortRequests: NativeHlsProvider.prototype._abortRequests,
    getStats: NativeHlsProvider.prototype.getStats
  };
  window.NativeTsTransmuxerForTest = {
    demuxMpegTs: demuxMpegTs,
    FirstPartyTsTransmuxerAdapter: FirstPartyTsTransmuxerAdapter
  };
})();
