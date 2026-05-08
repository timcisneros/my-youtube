import { test, expect } from '@playwright/test';

async function setPlayerContent(page, html) {
  await page.setContent(html);
  await page.addScriptTag({ path: 'public/native-player-engine.js' });
}

test('watch page loads native player without eager-loading Shaka', async ({ request }) => {
  const login = await request.post('/auth/free', { maxRedirects: 0 });
  expect(login.status()).toBeGreaterThanOrEqual(300);
  expect(login.status()).toBeLessThan(400);

  const watch = await request.get('/watch?v=dQw4w9WgXcQ');
  expect(watch.status()).toBe(200);
  const html = await watch.text();

  expect(html).toContain('/native-player-engine.js');
  expect(html).not.toContain('/vendor/shaka/shaka-player.compiled.js');
});

test('native engine lazy-loads Shaka only when fallback is requested', async ({ page }) => {
  const shakaRequests = [];
  await page.route('**/api/stream/TESTVIDEO01/dash.mpd**', route => {
    route.fulfill({
      status: 200,
      contentType: 'application/dash+xml',
      body: '<?xml version="1.0"?><MPD type="static" mediaPresentationDuration="PT1S"><Period></Period></MPD>',
    });
  });
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: [
        'window.shaka={};',
        'shaka.polyfill={installAll:function(){}};',
        'shaka.Player=function(){this.attach=function(){return Promise.resolve()};this.configure=function(){};this.addEventListener=function(){};this.load=function(){return Promise.resolve()};this.getVariantTracks=function(){return[]};this.destroy=function(){return Promise.resolve()};};',
        'shaka.Player.isBrowserSupported=function(){return true};',
        'shaka.net={NetworkingEngine:{PluginPriority:{APPLICATION:1},registerScheme:function(){}}};',
        'shaka.util={Error:{Severity:{RECOVERABLE:1},Category:{NETWORK:1},Code:{OPERATION_ABORTED:1}},AbortableOperation:function(promise){return promise}};',
      ].join(''),
    });
  });

  const logs = [];
  page.on('console', msg => logs.push(msg.text()));
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  await page.evaluate(() => {
    const video = document.getElementById('player');
    const engine = new window.PlayerEngine(video, { videoId: 'TESTVIDEO01', streamToken: 'test-token' });
    window.__engine = engine;
    return engine.init().then(() => engine.load());
  });

  expect(shakaRequests.length).toBe(1);
  expect(await page.evaluate(() => window._playerProvider)).toBe('shaka-fallback');
  expect(logs.some(line => line.includes('falling back to shaka: reason=dash-no-supported-video'))).toBe(true);
});

test('offline cached MPD stays on native path instead of Shaka fallback', async ({ page }) => {
  const shakaRequests = [];
  await page.route('**/api/stream/OFFLINE01/dash.mpd**', route => {
    route.fulfill({
      status: 200,
      contentType: 'application/dash+xml',
      headers: {
        'X-SW-Cached': '1',
        'X-SW-Offline': '1',
        'X-SW-Source': 'offline-bundle',
      },
      body: '<?xml version="1.0"?><MPD type="static" mediaPresentationDuration="PT1S"><Period></Period></MPD>',
    });
  });
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.abort();
  });

  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const result = await page.evaluate(() => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
    const video = document.getElementById('player');
    const engine = new window.PlayerEngine(video, { videoId: 'OFFLINE01', streamToken: 'test-token' });
    window.__engine = engine;
    return engine.init()
      .then(() => engine.load())
      .then(() => ({ ok: true, stats: engine.getPlayer().getStats() }))
      .catch(err => ({ ok: false, message: err.message, stats: engine.getPlayer().getStats(), provider: window._playerProvider }));
  });

  expect(result.ok).toBe(false);
  expect(result.message).toBe('dash-no-supported-video');
  expect(result.provider).toBe('native-dash');
  expect(result.stats.offlinePlayback).toBe(true);
  expect(result.stats.manifestFromServiceWorker).toBe(true);
  expect(result.stats.lastOfflineError).toBe('dash-no-supported-video');
  expect(shakaRequests).toHaveLength(0);
});

test('native engine decodes inline data MPD without fetch fallback', async ({ page }) => {
  const dataFetches = [];
  const shakaRequests = [];
  await page.route('data:**', route => {
    dataFetches.push(route.request().url());
    route.abort();
  });
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: [
        'window.shaka={};',
        'shaka.polyfill={installAll:function(){}};',
        'shaka.Player=function(){this.attach=function(){return Promise.resolve()};this.configure=function(){};this.addEventListener=function(){};this.load=function(){return Promise.resolve()};this.getVariantTracks=function(){return[]};this.destroy=function(){return Promise.resolve()};};',
        'shaka.Player.isBrowserSupported=function(){return true};',
        'shaka.net={NetworkingEngine:{PluginPriority:{APPLICATION:1},registerScheme:function(){}}};',
        'shaka.util={Error:{Severity:{RECOVERABLE:1},Category:{NETWORK:1},Code:{OPERATION_ABORTED:1}},AbortableOperation:function(promise){return promise}};',
      ].join(''),
    });
  });

  const logs = [];
  page.on('console', msg => logs.push(msg.text()));
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const result = await page.evaluate(() => {
    const mpd = '<?xml version="1.0"?><MPD type="static" mediaPresentationDuration="PT1S"><Period></Period></MPD>';
    const dataUrl = 'data:application/dash+xml;base64,' + btoa(mpd);
    const video = document.getElementById('player');
    const engine = new window.PlayerEngine(video, { videoId: 'TESTVIDEO01', streamToken: 'test-token' });
    return engine.init()
      .then(() => engine.load(dataUrl))
      .then(() => 'resolved')
      .catch(err => err.message);
  });

  expect(result).toBe('resolved');
  expect(dataFetches.length).toBe(0);
  expect(shakaRequests.length).toBe(1);
  expect(logs.some(line => line.includes('falling back to shaka: reason=dash-no-supported-video'))).toBe(true);
  expect(logs.some(line => line.includes('falling back to shaka: reason=Failed to fetch'))).toBe(false);
});

test('native DASH stats expose service-worker segment cache hits and misses', async ({ page }) => {
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  await page.route('**/api/stream/OFFLINE02/fmt/137**', route => {
    route.fulfill({
      status: 206,
      contentType: 'video/mp4',
      headers: {
        'X-SW-Cached': '1',
        'X-SW-Offline': '1',
        'X-SW-Source': 'idb',
        'Content-Range': 'bytes 0-3/4',
      },
      body: Buffer.from([0, 1, 2, 3]),
    });
  });
  await page.route('**/api/stream/OFFLINE02/fmt/140**', route => {
    route.fulfill({
      status: 503,
      headers: {
        'X-SW-Cached': '0',
        'X-SW-Offline': '1',
        'X-SW-Source': 'miss',
      },
      body: '',
    });
  });

  const stats = await page.evaluate(async () => {
    const video = document.getElementById('player');
    const engine = new window.PlayerEngine(video, { videoId: 'OFFLINE02', streamToken: 'test-token' });
    const provider = {
      engine,
      video,
      controllers: [],
      requestGeneration: 0,
      segmentCacheHitCount: 0,
      segmentCacheMissCount: 0,
      lastOfflineError: '',
      name: 'native-dash',
      bandwidth: 0,
      activeRanges: {},
      audioReps: [],
      textReps: [],
      unsupportedVideoCount: 0,
      unsupportedAudioCount: 0,
      rebufferCount: 0,
      rebufferDuration: 0,
      recoveryCount: 0,
      lastHttpStatus: 0,
      gapJumpCount: 0,
      lastGapSize: 0,
      capabilityProbeCount: 0,
      unsupportedCapabilityCount: 0,
      startupBufferComplete: false,
      mediaFetchCompletedCount: 0,
      mediaFetchTotalMs: 0,
      manifestCompatibilityWarnings: [],
      getActiveVariantTrack: () => null,
    };
    await window.NativeDashProviderForTest._fetchRange.call(provider, '/api/stream/OFFLINE02/fmt/137', { start: 0, end: 3 }, { measureBandwidth: false });
    await window.NativeDashProviderForTest._fetchRange.call(provider, '/api/stream/OFFLINE02/fmt/140', { start: 0, end: 3 }, { measureBandwidth: false, attempts: 1 }).catch(() => {});
    return window.NativeDashProviderForTest.getStats.call(provider);
  });

  expect(stats.offlinePlayback).toBe(true);
  expect(stats.segmentCacheHitCount).toBe(1);
  expect(stats.segmentCacheMissCount).toBe(1);
  expect(stats.lastOfflineError).toBe('offline-segment-http-503');
  expect(stats.lastHttpStatus).toBe(503);
});

test('native HLS stats expose service-worker manifest and segment cache state', async ({ page }) => {
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  await page.route('**/api/stream/HLSOFFLINE01/hls.m3u8**', route => {
    route.fulfill({
      status: 200,
      contentType: 'application/vnd.apple.mpegurl',
      headers: {
        'X-SW-Cached': '1',
        'X-SW-Offline': '1',
        'X-SW-Source': 'app-shell',
      },
      body: '#EXTM3U\n#EXT-X-ENDLIST',
    });
  });
  await page.route('**/api/stream/HLSOFFLINE01/hls-proxy?u=hit**', route => {
    route.fulfill({
      status: 206,
      contentType: 'video/mp4',
      headers: {
        'X-SW-Cached': '1',
        'X-SW-Offline': '1',
        'X-SW-Source': 'segment-cache',
        'Content-Range': 'bytes 0-3/4',
      },
      body: Buffer.from([0, 1, 2, 3]),
    });
  });
  await page.route('**/api/stream/HLSOFFLINE01/hls-proxy?u=miss**', route => {
    route.fulfill({
      status: 503,
      headers: {
        'X-SW-Cached': '0',
        'X-SW-Offline': '1',
        'X-SW-Source': 'miss',
      },
      body: '',
    });
  });

  const stats = await page.evaluate(async () => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
    const video = document.getElementById('player');
    const engine = new window.PlayerEngine(video, { videoId: 'HLSOFFLINE01', streamToken: 'test-token' });
    const hls = window.NativeHlsProviderForTest;
    const provider = {
      engine,
      video,
      playlistUrl: '/api/stream/HLSOFFLINE01/hls.m3u8',
      name: 'native-hls',
      controllers: [],
      variants: [],
      audioRenditions: [],
      subtitleRenditions: [],
      bandwidth: 0,
      rebufferCount: 0,
      rebufferDuration: 0,
      recoveryCount: 0,
      appendFailures: 0,
      quotaRecoveries: 0,
      stallReports: 0,
      stallRecoveryStage: 0,
      gapJumpCount: 0,
      lastGapSize: 0,
      lastError: '',
      lastHttpStatus: 0,
      playlistRefreshCount: 0,
      mediaFetchCompletedCount: 0,
      mediaFetchRetryCount: 0,
      mediaFetchTotalMs: 0,
      mediaUrlRefreshCount: 0,
      segmentCacheHitCount: 0,
      segmentCacheMissCount: 0,
      lastOfflineError: '',
      lastServiceWorkerSource: '',
      schedulerBackpressureCount: 0,
      schedulerDrainCount: 0,
      startupBufferComplete: false,
      startupBufferMs: 0,
      lastSwitchReason: 'startup',
      liveLatency: 0,
      atLiveEdge: false,
      manifestCompatibilityWarnings: [],
      _recordServiceWorkerFetch: hls._recordServiceWorkerFetch,
      _recordOfflineHttpError: hls._recordOfflineHttpError,
      isLive: () => false,
      getActiveVariantTrack: () => null,
      getActiveAudioTrack: () => null,
      getAudioTracks: () => [],
      getLiveRange: () => null,
      _bufferAheadGoal: () => 2,
      _bufferBehindGoal: () => 30,
    };

    await hls._fetchPlaylistText.call(provider, '/api/stream/HLSOFFLINE01/hls.m3u8');
    await hls._fetchRange.call(provider, '/api/stream/HLSOFFLINE01/hls-proxy?u=hit', { start: 0, end: 3 }, { attempts: 1 });
    await hls._fetchRange.call(provider, '/api/stream/HLSOFFLINE01/hls-proxy?u=miss', { start: 0, end: 3 }, { attempts: 1 }).catch(() => {});
    return hls.getStats.call(provider);
  });

  expect(stats.offlinePlayback).toBe(true);
  expect(stats.manifestFromServiceWorker).toBe(true);
  expect(stats.segmentCacheHitCount).toBe(1);
  expect(stats.segmentCacheMissCount).toBe(1);
  expect(stats.lastOfflineError).toBe('offline-segment-http-503');
  expect(stats.lastHttpStatus).toBe(503);
  expect(stats.lastServiceWorkerSource).toBe('miss');
});

test('native adapter reports only the actual active track as HD state source', async ({ page }) => {
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const active = await page.evaluate(() => {
    const video = document.getElementById('player');
    const engine = new window.PlayerEngine(video, { videoId: 'TESTVIDEO01', streamToken: 'test-token' });
    const player = engine.getPlayer();
    engine._provider = {
      getVariantTracks() {
        return [
          { id: 'low', height: 360, active: true },
          { id: 'hd', height: 1080, active: false },
        ];
      },
      getActiveVariantTrack() {
        return { id: 'low', height: 360, active: true };
      },
    };
    return {
      activeTrack: player.getActiveVariantTrack(),
      tracks: player.getVariantTracks(),
    };
  });

  expect(active.activeTrack.height).toBe(360);
  expect(active.tracks.filter(track => track.active && track.height >= 720)).toHaveLength(0);
});

test('native startup chooses a non-fuzzy initial representation within bandwidth budget', async ({ page }) => {
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player" style="width:1280px;height:720px"></video>');

  const chosen = await page.evaluate(() => {
    const video = document.getElementById('player');
    const engine = new window.PlayerEngine(video, { videoId: 'TESTVIDEO01', streamToken: 'test-token' });
    engine.getPlayer().configure('abr.useNetworkInformation', false);
    const provider = {
      engine,
      video,
      blacklisted: {},
      manualTrackId: null,
      bandwidth: 3000000,
      videoReps: [
        { id: '144', height: 144, bandwidth: 80_000 },
        { id: '240', height: 240, bandwidth: 160_000 },
        { id: '360', height: 360, bandwidth: 320_000 },
        { id: '480', height: 480, bandwidth: 530_000 },
        { id: '720', height: 720, bandwidth: 990_000 },
        { id: '1080', height: 1080, bandwidth: 3_100_000 },
      ],
    };
    provider._candidateVideos = window.NativeDashProviderForTest._candidateVideos;
    provider._chooseForBudget = window.NativeDashProviderForTest._chooseForBudget;
    provider._viewportMaxHeight = window.NativeDashProviderForTest._viewportMaxHeight;
    provider.chooseVideoRep = window.NativeDashProviderForTest.chooseVideoRep;
    return provider.chooseVideoRep();
  });

  expect(chosen.height).toBe(720);
});

test('native DASH startup matches Shaka default ABR without a minimum-height floor', async ({ page }) => {
  await page.goto('/auth/login');
  await page.setContent('<div id="players"></div>');
  await page.addScriptTag({ path: 'public/native-player-engine.js' });
  await page.addScriptTag({ path: 'node_modules/shaka-player/dist/shaka-player.compiled.js' });

  const state = await page.evaluate(async () => {
    window.shaka.polyfill.installAll();
    const urls = [
      '/api/stream/PLAYERTEST1/dash.mpd',
      '/api/stream/PLAYERTEST1/dash.mpd?fixtureTemplate=timeline',
      '/api/stream/PLAYERTEST1/dash.mpd?fixtureSegmentList=range',
      '/api/stream/PLAYERTEST1/dash.mpd?fixtureLive=multiperiod',
    ];
    const results = [];
    for (const url of urls) {
      const nativeVideo = document.createElement('video');
      const shakaVideo = document.createElement('video');
      nativeVideo.muted = true;
      shakaVideo.muted = true;
      nativeVideo.setAttribute('playsinline', '');
      shakaVideo.setAttribute('playsinline', '');
      nativeVideo.style.cssText = 'width:1280px;height:720px';
      shakaVideo.style.cssText = 'width:1280px;height:720px';
      document.getElementById('players').replaceChildren(nativeVideo, shakaVideo);

      const engine = new window.PlayerEngine(nativeVideo, { videoId: 'PLAYERTEST1', streamToken: '' });
      await engine.init();
      await engine.load(url);
      const nativeTrack = engine.getPlayer().getActiveVariantTrack();

      const shakaPlayer = new window.shaka.Player();
      await shakaPlayer.attach(shakaVideo);
      shakaPlayer.configure({
        abr: { enabled: true, defaultBandwidthEstimate: 3000000, restrictions: {} },
        streaming: { bufferingGoal: 30, rebufferingGoal: 0.3, bufferBehind: 60 },
      });
      await shakaPlayer.load(url);
      const shakaTrack = shakaPlayer.getVariantTracks().find(track => track.active) || null;
      results.push({
        url,
        nativeHeight: nativeTrack && nativeTrack.height,
        shakaHeight: shakaTrack && shakaTrack.height,
        nativeRestrictions: engine.getPlayer().config.abr.restrictions,
      });

      await shakaPlayer.destroy();
      await engine.destroy();
    }
    return results;
  });

  for (const item of state) {
    expect(item.nativeRestrictions).toEqual({});
    expect(item.nativeHeight).toBe(item.shakaHeight);
  }
});

test('native DASH startup honors explicit minimum height before viewport fallback', async ({ page }) => {
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player" style="width:1280px;height:180px"></video>');

  const state = await page.evaluate(() => {
    const video = document.getElementById('player');
    const engine = new window.PlayerEngine(video, { videoId: 'TESTVIDEO01', streamToken: 'test-token' });
    engine.getPlayer().configure('abr.useNetworkInformation', false);
    engine.getPlayer().configure('abr.restrictions.minHeight', 360);
    const makeProvider = videoReps => {
      const provider = {
        engine,
        video,
        blacklisted: {},
        manualTrackId: null,
        bandwidth: 3000000,
        videoReps,
      };
      provider._candidateVideos = window.NativeDashProviderForTest._candidateVideos;
      provider._chooseForBudget = window.NativeDashProviderForTest._chooseForBudget;
      provider._viewportMaxHeight = window.NativeDashProviderForTest._viewportMaxHeight;
      provider.chooseVideoRep = window.NativeDashProviderForTest.chooseVideoRep;
      return provider;
    };
    const withFloor = makeProvider([
      { id: '240', height: 240, bandwidth: 350_000 },
      { id: '360', height: 360, bandwidth: 800_000 },
      { id: '720', height: 720, bandwidth: 1_800_000 },
    ]).chooseVideoRep();
    const belowFloorOnly = makeProvider([
      { id: '144', height: 144, bandwidth: 100_000 },
      { id: '240', height: 240, bandwidth: 350_000 },
    ]).chooseVideoRep();
    return {
      withFloorHeight: withFloor.height,
      belowFloorOnlyHeight: belowFloorOnly.height,
    };
  });

  expect(state.withFloorHeight).toBe(360);
  expect(state.belowFloorOnlyHeight).toBe(240);
});

test('native ABR uses viewport cap and measured bandwidth', async ({ page }) => {
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player" style="width:320px;height:180px"></video>');

  const state = await page.evaluate(() => {
    const video = document.getElementById('player');
    const engine = new window.PlayerEngine(video, { videoId: 'TESTVIDEO01', streamToken: 'test-token' });
    engine.getPlayer().configure('abr.useNetworkInformation', false);
    const provider = {
      engine,
      video,
      blacklisted: {},
      manualTrackId: null,
      bandwidth: 3000000,
      videoReps: [
        { id: '240', height: 240, bandwidth: 350_000 },
        { id: '360', height: 360, bandwidth: 800_000 },
        { id: '720', height: 720, bandwidth: 1_800_000 },
      ],
    };
    provider._candidateVideos = window.NativeDashProviderForTest._candidateVideos;
    provider._chooseForBudget = window.NativeDashProviderForTest._chooseForBudget;
    provider._viewportMaxHeight = window.NativeDashProviderForTest._viewportMaxHeight;
    provider.chooseVideoRep = window.NativeDashProviderForTest.chooseVideoRep;
    const viewportChoice = provider.chooseVideoRep();
    window.NativeDashProviderForTest._recordBandwidthSample.call(provider, 62_500, 1000);
    const lowBandwidthChoice = provider.chooseVideoRep();
    return {
      viewportHeight: viewportChoice.height,
      estimatedBandwidth: Math.round(provider.bandwidth),
      lowBandwidthHeight: lowBandwidthChoice.height,
    };
  });

  expect(state.viewportHeight).toBe(360);
  expect(state.estimatedBandwidth).toBeLessThan(3000000);
  expect(state.lowBandwidthHeight).toBe(360);
});

