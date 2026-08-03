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
  var ABR_DOWNGRADE_BUFFER = 4;
  var BANDWIDTH_FAST_HALF_LIFE = 3;
  var BANDWIDTH_SLOW_HALF_LIFE = 9;
  var MIN_BANDWIDTH_SAMPLE_MS = 50;
  var DEFAULT_TIME_TO_FIRST_BYTE_MS = 100;
  var FRAME_SAMPLE_INTERVAL_MS = 2000;
  var FRAME_DROP_RATIO_THRESHOLD = 0.08;
  var FRAME_DROP_MIN_COUNT = 6;
  var LIVE_TARGET_LATENCY = 6;
  var LIVE_MAX_LATENCY = 18;
  var LIVE_BUFFER_AHEAD = 30;
  var LIVE_BUFFER_BEHIND = 8;
  var LOW_LATENCY_BUFFER_AHEAD = 4;
  var MAX_GAP_JUMP = 0.75;
  var STARTUP_BUFFER_GOAL = 4;
  var MAX_CONCURRENT_MEDIA_REQUESTS = 3;
  var DEFAULT_BANDWIDTH_ESTIMATE = 500000;
  var SOURCEBUFFER_WATCHDOG_MS = 1200;
  var SEGMENT_BUSY_WATCHDOG_MS = 2500;
  var MAX_NETWORK_HOLD_CYCLES = 2;
  var MANIFEST_REQUEST_TIMEOUT_MS = 120000;
  var SEGMENT_REQUEST_TIMEOUT_MS = 20000;
  var AUX_REQUEST_TIMEOUT_MS = 15000;
  var STARTUP_STALL_RECOVERY_MS = 8000;
  var PLAYBACK_STALL_RECOVERY_MS = 14000;
  var STARTUP_READY_TIMEOUT_MS = 30000;
  var BUFFERED_SEEK_PADDING = 0.05;
  var TS_STARTUP_ALIGNMENT_MIN_GAP = 0.1;

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
    this._serverProbeController = null;
    this._serverProbeTimeoutMs = Math.max(100, Number(opts.serverProbeTimeoutMs) || 5000);
    this._refreshTokenPromise = null;
    this._cleanups = [];
    this._initialized = false;
    this._provider = null;
    this._providerName = '';
    this._finalVia = '';
    this._state = 'idle';
    this._fallbackReason = '';
    this._nativeTerminalReason = '';
    this._terminalError = null;
    this._terminalErrorGeneration = -1;
    this._terminalErrorPhase = '';
    this._terminalErrorCount = 0;
    this._loadStartedAt = 0;
    this._loadGeneration = 0;
    this._startupTransaction = null;
    this._startupReadyGeneration = -1;
    this._startupReadyTimeoutMs = Math.max(250, Number(opts.startupReadyTimeoutMs) || STARTUP_READY_TIMEOUT_MS);
    this._offlinePlayback = false;
    this._manifestFromServiceWorker = false;
    this._lastOfflineError = '';
    this._internalStallWatch = true;
    this._stallWatchTimer = 0;
    this._stallWatchLastTime = -1;
    this._stallWatchLastProgressAt = 0;
    this._stallWatchWaiting = false;
    this._stallWatchReportCount = 0;
    var configuredStallRecoveryDelay = Number(opts.stallRecoveryDelayMs) || 0;
    this._stallRecoveryDelayMs = configuredStallRecoveryDelay > 0
      ? Math.max(100, configuredStallRecoveryDelay)
      : 0;
    this.recovering = false;
    this.recoveryTransition = false;
    this.networkTrouble = false;
    this._networkingEngine = new NativeNetworkingEngine(this);
    this._player = new PlayerAdapter(this);
    // Production builds split telemetry out of the critical playback bundle.
    // The source build remains self-contained for debugging and direct use.
    this._telemetry = new (window.PlayerTelemetry || PlayerTelemetry)(this);
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
    this._startInternalStallWatch();
    this._listen(this.video, 'timeupdate', function () {
      if (!self.video.seeking && !self.video.paused && isFinite(self.video.currentTime)) {
        self.lastGoodTime = self.video.currentTime;
      }
    });
    this._listen(this.video, 'waiting', function () {
      if (self.video.ended || self.destroyed) return;
      var currentTime = Number(self.video.currentTime) || 0;
      var waitingStarted = !self._stallWatchWaiting;
      self._stallWatchWaiting = true;
      // Some media stacks emit repeated `waiting` events while remaining in
      // the same stalled state. Only the edge into waiting (or real clock
      // movement) starts a new watchdog window; repeated events must not keep
      // postponing recovery forever.
      if (waitingStarted || self._stallWatchLastTime < 0 || Math.abs(currentTime - self._stallWatchLastTime) >= 0.1) {
        self._stallWatchLastTime = currentTime;
        self._stallWatchLastProgressAt = Date.now();
      }
    });
    this._listen(this.video, 'playing', function () {
      self._stallWatchWaiting = false;
      self._stallWatchLastTime = Number(self.video.currentTime) || 0;
      self._stallWatchLastProgressAt = Date.now();
    });
    this._listen(this.video, 'pause', function () { self._resetInternalStallWatch(); });
    this._listen(this.video, 'ended', function () { self._resetInternalStallWatch(); });
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
          self._completeNativeTerminalError(
            nativeTerminalError(self._provider, 'video-error-' + e.code),
            { phase: 'runtime' }
          );
        });
      }
    });
    return Promise.resolve();
  };

  PlayerEngine.prototype._startInternalStallWatch = function () {
    if (this._stallWatchTimer) return;
    var self = this;
    var intervalMs = this._stallRecoveryDelayMs
      ? Math.max(50, Math.min(1000, this._stallRecoveryDelayMs / 2))
      : 1000;
    this._stallWatchTimer = setInterval(function () {
      if (
        self.destroyed
        || self._state === 'error'
        || self.video.ended
        || self.video.seeking
        || self.isRecovering()
        || (self.video.paused && !self._stallWatchWaiting)
      ) {
        if (!self._stallWatchWaiting) self._resetInternalStallWatch();
        return;
      }
      var now = Date.now();
      var currentTime = Number(self.video.currentTime) || 0;
      if (self._stallWatchLastTime < 0 || Math.abs(currentTime - self._stallWatchLastTime) >= 0.1) {
        self._stallWatchLastTime = currentTime;
        self._stallWatchLastProgressAt = now;
        return;
      }
      var providerStarted = !!(self._provider && self._provider.startupBufferComplete);
      var threshold = self._stallRecoveryDelayMs
        || (providerStarted ? PLAYBACK_STALL_RECOVERY_MS : STARTUP_STALL_RECOVERY_MS);
      if (!self._stallWatchLastProgressAt) self._stallWatchLastProgressAt = now;
      if (now - self._stallWatchLastProgressAt < threshold) return;
      self._stallWatchLastProgressAt = now;
      self._stallWatchReportCount++;
      self._telemetry.record('stall-watchdog', {
        startup: !providerStarted,
        currentTime: currentTime
      });
      self.reportStall();
    }, intervalMs);
  };

  PlayerEngine.prototype._resetInternalStallWatch = function () {
    this._stallWatchWaiting = false;
    this._stallWatchLastTime = -1;
    this._stallWatchLastProgressAt = 0;
  };

  PlayerEngine.prototype._stopInternalStallWatch = function () {
    if (this._stallWatchTimer) clearInterval(this._stallWatchTimer);
    this._stallWatchTimer = 0;
    this._resetInternalStallWatch();
  };

  PlayerEngine.prototype.getPlayer = function () { return this._player; };
  PlayerEngine.prototype.getVia = function () { return this._finalVia; };
  PlayerEngine.prototype.configure = function () { return this._player.configure.apply(this._player, arguments); };
  PlayerEngine.prototype.setTextController = function (controller) { this._textController = controller; };
  PlayerEngine.prototype.setLive = function (live) { this.isLive = live; };
  PlayerEngine.prototype.isRecovering = function () { return this._serverDown || this._recovering; };

  PlayerEngine.prototype._cancelStartupReadiness = function (err) {
    var transaction = this._startupTransaction;
    if (!transaction || transaction.settled) return false;
    transaction.settled = true;
    transaction.error = err || abortError();
    if (transaction.timer) clearTimeout(transaction.timer);
    transaction.timer = 0;
    var waiters = transaction.waiters.splice(0);
    for (var i = 0; i < waiters.length; i++) waiters[i].reject(transaction.error);
    return true;
  };

  PlayerEngine.prototype._beginStartupReadiness = function (generation) {
    this._cancelStartupReadiness(abortError());
    this._startupTransaction = {
      generation: generation,
      provider: null,
      attached: false,
      settled: false,
      ready: false,
      error: null,
      timer: 0,
      waiters: []
    };
    return this._startupTransaction;
  };

  PlayerEngine.prototype._markStartupAttached = function (provider, generation) {
    generation = generation == null ? this._loadGeneration : generation;
    var transaction = this._startupTransaction;
    if (
      !transaction
      || transaction.settled
      || transaction.generation !== generation
      || generation !== this._loadGeneration
      || this.destroyed
      || (provider && this._provider !== provider)
    ) return false;
    if (transaction.provider && transaction.provider !== provider) return false;
    transaction.provider = provider || this._provider;
    transaction.attached = true;
    if (transaction.provider) transaction.provider.loadGeneration = generation;
    if (this._state === 'loading') this._setState('buffering');
    if (!transaction.timer) {
      var self = this;
      transaction.timer = setTimeout(function () {
        if (self._startupTransaction !== transaction || transaction.settled) return;
        var err = nativeTerminalError(transaction.provider, 'startup-buffer-timeout');
        err.name = 'TimeoutError';
        self._telemetry.record('startup-buffer-timeout', { loadGeneration: generation });
        self._setRecovering(true);
        self._rejectStartupReadiness(transaction, err);
      }, this._startupReadyTimeoutMs);
    }
    return true;
  };

  PlayerEngine.prototype._rejectStartupReadiness = function (transaction, err) {
    if (!transaction || transaction !== this._startupTransaction || transaction.settled) return false;
    transaction.settled = true;
    transaction.error = err || nativeTerminalError(transaction.provider, 'startup-buffer-failed');
    if (transaction.timer) clearTimeout(transaction.timer);
    transaction.timer = 0;
    var waiters = transaction.waiters.splice(0);
    for (var i = 0; i < waiters.length; i++) waiters[i].reject(transaction.error);
    return true;
  };

  PlayerEngine.prototype._markStartupReady = function (provider, generation) {
    generation = generation == null ? this._loadGeneration : generation;
    var transaction = this._startupTransaction;
    if (
      !transaction
      || transaction.settled
      || transaction.generation !== generation
      || generation !== this._loadGeneration
      || this.destroyed
      || (provider && this._provider !== provider)
    ) return false;
    if (!transaction.attached && !this._markStartupAttached(provider, generation)) return false;
    if (transaction.provider && provider && transaction.provider !== provider) return false;
    transaction.settled = true;
    transaction.ready = true;
    if (transaction.timer) clearTimeout(transaction.timer);
    transaction.timer = 0;
    this._startupReadyGeneration = generation;
    this._recovering = false;
    var seekInProgress = !!(provider && (provider.seekBufferPending || provider.seekInteractionPending));
    if (!this._serverDown && !seekInProgress) this._setState('ready');
    var detail = { loadGeneration: generation, provider: this._providerName || '' };
    this.emit('startup-ready', detail);
    if (this._player) this._player.emit('startupready', detail);
    var waiters = transaction.waiters.splice(0);
    for (var i = 0; i < waiters.length; i++) waiters[i].resolve(detail);
    return true;
  };

  PlayerEngine.prototype.waitForStartupReady = function (generation) {
    generation = generation == null ? this._loadGeneration : generation;
    var transaction = this._startupTransaction;
    if (generation !== this._loadGeneration || this.destroyed) return Promise.reject(abortError());
    if (this._startupReadyGeneration === generation) {
      return Promise.resolve({ loadGeneration: generation, provider: this._providerName || '' });
    }
    if (!transaction || transaction.generation !== generation) {
      return Promise.reject(abortError());
    }
    if (transaction.ready) return Promise.resolve({ loadGeneration: generation, provider: this._providerName || '' });
    if (transaction.error) return Promise.reject(transaction.error);
    return new Promise(function (resolve, reject) {
      transaction.waiters.push({ resolve: resolve, reject: reject });
    });
  };

  PlayerEngine.prototype.load = function (url, startTime, mimeType) {
    var self = this;
    if (this.destroyed) return Promise.reject(new Error('player-destroyed'));
    var generation = ++this._loadGeneration;
    this._beginStartupReadiness(generation);
    this._resetInternalStallWatch();
    url = url || this.manifestUrl;
    this._pendingLoadStartTime = isFinite(Number(startTime)) && Number(startTime) >= 0 ? Number(startTime) : null;
    this.setLive(false);
    this._loadStartedAt = performance.now();
    this._nativeTerminalReason = '';
    this._terminalError = null;
    this._terminalErrorGeneration = -1;
    this._terminalErrorPhase = '';
    this._telemetry.record('load-start');
    this._setState('loading');
    return Promise.resolve().then(function () {
      return self._loadNative(url, mimeType, generation);
    }).then(function () {
      if (generation !== self._loadGeneration) throw abortError();
      if (self._terminalError && self._terminalErrorGeneration === generation) throw self._terminalError;
      return seekToStartTime(self, startTime);
    }).then(function (value) {
      if (generation !== self._loadGeneration) throw abortError();
      // Test and extension providers opt into the readiness contract
      // explicitly; all built-in providers do so below.
      if (!self._provider || !self._provider._usesStartupReadiness) return value;
      return self.waitForStartupReady(generation).then(function () { return value; });
    }).catch(function (err) {
      if (generation !== self._loadGeneration || err && err.name === 'AbortError') throw abortError();
      if (err && err.serverError) throw err;
      self._recordOfflineLoadFailure(err);
      var terminalError = isNativeTerminalError(err)
        ? err
        : nativeTerminalError(self._provider, err && err.message ? err.message : 'native-load-failed');
      throw self._completeNativeTerminalError(terminalError, { phase: 'load', generation: generation });
    }).then(function (value) {
      if (generation === self._loadGeneration) self._pendingLoadStartTime = null;
      return value;
    }, function (err) {
      if (generation === self._loadGeneration) self._pendingLoadStartTime = null;
      throw err;
    });
  };

  PlayerEngine.prototype._loadNative = function (url, mimeType, generation) {
    var self = this;
    if (generation != null && generation !== this._loadGeneration) return Promise.reject(abortError());
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
      if (generation != null && generation !== self._loadGeneration) throw abortError();
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

  PlayerEngine.prototype._completeNativeTerminalError = function (err, options) {
    options = options || {};
    var generation = options.generation == null ? this._loadGeneration : options.generation;
    if (generation !== this._loadGeneration) return abortError();
    if (this._terminalError && this._terminalErrorGeneration === generation) return this._terminalError;
    var reason = err && err.message ? err.message : 'native-unsupported';
    if (!isNativeTerminalError(err)) err = nativeTerminalError(this._provider, reason);
    var phase = options.phase || (this._state === 'loading' ? 'load' : 'runtime');
    err.nativeTerminal = true;
    err.phase = phase;
    err.loadGeneration = generation;
    err.provider = this._providerName || 'native-terminal';
    this._nativeTerminalReason = reason;
    this._terminalError = err;
    this._terminalErrorGeneration = generation;
    this._terminalErrorPhase = phase;
    this._terminalErrorCount++;
    if (this._startupTransaction && this._startupTransaction.generation === generation) {
      this._rejectStartupReadiness(this._startupTransaction, err);
    }
    if (this._provider) {
      this._provider.lastError = reason;
      this._provider.fatalError = reason;
      this._provider.nativeUnsupportedReason = reason;
    } else {
      this._providerName = this._providerName || 'native-terminal';
      window._playerProvider = this._providerName;
    }
    if (this._provider && this._provider.quiesce) {
      try { this._provider.quiesce('terminal-' + phase); } catch (quiesceError) {
        console.warn('[player-engine] provider terminal quiesce failed:', quiesceError);
      }
    }
    this._recovering = false;
    this._serverDown = false;
    this._stopServerProbe();
    this._clearHeldRequests('player-terminal');
    try { if (!this.video.paused) this.video.pause(); } catch (pauseError) {}
    this._setState('error');
    this._telemetry.record('native-unsupported', {
      lastError: reason,
      hlsEncryptionMethod: err && err.hlsEncryptionMethod ? err.hlsEncryptionMethod : '',
      hlsKeyFormat: err && err.hlsKeyFormat ? err.hlsKeyFormat : ''
    });
    var detail = {
      error: err,
      reason: reason,
      phase: phase,
      loadGeneration: generation,
      provider: err.provider
    };
    this.emit('terminal-error', detail);
    if (this._player) this._player.emit('error', detail);
    return err;
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

  PlayerEngine.prototype._recordOfflineLoadFailure = function (err) {
    if (this._offlinePlayback || this._manifestFromServiceWorker || !isOnline()) {
      this._recordOfflineError(err);
    }
  };

  PlayerEngine.prototype._setState = function (state) {
    if (this._state === state) return;
    var previousState = this._state;
    this._state = state;
    this.recovering = state === 'recovering';
    this.recoveryTransition = state === 'recovering' || state === 'seeking';
    this.networkTrouble = this._serverDown;
    console.debug('[player-engine] state=' + state + ' provider=' + (this._providerName || 'none'));
    var detail = { state: state, previousState: previousState, loadGeneration: this._loadGeneration };
    this.emit('state-change', detail);
    if (this._player) this._player.emit('statechanged', detail);
  };

  PlayerEngine.prototype._setRecovering = function (recovering) {
    this._recovering = recovering;
    var startupPending = !!(this._startupTransaction && !this._startupTransaction.settled);
    this._setState(recovering ? 'recovering' : (startupPending ? 'buffering' : 'ready'));
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
      var controller = new AbortController();
      self._serverProbeController = controller;
      var probeTimeout = setTimeout(function () { controller.abort(); }, self._serverProbeTimeoutMs);
      fetch(self.manifestUrl, { method: 'HEAD', signal: controller.signal })
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
          clearTimeout(probeTimeout);
          if (self._serverProbeController === controller) self._serverProbeController = null;
          if (!self._serverDown || self.destroyed) return;
          self._serverProbeTimer = setTimeout(probe, 3000 + Math.random() * 2000);
        });
    }
    probe();
  };

  PlayerEngine.prototype._stopServerProbe = function () {
    if (this._serverProbeTimer) { clearTimeout(this._serverProbeTimer); this._serverProbeTimer = null; }
    if (this._serverElapsedTimer) { clearInterval(this._serverElapsedTimer); this._serverElapsedTimer = null; }
    if (this._serverProbeController) {
      try { this._serverProbeController.abort(); } catch (e) {}
      this._serverProbeController = null;
    }
  };

  PlayerEngine.prototype._exitServerDown = function () {
    if (!this._serverDown) return;
    this._serverDown = false;
    this.networkTrouble = false;
    this._stopServerProbe();
    this.lastGoodTime = Math.max(this.lastGoodTime, this.video.currentTime || 0);
    console.log('[player-engine] server back, releasing ' + this._heldRequests.length + ' held requests');
    if (this._provider && this._provider.resumeAfterServerRecovery) {
      try { this._provider.resumeAfterServerRecovery(); } catch (e) {
        console.warn('[player-engine] provider server recovery failed:', e);
      }
    }
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
    if (this._refreshingToken) return this._refreshTokenPromise || Promise.resolve();
    this._refreshingToken = true;
    var self = this;
    var authFailure = false;
    this._refreshTokenPromise = fetch('/watch/token?v=' + encodeURIComponent(this.videoId))
      .then(function (r) {
        var contentType = r.headers.get('Content-Type') || '';
        var redirectedToLogin = r.redirected && /\/auth\/login(?:\?|$)/.test(r.url || '');
        if (r.status === 401 || r.status === 403 || redirectedToLogin || (r.ok && contentType.indexOf('json') === -1)) {
          authFailure = true;
        }
        if (!r.ok) throw new Error('Token refresh failed: ' + r.status);
        if (authFailure) throw new Error('Token refresh requires authentication');
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
      .catch(function (err) {
        self._refreshingToken = false;
        if (self.destroyed) return;
        if (authFailure) {
          self._stopServerProbe();
          self._serverDown = false;
          self.networkTrouble = false;
          self._clearHeldRequests('auth-expired');
          self.emit('auth-expired');
          return;
        }
        // A restarting or temporarily unavailable server is not an expired
        // browser session. Keep the request held and let the probe retry.
        console.warn('[player-engine] token refresh deferred:', err && err.message ? err.message : err);
      })
      .then(function () {
        self._refreshTokenPromise = null;
      });
    return this._refreshTokenPromise;
  };

  PlayerEngine.prototype._getBufferAhead = function () {
    return getBufferAhead(this.video);
  };

  PlayerEngine.prototype.unload = function () {
    this._loadGeneration++;
    this._cancelStartupReadiness(abortError());
    this._pendingLoadStartTime = null;
    this._resetInternalStallWatch();
    this._stopServerProbe();
    this._clearHeldRequests('player-unloaded');
    this._serverDown = false;
    this._recovering = false;
    this.recovering = false;
    this.recoveryTransition = false;
    this.networkTrouble = false;
    this._networkHoldStartedAt = 0;
    this._fallbackReason = '';
    this._nativeTerminalReason = '';
    this._terminalError = null;
    this._terminalErrorGeneration = -1;
    this._terminalErrorPhase = '';
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
    this._loadGeneration++;
    this._cancelStartupReadiness(abortError());
    this._pendingLoadStartTime = null;
    this._stopInternalStallWatch();
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
    this.playIntentAt = 0;
    this.firstPlayingAt = 0;
    this.seekStartedAt = 0;
    this.lastSeekLatencyMs = 0;
    this.firstFrameMeasurementStarted = false;
    this.firstFrameBaselineTime = 0;
    this.firstFrameCallbackId = 0;
    this.firstFrameAnimationId = 0;
    this.destroyed = false;
    this.unloadSummaryRecorded = false;
    this._onLoadedData = null;
    this._onPlay = null;
    this._onPlaying = null;
    this._onSeeking = null;
    this._onSeeked = null;
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
      if (self.playIntentAt) self._startFirstFrameMeasurement();
    };
    this._onPlay = function () {
      if (!self.playIntentAt) self.playIntentAt = performance.now();
      self._startFirstFrameMeasurement();
    };
    this._onPlaying = function () {
      if (!self.firstPlayingAt) {
        self.firstPlayingAt = performance.now();
        self.record('playback-started');
      }
    };
    this._onSeeking = function () {
      if (!self.seekStartedAt) self.seekStartedAt = performance.now();
    };
    this._onSeeked = function () {
      if (!self.seekStartedAt) return;
      self.lastSeekLatencyMs = Math.max(0, performance.now() - self.seekStartedAt);
      self.seekStartedAt = 0;
      self.record('seek-complete', { seekLatencyMs: self.lastSeekLatencyMs });
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
    video.addEventListener('play', this._onPlay);
    video.addEventListener('playing', this._onPlaying);
    video.addEventListener('seeking', this._onSeeking);
    video.addEventListener('seeked', this._onSeeked);
    video.addEventListener('error', this._onError);
    window.addEventListener('pagehide', this._onPageHide);
    window.addEventListener('beforeunload', this._onBeforeUnload);
  };

  PlayerTelemetry.prototype._startFirstFrameMeasurement = function () {
    if (this.destroyed || this.firstFrameAt || this.firstFrameMeasurementStarted) return;
    var video = this.engine && this.engine.video;
    if (!video || !this.playIntentAt) return;
    var self = this;
    this.firstFrameMeasurementStarted = true;
    this.firstFrameBaselineTime = Number(video.currentTime) || 0;

    function frameHasAdvanced(metadata) {
      var mediaTime = metadata && Number(metadata.mediaTime);
      return !video.paused && (
        (isFinite(mediaTime) && mediaTime > self.firstFrameBaselineTime + 0.001)
        || Number(video.currentTime) > self.firstFrameBaselineTime + 0.001
      );
    }

    function finish(now, metadata) {
      self.firstFrameCallbackId = 0;
      self.firstFrameAnimationId = 0;
      if (self.destroyed || self.firstFrameAt) return;
      if (!frameHasAdvanced(metadata)) {
        schedule();
        return;
      }
      self.firstFrameAt = isFinite(now) ? now : performance.now();
      self.record('first-frame');
    }

    function schedule() {
      if (self.destroyed || self.firstFrameAt) return;
      if (video.requestVideoFrameCallback) {
        self.firstFrameCallbackId = video.requestVideoFrameCallback(finish);
        return;
      }
      self.firstFrameAnimationId = requestAnimationFrame(function (now) {
        finish(now, { mediaTime: Number(video.currentTime) || 0 });
      });
    }

    schedule();
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
      networkTimeoutCount: stats.networkTimeoutCount || 0,
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
      videoStartupMs: this.firstFrameAt && this.playIntentAt ? Math.round(this.firstFrameAt - this.playIntentAt) : 0,
      playToPlayingMs: this.firstPlayingAt && this.playIntentAt ? Math.round(this.firstPlayingAt - this.playIntentAt) : 0,
      pageToFirstFrameMs: this.firstFrameAt ? Math.round(this.firstFrameAt) : 0,
      startupBufferMs: stats.startupBufferMs || 0,
      seekLatencyMs: this.lastSeekLatencyMs || 0,
      at: engine.video && isFinite(engine.video.currentTime) ? engine.video.currentTime : 0,
      ts: Date.now()
    };
    if (extra) merge(event, extra);
    // Scheduler and media completion events can fire for every segment. Keep
    // the newest cumulative snapshot for these event types instead of sending
    // a request-sized telemetry stream back to the application server.
    var coalesced = type === 'media-fetch-complete'
      || type === 'scheduler-drain'
      || type === 'scheduler-backpressure';
    var replaced = false;
    if (coalesced) {
      for (var eventIndex = this.events.length - 1; eventIndex >= 0; eventIndex--) {
        if (this.events[eventIndex].type === type) {
          this.events[eventIndex] = event;
          replaced = true;
          break;
        }
      }
    }
    if (!replaced) this.events.push(event);
    if (this.events.length > 30) this.events.splice(0, this.events.length - 30);
    this.scheduleFlush(
      type === 'fatal-error'
      || type === 'video-error'
      || type === 'native-unsupported'
      || type === 'server-down'
      || type === 'recovery'
      || type === 'first-frame'
    );
  };

  PlayerTelemetry.prototype.scheduleFlush = function (urgent) {
    var self = this;
    if (this.flushTimer) {
      if (!urgent) return;
      clearTimeout(this.flushTimer);
    }
    this.flushTimer = setTimeout(function () {
      self.flushTimer = 0;
      self.flush();
    }, urgent ? 250 : 2000);
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
        if (navigator.sendBeacon('/api/player-events', blob)) {
          if (this.events.length) this.scheduleFlush(false);
          return;
        }
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
    if (this.events.length) this.scheduleFlush(false);
  };

  PlayerTelemetry.prototype.destroy = function () {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = 0;
    }
    var video = this.engine && this.engine.video;
    if (video && this.firstFrameCallbackId && video.cancelVideoFrameCallback) {
      try { video.cancelVideoFrameCallback(this.firstFrameCallbackId); } catch (e) {}
    }
    if (this.firstFrameAnimationId) cancelAnimationFrame(this.firstFrameAnimationId);
    this.firstFrameCallbackId = 0;
    this.firstFrameAnimationId = 0;
    if (video && this._onLoadedData) video.removeEventListener('loadeddata', this._onLoadedData);
    if (video && this._onPlay) video.removeEventListener('play', this._onPlay);
    if (video && this._onPlaying) video.removeEventListener('playing', this._onPlaying);
    if (video && this._onSeeking) video.removeEventListener('seeking', this._onSeeking);
    if (video && this._onSeeked) video.removeEventListener('seeked', this._onSeeked);
    if (video && this._onError) video.removeEventListener('error', this._onError);
    if (this._onPageHide) window.removeEventListener('pagehide', this._onPageHide);
    if (this._onBeforeUnload) window.removeEventListener('beforeunload', this._onBeforeUnload);
    this._onLoadedData = null;
    this._onPlay = null;
    this._onPlaying = null;
    this._onSeeking = null;
    this._onSeeked = null;
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
        // Start conservatively and promote from measured segment throughput.
        // Navigator.connection is frequently coarse or reports the host link
        // rather than the effective path to the media origin.
        useNetworkInformation: false,
        // Match the mature Hls.js cold-start prior: a slow first connection is
        // much more expensive than one early conservative rendition, and real
        // segment samples promote quality immediately after playback begins.
        defaultBandwidthEstimate: DEFAULT_BANDWIDTH_ESTIMATE,
        bandwidthUpgradeTarget: 0.85,
        bandwidthDowngradeTarget: 0.95,
        capLevelOnFPSDrop: true,
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
      networkHoldMs: 0,
      networkTimeoutCount: 0
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
    var attemptStarted = performance.now();
    var init = {
      method: request.method || "GET",
      headers: request.headers || {}
    };
    var timedSignal = createTimedRequestSignal(opts.signal, networkTimeoutFor(type, opts));
    init.signal = timedSignal.signal;
    if (request.body != null) init.body = request.body;
    return fetch(fetchUri, init).then(function (resp) {
      var responseStarted = performance.now();
      return resp.arrayBuffer().then(function (data) {
        var completed = performance.now();
        timedSignal.cleanup();
        var elapsed = Math.max(0, completed - started);
        var response = {
          uri: resp.url || fetchUri,
          originalUri: uri,
          data: data,
          status: resp.status,
          headers: headersToObject(resp.headers),
          timeMs: Math.max(0, completed - attemptStarted),
          timeToFirstByteMs: Math.max(0, responseStarted - attemptStarted),
          downloadTimeMs: Math.max(0, completed - responseStarted)
        };
        self._recordResponse(type, resp.status, elapsed);
        if (shouldHoldNetworkResponse(self.engine, type, response, opts)) {
          return self._holdAndRetry(type, request, opts, started, networkHoldReasonForStatus(resp.status), resp.status);
        }
        return applyNetworkFilters(self.responseFilters, type, response, "response", self).then(function () {
          return response;
        });
      });
    }).then(function (response) {
      timedSignal.cleanup();
      return response;
    }, function (err) {
      var timedOut = timedSignal.timedOut();
      timedSignal.cleanup();
      if (timedOut) {
        self.stats.networkTimeoutCount++;
        err = networkTimeoutError();
      }
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
    opts.__networkHoldAttempts = (opts.__networkHoldAttempts || 0) + 1;
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
    this._usesStartupReadiness = true;
    this.retryCount = 0;
    this.recoveryCount = 0;
    this.rebufferCount = 0;
    this.rebufferStartedAt = 0;
    this.rebufferDuration = 0;
    this.lastError = '';
    this.fatalError = '';
    this.nativeUnsupportedReason = '';
    this.assetUri = '';
    this.startupBufferComplete = false;
    this.startupBufferStartedAt = 0;
    this.startupBufferMs = 0;
    this.destroyed = false;
    this._terminalQuiesced = false;
    this._loadCleanup = null;
    this._rejectLoad = null;
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
        if (self._loadCleanup === cleanup) self._loadCleanup = null;
        self._rejectLoad = null;
      }
      function onLoaded() {
        if (self.destroyed) {
          cleanup();
          reject(abortError());
          return;
        }
        cleanup();
        self.video.addEventListener('waiting', self._boundWaiting = function () { self._onWaiting(); });
        self.video.addEventListener('playing', self._boundPlaying = function () { self._onPlaying(); });
        self.video.addEventListener('error', self._boundRuntimeError = function () { self._onRuntimeError(); });
        var initialTarget = pendingLoadStartTime(self);
        if (initialTarget != null) assignInternalMediaTime(self, initialTarget);
        self.startupBufferStartedAt = performance.now();
        self._boundStartupReady = function () { self._checkStartupReady(); };
        self.video.addEventListener('loadeddata', self._boundStartupReady);
        self.video.addEventListener('canplay', self._boundStartupReady);
        self.video.addEventListener('playing', self._boundStartupReady);
        if (self.engine && self.engine._markStartupAttached) self.engine._markStartupAttached(self);
        self.engine._player.emit('loaded');
        resolve();
        self._checkStartupReady();
      }
      function onError() {
        if (self.destroyed) {
          cleanup();
          reject(abortError());
          return;
        }
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
      self._loadCleanup = cleanup;
      self._rejectLoad = reject;
      self.video.addEventListener('loadedmetadata', onLoaded);
      self.video.addEventListener('error', onError);
    });
  };

  NativeUrlProvider.prototype._checkStartupReady = function () {
    if (this.destroyed || this.startupBufferComplete) return false;
    if (!this.video || this.video.readyState < 2) return false;
    var ready = markStartupBufferReady(this);
    if (this.startupBufferComplete) this._clearStartupReadyListeners();
    return ready;
  };

  NativeUrlProvider.prototype._clearStartupReadyListeners = function () {
    if (!this._boundStartupReady) return;
    this.video.removeEventListener('loadeddata', this._boundStartupReady);
    this.video.removeEventListener('canplay', this._boundStartupReady);
    this.video.removeEventListener('playing', this._boundStartupReady);
    this._boundStartupReady = null;
  };

  NativeUrlProvider.prototype.quiesce = function () {
    if (this._terminalQuiesced) return false;
    this._terminalQuiesced = true;
    this.destroyed = true;
    var rejectLoad = this._rejectLoad;
    if (this._loadCleanup) this._loadCleanup();
    if (rejectLoad) {
      try { rejectLoad(abortError()); } catch (e) {}
    }
    if (this._boundWaiting) this.video.removeEventListener('waiting', this._boundWaiting);
    if (this._boundPlaying) this.video.removeEventListener('playing', this._boundPlaying);
    if (this._boundRuntimeError) this.video.removeEventListener('error', this._boundRuntimeError);
    this._clearStartupReadyListeners();
    return true;
  };

  NativeUrlProvider.prototype.destroy = function () {
    this.quiesce('destroy');
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
      startupBufferComplete: this.startupBufferComplete,
      startupBufferMs: this.startupBufferMs,
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
    if (this.destroyed) return;
    if (this.rebufferStartedAt || this.video.paused || this.video.seeking) return;
    this.rebufferStartedAt = performance.now();
    this.rebufferCount++;
    this.lastError = getBufferAhead(this.video) < 0.5 ? 'buffer-underrun' : this.lastError;
    this.engine._telemetry.record('rebuffer-start');
  };

  NativeUrlProvider.prototype._onPlaying = function () {
    if (this.destroyed) return;
    if (!this.rebufferStartedAt) return;
    this.rebufferDuration += (performance.now() - this.rebufferStartedAt) / 1000;
    this.rebufferStartedAt = 0;
    this.engine._telemetry.record('rebuffer-end');
  };

  NativeUrlProvider.prototype._onRuntimeError = function () {
    if (this.destroyed) return;
    var mediaError = this.video.error;
    if (mediaError && mediaError.code === 2 && isOnline() && this.engine && !this.engine._serverDown) {
      this.lastError = 'native-url-network-error';
      this.engine._enterServerDown(this.lastError);
      return;
    }
    if (this.engine && this.engine._serverDown) return;
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

  NativeUrlProvider.prototype.resumeAfterServerRecovery = function () {
    if (this.destroyed || !this.engine || this.engine.destroyed) return;
    var position = this.engine.lastGoodTime || this.video.currentTime || 0;
    var wasLive = this.isLive();
    var shouldResume = !this.video.paused;
    var self = this;
    this.recoveryCount++;
    this.lastError = 'server-recovery';
    this.assetUri = stampUri(this.engine, this.url);
    this.video.addEventListener('loadedmetadata', function restoreAfterServerRecovery() {
      if (!wasLive && position > 0) {
        try { self.video.currentTime = position; } catch (e) {}
      }
      if (shouldResume) self.video.play().catch(function () {});
    }, { once: true });
    this.video.src = this.assetUri;
    this.video.load();
  };

  function NativeHlsProvider(engine, playlistUrl) {
    this.engine = engine;
    this.video = engine.video;
    this.playlistUrl = playlistUrl;
    this.name = 'native-hls';
    this.isAdaptive = true;
    this._usesStartupReadiness = true;
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
    this._terminalQuiesced = false;
    this.bandwidth = engine._player.config.abr.defaultBandwidthEstimate || DEFAULT_BANDWIDTH_ESTIMATE;
    this.bandwidthSamples = 0;
    this.lastBandwidthSample = 0;
    this.bandwidthFast = 0;
    this.bandwidthSlow = 0;
    this.bandwidthFastAccumulator = 0;
    this.bandwidthSlowAccumulator = 0;
    this.bandwidthFastWeight = 0;
    this.bandwidthSlowWeight = 0;
    this.bandwidthTtfbEstimate = DEFAULT_TIME_TO_FIRST_BYTE_MS;
    this.bandwidthTtfbAccumulator = 0;
    this.bandwidthTtfbWeight = 0;
    this.lastSwitchAt = 0;
    this.variantSwitchInFlight = false;
    this.pendingManualVariantSwitch = null;
    this.pendingAudioTrackSwitch = null;
    this.trackTransitionGeneration = 0;
    this.trackTransitionInFlight = null;
    this.trackTransitionCommitCount = 0;
    this.trackTransitionRollbackCount = 0;
    this.trackTransitionRollbackFailureCount = 0;
    this.lastFrameSampleAt = 0;
    this.lastDroppedFrames = 0;
    this.lastTotalFrames = 0;
    this.frameDropDownswitchCount = 0;
    this.lastFrameDropRatio = 0;
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
    this.manifestGapJumpCount = 0;
    this.lastManifestGapSize = 0;
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
    this.lastPlaylistRefreshAdvanced = false;
    this.blockingReloadRequestCount = 0;
    this.blockingReloadResponseCount = 0;
    this.blockingReloadFallbackCount = 0;
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
    this.hlsSegmentLedgerReconcileCount = 0;
    this.hlsSegmentLedgerInvalidationCount = 0;
    this.startupBufferComplete = false;
    this.startupBufferStartedAt = 0;
    this.startupBufferMs = 0;
    this.seekBufferPending = false;
    this.seekInteractionPending = false;
    this.seekBufferReadyCount = 0;
    this.bufferedSeekCount = 0;
    this.seekCount = 0;
    this.seekCancelCount = 0;
    this.seekAbortCount = 0;
    this.seekGeneration = 0;
    this.activeSeekGeneration = 0;
    this.completedSeekGeneration = 0;
    this.lastSeekTarget = 0;
    this.lastSeekStartedAt = 0;
    this.lastSeekMs = 0;
    this._lastSeekHandledTarget = null;
    this._lastSeekHandledAt = 0;
    this._lastSeekHandledGeneration = 0;
    this.lastSwitchReason = 'startup';
    this.liveWindow = null;
    this.liveLatency = 0;
    this.atLiveEdge = false;
    this.startupLiveTarget = null;
    this.liveWindowDriftRecoveryCount = 0;
    this.videoDuration = 0;
    this.videoEndList = false;
    this.audioEndList = null;
    this.liveToVodTransitionCount = 0;
    this.vodEndOfStreamCount = 0;
    this.vodEndOfStreamPending = false;
    this.vodEndOfStreamRetryCount = 0;
    this.vodEndOfStreamRefillPending = false;
    this.vodEndOfStreamReopenCount = 0;
    this.vodFinalDuration = 0;
    this._vodEndOfStreamRetryAttempt = 0;
    this._vodEndOfStreamScheduled = false;
    this._vodEndOfStreamRetryTimer = 0;
    this.mediaSequence = 0;
    this.discontinuitySequence = 0;
    this.discontinuityCount = 0;
    this.playlistRefreshFailed = false;
    this.staleManifestResponseCount = 0;
    this.playlistCursorByUrl = {};
    this.playlistResetCandidateByUrl = {};
    this.playlistEpochByUrl = {};
    this.playlistEpochResetCount = 0;
    this.lastPlaylistEpochResetTrack = '';
    this.lastPlaylistEpochResetOffset = 0;
    this.playlistEpochHoldCount = 0;
    this.lastPlaylistEpochHoldReason = '';
    this.hlsInitTimescaleByKey = {};
    this.hlsInitTrackInfoByKey = {};
    this.hlsInitTimescaleParseFailureCount = 0;
    this.hlsFragmentTimestampParseCount = 0;
    this.hlsFragmentTimestampFallbackCount = 0;
    this.hlsTimestampResolutionRetryCount = 0;
    this.hlsTimestampResolutionFailureCount = 0;
    this.lastHlsFragmentDecodeTime = 0;
    this.lastHlsFragmentTimestampOffset = 0;
    this.hlsTimestampGenerationByKey = {};
    this.hlsTimestampGenerationResolutionCount = 0;
    this.hlsDiscontinuityTimestampResolutionCount = 0;
    this.hlsDiscontinuityTimestampFallbackCount = 0;
    this.hlsInitMapSwitchCount = 0;
    this.hlsInitGenerationRefreshCount = 0;
    this.hlsContainerDetectionCount = 0;
    this.hlsContainerMismatchCount = 0;
    this.hlsTransmuxedTimestampResolutionCount = 0;
    this.hlsTimestampGenerationPruneCount = 0;
    this.hlsTsTimelineByGeneration = {};
    this.hlsTsSharedDemuxCount = 0;
    this.hlsTsTimestampRolloverCount = 0;
    this.hlsTsOutOfOrderSegmentCount = 0;
    this.hlsTsCompositionOffsetSampleCount = 0;
    this.hlsTsMaxCompositionOffsetMs = 0;
    this.hlsTsMuxedAvStartOffsetMs = 0;
    this.hlsTsInitAppendCount = 0;
    this.hlsTsInitSkipCount = 0;
    this.hlsTsMuxedQuotaRetryCount = 0;
    this.hlsTsMuxedQuotaAudioResumeCount = 0;
    this.hlsTsMuxedQuotaVideoResumeCount = 0;
    this.hlsAppendEpoch = 0;
    this.hlsAppendInvalidationCount = 0;
    this.hlsStaleAppendAbortCount = 0;
    this.hlsStaleRecoveryAbortCount = 0;
    this.lastHlsAppendInvalidationReason = '';
    this.hlsQuotaForwardEvictionCount = 0;
    this.hlsQuotaDownswitchCount = 0;
    this.hlsMuxedWatchdogCompletionCount = 0;
    this.hlsMuxedAppendLedger = {};
    this.hlsMuxedPartialCarryCount = 0;
    this.hlsMuxedLedgerResumeCount = 0;
    this.hlsMuxedLedgerCompletionCount = 0;
    this.encryptedInitSegmentCount = 0;
    this.lastHlsTimestampGenerationKey = '';
    this.playlistRefreshGeneration = 0;
    this.playlistManifestCommitGeneration = 0;
    this.playlistManifestStageCount = 0;
    this.playlistManifestCommitCount = 0;
    this.playlistManifestDiscardCount = 0;
    this.playlistManifestCommitInProgress = false;
    this.playlistRefreshPromise = null;
    this.playlistRefreshKey = '';
    this.playlistRefreshReasonInFlight = '';
    this.trackLifecyclePromise = null;
    this._sourceBufferVideoInitSegment = null;
    this._sourceBufferAudioInitSegment = null;
    this._appendedVideoInitGenerationKey = '';
    this._appendedAudioInitGenerationKey = '';
    this.videoSourceBufferMime = '';
    this.audioSourceBufferMime = '';
    this.trackActivationCount = 0;
    this.trackSuppressionCount = 0;
    this.sourceBufferTypeChangeCount = 0;
    this.sourceBufferTypeRebuildCount = 0;
    this.sourceBufferTypeRollbackCount = 0;
    this.suppressedAudioGapTrack = false;
    this.suppressedVideoGapTrack = false;
    this.suppressedGapTrackCount = 0;
    this.lastManifestGapTrack = '';
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
    this.partialSegmentGapCount = 0;
    this.preloadHintRequestCount = 0;
    this.preloadHintCount = 0;
    this.preloadHintReuseCount = 0;
    this.preloadHintDiscardCount = 0;
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

  NativeHlsProvider.prototype._loadMediaPlaylist = function (text, url, expectedVariant, preparedPlaylist) {
    var previousCursor = hlsDeliveryCursor(this);
    var previousSignature = hlsTrackSignature(this);
    var parsed = preparedPlaylist || parseHlsPlaylist(text, url);
    if (parsed.unsupportedEncryption) throw hlsUnsupportedEncryptionError(this, parsed);
    var isTs = hasMpegTsSegments(parsed.segments) || !parsed.map;
    if (!parsed.map && !isTs) throw new Error('hls-playlist-unsupported');
    if (!parsed.segments.length) throw new Error('hls-playlist-unsupported');
    if (expectedVariant && expectedVariant !== this.activeVariant) {
      this.staleManifestResponseCount = (this.staleManifestResponseCount || 0) + 1;
      return hlsTrackRefreshOutcome('video', false, true, false, false);
    }
    if (this.videoEndList && !parsed.endList) {
      this.staleManifestResponseCount = (this.staleManifestResponseCount || 0) + 1;
      return hlsTrackRefreshOutcome('video', false, true, false, false);
    }
    if (!acceptHlsPlaylistCursor(this, url, parsed, 'video')) {
      this.staleManifestResponseCount = (this.staleManifestResponseCount || 0) + 1;
      return hlsTrackRefreshOutcome('video', false, true, false, false);
    }
    applyHlsPlaylistEpoch(this, url, parsed, this.segments, 'video');
    assignHlsTimestampGenerations(this, url, parsed, 'video');
    if (parsed._hlsEpochReset) clearHlsPreloadHintEpochState(this);
    else reconcileHlsPreloadHints(this, this, parsed);
    this.segments = parsed._hlsEpochReset
      ? parsed.segments
      : (mergeSegmentState(this.segments, parsed.segments) || parsed.segments);
    pruneHlsTimestampGenerations(this);
    this.initSegment = parsed.map;
    this.isTsPlaylist = isTs;
    this.lowLatencyPlaylist = !!parsed.lowLatencyPlaylist;
    this.partialSegmentCount = parsed.partialSegmentCount || 0;
    this.partialSegmentGapCount = parsed.partialSegmentGapCount || 0;
    this.partTargetDuration = parsed.partTargetDuration || 0;
    this.preloadHints = parsed.preloadHints || [];
    this.serverControl = parsed.serverControl || null;
    this.preloadHintCount = parsed.preloadHints ? parsed.preloadHints.length : 0;
    this.renditionReportCount = parsed.renditionReports ? parsed.renditionReports.length : 0;
    this.skippedSegmentCount = parsed.skippedSegmentCount || 0;
    this.manifestCompatibilityWarnings = mergeUnique(this.manifestCompatibilityWarnings, parsed.warnings || []);
    this.videoDuration = parsed.duration || 0;
    this.videoEndList = this.videoEndList || !!parsed.endList;
    this._syncPresentationState();
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
    if (this.playlistRefreshCount === 0) this.lastPlaylistRefreshAdvanced = true;
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
      return Promise.all([
        this._ensureTsTransmuxer('video', codecs),
        this.muxedTsAudio
          ? this._ensureTsTransmuxer('audio', this.activeVariant.audioCodecs || audioCodecsOnly(rawCodecs) || 'mp4a.40.2')
          : Promise.resolve()
      ]).then(function () {
        var outcome = hlsTrackRefreshOutcome(
          'video',
          true,
          false,
          !!parsed._hlsEpochReset || hlsCursorAdvanced(previousCursor, hlsDeliveryCursor(this)),
          previousSignature !== hlsTrackSignature(this)
        );
        outcome.epochReset = !!parsed._hlsEpochReset;
        outcome.playlistEpoch = parsed._hlsPlaylistEpoch || 0;
        return outcome;
      }.bind(this));
    }
    var outcome = hlsTrackRefreshOutcome(
      'video',
      true,
      false,
      !!parsed._hlsEpochReset || hlsCursorAdvanced(previousCursor, hlsDeliveryCursor(this)),
      previousSignature !== hlsTrackSignature(this)
    );
    outcome.epochReset = !!parsed._hlsEpochReset;
    outcome.playlistEpoch = parsed._hlsPlaylistEpoch || 0;
    return outcome;
  };

  NativeHlsProvider.prototype._loadAudioPlaylist = function (text, url, expectedAudio, preparedPlaylist) {
    var previousCursor = hlsDeliveryCursor(this.activeAudio);
    var previousSignature = hlsTrackSignature(this.activeAudio);
    var parsed = preparedPlaylist || parseHlsPlaylist(text, url);
    if (parsed.unsupportedEncryption) throw hlsUnsupportedEncryptionError(this, parsed);
    var isTs = hasMpegTsSegments(parsed.segments) || !parsed.map;
    if ((!parsed.map && !isTs) || !parsed.segments.length) throw new Error(isTs ? 'hls-mpegts-unsupported' : 'hls-audio-playlist-unsupported');
    if (!this.activeAudio) throw new Error('hls-audio-unavailable');
    if (expectedAudio && expectedAudio !== this.activeAudio) {
      this.staleManifestResponseCount = (this.staleManifestResponseCount || 0) + 1;
      return hlsTrackRefreshOutcome('audio', false, true, false, false);
    }
    if (this.activeAudio.endList === true && !parsed.endList) {
      this.staleManifestResponseCount = (this.staleManifestResponseCount || 0) + 1;
      return hlsTrackRefreshOutcome('audio', false, true, false, false);
    }
    if (!acceptHlsPlaylistCursor(this, url, parsed, 'audio')) {
      this.staleManifestResponseCount = (this.staleManifestResponseCount || 0) + 1;
      return hlsTrackRefreshOutcome('audio', false, true, false, false);
    }
    applyHlsPlaylistEpoch(this, url, parsed, this.activeAudio.segments, 'audio');
    assignHlsTimestampGenerations(this, url, parsed, 'audio');
    if (parsed._hlsEpochReset) clearHlsPreloadHintEpochState(this);
    else reconcileHlsPreloadHints(this, this.activeAudio, parsed);
    this.activeAudio.segments = parsed._hlsEpochReset
      ? parsed.segments
      : (mergeSegmentState(this.activeAudio.segments, parsed.segments) || parsed.segments);
    pruneHlsTimestampGenerations(this);
    this.activeAudio.initSegment = parsed.map;
    this.activeAudio.isTsPlaylist = isTs;
    this.activeAudio.lowLatencyPlaylist = !!parsed.lowLatencyPlaylist;
    this.activeAudio.partialSegmentCount = parsed.partialSegmentCount || 0;
    this.activeAudio.partialSegmentGapCount = parsed.partialSegmentGapCount || 0;
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
    this.activeAudio.duration = parsed.duration || 0;
    this.activeAudio.endList = this.activeAudio.endList === true || !!parsed.endList;
    this.audioEndList = this.activeAudio.endList;
    this.activeAudio.playlistUrl = url;
    this.audioSegments = this.activeAudio.segments;
    this.audioInitSegment = this.activeAudio.initSegment;
    var codecs = this.activeAudio.codecs || audioCodecsOnly((this.activeVariant && this.activeVariant.codecs) || '') || 'mp4a.40.2';
    this.audioMimeType = 'audio/mp4; codecs="' + codecs + '"';
    if (!MediaSource.isTypeSupported(this.audioMimeType)) throw new Error('hls-audio-codec-unsupported');
    this._syncPresentationState();
    var outcome = hlsTrackRefreshOutcome(
      'audio',
      true,
      false,
      !!parsed._hlsEpochReset || hlsCursorAdvanced(previousCursor, hlsDeliveryCursor(this.activeAudio)),
      previousSignature !== hlsTrackSignature(this.activeAudio)
    );
    outcome.epochReset = !!parsed._hlsEpochReset;
    outcome.playlistEpoch = parsed._hlsPlaylistEpoch || 0;
    if (isTs) return this._ensureTsTransmuxer('audio', codecs).then(function () { return outcome; });
    return outcome;
  };

  NativeHlsProvider.prototype._syncPresentationState = function () {
    var separateAudioPendingEnd = !!(this.activeAudio && this.audioEndList === false);
    var live = !this.videoEndList || separateAudioPendingEnd;
    var duration = Math.max(
      this.videoDuration || 0,
      this.activeAudio && this.activeAudio.duration ? this.activeAudio.duration : 0
    );
    applyProviderPresentationState(this, live, duration);
  };

  NativeHlsProvider.prototype._loadStartupMediaPlaylists = function () {
    var self = this;
    var attempts = 0;
    var maxAttempts = Math.max(1, (this.variants || []).length);
    function attempt() {
      if (!self.activeVariant) throw nativeTerminalError(self, 'hls-no-supported-video');
      attempts++;
      var selectedVariant = self.activeVariant;
      var selectedAudio = self.activeAudio;
      var videoPlaylist = self._fetchPlaylistText(selectedVariant.url);
      var audioPlaylist = selectedAudio && selectedAudio.url
        ? self._fetchPlaylistText(selectedAudio.url)
        : Promise.resolve(null);
      return Promise.all([videoPlaylist, audioPlaylist]).then(function (playlists) {
        return Promise.resolve(self._loadMediaPlaylist(playlists[0], selectedVariant.url, selectedVariant)).then(function () {
          if (playlists[1] == null) return;
          return self._loadAudioPlaylist(playlists[1], selectedAudio.url, selectedAudio);
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
    var videoOnlyGaps = allSegmentsDeclaredGap(this.segments);
    var audioOnlyGaps = !!(this.activeAudio && allSegmentsDeclaredGap(this.audioSegments));
    this.suppressedVideoGapTrack = !!(videoOnlyGaps && this.activeAudio && !audioOnlyGaps);
    this.suppressedAudioGapTrack = audioOnlyGaps;
    this.suppressedGapTrackCount = (this.suppressedVideoGapTrack ? 1 : 0) + (this.suppressedAudioGapTrack ? 1 : 0);
    if (!this.suppressedVideoGapTrack) {
      this.sb = this.mediaSource.addSourceBuffer(this.mimeType);
      this.sb.mode = 'segments';
      this.videoSourceBufferMime = this.mimeType;
    }
    if (!this.suppressedAudioGapTrack && (this.audioInitSegment || this.muxedTsAudio || (this.activeAudio && this.activeAudio.isTsPlaylist))) {
      this.audioSb = this.mediaSource.addSourceBuffer(this.audioMimeType);
      this.audioSb.mode = 'segments';
      this.audioSourceBufferMime = this.audioMimeType;
    }
    this.video.addEventListener('waiting', this._boundWaiting = function () { self._onWaiting(); });
    this.video.addEventListener('playing', this._boundPlaying = function () { self._onPlaying(); });
    this.video.addEventListener('timeupdate', this._boundTick = function () { self._tick(); });
    this.video.addEventListener('seeking', this._boundSeeking = function () {
      if (self._applyingInitialStart || isInternalMediaSeek(self)) return;
      self._onSeek();
    });
    this.video.addEventListener('seeked', this._boundSeeked = function () {
      if (self._applyingInitialStart || isInternalMediaSeek(self)) return;
      self.endSeek();
    });
    // Video and audio have independent SourceBuffers, so their init requests and
    // appends do not need to sit on the same startup critical path.
    var videoInitPromise = this.initSegment && this.sb
      ? this._fetchRange(this.initSegment.url, this.initSegment.range, { phase: 'metadata' }).then(function (initData) {
        var generationKey = hlsTrackInitialTimestampGenerationKey(self, self);
        var sourceBuffer = self.sb;
        return appendHlsInitBuffer(
          self,
          self,
          sourceBuffer,
          self.initSegment,
          initData,
          generationKey,
          sourceBufferIdentityGuard(self, 'sb', sourceBuffer)
        ).then(function () {
          self._appendedVideoInitKey = hlsInitSegmentKey(self.initSegment);
          self._appendedVideoInitGenerationKey = generationKey;
          self._sourceBufferVideoInitSegment = self.initSegment;
        });
      })
      : Promise.resolve();
    var audioInitPromise = this.audioInitSegment && this.audioSb
      ? this._fetchRange(this.audioInitSegment.url, this.audioInitSegment.range, { phase: 'metadata' }).then(function (initData) {
        var generationKey = hlsTrackInitialTimestampGenerationKey(self, self.activeAudio);
        var sourceBuffer = self.audioSb;
        return appendHlsInitBuffer(
          self,
          self.activeAudio,
          sourceBuffer,
          self.audioInitSegment,
          initData,
          generationKey,
          sourceBufferIdentityGuard(self, 'audioSb', sourceBuffer)
        ).then(function () {
          self._appendedAudioInitKey = hlsInitSegmentKey(self.audioInitSegment);
          self._appendedAudioInitGenerationKey = generationKey;
          self._sourceBufferAudioInitSegment = self.audioInitSegment;
        });
      })
      : Promise.resolve();
    return Promise.all([videoInitPromise, audioInitPromise]).then(function () {
      if (self.live && self.liveWindow) {
        self.startupLiveTarget = self._defaultLiveStartTime();
        if (self.video.currentTime < self.liveWindow.start || self.video.currentTime < self.startupLiveTarget - 0.5) {
          assignInternalMediaTime(self, self.startupLiveTarget);
        }
      }
      if (self.engine._pendingLoadStartTime == null && isFinite(self.manifestStartTime)) {
        assignInternalMediaTime(self, self.manifestStartTime);
      }
      self.startupBufferStartedAt = performance.now();
      if (self.engine && self.engine._markStartupAttached) self.engine._markStartupAttached(self);
      if (self.live) self._schedulePlaylistRefresh();
      self._tick(true);
      return applyPendingLoadStartTime(self).then(function () {
        self.engine._player.emit('loaded');
        self.engine._player.emit('trackschanged');
      });
    });
  };

  NativeHlsProvider.prototype._appendTrackInitIfNeeded = function (kind, force) {
    var self = this;
    var isAudio = kind === 'audio';
    var generation = arguments.length > 2 && arguments[2] != null
      ? arguments[2]
      : (this.trackTransitionGeneration || 0);
    var sb = isAudio ? this.audioSb : this.sb;
    var initSegment = isAudio ? this.audioInitSegment : this.initSegment;
    var keyField = isAudio ? '_appendedAudioInitKey' : '_appendedVideoInitKey';
    var generationKeyField = isAudio ? '_appendedAudioInitGenerationKey' : '_appendedVideoInitGenerationKey';
    var initField = isAudio ? '_sourceBufferAudioInitSegment' : '_sourceBufferVideoInitSegment';
    var bufferField = isAudio ? 'audioSb' : 'sb';
    if (!sb || !initSegment) return Promise.resolve(false);
    var initKey = hlsInitSegmentKey(initSegment);
    var timestampGenerationKey = hlsTrackInitialTimestampGenerationKey(this, isAudio ? this.activeAudio : this);
    if (!force && initKey && this[keyField] === initKey && this[generationKeyField] === timestampGenerationKey) return Promise.resolve(false);
    assertHlsTrackTransitionCurrent(this, generation);
    return this._fetchRange(initSegment.url, initSegment.range, { phase: 'metadata' }).then(function (initData) {
      assertHlsTrackTransitionCurrent(self, generation);
      if (self[bufferField] !== sb) throw abortError();
      return appendHlsInitBuffer(self, isAudio ? self.activeAudio : self, sb, initSegment, initData, timestampGenerationKey);
    }).then(function () {
      assertHlsTrackTransitionCurrent(self, generation);
      if (self[bufferField] !== sb) throw abortError();
      self[keyField] = initKey;
      self[generationKeyField] = timestampGenerationKey;
      self[initField] = initSegment;
      return true;
    });
  };

  NativeHlsProvider.prototype._restoreTrackSourceBuffer = function (kind, desired, generation) {
    var self = this;
    var isAudio = kind === 'audio';
    var field = isAudio ? 'audioSb' : 'sb';
    var mimeField = isAudio ? 'audioSourceBufferMime' : 'videoSourceBufferMime';
    var keyField = isAudio ? '_appendedAudioInitKey' : '_appendedVideoInitKey';
    var generationKeyField = isAudio ? '_appendedAudioInitGenerationKey' : '_appendedVideoInitGenerationKey';
    var initField = isAudio ? '_sourceBufferAudioInitSegment' : '_sourceBufferVideoInitSegment';
    desired = desired || { exists: false, sourceBuffer: null, mime: '', initKey: '', initGenerationKey: '', initSegment: null };
    generation = generation == null ? (this.trackTransitionGeneration || 0) : generation;

    function assertCurrent() {
      assertHlsTrackTransitionCurrent(self, generation);
    }

    function removeCurrent() {
      var current = self[field];
      if (!current) return Promise.resolve();
      return waitForVodSourceBufferQueue(current).then(function () {
        assertCurrent();
        if (self[field] !== current) return;
        self.mediaSource.removeSourceBuffer(current);
        self[field] = null;
        self[mimeField] = '';
        self[keyField] = '';
        self[generationKeyField] = '';
        self[initField] = null;
      });
    }

    function addDesired() {
      assertCurrent();
      var replacement = self.mediaSource.addSourceBuffer(desired.mime);
      replacement.mode = 'segments';
      self[field] = replacement;
      self[mimeField] = desired.mime;
      self[keyField] = '';
      self[generationKeyField] = '';
      self[initField] = null;
      reconcileHlsSegmentLedgers(self, kind, null, isAudio ? self.activeAudio : self, null, true);
      if (!desired.initSegment) {
        self[keyField] = desired.initKey || '';
        self[generationKeyField] = desired.initGenerationKey || '';
        return Promise.resolve(replacement);
      }
      return self._fetchRange(desired.initSegment.url, desired.initSegment.range, { phase: 'metadata' }).then(function (initData) {
        assertCurrent();
        if (self[field] !== replacement) throw abortError();
        return appendHlsInitBuffer(self, isAudio ? self.activeAudio : self, replacement, desired.initSegment, initData, desired.initGenerationKey || '');
      }).then(function () {
        assertCurrent();
        if (self[field] !== replacement) throw abortError();
        self[keyField] = desired.initKey || hlsInitSegmentKey(desired.initSegment);
        self[generationKeyField] = desired.initGenerationKey || '';
        self[initField] = desired.initSegment;
        return replacement;
      });
    }

    assertCurrent();
    if (!desired.exists) {
      return removeCurrent().then(function () {
        self[field] = null;
        self[mimeField] = '';
        self[keyField] = '';
        self[generationKeyField] = '';
        self[initField] = null;
        return false;
      });
    }
    if (!desired.mime) return Promise.reject(new Error('hls-' + kind + '-rollback-mime-unavailable'));
    var current = this[field];
    if (current === desired.sourceBuffer && (this[mimeField] || desired.mime) === desired.mime) {
      this[mimeField] = desired.mime;
      if (
        !desired.initSegment
        || (this[keyField] || '') === (desired.initKey || '')
          && (this[generationKeyField] || '') === (desired.initGenerationKey || '')
          && this[initField] === desired.initSegment
      ) {
        this[keyField] = desired.initKey || '';
        this[generationKeyField] = desired.initGenerationKey || '';
        this[initField] = desired.initSegment || null;
        return Promise.resolve(false);
      }
      return this._fetchRange(desired.initSegment.url, desired.initSegment.range, { phase: 'metadata' }).then(function (initData) {
        assertCurrent();
        if (self[field] !== current) throw abortError();
        return appendHlsInitBuffer(self, isAudio ? self.activeAudio : self, current, desired.initSegment, initData, desired.initGenerationKey || '');
      }).then(function () {
        self[keyField] = desired.initKey || hlsInitSegmentKey(desired.initSegment);
        self[generationKeyField] = desired.initGenerationKey || '';
        self[initField] = desired.initSegment;
        return current;
      });
    }
    if (current && current.changeType) {
      return waitForVodSourceBufferQueue(current).then(function () {
        assertCurrent();
        if (self[field] !== current) throw abortError();
        current.changeType(desired.mime);
        self[mimeField] = desired.mime;
        self[keyField] = '';
        self[generationKeyField] = '';
        self[initField] = null;
        if (!desired.initSegment) return current;
        return self._fetchRange(desired.initSegment.url, desired.initSegment.range, { phase: 'metadata' }).then(function (initData) {
          assertCurrent();
          if (self[field] !== current) throw abortError();
          return appendHlsInitBuffer(self, isAudio ? self.activeAudio : self, current, desired.initSegment, initData, desired.initGenerationKey || '');
        }).then(function () {
          self[keyField] = desired.initKey || hlsInitSegmentKey(desired.initSegment);
          self[generationKeyField] = desired.initGenerationKey || '';
          self[initField] = desired.initSegment;
          return current;
        });
      }).catch(function (err) {
        if (err && err.name === 'AbortError') throw err;
        return removeCurrent().then(addDesired);
      });
    }
    return removeCurrent().then(addDesired);
  };

  NativeHlsProvider.prototype._transitionTrackSourceBuffer = function (kind, suppress, generation) {
    var self = this;
    var isAudio = kind === 'audio';
    var field = isAudio ? 'audioSb' : 'sb';
    var mimeType = isAudio ? this.audioMimeType : this.mimeType;
    var mimeField = isAudio ? 'audioSourceBufferMime' : 'videoSourceBufferMime';
    var keyField = isAudio ? '_appendedAudioInitKey' : '_appendedVideoInitKey';
    var generationKeyField = isAudio ? '_appendedAudioInitGenerationKey' : '_appendedVideoInitGenerationKey';
    var initField = isAudio ? '_sourceBufferAudioInitSegment' : '_sourceBufferVideoInitSegment';
    generation = generation == null ? (this.trackTransitionGeneration || 0) : generation;
    var previousState = captureHlsTrackSourceBufferState(this, kind);
    var sourceBuffer = this[field];

    function assertCurrent() {
      assertHlsTrackTransitionCurrent(self, generation);
    }

    function rollback(err) {
      if (self.destroyed || generation !== (self.trackTransitionGeneration || 0)) return Promise.reject(err);
      return self._restoreTrackSourceBuffer(kind, previousState, generation).then(function () {
        self.sourceBufferTypeRollbackCount = (self.sourceBufferTypeRollbackCount || 0) + 1;
        throw err;
      }, function (rollbackErr) {
        var terminal = new Error('hls-' + kind + '-sourcebuffer-rollback-failed');
        terminal.originalError = err;
        terminal.rollbackError = rollbackErr;
        throw terminal;
      });
    }

    try {
      assertCurrent();
    } catch (err) {
      return Promise.reject(err);
    }
    if (suppress) {
      if (!sourceBuffer) return Promise.resolve(false);
      return removeHlsGapSourceBuffer(this, kind, generation).then(function () {
        assertCurrent();
        if (!self[field]) {
          self[mimeField] = '';
          self[keyField] = '';
          self[generationKeyField] = '';
          self[initField] = null;
          self.trackSuppressionCount++;
          return true;
        }
        return false;
      });
    }
    if (!mimeType) return Promise.reject(new Error('hls-' + kind + '-mime-unavailable'));
    if (!sourceBuffer) {
      try {
        assertCurrent();
        sourceBuffer = this.mediaSource.addSourceBuffer(mimeType);
        sourceBuffer.mode = 'segments';
        this[field] = sourceBuffer;
        this[mimeField] = mimeType;
        this[keyField] = '';
        this[generationKeyField] = '';
        this[initField] = null;
        this.trackActivationCount++;
        reconcileHlsSegmentLedgers(this, kind, null, isAudio ? this.activeAudio : this, null, true);
      } catch (err) {
        return Promise.reject(err);
      }
      return this._appendTrackInitIfNeeded(kind, true, generation).then(function () { return true; }).catch(rollback);
    }
    var previousMime = this[mimeField] || mimeType;
    if (previousMime === mimeType) return this._appendTrackInitIfNeeded(kind, false, generation);
    return waitForVodSourceBufferQueue(sourceBuffer).then(function () {
      assertCurrent();
      return waitForSourceBufferIdle(sourceBuffer);
    }).then(function () {
      assertCurrent();
      if (self[field] !== sourceBuffer) throw abortError();
      if (sourceBuffer.changeType) {
        try {
          sourceBuffer.changeType(mimeType);
          self[mimeField] = mimeType;
          self[keyField] = '';
          self[generationKeyField] = '';
          self[initField] = null;
          self.sourceBufferTypeChangeCount++;
          return self._appendTrackInitIfNeeded(kind, true, generation);
        } catch (err) {
          // Browsers can expose changeType while rejecting a particular codec
          // transition. Rebuild the buffer through the same controlled path
          // used when changeType is absent.
        }
      }
      try {
        self.mediaSource.removeSourceBuffer(sourceBuffer);
        self[field] = null;
        self[mimeField] = '';
        self[keyField] = '';
        self[generationKeyField] = '';
        self[initField] = null;
      } catch (err) {
        throw new Error('hls-' + kind + '-sourcebuffer-rebuild-failed');
      }
      var replacement;
      try {
        replacement = self.mediaSource.addSourceBuffer(mimeType);
        replacement.mode = 'segments';
      } catch (err) {
        throw new Error('hls-' + kind + '-sourcebuffer-rebuild-failed');
      }
      self[field] = replacement;
      self[mimeField] = mimeType;
      self[keyField] = '';
      self[generationKeyField] = '';
      self[initField] = null;
      self.sourceBufferTypeRebuildCount++;
      reconcileHlsSegmentLedgers(self, kind, null, isAudio ? self.activeAudio : self, null, true);
      return self._appendTrackInitIfNeeded(kind, true, generation);
    }).catch(function (err) {
      if (err && err.name === 'AbortError') throw err;
      return rollback(err);
    });
  };

  NativeHlsProvider.prototype._applyTrackLifecycle = function (generation) {
    if (this.destroyed || !this.mediaSource || this.mediaSource.readyState !== 'open') return Promise.resolve();
    var self = this;
    generation = generation == null ? (this.trackTransitionGeneration || 0) : generation;
    try {
      assertHlsTrackTransitionCurrent(this, generation);
    } catch (err) {
      return Promise.reject(err);
    }
    var videoOnlyGaps = allSegmentsDeclaredGap(this.segments);
    var audioOnlyGaps = !!(this.activeAudio && allSegmentsDeclaredGap(this.audioSegments));
    var suppressVideo = !!(videoOnlyGaps && this.activeAudio && !audioOnlyGaps);
    var suppressAudio = audioOnlyGaps;
    var lifecycleChanged = suppressVideo !== !!this.suppressedVideoGapTrack
      || suppressAudio !== !!this.suppressedAudioGapTrack
      || (!suppressVideo && !this.sb)
      || (!suppressAudio && (this.activeAudio || this.muxedTsAudio) && !this.audioSb)
      || (!suppressVideo && this.sb && this.videoSourceBufferMime && this.videoSourceBufferMime !== this.mimeType)
      || (!suppressAudio && this.audioSb && this.audioSourceBufferMime && this.audioSourceBufferMime !== this.audioMimeType);
    if (lifecycleChanged) this._abortRequests();
    return this._transitionTrackSourceBuffer('video', suppressVideo, generation).then(function () {
      assertHlsTrackTransitionCurrent(self, generation);
      if (!self.activeAudio && !self.muxedTsAudio) return false;
      return self._transitionTrackSourceBuffer('audio', suppressAudio, generation);
    }).then(function () {
      assertHlsTrackTransitionCurrent(self, generation);
      self.suppressedVideoGapTrack = !!(suppressVideo && !self.sb);
      self.suppressedAudioGapTrack = !!(suppressAudio && !self.audioSb);
      self.suppressedGapTrackCount = (self.suppressedVideoGapTrack ? 1 : 0) + (self.suppressedAudioGapTrack ? 1 : 0);
    });
  };

  NativeHlsProvider.prototype._reconcileTrackLifecycle = function (generation) {
    var self = this;
    generation = generation == null ? (this.trackTransitionGeneration || 0) : generation;
    var previous = this.trackLifecyclePromise || Promise.resolve();
    var lifecycle = previous.catch(function () {}).then(function () {
      assertHlsTrackTransitionCurrent(self, generation);
      return self._applyTrackLifecycle(generation);
    });
    var tracked = lifecycle.then(function (value) {
      if (self.trackLifecyclePromise === tracked) self.trackLifecyclePromise = null;
      return value;
    }, function (err) {
      if (self.trackLifecyclePromise === tracked) self.trackLifecyclePromise = null;
      throw err;
    });
    this.trackLifecyclePromise = tracked;
    return tracked;
  };

  NativeHlsProvider.prototype._beginTrackTransition = function (reason) {
    if (this.destroyed || this.trackTransitionInFlight) return null;
    invalidateHlsAppendTransactions(this, reason || 'track-transition');
    var transaction = {
      generation: (this.trackTransitionGeneration || 0) + 1,
      reason: reason || 'track-transition',
      controller: new AbortController(),
      cancelled: false,
      snapshot: captureHlsTrackTransitionState(this)
    };
    this.trackTransitionGeneration = transaction.generation;
    this.trackTransitionInFlight = transaction;
    return transaction;
  };

  NativeHlsProvider.prototype._isTrackTransitionCurrent = function (transaction) {
    return this._ownsTrackTransition(transaction) && !transaction.cancelled;
  };

  NativeHlsProvider.prototype._ownsTrackTransition = function (transaction) {
    return !!(
      transaction
      && !this.destroyed
      && this.trackTransitionInFlight === transaction
      && this.trackTransitionGeneration === transaction.generation
    );
  };

  NativeHlsProvider.prototype._finishTrackTransition = function (transaction, committed) {
    if (!transaction || this.trackTransitionInFlight !== transaction) return false;
    if (committed) this.trackTransitionCommitCount = (this.trackTransitionCommitCount || 0) + 1;
    this.trackTransitionInFlight = null;
    return true;
  };

  NativeHlsProvider.prototype._cancelTrackTransitionForViewerIntent = function () {
    var transaction = this.trackTransitionInFlight;
    if (!transaction || transaction.cancelled) return false;
    transaction.cancelled = true;
    this.playlistRefreshGeneration = (this.playlistRefreshGeneration || 0) + 1;
    if (transaction.controller) {
      try { transaction.controller.abort(); } catch (e) {}
    }
    this._abortRequests();
    return true;
  };

  NativeHlsProvider.prototype._rollbackTrackTransition = function (transaction) {
    var self = this;
    if (!this._ownsTrackTransition(transaction)) return Promise.resolve(false);
    this._abortRequests();
    restoreHlsTrackTransitionState(this, transaction.snapshot);
    return this._restoreTrackSourceBuffer('video', transaction.snapshot.videoSourceBuffer, transaction.generation).then(function () {
      return self._restoreTrackSourceBuffer('audio', transaction.snapshot.audioSourceBuffer, transaction.generation);
    }).then(function () {
      if (!self._ownsTrackTransition(transaction)) throw abortError();
      markSegmentsUnappended(self);
      markSegmentsCoveredByBuffer(self, self.video);
      if (self.activeAudio) {
        markSegmentsUnappended(self.activeAudio);
        markSegmentsCoveredByBuffer(self.activeAudio, self.video);
      }
      self.trackTransitionRollbackCount = (self.trackTransitionRollbackCount || 0) + 1;
      return true;
    }).catch(function (err) {
      if (self.destroyed || (err && err.name === 'AbortError')) return false;
      self.trackTransitionRollbackFailureCount = (self.trackTransitionRollbackFailureCount || 0) + 1;
      self._completeNativeRuntimeTerminal('hls-track-transition-rollback-failed');
      throw err;
    });
  };

  NativeHlsProvider.prototype._flushPendingTrackSwitch = function () {
    if (this.destroyed || this.trackTransitionInFlight) return false;
    if (this._flushPendingVariantSwitch()) return true;
    var pendingAudio = this.pendingAudioTrackSwitch;
    if (!pendingAudio) return false;
    this.pendingAudioTrackSwitch = null;
    var rendition = this.audioRenditions.find(function (item) {
      return item.id === pendingAudio.id || item.language === pendingAudio.language;
    });
    if (!rendition || rendition === this.activeAudio) return false;
    this.selectAudioTrack(pendingAudio);
    return !!this.trackTransitionInFlight;
  };

  NativeHlsProvider.prototype._tick = function (force) {
    if (this.destroyed || (!this.sb && !this.audioSb) || !this.segments.length) return;
    if (this.playlistManifestCommitInProgress) return;
    if (this._jumpManifestGap && this._jumpManifestGap()) return;
    if (this._maybeEndVodStream && this._maybeEndVodStream()) return;
    if (endedVodSchedulerIsIdle(this)) return;
    this._updateLivePositionStats();
    this._jumpSmallGap();
    var ahead = getBufferAhead(this.video);
    this._maybeRefreshLiveLowBuffer(ahead);
    if (this._recoverLiveWindowDrift(ahead)) return;
    if (this.variantSwitchInFlight || this.trackTransitionInFlight) return;
    if (!this.manualTrackId) this._maybeSwitchAuto();
    if (this.variantSwitchInFlight || this.trackTransitionInFlight) return;
    if (!force && ahead >= this._bufferAheadGoal()) return;
    var schedulingGoal = this.seekBufferPending
      ? this._seekBufferGoal()
      : (!this.startupBufferComplete ? this._startupBufferGoal() : this._bufferAheadGoal());
    this._scheduleMediaRequests(schedulingGoal);
    this._trim();
    this._checkBufferMilestones();
  };

  NativeHlsProvider.prototype._scheduleMediaRequests = function (windowGoal) {
    if (this.destroyed || this.playlistManifestCommitInProgress) return;
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
    var tracks = this.sb ? [this._videoTrack] : [];
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
    var readyGoal = Math.min(goal, this._bufferAheadGoal());
    // Do not let future media divide the connection with the only video/audio
    // fragments capable of producing the first frame. Once the current
    // playhead is buffered, normal concurrent look-ahead resumes.
    var startupCriticalOnly = (!this.startupBufferComplete || this.seekBufferPending)
      && getBufferAhead(this.video) < 0.1;
    var candidates = [];
    tracks = tracks || this._mediaTracks();
    for (var i = 0; i < tracks.length; i++) {
      var track = tracks[i];
      // LL-HLS parts after the selected playhead can depend on the nearest
      // preceding independent part. Keep that dependency in the request
      // window even when PART-HOLD-BACK places it more than 500ms behind.
      var trackStart = this.live && this.lowLatencyPlaylist
        ? hlsIndependentPartStart(track.segments, ct)
        : ct;
      trackStart = hlsNextPlayableStart(track.segments, trackStart);
      var trackTarget = trackStart + goal;
      for (var j = 0; j < track.segments.length; j++) {
        var seg = track.segments[j];
        if (seg.gap || seg.state === 'expired' || seg.end <= trackStart - 0.05 || seg.start >= trackTarget || isSegmentBusyOrDone(seg)) continue;
        var priority = segmentPriority(seg, trackStart, readyGoal);
        var startupDependency = this.live && this.lowLatencyPlaylist
          ? seg.start <= ct + 0.05 && seg.end > trackStart - 0.05
          : priority === 0;
        if (startupCriticalOnly && !startupDependency) continue;
        candidates.push({ track: track, seg: seg, priority: priority });
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
    if (this.playlistManifestCommitInProgress || !track || !seg || isSegmentBusyOrDone(seg)) return false;
    var rangeKey = track.id + ':' + segmentKey(seg);
    if (this.activeRanges[rangeKey]) return false;
    this.activeRanges[rangeKey] = true;
    seg.state = 'fetching';
    seg._fetchStartedAt = performance.now();
    var networkTiming = null;
    if (seg._hlsPart) this.partialSegmentRequestCount++;
    if (seg._hlsPreloadHint) this.preloadHintRequestCount++;
    this._fetchRange(seg.url, seg.range, {
      phase: 'media',
      onTiming: function (timing) { networkTiming = timing; }
    }).then(function (data) {
      return self._decryptSegmentIfNeeded(seg, data).then(function (plainData) {
        delete self.activeRanges[rangeKey];
        if (seg._hlsPreloadHintStale) {
          seg.state = 'expired';
          seg.appended = false;
          delete seg._data;
          return;
        }
        seg.state = 'fetched';
        seg._data = plainData;
        var elapsed = Math.max(1, performance.now() - (seg._fetchStartedAt || performance.now()));
        self.mediaFetchCompletedCount++;
        self.mediaFetchTotalMs += elapsed;
        // Match mature HLS ABR semantics: alternate-audio requests do not
        // influence the video rendition estimator, and request latency is
        // separated from transfer time before throughput is sampled.
        if (track.kind === 'video' && seg.duration > 0 && networkTiming) {
          self._recordBandwidthSample(
            networkTiming.byteLength || plainData.byteLength || 0,
            networkTiming.timeMs,
            networkTiming.timeToFirstByteMs
          );
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
        self._recoverMediaRequest(err, track).then(function () {
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
    return this._decryptHlsResourceIfNeeded(seg, data, false);
  };

  NativeHlsProvider.prototype._decryptHlsInitIfNeeded = function (initSegment, data) {
    return this._decryptHlsResourceIfNeeded(initSegment, data, true);
  };

  NativeHlsProvider.prototype._decryptHlsResourceIfNeeded = function (resource, data, isInit) {
    if (!resource || !resource.key || resource.key.method !== 'AES-128') return Promise.resolve(data);
    var self = this;
    return this._fetchHlsKey(resource.key).then(function (rawKey) {
      var iv = resource.key.iv || (!isInit ? hlsDefaultIv(resource.mediaSequence || 0) : null);
      if (!iv) throw new Error('hls-map-iv-required');
      return crypto.subtle.importKey('raw', rawKey, { name: 'AES-CBC' }, false, ['decrypt']).then(function (key) {
        return crypto.subtle.decrypt({ name: 'AES-CBC', iv: iv }, key, data);
      });
    }).then(function (plain) {
      if (isInit) self.encryptedInitSegmentCount = (self.encryptedInitSegmentCount || 0) + 1;
      else self.encryptedSegmentCount++;
      self.lastDecryptionError = '';
      return plain;
    }).catch(function (err) {
      var fallbackReason = isInit ? 'hls-init-decrypt-failed' : 'hls-decrypt-failed';
      self.lastDecryptionError = err && err.message ? err.message : fallbackReason;
      self.lastError = self.lastDecryptionError;
      throw new Error(fallbackReason);
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
    if (this.playlistManifestCommitInProgress) return false;
    track = track || this._mediaTracks()[0];
    if (!track || !track.sb || track._appending || track._appendOwner) return false;
    if (track.sb.updating && !recoverStuckSourceBuffer(this, track)) return false;
    var next = nextFetchedSegmentForAppend(track, this.video.currentTime || 0);
    if (!next) return false;
    track._appending = true;
    next.state = 'appending';
    next._appendStartedAt = performance.now();
    var data = next._data;
    delete next._data;
    var appendTransaction = createHlsAppendTransaction(self, track, next);
    track._appendOwner = appendTransaction;
    next._appendOwner = appendTransaction;
    hlsAppendSegmentWithWatchdog(self, track, next, data, appendTransaction).then(function () {
      assertHlsAppendTransactionCurrent(self, appendTransaction);
      if (track._appendOwner !== appendTransaction || next._appendOwner !== appendTransaction) throw abortError();
      next.state = 'appended';
      next.appended = true;
      if (next._hlsPart || next._hlsPreloadHint) self.partialSegmentAppendCount++;
      if (next._parentSegment) markCompletedHlsParent(next._parentSegment, null);
      delete next._appendStartedAt;
      delete next._fetchStartedAt;
      delete next._appendOwner;
      track._appendOwner = null;
      track._appending = false;
      self.appendFailures = 0;
      self.stallReports = 0;
      self.stallRecoveryStage = 0;
      self.schedulerDrainCount++;
      self._alignHlsBufferedTarget();
      if (self._checkBufferMilestones) self._checkBufferMilestones();
      self.engine._player.emit('adaptation');
      self._drainAppendQueue(track);
      if (self._maybeEndVodStream) self._maybeEndVodStream();
      self._tick();
    }).catch(function (err) {
      var ownsTrack = track._appendOwner === appendTransaction;
      var ownsSegment = next._appendOwner === appendTransaction;
      if (ownsTrack) {
        track._appendOwner = null;
        track._appending = false;
      }
      if (!ownsSegment) return;
      delete next._appendOwner;
      if (err.name === 'AbortError') {
        if (!self.destroyed && next.state === 'appending') {
          next.state = 'pending';
          next.appended = false;
          delete next._appendStartedAt;
        }
      } else {
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

  NativeHlsProvider.prototype._appendSegmentData = function (track, seg, data, appendTransaction) {
    var self = this;
    appendTransaction = appendTransaction || createHlsAppendTransaction(this, track, seg);
    var container;
    try {
      assertHlsAppendTransactionCurrent(this, appendTransaction);
      container = bindHlsGenerationContainer(this, seg, detectHlsMediaContainer(data, seg));
    } catch (err) {
      return Promise.reject(err);
    }
    if (!container) return Promise.reject(new Error('hls-segment-container-unsupported'));
    var isTsMedia = container === 'mpegts';
    var prepareDiscontinuity = this._prepareDiscontinuityAppend || function () { return Promise.resolve(); };
    var ensureContainer = Promise.resolve();
    if (isTsMedia && this._ensureTsTransmuxer) {
      if (track.kind === 'audio') {
        ensureContainer = this._ensureTsTransmuxer('audio', track.codecs || 'mp4a.40.2');
      } else {
        var videoCodecs = videoCodecsOnly((this.activeVariant && (this.activeVariant.rawCodecs || this.activeVariant.codecs)) || '') || 'avc1.42c01f';
        ensureContainer = this._ensureTsTransmuxer('video', videoCodecs).then(function () {
          if (!self.muxedTsAudio || !self.audioSb) return;
          var audioCodecs = (self.activeVariant && self.activeVariant.audioCodecs) || audioCodecsOnly((self.activeVariant && self.activeVariant.rawCodecs) || '') || 'mp4a.40.2';
          return self._ensureTsTransmuxer('audio', audioCodecs);
        });
      }
    }
    var appendPromise = ensureContainer.then(function () {
      assertHlsAppendTransactionCurrent(self, appendTransaction);
      return prepareDiscontinuity.call(self, track, seg);
    }).then(function () {
      assertHlsAppendTransactionCurrent(self, appendTransaction);
      if (isTsMedia && track.kind === 'video') {
        if (self.muxedTsAudio && self.audioSb) {
          self._muxedAudioTrack = self._muxedAudioTrack || { id: 'muxed-audio', kind: 'audio', sb: self.audioSb };
          self._muxedAudioTrack.sb = self.audioSb;
          // A muxed transport stream has one clock. Demux it once and give
          // both remuxers the same generation-scoped timestamp origin so the
          // original audio/video lead or lag survives the fMP4 conversion.
          var sharedTsContext = prepareHlsTsTransmuxContext(self, track, seg, data);
          self.hlsTsSharedDemuxCount = (self.hlsTsSharedDemuxCount || 0) + 1;
          return Promise.all([
            self._transmuxTsSegment(track, seg, data, 'video', sharedTsContext),
            self._prepareDiscontinuityAppend(self._muxedAudioTrack, seg).then(function () {
              return self._transmuxTsSegment(track, seg, data, 'audio', sharedTsContext);
            })
          ]).then(function (outputs) {
            // Keep the first displayed video frame from racing ahead of muxed
            // audio readiness. Appending video first can expose a deceptively
            // fast first frame and then make the media clock pause while the
            // audio SourceBuffer catches up. Prepare both outputs together,
            // append audio first, and expose video only when both tracks can
            // advance continuously.
            return appendHlsMuxedTsOutputs(self, track, seg, outputs, null, appendTransaction);
          });
        }
        return self._transmuxTsSegment(track, seg, data, 'video').then(function (output) {
          return self._appendTransmuxedOutput(track.sb, output, track, seg, appendTransaction);
        });
      }
      if (isTsMedia && track.kind === 'audio') {
        return self._transmuxTsSegment(track, seg, data, 'audio').then(function (output) {
          return self._appendTransmuxedOutput(track.sb, output, track, seg, appendTransaction);
        });
      }
      function appendFmp4() {
        var offset;
        try {
          offset = hlsFmp4TimestampOffset(self, track, seg, data);
        } catch (err) {
          return Promise.reject(err);
        }
        return appendBuffer(
          track.sb,
          data,
          null,
          offset,
          hlsAppendTransactionGuard(self, appendTransaction)
        );
      }
      return appendFmp4().catch(function (err) {
        if (
          !err
          || err.code !== 'HLS_TIMESTAMP_UNRESOLVED'
          || seg._hlsTimestampResolutionRetried
          || !self._refreshHlsGenerationInit
        ) throw err;
        seg._hlsTimestampResolutionRetried = true;
        return self._refreshHlsGenerationInit(track, seg).then(appendFmp4);
      });
    });
    return appendPromise.catch(function (err) {
      if (!isQuotaExceeded(err)) throw err;
      self.quotaRecoveries++;
      self.lastError = 'quota-exceeded';
      if (self.engine && self.engine._telemetry) self.engine._telemetry.record('recovery', { lastError: 'quota-exceeded' });
      return self._recoverQuota(track, data, seg, err, appendTransaction).catch(function (retryErr) {
        if (!retryErr || retryErr.name !== 'AbortError') seg.state = 'failed';
        throw retryErr;
      });
    });
  };

  NativeHlsProvider.prototype._maybeEndVodStream = function () {
    if (this.live || !this.mediaSource) return false;
    if (this.mediaSource.readyState === 'ended') {
      this.vodEndOfStreamPending = false;
      return false;
    }
    if (this.mediaSource.readyState !== 'open') return false;
    if (!this.vodEndOfStreamPending) {
      if (!segmentsAppendedThroughEnd(this.segments, this.duration)) return false;
      if (!sourceBufferCoversPlayableEnd(this.sb, playableSegmentEnd(this.segments))) return false;
      if (
        this.activeAudio
        && this.audioSegments.length
        && !segmentsAppendedThroughEnd(this.audioSegments, this.activeAudio.duration || this.duration)
      ) return false;
      if (
        this.activeAudio
        && this.audioSegments.length
        && !sourceBufferCoversPlayableEnd(this.audioSb, playableSegmentEnd(this.audioSegments))
      ) return false;
      if (
        this.muxedTsAudio
        && this.audioSb
        && !sourceBufferCoversPlayableEnd(this.audioSb, playableSegmentEnd(this.segments))
      ) return false;
      this.vodEndOfStreamPending = true;
    }
    return finalizeVodEndOfStream(this, [this.sb, this.audioSb]);
  };

  NativeHlsProvider.prototype._prepareDiscontinuityAppend = function (track, seg) {
    if (!track || !track.sb || !seg) return Promise.resolve();
    var self = this;
    var isAudio = track !== this && track.kind === 'audio';
    var keyField = isAudio ? '_appendedAudioInitKey' : '_appendedVideoInitKey';
    var generationKeyField = isAudio ? '_appendedAudioInitGenerationKey' : '_appendedVideoInitGenerationKey';
    var initField = isAudio ? '_sourceBufferAudioInitSegment' : '_sourceBufferVideoInitSegment';
    var container = seg._hlsContainer || hlsSegmentContainerHint(seg);
    var generationKey = seg._hlsTimestampGenerationKey || (seg._parentSegment && seg._parentSegment._hlsTimestampGenerationKey) || '';
    var desiredInit = container === 'mpegts' ? null : hlsSegmentInitSegment(this, track, seg);
    var desiredInitKey = hlsInitSegmentKey(desiredInit);
    var appendedInitKey = this[keyField] || track._lastAppendInitKey || '';
    var mapChanged = !!(desiredInitKey && desiredInitKey !== appendedInitKey);
    var generationChanged = !!(desiredInit && generationKey && generationKey !== (this[generationKeyField] || track._lastAppendInitGenerationKey || ''));
    var needsInit = !!(desiredInit && (mapChanged || generationChanged));
    var sequence = seg.discontinuitySequence || 0;
    var previous = track._lastAppendDiscontinuitySequence;
    var boundary = previous != null && previous !== sequence;
    if (!boundary && !seg.discontinuity && !needsInit) {
      if (previous == null) track._lastAppendDiscontinuitySequence = sequence;
      return Promise.resolve();
    }
    track._lastAppendDiscontinuitySequence = sequence;
    var sourceBuffer = track.sb;
    var prepare = sourceBuffer.updating ? waitForSourceBufferIdle(sourceBuffer) : Promise.resolve();
    return prepare.then(function () {
      if (track.sb !== sourceBuffer) throw abortError();
      try {
        if (sourceBuffer.abort) sourceBuffer.abort();
      } catch (e) {}
      if (!needsInit || !desiredInit) {
        self[generationKeyField] = generationKey;
        track._lastAppendInitGenerationKey = generationKey;
        return false;
      }
      return self._fetchRange(desiredInit.url, desiredInit.range, {
        phase: 'metadata',
        revalidate: generationChanged && !mapChanged
      }).then(function (initData) {
        if (track.sb !== sourceBuffer) throw abortError();
        return appendHlsInitBuffer(self, track, sourceBuffer, desiredInit, initData, generationKey);
      }).then(function () {
        if (track.sb !== sourceBuffer) throw abortError();
        if (appendedInitKey && appendedInitKey !== desiredInitKey) {
          self.hlsInitMapSwitchCount = (self.hlsInitMapSwitchCount || 0) + 1;
        }
        if (generationChanged) self.hlsInitGenerationRefreshCount = (self.hlsInitGenerationRefreshCount || 0) + 1;
        self[keyField] = desiredInitKey;
        self[generationKeyField] = generationKey;
        self[initField] = desiredInit;
        track._lastAppendInitKey = desiredInitKey;
        track._lastAppendInitGenerationKey = generationKey;
        return true;
      });
    });
  };

  NativeHlsProvider.prototype._refreshHlsGenerationInit = function (track, seg) {
    if (!track || !track.sb || !seg) return Promise.reject(new Error('hls-generation-init-unavailable'));
    var self = this;
    var sourceBuffer = track.sb;
    var isAudio = track !== this && track.kind === 'audio';
    var keyField = isAudio ? '_appendedAudioInitKey' : '_appendedVideoInitKey';
    var generationKeyField = isAudio ? '_appendedAudioInitGenerationKey' : '_appendedVideoInitGenerationKey';
    var initField = isAudio ? '_sourceBufferAudioInitSegment' : '_sourceBufferVideoInitSegment';
    var initSegment = hlsSegmentInitSegment(this, track, seg);
    var generationKey = seg._hlsTimestampGenerationKey || (seg._parentSegment && seg._parentSegment._hlsTimestampGenerationKey) || '';
    if (!initSegment || !generationKey) return Promise.reject(new Error('hls-generation-init-unavailable'));
    var kind = hlsTrackKind(this, track);
    if (this.hlsInitTimescaleByKey) delete this.hlsInitTimescaleByKey[hlsInitTimescaleKey(kind, initSegment, generationKey)];
    if (this.hlsInitTrackInfoByKey) delete this.hlsInitTrackInfoByKey[hlsInitTimescaleKey(kind, initSegment, generationKey)];
    return waitForSourceBufferIdle(sourceBuffer).then(function () {
      if (track.sb !== sourceBuffer) throw abortError();
      try { if (sourceBuffer.abort) sourceBuffer.abort(); } catch (e) {}
      return self._fetchRange(initSegment.url, initSegment.range, { phase: 'metadata', revalidate: true });
    }).then(function (initData) {
      if (track.sb !== sourceBuffer) throw abortError();
      return appendHlsInitBuffer(self, track, sourceBuffer, initSegment, initData, generationKey);
    }).then(function () {
      if (track.sb !== sourceBuffer) throw abortError();
      self[keyField] = hlsInitSegmentKey(initSegment);
      self[generationKeyField] = generationKey;
      self[initField] = initSegment;
      track._lastAppendInitKey = self[keyField];
      track._lastAppendInitGenerationKey = generationKey;
      self.hlsTimestampResolutionRetryCount = (self.hlsTimestampResolutionRetryCount || 0) + 1;
      return true;
    });
  };

  NativeHlsProvider.prototype._appendTransmuxedOutput = function (sb, output, track, seg, appendTransaction) {
    var self = this;
    if (appendTransaction) assertHlsAppendTransactionCurrent(this, appendTransaction);
    var wantedHandler = track && track.kind === 'audio' ? 'soun' : 'vide';
    if (output.init && output.init.byteLength) {
      var initTracks = parseMp4InitTrackInfo(output.init);
      var selectedTrack = initTracks.find(function (item) { return item.handlerType === wantedHandler; }) || initTracks[0] || null;
      if (selectedTrack) track._hlsTransmuxTimestampInfo = selectedTrack;
    }
    var timestampOffset = hlsFiniteTimestamp(output.timestampOffset)
      ? output.timestampOffset
      : hlsLiveTimestampOffset(this, track, seg);
    var timestampInfo = track && track._hlsTransmuxTimestampInfo;
    var fragmentTiming = timestampInfo && output.data
      ? parseMp4FragmentTimestamp(output.data, timestampInfo.trackId)
      : null;
    if (hlsFiniteTimestamp(output.timestampOffset)) {
      this.hlsTransmuxedTimestampResolutionCount = (this.hlsTransmuxedTimestampResolutionCount || 0) + 1;
    } else if (timestampInfo && fragmentTiming && isFinite(seg && seg.start)) {
      timestampOffset = seg.start - fragmentTiming.presentationTime / timestampInfo.timescale;
      this.hlsTransmuxedTimestampResolutionCount = (this.hlsTransmuxedTimestampResolutionCount || 0) + 1;
    } else if (seg && seg._hlsTimestampGenerationKey && !isFinite(timestampOffset)) {
      return Promise.reject(new Error('hls-transmux-timestamp-unresolved'));
    }
    var appendInit = !!(output.init && output.init.byteLength);
    if (
      appendInit
      && track
      && track._hlsTransmuxInitSourceBuffer === sb
      && hlsMediaBytesEqual(track._hlsTransmuxInitData, output.init)
    ) {
      appendInit = false;
      this.hlsTsInitSkipCount = (this.hlsTsInitSkipCount || 0) + 1;
    }
    var chain = Promise.resolve();
    if (appendInit) chain = chain.then(function () {
      return appendBuffer(
        sb,
        output.init,
        null,
        undefined,
        appendTransaction ? hlsAppendTransactionGuard(self, appendTransaction) : null
      ).then(function () {
        if (track) {
          track._hlsTransmuxInitSourceBuffer = sb;
          track._hlsTransmuxInitData = copyHlsMediaBytes(output.init);
        }
        self.hlsTsInitAppendCount = (self.hlsTsInitAppendCount || 0) + 1;
      });
    });
    if (output.data && output.data.byteLength) chain = chain.then(function () {
      return appendBuffer(
        sb,
        output.data,
        null,
        timestampOffset,
        appendTransaction ? hlsAppendTransactionGuard(self, appendTransaction) : null
      );
    });
    return chain.then(function () {
      if (appendTransaction) assertHlsAppendTransactionCurrent(self, appendTransaction);
      self._alignTsStartupTime();
    });
  };

  function invalidateHlsAppendTransactions(provider, reason) {
    if (!provider) return 0;
    provider.hlsAppendEpoch = (provider.hlsAppendEpoch || 0) + 1;
    provider.hlsAppendInvalidationCount = (provider.hlsAppendInvalidationCount || 0) + 1;
    provider.lastHlsAppendInvalidationReason = reason || 'lifecycle-change';
    var ledger = provider.hlsMuxedAppendLedger || {};
    for (var key in ledger) {
      if (!Object.prototype.hasOwnProperty.call(ledger, key)) continue;
      var entry = ledger[key];
      if (entry.audioAppended !== entry.videoAppended && !entry.partialCarryRecorded) {
        entry.partialCarryRecorded = true;
        provider.hlsMuxedPartialCarryCount = (provider.hlsMuxedPartialCarryCount || 0) + 1;
      }
      delete entry.outputs;
      entry.transaction = null;
    }
    return provider.hlsAppendEpoch;
  }

  function createHlsRecoveryTransaction(provider, epoch, reason) {
    return {
      epoch: epoch,
      reason: reason || 'native-recovery',
      videoSourceBuffer: provider && provider.sb || null,
      audioSourceBuffer: provider && provider.audioSb || null,
      videoTrack: provider || null,
      audioTrack: provider && provider.activeAudio || null,
      videoInitSegment: provider && provider.initSegment || null,
      audioInitSegment: provider && provider.audioInitSegment || null,
      staleAbortRecorded: false
    };
  }

  function hlsRecoveryTransactionIsCurrent(provider, transaction) {
    return !!(
      provider
      && transaction
      && !provider.destroyed
      && (provider.hlsAppendEpoch || 0) === transaction.epoch
      && provider.sb === transaction.videoSourceBuffer
      && provider.audioSb === transaction.audioSourceBuffer
      && provider.activeAudio === transaction.audioTrack
      && provider.initSegment === transaction.videoInitSegment
      && provider.audioInitSegment === transaction.audioInitSegment
    );
  }

  function assertHlsRecoveryTransactionCurrent(provider, transaction) {
    if (hlsRecoveryTransactionIsCurrent(provider, transaction)) return;
    if (provider && transaction && !transaction.staleAbortRecorded) {
      transaction.staleAbortRecorded = true;
      provider.hlsStaleRecoveryAbortCount = (provider.hlsStaleRecoveryAbortCount || 0) + 1;
    }
    throw abortError();
  }

  function hlsRecoveryTransactionGuard(provider, transaction) {
    return function () {
      assertHlsRecoveryTransactionCurrent(provider, transaction);
    };
  }

  function hlsMuxedAppendLedgerKey(seg) {
    return (seg && seg._hlsTimestampGenerationKey || '') + '|' + segmentKey(seg || {});
  }

  function hlsMuxedAppendLedgerEntry(provider, transaction) {
    provider.hlsMuxedAppendLedger = provider.hlsMuxedAppendLedger || {};
    var key = hlsMuxedAppendLedgerKey(transaction.segment);
    var entry = provider.hlsMuxedAppendLedger[key];
    if (
      !entry
      || entry.videoSourceBuffer !== transaction.primarySourceBuffer
      || entry.audioSourceBuffer !== transaction.audioSourceBuffer
    ) {
      entry = {
        key: key,
        segment: transaction.segment,
        videoSourceBuffer: transaction.primarySourceBuffer,
        audioSourceBuffer: transaction.audioSourceBuffer,
        audioAppended: false,
        videoAppended: false,
        transaction: null,
        partialCarryRecorded: false,
        lastResumeEpoch: -1
      };
      provider.hlsMuxedAppendLedger[key] = entry;
    } else {
      entry.segment = transaction.segment;
      if (entry.audioAppended && !sourceBufferCoversSegment(entry.audioSourceBuffer, transaction.segment)) {
        entry.audioAppended = false;
      }
      if (entry.videoAppended && !sourceBufferCoversSegment(entry.videoSourceBuffer, transaction.segment)) {
        entry.videoAppended = false;
      }
      if (
        entry.audioAppended !== entry.videoAppended
        && entry.lastResumeEpoch !== transaction.epoch
      ) {
        entry.lastResumeEpoch = transaction.epoch;
        provider.hlsMuxedLedgerResumeCount = (provider.hlsMuxedLedgerResumeCount || 0) + 1;
      }
    }
    entry.transaction = transaction;
    transaction.ledgerKey = key;
    return entry;
  }

  function createHlsAppendTransaction(provider, track, seg) {
    var kind = track && track.kind === 'audio' ? 'audio' : 'video';
    var sourceBufferField = kind === 'audio' ? 'audioSb' : 'sb';
    var primarySourceBuffer = track && track.sb
      ? track.sb
      : (provider ? provider[sourceBufferField] : null);
    var muxed = !!(
      provider
      && kind === 'video'
      && provider.muxedTsAudio
      && provider.audioSb
    );
    var transaction = {
      epoch: provider && provider.hlsAppendEpoch || 0,
      kind: kind,
      track: track || null,
      segment: seg || null,
      sourceBufferField: sourceBufferField,
      primarySourceBuffer: primarySourceBuffer || null,
      audioSourceBuffer: muxed ? provider.audioSb : null,
      muxed: muxed,
      muxedAppendState: null,
      staleAbortRecorded: false
    };
    if (muxed) transaction.muxedAppendState = hlsMuxedAppendLedgerEntry(provider, transaction);
    return transaction;
  }

  function hlsAppendTransactionIsCurrent(provider, transaction) {
    if (!provider || !transaction || provider.destroyed) return false;
    if ((provider.hlsAppendEpoch || 0) !== transaction.epoch) return false;
    var currentSourceBuffer = Object.prototype.hasOwnProperty.call(provider, transaction.sourceBufferField)
      ? provider[transaction.sourceBufferField]
      : transaction.track && transaction.track.sb;
    if (currentSourceBuffer !== transaction.primarySourceBuffer) return false;
    if (transaction.track && transaction.track.sb !== transaction.primarySourceBuffer) return false;
    if (transaction.muxed && provider.audioSb !== transaction.audioSourceBuffer) return false;
    return true;
  }

  function assertHlsAppendTransactionCurrent(provider, transaction) {
    if (hlsAppendTransactionIsCurrent(provider, transaction)) return;
    if (provider && transaction && !transaction.staleAbortRecorded) {
      transaction.staleAbortRecorded = true;
      provider.hlsStaleAppendAbortCount = (provider.hlsStaleAppendAbortCount || 0) + 1;
    }
    throw abortError();
  }

  function hlsAppendTransactionGuard(provider, transaction) {
    return function () {
      assertHlsAppendTransactionCurrent(provider, transaction);
    };
  }

  function appendHlsMuxedTsOutputs(provider, videoTrack, seg, outputs, appendState, appendTransaction) {
    appendTransaction = appendTransaction || appendState && appendState.transaction || null;
    appendState = appendState || appendTransaction && appendTransaction.muxedAppendState || {
      audioAppended: false,
      videoAppended: false
    };
    appendState.outputs = outputs;
    appendState.transaction = appendTransaction || appendState.transaction || null;
    appendTransaction = appendState.transaction;
    if (appendTransaction) {
      assertHlsAppendTransactionCurrent(provider, appendTransaction);
      appendTransaction.muxedAppendState = appendState;
    }
    var chain = Promise.resolve();
    if (!appendState.audioAppended) {
      chain = chain.then(function () {
        if (appendTransaction) assertHlsAppendTransactionCurrent(provider, appendTransaction);
        return provider._appendTransmuxedOutput(
          appendTransaction ? appendTransaction.audioSourceBuffer : provider.audioSb,
          outputs[1],
          provider._muxedAudioTrack,
          seg,
          appendTransaction
        );
      }).then(function () {
        appendState.audioAppended = true;
        appendState.partialCarryRecorded = false;
      });
    }
    if (!appendState.videoAppended) {
      chain = chain.then(function () {
        if (appendTransaction) assertHlsAppendTransactionCurrent(provider, appendTransaction);
        return provider._appendTransmuxedOutput(
          appendTransaction ? appendTransaction.primarySourceBuffer : videoTrack.sb,
          outputs[0],
          videoTrack,
          seg,
          appendTransaction
        );
      }).then(function () {
        appendState.videoAppended = true;
        appendState.partialCarryRecorded = false;
      });
    }
    return chain.then(function () {
      if (appendState.audioAppended && appendState.videoAppended) {
        delete appendState.outputs;
        appendState.transaction = null;
        if (
          appendState.key
          && provider.hlsMuxedAppendLedger
          && provider.hlsMuxedAppendLedger[appendState.key] === appendState
        ) {
          delete provider.hlsMuxedAppendLedger[appendState.key];
        }
        provider.hlsMuxedLedgerCompletionCount = (provider.hlsMuxedLedgerCompletionCount || 0) + 1;
      }
    }).catch(function (err) {
      // Quota recovery resumes this exact transaction. Retaining the already
      // generated fragments avoids a second demux/remux and, more importantly,
      // prevents a completed audio append from being duplicated when only the
      // video SourceBuffer ran out of space.
      if (err && err.name === 'AbortError' && appendState.transaction === appendTransaction) {
        delete appendState.outputs;
        appendState.transaction = null;
      }
      try { err._hlsMuxedTsAppendState = appendState; } catch (e) {}
      throw err;
    });
  }

  NativeHlsProvider.prototype._alignTsStartupTime = function () {
    if (!this.isTsPlaylist || this.startupBufferComplete || !this.video || !this.video.buffered.length) return;
    var start = this.video.buffered.start(0);
    if (start > 0 && (this.video.currentTime || 0) < start - TS_STARTUP_ALIGNMENT_MIN_GAP) {
      // Seeking to the exact intersection boundary can leave Chromium at
      // HAVE_METADATA even though MSE reports the range as buffered. This is
      // especially reproducible when muxed TS audio starts after a B-frame
      // video track. Land slightly inside the range so both decoders have a
      // sample available and startup does not emit a false rebuffer.
      var end = this.video.buffered.end(0);
      var padding = Math.min(BUFFERED_SEEK_PADDING, Math.max(0, (end - start) / 4));
      var target = Math.min(start + padding, Math.max(start, end - 0.001));
      assignInternalMediaTime(this, target);
    }
  };

  NativeHlsProvider.prototype._schedulerTime = function () {
    var pendingStart = pendingLoadStartTime(this);
    if (!this.startupBufferComplete && pendingStart != null) return pendingStart;
    if (this.live && this.liveWindow) {
      if (this.seekBufferPending && isFinite(this.lastSeekTarget)) return this._clampSeekTarget(this.lastSeekTarget);
      if (!this.startupBufferComplete && isFinite(this.startupLiveTarget)) return this._clampSeekTarget(this.startupLiveTarget);
    }
    return this.video.currentTime || 0;
  };

  NativeHlsProvider.prototype._alignHlsBufferedTarget = function () {
    if (!this.video || !this.video.buffered || !this.video.buffered.length) return;
    var pendingSeek = this.seekBufferPending && isFinite(this.lastSeekTarget);
    if (!this.live && !pendingSeek) return;
    var target = pendingSeek
      ? this._clampSeekTarget(this.lastSeekTarget)
      : (!this.startupBufferComplete && isFinite(this.startupLiveTarget) ? this._clampSeekTarget(this.startupLiveTarget) : NaN);
    if (!isFinite(target) || !bufferedContains(this.video.buffered, target)) return;
    var currentTime = this.video.currentTime || 0;
    // The live-start target is a lower bound for an uninitialized playhead,
    // not a clock to keep re-applying. Rewinding active playback here emits a
    // synthetic seeking event, aborts useful in-flight media, and can turn an
    // ABR boundary into a visible stall.
    if ((pendingSeek && Math.abs(currentTime - target) > 0.25) || (!pendingSeek && currentTime < target - 0.25)) {
      assignInternalMediaTime(this, target);
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
    assignInternalMediaTime(this, target);
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

  NativeHlsProvider.prototype._transmuxTsSegment = function (track, seg, data, contentType, tsContext) {
    var adapter = contentType === 'audio' ? this.tsAudioTransmuxer : this.tsVideoTransmuxer;
    if (!adapter) return Promise.reject(new Error('hls-ts-transmuxer-unavailable'));
    var self = this;
    tsContext = tsContext || prepareHlsTsTransmuxContext(this, track, seg, data);
    return adapter.transmux(data, {
      activeVariant: this.activeVariant,
      contentType: contentType,
      demux: tsContext.demux,
      segment: seg,
      timeline: tsContext.timeline,
      track: track
    }).then(function (output) {
      self.transmuxedSegmentCount++;
      if (contentType === 'audio') self.transmuxedAudioSegmentCount++;
      else self.transmuxedVideoSegmentCount++;
      output = normalizeTransmuxOutput(output);
      self.hlsTsCompositionOffsetSampleCount = (self.hlsTsCompositionOffsetSampleCount || 0)
        + (output.compositionOffsetSampleCount || 0);
      self.hlsTsMaxCompositionOffsetMs = Math.max(
        self.hlsTsMaxCompositionOffsetMs || 0,
        output.maxCompositionOffsetMs || 0
      );
      return output;
    });
  };

  NativeHlsProvider.prototype._recoverQuota = function (track, data, seg, appendError, appendTransaction) {
    var self = this;
    var muxedAppendState = appendError && appendError._hlsMuxedTsAppendState;
    appendTransaction = appendTransaction
      || muxedAppendState && muxedAppendState.transaction
      || createHlsAppendTransaction(this, track, seg);
    var removeEnd = Math.max(0, (this.video.currentTime || 0) - 5);
    var transactionStart = seg && isFinite(seg.start) ? seg.start : (this.video.currentTime || 0);
    var transactionEnd = seg && isFinite(seg.end) ? seg.end : (this.video.currentTime || 0);
    var forwardWindowStart = (this.video.currentTime || 0) + 5;
    var removeStart = Math.max(forwardWindowStart, transactionEnd + 0.05);

    function transactionBuffers() {
      var buffers = [appendTransaction.primarySourceBuffer];
      if (appendTransaction.muxed && appendTransaction.audioSourceBuffer) {
        buffers.push(appendTransaction.audioSourceBuffer);
      } else if (self.audioSb && buffers.indexOf(self.audioSb) === -1) {
        buffers.push(self.audioSb);
      }
      return buffers.filter(Boolean);
    }

    function reconcileEviction(sourceBuffer, removedRange) {
      if (!removedRange) return;
      var isPrimary = sourceBuffer === appendTransaction.primarySourceBuffer;
      var kind = isPrimary ? appendTransaction.kind : 'audio';
      var primaryRep = kind === 'audio' ? (isPrimary ? track : self.activeAudio) : self;
      reconcileHlsSegmentLedgers(self, kind, removedRange, primaryRep, appendTransaction.segment, false);
    }

    function evictBehind() {
      assertHlsAppendTransactionCurrent(self, appendTransaction);
      var guard = hlsAppendTransactionGuard(self, appendTransaction);
      return Promise.all(transactionBuffers().map(function (sourceBuffer) {
        return removeBufferBefore(sourceBuffer, removeEnd, guard).then(function (removedRange) {
          reconcileEviction(sourceBuffer, removedRange);
        });
      })).then(function () {
        assertHlsAppendTransactionCurrent(self, appendTransaction);
      });
    }

    function evictForward() {
      assertHlsAppendTransactionCurrent(self, appendTransaction);
      var guard = hlsAppendTransactionGuard(self, appendTransaction);
      self.hlsQuotaForwardEvictionCount = (self.hlsQuotaForwardEvictionCount || 0) + 1;
      return Promise.all(transactionBuffers().map(function (sourceBuffer) {
        var removeBeforeTransaction = transactionStart > forwardWindowStart + 0.1
          ? removeBufferRange(sourceBuffer, forwardWindowStart, transactionStart - 0.05, guard)
          : Promise.resolve();
        return removeBeforeTransaction.then(function (removedRange) {
          reconcileEviction(sourceBuffer, removedRange);
          return removeBufferAfter(sourceBuffer, removeStart, guard);
        }).then(function (removedRange) {
          reconcileEviction(sourceBuffer, removedRange);
        });
      })).then(function () {
        assertHlsAppendTransactionCurrent(self, appendTransaction);
      });
    }

    function resumeMuxedOutputs(outputs, state) {
      state = state || {
        audioAppended: false,
        videoAppended: false,
        transaction: appendTransaction
      };
      if (
        state.audioAppended
        && !sourceBufferCoversSegment(appendTransaction.audioSourceBuffer, seg || {})
      ) state.audioAppended = false;
      if (
        state.videoAppended
        && !sourceBufferCoversSegment(appendTransaction.primarySourceBuffer, seg || {})
      ) state.videoAppended = false;
      if (!state.audioAppended) {
        self.hlsTsMuxedQuotaAudioResumeCount = (self.hlsTsMuxedQuotaAudioResumeCount || 0) + 1;
      }
      if (!state.videoAppended) {
        self.hlsTsMuxedQuotaVideoResumeCount = (self.hlsTsMuxedQuotaVideoResumeCount || 0) + 1;
      }
      return appendHlsMuxedTsOutputs(self, track, seg || {}, outputs, state, appendTransaction);
    }

    function retryAppend(state) {
      assertHlsAppendTransactionCurrent(self, appendTransaction);
      var container = seg && seg._hlsContainer ? seg._hlsContainer : detectHlsMediaContainer(data, seg);
      if (container === 'mpegts' && track.kind === 'video' && self.muxedTsAudio && self.audioSb) {
        self._muxedAudioTrack = self._muxedAudioTrack || { id: 'muxed-audio', kind: 'audio', sb: self.audioSb };
        self._muxedAudioTrack.sb = self.audioSb;
        self.hlsTsMuxedQuotaRetryCount = (self.hlsTsMuxedQuotaRetryCount || 0) + 1;
        if (state && state.outputs) return resumeMuxedOutputs(state.outputs, state);
        var sharedTsContext = prepareHlsTsTransmuxContext(self, track, seg || {}, data);
        self.hlsTsSharedDemuxCount = (self.hlsTsSharedDemuxCount || 0) + 1;
        return Promise.all([
          self._transmuxTsSegment(track, seg || {}, data, 'video', sharedTsContext),
          self._prepareDiscontinuityAppend(self._muxedAudioTrack, seg || {}).then(function () {
            return self._transmuxTsSegment(track, seg || {}, data, 'audio', sharedTsContext);
          })
        ]).then(function (outputs) {
          assertHlsAppendTransactionCurrent(self, appendTransaction);
          return resumeMuxedOutputs(outputs, null);
        });
      }
      if (container === 'mpegts' && track.kind === 'video') {
        return self._transmuxTsSegment(track, seg || {}, data, 'video').then(function (output) {
          return self._appendTransmuxedOutput(
            appendTransaction.primarySourceBuffer,
            output,
            track,
            seg || {},
            appendTransaction
          );
        });
      }
      if (container === 'mpegts' && track.kind === 'audio') {
        return self._transmuxTsSegment(track, seg || {}, data, 'audio').then(function (output) {
          return self._appendTransmuxedOutput(
            appendTransaction.primarySourceBuffer,
            output,
            track,
            seg || {},
            appendTransaction
          );
        });
      }
      return appendBuffer(
        appendTransaction.primarySourceBuffer,
        data,
        null,
        hlsFmp4TimestampOffset(self, track, seg || {}, data),
        hlsAppendTransactionGuard(self, appendTransaction)
      );
    }

    return evictBehind().then(function () {
      return retryAppend(muxedAppendState);
    }).catch(function (err) {
      if (!isQuotaExceeded(err)) throw err;
      muxedAppendState = err && err._hlsMuxedTsAppendState || muxedAppendState;
      return evictForward().then(function () {
        return retryAppend(muxedAppendState);
      });
    }).catch(function (err) {
      if (!isQuotaExceeded(err) || track.kind !== 'video') throw err;
      assertHlsAppendTransactionCurrent(self, appendTransaction);
      var lower = self._lowerVariant();
      if (!lower) throw err;
      self.hlsQuotaDownswitchCount = (self.hlsQuotaDownswitchCount || 0) + 1;
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
    if (this.destroyed || this.nativeRecoveryInProgress || this.trackTransitionInFlight) return Promise.resolve(false);
    reason = reason || 'native-recovery';
    var recoveryEpoch = invalidateHlsAppendTransactions(this, reason);
    var transaction = createHlsRecoveryTransaction(this, recoveryEpoch, reason);
    var guard = hlsRecoveryTransactionGuard(this, transaction);
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
    guard();
    var chain = Promise.all([
      transaction.videoSourceBuffer ? resetSourceBuffer(transaction.videoSourceBuffer, currentTime, guard) : Promise.resolve(),
      transaction.audioSourceBuffer ? resetSourceBuffer(transaction.audioSourceBuffer, currentTime, guard) : Promise.resolve()
    ]).then(function (removedRanges) {
      guard();
      reconcileHlsSegmentLedgers(self, 'video', removedRanges[0], transaction.videoTrack, null, false);
      reconcileHlsSegmentLedgers(self, 'audio', removedRanges[1], transaction.audioTrack, null, false);
      markSegmentsForTime(transaction.videoTrack, currentTime, Math.max(2, self._bufferAheadGoal()));
      if (transaction.audioTrack) markSegmentsForTime(transaction.audioTrack, currentTime, Math.max(2, self._bufferAheadGoal()));
      var initChain = Promise.resolve();
      if (transaction.videoInitSegment && transaction.videoSourceBuffer) {
        initChain = initChain.then(function () {
          guard();
          return self._fetchRange(transaction.videoInitSegment.url, transaction.videoInitSegment.range, { phase: 'metadata' }).then(function (initData) {
            guard();
            var generationKey = hlsTrackInitialTimestampGenerationKey(self, transaction.videoTrack);
            return appendHlsInitBuffer(
              self,
              transaction.videoTrack,
              transaction.videoSourceBuffer,
              transaction.videoInitSegment,
              initData,
              generationKey,
              guard
            ).then(function () {
              guard();
              self._appendedVideoInitKey = hlsInitSegmentKey(transaction.videoInitSegment);
              self._appendedVideoInitGenerationKey = generationKey;
              self._sourceBufferVideoInitSegment = transaction.videoInitSegment;
            });
          });
        });
      }
      if (transaction.audioInitSegment && transaction.audioSourceBuffer) {
        initChain = initChain.then(function () {
          guard();
          return self._fetchRange(transaction.audioInitSegment.url, transaction.audioInitSegment.range, { phase: 'metadata' }).then(function (initData) {
            guard();
            var generationKey = hlsTrackInitialTimestampGenerationKey(self, transaction.audioTrack);
            return appendHlsInitBuffer(
              self,
              transaction.audioTrack,
              transaction.audioSourceBuffer,
              transaction.audioInitSegment,
              initData,
              generationKey,
              guard
            ).then(function () {
              guard();
              self._appendedAudioInitKey = hlsInitSegmentKey(transaction.audioInitSegment);
              self._appendedAudioInitGenerationKey = generationKey;
              self._sourceBufferAudioInitSegment = transaction.audioInitSegment;
            });
          });
        });
      }
      return initChain;
    }).then(function () {
      guard();
      self.nativeRecoverySuccessCount++;
      self.appendFailures = 0;
      self.stallReports = 0;
      self.nativeRecoveryInProgress = false;
      self._tick(true);
      return true;
    }).catch(function (err) {
      self.nativeRecoveryInProgress = false;
      if (!hlsRecoveryTransactionIsCurrent(self, transaction) || err && err.name === 'AbortError') {
        if (!transaction.staleAbortRecorded) {
          transaction.staleAbortRecorded = true;
          self.hlsStaleRecoveryAbortCount = (self.hlsStaleRecoveryAbortCount || 0) + 1;
        }
        if (self.nativeRecoveryReasons) delete self.nativeRecoveryReasons[reason];
        return false;
      }
      self.lastError = err && err.message ? err.message : reason + '-failed';
      return false;
    });
    return chain;
  };

  NativeHlsProvider.prototype._recoverMediaRequest = function (err, track) {
    var reason = err && err.message ? err.message : 'hls-media-request-failed';
    var trackKind = track && track.kind === 'audio' ? 'audio' : 'video';
    this.mediaUrlRefreshCount++;
    this.recoveryCount++;
    this.lastError = reason;
    if (err && err.status) this.lastHttpStatus = err.status;
    var self = this;
    function refresh(retriedStale) {
      return self._refreshMediaPlaylist('media-error', trackKind).then(function (outcome) {
        var trackOutcome = outcome && outcome[trackKind];
        if (trackOutcome && trackOutcome.stale) {
          if (!retriedStale) return refresh(true);
          throw new Error('hls-' + trackKind + '-media-refresh-stale');
        }
        return outcome;
      });
    }
    return refresh(false);
  };

  NativeHlsProvider.prototype._fetchReloadPlaylist = function (url, track, useDeliveryDirectives, timeoutMs, signal) {
    var self = this;
    var requestUrl = useDeliveryDirectives ? hlsBlockingReloadUrl(url, track) : url;
    var requestOptions = timeoutMs || signal ? { timeoutMs: timeoutMs, signal: signal } : undefined;
    if (requestUrl === url) return this._fetchPlaylistText(url, requestOptions);
    this.blockingReloadRequestCount++;
    return this._fetchPlaylistText(requestUrl, requestOptions).then(function (text) {
      self.blockingReloadResponseCount++;
      return text;
    }).catch(function (err) {
      if (self.destroyed || (err && (err.name === 'AbortError' || err.name === 'TimeoutError'))) throw err;
      // A CDN can strip or reject delivery directives even when the origin
      // advertised them. Recover with an ordinary reload in the same cycle.
      self.blockingReloadFallbackCount++;
      return self._fetchPlaylistText(url, requestOptions);
    });
  };

  NativeHlsProvider.prototype._refreshMediaPlaylist = function (reason, recoveryTrackKind) {
    var self = this;
    if (!this.activeVariant || !this.activeVariant.url) return Promise.reject(new Error('hls-refresh-unavailable'));
    var refreshKey = this.activeVariant.url + '|' + (this.activeAudio && this.activeAudio.url ? this.activeAudio.url : '');
    if (this.playlistRefreshPromise && this.playlistRefreshKey === refreshKey) {
      // A refresh that began before a media failure cannot prove that it
      // contains replacement URLs for that failure. Let it settle, then issue
      // a causally newer media-error refresh. Concurrent media failures may
      // still share the same media-error refresh.
      if (reason === 'media-error' && this.playlistRefreshReasonInFlight !== 'media-error') {
        return this.playlistRefreshPromise.catch(function () {}).then(function () {
          return NativeHlsProvider.prototype._refreshMediaPlaylist.call(self, reason, recoveryTrackKind);
        });
      }
      return this.playlistRefreshPromise;
    }
    var refreshGeneration = (this.playlistRefreshGeneration || 0) + 1;
    this.playlistRefreshGeneration = refreshGeneration;
    var steeringTransaction = null;
    var owningTransition = this.trackTransitionInFlight;
    var transitionSignal = owningTransition && owningTransition.controller ? owningTransition.controller.signal : undefined;
    var refreshPromise = this._refreshContentSteering('refresh', transitionSignal).then(function () {
      steeringTransaction = self._applyContentSteeringToActiveVariant();
      var selectedVariant = self.activeVariant;
      var selectedAudio = self.activeAudio;
      var selectedTrackGeneration = self.trackTransitionGeneration || 0;
      var refreshSnapshot = captureHlsTrackTransitionState(self);
      refreshKey = selectedVariant.url + '|' + (selectedAudio && selectedAudio.url ? selectedAudio.url : '');
      self.playlistRefreshKey = refreshKey;
      var beforeVideo = hlsDeliveryCursor(self);
      var beforeAudio = hlsDeliveryCursor(selectedAudio);
      var blockingRefresh = self.live && (reason === 'live' || reason === 'live-low-buffer');
      var refreshTimeoutMs = Math.max(1500, Math.min(10000, (self.targetDuration || 2) * 2000));
      var videoPlaylist = self._fetchReloadPlaylist(selectedVariant.url, self, blockingRefresh, refreshTimeoutMs, transitionSignal);
      var audioPlaylist = selectedAudio && selectedAudio.url
        ? self._fetchReloadPlaylist(selectedAudio.url, selectedAudio, blockingRefresh, refreshTimeoutMs, transitionSignal)
        : Promise.resolve(null);
      var videoFetch = settleHlsPlaylistFetch(videoPlaylist, 'video', refreshTimeoutMs);
      var audioFetch = selectedAudio && selectedAudio.url
        ? settleHlsPlaylistFetch(audioPlaylist, 'audio', refreshTimeoutMs)
        : Promise.resolve(null);
      return Promise.all([videoFetch, audioFetch]).then(function (fetches) {
        if (
          refreshGeneration !== self.playlistRefreshGeneration
          || selectedVariant !== self.activeVariant
          || selectedAudio !== self.activeAudio
        ) {
          self.staleManifestResponseCount = (self.staleManifestResponseCount || 0) + (selectedAudio ? 2 : 1);
          return {
            stale: true,
            outcomes: [
              hlsTrackRefreshOutcome('video', false, true, false, false),
              selectedAudio ? hlsTrackRefreshOutcome('audio', false, true, false, false) : null
            ]
          };
        }
        var draftInfo = createHlsPlaylistRefreshDraft(self, selectedVariant, selectedAudio);
        var draft = draftInfo.provider;
        var preparedPlaylists = { video: null, audio: null };
        self.playlistManifestStageCount = (self.playlistManifestStageCount || 0) + 1;
        var stagedVideo = fetches[0] && fetches[0].failed
          ? Promise.resolve(fetches[0])
          : settleHlsPlaylistApplication('video', function () {
            preparedPlaylists.video = parseHlsPlaylist(fetches[0].text, selectedVariant.url);
            return draft._loadMediaPlaylist(
              fetches[0].text,
              selectedVariant.url,
              selectedVariant,
              cloneHlsRefreshValue(preparedPlaylists.video, [], [])
            );
          });
        var stagedAudio = !selectedAudio
          ? Promise.resolve(null)
          : fetches[1] && fetches[1].failed
            ? Promise.resolve(fetches[1])
            : settleHlsPlaylistApplication('audio', function () {
              preparedPlaylists.audio = parseHlsPlaylist(fetches[1].text, selectedAudio.url);
              return draft._loadAudioPlaylist(
                fetches[1].text,
                selectedAudio.url,
                draftInfo.audio,
                cloneHlsRefreshValue(preparedPlaylists.audio, [], [])
              );
            });
        return Promise.all([stagedVideo, stagedAudio]).then(function (outcomes) {
          return {
            draftInfo: draftInfo,
            fetches: fetches,
            preparedPlaylists: preparedPlaylists,
            outcomes: outcomes
          };
        });
      }).then(function (staged) {
        var videoOutcome = staged.outcomes[0] || hlsTrackRefreshOutcome('video', false, false, false, false);
        var audioOutcome = staged.outcomes[1];
        if (staged.stale) {
          return {
            applied: false,
            stale: true,
            partial: false,
            reason: reason || 'manual',
            video: videoOutcome,
            audio: audioOutcome
          };
        }
        var draft = staged.draftInfo.provider;
        var requiredAudio = !!(selectedAudio && selectedAudio.url);
        var anyEpochReset = !!(videoOutcome.epochReset || audioOutcome && audioOutcome.epochReset);
        var bothTracksReady = !!(
          videoOutcome.applied && !videoOutcome.stale && !videoOutcome.failed
          && (!requiredAudio || audioOutcome && audioOutcome.applied && !audioOutcome.stale && !audioOutcome.failed)
        );
        var alignedEpochTracks = !requiredAudio || hlsEpochTrackWindowsCompatible(draft, draft.activeAudio);
        if (anyEpochReset && requiredAudio && (!bothTracksReady || !alignedEpochTracks)) {
          var attemptedCursors = clonePlain(draft.playlistCursorByUrl || {});
          var attemptedCandidates = clonePlain(draft.playlistResetCandidateByUrl || {});
          var retainedCandidates = clonePlain(self.playlistResetCandidateByUrl || {});
          for (var candidateUrl in attemptedCandidates) {
            if (Object.prototype.hasOwnProperty.call(attemptedCandidates, candidateUrl)) {
              retainedCandidates[candidateUrl] = attemptedCandidates[candidateUrl];
            }
          }
          if (videoOutcome.epochReset && attemptedCursors[selectedVariant.url]) {
            retainedCandidates[selectedVariant.url] = { cursor: attemptedCursors[selectedVariant.url] };
          }
          if (audioOutcome && audioOutcome.epochReset && attemptedCursors[selectedAudio.url]) {
            retainedCandidates[selectedAudio.url] = { cursor: attemptedCursors[selectedAudio.url] };
          }
          self.playlistResetCandidateByUrl = retainedCandidates;
          self.playlistManifestDiscardCount = (self.playlistManifestDiscardCount || 0) + 1;
          self.playlistEpochHoldCount = (self.playlistEpochHoldCount || 0) + 1;
          self.lastPlaylistEpochHoldReason = !bothTracksReady
            ? 'required-track-not-ready'
            : 'required-track-timeline-mismatch';
          videoOutcome.applied = false;
          videoOutcome.stale = true;
          videoOutcome.advanced = false;
          videoOutcome.epochHeld = true;
          if (audioOutcome) {
            audioOutcome.applied = false;
            audioOutcome.stale = true;
            audioOutcome.advanced = false;
            audioOutcome.epochHeld = true;
          }
          self.lastPlaylistRefreshAdvanced = false;
          self.lastAudioPlaylistRefreshAdvanced = false;
          var heldOutcome = {
            applied: false,
            stale: true,
            partial: false,
            epochHeld: true,
            reason: reason || 'manual',
            video: videoOutcome,
            audio: audioOutcome
          };
          if (self.trackTransitionInFlight) {
            var heldError = new Error('hls-epoch-refresh-held');
            heldError.hlsEpochHeldOutcome = heldOutcome;
            throw heldError;
          }
          return heldOutcome;
        }
        var requiredAudioFailed = !!(audioOutcome && audioOutcome.failed && (
          reason === 'variant-switch'
          || reason === 'audio-switch'
          || (reason === 'media-error' && recoveryTrackKind === 'audio')
        ));
        if (videoOutcome.failed || requiredAudioFailed) {
          throw (videoOutcome.failed ? videoOutcome.error : audioOutcome.error);
        }
        self.playlistManifestCommitInProgress = true;
        var committedVideo = settleHlsPlaylistApplication('video', function () {
          return self._loadMediaPlaylist(
            staged.fetches[0].text,
            selectedVariant.url,
            selectedVariant,
            staged.preparedPlaylists.video
          );
        });
        var committedAudio = !selectedAudio || staged.fetches[1] && staged.fetches[1].failed
          ? Promise.resolve(audioOutcome)
          : settleHlsPlaylistApplication('audio', function () {
            return self._loadAudioPlaylist(
              staged.fetches[1].text,
              selectedAudio.url,
              selectedAudio,
              staged.preparedPlaylists.audio
            );
          });
        return Promise.all([committedVideo, committedAudio]).then(function (committedOutcomes) {
          videoOutcome = committedOutcomes[0] || videoOutcome;
          audioOutcome = committedOutcomes[1];
          var committedRequiredAudioFailed = !!(audioOutcome && audioOutcome.failed && (
            reason === 'variant-switch'
            || reason === 'audio-switch'
            || (reason === 'media-error' && recoveryTrackKind === 'audio')
          ));
          if (videoOutcome.failed || committedRequiredAudioFailed) {
            restoreHlsTrackTransitionState(self, refreshSnapshot);
            throw (videoOutcome.failed ? videoOutcome.error : audioOutcome.error);
          }
          self.lastPlaylistEpochHoldReason = '';
          self.lastPlaylistRefreshAdvanced = videoOutcome.advanced || hlsCursorAdvanced(beforeVideo, hlsDeliveryCursor(self));
          self.lastAudioPlaylistRefreshAdvanced = !!(audioOutcome && (audioOutcome.advanced || hlsCursorAdvanced(beforeAudio, hlsDeliveryCursor(selectedAudio))));
          var outcome = {
            applied: !!(videoOutcome.applied || audioOutcome && audioOutcome.applied),
            stale: !!(videoOutcome.stale || audioOutcome && audioOutcome.stale),
            partial: !!(audioOutcome && audioOutcome.failed),
            reason: reason || 'manual',
            video: videoOutcome,
            audio: audioOutcome
          };
          var reconcile = self._reconcileTrackLifecycle
            ? self._reconcileTrackLifecycle(selectedTrackGeneration)
            : Promise.resolve();
          return reconcile.then(function () {
            self.playlistManifestCommitGeneration = (self.playlistManifestCommitGeneration || 0) + 1;
            self.playlistManifestCommitCount = (self.playlistManifestCommitCount || 0) + 1;
            self.playlistManifestCommitInProgress = false;
            if (self._tick) self._tick(true);
            if (steeringTransaction && self._isTrackTransitionCurrent(steeringTransaction)) {
              self._finishTrackTransition(steeringTransaction, true);
              self.contentSteeringSwitchCount++;
              self.engine._player.emit('variantchanged');
            }
            return outcome;
          }, function (err) {
            self.playlistManifestCommitInProgress = false;
            throw err;
          });
        });
      });
    });
    refreshPromise = refreshPromise.catch(function (err) {
      self.playlistManifestCommitInProgress = false;
      if (!steeringTransaction || !self._ownsTrackTransition(steeringTransaction)) throw err;
      return self._rollbackTrackTransition(steeringTransaction).then(function () {
        self._finishTrackTransition(steeringTransaction, false);
        if (err && err.hlsEpochHeldOutcome) return err.hlsEpochHeldOutcome;
        throw err;
      }, function (rollbackErr) {
        self._finishTrackTransition(steeringTransaction, false);
        throw rollbackErr;
      });
    });
    var trackedPromise = refreshPromise.then(function (value) {
      if (self.playlistRefreshPromise === trackedPromise) {
        self.playlistRefreshPromise = null;
        self.playlistRefreshKey = '';
        self.playlistRefreshReasonInFlight = '';
      }
      return value;
    }, function (err) {
      if (self.playlistRefreshPromise === trackedPromise) {
        self.playlistRefreshPromise = null;
        self.playlistRefreshKey = '';
        self.playlistRefreshReasonInFlight = '';
      }
      throw err;
    });
    this.playlistRefreshKey = refreshKey;
    this.playlistRefreshReasonInFlight = reason || 'manual';
    this.playlistRefreshPromise = trackedPromise;
    return trackedPromise;
  };

  NativeHlsProvider.prototype._maybeRefreshLiveLowBuffer = function (ahead) {
    // The scheduled refresh owns manifest updates until startup buffering is ready.
    // Refreshing here during the initial tick can immediately consume TTL=0 content
    // steering responses and replace the selected startup pathway before it is used.
    if (
      !this.startupBufferComplete
      || !this.live
      || !this.liveWindow
      || this.destroyed
      || this.liveRefreshInFlight
      || this.playlistRefreshPromise
    ) return;
    var currentTime = this.video.currentTime || 0;
    var nearEdge = this.liveWindow.end - currentTime <= Math.max(MIN_BUFFER_AHEAD, this._targetLiveLatency() + 2);
    if (!nearEdge || ahead >= MIN_BUFFER_AHEAD) return;
    var now = performance.now();
    var minInterval = Math.max(500, (this.targetDuration || 2) * 500);
    if (this.lastLiveRefreshStartedAt && now - this.lastLiveRefreshStartedAt < minInterval) return;
    this.liveRefreshInFlight = true;
    this.lastLiveRefreshStartedAt = now;
    this.liveLowBufferRefreshCount++;
    var self = this;
    this._refreshMediaPlaylist('live-low-buffer').then(function (outcome) {
      self._evictExpiredLiveSegmentState();
      self.playlistRefreshFailed = !!(outcome && outcome.partial);
      if (outcome && outcome.partial && outcome.audio && outcome.audio.error) {
        self.lastError = outcome.audio.error.message || 'hls-audio-playlist-refresh-failed';
      }
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
      if (self.destroyed) return;
      if (self.liveRefreshInFlight) {
        clearTimeout(self.playlistRefreshTimer);
        self.playlistRefreshTimer = setTimeout(function () {
          self._schedulePlaylistRefresh();
        }, 100);
        return;
      }
      self.liveRefreshInFlight = true;
      self.lastLiveRefreshStartedAt = performance.now();
      self._refreshMediaPlaylist('live').then(function (outcome) {
        self._evictExpiredLiveSegmentState();
        self.playlistRefreshFailed = !!(outcome && outcome.partial);
        if (outcome && outcome.partial && outcome.audio && outcome.audio.error) {
          self.lastError = outcome.audio.error.message || 'hls-audio-playlist-refresh-failed';
        }
        self.liveRefreshInFlight = false;
        self._tick(true);
        self._schedulePlaylistRefresh();
      }).catch(function (err) {
        self.lastError = err && err.message ? err.message : 'hls-live-refresh-failed';
        self.playlistRefreshFailed = true;
        self.liveRefreshInFlight = false;
        self._schedulePlaylistRefresh();
      });
    }, this._playlistRefreshDelay());
  };

  NativeHlsProvider.prototype._playlistRefreshDelay = function () {
    var targetMs = Math.max(500, (this.targetDuration || 2) * 1000);
    if (this.lowLatencyPlaylist && this.serverControl && this.serverControl.canBlockReload) {
      // A successful blocking response already contains the requested future
      // part, so immediately issue the next blocking request. If a server
      // ignored the directive and returned an unchanged Playlist, honor the
      // standard half-Target-Duration retry floor.
      return this.lastPlaylistRefreshAdvanced ? 0 : Math.max(500, targetMs / 2);
    }
    if (!this.lastPlaylistRefreshAdvanced) return Math.max(500, targetMs / 2);
    var tail = this.segments && this.segments.length ? this.segments[this.segments.length - 1] : null;
    var tailMs = tail && tail.duration > 0 ? tail.duration * 1000 : targetMs;
    return Math.max(250, Math.min(targetMs, tailMs));
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
    if (!this.sb && !this.audioSb) return;
    if (this.sb) trimBuffer(this.sb, Math.max(0, (this.video.currentTime || 0) - this._bufferBehindGoal()));
    if (this.audioSb) trimBuffer(this.audioSb, Math.max(0, (this.video.currentTime || 0) - this._bufferBehindGoal()));
  };

  NativeHlsProvider.prototype._checkBufferMilestones = function () {
    var goal = this.seekBufferPending ? this._seekBufferGoal() : this._startupBufferGoal();
    // Encoded segment boundaries commonly land a few microseconds before their
    // declared EXTINF duration. Treat a 50ms margin as satisfying the goal so
    // startup does not remain pinned to the first live segment forever.
    var bufferedAhead = this.seekBufferPending
      ? getBufferAheadAt(this.video, this.lastSeekTarget, 0.05)
      : getBufferAhead(this.video);
    var ready = bufferedAhead + 0.05 >= startupBufferRequirement(this, goal);
    if (ready && !this.startupBufferComplete) {
      markStartupBufferReady(this);
    }
    if (ready && this.seekBufferPending) {
      completeSeekBuffer(this, this.activeSeekGeneration, false);
    }
  };

  NativeHlsProvider.prototype._abortRequests = function () {
    var cancelled = this.controllers.length + countKeys(this.activeRanges)
      + (this._videoTrack && (this._videoTrack._appendOwner || this._videoTrack._appending) ? 1 : 0);
    resetActiveSegmentRequests(this);
    if (this._videoTrack) resetActiveSegmentRequests(this._videoTrack);
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
    if (this.live && this.lowLatencyPlaylist) return goal === BUFFER_AHEAD ? LOW_LATENCY_BUFFER_AHEAD : goal;
    return this.live ? Math.max(goal, LIVE_BUFFER_AHEAD) : goal;
  };

  NativeHlsProvider.prototype._startupBufferGoal = function () {
    var cfg = this.engine._player.config.streaming || {};
    var goal = Math.max(1, cfg.startupBufferGoal || STARTUP_BUFFER_GOAL);
    return this.live && this.lowLatencyPlaylist && goal === STARTUP_BUFFER_GOAL ? 1 : goal;
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
    var goal = Math.max(0, cfg.bufferBehind == null ? BUFFER_BEHIND : cfg.bufferBehind);
    return this.live && goal === BUFFER_BEHIND ? LIVE_BUFFER_BEHIND : goal;
  };

  NativeHlsProvider.prototype._targetLiveLatency = function () {
    var advertised = this.serverControl && Number(
      this.lowLatencyPlaylist ? this.serverControl.partHoldBack : this.serverControl.holdBack
    );
    if (isFinite(advertised) && advertised > 0) return advertised;
    var partTarget = Number(this.partTargetDuration) || 0;
    if (this.lowLatencyPlaylist && partTarget > 0) return partTarget * 3;
    var targetDuration = Number(this.targetDuration) || 0;
    return targetDuration > 0 ? targetDuration * 3 : LIVE_TARGET_LATENCY;
  };

  NativeHlsProvider.prototype._defaultLiveStartTime = function () {
    if (!this.liveWindow) return this.video.currentTime || 0;
    return Math.max(this.liveWindow.start, this.liveWindow.end - this._targetLiveLatency());
  };

  NativeHlsProvider.prototype._updateLivePositionStats = function () {
    if (!this.live || !this.liveWindow) {
      this.liveLatency = 0;
      this.atLiveEdge = false;
      return;
    }
    this.liveLatency = Math.max(0, this.liveWindow.end - (this.video.currentTime || 0));
    this.atLiveEdge = this.liveLatency <= this._targetLiveLatency() + 1;
  };

  NativeHlsProvider.prototype.getLiveRange = function () {
    return this.live && this.liveWindow ? { start: this.liveWindow.start, end: this.liveWindow.end } : null;
  };

  NativeHlsProvider.prototype.seekRange = function () {
    var liveRange = this.getLiveRange();
    if (liveRange) return liveRange;
    if (isFinite(this.duration) && this.duration > 0) return { start: 0, end: this.duration };
    return mediaSeekRange(this.video);
  };

  NativeHlsProvider.prototype.seekToLiveEdge = function () {
    if (!this.liveWindow) return;
    this.commitSeek(Math.max(this.liveWindow.start, this.liveWindow.end - this._targetLiveLatency()));
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
    return beginSeekOperation(this, target).target;
  };

  NativeHlsProvider.prototype.commitSeek = function (targetTime) {
    var target = this._clampSeekTarget(targetTime);
    if (!seekOperationMatches(this, target)) this.beginSeek(target);
    var generation = this.activeSeekGeneration;
    this.seekCount++;
    try { this.video.currentTime = target; } catch (e) {}
    this._onSeek(target, generation);
    return target;
  };

  NativeHlsProvider.prototype.cancelSeek = function () {
    this.seekCancelCount++;
    cancelSeekOperation(this);
  };

  NativeHlsProvider.prototype.endSeek = function (generation) {
    return finishSeekInteraction(this, generation);
  };

  NativeHlsProvider.prototype._completeSeekBuffer = function (generation, buffered) {
    return completeSeekBuffer(this, generation, buffered);
  };

  NativeHlsProvider.prototype.seekDuringRecovery = function (targetTime) {
    this.commitSeek(targetTime);
  };

  NativeHlsProvider.prototype._onSeek = function (targetTime, generation) {
    if (this.destroyed) return;
    var target = this._clampSeekTarget(targetTime == null ? this.video.currentTime : targetTime);
    if (
      !(generation > 0)
      || generation !== this.activeSeekGeneration
      || Math.abs(target - this.lastSeekTarget) > 0.05
    ) {
      generation = beginSeekOperation(this, target).generation;
    }
    var now = performance.now();
    if (
      this._lastSeekHandledGeneration === generation
      && this._lastSeekHandledTarget !== null
      && Math.abs(target - this._lastSeekHandledTarget) <= 0.05
      && now - this._lastSeekHandledAt < 100
    ) return;
    this._lastSeekHandledTarget = target;
    this._lastSeekHandledAt = now;
    this._lastSeekHandledGeneration = generation;
    if (Math.abs(target - (this.video.currentTime || 0)) > 0.05) {
      try { this.video.currentTime = target; } catch (e) {}
    }
    this.lastSeekTarget = target;
    if (bufferedContains(this.video.buffered, target)) {
      completeSeekBuffer(this, generation, true);
      return;
    }
    invalidateHlsAppendTransactions(this, 'seek');
    // A seek may arrive immediately after the first frame while an automatic
    // rendition switch is fetching its playlist/init segment. Let that
    // metadata transition finish; the post-switch scheduler will use
    // lastSeekTarget and request only the sought media.
    var cancelled = this.variantSwitchInFlight ? 0 : this._abortRequests();
    if (cancelled > 0) this.seekAbortCount += cancelled;
    prepareVodStreamRefill(this);
    prepareSegmentsForRefill(this, this.sb || this.video, target, Math.max(2, this._seekBufferGoal()));
    if (this.activeAudio) prepareSegmentsForRefill(this.activeAudio, this.audioSb || this.video, target, Math.max(2, this._seekBufferGoal()));
    this._tick(true);
  };

  NativeHlsProvider.prototype._jumpSmallGap = function () {
    var gap = nextBufferedGap(this.video);
    if (!gap || gap.size <= 0 || gap.size > MAX_GAP_JUMP) return false;
    try {
      assignInternalMediaTime(this, gap.start + 0.01);
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

  NativeHlsProvider.prototype._jumpManifestGap = function () {
    return jumpDeclaredManifestGap(this, 'hls');
  };

  NativeHlsProvider.prototype.reportStall = function () {
    if (this._jumpManifestGap && this._jumpManifestGap()) return;
    var reopeningEndedVod = prepareVodStreamRefill(this);
    this._tick(true);
    if (getBufferAhead(this.video) >= 0.5) return;
    if (this._jumpSmallGap()) return;
    this.stallReports++;
    this.lastError = 'stall';
    if (this.engine && this.engine._telemetry) this.engine._telemetry.record('recovery', { lastError: 'stall' });
    if (this.stallRecoveryStage === 0) {
      this.stallRecoveryStage = 1;
      if (reopeningEndedVod) {
        prepareSegmentsForRefill(this, this.sb || this.video, this.video.currentTime || 0, Math.max(2, this._bufferAheadGoal()));
        if (this.activeAudio) prepareSegmentsForRefill(this.activeAudio, this.audioSb || this.video, this.video.currentTime || 0, Math.max(2, this._bufferAheadGoal()));
      } else {
        markSegmentsForTime(this, this.video.currentTime || 0, Math.max(2, this._bufferAheadGoal()));
        if (this.activeAudio) markSegmentsForTime(this.activeAudio, this.video.currentTime || 0, Math.max(2, this._bufferAheadGoal()));
      }
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
    if (opts.revalidate) headers['Cache-Control'] = 'no-cache';
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
      if (opts.onTiming) {
        opts.onTiming({
          byteLength: resp.data ? resp.data.byteLength : 0,
          timeMs: resp.timeMs,
          timeToFirstByteMs: resp.timeToFirstByteMs,
          downloadTimeMs: resp.downloadTimeMs
        });
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
            onTiming: opts.onTiming,
            revalidate: opts.revalidate,
            attempts: attempts,
            attempt: attempt + 1
          });
        });
      }
      self.lastError = err && err.message ? err.message : 'hls-range-error';
      throw err;
    });
  };

  NativeHlsProvider.prototype._fetchPlaylistText = function (url, requestOptions) {
    var self = this;
    return fetchText(this.engine, url, function (swInfo) {
      self._recordServiceWorkerFetch(swInfo, 'manifest');
    }, requestOptions).catch(function (err) {
      if (err && /^manifest-http-/.test(err.message || '') && self.engine && self.engine._offlinePlayback) {
        self.lastOfflineError = 'offline-' + err.message;
        self.engine._recordOfflineError(new Error(self.lastOfflineError));
      }
      throw err;
    });
  };

  NativeHlsProvider.prototype._refreshContentSteering = function (reason, signal) {
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
    }, signal ? { signal: signal } : undefined).then(function (resp) {
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
      self._chooseContentSteeringPathway(priority);
      return true;
    }).catch(function (err) {
      if (err && err.name === 'AbortError') throw err;
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

  NativeHlsProvider.prototype._recordBandwidthSample = function (byteLength, elapsedMs, timeToFirstByteMs) {
    var sampleDuration = bandwidthSampleDuration(this, elapsedMs, timeToFirstByteMs);
    var sample = (byteLength * 8 * 1000) / sampleDuration;
    if (!isFinite(sample) || sample <= 0) return;
    this.lastBandwidthSample = sample;
    this.bandwidthSamples = (this.bandwidthSamples || 0) + 1;
    updateBandwidthEstimate(this, sample, sampleDuration);
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
    if (!this.activeVariant || this.manualTrackId || !this.contentSteeringPathwayId || this.trackTransitionInFlight) return null;
    if (this.activeVariant.pathwayId === this.contentSteeringPathwayId) return null;
    var next = this._chooseForBudget(this._candidateVariants(), 0.8);
    if (!next || next === this.activeVariant || next.pathwayId !== this.contentSteeringPathwayId) return null;
    var transaction = this._beginTrackTransition('content-steering');
    if (!transaction) return null;
    this.activeVariant = next;
    for (var i = 0; i < this.variants.length; i++) this.variants[i].active = this.variants[i] === next;
    this.activeAudio = this._chooseAudioRendition(next) || this.activeAudio;
    this.lastSwitchReason = 'content-steering';
    this.lastSwitchAt = performance.now();
    return transaction;
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
    if (!variant || this.destroyed || this.activeVariant === variant || this.variantSwitchInFlight) return;
    if (this.trackTransitionInFlight) {
      if (reason === 'manual') {
        this.pendingManualVariantSwitch = { variantId: variant.id, clearBuffer: clearBuffer !== false };
      }
      return;
    }
    var self = this;
    var transaction = this._beginTrackTransition(reason || 'variant-switch');
    if (!transaction) return;
    if (reason === 'manual') {
      this.manualTrackId = variant.id;
      this.engine._player.config.abr.enabled = false;
    }
    this._abortRequests();
    this.variantSwitchInFlight = true;
    this.activeVariant = variant;
    this.lastSwitchAt = performance.now();
    for (var i = 0; i < this.variants.length; i++) this.variants[i].active = this.variants[i] === variant;
    this.activeAudio = this._chooseAudioRendition(variant) || this.activeAudio;
    this.lastSwitchReason = reason || (clearBuffer ? 'manual' : 'auto');
    this._refreshMediaPlaylist('variant-switch').then(function () {
      if (!self._isTrackTransitionCurrent(transaction)) throw abortError();
      if (clearBuffer) {
        markSegmentsUnappended(self);
        if (self.activeAudio) markSegmentsUnappended(self.activeAudio);
      }
      var videoInitKey = hlsInitSegmentKey(self.initSegment);
      var audioInitKey = hlsInitSegmentKey(self.audioInitSegment);
      var videoReady = !self.sb
        ? Promise.resolve()
        : clearBuffer
          ? clearSourceBuffer(self.sb).then(function (removedRange) {
            reconcileHlsSegmentLedgers(self, 'video', removedRange, self, null, false);
            self._appendedVideoInitKey = '';
            self._appendedVideoInitGenerationKey = '';
            self._sourceBufferVideoInitSegment = null;
          })
          : Promise.resolve(self.sb._nativeQueue).catch(function () {}).then(function () {
          if (!self._isTrackTransitionCurrent(transaction)) throw abortError();
          return waitForSourceBufferIdle(self.sb);
        }).then(function () {
          // The old rendition may already cover one or more timeline
          // intervals. Treat those intervals as satisfied in the new playlist
          // so the switch starts at the next boundary rather than downloading
          // overlapping media that the decoder may continue to ignore.
          markSegmentsCoveredByBuffer(self, self.video);
          });
      var audioReady = clearBuffer && self.audioSb
        ? clearSourceBuffer(self.audioSb).then(function (removedRange) {
          reconcileHlsSegmentLedgers(self, 'audio', removedRange, self.activeAudio, null, false);
          self._appendedAudioInitKey = '';
          self._appendedAudioInitGenerationKey = '';
          self._sourceBufferAudioInitSegment = null;
        })
        : Promise.resolve();
      if (self.initSegment && self.sb && (clearBuffer || videoInitKey !== self._appendedVideoInitKey)) {
        videoReady = videoReady.then(function () {
          if (!self._isTrackTransitionCurrent(transaction)) throw abortError();
          return self._fetchRange(self.initSegment.url, self.initSegment.range, { phase: 'metadata' });
        }).then(function (initData) {
          if (!self._isTrackTransitionCurrent(transaction)) throw abortError();
          return appendHlsInitBuffer(self, self, self.sb, self.initSegment, initData, hlsTrackInitialTimestampGenerationKey(self, self));
        }).then(function () {
          self._appendedVideoInitKey = videoInitKey;
          self._appendedVideoInitGenerationKey = hlsTrackInitialTimestampGenerationKey(self, self);
          self._sourceBufferVideoInitSegment = self.initSegment;
        });
      }
      if (self.audioInitSegment && self.audioSb && (clearBuffer || audioInitKey !== self._appendedAudioInitKey)) {
        audioReady = audioReady.then(function () {
          if (!self._isTrackTransitionCurrent(transaction)) throw abortError();
          return self._fetchRange(self.audioInitSegment.url, self.audioInitSegment.range, { phase: 'metadata' });
        }).then(function (initData) {
          if (!self._isTrackTransitionCurrent(transaction)) throw abortError();
          return appendHlsInitBuffer(self, self.activeAudio, self.audioSb, self.audioInitSegment, initData, hlsTrackInitialTimestampGenerationKey(self, self.activeAudio));
        }).then(function () {
          self._appendedAudioInitKey = audioInitKey;
          self._appendedAudioInitGenerationKey = hlsTrackInitialTimestampGenerationKey(self, self.activeAudio);
          self._sourceBufferAudioInitSegment = self.audioInitSegment;
        });
      }
      return Promise.all([videoReady, audioReady]);
    }).then(function () {
      if (!self._isTrackTransitionCurrent(transaction)) throw abortError();
      self._finishTrackTransition(transaction, true);
      self.variantSwitchInFlight = false;
      self.engine._player.emit('variantchanged');
      if (self._flushPendingTrackSwitch()) return;
      self._tick(true);
    }).catch(function (err) {
      if (self.destroyed || !self._ownsTrackTransition(transaction)) {
        self.variantSwitchInFlight = false;
        return;
      }
      self.lastError = err && err.message ? err.message : 'hls-variant-switch-failed';
      return self._rollbackTrackTransition(transaction).then(function () {
        self._finishTrackTransition(transaction, false);
        self.variantSwitchInFlight = false;
        if (self._flushPendingTrackSwitch()) return;
        if (reason === 'quota-recovery' || reason === 'append-recovery' || reason === 'stall-recovery') self._handleFatal(err);
        else self._tick(true);
      }).catch(function (rollbackErr) {
        self._finishTrackTransition(transaction, false);
        self.variantSwitchInFlight = false;
        self.lastError = rollbackErr && rollbackErr.message ? rollbackErr.message : 'hls-track-transition-rollback-failed';
      });
    });
  };

  NativeHlsProvider.prototype._flushPendingVariantSwitch = function () {
    var pending = this.pendingManualVariantSwitch;
    if (!pending || this.destroyed || this.variantSwitchInFlight || this.trackTransitionInFlight) return false;
    this.pendingManualVariantSwitch = null;
    var variant = this.variants.find(function (item) { return item.id === pending.variantId; });
    if (!variant || !variantSelectable(this, variant)) return false;
    if (this.activeVariant === variant) {
      // A cancelled automatic transition restores its pre-switch ABR
      // snapshot. If that restored rendition is also the viewer's queued
      // choice, preserve the viewer's manual policy even though no media
      // transition is now necessary.
      this.manualTrackId = variant.id;
      this.engine._player.config.abr.enabled = false;
      this.lastSwitchAt = performance.now();
      this.lastSwitchReason = 'manual';
      for (var i = 0; i < this.variants.length; i++) this.variants[i].active = this.variants[i] === variant;
      return false;
    }
    this._switchVariant(variant, pending.clearBuffer, 'manual');
    return this.variantSwitchInFlight;
  };

  NativeHlsProvider.prototype._maybeSwitchAuto = function () {
    if (this.suppressedVideoGapTrack || !this.engine._player.config.abr.enabled || this.variantSwitchInFlight || this.trackTransitionInFlight || this.variants.length < 2 || !this.activeVariant) return;
    var now = performance.now();
    if (sampleFramePressure(this, now)) {
      var smootherVariant = this._lowerVariant();
      if (smootherVariant) {
        this.frameDropDownswitchCount++;
        this._switchVariant(smootherVariant, false, 'dropped-frames');
        return;
      }
    }
    var ahead = getBufferAhead(this.video);
    var previous = this.activeVariant;
    var abr = this.engine._player.config.abr || {};
    var upgradeFactor = this.live
      ? Math.min(0.7, abr.bandwidthUpgradeTarget || 0.85)
      : (abr.bandwidthUpgradeTarget || 0.85);
    var downgradeFactor = abr.bandwidthDowngradeTarget || 0.95;
    var candidates = this._candidateVariants();
    var upgradeChoice = this._chooseForBudget(candidates, upgradeFactor);
    var sustainChoice = this._chooseForBudget(candidates, downgradeFactor);
    var currentSustainable = (previous.bandwidth || 0)
      <= effectiveBandwidthEstimate(this) * downgradeFactor;
    var chosen = currentSustainable
      ? ((upgradeChoice.height || 0) > (previous.height || 0) ? upgradeChoice : previous)
      : sustainChoice;
    if (!chosen || chosen === previous) return;
    var isUpgrade = (chosen.height || 0) > (previous.height || 0);
    var reason = !isUpgrade && ahead < ABR_DOWNGRADE_BUFFER ? 'low-buffer' : 'bandwidth';
    var upgradeCooldownComplete = !this.lastSwitchAt || now - this.lastSwitchAt >= ABR_SWITCH_COOLDOWN_MS;
    if (!isUpgrade || (
      upgradeCooldownComplete
      && abrUpgradeIsSafe(this, chosen, ahead)
    )) this._switchVariant(chosen, false, reason);
  };

  NativeHlsProvider.prototype.selectVariantTrack = function (track, clearBuffer) {
    if (this.suppressedVideoGapTrack) return;
    var variant = this.variants.find(function (item) { return item.id === track.id || item.height === track.height; });
    if (!variant || !variantSelectable(this, variant)) return;
    // Viewer intent takes effect immediately even when the media transition
    // must wait behind an automatic switch. The transaction owns playback
    // state; manual ABR policy remains the viewer's preference.
    this.manualTrackId = variant.id;
    this.engine._player.config.abr.enabled = false;
    this.lastSwitchAt = performance.now();
    this.lastSwitchReason = 'manual';
    if (this.variantSwitchInFlight || this.trackTransitionInFlight) {
      // A viewer choice must win over an automatic transition already
      // preparing another rendition. Queue only the latest manual intent and
      // apply it before the completed auto switch can schedule more media.
      this.pendingManualVariantSwitch = {
        variantId: variant.id,
        clearBuffer: clearBuffer !== false
      };
      if (this.trackTransitionInFlight) this._cancelTrackTransitionForViewerIntent();
      return;
    }
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
    if (!rendition || rendition === this.activeAudio || this.destroyed || !capabilityAllowed(this, rendition)) return;
    if (this.trackTransitionInFlight) {
      this.pendingAudioTrackSwitch = { id: rendition.id, language: rendition.language || '' };
      this._cancelTrackTransitionForViewerIntent();
      return;
    }
    var self = this;
    var transaction = this._beginTrackTransition('audio-switch');
    if (!transaction) return;
    this._abortRequests();
    this.activeAudio = rendition;
    this.audioEndList = rendition.endList === true ? true : null;
    for (var i = 0; i < this.audioRenditions.length; i++) this.audioRenditions[i].active = this.audioRenditions[i] === rendition;
    this._fetchPlaylistText(rendition.url, { signal: transaction.controller.signal }).then(function (audioText) {
      if (!self._isTrackTransitionCurrent(transaction)) throw abortError();
      return self._loadAudioPlaylist(audioText, rendition.url, rendition);
    }).then(function () {
      if (!self._isTrackTransitionCurrent(transaction)) throw abortError();
      return self._reconcileTrackLifecycle(transaction.generation);
    }).then(function () {
      if (!self._isTrackTransitionCurrent(transaction)) throw abortError();
      if (!self.audioSb || allSegmentsDeclaredGap(self.audioSegments)) return;
      markSegmentsUnappended(self.activeAudio);
      return clearSourceBuffer(self.audioSb).then(function (removedRange) {
        if (!self._isTrackTransitionCurrent(transaction)) throw abortError();
        reconcileHlsSegmentLedgers(self, 'audio', removedRange, self.activeAudio, null, false);
        self._appendedAudioInitKey = '';
        self._appendedAudioInitGenerationKey = '';
        self._sourceBufferAudioInitSegment = null;
        return self._appendTrackInitIfNeeded('audio', true, transaction.generation);
      });
    }).then(function () {
      if (!self._isTrackTransitionCurrent(transaction)) throw abortError();
      self._finishTrackTransition(transaction, true);
      self.engine._player.emit('audiotrackchanged', self.getActiveAudioTrack());
      if (self._flushPendingTrackSwitch()) return;
      self._tick(true);
    }).catch(function (err) {
      if (self.destroyed || !self._ownsTrackTransition(transaction)) return;
      self.lastError = err && err.message ? err.message : 'hls-audio-switch-failed';
      return self._rollbackTrackTransition(transaction).then(function () {
        self._finishTrackTransition(transaction, false);
        if (self._flushPendingTrackSwitch()) return;
        self._tick(true);
      }).catch(function (rollbackErr) {
        self._finishTrackTransition(transaction, false);
        self.lastError = rollbackErr && rollbackErr.message ? rollbackErr.message : 'hls-track-transition-rollback-failed';
      });
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
      manifestGapJumpCount: this.manifestGapJumpCount || 0,
      lastManifestGapSize: this.lastManifestGapSize || 0,
      lastManifestGapTrack: this.lastManifestGapTrack || '',
      suppressedAudioGapTrack: !!this.suppressedAudioGapTrack,
      suppressedVideoGapTrack: !!this.suppressedVideoGapTrack,
      suppressedGapTrackCount: this.suppressedGapTrackCount || 0,
      trackActivationCount: this.trackActivationCount || 0,
      trackSuppressionCount: this.trackSuppressionCount || 0,
      sourceBufferTypeChangeCount: this.sourceBufferTypeChangeCount || 0,
      sourceBufferTypeRebuildCount: this.sourceBufferTypeRebuildCount || 0,
      sourceBufferTypeRollbackCount: this.sourceBufferTypeRollbackCount || 0,
      trackLifecycleInFlight: !!this.trackLifecyclePromise,
      lastError: this.lastError,
      lastHttpStatus: this.lastHttpStatus,
      playlistRefreshCount: this.playlistRefreshCount,
      liveLowBufferRefreshCount: this.liveLowBufferRefreshCount || 0,
      blockingReloadRequestCount: this.blockingReloadRequestCount || 0,
      blockingReloadResponseCount: this.blockingReloadResponseCount || 0,
      blockingReloadFallbackCount: this.blockingReloadFallbackCount || 0,
      lastPlaylistRefreshAdvanced: !!this.lastPlaylistRefreshAdvanced,
      liveWindowDriftRecoveryCount: this.liveWindowDriftRecoveryCount || 0,
      vodEndOfStreamCount: this.vodEndOfStreamCount || 0,
      vodEndOfStreamPending: !!this.vodEndOfStreamPending,
      vodEndOfStreamRetryCount: this.vodEndOfStreamRetryCount || 0,
      vodEndOfStreamRefillPending: !!this.vodEndOfStreamRefillPending,
      vodEndOfStreamReopenCount: this.vodEndOfStreamReopenCount || 0,
      vodFinalDuration: this.vodFinalDuration || 0,
      liveToVodTransitionCount: this.liveToVodTransitionCount || 0,
      liveRefreshInFlight: !!this.liveRefreshInFlight,
      playlistRefreshInFlight: !!this.playlistRefreshPromise,
      playlistRefreshReasonInFlight: this.playlistRefreshReasonInFlight || '',
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
      bandwidthFastEstimate: Math.round(this.bandwidthFast || 0),
      bandwidthSlowEstimate: Math.round(this.bandwidthSlow || 0),
      bandwidthTimeToFirstByteEstimateMs: Math.round(this.bandwidthTtfbEstimate || 0),
      frameDropDownswitchCount: this.frameDropDownswitchCount || 0,
      lastFrameDropRatio: this.lastFrameDropRatio || 0,
      mediaUrlRefreshCount: this.mediaUrlRefreshCount,
      playlistMediaSequence: this.mediaSequence || 0,
      discontinuitySequence: this.discontinuitySequence || 0,
      discontinuityCount: this.discontinuityCount || 0,
      playlistRefreshFailed: !!this.playlistRefreshFailed,
      staleManifestResponseCount: this.staleManifestResponseCount || 0,
      playlistEpochResetCount: this.playlistEpochResetCount || 0,
      lastPlaylistEpochResetTrack: this.lastPlaylistEpochResetTrack || '',
      lastPlaylistEpochResetOffset: this.lastPlaylistEpochResetOffset || 0,
      playlistEpochHoldCount: this.playlistEpochHoldCount || 0,
      lastPlaylistEpochHoldReason: this.lastPlaylistEpochHoldReason || '',
      playlistManifestCommitGeneration: this.playlistManifestCommitGeneration || 0,
      playlistManifestStageCount: this.playlistManifestStageCount || 0,
      playlistManifestCommitCount: this.playlistManifestCommitCount || 0,
      playlistManifestDiscardCount: this.playlistManifestDiscardCount || 0,
      playlistManifestCommitInProgress: !!this.playlistManifestCommitInProgress,
      hlsInitTimescaleParseFailureCount: this.hlsInitTimescaleParseFailureCount || 0,
      hlsFragmentTimestampParseCount: this.hlsFragmentTimestampParseCount || 0,
      hlsFragmentTimestampFallbackCount: this.hlsFragmentTimestampFallbackCount || 0,
      hlsTimestampGenerationResolutionCount: this.hlsTimestampGenerationResolutionCount || 0,
      hlsTimestampGenerationCount: countKeys(this.hlsTimestampGenerationByKey),
      hlsDiscontinuityTimestampResolutionCount: this.hlsDiscontinuityTimestampResolutionCount || 0,
      hlsDiscontinuityTimestampFallbackCount: this.hlsDiscontinuityTimestampFallbackCount || 0,
      hlsInitMapSwitchCount: this.hlsInitMapSwitchCount || 0,
      hlsInitGenerationRefreshCount: this.hlsInitGenerationRefreshCount || 0,
      hlsTimestampResolutionRetryCount: this.hlsTimestampResolutionRetryCount || 0,
      hlsTimestampResolutionFailureCount: this.hlsTimestampResolutionFailureCount || 0,
      hlsContainerDetectionCount: this.hlsContainerDetectionCount || 0,
      hlsContainerMismatchCount: this.hlsContainerMismatchCount || 0,
      hlsTransmuxedTimestampResolutionCount: this.hlsTransmuxedTimestampResolutionCount || 0,
      hlsTimestampGenerationPruneCount: this.hlsTimestampGenerationPruneCount || 0,
      hlsTsTimelineGenerationCount: countKeys(this.hlsTsTimelineByGeneration),
      hlsTsSharedDemuxCount: this.hlsTsSharedDemuxCount || 0,
      hlsTsTimestampRolloverCount: this.hlsTsTimestampRolloverCount || 0,
      hlsTsOutOfOrderSegmentCount: this.hlsTsOutOfOrderSegmentCount || 0,
      hlsTsCompositionOffsetSampleCount: this.hlsTsCompositionOffsetSampleCount || 0,
      hlsTsMaxCompositionOffsetMs: this.hlsTsMaxCompositionOffsetMs || 0,
      hlsTsMuxedAvStartOffsetMs: this.hlsTsMuxedAvStartOffsetMs || 0,
      hlsTsInitAppendCount: this.hlsTsInitAppendCount || 0,
      hlsTsInitSkipCount: this.hlsTsInitSkipCount || 0,
      hlsTsMuxedQuotaRetryCount: this.hlsTsMuxedQuotaRetryCount || 0,
      hlsTsMuxedQuotaAudioResumeCount: this.hlsTsMuxedQuotaAudioResumeCount || 0,
      hlsTsMuxedQuotaVideoResumeCount: this.hlsTsMuxedQuotaVideoResumeCount || 0,
      hlsAppendEpoch: this.hlsAppendEpoch || 0,
      hlsAppendInvalidationCount: this.hlsAppendInvalidationCount || 0,
      hlsStaleAppendAbortCount: this.hlsStaleAppendAbortCount || 0,
      hlsStaleRecoveryAbortCount: this.hlsStaleRecoveryAbortCount || 0,
      lastHlsAppendInvalidationReason: this.lastHlsAppendInvalidationReason || '',
      hlsQuotaForwardEvictionCount: this.hlsQuotaForwardEvictionCount || 0,
      hlsQuotaDownswitchCount: this.hlsQuotaDownswitchCount || 0,
      hlsMuxedWatchdogCompletionCount: this.hlsMuxedWatchdogCompletionCount || 0,
      hlsMuxedAppendLedgerSize: countKeys(this.hlsMuxedAppendLedger),
      hlsMuxedPartialCarryCount: this.hlsMuxedPartialCarryCount || 0,
      hlsMuxedLedgerResumeCount: this.hlsMuxedLedgerResumeCount || 0,
      hlsMuxedLedgerCompletionCount: this.hlsMuxedLedgerCompletionCount || 0,
      lastHlsTimestampGenerationKey: this.lastHlsTimestampGenerationKey || '',
      lastHlsFragmentDecodeTime: this.lastHlsFragmentDecodeTime || 0,
      lastHlsFragmentTimestampOffset: this.lastHlsFragmentTimestampOffset || 0,
      schedulerQueueDepth: appendQueueDepth(this.sb),
      schedulerBackpressureCount: this.schedulerBackpressureCount,
      schedulerDrainCount: this.schedulerDrainCount,
      sourceBufferAbortCount: this.sourceBufferAbortCount || 0,
      hlsSegmentLedgerReconcileCount: this.hlsSegmentLedgerReconcileCount || 0,
      hlsSegmentLedgerInvalidationCount: this.hlsSegmentLedgerInvalidationCount || 0,
      sourceBufferMutationTimeoutCount: sourceBufferMutationStat(this, '_nativeMutationTimeoutCount'),
      sourceBufferMutationAbortCount: sourceBufferMutationStat(this, '_nativeMutationAbortCount'),
      sourceBufferMissedUpdateEndCount: sourceBufferMutationStat(this, '_nativeMutationMissedUpdateEndCount'),
      startupBufferComplete: this.startupBufferComplete,
      startupBufferMs: this.startupBufferMs,
      seekBufferPending: !!this.seekBufferPending,
      seekInteractionPending: !!this.seekInteractionPending,
      seekBufferReadyCount: this.seekBufferReadyCount || 0,
      bufferedSeekCount: this.bufferedSeekCount || 0,
      seekCount: this.seekCount || 0,
      seekCancelCount: this.seekCancelCount || 0,
      seekAbortCount: this.seekAbortCount || 0,
      seekGeneration: this.seekGeneration || 0,
      activeSeekGeneration: this.activeSeekGeneration || 0,
      completedSeekGeneration: this.completedSeekGeneration || 0,
      lastSeekTarget: this.lastSeekTarget || 0,
      lastSeekMs: this.lastSeekMs || 0,
      effectiveSeekBufferGoal: this._seekBufferGoal ? this._seekBufferGoal() : STARTUP_BUFFER_GOAL,
      lastSwitchReason: this.lastSwitchReason,
      variantSwitchInFlight: !!this.variantSwitchInFlight,
      pendingManualVariantId: this.pendingManualVariantSwitch ? this.pendingManualVariantSwitch.variantId : '',
      pendingAudioTrackId: this.pendingAudioTrackSwitch ? this.pendingAudioTrackSwitch.id : '',
      trackTransitionInFlight: !!this.trackTransitionInFlight,
      trackTransitionReason: this.trackTransitionInFlight ? this.trackTransitionInFlight.reason : '',
      trackTransitionCommitCount: this.trackTransitionCommitCount || 0,
      trackTransitionRollbackCount: this.trackTransitionRollbackCount || 0,
      trackTransitionRollbackFailureCount: this.trackTransitionRollbackFailureCount || 0,
      transmuxedSegmentCount: this.transmuxedSegmentCount,
      transmuxedVideoSegmentCount: this.transmuxedVideoSegmentCount,
      transmuxedAudioSegmentCount: this.transmuxedAudioSegmentCount,
      transmuxerProvider: this.tsTransmuxerProvider,
      transmuxerLoadMs: this.tsTransmuxerLoadMs,
      muxedTsAudio: !!this.muxedTsAudio,
      encryptedSegmentCount: this.encryptedSegmentCount,
      encryptedInitSegmentCount: this.encryptedInitSegmentCount || 0,
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
      partialSegmentGapCount: this.partialSegmentGapCount || 0,
      preloadHintRequestCount: this.preloadHintRequestCount || 0,
      preloadHintCount: this.preloadHintCount || 0,
      preloadHintReuseCount: this.preloadHintReuseCount || 0,
      preloadHintDiscardCount: this.preloadHintDiscardCount || 0,
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
    if (this._jumpManifestGap && this._jumpManifestGap()) return;
    if (this._maybeEndVodStream && this._maybeEndVodStream()) return;
    if (endedVodSchedulerIsIdle(this)) return;
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

  NativeHlsProvider.prototype.quiesce = function (reason) {
    if (this._terminalQuiesced) return false;
    this._terminalQuiesced = true;
    this.destroyed = true;
    invalidateSeekOperation(this);
    if (this.trackTransitionInFlight && this.trackTransitionInFlight.controller) {
      try { this.trackTransitionInFlight.controller.abort(); } catch (e) {}
    }
    invalidateHlsAppendTransactions(this, reason || 'terminal');
    try { this._abortRequests(); } catch (e) {}
    this.trackTransitionGeneration = (this.trackTransitionGeneration || 0) + 1;
    this.trackTransitionInFlight = null;
    this.variantSwitchInFlight = false;
    this.nativeRecoveryInProgress = false;
    this.pendingManualVariantSwitch = null;
    this.pendingAudioTrackSwitch = null;
    this.playlistRefreshGeneration++;
    this.playlistRefreshPromise = null;
    this.playlistRefreshKey = '';
    this.playlistRefreshReasonInFlight = '';
    this.trackLifecyclePromise = null;
    clearVodEndOfStreamState(this);
    clearTimeout(this.playlistRefreshTimer);
    this.playlistRefreshTimer = 0;
    if (this._boundWaiting) this.video.removeEventListener('waiting', this._boundWaiting);
    if (this._boundPlaying) this.video.removeEventListener('playing', this._boundPlaying);
    if (this._boundTick) this.video.removeEventListener('timeupdate', this._boundTick);
    if (this._boundNativeTextCueUpdate) {
      this.video.removeEventListener('timeupdate', this._boundNativeTextCueUpdate);
      this.video.removeEventListener('seeking', this._boundNativeTextCueUpdate);
    }
    if (this._boundSeeking) this.video.removeEventListener('seeking', this._boundSeeking);
    if (this._boundSeeked) this.video.removeEventListener('seeked', this._boundSeeked);
    this.controllers.forEach(function (controller) { try { controller.abort(); } catch (e) {} });
    this.controllers = [];
    this.activeRanges = {};
    return true;
  };

  NativeHlsProvider.prototype.destroy = function () {
    this.quiesce('destroy');
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
    this._usesStartupReadiness = true;
    this.mediaSource = null;
    this.objectUrl = '';
    this.audio = null;
    this.audioReps = [];
    this.videoReps = [];
    this.activeVideo = null;
    this.blacklisted = {};
    this.abortController = null;
    this.destroyed = false;
    this._terminalQuiesced = false;
    this.fillTimer = null;
    this.bandwidth = engine._player.config.abr.defaultBandwidthEstimate || DEFAULT_BANDWIDTH_ESTIMATE;
    this.manualTrackId = null;
    this.controllers = [];
    this.requestGeneration = 0;
    this.appendFailures = 0;
    this.activeRanges = {};
    this.videoSwitchInFlight = false;
    this.pendingManualVideoSwitch = null;
    this.lastSwitchAt = 0;
    this.lastSwitchReason = 'startup';
    this.lastBandwidthSample = 0;
    this.bandwidthSamples = 0;
    this.bandwidthFast = 0;
    this.bandwidthSlow = 0;
    this.bandwidthFastAccumulator = 0;
    this.bandwidthSlowAccumulator = 0;
    this.bandwidthFastWeight = 0;
    this.bandwidthSlowWeight = 0;
    this.bandwidthTtfbEstimate = DEFAULT_TIME_TO_FIRST_BYTE_MS;
    this.bandwidthTtfbAccumulator = 0;
    this.bandwidthTtfbWeight = 0;
    this.lastFrameSampleAt = 0;
    this.lastDroppedFrames = 0;
    this.lastTotalFrames = 0;
    this.frameDropDownswitchCount = 0;
    this.lastFrameDropRatio = 0;
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
    this.staleManifestResponseCount = 0;
    this.presentationEnded = false;
    this.minimumUpdatePeriod = 0;
    this.manifestRefreshTimer = null;
    this.manifestRefreshPromise = null;
    this.manifestRefreshReasonInFlight = '';
    this.lastManifestPublishTime = NaN;
    this.gapJumpCount = 0;
    this.lastGapSize = 0;
    this.manifestGapJumpCount = 0;
    this.lastManifestGapSize = 0;
    this.capabilityProbeCount = 0;
    this.unsupportedCapabilityCount = 0;
    this.startupBufferComplete = false;
    this.startupBufferStartedAt = 0;
    this.startupBufferMs = 0;
    this.firstPlayableRange = null;
    this.seekBufferPending = false;
    this.seekInteractionPending = false;
    this.seekBufferReadyCount = 0;
    this.bufferedSeekCount = 0;
    this.seekCount = 0;
    this.seekCancelCount = 0;
    this.seekAbortCount = 0;
    this.seekGeneration = 0;
    this.activeSeekGeneration = 0;
    this.completedSeekGeneration = 0;
    this.lastSeekTarget = 0;
    this.lastSeekStartedAt = 0;
    this.lastSeekMs = 0;
    this._lastSeekHandledTarget = null;
    this._lastSeekHandledAt = 0;
    this._lastSeekHandledGeneration = 0;
    this.requestCancellationCount = 0;
    this.dashAppendTransactionCount = 0;
    this.dashStaleAppendAbortCount = 0;
    this.dashSourceBufferQueueDrainCount = 0;
    this.dashControlTransitionGeneration = 0;
    this.dashControlTransitionInFlight = null;
    this.dashControlTransitionCount = 0;
    this.dashControlTransitionCommitCount = 0;
    this.dashControlTransitionInvalidationCount = 0;
    this.dashStaleControlTransitionAbortCount = 0;
    this.dashStaleControlTransitionReleaseCount = 0;
    this.dashControlTransitionRollbackCount = 0;
    this.dashControlTransitionRollbackFailureCount = 0;
    this.dashSourceBufferConfigEpoch = 0;
    this.dashSourceBufferCommittedConfigEpoch = 0;
    this.dashSourceBufferConfigUncertain = false;
    this.dashSourceBufferReconcilePending = null;
    this.dashSourceBufferReconcileQueuedCount = 0;
    this.dashSourceBufferReconcileAttemptCount = 0;
    this.dashSourceBufferReconcileSuccessCount = 0;
    this.dashSourceBufferReconcileFailureCount = 0;
    this.dashSegmentLedgerReconcileCount = 0;
    this.dashSegmentLedgerInvalidationCount = 0;
    this.audioSwitchInFlight = false;
    this.pendingAudioSwitch = null;
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
    this.liveToVodTransitionCount = 0;
    this.vodEndOfStreamCount = 0;
    this.vodEndOfStreamPending = false;
    this.vodEndOfStreamRetryCount = 0;
    this.vodEndOfStreamRefillPending = false;
    this.vodEndOfStreamReopenCount = 0;
    this.vodFinalDuration = 0;
    this._vodEndOfStreamRetryAttempt = 0;
    this._vodEndOfStreamScheduled = false;
    this._vodEndOfStreamRetryTimer = 0;
  }

  NativeDashProvider.prototype.load = function () {
    var self = this;
    var parsed = parseMPD(this.manifestText, this.manifestUrl);
    this.presentationEnded = parsed.type !== 'dynamic';
    this.lastManifestPublishTime = parsed.publishTime;
    applyProviderPresentationState(this, parsed.type === 'dynamic', parsed.duration);
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
      if (self._applyingInitialStart || isInternalMediaSeek(self)) return;
      self._onSeek();
    });
    this.video.addEventListener('seeked', this._boundSeeked = function () {
      if (self._applyingInitialStart || isInternalMediaSeek(self)) return;
      self.endSeek();
    });
    this.video.addEventListener('waiting', this._boundWaiting = function () { self._onWaiting(); });
    this.video.addEventListener('playing', this._boundPlaying = function () { self._onPlaying(); });
    return Promise.all([
      this._prepareRep(this.activeVideo),
      this._prepareRep(this.audio)
    ]).then(function () {
      // The SourceBuffers are independent. Append both init segments together
      // so slower devices do not pay two updateend waits before media can start.
      return Promise.all([
        appendBuffer(
          self.videoSb,
          self.activeVideo.initData,
          null,
          undefined,
          sourceBufferIdentityGuard(self, 'videoSb', self.videoSb)
        ).then(function () {
          self.activeVideo._appendedInitKey = self.activeVideo.generationKey || generationKeyForRep(self.activeVideo);
        }),
        appendBuffer(
          self.audioSb,
          self.audio.initData,
          null,
          undefined,
          sourceBufferIdentityGuard(self, 'audioSb', self.audioSb)
        ).then(function () {
          self.audio._appendedInitKey = self.audio.generationKey || generationKeyForRep(self.audio);
        })
      ]);
    }).then(function () {
      if (self.live) self._startNearLiveEdge();
      if (self.engine && self.engine._markStartupAttached) self.engine._markStartupAttached(self);
      self._tick(true);
      return applyPendingLoadStartTime(self).then(function () {
        self.fillTimer = setInterval(function () { self._tick(); }, 1000);
        self._scheduleManifestRefresh();
      });
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
        self._recordBandwidthSample(
          buf.byteLength,
          resp.timeMs || Math.max(1, performance.now() - started),
          resp.timeToFirstByteMs
        );
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

  NativeDashProvider.prototype._recordBandwidthSample = function (byteLength, elapsedMs, timeToFirstByteMs) {
    var sampleDuration = bandwidthSampleDuration(this, elapsedMs, timeToFirstByteMs);
    var sample = (byteLength * 8 * 1000) / sampleDuration;
    if (!isFinite(sample) || sample <= 0) return;
    this.lastBandwidthSample = sample;
    this.bandwidthSamples = (this.bandwidthSamples || 0) + 1;
    updateBandwidthEstimate(this, sample, sampleDuration);
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
    if (this._jumpManifestGap && this._jumpManifestGap()) return;
    if (this._maybeEndVodStream && this._maybeEndVodStream()) return;
    if (endedVodSchedulerIsIdle(this)) return;
    if (this.live) this._updateLivePositionStats();
    this._jumpSmallGap();
    if (this.dashSourceBufferConfigUncertain) {
      if (!this.dashControlTransitionInFlight) flushPendingDashControlTransition(this);
      return;
    }
    if (this.dashControlTransitionInFlight || this.videoSwitchInFlight || this.audioSwitchInFlight) return;
    var ahead = getBufferAhead(this.video);
    this._maybeSwitchAuto();
    if (this.dashControlTransitionInFlight || this.videoSwitchInFlight || this.audioSwitchInFlight) return;
    if (!force && ahead >= this._bufferAheadGoal()) return;
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
    if (this.destroyed || this.dashSourceBufferConfigUncertain || this.dashControlTransitionInFlight) return;
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
    if (this.dashSourceBufferConfigUncertain || this.dashControlTransitionInFlight) return [];
    var pendingStart = pendingLoadStartTime(this);
    var ct = !this.startupBufferComplete && pendingStart != null ? pendingStart : (this.video.currentTime || 0);
    if (this.live && this.liveWindow && ct < this.liveWindow.start) ct = this.liveWindow.start;
    var target = ct + (windowGoal || this._bufferAheadGoal());
    var readyGoal = Math.min(windowGoal || this._bufferAheadGoal(), this._bufferAheadGoal());
    var startupCriticalOnly = (!this.startupBufferComplete || this.seekBufferPending)
      && getBufferAhead(this.video) < 0.1;
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
        var priority = segmentPriority(seg, ct, readyGoal);
        if (startupCriticalOnly && priority !== 0) continue;
        candidates.push({
          rep: rep,
          sb: tracks[i].sb,
          seg: seg,
          priority: priority
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
    var self = this;
    function refresh(retriedStale) {
      return self._refreshPlaybackManifest('media-error').then(function (outcome) {
        if (outcome && outcome.stale) {
          if (!retriedStale) return refresh(true);
          throw new Error('dash-media-refresh-stale');
        }
        return outcome;
      });
    }
    return refresh(false);
  };

  function createDashAppendTransaction(provider, rep, seg, sb, enforceOwnership) {
    var kind = rep && rep.kind === 'audio' ? 'audio' : 'video';
    var sourceBufferField = kind === 'audio' ? 'audioSb' : 'videoSb';
    var sourceBuffer = provider && provider[sourceBufferField] || sb || null;
    var transaction = {
      generation: provider && provider.requestGeneration || 0,
      kind: kind,
      rep: rep || null,
      segment: seg || null,
      sourceBufferField: sourceBufferField,
      sourceBuffer: sourceBuffer,
      videoSourceBuffer: provider && provider.videoSb || (kind === 'video' ? sourceBuffer : null),
      audioSourceBuffer: provider && provider.audioSb || (kind === 'audio' ? sourceBuffer : null),
      activeRep: provider && (kind === 'audio' ? provider.audio : provider.activeVideo) || rep || null,
      generationKey: seg && seg.generationKey || rep && rep.generationKey || '',
      enforceOwnership: !!enforceOwnership,
      staleAbortRecorded: false
    };
    if (provider) {
      provider.dashAppendTransactionCount = (provider.dashAppendTransactionCount || 0) + 1;
    }
    return transaction;
  }

  function dashAppendTransactionIsCurrent(provider, transaction) {
    if (!provider || !transaction || provider.destroyed) return false;
    if ((provider.requestGeneration || 0) !== transaction.generation) return false;
    if (
      transaction.videoSourceBuffer
      && Object.prototype.hasOwnProperty.call(provider, 'videoSb')
      && provider.videoSb !== transaction.videoSourceBuffer
    ) return false;
    if (
      transaction.audioSourceBuffer
      && Object.prototype.hasOwnProperty.call(provider, 'audioSb')
      && provider.audioSb !== transaction.audioSourceBuffer
    ) return false;
    var activeSourceBuffer = Object.prototype.hasOwnProperty.call(provider, transaction.sourceBufferField)
      ? provider[transaction.sourceBufferField]
      : transaction.sourceBuffer;
    if (activeSourceBuffer !== transaction.sourceBuffer) return false;
    if (transaction.enforceOwnership) {
      if (!transaction.rep || transaction.rep._appendOwner !== transaction) return false;
      if (!transaction.segment || transaction.segment._appendOwner !== transaction) return false;
      var activeRep = transaction.kind === 'audio' ? provider.audio : provider.activeVideo;
      if (activeRep && activeRep !== transaction.rep) return false;
      var generationKey = transaction.segment && transaction.segment.generationKey
        || transaction.rep && transaction.rep.generationKey
        || '';
      if (transaction.generationKey && generationKey !== transaction.generationKey) return false;
    }
    return true;
  }

  function assertDashAppendTransactionCurrent(provider, transaction) {
    if (dashAppendTransactionIsCurrent(provider, transaction)) return;
    if (provider && transaction && !transaction.staleAbortRecorded) {
      transaction.staleAbortRecorded = true;
      provider.dashStaleAppendAbortCount = (provider.dashStaleAppendAbortCount || 0) + 1;
    }
    throw abortError();
  }

  function dashAppendTransactionGuard(provider, transaction) {
    return function () {
      assertDashAppendTransactionCurrent(provider, transaction);
    };
  }

  function updateDashAppendTransactionSourceBuffer(transaction, replacement) {
    if (!transaction) return;
    transaction.sourceBuffer = replacement;
    if (transaction.kind === 'audio') transaction.audioSourceBuffer = replacement;
    else transaction.videoSourceBuffer = replacement;
  }

  function dashAppendWorkInFlight(provider, exceptTransaction) {
    if (!provider) return false;
    var reps = [provider.activeVideo, provider.audio];
    for (var i = 0; i < reps.length; i++) {
      if (!reps[i]) continue;
      if (reps[i]._appendOwner && reps[i]._appendOwner !== exceptTransaction) return true;
      if (reps[i]._appending && (!exceptTransaction || reps[i]._appendOwner !== exceptTransaction)) return true;
    }
    return false;
  }

  function waitForDashAppendTopologyPeers(provider, transaction) {
    if (!dashAppendWorkInFlight(provider, transaction)) return Promise.resolve();
    var startedAt = performance.now();
    return new Promise(function (resolve, reject) {
      function poll() {
        try {
          assertDashAppendTransactionCurrent(provider, transaction);
        } catch (err) {
          reject(err);
          return;
        }
        if (!dashAppendWorkInFlight(provider, transaction)) {
          resolve();
          return;
        }
        if (performance.now() - startedAt >= SEGMENT_BUSY_WATCHDOG_MS) {
          reject(new Error('dash-sourcebuffer-topology-peer-timeout'));
          return;
        }
        setTimeout(poll, 10);
      }
      poll();
    });
  }

  function beginDashControlTransition(provider, kind, target, clearBuffer, reason) {
    if (!provider || provider.destroyed || provider.dashControlTransitionInFlight || dashAppendWorkInFlight(provider)) return null;
    provider.dashControlTransitionGeneration = (provider.dashControlTransitionGeneration || 0) + 1;
    var transaction = {
      generation: provider.dashControlTransitionGeneration,
      requestGeneration: provider.requestGeneration || 0,
      kind: kind,
      target: target || null,
      previousVideo: provider.activeVideo || null,
      previousAudio: provider.audio || null,
      videoSourceBuffer: provider.videoSb || null,
      audioSourceBuffer: provider.audioSb || null,
      clearBuffer: !!clearBuffer,
      reason: reason || kind,
      staleAbortRecorded: false
    };
    provider.dashControlTransitionInFlight = transaction;
    provider.dashControlTransitionCount = (provider.dashControlTransitionCount || 0) + 1;
    if (kind === 'video') provider.videoSwitchInFlight = true;
    if (kind === 'audio') provider.audioSwitchInFlight = true;
    if (kind === 'recovery') provider.nativeRecoveryInProgress = true;
    return transaction;
  }

  function dashControlTransitionIsCurrent(provider, transaction) {
    return !!(
      provider
      && transaction
      && !provider.destroyed
      && provider.dashControlTransitionInFlight === transaction
      && (provider.dashControlTransitionGeneration || 0) === transaction.generation
      && (provider.requestGeneration || 0) === transaction.requestGeneration
      && (provider.videoSb || null) === transaction.videoSourceBuffer
      && (provider.audioSb || null) === transaction.audioSourceBuffer
    );
  }

  function assertDashControlTransitionCurrent(provider, transaction) {
    if (dashControlTransitionIsCurrent(provider, transaction)) return;
    if (provider && transaction && !transaction.staleAbortRecorded) {
      transaction.staleAbortRecorded = true;
      provider.dashStaleControlTransitionAbortCount = (provider.dashStaleControlTransitionAbortCount || 0) + 1;
    }
    throw abortError();
  }

  function dashControlTransitionGuard(provider, transaction) {
    return function () {
      assertDashControlTransitionCurrent(provider, transaction);
    };
  }

  function finishDashControlTransition(provider, transaction, committed) {
    if (!dashControlTransitionIsCurrent(provider, transaction)) return false;
    provider.dashControlTransitionInFlight = null;
    if (transaction.kind === 'video') provider.videoSwitchInFlight = false;
    if (transaction.kind === 'audio') provider.audioSwitchInFlight = false;
    if (transaction.kind === 'recovery') provider.nativeRecoveryInProgress = false;
    if (committed) {
      provider.dashControlTransitionCommitCount = (provider.dashControlTransitionCommitCount || 0) + 1;
    }
    return true;
  }

  function releaseStaleDashControlTransition(provider, transaction, reason) {
    if (!provider || !transaction || provider.dashControlTransitionInFlight !== transaction) return false;
    queueDashSourceBufferConfigurationReconciliation(provider, transaction, reason || 'stale-control-transition');
    provider.dashControlTransitionInFlight = null;
    if (transaction.kind === 'video') provider.videoSwitchInFlight = false;
    if (transaction.kind === 'audio') provider.audioSwitchInFlight = false;
    if (transaction.kind === 'recovery') provider.nativeRecoveryInProgress = false;
    provider.dashStaleControlTransitionReleaseCount = (provider.dashStaleControlTransitionReleaseCount || 0) + 1;
    return true;
  }

  function handleStaleDashControlTransition(provider, transaction, reason) {
    if (provider && transaction && !transaction.staleAbortRecorded) {
      transaction.staleAbortRecorded = true;
      provider.dashStaleControlTransitionAbortCount = (provider.dashStaleControlTransitionAbortCount || 0) + 1;
    }
    var released = releaseStaleDashControlTransition(provider, transaction, reason);
    if (released && !provider.destroyed) {
      if (!flushPendingDashControlTransition(provider) && provider._tick) provider._tick(true);
    }
    return false;
  }

  function recordDashSourceBufferConfigurationMutation(provider, transaction, kind) {
    if (!transaction.configurationEpoch) {
      provider.dashSourceBufferConfigEpoch = (provider.dashSourceBufferConfigEpoch || 0) + 1;
      transaction.configurationEpoch = provider.dashSourceBufferConfigEpoch;
      transaction.configurationMutations = {};
    }
    transaction.configurationMutations[kind] = true;
    return transaction.configurationEpoch;
  }

  function markDashSourceBufferConfigurationMutation(provider, transaction, kind) {
    assertDashControlTransitionCurrent(provider, transaction);
    return recordDashSourceBufferConfigurationMutation(provider, transaction, kind);
  }

  function markDashAppendSourceBufferConfigurationMutation(provider, transaction, kind, generationKey) {
    assertDashAppendTransactionCurrent(provider, transaction);
    var epoch = recordDashSourceBufferConfigurationMutation(provider, transaction, kind);
    transaction.configurationGenerationKeys = transaction.configurationGenerationKeys || {};
    transaction.configurationGenerationKeys[kind] = generationKey || '';
    if (transaction.rep) transaction.rep._appendedInitKey = '';
    return epoch;
  }

  function dashSourceBufferReconcilePendingHasEntries(pending) {
    return !!(pending && (pending.video || pending.audio));
  }

  function queueDashSourceBufferConfigurationReconciliation(provider, transaction, reason) {
    if (
      !provider
      || provider.destroyed
      || !transaction
      || !transaction.configurationEpoch
      || !transaction.configurationMutations
    ) return false;
    var pending = provider.dashSourceBufferReconcilePending || {};
    if (transaction.configurationMutations.video && provider.activeVideo && provider.videoSb) {
      pending.video = {
        epoch: transaction.configurationEpoch,
        reason: reason || transaction.reason || 'control-transition-invalidated'
      };
    }
    if (transaction.configurationMutations.audio && provider.audio && provider.audioSb) {
      pending.audio = {
        epoch: transaction.configurationEpoch,
        reason: reason || transaction.reason || 'control-transition-invalidated'
      };
    }
    if (!dashSourceBufferReconcilePendingHasEntries(pending)) return false;
    provider.dashSourceBufferReconcilePending = pending;
    provider.dashSourceBufferConfigUncertain = true;
    provider.dashSourceBufferReconcileQueuedCount = (provider.dashSourceBufferReconcileQueuedCount || 0) + 1;
    return true;
  }

  function queueDashAppendSourceBufferConfigurationReconciliation(provider, reason) {
    if (!provider || provider.destroyed) return false;
    var queued = false;
    var seen = [];
    var reps = [provider.activeVideo, provider.audio];
    for (var i = 0; i < reps.length; i++) {
      var transaction = reps[i] && reps[i]._appendOwner;
      if (!transaction || seen.indexOf(transaction) !== -1) continue;
      seen.push(transaction);
      queued = queueDashSourceBufferConfigurationReconciliation(provider, transaction, reason) || queued;
    }
    return queued;
  }

  function commitDashSourceBufferConfiguration(provider, transaction) {
    if (!provider || !transaction || !transaction.configurationEpoch) return;
    provider.dashSourceBufferCommittedConfigEpoch = Math.max(
      provider.dashSourceBufferCommittedConfigEpoch || 0,
      transaction.configurationEpoch
    );
    var pending = provider.dashSourceBufferReconcilePending;
    var mutations = transaction.configurationMutations || {};
    if (pending && mutations.video) delete pending.video;
    if (pending && mutations.audio) delete pending.audio;
    if (!dashSourceBufferReconcilePendingHasEntries(pending)) pending = null;
    provider.dashSourceBufferReconcilePending = pending;
    provider.dashSourceBufferConfigUncertain = !!pending;
  }

  function invalidateDashControlTransition(provider, reason) {
    if (!provider) return 0;
    provider.dashControlTransitionGeneration = (provider.dashControlTransitionGeneration || 0) + 1;
    var transaction = provider.dashControlTransitionInFlight;
    if (!transaction) return provider.dashControlTransitionGeneration;
    provider.dashControlTransitionInvalidationCount = (provider.dashControlTransitionInvalidationCount || 0) + 1;
    provider.lastDashControlTransitionInvalidationReason = reason || 'request-cancel';
    queueDashSourceBufferConfigurationReconciliation(provider, transaction, reason);
    if (!provider.destroyed && transaction.kind === 'video' && transaction.reason === 'manual' && transaction.target) {
      if (!provider.pendingManualVideoSwitch) {
        provider.pendingManualVideoSwitch = {
          repId: transaction.target.id,
          clearBuffer: transaction.clearBuffer
        };
      }
    }
    if (!provider.destroyed && transaction.kind === 'audio' && transaction.target) {
      if (!provider.pendingAudioSwitch) provider.pendingAudioSwitch = { repId: transaction.target.id };
    }
    provider.dashControlTransitionInFlight = null;
    if (transaction.kind === 'video') provider.videoSwitchInFlight = false;
    if (transaction.kind === 'audio') provider.audioSwitchInFlight = false;
    if (transaction.kind === 'recovery') provider.nativeRecoveryInProgress = false;
    return provider.dashControlTransitionGeneration;
  }

  function flushPendingDashControlTransition(provider) {
    if (!provider || provider.destroyed || provider.dashControlTransitionInFlight) return false;
    if (NativeDashProvider.prototype._flushPendingVideoSwitch.call(provider)) return true;
    var pendingAudio = provider.pendingAudioSwitch;
    if (pendingAudio) {
      provider.pendingAudioSwitch = null;
      var audioRep = (provider.audioReps || []).find(function (item) { return item.id === pendingAudio.repId; });
      if (audioRep && (!provider.audio || audioRep.id !== provider.audio.id)) {
        var switchAudio = provider._switchAudio || NativeDashProvider.prototype._switchAudio;
        switchAudio.call(provider, audioRep);
        if (provider.dashControlTransitionInFlight || provider.audioSwitchInFlight) return true;
      }
    }
    if (provider.dashSourceBufferConfigUncertain && dashSourceBufferReconcilePendingHasEntries(provider.dashSourceBufferReconcilePending)) {
      var reconcile = provider._reconcileSourceBufferConfiguration
        || NativeDashProvider.prototype._reconcileSourceBufferConfiguration;
      reconcile.call(provider);
      return !!provider.dashControlTransitionInFlight;
    }
    return false;
  }

  function dashConfigurationSegmentAtTime(rep, currentTime) {
    var segments = rep && rep.segments || [];
    var fallback = null;
    for (var i = 0; i < segments.length; i++) {
      var seg = segments[i];
      if (seg.state === 'expired') continue;
      if (seg.start <= currentTime + 0.05 && seg.end > currentTime - 0.05) return seg;
      if (!fallback && seg.end > currentTime - 0.05) fallback = seg;
    }
    return fallback || segments[segments.length - 1] || null;
  }

  function appendDashControlSourceBufferConfiguration(provider, transaction, kind, rep, sourceBuffer, currentTime, guard) {
    if (!rep || !sourceBuffer) return Promise.resolve();
    var seg = dashConfigurationSegmentAtTime(rep, currentTime);
    var key = seg && seg.generationKey || rep.generationKey || generationKeyForRep(rep);
    var typeRep = {
      mimeType: seg && seg.mimeType || rep.mimeType,
      codecs: seg && seg.codecs || rep.codecs
    };
    var initData = seg && provider._initDataForSegment
      ? provider._initDataForSegment(rep, seg)
      : Promise.resolve(rep.initData);
    return initData.then(function (data) {
      guard();
      if (!data) throw new Error('dash-sourcebuffer-config-init-missing');
      markDashSourceBufferConfigurationMutation(provider, transaction, kind);
      rep._appendedInitKey = '';
      var change = kind === 'audio'
        ? provider._changeAudioTypeIfNeeded(typeRep, sourceBuffer, guard)
        : provider._changeVideoTypeIfNeeded(typeRep, sourceBuffer, guard);
      return change.then(function () {
        guard();
        return appendBuffer(sourceBuffer, data, seg && seg.appendWindow, undefined, guard);
      }).then(function () {
        guard();
        rep._appendedInitKey = key;
      });
    });
  }

  function reconcileDashSourceBufferKind(provider, transaction, kind, guard) {
    var rep = kind === 'audio' ? provider.audio : provider.activeVideo;
    var sourceBuffer = kind === 'audio' ? transaction.audioSourceBuffer : transaction.videoSourceBuffer;
    if (!rep || !sourceBuffer) return Promise.resolve();
    var currentTime = provider.video.currentTime || 0;
    var prepare = provider._prepareRep ? provider._prepareRep(rep) : Promise.resolve(rep);
    return prepare.then(function () {
      guard();
      return waitForVodSourceBufferQueue(sourceBuffer);
    }).then(function () {
      guard();
      return appendDashControlSourceBufferConfiguration(
        provider,
        transaction,
        kind,
        rep,
        sourceBuffer,
        currentTime,
        guard
      );
    });
  }

  NativeDashProvider.prototype._reconcileSourceBufferConfiguration = function () {
    if (
      this.destroyed
      || this.dashControlTransitionInFlight
      || !this.dashSourceBufferConfigUncertain
      || !dashSourceBufferReconcilePendingHasEntries(this.dashSourceBufferReconcilePending)
    ) return Promise.resolve(false);
    try { this._abortRequests('sourcebuffer-config-reconcile-start'); } catch (e) {}
    var transaction = beginDashControlTransition(this, 'reconcile', null, false, 'sourcebuffer-config-reconcile');
    if (!transaction) return Promise.resolve(false);
    var self = this;
    var guard = dashControlTransitionGuard(this, transaction);
    var pending = this.dashSourceBufferReconcilePending;
    this.dashSourceBufferReconcileAttemptCount = (this.dashSourceBufferReconcileAttemptCount || 0) + 1;
    var chain = Promise.resolve();
    if (pending.video) chain = chain.then(function () {
      return reconcileDashSourceBufferKind(self, transaction, 'video', guard);
    });
    if (pending.audio) chain = chain.then(function () {
      return reconcileDashSourceBufferKind(self, transaction, 'audio', guard);
    });
    return chain.then(function () {
      guard();
      commitDashSourceBufferConfiguration(self, transaction);
      self.dashSourceBufferReconcileSuccessCount = (self.dashSourceBufferReconcileSuccessCount || 0) + 1;
      finishDashControlTransition(self, transaction, true);
      if (!flushPendingDashControlTransition(self)) self._tick(true);
      return true;
    }).catch(function (err) {
      if (!dashControlTransitionIsCurrent(self, transaction)) {
        return handleStaleDashControlTransition(self, transaction, 'sourcebuffer-config-reconcile-stale');
      }
      self.dashSourceBufferReconcileFailureCount = (self.dashSourceBufferReconcileFailureCount || 0) + 1;
      self.lastError = err && err.message ? err.message : 'dash-sourcebuffer-config-reconcile-failed';
      queueDashSourceBufferConfigurationReconciliation(self, transaction, 'sourcebuffer-config-reconcile-failed');
      finishDashControlTransition(self, transaction, false);
      if (self._tryNativeRecovery) return self._tryNativeRecovery('dash-sourcebuffer-config-reconcile');
      if (self._completeNativeRuntimeTerminal) self._completeNativeRuntimeTerminal('dash-sourcebuffer-config-reconcile-failed');
      return false;
    });
  };

  NativeDashProvider.prototype._drainAppendQueue = function (rep, sb) {
    var self = this;
    var activeSourceBuffer = rep && rep.kind === 'audio' ? this.audioSb : this.videoSb;
    if (activeSourceBuffer) sb = activeSourceBuffer;
    if (!rep || !rep.segments || !sb || sb.updating || rep._appending || rep._appendOwner) return false;
    if (this.dashSourceBufferConfigUncertain || this.dashControlTransitionInFlight || (rep.kind === 'video' && this.videoSwitchInFlight)) return false;
    var next = nextFetchedSegmentForAppend(rep, this.video.currentTime || 0);
    if (!next) return false;
    rep._appending = true;
    next.state = 'appending';
    next._appendStartedAt = performance.now();
    var data = next._data;
    delete next._data;
    var appendTransaction = createDashAppendTransaction(this, rep, next, sb, true);
    rep._appendOwner = appendTransaction;
    next._appendOwner = appendTransaction;
    this._appendSegmentData(rep, sb, next, data, appendTransaction).then(function () {
      assertDashAppendTransactionCurrent(self, appendTransaction);
      next.state = 'appended';
      next.appended = true;
      delete next._fetchStartedAt;
      delete next._appendStartedAt;
      delete next._appendOwner;
      rep._appendOwner = null;
      rep._appending = false;
      self.appendFailures = 0;
      self.stallReports = 0;
      self.stallRecoveryStage = 0;
      self.engine._player.emit('adaptation');
      self.schedulerDrainCount++;
      if (self.engine && self.engine._telemetry) self.engine._telemetry.record('scheduler-drain', {
        schedulerQueueDepth: self._schedulerQueueDepth()
      });
      if (self._checkBufferMilestones) self._checkBufferMilestones();
      var transitionStarted = flushPendingDashControlTransition(self);
      if (!transitionStarted) self._drainAppendQueue(rep, sb);
      if (self._maybeEndVodStream) self._maybeEndVodStream();
      if (!transitionStarted) self._tick();
    }).catch(function (err) {
      var ownsRep = rep._appendOwner === appendTransaction;
      var ownsSegment = next._appendOwner === appendTransaction;
      var configurationQueued = ownsSegment
        ? queueDashSourceBufferConfigurationReconciliation(self, appendTransaction, 'dash-append-failed')
        : false;
      if (ownsRep) {
        rep._appendOwner = null;
        rep._appending = false;
      }
      if (!ownsSegment) return;
      delete next._appendOwner;
      delete next._appendStartedAt;
      if (err.name === 'AbortError') {
        if (!self.destroyed && next.state === 'appending') {
          next.state = 'pending';
          next.appended = false;
        }
        if (!self.destroyed && !self.dashControlTransitionInFlight) {
          if (configurationQueued || self.pendingManualVideoSwitch || self.pendingAudioSwitch) {
            flushPendingDashControlTransition(self);
          }
        }
      } else {
        next.state = 'failed';
        next.appended = false;
        self._handleAppendFailure(rep, err);
      }
    });
    return true;
  };

  NativeDashProvider.prototype._maybeEndVodStream = function () {
    if (this.live || !this.mediaSource) return false;
    if (this.mediaSource.readyState === 'ended') {
      this.vodEndOfStreamPending = false;
      return false;
    }
    if (this.mediaSource.readyState !== 'open') return false;
    if (!this.vodEndOfStreamPending) {
      if (
        !this.activeVideo
        || !segmentsAppendedThroughEnd(this.activeVideo.segments, this.activeVideo.duration || this.duration)
      ) return false;
      if (!sourceBufferCoversPlayableEnd(this.videoSb, playableSegmentEnd(this.activeVideo.segments))) return false;
      if (
        this.audio
        && !segmentsAppendedThroughEnd(this.audio.segments, this.audio.duration || this.duration)
      ) return false;
      if (this.audio && !sourceBufferCoversPlayableEnd(this.audioSb, playableSegmentEnd(this.audio.segments))) return false;
      this.vodEndOfStreamPending = true;
    }
    return finalizeVodEndOfStream(this, [this.videoSb, this.audioSb]);
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

  NativeDashProvider.prototype._appendSegmentData = function (rep, sb, seg, data, appendTransaction) {
    var self = this;
    appendTransaction = appendTransaction || createDashAppendTransaction(this, rep, seg, sb, false);
    var guard = dashAppendTransactionGuard(this, appendTransaction);
    var prepare = this._prepareSegmentGeneration
      ? this._prepareSegmentGeneration(rep, sb, seg, appendTransaction)
      : Promise.resolve();
    return prepare.then(function () {
      assertDashAppendTransactionCurrent(self, appendTransaction);
      return appendBuffer(appendTransaction.sourceBuffer, data, seg.appendWindow, undefined, guard);
    }).catch(function (err) {
      if (!isQuotaExceeded(err)) throw err;
      assertDashAppendTransactionCurrent(self, appendTransaction);
      self.quotaRecoveries++;
      self.lastError = 'quota-exceeded';
      self.engine._telemetry.record('recovery', { lastError: 'quota-exceeded' });
      return self._recoverQuota(rep, appendTransaction.sourceBuffer, data, appendTransaction);
    }).then(function (result) {
      assertDashAppendTransactionCurrent(self, appendTransaction);
      commitDashSourceBufferConfiguration(self, appendTransaction);
      return result;
    });
  };

  NativeDashProvider.prototype._prepareSegmentGeneration = function (rep, sb, seg, appendTransaction) {
    if (!rep || !seg) return Promise.resolve();
    appendTransaction = appendTransaction || createDashAppendTransaction(this, rep, seg, sb, false);
    var key = seg.generationKey || rep.generationKey || generationKeyForRep(rep);
    var nextMime = segmentMime(seg, rep);
    var currentMime = rep.kind === 'audio' ? this.audioMime : this.videoMime;
    var self = this;
    var chain = Promise.resolve();
    try {
      assertDashAppendTransactionCurrent(this, appendTransaction);
    } catch (err) {
      return Promise.reject(err);
    }
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
        assertDashAppendTransactionCurrent(self, appendTransaction);
        markDashAppendSourceBufferConfigurationMutation(self, appendTransaction, rep.kind === 'audio' ? 'audio' : 'video', key);
        var change = rep.kind === 'audio' ? self._changeAudioTypeIfNeeded(typeRep) : self._changeVideoTypeIfNeeded(typeRep);
        return change.then(function () {
          assertDashAppendTransactionCurrent(self, appendTransaction);
          self.periodTransitionCount = (self.periodTransitionCount || 0) + 1;
          self.lastPeriodTransitionReason = 'changeType';
          self.lastPeriodTransitionError = '';
        }).catch(function (err) {
          assertDashAppendTransactionCurrent(self, appendTransaction);
          return self._rebuildSourceBufferForPeriod(rep, appendTransaction.sourceBuffer, seg, nextMime, err, appendTransaction).catch(function (rebuildErr) {
            if (rebuildErr && rebuildErr.name === 'AbortError') throw rebuildErr;
            self.lastPeriodTransitionError = rebuildErr && rebuildErr.message ? rebuildErr.message : 'dash-period-codec-change-unsupported';
            throw new Error('dash-period-codec-change-unsupported');
          });
        });
      });
    }
    return chain.then(function () {
      assertDashAppendTransactionCurrent(self, appendTransaction);
      if (rep._appendedInitKey === key) return;
      return self._initDataForSegment(rep, seg).then(function (initData) {
        assertDashAppendTransactionCurrent(self, appendTransaction);
        markDashAppendSourceBufferConfigurationMutation(self, appendTransaction, rep.kind === 'audio' ? 'audio' : 'video', key);
        return appendBuffer(
          appendTransaction.sourceBuffer,
          initData,
          seg.appendWindow,
          undefined,
          dashAppendTransactionGuard(self, appendTransaction)
        ).then(function () {
          assertDashAppendTransactionCurrent(self, appendTransaction);
          rep._appendedInitKey = key;
        });
      });
    });
  };

  NativeDashProvider.prototype._rebuildSourceBufferForPeriod = function (rep, sb, seg, nextMime, previousError, appendTransaction) {
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
    return waitForDashAppendTopologyPeers(this, appendTransaction).then(function () {
      if (appendTransaction) assertDashAppendTransactionCurrent(self, appendTransaction);
      return waitForVodSourceBufferQueue(sb);
    }).then(function () {
      if (appendTransaction) assertDashAppendTransactionCurrent(self, appendTransaction);
      else {
        if (self.destroyed) throw abortError();
        var currentSourceBuffer = kind === 'audio' ? self.audioSb : self.videoSb;
        if (currentSourceBuffer !== sb) throw abortError();
      }
      if (sb.updating || appendQueueDepth(sb) > 0) {
        throw new Error('dash-period-sourcebuffer-busy');
      }
      self.dashSourceBufferQueueDrainCount = (self.dashSourceBufferQueueDrainCount || 0) + 1;
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
      updateDashAppendTransactionSourceBuffer(appendTransaction, replacement);
      if (appendTransaction) assertDashAppendTransactionCurrent(self, appendTransaction);
      reconcileDashSegmentLedgers(self, kind, null, rep, appendTransaction && appendTransaction.segment, true);
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

  NativeDashProvider.prototype._recoverQuota = function (rep, sb, data, appendTransaction) {
    var self = this;
    appendTransaction = appendTransaction || createDashAppendTransaction(this, rep, null, sb, false);
    var guard = dashAppendTransactionGuard(this, appendTransaction);
    var removeEnd = Math.max(0, (this.video.currentTime || 0) - 5);
    try {
      assertDashAppendTransactionCurrent(this, appendTransaction);
    } catch (err) {
      return Promise.reject(err);
    }
    return waitForDashAppendTopologyPeers(this, appendTransaction).then(function () {
      assertDashAppendTransactionCurrent(self, appendTransaction);
      return Promise.all([
        removeBufferBefore(self.videoSb, removeEnd, guard),
        removeBufferBefore(self.audioSb, removeEnd, guard)
      ]);
    }).then(function (removedRanges) {
      assertDashAppendTransactionCurrent(self, appendTransaction);
      reconcileDashSegmentLedgers(
        self,
        'video',
        removedRanges[0],
        self.activeVideo,
        appendTransaction.kind === 'video' ? appendTransaction.segment : null,
        false
      );
      reconcileDashSegmentLedgers(
        self,
        'audio',
        removedRanges[1],
        self.audio,
        appendTransaction.kind === 'audio' ? appendTransaction.segment : null,
        false
      );
      var seg = appendTransaction.segment;
      var retry = seg && self._prepareSegmentGeneration
        ? self._prepareSegmentGeneration(rep, appendTransaction.sourceBuffer, seg, appendTransaction)
        : Promise.resolve();
      return retry.then(function () {
        assertDashAppendTransactionCurrent(self, appendTransaction);
        return appendBuffer(
          appendTransaction.sourceBuffer,
          data,
          seg && seg.appendWindow,
          undefined,
          guard
        );
      });
    }).catch(function (err) {
      if (!isQuotaExceeded(err) || rep.kind !== 'video') throw err;
      assertDashAppendTransactionCurrent(self, appendTransaction);
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
    if (this.destroyed || this.nativeRecoveryInProgress || this.dashControlTransitionInFlight) return Promise.resolve(false);
    reason = reason || 'native-recovery';
    try { this._abortRequests('native-recovery-start'); } catch (e) {}
    var transaction = beginDashControlTransition(this, 'recovery', null, true, reason);
    if (!transaction) return Promise.resolve(false);
    var guard = dashControlTransitionGuard(this, transaction);
    this.nativeRecoveryAttemptCount++;
    this.recoveryCount++;
    this.lastNativeRecoveryReason = reason;
    this.nativeRecoveryReasons = this.nativeRecoveryReasons || {};
    this.nativeRecoveryReasons[reason] = true;
    this.lastError = reason;
    if (this.engine && this.engine._telemetry) this.engine._telemetry.record('recovery', { lastError: reason });
    var self = this;
    var currentTime = this.video.currentTime || 0;
    if (transaction.previousVideo) transaction.previousVideo._appendedInitKey = '';
    if (transaction.previousAudio) transaction.previousAudio._appendedInitKey = '';
    return Promise.all([
      transaction.videoSourceBuffer ? resetSourceBuffer(transaction.videoSourceBuffer, currentTime, guard) : Promise.resolve(),
      transaction.audioSourceBuffer ? resetSourceBuffer(transaction.audioSourceBuffer, currentTime, guard) : Promise.resolve()
    ]).then(function (removedRanges) {
      guard();
      reconcileDashSegmentLedgers(self, 'video', removedRanges[0], transaction.previousVideo, null, false);
      reconcileDashSegmentLedgers(self, 'audio', removedRanges[1], transaction.previousAudio, null, false);
      if (transaction.previousVideo) {
        markSegmentsForTime(transaction.previousVideo, currentTime, Math.max(2, self._bufferAheadGoal()));
      }
      if (transaction.previousAudio) {
        markSegmentsForTime(transaction.previousAudio, currentTime, Math.max(2, self._bufferAheadGoal()));
      }
      var chain = Promise.resolve();
      if (transaction.videoSourceBuffer && transaction.previousVideo) {
        chain = chain.then(function () {
          guard();
          return appendDashControlSourceBufferConfiguration(
            self,
            transaction,
            'video',
            transaction.previousVideo,
            transaction.videoSourceBuffer,
            currentTime,
            guard
          );
        });
      }
      if (transaction.audioSourceBuffer && transaction.previousAudio) {
        chain = chain.then(function () {
          guard();
          return appendDashControlSourceBufferConfiguration(
            self,
            transaction,
            'audio',
            transaction.previousAudio,
            transaction.audioSourceBuffer,
            currentTime,
            guard
          );
        });
      }
      return chain;
    }).then(function () {
      guard();
      self.nativeRecoverySuccessCount++;
      self.appendFailures = 0;
      self.stallReports = 0;
      commitDashSourceBufferConfiguration(self, transaction);
      finishDashControlTransition(self, transaction, true);
      if (flushPendingDashControlTransition(self)) return true;
      self._tick(true);
      return true;
    }).catch(function (err) {
      if (!dashControlTransitionIsCurrent(self, transaction)) {
        handleStaleDashControlTransition(self, transaction, reason + '-stale');
        if (self.nativeRecoveryReasons) delete self.nativeRecoveryReasons[reason];
        return false;
      }
      self.lastError = err && err.message ? err.message : reason + '-failed';
      queueDashSourceBufferConfigurationReconciliation(self, transaction, reason + '-failed');
      finishDashControlTransition(self, transaction, false);
      if (reason === 'dash-sourcebuffer-config-reconcile' && self.dashSourceBufferConfigUncertain) {
        if (self._completeNativeRuntimeTerminal) self._completeNativeRuntimeTerminal('dash-sourcebuffer-config-reconcile-failed');
        return false;
      }
      if (!flushPendingDashControlTransition(self)) self._tick(true);
      return false;
    });
  };

  NativeDashProvider.prototype._maybeSwitchAuto = function () {
    if (this.dashSourceBufferConfigUncertain || !this.engine._player.config.abr.enabled || this.manualTrackId || this.videoSwitchInFlight || this.dashControlTransitionInFlight) return;
    var ahead = getBufferAhead(this.video);
    var current = this.activeVideo;
    var candidates = this._candidateVideos();
    if (!candidates.length) return;
    var now = performance.now();
    if (now - this.lastSwitchAt >= ABR_SWITCH_COOLDOWN_MS && sampleFramePressure(this, now)) {
      var smootherRep = this._lowerVideoRep();
      if (smootherRep) {
        this.frameDropDownswitchCount++;
        this._switchVideo(smootherRep, false, 'dropped-frames');
        return;
      }
    }
    var abr = this.engine._player.config.abr || {};
    var upgradeFactor = this.live
      ? Math.min(0.7, abr.bandwidthUpgradeTarget || 0.85)
      : (abr.bandwidthUpgradeTarget || 0.85);
    var downgradeFactor = abr.bandwidthDowngradeTarget || 0.95;
    var upgradeChoice = this._chooseForBudget(candidates, upgradeFactor);
    var sustainChoice = this._chooseForBudget(candidates, downgradeFactor);
    var currentSustainable = (current.bandwidth || 0)
      <= effectiveBandwidthEstimate(this) * downgradeFactor;
    var chosen = currentSustainable
      ? ((upgradeChoice.height || 0) > (current.height || 0) ? upgradeChoice : current)
      : sustainChoice;
    var isUpgrade = (chosen.height || 0) > (current.height || 0);
    var reason = !isUpgrade && ahead < ABR_DOWNGRADE_BUFFER ? 'low-buffer' : 'bandwidth';
    var allowUpgrade = (!this.lastSwitchAt || now - this.lastSwitchAt >= ABR_SWITCH_COOLDOWN_MS)
      && abrUpgradeIsSafe(this, chosen, ahead);
    if (chosen.id !== current.id && (!isUpgrade || allowUpgrade)) {
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
    // Startup has no measured throughput yet. Use a conservative fraction of
    // the estimate, then let normal ABR promote once playback has real samples
    // and enough buffered media.
    return this._chooseForBudget(candidates, this.bandwidthSamples ? 0.8 : 0.35);
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
    if (!rep || !this.activeVideo || rep.id === this.activeVideo.id || this.destroyed) return Promise.resolve(false);
    var switchReason = reason || (clearBuffer ? 'manual' : 'auto');
    if (this.dashSourceBufferConfigUncertain && switchReason !== 'manual') {
      flushPendingDashControlTransition(this);
      return Promise.resolve(false);
    }
    if (this.videoSwitchInFlight || this.dashControlTransitionInFlight) {
      if (switchReason === 'manual') {
        this.pendingManualVideoSwitch = { repId: rep.id, clearBuffer: clearBuffer !== false };
      }
      return Promise.resolve(false);
    }
    if (!clearBuffer && dashAppendWorkInFlight(this)) {
      if (switchReason === 'manual') {
        this.pendingManualVideoSwitch = { repId: rep.id, clearBuffer: false };
      }
      return Promise.resolve(false);
    }
    var self = this;
    if (clearBuffer) this._abortRequests('video-switch-start');
    var transaction = beginDashControlTransition(this, 'video', rep, clearBuffer, switchReason);
    if (!transaction) return Promise.resolve(false);
    var guard = dashControlTransitionGuard(this, transaction);
    var transition = this._prepareRep(rep).then(function () {
      guard();
      var videoReady;
      if (clearBuffer) {
        transaction.bufferMutationStarted = true;
        markSegmentsUnappended(rep);
        videoReady = resetSourceBuffer(transaction.videoSourceBuffer, self.video.currentTime, guard).then(function (removedRange) {
          guard();
          reconcileDashSegmentLedgers(self, 'video', removedRange, rep, null, false);
        });
      } else {
        videoReady = waitForVodSourceBufferQueue(transaction.videoSourceBuffer).then(function () {
          guard();
          markSegmentsCoveredByBuffer(rep, self.video);
        });
      }
      return videoReady.then(function () {
        guard();
        transaction.bufferMutationStarted = true;
        return appendDashControlSourceBufferConfiguration(
          self,
          transaction,
          'video',
          rep,
          transaction.videoSourceBuffer,
          self.video.currentTime || 0,
          guard
        );
      });
    }).then(function () {
      guard();
      self.activeVideo = rep;
      self.lastSwitchAt = performance.now();
      self.lastSwitchReason = switchReason;
      commitDashSourceBufferConfiguration(self, transaction);
      finishDashControlTransition(self, transaction, true);
      self.engine._player.emit('variantchanged');
      console.log('[native-dash] selected video id=' + rep.id + ' height=' + rep.height + ' codec=' + rep.codecs + ' reason=' + self.lastSwitchReason);
      if (flushPendingDashControlTransition(self)) return true;
      self._tick(true);
      return true;
    }).catch(function (err) {
      if (!dashControlTransitionIsCurrent(self, transaction)) {
        return handleStaleDashControlTransition(self, transaction, 'video-switch-stale');
      }
      var switchError = err && err.message ? err.message : 'dash-variant-switch-failed';
      self.dashControlTransitionRollbackCount = (self.dashControlTransitionRollbackCount || 0) + 1;
      // A codec change can succeed before the new initialization append fails.
      // Restore the previous SourceBuffer type before allowing its scheduler to
      // continue, and never leave the failed rendition reported as active.
      var previous = transaction.previousVideo;
      var restore = Promise.resolve();
      if (previous && transaction.bufferMutationStarted) {
        if (clearBuffer) markSegmentsUnappended(previous);
        restore = self._prepareRep(previous).then(function () {
          guard();
          return appendDashControlSourceBufferConfiguration(
            self,
            transaction,
            'video',
            previous,
            transaction.videoSourceBuffer,
            self.video.currentTime || 0,
            guard
          );
        });
      }
      return restore.then(function () {
        guard();
        self.blacklisted[rep.id] = true;
        self.lastError = switchError;
        self.activeVideo = previous;
        commitDashSourceBufferConfiguration(self, transaction);
        finishDashControlTransition(self, transaction, false);
        console.warn('[native-dash] switch failed id=' + rep.id + ': ' + self.lastError);
        if (!flushPendingDashControlTransition(self)) self._tick(true);
        return false;
      }).catch(function (restoreError) {
        if (!dashControlTransitionIsCurrent(self, transaction)) {
          return handleStaleDashControlTransition(self, transaction, 'video-switch-rollback-stale');
        }
        self.dashControlTransitionRollbackFailureCount = (self.dashControlTransitionRollbackFailureCount || 0) + 1;
        self.blacklisted[rep.id] = true;
        self.lastError = switchError + '; rollback: ' + (restoreError && restoreError.message
          ? restoreError.message
          : 'dash-variant-rollback-failed');
        self.activeVideo = previous;
        queueDashSourceBufferConfigurationReconciliation(self, transaction, 'video-switch-rollback-failed');
        finishDashControlTransition(self, transaction, false);
        console.warn('[native-dash] switch failed id=' + rep.id + ': ' + self.lastError);
        if (!flushPendingDashControlTransition(self)) self._tick(true);
        return false;
      });
    });
    return transition;
  };

  NativeDashProvider.prototype._flushPendingVideoSwitch = function () {
    var pending = this.pendingManualVideoSwitch;
    if (!pending || this.destroyed || this.videoSwitchInFlight || this.dashControlTransitionInFlight) return false;
    this.pendingManualVideoSwitch = null;
    var rep = this.videoReps.find(function (item) { return item.id === pending.repId; });
    if (!rep || !variantSelectable(this, rep)) return false;
    if (this.activeVideo === rep) {
      this.lastSwitchReason = 'manual';
      return false;
    }
    this._switchVideo(rep, pending.clearBuffer, 'manual');
    return !!(this.videoSwitchInFlight || this.dashControlTransitionInFlight);
  };

  NativeDashProvider.prototype._flushPendingDashControlTransition = function () {
    return flushPendingDashControlTransition(this);
  };

  NativeDashProvider.prototype._changeVideoTypeIfNeeded = function (rep, sourceBuffer, guard) {
    if (guard) guard();
    sourceBuffer = sourceBuffer || this.videoSb;
    var nextMime = mime(rep);
    if (nextMime === this.videoMime) return Promise.resolve();
    if (!sourceBuffer || !sourceBuffer.changeType) return Promise.reject(new Error('sourcebuffer-changeType-unavailable'));
    try {
      sourceBuffer.changeType(nextMime);
      if (guard) guard();
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
    if (this.videoSwitchInFlight || this.dashControlTransitionInFlight) {
      this.pendingManualVideoSwitch = {
        repId: rep.id,
        clearBuffer: clearBuffer !== false
      };
      return;
    }
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
    if (this.audioSwitchInFlight || this.dashControlTransitionInFlight) {
      this.pendingAudioSwitch = { repId: rep.id };
      return;
    }
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
    if (!rep || this.destroyed || this.audio && rep.id === this.audio.id) return Promise.resolve(false);
    if (this.audioSwitchInFlight || this.dashControlTransitionInFlight) {
      this.pendingAudioSwitch = { repId: rep.id };
      return Promise.resolve(false);
    }
    var self = this;
    this._abortRequests('audio-switch-start');
    var transaction = beginDashControlTransition(this, 'audio', rep, true, 'manual-audio');
    if (!transaction) return Promise.resolve(false);
    var guard = dashControlTransitionGuard(this, transaction);
    var transition = this._prepareRep(rep).then(function () {
      guard();
      transaction.bufferMutationStarted = true;
      markSegmentsUnappended(rep);
      return resetSourceBuffer(transaction.audioSourceBuffer, self.video.currentTime, guard).then(function (removedRange) {
        guard();
        reconcileDashSegmentLedgers(self, 'audio', removedRange, rep, null, false);
      });
    }).then(function () {
      guard();
      return appendDashControlSourceBufferConfiguration(
        self,
        transaction,
        'audio',
        rep,
        transaction.audioSourceBuffer,
        self.video.currentTime || 0,
        guard
      );
    }).then(function () {
      guard();
      self.audio = rep;
      commitDashSourceBufferConfiguration(self, transaction);
      finishDashControlTransition(self, transaction, true);
      self.engine._player.emit('audiotrackchanged', self.getActiveAudioTrack());
      console.log('[native-dash] selected audio id=' + rep.id + ' lang=' + (rep.language || '') + ' codec=' + rep.codecs);
      if (flushPendingDashControlTransition(self)) return true;
      self._tick(true);
      return true;
    }).catch(function (err) {
      if (!dashControlTransitionIsCurrent(self, transaction)) {
        return handleStaleDashControlTransition(self, transaction, 'audio-switch-stale');
      }
      var switchError = err && err.message ? err.message : 'audio-switch-failed';
      var previous = transaction.previousAudio;
      var restore = Promise.resolve();
      if (previous && transaction.bufferMutationStarted) {
        self.dashControlTransitionRollbackCount = (self.dashControlTransitionRollbackCount || 0) + 1;
        markSegmentsUnappended(previous);
        restore = self._prepareRep(previous).then(function () {
          guard();
          return appendDashControlSourceBufferConfiguration(
            self,
            transaction,
            'audio',
            previous,
            transaction.audioSourceBuffer,
            self.video.currentTime || 0,
            guard
          );
        });
      }
      return restore.then(function () {
        guard();
        self.audio = previous;
        self.lastError = switchError;
        commitDashSourceBufferConfiguration(self, transaction);
        finishDashControlTransition(self, transaction, false);
        console.warn('[native-dash] audio switch failed id=' + rep.id + ': ' + self.lastError);
        if (!flushPendingDashControlTransition(self)) self._tick(true);
        return false;
      }).catch(function (restoreError) {
        if (!dashControlTransitionIsCurrent(self, transaction)) {
          return handleStaleDashControlTransition(self, transaction, 'audio-switch-rollback-stale');
        }
        self.dashControlTransitionRollbackFailureCount = (self.dashControlTransitionRollbackFailureCount || 0) + 1;
        self.audio = previous;
        self.lastError = switchError + '; rollback: ' + (restoreError && restoreError.message
          ? restoreError.message
          : 'dash-audio-rollback-failed');
        queueDashSourceBufferConfigurationReconciliation(self, transaction, 'audio-switch-rollback-failed');
        finishDashControlTransition(self, transaction, false);
        console.warn('[native-dash] audio switch failed id=' + rep.id + ': ' + self.lastError);
        if (!flushPendingDashControlTransition(self)) self._tick(true);
        return false;
      });
    });
    return transition;
  };

  NativeDashProvider.prototype._changeAudioTypeIfNeeded = function (rep, sourceBuffer, guard) {
    if (guard) guard();
    sourceBuffer = sourceBuffer || this.audioSb;
    var nextMime = mime(rep);
    if (nextMime === this.audioMime) return Promise.resolve();
    if (!sourceBuffer || !sourceBuffer.changeType) return Promise.reject(new Error('sourcebuffer-changeType-unavailable'));
    try {
      sourceBuffer.changeType(nextMime);
      if (guard) guard();
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
    return this.live && range ? { start: range.start, end: range.end } : null;
  };

  NativeDashProvider.prototype.seekRange = function () {
    var liveRange = this.getLiveRange();
    if (liveRange) return liveRange;
    if (isFinite(this.duration) && this.duration > 0) return { start: 0, end: this.duration };
    return mediaSeekRange(this.video);
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
      bandwidthFastEstimate: Math.round(this.bandwidthFast || 0),
      bandwidthSlowEstimate: Math.round(this.bandwidthSlow || 0),
      bandwidthTimeToFirstByteEstimateMs: Math.round(this.bandwidthTtfbEstimate || 0),
      frameDropDownswitchCount: this.frameDropDownswitchCount || 0,
      lastFrameDropRatio: this.lastFrameDropRatio || 0,
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
      variantSwitchInFlight: !!this.videoSwitchInFlight,
      pendingManualVariantId: this.pendingManualVideoSwitch ? this.pendingManualVideoSwitch.repId : '',
      fallbackReason: this.engine ? (this.engine._fallbackReason || '') : '',
      rebufferCount: this.rebufferCount,
      rebufferDuration: this.rebufferDuration + (this.rebufferStartedAt ? (performance.now() - this.rebufferStartedAt) / 1000 : 0),
      recoveryCount: this.recoveryCount,
      lastError: this.lastError,
      lastHttpStatus: this.lastHttpStatus,
      gapJumpCount: this.gapJumpCount,
      lastGapSize: this.lastGapSize,
      manifestGapJumpCount: this.manifestGapJumpCount || 0,
      lastManifestGapSize: this.lastManifestGapSize || 0,
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
      dashAppendTransactionCount: this.dashAppendTransactionCount || 0,
      dashStaleAppendAbortCount: this.dashStaleAppendAbortCount || 0,
      dashSourceBufferQueueDrainCount: this.dashSourceBufferQueueDrainCount || 0,
      dashControlTransitionCount: this.dashControlTransitionCount || 0,
      dashControlTransitionCommitCount: this.dashControlTransitionCommitCount || 0,
      dashControlTransitionInvalidationCount: this.dashControlTransitionInvalidationCount || 0,
      dashStaleControlTransitionAbortCount: this.dashStaleControlTransitionAbortCount || 0,
      dashStaleControlTransitionReleaseCount: this.dashStaleControlTransitionReleaseCount || 0,
      dashControlTransitionRollbackCount: this.dashControlTransitionRollbackCount || 0,
      dashControlTransitionRollbackFailureCount: this.dashControlTransitionRollbackFailureCount || 0,
      dashControlTransitionInFlight: !!this.dashControlTransitionInFlight,
      dashControlTransitionKind: this.dashControlTransitionInFlight ? this.dashControlTransitionInFlight.kind : '',
      dashSourceBufferConfigEpoch: this.dashSourceBufferConfigEpoch || 0,
      dashSourceBufferCommittedConfigEpoch: this.dashSourceBufferCommittedConfigEpoch || 0,
      dashSourceBufferConfigUncertain: !!this.dashSourceBufferConfigUncertain,
      dashSourceBufferReconcileVideoPending: !!(this.dashSourceBufferReconcilePending && this.dashSourceBufferReconcilePending.video),
      dashSourceBufferReconcileAudioPending: !!(this.dashSourceBufferReconcilePending && this.dashSourceBufferReconcilePending.audio),
      dashSourceBufferReconcileQueuedCount: this.dashSourceBufferReconcileQueuedCount || 0,
      dashSourceBufferReconcileAttemptCount: this.dashSourceBufferReconcileAttemptCount || 0,
      dashSourceBufferReconcileSuccessCount: this.dashSourceBufferReconcileSuccessCount || 0,
      dashSourceBufferReconcileFailureCount: this.dashSourceBufferReconcileFailureCount || 0,
      dashSegmentLedgerReconcileCount: this.dashSegmentLedgerReconcileCount || 0,
      dashSegmentLedgerInvalidationCount: this.dashSegmentLedgerInvalidationCount || 0,
      pendingAudioTrackId: this.pendingAudioSwitch ? this.pendingAudioSwitch.repId : '',
      lastDashControlTransitionInvalidationReason: this.lastDashControlTransitionInvalidationReason || '',
      seekBufferPending: !!this.seekBufferPending,
      seekInteractionPending: !!this.seekInteractionPending,
      seekBufferReadyCount: this.seekBufferReadyCount || 0,
      bufferedSeekCount: this.bufferedSeekCount || 0,
      seekCount: this.seekCount || 0,
      seekCancelCount: this.seekCancelCount || 0,
      seekAbortCount: this.seekAbortCount || 0,
      seekGeneration: this.seekGeneration || 0,
      activeSeekGeneration: this.activeSeekGeneration || 0,
      completedSeekGeneration: this.completedSeekGeneration || 0,
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
      vodEndOfStreamPending: !!this.vodEndOfStreamPending,
      vodEndOfStreamRetryCount: this.vodEndOfStreamRetryCount || 0,
      vodEndOfStreamRefillPending: !!this.vodEndOfStreamRefillPending,
      vodEndOfStreamReopenCount: this.vodEndOfStreamReopenCount || 0,
      vodFinalDuration: this.vodFinalDuration || 0,
      liveToVodTransitionCount: this.liveToVodTransitionCount || 0,
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
      manifestRefreshInFlight: !!this.manifestRefreshPromise,
      manifestRefreshReasonInFlight: this.manifestRefreshReasonInFlight || '',
      lastManifestPublishTime: isFinite(this.lastManifestPublishTime) ? this.lastManifestPublishTime : 0,
      staleManifestResponseCount: this.staleManifestResponseCount || 0,
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
    return beginSeekOperation(this, target).target;
  };

  NativeDashProvider.prototype.commitSeek = function (targetTime) {
    var target = this._clampSeekTarget(targetTime);
    if (!seekOperationMatches(this, target)) this.beginSeek(target);
    var generation = this.activeSeekGeneration;
    this.seekCount++;
    try { this.video.currentTime = target; } catch (e) {}
    this._onSeek(target, generation);
    return target;
  };

  NativeDashProvider.prototype.cancelSeek = function () {
    this.seekCancelCount++;
    cancelSeekOperation(this);
  };

  NativeDashProvider.prototype.endSeek = function (generation) {
    return finishSeekInteraction(this, generation);
  };

  NativeDashProvider.prototype._completeSeekBuffer = function (generation, buffered) {
    return completeSeekBuffer(this, generation, buffered);
  };

  NativeDashProvider.prototype.seekDuringRecovery = function (targetTime) {
    this.commitSeek(targetTime);
  };

  NativeDashProvider.prototype._onSeek = function (targetTime, generation) {
    if (this.destroyed) return;
    var target = this._clampSeekTarget(targetTime == null ? this.video.currentTime : targetTime);
    if (
      !(generation > 0)
      || generation !== this.activeSeekGeneration
      || Math.abs(target - this.lastSeekTarget) > 0.05
    ) {
      generation = beginSeekOperation(this, target).generation;
    }
    var now = performance.now();
    if (
      this._lastSeekHandledGeneration === generation
      && this._lastSeekHandledTarget !== null
      && Math.abs(target - this._lastSeekHandledTarget) <= 0.05
      && now - this._lastSeekHandledAt < 100
    ) return;
    this._lastSeekHandledTarget = target;
    this._lastSeekHandledAt = now;
    this._lastSeekHandledGeneration = generation;
    if (Math.abs(target - (this.video.currentTime || 0)) > 0.05) {
      try { this.video.currentTime = target; } catch (e) {}
    }
    this.lastSeekTarget = target;
    if (bufferedContains(this.video.buffered, target)) {
      completeSeekBuffer(this, generation, true);
      return;
    }
    var cancelled = this._abortRequests('seek');
    if (cancelled > 0) this.seekAbortCount += cancelled;
    prepareVodStreamRefill(this);
    prepareSegmentsForRefill(this.activeVideo, this.videoSb || this.video, target, Math.max(2, this._seekBufferGoal()));
    prepareSegmentsForRefill(this.audio, this.audioSb || this.video, target, Math.max(2, this._seekBufferGoal()));
    if (!flushPendingDashControlTransition(this)) this._tick(true);
  };

  NativeDashProvider.prototype._onWaiting = function () {
    if (this._jumpManifestGap && this._jumpManifestGap()) return;
    if (this._maybeEndVodStream && this._maybeEndVodStream()) return;
    if (endedVodSchedulerIsIdle(this)) return;
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

  NativeDashProvider.prototype._abortRequests = function (reason) {
    queueDashAppendSourceBufferConfigurationReconciliation(this, reason || 'request-cancel');
    invalidateDashControlTransition(this, reason || 'request-cancel');
    var cancelled = this.controllers.length + countKeys(this.activeRanges)
      + (this.activeVideo && (this.activeVideo._appendOwner || this.activeVideo._appending) ? 1 : 0)
      + (this.audio && (this.audio._appendOwner || this.audio._appending) ? 1 : 0);
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
    var bufferedAhead = this.seekBufferPending
      ? getBufferAheadAt(this.video, this.lastSeekTarget, 0.05)
      : getBufferAhead(this.video);
    var ready = bufferedAhead + 0.05 >= startupBufferRequirement(this, readyGoal);
    if (ready && !this.startupBufferComplete) {
      markStartupBufferReady(this);
    }
    if (ready && this.seekBufferPending) {
      completeSeekBuffer(this, this.activeSeekGeneration, false);
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
      assignInternalMediaTime(this, gap.start + 0.01);
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

  NativeDashProvider.prototype._jumpManifestGap = function () {
    return jumpDeclaredManifestGap(this, 'dash');
  };

  NativeDashProvider.prototype._startNearLiveEdge = function () {
    this._updateLiveWindowFromReps();
    if (!this.liveWindow) return;
    var start = Math.max(this.liveWindow.start, this.liveWindow.end - LIVE_TARGET_LATENCY);
    if (!this.video.currentTime || this.video.currentTime < this.liveWindow.start || this.video.currentTime > this.liveWindow.end) {
      assignInternalMediaTime(this, start);
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
      assignInternalMediaTime(this, liveRange.start);
    }
    if (!this.video.seeking && getBufferAhead(this.video) > 2 && this.liveLatency > LIVE_MAX_LATENCY) {
      try {
        assignInternalMediaTime(this, Math.max(liveRange.start, edge - LIVE_TARGET_LATENCY));
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
    if (this.manifestRefreshPromise) {
      if (reason === 'media-error' && this.manifestRefreshReasonInFlight !== 'media-error') {
        var causalRefresh = this.manifestRefreshPromise.catch(function () {}).then(function () {
          return NativeDashProvider.prototype._refreshPlaybackManifest.call(self, reason, false);
        });
        return swallowErrors ? causalRefresh.catch(function () {}) : causalRefresh;
      }
      return swallowErrors ? this.manifestRefreshPromise.catch(function () {}) : this.manifestRefreshPromise;
    }
    var refreshPromise = fetchManifest(this.engine, this.manifestUrl).then(function (manifest) {
      if (self.destroyed) return;
      var parsed = parseMPD(manifest.text || self.manifestText, manifest.url || self.manifestUrl);
      if (self.presentationEnded && parsed.type === 'dynamic') {
        self.staleManifestResponseCount = (self.staleManifestResponseCount || 0) + 1;
        self.engine._telemetry.record('manifest-refresh', {
          manifestRefreshReason: 'stale-dynamic-after-static'
        });
        return { applied: false, stale: true, advanced: false, reason: 'stale-dynamic-after-static' };
      }
      var stalePublishTime = parsed.type === 'dynamic'
        && isFinite(parsed.publishTime)
        && isFinite(self.lastManifestPublishTime)
        && parsed.publishTime < self.lastManifestPublishTime;
      var staleLiveWindow = parsed.type === 'dynamic'
        && self.live
        && parsed.liveWindow
        && self.liveWindow
        && parsed.liveWindow.end < self.liveWindow.end - 0.001;
      if (stalePublishTime || staleLiveWindow) {
        self.staleManifestResponseCount = (self.staleManifestResponseCount || 0) + 1;
        self.engine._telemetry.record('manifest-refresh', {
          manifestRefreshReason: stalePublishTime ? 'stale-publish-time' : 'stale-live-window'
        });
        return {
          applied: false,
          stale: true,
          advanced: false,
          reason: stalePublishTime ? 'stale-publish-time' : 'stale-live-window'
        };
      }
      if (parsed.type !== 'dynamic') self.presentationEnded = true;
      if (isFinite(parsed.publishTime)) {
        self.lastManifestPublishTime = isFinite(self.lastManifestPublishTime)
          ? Math.max(self.lastManifestPublishTime, parsed.publishTime)
          : parsed.publishTime;
      }
      self.manifestText = manifest.text || self.manifestText;
      self.manifestRefreshReason = reason || (parsed.type === 'dynamic' ? 'live' : 'manual');
      var nextLive = parsed.type === 'dynamic';
      self.minimumUpdatePeriod = nextLive ? (parsed.minimumUpdatePeriod || self.minimumUpdatePeriod) : 0;
      self.liveWindow = nextLive ? (parsed.liveWindow || self.liveWindow) : null;
      self.manifestCompatibilityWarnings = mergeUnique(self.manifestCompatibilityWarnings || [], parsed.warnings || []);
      addTimelineRegions(self, parsed.timelineRegions || []);
      if (parsed.type === 'dynamic') {
        mergeLiveReps(self.videoReps, parsed.video);
        mergeLiveReps(self.audioReps, parsed.audio);
      } else {
        mergeStaticReps(self.videoReps, parsed.video);
        mergeStaticReps(self.audioReps, parsed.audio);
      }
      applyProviderPresentationState(self, nextLive, parsed.duration);
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
      return {
        applied: true,
        stale: false,
        advanced: parsed.type === 'dynamic',
        reason: self.manifestRefreshReason
      };
    }).catch(function (err) {
      self.manifestRefreshFailed = true;
      self.recoveryCount++;
      self.lastError = err && err.message ? err.message : 'manifest-refresh-failed';
      self.engine._telemetry.record('recovery', { lastError: self.lastError });
      console.warn('[native-dash] manifest refresh failed: ' + self.lastError);
      throw err;
    });
    var trackedPromise = refreshPromise.then(function (value) {
      if (self.manifestRefreshPromise === trackedPromise) {
        self.manifestRefreshPromise = null;
        self.manifestRefreshReasonInFlight = '';
      }
      return value;
    }, function (err) {
      if (self.manifestRefreshPromise === trackedPromise) {
        self.manifestRefreshPromise = null;
        self.manifestRefreshReasonInFlight = '';
      }
      throw err;
    });
    this.manifestRefreshReasonInFlight = reason || 'manual';
    this.manifestRefreshPromise = trackedPromise;
    return swallowErrors ? trackedPromise.catch(function () {}) : trackedPromise;
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
    if (this._jumpManifestGap && this._jumpManifestGap()) return;
    var reopeningEndedVod = prepareVodStreamRefill(this);
    this._tick(true);
    if (getBufferAhead(this.video) < 0.5) {
      if (this._jumpSmallGap && this._jumpSmallGap()) return;
      this.stallReports++;
      this.lastError = 'stall';
      this.engine._telemetry.record('recovery', { lastError: 'stall' });
      if (this.stallRecoveryStage === 0) {
        this.stallRecoveryStage = 1;
        if (reopeningEndedVod) {
          prepareSegmentsForRefill(this.activeVideo, this.videoSb || this.video, this.video.currentTime, Math.max(2, this._bufferAheadGoal()));
          prepareSegmentsForRefill(this.audio, this.audioSb || this.video, this.video.currentTime, Math.max(2, this._bufferAheadGoal()));
        } else {
          markSegmentsForTime(this.activeVideo, this.video.currentTime, Math.max(2, this._bufferAheadGoal()));
          markSegmentsForTime(this.audio, this.video.currentTime, Math.max(2, this._bufferAheadGoal()));
        }
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

  NativeDashProvider.prototype.quiesce = function (reason) {
    if (this._terminalQuiesced) return false;
    this._terminalQuiesced = true;
    this.destroyed = true;
    invalidateSeekOperation(this);
    this.manifestRefreshPromise = null;
    this.manifestRefreshReasonInFlight = '';
    clearVodEndOfStreamState(this);
    if (this.fillTimer) clearInterval(this.fillTimer);
    this.fillTimer = null;
    if (this.manifestRefreshTimer) clearTimeout(this.manifestRefreshTimer);
    this.manifestRefreshTimer = null;
    try { this._abortRequests(reason || 'terminal'); } catch (e) {}
    this.dashControlTransitionInFlight = null;
    this.videoSwitchInFlight = false;
    this.audioSwitchInFlight = false;
    this.nativeRecoveryInProgress = false;
    this.pendingManualVideoSwitch = null;
    this.pendingAudioSwitch = null;
    this.activeRanges = {};
    if (this._boundTick) this.video.removeEventListener('timeupdate', this._boundTick);
    if (this._boundSeek) this.video.removeEventListener('seeking', this._boundSeek);
    if (this._boundSeeked) this.video.removeEventListener('seeked', this._boundSeeked);
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
    return true;
  };

  NativeDashProvider.prototype.destroy = function () {
    this.quiesce('destroy');
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

  function fetchText(engine, url, onSource, requestOptions) {
    return nativeNetworkRequest(engine, NativeNetworkingEngine.RequestType.MANIFEST, {
      uris: [url],
      method: 'GET',
      headers: {}
    }, requestOptions).then(function (resp) {
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
    var lastPartRangeEnd = -1;
    var lastPartRangeUri = '';
    var preloadHints = [];
    var renditionReports = [];
    var serverControl = null;
    var partTargetDuration = 0;
    var skippedSegmentCount = 0;
    var contentSteeringUri = '';
    var contentSteeringPathwayId = '';
    var warnings = [];
    var map = null;
    var maps = [];
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
    var pendingGap = false;
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
        if (!segments.length && targetDuration > 0) timeline = (mediaSequence + skippedSegmentCount) * targetDuration;
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
        if (currentKey) {
          map.key = currentKey;
          if (currentKey.method === 'AES-128' && !currentKey.iv) {
            unsupportedEncryption = true;
            unsupportedEncryptionReason = 'hls-map-iv-required';
          }
        }
        maps.push(map);
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
          var resolvedPartUri = resolveUrl(partUri, playlistUrl);
          var partRangeBase = resolvedPartUri === lastPartRangeUri ? lastPartRangeEnd : -1;
          var partRange = hlsByteRange(unquote(partAttrs.BYTERANGE || ''), partRangeBase);
          pendingParts.push({
            url: resolvedPartUri,
            duration: parseFloat(unquote(partAttrs.DURATION || '')) || 0,
            independent: String(unquote(partAttrs.INDEPENDENT || '')).toUpperCase() === 'YES',
            gap: String(unquote(partAttrs.GAP || '')).toUpperCase() === 'YES',
            range: partRange,
            _hlsInitSegment: map
          });
          lastPartRangeEnd = partRange ? partRange.end : -1;
          lastPartRangeUri = partRange ? resolvedPartUri : '';
        }
      } else if (line.indexOf('#EXT-X-PRELOAD-HINT') === 0) {
        var hintAttrs = hlsAttrs(line);
        var hintUri = unquote(hintAttrs.URI || '');
        preloadHints.push({
          type: unquote(hintAttrs.TYPE || ''),
          url: hintUri ? resolveUrl(hintUri, playlistUrl) : '',
          byteRangeStart: parseInt(unquote(hintAttrs['BYTERANGE-START'] || ''), 10),
          byteRangeLength: parseInt(unquote(hintAttrs['BYTERANGE-LENGTH'] || ''), 10),
          _hlsInitSegment: map
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
        if (!segments.length && skipped > 0 && targetDuration > 0) timeline += skipped * targetDuration;
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
      } else if (line === '#EXT-X-GAP') {
        pendingGap = true;
      } else if (line.indexOf('#EXT-X-TARGETDURATION') === 0) {
        targetDuration = parseFloat(line.split(':')[1] || '0') || 0;
        if (!segments.length && targetDuration > 0) timeline = (mediaSequence + skippedSegmentCount) * targetDuration;
      } else if (line.indexOf('#EXT-X-MEDIA-SEQUENCE') === 0) {
        mediaSequence = parseInt(line.split(':')[1] || '0', 10) || 0;
        if (!segments.length && targetDuration > 0) timeline = (mediaSequence + skippedSegmentCount) * targetDuration;
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
          mediaSequence: mediaSequence + skippedSegmentCount + segments.length,
          discontinuity: pendingDiscontinuity,
          discontinuitySequence: currentDiscontinuitySequence,
          gap: pendingGap,
          url: resolveUrl(line, playlistUrl),
          range: range,
          _hlsPartialOnly: false,
          _hlsPlaylistUrl: playlistUrl,
          _hlsInitSegment: map
        };
        if (imageTiles) segment.tiles = imageTiles;
        if (pendingParts.length) {
          segment.parts = normalizeHlsParts(pendingParts, segment);
          pendingParts = [];
          lastPartRangeEnd = -1;
          lastPartRangeUri = '';
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
        pendingGap = false;
      }
    }
    // The live edge of an LL-HLS Playlist normally contains Partial Segments
    // whose Parent Segment does not have an EXTINF/URI yet. Represent that
    // in-progress parent explicitly so its parts participate in scheduling.
    if (pendingParts.length) {
      var partialDuration = pendingParts.reduce(function (sum, part) {
        return sum + (part.duration || 0);
      }, 0);
      var partialParent = {
        start: timeline,
        end: timeline + partialDuration,
        duration: partialDuration,
        mediaSequence: mediaSequence + skippedSegmentCount + segments.length,
        discontinuity: pendingDiscontinuity,
        discontinuitySequence: currentDiscontinuitySequence,
        gap: false,
        url: '',
        range: null,
        _hlsPartialOnly: true,
        _hlsPlaylistUrl: playlistUrl,
        _hlsInitSegment: map
      };
      if (currentKey) partialParent.key = currentKey;
      if (isFinite(pendingProgramDateTimeMs)) partialParent.programDateTimeMs = pendingProgramDateTimeMs;
      partialParent.parts = normalizeHlsParts(pendingParts, partialParent);
      segments.push(partialParent);
      timeline += partialDuration;
      duration = timeline;
      pendingParts = [];
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
      partialSegmentCount: segments.reduce(function (count, segment) { return count + ((segment.parts && segment.parts.length) || 0); }, 0),
      partialSegmentGapCount: segments.reduce(function (count, segment) {
        return count + ((segment.parts || []).filter(function (part) { return part.gap; }).length);
      }, 0),
      skippedSegmentCount: skippedSegmentCount,
      lowLatencyPlaylist: !!(partTargetDuration || preloadHints.length || segments.some(function (segment) { return !!(segment.parts && segment.parts.length); })),
      imagesOnly: !!imageTiles,
      contentSteeringUri: contentSteeringUri,
      contentSteeringPathwayId: contentSteeringPathwayId,
      warnings: warnings,
      map: segments.length && segments[0]._hlsInitSegment ? segments[0]._hlsInitSegment : map,
      maps: maps,
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

  function hlsSegmentContainerHint(seg) {
    if (!seg) return '';
    if (/\.ts(\?|$)/i.test(seg.url || '')) return 'mpegts';
    if (seg._hlsInitSegment) return 'fmp4';
    return '';
  }

  function hlsMpegTsBytes(data) {
    var bytes = data instanceof Uint8Array
      ? data
      : (data instanceof ArrayBuffer ? new Uint8Array(data) : (ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : null));
    if (!bytes || bytes.length < 188) return false;
    var scanEnd = Math.min(188, bytes.length);
    for (var offset = 0; offset < scanEnd; offset++) {
      if (bytes[offset] !== 0x47) continue;
      if (offset + 188 >= bytes.length || bytes[offset + 188] !== 0x47) continue;
      if (offset + 376 < bytes.length && bytes[offset + 376] !== 0x47) continue;
      return true;
    }
    return false;
  }

  function hlsFmp4Bytes(data) {
    var view = mp4DataView(data);
    if (!view || view.byteLength < 8) return false;
    var boxes = mp4Boxes(view, 0, Math.min(view.byteLength, 1024 * 1024));
    for (var i = 0; i < boxes.length; i++) {
      if (boxes[i].type === 'ftyp' || boxes[i].type === 'styp' || boxes[i].type === 'moof' || boxes[i].type === 'sidx') return true;
    }
    return false;
  }

  function detectHlsMediaContainer(data, seg) {
    if (hlsMpegTsBytes(data)) return 'mpegts';
    if (hlsFmp4Bytes(data)) return 'fmp4';
    return hlsSegmentContainerHint(seg);
  }

  function bindHlsGenerationContainer(provider, seg, container) {
    if (!seg || !container) return container;
    seg._hlsContainer = container;
    var parent = seg._parentSegment || seg;
    if (parent) parent._hlsContainer = parent._hlsContainer || container;
    var generationKey = seg._hlsTimestampGenerationKey || parent && parent._hlsTimestampGenerationKey || '';
    var generation = provider && provider.hlsTimestampGenerationByKey && generationKey
      ? provider.hlsTimestampGenerationByKey[generationKey]
      : null;
    if (generation && generation.container && generation.container !== container) {
      provider.hlsContainerMismatchCount = (provider.hlsContainerMismatchCount || 0) + 1;
      var mismatch = new Error('hls-container-generation-mismatch');
      mismatch.code = 'HLS_CONTAINER_GENERATION_MISMATCH';
      throw mismatch;
    }
    if (generation && !generation.container) generation.container = container;
    if (provider) provider.hlsContainerDetectionCount = (provider.hlsContainerDetectionCount || 0) + 1;
    return container;
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
    // Older service workers stamped every synthetic network-miss response as offline.
    // Trust that hint only when the window also reports offline; otherwise hold the
    // request so the server-down probe can resume it after a server restart.
    if (swInfo && swInfo.offline && !isOnline()) return false;
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
    if (opts && opts.__networkHoldAttempts >= MAX_NETWORK_HOLD_CYCLES) return false;
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
    opts = opts || {};
    var timedSignal = createTimedRequestSignal(opts.signal, networkTimeoutFor(type, opts));
    init.signal = timedSignal.signal;
    if (request.body != null) init.body = request.body;
    var fetchUri = engine ? stampUri(engine, uri) : uri;
    var started = performance.now();
    return fetch(fetchUri, init).then(function (resp) {
      return resp.arrayBuffer().then(function (data) {
        timedSignal.cleanup();
        return {
          uri: resp.url || fetchUri,
          originalUri: uri,
          data: data,
          status: resp.status,
          headers: headersToObject(resp.headers),
          timeMs: Math.max(0, performance.now() - started)
        };
      });
    }).then(function (response) {
      timedSignal.cleanup();
      return response;
    }, function (err) {
      var timedOut = timedSignal.timedOut();
      timedSignal.cleanup();
      if (timedOut) throw networkTimeoutError();
      throw err;
    });
  }

  function networkTimeoutFor(type, opts) {
    var configured = Number(opts && opts.timeoutMs);
    if (isFinite(configured) && configured > 0) return configured;
    if (type === NativeNetworkingEngine.RequestType.MANIFEST) return MANIFEST_REQUEST_TIMEOUT_MS;
    if (type === NativeNetworkingEngine.RequestType.SEGMENT) return SEGMENT_REQUEST_TIMEOUT_MS;
    if (type === NativeNetworkingEngine.RequestType.KEY || type === NativeNetworkingEngine.RequestType.LICENSE) return AUX_REQUEST_TIMEOUT_MS;
    return 30000;
  }

  function createTimedRequestSignal(externalSignal, timeoutMs) {
    var controller = new AbortController();
    var didTimeout = false;
    function abortFromExternal() { controller.abort(); }
    if (externalSignal) {
      if (externalSignal.aborted) controller.abort();
      else externalSignal.addEventListener('abort', abortFromExternal, { once: true });
    }
    var timer = setTimeout(function () {
      didTimeout = true;
      controller.abort();
    }, timeoutMs);
    return {
      signal: controller.signal,
      timedOut: function () { return didTimeout; },
      cleanup: function () {
        clearTimeout(timer);
        if (externalSignal) externalSignal.removeEventListener('abort', abortFromExternal);
      }
    };
  }

  function networkTimeoutError() {
    var err = new Error('network-request-timeout');
    err.name = 'TimeoutError';
    return err;
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
    out.networkTimeoutCount = networkStats.networkTimeoutCount || 0;
    out.networkHeldRequestCount = networkStats.networkHeldRequestCount || 0;
    out.networkResumeCount = networkStats.networkResumeCount || 0;
    out.networkHoldReason = networkStats.networkHoldReason || "";
    out.networkHoldMs = Math.round(networkStats.networkHoldMs || 0);
    out.stallWatchReportCount = engine && engine._stallWatchReportCount ? engine._stallWatchReportCount : 0;
    out.stallWatchWaiting = !!(engine && engine._stallWatchWaiting);
    out.playerState = engine && engine._state ? engine._state : 'idle';
    out.terminalErrorCount = engine && engine._terminalErrorCount ? engine._terminalErrorCount : 0;
    out.terminalErrorPhase = engine && engine._terminalErrorPhase ? engine._terminalErrorPhase : '';
    out.terminalLoadGeneration = engine && engine._terminalErrorGeneration >= 0 ? engine._terminalErrorGeneration : -1;
    out.providerTerminalQuiesced = !!(engine && engine._provider && engine._provider._terminalQuiesced);
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
      publishTime: publishTime,
      availabilityStartTime: availabilityStartTime,
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

  function mutateSourceBuffer(sb, mutation, options) {
    options = options || {};
    if (!sb) return Promise.reject(new Error(options.errorMessage || 'sourcebuffer-unavailable'));
    return queueSourceBuffer(sb, function () {
      return waitForSourceBufferIdle(sb).then(function () {
        if (options.guard) options.guard();
        return new Promise(function (resolve, reject) {
          var settled = false;
          var timeoutId = 0;
          function cleanup() {
            if (timeoutId) clearTimeout(timeoutId);
            sb.removeEventListener('updateend', onEnd);
            sb.removeEventListener('error', onError);
            sb.removeEventListener('abort', onAbort);
          }
          function finish(err) {
            if (settled) return;
            settled = true;
            cleanup();
            if (err) {
              reject(err);
              return;
            }
            try {
              if (options.guard) options.guard();
              resolve();
            } catch (guardError) {
              reject(guardError);
            }
          }
          function onEnd() { finish(); }
          function onError() { finish(new Error(options.errorMessage || 'sourcebuffer-error')); }
          function onAbort() { finish(abortError()); }
          sb.addEventListener('updateend', onEnd);
          sb.addEventListener('error', onError);
          sb.addEventListener('abort', onAbort);
          try {
            if (mutation() === false) {
              finish();
              return;
            }
            timeoutId = setTimeout(function () {
              if (settled) return;
              if (!sb.updating) {
                sb._nativeMutationMissedUpdateEndCount = (sb._nativeMutationMissedUpdateEndCount || 0) + 1;
                finish();
                return;
              }
              sb._nativeMutationTimeoutCount = (sb._nativeMutationTimeoutCount || 0) + 1;
              var timeoutError = new Error(options.timeoutMessage || 'sourcebuffer-timeout');
              cleanup();
              if (sb.abort) {
                try {
                  sb.abort();
                  sb._nativeMutationAbortCount = (sb._nativeMutationAbortCount || 0) + 1;
                } catch (e) {}
              }
              finish(timeoutError);
            }, options.timeoutMs || SOURCEBUFFER_WATCHDOG_MS);
          } catch (err) {
            finish(err);
          }
        });
      });
    });
  }

  function appendBuffer(sb, data, appendWindow, timestampOffset, guard) {
    return mutateSourceBuffer(sb, function () {
      if (appendWindow) {
        if (appendWindow.end > sb.appendWindowStart) sb.appendWindowEnd = appendWindow.end;
        sb.appendWindowStart = appendWindow.start;
        sb.appendWindowEnd = appendWindow.end;
      }
      if (isFinite(timestampOffset) && Math.abs((sb.timestampOffset || 0) - timestampOffset) > 0.001) {
        sb.timestampOffset = timestampOffset;
      }
      sb.appendBuffer(data);
    }, {
      guard: guard,
      errorMessage: 'sourcebuffer-error',
      timeoutMessage: 'sourcebuffer-timeout'
    });
  }

  function sourceBufferIdentityGuard(provider, field, sourceBuffer) {
    return function () {
      if (!provider || provider.destroyed || provider[field] !== sourceBuffer) throw abortError();
    };
  }

  function resetSourceBuffer(sb, currentTime, guard) {
    if (!sb || !sb.buffered || !sb.buffered.length) return Promise.resolve(null);
    var removedRange = null;
    return mutateSourceBuffer(sb, function () {
      if (!sb.buffered.length) return false;
      var end = Math.min(Math.max(0, currentTime + 1), sb.buffered.end(sb.buffered.length - 1));
      if (!isFinite(end) || end <= 0) return false;
      removedRange = { start: 0, end: end };
      sb.remove(0, end);
    }, {
      guard: guard,
      errorMessage: 'sourcebuffer-reset-failed',
      timeoutMessage: 'sourcebuffer-reset-timeout'
    }).then(function () { return removedRange; });
  }

  function clearSourceBuffer(sb) {
    if (!sb || !sb.buffered || !sb.buffered.length) return Promise.resolve(null);
    var removedRange = null;
    return mutateSourceBuffer(sb, function () {
      if (!sb.buffered.length) return false;
      var start = sb.buffered.start(0);
      var end = sb.buffered.end(sb.buffered.length - 1);
      if (!isFinite(start) || !isFinite(end) || end <= start) return false;
      removedRange = { start: start, end: end };
      sb.remove(start, end);
    }, {
      errorMessage: 'sourcebuffer-clear-failed',
      timeoutMessage: 'sourcebuffer-clear-timeout'
    }).then(function () { return removedRange; });
  }

  function trimBuffer(sb, removeEnd) {
    removeBufferBefore(sb, removeEnd).catch(function () {});
  }

  function removeBufferBefore(sb, removeEnd, guard) {
    if (!sb || !sb.buffered || !sb.buffered.length || removeEnd <= 0) return Promise.resolve(null);
    var removedRange = null;
    return mutateSourceBuffer(sb, function () {
      if (!sb.buffered.length || sb.buffered.start(0) >= removeEnd) return false;
      var end = Math.min(removeEnd, sb.buffered.end(0));
      if (!isFinite(end) || end <= sb.buffered.start(0)) return false;
      removedRange = { start: sb.buffered.start(0), end: end };
      sb.remove(removedRange.start, end);
    }, {
      guard: guard,
      errorMessage: 'sourcebuffer-remove-failed',
      timeoutMessage: 'sourcebuffer-remove-timeout'
    }).then(function () { return removedRange; });
  }

  function removeBufferAfter(sb, removeStart, guard) {
    if (!sb || !sb.buffered || !sb.buffered.length || !isFinite(removeStart)) return Promise.resolve(null);
    var removedRange = null;
    return mutateSourceBuffer(sb, function () {
      if (!sb.buffered.length) return false;
      var lastEnd = sb.buffered.end(sb.buffered.length - 1);
      if (!isFinite(lastEnd) || lastEnd <= removeStart) return false;
      removedRange = { start: removeStart, end: lastEnd };
      sb.remove(removeStart, lastEnd);
    }, {
      guard: guard,
      errorMessage: 'sourcebuffer-remove-failed',
      timeoutMessage: 'sourcebuffer-remove-timeout'
    }).then(function () { return removedRange; });
  }

  function removeBufferRange(sb, removeStart, removeEnd, guard) {
    if (
      !sb
      || !sb.buffered
      || !sb.buffered.length
      || !isFinite(removeStart)
      || !isFinite(removeEnd)
      || removeEnd <= removeStart
    ) return Promise.resolve(null);
    var removedRange = null;
    return mutateSourceBuffer(sb, function () {
      if (!sb.buffered.length) return false;
      var firstStart = sb.buffered.start(0);
      var lastEnd = sb.buffered.end(sb.buffered.length - 1);
      var start = Math.max(removeStart, firstStart);
      var end = Math.min(removeEnd, lastEnd);
      if (!isFinite(start) || !isFinite(end) || end <= start) return false;
      removedRange = { start: start, end: end };
      sb.remove(start, end);
    }, {
      guard: guard,
      errorMessage: 'sourcebuffer-remove-failed',
      timeoutMessage: 'sourcebuffer-remove-timeout'
    }).then(function () { return removedRange; });
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

  function providerSourceBuffers(provider) {
    if (!provider) return [];
    return [provider.sb, provider.videoSb, provider.audioSb].filter(function (sb, index, list) {
      return !!sb && list.indexOf(sb) === index;
    });
  }

  function sourceBufferMutationStat(provider, field) {
    return providerSourceBuffers(provider).reduce(function (total, sourceBuffer) {
      return total + (sourceBuffer[field] || 0);
    }, 0);
  }

  function sourceBufferHighestEnd(sb) {
    if (!sb || !sb.buffered || !sb.buffered.length) return 0;
    var end = 0;
    for (var i = 0; i < sb.buffered.length; i++) end = Math.max(end, sb.buffered.end(i));
    return end;
  }

  function synchronizeMediaSourceDuration(provider) {
    if (!provider || provider.destroyed || !provider.mediaSource) return;
    var sourceBuffers = providerSourceBuffers(provider);
    Promise.all(sourceBuffers.map(waitForVodSourceBufferQueue)).then(function () {
      if (!provider || provider.destroyed || !provider.mediaSource || provider.mediaSource.readyState !== 'open') return;
      var duration = provider.live ? Infinity : Number(provider.duration);
      if (!provider.live) {
        if (!isFinite(duration) || duration <= 0) return;
        for (var i = 0; i < sourceBuffers.length; i++) duration = Math.max(duration, sourceBufferHighestEnd(sourceBuffers[i]));
      }
      try {
        if (provider.mediaSource.duration !== duration) provider.mediaSource.duration = duration;
      } catch (e) {}
    });
  }

  function applyProviderPresentationState(provider, live, duration) {
    if (!provider) return;
    var wasLive = provider.live === true;
    provider.live = !!live;
    if (isFinite(Number(duration)) && Number(duration) > 0) provider.duration = Number(duration);
    if (provider.engine && provider.engine.setLive) provider.engine.setLive(provider.live);
    if (wasLive && !provider.live) {
      provider.liveToVodTransitionCount = (provider.liveToVodTransitionCount || 0) + 1;
      if (provider.manifestRefreshTimer) {
        clearTimeout(provider.manifestRefreshTimer);
        provider.manifestRefreshTimer = 0;
      }
    }
    synchronizeMediaSourceDuration(provider);
  }

  function playableSegmentEnd(segments) {
    var end = 0;
    for (var i = 0; segments && i < segments.length; i++) {
      if (!segments[i].gap) end = Math.max(end, segments[i].end || 0);
    }
    return end;
  }

  function allSegmentsDeclaredGap(segments) {
    return !!(segments && segments.length && segments.every(function (segment) { return !!segment.gap; }));
  }

  function assertHlsTrackTransitionCurrent(provider, generation) {
    if (
      !provider
      || provider.destroyed
      || generation !== (provider.trackTransitionGeneration || 0)
      || !provider.mediaSource
      || provider.mediaSource.readyState !== 'open'
    ) throw abortError();
  }

  function captureHlsTrackSourceBufferState(provider, kind) {
    var isAudio = kind === 'audio';
    var sourceBuffer = isAudio ? provider.audioSb : provider.sb;
    return {
      exists: !!sourceBuffer,
      sourceBuffer: sourceBuffer || null,
      mime: (isAudio ? provider.audioSourceBufferMime : provider.videoSourceBufferMime) || '',
      initKey: (isAudio ? provider._appendedAudioInitKey : provider._appendedVideoInitKey) || '',
      initGenerationKey: (isAudio ? provider._appendedAudioInitGenerationKey : provider._appendedVideoInitGenerationKey) || '',
      initSegment: (isAudio ? provider._sourceBufferAudioInitSegment : provider._sourceBufferVideoInitSegment)
        || (isAudio ? provider.audioInitSegment : provider.initSegment)
        || null
    };
  }

  function snapshotOwnProperties(target) {
    var properties = {};
    if (!target) return properties;
    for (var key in target) {
      if (Object.prototype.hasOwnProperty.call(target, key)) properties[key] = target[key];
    }
    return properties;
  }

  function restoreOwnProperties(target, properties) {
    if (!target) return;
    for (var key in target) {
      if (Object.prototype.hasOwnProperty.call(target, key) && !Object.prototype.hasOwnProperty.call(properties, key)) delete target[key];
    }
    for (var name in properties) {
      if (Object.prototype.hasOwnProperty.call(properties, name)) target[name] = properties[name];
    }
  }

  function snapshotHlsObjects(objects) {
    return (objects || []).map(function (target) {
      return { target: target, properties: snapshotOwnProperties(target) };
    });
  }

  function hlsSegmentObjects(segments) {
    var objects = [];
    for (var i = 0; segments && i < segments.length; i++) {
      objects.push(segments[i]);
      var parts = segments[i].parts || [];
      for (var p = 0; p < parts.length; p++) objects.push(parts[p]);
    }
    return objects;
  }

  function hlsPreloadHintObjects(provider) {
    var objects = [];
    function collect(track) {
      var hints = track && track._preloadHintSegments ? track._preloadHintSegments : {};
      for (var key in hints) {
        if (Object.prototype.hasOwnProperty.call(hints, key) && objects.indexOf(hints[key]) === -1) objects.push(hints[key]);
      }
    }
    collect(provider);
    for (var i = 0; provider && provider.audioRenditions && i < provider.audioRenditions.length; i++) collect(provider.audioRenditions[i]);
    return objects;
  }

  function restoreHlsObjects(snapshots) {
    for (var i = 0; snapshots && i < snapshots.length; i++) {
      restoreOwnProperties(snapshots[i].target, snapshots[i].properties);
    }
  }

  function captureHlsTrackTransitionState(provider) {
    var fields = [
      'activeVariant', 'activeAudio', 'manualTrackId', 'lastSwitchAt', 'lastSwitchReason',
      'segments', 'initSegment', 'audioSegments', 'audioInitSegment',
      'isTsPlaylist', 'muxedTsAudio', 'lowLatencyPlaylist', 'partialSegmentCount',
      'partialSegmentGapCount', 'partTargetDuration', 'preloadHints', 'serverControl',
      'preloadHintCount', 'renditionReportCount', 'skippedSegmentCount',
      'manifestCompatibilityWarnings', 'videoDuration', 'videoEndList', 'audioEndList',
      'live', 'duration', 'manifestStartTime', 'mediaSequence', 'discontinuitySequence',
      'discontinuityCount', 'targetDuration', 'mediaPlaylistUrl', 'liveWindow', 'mimeType',
      'audioMimeType', 'suppressedVideoGapTrack', 'suppressedAudioGapTrack',
      'suppressedGapTrackCount', '_preloadHintSegments'
    ];
    var values = {};
    for (var i = 0; i < fields.length; i++) values[fields[i]] = provider[fields[i]];
    return {
      fields: values,
      abrEnabled: !!(provider.engine && provider.engine._player && provider.engine._player.config.abr.enabled),
      variants: snapshotHlsObjects(provider.variants),
      audioRenditions: snapshotHlsObjects(provider.audioRenditions),
      videoSegmentObjects: snapshotHlsObjects(hlsSegmentObjects(provider.segments)),
      audioSegmentObjects: snapshotHlsObjects(hlsSegmentObjects(provider.activeAudio && provider.activeAudio.segments)),
      preloadHintObjects: snapshotHlsObjects(hlsPreloadHintObjects(provider)),
      playlistCursorByUrl: clonePlain(provider.playlistCursorByUrl || {}),
      playlistResetCandidateByUrl: clonePlain(provider.playlistResetCandidateByUrl || {}),
      playlistEpochByUrl: clonePlain(provider.playlistEpochByUrl || {}),
      hlsTimestampGenerationByKey: clonePlain(provider.hlsTimestampGenerationByKey || {}),
      videoSourceBuffer: captureHlsTrackSourceBufferState(provider, 'video'),
      audioSourceBuffer: captureHlsTrackSourceBufferState(provider, 'audio')
    };
  }

  function restoreHlsTrackTransitionState(provider, snapshot) {
    if (!provider || !snapshot) return;
    for (var key in snapshot.fields) {
      if (Object.prototype.hasOwnProperty.call(snapshot.fields, key)) provider[key] = snapshot.fields[key];
    }
    restoreHlsObjects(snapshot.variants);
    restoreHlsObjects(snapshot.audioRenditions);
    restoreHlsObjects(snapshot.videoSegmentObjects);
    restoreHlsObjects(snapshot.audioSegmentObjects);
    restoreHlsObjects(snapshot.preloadHintObjects);
    provider.playlistCursorByUrl = clonePlain(snapshot.playlistCursorByUrl || {});
    provider.playlistResetCandidateByUrl = clonePlain(snapshot.playlistResetCandidateByUrl || {});
    provider.playlistEpochByUrl = clonePlain(snapshot.playlistEpochByUrl || {});
    provider.hlsTimestampGenerationByKey = clonePlain(snapshot.hlsTimestampGenerationByKey || {});
    if (provider.engine && provider.engine._player) provider.engine._player.config.abr.enabled = snapshot.abrEnabled;
  }

  function removeHlsGapSourceBuffer(provider, kind, generation) {
    if (!provider || !provider.mediaSource) return Promise.resolve();
    var field = kind === 'audio' ? 'audioSb' : 'sb';
    var sourceBuffer = provider[field];
    if (!sourceBuffer) return Promise.resolve();
    return waitForVodSourceBufferQueue(sourceBuffer).then(function () {
      assertHlsTrackTransitionCurrent(provider, generation == null ? (provider.trackTransitionGeneration || 0) : generation);
      try {
        provider.mediaSource.removeSourceBuffer(sourceBuffer);
        provider[field] = null;
      } catch (e) {}
    });
  }

  function sourceBufferCoversPlayableEnd(sb, expectedEnd) {
    if (!isFinite(expectedEnd) || expectedEnd <= 0 || !sb || !sb.buffered) return true;
    for (var i = 0; i < sb.buffered.length; i++) {
      if (sb.buffered.start(i) < expectedEnd && sb.buffered.end(i) >= expectedEnd - 0.25) return true;
    }
    return false;
  }

  function providerPlayableEnd(provider) {
    if (!provider) return 0;
    if (provider.name === 'native-dash' || provider.activeVideo) {
      return Math.max(
        playableSegmentEnd(provider.activeVideo && provider.activeVideo.segments),
        playableSegmentEnd(provider.audio && provider.audio.segments)
      );
    }
    return Math.max(
      playableSegmentEnd(provider.segments),
      playableSegmentEnd(provider.audioSegments)
    );
  }

  function prepareVodStreamRefill(provider) {
    if (
      !provider
      || provider.live
      || !provider.mediaSource
      || provider.mediaSource.readyState !== 'ended'
    ) return false;
    // An all-gap presentation has no media object that could reopen MSE.
    // Let the media element replay its already-finalized empty timeline
    // without entering a refill state that can never complete.
    if (providerPlayableEnd(provider) <= 0) {
      clearVodEndOfStreamState(provider);
      return false;
    }
    if (provider.vodEndOfStreamRefillPending) return true;
    clearVodEndOfStreamState(provider);
    provider.vodEndOfStreamRefillPending = true;
    provider.vodEndOfStreamReopenCount = (provider.vodEndOfStreamReopenCount || 0) + 1;
    provider.vodFinalDuration = 0;
    return true;
  }

  function endedVodSchedulerIsIdle(provider) {
    return !!(
      provider
      && provider.mediaSource
      && provider.mediaSource.readyState === 'ended'
      && !provider.vodEndOfStreamRefillPending
    );
  }

  function vodSourceBufferBusy(sb) {
    return !!(sb && (sb.updating || appendQueueDepth(sb) > 0));
  }

  function waitForVodSourceBufferQueue(sb) {
    if (!sb) return Promise.resolve();
    return Promise.resolve(sb._nativeQueue).catch(function () {}).then(function () {
      return sb.updating ? waitForSourceBufferIdle(sb) : undefined;
    });
  }

  function scheduleVodEndOfStream(provider, sourceBuffers, delayMs) {
    if (
      !provider
      || provider.destroyed
      || !provider.vodEndOfStreamPending
      || provider._vodEndOfStreamScheduled
    ) return;
    provider._vodEndOfStreamScheduled = true;
    Promise.all((sourceBuffers || []).filter(Boolean).map(waitForVodSourceBufferQueue)).then(function () {
      if (provider.destroyed || !provider.vodEndOfStreamPending) {
        provider._vodEndOfStreamScheduled = false;
        return;
      }
      function retry() {
        provider._vodEndOfStreamRetryTimer = 0;
        provider._vodEndOfStreamScheduled = false;
        if (!provider.destroyed && provider.vodEndOfStreamPending && provider._maybeEndVodStream) {
          provider._maybeEndVodStream();
        }
      }
      if (delayMs > 0) {
        provider._vodEndOfStreamRetryTimer = setTimeout(retry, delayMs);
      } else {
        retry();
      }
    });
  }

  function finalizeVodEndOfStream(provider, sourceBuffers) {
    if (!provider || provider.destroyed || !provider.mediaSource) return false;
    if (provider.mediaSource.readyState === 'ended') {
      provider.vodEndOfStreamPending = false;
      provider._vodEndOfStreamRetryAttempt = 0;
      return false;
    }
    if (provider.mediaSource.readyState !== 'open') return false;
    sourceBuffers = (sourceBuffers || []).filter(Boolean);
    if (sourceBuffers.some(vodSourceBufferBusy)) {
      scheduleVodEndOfStream(provider, sourceBuffers, 0);
      return false;
    }
    try {
      provider.mediaSource.endOfStream();
      provider.vodEndOfStreamPending = false;
      provider._vodEndOfStreamRetryAttempt = 0;
      if (provider._vodEndOfStreamRetryTimer) clearTimeout(provider._vodEndOfStreamRetryTimer);
      provider._vodEndOfStreamRetryTimer = 0;
      provider.vodEndOfStreamCount = (provider.vodEndOfStreamCount || 0) + 1;
      provider.vodEndOfStreamRefillPending = false;
      provider.vodFinalDuration = providerPlayableEnd(provider);
      return true;
    } catch (e) {
      provider.vodEndOfStreamRetryCount = (provider.vodEndOfStreamRetryCount || 0) + 1;
      provider._vodEndOfStreamRetryAttempt = (provider._vodEndOfStreamRetryAttempt || 0) + 1;
      scheduleVodEndOfStream(
        provider,
        sourceBuffers,
        Math.min(1000, 50 * Math.pow(2, Math.min(4, provider._vodEndOfStreamRetryAttempt - 1)))
      );
      return false;
    }
  }

  function clearVodEndOfStreamState(provider) {
    if (!provider) return;
    provider.vodEndOfStreamPending = false;
    provider.vodEndOfStreamRefillPending = false;
    provider._vodEndOfStreamScheduled = false;
    provider._vodEndOfStreamRetryAttempt = 0;
    if (provider._vodEndOfStreamRetryTimer) clearTimeout(provider._vodEndOfStreamRetryTimer);
    provider._vodEndOfStreamRetryTimer = 0;
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

  function pendingLoadStartTime(provider) {
    if (!provider || !provider.engine) return null;
    var pending = provider.engine._pendingLoadStartTime;
    if (pending == null) return null;
    var target = Number(pending);
    if (!isFinite(target) || target < 0) return null;
    var range = provider.seekRange ? provider.seekRange() : null;
    if (range && isFinite(range.start) && isFinite(range.end) && range.end >= range.start) {
      target = clamp(target, range.start, range.end);
    }
    return target;
  }

  function assignInternalMediaTime(provider, target) {
    if (!provider || !provider.video || !isFinite(Number(target))) return false;
    var normalizedTarget = Number(target);
    provider._internalMediaSeekTarget = normalizedTarget;
    provider._internalMediaSeekExpiresAt = performance.now() + 2000;
    try {
      provider.video.currentTime = normalizedTarget;
      return true;
    } catch (e) {
      provider._internalMediaSeekTarget = null;
      provider._internalMediaSeekExpiresAt = 0;
      return false;
    }
  }

  function isInternalMediaSeek(provider) {
    if (!provider || provider._internalMediaSeekTarget == null || !isFinite(provider._internalMediaSeekTarget)) return false;
    if (performance.now() > (provider._internalMediaSeekExpiresAt || 0)) {
      provider._internalMediaSeekTarget = null;
      provider._internalMediaSeekExpiresAt = 0;
      return false;
    }
    return Math.abs((provider.video.currentTime || 0) - provider._internalMediaSeekTarget) <= 0.5;
  }

  function applyPendingLoadStartTime(provider) {
    var target = pendingLoadStartTime(provider);
    if (target == null || !provider.video) return Promise.resolve();
    var video = provider.video;
    return new Promise(function (resolve) {
      var settled = false;
      var timeout = 0;
      var retryTimer = 0;
      provider._applyingInitialStart = true;
      function cleanup() {
        video.removeEventListener('loadedmetadata', attempt);
        video.removeEventListener('durationchange', attempt);
        video.removeEventListener('loadeddata', attempt);
        video.removeEventListener('progress', attempt);
        if (timeout) clearTimeout(timeout);
        if (retryTimer) clearInterval(retryTimer);
        provider._applyingInitialStart = false;
      }
      function finish() {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      }
      function attempt() {
        if (settled || provider.destroyed) return finish();
        try { video.currentTime = target; } catch (e) {}
        if (Math.abs((video.currentTime || 0) - target) <= 0.05) finish();
      }
      video.addEventListener('loadedmetadata', attempt);
      video.addEventListener('durationchange', attempt);
      video.addEventListener('loadeddata', attempt);
      video.addEventListener('progress', attempt);
      attempt();
      if (!settled) {
        retryTimer = setInterval(attempt, 25);
        timeout = setTimeout(function () {
          attempt();
          finish();
        }, 2000);
      }
    });
  }

  function startupBufferRequirement(provider, goal) {
    var bufferGoal = provider && provider._bufferAheadGoal ? provider._bufferAheadGoal() : goal;
    var required = Math.max(0, Math.min(Number(goal) || 0, Number(bufferGoal) || 0));
    if (!provider || provider.live) return required;
    var duration = 0;
    var durationCandidates = [
      provider.vodFinalDuration,
      provider.videoDuration,
      provider.duration,
      provider.video && provider.video.duration
    ];
    for (var i = 0; i < durationCandidates.length; i++) {
      var candidate = Number(durationCandidates[i]);
      if (isFinite(candidate) && candidate > 0) {
        duration = candidate;
        break;
      }
    }
    if (!duration) return required;
    var target = provider.seekBufferPending
      ? Number(provider.lastSeekTarget)
      : Number(provider.video && provider.video.currentTime);
    if (!isFinite(target)) target = 0;
    return Math.max(0, Math.min(required, Math.max(0, duration - target)));
  }

  function markStartupBufferReady(provider) {
    if (!provider || provider.destroyed || provider.startupBufferComplete) return false;
    provider.startupBufferComplete = true;
    provider.startupBufferMs = provider.startupBufferStartedAt
      ? performance.now() - provider.startupBufferStartedAt
      : 0;
    if (provider.engine && provider.engine._telemetry) {
      provider.engine._telemetry.record('startup-buffer-ready', { startupBufferMs: provider.startupBufferMs });
    }
    if (provider.engine && provider.engine._markStartupReady) {
      return provider.engine._markStartupReady(provider, provider.loadGeneration);
    }
    if (provider.engine && provider.engine._setState) provider.engine._setState('ready');
    return true;
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

  function seekOperationMatches(provider, target) {
    if (!provider || !(provider.activeSeekGeneration > 0)) return false;
    if (!provider.seekBufferPending && !provider.seekInteractionPending) return false;
    return Math.abs((Number(provider.lastSeekTarget) || 0) - target) <= 0.05;
  }

  function beginSeekOperation(provider, target) {
    target = Number(target);
    if (!isFinite(target)) target = provider && provider.video ? Number(provider.video.currentTime) || 0 : 0;
    if (!seekOperationMatches(provider, target)) {
      provider.seekGeneration = (provider.seekGeneration || 0) + 1;
      provider.activeSeekGeneration = provider.seekGeneration;
      provider.seekBufferPending = true;
      provider.seekInteractionPending = true;
      provider.lastSeekStartedAt = performance.now();
    } else {
      provider.seekInteractionPending = true;
      if (!provider.lastSeekStartedAt) provider.lastSeekStartedAt = performance.now();
    }
    provider.lastSeekTarget = target;
    if (provider.engine && provider.engine._setState) provider.engine._setState('seeking');
    return { target: target, generation: provider.activeSeekGeneration };
  }

  function activeSeekGeneration(provider) {
    if (provider.activeSeekGeneration > 0) return provider.activeSeekGeneration;
    provider.seekGeneration = (provider.seekGeneration || 0) + 1;
    provider.activeSeekGeneration = provider.seekGeneration;
    return provider.activeSeekGeneration;
  }

  function finalizeSeekOperation(provider, generation) {
    if (!provider || generation !== provider.activeSeekGeneration) return false;
    if (provider.seekBufferPending || provider.seekInteractionPending) return false;
    provider.completedSeekGeneration = generation;
    if (
      !provider.destroyed
      && provider.engine
      && provider.engine._setState
      && !provider.engine._serverDown
      && provider.engine._state !== 'error'
      && provider.engine._state !== 'destroyed'
    ) {
      provider.engine._setState('ready');
    }
    return true;
  }

  function completeSeekBuffer(provider, generation, buffered) {
    if (!provider) return false;
    generation = generation || activeSeekGeneration(provider);
    if (
      provider.destroyed
      || generation !== provider.activeSeekGeneration
      || !provider.seekBufferPending
    ) return false;
    provider.seekBufferPending = false;
    provider.seekBufferReadyCount = (provider.seekBufferReadyCount || 0) + 1;
    if (buffered) provider.bufferedSeekCount = (provider.bufferedSeekCount || 0) + 1;
    if (provider.engine && provider.engine._telemetry) {
      provider.engine._telemetry.record('seek-buffer-ready', buffered ? { buffered: true } : undefined);
    }
    finalizeSeekOperation(provider, generation);
    return true;
  }

  function finishSeekInteraction(provider, generation) {
    if (!provider) return false;
    generation = generation || provider.activeSeekGeneration;
    if (!(generation > 0) || generation !== provider.activeSeekGeneration) return false;
    if (provider.lastSeekStartedAt) provider.lastSeekMs = performance.now() - provider.lastSeekStartedAt;
    provider.lastSeekStartedAt = 0;
    provider.seekInteractionPending = false;
    finalizeSeekOperation(provider, generation);
    return true;
  }

  function invalidateSeekOperation(provider) {
    if (!provider) return 0;
    provider.seekGeneration = (provider.seekGeneration || 0) + 1;
    provider.activeSeekGeneration = 0;
    provider.seekBufferPending = false;
    provider.seekInteractionPending = false;
    provider.lastSeekStartedAt = 0;
    return provider.seekGeneration;
  }

  function cancelSeekOperation(provider) {
    invalidateSeekOperation(provider);
    if (
      !provider.destroyed
      && provider.engine
      && provider.engine._setState
      && !provider.engine._serverDown
      && provider.engine._state !== 'error'
      && provider.engine._state !== 'destroyed'
    ) {
      provider.engine._setState('ready');
    }
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

  function getBufferAheadAt(video, currentTime, startTolerance) {
    if (!video || !video.buffered) return 0;
    var buf = video.buffered;
    var ct = Number(currentTime) || 0;
    var tolerance = startTolerance == null ? 0.5 : Math.max(0, Number(startTolerance) || 0);
    for (var i = 0; i < buf.length; i++) {
      if (ct >= buf.start(i) - tolerance && ct <= buf.end(i)) return Math.max(0, buf.end(i) - ct);
    }
    return 0;
  }

  function getBufferAhead(video) {
    return getBufferAheadAt(video, video ? video.currentTime : 0, 0.5);
  }

  function updateEwma(provider, accumulatorKey, weightKey, sample, weight, halfLife) {
    var alpha = Math.exp(Math.log(0.5) / halfLife);
    var adjustedAlpha = Math.pow(alpha, Math.max(0.001, weight));
    provider[accumulatorKey] = sample * (1 - adjustedAlpha)
      + adjustedAlpha * (provider[accumulatorKey] || 0);
    provider[weightKey] = (provider[weightKey] || 0) + Math.max(0.001, weight);
    var zeroFactor = 1 - Math.pow(alpha, provider[weightKey]);
    return zeroFactor > 0 ? provider[accumulatorKey] / zeroFactor : sample;
  }

  function updateTimeToFirstByteEstimate(provider, timeToFirstByteMs) {
    if (!isFinite(timeToFirstByteMs) || timeToFirstByteMs < 0) {
      return provider.bandwidthTtfbEstimate || DEFAULT_TIME_TO_FIRST_BYTE_MS;
    }
    var seconds = timeToFirstByteMs / 1000;
    var weight = Math.sqrt(2) * Math.exp(-(seconds * seconds) / 2);
    provider.bandwidthTtfbEstimate = updateEwma(
      provider,
      'bandwidthTtfbAccumulator',
      'bandwidthTtfbWeight',
      Math.max(5, timeToFirstByteMs),
      weight,
      BANDWIDTH_SLOW_HALF_LIFE
    );
    return provider.bandwidthTtfbEstimate;
  }

  function bandwidthSampleDuration(provider, elapsedMs, timeToFirstByteMs) {
    var elapsed = Math.max(1, Number(elapsedMs) || 0);
    if (!isFinite(timeToFirstByteMs) || timeToFirstByteMs < 0) return elapsed;
    var estimate = updateTimeToFirstByteEstimate(provider, timeToFirstByteMs);
    return Math.max(
      MIN_BANDWIDTH_SAMPLE_MS,
      elapsed - Math.min(timeToFirstByteMs, estimate)
    );
  }

  // Samples are weighted by transfer duration. This prevents a tiny LL-HLS
  // part from having the same influence as a multi-second media fragment.
  function updateBandwidthEstimate(provider, sample, sampleDurationMs) {
    var weight = Math.max(MIN_BANDWIDTH_SAMPLE_MS, sampleDurationMs || 0) / 1000;
    provider.bandwidthFast = updateEwma(
      provider,
      'bandwidthFastAccumulator',
      'bandwidthFastWeight',
      sample,
      weight,
      BANDWIDTH_FAST_HALF_LIFE
    );
    provider.bandwidthSlow = updateEwma(
      provider,
      'bandwidthSlowAccumulator',
      'bandwidthSlowWeight',
      sample,
      weight,
      BANDWIDTH_SLOW_HALF_LIFE
    );
    provider.bandwidth = Math.min(provider.bandwidthFast, provider.bandwidthSlow);
  }

  function abrSegmentDuration(provider) {
    var segments = provider && provider.activeVideo && provider.activeVideo.segments
      ? provider.activeVideo.segments
      : (provider && provider.segments ? provider.segments : []);
    var currentTime = provider && provider.video ? Number(provider.video.currentTime) || 0 : 0;
    for (var i = 0; i < segments.length; i++) {
      var segment = segments[i];
      if (segment.end > currentTime - 0.05) {
        var duration = Number(segment.duration) || (Number(segment.end) - Number(segment.start));
        if (isFinite(duration) && duration > 0) return duration;
      }
    }
    return 4;
  }

  function abrUpgradeIsSafe(provider, candidate, bufferAhead) {
    if (!provider || !candidate || !provider.bandwidthSamples || bufferAhead <= 0.05) return false;
    var estimate = effectiveBandwidthEstimate(provider);
    var bitrate = Number(candidate.bandwidth) || 0;
    if (!isFinite(estimate) || estimate <= 0 || bitrate <= 0) return false;
    var duration = abrSegmentDuration(provider);
    var timeToFirstByte = (provider.bandwidthTtfbEstimate || DEFAULT_TIME_TO_FIRST_BYTE_MS) / 1000;
    var predictedFetchSeconds = timeToFirstByte + bitrate * duration / estimate;
    // Upgrade only when the next higher-quality fragment is expected to arrive
    // before the already-buffered media is exhausted.
    return predictedFetchSeconds <= bufferAhead + 0.05;
  }

  function sampleFramePressure(provider, now) {
    var abr = provider && provider.engine && provider.engine._player
      ? provider.engine._player.config.abr || {}
      : {};
    if (abr.capLevelOnFPSDrop === false || !provider.video || !provider.video.getVideoPlaybackQuality) return false;
    now = isFinite(now) ? now : performance.now();
    var quality;
    try { quality = provider.video.getVideoPlaybackQuality(); } catch (e) { return false; }
    if (!quality) return false;
    var dropped = Number(quality.droppedVideoFrames) || 0;
    var total = Number(quality.totalVideoFrames) || 0;
    if (!provider.lastFrameSampleAt) {
      provider.lastFrameSampleAt = now;
      provider.lastDroppedFrames = dropped;
      provider.lastTotalFrames = total;
      return false;
    }
    if (now - provider.lastFrameSampleAt < FRAME_SAMPLE_INTERVAL_MS) return false;
    var droppedDelta = Math.max(0, dropped - (provider.lastDroppedFrames || 0));
    var totalDelta = Math.max(0, total - (provider.lastTotalFrames || 0));
    provider.lastFrameSampleAt = now;
    provider.lastDroppedFrames = dropped;
    provider.lastTotalFrames = total;
    provider.lastFrameDropRatio = totalDelta ? droppedDelta / totalDelta : 0;
    return totalDelta >= 24
      && droppedDelta >= FRAME_DROP_MIN_COUNT
      && provider.lastFrameDropRatio >= FRAME_DROP_RATIO_THRESHOLD;
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

  function bufferedRangeStartAtOrAfter(video, time) {
    if (!video || !video.buffered) return null;
    for (var i = 0; i < video.buffered.length; i++) {
      var start = video.buffered.start(i);
      var end = video.buffered.end(i);
      if (end < time - 0.05) continue;
      if (start <= time + 0.1) return Math.max(start, time);
      return start;
    }
    return null;
  }

  function hlsDeclaredTrackGapAtPlayhead(segments, currentTime) {
    if (!segments || !segments.length) return null;
    var gapStart = 0;
    var gapEnd = 0;
    for (var i = 0; i < segments.length; i++) {
      var seg = segments[i];
      if (!seg.gap || currentTime < seg.start - 0.15 || currentTime >= seg.end) continue;
      gapStart = seg.start;
      gapEnd = seg.end;
      for (var j = i + 1; j < segments.length; j++) {
        if (!segments[j].gap || segments[j].start > gapEnd + 0.05) break;
        gapEnd = Math.max(gapEnd, segments[j].end);
      }
      break;
    }
    if (gapEnd <= gapStart) return null;
    return { start: gapStart, end: gapEnd };
  }

  function hlsDeclaredGapAtPlayhead(provider) {
    var currentTime = provider && provider.video ? (provider.video.currentTime || 0) : 0;
    if (!provider) return null;
    var tracks = [];
    if (!provider.suppressedVideoGapTrack && provider.segments && provider.segments.length) {
      tracks.push({ kind: 'video', segments: provider.segments, buffered: provider.sb ? provider.sb.buffered : provider.video.buffered });
    }
    if (provider.activeAudio && provider.audioSb) {
      tracks.push({ kind: 'audio', segments: provider.audioSegments, buffered: provider.audioSb.buffered });
    }
    var declared = [];
    for (var i = 0; i < tracks.length; i++) {
      var gap = hlsDeclaredTrackGapAtPlayhead(tracks[i].segments, currentTime);
      if (gap) declared.push({ kind: tracks[i].kind, start: gap.start, end: gap.end });
    }
    if (!declared.length) return null;
    var gapStart = declared[0].start;
    var gapEnd = declared[0].end;
    for (var j = 1; j < declared.length; j++) {
      gapStart = Math.min(gapStart, declared[j].start);
      gapEnd = Math.max(gapEnd, declared[j].end);
    }
    var bufferedStart = bufferedRangeStartAtOrAfter(provider.video, gapEnd);
    if (bufferedStart == null || bufferedStart > gapEnd + 0.25) return null;
    for (var k = 0; k < tracks.length; k++) {
      var trackStart = bufferedRangeStartAtOrAfter({ buffered: tracks[k].buffered }, bufferedStart);
      if (trackStart == null || trackStart > bufferedStart + 0.25) return null;
    }
    return {
      target: bufferedStart + 0.01,
      size: gapEnd - gapStart,
      track: declared.map(function (item) { return item.kind; }).join('+')
    };
  }

  function bufferedGapAtPlayhead(video) {
    if (!video || !video.buffered || video.buffered.length < 2) return null;
    var currentTime = video.currentTime || 0;
    for (var i = 0; i < video.buffered.length - 1; i++) {
      var end = video.buffered.end(i);
      var nextStart = video.buffered.start(i + 1);
      if (currentTime >= video.buffered.start(i) - 0.05 && currentTime >= end - 0.15 && currentTime < nextStart) {
        return { start: end, end: nextStart };
      }
    }
    return null;
  }

  function representationDeclaresTimelineGap(rep, gap) {
    var segments = rep && (rep.segments || rep.templateSegments);
    if (!segments || !segments.length || !gap) return false;
    var before = false;
    var after = false;
    for (var i = 0; i < segments.length; i++) {
      var seg = segments[i];
      if (seg.end <= gap.start + 0.15) before = true;
      if (seg.start >= gap.end - 0.15) after = true;
      if (seg.start < gap.end - 0.15 && seg.end > gap.start + 0.15) return false;
    }
    return before && after;
  }

  function dashDeclaredGapAtPlayhead(provider) {
    var gap = bufferedGapAtPlayhead(provider && provider.video);
    if (!gap) return null;
    if (!representationDeclaresTimelineGap(provider.activeVideo, gap)) return null;
    if (provider.audio && !representationDeclaresTimelineGap(provider.audio, gap)) return null;
    return { target: gap.end + 0.01, size: gap.end - gap.start };
  }

  function jumpDeclaredManifestGap(provider, type) {
    if (!provider || provider.destroyed || !provider.video || provider.video.seeking) return false;
    var gap = type === 'hls' ? hlsDeclaredGapAtPlayhead(provider) : dashDeclaredGapAtPlayhead(provider);
    if (!gap || gap.size <= 0) return false;
    try {
      assignInternalMediaTime(provider, gap.target);
      provider.manifestGapJumpCount = (provider.manifestGapJumpCount || 0) + 1;
      provider.lastManifestGapSize = gap.size;
      provider.lastManifestGapTrack = gap.track || type;
      provider.lastError = 'manifest-gap-jump';
      if (provider.engine && provider.engine._telemetry) {
        provider.engine._telemetry.record('gap-jump', {
          lastGapSize: gap.size,
          manifestGap: true
        });
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  function markSegmentsUnappended(rep) {
    if (!rep || !rep.segments) return;
    for (var i = 0; i < rep.segments.length; i++) {
      rep.segments[i].appended = false;
      rep.segments[i].state = 'pending';
    }
  }

  function segmentOverlapsRemovedRange(seg, range) {
    if (!seg || !range || !isFinite(range.start) || !isFinite(range.end)) return false;
    return seg.end > range.start + 0.001 && seg.start < range.end - 0.001;
  }

  function invalidateRepresentationSegmentLedger(rep, range, preserveSegment, fullReset) {
    if (!rep) return 0;
    if (fullReset) {
      if (Object.prototype.hasOwnProperty.call(rep, '_appendedInitKey')) rep._appendedInitKey = '';
      if (Object.prototype.hasOwnProperty.call(rep, '_lastAppendInitKey')) rep._lastAppendInitKey = '';
      if (Object.prototype.hasOwnProperty.call(rep, '_lastAppendInitGenerationKey')) rep._lastAppendInitGenerationKey = '';
    }
    if (!rep.segments) return 0;
    var invalidated = 0;
    for (var i = 0; i < rep.segments.length; i++) {
      var seg = rep.segments[i];
      if (seg === preserveSegment || seg.state === 'expired' || seg.gap) continue;
      if (!fullReset && !segmentOverlapsRemovedRange(seg, range)) continue;
      if (seg.appended || seg.state !== 'pending') invalidated++;
      seg.appended = false;
      seg.state = 'pending';
      delete seg._data;
      delete seg._fetchStartedAt;
      delete seg._appendStartedAt;
      delete seg._appendOwner;
      resetHlsPartState(seg);
    }
    return invalidated;
  }

  function uniqueRepresentations(items) {
    var result = [];
    for (var i = 0; i < items.length; i++) {
      if (items[i] && result.indexOf(items[i]) === -1) result.push(items[i]);
    }
    return result;
  }

  function dashRepresentationsForSourceBuffer(provider, kind, primaryRep) {
    var reps = kind === 'audio' ? (provider.audioReps || []) : (provider.videoReps || []);
    return uniqueRepresentations(reps.concat([
      primaryRep || null,
      kind === 'audio' ? provider.audio : provider.activeVideo
    ]));
  }

  function reconcileDashSegmentLedgers(provider, kind, range, primaryRep, preserveSegment, fullReset) {
    if (!provider) return 0;
    var reps = dashRepresentationsForSourceBuffer(provider, kind, primaryRep);
    var invalidated = 0;
    for (var i = 0; i < reps.length; i++) {
      invalidated += invalidateRepresentationSegmentLedger(reps[i], range, preserveSegment, fullReset);
    }
    if (invalidated) {
      provider.dashSegmentLedgerReconcileCount = (provider.dashSegmentLedgerReconcileCount || 0) + 1;
      provider.dashSegmentLedgerInvalidationCount = (provider.dashSegmentLedgerInvalidationCount || 0) + invalidated;
    }
    return invalidated;
  }

  function hlsRepresentationsForSourceBuffer(provider, kind, primaryRep) {
    if (kind !== 'audio') return uniqueRepresentations([provider, primaryRep]);
    return uniqueRepresentations((provider.audioRenditions || []).concat([
      provider.activeAudio,
      provider._muxedAudioTrack,
      primaryRep
    ]));
  }

  function reconcileHlsSegmentLedgers(provider, kind, range, primaryRep, preserveSegment, fullReset) {
    if (!provider) return 0;
    var reps = hlsRepresentationsForSourceBuffer(provider, kind, primaryRep);
    var invalidated = 0;
    for (var i = 0; i < reps.length; i++) {
      invalidated += invalidateRepresentationSegmentLedger(reps[i], range, preserveSegment, fullReset);
    }
    if (invalidated) {
      provider.hlsSegmentLedgerReconcileCount = (provider.hlsSegmentLedgerReconcileCount || 0) + 1;
      provider.hlsSegmentLedgerInvalidationCount = (provider.hlsSegmentLedgerInvalidationCount || 0) + invalidated;
    }
    return invalidated;
  }

  function markSegmentsCoveredByBuffer(rep, video) {
    if (!rep || !rep.segments || !video || !video.buffered) return;
    var buffered = video.buffered;
    for (var i = 0; i < rep.segments.length; i++) {
      var seg = rep.segments[i];
      if (seg.gap) continue;
      for (var rangeIndex = 0; rangeIndex < buffered.length; rangeIndex++) {
        if (
          seg.start >= buffered.start(rangeIndex) - 0.05
          && seg.end <= buffered.end(rangeIndex) + 0.05
        ) {
          seg.appended = true;
          seg.state = 'appended';
          if (seg.parts) {
            for (var partIndex = 0; partIndex < seg.parts.length; partIndex++) {
              seg.parts[partIndex].appended = true;
              seg.parts[partIndex].state = 'appended';
            }
          }
          break;
        }
      }
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

  function prepareSegmentsForRefill(rep, bufferedSource, time, ahead) {
    if (!rep) return;
    markSegmentsUnappended(rep);
    markSegmentsCoveredByBuffer(rep, bufferedSource);
    markSegmentsForTime(rep, time, ahead);
  }

  function isSegmentBusyOrDone(seg) {
    return seg.appended || seg.state === 'fetching' || seg.state === 'fetched' || seg.state === 'appending' || seg.state === 'appended';
  }

  function segmentsAppendedThroughEnd(segments, duration) {
    if (!segments || !segments.length) return false;
    var terminal = null;
    var manifestEnd = 0;
    for (var i = 0; i < segments.length; i++) {
      var seg = segments[i];
      manifestEnd = Math.max(manifestEnd, seg.end || 0);
      if (seg.gap) continue;
      if (seg.end < 0.05) continue;
      if (!terminal || seg.end > terminal.end) terminal = seg;
    }
    // An all-gap rendition has no media bytes left to append. Closing it is
    // preferable to waiting forever for an object the Playlist forbids us to
    // request.
    if (!terminal) return segments.every(function (seg) { return !!seg.gap; });
    if (!terminal.appended && terminal.state !== 'appended') return false;
    // A finite VOD manifest is authoritative about its final segment. Earlier
    // segments may legitimately be absent after a seek or an ABR switch, and
    // requiring them all prevents MediaSource.endOfStream() forever. Keep the
    // duration check only as protection against a genuinely incomplete index.
    var effectiveDuration = duration;
    if (manifestEnd > terminal.end) {
      var trailingEntriesAreGaps = segments.every(function (seg) {
        return seg.end <= terminal.end + 0.001 || !!seg.gap;
      });
      if (trailingEntriesAreGaps && isFinite(effectiveDuration)) {
        effectiveDuration = Math.max(0, effectiveDuration - (manifestEnd - terminal.end));
      }
    }
    return !(isFinite(effectiveDuration) && effectiveDuration > 0 && terminal.end < effectiveDuration - Math.max(1, effectiveDuration * 0.01));
  }

  function segmentPriority(seg, currentTime, readyGoal) {
    if (currentTime >= seg.start - 0.05 && currentTime < seg.end + 0.05) return 0;
    if (seg.start < currentTime + readyGoal) return 1;
    return 2 + Math.max(0, seg.start - currentTime);
  }

  function nextFetchedSegmentForAppend(rep, currentTime) {
    if (!rep || !rep.segments) return null;
    var fetched = rep.segments.filter(function (seg) {
      // EXT-X-PRELOAD-HINT authorizes an early download, not speculative
      // presentation. Keep the bytes parked until a subsequent EXT-X-PART
      // confirms and adopts this object.
      return seg.state === 'fetched'
        && seg._data
        && !seg._hlsPreloadHint
        && seg.end > currentTime - 0.5;
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
    rep._appendOwner = null;
    for (var i = 0; i < rep.segments.length; i++) {
      var seg = rep.segments[i];
      if (seg.state === 'fetching' || seg.state === 'fetched' || seg.state === 'appending') {
        seg.state = 'pending';
        seg.appended = false;
        delete seg._data;
        delete seg._fetchStartedAt;
        delete seg._appendStartedAt;
        delete seg._appendOwner;
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
    var oldBySequence = {};
    oldSegments = oldSegments || [];
    for (var i = 0; i < oldSegments.length; i++) {
      oldByKey[segmentKey(oldSegments[i])] = oldSegments[i];
      var sequenceKey = hlsSequenceKey(oldSegments[i]);
      if (sequenceKey) oldBySequence[sequenceKey] = oldSegments[i];
    }
    return freshSegments.map(function (seg) {
      var old = oldByKey[segmentKey(seg)];
      if (!old) {
        var oldAtSequence = oldBySequence[hlsSequenceKey(seg)];
        if (oldAtSequence && (oldAtSequence._hlsPartialOnly || seg._hlsPartialOnly)) old = oldAtSequence;
      }
      if (old) {
        if (old.state === 'fetching' || old.state === 'fetched' || old.state === 'appending') {
          var oldParts = old.parts;
          old.start = seg.start;
          old.end = seg.end;
          old.duration = seg.duration;
          old.mediaSequence = seg.mediaSequence;
          old.discontinuity = seg.discontinuity;
          old.discontinuitySequence = seg.discontinuitySequence;
          old.url = seg.url;
          old.range = seg.range;
          old.key = seg.key || old.key;
          old.gap = !!seg.gap;
          old._hlsPartialOnly = !!seg._hlsPartialOnly;
          old._hlsPlaylistUrl = seg._hlsPlaylistUrl || old._hlsPlaylistUrl;
          old._hlsInitSegment = seg._hlsInitSegment || old._hlsInitSegment;
          old._hlsTimestampGenerationKey = seg._hlsTimestampGenerationKey || old._hlsTimestampGenerationKey;
          if (isFinite(seg.programDateTimeMs)) old.programDateTimeMs = seg.programDateTimeMs;
          mergeHlsPartState(old, seg);
          old.parts = seg.parts || oldParts;
          markCompletedHlsParent(old, null);
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
        markCompletedHlsParent(seg, old);
      }
      return seg;
    });
  }

  function mergeHlsPartState(oldSeg, freshSeg) {
    if (!oldSeg || !freshSeg || !oldSeg.parts || !freshSeg.parts) return;
    var oldByKey = {};
    for (var i = 0; i < oldSeg.parts.length; i++) oldByKey[segmentKey(oldSeg.parts[i])] = oldSeg.parts[i];
    for (var j = 0; j < freshSeg.parts.length; j++) {
      var fresh = freshSeg.parts[j];
      var old = oldByKey[segmentKey(fresh)];
      if (!old) continue;
      if (old.state === 'fetching' || old.state === 'fetched' || old.state === 'appending') {
        old.start = fresh.start;
        old.end = fresh.end;
        old.duration = fresh.duration;
        old.mediaSequence = fresh.mediaSequence;
        old.partIndex = fresh.partIndex;
        old.discontinuity = fresh.discontinuity;
        old.discontinuitySequence = fresh.discontinuitySequence;
        old.independent = fresh.independent;
        old.gap = fresh.gap;
        old.key = fresh.key || old.key;
        old._hlsInitSegment = fresh._hlsInitSegment || freshSeg._hlsInitSegment || old._hlsInitSegment;
        old._hlsTimestampGenerationKey = fresh._hlsTimestampGenerationKey || old._hlsTimestampGenerationKey;
        old._parentSegment = freshSeg;
        old._hlsPart = true;
        old._hlsPreloadHint = false;
        freshSeg.parts[j] = old;
        continue;
      }
      fresh.appended = old.appended;
      fresh.state = old.state === 'recovering' ? '' : old.state;
    }
  }

  function hlsSequenceKey(seg) {
    if (!seg || seg.mediaSequence == null || !seg._hlsPlaylistUrl) return '';
    return seg._hlsPlaylistUrl
      + ':ms' + seg.mediaSequence
      + ':ds' + (seg.discontinuitySequence || 0)
      + ':map=' + hlsInitSegmentKey(seg._hlsInitSegment);
  }

  function markCompletedHlsParent(parent, previous) {
    if (!parent || parent._hlsPartialOnly || parent.gap) return;
    var parts = parent.parts || [];
    var allCurrentPartsAppended = parts.length && parts.every(function (part) {
      return !part.gap && (part.appended || part.state === 'appended');
    });
    var previousParts = previous && previous.parts ? previous.parts : [];
    var previousDuration = previousParts.reduce(function (sum, part) {
      return sum + (part.duration || 0);
    }, 0);
    var allPreviousPartsAppended = previousParts.length && previousParts.every(function (part) {
      return !part.gap && (part.appended || part.state === 'appended');
    });
    var previousPartsCoverParent = allPreviousPartsAppended
      && previousDuration >= (parent.duration || 0) - 0.05;
    if (!allCurrentPartsAppended && !previousPartsCoverParent) return;
    parent.appended = true;
    parent.state = 'appended';
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
      part._hlsInitSegment = part._hlsInitSegment || segment._hlsInitSegment || null;
      part._hlsPart = true;
      part._parentSegment = segment;
      if (!part.range && segment.range) part.range = null;
      out.push(part);
      t += duration;
    }
    return out;
  }

  function hlsHintRange(hint) {
    if (!hint) return null;
    var length = isFinite(hint.byteRangeLength) ? hint.byteRangeLength : NaN;
    var start = isFinite(hint.byteRangeStart) ? hint.byteRangeStart : NaN;
    return isFinite(start) && isFinite(length) && length > 0
      ? { start: start, end: start + length - 1 }
      : null;
  }

  function hlsHintKey(url, range) {
    return String(url || '') + (range ? ':' + range.start + '-' + range.end : '');
  }

  function reconcileHlsPreloadHints(provider, track, parsed) {
    if (!track || !track._preloadHintSegments) return;
    var hintsByKey = track._preloadHintSegments;
    var retained = {};
    var segments = parsed && parsed.segments ? parsed.segments : [];
    for (var i = 0; i < segments.length; i++) {
      var parts = segments[i].parts || [];
      for (var p = 0; p < parts.length; p++) {
        var official = parts[p];
        var officialKey = hlsHintKey(official.url, official.range);
        retained[officialKey] = true;
        var hinted = hintsByKey[officialKey];
        if (!hinted) continue;
        hinted.start = official.start;
        hinted.end = official.end;
        hinted.duration = official.duration;
        hinted.mediaSequence = official.mediaSequence;
        hinted.partIndex = official.partIndex;
        hinted.discontinuity = official.discontinuity;
        hinted.discontinuitySequence = official.discontinuitySequence;
        hinted.independent = official.independent;
        hinted.gap = official.gap;
        hinted.key = official.key;
        hinted.range = official.range;
        hinted._hlsInitSegment = official._hlsInitSegment || segments[i]._hlsInitSegment || hinted._hlsInitSegment;
        hinted._hlsTimestampGenerationKey = official._hlsTimestampGenerationKey || hinted._hlsTimestampGenerationKey;
        hinted._parentSegment = segments[i];
        hinted._hlsPart = true;
        hinted._hlsPreloadHint = false;
        hinted._hlsPreloadHintStale = false;
        if (hinted.state === 'failed' || hinted.state === 'expired') {
          hinted.state = 'pending';
          hinted.appended = false;
        }
        parts[p] = hinted;
        delete hintsByKey[officialKey];
        if (provider) provider.preloadHintReuseCount++;
      }
    }
    var nextHints = parsed && parsed.preloadHints ? parsed.preloadHints : [];
    for (var h = 0; h < nextHints.length; h++) {
      retained[hlsHintKey(nextHints[h].url, hlsHintRange(nextHints[h]))] = true;
    }
    for (var key in hintsByKey) {
      if (!hintsByKey.hasOwnProperty(key) || retained[key]) continue;
      hintsByKey[key]._hlsPreloadHintStale = true;
      if (hintsByKey[key].state !== 'fetching' && hintsByKey[key].state !== 'appending') {
        hintsByKey[key].state = 'expired';
        delete hintsByKey[key]._data;
      }
      delete hintsByKey[key];
      if (provider) provider.preloadHintDiscardCount++;
    }
  }

  function hlsDeliveryCursor(track) {
    if (!track || !track.segments || !track.segments.length) return null;
    var tail = track.segments[track.segments.length - 1];
    if (tail.mediaSequence == null) return null;
    var cursor = {
      msn: tail.mediaSequence,
      part: -1,
      partial: false,
      discontinuitySequence: tail.discontinuitySequence || 0,
      programDateTimeMs: isFinite(tail.programDateTimeMs)
        ? tail.programDateTimeMs + Math.max(0, tail.duration || 0) * 1000
        : null
    };
    if (tail._hlsPartialOnly) {
      cursor.part = Math.max(-1, ((tail.parts && tail.parts.length) || 0) - 1);
      cursor.partial = true;
    }
    return cursor;
  }

  function hlsTrackSignature(track) {
    if (!track) return '';
    var initSegment = track.initSegment || track.map || null;
    var initKey = hlsInitSegmentKey(initSegment);
    var segments = track.segments || [];
    var values = [initKey, String(track.endList === true), String(track.isTsPlaylist === true)];
    for (var i = 0; i < segments.length; i++) {
      values.push(segmentKey(segments[i]) + ':gap=' + (segments[i].gap ? '1' : '0'));
    }
    return values.join('|');
  }

  function hlsTrackRefreshOutcome(kind, applied, stale, advanced, changed) {
    return {
      kind: kind,
      applied: !!applied,
      stale: !!stale,
      advanced: !!advanced,
      changed: !!changed,
      failed: false,
      error: null
    };
  }

  function failedHlsTrackRefreshOutcome(kind, err) {
    return {
      kind: kind,
      applied: false,
      stale: false,
      advanced: false,
      changed: false,
      failed: true,
      error: err
    };
  }

  function hlsPlaylistFetchOutcome(kind, text) {
    return {
      kind: kind,
      text: text,
      failed: false,
      error: null
    };
  }

  function settleHlsPlaylistFetch(fetchPromise, kind, timeoutMs) {
    return new Promise(function (resolve) {
      var settled = false;
      var timer = setTimeout(function () {
        finish(failedHlsTrackRefreshOutcome(kind, new Error('hls-' + kind + '-playlist-refresh-timeout')));
      }, timeoutMs);
      function finish(outcome) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(outcome);
      }
      fetchPromise.then(function (text) {
        finish(hlsPlaylistFetchOutcome(kind, text));
      }, function (err) {
        finish(failedHlsTrackRefreshOutcome(kind, err));
      });
    });
  }

  function settleHlsPlaylistApplication(kind, apply) {
    try {
      return Promise.resolve(apply()).then(function (outcome) {
        return outcome || hlsTrackRefreshOutcome(kind, false, false, false, false);
      }, function (err) {
        return failedHlsTrackRefreshOutcome(kind, err);
      });
    } catch (err) {
      return Promise.resolve(failedHlsTrackRefreshOutcome(kind, err));
    }
  }

  function cloneHlsRefreshValue(value, sources, copies) {
    if (value === null || typeof value !== 'object') return value;
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return value;
    var existingIndex = sources.indexOf(value);
    if (existingIndex !== -1) return copies[existingIndex];
    var copy = Array.isArray(value) ? [] : {};
    sources.push(value);
    copies.push(copy);
    for (var key in value) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        copy[key] = cloneHlsRefreshValue(value[key], sources, copies);
      }
    }
    return copy;
  }

  function createHlsPlaylistRefreshDraft(provider, selectedVariant, selectedAudio) {
    var draft = Object.create(Object.getPrototypeOf(provider) || Object.prototype);
    for (var key in provider) {
      if (Object.prototype.hasOwnProperty.call(provider, key)) draft[key] = provider[key];
    }
    var videoSources = [];
    var videoCopies = [];
    draft.segments = cloneHlsRefreshValue(provider.segments || [], videoSources, videoCopies);
    draft._preloadHintSegments = cloneHlsRefreshValue(provider._preloadHintSegments || {}, videoSources, videoCopies);
    draft.playlistCursorByUrl = clonePlain(provider.playlistCursorByUrl || {});
    draft.playlistResetCandidateByUrl = clonePlain(provider.playlistResetCandidateByUrl || {});
    draft.playlistEpochByUrl = clonePlain(provider.playlistEpochByUrl || {});
    draft.hlsTimestampGenerationByKey = clonePlain(provider.hlsTimestampGenerationByKey || {});
    draft.manifestCompatibilityWarnings = (provider.manifestCompatibilityWarnings || []).slice();
    draft.activeVariant = selectedVariant;
    var audioDraft = null;
    if (selectedAudio) {
      audioDraft = {};
      for (var audioKey in selectedAudio) {
        if (Object.prototype.hasOwnProperty.call(selectedAudio, audioKey)) audioDraft[audioKey] = selectedAudio[audioKey];
      }
      var audioSources = [];
      var audioCopies = [];
      audioDraft.segments = cloneHlsRefreshValue(selectedAudio.segments || [], audioSources, audioCopies);
      audioDraft._preloadHintSegments = cloneHlsRefreshValue(selectedAudio._preloadHintSegments || {}, audioSources, audioCopies);
      draft.activeAudio = audioDraft;
      draft.audioSegments = audioDraft.segments;
      draft.audioInitSegment = audioDraft.initSegment || null;
    }
    draft._stagedTimelineRegions = [];
    draft._addTimelineRegions = function (regions) {
      if (regions && regions.length) this._stagedTimelineRegions = this._stagedTimelineRegions.concat(regions);
    };
    // Presentation changes affect the engine, MediaSource duration, and live
    // refresh timers. A draft computes the values without publishing any of
    // those side effects before both required tracks have been validated.
    draft._syncPresentationState = function () {
      var separateAudioPendingEnd = !!(this.activeAudio && this.audioEndList === false);
      this.live = !this.videoEndList || separateAudioPendingEnd;
      var duration = Math.max(
        this.videoDuration || 0,
        this.activeAudio && this.activeAudio.duration ? this.activeAudio.duration : 0
      );
      if (isFinite(duration) && duration > 0) this.duration = duration;
    };
    // Transmuxer setup can load code and mutate provider-owned adapters. The
    // live commit replays the already-validated manifests and performs that
    // work only after the transaction has been accepted.
    draft._ensureTsTransmuxer = function () { return Promise.resolve(); };
    return {
      provider: draft,
      variant: selectedVariant,
      audio: audioDraft
    };
  }

  function hlsCursorAdvanced(previous, current) {
    return compareHlsCursors(current, previous) > 0;
  }

  function hlsEpochTrackWindowsCompatible(videoTrack, audioTrack) {
    var videoSegments = videoTrack && videoTrack.segments ? videoTrack.segments : [];
    var audioSegments = audioTrack && audioTrack.segments ? audioTrack.segments : [];
    if (!videoSegments.length || !audioSegments.length) return false;
    var videoTail = videoSegments[videoSegments.length - 1];
    var audioTail = audioSegments[audioSegments.length - 1];
    if (!isFinite(videoTail.end) || !isFinite(audioTail.end)) return false;
    var tolerance = Math.max(
      0.5,
      (videoTrack && videoTrack.targetDuration) || 0,
      (audioTrack && audioTrack.targetDuration) || 0
    ) * 2;
    return Math.abs(videoTail.end - audioTail.end) <= tolerance;
  }

  function compareHlsCursors(current, previous) {
    if (!previous) return current ? 1 : 0;
    if (!current) return -1;
    if (current.msn !== previous.msn) return current.msn > previous.msn ? 1 : -1;
    if (previous.partial && !current.partial) return 1;
    if (!previous.partial && current.partial) return -1;
    if (current.part === previous.part) return 0;
    return current.part > previous.part ? 1 : -1;
  }

  function copyHlsPlaylistCursor(cursor) {
    if (!cursor) return null;
    return {
      msn: cursor.msn,
      part: cursor.part,
      partial: cursor.partial,
      discontinuitySequence: cursor.discontinuitySequence || 0,
      programDateTimeMs: isFinite(cursor.programDateTimeMs) ? cursor.programDateTimeMs : null
    };
  }

  function acceptHlsPlaylistCursor(provider, url, parsed, kind) {
    if (!provider) return true;
    provider.playlistCursorByUrl = provider.playlistCursorByUrl || {};
    provider.playlistResetCandidateByUrl = provider.playlistResetCandidateByUrl || {};
    provider.playlistEpochByUrl = provider.playlistEpochByUrl || {};
    var key = String(url || '');
    var incoming = hlsDeliveryCursor(parsed);
    var previous = provider.playlistCursorByUrl[key];
    if (previous && incoming && compareHlsCursors(incoming, previous) < 0) {
      var previousPdt = previous.programDateTimeMs;
      var incomingPdt = incoming.programDateTimeMs;
      var newerProgramDate = previousPdt != null && incomingPdt != null
        && isFinite(previousPdt) && isFinite(incomingPdt) && incomingPdt > previousPdt + 250;
      var newerDiscontinuity = (incoming.discontinuitySequence || 0) > (previous.discontinuitySequence || 0);
      var dramaticDrop = previous.msn - incoming.msn >= Math.max(3, (parsed.segments && parsed.segments.length) || 0);
      var confirmedAdvancingReset = false;
      var candidate = provider.playlistResetCandidateByUrl[key];
      if (!newerProgramDate && !newerDiscontinuity && provider.live && !parsed.endList && dramaticDrop) {
        if (candidate && compareHlsCursors(incoming, candidate.cursor) > 0) {
          confirmedAdvancingReset = true;
        } else if (!candidate || compareHlsCursors(incoming, candidate.cursor) < 0) {
          provider.playlistResetCandidateByUrl[key] = { cursor: copyHlsPlaylistCursor(incoming) };
        }
      }
      if (!newerProgramDate && !newerDiscontinuity && !confirmedAdvancingReset) return false;
      delete provider.playlistResetCandidateByUrl[key];
      var previousEpoch = provider.playlistEpochByUrl[key];
      parsed._hlsEpochReset = true;
      parsed._hlsPlaylistEpoch = previousEpoch && previousEpoch.id ? previousEpoch.id + 1 : 1;
      provider.playlistEpochResetCount = (provider.playlistEpochResetCount || 0) + 1;
      provider.lastPlaylistEpochResetTrack = kind || '';
    } else {
      delete provider.playlistResetCandidateByUrl[key];
    }
    if (incoming && (!previous || compareHlsCursors(incoming, previous) >= 0)) {
      provider.playlistCursorByUrl[key] = copyHlsPlaylistCursor(incoming);
    } else if (parsed._hlsEpochReset && incoming) {
      provider.playlistCursorByUrl[key] = copyHlsPlaylistCursor(incoming);
    }
    return true;
  }

  function clearHlsPreloadHintEpochState(provider) {
    if (!provider) return;
    var hints = provider._preloadHintSegments || {};
    for (var key in hints) {
      if (!Object.prototype.hasOwnProperty.call(hints, key)) continue;
      hints[key]._hlsPreloadHintStale = true;
      hints[key].state = 'expired';
      delete hints[key]._data;
      provider.preloadHintDiscardCount = (provider.preloadHintDiscardCount || 0) + 1;
    }
    provider._preloadHintSegments = {};
  }

  function hlsSegmentInitSegment(provider, track, seg) {
    var parent = seg && (seg._parentSegment || seg);
    if (seg && seg._hlsInitSegment) return seg._hlsInitSegment;
    if (parent && parent._hlsInitSegment) return parent._hlsInitSegment;
    var isAudio = track && track !== provider && track.kind === 'audio';
    return isAudio
      ? (track.initSegment || provider.audioInitSegment || null)
      : (provider.initSegment || null);
  }

  function hlsTimestampGenerationKey(kind, url, segment) {
    return (kind || 'video')
      + ':' + String(url || segment && segment._hlsPlaylistUrl || '')
      + ':epoch=' + (segment && segment._hlsPlaylistEpoch || 0)
      + ':disc=' + (segment && segment.discontinuitySequence || 0)
      + ':map=' + hlsInitSegmentKey(segment && segment._hlsInitSegment);
  }

  function assignHlsTimestampGenerations(provider, url, parsed, kind) {
    if (!provider || !parsed || !parsed.segments) return;
    provider.hlsTimestampGenerationByKey = provider.hlsTimestampGenerationByKey || {};
    var previousKey = '';
    var previousSequence = null;
    for (var i = 0; i < parsed.segments.length; i++) {
      var segment = parsed.segments[i];
      if (!segment._hlsInitSegment) segment._hlsInitSegment = parsed.map || null;
      var key = hlsTimestampGenerationKey(kind, url, segment);
      var generation = provider.hlsTimestampGenerationByKey[key];
      var isDiscontinuity = !!segment.discontinuity
        || previousSequence != null && previousSequence !== (segment.discontinuitySequence || 0);
      if (!generation) {
        generation = {
          key: key,
          kind: kind || 'video',
          playlistUrl: String(url || ''),
          playlistEpoch: segment._hlsPlaylistEpoch || 0,
          discontinuitySequence: segment.discontinuitySequence || 0,
          initKey: hlsInitSegmentKey(segment._hlsInitSegment),
          boundaryStart: segment.start,
          previousKey: previousKey,
          discontinuity: isDiscontinuity,
          containerHint: hlsSegmentContainerHint(segment),
          container: '',
          mediaTimestampOffset: null,
          mediaTimestampResolved: false
        };
        provider.hlsTimestampGenerationByKey[key] = generation;
      } else if (isDiscontinuity) {
        generation.discontinuity = true;
      }
      segment._hlsTimestampGenerationKey = key;
      var parts = segment.parts || [];
      for (var p = 0; p < parts.length; p++) {
        parts[p]._hlsInitSegment = parts[p]._hlsInitSegment || segment._hlsInitSegment || null;
        parts[p]._hlsTimestampGenerationKey = key;
      }
      previousKey = key;
      previousSequence = segment.discontinuitySequence || 0;
    }
    var hints = parsed.preloadHints || [];
    var tail = parsed.segments.length ? parsed.segments[parsed.segments.length - 1] : null;
    for (var h = 0; h < hints.length; h++) {
      hints[h]._hlsInitSegment = hints[h]._hlsInitSegment || tail && tail._hlsInitSegment || parsed.map || null;
      hints[h]._hlsTimestampGenerationKey = tail ? tail._hlsTimestampGenerationKey : '';
    }
  }

  function pruneHlsTimestampGenerations(provider) {
    if (!provider || !provider.hlsTimestampGenerationByKey) return 0;
    var retained = {};
    function collectTrack(track) {
      var segments = track && track.segments ? track.segments : [];
      for (var i = 0; i < segments.length; i++) {
        var segmentKey = segments[i]._hlsTimestampGenerationKey || '';
        if (segmentKey) retained[segmentKey] = true;
        var parts = segments[i].parts || [];
        for (var p = 0; p < parts.length; p++) {
          if (parts[p]._hlsTimestampGenerationKey) retained[parts[p]._hlsTimestampGenerationKey] = true;
        }
      }
      var hints = track && track._preloadHintSegments ? track._preloadHintSegments : {};
      for (var hintKey in hints) {
        if (Object.prototype.hasOwnProperty.call(hints, hintKey) && hints[hintKey]._hlsTimestampGenerationKey) {
          retained[hints[hintKey]._hlsTimestampGenerationKey] = true;
        }
      }
    }
    collectTrack(provider);
    collectTrack(provider.activeAudio);
    for (var a = 0; provider.audioRenditions && a < provider.audioRenditions.length; a++) collectTrack(provider.audioRenditions[a]);
    var removedKeys = [];
    for (var key in provider.hlsTimestampGenerationByKey) {
      if (!Object.prototype.hasOwnProperty.call(provider.hlsTimestampGenerationByKey, key) || retained[key]) continue;
      removedKeys.push(key);
      delete provider.hlsTimestampGenerationByKey[key];
    }
    function pruneGenerationCache(cache) {
      if (!cache || !removedKeys.length) return;
      for (var cacheKey in cache) {
        if (!Object.prototype.hasOwnProperty.call(cache, cacheKey)) continue;
        for (var r = 0; r < removedKeys.length; r++) {
          if (cacheKey.indexOf(':generation=' + removedKeys[r]) !== -1) {
            delete cache[cacheKey];
            break;
          }
        }
      }
    }
    pruneGenerationCache(provider.hlsInitTimescaleByKey);
    pruneGenerationCache(provider.hlsInitTrackInfoByKey);
    if (provider.hlsTsTimelineByGeneration) {
      for (var timelineIndex = 0; timelineIndex < removedKeys.length; timelineIndex++) {
        delete provider.hlsTsTimelineByGeneration[removedKeys[timelineIndex]];
      }
    }
    provider.hlsTimestampGenerationPruneCount = (provider.hlsTimestampGenerationPruneCount || 0) + removedKeys.length;
    return removedKeys.length;
  }

  function applyHlsPlaylistEpoch(provider, url, parsed, previousSegments, kind) {
    if (!provider || !parsed || !parsed.segments || !parsed.segments.length) return;
    provider.playlistEpochByUrl = provider.playlistEpochByUrl || {};
    var key = String(url || '');
    var epoch = provider.playlistEpochByUrl[key];
    var oldSegments = previousSegments || [];
    var oldTail = oldSegments.length ? oldSegments[oldSegments.length - 1] : null;
    if (parsed._hlsEpochReset) {
      var oldOrigin = hlsProgramDateOrigin(oldSegments);
      var newOrigin = hlsProgramDateOrigin(parsed.segments);
      var first = parsed.segments[0];
      var timelineStart = oldTail && isFinite(oldTail.end) ? oldTail.end : first.start;
      if (oldOrigin && newOrigin) {
        timelineStart = oldOrigin.time + (newOrigin.ms - oldOrigin.ms) / 1000;
      }
      var timelineOffset = timelineStart - first.start;
      if (!isFinite(timelineOffset)) timelineOffset = 0;
      var incomingDiscontinuity = first.discontinuitySequence || parsed.discontinuitySequence || 0;
      var priorDiscontinuity = oldTail ? oldTail.discontinuitySequence || 0 : incomingDiscontinuity - 1;
      var discontinuityOffset = Math.max(0, priorDiscontinuity + 1 - incomingDiscontinuity);
      epoch = {
        id: parsed._hlsPlaylistEpoch || 1,
        timelineOffset: timelineOffset,
        discontinuityOffset: discontinuityOffset,
        mediaTimestampOffset: null,
        mediaTimestampResolved: false,
        kind: kind || ''
      };
      provider.playlistEpochByUrl[key] = epoch;
      provider.lastPlaylistEpochResetOffset = timelineOffset;
    } else if (!epoch && oldTail && oldTail._hlsPlaylistEpoch && isFinite(oldTail._hlsEpochManifestOffset)) {
      var firstSegment = parsed.segments[0];
      epoch = {
        id: oldTail._hlsPlaylistEpoch,
        timelineOffset: oldTail._hlsEpochManifestOffset,
        discontinuityOffset: Math.max(0, (oldTail.discontinuitySequence || 0) - (firstSegment.discontinuitySequence || 0)),
        mediaTimestampOffset: null,
        mediaTimestampResolved: false,
        kind: kind || ''
      };
      provider.playlistEpochByUrl[key] = epoch;
    }
    if (!epoch) return;
    parsed._hlsPlaylistEpoch = epoch.id || 0;
    var offset = Number(epoch.timelineOffset) || 0;
    var discontinuityOffset = Number(epoch.discontinuityOffset) || 0;
    for (var i = 0; i < parsed.segments.length; i++) {
      var segment = parsed.segments[i];
      segment.start += offset;
      segment.end += offset;
      segment.discontinuitySequence = (segment.discontinuitySequence || 0) + discontinuityOffset;
      segment._hlsPlaylistEpoch = epoch.id || 0;
      segment._hlsEpochManifestOffset = offset;
      segment._hlsEpochTimestampOffset = epoch.mediaTimestampResolved ? epoch.mediaTimestampOffset : NaN;
      if (parsed._hlsEpochReset && i === 0) segment.discontinuity = true;
      var parts = segment.parts || [];
      for (var p = 0; p < parts.length; p++) {
        parts[p].start += offset;
        parts[p].end += offset;
        parts[p].discontinuitySequence = (parts[p].discontinuitySequence || 0) + discontinuityOffset;
        parts[p]._hlsPlaylistEpoch = epoch.id || 0;
        parts[p]._hlsPlaylistUrl = segment._hlsPlaylistUrl || parts[p]._hlsPlaylistUrl || '';
        parts[p]._hlsEpochManifestOffset = offset;
        parts[p]._hlsEpochTimestampOffset = epoch.mediaTimestampResolved ? epoch.mediaTimestampOffset : NaN;
      }
    }
    parsed.duration += offset;
    parsed.discontinuitySequence = (parsed.discontinuitySequence || 0) + discontinuityOffset;
    if (parsed._hlsEpochReset) parsed.discontinuityCount = (parsed.discontinuityCount || 0) + 1;
  }

  function hlsBlockingReloadUrl(url, track) {
    if (!url || !track || !track.serverControl || !track.serverControl.canBlockReload) return url;
    var cursor = hlsDeliveryCursor(track);
    if (!cursor) return url;
    var msn = cursor.partial ? cursor.msn : cursor.msn + 1;
    var part = cursor.partial
      ? cursor.part + 1
      : (track.lowLatencyPlaylist && track.partTargetDuration > 0 ? 0 : null);
    try {
      var requestUrl = new URL(url, window.location.href);
      requestUrl.searchParams.set('_HLS_msn', String(msn));
      if (part != null) requestUrl.searchParams.set('_HLS_part', String(part));
      else requestUrl.searchParams.delete('_HLS_part');
      return requestUrl.href;
    } catch (e) {
      return url;
    }
  }

  function hlsPlayableSegments(provider, track, segments) {
    if (!segments || !segments.length) return segments || [];
    var withoutDeclaredGaps = segments.filter(function (segment) { return !segment.gap; });
    if (!provider || !provider.live || !track || track.isTsPlaylist || provider.isTsPlaylist && (track === provider || track.kind === 'video')) {
      return withoutDeclaredGaps;
    }
    var lowLatency = track.lowLatencyPlaylist || provider.lowLatencyPlaylist;
    if (!lowLatency) return withoutDeclaredGaps;
    var out = [];
    var isVideo = track === provider || track.kind === 'video';
    // Before MSE has metadata, assigning the live startup time may not update
    // HTMLMediaElement.currentTime yet. Use the scheduler's pending startup or
    // seek target so LL parts are selected instead of prematurely fetching the
    // full parent segment.
    var schedulerTime = provider._schedulerTime ? provider._schedulerTime() : NaN;
    var ct = isFinite(schedulerTime)
      ? schedulerTime
      : (provider.video && isFinite(provider.video.currentTime) ? provider.video.currentTime : 0);
    var liveEnd = provider.liveWindow ? provider.liveWindow.end : 0;
    var targetLatency = provider._targetLiveLatency ? provider._targetLiveLatency() : LIVE_TARGET_LATENCY;
    var nearLiveEdge = liveEnd && liveEnd - ct <= Math.max(targetLatency + 2, provider._bufferAheadGoal ? provider._bufferAheadGoal() : BUFFER_AHEAD);
    for (var i = 0; i < withoutDeclaredGaps.length; i++) {
      var seg = withoutDeclaredGaps[i];
      var parts = seg.parts || [];
      var usableParts = lowLatency && parts.length && nearLiveEdge
        ? playableHlsParts(parts, isVideo)
        : [];
      if (usableParts.length && !seg.appended && seg.state !== 'appended') {
        var unavailablePart = parts.some(function (part) { return part.gap || part.state === 'failed'; });
        if (!unavailablePart || seg._hlsPartialOnly) {
          for (var p = 0; p < usableParts.length; p++) out.push(usableParts[p]);
          continue;
        }
      }
      // An in-progress Parent Segment has no resource of its own to fetch.
      // Wait for another playlist update when none of its published parts can
      // be decoded; never issue a request for its intentionally empty URL.
      if (seg._hlsPartialOnly) continue;
      out.push(seg);
    }
    appendHlsPreloadHint(provider, track, out);
    return out;
  }

  function hlsIndependentPartStart(segments, time) {
    if (!segments || !segments.length || !isFinite(time)) return time;
    var selected = -1;
    for (var i = 0; i < segments.length; i++) {
      var part = segments[i];
      if (!part || !part._hlsPart) continue;
      if (part.start <= time + 0.05 && (!part._parentSegment || time <= part._parentSegment.end + 0.1)) {
        selected = i;
        continue;
      }
      if (part.start > time + 0.05) break;
    }
    if (selected < 0) return time;
    var parent = segments[selected]._parentSegment;
    for (var j = selected; j >= 0; j--) {
      var candidate = segments[j];
      if (!candidate || !candidate._hlsPart) continue;
      if (parent && candidate._parentSegment !== parent) break;
      if (candidate.independent) return Math.min(time, candidate.start);
    }
    return time;
  }

  function hlsNextPlayableStart(segments, time) {
    if (!segments || !segments.length || !isFinite(time)) return time;
    for (var i = 0; i < segments.length; i++) {
      var segment = segments[i];
      if (!segment || segment.gap || segment.state === 'expired' || segment.end <= time - 0.05) continue;
      return segment.start > time + 0.05 ? segment.start : time;
    }
    return time;
  }

  function playableHlsParts(parts, requireIndependent) {
    var out = [];
    var decodable = !requireIndependent;
    for (var i = 0; i < (parts || []).length; i++) {
      var part = parts[i];
      if (part.gap || part.state === 'failed') {
        decodable = !requireIndependent;
        continue;
      }
      if (part.independent) decodable = true;
      if (decodable) out.push(part);
    }
    return out;
  }

  function appendHlsPreloadHint(provider, track, out) {
    if (!provider || !track || !provider.live) return;
    var isVideo = track === provider || track.kind === 'video';
    var source = isVideo ? provider : track;
    if (!source.lowLatencyPlaylist || source.isTsPlaylist || (isVideo && provider.isTsPlaylist)) return;
    if (getBufferAhead(provider.video) >= Math.min(1, provider._startupBufferGoal ? provider._startupBufferGoal() : 1)) return;
    var hints = source.preloadHints || [];
    for (var i = 0; i < hints.length; i++) {
      var hint = hints[i];
      if (String(hint.type || '').toUpperCase() !== 'PART' || !hint.url) continue;
      var range = hlsHintRange(hint);
      source._preloadHintSegments = source._preloadHintSegments || {};
      var key = hlsHintKey(hint.url, range);
      var seg = source._preloadHintSegments[key];
      if (!seg) {
        var sourceSegments = source.segments || [];
        var tail = sourceSegments.length ? sourceSegments[sourceSegments.length - 1] : null;
        var liveEnd = tail ? tail.end : (provider.liveWindow ? provider.liveWindow.end : 0);
        var duration = source.partTargetDuration || provider.partTargetDuration || 0.25;
        var cursor = hlsDeliveryCursor(source);
        var mediaSequence = cursor
          ? (cursor.partial ? cursor.msn : cursor.msn + 1)
          : (source.mediaSequence || 0) + sourceSegments.length;
        var partIndex = cursor && cursor.partial ? cursor.part + 1 : 0;
        seg = source._preloadHintSegments[key] = {
          start: liveEnd,
          end: liveEnd + duration,
          duration: duration,
          mediaSequence: mediaSequence,
          partIndex: partIndex,
          discontinuitySequence: source.discontinuitySequence || provider.discontinuitySequence || 0,
          url: hint.url,
          range: range,
          _hlsPlaylistUrl: source.playlistUrl || provider.mediaPlaylistUrl || '',
          _hlsInitSegment: hint._hlsInitSegment || tail && tail._hlsInitSegment || source.initSegment || provider.initSegment || null,
          _hlsTimestampGenerationKey: hint._hlsTimestampGenerationKey || tail && tail._hlsTimestampGenerationKey || '',
          _hlsPreloadHint: true,
          _hlsPart: true
        };
      }
      if (!seg._hlsPreloadHintStale && !isSegmentBusyOrDone(seg) && seg.state !== 'failed' && seg.state !== 'expired') out.push(seg);
      break;
    }
  }

  var TS_TIMESTAMP_ROLLOVER_SECONDS = 8589934592 / 90000;
  var TS_TIMESTAMP_ROLLOVER_HALF_SECONDS = TS_TIMESTAMP_ROLLOVER_SECONDS / 2;
  // Keep decode timestamps positive while mapping the transport clock onto the
  // manifest timeline. Unlike a first-fetched-segment origin, this fixed guard
  // remains valid when an unbuffered seek requests an earlier segment.
  var TS_DECODE_TIME_GUARD_SECONDS = 60;

  function hlsTsTimelineGenerationKey(track, seg) {
    var parent = seg && (seg._parentSegment || seg);
    var generationKey = seg && seg._hlsTimestampGenerationKey
      || parent && parent._hlsTimestampGenerationKey
      || '';
    if (generationKey) return generationKey;
    return 'ts:'
      + String(seg && seg._hlsPlaylistUrl || parent && parent._hlsPlaylistUrl || '')
      + ':disc=' + (seg && seg.discontinuitySequence || parent && parent.discontinuitySequence || 0)
      + ':track=' + (track && track.kind || 'video');
  }

  function prepareHlsTsTransmuxContext(provider, track, seg, data, preparedDemux) {
    var demux = preparedDemux || demuxMpegTs(data);
    var generationKey = hlsTsTimelineGenerationKey(track, seg);
    provider.hlsTsTimelineByGeneration = provider.hlsTsTimelineByGeneration || {};
    var timeline = provider.hlsTsTimelineByGeneration[generationKey];
    if (!timeline) {
      timeline = provider.hlsTsTimelineByGeneration[generationKey] = {
        key: generationKey,
        clockByPid: {},
        decodeOrigin: null,
        presentationAnchor: null,
        presentationClockAtManifestZero: null,
        timestampOffset: null,
        firstPresentationByType: {},
        maxManifestStart: null,
        seenManifestStarts: {},
        outOfOrderSegmentCount: 0,
        rolloverCount: 0
      };
    }
    timeline.seenManifestStarts = timeline.seenManifestStarts || {};
    var manifestStart = hlsFiniteTimestamp(seg && seg.start) ? Number(seg.start) : 0;
    var rawBounds = hlsTsDemuxTimestampBounds(demux, true);
    var rawPresentationAnchor = hlsFiniteTimestamp(rawBounds.minPresentationTime)
      ? rawBounds.minPresentationTime
      : rawBounds.minDecodeTime;
    if (!hlsFiniteTimestamp(timeline.presentationClockAtManifestZero) && hlsFiniteTimestamp(rawPresentationAnchor)) {
      // Start in the second local 33-bit epoch. That leaves a complete epoch
      // available below the initial segment, so seeking backward across a PTS
      // rollover can still be represented without negative media timestamps.
      timeline.presentationClockAtManifestZero = rawPresentationAnchor
        + TS_TIMESTAMP_ROLLOVER_SECONDS
        - manifestStart;
      timeline.decodeOrigin = timeline.presentationClockAtManifestZero - TS_DECODE_TIME_GUARD_SECONDS;
      timeline.presentationAnchor = TS_DECODE_TIME_GUARD_SECONDS;
      timeline.timestampOffset = -TS_DECODE_TIME_GUARD_SECONDS;
    }
    var manifestStartKey = String(manifestStart);
    if (
      hlsFiniteTimestamp(timeline.maxManifestStart)
      && manifestStart < timeline.maxManifestStart - 0.05
      && !timeline.seenManifestStarts[manifestStartKey]
    ) {
      timeline.outOfOrderSegmentCount = (timeline.outOfOrderSegmentCount || 0) + 1;
      provider.hlsTsOutOfOrderSegmentCount = (provider.hlsTsOutOfOrderSegmentCount || 0) + 1;
    }
    timeline.seenManifestStarts[manifestStartKey] = true;
    timeline.maxManifestStart = hlsFiniteTimestamp(timeline.maxManifestStart)
      ? Math.max(timeline.maxManifestStart, manifestStart)
      : manifestStart;
    var rollovers = normalizeHlsTsDemuxTimestamps(timeline, demux, manifestStart);
    if (rollovers) {
      provider.hlsTsTimestampRolloverCount = (provider.hlsTsTimestampRolloverCount || 0) + rollovers;
    }
    var bounds = hlsTsDemuxTimestampBounds(demux);
    if (!hlsFiniteTimestamp(timeline.decodeOrigin) && hlsFiniteTimestamp(bounds.minDecodeTime)) {
      timeline.decodeOrigin = bounds.minDecodeTime;
      timeline.presentationAnchor = hlsFiniteTimestamp(bounds.minPresentationTime)
        ? bounds.minPresentationTime - timeline.decodeOrigin
        : 0;
      timeline.timestampOffset = (hlsFiniteTimestamp(seg && seg.start) ? seg.start : 0) - timeline.presentationAnchor;
    }
    if (!timeline.firstPresentationByType || !countKeys(timeline.firstPresentationByType)) {
      timeline.firstPresentationByType = bounds.firstPresentationByType;
      if (hlsFiniteTimestamp(bounds.firstPresentationByType.audio) && hlsFiniteTimestamp(bounds.firstPresentationByType.video)) {
        provider.hlsTsMuxedAvStartOffsetMs = (bounds.firstPresentationByType.audio - bounds.firstPresentationByType.video) * 1000;
      }
    }
    return { demux: demux, timeline: timeline };
  }

  function normalizeHlsTsDemuxTimestamps(timeline, demux, manifestStart) {
    if (!timeline || !demux) return 0;
    timeline.clockByPid = timeline.clockByPid || {};
    var hasManifestClock = hlsFiniteTimestamp(timeline.presentationClockAtManifestZero)
      && hlsFiniteTimestamp(manifestStart);
    var manifestClockReference = hasManifestClock
      ? timeline.presentationClockAtManifestZero + Number(manifestStart)
      : NaN;
    var rollovers = 0;
    var tracks = demux.tracks || [];
    for (var t = 0; t < tracks.length; t++) {
      var track = tracks[t];
      var pidKey = String(track.pid == null ? t : track.pid);
      var clock = timeline.clockByPid[pidKey] || (timeline.clockByPid[pidKey] = {
        lastRaw: null,
        wrapOffset: 0
      });
      var pesList = track.pes || [];
      for (var p = 0; p < pesList.length; p++) {
        var pes = pesList[p];
        var rawDts = hlsFiniteTimestamp(pes.dts) ? pes.dts : (hlsFiniteTimestamp(pes.pts) ? pes.pts : null);
        var rawPts = hlsFiniteTimestamp(pes.pts) ? pes.pts : rawDts;
        var anchor = rawDts;
        if (!hlsFiniteTimestamp(anchor)) continue;
        if (hasManifestClock) {
          var normalizedPtsFromManifest = hlsTsTimestampNear(rawPts, manifestClockReference);
          var normalizedDtsFromManifest = hlsTsTimestampNear(rawDts, normalizedPtsFromManifest);
          pes.normalizedDts = normalizedDtsFromManifest;
          pes.normalizedPts = normalizedPtsFromManifest;
          var normalizedCycle = Math.floor(normalizedDtsFromManifest / TS_TIMESTAMP_ROLLOVER_SECONDS);
          var advancesClock = !hlsFiniteTimestamp(clock.lastManifestStart)
            || Number(manifestStart) >= clock.lastManifestStart - 0.001;
          if (advancesClock) {
            if (clock.lastCycle != null && normalizedCycle > clock.lastCycle) {
              rollovers += normalizedCycle - clock.lastCycle;
            }
            clock.lastRaw = anchor;
            clock.lastNormalized = normalizedDtsFromManifest;
            clock.lastCycle = normalizedCycle;
            clock.lastManifestStart = Number(manifestStart);
          }
          continue;
        }
        if (hlsFiniteTimestamp(clock.lastRaw)) {
          var delta = anchor - clock.lastRaw;
          if (delta < -TS_TIMESTAMP_ROLLOVER_HALF_SECONDS) {
            clock.wrapOffset += TS_TIMESTAMP_ROLLOVER_SECONDS;
            rollovers++;
          } else if (delta > TS_TIMESTAMP_ROLLOVER_HALF_SECONDS) {
            clock.wrapOffset -= TS_TIMESTAMP_ROLLOVER_SECONDS;
            rollovers++;
          }
        }
        var normalizedDts = rawDts + clock.wrapOffset;
        var normalizedPts = rawPts + clock.wrapOffset;
        while (normalizedPts - normalizedDts > TS_TIMESTAMP_ROLLOVER_HALF_SECONDS) normalizedPts -= TS_TIMESTAMP_ROLLOVER_SECONDS;
        while (normalizedDts - normalizedPts > TS_TIMESTAMP_ROLLOVER_HALF_SECONDS) normalizedPts += TS_TIMESTAMP_ROLLOVER_SECONDS;
        pes.normalizedDts = normalizedDts;
        pes.normalizedPts = normalizedPts;
        clock.lastRaw = anchor;
        clock.lastNormalized = normalizedDts;
      }
    }
    timeline.rolloverCount = (timeline.rolloverCount || 0) + rollovers;
    return rollovers;
  }

  function hlsTsTimestampNear(rawTimestamp, referenceTimestamp) {
    if (!hlsFiniteTimestamp(rawTimestamp) || !hlsFiniteTimestamp(referenceTimestamp)) return rawTimestamp;
    return rawTimestamp + Math.round(
      (referenceTimestamp - rawTimestamp) / TS_TIMESTAMP_ROLLOVER_SECONDS
    ) * TS_TIMESTAMP_ROLLOVER_SECONDS;
  }

  function hlsTsDemuxTimestampBounds(demux, rawOnly) {
    var minDecodeTime = Infinity;
    var minPresentationTime = Infinity;
    var firstPresentationByType = {};
    var tracks = demux && demux.tracks ? demux.tracks : [];
    for (var t = 0; t < tracks.length; t++) {
      var track = tracks[t];
      var trackMinPresentation = Infinity;
      var pesList = track.pes || [];
      for (var p = 0; p < pesList.length; p++) {
        var dts = !rawOnly && hlsFiniteTimestamp(pesList[p].normalizedDts) ? pesList[p].normalizedDts : pesList[p].dts;
        var pts = !rawOnly && hlsFiniteTimestamp(pesList[p].normalizedPts) ? pesList[p].normalizedPts : pesList[p].pts;
        if (hlsFiniteTimestamp(dts)) minDecodeTime = Math.min(minDecodeTime, dts);
        if (hlsFiniteTimestamp(pts)) {
          minPresentationTime = Math.min(minPresentationTime, pts);
          trackMinPresentation = Math.min(trackMinPresentation, pts);
        }
      }
      if (isFinite(trackMinPresentation) && track.type) firstPresentationByType[track.type] = trackMinPresentation;
    }
    return {
      minDecodeTime: isFinite(minDecodeTime) ? minDecodeTime : NaN,
      minPresentationTime: isFinite(minPresentationTime) ? minPresentationTime : NaN,
      firstPresentationByType: firstPresentationByType
    };
  }

  function hlsFiniteTimestamp(value) {
    return value != null && isFinite(Number(value));
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
    this.lastDemux = context && context.demux ? context.demux : demuxMpegTs(data);
    if (this.contentType === 'video') {
      return Promise.resolve(remuxH264ToFragmentedMp4(this.lastDemux, {
        codecs: this.codecs,
        height: context && context.activeVariant ? context.activeVariant.height : 0,
        sequenceNumber: this.sequenceNumber++,
        timeline: context && context.timeline,
        width: context && context.activeVariant ? context.activeVariant.width : 0
      }));
    }
    if (this.contentType === 'audio') {
      return Promise.resolve(remuxAacToFragmentedMp4(this.lastDemux, {
        codecs: this.codecs,
        sequenceNumber: this.sequenceNumber++,
        timeline: context && context.timeline
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
    var timeline = options.timeline || null;
    var baseDecodeTime = hlsTsBaseDecodeTime(samples, timescale, timeline);
    var compositionOffsetSampleCount = 0;
    var maxCompositionOffsetTicks = 0;
    for (var sampleIndex = 0; sampleIndex < samples.length; sampleIndex++) {
      var sample = samples[sampleIndex];
      var compositionOffset = hlsFiniteTimestamp(sample.pts) && hlsFiniteTimestamp(sample.dts)
        ? Math.round((sample.pts - sample.dts) * timescale)
        : 0;
      sample.compositionOffset = compositionOffset;
      if (compositionOffset) compositionOffsetSampleCount++;
      maxCompositionOffsetTicks = Math.max(maxCompositionOffsetTicks, Math.abs(compositionOffset));
    }
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
        baseDecodeTime: baseDecodeTime,
        samples: samples,
        sequenceNumber: options.sequenceNumber || 1,
        timescale: timescale,
        trackId: 1
      }).buffer,
      compositionOffsetSampleCount: compositionOffsetSampleCount,
      maxCompositionOffsetMs: maxCompositionOffsetTicks / timescale * 1000,
      timelineGenerationKey: timeline && timeline.key || '',
      timestampOffset: timeline && hlsFiniteTimestamp(timeline.timestampOffset) ? timeline.timestampOffset : NaN
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
        dts: hlsFiniteTimestamp(pes.normalizedDts) ? pes.normalizedDts : (pes.dts === null ? pes.pts : pes.dts),
        duration: 0,
        keyframe: keyframe,
        nalUnits: units,
        pts: hlsFiniteTimestamp(pes.normalizedPts) ? pes.normalizedPts : pes.pts,
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
        baseDecodeTime: hlsTsBaseDecodeTime(samples, config.sampleRate || 44100, options.timeline || null),
        samples: samples,
        sequenceNumber: options.sequenceNumber || 1,
        timescale: config.sampleRate || 44100,
        trackId: 1
      }).buffer,
      compositionOffsetSampleCount: 0,
      maxCompositionOffsetMs: 0,
      timelineGenerationKey: options.timeline && options.timeline.key || '',
      timestampOffset: options.timeline && hlsFiniteTimestamp(options.timeline.timestampOffset)
        ? options.timeline.timestampOffset
        : NaN
    };
  }

  function hlsTsBaseDecodeTime(samples, timescale, timeline) {
    if (!samples || !samples.length || !timeline || !hlsFiniteTimestamp(timeline.decodeOrigin)) return 0;
    var firstDts = hlsFiniteTimestamp(samples[0].dts) ? samples[0].dts : samples[0].pts;
    if (!hlsFiniteTimestamp(firstDts)) return 0;
    return Math.max(0, Math.round((firstDts - timeline.decodeOrigin) * timescale));
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
          dts: hlsFiniteTimestamp(pes.normalizedDts) ? pes.normalizedDts : (pes.dts === null ? pes.pts : pes.dts),
          duration: 1024,
          keyframe: true,
          pts: hlsFiniteTimestamp(pes.normalizedPts) ? pes.normalizedPts : pes.pts,
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
    var hasCompositionOffsets = samples.some(function (sample) { return sample.compositionOffset != null; });
    for (var i = 0; i < samples.length; i++) {
      var sample = samples[i];
      parts.push(
        mp4Uint32(sample.duration || 90000),
        mp4Uint32(sample.size),
        mp4Uint32(sample.keyframe ? 0x02000000 : 0x01010000)
      );
      if (hasCompositionOffsets) parts.push(mp4Uint32(sample.compositionOffset || 0));
    }
    return mp4FullBox.apply(null, ['trun', hasCompositionOffsets ? 1 : 0, hasCompositionOffsets ? 0x000f01 : 0x000701].concat(parts));
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

  function copyHlsMediaBytes(data) {
    var bytes = toUint8Array(data);
    var copy = new Uint8Array(bytes.length);
    copy.set(bytes);
    return copy;
  }

  function hlsMediaBytesEqual(left, right) {
    if (!left || !right) return false;
    var a = toUint8Array(left);
    var b = toUint8Array(right);
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
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
    var hlsMap = seg._hlsInitSegment ? ':map=' + hlsInitSegmentKey(seg._hlsInitSegment) : '';
    return (seg.url || String(seg.start)) + range + hlsSeq + hlsPart + hlsMap;
  }

  function hlsInitSegmentKey(initSegment) {
    if (!initSegment) return '';
    var range = initSegment.range
      ? ':' + initSegment.range.start + '-' + initSegment.range.end
      : '';
    var encryption = '';
    if (initSegment.key) {
      var iv = initSegment.key.iv;
      var ivHex = '';
      if (iv && typeof iv.length === 'number') {
        for (var i = 0; i < iv.length; i++) ivHex += ('0' + Number(iv[i]).toString(16)).slice(-2);
      }
      encryption = ':key=' + String(initSegment.key.uri || '') + ':iv=' + ivHex;
    }
    return String(initSegment.url || '') + range + encryption;
  }

  function mp4DataView(data) {
    if (data instanceof ArrayBuffer) return new DataView(data);
    if (ArrayBuffer.isView(data)) return new DataView(data.buffer, data.byteOffset, data.byteLength);
    return null;
  }

  function mp4Boxes(view, start, end) {
    var boxes = [];
    var position = Math.max(0, start || 0);
    end = Math.min(view ? view.byteLength : 0, end == null ? (view ? view.byteLength : 0) : end);
    while (view && position + 8 <= end) {
      var size = view.getUint32(position);
      var type = readType(view, position + 4);
      var headerSize = 8;
      if (size === 1) {
        if (position + 16 > end) break;
        size = view.getUint32(position + 8) * 4294967296 + view.getUint32(position + 12);
        headerSize = 16;
      } else if (size === 0) {
        size = end - position;
      }
      if (!isFinite(size) || size < headerSize || position + size > end) break;
      boxes.push({
        start: position,
        end: position + size,
        size: size,
        type: type,
        headerSize: headerSize,
        payloadStart: position + headerSize
      });
      position += size;
    }
    return boxes;
  }

  function mp4BoxOfType(boxes, type) {
    for (var i = 0; i < boxes.length; i++) if (boxes[i].type === type) return boxes[i];
    return null;
  }

  function mp4Uint64Number(view, position) {
    if (position + 8 > view.byteLength) return NaN;
    var high = view.getUint32(position);
    var low = view.getUint32(position + 4);
    var value = high * 4294967296 + low;
    return Number.isSafeInteger(value) ? value : NaN;
  }

  function parseMp4InitTrackInfo(data) {
    var view = mp4DataView(data);
    if (!view) return [];
    var moov = mp4BoxOfType(mp4Boxes(view, 0, view.byteLength), 'moov');
    if (!moov) return [];
    var tracks = [];
    var traks = mp4Boxes(view, moov.payloadStart, moov.end).filter(function (box) { return box.type === 'trak'; });
    for (var i = 0; i < traks.length; i++) {
      var trakChildren = mp4Boxes(view, traks[i].payloadStart, traks[i].end);
      var tkhd = mp4BoxOfType(trakChildren, 'tkhd');
      var mdia = mp4BoxOfType(trakChildren, 'mdia');
      if (!mdia) continue;
      var mdiaChildren = mp4Boxes(view, mdia.payloadStart, mdia.end);
      var mdhd = mp4BoxOfType(mdiaChildren, 'mdhd');
      var hdlr = mp4BoxOfType(mdiaChildren, 'hdlr');
      if (!mdhd || mdhd.payloadStart + 16 > mdhd.end) continue;
      var mdhdVersion = view.getUint8(mdhd.payloadStart);
      var timescalePosition = mdhd.payloadStart + (mdhdVersion === 1 ? 20 : 12);
      if (timescalePosition + 4 > mdhd.end) continue;
      var timescale = view.getUint32(timescalePosition);
      var trackId = 0;
      if (tkhd && tkhd.payloadStart + 16 <= tkhd.end) {
        var tkhdVersion = view.getUint8(tkhd.payloadStart);
        var trackIdPosition = tkhd.payloadStart + (tkhdVersion === 1 ? 20 : 12);
        if (trackIdPosition + 4 <= tkhd.end) trackId = view.getUint32(trackIdPosition);
      }
      var handlerType = hdlr && hdlr.payloadStart + 12 <= hdlr.end
        ? readType(view, hdlr.payloadStart + 8)
        : '';
      if (timescale > 0) tracks.push({ handlerType: handlerType, timescale: timescale, trackId: trackId });
    }
    return tracks;
  }

  function parseMp4FragmentTimestamp(data, expectedTrackId) {
    var view = mp4DataView(data);
    if (!view) return null;
    var moof = mp4BoxOfType(mp4Boxes(view, 0, view.byteLength), 'moof');
    if (!moof) return null;
    var trafs = mp4Boxes(view, moof.payloadStart, moof.end).filter(function (box) { return box.type === 'traf'; });
    for (var i = 0; i < trafs.length; i++) {
      var children = mp4Boxes(view, trafs[i].payloadStart, trafs[i].end);
      var tfhd = mp4BoxOfType(children, 'tfhd');
      var tfdt = mp4BoxOfType(children, 'tfdt');
      var trun = mp4BoxOfType(children, 'trun');
      if (!tfdt || tfdt.payloadStart + 8 > tfdt.end) continue;
      var trackId = tfhd && tfhd.payloadStart + 8 <= tfhd.end ? view.getUint32(tfhd.payloadStart + 4) : 0;
      if (expectedTrackId && trackId && trackId !== expectedTrackId) continue;
      var tfdtVersion = view.getUint8(tfdt.payloadStart);
      var decodeTime = tfdtVersion === 1
        ? mp4Uint64Number(view, tfdt.payloadStart + 4)
        : view.getUint32(tfdt.payloadStart + 4);
      if (!isFinite(decodeTime)) continue;
      var compositionOffset = 0;
      if (trun && trun.payloadStart + 12 <= trun.end) {
        var trunVersion = view.getUint8(trun.payloadStart);
        var flags = view.getUint32(trun.payloadStart) & 0xffffff;
        var sampleCount = view.getUint32(trun.payloadStart + 4);
        var cursor = trun.payloadStart + 8;
        if (flags & 0x000001) cursor += 4;
        if (flags & 0x000004) cursor += 4;
        if (sampleCount > 0) {
          if (flags & 0x000100) cursor += 4;
          if (flags & 0x000200) cursor += 4;
          if (flags & 0x000400) cursor += 4;
          if ((flags & 0x000800) && cursor + 4 <= trun.end) {
            compositionOffset = trunVersion === 1 ? view.getInt32(cursor) : view.getUint32(cursor);
          }
        }
      }
      return {
        trackId: trackId,
        decodeTime: decodeTime,
        compositionOffset: compositionOffset,
        presentationTime: decodeTime + compositionOffset
      };
    }
    return null;
  }

  function hlsTrackKind(provider, track) {
    return track && track !== provider && track.kind === 'audio' ? 'audio' : 'video';
  }

  function hlsTrackInitialTimestampGenerationKey(provider, track) {
    var segments = track && track.segments ? track.segments : (track === provider ? provider.segments : []);
    return segments && segments.length ? segments[0]._hlsTimestampGenerationKey || '' : '';
  }

  function hlsInitTimescaleKey(kind, initSegment, generationKey) {
    return kind + ':' + hlsInitSegmentKey(initSegment) + (generationKey ? ':generation=' + generationKey : '');
  }

  function recordHlsInitTimescale(provider, track, initSegment, data, generationKey) {
    if (!provider || !track || !initSegment || !data) return null;
    var kind = hlsTrackKind(provider, track);
    var wantedHandler = kind === 'audio' ? 'soun' : 'vide';
    var tracks = parseMp4InitTrackInfo(data);
    var selected = tracks.find(function (item) { return item.handlerType === wantedHandler; }) || tracks[0] || null;
    if (!selected || !selected.timescale) {
      provider.hlsInitTimescaleParseFailureCount = (provider.hlsInitTimescaleParseFailureCount || 0) + 1;
      return null;
    }
    provider.hlsInitTimescaleByKey = provider.hlsInitTimescaleByKey || {};
    provider.hlsInitTrackInfoByKey = provider.hlsInitTrackInfoByKey || {};
    provider.hlsInitTimescaleByKey[hlsInitTimescaleKey(kind, initSegment, generationKey)] = selected;
    provider.hlsInitTrackInfoByKey[hlsInitTimescaleKey(kind, initSegment, generationKey)] = tracks;
    track._hlsMediaTimescale = selected.timescale;
    track._hlsMediaTrackId = selected.trackId || 0;
    return selected;
  }

  function appendHlsInitBuffer(provider, track, sb, initSegment, data, generationKey, guard) {
    generationKey = generationKey || hlsTrackInitialTimestampGenerationKey(provider, track);
    if (guard) guard();
    var decrypt = provider && provider._decryptHlsInitIfNeeded
      ? provider._decryptHlsInitIfNeeded(initSegment, data)
      : Promise.resolve(data);
    return decrypt.then(function (plainData) {
      if (guard) guard();
      recordHlsInitTimescale(provider, track, initSegment, plainData, generationKey);
      return appendBuffer(sb, plainData, null, undefined, guard);
    });
  }

  function hlsTrackTimestampInfo(provider, track, initSegment, generationKey) {
    var kind = hlsTrackKind(provider, track);
    var explicitInitSegment = !!initSegment;
    initSegment = initSegment || (kind === 'audio'
      ? (track && track.initSegment) || provider.audioInitSegment
      : provider.initSegment);
    var cached = provider.hlsInitTimescaleByKey
      ? provider.hlsInitTimescaleByKey[hlsInitTimescaleKey(kind, initSegment, generationKey)]
      : null;
    if (cached) return cached;
    // A track-level value describes only the most recently appended init. It
    // must not leak across an explicit EXT-X-MAP boundary whose init has not
    // been parsed yet.
    if (!explicitInitSegment && track && track._hlsMediaTimescale) {
      return { timescale: track._hlsMediaTimescale, trackId: track._hlsMediaTrackId || 0 };
    }
    return null;
  }

  function setHlsTrackEpochTimestampOffset(track, epochId, offset) {
    var segments = track && track.segments ? track.segments : [];
    for (var i = 0; i < segments.length; i++) {
      if (segments[i]._hlsPlaylistEpoch !== epochId) continue;
      segments[i]._hlsEpochTimestampOffset = offset;
      var parts = segments[i].parts || [];
      for (var p = 0; p < parts.length; p++) parts[p]._hlsEpochTimestampOffset = offset;
    }
  }

  function setHlsTrackGenerationTimestampOffset(track, generationKey, offset) {
    var segments = track && track.segments ? track.segments : [];
    for (var i = 0; i < segments.length; i++) {
      if (segments[i]._hlsTimestampGenerationKey !== generationKey) continue;
      segments[i]._hlsTimestampOffset = offset;
      var parts = segments[i].parts || [];
      for (var p = 0; p < parts.length; p++) parts[p]._hlsTimestampOffset = offset;
    }
  }

  function hlsFmp4TimestampOffset(provider, track, seg, data) {
    // timestampOffset is sticky on SourceBuffer, so normal CMAF fragments must
    // explicitly establish their own mapping after every timestamp generation.
    // Derive it from the fragment's tfdt/first composition time; media sequence
    // and target duration are delivery coordinates, not the embedded media clock.
    if (!seg) return 0;
    var parent = seg._parentSegment || seg;
    var playlistUrl = seg._hlsPlaylistUrl || parent._hlsPlaylistUrl || '';
    var generationKey = seg._hlsTimestampGenerationKey || parent._hlsTimestampGenerationKey || '';
    var generation = provider && provider.hlsTimestampGenerationByKey && generationKey
      ? provider.hlsTimestampGenerationByKey[generationKey]
      : null;
    var epoch = provider && provider.playlistEpochByUrl
      ? provider.playlistEpochByUrl[String(playlistUrl)]
      : null;
    var timestampState = generation || (seg._hlsPlaylistEpoch ? epoch : null);
    if (!timestampState) return 0;
    if (timestampState.mediaTimestampResolved && isFinite(timestampState.mediaTimestampOffset)) {
      seg._hlsTimestampOffset = timestampState.mediaTimestampOffset;
      if (seg._hlsPlaylistEpoch) seg._hlsEpochTimestampOffset = timestampState.mediaTimestampOffset;
      return timestampState.mediaTimestampOffset;
    }
    var initSegment = provider ? hlsSegmentInitSegment(provider, track, seg) : null;
    var initInfo = provider ? hlsTrackTimestampInfo(provider, track, initSegment, generationKey) : null;
    var timing = initInfo ? parseMp4FragmentTimestamp(data, initInfo.trackId) : null;
    if (initInfo && timing && isFinite(seg.start) && isFinite(timing.presentationTime)) {
      var presentationTime = timing.presentationTime / initInfo.timescale;
      var offset = seg.start - presentationTime;
      if (isFinite(offset)) {
        timestampState.mediaTimestampOffset = offset;
        timestampState.mediaTimestampResolved = true;
        if (generation) setHlsTrackGenerationTimestampOffset(track, generationKey, offset);
        if (epoch) {
          epoch.mediaTimestampOffset = offset;
          epoch.mediaTimestampResolved = true;
        }
        seg._hlsTimestampOffset = offset;
        seg._hlsEpochTimestampOffset = offset;
        if (!generation && seg._hlsPlaylistEpoch) {
          setHlsTrackEpochTimestampOffset(track, seg._hlsPlaylistEpoch, offset);
        }
        provider.hlsFragmentTimestampParseCount = (provider.hlsFragmentTimestampParseCount || 0) + 1;
        if (generation) {
          provider.hlsTimestampGenerationResolutionCount = (provider.hlsTimestampGenerationResolutionCount || 0) + 1;
          if (generation.discontinuity) {
            provider.hlsDiscontinuityTimestampResolutionCount = (provider.hlsDiscontinuityTimestampResolutionCount || 0) + 1;
          }
          provider.lastHlsTimestampGenerationKey = generationKey;
        }
        provider.lastHlsFragmentDecodeTime = timing.decodeTime / initInfo.timescale;
        provider.lastHlsFragmentTimestampOffset = offset;
        return offset;
      }
    }
    if (generation) {
      if (provider) provider.hlsTimestampResolutionFailureCount = (provider.hlsTimestampResolutionFailureCount || 0) + 1;
      var unresolved = new Error('hls-timestamp-unresolved');
      unresolved.code = 'HLS_TIMESTAMP_UNRESOLVED';
      unresolved.generationKey = generationKey;
      throw unresolved;
    }
    if (provider && !timestampState.mediaTimestampFallbackRecorded) {
      provider.hlsFragmentTimestampFallbackCount = (provider.hlsFragmentTimestampFallbackCount || 0) + 1;
      timestampState.mediaTimestampFallbackRecorded = true;
      if (generation && generation.discontinuity) {
        provider.hlsDiscontinuityTimestampFallbackCount = (provider.hlsDiscontinuityTimestampFallbackCount || 0) + 1;
      }
    }
    var fallback = isFinite(seg._hlsEpochManifestOffset)
      ? seg._hlsEpochManifestOffset
      : (epoch && seg._hlsPlaylistEpoch && isFinite(epoch.timelineOffset)
        ? epoch.timelineOffset
        : (generation && generation.discontinuity && isFinite(generation.boundaryStart)
          ? generation.boundaryStart
          : 0));
    seg._hlsTimestampOffset = fallback;
    seg._hlsEpochTimestampOffset = fallback;
    return fallback;
  }

  function hlsLiveTimestampOffset(provider, track, seg) {
    if (!provider || !provider.live || !track || !seg) return NaN;
    if (!isFinite(seg.start) || seg.start < 0) return NaN;
    return seg.start;
  }

  function sourceBufferContainsSegment(sb, seg) {
    if (!sb || !sb.buffered || !seg || !isFinite(seg.start) || !isFinite(seg.end)) return false;
    var probe = Math.max(seg.start, seg.end - 0.1);
    return bufferedContains(sb.buffered, probe);
  }

  function sourceBufferCoversSegment(sb, seg) {
    if (!sb || !sb.buffered || !seg || !isFinite(seg.start) || !isFinite(seg.end)) return false;
    for (var i = 0; i < sb.buffered.length; i++) {
      if (
        sb.buffered.start(i) <= seg.start + 0.05
        && sb.buffered.end(i) >= seg.end - 0.05
      ) return true;
    }
    return false;
  }

  function hlsAppendTransactionBuffered(provider, track, seg, transaction) {
    if (!hlsAppendTransactionIsCurrent(provider, transaction)) return false;
    if (!sourceBufferContainsSegment(transaction.primarySourceBuffer, seg)) return false;
    if (transaction.muxed && !sourceBufferContainsSegment(transaction.audioSourceBuffer, seg)) return false;
    return true;
  }

  function hlsAppendSegmentWithWatchdog(provider, track, seg, data, appendTransaction) {
    appendTransaction = appendTransaction || createHlsAppendTransaction(provider, track, seg);
    var append = provider._appendSegmentData(track, seg, data, appendTransaction);
    return new Promise(function (resolve, reject) {
      var done = false;
      var timeoutId = setTimeout(function () {
        if (done) return;
        done = true;
        if (hlsAppendTransactionBuffered(provider, track, seg, appendTransaction)) {
          if (appendTransaction.muxed) {
            provider.hlsMuxedWatchdogCompletionCount = (provider.hlsMuxedWatchdogCompletionCount || 0) + 1;
          }
          resolve();
        } else {
          try {
            assertHlsAppendTransactionCurrent(provider, appendTransaction);
            reject(new Error('hls-append-timeout'));
          } catch (err) {
            reject(err);
          }
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
    return (provider && provider.bandwidth) || abr.defaultBandwidthEstimate || DEFAULT_BANDWIDTH_ESTIMATE;
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
    quiesce: NativeUrlProvider.prototype.quiesce,
    getStats: NativeUrlProvider.prototype.getStats,
    _onRuntimeError: NativeUrlProvider.prototype._onRuntimeError,
    resumeAfterServerRecovery: NativeUrlProvider.prototype.resumeAfterServerRecovery,
    isLive: NativeUrlProvider.prototype.isLive,
    getBufferedInfo: NativeUrlProvider.prototype.getBufferedInfo,
    getVariantTracks: NativeUrlProvider.prototype.getVariantTracks,
    getActiveVariantTrack: NativeUrlProvider.prototype.getActiveVariantTrack,
    getAudioTracks: NativeUrlProvider.prototype.getAudioTracks,
    getActiveAudioTrack: NativeUrlProvider.prototype.getActiveAudioTrack
  };
  window.NativeDashProviderForTest = {
    _open: NativeDashProvider.prototype._open,
    quiesce: NativeDashProvider.prototype.quiesce,
    _maybeEndVodStream: NativeDashProvider.prototype._maybeEndVodStream,
    _candidateVideos: NativeDashProvider.prototype._candidateVideos,
    _chooseForBudget: NativeDashProvider.prototype._chooseForBudget,
    _appendSegmentData: NativeDashProvider.prototype._appendSegmentData,
    _handleAppendFailure: NativeDashProvider.prototype._handleAppendFailure,
    _completeNativeRuntimeTerminal: NativeDashProvider.prototype._completeNativeRuntimeTerminal,
    _tryNativeRecovery: NativeDashProvider.prototype._tryNativeRecovery,
    _reconcileSourceBufferConfiguration: NativeDashProvider.prototype._reconcileSourceBufferConfiguration,
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
    _recoverMediaRequest: NativeDashProvider.prototype._recoverMediaRequest,
    _drainAppendQueue: NativeDashProvider.prototype._drainAppendQueue,
    createDashAppendTransaction: createDashAppendTransaction,
    dashAppendTransactionIsCurrent: dashAppendTransactionIsCurrent,
    assertDashAppendTransactionCurrent: assertDashAppendTransactionCurrent,
    beginDashControlTransition: beginDashControlTransition,
    dashControlTransitionIsCurrent: dashControlTransitionIsCurrent,
    assertDashControlTransitionCurrent: assertDashControlTransitionCurrent,
    invalidateDashControlTransition: invalidateDashControlTransition,
    markDashSourceBufferConfigurationMutation: markDashSourceBufferConfigurationMutation,
    queueDashSourceBufferConfigurationReconciliation: queueDashSourceBufferConfigurationReconciliation,
    commitDashSourceBufferConfiguration: commitDashSourceBufferConfiguration,
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
    _jumpManifestGap: NativeDashProvider.prototype._jumpManifestGap,
    _refreshManifest: NativeDashProvider.prototype._refreshManifest,
    _refreshPlaybackManifest: NativeDashProvider.prototype._refreshPlaybackManifest,
    _updateLiveWindowFromReps: NativeDashProvider.prototype._updateLiveWindowFromReps,
    _updateLivePositionStats: NativeDashProvider.prototype._updateLivePositionStats,
    _evictExpiredLiveSegmentState: NativeDashProvider.prototype._evictExpiredLiveSegmentState,
    _switchVideo: NativeDashProvider.prototype._switchVideo,
    _switchAudio: NativeDashProvider.prototype._switchAudio,
    _maybeSwitchAuto: NativeDashProvider.prototype._maybeSwitchAuto,
    _flushPendingVideoSwitch: NativeDashProvider.prototype._flushPendingVideoSwitch,
    _flushPendingDashControlTransition: NativeDashProvider.prototype._flushPendingDashControlTransition,
    _recordBandwidthSample: NativeDashProvider.prototype._recordBandwidthSample,
    _sampleFramePressure: sampleFramePressure,
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
    _completeSeekBuffer: NativeDashProvider.prototype._completeSeekBuffer,
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
    _open: NativeHlsProvider.prototype._open,
    quiesce: NativeHlsProvider.prototype.quiesce,
    _applyTrackLifecycle: NativeHlsProvider.prototype._applyTrackLifecycle,
    _reconcileTrackLifecycle: NativeHlsProvider.prototype._reconcileTrackLifecycle,
    _transitionTrackSourceBuffer: NativeHlsProvider.prototype._transitionTrackSourceBuffer,
    _restoreTrackSourceBuffer: NativeHlsProvider.prototype._restoreTrackSourceBuffer,
    _appendTrackInitIfNeeded: NativeHlsProvider.prototype._appendTrackInitIfNeeded,
    _beginTrackTransition: NativeHlsProvider.prototype._beginTrackTransition,
    _isTrackTransitionCurrent: NativeHlsProvider.prototype._isTrackTransitionCurrent,
    _ownsTrackTransition: NativeHlsProvider.prototype._ownsTrackTransition,
    _finishTrackTransition: NativeHlsProvider.prototype._finishTrackTransition,
    _cancelTrackTransitionForViewerIntent: NativeHlsProvider.prototype._cancelTrackTransitionForViewerIntent,
    _rollbackTrackTransition: NativeHlsProvider.prototype._rollbackTrackTransition,
    _flushPendingTrackSwitch: NativeHlsProvider.prototype._flushPendingTrackSwitch,
    _tick: NativeHlsProvider.prototype._tick,
    _scheduleMediaRequests: NativeHlsProvider.prototype._scheduleMediaRequests,
    _startSegmentFetch: NativeHlsProvider.prototype._startSegmentFetch,
    _drainAppendQueue: NativeHlsProvider.prototype._drainAppendQueue,
    _syncPresentationState: NativeHlsProvider.prototype._syncPresentationState,
    _maybeEndVodStream: NativeHlsProvider.prototype._maybeEndVodStream,
    _prepareDiscontinuityAppend: NativeHlsProvider.prototype._prepareDiscontinuityAppend,
    _refreshHlsGenerationInit: NativeHlsProvider.prototype._refreshHlsGenerationInit,
    _appendSegmentData: NativeHlsProvider.prototype._appendSegmentData,
    _appendTransmuxedOutput: NativeHlsProvider.prototype._appendTransmuxedOutput,
    _recoverQuota: NativeHlsProvider.prototype._recoverQuota,
    createHlsAppendTransaction: createHlsAppendTransaction,
    invalidateHlsAppendTransactions: invalidateHlsAppendTransactions,
    hlsAppendTransactionIsCurrent: hlsAppendTransactionIsCurrent,
    hlsRecoveryTransactionIsCurrent: hlsRecoveryTransactionIsCurrent,
    hlsAppendSegmentWithWatchdog: hlsAppendSegmentWithWatchdog,
    _handleAppendFailure: NativeHlsProvider.prototype._handleAppendFailure,
    _handleFatal: NativeHlsProvider.prototype._handleFatal,
    _completeNativeRuntimeTerminal: NativeHlsProvider.prototype._completeNativeRuntimeTerminal,
    _tryNativeRecovery: NativeHlsProvider.prototype._tryNativeRecovery,
    _probeCapabilities: NativeHlsProvider.prototype._probeCapabilities,
    _isCapabilityAllowed: NativeHlsProvider.prototype._isCapabilityAllowed,
    _candidateVariants: NativeHlsProvider.prototype._candidateVariants,
    _chooseForBudget: NativeHlsProvider.prototype._chooseForBudget,
    _lowerVariant: NativeHlsProvider.prototype._lowerVariant,
    _chooseAudioRendition: NativeHlsProvider.prototype._chooseAudioRendition,
    _fetchRange: NativeHlsProvider.prototype._fetchRange,
    _decryptHlsInitIfNeeded: NativeHlsProvider.prototype._decryptHlsInitIfNeeded,
    _decryptHlsResourceIfNeeded: NativeHlsProvider.prototype._decryptHlsResourceIfNeeded,
    _fetchHlsKey: NativeHlsProvider.prototype._fetchHlsKey,
    _fetchPlaylistText: NativeHlsProvider.prototype._fetchPlaylistText,
    _loadStartupMediaPlaylists: NativeHlsProvider.prototype._loadStartupMediaPlaylists,
    _loadMediaPlaylist: NativeHlsProvider.prototype._loadMediaPlaylist,
    _loadAudioPlaylist: NativeHlsProvider.prototype._loadAudioPlaylist,
    selectAudioTrack: NativeHlsProvider.prototype.selectAudioTrack,
    _refreshMediaPlaylist: NativeHlsProvider.prototype._refreshMediaPlaylist,
    _recoverMediaRequest: NativeHlsProvider.prototype._recoverMediaRequest,
    _fetchReloadPlaylist: NativeHlsProvider.prototype._fetchReloadPlaylist,
    _playlistRefreshDelay: NativeHlsProvider.prototype._playlistRefreshDelay,
    hlsBlockingReloadUrl: hlsBlockingReloadUrl,
    hlsDeliveryCursor: hlsDeliveryCursor,
    acceptHlsPlaylistCursor: acceptHlsPlaylistCursor,
    applyHlsPlaylistEpoch: applyHlsPlaylistEpoch,
    assignHlsTimestampGenerations: assignHlsTimestampGenerations,
    pruneHlsTimestampGenerations: pruneHlsTimestampGenerations,
    detectHlsMediaContainer: detectHlsMediaContainer,
    parseMp4InitTrackInfo: parseMp4InitTrackInfo,
    parseMp4FragmentTimestamp: parseMp4FragmentTimestamp,
    recordHlsInitTimescale: recordHlsInitTimescale,
    hlsPlayableSegments: hlsPlayableSegments,
    reconcileHlsPreloadHints: reconcileHlsPreloadHints,
    mergeSegmentState: mergeSegmentState,
    nextFetchedSegmentForAppend: nextFetchedSegmentForAppend,
    _recordServiceWorkerFetch: NativeHlsProvider.prototype._recordServiceWorkerFetch,
    _recordBandwidthSample: NativeHlsProvider.prototype._recordBandwidthSample,
    _sampleFramePressure: sampleFramePressure,
    _recordOfflineHttpError: NativeHlsProvider.prototype._recordOfflineHttpError,
    _drainAppendQueue: NativeHlsProvider.prototype._drainAppendQueue,
    _ensureTsTransmuxer: NativeHlsProvider.prototype._ensureTsTransmuxer,
    _transmuxTsSegment: NativeHlsProvider.prototype._transmuxTsSegment,
    _jumpSmallGap: NativeHlsProvider.prototype._jumpSmallGap,
    _jumpManifestGap: NativeHlsProvider.prototype._jumpManifestGap,
    reportStall: NativeHlsProvider.prototype.reportStall,
    chooseVariant: NativeHlsProvider.prototype.chooseVariant,
    _switchVariant: NativeHlsProvider.prototype._switchVariant,
    getVariantTracks: NativeHlsProvider.prototype.getVariantTracks,
    selectVariantTrack: NativeHlsProvider.prototype.selectVariantTrack,
    _flushPendingVariantSwitch: NativeHlsProvider.prototype._flushPendingVariantSwitch,
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
    _completeSeekBuffer: NativeHlsProvider.prototype._completeSeekBuffer,
    _onSeek: NativeHlsProvider.prototype._onSeek,
    _clampSeekTarget: NativeHlsProvider.prototype._clampSeekTarget,
    _seekBufferGoal: NativeHlsProvider.prototype._seekBufferGoal,
    _startupBufferGoal: NativeHlsProvider.prototype._startupBufferGoal,
    _bufferAheadGoal: NativeHlsProvider.prototype._bufferAheadGoal,
    _bufferBehindGoal: NativeHlsProvider.prototype._bufferBehindGoal,
    _targetLiveLatency: NativeHlsProvider.prototype._targetLiveLatency,
    _defaultLiveStartTime: NativeHlsProvider.prototype._defaultLiveStartTime,
    _updateLivePositionStats: NativeHlsProvider.prototype._updateLivePositionStats,
    _checkBufferMilestones: NativeHlsProvider.prototype._checkBufferMilestones,
    _abortRequests: NativeHlsProvider.prototype._abortRequests,
    getStats: NativeHlsProvider.prototype.getStats
  };
  window.NativePlayerSourceBufferForTest = {
    append: appendBuffer,
    clear: clearSourceBuffer,
    reset: resetSourceBuffer,
    removeBefore: removeBufferBefore,
    removeAfter: removeBufferAfter,
    removeRange: removeBufferRange
  };
  window.NativeTsTransmuxerForTest = {
    demuxMpegTs: demuxMpegTs,
    FirstPartyTsTransmuxerAdapter: FirstPartyTsTransmuxerAdapter,
    normalizeHlsTsDemuxTimestamps: normalizeHlsTsDemuxTimestamps,
    prepareHlsTsTransmuxContext: prepareHlsTsTransmuxContext
  };
})();
