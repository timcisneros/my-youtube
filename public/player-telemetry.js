// Generated optional telemetry feature chunk from native-player-engine.js.
(function () {
  'use strict';
  function isOnline() {
    return !('navigator' in window) || !('onLine' in navigator) || navigator.onLine;
  }
  function merge(target, src) {
    for (var key in src) {
      if (!Object.prototype.hasOwnProperty.call(src, key)) continue;
      if (src[key] && typeof src[key] === 'object' && !Array.isArray(src[key])) {
        if (!target[key]) target[key] = {};
        merge(target[key], src[key]);
      } else {
        target[key] = src[key];
      }
    }
    return target;
  }
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

  window.PlayerTelemetry = PlayerTelemetry;
})();