test('native ABR upgrades and downgrades with buffer-aware cooldown', async ({ page }) => {
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player" style="width:1280px;height:720px"></video>');

  const state = await page.evaluate(() => {
    const video = document.getElementById('player');
    const engine = new window.PlayerEngine(video, { videoId: 'TESTVIDEO01', streamToken: 'test-token' });
    let bufferAhead = 20;
    const provider = {
      engine,
      video,
      blacklisted: {},
      manualTrackId: null,
      bandwidth: 3000000,
      activeVideo: { id: '360', height: 360, bandwidth: 800_000 },
      videoReps: [
        { id: '240', height: 240, bandwidth: 350_000 },
        { id: '360', height: 360, bandwidth: 800_000 },
        { id: '720', height: 720, bandwidth: 1_800_000 },
      ],
      lastSwitchAt: -10000,
      bandwidthSamples: 2,
      _switchVideo(rep, clearBuffer, reason) {
        this.activeVideo = rep;
        this.lastSwitchReason = reason;
        this.lastSwitchAt = performance.now();
      },
    };
    Object.defineProperty(video, 'buffered', {
      get() {
        return {
          length: 1,
          start() { return 0; },
          end() { return video.currentTime + bufferAhead; },
        };
      },
    });
    provider._candidateVideos = window.NativeDashProviderForTest._candidateVideos;
    provider._chooseForBudget = window.NativeDashProviderForTest._chooseForBudget;
    provider._viewportMaxHeight = window.NativeDashProviderForTest._viewportMaxHeight;
    provider._maybeSwitchAuto = window.NativeDashProviderForTest._maybeSwitchAuto;

    provider._maybeSwitchAuto();
    const upgraded = { id: provider.activeVideo.id, reason: provider.lastSwitchReason };
    bufferAhead = 2;
    provider.bandwidth = 600000;
    provider.lastSwitchAt = performance.now();
    provider._maybeSwitchAuto();
    return {
      upgraded,
      downgraded: { id: provider.activeVideo.id, reason: provider.lastSwitchReason },
    };
  });

  expect(state.upgraded).toEqual({ id: '720', reason: 'bandwidth' });
  expect(state.downgraded).toEqual({ id: '240', reason: 'low-buffer' });
});

test('native capability probing filters non-smooth variants and records counts', async ({ page }) => {
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const state = await page.evaluate(async () => {
    Object.defineProperty(navigator, 'mediaCapabilities', {
      configurable: true,
      value: {
        decodingInfo(config) {
          const contentType = (config.video && config.video.contentType) || (config.audio && config.audio.contentType) || '';
          return Promise.resolve({
            supported: true,
            smooth: contentType.indexOf('av01') === -1,
            powerEfficient: contentType.indexOf('avc1') !== -1 || contentType.indexOf('mp4a') !== -1,
          });
        },
      },
    });
    const video = document.getElementById('player');
    const engine = new window.PlayerEngine(video, { videoId: 'TESTVIDEO01', streamToken: 'test-token' });
    const provider = {
      engine,
      capabilityProbeCount: 0,
      _probeCapabilities: window.NativeDashProviderForTest._probeCapabilities,
      _isCapabilityAllowed: window.NativeDashProviderForTest._isCapabilityAllowed,
    };
    const reps = [
      { id: 'avc', kind: 'video', mimeType: 'video/mp4', codecs: 'avc1.42c01f', width: 640, height: 360, bandwidth: 800000 },
      { id: 'av1', kind: 'video', mimeType: 'video/mp4', codecs: 'av01.0.05M.08', width: 1280, height: 720, bandwidth: 1200000 },
      { id: 'aac', kind: 'audio', mimeType: 'audio/mp4', codecs: 'mp4a.40.2', bandwidth: 64000, asr: 44100 },
    ];
    await provider._probeCapabilities(reps);
    return {
      probeCount: provider.capabilityProbeCount,
      allowed: reps.filter(rep => provider._isCapabilityAllowed(rep)).map(rep => rep.id),
      statuses: reps.map(rep => ({ id: rep.id, capability: rep.capability })),
    };
  });

  expect(state.probeCount).toBe(3);
  expect(state.allowed).toEqual(['avc', 'aac']);
  expect(state.statuses.find(rep => rep.id === 'av1').capability.smooth).toBe(false);
});

test('native startup prefers smooth efficient codec family over non-smooth AV1', async ({ page }) => {
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player" style="width:1280px;height:720px"></video>');

  const chosen = await page.evaluate(() => {
    const video = document.getElementById('player');
    const engine = new window.PlayerEngine(video, { videoId: 'TESTVIDEO01', streamToken: 'test-token' });
    const provider = {
      engine,
      video,
      blacklisted: {},
      manualTrackId: null,
      bandwidth: 3000000,
      videoReps: [
        { id: 'avc-720', height: 720, width: 1280, bandwidth: 1400000, codecs: 'avc1.42c01f', capability: { probed: true, supported: true, smooth: true, powerEfficient: true } },
        { id: 'av1-720', height: 720, width: 1280, bandwidth: 900000, codecs: 'av01.0.05M.08', capability: { probed: true, supported: true, smooth: false, powerEfficient: false } },
      ],
    };
    provider._candidateVideos = window.NativeDashProviderForTest._candidateVideos;
    provider._chooseForBudget = window.NativeDashProviderForTest._chooseForBudget;
    provider._viewportMaxHeight = window.NativeDashProviderForTest._viewportMaxHeight;
    provider._isCapabilityAllowed = window.NativeDashProviderForTest._isCapabilityAllowed;
    provider.chooseVideoRep = window.NativeDashProviderForTest.chooseVideoRep;
    return provider.chooseVideoRep();
  });

  expect(chosen.id).toBe('avc-720');
});

test('native ABR stays within codec family when possible and exposes capability metadata', async ({ page }) => {
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player" style="width:1920px;height:1080px"></video>');

  const state = await page.evaluate(() => {
    const video = document.getElementById('player');
    const engine = new window.PlayerEngine(video, { videoId: 'TESTVIDEO01', streamToken: 'test-token' });
    const provider = {
      engine,
      video,
      blacklisted: {},
      manualTrackId: null,
      bandwidth: 5000000,
      activeVideo: { id: 'avc-360', height: 360, width: 640, bandwidth: 800000, codecs: 'avc1.42c01f', capability: { probed: true, supported: true, smooth: true, powerEfficient: true } },
      videoReps: [
        { id: 'avc-360', height: 360, width: 640, bandwidth: 800000, codecs: 'avc1.42c01f', capability: { probed: true, supported: true, smooth: true, powerEfficient: true } },
        { id: 'avc-720', height: 720, width: 1280, bandwidth: 1800000, codecs: 'avc1.42c01f', capability: { probed: true, supported: true, smooth: true, powerEfficient: true } },
        { id: 'av1-1080', height: 1080, width: 1920, bandwidth: 2200000, codecs: 'av01.0.08M.08', capability: { probed: true, supported: true, smooth: true, powerEfficient: false } },
      ],
      lastSwitchAt: -10000,
      bandwidthSamples: 2,
      _switchVideo(rep, clearBuffer, reason) {
        this.activeVideo = rep;
        this.lastSwitchReason = reason;
      },
    };
    Object.defineProperty(video, 'buffered', {
      get() {
        return { length: 1, start() { return 0; }, end() { return video.currentTime + 20; } };
      },
    });
    provider._candidateVideos = window.NativeDashProviderForTest._candidateVideos;
    provider._chooseForBudget = window.NativeDashProviderForTest._chooseForBudget;
    provider._viewportMaxHeight = window.NativeDashProviderForTest._viewportMaxHeight;
    provider._isCapabilityAllowed = window.NativeDashProviderForTest._isCapabilityAllowed;
    provider._maybeSwitchAuto = window.NativeDashProviderForTest._maybeSwitchAuto;
    provider.getVariantTracks = window.NativeDashProviderForTest.getVariantTracks;
    provider.getActiveVariantTrack = window.NativeDashProviderForTest.getActiveVariantTrack;
    provider._maybeSwitchAuto();
    return {
      active: provider.getActiveVariantTrack(),
      tracks: provider.getVariantTracks(),
      reason: provider.lastSwitchReason,
    };
  });

  expect(state.active.id).toBe('avc-720');
  expect(state.active.codecFamily).toBe('avc1');
  expect(state.reason).toBe('bandwidth');
  expect(state.tracks.find(track => track.id === 'av1-1080')).toMatchObject({
    codecFamily: 'av01',
    capabilityStatus: 'supported',
    smooth: true,
    powerEfficient: false,
  });
});

test('manual native quality selection disables ABR and updates active track', async ({ page }) => {
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const state = await page.evaluate(() => {
    const video = document.getElementById('player');
    const engine = new window.PlayerEngine(video, { videoId: 'TESTVIDEO01', streamToken: 'test-token' });
    const provider = {
      engine,
      video,
      videoReps: [
        { id: '360', height: 360, bandwidth: 800_000 },
        { id: '720', height: 720, bandwidth: 1_800_000 },
      ],
      activeVideo: { id: '360', height: 360, bandwidth: 800_000 },
      _switchVideo(rep, clearBuffer, reason) {
        this.activeVideo = rep;
        this.lastSwitchReason = reason;
        this.clearedBuffer = clearBuffer;
      },
      getActiveVariantTrack() {
        return { id: this.activeVideo.id, height: this.activeVideo.height, bandwidth: this.activeVideo.bandwidth, active: true };
      },
    };
    window.NativeDashProviderForTest.selectVariantTrack.call(provider, { id: '720' }, true);
    return {
      abrEnabled: engine.getPlayer().config.abr.enabled,
      manualTrackId: provider.manualTrackId,
      activeTrack: provider.getActiveVariantTrack(),
      clearedBuffer: provider.clearedBuffer,
      reason: provider.lastSwitchReason,
    };
  });

  expect(state.abrEnabled).toBe(false);
  expect(state.manualTrackId).toBe('720');
  expect(state.activeTrack.height).toBe(720);
  expect(state.clearedBuffer).toBe(true);
  expect(state.reason).toBe('manual');
});

test('native stats expose active quality and playback health', async ({ page }) => {
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const stats = await page.evaluate(() => {
    const video = document.getElementById('player');
    video.getVideoPlaybackQuality = () => ({ droppedVideoFrames: 2, totalVideoFrames: 40 });
    const engine = new window.PlayerEngine(video, { videoId: 'TESTVIDEO01', streamToken: 'test-token' });
    engine._provider = {
      name: 'native-dash',
      video,
      bandwidth: 1800000,
      lastBandwidthSample: 2000000,
      lastSwitchReason: 'bandwidth',
      startupBufferComplete: true,
      startupBufferMs: 125,
      firstPlayableRange: { start: 0, end: 4 },
      activeRanges: { video: true, audio: true },
      videoSb: { _nativeQueueDepth: 2 },
      audioSb: { _nativeQueueDepth: 1 },
      requestCancellationCount: 3,
      mediaFetchCompletedCount: 4,
      mediaFetchTotalMs: 100,
      schedulerBackpressureCount: 1,
      schedulerDrainCount: 2,
      periodCount: 2,
      manifestProfile: 'urn:mpeg:dash:profile:isoff-live:2011',
      manifestCompatibilityWarnings: ['segmenttimeline-negative-repeat-expanded'],
      _pendingSegmentCount() { return 5; },
      _schedulerQueueDepth() { return 2; },
      getActiveVariantTrack() {
        return { id: '720', height: 720, bandwidth: 1800000, active: true };
      },
      getStats: window.NativeDashProviderForTest.getStats,
    };
    return engine.getPlayer().getStats();
  });

  expect(stats.provider).toBe('native-dash');
  expect(stats.activeVariant.height).toBe(720);
  expect(stats.droppedFrames).toBe(2);
  expect(stats.totalFrames).toBe(40);
  expect(stats.startupBufferComplete).toBe(true);
  expect(stats.startupBufferMs).toBe(125);
  expect(stats.firstPlayableRange).toEqual({ start: 0, end: 4 });
  expect(stats.inFlightRequestCount).toBe(2);
  expect(stats.pendingSegmentCount).toBe(5);
  expect(stats.appendQueueDepth).toBe(3);
  expect(stats.requestCancellationCount).toBe(3);
  expect(stats.schedulerQueueDepth).toBe(2);
  expect(stats.mediaFetchInFlightCount).toBe(2);
  expect(stats.mediaFetchCompletedCount).toBe(4);
  expect(stats.mediaFetchCancelledCount).toBe(3);
  expect(stats.mediaFetchAverageMs).toBe(25);
  expect(stats.schedulerBackpressureCount).toBe(1);
  expect(stats.schedulerDrainCount).toBe(2);
  expect(stats.periodCount).toBe(2);
  expect(stats.manifestProfile).toBe('urn:mpeg:dash:profile:isoff-live:2011');
  expect(stats.manifestCompatibilityWarnings).toEqual(['segmenttimeline-negative-repeat-expanded']);
});

test('native buffer scheduler prioritizes the current playback window', async ({ page }) => {
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const chosen = await page.evaluate(() => {
    const provider = {
      _selectNextSegment: window.NativeDashProviderForTest._selectNextSegment,
    };
    const rep = {
      segments: [
        { id: 'far', start: 12, end: 14 },
        { id: 'near', start: 4, end: 6 },
        { id: 'expired', start: 6, end: 8, state: 'expired' },
        { id: 'fetching', start: 8, end: 10, state: 'fetching' },
        { id: 'appended', start: 10, end: 12, appended: true },
      ],
    };
    const first = provider._selectNextSegment(rep, 5, 15);
    first.state = 'fetching';
    const second = provider._selectNextSegment(rep, 5, 15);
    return {
      first: first.id,
      second: second.id,
    };
  });

  expect(chosen).toEqual({ first: 'near', second: 'far' });
});

test('native buffer milestones emit startup and seek readiness telemetry', async ({ page }) => {
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const state = await page.evaluate(() => {
    const video = document.getElementById('player');
    Object.defineProperty(video, 'currentTime', { configurable: true, get() { return 1; } });
    Object.defineProperty(video, 'buffered', {
      configurable: true,
      get() {
        return {
          length: 1,
          start() { return 0; },
          end() { return 6; },
        };
      },
    });
    const events = [];
    const provider = {
      video,
      startupBufferComplete: false,
      startupBufferStartedAt: performance.now() - 50,
      startupBufferMs: 0,
      firstPlayableRange: null,
      seekBufferPending: true,
      seekBufferReadyCount: 0,
      engine: {
        _telemetry: {
          record(type, payload) {
            events.push({ type, payload: payload || null });
          },
        },
      },
      _bufferAheadGoal() { return 30; },
    };

    window.NativeDashProviderForTest._checkBufferMilestones.call(provider);
    window.NativeDashProviderForTest._checkBufferMilestones.call(provider);
    return {
      startupBufferComplete: provider.startupBufferComplete,
      startupBufferMs: provider.startupBufferMs,
      firstPlayableRange: provider.firstPlayableRange,
      seekBufferPending: provider.seekBufferPending,
      seekBufferReadyCount: provider.seekBufferReadyCount,
      events,
    };
  });

  expect(state.startupBufferComplete).toBe(true);
  expect(state.startupBufferMs).toBeGreaterThanOrEqual(0);
  expect(state.firstPlayableRange).toEqual({ start: 0, end: 6 });
  expect(state.seekBufferPending).toBe(false);
  expect(state.seekBufferReadyCount).toBe(1);
  expect(state.events.map(event => event.type)).toEqual(['startup-buffer-ready', 'seek-buffer-ready']);
});

test('native streaming config controls buffer targets and rebuffer readiness', async ({ page }) => {
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const state = await page.evaluate(() => {
    const video = document.getElementById('player');
    Object.defineProperty(video, 'currentTime', { configurable: true, get() { return 1; } });
    Object.defineProperty(video, 'buffered', {
      configurable: true,
      get() {
        return {
          length: 1,
          start() { return 1; },
          end() { return 1.2; },
        };
      },
    });
    const engine = new window.PlayerEngine(video, { videoId: 'TESTVIDEO01', streamToken: 'test-token' });
    const events = [];
    engine._telemetry.record = function (type, payload) { events.push({ type, payload: payload || null }); };
    engine.getPlayer().configure('streaming.bufferingGoal', 1);
    engine.getPlayer().configure('streaming.rebufferingGoal', 0.1);
    engine.getPlayer().configure('streaming.seekBufferGoal', 4);
    const provider = {
      video,
      seekBufferPending: true,
      seekBufferReadyCount: 0,
      startupBufferComplete: true,
      firstPlayableRange: null,
      engine,
      _bufferAheadGoal: window.NativeDashProviderForTest._bufferAheadGoal,
      _rebufferingGoal: window.NativeDashProviderForTest._rebufferingGoal,
      _seekBufferGoal: window.NativeDashProviderForTest._seekBufferGoal,
      _checkBufferMilestones: window.NativeDashProviderForTest._checkBufferMilestones,
    };
    provider._checkBufferMilestones();
    return {
      bufferGoal: provider._bufferAheadGoal(),
      rebufferGoal: provider._rebufferingGoal(),
      seekGoal: provider._seekBufferGoal(),
      seekBufferPending: provider.seekBufferPending,
      seekBufferReadyCount: provider.seekBufferReadyCount,
      events,
    };
  });

  expect(state.bufferGoal).toBe(1);
  expect(state.rebufferGoal).toBe(0.1);
  expect(state.seekGoal).toBe(4);
  expect(state.seekBufferPending).toBe(false);
  expect(state.seekBufferReadyCount).toBe(1);
  expect(state.events.map(event => event.type)).toEqual(['seek-buffer-ready']);
});

test('native streaming bufferingGoal limits scheduled segment candidates', async ({ page }) => {
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const state = await page.evaluate(() => {
    const video = document.getElementById('player');
    Object.defineProperty(video, 'currentTime', { configurable: true, get() { return 0; } });
    const engine = new window.PlayerEngine(video, { videoId: 'TESTVIDEO01', streamToken: 'test-token' });
    engine.getPlayer().configure('streaming.bufferingGoal', 1);
    const provider = {
      video,
      live: false,
      engine,
      activeVideo: {
        segments: [
          { id: 'near-video', start: 0, end: 1 },
          { id: 'far-video', start: 2, end: 3 },
        ],
      },
      audio: {
        segments: [
          { id: 'near-audio', start: 0, end: 1 },
          { id: 'far-audio', start: 2, end: 3 },
        ],
      },
      videoSb: {},
      audioSb: {},
      _bufferAheadGoal: window.NativeDashProviderForTest._bufferAheadGoal,
      _buildSegmentCandidates: window.NativeDashProviderForTest._buildSegmentCandidates,
    };
    return provider._buildSegmentCandidates().map(item => item.seg.id);
  });

  expect(state).toEqual(['near-video', 'near-audio']);
});

