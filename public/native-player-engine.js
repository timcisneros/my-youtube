/**
 * PlayerEngine — native-first playback engine with explicit Shaka fallback.
 *
 * The public API intentionally matches the old Shaka-backed engine so the
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
  var MAX_GAP_JUMP = 0.75;
  var STARTUP_BUFFER_GOAL = 4;
  var MAX_CONCURRENT_MEDIA_REQUESTS = 3;
  var SHAKA_URL = '/vendor/shaka/shaka-player.compiled.js';

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
    this._provider = null;
    this._providerName = '';
    this._finalVia = '';
    this._state = 'idle';
    this._fallbackReason = '';
    this._loadStartedAt = 0;
    this._offlinePlayback = false;
    this._manifestFromServiceWorker = false;
    this._lastOfflineError = '';
    this.recovering = false;
    this.recoveryTransition = false;
    this.networkTrouble = false;
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

  PlayerEngine.prototype.init = function () {
    var self = this;
    this._telemetry.attach();
    this.video.addEventListener('timeupdate', function () {
      if (!self.video.seeking && !self.video.paused && isFinite(self.video.currentTime)) {
        self.lastGoodTime = self.video.currentTime;
      }
    });
    this.video.addEventListener('error', function () {
      var e = self.video.error;
      if (!e || self.destroyed || self._serverDown || self._recovering) return;
      console.warn('[player-engine] video error code=' + e.code + ' provider=' + self._providerName);
      self._telemetry.record('video-error', { lastError: 'video-error-' + e.code });
      if (self._provider && self._provider.handleVideoError) {
        self._setRecovering(true);
        self._provider.handleVideoError(e).then(function () {
          self._setRecovering(false);
          self._telemetry.record('recovery', { lastError: 'video-error-' + e.code });
          self.emit('recovery-end', { method: 'native', time: self.video.currentTime, via: self._finalVia });
        }).catch(function (err) {
          self._setRecovering(false);
          self._fallbackToShaka('video-error-' + e.code, self.lastGoodTime || self.video.currentTime || 0).catch(function (fallbackErr) {
            console.error('[player-engine] fallback failed:', fallbackErr);
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

  PlayerEngine.prototype.load = function (url) {
    var self = this;
    url = url || this.manifestUrl;
    this.setLive(false);
    this._loadStartedAt = performance.now();
    this._telemetry.record('load-start');
    this._setState('loading');
    return this._loadNative(url).catch(function (err) {
      if (err && err.serverError) throw err;
      if (self._shouldKeepNativeOffline(err)) throw err;
      return self._fallbackToShaka(err && err.message ? err.message : 'native-load-failed');
    });
  };

  PlayerEngine.prototype._loadNative = function (url) {
    var self = this;
    this._destroyProvider();
    if (isLikelyNativeUrl(url)) {
      if (/\.m3u8(\?|$)/i.test(url) && !canPlayNativeHls(this.video)) {
        if (!window.MediaSource) throw new Error('mse-unavailable');
        this._provider = new NativeHlsProvider(this, url);
        this._providerName = this._provider.name;
        window._playerProvider = this._providerName;
        console.log('[player-engine] provider=' + this._providerName + ' mode=hls');
        return this._provider.load();
      }
      this._provider = new NativeUrlProvider(this, url);
      this._providerName = this._provider.name;
      window._playerProvider = this._providerName;
      console.log('[player-engine] provider=' + this._providerName);
      return this._provider.load();
    }
    return fetchManifest(url, this.streamToken).then(function (manifest) {
      self._recordManifestSource(manifest);
      self._finalVia = manifest.via || self._finalVia;
      if (manifest.via) self.emit('via', manifest.via);
      if (manifest.downloadedHeight) self.emit('downloaded-height', manifest.downloadedHeight);
        if (manifest.json) {
        if (manifest.json.hls && canPlayNativeHls(self.video)) {
          self._finalVia = (manifest.json.via || 'yt-dlp') + '/hls';
          self.emit('via', self._finalVia);
          self._provider = new NativeUrlProvider(self, manifest.json.hls, 'hls');
          self._providerName = self._provider.name;
          window._playerProvider = self._providerName;
          console.log('[player-engine] provider=' + self._providerName + ' mode=hls');
          return self._provider.load();
        }
        if (manifest.json.hls && !manifest.json.progressive) {
          if (!window.MediaSource) throw new Error('mse-unavailable');
          self._finalVia = (manifest.json.via || 'yt-dlp') + '/hls';
          self.emit('via', self._finalVia);
          self._provider = new NativeHlsProvider(self, manifest.json.hls);
          self._providerName = self._provider.name;
          window._playerProvider = self._providerName;
          console.log('[player-engine] provider=' + self._providerName + ' mode=hls');
          return self._provider.load();
        }
        if (manifest.json.progressive) {
          self._finalVia = (manifest.json.via || 'yt-dlp') + '/progressive';
          self.emit('via', self._finalVia);
          self._provider = new NativeUrlProvider(self, manifest.json.progressive, 'progressive');
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

  PlayerEngine.prototype._fallbackToShaka = function (reason, startTime) {
    var self = this;
    if (this._shouldKeepNativeOffline(new Error(reason || 'native-load-failed'))) {
      return Promise.reject(new Error(this._lastOfflineError || reason || 'offline-native-playback-error'));
    }
    this._setState('fallback');
    return loadShaka().then(function () {
      if (!window.shaka || !window.shaka.Player) {
        throw new Error('shaka-unavailable after ' + reason);
      }
      self._destroyProvider();
      self._provider = new ShakaFallbackProvider(self, reason);
      self._providerName = self._provider.name;
      window._playerProvider = self._providerName;
      window._shakaPlayer = self._provider.player;
      self._fallbackReason = reason;
      console.warn('[player-engine] falling back to shaka: reason=' + reason);
      self._telemetry.record('fallback', { fallbackReason: reason });
      return self._provider.load(self.manifestUrl, startTime);
    });
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
    this.recoveryTransition = state === 'recovering' || state === 'seeking' || state === 'fallback';
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

  PlayerEngine.prototype._getBufferAhead = function () {
    return getBufferAhead(this.video);
  };

  PlayerEngine.prototype.destroy = function () {
    this.destroyed = true;
    this._telemetry.record('unload-summary');
    this._telemetry.flush();
    this._setState('destroyed');
    this._serverDown = false;
    this._recovering = false;
    this._heldRequests = [];
    this._stopServerProbe();
    this._destroyProvider();
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
  }

  PlayerTelemetry.prototype.attach = function () {
    if (this.attached) return;
    this.attached = true;
    var self = this;
    var video = this.engine.video;
    video.addEventListener('loadeddata', function () {
      if (!self.firstFrameAt) {
        self.firstFrameAt = performance.now();
        self.record('first-frame');
      }
    });
    video.addEventListener('error', function () {
      var err = video.error;
      self.record('fatal-error', { lastError: err ? 'video-error-' + err.code : 'video-error' });
    });
    var flush = function () {
      self.record('unload-summary');
      self.flush();
    };
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', flush);
  };

  PlayerTelemetry.prototype.record = function (type, extra) {
    if (window.__disablePlayerTelemetry) return;
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
        seekBufferGoal: STARTUP_BUFFER_GOAL
      },
      manifest: { availabilityWindowOverride: null }
    };
  }

  PlayerAdapter.prototype.load = function (url) {
    return this.engine.load(url);
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
    return this.engine._provider && this.engine._provider.getStats
      ? this.engine._provider.getStats()
      : {};
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
        self.fatalError = 'native-url-error';
        reject(new Error('native-url-error'));
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

  NativeUrlProvider.prototype.getStats = function () {
    var quality = this.video.getVideoPlaybackQuality ? this.video.getVideoPlaybackQuality() : null;
    return {
      provider: this.name,
      mode: this.mode,
      isLive: this.isLive(),
      assetUri: this.assetUri || this.url,
      fallbackReason: this.engine ? (this.engine._fallbackReason || '') : '',
      bufferAhead: getBufferAhead(this.video),
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
    this.engine._telemetry.record('fallback', { fallbackReason: 'native-url-error', lastError: this.fatalError });
    this.engine._fallbackToShaka('native-url-error', this.video.currentTime || this.engine.lastGoodTime || 0);
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
    this.startupBufferComplete = false;
    this.startupBufferStartedAt = 0;
    this.startupBufferMs = 0;
    this.lastSwitchReason = 'startup';
    this.liveWindow = null;
    this.liveLatency = 0;
    this.atLiveEdge = false;
    this.manifestCompatibilityWarnings = [];
  }

  NativeHlsProvider.prototype.load = function () {
    var self = this;
    return this._fetchPlaylistText(this.playlistUrl).then(function (text) {
      var parsed = parseHlsPlaylist(text, self.playlistUrl);
      if (parsed.encrypted) throw new Error('hls-encrypted-unsupported');
      if (parsed.variants.length) {
        self.audioRenditions = parsed.audioRenditions;
        self.subtitleRenditions = parsed.subtitleRenditions;
        self.variants = parsed.variants.map(function (variant) {
          variant.kind = 'video';
          variant.mimeType = 'video/mp4';
          variant.codecs = videoCodecsOnly(variant.codecs) || variant.codecs;
          return variant;
        }).sort(compareVideoReps);
        self.audioRenditions.forEach(function (rendition) {
          rendition.kind = 'audio';
          rendition.mimeType = 'audio/mp4';
          rendition.codecs = rendition.codecs || audioCodecsOnly(parsed.codecs) || 'mp4a.40.2';
          rendition.asr = 44100;
        });
        return self._probeCapabilities(self.variants.concat(self.audioRenditions)).then(function () {
          self.unsupportedVideoCount = self.variants.filter(function (variant) { return !MediaSource.isTypeSupported(mime(variant)); }).length;
          self.unsupportedAudioCount = self.audioRenditions.filter(function (rendition) { return !MediaSource.isTypeSupported(mime(rendition)); }).length;
          self.unsupportedCapabilityCount = self.variants.concat(self.audioRenditions).filter(function (rep) { return !capabilityAllowed(self, rep); }).length;
          self.activeVariant = self.chooseVariant();
          if (!self.activeVariant) throw new Error('hls-no-supported-video');
          self.activeAudio = self._chooseAudioRendition(self.activeVariant);
          if (self.activeVariant.audioGroup && !self.activeAudio) throw new Error('hls-no-supported-audio');
          return self._fetchPlaylistText(self.activeVariant.url).then(function (mediaText) {
            return self._loadMediaPlaylist(mediaText, self.activeVariant.url);
          }).then(function () {
            if (!self.activeAudio || !self.activeAudio.url) return;
            return self._fetchPlaylistText(self.activeAudio.url).then(function (audioText) {
              return self._loadAudioPlaylist(audioText, self.activeAudio.url);
            });
          });
        });
      }
      self.variants = [{ id: 'hls', url: self.playlistUrl, bandwidth: 0, height: 0, codecs: parsed.codecs || 'avc1.42c01f,mp4a.40.2', active: true }];
      self.variants[0].kind = 'video';
      self.variants[0].mimeType = 'video/mp4';
      self.variants[0].codecs = videoCodecsOnly(self.variants[0].codecs) || self.variants[0].codecs;
      self.activeVariant = self.variants[0];
      return self._loadMediaPlaylist(text, self.playlistUrl);
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
    if (parsed.encrypted) throw new Error('hls-encrypted-unsupported');
    if (parsed.discontinuity) throw new Error('hls-discontinuity-unsupported');
    if (!parsed.map) throw new Error(hasMpegTsSegments(parsed.segments) ? 'hls-mpegts-unsupported' : 'hls-playlist-unsupported');
    if (!parsed.segments.length) throw new Error('hls-playlist-unsupported');
    this.segments = mergeSegmentState(this.segments, parsed.segments) || parsed.segments;
    this.initSegment = parsed.map;
    this.duration = parsed.duration;
    this.live = !parsed.endList;
    this.mediaSequence = parsed.mediaSequence || 0;
    this.targetDuration = parsed.targetDuration || this.targetDuration || 2;
    this.mediaPlaylistUrl = url;
    this.liveWindow = this.segments.length ? {
      start: this.segments[0].start,
      end: this.segments[this.segments.length - 1].end
    } : null;
    this.playlistRefreshCount++;
    var codecs = (this.activeVariant && this.activeVariant.codecs) || parsed.codecs || 'avc1.42c01f';
    codecs = videoCodecsOnly(codecs) || codecs;
    this.mimeType = 'video/mp4; codecs="' + codecs + '"';
    if (!MediaSource.isTypeSupported(this.mimeType)) throw new Error('hls-codec-unsupported');
  };

  NativeHlsProvider.prototype._loadAudioPlaylist = function (text, url) {
    var parsed = parseHlsPlaylist(text, url);
    if (parsed.encrypted) throw new Error('hls-encrypted-unsupported');
    if (parsed.discontinuity) throw new Error('hls-discontinuity-unsupported');
    if (!parsed.map || !parsed.segments.length) throw new Error(hasMpegTsSegments(parsed.segments) ? 'hls-mpegts-unsupported' : 'hls-audio-playlist-unsupported');
    if (!this.activeAudio) throw new Error('hls-audio-unavailable');
    this.activeAudio.segments = mergeSegmentState(this.activeAudio.segments, parsed.segments) || parsed.segments;
    this.activeAudio.initSegment = parsed.map;
    this.activeAudio.targetDuration = parsed.targetDuration || this.targetDuration || 2;
    this.activeAudio.mediaSequence = parsed.mediaSequence || 0;
    this.activeAudio.playlistUrl = url;
    this.audioSegments = this.activeAudio.segments;
    this.audioInitSegment = this.activeAudio.initSegment;
    var codecs = this.activeAudio.codecs || audioCodecsOnly((this.activeVariant && this.activeVariant.codecs) || '') || 'mp4a.40.2';
    this.audioMimeType = 'audio/mp4; codecs="' + codecs + '"';
    if (!MediaSource.isTypeSupported(this.audioMimeType)) throw new Error('hls-audio-codec-unsupported');
  };

  NativeHlsProvider.prototype._open = function () {
    var self = this;
    this.mediaSource.duration = this.live ? Infinity : (this.duration || NaN);
    this.sb = this.mediaSource.addSourceBuffer(this.mimeType);
    this.sb.mode = 'segments';
    if (this.audioInitSegment) {
      this.audioSb = this.mediaSource.addSourceBuffer(this.audioMimeType);
      this.audioSb.mode = 'segments';
    }
    this.video.addEventListener('waiting', this._boundWaiting = function () { self._onWaiting(); });
    this.video.addEventListener('playing', this._boundPlaying = function () { self._onPlaying(); });
    this.video.addEventListener('timeupdate', this._boundTick = function () { self._tick(); });
    this.video.addEventListener('seeking', this._boundSeeking = function () {
      self._abortRequests();
      markSegmentsForTime(self, self.video.currentTime || 0, Math.max(2, self._bufferAheadGoal()));
      self._tick(true);
    });
    return this._fetchRange(this.initSegment.url, this.initSegment.range, { phase: 'metadata' }).then(function (initData) {
      return appendBuffer(self.sb, initData);
    }).then(function () {
      if (!self.audioInitSegment || !self.audioSb) return;
      return self._fetchRange(self.audioInitSegment.url, self.audioInitSegment.range, { phase: 'metadata' }).then(function (initData) {
        return appendBuffer(self.audioSb, initData);
      });
    }).then(function () {
      if (self.live && self.liveWindow && self.video.currentTime < self.liveWindow.start) {
        self.video.currentTime = Math.max(self.liveWindow.start, self.liveWindow.end - LIVE_TARGET_LATENCY);
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
    this._videoTrack.segments = this.segments;
    this._videoTrack.sb = this.sb;
    var tracks = [this._videoTrack];
    if (this.activeAudio && this.audioSb && this.audioSegments.length) {
      this.activeAudio.kind = 'audio';
      this.activeAudio.segments = this.audioSegments;
      this.activeAudio.sb = this.audioSb;
      tracks.push(this.activeAudio);
    }
    return tracks;
  };

  NativeHlsProvider.prototype._buildSegmentCandidates = function (windowGoal, tracks) {
    var ct = this.video.currentTime || 0;
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
    this._fetchRange(seg.url, seg.range, { phase: 'media' }).then(function (data) {
      delete self.activeRanges[rangeKey];
      seg.state = 'fetched';
      seg._data = data;
      var elapsed = Math.max(1, performance.now() - (seg._fetchStartedAt || performance.now()));
      self.mediaFetchCompletedCount++;
      self.mediaFetchTotalMs += elapsed;
      if (seg.duration > 0 && elapsed > 0) {
        self._recordBandwidthSample(data.byteLength || 0, elapsed);
      }
      self._drainAppendQueue(track);
      self._tick();
    }).catch(function (err) {
      delete self.activeRanges[rangeKey];
      delete seg._fetchStartedAt;
      if (err.name === 'AbortError') return;
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

  NativeHlsProvider.prototype._drainAppendQueue = function (track) {
    var self = this;
    track = track || this._mediaTracks()[0];
    if (!track || !track.sb || track.sb.updating || track._appending) return false;
    var next = nextFetchedSegmentForAppend(track, this.video.currentTime || 0);
    if (!next) return false;
    track._appending = true;
    next.state = 'appending';
    var data = next._data;
    delete next._data;
    this._appendSegmentData(track, next, data).then(function () {
      next.state = 'appended';
      next.appended = true;
      delete next._fetchStartedAt;
      track._appending = false;
      self.appendFailures = 0;
      self.stallReports = 0;
      self.stallRecoveryStage = 0;
      self.schedulerDrainCount++;
      self.engine._player.emit('adaptation');
      self._drainAppendQueue(track);
      self._tick();
    }).catch(function (err) {
      track._appending = false;
      if (err.name !== 'AbortError') {
        next.state = 'failed';
        next.appended = false;
        self._handleAppendFailure(track, err);
      }
    });
    return true;
  };

  NativeHlsProvider.prototype._appendSegmentData = function (track, seg, data) {
    var self = this;
    return appendBuffer(track.sb, data).catch(function (err) {
      if (!isQuotaExceeded(err)) throw err;
      self.quotaRecoveries++;
      self.lastError = 'quota-exceeded';
      if (self.engine && self.engine._telemetry) self.engine._telemetry.record('recovery', { lastError: 'quota-exceeded' });
      return self._recoverQuota(track, data).catch(function (retryErr) {
        seg.state = 'failed';
        throw retryErr;
      });
    });
  };

  NativeHlsProvider.prototype._recoverQuota = function (track, data) {
    var self = this;
    var removeEnd = Math.max(0, (this.video.currentTime || 0) - 5);
    return Promise.all([
      this.sb ? removeBufferBefore(this.sb, removeEnd) : Promise.resolve(),
      this.audioSb ? removeBufferBefore(this.audioSb, removeEnd) : Promise.resolve()
    ]).then(function () {
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
    if (track.kind === 'video') {
      if (this.activeVariant) this.blacklisted[this.activeVariant.id] = true;
      var lower = this._lowerVariant();
      if (lower) {
        this._switchVariant(lower, true, 'append-recovery');
        return;
      }
      this.engine._fallbackToShaka('hls-video-append-exhausted');
      return;
    }
    if (this.appendFailures >= 2) this.engine._fallbackToShaka('hls-audio-append-failed');
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
    return this._fetchPlaylistText(this.activeVariant.url).then(function (mediaText) {
      return self._loadMediaPlaylist(mediaText, self.activeVariant.url);
    }).then(function () {
      if (!self.activeAudio || !self.activeAudio.url) return;
      return self._fetchPlaylistText(self.activeAudio.url).then(function (audioText) {
        return self._loadAudioPlaylist(audioText, self.activeAudio.url);
      });
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
  };

  NativeHlsProvider.prototype._trim = function () {
    if (!this.sb) return;
    trimBuffer(this.sb, Math.max(0, (this.video.currentTime || 0) - this._bufferBehindGoal()));
    if (this.audioSb) trimBuffer(this.audioSb, Math.max(0, (this.video.currentTime || 0) - this._bufferBehindGoal()));
  };

  NativeHlsProvider.prototype._checkBufferMilestones = function () {
    if (this.startupBufferComplete) return;
    if (getBufferAhead(this.video) < Math.min(this._startupBufferGoal(), this._bufferAheadGoal())) return;
    this.startupBufferComplete = true;
    this.startupBufferMs = this.startupBufferStartedAt ? performance.now() - this.startupBufferStartedAt : 0;
    if (this.engine && this.engine._telemetry) this.engine._telemetry.record('startup-buffer-ready', { startupBufferMs: this.startupBufferMs });
  };

  NativeHlsProvider.prototype._abortRequests = function () {
    resetActiveSegmentRequests(this);
    if (this.activeAudio) resetActiveSegmentRequests(this.activeAudio);
    this.activeRanges = {};
    this._appending = false;
    for (var i = 0; i < this.controllers.length; i++) {
      try { this.controllers[i].abort(); } catch (e) {}
    }
    this.controllers = [];
  };

  NativeHlsProvider.prototype._handleFatal = function (err) {
    if (this.destroyed) return;
    this.lastError = err && err.message ? err.message : 'hls-media-error';
    if (err && err.status) this.lastHttpStatus = err.status;
    this.engine._fallbackToShaka(this.lastError, this.video.currentTime || this.engine.lastGoodTime || 0);
  };

  NativeHlsProvider.prototype._bufferAheadGoal = function () {
    var cfg = this.engine._player.config.streaming || {};
    return Math.max(1, cfg.bufferingGoal || BUFFER_AHEAD);
  };

  NativeHlsProvider.prototype._startupBufferGoal = function () {
    var cfg = this.engine._player.config.streaming || {};
    return Math.max(1, cfg.startupBufferGoal || STARTUP_BUFFER_GOAL);
  };

  NativeHlsProvider.prototype._maxConcurrentMediaRequests = function () {
    var cfg = this.engine._player.config.streaming || {};
    return Math.max(1, cfg.maxConcurrentRequests || MAX_CONCURRENT_MEDIA_REQUESTS);
  };

  NativeHlsProvider.prototype._bufferBehindGoal = function () {
    var cfg = this.engine._player.config.streaming || {};
    return Math.max(0, cfg.bufferBehind == null ? BUFFER_BEHIND : cfg.bufferBehind);
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

  NativeHlsProvider.prototype.seekToLiveEdge = function () {
    if (!this.liveWindow) return;
    this.video.currentTime = Math.max(this.liveWindow.start, this.liveWindow.end - LIVE_TARGET_LATENCY);
    this._tick(true);
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
      var lower = this._lowerVariant();
      if (lower) {
        this.stallRecoveryStage = 2;
        this.blacklisted[this.activeVariant.id] = true;
        this._switchVariant(lower, true, 'stall-recovery');
        return;
      }
    }
    if (this.stallReports >= 3) this.engine._fallbackToShaka('hls-stall-exhausted');
  };

  NativeHlsProvider.prototype._fetchRange = function (url, range, opts) {
    var self = this;
    opts = opts || {};
    var attempts = opts.attempts || 3;
    var attempt = opts.attempt || 1;
    var controller = new AbortController();
    this.controllers.push(controller);
    var init = { headers: {}, signal: controller.signal };
    if (range) init.headers.Range = 'bytes=' + range.start + '-' + range.end;
    return fetch(stampUri(this.engine, url), init).then(function (resp) {
      removeItem(self.controllers, controller);
      var swInfo = readServiceWorkerSource(resp);
      self._recordServiceWorkerFetch(swInfo, 'segment');
      if (resp.status === 401 || resp.status === 403 || resp.status === 404 || resp.status === 410 || resp.status === 416 || resp.status >= 500) {
        self.lastHttpStatus = resp.status;
        if (swInfo.offline) self._recordOfflineHttpError(resp.status);
        throw rangeHttpError(resp.status);
      }
      if (!resp.ok && resp.status !== 206) {
        self.lastHttpStatus = resp.status;
        if (swInfo.offline) self._recordOfflineHttpError(resp.status);
        throw rangeHttpError(resp.status);
      }
      return resp.arrayBuffer();
    }).catch(function (err) {
      removeItem(self.controllers, controller);
      if (err.name === 'AbortError') throw abortError();
      if (attempt < attempts && isTransientRequestError(err)) {
        self.recoveryCount++;
        self.mediaFetchRetryCount++;
        self.lastError = err && err.message ? err.message : 'hls-range-retry';
        return wait(250 * Math.pow(2, attempt - 1)).then(function () {
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
    return fetchText(url, this.engine.streamToken, function (swInfo) {
      self._recordServiceWorkerFetch(swInfo, 'manifest');
    }).catch(function (err) {
      if (err && /^manifest-http-/.test(err.message || '') && self.engine && self.engine._offlinePlayback) {
        self.lastOfflineError = 'offline-' + err.message;
        self.engine._recordOfflineError(new Error(self.lastOfflineError));
      }
      throw err;
    });
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
    var cfg = this.engine._player.config.abr.restrictions || {};
    var min = cfg.minHeight || 0;
    var max = Math.min(cfg.maxHeight || Infinity, this._viewportMaxHeight());
    var filtered = this.variants.filter(function (variant) {
      return !this.blacklisted[variant.id] && capabilityAllowed(this, variant) && (!variant.height || (variant.height >= min && variant.height <= max));
    }, this);
    if (filtered.length) return filtered;
    return this.variants.filter(function (variant) { return !this.blacklisted[variant.id] && capabilityAllowed(this, variant); }, this);
  };

  NativeHlsProvider.prototype._viewportMaxHeight = function () {
    var cfg = this.engine._player.config.abr.restrictions || {};
    if (cfg.ignoreViewportSize) return Infinity;
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
    var chosen = this._chooseForBudget(candidates, 0.8);
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
    var chosen = this._chooseForBudget(this._candidateVariants(), this.bandwidthSamples < 2 || ahead >= MIN_BUFFER_AHEAD ? 0.8 : 0.55);
    var reason = 'bandwidth';
    if (ahead < ABR_DOWNGRADE_BUFFER && this.bandwidthSamples >= 2) {
      this.bandwidth = previousBandwidth;
      chosen = this._chooseForBudget(this._candidateVariants(), 0.45);
      reason = 'low-buffer';
    }
    this.bandwidth = previousBandwidth;
    if (!chosen || chosen === previous) return;
    this.lastSwitchAt = now;
    if (chosen.height < previous.height || ahead >= ABR_UPGRADE_BUFFER) this._switchVariant(chosen, false, reason);
  };

  NativeHlsProvider.prototype.selectVariantTrack = function (track, clearBuffer) {
    var variant = this.variants.find(function (item) { return item.id === track.id || item.height === track.height; });
    if (!variant || !capabilityAllowed(this, variant)) return;
    this.manualTrackId = variant.id;
    this.engine._player.config.abr.enabled = false;
    this.lastSwitchAt = performance.now();
    this._switchVariant(variant, clearBuffer !== false, 'manual');
  };

  NativeHlsProvider.prototype.getVariantTracks = function () {
    var self = this;
    return this.variants.map(function (variant) {
      return {
        id: variant.id,
        bandwidth: variant.bandwidth || 0,
        width: variant.width || 0,
        height: variant.height || 0,
        codecs: variant.codecs || '',
        codecFamily: codecFamily(variant.codecs),
        capabilityStatus: capabilityStatus(variant.capability || defaultCapability(variant)),
        supported: capabilityAllowed(self, variant),
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
        return self._fetchRange(self.audioInitSegment.url, self.audioInitSegment.range, { phase: 'metadata' });
      }).then(function (initData) {
        return appendBuffer(self.audioSb, initData);
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
        source: 'native-hls',
        supported: true
      }, !!rendition.active);
    });
  };

  NativeHlsProvider.prototype.getActiveTextTrack = function () {
    var tracks = this.getTextTracks();
    for (var i = 0; i < tracks.length; i++) if (tracks[i].active) return tracks[i];
    return null;
  };

  NativeHlsProvider.prototype.selectTextTrack = function (track) {
    for (var i = 0; i < this.subtitleRenditions.length; i++) {
      this.subtitleRenditions[i].active = this.subtitleRenditions[i].id === track.id || this.subtitleRenditions[i].language === track.language;
    }
    this.engine._player.emit('texttrackchanged', this.getActiveTextTrack());
    return Promise.resolve();
  };

  NativeHlsProvider.prototype.setTextTrackVisibility = function (visible) {
    if (!visible) {
      for (var i = 0; i < this.subtitleRenditions.length; i++) this.subtitleRenditions[i].active = false;
    }
    this.engine._player.emit('texttrackchanged', this.getActiveTextTrack());
    return Promise.resolve();
  };

  NativeHlsProvider.prototype.isLive = function () {
    return !!this.live;
  };

  NativeHlsProvider.prototype.getStats = function () {
    var quality = this.video.getVideoPlaybackQuality ? this.video.getVideoPlaybackQuality() : null;
    return {
      provider: this.name,
      mode: 'hls',
      isLive: this.isLive(),
      assetUri: this.playlistUrl,
      bandwidthEstimate: Math.round(this.bandwidth || 0),
      bufferAhead: getBufferAhead(this.video),
      activeVariant: this.getActiveVariantTrack(),
      activeAudio: this.getActiveAudioTrack(),
      audioTrackCount: this.getAudioTracks().length,
      activeTextTrack: this.engine && this.engine._player ? this.engine._player.getActiveTextTrack() : null,
      textTrackCount: this.engine && this.engine._player ? this.engine._player.getTextTracks().length : 0,
      nativeAudioTrackCount: this.audioRenditions.length || 1,
      nativeTextTrackCount: this.subtitleRenditions.length,
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
      schedulerQueueDepth: appendQueueDepth(this.sb),
      schedulerBackpressureCount: this.schedulerBackpressureCount,
      schedulerDrainCount: this.schedulerDrainCount,
      startupBufferComplete: this.startupBufferComplete,
      startupBufferMs: this.startupBufferMs,
      lastSwitchReason: this.lastSwitchReason,
      liveWindow: this.getLiveRange(),
      liveLatency: this.liveLatency,
      atLiveEdge: this.atLiveEdge,
      effectiveBufferingGoal: this._bufferAheadGoal(),
      effectiveBufferBehind: this._bufferBehindGoal(),
      manifestCompatibilityWarnings: this.manifestCompatibilityWarnings,
      droppedFrames: quality ? quality.droppedVideoFrames : 0,
      totalFrames: quality ? quality.totalVideoFrames : 0,
      fatalError: ''
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

  NativeHlsProvider.prototype.destroy = function () {
    this.destroyed = true;
    clearTimeout(this.playlistRefreshTimer);
    if (this._boundWaiting) this.video.removeEventListener('waiting', this._boundWaiting);
    if (this._boundPlaying) this.video.removeEventListener('playing', this._boundPlaying);
    if (this._boundTick) this.video.removeEventListener('timeupdate', this._boundTick);
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
    this.activeTextTrackId = '';
    this.textTrackVisibility = false;
    this.textLoadStates = {};
    this.segmentCacheHitCount = 0;
    this.segmentCacheMissCount = 0;
    this.lastOfflineError = '';
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
    this.engine.setLive(this.live);
    this.unsupportedVideoCount = parsed.video.filter(function (rep) { return !isSupported(rep.mimeType, rep.codecs); }).length;
    this.unsupportedAudioCount = parsed.audio.filter(function (rep) { return !isSupported(rep.mimeType, rep.codecs); }).length;
    var supportedVideo = parsed.video.filter(function (rep) { return isSupported(rep.mimeType, rep.codecs); });
    var supportedAudio = parsed.audio.filter(function (rep) { return isSupported(rep.mimeType, rep.codecs); });
    return this._probeCapabilities(supportedVideo.concat(supportedAudio)).then(function () {
    self.videoReps = supportedVideo.filter(function (rep) { return self._isCapabilityAllowed(rep); });
    self.audioReps = supportedAudio.filter(function (rep) { return self._isCapabilityAllowed(rep); });
    self.unsupportedCapabilityCount = supportedVideo.concat(supportedAudio).length - self.videoReps.length - self.audioReps.length;
    if (self.unsupportedCapabilityCount > 0) {
      self.engine._telemetry.record('capability-skip', { unsupportedCapabilityCount: self.unsupportedCapabilityCount });
    }
    self.audioReps.sort(function (a, b) { return compareAudioReps(a, b); });
    self.audio = self.audioReps[0] || null;
    if (!self.videoReps.length) throw new Error('dash-no-supported-video');
    if (!self.audio) throw new Error('dash-no-supported-audio');
    self.videoReps.sort(function (a, b) { return compareVideoReps(a, b); });
    self.activeVideo = self.chooseVideoRep();
    self.startupBufferStartedAt = performance.now();
    console.log('[native-dash] selected video id=' + self.activeVideo.id + ' height=' + self.activeVideo.height + ' codec=' + self.activeVideo.codecs);

    self.engine._assetUri = self.manifestUrl;
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
      return appendBuffer(self.audioSb, self.audio.initData);
    }).then(function () {
      if (self.live) self._startNearLiveEdge();
      self._tick(true);
      self.fillTimer = setInterval(function () { self._tick(); }, 1000);
      self._scheduleManifestRefresh();
    });
  };

  NativeDashProvider.prototype._prepareRep = function (rep) {
    var self = this;
    if (rep.initData && rep.segments) return Promise.resolve(rep);
    if (rep.initUrl && rep.segments) {
      return this._fetchRange(rep.initUrl, rep.initRange || null, { measureBandwidth: false, phase: 'metadata' }).then(function (initData) {
        rep.initData = initData;
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
      rep.segments = parseSidx(parts[1], rep.indexRange.end);
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
    var attempts = opts.attempts || 3;
    var attempt = opts.attempt || 1;
    var phase = opts.phase || 'media';
    var controller = new AbortController();
    this.controllers.push(controller);
    var started = performance.now();
    var init = { headers: {}, signal: controller.signal };
    if (range) init.headers.Range = 'bytes=' + range.start + '-' + range.end;
    return fetch(stampUri(this.engine, url), init).then(function (resp) {
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
      if (!resp.ok && resp.status !== 206) {
        self.lastHttpStatus = resp.status;
        if (swInfo.offline) {
          self.lastOfflineError = 'offline-segment-http-' + resp.status;
          self.engine._recordOfflineError(new Error(self.lastOfflineError));
        }
        throw rangeHttpError(resp.status);
      }
      return resp.arrayBuffer().then(function (buf) {
        if (generation !== self.requestGeneration) throw abortError();
        if (opts.measureBandwidth !== false) {
          var elapsed = Math.max(1, performance.now() - started);
          self._recordBandwidthSample(buf.byteLength, elapsed);
        }
        return buf;
      });
    }).catch(function (err) {
      removeItem(self.controllers, controller);
      if (err.name === 'AbortError' || generation !== self.requestGeneration) throw abortError();
      if (attempt < attempts && isTransientRequestError(err)) {
        var delay = 250 * Math.pow(2, attempt - 1);
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
    return appendBuffer(sb, data, seg.appendWindow).catch(function (err) {
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
    if (rep.kind === 'video') {
      this.blacklisted[rep.id] = true;
      console.warn('[native-dash] append error for video id=' + rep.id + ', switching representation:', err.message);
      try {
        this._switchVideo(this.chooseVideoRep(), true);
      } catch (e) {
        this.engine._fallbackToShaka('native-video-append-exhausted');
      }
      return;
    }
    if (this.appendFailures >= 2) this.engine._fallbackToShaka('native-audio-append-failed');
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
    var cfg = this.engine._player.config.abr.restrictions || {};
    var min = cfg.minHeight || 0;
    var max = Math.min(cfg.maxHeight || Infinity, this._viewportMaxHeight());
    var playable = this.videoReps.filter(function (rep) {
      return !this.blacklisted[rep.id] && capabilityAllowed(this, rep);
    }, this);
    var filtered = playable.filter(function (rep) {
      return !rep.height || (rep.height >= min && rep.height <= max);
    });
    if (filtered.length) return filtered;
    var minOnly = playable.filter(function (rep) {
      return !rep.height || rep.height >= min;
    });
    if (minOnly.length) return minOnly;
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
    if (cfg.ignoreViewportSize) return Infinity;
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
          return appendBuffer(self.videoSb, rep.initData);
        });
      }
      return self._changeVideoTypeIfNeeded(rep).then(function () {
        return appendBuffer(self.videoSb, rep.initData).catch(function () {});
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
    return this.videoReps.map(function (rep) {
      var cap = rep.capability || defaultCapability(rep);
      return {
        id: rep.id,
        height: rep.height || 0,
        width: rep.width || 0,
        bandwidth: rep.bandwidth || 0,
        codecs: rep.codecs || '',
        codecFamily: codecFamily(rep.codecs),
        capabilityStatus: capabilityStatus(cap),
        supported: cap.supported !== false,
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
      smooth: !(rep.capability && rep.capability.smooth === false),
      powerEfficient: !!(rep.capability && rep.capability.powerEfficient === true),
      active: true
    };
  };

  NativeDashProvider.prototype.selectVariantTrack = function (track, clearBuffer) {
    var rep = this.videoReps.find(function (r) { return r.id === track.id || r.height === track.height; });
    if (!rep) return;
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
    this.activeTextTrackId = rep.id;
    this.textTrackVisibility = true;
    rep.loadState = rep.loadState || 'selected';
    this.engine._player.emit('texttrackchanged', this.getActiveTextTrack());
    return Promise.resolve();
  };

  NativeDashProvider.prototype.setTextTrackVisibility = function (visible) {
    this.textTrackVisibility = !!visible;
    if (!visible) this.activeTextTrackId = '';
    this.engine._player.emit('texttrackchanged', this.getActiveTextTrack());
    return Promise.resolve();
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
      return appendBuffer(self.audioSb, rep.initData);
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

  NativeDashProvider.prototype.seekToLiveEdge = function () {
    if (!this.live || !this.liveWindow) return;
    this.video.currentTime = Math.max(this.liveWindow.start, this.liveWindow.end - LIVE_TARGET_LATENCY);
    this._onSeek();
  };

  NativeDashProvider.prototype.getStats = function () {
    var quality = this.video.getVideoPlaybackQuality ? this.video.getVideoPlaybackQuality() : null;
    return {
      provider: this.name,
      mode: 'dash',
      isLive: this.isLive ? this.isLive() : false,
      assetUri: this.manifestUrl,
      bandwidthEstimate: Math.round(this.bandwidth || 0),
      lastBandwidthSample: Math.round(this.lastBandwidthSample || 0),
      bufferAhead: getBufferAhead(this.video),
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
      schedulerQueueDepth: this._schedulerQueueDepth ? this._schedulerQueueDepth() : 0,
      mediaFetchInFlightCount: countKeys(this.activeRanges),
      mediaFetchCompletedCount: this.mediaFetchCompletedCount || 0,
      mediaFetchCancelledCount: this.requestCancellationCount || 0,
      mediaFetchRetryCount: this.mediaFetchRetryCount || 0,
      mediaUrlRefreshCount: this.mediaUrlRefreshCount || 0,
      mediaFetchAverageMs: this.mediaFetchCompletedCount ? this.mediaFetchTotalMs / this.mediaFetchCompletedCount : 0,
      schedulerBackpressureCount: this.schedulerBackpressureCount || 0,
      schedulerDrainCount: this.schedulerDrainCount || 0,
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
      fatalError: '',
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

  NativeDashProvider.prototype.seekDuringRecovery = function (targetTime) {
    this.video.currentTime = targetTime;
    this._onSeek();
  };

  NativeDashProvider.prototype._onSeek = function () {
    if (this.destroyed) return;
    if (this.live && this.liveWindow) {
      var clamped = clamp(this.video.currentTime || 0, this.liveWindow.start, this.liveWindow.end);
      if (Math.abs(clamped - (this.video.currentTime || 0)) > 0.05) {
        this.video.currentTime = clamped;
      }
    }
    this.engine._setState('seeking');
    this.pendingSeek++;
    this._abortRequests();
    this.seekBufferPending = true;
    markSegmentsForTime(this.activeVideo, this.video.currentTime, this._bufferAheadGoal());
    markSegmentsForTime(this.audio, this.video.currentTime, this._bufferAheadGoal());
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
    var rebufferingGoal = this._rebufferingGoal ? this._rebufferingGoal() : 0.3;
    var readyGoal = this.seekBufferPending
      ? Math.min(this._seekBufferGoal ? this._seekBufferGoal() : STARTUP_BUFFER_GOAL, rebufferingGoal)
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
    return fetchManifest(this.manifestUrl, this.engine.streamToken).then(function (manifest) {
      var parsed = parseMPD(manifest.text || self.manifestText, manifest.url || self.manifestUrl);
      self.manifestText = manifest.text || self.manifestText;
      self.manifestRefreshReason = reason || (parsed.type === 'dynamic' ? 'live' : 'manual');
      self.minimumUpdatePeriod = parsed.minimumUpdatePeriod || self.minimumUpdatePeriod;
      self.liveWindow = parsed.liveWindow || self.liveWindow;
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
        var lower = this._lowerVideoRep();
        if (lower) {
          this.stallRecoveryStage = 2;
          this.blacklisted[this.activeVideo.id] = true;
          this._switchVideo(lower, true, 'stall-recovery');
          return;
        }
      }
      if (this.stallReports >= 3) {
        this.engine._fallbackToShaka('native-stall-exhausted');
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
    if (this._boundWaiting) this.video.removeEventListener('waiting', this._boundWaiting);
    if (this._boundPlaying) this.video.removeEventListener('playing', this._boundPlaying);
    try {
      if (this.mediaSource && this.mediaSource.readyState === 'open') this.mediaSource.endOfStream();
    } catch (e) {}
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
  };

  function ShakaFallbackProvider(engine, reason) {
    this.engine = engine;
    this.video = engine.video;
    this.name = 'shaka-fallback';
    this.isAdaptive = true;
    this.reason = reason;
    this.player = new shaka.Player();
    this.rebufferCount = 0;
    this.rebufferStartedAt = 0;
    this.rebufferDuration = 0;
    this.lastError = '';
  }

  ShakaFallbackProvider.prototype.load = function (url, startTime) {
    var self = this;
    shaka.polyfill.installAll();
    if (!shaka.Player.isBrowserSupported()) throw new Error('shaka-browser-unsupported');
    installShakaHttpPlugin(this.engine);
    return this.player.attach(this.video).then(function () {
      self.player.configure({
        abr: {
          enabled: true,
          useNetworkInformation: true,
          defaultBandwidthEstimate: 3000000,
          bandwidthUpgradeTarget: 0.85,
          bandwidthDowngradeTarget: 0.95,
          restrictions: {}
        },
        streaming: { bufferingGoal: 30, rebufferingGoal: 0.3, bufferBehind: 60 }
      });
      self.player.addEventListener('error', function (event) {
        var error = event.detail;
        if (error) {
          self.lastError = 'shaka-' + error.category + '-' + error.code;
          self.engine._telemetry.record('fatal-error', { lastError: self.lastError });
          console.debug('[player-engine] shaka error cat=' + error.category + ' code=' + error.code);
        }
      });
      self.video.addEventListener('waiting', self._boundWaiting = function () {
        if (self.rebufferStartedAt || self.video.paused || self.video.seeking) return;
        self.rebufferStartedAt = performance.now();
        self.rebufferCount++;
        self.engine._telemetry.record('rebuffer-start');
      });
      self.video.addEventListener('playing', self._boundPlaying = function () {
        if (!self.rebufferStartedAt) return;
        self.rebufferDuration += (performance.now() - self.rebufferStartedAt) / 1000;
        self.rebufferStartedAt = 0;
        self.engine._telemetry.record('rebuffer-end');
      });
      return self.player.load(url, startTime > 1 ? startTime : undefined);
    }).then(function () {
      self.engine._setState('ready');
      self.engine._player.emit('loaded');
      self.engine._player.emit('trackschanged');
    });
  };

  ShakaFallbackProvider.prototype.configure = function (config) {
    try { this.player.configure(config); } catch (e) {}
  };

  ShakaFallbackProvider.prototype.getVariantTracks = function () {
    try { return this.player.getVariantTracks(); } catch (e) { return []; }
  };

  ShakaFallbackProvider.prototype.getActiveVariantTrack = function () {
    var tracks = this.getVariantTracks();
    for (var i = 0; i < tracks.length; i++) {
      if (tracks[i].active) return tracks[i];
    }
    return null;
  };

  ShakaFallbackProvider.prototype.selectVariantTrack = function (track, clearBuffer) {
    try { this.player.selectVariantTrack(track, clearBuffer); } catch (e) {}
  };

  ShakaFallbackProvider.prototype.getAudioTracks = function () {
    try {
      if (this.player.getAudioTracks) return this.player.getAudioTracks();
      var variants = this.getVariantTracks();
      var seen = {};
      var tracks = [];
      for (var i = 0; i < variants.length; i++) {
        var key = variants[i].audioId || variants[i].language || 'default';
        if (seen[key]) continue;
        seen[key] = true;
        tracks.push({
          id: key,
          active: !!variants[i].active,
          language: variants[i].language || '',
          label: variants[i].label || variants[i].language || 'Default',
          bandwidth: variants[i].audioBandwidth || 0,
          codecs: variants[i].audioCodec || ''
        });
      }
      return tracks;
    } catch (e) { return []; }
  };

  ShakaFallbackProvider.prototype.getActiveAudioTrack = function () {
    var tracks = this.getAudioTracks();
    for (var i = 0; i < tracks.length; i++) {
      if (tracks[i].active) return tracks[i];
    }
    return tracks[0] || null;
  };

  ShakaFallbackProvider.prototype.selectAudioTrack = function (track) {
    try {
      if (this.player.selectAudioTrack) {
        this.player.selectAudioTrack(track);
      }
      this.engine._player.emit('audiotrackchanged', track);
    } catch (e) {}
  };

  ShakaFallbackProvider.prototype.isLive = function () {
    try { return this.player.isLive(); } catch (e) { return false; }
  };

  ShakaFallbackProvider.prototype.getStats = function () {
    var quality = this.video.getVideoPlaybackQuality ? this.video.getVideoPlaybackQuality() : null;
    var active = this.getActiveVariantTrack();
    return {
      provider: this.name,
      mode: 'fallback',
      isLive: this.isLive(),
      assetUri: this.engine.manifestUrl,
      fallbackReason: this.reason || this.engine._fallbackReason || '',
      bandwidthEstimate: 0,
      lastBandwidthSample: 0,
      bufferAhead: getBufferAhead(this.video),
      activeVariant: active,
      activeAudio: this.getActiveAudioTrack(),
      audioTrackCount: this.getAudioTracks().length,
      activeTextTrack: this.engine._player.getActiveTextTrack(),
      textTrackCount: this.engine._player.getTextTracks().length,
      lastSwitchReason: '',
      rebufferCount: this.rebufferCount,
      rebufferDuration: this.rebufferDuration + (this.rebufferStartedAt ? (performance.now() - this.rebufferStartedAt) / 1000 : 0),
      recoveryCount: 0,
      lastError: this.lastError,
      lastHttpStatus: 0,
      fatalError: '',
      droppedFrames: quality ? quality.droppedVideoFrames : 0,
      totalFrames: quality ? quality.totalVideoFrames : 0
    };
  };

  ShakaFallbackProvider.prototype.destroy = function () {
    if (this._boundWaiting) this.video.removeEventListener('waiting', this._boundWaiting);
    if (this._boundPlaying) this.video.removeEventListener('playing', this._boundPlaying);
    try { this.player.destroy(); } catch (e) {}
  };

  function installShakaHttpPlugin(engine) {
    if (!window.shaka || installShakaHttpPlugin.installed) return;
    function stamp(uri) { return stampUri(engine, uri); }
    function waitForServer() {
      if (!engine._serverDown) return Promise.resolve();
      return new Promise(function (resolve) { engine._heldRequests.push(resolve); });
    }
    function httpPlugin(uri, request, requestType, progressUpdated, headersReceived) {
      var abortController = new AbortController();
      var aborted = false;
      function doFetch() {
        if (aborted) return Promise.reject(new shaka.util.Error(shaka.util.Error.Severity.RECOVERABLE, shaka.util.Error.Category.NETWORK, shaka.util.Error.Code.OPERATION_ABORTED));
        var init = { method: request.method || 'GET', headers: request.headers || {}, signal: abortController.signal };
        if (request.body) init.body = request.body;
        var fetchUri = stamp(uri);
        return fetch(fetchUri, init).then(function (response) {
          if (response.status === 401 || response.status === 403 || response.status >= 500) {
            if (!engine._serverDown) engine._enterServerDown(response.status === 401 ? 'token-expired' : 'server-error');
            return waitForServer().then(doFetch);
          }
          if (requestType === shaka.net.NetworkingEngine.RequestType.MANIFEST) {
            var via = response.headers.get('x-stream-via');
            if (via) { engine._finalVia = via; engine.emit('via', via); }
            var dlHeight = response.headers.get('x-downloaded-height');
            if (dlHeight) engine.emit('downloaded-height', parseInt(dlHeight, 10));
          }
          var headers = {};
          response.headers.forEach(function (value, key) { headers[key] = value; });
          if (headersReceived) headersReceived(headers);
          return response.arrayBuffer().then(function (data) {
            if (progressUpdated) progressUpdated(0, data.byteLength, data.byteLength);
            return { uri: response.url || fetchUri, originalUri: uri, data: data, status: response.status, headers: headers, timeMs: 0 };
          });
        }).catch(function (err) {
          if (aborted || err.name === 'AbortError') throw new shaka.util.Error(shaka.util.Error.Severity.RECOVERABLE, shaka.util.Error.Category.NETWORK, shaka.util.Error.Code.OPERATION_ABORTED);
          if (!engine._serverDown) engine._enterServerDown('network-error');
          return waitForServer().then(doFetch);
        });
      }
      var promise = (engine._serverDown ? waitForServer() : Promise.resolve()).then(doFetch);
      return new shaka.util.AbortableOperation(promise, function () {
        aborted = true;
        abortController.abort();
        return Promise.resolve();
      });
    }
    var APP = shaka.net.NetworkingEngine.PluginPriority.APPLICATION;
    shaka.net.NetworkingEngine.registerScheme('http', httpPlugin, APP);
    shaka.net.NetworkingEngine.registerScheme('https', httpPlugin, APP);
    installShakaHttpPlugin.installed = true;
  }

  function fetchManifest(url, token) {
    if (url.indexOf('data:') === 0) {
      return Promise.resolve(decodeDataUri(url)).then(function (text) {
        return { url: url, text: text };
      });
    }
    return fetch(stampToken(url, token)).then(function (resp) {
      if (resp.status === 401 || resp.status === 403 || resp.status >= 500) {
        throw new Error('manifest-http-' + resp.status);
      }
      var ct = resp.headers.get('content-type') || '';
      var via = resp.headers.get('x-stream-via') || '';
      var downloadedHeight = parseInt(resp.headers.get('x-downloaded-height') || '0', 10);
      var swInfo = readServiceWorkerSource(resp);
      if (ct.indexOf('json') !== -1) {
        return resp.json().then(function (json) {
          return merge({ url: resp.url || url, json: json, via: via, downloadedHeight: downloadedHeight }, swInfo);
        });
      }
      return resp.text().then(function (text) {
        return merge({ url: resp.url || url, text: text, via: via, downloadedHeight: downloadedHeight }, swInfo);
      });
    });
  }

  function fetchText(url, token, onSource) {
    return fetch(stampToken(url, token)).then(function (resp) {
      var swInfo = readServiceWorkerSource(resp);
      if (onSource) onSource(swInfo);
      if (resp.status === 401 || resp.status === 403 || resp.status === 404 || resp.status === 410 || resp.status >= 500) {
        throw new Error('manifest-http-' + resp.status);
      }
      if (!resp.ok) throw new Error('manifest-http-' + resp.status);
      return resp.text();
    });
  }

  function parseHlsPlaylist(text, playlistUrl) {
    var lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
    var variants = [];
    var audioRenditions = [];
    var subtitleRenditions = [];
    var segments = [];
    var map = null;
    var encrypted = false;
    var discontinuity = false;
    var endList = false;
    var targetDuration = 0;
    var mediaSequence = 0;
    var pendingDuration = 0;
    var duration = 0;
    var timeline = 0;
    var nextRange = null;
    var lastRangeEnd = -1;
    var playlistCodecs = '';
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) continue;
      if (line.indexOf('#EXT-X-STREAM-INF') === 0) {
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
            active: false
          });
          if (codecs) playlistCodecs = codecs;
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
        if (type === 'AUDIO' && mediaItem.url) audioRenditions.push(mediaItem);
        if (type === 'SUBTITLES' && mediaItem.url) {
          mediaItem.mimeType = /ttml|xml/i.test(mediaItem.url) ? 'application/ttml+xml' : 'text/vtt';
          subtitleRenditions.push(mediaItem);
        }
      } else if (line.indexOf('#EXT-X-MAP') === 0) {
        var mapAttrs = hlsAttrs(line);
        map = {
          url: resolveUrl(unquote(mapAttrs.URI || ''), playlistUrl),
          range: hlsByteRange(unquote(mapAttrs.BYTERANGE || ''), -1)
        };
      } else if (line.indexOf('#EXT-X-KEY') === 0) {
        var keyAttrs = hlsAttrs(line);
        if (String(keyAttrs.METHOD || '').toUpperCase() !== 'NONE') encrypted = true;
      } else if (line.indexOf('#EXT-X-DISCONTINUITY') === 0) {
        discontinuity = true;
      } else if (line.indexOf('#EXT-X-TARGETDURATION') === 0) {
        targetDuration = parseFloat(line.split(':')[1] || '0') || 0;
        timeline = mediaSequence * targetDuration;
        duration = timeline;
      } else if (line.indexOf('#EXT-X-MEDIA-SEQUENCE') === 0) {
        mediaSequence = parseInt(line.split(':')[1] || '0', 10) || 0;
        timeline = mediaSequence * (targetDuration || 0);
        duration = timeline;
      } else if (line.indexOf('#EXT-X-ENDLIST') === 0) {
        endList = true;
      } else if (line.indexOf('#EXTINF') === 0) {
        pendingDuration = parseFloat((line.split(':')[1] || '').split(',')[0]) || 0;
      } else if (line.indexOf('#EXT-X-BYTERANGE') === 0) {
        nextRange = hlsByteRange(line.split(':')[1] || '', lastRangeEnd);
      } else if (line.charAt(0) !== '#') {
        var range = nextRange;
        if (range) lastRangeEnd = range.end;
        segments.push({
          start: timeline,
          end: timeline + pendingDuration,
          duration: pendingDuration,
          mediaSequence: mediaSequence + segments.length,
          url: resolveUrl(line, playlistUrl),
          range: range
        });
        timeline += pendingDuration;
        duration = timeline;
        pendingDuration = 0;
        nextRange = null;
      }
    }
    return {
      variants: variants,
      audioRenditions: audioRenditions,
      subtitleRenditions: subtitleRenditions,
      segments: segments,
      map: map,
      encrypted: encrypted,
      discontinuity: discontinuity,
      endList: endList,
      targetDuration: targetDuration,
      mediaSequence: mediaSequence,
      duration: duration,
      codecs: playlistCodecs
    };
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

  function hlsByteRange(value, lastEnd) {
    var m = String(value || '').match(/^(\d+)(?:@(\d+))?$/);
    if (!m) return null;
    var length = parseInt(m[1], 10);
    var start = m[2] ? parseInt(m[2], 10) : lastEnd + 1;
    return { start: start, end: start + length - 1 };
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
    var cached = resp.headers.get('x-sw-cached') === '1' || resp.headers.get('x-sw-cache') === '1';
    var offline = resp.headers.get('x-sw-offline') === '1';
    var source = resp.headers.get('x-sw-source') || '';
    return {
      swCached: cached,
      swOffline: offline,
      swSource: source,
      cached: cached,
      offline: offline,
      source: source
    };
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

  function loadShaka() {
    if (window.shaka && window.shaka.Player) return Promise.resolve();
    if (loadShaka.promise) return loadShaka.promise;
    loadShaka.promise = new Promise(function (resolve, reject) {
      var script = document.createElement('script');
      script.src = SHAKA_URL;
      script.async = true;
      script.onload = function () { resolve(); };
      script.onerror = function () { reject(new Error('shaka-script-load-failed')); };
      document.head.appendChild(script);
    });
    return loadShaka.promise;
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
    var periodNodes = directChildren(mpd, 'Period');
    if (type === 'dynamic') {
      if (!mpd.getAttribute('availabilityStartTime')) throw new Error('dash-live-ast-missing');
    }
    var reps = [];
    var textReps = [];
    var mpdBase = directChildText(mpd, 'BaseURL');
    var mpdTemplate = directChild(mpd, 'SegmentTemplate');
    var mpdList = segmentListChain([], directChild(mpd, 'SegmentList'));
    var periods = periodNodes.length ? periodNodes : [mpd];
    for (var p = 0; p < periods.length; p++) {
      var period = periods[p];
      var periodStart = period.localName === 'Period' ? parseDuration(period.getAttribute('start')) : 0;
      if (!isFinite(periodStart)) periodStart = inferPeriodStart(periods, p);
      var periodDuration = period.localName === 'Period' ? parseDuration(period.getAttribute('duration')) : duration;
      var periodEnd = isFinite(periodDuration) ? periodStart + periodDuration : inferPeriodEnd(periods, p, duration);
      if (!isFinite(periodDuration) && isFinite(periodEnd)) periodDuration = periodEnd - periodStart;
      var periodBase = resolveBaseUrl(mpdBase, directChildText(period, 'BaseURL'), manifestUrl);
      var periodDirectTemplate = directChild(period, 'SegmentTemplate');
      var periodDirectList = directChild(period, 'SegmentList');
      var periodTemplate = periodDirectTemplate || (periodDirectList ? null : mpdTemplate);
      var periodList = segmentListChain(periodDirectTemplate ? [] : mpdList, periodDirectList);
      var sets = period.querySelectorAll('AdaptationSet');
      for (var i = 0; i < sets.length; i++) {
      var set = sets[i];
      if (set.querySelector('ContentProtection')) throw new Error('dash-drm-unsupported');
      var setMime = set.getAttribute('mimeType') || '';
      var setBase = resolveBaseUrl(periodBase, directChildText(set, 'BaseURL'), manifestUrl);
      var setDirectTemplate = directChild(set, 'SegmentTemplate');
      var setDirectList = directChild(set, 'SegmentList');
      var setTemplate = setDirectTemplate || (setDirectList ? null : periodTemplate);
      var setList = segmentListChain(setDirectTemplate ? [] : periodList, setDirectList);
      var setRoles = descriptorValues(set, 'Role');
      var setAccessibility = descriptorValues(set, 'Accessibility');
      var setLabel = directChildText(set, 'Label') || set.getAttribute('label') || '';
      var setChannels = descriptorValues(set, 'AudioChannelConfiguration');
      var repNodes = set.querySelectorAll('Representation');
      for (var j = 0; j < repNodes.length; j++) {
        var r = repNodes[j];
        if (r.querySelector('ContentProtection')) throw new Error('dash-drm-unsupported');
        var baseText = resolveBaseUrl(setBase, directChildText(r, 'BaseURL'), manifestUrl);
        var segBase = directChild(r, 'SegmentBase');
        var repDirectTemplate = directChild(r, 'SegmentTemplate');
        var repDirectList = directChild(r, 'SegmentList');
        var segTemplate = repDirectTemplate || (repDirectList ? null : setTemplate);
        var segList = segmentListChain(repDirectTemplate ? [] : setList, repDirectList);
        var init = segBase && segBase.querySelector('Initialization');
        var mimeType = r.getAttribute('mimeType') || setMime;
        var codecs = r.getAttribute('codecs') || '';
        var kind = mimeType.indexOf('audio/') === 0 ? 'audio' : (isTextMime(mimeType) ? 'text' : 'video');
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
          asr: parseInt(r.getAttribute('audioSamplingRate') || '0', 10),
          language: language,
          label: label,
        roles: roles,
        accessibility: accessibility,
        channels: channels,
          periodIndex: p,
          source: kind === 'text' ? 'native-dash' : ''
        };
        if (kind === 'text') {
          rep.supported = isSupportedTextMime(mimeType);
          rep.url = directChildText(r, 'BaseURL')
            ? resolveBaseUrl(setBase, directChildText(r, 'BaseURL'), manifestUrl)
            : (directChildText(set, 'BaseURL') ? setBase : '');
          textReps.push(rep);
          continue;
        }
        if (segBase && init) {
          if (!baseText) continue;
          rep.baseUrl = resolveUrl(baseText, manifestUrl);
          rep.initRange = parseRange(init.getAttribute('range'));
          rep.indexRange = parseRange(segBase.getAttribute('indexRange'));
          reps.push(rep);
          continue;
        }
        if (segTemplate) {
          var templateData = parseSegmentTemplate(segTemplate, rep, baseText, manifestUrl, isFinite(periodDuration) ? periodDuration : duration, type, periodStart, periodEnd, warnings);
          if (templateData) {
            rep.initUrl = templateData.initUrl;
            rep.templateSegments = templateData.segments;
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
            reps.push(rep);
          }
        }
      }
    }
    }
    if (!reps.length && doc.querySelector('SegmentTemplate')) throw new Error(type === 'dynamic' ? 'dash-live-template-unsupported' : 'dash-template-unsupported');
    if (!reps.length && doc.querySelector('SegmentList')) throw new Error('dash-segmentlist-unsupported');
    reps = mergePeriodRepresentations(reps);
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
      video: reps.filter(function (r) { return r.kind === 'video'; }),
      audio: reps.filter(function (r) { return r.kind === 'audio'; }),
      text: mergeTextRepresentations(textReps)
    };
  }

  function parseSegmentTemplate(node, rep, baseText, manifestUrl, duration, mpdType, periodStart, periodEnd, warnings) {
    var initPattern = node.getAttribute('initialization') || '';
    var mediaPattern = node.getAttribute('media') || '';
    if (!initPattern || !mediaPattern) return null;
    var timescale = parseInt(node.getAttribute('timescale') || '1', 10) || 1;
    var startNumber = parseInt(node.getAttribute('startNumber') || '1', 10) || 1;
    var pto = parseInt(node.getAttribute('presentationTimeOffset') || '0', 10) || 0;
    var base = resolveUrl(baseText || '', manifestUrl);
    var timeline = directChild(node, 'SegmentTimeline');
    if (mpdType === 'dynamic' && !timeline) throw new Error('dash-live-template-unsupported');
    var segments = timeline
      ? templateTimelineSegments(timeline, mediaPattern, rep, base, timescale, startNumber, pto, periodStart || 0, periodEnd, duration, warnings)
      : templateNumberSegments(node, mediaPattern, rep, base, timescale, startNumber, duration, periodStart || 0, periodEnd);
    if (!segments.length) return null;
    return {
      initUrl: resolveUrl(expandTemplateUrl(initPattern, rep, startNumber, 0), base),
      segments: segments
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

  function isSupportedTextMime(mimeType) {
    return /text\/vtt|application\/vtt|application\/ttml\+xml/i.test(mimeType || '');
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

  function mergePeriodRepresentations(reps) {
    var byKey = {};
    var merged = [];
    for (var i = 0; i < reps.length; i++) {
      var rep = reps[i];
      var key = rep.kind + ':' + rep.id;
      var existing = byKey[key];
      if (!existing) {
        byKey[key] = rep;
        merged.push(rep);
        continue;
      }
      if (existing.mimeType !== rep.mimeType || existing.codecs !== rep.codecs) {
        throw new Error('dash-multiperiod-codec-unsupported');
      }
      if (existing.templateSegments && rep.templateSegments) {
        existing.templateSegments = existing.templateSegments.concat(rep.templateSegments);
        existing.templateSegments.sort(function (a, b) { return a.start - b.start; });
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

  function appendBuffer(sb, data, appendWindow) {
    return queueSourceBuffer(sb, function () {
      return waitForSourceBufferIdle(sb).then(function () {
        return new Promise(function (resolve, reject) {
          function cleanup() {
            sb.removeEventListener('updateend', onEnd);
            sb.removeEventListener('error', onError);
          }
          function onEnd() { cleanup(); resolve(); }
          function onError() { cleanup(); reject(new Error('sourcebuffer-error')); }
          sb.addEventListener('updateend', onEnd);
          sb.addEventListener('error', onError);
          try {
            if (appendWindow) {
              sb.appendWindowStart = appendWindow.start;
              sb.appendWindowEnd = appendWindow.end;
            }
            sb.appendBuffer(data);
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
      function done() {
        sb.removeEventListener('updateend', done);
        resolve();
      }
      sb.addEventListener('updateend', done);
    });
  }

  function getBufferAhead(video) {
    var buf = video.buffered;
    var ct = video.currentTime || 0;
    for (var i = 0; i < buf.length; i++) {
      if (ct >= buf.start(i) - 0.5 && ct <= buf.end(i)) return buf.end(i) - ct;
    }
    return 0;
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
      } else if (seg.state === 'failed') {
        seg.state = 'pending';
        seg.appended = false;
      }
    }
  }

  function isSegmentBusyOrDone(seg) {
    return seg.appended || seg.state === 'fetching' || seg.state === 'fetched' || seg.state === 'appending' || seg.state === 'appended';
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
    for (var i = 0; i < rep.segments.length; i++) {
      var other = rep.segments[i];
      if (other === seg || other.state === 'expired' || other.end <= currentTime - 0.5 || other.start >= seg.start) continue;
      if (other.state === 'fetching' || other.state === 'fetched' || other.state === 'appending') return true;
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
        seg.appended = old.appended;
        seg.state = old.state === 'failed' || old.state === 'recovering' || old.state === 'fetching' ? '' : old.state;
      }
      return seg;
    });
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
    return (seg.url || String(seg.start)) + range;
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
    return !!(err && /range-http-(403|404|410|416|5\d\d)|Failed to fetch|Load failed|network/i.test(err.message || ''));
  }

  function mime(rep) {
    return rep.mimeType + '; codecs="' + rep.codecs + '"';
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
      supported: rep.supported !== false,
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
    var base = uri.replace(/[?&]token=[^&]*/, '');
    return base + (base.indexOf('?') === -1 ? '?' : '&') + 'token=' + token;
  }

  function isLikelyNativeUrl(url) {
    return /\.(m3u8|mp4|m4v|webm)(\?|$)/i.test(url);
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
  window.NativeDashProviderForTest = {
    _candidateVideos: NativeDashProvider.prototype._candidateVideos,
    _chooseForBudget: NativeDashProvider.prototype._chooseForBudget,
    _appendSegmentData: NativeDashProvider.prototype._appendSegmentData,
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
    _jumpSmallGap: NativeDashProvider.prototype._jumpSmallGap,
    _refreshManifest: NativeDashProvider.prototype._refreshManifest,
    _updateLiveWindowFromReps: NativeDashProvider.prototype._updateLiveWindowFromReps,
    _updateLivePositionStats: NativeDashProvider.prototype._updateLivePositionStats,
    _evictExpiredLiveSegmentState: NativeDashProvider.prototype._evictExpiredLiveSegmentState,
    _switchAudio: NativeDashProvider.prototype._switchAudio,
    _maybeSwitchAuto: NativeDashProvider.prototype._maybeSwitchAuto,
    _recordBandwidthSample: NativeDashProvider.prototype._recordBandwidthSample,
    _fetchRange: NativeDashProvider.prototype._fetchRange,
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
    getLiveRange: NativeDashProvider.prototype.getLiveRange,
    getStats: NativeDashProvider.prototype.getStats,
    reportStall: NativeDashProvider.prototype.reportStall,
    seekToLiveEdge: NativeDashProvider.prototype.seekToLiveEdge,
    selectAudioTrack: NativeDashProvider.prototype.selectAudioTrack,
    selectVariantTrack: NativeDashProvider.prototype.selectVariantTrack,
    parseMPD: parseMPD,
    parseHlsPlaylist: parseHlsPlaylist,
    compareAudioReps: compareAudioReps
  };
  window.NativeHlsProviderForTest = {
    _appendSegmentData: NativeHlsProvider.prototype._appendSegmentData,
    _recoverQuota: NativeHlsProvider.prototype._recoverQuota,
    _handleAppendFailure: NativeHlsProvider.prototype._handleAppendFailure,
    _probeCapabilities: NativeHlsProvider.prototype._probeCapabilities,
    _isCapabilityAllowed: NativeHlsProvider.prototype._isCapabilityAllowed,
    _candidateVariants: NativeHlsProvider.prototype._candidateVariants,
    _chooseForBudget: NativeHlsProvider.prototype._chooseForBudget,
    _lowerVariant: NativeHlsProvider.prototype._lowerVariant,
    _fetchRange: NativeHlsProvider.prototype._fetchRange,
    _fetchPlaylistText: NativeHlsProvider.prototype._fetchPlaylistText,
    _recordServiceWorkerFetch: NativeHlsProvider.prototype._recordServiceWorkerFetch,
    _recordOfflineHttpError: NativeHlsProvider.prototype._recordOfflineHttpError,
    _jumpSmallGap: NativeHlsProvider.prototype._jumpSmallGap,
    reportStall: NativeHlsProvider.prototype.reportStall,
    chooseVariant: NativeHlsProvider.prototype.chooseVariant,
    getVariantTracks: NativeHlsProvider.prototype.getVariantTracks,
    selectVariantTrack: NativeHlsProvider.prototype.selectVariantTrack,
    getStats: NativeHlsProvider.prototype.getStats
  };
})();