test('native streaming bufferBehind controls trimming and can disable it', async ({ page }) => {
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const state = await page.evaluate(() => {
    function makeSourceBuffer() {
      const listeners = {};
      return {
        updating: false,
        removes: [],
        buffered: { length: 1, start() { return 0; }, end() { return 30; } },
        addEventListener(name, fn) { listeners[name] = fn; },
        removeEventListener(name) { delete listeners[name]; },
        remove(start, end) {
          this.removes.push({ start, end });
          setTimeout(() => { if (listeners.updateend) listeners.updateend(); }, 0);
        },
      };
    }
    const video = document.getElementById('player');
    Object.defineProperty(video, 'currentTime', { configurable: true, get() { return 20; } });
    const engine = new window.PlayerEngine(video, { videoId: 'TESTVIDEO01', streamToken: 'test-token' });
    const videoSb = makeSourceBuffer();
    const audioSb = makeSourceBuffer();
    const provider = {
      video,
      videoSb,
      audioSb,
      engine,
      _bufferBehindGoal: window.NativeDashProviderForTest._bufferBehindGoal,
      _trim: window.NativeDashProviderForTest._trim,
    };
    engine.getPlayer().configure('streaming.bufferBehind', 5);
    provider._trim();
    return new Promise(resolve => setTimeout(resolve, 0)).then(() => {
      const trimmed = { video: videoSb.removes.slice(), audio: audioSb.removes.slice(), behind: provider._bufferBehindGoal() };
      engine.getPlayer().configure('streaming.bufferBehind', 0);
      provider._trim();
      return new Promise(resolve => setTimeout(resolve, 0)).then(() => ({
        trimmed,
        finalVideoRemoveCount: videoSb.removes.length,
        finalAudioRemoveCount: audioSb.removes.length,
        disabledBehind: provider._bufferBehindGoal(),
      }));
    });
  });

  expect(state.trimmed.behind).toBe(5);
  expect(state.trimmed.video).toEqual([{ start: 0, end: 15 }]);
  expect(state.trimmed.audio).toEqual([{ start: 0, end: 15 }]);
  expect(state.disabledBehind).toBe(0);
  expect(state.finalVideoRemoveCount).toBe(1);
  expect(state.finalAudioRemoveCount).toBe(1);
});

test('native manifest availabilityWindowOverride narrows exposed live range only', async ({ page }) => {
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const state = await page.evaluate(() => {
    const video = document.getElementById('player');
    Object.defineProperty(video, 'currentTime', { configurable: true, get() { return 55; }, set() {} });
    Object.defineProperty(video, 'buffered', {
      configurable: true,
      get() {
        return { length: 1, start() { return 50; }, end() { return 60; } };
      },
    });
    const engine = new window.PlayerEngine(video, { videoId: 'TESTVIDEO01', streamToken: 'test-token' });
    const provider = {
      video,
      engine,
      live: true,
      liveWindow: { start: 0, end: 60 },
      liveLatency: 0,
      atLiveEdge: false,
      _updateLiveWindowFromReps() {},
      _availabilityWindowOverride: window.NativeDashProviderForTest._availabilityWindowOverride,
      _effectiveLiveWindow: window.NativeDashProviderForTest._effectiveLiveWindow,
      _updateLivePositionStats: window.NativeDashProviderForTest._updateLivePositionStats,
      getLiveRange: window.NativeDashProviderForTest.getLiveRange,
      getStats: window.NativeDashProviderForTest.getStats,
      getActiveVariantTrack() { return null; },
    };
    engine.getPlayer().configure('manifest.availabilityWindowOverride', 20);
    provider._updateLivePositionStats();
    return {
      parsedWindow: provider.liveWindow,
      liveRange: provider.getLiveRange(),
      override: provider._availabilityWindowOverride(),
      stats: provider.getStats(),
    };
  });

  expect(state.parsedWindow).toEqual({ start: 0, end: 60 });
  expect(state.liveRange).toEqual({ start: 40, end: 60 });
  expect(state.override).toBe(20);
  expect(state.stats.liveWindowStart).toBe(40);
  expect(state.stats.liveWindowEnd).toBe(60);
  expect(state.stats.effectiveAvailabilityWindowOverride).toBe(20);
});

test('native request cancellation aborts in-flight scheduler work and records telemetry', async ({ page }) => {
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const state = await page.evaluate(() => {
    const events = [];
    let aborts = 0;
    const provider = {
      controllers: [
        { abort() { aborts++; } },
        { abort() { aborts++; } },
      ],
      activeRanges: { video: true, audio: true },
      requestGeneration: 7,
      requestCancellationCount: 0,
      engine: {
        _telemetry: {
          record(type, payload) {
            events.push({ type, payload });
          },
        },
      },
    };

    window.NativeDashProviderForTest._abortRequests.call(provider);
    return {
      aborts,
      generation: provider.requestGeneration,
      controllerCount: provider.controllers.length,
      activeRangeCount: Object.keys(provider.activeRanges).length,
      requestCancellationCount: provider.requestCancellationCount,
      events,
    };
  });

  expect(state.aborts).toBe(2);
  expect(state.generation).toBe(8);
  expect(state.controllerCount).toBe(0);
  expect(state.activeRangeCount).toBe(0);
  expect(state.requestCancellationCount).toBe(4);
  expect(state.events).toEqual([
    { type: 'request-cancel', payload: { cancelledRequests: 4 } },
  ]);
});

test('native media scheduler respects max concurrent request limit', async ({ page }) => {
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const state = await page.evaluate(() => {
    const video = document.getElementById('player');
    Object.defineProperty(video, 'currentTime', { configurable: true, get() { return 0; } });
    const events = [];
    const provider = {
      video,
      destroyed: false,
      activeRanges: {},
      engine: {
        _telemetry: { record(type, payload) { events.push({ type, payload }); } },
      },
      _bufferAheadGoal() { return 30; },
      _maxConcurrentMediaRequests() { return 2; },
      _drainAppendQueue: window.NativeDashProviderForTest._drainAppendQueue,
      _buildSegmentCandidates: window.NativeDashProviderForTest._buildSegmentCandidates,
      _startSegmentFetch: window.NativeDashProviderForTest._startSegmentFetch,
      _scheduleMediaRequests: window.NativeDashProviderForTest._scheduleMediaRequests,
      _fetchRange() { return new Promise(() => {}); },
    };
    const rep = {
      id: 'v',
      kind: 'video',
      baseUrl: '/video',
      segments: [
        { id: 's0', start: 0, end: 2, range: { start: 0, end: 99 } },
        { id: 's1', start: 2, end: 4, range: { start: 100, end: 199 } },
        { id: 's2', start: 4, end: 6, range: { start: 200, end: 299 } },
      ],
    };
    provider._scheduleMediaRequests(6, [{ rep, sb: { updating: false } }]);
    provider._scheduleMediaRequests(6, [{ rep, sb: { updating: false } }]);
    return {
      fetching: rep.segments.filter(seg => seg.state === 'fetching').map(seg => seg.id),
      activeRangeCount: Object.keys(provider.activeRanges).length,
      backpressureCount: provider.schedulerBackpressureCount,
      events,
    };
  });

  expect(state.fetching).toEqual(['s0', 's1']);
  expect(state.activeRangeCount).toBe(2);
  expect(state.backpressureCount).toBe(1);
  expect(state.events).toEqual([
    { type: 'scheduler-backpressure', payload: { mediaFetchInFlightCount: 2 } },
  ]);
});

test('native media scheduler appends fetched segments in timeline order', async ({ page }) => {
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const state = await page.evaluate(() => {
    const video = document.getElementById('player');
    Object.defineProperty(video, 'currentTime', { configurable: true, get() { return 0; } });
    const appended = [];
    const events = [];
    const rep = {
      id: 'v',
      kind: 'video',
      segments: [
        { id: 'late', start: 2, end: 4, state: 'fetched', _data: new ArrayBuffer(1) },
        { id: 'early', start: 0, end: 2, state: 'fetching' },
      ],
    };
    const provider = {
      video,
      schedulerDrainCount: 0,
      engine: {
        _player: { emit() {} },
        _telemetry: { record(type, payload) { events.push({ type, payload }); } },
      },
      _schedulerQueueDepth: window.NativeDashProviderForTest._schedulerQueueDepth,
      _appendSegmentData(activeRep, sb, seg) {
        appended.push(seg.id);
        return Promise.resolve();
      },
      _tick() {},
      _drainAppendQueue: window.NativeDashProviderForTest._drainAppendQueue,
    };

    const blocked = provider._drainAppendQueue(rep, { updating: false });
    rep.segments[1].state = 'fetched';
    rep.segments[1]._data = new ArrayBuffer(1);
    const started = provider._drainAppendQueue(rep, { updating: false });
    return new Promise(resolve => setTimeout(() => resolve({
      blocked,
      started,
      appended,
      states: rep.segments.map(seg => ({ id: seg.id, state: seg.state, appended: !!seg.appended })),
      drainCount: provider.schedulerDrainCount,
      events: events.map(event => event.type),
    }), 20));
  });

  expect(state.blocked).toBe(false);
  expect(state.started).toBe(true);
  expect(state.appended).toEqual(['early', 'late']);
  expect(state.states).toEqual([
    { id: 'late', state: 'appended', appended: true },
    { id: 'early', state: 'appended', appended: true },
  ]);
  expect(state.drainCount).toBe(2);
  expect(state.events).toEqual(['scheduler-drain', 'scheduler-drain']);
});

test('native telemetry posts first-party playback events only', async ({ page }) => {
  const batches = [];
  await page.route('**/api/player-events', async route => {
    batches.push(route.request().postDataJSON());
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });

  await page.goto('/auth/login');
  await page.setContent('<video id="player"></video>');
  await page.addScriptTag({ path: 'public/native-player-engine.js' });

  await page.evaluate(() => {
    const video = document.getElementById('player');
    Object.defineProperty(video, 'currentTime', { configurable: true, get() { return 1.25; } });
    const engine = new window.PlayerEngine(video, { videoId: 'TESTVIDEO01', streamToken: 'test-token' });
    engine._provider = {
      getStats() {
        return {
          provider: 'native-dash',
          mode: 'dash',
          bufferAhead: 12,
          bandwidthEstimate: 1800000,
          activeVariant: { height: 720 },
          rebufferCount: 1,
          rebufferDuration: 0.25,
          recoveryCount: 1,
          droppedFrames: 2,
          totalFrames: 100,
        };
      },
    };
    return engine.init().then(() => {
      engine._loadStartedAt = performance.now() - 100;
      engine._telemetry.record('first-frame');
    });
  });

  await expect.poll(() => batches.length).toBeGreaterThan(0);
  const event = batches.flatMap(batch => batch.events)[0];
  expect(event.type).toBe('first-frame');
  expect(event.provider).toBe('native-dash');
  expect(event.mode).toBe('dash');
  expect(event.videoId).toBe('TESTVIDEO01');
  expect(event.activeHeight).toBe(720);
});

test('native DASH quota pressure trims and retries append before fallback', async ({ page }) => {
  await page.goto('/auth/login');
  await page.setContent('<video id="player"></video>');
  await page.addScriptTag({ path: 'public/native-player-engine.js' });

  const state = await page.evaluate(() => {
    function makeSourceBuffer(throwQuotaFirst) {
      const listeners = {};
      let appendCalls = 0;
      let removeCalls = 0;
      return {
        get appendCalls() { return appendCalls; },
        get removeCalls() { return removeCalls; },
        updating: false,
        buffered: {
          length: 1,
          start() { return 0; },
          end() { return 20; },
        },
        addEventListener(name, fn) { listeners[name] = fn; },
        removeEventListener(name) { delete listeners[name]; },
        appendBuffer() {
          appendCalls++;
          if (throwQuotaFirst && appendCalls === 1) {
            const err = new Error('quota');
            err.name = 'QuotaExceededError';
            throw err;
          }
          setTimeout(() => { if (listeners.updateend) listeners.updateend(); }, 0);
        },
        remove() {
          removeCalls++;
          setTimeout(() => { if (listeners.updateend) listeners.updateend(); }, 0);
        },
      };
    }

    const video = document.getElementById('player');
    Object.defineProperty(video, 'currentTime', { configurable: true, get() { return 10; } });
    const engine = new window.PlayerEngine(video, { videoId: 'TESTVIDEO01', streamToken: 'test-token' });
    const videoSb = makeSourceBuffer(true);
    const audioSb = makeSourceBuffer(false);
    const provider = {
      engine,
      video,
      videoSb,
      audioSb,
      quotaRecoveries: 0,
      lastError: '',
      blacklisted: {},
      videoReps: [{ id: '720', height: 720, codecs: 'avc1.42c01f' }],
      activeVideo: { id: '720', height: 720, codecs: 'avc1.42c01f' },
      _lowerVideoRep: window.NativeDashProviderForTest._lowerVideoRep,
      _recoverQuota: window.NativeDashProviderForTest._recoverQuota,
      _switchVideo() { this.switched = true; },
    };
    engine._telemetry.record = function () {};
    return window.NativeDashProviderForTest._appendSegmentData
      .call(provider, { kind: 'video', id: '720' }, videoSb, {}, new ArrayBuffer(1))
      .then(() => ({
        appendCalls: videoSb.appendCalls,
        videoRemoveCalls: videoSb.removeCalls,
        audioRemoveCalls: audioSb.removeCalls,
        quotaRecoveries: provider.quotaRecoveries,
        lastError: provider.lastError,
        switched: !!provider.switched,
      }));
  });

  expect(state.appendCalls).toBe(2);
  expect(state.videoRemoveCalls).toBe(1);
  expect(state.audioRemoveCalls).toBe(1);
  expect(state.quotaRecoveries).toBe(1);
  expect(state.lastError).toBe('quota-exceeded');
  expect(state.switched).toBe(false);
});

test('native DASH stall recovery force-fills before downgrading', async ({ page }) => {
  await page.goto('/auth/login');
  await page.setContent('<video id="player"></video>');
  await page.addScriptTag({ path: 'public/native-player-engine.js' });

  const state = await page.evaluate(() => {
    const video = document.getElementById('player');
    Object.defineProperty(video, 'buffered', {
      configurable: true,
      get() { return { length: 0, start() { return 0; }, end() { return 0; } }; },
    });
    const engine = new window.PlayerEngine(video, { videoId: 'TESTVIDEO01', streamToken: 'test-token' });
    engine._telemetry.record = function () {};
    const provider = {
      engine,
      video,
      stallReports: 0,
      stallRecoveryStage: 0,
      lastError: '',
      blacklisted: {},
      activeVideo: { id: '720', height: 720, codecs: 'avc1.42c01f', segments: [{ start: 0, end: 2, state: 'failed' }] },
      audio: { id: 'a64', segments: [{ start: 0, end: 2, state: 'failed' }] },
      videoReps: [
        { id: '360', height: 360, codecs: 'avc1.42c01f' },
        { id: '720', height: 720, codecs: 'avc1.42c01f' },
      ],
      _bufferAheadGoal() { return 30; },
      _tick() { this.tickCount = (this.tickCount || 0) + 1; },
      _lowerVideoRep: window.NativeDashProviderForTest._lowerVideoRep,
      _switchVideo(rep, clearBuffer, reason) {
        this.switchedTo = rep.id;
        this.switchReason = reason;
        this.clearBuffer = clearBuffer;
      },
    };

    window.NativeDashProviderForTest.reportStall.call(provider);
    const afterFirst = {
      stage: provider.stallRecoveryStage,
      tickCount: provider.tickCount,
      switchedTo: provider.switchedTo || '',
      videoState: provider.activeVideo.segments[0].state,
      audioState: provider.audio.segments[0].state,
    };
    window.NativeDashProviderForTest.reportStall.call(provider);
    return {
      afterFirst,
      afterSecond: {
        stage: provider.stallRecoveryStage,
        switchedTo: provider.switchedTo || '',
        switchReason: provider.switchReason || '',
        clearBuffer: provider.clearBuffer,
        blacklisted720: provider.blacklisted['720'] === true,
      },
    };
  });

  expect(state.afterFirst).toMatchObject({
    stage: 1,
    switchedTo: '',
    videoState: 'pending',
    audioState: 'pending',
  });
  expect(state.afterFirst.tickCount).toBeGreaterThanOrEqual(2);
  expect(state.afterSecond).toMatchObject({
    stage: 2,
    switchedTo: '360',
    switchReason: 'stall-recovery',
    clearBuffer: true,
    blacklisted720: true,
  });
});

test('native HLS quota pressure trims and retries append before fallback', async ({ page }) => {
  await page.goto('/auth/login');
  await page.setContent('<video id="player"></video>');
  await page.addScriptTag({ path: 'public/native-player-engine.js' });

  const state = await page.evaluate(() => {
    function makeSourceBuffer(throwQuotaFirst) {
      const listeners = {};
      let appendCalls = 0;
      let removeCalls = 0;
      return {
        get appendCalls() { return appendCalls; },
        get removeCalls() { return removeCalls; },
        updating: false,
        buffered: {
          length: 1,
          start() { return 0; },
          end() { return 20; },
        },
        addEventListener(name, fn) { listeners[name] = fn; },
        removeEventListener(name) { delete listeners[name]; },
        appendBuffer() {
          appendCalls++;
          if (throwQuotaFirst && appendCalls === 1) {
            const err = new Error('quota');
            err.name = 'QuotaExceededError';
            throw err;
          }
          setTimeout(() => { if (listeners.updateend) listeners.updateend(); }, 0);
        },
        remove() {
          removeCalls++;
          setTimeout(() => { if (listeners.updateend) listeners.updateend(); }, 0);
        },
      };
    }

    const video = document.getElementById('player');
    Object.defineProperty(video, 'currentTime', { configurable: true, get() { return 10; } });
    const engine = new window.PlayerEngine(video, { videoId: 'TESTVIDEO01', streamToken: 'test-token' });
    engine._telemetry.record = function () {};
    const videoSb = makeSourceBuffer(true);
    const audioSb = makeSourceBuffer(false);
    const provider = {
      engine,
      video,
      sb: videoSb,
      audioSb,
      quotaRecoveries: 0,
      lastError: '',
      blacklisted: {},
      variants: [{ id: '360', height: 360 }, { id: '720', height: 720 }],
      activeVariant: { id: '720', height: 720 },
      _lowerVariant: window.NativeHlsProviderForTest._lowerVariant,
      _switchVariant() { this.switched = true; },
      _recoverQuota: window.NativeHlsProviderForTest._recoverQuota,
    };
    return window.NativeHlsProviderForTest._appendSegmentData
      .call(provider, { kind: 'video', id: 'video', sb: videoSb }, {}, new ArrayBuffer(1))
      .then(() => ({
        appendCalls: videoSb.appendCalls,
        videoRemoveCalls: videoSb.removeCalls,
        audioRemoveCalls: audioSb.removeCalls,
        quotaRecoveries: provider.quotaRecoveries,
        lastError: provider.lastError,
        switched: !!provider.switched,
      }));
  });

  expect(state.appendCalls).toBe(2);
  expect(state.videoRemoveCalls).toBe(1);
  expect(state.audioRemoveCalls).toBe(1);
  expect(state.quotaRecoveries).toBe(1);
  expect(state.lastError).toBe('quota-exceeded');
  expect(state.switched).toBe(false);
});

test('native HLS stall recovery force-fills before downgrading', async ({ page }) => {
  await page.goto('/auth/login');
  await page.setContent('<video id="player"></video>');
  await page.addScriptTag({ path: 'public/native-player-engine.js' });

  const state = await page.evaluate(() => {
    const video = document.getElementById('player');
    Object.defineProperty(video, 'buffered', {
      configurable: true,
      get() { return { length: 0, start() { return 0; }, end() { return 0; } }; },
    });
    const engine = new window.PlayerEngine(video, { videoId: 'TESTVIDEO01', streamToken: 'test-token' });
    engine._telemetry.record = function () {};
    const activeVariant = { id: '720', height: 720 };
    const provider = {
      engine,
      video,
      stallReports: 0,
      stallRecoveryStage: 0,
      lastError: '',
      blacklisted: {},
      variants: [
        { id: '360', height: 360 },
        activeVariant,
      ],
      activeVariant,
      segments: [{ start: 0, end: 2, state: 'failed' }],
      activeAudio: { id: 'a64', segments: [{ start: 0, end: 2, state: 'failed' }] },
      _bufferAheadGoal() { return 30; },
      _tick() { this.tickCount = (this.tickCount || 0) + 1; },
      _lowerVariant: window.NativeHlsProviderForTest._lowerVariant,
      _jumpSmallGap: window.NativeHlsProviderForTest._jumpSmallGap,
      _switchVariant(variant, clearBuffer, reason) {
        this.switchedTo = variant.id;
        this.switchReason = reason;
        this.clearBuffer = clearBuffer;
      },
    };

    window.NativeHlsProviderForTest.reportStall.call(provider);
    const afterFirst = {
      stage: provider.stallRecoveryStage,
      tickCount: provider.tickCount,
      switchedTo: provider.switchedTo || '',
      videoState: provider.segments[0].state,
      audioState: provider.activeAudio.segments[0].state,
    };
    window.NativeHlsProviderForTest.reportStall.call(provider);
    return {
      afterFirst,
      afterSecond: {
        stage: provider.stallRecoveryStage,
        switchedTo: provider.switchedTo || '',
        switchReason: provider.switchReason || '',
        clearBuffer: provider.clearBuffer,
        blacklisted720: provider.blacklisted['720'] === true,
      },
    };
  });

  expect(state.afterFirst).toMatchObject({
    stage: 1,
    switchedTo: '',
    videoState: 'pending',
    audioState: 'pending',
  });
  expect(state.afterFirst.tickCount).toBeGreaterThanOrEqual(2);
  expect(state.afterSecond).toMatchObject({
    stage: 2,
    switchedTo: '360',
    switchReason: 'stall-recovery',
    clearBuffer: true,
    blacklisted720: true,
  });
});

test('native HLS jumps small gaps and leaves large gaps alone', async ({ page }) => {
  await page.goto('/auth/login');
  await page.setContent('<video id="player"></video>');
  await page.addScriptTag({ path: 'public/native-player-engine.js' });

  const state = await page.evaluate(() => {
    const video = document.getElementById('player');
    let currentTime = 2.1;
    Object.defineProperty(video, 'currentTime', {
      configurable: true,
      get() { return currentTime; },
      set(value) { currentTime = value; },
    });
    Object.defineProperty(video, 'buffered', {
      configurable: true,
      get() {
        return {
          length: 2,
          start(i) { return i === 0 ? 0 : 2.5; },
          end(i) { return i === 0 ? 2 : 5; },
        };
      },
    });
    const engine = new window.PlayerEngine(video, { videoId: 'TESTVIDEO01', streamToken: 'test-token' });
    engine._telemetry.record = function () {};
    const provider = {
      engine,
      video,
      gapJumpCount: 0,
      lastGapSize: 0,
      lastError: '',
      _tick() { this.tickCount = (this.tickCount || 0) + 1; },
    };
    const jumped = window.NativeHlsProviderForTest._jumpSmallGap.call(provider);
    currentTime = 3;
    const noGap = window.NativeHlsProviderForTest._jumpSmallGap.call(provider);
    return {
      jumped,
      noGap,
      currentTime,
      gapJumpCount: provider.gapJumpCount,
      lastGapSize: provider.lastGapSize,
      lastError: provider.lastError,
    };
  });

  expect(state.jumped).toBe(true);
  expect(state.noGap).toBe(false);
  expect(state.currentTime).toBe(3);
  expect(state.gapJumpCount).toBe(1);
  expect(state.lastGapSize).toBeCloseTo(0.4);
  expect(state.lastError).toBe('gap-jump');
});

test('native HLS append recovery falls back with explicit video reason', async ({ page }) => {
  await page.goto('/auth/login');
  await page.setContent('<video id="player"></video>');
  await page.addScriptTag({ path: 'public/native-player-engine.js' });

  const state = await page.evaluate(() => {
    const video = document.getElementById('player');
    const engine = new window.PlayerEngine(video, { videoId: 'TESTVIDEO01', streamToken: 'test-token' });
    let fallbackReason = '';
    engine._fallbackToShaka = function (reason) { fallbackReason = reason; };
    const provider = {
      engine,
      video,
      appendFailures: 0,
      lastError: '',
      blacklisted: {},
      variants: [{ id: '720', height: 720 }],
      activeVariant: { id: '720', height: 720 },
      _lowerVariant: window.NativeHlsProviderForTest._lowerVariant,
    };
    window.NativeHlsProviderForTest._handleAppendFailure.call(provider, { kind: 'video', id: 'video' }, new Error('append failed'));
    return {
      fallbackReason,
      appendFailures: provider.appendFailures,
      lastError: provider.lastError,
      blacklisted720: provider.blacklisted['720'] === true,
    };
  });

  expect(state).toMatchObject({
    fallbackReason: 'hls-video-append-exhausted',
    appendFailures: 1,
    lastError: 'append failed',
    blacklisted720: true,
  });
});

test('native HLS capability-aware selection skips unsupported variants', async ({ page }) => {
  await page.goto('/auth/login');
  await page.setContent('<video id="player"></video>');
  await page.addScriptTag({ path: 'public/native-player-engine.js' });

  const state = await page.evaluate(() => {
    const video = document.getElementById('player');
    Object.defineProperty(video, 'clientHeight', { configurable: true, get() { return 720; } });
    video.getBoundingClientRect = () => ({ height: 720 });
    const provider = {
      video,
      bandwidth: 3_000_000,
      blacklisted: {},
      variants: [
        { id: 'bad-720', kind: 'video', mimeType: 'video/mp4', codecs: 'avc1.42c01f', bandwidth: 1_000_000, width: 1280, height: 720, capability: { probed: true, supported: false, smooth: false, powerEfficient: false } },
        { id: 'good-360', kind: 'video', mimeType: 'video/mp4', codecs: 'avc1.42c01f', bandwidth: 600_000, width: 640, height: 360, capability: { probed: true, supported: true, smooth: true, powerEfficient: true } },
      ],
      engine: { _player: { config: { abr: { restrictions: { minHeight: 360 }, defaultBandwidthEstimate: 3_000_000 } } } },
      _isCapabilityAllowed: window.NativeHlsProviderForTest._isCapabilityAllowed,
      _candidateVariants: window.NativeHlsProviderForTest._candidateVariants,
      _viewportMaxHeight() { return 720; },
      _chooseForBudget: window.NativeHlsProviderForTest._chooseForBudget,
    };
    const chosen = window.NativeHlsProviderForTest.chooseVariant.call(provider);
    return {
      chosen,
      tracks: window.NativeHlsProviderForTest.getVariantTracks.call(provider),
    };
  });

  expect(state.chosen.id).toBe('good-360');
  expect(state.tracks).toEqual([
    expect.objectContaining({ id: 'bad-720', supported: false, capabilityStatus: 'unsupported', active: false }),
    expect.objectContaining({ id: 'good-360', supported: true, capabilityStatus: 'power-efficient', active: true, codecFamily: 'avc1' }),
  ]);
});

test('native HLS manual quality selection ignores unsupported tracks', async ({ page }) => {
  await page.goto('/auth/login');
  await page.setContent('<video id="player"></video>');
  await page.addScriptTag({ path: 'public/native-player-engine.js' });

  const state = await page.evaluate(() => {
    const video = document.getElementById('player');
    const active = { id: '360', kind: 'video', mimeType: 'video/mp4', codecs: 'avc1.42c01f', bandwidth: 600_000, height: 360, active: true, capability: { probed: true, supported: true, smooth: true, powerEfficient: true } };
    const unsupported = { id: '720', kind: 'video', mimeType: 'video/mp4', codecs: 'avc1.42c01f', bandwidth: 1_800_000, height: 720, active: false, capability: { probed: true, supported: false, smooth: false, powerEfficient: false } };
    const engine = new window.PlayerEngine(video, { videoId: 'TESTVIDEO01', streamToken: 'test-token' });
    const provider = {
      engine,
      video,
      variants: [active, unsupported],
      activeVariant: active,
      blacklisted: {},
      destroyed: false,
      _switchVariant(variant) {
        this.switchedTo = variant.id;
      },
      _isCapabilityAllowed: window.NativeHlsProviderForTest._isCapabilityAllowed,
    };
    window.NativeHlsProviderForTest.selectVariantTrack.call(provider, { id: '720' }, true);
    return {
      switchedTo: provider.switchedTo || '',
      manualTrackId: provider.manualTrackId || '',
      abrEnabled: engine.getPlayer().config.abr.enabled,
    };
  });

  expect(state.switchedTo).toBe('');
  expect(state.manualTrackId).toBe('');
  expect(state.abrEnabled).toBe(true);
});

test('native DASH fixture plays through MSE without Shaka fallback', async ({ page }) => {
  const shakaRequests = [];
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.abort();
  });

  const logs = [];
  page.on('console', msg => logs.push(msg.text()));
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player" muted playsinline style="width:1280px;height:720px"></video>');

  await page.evaluate(() => {
    const video = document.getElementById('player');
    video.muted = true;
    const engine = new window.PlayerEngine(video, { videoId: 'PLAYERTEST1', streamToken: '' });
    window.__engine = engine;
    window.__player = engine.getPlayer();
    return engine.init().then(() => engine.load('/api/stream/PLAYERTEST1/dash.mpd'));
  });

  await expect.poll(() => page.evaluate(() => window._playerProvider)).toBe('native-dash');
  await page.evaluate(() => document.getElementById('player').play());
  await page.waitForFunction(() => {
    const video = document.getElementById('player');
    return !video.paused && video.currentTime > 0 && video.buffered.length > 0;
  }, null, { timeout: 10_000 });

  const state = await page.evaluate(() => {
    const video = document.getElementById('player');
    const activeTrack = window.__player.getActiveVariantTrack();
    return {
      currentTime: video.currentTime,
      bufferedEnd: video.buffered.end(video.buffered.length - 1),
      activeTrack,
    };
  });

  expect(state.currentTime).toBeGreaterThan(0);
  expect(state.bufferedEnd).toBeGreaterThan(0);
  expect(state.activeTrack.height).toBe(360);
  expect(shakaRequests).toHaveLength(0);
  expect(logs.some(line => line.includes('falling back to shaka'))).toBe(false);
});

test('native DASH fixture seeks and rebuilds buffer without fallback', async ({ page }) => {
  const shakaRequests = [];
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.abort();
  });

  const logs = [];
  page.on('console', msg => logs.push(msg.text()));
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player" muted playsinline style="width:1280px;height:720px"></video>');

  await page.evaluate(() => {
    const video = document.getElementById('player');
    video.muted = true;
    const engine = new window.PlayerEngine(video, { videoId: 'PLAYERTEST1', streamToken: '' });
    window.__engine = engine;
    return engine.init().then(() => engine.load('/api/stream/PLAYERTEST1/dash.mpd'));
  });

  await page.evaluate(() => document.getElementById('player').play());
  await page.waitForFunction(() => document.getElementById('player').buffered.length > 0, null, { timeout: 10_000 });
  await page.evaluate(() => { document.getElementById('player').currentTime = 1.1; });
  await page.waitForFunction(() => {
    const video = document.getElementById('player');
    if (video.currentTime < 0.9 || video.buffered.length === 0) return false;
    for (let i = 0; i < video.buffered.length; i++) {
      if (video.currentTime >= video.buffered.start(i) - 0.1 && video.currentTime <= video.buffered.end(i) + 0.1) return true;
    }
    return false;
  }, null, { timeout: 10_000 });

  expect(await page.evaluate(() => window._playerProvider)).toBe('native-dash');
  expect(shakaRequests).toHaveLength(0);
  expect(logs.some(line => line.includes('falling back to shaka'))).toBe(false);
});

test('native DASH parser supports SegmentTemplate number, timeline, and set BaseURL', async ({ page }) => {
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const parsed = await page.evaluate(() => {
    const numberMpd = `<?xml version="1.0"?><MPD type="static" mediaPresentationDuration="PT6S"><Period>
<AdaptationSet mimeType="video/mp4"><BaseURL>/media/</BaseURL><SegmentTemplate timescale="1" duration="2" initialization="$RepresentationID$/init.mp4" media="$RepresentationID$/$Number$.m4s"/>
<Representation id="v1" bandwidth="800000" width="640" height="360" codecs="avc1.42c01f"/></AdaptationSet>
<AdaptationSet mimeType="audio/mp4"><BaseURL>/media/</BaseURL><SegmentTemplate timescale="1" duration="2" initialization="$RepresentationID$/init.mp4" media="$RepresentationID$/$Number$.m4s"/>
<Representation id="a1" bandwidth="64000" codecs="mp4a.40.2"/></AdaptationSet>
</Period></MPD>`;
    const timelineMpd = `<?xml version="1.0"?><MPD type="static" mediaPresentationDuration="PT6S"><Period>
<AdaptationSet mimeType="video/mp4"><SegmentTemplate timescale="1000" initialization="/i/$RepresentationID$" media="/m/$Time$"><SegmentTimeline><S t="0" d="2000" r="2"/></SegmentTimeline></SegmentTemplate>
<Representation id="v1" bandwidth="800000" width="640" height="360" codecs="avc1.42c01f"/></AdaptationSet>
<AdaptationSet mimeType="audio/mp4"><SegmentTemplate timescale="1000" initialization="/i/$RepresentationID$" media="/m/$Time$"><SegmentTimeline><S t="0" d="2000" r="2"/></SegmentTimeline></SegmentTemplate>
<Representation id="a1" bandwidth="64000" codecs="mp4a.40.2"/></AdaptationSet>
</Period></MPD>`;
    const number = window.NativeDashProviderForTest.parseMPD(numberMpd, 'https://example.test/dash/manifest.mpd');
    const timeline = window.NativeDashProviderForTest.parseMPD(timelineMpd, 'https://example.test/dash/manifest.mpd');
    return {
      numberInit: number.video[0].initUrl,
      numberSegments: number.video[0].templateSegments.map(seg => seg.url),
      timelineSegments: timeline.video[0].templateSegments.map(seg => ({ start: seg.start, end: seg.end, url: seg.url })),
    };
  });

  expect(parsed.numberInit).toBe('https://example.test/media/v1/init.mp4');
  expect(parsed.numberSegments).toHaveLength(3);
  expect(parsed.numberSegments[0]).toBe('https://example.test/media/v1/1.m4s');
  expect(parsed.timelineSegments).toEqual([
    { start: 0, end: 2, url: 'https://example.test/m/0' },
    { start: 2, end: 4, url: 'https://example.test/m/2000' },
    { start: 4, end: 6, url: 'https://example.test/m/4000' },
  ]);
});

test('native DASH parser supports SegmentList URL and byte-range segments', async ({ page }) => {
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const parsed = await page.evaluate(() => {
    const urlMpd = `<?xml version="1.0"?><MPD type="static" mediaPresentationDuration="PT6S"><Period duration="PT6S">
<AdaptationSet mimeType="video/mp4"><SegmentList timescale="1" duration="2"><Initialization sourceURL="v/init.mp4"/><SegmentURL media="v/1.m4s"/><SegmentURL media="v/2.m4s"/><SegmentURL media="v/3.m4s"/></SegmentList>
<Representation id="v1" bandwidth="800000" width="640" height="360" codecs="avc1.42c01f"/></AdaptationSet>
<AdaptationSet mimeType="audio/mp4"><SegmentList timescale="1" duration="2"><Initialization sourceURL="a/init.mp4"/><SegmentURL media="a/1.m4s"/><SegmentURL media="a/2.m4s"/><SegmentURL media="a/3.m4s"/></SegmentList>
<Representation id="a1" bandwidth="64000" codecs="mp4a.40.2"/></AdaptationSet>
</Period></MPD>`;
    const rangeMpd = `<?xml version="1.0"?><MPD type="static" mediaPresentationDuration="PT4S"><Period duration="PT4S">
<AdaptationSet mimeType="video/mp4"><BaseURL>/media/video.mp4</BaseURL><SegmentList timescale="1" duration="2"><Initialization range="0-99"/><SegmentURL mediaRange="100-199"/><SegmentURL mediaRange="200-299"/></SegmentList>
<Representation id="v1" bandwidth="800000" width="640" height="360" codecs="avc1.42c01f"/></AdaptationSet>
<AdaptationSet mimeType="audio/mp4"><BaseURL>/media/audio.mp4</BaseURL><SegmentList timescale="1" duration="2"><Initialization range="0-49"/><SegmentURL mediaRange="50-149"/><SegmentURL mediaRange="150-249"/></SegmentList>
<Representation id="a1" bandwidth="64000" codecs="mp4a.40.2"/></AdaptationSet>
</Period></MPD>`;
    const url = window.NativeDashProviderForTest.parseMPD(urlMpd, 'https://example.test/dash/manifest.mpd');
    const range = window.NativeDashProviderForTest.parseMPD(rangeMpd, 'https://example.test/dash/manifest.mpd');
    return {
      urlInit: url.video[0].initUrl,
      urlSegments: url.video[0].segments.map(seg => ({ start: seg.start, end: seg.end, url: seg.url, range: seg.range, appendWindow: seg.appendWindow })),
      rangeInit: range.video[0].initUrl,
      rangeInitRange: range.video[0].initRange,
      rangeSegments: range.video[0].segments.map(seg => ({ start: seg.start, end: seg.end, url: seg.url, range: seg.range })),
    };
  });

  expect(parsed.urlInit).toBe('https://example.test/dash/v/init.mp4');
  expect(parsed.urlSegments).toEqual([
    { start: 0, end: 2, url: 'https://example.test/dash/v/1.m4s', range: null, appendWindow: { start: 0, end: 6 } },
    { start: 2, end: 4, url: 'https://example.test/dash/v/2.m4s', range: null, appendWindow: { start: 0, end: 6 } },
    { start: 4, end: 6, url: 'https://example.test/dash/v/3.m4s', range: null, appendWindow: { start: 0, end: 6 } },
  ]);
  expect(parsed.rangeInit).toBe('https://example.test/media/video.mp4');
  expect(parsed.rangeInitRange).toEqual({ start: 0, end: 99 });
  expect(parsed.rangeSegments).toEqual([
    { start: 0, end: 2, url: 'https://example.test/media/video.mp4', range: { start: 100, end: 199 } },
    { start: 2, end: 4, url: 'https://example.test/media/video.mp4', range: { start: 200, end: 299 } },
  ]);
});

test('native DASH parser supports inherited SegmentList metadata', async ({ page }) => {
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const parsed = await page.evaluate(() => {
    const mpd = `<?xml version="1.0"?><MPD type="static" mediaPresentationDuration="PT4S">
<BaseURL>https://cdn.example.test/root/</BaseURL>
<SegmentList timescale="1" duration="2"><Initialization sourceURL="init.mp4"/></SegmentList>
<Period duration="PT4S"><BaseURL>period/</BaseURL>
<AdaptationSet mimeType="video/mp4"><BaseURL>video/</BaseURL><SegmentList><SegmentURL media="seg-1.m4s"/><SegmentURL media="seg-2.m4s"/></SegmentList>
<Representation id="v1" bandwidth="800000" width="640" height="360" codecs="avc1.42c01f"><BaseURL>rep/</BaseURL></Representation></AdaptationSet>
<AdaptationSet mimeType="audio/mp4"><BaseURL>audio/</BaseURL><SegmentList><SegmentURL media="seg-1.m4s"/><SegmentURL media="seg-2.m4s"/></SegmentList>
<Representation id="a1" bandwidth="64000" codecs="mp4a.40.2"/></AdaptationSet>
</Period></MPD>`;
    const out = window.NativeDashProviderForTest.parseMPD(mpd, 'https://origin.example.test/manifest.mpd');
    return {
      videoInit: out.video[0].initUrl,
      videoSegments: out.video[0].segments.map(seg => ({ start: seg.start, end: seg.end, url: seg.url })),
      audioInit: out.audio[0].initUrl,
      audioSegment: out.audio[0].segments[0].url,
    };
  });

  expect(parsed).toEqual({
    videoInit: 'https://cdn.example.test/root/period/video/rep/init.mp4',
    videoSegments: [
      { start: 0, end: 2, url: 'https://cdn.example.test/root/period/video/rep/seg-1.m4s' },
      { start: 2, end: 4, url: 'https://cdn.example.test/root/period/video/rep/seg-2.m4s' },
    ],
    audioInit: 'https://cdn.example.test/root/period/audio/init.mp4',
    audioSegment: 'https://cdn.example.test/root/period/audio/seg-1.m4s',
  });
});

test('native DASH parser supports dynamic live SegmentTemplate metadata', async ({ page }) => {
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const parsed = await page.evaluate(() => {
    const mpd = `<?xml version="1.0"?><MPD type="dynamic" availabilityStartTime="2026-05-04T00:00:00Z" minimumUpdatePeriod="PT2S" timeShiftBufferDepth="PT4S"><Period start="PT10S">
<AdaptationSet mimeType="video/mp4"><SegmentTemplate timescale="1000" presentationTimeOffset="10000" initialization="/i/$RepresentationID$" media="/m/$Time$"><SegmentTimeline><S t="10000" d="2000" r="2"/></SegmentTimeline></SegmentTemplate>
<Representation id="v1" bandwidth="800000" width="640" height="360" codecs="avc1.42c01f"/></AdaptationSet>
<AdaptationSet mimeType="audio/mp4"><SegmentTemplate timescale="1000" presentationTimeOffset="10000" initialization="/i/$RepresentationID$" media="/a/$Time$"><SegmentTimeline><S t="10000" d="2000" r="2"/></SegmentTimeline></SegmentTemplate>
<Representation id="a1" bandwidth="64000" codecs="mp4a.40.2"/></AdaptationSet>
</Period></MPD>`;
    const out = window.NativeDashProviderForTest.parseMPD(mpd, 'https://example.test/live/manifest.mpd');
    return {
      type: out.type,
      minimumUpdatePeriod: out.minimumUpdatePeriod,
      liveWindow: out.liveWindow,
      segments: out.video[0].templateSegments.map(seg => ({ start: seg.start, end: seg.end, url: seg.url })),
    };
  });

  expect(parsed.type).toBe('dynamic');
  expect(parsed.minimumUpdatePeriod).toBe(2);
  expect(parsed.liveWindow).toEqual({ start: 12, end: 16 });
  expect(parsed.segments).toEqual([
    { start: 10, end: 12, url: 'https://example.test/m/10000' },
    { start: 12, end: 14, url: 'https://example.test/m/12000' },
    { start: 14, end: 16, url: 'https://example.test/m/14000' },
  ]);
});

test('native DASH parser supports simple static multi-period timelines', async ({ page }) => {
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const parsed = await page.evaluate(() => {
    const mpd = `<?xml version="1.0"?><MPD type="static" mediaPresentationDuration="PT8S">
<Period id="p0" start="PT0S" duration="PT4S">
<AdaptationSet mimeType="video/mp4"><SegmentTemplate timescale="1000" initialization="/i/$RepresentationID$" media="/v/$Time$"><SegmentTimeline><S t="0" d="2000" r="1"/></SegmentTimeline></SegmentTemplate>
<Representation id="v1" bandwidth="800000" width="640" height="360" codecs="avc1.42c01f"/></AdaptationSet>
<AdaptationSet mimeType="audio/mp4"><SegmentTemplate timescale="1000" initialization="/i/$RepresentationID$" media="/a/$Time$"><SegmentTimeline><S t="0" d="2000" r="1"/></SegmentTimeline></SegmentTemplate>
<Representation id="a1" bandwidth="64000" codecs="mp4a.40.2"/></AdaptationSet>
</Period>
<Period id="p1" start="PT4S" duration="PT4S">
<AdaptationSet mimeType="video/mp4"><SegmentTemplate timescale="1000" initialization="/i/$RepresentationID$" media="/v2/$Time$"><SegmentTimeline><S t="0" d="2000" r="1"/></SegmentTimeline></SegmentTemplate>
<Representation id="v1" bandwidth="800000" width="640" height="360" codecs="avc1.42c01f"/></AdaptationSet>
<AdaptationSet mimeType="audio/mp4"><SegmentTemplate timescale="1000" initialization="/i/$RepresentationID$" media="/a2/$Time$"><SegmentTimeline><S t="0" d="2000" r="1"/></SegmentTimeline></SegmentTemplate>
<Representation id="a1" bandwidth="64000" codecs="mp4a.40.2"/></AdaptationSet>
</Period>
</MPD>`;
    const out = window.NativeDashProviderForTest.parseMPD(mpd, 'https://example.test/manifest.mpd');
    return out.video[0].templateSegments.map(seg => ({
      start: seg.start,
      end: seg.end,
      periodIndex: seg.periodIndex,
      appendWindow: seg.appendWindow,
    }));
  });

  expect(parsed).toEqual([
    { start: 0, end: 2, periodIndex: 0, appendWindow: { start: 0, end: 4 } },
    { start: 2, end: 4, periodIndex: 0, appendWindow: { start: 0, end: 4 } },
    { start: 4, end: 6, periodIndex: 1, appendWindow: { start: 4, end: 8 } },
    { start: 6, end: 8, periodIndex: 1, appendWindow: { start: 4, end: 8 } },
  ]);
});

test('native DASH parser supports compatible dynamic multi-period timelines', async ({ page }) => {
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const parsed = await page.evaluate(() => {
    const mpd = `<?xml version="1.0"?><MPD type="dynamic" profiles="urn:mpeg:dash:profile:isoff-live:2011" availabilityStartTime="2026-05-04T00:00:00Z" minimumUpdatePeriod="PT1S" timeShiftBufferDepth="PT6S">
<Period id="p0" start="PT0S" duration="PT4S">
<AdaptationSet mimeType="video/mp4"><SegmentTemplate timescale="1000" initialization="/i/$RepresentationID$" media="/v/$Time$" presentationTimeOffset="0"><SegmentTimeline><S t="0" d="2000" r="1"/></SegmentTimeline></SegmentTemplate>
<Representation id="v1" bandwidth="800000" width="640" height="360" codecs="avc1.42c01f"/></AdaptationSet>
<AdaptationSet mimeType="audio/mp4"><SegmentTemplate timescale="1000" initialization="/i/$RepresentationID$" media="/a/$Time$" presentationTimeOffset="0"><SegmentTimeline><S t="0" d="2000" r="1"/></SegmentTimeline></SegmentTemplate>
<Representation id="a1" bandwidth="64000" codecs="mp4a.40.2"/></AdaptationSet>
</Period>
<Period id="p1" start="PT4S" duration="PT4S">
<AdaptationSet mimeType="video/mp4"><SegmentTemplate timescale="1000" initialization="/i/$RepresentationID$" media="/v2/$Time$" presentationTimeOffset="4000"><SegmentTimeline><S t="4000" d="2000" r="1"/></SegmentTimeline></SegmentTemplate>
<Representation id="v1" bandwidth="800000" width="640" height="360" codecs="avc1.42c01f"/></AdaptationSet>
<AdaptationSet mimeType="audio/mp4"><SegmentTemplate timescale="1000" initialization="/i/$RepresentationID$" media="/a2/$Time$" presentationTimeOffset="4000"><SegmentTimeline><S t="4000" d="2000" r="1"/></SegmentTimeline></SegmentTemplate>
<Representation id="a1" bandwidth="64000" codecs="mp4a.40.2"/></AdaptationSet>
</Period>
</MPD>`;
    const out = window.NativeDashProviderForTest.parseMPD(mpd, 'https://example.test/live/manifest.mpd');
    return {
      type: out.type,
      periodCount: out.periodCount,
      profile: out.profile,
      liveWindow: out.liveWindow,
      segments: out.video[0].templateSegments.map(seg => ({ start: seg.start, end: seg.end, periodIndex: seg.periodIndex, appendWindow: seg.appendWindow })),
    };
  });

  expect(parsed.type).toBe('dynamic');
  expect(parsed.periodCount).toBe(2);
  expect(parsed.profile).toBe('urn:mpeg:dash:profile:isoff-live:2011');
  expect(parsed.liveWindow).toEqual({ start: 2, end: 8 });
  expect(parsed.segments).toEqual([
    { start: 0, end: 2, periodIndex: 0, appendWindow: { start: 0, end: 4 } },
    { start: 2, end: 4, periodIndex: 0, appendWindow: { start: 0, end: 4 } },
    { start: 4, end: 6, periodIndex: 1, appendWindow: { start: 4, end: 8 } },
    { start: 6, end: 8, periodIndex: 1, appendWindow: { start: 4, end: 8 } },
  ]);
});

test('native DASH parser resolves hierarchical BaseURL inheritance', async ({ page }) => {
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const parsed = await page.evaluate(() => {
    const mpd = `<?xml version="1.0"?><MPD type="static" mediaPresentationDuration="PT4S">
<BaseURL>https://cdn.example.test/root/</BaseURL>
<Period duration="PT4S"><BaseURL>period/</BaseURL>
<AdaptationSet mimeType="video/mp4"><BaseURL>video/</BaseURL><SegmentTemplate timescale="1" duration="2" initialization="init/$RepresentationID$.mp4" media="seg/$Number$.m4s"/>
<Representation id="v1" bandwidth="800000" width="640" height="360" codecs="avc1.42c01f"><BaseURL>rep/</BaseURL></Representation></AdaptationSet>
<AdaptationSet mimeType="audio/mp4"><BaseURL>audio/</BaseURL><SegmentTemplate timescale="1" duration="2" initialization="init/$RepresentationID$.mp4" media="seg/$Number$.m4s"/>
<Representation id="a1" bandwidth="64000" codecs="mp4a.40.2"/></AdaptationSet>
</Period></MPD>`;
    const out = window.NativeDashProviderForTest.parseMPD(mpd, 'https://origin.example.test/manifest.mpd');
    return {
      videoInit: out.video[0].initUrl,
      videoSegment: out.video[0].templateSegments[0].url,
      audioInit: out.audio[0].initUrl,
      audioSegment: out.audio[0].templateSegments[0].url,
    };
  });

  expect(parsed).toEqual({
    videoInit: 'https://cdn.example.test/root/period/video/rep/init/v1.mp4',
    videoSegment: 'https://cdn.example.test/root/period/video/rep/seg/1.m4s',
    audioInit: 'https://cdn.example.test/root/period/audio/init/a1.mp4',
    audioSegment: 'https://cdn.example.test/root/period/audio/seg/1.m4s',
  });
});

test('native DASH parser expands bounded negative SegmentTimeline repeats', async ({ page }) => {
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const parsed = await page.evaluate(() => {
    const mpd = `<?xml version="1.0"?><MPD type="static" mediaPresentationDuration="PT6S"><Period duration="PT6S">
<AdaptationSet mimeType="video/mp4"><SegmentTemplate timescale="1000" initialization="/i/$RepresentationID$" media="/v/$Time$"><SegmentTimeline><S t="0" d="2000" r="-1"/></SegmentTimeline></SegmentTemplate>
<Representation id="v1" bandwidth="800000" width="640" height="360" codecs="avc1.42c01f"/></AdaptationSet>
<AdaptationSet mimeType="audio/mp4"><SegmentTemplate timescale="1000" initialization="/i/$RepresentationID$" media="/a/$Time$"><SegmentTimeline><S t="0" d="2000" r="-1"/></SegmentTimeline></SegmentTemplate>
<Representation id="a1" bandwidth="64000" codecs="mp4a.40.2"/></AdaptationSet>
</Period></MPD>`;
    const out = window.NativeDashProviderForTest.parseMPD(mpd, 'https://example.test/manifest.mpd');
    return {
      warnings: out.warnings,
      segments: out.video[0].templateSegments.map(seg => ({ start: seg.start, end: seg.end, url: seg.url })),
    };
  });

  expect(parsed.warnings).toEqual(['segmenttimeline-negative-repeat-expanded', 'segmenttimeline-negative-repeat-expanded']);
  expect(parsed.segments).toEqual([
    { start: 0, end: 2, url: 'https://example.test/v/0' },
    { start: 2, end: 4, url: 'https://example.test/v/2000' },
    { start: 4, end: 6, url: 'https://example.test/v/4000' },
  ]);
});

test('native DASH parser rejects incompatible codec changes across periods', async ({ page }) => {
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const error = await page.evaluate(() => {
    const mpd = `<?xml version="1.0"?><MPD type="dynamic" availabilityStartTime="2026-05-04T00:00:00Z" timeShiftBufferDepth="PT8S">
<Period start="PT0S" duration="PT4S"><AdaptationSet mimeType="video/mp4"><SegmentTemplate timescale="1000" initialization="/i/$RepresentationID$" media="/v/$Time$"><SegmentTimeline><S t="0" d="2000" r="1"/></SegmentTimeline></SegmentTemplate><Representation id="v1" bandwidth="1" codecs="avc1.42c01f"/></AdaptationSet><AdaptationSet mimeType="audio/mp4"><SegmentTemplate timescale="1000" initialization="/i/$RepresentationID$" media="/a/$Time$"><SegmentTimeline><S t="0" d="2000" r="1"/></SegmentTimeline></SegmentTemplate><Representation id="a1" bandwidth="1" codecs="mp4a.40.2"/></AdaptationSet></Period>
<Period start="PT4S" duration="PT4S"><AdaptationSet mimeType="video/mp4"><SegmentTemplate timescale="1000" presentationTimeOffset="4000" initialization="/i/$RepresentationID$" media="/v2/$Time$"><SegmentTimeline><S t="4000" d="2000" r="1"/></SegmentTimeline></SegmentTemplate><Representation id="v1" bandwidth="1" codecs="hev1.1.6.L93.B0"/></AdaptationSet><AdaptationSet mimeType="audio/mp4"><SegmentTemplate timescale="1000" presentationTimeOffset="4000" initialization="/i/$RepresentationID$" media="/a2/$Time$"><SegmentTimeline><S t="4000" d="2000" r="1"/></SegmentTimeline></SegmentTemplate><Representation id="a1" bandwidth="1" codecs="mp4a.40.2"/></AdaptationSet></Period>
</MPD>`;
    try {
      window.NativeDashProviderForTest.parseMPD(mpd, 'https://example.test/manifest.mpd');
      return '';
    } catch (err) {
      return err.message;
    }
  });

  expect(error).toBe('dash-multiperiod-codec-unsupported');
});

test('native DASH parser preserves audio track language and label metadata', async ({ page }) => {
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const parsed = await page.evaluate(() => {
    const mpd = `<?xml version="1.0"?><MPD type="static" mediaPresentationDuration="PT4S"><Period>
<AdaptationSet mimeType="video/mp4"><SegmentTemplate timescale="1" duration="2" initialization="/v/$RepresentationID$/init.mp4" media="/v/$RepresentationID$/$Number$.m4s"/>
<Representation id="v1" bandwidth="800000" width="640" height="360" codecs="avc1.42c01f"/></AdaptationSet>
<AdaptationSet mimeType="audio/mp4" lang="es" label="Spanish"><SegmentTemplate timescale="1" duration="2" initialization="/a/$RepresentationID$/init.mp4" media="/a/$RepresentationID$/$Number$.m4s"/>
<Representation id="a-es" bandwidth="64000" codecs="mp4a.40.2"/></AdaptationSet>
<AdaptationSet mimeType="audio/mp4" lang="en" label="English"><SegmentTemplate timescale="1" duration="2" initialization="/a/$RepresentationID$/init.mp4" media="/a/$RepresentationID$/$Number$.m4s"/>
<Representation id="a-en" bandwidth="48000" codecs="mp4a.40.2"/></AdaptationSet>
</Period></MPD>`;
    const out = window.NativeDashProviderForTest.parseMPD(mpd, 'https://example.test/manifest.mpd');
    return out.audio.map(rep => ({ id: rep.id, language: rep.language, label: rep.label }));
  });

  expect(parsed).toEqual([
    { id: 'a-es', language: 'es', label: 'Spanish' },
    { id: 'a-en', language: 'en', label: 'English' },
  ]);
});

test('native DASH parser preserves track roles accessibility and text metadata', async ({ page }) => {
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const parsed = await page.evaluate(() => {
    const mpd = `<?xml version="1.0"?><MPD type="static" mediaPresentationDuration="PT4S"><Period>
<AdaptationSet mimeType="video/mp4"><SegmentTemplate timescale="1" duration="2" initialization="/v/$RepresentationID$/init.mp4" media="/v/$RepresentationID$/$Number$.m4s"/>
<Representation id="v1" bandwidth="800000" width="640" height="360" codecs="avc1.42c01f"/></AdaptationSet>
<AdaptationSet mimeType="audio/mp4" lang="en"><Label>English main</Label><Role schemeIdUri="urn:mpeg:dash:role:2011" value="main"/><Accessibility schemeIdUri="urn:tva:metadata:cs:AudioPurposeCS:2007" value="1"/><AudioChannelConfiguration schemeIdUri="urn:mpeg:dash:23003:3:audio_channel_configuration:2011" value="2"/><SegmentTemplate timescale="1" duration="2" initialization="/a/$RepresentationID$/init.mp4" media="/a/$RepresentationID$/$Number$.m4s"/>
<Representation id="a-main" bandwidth="64000" codecs="mp4a.40.2" audioSamplingRate="48000"/></AdaptationSet>
<AdaptationSet mimeType="text/vtt" lang="en"><Label>English captions</Label><Role schemeIdUri="urn:mpeg:dash:role:2011" value="subtitle"/><BaseURL>/captions/en.vtt</BaseURL><Representation id="text-en" bandwidth="0"/></AdaptationSet>
<AdaptationSet mimeType="application/ttml+xml" lang="es"><Label>Spanish TTML</Label><Role schemeIdUri="urn:mpeg:dash:role:2011" value="subtitle"/><BaseURL>/captions/es.ttml</BaseURL><Representation id="text-es" bandwidth="0"/></AdaptationSet>
</Period></MPD>`;
    const out = window.NativeDashProviderForTest.parseMPD(mpd, 'https://example.test/manifest.mpd');
    return {
      audio: out.audio.map(rep => ({
        id: rep.id,
        label: rep.label,
        roles: rep.roles,
        accessibility: rep.accessibility,
        channels: rep.channels,
        asr: rep.asr,
      })),
      text: out.text.map(rep => ({
        id: rep.id,
        language: rep.language,
        label: rep.label,
        mimeType: rep.mimeType,
        roles: rep.roles,
        url: rep.url,
        supported: rep.supported,
        source: rep.source,
      })),
    };
  });

  expect(parsed.audio).toEqual([{
    id: 'a-main',
    label: 'English main',
    roles: ['main'],
    accessibility: ['1'],
    channels: '2',
    asr: 48000,
  }]);
  expect(parsed.text).toEqual([
    {
      id: 'text-en',
      language: 'en',
      label: 'English captions',
      mimeType: 'text/vtt',
      roles: ['subtitle'],
      url: 'https://example.test/captions/en.vtt',
      supported: true,
      source: 'native-dash',
    },
    {
      id: 'text-es',
      language: 'es',
      label: 'Spanish TTML',
      mimeType: 'application/ttml+xml',
      roles: ['subtitle'],
      url: 'https://example.test/captions/es.ttml',
      supported: true,
      source: 'native-dash',
    },
  ]);
});

test('native DASH audio role ordering prefers main over commentary', async ({ page }) => {
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const ordered = await page.evaluate(() => {
    const reps = [
      { id: 'commentary', language: 'en', label: 'English commentary', bandwidth: 128000, roles: ['commentary'] },
      { id: 'descriptive', language: 'en', label: 'English descriptive', bandwidth: 96000, roles: ['description'] },
      { id: 'main', language: 'en', label: 'English', bandwidth: 64000, roles: ['main'] },
      { id: 'es-main', language: 'es', label: 'Spanish', bandwidth: 128000, roles: ['main'] },
    ];
    reps.sort(window.NativeDashProviderForTest.compareAudioReps);
    return reps.map(rep => rep.id);
  });

  expect(ordered).toEqual(['main', 'es-main', 'commentary', 'descriptive']);
});

test('native DASH exposes audio tracks and switches audio without touching video buffer', async ({ page }) => {
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const state = await page.evaluate(() => {
    function makeSourceBuffer() {
      const listeners = {};
      let appendCalls = 0;
      let removeCalls = 0;
      let changeTypeCalls = 0;
      return {
        get appendCalls() { return appendCalls; },
        get removeCalls() { return removeCalls; },
        get changeTypeCalls() { return changeTypeCalls; },
        updating: false,
        buffered: { length: 1, start() { return 0; }, end() { return 20; } },
        addEventListener(name, fn) { listeners[name] = fn; },
        removeEventListener(name) { delete listeners[name]; },
        appendBuffer() {
          appendCalls++;
          setTimeout(() => { if (listeners.updateend) listeners.updateend(); }, 0);
        },
        remove() {
          removeCalls++;
          setTimeout(() => { if (listeners.updateend) listeners.updateend(); }, 0);
        },
        changeType() { changeTypeCalls++; },
      };
    }

    const video = document.getElementById('player');
    Object.defineProperty(video, 'currentTime', { configurable: true, get() { return 8; } });
    const engine = new window.PlayerEngine(video, { videoId: 'TESTVIDEO01', streamToken: 'test-token' });
    engine._telemetry.record = function () {};
    const videoSb = makeSourceBuffer();
    const audioSb = makeSourceBuffer();
    const audio1 = { id: 'a-en', kind: 'audio', mimeType: 'audio/mp4', codecs: 'mp4a.40.2', bandwidth: 48000, language: 'en', label: 'English', initData: new ArrayBuffer(1), segments: [{ start: 0, end: 2 }] };
    const audio2 = { id: 'a-es', kind: 'audio', mimeType: 'audio/mp4', codecs: 'mp4a.40.2', bandwidth: 64000, language: 'es', label: 'Spanish', initData: new ArrayBuffer(1), segments: [{ start: 0, end: 2 }] };
    const provider = {
      engine,
      video,
      audio: audio1,
      audioReps: [audio1, audio2],
      audioSb,
      videoSb,
      audioMime: 'audio/mp4; codecs="mp4a.40.2"',
      controllers: [],
      requestGeneration: 0,
      activeRanges: {},
      destroyed: false,
      lastError: '',
      _abortRequests() {
        this.requestGeneration++;
        this.activeRanges = {};
      },
      _prepareRep(rep) { return Promise.resolve(rep); },
      _changeAudioTypeIfNeeded() { return Promise.resolve(); },
      _tick() { this.ticked = true; },
      getActiveAudioTrack: window.NativeDashProviderForTest.getActiveAudioTrack,
      getAudioTracks: window.NativeDashProviderForTest.getAudioTracks,
      _switchAudio: window.NativeDashProviderForTest._switchAudio,
      selectAudioTrack: window.NativeDashProviderForTest.selectAudioTrack,
    };
    engine._provider = provider;
    const before = provider.getAudioTracks();
    provider.selectAudioTrack({ id: 'a-es' });
    return new Promise(resolve => setTimeout(() => resolve({
      before,
      active: provider.getActiveAudioTrack(),
      videoRemoveCalls: videoSb.removeCalls,
      audioRemoveCalls: audioSb.removeCalls,
      audioAppendCalls: audioSb.appendCalls,
      generation: provider.requestGeneration,
      ticked: !!provider.ticked,
    }), 20));
  });

  expect(state.before).toEqual([
    expect.objectContaining({ id: 'a-en', active: true, language: 'en', label: 'English' }),
    expect.objectContaining({ id: 'a-es', active: false, language: 'es', label: 'Spanish' }),
  ]);
  expect(state.active).toMatchObject({ id: 'a-es', active: true, language: 'es' });
  expect(state.videoRemoveCalls).toBe(0);
  expect(state.audioRemoveCalls).toBe(1);
  expect(state.audioAppendCalls).toBe(1);
  expect(state.generation).toBe(1);
  expect(state.ticked).toBe(true);
});

test('adapter text track APIs render selected cues through the caption overlay', async ({ page }) => {
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video><div class="custom-caption-container"></div>');

  const state = await page.evaluate(() => {
    window.__disablePlayerTelemetry = true;
    const video = document.getElementById('player');
    const overlay = document.querySelector('.custom-caption-container');
    Object.defineProperty(video, 'currentTime', { configurable: true, get() { return 1; } });
    const engine = new window.PlayerEngine(video, { videoId: 'TESTVIDEO01', streamToken: 'test-token' });
    const controller = {
      tracks: [{ id: 'en', language: 'en', label: 'English', active: false }],
      activeId: '',
      cues: {
        en: [{ start: 0, end: 4, text: 'Hello captions' }],
      },
      getTextTracks() {
        const activeId = this.activeId;
        return this.tracks.map(track => ({ ...track, active: track.id === activeId }));
      },
      getActiveTextTrack() {
        return this.getTextTracks().find(track => track.active) || null;
      },
      selectTextTrack(track) {
        this.activeId = track.id;
        const cue = this.cues[track.id].find(item => video.currentTime >= item.start && video.currentTime < item.end);
        overlay.textContent = cue ? cue.text : '';
        return Promise.resolve();
      },
      setTextTrackVisibility(visible) {
        if (!visible) overlay.textContent = '';
        return Promise.resolve();
      },
    };
    engine.setTextController(controller);
    const player = engine.getPlayer();
    return player.selectTextTrack(player.getTextTracks()[0]).then(() => ({
      active: player.getActiveTextTrack(),
      visibleText: overlay.textContent,
      count: player.getTextTracks().length,
    }));
  });

  expect(state.count).toBe(1);
  expect(state.active).toMatchObject({ id: 'en', language: 'en', label: 'English', active: true });
  expect(state.visibleText).toContain('Hello captions');
});

test('adapter merges native DASH text tracks with controller captions', async ({ page }) => {
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const state = await page.evaluate(() => {
    const video = document.getElementById('player');
    const engine = new window.PlayerEngine(video, { videoId: 'TESTVIDEO01', streamToken: 'test-token' });
    const provider = {
      engine,
      textReps: [
        { id: 'dash-en', language: 'en', label: 'DASH English', mimeType: 'text/vtt', roles: ['subtitle'], accessibility: [], url: '/captions/en.vtt', supported: true },
        { id: 'dash-ttml', language: 'es', label: 'DASH Spanish', mimeType: 'application/ttml+xml', roles: ['subtitle'], accessibility: [], url: '/captions/es.ttml', supported: true },
      ],
      activeTextTrackId: '',
      textTrackVisibility: false,
      getTextTracks: window.NativeDashProviderForTest.getTextTracks,
      getActiveTextTrack: window.NativeDashProviderForTest.getActiveTextTrack,
      selectTextTrack: window.NativeDashProviderForTest.selectTextTrack,
      setTextTrackVisibility: window.NativeDashProviderForTest.setTextTrackVisibility,
    };
    engine._provider = provider;
    engine.setTextController({
      activeId: '',
      getTextTracks() { return [{ id: 'controller-en', language: 'en', label: 'Controller English', active: this.activeId === 'controller-en' }]; },
      getActiveTextTrack() { return this.getTextTracks().find(track => track.active) || null; },
      selectTextTrack(track) { this.activeId = track.id; return Promise.resolve(); },
      setTextTrackVisibility(visible) { if (!visible) this.activeId = ''; return Promise.resolve(); },
    });
    const player = engine.getPlayer();
    const before = player.getTextTracks();
    return player.selectTextTrack(before.find(track => track.id === 'dash-en')).then(() => ({
      before,
      active: player.getActiveTextTrack(),
      after: player.getTextTracks(),
    }));
  });

  expect(state.before).toEqual([
    expect.objectContaining({ id: 'controller-en', label: 'Controller English', active: false }),
    expect.objectContaining({ id: 'dash-en', label: 'DASH English', supported: true, active: false }),
    expect.objectContaining({ id: 'dash-ttml', label: 'DASH Spanish', supported: true, active: false }),
  ]);
  expect(state.active).toMatchObject({ id: 'dash-en', active: true, roles: ['subtitle'] });
  expect(state.after.find(track => track.id === 'dash-en')).toMatchObject({ active: true });
});

test('adapter routes native DASH sidecar text through caption controller', async ({ page }) => {
  await page.route('**/captions/native-en.vtt**', route => {
    route.fulfill({
      status: 200,
      contentType: 'text/vtt',
      body: 'WEBVTT\n\n00:00:00.000 --> 00:00:04.000\nNative DASH captions\n',
    });
  });
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video><div id="caption-overlay"></div>');

  const state = await page.evaluate(() => {
    function parseVtt(text) {
      const match = text.match(/(\d\d:\d\d:\d\d\.\d\d\d)\s+-->\s+(\d\d:\d\d:\d\d\.\d\d\d)\s+([\s\S]*)/);
      return match ? [{ start: 0, end: 4, text: match[3].trim() }] : [];
    }
    const video = document.getElementById('player');
    const overlay = document.getElementById('caption-overlay');
    Object.defineProperty(video, 'currentTime', { configurable: true, get() { return 1; } });
    const engine = new window.PlayerEngine(video, { videoId: 'TESTVIDEO01', streamToken: 'test-token' });
    const provider = {
      engine,
      textReps: [
        { id: 'dash-en', source: 'native-dash', language: 'en', label: 'DASH English', mimeType: 'text/vtt', roles: ['subtitle'], accessibility: [], url: '/captions/native-en.vtt', supported: true },
      ],
      activeTextTrackId: '',
      textTrackVisibility: false,
      getTextTracks: window.NativeDashProviderForTest.getTextTracks,
      getActiveTextTrack: window.NativeDashProviderForTest.getActiveTextTrack,
      selectTextTrack: window.NativeDashProviderForTest.selectTextTrack,
      setTextTrackVisibility: window.NativeDashProviderForTest.setTextTrackVisibility,
    };
    engine._provider = provider;
    engine.setTextController({
      activeTrackId: '',
      cues: [],
      getTextTracks() {
        return provider.getTextTracks().map(track => ({ ...track, active: this.activeTrackId === track.id }));
      },
      getActiveTextTrack() {
        return this.getTextTracks().find(track => track.active) || null;
      },
      selectTextTrack(track) {
        return fetch(track.url).then(r => r.text()).then(text => {
          this.cues = parseVtt(text);
          this.activeTrackId = track.id;
          const cue = this.cues.find(item => video.currentTime >= item.start && video.currentTime < item.end);
          overlay.textContent = cue ? cue.text : '';
          provider.selectTextTrack(track);
        });
      },
      setTextTrackVisibility(visible) {
        if (!visible) {
          this.activeTrackId = '';
          overlay.textContent = '';
        }
        return Promise.resolve();
      },
    });
    const player = engine.getPlayer();
    const track = player.getTextTracks().find(item => item.id === 'dash-en');
    return player.selectTextTrack(track).then(() => ({
      active: player.getActiveTextTrack(),
      overlayText: overlay.textContent,
      providerActive: provider.getActiveTextTrack(),
    }));
  });

  expect(state.active).toMatchObject({ id: 'dash-en', source: 'native-dash', active: true });
  expect(state.providerActive).toMatchObject({ id: 'dash-en', active: true });
  expect(state.overlayText).toBe('Native DASH captions');
});

test('fallback provider exposes normalized audio and text track stats', async ({ page }) => {
  await page.route('**/api/stream/TESTVIDEO04/dash.mpd**', route => {
    route.fulfill({
      status: 200,
      contentType: 'application/dash+xml',
      body: '<?xml version="1.0"?><MPD type="static" mediaPresentationDuration="PT1S"><Period></Period></MPD>',
    });
  });
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: [
        'window.shaka={};',
        'shaka.polyfill={installAll:function(){}};',
        'shaka.Player=function(){this.attach=function(){return Promise.resolve()};this.configure=function(){};this.addEventListener=function(){};this.load=function(){return Promise.resolve()};this.getVariantTracks=function(){return[{id:"v",height:360,active:true,audioId:"a-en",language:"en",label:"English",audioBandwidth:64000,audioCodec:"mp4a.40.2"}]};this.getAudioTracks=function(){return[{id:"a-en",language:"en",label:"English",active:true}]};this.selectAudioTrack=function(){};this.destroy=function(){return Promise.resolve()};};',
        'shaka.Player.isBrowserSupported=function(){return true};',
        'shaka.net={NetworkingEngine:{PluginPriority:{APPLICATION:1},registerScheme:function(){}}};',
        'shaka.util={Error:{Severity:{RECOVERABLE:1},Category:{NETWORK:1},Code:{OPERATION_ABORTED:1}},AbortableOperation:function(promise){return promise}};',
      ].join(''),
    });
  });

  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const stats = await page.evaluate(() => {
    const video = document.getElementById('player');
    const engine = new window.PlayerEngine(video, { videoId: 'TESTVIDEO04', streamToken: 'test-token' });
    engine.setTextController({
      getTextTracks() { return [{ id: 'en', language: 'en', label: 'English', active: true }]; },
      getActiveTextTrack() { return { id: 'en', language: 'en', label: 'English', active: true }; },
      selectTextTrack() { return Promise.resolve(); },
      setTextTrackVisibility() { return Promise.resolve(); },
    });
    return engine.init().then(() => engine.load()).then(() => engine.getPlayer().getStats());
  });

  expect(stats.provider).toBe('shaka-fallback');
  expect(stats.activeAudio).toMatchObject({ id: 'a-en', language: 'en', label: 'English', active: true });
  expect(stats.audioTrackCount).toBe(1);
  expect(stats.activeTextTrack).toMatchObject({ id: 'en', language: 'en', label: 'English', active: true });
  expect(stats.textTrackCount).toBe(1);
});

test('native DASH template fixture plays and seeks without Shaka fallback', async ({ page }) => {
  const shakaRequests = [];
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.abort();
  });

  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player" muted playsinline style="width:1280px;height:720px"></video>');

  await page.evaluate(() => {
    const video = document.getElementById('player');
    video.muted = true;
    const engine = new window.PlayerEngine(video, { videoId: 'PLAYERTEST1', streamToken: '' });
    window.__engine = engine;
    window.__player = engine.getPlayer();
    return engine.init().then(() => engine.load('/api/stream/PLAYERTEST1/dash.mpd?fixtureTemplate=timeline'));
  });

  await expect.poll(() => page.evaluate(() => window._playerProvider)).toBe('native-dash');
  await page.evaluate(() => document.getElementById('player').play());
  await page.waitForFunction(() => document.getElementById('player').currentTime > 0, null, { timeout: 10_000 });
  await page.evaluate(() => { document.getElementById('player').currentTime = 1.1; });
  await page.waitForFunction(() => document.getElementById('player').buffered.length > 0 && document.getElementById('player').currentTime > 0.9, null, { timeout: 10_000 });

  const stats = await page.evaluate(() => window.__player.getStats());
  expect(stats.activeVariant.height).toBeGreaterThan(0);
  expect(stats.activeAudio.id).toBe('a64');
  expect(shakaRequests).toHaveLength(0);
});

test('native DASH SegmentList fixture plays range-backed media without Shaka fallback', async ({ page }) => {
  const shakaRequests = [];
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.abort();
  });

  const logs = [];
  page.on('console', msg => logs.push(msg.text()));
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player" muted playsinline style="width:1280px;height:720px"></video>');

  await page.evaluate(() => {
    const video = document.getElementById('player');
    video.muted = true;
    const engine = new window.PlayerEngine(video, { videoId: 'PLAYERTEST1', streamToken: '' });
    window.__engine = engine;
    window.__player = engine.getPlayer();
    return engine.init().then(() => engine.load('/api/stream/PLAYERTEST1/dash.mpd?fixtureSegmentList=range'));
  });

  await expect.poll(() => page.evaluate(() => window._playerProvider)).toBe('native-dash');
  await page.evaluate(() => document.getElementById('player').play());
  await page.waitForFunction(() => {
    const video = document.getElementById('player');
    return !video.paused && video.currentTime > 0 && video.buffered.length > 0;
  }, null, { timeout: 10_000 });

  const stats = await page.evaluate(() => window.__player.getStats());
  expect(stats.activeVariant.height).toBeGreaterThan(0);
  expect(stats.activeAudio.id).toBe('a64');
  expect(shakaRequests).toHaveLength(0);
  expect(logs.some(line => line.includes('falling back to shaka'))).toBe(false);
});

test('native DASH live fixture starts near live edge and reports live stats without Shaka fallback', async ({ page }) => {
  const shakaRequests = [];
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.abort();
  });

  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player" muted playsinline style="width:1280px;height:720px"></video>');

  await page.evaluate(() => {
    const video = document.getElementById('player');
    video.muted = true;
    const engine = new window.PlayerEngine(video, { videoId: 'PLAYERTEST1', streamToken: '' });
    window.__engine = engine;
    window.__player = engine.getPlayer();
    return engine.init().then(() => engine.load('/api/stream/PLAYERTEST1/dash.mpd?fixtureLive=1'));
  });

  await expect.poll(() => page.evaluate(() => window._playerProvider)).toBe('native-dash');
  await page.evaluate(() => document.getElementById('player').play());
  await page.waitForFunction(() => document.getElementById('player').buffered.length > 0, null, { timeout: 10_000 });

  const stats = await page.evaluate(() => window.__player.getStats());
  expect(stats.isLive).toBe(true);
  expect(stats.liveWindowEnd).toBeGreaterThan(stats.liveWindowStart);
  expect(stats.liveLatency).toBeGreaterThanOrEqual(0);
  expect(stats.atLiveEdge).toBe(true);
  expect(stats.activeVariant.height).toBe(360);
  expect(shakaRequests).toHaveLength(0);
});

test('native DASH dynamic multi-period fixture plays without Shaka fallback', async ({ page }) => {
  const shakaRequests = [];
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.abort();
  });

  const logs = [];
  page.on('console', msg => logs.push(msg.text()));
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player" muted playsinline style="width:1280px;height:720px"></video>');

  await page.evaluate(() => {
    const video = document.getElementById('player');
    video.muted = true;
    const engine = new window.PlayerEngine(video, { videoId: 'PLAYERTEST1', streamToken: '' });
    window.__engine = engine;
    window.__player = engine.getPlayer();
    return engine.init().then(() => engine.load('/api/stream/PLAYERTEST1/dash.mpd?fixtureLive=multiperiod'));
  });

  await expect.poll(() => page.evaluate(() => window._playerProvider)).toBe('native-dash');
  await page.evaluate(() => document.getElementById('player').play());
  await page.waitForFunction(() => document.getElementById('player').buffered.length > 0, null, { timeout: 10_000 });

  const stats = await page.evaluate(() => window.__player.getStats());
  expect(stats.isLive).toBe(true);
  expect(stats.periodCount).toBe(2);
  expect(stats.liveWindowEnd).toBeGreaterThan(stats.liveWindowStart);
  expect(stats.activeVariant.height).toBeGreaterThan(0);
  expect(shakaRequests).toHaveLength(0);
  expect(logs.some(line => line.includes('falling back to shaka'))).toBe(false);
});

test('native DASH sliding live fixture advances its manifest window', async ({ page }) => {
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const windows = await page.evaluate(async () => {
    const key = 'k' + Date.now() + Math.random();
    const firstText = await fetch('/api/stream/PLAYERTEST1/dash.mpd?fixtureLive=sliding&fixtureLiveKey=' + key).then(resp => resp.text());
    const secondText = await fetch('/api/stream/PLAYERTEST1/dash.mpd?fixtureLive=sliding&fixtureLiveKey=' + key).then(resp => resp.text());
    const first = window.NativeDashProviderForTest.parseMPD(firstText, location.origin + '/api/stream/PLAYERTEST1/dash.mpd');
    const second = window.NativeDashProviderForTest.parseMPD(secondText, location.origin + '/api/stream/PLAYERTEST1/dash.mpd');
    return [first.liveWindow, second.liveWindow];
  });

  expect(windows[1].start).toBeGreaterThanOrEqual(windows[0].start);
  expect(windows[1].end).toBeGreaterThanOrEqual(windows[0].end);
});

test('native DASH live refresh merges a sliding window without fallback', async ({ page }) => {
  const manifest = windowStart => `<?xml version="1.0"?><MPD type="dynamic" availabilityStartTime="2026-05-04T00:00:00Z" minimumUpdatePeriod="PT1S" timeShiftBufferDepth="PT4S"><Period start="PT0S">
<AdaptationSet mimeType="video/mp4"><SegmentTemplate timescale="1000" initialization="/i/$RepresentationID$" media="/v/$Time$"><SegmentTimeline><S t="${windowStart * 1000}" d="2000" r="1"/></SegmentTimeline></SegmentTemplate>
<Representation id="v1" bandwidth="800000" width="640" height="360" codecs="avc1.42c01f"/></AdaptationSet>
<AdaptationSet mimeType="audio/mp4"><SegmentTemplate timescale="1000" initialization="/i/$RepresentationID$" media="/a/$Time$"><SegmentTimeline><S t="${windowStart * 1000}" d="2000" r="1"/></SegmentTimeline></SegmentTemplate>
<Representation id="a1" bandwidth="64000" codecs="mp4a.40.2"/></AdaptationSet>
</Period></MPD>`;

  await page.route('**/live-slide.mpd**', route => {
    route.fulfill({
      status: 200,
      contentType: 'application/dash+xml',
      body: manifest(2),
    });
  });

  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const state = await page.evaluate(() => {
    const first = window.NativeDashProviderForTest.parseMPD(`<?xml version="1.0"?><MPD type="dynamic" availabilityStartTime="2026-05-04T00:00:00Z" minimumUpdatePeriod="PT1S" timeShiftBufferDepth="PT4S"><Period start="PT0S">
<AdaptationSet mimeType="video/mp4"><SegmentTemplate timescale="1000" initialization="/i/$RepresentationID$" media="/v/$Time$"><SegmentTimeline><S t="0" d="2000" r="1"/></SegmentTimeline></SegmentTemplate>
<Representation id="v1" bandwidth="800000" width="640" height="360" codecs="avc1.42c01f"/></AdaptationSet>
<AdaptationSet mimeType="audio/mp4"><SegmentTemplate timescale="1000" initialization="/i/$RepresentationID$" media="/a/$Time$"><SegmentTimeline><S t="0" d="2000" r="1"/></SegmentTimeline></SegmentTemplate>
<Representation id="a1" bandwidth="64000" codecs="mp4a.40.2"/></AdaptationSet>
</Period></MPD>`, location.origin + '/live-slide.mpd');
    const videoRep = first.video[0];
    const audioRep = first.audio[0];
    videoRep.segments = videoRep.templateSegments.slice();
    audioRep.segments = audioRep.templateSegments.slice();
    videoRep.segments[1].appended = true;
    videoRep.segments[1].state = 'appended';
    const provider = {
      manifestUrl: '/live-slide.mpd',
      manifestText: '',
      live: true,
      destroyed: false,
      videoReps: [videoRep],
      audioReps: [audioRep],
      activeVideo: videoRep,
      audio: audioRep,
      liveWindow: first.liveWindow,
      minimumUpdatePeriod: 1,
      manifestRefreshCount: 0,
      manifestRefreshFailed: false,
      recoveryCount: 0,
      lastError: '',
      engine: { streamToken: '', _telemetry: { record() {} } },
      _tick() { this.ticked = true; },
      _updateLiveWindowFromReps: window.NativeDashProviderForTest._updateLiveWindowFromReps,
      _evictExpiredLiveSegmentState: window.NativeDashProviderForTest._evictExpiredLiveSegmentState,
      _refreshManifest: window.NativeDashProviderForTest._refreshManifest,
    };
    return provider._refreshManifest().then(() => ({
      refreshCount: provider.manifestRefreshCount,
      failed: provider.manifestRefreshFailed,
      liveWindow: provider.liveWindow,
      videoSegments: provider.videoReps[0].segments.map(seg => ({ start: seg.start, end: seg.end, state: seg.state || 'pending', appended: !!seg.appended })),
      ticked: !!provider.ticked,
    }));
  });

  expect(state.refreshCount).toBe(1);
  expect(state.failed).toBe(false);
  expect(state.liveWindow).toEqual({ start: 2, end: 6 });
  expect(state.videoSegments).toEqual([
    { start: 2, end: 4, state: 'appended', appended: true },
    { start: 4, end: 6, state: 'pending', appended: false },
  ]);
  expect(state.ticked).toBe(true);
});

test('native DASH live adapter exposes live range and seeks to live edge', async ({ page }) => {
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const state = await page.evaluate(() => {
    const video = document.getElementById('player');
    let currentTime = 0;
    Object.defineProperty(video, 'currentTime', {
      configurable: true,
      get() { return currentTime; },
      set(value) { currentTime = value; },
    });
    const engine = new window.PlayerEngine(video, { videoId: 'TESTVIDEO01', streamToken: 'test-token' });
    const provider = {
      live: true,
      liveWindow: { start: 20, end: 40 },
      video,
      seekCount: 0,
      isLive() { return true; },
      getLiveRange: window.NativeDashProviderForTest.getLiveRange,
      seekToLiveEdge: window.NativeDashProviderForTest.seekToLiveEdge,
      _onSeek() { this.seekCount++; },
    };
    engine._provider = provider;
    const player = engine.getPlayer();
    player.seekToLiveEdge();
    return {
      range: player.getLiveRange(),
      currentTime: video.currentTime,
      seekCount: provider.seekCount,
    };
  });

  expect(state.range).toEqual({ start: 20, end: 40 });
  expect(state.currentTime).toBe(34);
  expect(state.seekCount).toBe(1);
});

test('native DASH jumps small buffered gaps before stall fallback', async ({ page }) => {
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const state = await page.evaluate(() => {
    const video = document.getElementById('player');
    let currentTime = 4.4;
    Object.defineProperty(video, 'currentTime', {
      configurable: true,
      get() { return currentTime; },
      set(value) { currentTime = value; },
    });
    Object.defineProperty(video, 'buffered', {
      configurable: true,
      get() {
        return {
          length: 1,
          start() { return 5; },
          end() { return 10; },
        };
      },
    });
    const engine = new window.PlayerEngine(video, { videoId: 'TESTVIDEO01', streamToken: 'test-token' });
    const events = [];
    engine._telemetry.record = function (type, extra) { events.push({ type, extra }); };
    const provider = {
      video,
      engine,
      gapJumpCount: 0,
      lastGapSize: 0,
      lastError: '',
      _tick() { this.ticked = true; },
      _jumpSmallGap: window.NativeDashProviderForTest._jumpSmallGap,
      getStats: window.NativeDashProviderForTest.getStats,
      name: 'native-dash',
      manifestUrl: '/x.mpd',
      bandwidth: 0,
      activeVideo: { id: 'v1', height: 360 },
      audio: null,
      audioReps: [],
      unsupportedVideoCount: 0,
      unsupportedAudioCount: 0,
      getActiveVariantTrack() { return { id: 'v1', height: 360, active: true }; },
    };
    provider._jumpSmallGap();
    engine._provider = provider;
    return { currentTime: video.currentTime, gapJumpCount: provider.gapJumpCount, lastGapSize: provider.lastGapSize, events, stats: engine.getPlayer().getStats() };
  });

  expect(state.currentTime).toBeCloseTo(5.01, 2);
  expect(state.gapJumpCount).toBe(1);
  expect(state.lastGapSize).toBeCloseTo(0.6, 1);
  expect(state.events.some(event => event.type === 'gap-jump')).toBe(true);
  expect(state.stats.gapJumpCount).toBe(1);
});

test('native DASH does not jump large buffered gaps', async ({ page }) => {
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const state = await page.evaluate(() => {
    const video = document.getElementById('player');
    let currentTime = 3;
    Object.defineProperty(video, 'currentTime', {
      configurable: true,
      get() { return currentTime; },
      set(value) { currentTime = value; },
    });
    Object.defineProperty(video, 'buffered', {
      configurable: true,
      get() {
        return {
          length: 1,
          start() { return 5; },
          end() { return 10; },
        };
      },
    });
    const engine = new window.PlayerEngine(video, { videoId: 'TESTVIDEO01', streamToken: 'test-token' });
    const provider = { video, engine, gapJumpCount: 0, lastGapSize: 0, _tick() {}, _jumpSmallGap: window.NativeDashProviderForTest._jumpSmallGap };
    return { jumped: provider._jumpSmallGap(), currentTime: video.currentTime, gapJumpCount: provider.gapJumpCount };
  });

  expect(state.jumped).toBe(false);
  expect(state.currentTime).toBe(3);
  expect(state.gapJumpCount).toBe(0);
});

test('native DASH applies append windows and skips expired live segments', async ({ page }) => {
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const state = await page.evaluate(() => {
    function makeSourceBuffer() {
      const listeners = {};
      return {
        appendWindowStart: 0,
        appendWindowEnd: Infinity,
        updating: false,
        buffered: { length: 0, start() { return 0; }, end() { return 0; } },
        addEventListener(name, fn) { listeners[name] = fn; },
        removeEventListener(name) { delete listeners[name]; },
        appendBuffer() { setTimeout(() => { if (listeners.updateend) listeners.updateend(); }, 0); },
      };
    }
    const video = document.getElementById('player');
    const engine = new window.PlayerEngine(video, { videoId: 'TESTVIDEO01', streamToken: 'test-token' });
    engine._telemetry.record = function () {};
    const sb = makeSourceBuffer();
    const provider = { engine, videoSb: sb, audioSb: sb, quotaRecoveries: 0, lastError: '', _recoverQuota() { return Promise.reject(new Error('no-quota')); } };
    const seg = { start: 4, end: 6, appendWindow: { start: 4, end: 8 } };
    const reps = [{ segments: [{ start: 0, end: 2, state: 'appended', appended: true }, { start: 2, end: 4, state: 'pending', appended: false }] }];
    const liveProvider = { liveWindow: { start: 3, end: 8 }, videoReps: reps, audioReps: [], _evictExpiredLiveSegmentState: window.NativeDashProviderForTest._evictExpiredLiveSegmentState };
    liveProvider._evictExpiredLiveSegmentState();
    return window.NativeDashProviderForTest._appendSegmentData.call(provider, { kind: 'video' }, sb, seg, new ArrayBuffer(1)).then(() => ({
      appendWindowStart: sb.appendWindowStart,
      appendWindowEnd: sb.appendWindowEnd,
      expired: reps[0].segments[0],
      kept: reps[0].segments[1],
    }));
  });

  expect(state.appendWindowStart).toBe(4);
  expect(state.appendWindowEnd).toBe(8);
  expect(state.expired.state).toBe('expired');
  expect(state.expired.appended).toBe(false);
  expect(state.kept.state).toBe('pending');
});

test('DRM DASH manifest falls back with explicit reason', async ({ page }) => {
  const shakaRequests = [];
  await page.route('**/api/stream/DRMTEST0001/dash.mpd**', route => {
    route.fulfill({
      status: 200,
      contentType: 'application/dash+xml',
      body: `<?xml version="1.0"?><MPD type="static" mediaPresentationDuration="PT1S"><Period>
<AdaptationSet mimeType="video/mp4"><ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/><Representation id="v" bandwidth="1" codecs="avc1.42c01f"><BaseURL>/x</BaseURL><SegmentBase indexRange="0-1"><Initialization range="0-1"/></SegmentBase></Representation></AdaptationSet>
</Period></MPD>`,
    });
  });
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: [
        'window.shaka={};',
        'shaka.polyfill={installAll:function(){}};',
        'shaka.Player=function(){this.attach=function(){return Promise.resolve()};this.configure=function(){};this.addEventListener=function(){};this.load=function(){return Promise.resolve()};this.getVariantTracks=function(){return[]};this.destroy=function(){return Promise.resolve()};};',
        'shaka.Player.isBrowserSupported=function(){return true};',
        'shaka.net={NetworkingEngine:{PluginPriority:{APPLICATION:1},registerScheme:function(){}}};',
        'shaka.util={Error:{Severity:{RECOVERABLE:1},Category:{NETWORK:1},Code:{OPERATION_ABORTED:1}},AbortableOperation:function(promise){return promise}};',
      ].join(''),
    });
  });

  await page.goto('/auth/login');
  await page.setContent('<video id="player"></video>');
  await page.addScriptTag({ path: 'public/native-player-engine.js' });

  const stats = await page.evaluate(() => {
    const engine = new window.PlayerEngine(document.getElementById('player'), { videoId: 'DRMTEST0001', streamToken: 'test-token' });
    return engine.init().then(() => engine.load()).then(() => engine.getPlayer().getStats());
  });

  expect(shakaRequests).toHaveLength(1);
  expect(stats.provider).toBe('shaka-fallback');
  expect(stats.fallbackReason).toBe('dash-drm-unsupported');
});

test('native DASH retries a failed media range without Shaka fallback or reset', async ({ page }) => {
  const shakaRequests = [];
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.abort();
  });

  const logs = [];
  page.on('console', msg => logs.push(msg.text()));
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player" muted playsinline style="width:1280px;height:720px"></video>');

  await page.evaluate(() => {
    const video = document.getElementById('player');
    video.muted = true;
    const engine = new window.PlayerEngine(video, { videoId: 'PLAYERTEST1', streamToken: '' });
    window.__engine = engine;
    window.__player = engine.getPlayer();
    return engine.init().then(() => engine.load('/api/stream/PLAYERTEST1/dash.mpd?fixtureFailStatus=500&fixtureFailCount=1&fixtureFailFormat=v360&fixtureFailPhase=media'));
  });

  await page.evaluate(() => document.getElementById('player').play());
  await page.waitForFunction(() => {
    const video = document.getElementById('player');
    const stats = window.__player.getStats();
    return video.currentTime > 0 && stats.recoveryCount > 0 && stats.lastHttpStatus === 500;
  }, null, { timeout: 10_000 });

  const state = await page.evaluate(() => ({
    provider: window._playerProvider,
    currentTime: document.getElementById('player').currentTime,
    stats: window.__player.getStats(),
  }));

  expect(state.provider).toBe('native-dash');
  expect(state.currentTime).toBeGreaterThan(0);
  expect(state.currentTime).toBeLessThan(5.5);
  expect(state.stats.recoveryCount).toBeGreaterThan(0);
  expect(state.stats.lastHttpStatus).toBe(500);
  expect(shakaRequests).toHaveLength(0);
  expect(logs.some(line => line.includes('falling back to shaka'))).toBe(false);
});

test('native DASH refreshes media URLs after exhausted CDN expiry errors', async ({ page }) => {
  const shakaRequests = [];
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.abort();
  });

  const logs = [];
  page.on('console', msg => logs.push(msg.text()));
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player" muted playsinline style="width:1280px;height:720px"></video>');

  await page.evaluate(() => {
    const video = document.getElementById('player');
    video.muted = true;
    const engine = new window.PlayerEngine(video, { videoId: 'PLAYERTEST1', streamToken: '' });
    window.__engine = engine;
    window.__player = engine.getPlayer();
    return engine.init().then(() => engine.load('/api/stream/PLAYERTEST1/dash.mpd?fixtureFailStatus=410&fixtureFailCount=3&fixtureFailFormat=v360&fixtureFailPhase=media'));
  });

  await page.evaluate(() => document.getElementById('player').play());
  await page.waitForFunction(() => {
    const stats = window.__player.getStats();
    return document.getElementById('player').currentTime > 0
      && stats.mediaUrlRefreshCount > 0
      && stats.manifestRefreshReason === 'media-error'
      && stats.lastHttpStatus === 410;
  }, null, { timeout: 12_000 });

  const state = await page.evaluate(() => ({
    provider: window._playerProvider,
    currentTime: document.getElementById('player').currentTime,
    stats: window.__player.getStats(),
  }));

  expect(state.provider).toBe('native-dash');
  expect(state.currentTime).toBeGreaterThan(0);
  expect(state.currentTime).toBeLessThan(5.5);
  expect(state.stats.mediaFetchRetryCount).toBeGreaterThanOrEqual(2);
  expect(state.stats.mediaUrlRefreshCount).toBeGreaterThan(0);
  expect(state.stats.lastRecoveryReason).toBe('range-http-410');
  expect(state.stats.manifestRefreshReason).toBe('media-error');
  expect(shakaRequests).toHaveLength(0);
  expect(logs.some(line => line.includes('falling back to shaka'))).toBe(false);
});

test('native DASH refreshes manifest state after stale media range errors', async ({ page }) => {
  const shakaRequests = [];
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.abort();
  });

  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player" muted playsinline style="width:1280px;height:720px"></video>');

  await page.evaluate(() => {
    const video = document.getElementById('player');
    video.muted = true;
    const engine = new window.PlayerEngine(video, { videoId: 'PLAYERTEST1', streamToken: '' });
    window.__engine = engine;
    window.__player = engine.getPlayer();
    return engine.init().then(() => engine.load('/api/stream/PLAYERTEST1/dash.mpd?fixtureFailStatus=416&fixtureFailCount=3&fixtureFailFormat=v360&fixtureFailPhase=media'));
  });

  await page.evaluate(() => document.getElementById('player').play());
  await page.waitForFunction(() => {
    const stats = window.__player.getStats();
    return document.getElementById('player').currentTime > 0
      && stats.mediaUrlRefreshCount > 0
      && stats.lastHttpStatus === 416;
  }, null, { timeout: 12_000 });

  const stats = await page.evaluate(() => window.__player.getStats());
  expect(await page.evaluate(() => window._playerProvider)).toBe('native-dash');
  expect(stats.mediaUrlRefreshCount).toBeGreaterThan(0);
  expect(stats.lastRecoveryReason).toBe('range-http-416');
  expect(stats.manifestRefreshReason).toBe('media-error');
  expect(shakaRequests).toHaveLength(0);
});

test('native DASH treats token expiry on media as recoverable retry', async ({ page }) => {
  const shakaRequests = [];
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.abort();
  });

  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player" muted playsinline style="width:1280px;height:720px"></video>');

  await page.evaluate(() => {
    const video = document.getElementById('player');
    video.muted = true;
    const engine = new window.PlayerEngine(video, { videoId: 'PLAYERTEST1', streamToken: '' });
    window.__engine = engine;
    window.__player = engine.getPlayer();
    return engine.init().then(() => engine.load('/api/stream/PLAYERTEST1/dash.mpd?fixtureFailStatus=401&fixtureFailCount=1&fixtureFailFormat=v360&fixtureFailPhase=media'));
  });

  await page.evaluate(() => document.getElementById('player').play());
  await page.waitForFunction(() => {
    const stats = window.__player.getStats();
    return document.getElementById('player').currentTime > 0 && stats.recoveryCount > 0 && stats.lastHttpStatus === 401;
  }, null, { timeout: 10_000 });

  const state = await page.evaluate(() => ({
    provider: window._playerProvider,
    currentTime: document.getElementById('player').currentTime,
    stats: window.__player.getStats(),
  }));

  expect(state.provider).toBe('native-dash');
  expect(state.currentTime).toBeGreaterThan(0);
  expect(state.stats.recoveryCount).toBeGreaterThan(0);
  expect(state.stats.lastHttpStatus).toBe(401);
  expect(shakaRequests).toHaveLength(0);
});

test('native DASH reports delayed media buffering without fallback', async ({ page }) => {
  const shakaRequests = [];
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.abort();
  });

  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player" muted playsinline style="width:1280px;height:720px"></video>');

  await page.evaluate(() => {
    const video = document.getElementById('player');
    video.muted = true;
    const engine = new window.PlayerEngine(video, { videoId: 'PLAYERTEST1', streamToken: '' });
    window.__engine = engine;
    window.__player = engine.getPlayer();
    return engine.init().then(() => engine.load('/api/stream/PLAYERTEST1/dash.mpd?fixtureDelayMs=250&fixtureFailPhase=media'));
  });

  await page.evaluate(() => document.getElementById('player').play());
  await page.waitForFunction(() => document.getElementById('player').currentTime > 0, null, { timeout: 10_000 });

  const stats = await page.evaluate(() => window.__player.getStats());
  expect(await page.evaluate(() => window._playerProvider)).toBe('native-dash');
  expect(stats.provider).toBe('native-dash');
  expect(stats.bufferAhead).toBeGreaterThanOrEqual(0);
  expect(shakaRequests).toHaveLength(0);
});

test('fallback provider exposes normalized stats and reason', async ({ page }) => {
  await page.route('**/api/stream/TESTVIDEO02/dash.mpd**', route => {
    route.fulfill({
      status: 200,
      contentType: 'application/dash+xml',
      body: '<?xml version="1.0"?><MPD type="static" mediaPresentationDuration="PT1S"><Period></Period></MPD>',
    });
  });
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: [
        'window.shaka={};',
        'shaka.polyfill={installAll:function(){}};',
        'shaka.Player=function(){this.attach=function(){return Promise.resolve()};this.configure=function(){};this.addEventListener=function(){};this.load=function(){return Promise.resolve()};this.getVariantTracks=function(){return[{id:"s",height:360,active:true}]};this.destroy=function(){return Promise.resolve()};};',
        'shaka.Player.isBrowserSupported=function(){return true};',
        'shaka.net={NetworkingEngine:{PluginPriority:{APPLICATION:1},registerScheme:function(){}}};',
        'shaka.util={Error:{Severity:{RECOVERABLE:1},Category:{NETWORK:1},Code:{OPERATION_ABORTED:1}},AbortableOperation:function(promise){return promise}};',
      ].join(''),
    });
  });

  await page.goto('/auth/login');
  await page.setContent('<video id="player"></video>');
  await page.addScriptTag({ path: 'public/native-player-engine.js' });

  const stats = await page.evaluate(() => {
    const video = document.getElementById('player');
    const engine = new window.PlayerEngine(video, { videoId: 'TESTVIDEO02', streamToken: 'test-token' });
    window.__engine = engine;
    return engine.init().then(() => engine.load()).then(() => engine.getPlayer().getStats());
  });

  expect(stats.provider).toBe('shaka-fallback');
  expect(stats.fallbackReason).toBe('dash-no-supported-video');
  expect(stats.activeVariant.height).toBe(360);
});

test('native progressive fixture plays without Shaka fallback and exposes URL stats', async ({ page }) => {
  const shakaRequests = [];
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.abort();
  });

  await page.goto('/auth/login');
  await page.setContent('<video id="player" muted playsinline style="width:640px;height:360px"></video>');
  await page.addScriptTag({ path: 'public/native-player-engine.js' });

  await page.evaluate(() => {
    const video = document.getElementById('player');
    video.muted = true;
    const engine = new window.PlayerEngine(video, { videoId: 'PLAYERTEST1', streamToken: '' });
    window.__engine = engine;
    window.__player = engine.getPlayer();
    return engine.init().then(() => engine.load('/api/stream/PLAYERTEST1/progressive.mp4'));
  });

  await expect.poll(() => page.evaluate(() => window._playerProvider)).toBe('native-url');
  await page.evaluate(() => document.getElementById('player').play());
  await page.waitForFunction(() => document.getElementById('player').currentTime > 0, null, { timeout: 10_000 });

  const stats = await page.evaluate(() => window.__player.getStats());
  expect(stats.provider).toBe('native-url');
  expect(stats.mode).toBe('progressive');
  expect(stats.assetUri).toContain('/api/stream/PLAYERTEST1/progressive.mp4');
  expect(stats.isLive).toBe(false);
  expect(shakaRequests).toHaveLength(0);
});

test('native HLS parser supports master and fMP4 media playlists', async ({ page }) => {
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const parsed = await page.evaluate(() => {
    const master = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio-main",NAME="English",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,URI="audio-en.m3u8",CODECS="mp4a.40.2"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English captions",LANGUAGE="en",DEFAULT=NO,AUTOSELECT=YES,URI="captions/en.vtt"
#EXT-X-STREAM-INF:BANDWIDTH=350000,RESOLUTION=426x240,CODECS="avc1.42c01f,mp4a.40.2",AUDIO="audio-main",SUBTITLES="subs"
low.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1800000,RESOLUTION=1280x720,CODECS="avc1.42c01f,mp4a.40.2",AUDIO="audio-main",SUBTITLES="subs"
hi.m3u8`;
    const media = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:2
#EXT-X-MAP:URI="video.mp4",BYTERANGE="100@0"
#EXTINF:2.000,
#EXT-X-BYTERANGE:200@100
video.mp4
#EXTINF:2.000,
#EXT-X-BYTERANGE:200@300
video.mp4
#EXT-X-ENDLIST`;
    const masterOut = window.NativeDashProviderForTest.parseHlsPlaylist(master, 'https://example.test/hls/master.m3u8');
    const mediaOut = window.NativeDashProviderForTest.parseHlsPlaylist(media, 'https://example.test/hls/hi.m3u8');
    return {
      variants: masterOut.variants,
      audioRenditions: masterOut.audioRenditions,
      subtitleRenditions: masterOut.subtitleRenditions,
      map: mediaOut.map,
      segments: mediaOut.segments,
      mediaSequence: mediaOut.mediaSequence,
      duration: mediaOut.duration,
      endList: mediaOut.endList,
    };
  });

  expect(parsed.variants).toEqual([
    expect.objectContaining({ url: 'https://example.test/hls/low.m3u8', bandwidth: 350000, width: 426, height: 240, codecs: 'avc1.42c01f,mp4a.40.2', audioGroup: 'audio-main', subtitleGroup: 'subs' }),
    expect.objectContaining({ url: 'https://example.test/hls/hi.m3u8', bandwidth: 1800000, width: 1280, height: 720, codecs: 'avc1.42c01f,mp4a.40.2', audioGroup: 'audio-main', subtitleGroup: 'subs' }),
  ]);
  expect(parsed.audioRenditions).toEqual([
    expect.objectContaining({ id: 'audio-main:English', groupId: 'audio-main', language: 'en', label: 'English', url: 'https://example.test/hls/audio-en.m3u8', codecs: 'mp4a.40.2', defaultTrack: true }),
  ]);
  expect(parsed.subtitleRenditions).toEqual([
    expect.objectContaining({ id: 'subs:English captions', groupId: 'subs', language: 'en', label: 'English captions', url: 'https://example.test/hls/captions/en.vtt', mimeType: 'text/vtt' }),
  ]);
  expect(parsed.map).toEqual({ url: 'https://example.test/hls/video.mp4', range: { start: 0, end: 99 } });
  expect(parsed.segments).toEqual([
    { start: 0, end: 2, duration: 2, mediaSequence: 0, url: 'https://example.test/hls/video.mp4', range: { start: 100, end: 299 } },
    { start: 2, end: 4, duration: 2, mediaSequence: 1, url: 'https://example.test/hls/video.mp4', range: { start: 300, end: 499 } },
  ]);
  expect(parsed.duration).toBe(4);
  expect(parsed.mediaSequence).toBe(0);
  expect(parsed.endList).toBe(true);
});

test('native HLS fixture plays through MSE without Shaka fallback', async ({ page }) => {
  const shakaRequests = [];
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.abort();
  });

  await page.goto('/auth/login');
  await page.setContent('<video id="player" muted playsinline style="width:1280px;height:720px"></video>');
  await page.addScriptTag({ path: 'public/native-player-engine.js' });

  await page.evaluate(() => {
    const video = document.getElementById('player');
    video.muted = true;
    video.canPlayType = () => '';
    const engine = new window.PlayerEngine(video, { videoId: 'PLAYERTEST1', streamToken: '' });
    window.__engine = engine;
    window.__player = engine.getPlayer();
    window.__player.configure({ streaming: { bufferingGoal: 2, startupBufferGoal: 1, maxConcurrentRequests: 1 } });
    return engine.init().then(() => engine.load('/api/stream/PLAYERTEST1/hls.m3u8?fixtureHls=1'));
  });

  await expect.poll(() => page.evaluate(() => window._playerProvider)).toBe('native-hls');
  await page.evaluate(() => document.getElementById('player').play());
  await page.waitForFunction(() => document.getElementById('player').currentTime > 0, null, { timeout: 10_000 });

  const stats = await page.evaluate(() => window.__player.getStats());
  expect(stats.provider).toBe('native-hls');
  expect(stats.mode).toBe('hls');
  expect(stats.activeVariant.height).toBeGreaterThanOrEqual(360);
  expect(stats.playlistRefreshCount).toBeGreaterThan(0);
  expect(stats.mediaFetchCompletedCount).toBeGreaterThan(0);
  expect(stats.mediaFetchCompletedCount).toBeLessThanOrEqual(2);
  expect(stats.schedulerDrainCount).toBe(stats.mediaFetchCompletedCount);
  expect(shakaRequests).toHaveLength(0);
});

test('native HLS manual quality selection updates active variant without Shaka', async ({ page }) => {
  const shakaRequests = [];
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.abort();
  });

  await page.goto('/auth/login');
  await page.setContent('<video id="player" muted playsinline style="width:1280px;height:720px"></video>');
  await page.addScriptTag({ path: 'public/native-player-engine.js' });

  await page.evaluate(() => {
    const video = document.getElementById('player');
    video.muted = true;
    video.canPlayType = () => '';
    const engine = new window.PlayerEngine(video, { videoId: 'PLAYERTEST1', streamToken: '' });
    window.__engine = engine;
    window.__player = engine.getPlayer();
    window.__player.configure({ streaming: { bufferingGoal: 2, startupBufferGoal: 1, maxConcurrentRequests: 1 } });
    return engine.init().then(() => engine.load('/api/stream/PLAYERTEST1/hls.m3u8?fixtureHls=1'));
  });

  await expect.poll(() => page.evaluate(() => window._playerProvider)).toBe('native-hls');
  await expect.poll(() => page.evaluate(() => window.__player.getVariantTracks().length)).toBeGreaterThan(1);

  await page.evaluate(() => {
    const track = window.__player.getVariantTracks().find(item => item.height === 240);
    window.__player.selectVariantTrack(track, true);
  });

  await expect.poll(() => page.evaluate(() => window.__player.getActiveVariantTrack()?.height)).toBe(240);
  const stats = await page.evaluate(() => window.__player.getStats());
  expect(stats.provider).toBe('native-hls');
  expect(stats.lastSwitchReason).toBe('manual');
  expect(shakaRequests).toHaveLength(0);
});

test('native HLS media groups expose audio and subtitle tracks without Shaka', async ({ page }) => {
  const shakaRequests = [];
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.abort();
  });

  await page.goto('/auth/login');
  await page.setContent('<video id="player" muted playsinline style="width:1280px;height:720px"></video>');
  await page.addScriptTag({ path: 'public/native-player-engine.js' });

  await page.evaluate(() => {
    const video = document.getElementById('player');
    video.muted = true;
    video.canPlayType = () => '';
    const engine = new window.PlayerEngine(video, { videoId: 'PLAYERTEST1', streamToken: '' });
    window.__engine = engine;
    window.__player = engine.getPlayer();
    window.__player.configure({ streaming: { bufferingGoal: 2, startupBufferGoal: 1, maxConcurrentRequests: 2 } });
    return engine.init().then(() => engine.load('/api/stream/PLAYERTEST1/hls.m3u8?fixtureHls=groups'));
  });

  await expect.poll(() => page.evaluate(() => window._playerProvider)).toBe('native-hls');
  await page.evaluate(() => document.getElementById('player').play());
  await page.waitForFunction(() => document.getElementById('player').currentTime > 0, null, { timeout: 10_000 });

  const state = await page.evaluate(async () => {
    const audioTracks = window.__player.getAudioTracks();
    const textTracks = window.__player.getTextTracks();
    await window.__player.selectTextTrack(textTracks[0]);
    return {
      stats: window.__player.getStats(),
      audioTracks,
      activeAudio: window.__player.getActiveAudioTrack(),
      textTracks,
      activeText: window.__player.getActiveTextTrack(),
    };
  });

  expect(state.stats.provider).toBe('native-hls');
  expect(state.stats.nativeAudioTrackCount).toBe(1);
  expect(state.stats.nativeTextTrackCount).toBe(1);
  expect(state.audioTracks[0]).toMatchObject({ language: 'en', label: 'English', active: true, groupId: 'audio-main' });
  expect(state.activeAudio).toMatchObject({ language: 'en', label: 'English' });
  expect(state.textTracks[0]).toMatchObject({ language: 'en', label: 'English captions', source: 'native-hls', supported: true });
  expect(state.activeText).toMatchObject({ language: 'en', label: 'English captions', source: 'native-hls' });
  expect(shakaRequests).toHaveLength(0);
});

test('unsupported HLS audio codec falls back with explicit reason', async ({ page }) => {
  const shakaRequests = [];
  await page.route('**/api/stream/HLSAUDIOBAD/dash.mpd**', route => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ hls: '/bad-audio-master.m3u8', via: 'fixture' }),
    });
  });
  await page.route('**/bad-audio-master.m3u8', route => {
    route.fulfill({
      status: 200,
      contentType: 'application/vnd.apple.mpegurl',
      body: [
        '#EXTM3U',
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio-main",NAME="Bad Audio",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,URI="/bad-audio.m3u8",CODECS="bad.codec"',
        '#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=640x360,CODECS="avc1.42c01f,bad.codec",AUDIO="audio-main"',
        '/bad-video.m3u8',
      ].join('\n'),
    });
  });
  const mediaPlaylist = [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    '#EXT-X-TARGETDURATION:2',
    '#EXT-X-MAP:URI="/media.mp4",BYTERANGE="100@0"',
    '#EXTINF:2,',
    '#EXT-X-BYTERANGE:100@100',
    '/media.mp4',
    '#EXT-X-ENDLIST',
  ].join('\n');
  await page.route('**/bad-video.m3u8', route => route.fulfill({ status: 200, contentType: 'application/vnd.apple.mpegurl', body: mediaPlaylist }));
  await page.route('**/bad-audio.m3u8', route => route.fulfill({ status: 200, contentType: 'application/vnd.apple.mpegurl', body: mediaPlaylist }));
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: [
        'window.shaka={};',
        'shaka.polyfill={installAll:function(){}};',
        'shaka.Player=function(){this.attach=function(){return Promise.resolve()};this.configure=function(){};this.addEventListener=function(){};this.load=function(){return Promise.resolve()};this.getVariantTracks=function(){return[]};this.destroy=function(){return Promise.resolve()};};',
        'shaka.Player.isBrowserSupported=function(){return true};',
        'shaka.net={NetworkingEngine:{PluginPriority:{APPLICATION:1},registerScheme:function(){}}};',
        'shaka.util={Error:{Severity:{RECOVERABLE:1},Category:{NETWORK:1},Code:{OPERATION_ABORTED:1}},AbortableOperation:function(promise){return promise}};',
      ].join(''),
    });
  });

  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  await page.evaluate(() => {
    const video = document.getElementById('player');
    video.canPlayType = () => '';
    const engine = new window.PlayerEngine(video, { videoId: 'HLSAUDIOBAD', streamToken: 'test-token' });
    window.__engine = engine;
    window.__player = engine.getPlayer();
    return engine.init().then(() => engine.load());
  });

  const stats = await page.evaluate(() => window.__player.getStats());
  expect(stats.provider).toBe('shaka-fallback');
  expect(stats.fallbackReason).toBe('hls-no-supported-audio');
  expect(shakaRequests.length).toBe(1);
});

test('unsupported HLS video variants fall back with explicit reason', async ({ page }) => {
  const shakaRequests = [];
  await page.route('**/api/stream/HLSVIDEOBAD/dash.mpd**', route => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ hls: '/bad-video-master.m3u8', via: 'fixture' }),
    });
  });
  await page.route('**/bad-video-master.m3u8', route => {
    route.fulfill({
      status: 200,
      contentType: 'application/vnd.apple.mpegurl',
      body: [
        '#EXTM3U',
        '#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=640x360,CODECS="bad.codec"',
        '/bad-video.m3u8',
      ].join('\n'),
    });
  });
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: [
        'window.shaka={};',
        'shaka.polyfill={installAll:function(){}};',
        'shaka.Player=function(){this.attach=function(){return Promise.resolve()};this.configure=function(){};this.addEventListener=function(){};this.load=function(){return Promise.resolve()};this.getVariantTracks=function(){return[]};this.destroy=function(){return Promise.resolve()};};',
        'shaka.Player.isBrowserSupported=function(){return true};',
        'shaka.net={NetworkingEngine:{PluginPriority:{APPLICATION:1},registerScheme:function(){}}};',
        'shaka.util={Error:{Severity:{RECOVERABLE:1},Category:{NETWORK:1},Code:{OPERATION_ABORTED:1}},AbortableOperation:function(promise){return promise}};',
      ].join(''),
    });
  });

  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  await page.evaluate(() => {
    const video = document.getElementById('player');
    video.canPlayType = () => '';
    const engine = new window.PlayerEngine(video, { videoId: 'HLSVIDEOBAD', streamToken: 'test-token' });
    window.__engine = engine;
    window.__player = engine.getPlayer();
    return engine.init().then(() => engine.load());
  });

  const stats = await page.evaluate(() => window.__player.getStats());
  expect(stats.provider).toBe('shaka-fallback');
  expect(stats.fallbackReason).toBe('hls-no-supported-video');
  expect(shakaRequests.length).toBe(1);
});

test('encrypted HLS falls back with explicit reason', async ({ page }) => {
  const shakaRequests = [];
  await page.route('**/api/stream/HLSUNSUP001/dash.mpd**', route => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ hls: '/encrypted.m3u8', via: 'fixture' }),
    });
  });
  await page.route('**/encrypted.m3u8', route => {
    route.fulfill({
      status: 200,
      contentType: 'application/vnd.apple.mpegurl',
      body: '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="/key"\n#EXTINF:2,\nseg.m4s\n#EXT-X-ENDLIST',
    });
  });
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: [
        'window.shaka={};',
        'shaka.polyfill={installAll:function(){}};',
        'shaka.Player=function(){this.attach=function(){return Promise.resolve()};this.configure=function(){};this.addEventListener=function(){};this.load=function(){return Promise.resolve()};this.getVariantTracks=function(){return[]};this.destroy=function(){return Promise.resolve()};};',
        'shaka.Player.isBrowserSupported=function(){return true};',
        'shaka.net={NetworkingEngine:{PluginPriority:{APPLICATION:1},registerScheme:function(){}}};',
        'shaka.util={Error:{Severity:{RECOVERABLE:1},Category:{NETWORK:1},Code:{OPERATION_ABORTED:1}},AbortableOperation:function(promise){return promise}};',
      ].join(''),
    });
  });

  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const stats = await page.evaluate(() => {
    const video = document.getElementById('player');
    video.canPlayType = () => '';
    const engine = new window.PlayerEngine(video, { videoId: 'HLSUNSUP001', streamToken: 'test-token' });
    return engine.init().then(() => engine.load()).then(() => engine.getPlayer().getStats());
  });

  expect(shakaRequests).toHaveLength(1);
  expect(stats.provider).toBe('shaka-fallback');
  expect(stats.fallbackReason).toBe('hls-encrypted-unsupported');
});

test('supported HLS uses native URL provider and live-like stats', async ({ page }) => {
  await page.route('**/api/stream/HLSSUPPORT1/dash.mpd**', route => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ hls: '/api/stream/HLSSUPPORT1/hls/master.m3u8', via: 'fixture' }),
    });
  });

  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const stats = await page.evaluate(() => {
    const video = document.getElementById('player');
    video.canPlayType = type => /mpegurl/i.test(type) ? 'probably' : '';
    Object.defineProperty(video, 'duration', { configurable: true, get() { return Infinity; } });
    video.load = () => setTimeout(() => video.dispatchEvent(new Event('loadedmetadata')), 0);
    const engine = new window.PlayerEngine(video, { videoId: 'HLSSUPPORT1', streamToken: 'test-token' });
    return engine.init().then(() => engine.load()).then(() => engine.getPlayer().getStats());
  });

  expect(await page.evaluate(() => window._playerProvider)).toBe('native-url');
  expect(stats.provider).toBe('native-url');
  expect(stats.mode).toBe('hls');
  expect(stats.isLive).toBe(true);
  expect(stats.assetUri).toContain('/api/stream/HLSSUPPORT1/hls/master.m3u8');
});

test('native URL load retries once before succeeding', async ({ page }) => {
  await page.goto('/auth/login');
  await page.setContent('<video id="player"></video>');
  await page.addScriptTag({ path: 'public/native-player-engine.js' });

  const stats = await page.evaluate(() => {
    const video = document.getElementById('player');
    let loads = 0;
    video.load = () => {
      loads++;
      setTimeout(() => {
        video.dispatchEvent(new Event(loads === 1 ? 'error' : 'loadedmetadata'));
      }, 0);
    };
    const engine = new window.PlayerEngine(video, { videoId: 'TESTVIDEO03', streamToken: 'test-token' });
    return engine.init().then(() => engine.load('/fixture/video.mp4')).then(() => {
      const result = engine.getPlayer().getStats();
      result.loads = loads;
      return result;
    });
  });

  expect(stats.provider).toBe('native-url');
  expect(stats.mode).toBe('progressive');
  expect(stats.recoveryCount).toBe(1);
  expect(stats.loads).toBe(2);
});
