import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

async function setPlayerContent(page, html) {
  await page.setContent(html);
  await page.addScriptTag({ path: 'public/native-player-engine.js' });
}

async function blockShakaScript(page) {
  const shakaRequests = [];
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.abort();
  });
  return shakaRequests;
}

async function getPlayerFallbackState(page) {
  return page.evaluate(() => {
    const stats = window.__player ? window.__player.getStats() : {};
    return {
      provider: stats.provider || window._playerProvider || '',
      fallbackReason: stats.fallbackReason || '',
      mode: stats.mode || '',
      assetUri: stats.assetUri || '',
      drmKeySystem: stats.drmKeySystem || '',
      transmuxerProvider: stats.transmuxerProvider || '',
    };
  });
}

async function expectNativePlayback(page, expected = {}) {
  const state = await getPlayerFallbackState(page);
  expect(state.provider).not.toBe('shaka-fallback');
  expect(state.fallbackReason).toBe('');
  if (expected.provider) expect(state.provider).toBe(expected.provider);
  if (expected.mode) expect(state.mode).toBe(expected.mode);
  if (expected.drmKeySystem) expect(state.drmKeySystem).toBe(expected.drmKeySystem);
  if (expected.transmuxerProvider !== undefined) expect(state.transmuxerProvider).toBe(expected.transmuxerProvider);
  return state;
}

async function expectFirstPartyNativePlayback(page, expected = {}) {
  const state = await expectNativePlayback(page, expected);
  expect(state.transmuxerProvider).not.toBe('shaka-ts');
  return state;
}

test('HLS MPEG-TS transmuxing keeps Shaka references behind adapter boundary', () => {
  const source = readFileSync('public/native-player-engine.js', 'utf8');
  const start = source.indexOf('NativeHlsProvider.prototype._transmuxTsSegment');
  const end = source.indexOf('NativeHlsProvider.prototype._recoverQuota', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  expect(source.slice(start, end)).not.toContain('shaka.');
  expect(source).toContain('function createTsTransmuxerAdapter');
  expect(source).toContain('window.__nativeTsTransmuxerFactory');
  expect(source).not.toContain('function ShakaTsTransmuxerAdapter');
  expect(source).not.toContain('function createShakaTsTransmuxerAdapter');
  expect(source).not.toContain("provider = 'shaka-ts'");
  expect(source).toContain('hls-first-party-ts-transmuxer-unavailable');
});

test('HLS MPEG-TS transmuxing prefers injected first-party adapter without loading Shaka', async ({ page }) => {
  const shakaRequests = [];
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.abort();
  });
  await setPlayerContent(page, '<video id="player"></video>');

  const state = await page.evaluate(async () => {
    const calls = [];
    window.__nativeTsTransmuxerFactory = ({ contentType, codecs, mimeType }) => ({
      provider: 'first-party-ts',
      contentType,
      codecs,
      mimeType,
      transmux(data, context) {
        calls.push({
          byteLength: data.byteLength,
          contentType: context.contentType,
          segmentUrl: context.segment.url,
          trackId: context.track.id,
        });
        return Promise.resolve({
          init: new Uint8Array([1, 2]).buffer,
          data: new Uint8Array([3, 4, 5]).buffer,
        });
      },
    });

    const provider = {
      tsTransmuxers: { video: null, audio: null },
      tsVideoTransmuxer: null,
      tsAudioTransmuxer: null,
      tsTransmuxer: null,
      tsTransmuxerProvider: '',
      tsTransmuxerLoadMs: 0,
      transmuxedSegmentCount: 0,
      transmuxedVideoSegmentCount: 0,
      transmuxedAudioSegmentCount: 0,
      manifestCompatibilityWarnings: [],
      activeVariant: { id: 'v360', codecs: 'avc1.42c01f', width: 640, height: 360 },
    };

    await window.NativeHlsProviderForTest._ensureTsTransmuxer.call(provider, 'video', 'avc1.42c01f');
    const output = await window.NativeHlsProviderForTest._transmuxTsSegment.call(
      provider,
      { id: 'v360', kind: 'video' },
      { start: 0, end: 1, duration: 1, url: '/segment.ts' },
      new Uint8Array([188]).buffer,
      'video'
    );

    return {
      calls,
      provider: provider.tsTransmuxerProvider,
      warned: provider.manifestCompatibilityWarnings.includes('hls-ts-transmuxed'),
      segmentCount: provider.transmuxedSegmentCount,
      videoSegmentCount: provider.transmuxedVideoSegmentCount,
      init: Array.from(new Uint8Array(output.init)),
      data: Array.from(new Uint8Array(output.data)),
    };
  });

  expect(state.provider).toBe('first-party-ts');
  expect(state.warned).toBe(true);
  expect(state.segmentCount).toBe(1);
  expect(state.videoSegmentCount).toBe(1);
  expect(state.calls).toEqual([{ byteLength: 1, contentType: 'video', segmentUrl: '/segment.ts', trackId: 'v360' }]);
  expect(state.init).toEqual([1, 2]);
  expect(state.data).toEqual([3, 4, 5]);
  expect(shakaRequests).toHaveLength(0);
});

test('first-party MPEG-TS demuxer parses PAT PMT H264 and ADTS tracks', async ({ page }) => {
  await setPlayerContent(page, '<video id="player"></video>');

  const summary = await page.evaluate(() => {
    function packet(pid, payload, payloadUnitStart = false) {
      const out = new Uint8Array(188);
      out.fill(0xff);
      out[0] = 0x47;
      out[1] = (payloadUnitStart ? 0x40 : 0) | ((pid >> 8) & 0x1f);
      out[2] = pid & 0xff;
      out[3] = 0x10;
      out.set(payload.slice(0, 184), 4);
      return out;
    }
    function concat(parts) {
      const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
      let offset = 0;
      for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
      }
      return out;
    }
    function ptsBytes(seconds) {
      const value = Math.round(seconds * 90000);
      return [
        0x20 | (((value / 0x40000000) & 0x07) << 1) | 1,
        (value >> 22) & 0xff,
        (((value >> 15) & 0x7f) << 1) | 1,
        (value >> 7) & 0xff,
        ((value & 0x7f) << 1) | 1,
      ];
    }
    function pes(streamId, ptsSeconds, payload) {
      return new Uint8Array([
        0x00, 0x00, 0x01, streamId, 0x00, 0x00, 0x80, 0x80, 0x05,
        ...ptsBytes(ptsSeconds),
        ...payload,
      ]);
    }

    const pat = packet(0, new Uint8Array([
      0x00,
      0x00, 0xb0, 0x0d, 0x00, 0x01, 0xc1, 0x00, 0x00,
      0x00, 0x01, 0xe1, 0x00,
      0x00, 0x00, 0x00, 0x00,
    ]), true);
    const pmt = packet(0x100, new Uint8Array([
      0x00,
      0x02, 0xb0, 0x17, 0x00, 0x01, 0xc1, 0x00, 0x00,
      0xe1, 0x01, 0xf0, 0x00,
      0x1b, 0xe1, 0x01, 0xf0, 0x00,
      0x0f, 0xe1, 0x02, 0xf0, 0x00,
      0x00, 0x00, 0x00, 0x00,
    ]), true);
    const h264 = pes(0xe0, 1, new Uint8Array([
      0x00, 0x00, 0x00, 0x01, 0x67, 0x42, 0x00, 0x1f,
      0x00, 0x00, 0x01, 0x68, 0xce, 0x06,
      0x00, 0x00, 0x01, 0x65, 0x88,
    ]));
    const adts = pes(0xc0, 1, new Uint8Array([
      0xff, 0xf1, 0x50, 0x80, 0x01, 0x7f, 0xfc,
      0x21, 0x22, 0x23, 0x24,
    ]));

    const demux = window.NativeTsTransmuxerForTest.demuxMpegTs(concat([
      pat,
      pmt,
      packet(0x101, h264, true),
      packet(0x102, adts, true),
    ]));
    return {
      packetCount: demux.packetCount,
      pmtPid: demux.pmtPid,
      tracks: demux.tracks.map(track => ({
        pid: track.pid,
        type: track.type,
        streamType: track.streamType,
        pesCount: track.pes.length,
        pts: track.pes[0] && track.pes[0].pts,
        nalTypes: track.nalTypes,
        adtsFrames: track.adtsFrames,
        firstAdtsFrame: track.pes[0] && track.pes[0].adtsFrames && track.pes[0].adtsFrames[0],
      })),
    };
  });

  expect(summary.packetCount).toBe(4);
  expect(summary.pmtPid).toBe(0x100);
  expect(summary.tracks).toHaveLength(2);
  expect(summary.tracks[0]).toMatchObject({ pid: 0x101, type: 'video', streamType: 0x1b, pesCount: 1 });
  expect(summary.tracks[0].pts).toBeCloseTo(1, 4);
  expect(summary.tracks[0].nalTypes).toEqual([7, 8, 5]);
  expect(summary.tracks[1]).toMatchObject({ pid: 0x102, type: 'audio', streamType: 0x0f, pesCount: 1, adtsFrames: 1 });
  expect(summary.tracks[1].firstAdtsFrame).toMatchObject({ profile: 2, sampleRateIndex: 4, channelConfig: 2 });
});

test('first-party MPEG-TS adapter opt-in emits video fMP4 without loading Shaka', async ({ page }) => {
  const shakaRequests = [];
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.abort();
  });
  await setPlayerContent(page, '<video id="player"></video>');

  const state = await page.evaluate(async () => {
    function packet(pid, payload, payloadUnitStart = false) {
      const out = new Uint8Array(188);
      out.fill(0xff);
      out[0] = 0x47;
      out[1] = (payloadUnitStart ? 0x40 : 0) | ((pid >> 8) & 0x1f);
      out[2] = pid & 0xff;
      out[3] = 0x10;
      out.set(payload.slice(0, 184), 4);
      return out;
    }
    function concat(parts) {
      const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
      let offset = 0;
      for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
      }
      return out;
    }
    function ptsBytes(seconds) {
      const value = Math.round(seconds * 90000);
      return [
        0x20 | (((value / 0x40000000) & 0x07) << 1) | 1,
        (value >> 22) & 0xff,
        (((value >> 15) & 0x7f) << 1) | 1,
        (value >> 7) & 0xff,
        ((value & 0x7f) << 1) | 1,
      ];
    }
    function pes(streamId, ptsSeconds, payload) {
      return new Uint8Array([
        0x00, 0x00, 0x01, streamId, 0x00, 0x00, 0x80, 0x80, 0x05,
        ...ptsBytes(ptsSeconds),
        ...payload,
      ]);
    }
    function boxTypes(bytes) {
      const out = [];
      for (let offset = 0; offset + 8 <= bytes.length;) {
        const size = (bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3];
        const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
        if (size < 8 || offset + size > bytes.length) break;
        out.push(type);
        offset += size;
      }
      return out;
    }
    function findBox(bytes, target) {
      for (let offset = 0; offset + 8 <= bytes.length;) {
        const size = (bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3];
        const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
        if (size < 8 || offset + size > bytes.length) return null;
        if (type === target) return bytes.slice(offset, offset + size);
        offset += size;
      }
      return null;
    }

    window.__enableFirstPartyTsTransmuxer = true;
    const provider = {
      tsTransmuxers: { video: null, audio: null },
      tsVideoTransmuxer: null,
      tsAudioTransmuxer: null,
      tsTransmuxer: null,
      tsTransmuxerProvider: '',
      tsTransmuxerLoadMs: 0,
      transmuxedSegmentCount: 0,
      transmuxedVideoSegmentCount: 0,
      transmuxedAudioSegmentCount: 0,
      manifestCompatibilityWarnings: [],
      activeVariant: { id: 'v360', codecs: 'avc1.42c01f', width: 640, height: 360 },
    };
    const pat = packet(0, new Uint8Array([
      0x00,
      0x00, 0xb0, 0x0d, 0x00, 0x01, 0xc1, 0x00, 0x00,
      0x00, 0x01, 0xe1, 0x00,
      0x00, 0x00, 0x00, 0x00,
    ]), true);
    const pmt = packet(0x100, new Uint8Array([
      0x00,
      0x02, 0xb0, 0x12, 0x00, 0x01, 0xc1, 0x00, 0x00,
      0xe1, 0x01, 0xf0, 0x00,
      0x1b, 0xe1, 0x01, 0xf0, 0x00,
      0x00, 0x00, 0x00, 0x00,
    ]), true);
    const h264 = pes(0xe0, 1, new Uint8Array([
      0x00, 0x00, 0x00, 0x01, 0x67, 0x42, 0x00, 0x1f,
      0x00, 0x00, 0x01, 0x68, 0xce, 0x06,
      0x00, 0x00, 0x01, 0x65, 0x88, 0x84,
    ]));
    const segment = concat([pat, pmt, packet(0x101, h264, true)]);
    await window.NativeHlsProviderForTest._ensureTsTransmuxer.call(provider, 'video', 'avc1.42c01f');
    const output = await window.NativeHlsProviderForTest._transmuxTsSegment.call(
      provider,
      { id: 'v360', kind: 'video' },
      { start: 0, end: 1, duration: 1, url: '/video.ts' },
      segment.buffer,
      'video'
    );
    const init = new Uint8Array(output.init);
    const data = new Uint8Array(output.data);
    const mdat = findBox(data, 'mdat');
    return {
      provider: provider.tsTransmuxerProvider,
      warned: provider.manifestCompatibilityWarnings.includes('hls-ts-transmuxed'),
      segmentCount: provider.transmuxedSegmentCount,
      videoSegmentCount: provider.transmuxedVideoSegmentCount,
      demuxPacketCount: provider.tsVideoTransmuxer.lastDemux.packetCount,
      initBoxes: boxTypes(init),
      mediaBoxes: boxTypes(data),
      initByteLength: init.byteLength,
      dataByteLength: data.byteLength,
      mdatByteLength: mdat ? mdat.byteLength : 0,
    };
  });

  expect(state.provider).toBe('first-party-ts');
  expect(state.warned).toBe(true);
  expect(state.segmentCount).toBe(1);
  expect(state.videoSegmentCount).toBe(1);
  expect(state.demuxPacketCount).toBe(3);
  expect(state.initBoxes).toEqual(['ftyp', 'moov']);
  expect(state.mediaBoxes).toEqual(['moof', 'mdat']);
  expect(state.initByteLength).toBeGreaterThan(100);
  expect(state.dataByteLength).toBeGreaterThan(40);
  expect(state.mdatByteLength).toBeGreaterThan(16);
  expect(shakaRequests).toHaveLength(0);
});

test('watch page loads native player without eager-loading Shaka', async ({ request }) => {
  const login = await request.post('/auth/free', { maxRedirects: 0 });
  expect(login.status()).toBeGreaterThanOrEqual(300);
  expect(login.status()).toBeLessThan(400);

  const watch = await request.get('/watch?v=dQw4w9WgXcQ');
  expect(watch.status()).toBe(200);
  const html = await watch.text();

  expect(html).toContain('/native-player-engine.js');
  expect(html).not.toContain('/vendor/shaka/shaka-player.compiled.js');
  expect(html).toContain('var playerDrmServers = ');
  expect(html).toContain('player.configure({ drm: { servers: playerDrmServers } });');
});

test('watch navigation loading bar timer and stream status badge complete in browser', async ({ page }) => {
  await page.goto('/auth/login');
  await page.evaluate(() => {
    history.replaceState({}, '', '/watch?v=dQw4w9WgXcQ');
    document.body.innerHTML = [
      '<nav><span class="nav-status">',
      '<span class="stream-via" id="stream-via"></span>',
      '<span class="load-timer" id="load-timer"></span>',
      '</span></nav>',
      '<main><video id="player"></video><a href="/">Home</a></main>',
    ].join('');
  });
  await page.addScriptTag({ path: 'public/app.js' });

  await expect(page.locator('#load-timer')).toHaveClass(/running/);
  await expect(page.locator('.top-loading-bar')).toHaveCount(1);

  await page.evaluate(() => {
    window._finishLoadingBar();
    window._startLoadBar();
  });
  await page.waitForTimeout(700);
  await expect(page.locator('.top-loading-bar')).toHaveCount(1);

  await page.evaluate(() => {
    window._setLoadBarProgress(63);
    document.getElementById('stream-via').textContent = 'manifest ready';
  });
  await expect(page.locator('.top-loading-bar')).toHaveCSS('width', /.+/);
  await expect(page.locator('#stream-via')).toHaveText('manifest ready');

  await page.evaluate(() => {
    window._stopLoadTimer();
    window._finishLoadingBar();
  });
  await expect(page.locator('#load-timer')).toHaveClass(/done-green|done-yellow|done-red/);
  await expect(page.locator('.top-loading-bar')).toHaveCount(0);

  await page.evaluate(() => {
    window._resetLoadTimer();
    document.getElementById('stream-via').textContent = '';
  });
  await expect(page.locator('#load-timer')).toHaveClass('load-timer');
  await expect(page.locator('#load-timer')).toHaveText('');
  await expect(page.locator('#stream-via')).toHaveText('');

  await page.evaluate(() => {
    history.replaceState({}, '', '/watch?v=dQw4w9WgXcQ');
    window.PlayerEngine = function () {
      return {
        getPlayer() { return {}; },
        init() { return Promise.resolve(); },
        load() { return Promise.resolve(); },
        destroy() {},
      };
    };
    window._startLoadTimer();
    window._startLoadBar();
    handleFallback('');
  });
  await expect(page.locator('#stream-via')).toHaveText('offline');
  await expect(page.locator('#load-timer')).toHaveClass(/done-green|done-yellow|done-red/);
  await expect(page.locator('.top-loading-bar')).toHaveCount(0);

  await page.evaluate(() => {
    window._startLoadTimer();
    document.getElementById('load-timer').remove();
    window._stopLoadTimer();
    document.querySelector('.nav-status').insertAdjacentHTML('beforeend', '<span class="load-timer" id="load-timer"></span>');
  });
  await page.waitForTimeout(100);
  await expect(page.locator('#load-timer')).toHaveText('');
  await expect(page.locator('#load-timer')).toHaveClass('load-timer');

  await page.evaluate(() => {
    window._startLoadTimer();
    window._startLoadBar();
    document.querySelector('main').remove();
    handleFallback('');
    document.body.insertAdjacentHTML('beforeend', '<main></main>');
  });
  await expect(page.locator('#load-timer')).toHaveClass('load-timer');
  await expect(page.locator('#load-timer')).toHaveText('');
  await expect(page.locator('.top-loading-bar')).toHaveCount(0);

  await page.route('**/watch?v=OFFLINE001A', route => {
    route.fulfill({
      status: 200,
      headers: { 'X-SW-Fallback': '1', 'Content-Type': 'text/html' },
      body: '<main><div class="offline-message">offline</div></main>',
    });
  });
  await page.evaluate(() => {
    history.replaceState({}, '', '/');
    window._isOffline = true;
    document.body.innerHTML = [
      '<nav><span class="nav-status">',
      '<span class="stream-via" id="stream-via"></span>',
      '<span class="load-timer" id="load-timer"></span>',
      '</span></nav>',
      '<main><a id="offline-watch" href="/watch?v=OFFLINE001A">Offline watch</a></main>',
    ].join('');
  });
  await page.locator('#offline-watch').click();
  await expect(page.locator('#stream-via')).toHaveText('offline');
  await expect(page.locator('#load-timer')).toHaveClass(/done-green|done-yellow|done-red/);
  await expect(page.locator('.top-loading-bar')).toHaveCount(0);
});

test('thumbnail SPA navigation ignores stale watch responses and initializes latest player', async ({ page }) => {
  await page.goto('/auth/login');
  await page.setContent([
    '<nav><span class="nav-status"><span id="stream-via"></span><span id="load-timer"></span></span></nav>',
    '<main><div class="video-grid">',
    '<a id="first" class="video-card" href="/watch?v=FIRSTVIDEO1"><span>First</span></a>',
    '<a id="second" class="video-card" href="/watch?v=SECONDVID2"><span>Second</span></a>',
    '</div></main>',
  ].join(''));
  await page.addScriptTag({
    content: `
      window.__resolveFirstWatch = null;
      window.fetch = function(url) {
        var href = String(url);
        if (href.indexOf('/watch?v=FIRSTVIDEO1') !== -1) {
          return new Promise(function(resolve) {
            window.__resolveFirstWatch = function() {
              resolve(new Response('<!doctype html><title>First</title><main><h1>First</h1><script>window.__initializedVideo = "FIRSTVIDEO1";<\\/script></main>', {
                status: 200,
                headers: { 'Content-Type': 'text/html' },
              }));
            };
          });
        }
        if (href.indexOf('/watch?v=SECONDVID2') !== -1) {
          return Promise.resolve(new Response('<!doctype html><title>Second</title><main><h1>Second</h1><script>window.__initializedVideo = "SECONDVID2";<\\/script></main>', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          }));
        }
        return Promise.resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
      };
    `,
  });
  await page.addScriptTag({ path: 'public/app.js' });

  await page.click('#first');
  await page.click('#second');
  await expect.poll(() => page.evaluate(() => window.__initializedVideo)).toBe('SECONDVID2');
  await page.evaluate(() => window.__resolveFirstWatch && window.__resolveFirstWatch());
  await page.waitForTimeout(100);

  const state = await page.evaluate(() => ({
    initialized: window.__initializedVideo,
    title: document.title,
    heading: document.querySelector('main h1')?.textContent || '',
  }));
  expect(state).toEqual({ initialized: 'SECONDVID2', title: 'Second', heading: 'Second' });
});

test('native engine keeps unsupported DASH terminal without lazy-loading Shaka', async ({ page }) => {
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
    route.abort();
  });

  const logs = [];
  page.on('console', msg => logs.push(msg.text()));
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const stats = await page.evaluate(() => {
    const video = document.getElementById('player');
    const engine = new window.PlayerEngine(video, { videoId: 'TESTVIDEO01', streamToken: 'test-token' });
    window.__engine = engine;
    window.__player = engine.getPlayer();
    return engine.init().then(() => engine.load()).then(() => engine.getPlayer().getStats());
  });

  expect(shakaRequests).toHaveLength(0);
  expect(await page.evaluate(() => window._playerProvider)).toBe('native-dash');
  expect(stats.provider).toBe('native-dash');
  expect(stats.fallbackReason).toBe('');
  expect(stats.lastError).toBe('dash-no-supported-video');
  expect(stats.fatalError).toBe('dash-no-supported-video');
  expect(stats.nativeUnsupportedReason).toBe('dash-no-supported-video');
  expect(logs.some(line => line.includes('falling back to shaka: reason=dash-no-supported-video'))).toBe(false);
});

test('native engine keeps DASH with no supported audio terminal without lazy-loading Shaka', async ({ page }) => {
  const shakaRequests = [];
  await page.route('**/api/stream/DASHAUDIOBAD/dash.mpd**', route => {
    route.fulfill({
      status: 200,
      contentType: 'application/dash+xml',
      body: [
        '<?xml version="1.0"?>',
        '<MPD type="static" mediaPresentationDuration="PT2S">',
        '<Period>',
        '<AdaptationSet mimeType="video/mp4">',
        '<SegmentTemplate timescale="1000" initialization="/i/$RepresentationID$" media="/v/$Time$"><SegmentTimeline><S t="0" d="2000"/></SegmentTimeline></SegmentTemplate>',
        '<Representation id="v1" bandwidth="800000" width="640" height="360" codecs="avc1.42c01f"/>',
        '</AdaptationSet>',
        '</Period>',
        '</MPD>',
      ].join(''),
    });
  });
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.abort();
  });

  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const stats = await page.evaluate(() => {
    const video = document.getElementById('player');
    const engine = new window.PlayerEngine(video, { videoId: 'DASHAUDIOBAD', streamToken: 'test-token' });
    window.__engine = engine;
    window.__player = engine.getPlayer();
    return engine.init().then(() => engine.load()).then(() => engine.getPlayer().getStats());
  });

  expect(shakaRequests).toHaveLength(0);
  expect(stats.provider).toBe('native-dash');
  expect(stats.fallbackReason).toBe('');
  expect(stats.lastError).toBe('dash-no-supported-audio');
  expect(stats.fatalError).toBe('dash-no-supported-audio');
  expect(stats.nativeUnsupportedReason).toBe('dash-no-supported-audio');
  expect(stats.lastDrmError).toBe('');
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

test('native engine decodes inline data MPD without fetch or Shaka fallback', async ({ page }) => {
  const dataFetches = [];
  const shakaRequests = [];
  await page.route('data:**', route => {
    dataFetches.push(route.request().url());
    route.abort();
  });
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.abort();
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
      .then(() => engine.getPlayer().getStats())
      .catch(err => err.message);
  });

  expect(result.provider).toBe('native-dash');
  expect(result.fallbackReason).toBe('');
  expect(result.lastError).toBe('dash-no-supported-video');
  expect(result.nativeUnsupportedReason).toBe('dash-no-supported-video');
  expect(dataFetches.length).toBe(0);
  expect(shakaRequests).toHaveLength(0);
  expect(logs.some(line => line.includes('falling back to shaka: reason=dash-no-supported-video'))).toBe(false);
  expect(logs.some(line => line.includes('falling back to shaka: reason=Failed to fetch'))).toBe(false);
});

test('native video element recovery failure stays native with explicit terminal reason', async ({ page }) => {
  const shakaRequests = [];
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.abort();
  });
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const state = await page.evaluate(async () => {
    const video = document.getElementById('player');
    Object.defineProperty(video, 'error', {
      configurable: true,
      get() { return { code: 3 }; },
    });
    const engine = new window.PlayerEngine(video, { videoId: 'TESTVIDEO01', streamToken: 'test-token' });
    await engine.init();
    const provider = {
      name: 'native-test',
      lastError: '',
      fatalError: '',
      nativeUnsupportedReason: '',
      handleVideoError() { return Promise.reject(new Error('recovery-failed')); },
      getStats() {
        return {
          provider: this.name,
          mode: 'test',
          fallbackReason: engine._fallbackReason || '',
          lastError: this.lastError || '',
          fatalError: this.fatalError || '',
          nativeUnsupportedReason: this.nativeUnsupportedReason || '',
        };
      },
    };
    engine._provider = provider;
    engine._providerName = provider.name;
    window.__player = engine.getPlayer();
    video.dispatchEvent(new Event('error'));
    await new Promise(resolve => setTimeout(resolve, 0));
    return {
      providerName: engine._providerName,
      state: engine._state,
      recovering: engine.isRecovering(),
      stats: engine.getPlayer().getStats(),
    };
  });

  expect(shakaRequests).toHaveLength(0);
  expect(state.providerName).toBe('native-test');
  expect(state.state).toBe('error');
  expect(state.recovering).toBe(false);
  expect(state.stats.provider).toBe('native-test');
  expect(state.stats.fallbackReason || '').toBe('');
  expect(state.stats.lastError).toBe('video-error-3');
  expect(state.stats.fatalError).toBe('video-error-3');
  expect(state.stats.nativeUnsupportedReason).toBe('video-error-3');
});

test('native video element recovery success remains native and non-terminal', async ({ page }) => {
  const shakaRequests = [];
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.abort();
  });
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const state = await page.evaluate(async () => {
    const video = document.getElementById('player');
    Object.defineProperty(video, 'error', {
      configurable: true,
      get() { return { code: 2 }; },
    });
    Object.defineProperty(video, 'currentTime', {
      configurable: true,
      get() { return 7; },
    });
    const engine = new window.PlayerEngine(video, { videoId: 'TESTVIDEO01', streamToken: 'test-token' });
    let recoveryEvent = null;
    engine.on('recovery-end', event => { recoveryEvent = event; });
    await engine.init();
    const provider = {
      name: 'native-test',
      lastError: '',
      fatalError: '',
      nativeUnsupportedReason: '',
      recoveryCount: 0,
      handleVideoError() {
        this.recoveryCount++;
        return Promise.resolve();
      },
      getStats() {
        return {
          provider: this.name,
          mode: 'test',
          fallbackReason: engine._fallbackReason || '',
          lastError: this.lastError || '',
          fatalError: this.fatalError || '',
          nativeUnsupportedReason: this.nativeUnsupportedReason || '',
          recoveryCount: this.recoveryCount,
        };
      },
    };
    engine._provider = provider;
    engine._providerName = provider.name;
    window.__player = engine.getPlayer();
    video.dispatchEvent(new Event('error'));
    await new Promise(resolve => setTimeout(resolve, 0));
    return {
      providerName: engine._providerName,
      state: engine._state,
      recovering: engine.isRecovering(),
      recoveryEvent,
      stats: engine.getPlayer().getStats(),
    };
  });

  expect(shakaRequests).toHaveLength(0);
  expect(state.providerName).toBe('native-test');
  expect(state.state).not.toBe('error');
  expect(state.recovering).toBe(false);
  expect(state.recoveryEvent).toMatchObject({ method: 'native', time: 7 });
  expect(state.stats.provider).toBe('native-test');
  expect(state.stats.fallbackReason || '').toBe('');
  expect(state.stats.lastError).toBe('');
  expect(state.stats.fatalError).toBe('');
  expect(state.stats.nativeUnsupportedReason).toBe('');
  expect(state.stats.recoveryCount).toBe(1);
});

test('native load MSE unavailable stays native with explicit terminal reason', async ({ page }) => {
  const shakaRequests = [];
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.abort();
  });
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const state = await page.evaluate(async () => {
    Object.defineProperty(window, 'MediaSource', {
      configurable: true,
      value: null,
    });
    const video = document.getElementById('player');
    video.canPlayType = () => '';
    const engine = new window.PlayerEngine(video, { videoId: 'TESTVIDEO01', streamToken: 'test-token' });
    window.__player = engine.getPlayer();
    await engine.init();
    await engine.load('/native-only.m3u8', undefined, 'application/vnd.apple.mpegurl');
    return {
      providerName: engine._providerName,
      state: engine._state,
      stats: engine.getPlayer().getStats(),
    };
  });

  expect(shakaRequests).toHaveLength(0);
  expect(state.providerName).toBe('native-terminal');
  expect(state.state).toBe('error');
  expect(state.stats.provider).toBe('native-terminal');
  expect(state.stats.mode).toBe('native-terminal');
  expect(state.stats.fallbackReason || '').toBe('');
  expect(state.stats.lastError).toBe('mse-unavailable');
  expect(state.stats.fatalError).toBe('mse-unavailable');
  expect(state.stats.nativeUnsupportedReason).toBe('mse-unavailable');
});

test('native load manifest HTTP error stays native with explicit terminal reason', async ({ page }) => {
  const shakaRequests = [];
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.abort();
  });
  await page.route('**/manifest-503.mpd', route => {
    route.fulfill({ status: 503, contentType: 'application/dash+xml', body: '' });
  });
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const state = await page.evaluate(async () => {
    const video = document.getElementById('player');
    const engine = new window.PlayerEngine(video, { videoId: 'TESTVIDEO01', streamToken: 'test-token' });
    window.__player = engine.getPlayer();
    await engine.init();
    await engine.load('/manifest-503.mpd');
    return {
      providerName: engine._providerName,
      state: engine._state,
      stats: engine.getPlayer().getStats(),
    };
  });

  expect(shakaRequests).toHaveLength(0);
  expect(state.providerName).toBe('native-terminal');
  expect(state.state).toBe('error');
  expect(state.stats.provider).toBe('native-terminal');
  expect(state.stats.fallbackReason || '').toBe('');
  expect(state.stats.lastError).toBe('manifest-http-503');
  expect(state.stats.fatalError).toBe('manifest-http-503');
  expect(state.stats.nativeUnsupportedReason).toBe('manifest-http-503');
});

test('native load manifest parse error stays native with explicit terminal reason', async ({ page }) => {
  const shakaRequests = [];
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.abort();
  });
  await page.route('**/bad-manifest-json', route => {
    route.fulfill({ status: 200, contentType: 'application/json', body: '{bad json' });
  });
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const state = await page.evaluate(async () => {
    const video = document.getElementById('player');
    const engine = new window.PlayerEngine(video, { videoId: 'TESTVIDEO01', streamToken: 'test-token' });
    window.__player = engine.getPlayer();
    await engine.init();
    await engine.load('/bad-manifest-json');
    const stats = engine.getPlayer().getStats();
    return {
      providerName: engine._providerName,
      state: engine._state,
      stats,
    };
  });

  expect(shakaRequests).toHaveLength(0);
  expect(state.providerName).toBe('native-terminal');
  expect(state.state).toBe('error');
  expect(state.stats.provider).toBe('native-terminal');
  expect(state.stats.fallbackReason).toBe('');
  expect(state.stats.lastError).toContain('JSON');
  expect(state.stats.fatalError).toBe(state.stats.lastError);
  expect(state.stats.nativeUnsupportedReason).toBe(state.stats.lastError);
});

test('native unclassified load error before provider stays native terminal', async ({ page }) => {
  const shakaRequests = [];
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.abort();
  });
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const state = await page.evaluate(async () => {
    const video = document.getElementById('player');
    const engine = new window.PlayerEngine(video, { videoId: 'TESTVIDEO01', streamToken: 'test-token' });
    window.__player = engine.getPlayer();
    await engine.init();
    engine._loadNative = () => Promise.reject(new Error('opaque-native-load-error'));
    await engine.load('/opaque.mpd');
    return {
      providerName: engine._providerName,
      state: engine._state,
      stats: engine.getPlayer().getStats(),
    };
  });

  expect(shakaRequests).toHaveLength(0);
  expect(state.providerName).toBe('native-terminal');
  expect(state.state).toBe('error');
  expect(state.stats.provider).toBe('native-terminal');
  expect(state.stats.fallbackReason).toBe('');
  expect(state.stats.lastError).toBe('opaque-native-load-error');
  expect(state.stats.fatalError).toBe('opaque-native-load-error');
  expect(state.stats.nativeUnsupportedReason).toBe('opaque-native-load-error');
});

test('native unclassified load error with provider stays native terminal', async ({ page }) => {
  const shakaRequests = [];
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.abort();
  });
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const state = await page.evaluate(async () => {
    const video = document.getElementById('player');
    const engine = new window.PlayerEngine(video, { videoId: 'TESTVIDEO01', streamToken: 'test-token' });
    const provider = {
      name: 'native-dash',
      lastError: '',
      fatalError: '',
      nativeUnsupportedReason: '',
      getStats() {
        return {
          provider: this.name,
          mode: 'dash',
          fallbackReason: engine._fallbackReason || '',
          lastError: this.lastError || '',
          fatalError: this.fatalError || '',
          nativeUnsupportedReason: this.nativeUnsupportedReason || '',
        };
      },
    };
    window.__player = engine.getPlayer();
    await engine.init();
    engine._loadNative = () => {
      engine._provider = provider;
      engine._providerName = provider.name;
      window._playerProvider = provider.name;
      return Promise.reject(new Error('opaque-provider-load-error'));
    };
    await engine.load('/opaque-provider.mpd');
    return {
      providerName: engine._providerName,
      state: engine._state,
      stats: engine.getPlayer().getStats(),
    };
  });

  expect(shakaRequests).toHaveLength(0);
  expect(state.providerName).toBe('native-dash');
  expect(state.state).toBe('error');
  expect(state.stats.provider).toBe('native-dash');
  expect(state.stats.fallbackReason).toBe('');
  expect(state.stats.lastError).toBe('opaque-provider-load-error');
  expect(state.stats.fatalError).toBe('opaque-provider-load-error');
  expect(state.stats.nativeUnsupportedReason).toBe('opaque-provider-load-error');
});

test('native DASH stats expose service-worker segment cache hits and misses', async ({ page }) => {
  const shakaRequests = [];
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.abort();
  });

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
  expect(stats.provider).toBe('native-dash');
  expect(stats.fallbackReason).toBe('');
  expect(stats.segmentCacheHitCount).toBe(1);
  expect(stats.segmentCacheMissCount).toBe(1);
  expect(stats.lastOfflineError).toBe('offline-segment-http-503');
  expect(stats.lastHttpStatus).toBe(503);
  expect(shakaRequests).toHaveLength(0);
});

test('native HLS stats expose service-worker manifest and segment cache state', async ({ page }) => {
  const shakaRequests = [];
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.abort();
  });

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
  expect(stats.provider).toBe('native-hls');
  expect(stats.fallbackReason).toBe('');
  expect(stats.manifestFromServiceWorker).toBe(true);
  expect(stats.segmentCacheHitCount).toBe(1);
  expect(stats.segmentCacheMissCount).toBe(1);
  expect(stats.lastOfflineError).toBe('offline-segment-http-503');
  expect(stats.lastHttpStatus).toBe(503);
  expect(stats.lastServiceWorkerSource).toBe('miss');
  expect(shakaRequests).toHaveLength(0);
});

test('native adapter reports only the actual active track as HD state source', async ({ page }) => {
  const shakaRequests = [];
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.abort();
  });

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
  expect(shakaRequests).toHaveLength(0);
});

test('native adapter exposes defensive configuration snapshots', async ({ page }) => {
  const shakaRequests = [];
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.abort();
  });

  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const state = await page.evaluate(() => {
    const video = document.getElementById('player');
    const engine = new window.PlayerEngine(video, { videoId: 'TESTVIDEO01', streamToken: 'test-token' });
    const player = engine.getPlayer();
    player.configure({
      abr: { enabled: false, restrictions: { minHeight: 360 } },
      streaming: { retryParameters: { maxAttempts: 5 } },
    });
    const snapshot = player.getConfiguration();
    snapshot.abr.enabled = true;
    snapshot.abr.restrictions.minHeight = 1080;
    snapshot.streaming.retryParameters.maxAttempts = 99;
    return {
      snapshot,
      current: player.getConfiguration(),
      stats: player.getStats(),
    };
  });

  expect(state.snapshot.abr.enabled).toBe(true);
  expect(state.snapshot.abr.restrictions.minHeight).toBe(1080);
  expect(state.snapshot.streaming.retryParameters.maxAttempts).toBe(99);
  expect(state.current.abr.enabled).toBe(false);
  expect(state.current.abr.restrictions.minHeight).toBe(360);
  expect(state.current.streaming.retryParameters.maxAttempts).toBe(5);
  expect(state.stats.fallbackReason || '').toBe('');
  expect(shakaRequests).toHaveLength(0);
});

test('native adapter exposes Shaka-shaped buffered info and timeline introspection', async ({ page }) => {
  const shakaRequests = [];
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.abort();
  });

  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const state = await page.evaluate(() => {
    function ranges(items) {
      return {
        length: items.length,
        start(index) { return items[index][0]; },
        end(index) { return items[index][1]; },
      };
    }

    const video = document.getElementById('player');
    Object.defineProperty(video, 'buffered', {
      configurable: true,
      get() { return ranges([[5.02, 10], [0, 5], [12, 12]]); },
    });
    video.currentTime = 7;

    const engine = new window.PlayerEngine(video, { videoId: 'TESTVIDEO01', streamToken: 'test-token' });
    const player = engine.getPlayer();
    engine._provider = {
      getLiveRange() { return { start: 3, end: 30 }; },
    };
    const loadedInfo = player.getBufferedInfo();
    const unloadedEngine = new window.PlayerEngine(document.createElement('video'), { videoId: 'EMPTY', streamToken: '' });

    return {
      loadedInfo,
      playhead: player.getPlayheadTime(),
      presentationStart: player.getPresentationStartTime(),
      unloadedInfo: unloadedEngine.getPlayer().getBufferedInfo(),
      unloadedPlayhead: unloadedEngine.getPlayer().getPlayheadTime(),
      unloadedPresentationStart: unloadedEngine.getPlayer().getPresentationStartTime(),
      stats: player.getStats(),
    };
  });

  expect(state.loadedInfo).toEqual({
    total: [{ start: 0, end: 10 }],
    audio: [{ start: 0, end: 10 }],
    video: [{ start: 0, end: 10 }],
    text: [],
  });
  expect(state.playhead).toBe(7);
  expect(state.presentationStart).toBe(3);
  expect(state.unloadedInfo).toEqual({ total: [], audio: [], video: [], text: [] });
  expect(state.unloadedPlayhead).toBe(0);
  expect(state.unloadedPresentationStart).toBe(0);
  expect(state.stats.fallbackReason || '').toBe('');
  expect(shakaRequests).toHaveLength(0);
});

test('native DASH and HLS buffered info preserve source-buffer audio and video ranges', async ({ page }) => {
  const shakaRequests = [];
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.abort();
  });

  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const state = await page.evaluate(() => {
    function ranges(items) {
      return {
        length: items.length,
        start(index) { return items[index][0]; },
        end(index) { return items[index][1]; },
      };
    }

    const video = document.getElementById('player');
    Object.defineProperty(video, 'buffered', {
      configurable: true,
      get() { return ranges([[0, 12]]); },
    });
    const engine = new window.PlayerEngine(video, { videoId: 'TESTVIDEO01', streamToken: 'test-token' });
    const dashProvider = {
      video,
      audioSb: { buffered: ranges([[1, 3], [3.02, 4]]) },
      videoSb: { buffered: ranges([[0, 8], [9, 12]]) },
    };
    const hlsProvider = {
      video,
      audioSb: { buffered: ranges([[2, 6]]) },
      sb: { buffered: ranges([[0, 5]]) },
    };
    engine._provider = {
      video,
      audioSb: dashProvider.audioSb,
      videoSb: dashProvider.videoSb,
      getBufferedInfo: window.NativeDashProviderForTest.getBufferedInfo,
    };
    return {
      dash: window.NativeDashProviderForTest.getBufferedInfo.call(dashProvider),
      hls: window.NativeHlsProviderForTest.getBufferedInfo.call(hlsProvider),
      adapter: engine.getPlayer().getBufferedInfo(),
    };
  });

  expect(state.dash).toEqual({
    total: [{ start: 0, end: 12 }],
    audio: [{ start: 1, end: 4 }],
    video: [{ start: 0, end: 8 }, { start: 9, end: 12 }],
    text: [],
  });
  expect(state.hls).toEqual({
    total: [{ start: 0, end: 12 }],
    audio: [{ start: 2, end: 6 }],
    video: [{ start: 0, end: 5 }],
    text: [],
  });
  expect(state.adapter).toEqual(state.dash);
  expect(shakaRequests).toHaveLength(0);
});

test('native adapter exposes Shaka-compatible seek ranges for unloaded, VOD, and live states', async ({ page }) => {
  const shakaRequests = [];
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.abort();
  });

  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const state = await page.evaluate(() => {
    const video = document.getElementById('player');
    const engine = new window.PlayerEngine(video, { videoId: 'TESTVIDEO01', streamToken: 'test-token' });
    const player = engine.getPlayer();
    const unloaded = player.seekRange();
    Object.defineProperty(video, 'duration', { configurable: true, get() { return 42; } });
    const vod = player.seekRange();
    engine._provider = {
      getLiveRange() { return { start: 12, end: 48 }; },
    };
    return {
      unloaded,
      vod,
      live: player.seekRange(),
      presentationStart: player.getPresentationStartTime(),
      stats: player.getStats(),
    };
  });

  expect(state.unloaded).toEqual({ start: 0, end: 0 });
  expect(state.vod).toEqual({ start: 0, end: 42 });
  expect(state.live).toEqual({ start: 12, end: 48 });
  expect(state.presentationStart).toBe(12);
  expect(state.stats.fallbackReason || '').toBe('');
  expect(shakaRequests).toHaveLength(0);
});

test('native adapter exposes playback-rate and trick-play controls', async ({ page }) => {
  const shakaRequests = [];
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.abort();
  });

  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const state = await page.evaluate(() => {
    const video = document.getElementById('player');
    const engine = new window.PlayerEngine(video, { videoId: 'TESTVIDEO01', streamToken: 'test-token' });
    const player = engine.getPlayer();
    const events = [];
    player.addEventListener('ratechange', event => events.push(event.detail.playbackRate));
    const initial = player.getPlaybackRate();
    const first = player.setPlaybackRate(1.5);
    const clampedHigh = player.trickPlay(3);
    const clampedLow = player.setPlaybackRate(0.1);
    const ignored = player.setPlaybackRate('bad');
    const restored = player.cancelTrickPlay();
    const stats = player.getStats();
    return { initial, first, clampedHigh, clampedLow, ignored, restored, videoRate: video.playbackRate, events, stats };
  });

  expect(state.initial).toBe(1);
  expect(state.first).toBe(1.5);
  expect(state.clampedHigh).toBe(2);
  expect(state.clampedLow).toBe(0.25);
  expect(state.ignored).toBe(0.25);
  expect(state.restored).toBe(1);
  expect(state.videoRate).toBe(1);
  expect(state.events).toEqual([1.5, 2, 0.25, 1]);
  expect(state.stats.playbackRate).toBe(1);
  expect(state.stats.lastPlaybackRate).toBe(1);
  expect(state.stats.playbackRateChangeCount).toBe(4);
  expect(state.stats.fallbackReason || '').toBe('');
  expect(shakaRequests).toHaveLength(0);
});

test('native adapter exposes I-frame preview tracks and stats', async ({ page }) => {
  const shakaRequests = [];
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.abort();
  });

  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const state = await page.evaluate(async () => {
    const video = document.getElementById('player');
    const engine = new window.PlayerEngine(video, { videoId: 'TESTVIDEO01', streamToken: 'test-token' });
    const player = engine.getPlayer();
    engine._provider = {
      getIFrameTracks() {
        return [{ id: 'iframe-0', height: 360, bandwidth: 120000, iframeOnly: true, loaded: false }];
      },
      getIFramePreview(time, trackId) {
        if (trackId === 'missing') return Promise.resolve(null);
        return Promise.resolve({ start: time, end: time + 2, url: '/iframe.mp4', track: { id: trackId || 'auto' } });
      },
      getStats() { return { provider: 'mock', fallbackReason: '' }; },
    };
    const tracks = player.getIFrameTracks();
    const hit = await player.getIFramePreview(12.5, 'iframe-0');
    const miss = await player.getIFramePreview(13, 'missing');
    const stats = player.getStats();
    return { tracks, hit, miss, stats };
  });

  expect(state.tracks).toEqual([
    expect.objectContaining({ id: 'iframe-0', height: 360, bandwidth: 120000, iframeOnly: true, loaded: false }),
  ]);
  expect(state.hit).toMatchObject({ start: 12.5, end: 14.5, url: '/iframe.mp4' });
  expect(state.miss).toBeNull();
  expect(state.stats.fallbackReason).toBe('');
  expect(state.stats.iframePreviewRequestCount).toBe(2);
  expect(state.stats.iframePreviewSuccessCount).toBe(1);
  expect(state.stats.iframePreviewMissCount).toBe(1);
  expect(state.stats.lastIFramePreviewTime).toBe(13);
  expect(state.stats.lastIFramePreviewTrackId).toBe('missing');
  expect(shakaRequests).toHaveLength(0);
});

test('native adapter exposes seek lifecycle methods for unloaded and provider states', async ({ page }) => {
  const shakaRequests = [];
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.abort();
  });

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
    const player = engine.getPlayer();
    const unloadedBegin = player.beginSeek(5);
    const unloadedCommit = player.commitSeek(5);
    player.endSeek();
    const calls = [];
    engine._provider = {
      beginSeek(target) { calls.push(['begin', target]); return target + 1; },
      commitSeek(target) { calls.push(['commit', target]); return target + 2; },
      cancelSeek() { calls.push(['cancel']); },
      endSeek() { calls.push(['end']); },
    };
    const delegatedBegin = player.beginSeek(10);
    const delegatedCommit = player.commitSeek(11);
    player.cancelSeek();
    player.endSeek();
    return { unloadedBegin, unloadedCommit, currentTime, delegatedBegin, delegatedCommit, calls };
  });

  expect(state.unloadedBegin).toBe(5);
  expect(state.unloadedCommit).toBe(5);
  expect(state.currentTime).toBe(5);
  expect(state.delegatedBegin).toBe(11);
  expect(state.delegatedCommit).toBe(13);
  expect(state.calls).toEqual([['begin', 10], ['commit', 11], ['cancel'], ['end']]);
  expect(shakaRequests).toHaveLength(0);
});

test('native provider seek lifecycle clamps live targets and records seek stats', async ({ page }) => {
  const shakaRequests = [];
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.abort();
  });

  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const state = await page.evaluate(() => {
    function makeVideo() {
      const video = document.getElementById('player').cloneNode();
      let currentTime = 0;
      Object.defineProperty(video, 'currentTime', {
        configurable: true,
        get() { return currentTime; },
        set(value) { currentTime = value; },
      });
      Object.defineProperty(video, 'buffered', {
        configurable: true,
        get() { return { length: 0, start() { return 0; }, end() { return 0; } }; },
      });
      return video;
    }
    function engineFor(states, events) {
      return {
        _serverDown: false,
        _setState(state) { states.push(state); },
        _telemetry: { record(type, payload) { events.push({ type, payload: payload || null }); } },
        _player: { config: { streaming: { bufferingGoal: 8, seekBufferGoal: 3 } } },
      };
    }
    const dashStates = [];
    const dashEvents = [];
    let dashAborted = 0;
    const dash = {
      video: makeVideo(),
      destroyed: false,
      live: true,
      liveWindow: { start: 10, end: 20 },
      activeVideo: { id: 'v', segments: [{ start: 19, end: 21, state: 'idle' }] },
      audio: { id: 'a', segments: [{ start: 19, end: 21, state: 'idle' }] },
      controllers: [{ abort() { dashAborted++; } }],
      activeRanges: { old: true },
      requestGeneration: 0,
      requestCancellationCount: 0,
      pendingSeek: 0,
      seekBufferPending: false,
      seekBufferReadyCount: 0,
      seekCount: 0,
      seekCancelCount: 0,
      seekAbortCount: 0,
      lastSeekTarget: 0,
      engine: engineFor(dashStates, dashEvents),
      _tick(force) { this.ticked = force; },
      beginSeek: window.NativeDashProviderForTest.beginSeek,
      _onSeek: window.NativeDashProviderForTest._onSeek,
      _clampSeekTarget: window.NativeDashProviderForTest._clampSeekTarget,
      _availabilityWindowOverride: window.NativeDashProviderForTest._availabilityWindowOverride,
      _effectiveLiveWindow: window.NativeDashProviderForTest._effectiveLiveWindow,
      _seekBufferGoal: window.NativeDashProviderForTest._seekBufferGoal,
      _bufferAheadGoal: window.NativeDashProviderForTest._bufferAheadGoal,
      _abortRequests: window.NativeDashProviderForTest._abortRequests,
    };
    const dashTarget = window.NativeDashProviderForTest.commitSeek.call(dash, 25);
    window.NativeDashProviderForTest.cancelSeek.call(dash);

    const hlsStates = [];
    const hlsEvents = [];
    let hlsAborted = 0;
    const hls = {
      video: makeVideo(),
      destroyed: false,
      live: true,
      liveWindow: { start: 30, end: 40 },
      segments: [{ start: 30, end: 33, state: 'idle' }],
      activeAudio: { id: 'aud', segments: [{ start: 30, end: 33, state: 'idle' }] },
      controllers: [{ abort() { hlsAborted++; } }],
      activeRanges: { old: true },
      seekBufferPending: false,
      seekBufferReadyCount: 0,
      seekCount: 0,
      seekCancelCount: 0,
      seekAbortCount: 0,
      lastSeekTarget: 0,
      engine: engineFor(hlsStates, hlsEvents),
      _appending: true,
      _tick(force) { this.ticked = force; },
      beginSeek: window.NativeHlsProviderForTest.beginSeek,
      _onSeek: window.NativeHlsProviderForTest._onSeek,
      _clampSeekTarget: window.NativeHlsProviderForTest._clampSeekTarget,
      _seekBufferGoal: window.NativeHlsProviderForTest._seekBufferGoal,
      _bufferAheadGoal: window.NativeDashProviderForTest._bufferAheadGoal,
      _abortRequests: window.NativeHlsProviderForTest._abortRequests,
    };
    const hlsTarget = window.NativeHlsProviderForTest.commitSeek.call(hls, 20);
    window.NativeHlsProviderForTest.endSeek.call(hls);

    return {
      dash: {
        target: dashTarget,
        currentTime: dash.video.currentTime,
        requestGeneration: dash.requestGeneration,
        requestCancellationCount: dash.requestCancellationCount,
        seekAbortCount: dash.seekAbortCount,
        seekCancelCount: dash.seekCancelCount,
        seekCount: dash.seekCount,
        seekBufferPending: dash.seekBufferPending,
        lastSeekTarget: dash.lastSeekTarget,
        dashAborted,
        states: dashStates,
        ticked: dash.ticked,
        videoSegmentState: dash.activeVideo.segments[0].state,
        audioSegmentState: dash.audio.segments[0].state,
      },
      hls: {
        target: hlsTarget,
        currentTime: hls.video.currentTime,
        seekAbortCount: hls.seekAbortCount,
        seekCount: hls.seekCount,
        seekBufferPending: hls.seekBufferPending,
        lastSeekTarget: hls.lastSeekTarget,
        hlsAborted,
        states: hlsStates,
        ticked: hls.ticked,
        appending: hls._appending,
        videoSegmentState: hls.segments[0].state,
        audioSegmentState: hls.activeAudio.segments[0].state,
      },
    };
  });

  expect(state.dash.target).toBe(20);
  expect(state.dash.currentTime).toBe(20);
  expect(state.dash.requestGeneration).toBe(1);
  expect(state.dash.requestCancellationCount).toBe(2);
  expect(state.dash.seekAbortCount).toBe(2);
  expect(state.dash.seekCancelCount).toBe(1);
  expect(state.dash.seekCount).toBe(1);
  expect(state.dash.seekBufferPending).toBe(false);
  expect(state.dash.lastSeekTarget).toBe(20);
  expect(state.dash.dashAborted).toBe(1);
  expect(state.dash.states).toContain('seeking');
  expect(state.dash.ticked).toBe(true);
  expect(state.dash.videoSegmentState).toBe('pending');
  expect(state.dash.audioSegmentState).toBe('pending');

  expect(state.hls.target).toBe(30);
  expect(state.hls.currentTime).toBe(30);
  expect(state.hls.seekAbortCount).toBe(2);
  expect(state.hls.seekCount).toBe(1);
  expect(state.hls.seekBufferPending).toBe(true);
  expect(state.hls.lastSeekTarget).toBe(30);
  expect(state.hls.hlsAborted).toBe(1);
  expect(state.hls.states).toContain('seeking');
  expect(state.hls.states).toContain('ready');
  expect(state.hls.ticked).toBe(true);
  expect(state.hls.appending).toBe(false);
  expect(state.hls.videoSegmentState).toBe('pending');
  expect(state.hls.audioSegmentState).toBe('pending');
  expect(shakaRequests).toHaveLength(0);
});

test('watch seek bar uses player seek lifecycle without hard-coded buffer restoration', async ({ request }) => {
  const login = await request.post('/auth/free', { maxRedirects: 0 });
  expect(login.status()).toBeGreaterThanOrEqual(300);
  expect(login.status()).toBeLessThan(400);

  const watch = await request.get('/watch?v=dQw4w9WgXcQ');
  expect(watch.status()).toBe(200);
  const html = await watch.text();
  expect(html).toContain('player.beginSeek');
  expect(html).toContain('player.commitSeek');
  expect(html).toContain('player.endSeek');
  expect(html).not.toContain("streaming.bufferingGoal', 120");
  expect(html).not.toContain("streaming.rebufferingGoal', 0.01");
});

test('watch live badge uses player live-edge API and stats', async ({ request }) => {
  const login = await request.post('/auth/free', { maxRedirects: 0 });
  expect(login.status()).toBeGreaterThanOrEqual(300);
  expect(login.status()).toBeLessThan(400);

  const watch = await request.get('/watch?v=dQw4w9WgXcQ');
  expect(watch.status()).toBe(200);
  const html = await watch.text();
  expect(html).toContain('if (player.seekToLiveEdge) player.seekToLiveEdge();');
  expect(html).toContain('player.getStats ? player.getStats() : null');
  expect(html).toContain("typeof stats.atLiveEdge === 'boolean'");
  expect(html).toContain('stats.liveLatency');
  expect(html).not.toContain('video.currentTime = range.end');
});

test('watch user seek surfaces route through shared player seek lifecycle helper', async ({ request }) => {
  const login = await request.post('/auth/free', { maxRedirects: 0 });
  expect(login.status()).toBeGreaterThanOrEqual(300);
  expect(login.status()).toBeLessThan(400);

  const watch = await request.get('/watch?v=dQw4w9WgXcQ');
  expect(watch.status()).toBe(200);
  const html = await watch.text();
  expect(html).toContain('function playerSeekTo(target, opts)');
  expect(html).toContain('window._playerSeekTo = playerSeekTo');
  expect(html).toContain("navigator.mediaSession.setActionHandler('seekbackward', function () { playerSeekTo");
  expect(html).toContain("navigator.mediaSession.setActionHandler('seekforward', function () { playerSeekTo");
  expect(html).toContain("navigator.mediaSession.setActionHandler('seekto', function (d) { if (d.seekTime != null) playerSeekTo(d.seekTime); });");
  expect(html).toContain('playerSeekTo(Math.max(0, (engine.recovering ? engine.lastGoodTime : video.currentTime) - 5)');
  expect(html).toContain('playerSeekTo(Math.min(video.duration || Infinity, (engine.recovering ? engine.lastGoodTime : video.currentTime) + 5)');
  expect(html).toContain('playerSeekTo(dur * pct)');
  expect(html).toContain('playerSeekTo(chapters[idx].start_time)');
  expect(html).toContain('playerSeekTo(parseFloat(link.dataset.time))');
  expect(html).not.toContain('video.currentTime = Math.max(0, video.currentTime - 5)');
  expect(html).not.toContain('video.currentTime = Math.min(video.duration || Infinity, video.currentTime + 5)');
  expect(html).not.toContain('video.currentTime = dur * pct');
  expect(html).not.toContain('video.currentTime = chapters[idx].start_time');
  expect(html).not.toContain('video.currentTime = parseFloat(link.dataset.time)');
  expect(html).not.toContain("setActionHandler('seekto', function (d) { if (d.seekTime != null) video.currentTime = d.seekTime; });");
});

test('watch playback speed controls use player adapter API', async ({ request }) => {
  const login = await request.post('/auth/free', { maxRedirects: 0 });
  expect(login.status()).toBeGreaterThanOrEqual(300);
  expect(login.status()).toBeLessThan(400);

  const watch = await request.get('/watch?v=dQw4w9WgXcQ');
  expect(watch.status()).toBe(200);
  const html = await watch.text();
  expect(html).toContain('if (player.setPlaybackRate) player.setPlaybackRate(rate);');
  expect(html).toContain('if (player.setPlaybackRate) player.setPlaybackRate(savedSpeed);');
  expect(html).toContain('player.getPlaybackRate ? player.getPlaybackRate() : video.playbackRate');
  expect(html).toContain("localStorage.getItem('player-speed')");
  expect(html).not.toContain('video.playbackRate = Math.min(2, video.playbackRate + 0.25);');
  expect(html).not.toContain('video.playbackRate = Math.max(0.25, video.playbackRate - 0.25);');
  expect(html).not.toContain('video.playbackRate = rate;\n              });');
});

test('watch seek preview falls back from storyboards to native I-frame metadata', async ({ request }) => {
  const login = await request.post('/auth/free', { maxRedirects: 0 });
  expect(login.status()).toBeGreaterThanOrEqual(300);
  expect(login.status()).toBeLessThan(400);

  const watch = await request.get('/watch?v=dQw4w9WgXcQ');
  expect(watch.status()).toBe(200);
  const html = await watch.text();
  expect(html).toContain("var previewSource = 'none';");
  expect(html).toContain('window._seekPreviewSource = previewSource;');
  expect(html).toContain('tooltip.dataset.previewSource = previewSource;');
  expect(html).toContain('function requestIFramePreview(time)');
  expect(html).toContain('player.getIFramePreview(time).then(function (preview)');
  expect(html).toContain("setPreviewSource(lastIframePreview ? 'iframe' : 'none');");
  expect(html).toContain("setPreviewSource('storyboard');");
  expect(html).toContain('tooltip.dataset.previewUrl = preview.url ||');
  expect(html).toContain("return fetch('/api/stream/");
});

test('thumbnail preview uses native I-frame metadata after storyboard failure', async ({ page }) => {
  const shakaRequests = [];
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.abort();
  });

  const source = readFileSync('views/player/thumbnail-preview.ejs', 'utf8').replaceAll('<%= video.videoId %>', 'PLAYERTEST1');

  await page.setContent(`<div id="player-container" style="width:400px;height:240px"><div id="seek" style="width:400px;height:20px"></div><video id="player"></video></div>`);
  await page.addScriptTag({ content: `
    var container = document.getElementById('player-container');
    var video = document.getElementById('player');
    var seekBarContainer = document.getElementById('seek');
    var streamToken = 'test-token';
    var isLive = false;
    var iframeCalls = [];
    Object.defineProperty(video, 'duration', { configurable: true, get: function () { return 100; } });
    function safePlayerCall(fn) { try { return fn(); } catch (e) { return null; } }
    function getLiveRange() { return { start: 0, end: 100 }; }
    function formatTime(value) { return String(value); }
    function seekTimeFromMouse(e) {
      var rect = seekBarContainer.getBoundingClientRect();
      return ((e.clientX - rect.left) / rect.width) * video.duration;
    }
    var player = {
      getIFrameTracks: function () { return [{ id: 'iframe-0', height: 360, iframeOnly: true }]; },
      getIFramePreview: function (time) {
        iframeCalls.push(time);
        return Promise.resolve({ start: 24, end: 26, url: '/iframe.mp4', range: { start: 10, end: 20 }, track: { id: 'iframe-0' } });
      },
      getStats: function () {
        return { provider: 'native-hls', fallbackReason: '' };
      }
    };
    window.fetch = function () { return Promise.resolve({ ok: false }); };
  ` });
  await page.addScriptTag({ content: source });

  await page.evaluate(() => window._loadStoryboard());
  await page.dispatchEvent('#seek', 'mousemove', { clientX: 100, clientY: 10 });
  await page.waitForTimeout(180);
  await expect.poll(() => page.evaluate(() => window._seekPreviewSource)).toBe('iframe');

  const state = await page.evaluate(() => {
    const tooltip = document.querySelector('.seek-thumbnail');
    return {
      calls: iframeCalls.length,
      source: tooltip.dataset.previewSource,
      url: tooltip.dataset.previewUrl,
      range: tooltip.dataset.previewRange,
      imageDisplay: document.querySelector('.seek-thumbnail-img').style.display,
      stats: player.getStats(),
    };
  });
  expect(state.calls).toBe(1);
  expect(state.source).toBe('iframe');
  expect(state.url).toBe('/iframe.mp4');
  expect(state.range).toBe('10-20');
  expect(state.imageDisplay).toBe('none');
  expect(state.stats.fallbackReason).toBe('');
  expect(shakaRequests).toHaveLength(0);
});

test('watch page renders centralized player cleanup hooks', async ({ request }) => {
  const login = await request.post('/auth/free', { maxRedirects: 0 });
  expect(login.status()).toBeGreaterThanOrEqual(300);
  expect(login.status()).toBeLessThan(400);

  const watch = await request.get('/watch?v=dQw4w9WgXcQ');
  expect(watch.status()).toBe(200);
  const html = await watch.text();

  expect(html).toContain('function runPlayerCleanupTasks()');
  expect(html).toContain('window._cleanupPlayer = function ()');
  expect(html).toContain('if (window._detailsTimer)');
  expect(html).toContain('runPlayerCleanupTasks();');
});

test('native engine destroy removes owned listeners and is idempotent', async ({ page }) => {
  const shakaRequests = [];
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.abort();
  });

  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const state = await page.evaluate(async () => {
    const video = document.getElementById('player');
    const counts = { videoAdd: {}, videoRemove: {}, windowAdd: {}, windowRemove: {} };
    const originalVideoAdd = video.addEventListener.bind(video);
    const originalVideoRemove = video.removeEventListener.bind(video);
    const originalWindowAdd = window.addEventListener.bind(window);
    const originalWindowRemove = window.removeEventListener.bind(window);
    video.addEventListener = function (name, fn, opts) {
      counts.videoAdd[name] = (counts.videoAdd[name] || 0) + 1;
      return originalVideoAdd(name, fn, opts);
    };
    video.removeEventListener = function (name, fn, opts) {
      counts.videoRemove[name] = (counts.videoRemove[name] || 0) + 1;
      return originalVideoRemove(name, fn, opts);
    };
    window.addEventListener = function (name, fn, opts) {
      counts.windowAdd[name] = (counts.windowAdd[name] || 0) + 1;
      return originalWindowAdd(name, fn, opts);
    };
    window.removeEventListener = function (name, fn, opts) {
      counts.windowRemove[name] = (counts.windowRemove[name] || 0) + 1;
      return originalWindowRemove(name, fn, opts);
    };
    try {
      const engine = new window.PlayerEngine(video, { videoId: 'TESTVIDEO01', streamToken: 'test-token' });
      await engine.init();
      engine.destroy();
      engine.destroy();
      return {
        destroyed: engine.destroyed,
        recovering: engine.isRecovering(),
        state: engine._state,
        counts,
      };
    } finally {
      video.addEventListener = originalVideoAdd;
      video.removeEventListener = originalVideoRemove;
      window.addEventListener = originalWindowAdd;
      window.removeEventListener = originalWindowRemove;
    }
  });

  expect(state.destroyed).toBe(true);
  expect(state.recovering).toBe(false);
  expect(state.state).toBe('destroyed');
  expect(state.counts.videoRemove.timeupdate).toBe(state.counts.videoAdd.timeupdate);
  expect(state.counts.videoRemove.error).toBe(state.counts.videoAdd.error);
  expect(state.counts.videoRemove.loadeddata).toBe(state.counts.videoAdd.loadeddata);
  expect(state.counts.windowRemove.pagehide).toBe(state.counts.windowAdd.pagehide);
  expect(state.counts.windowRemove.beforeunload).toBe(state.counts.windowAdd.beforeunload);
  expect(shakaRequests).toHaveLength(0);
});

test('native telemetry unload summary is one-shot and detached after destroy', async ({ page }) => {
  const shakaRequests = [];
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.abort();
  });

  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const state = await page.evaluate(async () => {
    const batches = [];
    const originalBeacon = navigator.sendBeacon;
    navigator.sendBeacon = function (url, body) {
      batches.push({ url, body: body ? body.text ? null : String(body) : '' });
      return true;
    };
    try {
      const video = document.getElementById('player');
      const engine = new window.PlayerEngine(video, { videoId: 'TESTVIDEO01', streamToken: 'test-token' });
      await engine.init();
      window.dispatchEvent(new Event('pagehide'));
      engine.destroy();
      window.dispatchEvent(new Event('beforeunload'));
      return {
        batchCount: batches.length,
        eventTypes: engine._telemetry.events.map(event => event.type),
        telemetryDestroyed: engine._telemetry.destroyed,
      };
    } finally {
      navigator.sendBeacon = originalBeacon;
    }
  });

  expect(state.batchCount).toBe(1);
  expect(state.eventTypes).toEqual([]);
  expect(state.telemetryDestroyed).toBe(true);
  expect(shakaRequests).toHaveLength(0);
});

test('native engine destroy rejects held network requests and clears hold stats', async ({ page }) => {
  const shakaRequests = [];
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.abort();
  });
  await page.route('**/held-destroy.m4s', route => {
    route.fulfill({ status: 500, contentType: 'text/plain', body: 'down' });
  });
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const state = await page.evaluate(async () => {
    window.__disablePlayerTelemetry = true;
    const video = document.getElementById('player');
    const engine = new window.PlayerEngine(video, { videoId: 'DESTROYHOLD', streamToken: 'test-token' });
    await engine.init();
    engine._setState('ready');
    engine._startServerProbe = function () {};
    const player = engine.getPlayer();
    const net = player.getNetworkingEngine();
    const request = net.request(net.RequestType.SEGMENT, { uris: ['/held-destroy.m4s'] }, { forceNetworkHold: true })
      .then(() => ({ ok: true }))
      .catch(err => ({ ok: false, message: err.message }));
    for (let i = 0; i < 20; i++) {
      if (player.getStats().networkHeldRequestCount > 0) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const before = player.getStats();
    engine.destroy();
    const result = await request;
    const after = player.getStats();
    return {
      beforeHeld: before.networkHeldRequestCount,
      result,
      afterHeld: after.networkHeldRequestCount,
      recovering: engine.isRecovering(),
      destroyed: engine.destroyed,
    };
  });

  expect(state.beforeHeld).toBe(1);
  expect(state.result).toEqual({ ok: false, message: 'player-destroyed' });
  expect(state.afterHeld).toBe(0);
  expect(state.recovering).toBe(false);
  expect(state.destroyed).toBe(true);
  expect(shakaRequests).toHaveLength(0);
});

test('native adapter unload clears provider state and stays reusable', async ({ page }) => {
  const shakaRequests = [];
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.abort();
  });

  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player" src="/old.mp4"></video>');

  const state = await page.evaluate(async () => {
    const video = document.getElementById('player');
    const engine = new window.PlayerEngine(video, { videoId: 'TESTVIDEO01', streamToken: 'test-token' });
    const player = engine.getPlayer();
    let destroyed = 0;
    let visibility = null;
    engine.setTextController({
      activeTrackId: 'en',
      getTextTracks() { return []; },
      getActiveTextTrack() { return null; },
      selectTextTrack() { return Promise.resolve(); },
      setTextTrackVisibility(value) { visibility = value; return Promise.resolve(); },
    });
    engine._provider = { destroy() { destroyed++; } };
    engine._providerName = 'native-dash';
    window._playerProvider = 'native-dash';
    await player.unload();
    const afterUnload = {
      destroyed,
      providerName: engine._providerName,
      windowProvider: window._playerProvider,
      visibility,
      src: video.getAttribute('src'),
      activeTrackId: engine._textController.activeTrackId,
    };
    let loadedUrl = '';
    engine._loadNative = function (url) {
      loadedUrl = url;
      return Promise.resolve();
    };
    await player.load('/next.mpd');
    return { afterUnload, loadedUrl, state: engine._state };
  });

  expect(state.afterUnload.destroyed).toBe(1);
  expect(state.afterUnload.providerName).toBe('');
  expect(state.afterUnload.windowProvider).toBe('');
  expect(state.afterUnload.visibility).toBe(false);
  expect(state.afterUnload.src).toBe(null);
  expect(state.afterUnload.activeTrackId).toBe('');
  expect(state.loadedUrl).toBe('/next.mpd');
  expect(state.state).toBe('loading');
  expect(shakaRequests).toHaveLength(0);
});

test('native load honors startTime and HLS MIME hints', async ({ page }) => {
  const shakaRequests = [];
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.abort();
  });
  await page.route('**/ambiguous-hls', route => {
    route.fulfill({
      status: 200,
      contentType: 'application/vnd.apple.mpegurl',
      body: [
        '#EXTM3U',
        '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.42c01f,mp4a.40.2"',
        '/api/stream/PLAYERTEST1/hls/v360.m3u8?fixtureHls=1',
      ].join('\n'),
    });
  });

  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player" muted playsinline style="width:1280px;height:720px"></video>');

  const state = await page.evaluate(async () => {
    const video = document.getElementById('player');
    video.muted = true;
    video.canPlayType = () => '';
    const engine = new window.PlayerEngine(video, { videoId: 'PLAYERTEST1', streamToken: '' });
    const player = engine.getPlayer();
    window.__engine = engine;
    window.__player = player;
    await engine.init();
    await player.load('/api/stream/PLAYERTEST1/dash.mpd?fixtureTemplate=timeline', 1.5);
    const dash = {
      provider: window._playerProvider,
      currentTime: video.currentTime,
      range: player.seekRange(),
      stats: player.getStats(),
    };
    await player.unload();
    await player.load('/ambiguous-hls', 1, 'application/x-mpegurl');
    return {
      dash,
      hlsProvider: window._playerProvider,
      hlsTime: video.currentTime,
      hlsStats: player.getStats(),
    };
  });

  expect(state.dash.provider).toBe('native-dash');
  expect(state.dash.currentTime).toBeCloseTo(1.5, 1);
  expect(state.dash.range.end).toBeGreaterThan(1.5);
  expect(state.dash.stats.fallbackReason).toBe('');
  expect(state.hlsProvider).toBe('native-hls');
  expect(state.hlsTime).toBeCloseTo(1, 1);
  expect(state.hlsStats.provider).toBe('native-hls');
  expect(state.hlsStats.fallbackReason).toBe('');
  expect(shakaRequests).toHaveLength(0);
});

test('native networking engine applies filters to DASH and HLS manifests and media', async ({ page }) => {
  const filteredRequests = [];
  const shakaRequests = [];
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.abort();
  });
  await page.route('**/api/stream/PLAYERTEST1/**', route => {
    const headers = route.request().headers();
    if (headers['x-native-filter']) {
      filteredRequests.push({
        url: route.request().url(),
        type: headers['x-native-filter'],
      });
    }
    route.continue();
  });

  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player" muted playsinline style="width:1280px;height:720px"></video>');

  const state = await page.evaluate(async () => {
    const video = document.getElementById('player');
    video.muted = true;
    video.canPlayType = () => '';
    const engine = new window.PlayerEngine(video, { videoId: 'PLAYERTEST1', streamToken: '' });
    const player = engine.getPlayer();
    const net = player.getNetworkingEngine();
    const responses = [];
    net.registerRequestFilter((type, request) => {
      request.headers['X-Native-Filter'] = type;
    });
    net.registerResponseFilter((type, response) => {
      responses.push({ type, status: response.status, originalUri: response.originalUri });
    });
    await engine.init();
    await player.load('/api/stream/PLAYERTEST1/dash.mpd?fixtureTemplate=timeline');
    const dashStats = player.getStats();
    await player.unload();
    await player.load('/api/stream/PLAYERTEST1/hls.m3u8?fixtureHls=1');
    const hlsStats = player.getStats();
    return {
      dashStats,
      hlsStats,
      responses,
      sameEngine: net === player.getNetworkingEngine(),
      requestType: net.RequestType.SEGMENT,
    };
  });

  expect(state.sameEngine).toBe(true);
  expect(state.requestType).toBe('SEGMENT');
  expect(state.dashStats.provider).toBe('native-dash');
  expect(state.dashStats.fallbackReason).toBe('');
  expect(state.hlsStats.provider).toBe('native-hls');
  expect(state.hlsStats.fallbackReason).toBe('');
  expect(state.dashStats.networkingManifestRequestCount).toBeGreaterThan(0);
  expect(state.dashStats.networkingSegmentRequestCount).toBeGreaterThan(0);
  expect(state.responses.some(item => item.type === 'MANIFEST' && item.status === 200)).toBe(true);
  expect(state.responses.some(item => item.type === 'SEGMENT' && item.status === 206)).toBe(true);
  expect(state.hlsStats.networkingManifestRequestCount).toBeGreaterThan(1);
  expect(state.hlsStats.networkingSegmentRequestCount).toBeGreaterThan(0);
  expect(state.hlsStats.lastNetworkingStatus).toBeGreaterThanOrEqual(200);
  expect(state.hlsStats.networkingTotalRequestMs).toBeGreaterThanOrEqual(0);
  expect(filteredRequests.some(item => item.url.includes('dash.mpd') && item.type === 'MANIFEST')).toBe(true);
  expect(filteredRequests.some(item => item.url.includes('.m3u8') && item.type === 'MANIFEST')).toBe(true);
  expect(filteredRequests.some(item => item.type === 'SEGMENT')).toBe(true);
  expect(shakaRequests).toHaveLength(0);
});

test('native networking engine supports response mutation and explicit filter failures', async ({ page }) => {
  const shakaRequests = [];
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.abort();
  });
  await page.route('**/networking-text.txt', route => {
    route.fulfill({ status: 200, contentType: 'text/plain', body: 'original' });
  });

  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const state = await page.evaluate(async () => {
    const engine = new window.PlayerEngine(document.getElementById('player'), { videoId: 'PLAYERTEST1', streamToken: '' });
    const net = engine.getPlayer().getNetworkingEngine();
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    net.registerResponseFilter((type, response) => {
      response.data = encoder.encode('mutated').buffer;
      response.headers['x-mutated'] = '1';
    });
    const response = await net.request(net.RequestType.OTHER, { uris: ['/networking-text.txt'] });
    net.clearAllResponseFilters();
    net.registerRequestFilter(() => {
      throw new Error('blocked');
    });
    let failure = '';
    try {
      await net.request(net.RequestType.OTHER, { uris: ['/networking-text.txt'] });
    } catch (err) {
      failure = err.message;
    }
    return {
      text: decoder.decode(response.data),
      mutatedHeader: response.headers['x-mutated'],
      failure,
      stats: engine.getPlayer().getStats(),
    };
  });

  expect(state.text).toBe('mutated');
  expect(state.mutatedHeader).toBe('1');
  expect(state.failure).toBe('native-network-request-filter-failed');
  expect(state.stats.fallbackReason || '').toBe('');
  expect(state.stats.networkingOtherRequestCount).toBe(2);
  expect(state.stats.networkingFilterErrorCount).toBe(1);
  expect(shakaRequests).toHaveLength(0);
});

test('native networking engine routes HLS keys through KEY requests', async ({ page }) => {
  const keyRequests = [];
  const shakaRequests = [];
  await page.route('**/api/stream/PLAYERTEST1/**', route => {
    const headers = route.request().headers();
    if (headers['x-native-key'] === '1') keyRequests.push(route.request().url());
    route.continue();
  });
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
    const player = engine.getPlayer();
    player.getNetworkingEngine().registerRequestFilter((type, request) => {
      if (type === 'KEY') request.headers['X-Native-Key'] = '1';
    });
    window.__player = player;
    player.configure({ streaming: { bufferingGoal: 2, startupBufferGoal: 1, maxConcurrentRequests: 1 } });
    return engine.init().then(() => engine.load('/api/stream/PLAYERTEST1/hls.m3u8?fixtureHls=aes'));
  });

  await expect.poll(() => page.evaluate(() => window._playerProvider)).toBe('native-hls');
  await page.evaluate(() => document.getElementById('player').play());
  await page.waitForFunction(() => document.getElementById('player').currentTime > 0, null, { timeout: 10_000 });

  const stats = await page.evaluate(() => window.__player.getStats());
  expect(keyRequests.length).toBeGreaterThan(0);
  expect(stats.provider).toBe('native-hls');
  expect(stats.networkingKeyRequestCount).toBeGreaterThan(0);
  expect(stats.hlsKeyFetchCount).toBe(1);
  expect(stats.fallbackReason).toBe('');
  expect(shakaRequests).toHaveLength(0);
});

test('native networking engine routes DASH DRM licenses through LICENSE requests', async ({ page }) => {
  const licenseRequests = [];
  const shakaRequests = [];
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.abort();
  });
  await page.route('**/license-test', async route => {
    const request = route.request();
    licenseRequests.push({
      header: request.headers()['x-native-license'],
      body: await request.postDataBuffer(),
    });
    route.fulfill({
      status: 200,
      contentType: 'application/octet-stream',
      body: Buffer.from([9, 8, 7, 6]),
    });
  });

  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const state = await page.evaluate(async () => {
    const engine = new window.PlayerEngine(document.getElementById('player'), { videoId: 'PLAYERTEST1', streamToken: '' });
    const player = engine.getPlayer();
    player.getNetworkingEngine().registerRequestFilter((type, request) => {
      if (type === 'LICENSE') request.headers['X-Native-License'] = '1';
    });
    const provider = {
      engine,
      drmInfo: { keySystem: 'com.example.drm', licenseServerUrl: '/license-test' },
      drmLicenseRequestCount: 0,
      lastDrmError: '',
    };
    let licenseLength = 0;
    const session = {
      update(data) {
        licenseLength = data.byteLength;
        return Promise.resolve();
      },
    };
    await window.NativeDashProviderForTest._handleDrmMessage.call(provider, session, new Uint8Array([1, 2, 3]).buffer);
    return {
      licenseLength,
      providerRequestCount: provider.drmLicenseRequestCount,
      lastDrmError: provider.lastDrmError,
      stats: player.getStats(),
    };
  });

  expect(licenseRequests).toHaveLength(1);
  expect(licenseRequests[0].header).toBe('1');
  expect([...licenseRequests[0].body]).toEqual([1, 2, 3]);
  expect(state.licenseLength).toBe(4);
  expect(state.providerRequestCount).toBe(1);
  expect(state.lastDrmError).toBe('');
  expect(state.stats.fallbackReason || '').toBe('');
  expect(state.stats.networkingLicenseRequestCount).toBe(1);
  expect(shakaRequests).toHaveLength(0);
});

test('native timeline region events are emitted once and reflected in stats', async ({ page }) => {
  const shakaRequests = await blockShakaScript(page);
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const state = await page.evaluate(() => {
    const video = document.getElementById('player');
    const engine = new window.PlayerEngine(video, { videoId: 'TESTVIDEO01', streamToken: 'test-token' });
    const events = [];
    engine.getPlayer().addEventListener('timelineregionadded', event => events.push(event.detail));
    const provider = {
      engine,
      video,
      name: 'native-dash',
      manifestUrl: '/manifest.mpd',
      live: false,
      bandwidth: 0,
      bandwidthSamples: 0,
      activeRanges: {},
      videoSb: null,
      audioSb: null,
      videoReps: [],
      audioReps: [],
      textReps: [],
      activeVideo: null,
      audio: null,
      timelineRegions: [],
      timelineRegionKeys: {},
      lastTimelineRegion: null,
      manifestStartTime: 6,
      getActiveVariantTrack() { return null; },
      getTextTracks() { return []; },
      getStats: window.NativeDashProviderForTest.getStats,
    };
    engine._provider = provider;
    window.NativeDashProviderForTest._addTimelineRegions.call(provider, [
      { id: 'ad-1', schemeIdUri: 'urn:test', value: 'ad', startTime: 5, endTime: 9, eventElement: 'payload', source: 'dash-eventstream' },
      { id: 'ad-1', schemeIdUri: 'urn:test', value: 'ad', startTime: 5, endTime: 9, eventElement: 'payload', source: 'dash-eventstream' },
      { id: 'ad-2', schemeIdUri: 'urn:test', value: 'ad', startTime: 10, endTime: 12, source: 'dash-eventstream' },
    ]);
    return {
      events,
      stats: provider.getStats(),
    };
  });

  expect(state.events).toHaveLength(2);
  expect(state.events[0]).toMatchObject({ id: 'ad-1', schemeIdUri: 'urn:test', startTime: 5, endTime: 9 });
  expect(state.stats.timelineRegionCount).toBe(2);
  expect(state.stats.lastTimelineRegion).toMatchObject({ id: 'ad-2', startTime: 10, endTime: 12 });
  expect(state.stats.manifestStartTime).toBe(6);
  expect(shakaRequests).toHaveLength(0);
});

test('native startup chooses a non-fuzzy initial representation within bandwidth budget', async ({ page }) => {
  const shakaRequests = [];
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.abort();
  });

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
  expect(shakaRequests).toHaveLength(0);
});

test('native DASH startup uses default ABR without a minimum-height floor', async ({ page }) => {
  await page.goto('/auth/login');
  await page.setContent('<div id="players"></div>');
  await page.addScriptTag({ path: 'public/native-player-engine.js' });

  const state = await page.evaluate(async () => {
    const urls = [
      '/api/stream/PLAYERTEST1/dash.mpd',
      '/api/stream/PLAYERTEST1/dash.mpd?fixtureTemplate=timeline',
      '/api/stream/PLAYERTEST1/dash.mpd?fixtureSegmentList=range',
      '/api/stream/PLAYERTEST1/dash.mpd?fixtureLive=multiperiod',
    ];
    const results = [];
    for (const url of urls) {
      const nativeVideo = document.createElement('video');
      nativeVideo.muted = true;
      nativeVideo.setAttribute('playsinline', '');
      nativeVideo.style.cssText = 'width:1280px;height:720px';
      document.getElementById('players').replaceChildren(nativeVideo);

      const engine = new window.PlayerEngine(nativeVideo, { videoId: 'PLAYERTEST1', streamToken: '' });
      await engine.init();
      await engine.load(url);
      const nativeTrack = engine.getPlayer().getActiveVariantTrack();
      results.push({
        url,
        nativeHeight: nativeTrack && nativeTrack.height,
        nativeProvider: engine.getPlayer().getStats().provider,
        nativeFallbackReason: engine.getPlayer().getStats().fallbackReason || '',
        nativeRestrictions: engine.getPlayer().config.abr.restrictions,
      });

      await engine.destroy();
    }
    return results;
  });

  for (const item of state) {
    expect(item.nativeRestrictions).toEqual({});
    expect(item.nativeProvider).toBe('native-dash');
    expect(item.nativeFallbackReason).toBe('');
    expect(item.nativeHeight).toBe(360);
  }
});

test('native DASH startup honors explicit minimum height before viewport fallback', async ({ page }) => {
  const shakaRequests = [];
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.abort();
  });

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
  expect(shakaRequests).toHaveLength(0);
});

test('native DASH applies bandwidth restrictions and exposes restricted tracks', async ({ page }) => {
  const shakaRequests = [];
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.abort();
  });

  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player" style="width:1280px;height:720px"></video>');

  const state = await page.evaluate(() => {
    const video = document.getElementById('player');
    const engine = new window.PlayerEngine(video, { videoId: 'TESTVIDEO01', streamToken: 'test-token' });
    const player = engine.getPlayer();
    player.configure({
      abr: {
        useNetworkInformation: false,
        defaultBandwidthEstimate: 5_000_000,
        restrictions: { minBandwidth: 700_000, maxBandwidth: 1_000_000 },
      },
      streaming: { retryParameters: { maxAttempts: 5, baseDelay: 10, backoffFactor: 3 } },
    });
    const provider = {
      engine,
      video,
      name: 'native-dash',
      manifestUrl: '/manifest.mpd',
      blacklisted: {},
      manualTrackId: null,
      bandwidth: 5_000_000,
      bandwidthSamples: 0,
      activeRanges: {},
      videoSb: null,
      audioSb: null,
      audioReps: [],
      textReps: [],
      activeVideo: null,
      videoReps: [
        { id: '240', height: 240, width: 426, bandwidth: 350_000, codecs: 'avc1.42c01f' },
        { id: '360', height: 360, width: 640, bandwidth: 800_000, codecs: 'avc1.42c01f' },
        { id: '720', height: 720, width: 1280, bandwidth: 1_800_000, codecs: 'avc1.42c01f' },
      ],
      _viewportMaxHeight: window.NativeDashProviderForTest._viewportMaxHeight,
      _candidateVideos: window.NativeDashProviderForTest._candidateVideos,
      _chooseForBudget: window.NativeDashProviderForTest._chooseForBudget,
      chooseVideoRep: window.NativeDashProviderForTest.chooseVideoRep,
      getVariantTracks: window.NativeDashProviderForTest.getVariantTracks,
      getActiveVariantTrack: window.NativeDashProviderForTest.getActiveVariantTrack,
      getTextTracks: window.NativeDashProviderForTest.getTextTracks,
      getStats: window.NativeDashProviderForTest.getStats,
    };
    provider.activeVideo = provider.chooseVideoRep();
    engine._provider = provider;
    return {
      chosen: provider.activeVideo,
      tracks: provider.getVariantTracks(),
      stats: provider.getStats(),
    };
  });

  expect(state.chosen.id).toBe('360');
  expect(state.tracks.find(track => track.id === '240')).toMatchObject({ restricted: true, selectable: false, supported: true });
  expect(state.tracks.find(track => track.id === '360')).toMatchObject({ restricted: false, selectable: true, active: true });
  expect(state.tracks.find(track => track.id === '720')).toMatchObject({ restricted: true, selectable: false, supported: true });
  expect(state.stats.abrEnabled).toBe(true);
  expect(state.stats.provider).toBe('native-dash');
  expect(state.stats.fallbackReason).toBe('');
  expect(state.stats.restrictedVariantCount).toBe(2);
  expect(state.stats.activeRestrictions).toMatchObject({ minBandwidth: 700_000, maxBandwidth: 1_000_000 });
  expect(state.stats.effectiveRetryMaxAttempts).toBe(5);
  expect(state.stats.effectiveRetryBaseDelay).toBe(10);
  expect(shakaRequests).toHaveLength(0);
});

test('native ABR uses viewport cap and measured bandwidth', async ({ page }) => {
  const shakaRequests = [];
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.abort();
  });

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
  expect(shakaRequests).toHaveLength(0);
});

test('native ABR upgrades and downgrades with buffer-aware cooldown', async ({ page }) => {
  const shakaRequests = [];
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.abort();
  });

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
  expect(shakaRequests).toHaveLength(0);
});

test('native capability probing filters non-smooth variants and records counts', async ({ page }) => {
  const shakaRequests = [];
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.abort();
  });

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
  expect(shakaRequests).toHaveLength(0);
});

test('native startup prefers smooth efficient codec family over non-smooth AV1', async ({ page }) => {
  const shakaRequests = [];
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.abort();
  });

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
  expect(shakaRequests).toHaveLength(0);
});

test('native ABR stays within codec family when possible and exposes capability metadata', async ({ page }) => {
  const shakaRequests = [];
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.abort();
  });

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
  expect(shakaRequests).toHaveLength(0);
});

test('manual native quality selection disables ABR and updates active track', async ({ page }) => {
  const shakaRequests = [];
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.abort();
  });

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
  expect(shakaRequests).toHaveLength(0);
});

test('native stats expose active quality and playback health', async ({ page }) => {
  const shakaRequests = [];
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.abort();
  });

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
  expect(stats.fallbackReason).toBe('');
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
  expect(shakaRequests).toHaveLength(0);
});

test('native buffer scheduler prioritizes the current playback window', async ({ page }) => {
  const shakaRequests = [];
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.abort();
  });

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
  expect(shakaRequests).toHaveLength(0);
});

test('native buffer scheduler closes VOD after the terminal DASH and HLS segments', async ({ page }) => {
  await setPlayerContent(page, '<video id="player"></video>');

  const state = await page.evaluate(() => {
    function mediaSourceState() {
      return {
        readyState: 'open',
        ended: 0,
        endOfStream() { this.ended++; this.readyState = 'ended'; },
      };
    }
    const dashMediaSource = mediaSourceState();
    const dash = {
      live: false,
      duration: 6,
      mediaSource: dashMediaSource,
      videoSb: { updating: false },
      audioSb: { updating: false },
      activeVideo: {
        segments: [
          { start: 0, end: 2, state: 'pending', appended: false },
          { start: 2, end: 4, state: 'pending', appended: false },
          { start: 4, end: 6, state: 'appended', appended: true },
        ],
      },
      audio: {
        segments: [
          { start: 0, end: 2, state: 'pending', appended: false },
          { start: 2, end: 4, state: 'pending', appended: false },
          { start: 4, end: 6, state: 'appended', appended: true },
        ],
      },
      vodEndOfStreamCount: 0,
    };
    const dashClosed = window.NativeDashProviderForTest._maybeEndVodStream.call(dash);

    const hlsMediaSource = mediaSourceState();
    const hls = {
      live: false,
      duration: 6,
      mediaSource: hlsMediaSource,
      sb: { updating: false },
      audioSb: null,
      segments: [
        { start: 0, end: 2, state: 'pending', appended: false },
        { start: 2, end: 4, state: 'pending', appended: false },
        { start: 4, end: 6, state: 'appended', appended: true },
      ],
      activeAudio: null,
      audioSegments: [],
      vodEndOfStreamCount: 0,
    };
    const hlsClosed = window.NativeHlsProviderForTest._maybeEndVodStream.call(hls);

    return {
      dashClosed,
      dashEnded: dashMediaSource.ended,
      dashCount: dash.vodEndOfStreamCount,
      hlsClosed,
      hlsEnded: hlsMediaSource.ended,
      hlsCount: hls.vodEndOfStreamCount,
    };
  });

  expect(state).toEqual({
    dashClosed: true,
    dashEnded: 1,
    dashCount: 1,
    hlsClosed: true,
    hlsEnded: 1,
    hlsCount: 1,
  });
});

test('watch page renders centralized autoplay retry and end buffering cleanup', () => {
  const player = readFileSync('views/player.ejs', 'utf8');
  const controls = readFileSync('views/player/controls-setup.ejs', 'utf8');

  expect(player).toContain("var blocked = err && err.name === 'NotAllowedError';");
  expect(player).not.toContain("err.name === 'NotAllowedError' || err.name === 'AbortError'");
  expect(player).toContain('autoplayRetryTimer = setPlayerTimeout(retry, 250);');
  expect(player).toContain("video.addEventListener('ended', function () {");
  expect(player).toContain("container.classList.remove('player-buffering');");
  expect(controls).toContain("localStorage.getItem('player-muted-v2')");
  expect(controls).toContain("if (!autoplayPolicyMuted) localStorage.setItem('player-muted-v2'");
});

test('service-worker segment cache keeps the current player runtime ahead of cached JavaScript', () => {
  const worker = readFileSync('public/sw.js', 'utf8');
  const route = readFileSync('routes/player.ts', 'utf8');
  const head = readFileSync('views/partials/head.ejs', 'utf8');

  expect(worker).toContain("var STATIC_CACHE = 'my-youtube-static-v12';");
  expect(worker).toContain("var NETWORK_FIRST_STATIC = [\n  '/idb-helpers.js',\n  '/app.js',\n  '/native-player-engine.js'\n];");
  expect(worker).toContain('if (NETWORK_FIRST_STATIC.indexOf(url.pathname) !== -1)');
  expect(route).toContain('/native-player-engine.js?v=12');
  expect(head).toContain('/native-player-engine.js?v=12');
});

test('service-worker segment cache leaves the first streamed Today page intact during install', () => {
  const head = readFileSync('views/partials/head.ejs', 'utf8');
  const shell = readFileSync('views/partials/shell-start.ejs', 'utf8');
  const today = readFileSync('views/today.ejs', 'utf8');
  const route = readFileSync('routes/today.ts', 'utf8');

  expect(head).toContain('var hadServiceWorkerController=!!navigator.serviceWorker.controller');
  expect(head).toContain('if(hadServiceWorkerController)window.location.reload()');
  expect(shell).toContain('id="today-loading"');
  expect(shell).toContain('Checking your subscriptions for new videos');
  expect(today).toContain("document.getElementById('today-loading')");
  expect(route).toContain("showTodayLoading: true");
});

test('native buffer milestones emit startup and seek readiness telemetry', async ({ page }) => {
  const shakaRequests = [];
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.abort();
  });

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
  expect(shakaRequests).toHaveLength(0);
});

test('native streaming config controls buffer targets and rebuffer readiness', async ({ page }) => {
  const shakaRequests = [];
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.abort();
  });

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
  expect(state.seekBufferPending).toBe(true);
  expect(state.seekBufferReadyCount).toBe(0);
  expect(state.events).toEqual([]);
  expect(shakaRequests).toHaveLength(0);
});

test('native streaming bufferingGoal limits scheduled segment candidates', async ({ page }) => {
  const shakaRequests = [];
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.abort();
  });

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
  expect(shakaRequests).toHaveLength(0);
});

test('native streaming bufferBehind controls trimming and can disable it', async ({ page }) => {
  const shakaRequests = [];
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.abort();
  });

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
  expect(shakaRequests).toHaveLength(0);
});

test('native manifest availabilityWindowOverride narrows exposed live range only', async ({ page }) => {
  const shakaRequests = [];
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.abort();
  });

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
  expect(state.stats.fallbackReason || '').toBe('');
  expect(shakaRequests).toHaveLength(0);
});

test('native request cancellation aborts in-flight scheduler work and records telemetry', async ({ page }) => {
  const shakaRequests = [];
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.abort();
  });

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
  expect(shakaRequests).toHaveLength(0);
});

test('native media scheduler respects max concurrent request limit', async ({ page }) => {
  const shakaRequests = [];
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.abort();
  });

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
  expect(shakaRequests).toHaveLength(0);
});

test('native media scheduler appends fetched segments in timeline order', async ({ page }) => {
  const shakaRequests = [];
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.abort();
  });

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
  expect(shakaRequests).toHaveLength(0);
});

test('native networking holds transient server errors and resumes the same request', async ({ page }) => {
  let segmentAttempts = 0;
  let probeAttempts = 0;
  const events = [];
  const shakaRequests = [];

  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.abort();
  });
  await page.route('**/network-hold-segment.m4s', route => {
    segmentAttempts++;
    route.fulfill({
      status: segmentAttempts === 1 ? 500 : 200,
      contentType: 'application/octet-stream',
      body: segmentAttempts === 1 ? 'server down' : 'ok',
    });
  });
  await page.route('**/api/stream/HOLDTEST/dash.mpd**', route => {
    probeAttempts++;
    route.fulfill({ status: 200, contentType: 'application/dash+xml', body: '' });
  });
  await page.route('**/api/player-events', route => route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }));

  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const state = await page.evaluate(async () => {
    const video = document.getElementById('player');
    const engine = new window.PlayerEngine(video, { videoId: 'HOLDTEST', streamToken: 'test-token' });
    await engine.init();
    engine._setState('ready');
    engine.on('server-down', reason => window.__events.push({ type: 'server-down', reason }));
    engine.on('server-up', () => window.__events.push({ type: 'server-up' }));
    window.__events = [];
    const networking = engine.getPlayer().getNetworkingEngine();
    const response = await networking.request(networking.RequestType.SEGMENT, { uris: ['/network-hold-segment.m4s'] }, { forceNetworkHold: true });
    return {
      status: response.status,
      body: new TextDecoder().decode(response.data),
      recovering: engine.isRecovering(),
      events: window.__events,
      stats: engine.getPlayer().getStats(),
    };
  });

  expect(segmentAttempts).toBe(2);
  expect(probeAttempts).toBeGreaterThan(0);
  expect(state.status).toBe(200);
  expect(state.body).toBe('ok');
  expect(state.recovering).toBe(false);
  expect(state.events).toEqual([{ type: 'server-down', reason: 'server-error' }, { type: 'server-up' }]);
  expect(state.stats.networkHoldCount).toBe(1);
  expect(state.stats.networkResumeCount).toBe(1);
  expect(state.stats.networkHeldRequestCount).toBe(0);
  expect(state.stats.networkHoldReason).toBe('server-error');
  expect(state.stats.lastNetworkingStatus).toBe(200);
  expect(state.stats.fallbackReason || '').toBe('');
  expect(shakaRequests).toHaveLength(0);
});

test('native networking refreshes token before resuming held 401 requests', async ({ page }) => {
  let segmentAttempts = 0;
  let tokenRequests = 0;
  const shakaRequests = [];

  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.abort();
  });
  await page.route('**/token-hold-segment.m4s', route => {
    segmentAttempts++;
    route.fulfill({
      status: segmentAttempts === 1 ? 401 : 200,
      contentType: 'application/octet-stream',
      body: segmentAttempts === 1 ? 'expired' : 'ok',
    });
  });
  await page.route('**/watch/token**', route => {
    tokenRequests++;
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"token":"fresh-token"}' });
  });
  await page.route('**/api/stream/TOKENHOLD/dash.mpd**', route => {
    route.fulfill({ status: 200, contentType: 'application/dash+xml', body: '' });
  });
  await page.route('**/api/player-events', route => route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }));

  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const state = await page.evaluate(async () => {
    const video = document.getElementById('player');
    const engine = new window.PlayerEngine(video, { videoId: 'TOKENHOLD', streamToken: 'old-token' });
    const tokenEvents = [];
    engine.on('token-refreshed', token => tokenEvents.push(token));
    await engine.init();
    engine._setState('ready');
    const networking = engine.getPlayer().getNetworkingEngine();
    const response = await networking.request(networking.RequestType.SEGMENT, { uris: ['/token-hold-segment.m4s'] }, { forceNetworkHold: true });
    return {
      status: response.status,
      body: new TextDecoder().decode(response.data),
      streamToken: engine.streamToken,
      manifestUrl: engine.manifestUrl,
      tokenEvents,
      stats: engine.getPlayer().getStats(),
    };
  });

  expect(segmentAttempts).toBe(2);
  expect(tokenRequests).toBe(1);
  expect(state.status).toBe(200);
  expect(state.body).toBe('ok');
  expect(state.streamToken).toBe('fresh-token');
  expect(state.manifestUrl).toContain('token=fresh-token');
  expect(state.tokenEvents).toEqual(['fresh-token']);
  expect(state.stats.networkHoldCount).toBe(1);
  expect(state.stats.networkResumeCount).toBe(1);
  expect(state.stats.networkHoldReason).toBe('token-expired');
  expect(state.stats.fallbackReason || '').toBe('');
  expect(shakaRequests).toHaveLength(0);
});

test('native networking does not hold permanent media statuses', async ({ page }) => {
  let segmentAttempts = 0;
  const shakaRequests = [];
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.abort();
  });
  await page.route('**/network-permanent-404.m4s', route => {
    segmentAttempts++;
    route.fulfill({ status: 404, contentType: 'text/plain', body: 'missing' });
  });

  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const state = await page.evaluate(async () => {
    const video = document.getElementById('player');
    const engine = new window.PlayerEngine(video, { videoId: 'PERMTEST', streamToken: 'test-token' });
    await engine.init();
    engine._setState('ready');
    const networking = engine.getPlayer().getNetworkingEngine();
    const response = await networking.request(networking.RequestType.SEGMENT, { uris: ['/network-permanent-404.m4s'] }, { forceNetworkHold: true });
    return {
      status: response.status,
      body: new TextDecoder().decode(response.data),
      stats: engine.getPlayer().getStats(),
    };
  });

  expect(segmentAttempts).toBe(1);
  expect(state.status).toBe(404);
  expect(state.body).toBe('missing');
  expect(state.stats.networkHoldCount).toBe(0);
  expect(state.stats.networkResumeCount).toBe(0);
  expect(state.stats.fallbackReason || '').toBe('');
  expect(shakaRequests).toHaveLength(0);
});

test('native telemetry posts first-party playback events only', async ({ page }) => {
  const batches = [];
  const shakaRequests = [];
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.abort();
  });
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
  expect(shakaRequests).toHaveLength(0);
});

test('native DASH quota pressure trims and retries append before fallback', async ({ page }) => {
  const shakaRequests = [];
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.abort();
  });

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
  expect(shakaRequests).toHaveLength(0);
});

test('native DASH stall recovery force-fills before downgrading', async ({ page }) => {
  const shakaRequests = [];
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.abort();
  });

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
    stage: 3,
    switchedTo: '360',
    switchReason: 'stall-recovery',
    clearBuffer: true,
    blacklisted720: true,
  });
  expect(shakaRequests).toHaveLength(0);
});

test('native DASH append failure rebuilds native buffers before fallback', async ({ page }) => {
  const shakaRequests = [];
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.abort();
  });

  await page.goto('/auth/login');
  await page.setContent('<video id="player"></video>');
  await page.addScriptTag({ path: 'public/native-player-engine.js' });

  const state = await page.evaluate(() => {
    function makeSourceBuffer() {
      const listeners = {};
      let appendCalls = 0;
      let removeCalls = 0;
      return {
        get appendCalls() { return appendCalls; },
        get removeCalls() { return removeCalls; },
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
        changeType() {},
      };
    }

    const video = document.getElementById('player');
    Object.defineProperty(video, 'currentTime', { configurable: true, get() { return 10; } });
    const engine = new window.PlayerEngine(video, { videoId: 'TESTVIDEO01', streamToken: 'test-token' });
    engine._telemetry.record = function () {};
    const activeVideo = { id: '720', kind: 'video', mimeType: 'video/mp4', codecs: 'avc1.42c01f', initData: new ArrayBuffer(2), segments: [{ start: 9, end: 11, state: 'failed' }] };
    const audio = { id: 'a64', kind: 'audio', mimeType: 'audio/mp4', codecs: 'mp4a.40.2', initData: new ArrayBuffer(1), segments: [{ start: 9, end: 11, state: 'failed' }] };
    const provider = {
      engine,
      video,
      videoSb: makeSourceBuffer(),
      audioSb: makeSourceBuffer(),
      videoMime: 'video/mp4; codecs="avc1.42c01f"',
      audioMime: 'audio/mp4; codecs="mp4a.40.2"',
      activeVideo,
      audio,
      appendFailures: 0,
      recoveryCount: 0,
      nativeRecoveryAttemptCount: 0,
      nativeRecoverySuccessCount: 0,
      nativeRecoveryReasons: {},
      activeRanges: {},
      controllers: [],
      requestGeneration: 0,
      requestCancellationCount: 0,
      lastError: '',
      blacklisted: {},
      _bufferAheadGoal() { return 30; },
      _tick(force) { this.ticked = force; },
      _abortRequests: window.NativeDashProviderForTest._abortRequests,
      _changeVideoTypeIfNeeded: window.NativeDashProviderForTest._changeVideoTypeIfNeeded,
      _changeAudioTypeIfNeeded: window.NativeDashProviderForTest._changeAudioTypeIfNeeded,
      _tryNativeRecovery: window.NativeDashProviderForTest._tryNativeRecovery,
      _recordRangeError(err) { this.lastError = err.message; },
    };
    window.NativeDashProviderForTest._handleAppendFailure.call(provider, { kind: 'video', id: '720' }, new Error('append failed'));
    return new Promise(resolve => setTimeout(() => resolve({
      attempts: provider.nativeRecoveryAttemptCount,
      successes: provider.nativeRecoverySuccessCount,
      reason: provider.lastNativeRecoveryReason,
      videoState: activeVideo.segments[0].state,
      audioState: audio.segments[0].state,
      videoRemoveCalls: provider.videoSb.removeCalls,
      audioRemoveCalls: provider.audioSb.removeCalls,
      videoAppendCalls: provider.videoSb.appendCalls,
      audioAppendCalls: provider.audioSb.appendCalls,
      ticked: provider.ticked === true,
    }), 30));
  });

  expect(state).toMatchObject({
    attempts: 1,
    successes: 1,
    reason: 'native-video-append',
    videoState: 'pending',
    audioState: 'pending',
    videoRemoveCalls: 1,
    audioRemoveCalls: 1,
    videoAppendCalls: 1,
    audioAppendCalls: 1,
    ticked: true,
  });
  expect(shakaRequests).toHaveLength(0);
});

test('native DASH video append exhaustion stays native with explicit terminal reason', async ({ page }) => {
  await page.goto('/auth/login');
  await page.setContent('<video id="player"></video>');
  await page.addScriptTag({ path: 'public/native-player-engine.js' });

  const state = await page.evaluate(() => {
    function makeProvider(engine, video) {
      return {
        name: 'native-dash',
        engine,
        video,
        manifestUrl: '/manifest.mpd',
        appendFailures: 0,
        rebufferDuration: 0,
        activeRanges: {},
        blacklisted: {},
        videoReps: [{ id: '720', kind: 'video', height: 720 }],
        audioReps: [],
        textReps: [],
        activeVideo: { id: '720', kind: 'video', height: 720 },
        audio: null,
        lastError: '',
        _recordRangeError(err) { this.lastError = err.message; },
        _completeNativeRuntimeTerminal: window.NativeDashProviderForTest._completeNativeRuntimeTerminal,
        _switchVideo() {},
        chooseVideoRep() { throw new Error('no-video-rep'); },
        getActiveVariantTrack() { return null; },
        isLive() { return false; },
        getStats: window.NativeDashProviderForTest.getStats,
      };
    }

    const video = document.getElementById('player');
    const engine = new window.PlayerEngine(video, { videoId: 'TESTVIDEO01', streamToken: 'test-token' });
    engine._providerName = 'native-dash';
    const provider = makeProvider(engine, video);
    engine._provider = provider;
    window.NativeDashProviderForTest._handleAppendFailure.call(provider, { kind: 'video', id: '720' }, new Error('append failed'));
    return {
      stats: provider.getStats(),
      appendFailures: provider.appendFailures,
      lastError: provider.lastError,
      fatalError: provider.fatalError,
      nativeUnsupportedReason: provider.nativeUnsupportedReason,
      blacklisted720: provider.blacklisted['720'] === true,
    };
  });

  expect(state.appendFailures).toBe(1);
  expect(state.lastError).toBe('native-video-append-exhausted');
  expect(state.fatalError).toBe('native-video-append-exhausted');
  expect(state.nativeUnsupportedReason).toBe('native-video-append-exhausted');
  expect(state.blacklisted720).toBe(true);
  expect(state.stats.provider).toBe('native-dash');
  expect(state.stats.fallbackReason).toBe('');
  expect(state.stats.lastError).toBe('native-video-append-exhausted');
  expect(state.stats.fatalError).toBe('native-video-append-exhausted');
  expect(state.stats.nativeUnsupportedReason).toBe('native-video-append-exhausted');
});

test('native DASH audio append exhaustion stays native with explicit terminal reason', async ({ page }) => {
  await page.goto('/auth/login');
  await page.setContent('<video id="player"></video>');
  await page.addScriptTag({ path: 'public/native-player-engine.js' });

  const state = await page.evaluate(() => {
    const video = document.getElementById('player');
    const engine = new window.PlayerEngine(video, { videoId: 'TESTVIDEO01', streamToken: 'test-token' });
    engine._providerName = 'native-dash';
    const provider = {
      name: 'native-dash',
      engine,
      video,
      manifestUrl: '/manifest.mpd',
      appendFailures: 1,
      rebufferDuration: 0,
      activeRanges: {},
      blacklisted: {},
      videoReps: [],
      audioReps: [{ id: 'a64', kind: 'audio' }],
      textReps: [],
      activeVideo: null,
      audio: { id: 'a64', kind: 'audio' },
      lastError: '',
      _recordRangeError(err) { this.lastError = err.message; },
      _completeNativeRuntimeTerminal: window.NativeDashProviderForTest._completeNativeRuntimeTerminal,
      getActiveVariantTrack() { return null; },
      isLive() { return false; },
      getStats: window.NativeDashProviderForTest.getStats,
    };
    engine._provider = provider;
    window.NativeDashProviderForTest._handleAppendFailure.call(provider, { kind: 'audio', id: 'a64' }, new Error('append failed'));
    return {
      stats: provider.getStats(),
      appendFailures: provider.appendFailures,
      lastError: provider.lastError,
      fatalError: provider.fatalError,
      nativeUnsupportedReason: provider.nativeUnsupportedReason,
    };
  });

  expect(state.appendFailures).toBe(2);
  expect(state.lastError).toBe('native-audio-append-failed');
  expect(state.fatalError).toBe('native-audio-append-failed');
  expect(state.nativeUnsupportedReason).toBe('native-audio-append-failed');
  expect(state.stats.provider).toBe('native-dash');
  expect(state.stats.fallbackReason).toBe('');
  expect(state.stats.lastError).toBe('native-audio-append-failed');
  expect(state.stats.fatalError).toBe('native-audio-append-failed');
  expect(state.stats.nativeUnsupportedReason).toBe('native-audio-append-failed');
});

test('native DASH stall exhaustion stays native with explicit terminal reason', async ({ page }) => {
  await page.goto('/auth/login');
  await page.setContent('<video id="player"></video>');
  await page.addScriptTag({ path: 'public/native-player-engine.js' });

  const state = await page.evaluate(() => {
    const video = document.getElementById('player');
    Object.defineProperty(video, 'buffered', {
      configurable: true,
      get() {
        return { length: 0, start() { return 0; }, end() { return 0; } };
      },
    });
    const engine = new window.PlayerEngine(video, { videoId: 'TESTVIDEO01', streamToken: 'test-token' });
    engine._providerName = 'native-dash';
    const provider = {
      name: 'native-dash',
      engine,
      video,
      manifestUrl: '/manifest.mpd',
      stallReports: 2,
      stallRecoveryStage: 3,
      appendFailures: 0,
      rebufferDuration: 0,
      gapJumpCount: 0,
      lastGapSize: 0,
      activeRanges: {},
      blacklisted: {},
      videoReps: [{ id: '720', kind: 'video', height: 720 }],
      audioReps: [],
      textReps: [],
      activeVideo: { id: '720', kind: 'video', height: 720 },
      audio: null,
      lastError: '',
      _tick(force) { this.ticked = force; },
      _bufferAheadGoal() { return 30; },
      _jumpSmallGap: window.NativeDashProviderForTest._jumpSmallGap,
      _completeNativeRuntimeTerminal: window.NativeDashProviderForTest._completeNativeRuntimeTerminal,
      getActiveVariantTrack() { return null; },
      isLive() { return false; },
      getStats: window.NativeDashProviderForTest.getStats,
    };
    engine._provider = provider;
    window.NativeDashProviderForTest.reportStall.call(provider);
    return {
      stats: provider.getStats(),
      stallReports: provider.stallReports,
      lastError: provider.lastError,
      fatalError: provider.fatalError,
      nativeUnsupportedReason: provider.nativeUnsupportedReason,
      ticked: provider.ticked === true,
    };
  });

  expect(state.stallReports).toBe(3);
  expect(state.lastError).toBe('native-stall-exhausted');
  expect(state.fatalError).toBe('native-stall-exhausted');
  expect(state.nativeUnsupportedReason).toBe('native-stall-exhausted');
  expect(state.ticked).toBe(true);
  expect(state.stats.provider).toBe('native-dash');
  expect(state.stats.fallbackReason).toBe('');
  expect(state.stats.lastError).toBe('native-stall-exhausted');
  expect(state.stats.fatalError).toBe('native-stall-exhausted');
  expect(state.stats.nativeUnsupportedReason).toBe('native-stall-exhausted');
});

test('native HLS quota pressure trims and retries append before fallback', async ({ page }) => {
  const shakaRequests = [];
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.abort();
  });

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
  expect(shakaRequests).toHaveLength(0);
});

test('native HLS stall recovery force-fills before downgrading', async ({ page }) => {
  const shakaRequests = [];
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.abort();
  });

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
    stage: 3,
    switchedTo: '360',
    switchReason: 'stall-recovery',
    clearBuffer: true,
    blacklisted720: true,
  });
  expect(shakaRequests).toHaveLength(0);
});

test('native HLS append failure rebuilds native buffers before fallback', async ({ page }) => {
  const shakaRequests = [];
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.abort();
  });

  await page.goto('/auth/login');
  await page.setContent('<video id="player"></video>');
  await page.addScriptTag({ path: 'public/native-player-engine.js' });

  const state = await page.evaluate(() => {
    function makeSourceBuffer() {
      const listeners = {};
      let appendCalls = 0;
      let removeCalls = 0;
      return {
        get appendCalls() { return appendCalls; },
        get removeCalls() { return removeCalls; },
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
      };
    }

    const video = document.getElementById('player');
    Object.defineProperty(video, 'currentTime', { configurable: true, get() { return 10; } });
    const engine = new window.PlayerEngine(video, { videoId: 'TESTVIDEO01', streamToken: 'test-token' });
    engine._telemetry.record = function () {};
    const provider = {
      engine,
      video,
      sb: makeSourceBuffer(),
      audioSb: makeSourceBuffer(),
      initSegment: { url: '/video-init', range: null },
      audioInitSegment: { url: '/audio-init', range: null },
      segments: [{ start: 9, end: 11, state: 'failed' }],
      activeAudio: { id: 'a64', segments: [{ start: 9, end: 11, state: 'failed' }] },
      appendFailures: 0,
      recoveryCount: 0,
      nativeRecoveryAttemptCount: 0,
      nativeRecoverySuccessCount: 0,
      nativeRecoveryReasons: {},
      activeRanges: {},
      controllers: [],
      lastError: '',
      blacklisted: {},
      _bufferAheadGoal() { return 30; },
      _tick(force) { this.ticked = force; },
      _fetchRange(url) { return Promise.resolve(url === '/video-init' ? new ArrayBuffer(2) : new ArrayBuffer(1)); },
      _tryNativeRecovery: window.NativeHlsProviderForTest._tryNativeRecovery,
    };
    window.NativeHlsProviderForTest._handleAppendFailure.call(provider, { kind: 'video', id: 'video', sb: provider.sb }, new Error('append failed'));
    return new Promise(resolve => setTimeout(() => resolve({
      attempts: provider.nativeRecoveryAttemptCount,
      successes: provider.nativeRecoverySuccessCount,
      reason: provider.lastNativeRecoveryReason,
      videoState: provider.segments[0].state,
      audioState: provider.activeAudio.segments[0].state,
      videoRemoveCalls: provider.sb.removeCalls,
      audioRemoveCalls: provider.audioSb.removeCalls,
      videoAppendCalls: provider.sb.appendCalls,
      audioAppendCalls: provider.audioSb.appendCalls,
      ticked: provider.ticked === true,
    }), 30));
  });

  expect(state).toMatchObject({
    attempts: 1,
    successes: 1,
    reason: 'hls-video-append',
    videoState: 'pending',
    audioState: 'pending',
    videoRemoveCalls: 1,
    audioRemoveCalls: 1,
    videoAppendCalls: 1,
    audioAppendCalls: 1,
    ticked: true,
  });
  expect(shakaRequests).toHaveLength(0);
});

test('native HLS jumps small gaps and leaves large gaps alone', async ({ page }) => {
  const shakaRequests = [];
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.abort();
  });

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
  expect(shakaRequests).toHaveLength(0);
});

test('native HLS append recovery stays native with explicit video terminal reason', async ({ page }) => {
  await page.goto('/auth/login');
  await page.setContent('<video id="player"></video>');
  await page.addScriptTag({ path: 'public/native-player-engine.js' });

  const state = await page.evaluate(() => {
    const video = document.getElementById('player');
    const engine = new window.PlayerEngine(video, { videoId: 'TESTVIDEO01', streamToken: 'test-token' });
    engine._providerName = 'native-hls';
    const provider = {
      name: 'native-hls',
      engine,
      video,
      playlistUrl: '/master.m3u8',
      appendFailures: 0,
      rebufferDuration: 0,
      lastError: '',
      blacklisted: {},
      audioRenditions: [],
      subtitleRenditions: [],
      variants: [{ id: '720', height: 720 }],
      activeVariant: { id: '720', height: 720 },
      _lowerVariant: window.NativeHlsProviderForTest._lowerVariant,
      _bufferAheadGoal() { return 30; },
      _bufferBehindGoal() { return 30; },
      _completeNativeRuntimeTerminal: window.NativeHlsProviderForTest._completeNativeRuntimeTerminal,
      getActiveVariantTrack() { return null; },
      getActiveAudioTrack() { return null; },
      getAudioTracks() { return []; },
      getLiveRange() { return { start: 0, end: 0 }; },
      isLive() { return false; },
      getStats: window.NativeHlsProviderForTest.getStats,
    };
    engine._provider = provider;
    window.NativeHlsProviderForTest._handleAppendFailure.call(provider, { kind: 'video', id: 'video' }, new Error('append failed'));
    return {
      stats: provider.getStats(),
      appendFailures: provider.appendFailures,
      lastError: provider.lastError,
      fatalError: provider.fatalError,
      nativeUnsupportedReason: provider.nativeUnsupportedReason,
      blacklisted720: provider.blacklisted['720'] === true,
    };
  });

  expect(state.appendFailures).toBe(1);
  expect(state.lastError).toBe('hls-video-append-exhausted');
  expect(state.fatalError).toBe('hls-video-append-exhausted');
  expect(state.nativeUnsupportedReason).toBe('hls-video-append-exhausted');
  expect(state.blacklisted720).toBe(true);
  expect(state.stats.provider).toBe('native-hls');
  expect(state.stats.fallbackReason).toBe('');
  expect(state.stats.lastError).toBe('hls-video-append-exhausted');
  expect(state.stats.fatalError).toBe('hls-video-append-exhausted');
  expect(state.stats.nativeUnsupportedReason).toBe('hls-video-append-exhausted');
});

test('native HLS audio append exhaustion stays native with explicit terminal reason', async ({ page }) => {
  await page.goto('/auth/login');
  await page.setContent('<video id="player"></video>');
  await page.addScriptTag({ path: 'public/native-player-engine.js' });

  const state = await page.evaluate(() => {
    const video = document.getElementById('player');
    const engine = new window.PlayerEngine(video, { videoId: 'TESTVIDEO01', streamToken: 'test-token' });
    engine._providerName = 'native-hls';
    const provider = {
      name: 'native-hls',
      engine,
      video,
      playlistUrl: '/master.m3u8',
      appendFailures: 1,
      rebufferDuration: 0,
      lastError: '',
      blacklisted: {},
      variants: [],
      audioRenditions: [],
      subtitleRenditions: [],
      _bufferAheadGoal() { return 30; },
      _bufferBehindGoal() { return 30; },
      _completeNativeRuntimeTerminal: window.NativeHlsProviderForTest._completeNativeRuntimeTerminal,
      getActiveVariantTrack() { return null; },
      getActiveAudioTrack() { return null; },
      getAudioTracks() { return []; },
      getLiveRange() { return { start: 0, end: 0 }; },
      isLive() { return false; },
      getStats: window.NativeHlsProviderForTest.getStats,
    };
    engine._provider = provider;
    window.NativeHlsProviderForTest._handleAppendFailure.call(provider, { kind: 'audio', id: 'audio' }, new Error('append failed'));
    return {
      stats: provider.getStats(),
      appendFailures: provider.appendFailures,
      lastError: provider.lastError,
      fatalError: provider.fatalError,
      nativeUnsupportedReason: provider.nativeUnsupportedReason,
    };
  });

  expect(state.appendFailures).toBe(2);
  expect(state.lastError).toBe('hls-audio-append-failed');
  expect(state.fatalError).toBe('hls-audio-append-failed');
  expect(state.nativeUnsupportedReason).toBe('hls-audio-append-failed');
  expect(state.stats.provider).toBe('native-hls');
  expect(state.stats.fallbackReason).toBe('');
  expect(state.stats.lastError).toBe('hls-audio-append-failed');
  expect(state.stats.fatalError).toBe('hls-audio-append-failed');
  expect(state.stats.nativeUnsupportedReason).toBe('hls-audio-append-failed');
});

test('native HLS stall exhaustion stays native with explicit terminal reason', async ({ page }) => {
  await page.goto('/auth/login');
  await page.setContent('<video id="player"></video>');
  await page.addScriptTag({ path: 'public/native-player-engine.js' });

  const state = await page.evaluate(() => {
    const video = document.getElementById('player');
    Object.defineProperty(video, 'buffered', {
      configurable: true,
      get() {
        return { length: 0, start() { return 0; }, end() { return 0; } };
      },
    });
    const engine = new window.PlayerEngine(video, { videoId: 'TESTVIDEO01', streamToken: 'test-token' });
    engine._providerName = 'native-hls';
    const provider = {
      name: 'native-hls',
      engine,
      video,
      playlistUrl: '/master.m3u8',
      stallReports: 2,
      stallRecoveryStage: 3,
      appendFailures: 0,
      rebufferDuration: 0,
      gapJumpCount: 0,
      lastGapSize: 0,
      lastError: '',
      blacklisted: {},
      activeVariant: { id: '720', height: 720 },
      variants: [{ id: '720', height: 720 }],
      audioRenditions: [],
      subtitleRenditions: [],
      _tick(force) { this.ticked = force; },
      _jumpSmallGap: window.NativeHlsProviderForTest._jumpSmallGap,
      _bufferAheadGoal() { return 30; },
      _bufferBehindGoal() { return 30; },
      _completeNativeRuntimeTerminal: window.NativeHlsProviderForTest._completeNativeRuntimeTerminal,
      getActiveVariantTrack() { return null; },
      getActiveAudioTrack() { return null; },
      getAudioTracks() { return []; },
      getLiveRange() { return { start: 0, end: 0 }; },
      isLive() { return false; },
      getStats: window.NativeHlsProviderForTest.getStats,
    };
    engine._provider = provider;
    window.NativeHlsProviderForTest.reportStall.call(provider);
    return {
      stats: provider.getStats(),
      stallReports: provider.stallReports,
      lastError: provider.lastError,
      fatalError: provider.fatalError,
      nativeUnsupportedReason: provider.nativeUnsupportedReason,
      ticked: provider.ticked === true,
    };
  });

  expect(state.stallReports).toBe(3);
  expect(state.lastError).toBe('hls-stall-exhausted');
  expect(state.fatalError).toBe('hls-stall-exhausted');
  expect(state.nativeUnsupportedReason).toBe('hls-stall-exhausted');
  expect(state.ticked).toBe(true);
  expect(state.stats.provider).toBe('native-hls');
  expect(state.stats.fallbackReason).toBe('');
  expect(state.stats.lastError).toBe('hls-stall-exhausted');
  expect(state.stats.fatalError).toBe('hls-stall-exhausted');
  expect(state.stats.nativeUnsupportedReason).toBe('hls-stall-exhausted');
});

test('native HLS fatal media error stays native with explicit terminal reason', async ({ page }) => {
  const shakaRequests = [];
  await page.route('**/player/shaka/**', route => {
    shakaRequests.push(route.request().url());
    route.abort();
  });
  await page.goto('/auth/login');
  await page.setContent('<video id="player"></video>');
  await page.addScriptTag({ path: 'public/native-player-engine.js' });

  const state = await page.evaluate(() => {
    const video = document.getElementById('player');
    const engine = new window.PlayerEngine(video, { videoId: 'TESTVIDEO01', streamToken: 'test-token' });
    engine._providerName = 'native-hls';
    const provider = {
      name: 'native-hls',
      engine,
      video,
      playlistUrl: '/master.m3u8',
      appendFailures: 0,
      rebufferDuration: 0,
      lastError: '',
      lastHttpStatus: 0,
      blacklisted: {},
      variants: [],
      audioRenditions: [],
      subtitleRenditions: [],
      _bufferAheadGoal() { return 30; },
      _bufferBehindGoal() { return 30; },
      _handleFatal: window.NativeHlsProviderForTest._handleFatal,
      _completeNativeRuntimeTerminal: window.NativeHlsProviderForTest._completeNativeRuntimeTerminal,
      getActiveVariantTrack() { return null; },
      getActiveAudioTrack() { return null; },
      getAudioTracks() { return []; },
      getLiveRange() { return { start: 0, end: 0 }; },
      isLive() { return false; },
      getStats: window.NativeHlsProviderForTest.getStats,
    };
    engine._provider = provider;
    provider._handleFatal(new Error('hls-media-error'));
    return {
      stats: provider.getStats(),
      lastError: provider.lastError,
      fatalError: provider.fatalError,
      nativeUnsupportedReason: provider.nativeUnsupportedReason,
      lastHttpStatus: provider.lastHttpStatus,
    };
  });

  expect(shakaRequests).toHaveLength(0);
  expect(state.lastError).toBe('hls-media-error');
  expect(state.fatalError).toBe('hls-media-error');
  expect(state.nativeUnsupportedReason).toBe('hls-media-error');
  expect(state.lastHttpStatus).toBe(0);
  expect(state.stats.provider).toBe('native-hls');
  expect(state.stats.fallbackReason).toBe('');
  expect(state.stats.lastError).toBe('hls-media-error');
  expect(state.stats.fatalError).toBe('hls-media-error');
  expect(state.stats.nativeUnsupportedReason).toBe('hls-media-error');
  expect(state.stats.lastHttpStatus).toBe(0);
});

test('native HLS fatal HTTP error stays native with status', async ({ page }) => {
  const shakaRequests = [];
  await page.route('**/player/shaka/**', route => {
    shakaRequests.push(route.request().url());
    route.abort();
  });
  await page.goto('/auth/login');
  await page.setContent('<video id="player"></video>');
  await page.addScriptTag({ path: 'public/native-player-engine.js' });

  const state = await page.evaluate(() => {
    const video = document.getElementById('player');
    const engine = new window.PlayerEngine(video, { videoId: 'TESTVIDEO01', streamToken: 'test-token' });
    engine._providerName = 'native-hls';
    const provider = {
      name: 'native-hls',
      engine,
      video,
      playlistUrl: '/master.m3u8',
      appendFailures: 0,
      rebufferDuration: 0,
      lastError: '',
      lastHttpStatus: 0,
      blacklisted: {},
      variants: [],
      audioRenditions: [],
      subtitleRenditions: [],
      _bufferAheadGoal() { return 30; },
      _bufferBehindGoal() { return 30; },
      _handleFatal: window.NativeHlsProviderForTest._handleFatal,
      _completeNativeRuntimeTerminal: window.NativeHlsProviderForTest._completeNativeRuntimeTerminal,
      getActiveVariantTrack() { return null; },
      getActiveAudioTrack() { return null; },
      getAudioTracks() { return []; },
      getLiveRange() { return { start: 0, end: 0 }; },
      isLive() { return false; },
      getStats: window.NativeHlsProviderForTest.getStats,
    };
    const err = new Error('hls-http-503');
    err.status = 503;
    engine._provider = provider;
    provider._handleFatal(err);
    return {
      stats: provider.getStats(),
      lastError: provider.lastError,
      fatalError: provider.fatalError,
      nativeUnsupportedReason: provider.nativeUnsupportedReason,
      lastHttpStatus: provider.lastHttpStatus,
    };
  });

  expect(shakaRequests).toHaveLength(0);
  expect(state.lastError).toBe('hls-http-503');
  expect(state.fatalError).toBe('hls-http-503');
  expect(state.nativeUnsupportedReason).toBe('hls-http-503');
  expect(state.lastHttpStatus).toBe(503);
  expect(state.stats.provider).toBe('native-hls');
  expect(state.stats.fallbackReason).toBe('');
  expect(state.stats.lastError).toBe('hls-http-503');
  expect(state.stats.fatalError).toBe('hls-http-503');
  expect(state.stats.nativeUnsupportedReason).toBe('hls-http-503');
  expect(state.stats.lastHttpStatus).toBe(503);
});

test('native HLS capability-aware selection skips unsupported variants', async ({ page }) => {
  const shakaRequests = await blockShakaScript(page);
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
  expect(shakaRequests).toHaveLength(0);
});

test('native HLS manual quality selection ignores unsupported tracks', async ({ page }) => {
  const shakaRequests = await blockShakaScript(page);
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
  expect(shakaRequests).toHaveLength(0);
});

test('native HLS manual quality selection ignores restricted tracks', async ({ page }) => {
  const shakaRequests = await blockShakaScript(page);
  await page.goto('/auth/login');
  await page.setContent('<video id="player"></video>');
  await page.addScriptTag({ path: 'public/native-player-engine.js' });

  const state = await page.evaluate(() => {
    const video = document.getElementById('player');
    const active = { id: '360', kind: 'video', mimeType: 'video/mp4', codecs: 'avc1.42c01f', bandwidth: 800_000, height: 360, active: true };
    const restricted = { id: '720', kind: 'video', mimeType: 'video/mp4', codecs: 'avc1.42c01f', bandwidth: 1_800_000, height: 720, active: false };
    const engine = new window.PlayerEngine(video, { videoId: 'TESTVIDEO01', streamToken: 'test-token' });
    engine.getPlayer().configure('abr.restrictions.maxHeight', 360);
    const provider = {
      engine,
      video,
      variants: [active, restricted],
      activeVariant: active,
      blacklisted: {},
      destroyed: false,
      _viewportMaxHeight() { return Infinity; },
      _switchVariant(variant) {
        this.switchedTo = variant.id;
      },
      _isCapabilityAllowed: window.NativeHlsProviderForTest._isCapabilityAllowed,
    };
    const tracks = window.NativeHlsProviderForTest.getVariantTracks.call(provider);
    window.NativeHlsProviderForTest.selectVariantTrack.call(provider, { id: '720' }, true);
    return {
      tracks,
      switchedTo: provider.switchedTo || '',
      manualTrackId: provider.manualTrackId || '',
      abrEnabled: engine.getPlayer().config.abr.enabled,
    };
  });

  expect(state.tracks.find(track => track.id === '720')).toMatchObject({ restricted: true, selectable: false, supported: true });
  expect(state.switchedTo).toBe('');
  expect(state.manualTrackId).toBe('');
  expect(state.abrEnabled).toBe(true);
  expect(shakaRequests).toHaveLength(0);
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
  await expectFirstPartyNativePlayback(page, { provider: 'native-dash', mode: 'dash' });
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
    window.__player = engine.getPlayer();
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
  await expectFirstPartyNativePlayback(page, { provider: 'native-dash', mode: 'dash' });
  expect(shakaRequests).toHaveLength(0);
  expect(logs.some(line => line.includes('falling back to shaka'))).toBe(false);
});

test('native DASH parser supports SegmentTemplate number, timeline, and set BaseURL', async ({ page }) => {
  const shakaRequests = await blockShakaScript(page);
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
  expect(shakaRequests).toHaveLength(0);
});

test('native DASH parser supports SegmentList URL and byte-range segments', async ({ page }) => {
  const shakaRequests = await blockShakaScript(page);
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
  expect(shakaRequests).toHaveLength(0);
});

test('native DASH parser supports inherited SegmentBase index ranges and sidx expansion', async ({ page }) => {
  const shakaRequests = await blockShakaScript(page);
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const parsed = await page.evaluate(async () => {
    function sidxBox(refs, timescale = 1000, firstOffset = 0) {
      const size = 8 + 4 + 4 + 4 + 4 + 4 + 2 + 2 + refs.length * 12;
      const out = new ArrayBuffer(size);
      const view = new DataView(out);
      let pos = 0;
      function u32(value) { view.setUint32(pos, value); pos += 4; }
      function u16(value) { view.setUint16(pos, value); pos += 2; }
      function type(value) {
        for (let i = 0; i < value.length; i++) view.setUint8(pos++, value.charCodeAt(i));
      }
      u32(size);
      type('sidx');
      u32(0);
      u32(1);
      u32(timescale);
      u32(0);
      u32(firstOffset);
      u16(0);
      u16(refs.length);
      for (const ref of refs) {
        u32(ref.size);
        u32(ref.duration);
        u32(0x90000000);
      }
      return out;
    }

    const mpd = `<?xml version="1.0"?><MPD type="static" mediaPresentationDuration="PT4S">
<Period duration="PT4S">
<AdaptationSet mimeType="video/mp4"><SegmentBase indexRange="100-155"><Initialization range="0-99"/></SegmentBase>
<Representation id="v1" bandwidth="800000" width="640" height="360" codecs="avc1.42c01f"><BaseURL>/single/video.mp4</BaseURL></Representation>
</AdaptationSet>
<AdaptationSet mimeType="audio/mp4"><SegmentBase indexRange="80-135"><Initialization range="0-79"/></SegmentBase>
<Representation id="a1" bandwidth="64000" codecs="mp4a.40.2"><BaseURL>/single/audio.mp4</BaseURL></Representation>
</AdaptationSet>
</Period></MPD>`;
    const out = window.NativeDashProviderForTest.parseMPD(mpd, 'https://example.test/dash/manifest.mpd');
    const rep = out.video[0];
    const calls = [];
    await window.NativeDashProviderForTest._prepareRep.call({
      requestGeneration: 0,
      engine: { _enterServerDown() {} },
      _fetchRange(url, range) {
        calls.push({ url, range });
        return Promise.resolve(range.start === 0 ? new Uint8Array([1, 2]).buffer : sidxBox([
          { size: 200, duration: 2000 },
          { size: 300, duration: 2000 },
        ]));
      },
    }, rep);
    return {
      baseUrl: rep.baseUrl,
      initRange: rep.initRange,
      indexRange: rep.indexRange,
      calls,
      segments: rep.segments.map(seg => ({ start: seg.start, end: seg.end, url: seg.url, range: seg.range })),
    };
  });

  expect(parsed.baseUrl).toBe('https://example.test/single/video.mp4');
  expect(parsed.initRange).toEqual({ start: 0, end: 99 });
  expect(parsed.indexRange).toEqual({ start: 100, end: 155 });
  expect(parsed.calls).toEqual([
    { url: 'https://example.test/single/video.mp4', range: { start: 0, end: 99 } },
    { url: 'https://example.test/single/video.mp4', range: { start: 100, end: 155 } },
  ]);
  expect(parsed.segments).toEqual([
    { start: 0, end: 2, url: 'https://example.test/single/video.mp4', range: { start: 156, end: 355 } },
    { start: 2, end: 4, url: 'https://example.test/single/video.mp4', range: { start: 356, end: 655 } },
  ]);
  expect(shakaRequests).toHaveLength(0);
});

test('native DASH parser preserves image adaptation set thumbnail metadata', async ({ page }) => {
  const shakaRequests = await blockShakaScript(page);
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const parsed = await page.evaluate(async () => {
    const mpd = `<?xml version="1.0"?><MPD type="static" mediaPresentationDuration="PT10S"><Period duration="PT10S">
<AdaptationSet mimeType="video/mp4"><SegmentTemplate timescale="1" duration="5" initialization="/v/$RepresentationID$/init.mp4" media="/v/$RepresentationID$/$Number$.m4s"/><Representation id="v1" bandwidth="800000" width="640" height="360" codecs="avc1.42c01f"/></AdaptationSet>
<AdaptationSet mimeType="audio/mp4"><SegmentTemplate timescale="1" duration="5" initialization="/a/$RepresentationID$/init.mp4" media="/a/$RepresentationID$/$Number$.m4s"/><Representation id="a1" bandwidth="64000" codecs="mp4a.40.2"/></AdaptationSet>
<AdaptationSet mimeType="image/jpeg"><SegmentTemplate timescale="1" duration="5" media="/thumbs/$Number$.jpg"/><Representation id="thumbs" bandwidth="24000" width="160" height="90" tilesHorizontal="5" tilesVertical="5"/></AdaptationSet>
</Period></MPD>`;
    const out = window.NativeDashProviderForTest.parseMPD(mpd, 'https://example.test/dash/manifest.mpd');
    const preview = await window.NativeDashProviderForTest.getIFramePreview.call({ imageReps: out.images }, 6, 'thumbs');
    return {
      images: out.images.map(rep => ({
        id: rep.id,
        kind: rep.kind,
        mimeType: rep.mimeType,
        width: rep.width,
        height: rep.height,
        segments: rep.templateSegments.map(seg => ({ start: seg.start, end: seg.end, url: seg.url, tiles: seg.tiles, imageOnly: seg.imageOnly })),
      })),
      tracks: window.NativeDashProviderForTest.getIFrameTracks.call({ imageReps: out.images }),
      preview,
    };
  });

  expect(parsed.images).toEqual([{
    id: 'thumbs',
    kind: 'image',
    mimeType: 'image/jpeg',
    width: 160,
    height: 90,
    segments: [
      { start: 0, end: 5, url: 'https://example.test/thumbs/1.jpg', tiles: { width: 160, height: 90, columns: 5, rows: 5, duration: 0 }, imageOnly: true },
      { start: 5, end: 10, url: 'https://example.test/thumbs/2.jpg', tiles: { width: 160, height: 90, columns: 5, rows: 5, duration: 0 }, imageOnly: true },
    ],
  }]);
  expect(parsed.tracks).toEqual([
    expect.objectContaining({ id: 'thumbs', width: 160, height: 90, imageOnly: true, thumbnailType: 'dash-image', source: 'native-dash', loaded: true }),
  ]);
  expect(parsed.preview).toMatchObject({
    track: expect.objectContaining({ id: 'thumbs', imageOnly: true, thumbnailType: 'dash-image', source: 'native-dash' }),
    start: 5,
    end: 10,
    url: 'https://example.test/thumbs/2.jpg',
    tiles: { width: 160, height: 90, columns: 5, rows: 5, duration: 0 },
    imageOnly: true,
    thumbnailType: 'dash-image',
  });
  expect(shakaRequests).toHaveLength(0);
});

test('native DASH parser supports inherited SegmentList metadata', async ({ page }) => {
  const shakaRequests = await blockShakaScript(page);
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
  expect(shakaRequests).toHaveLength(0);
});

test('native DASH parser supports dynamic live SegmentTemplate metadata', async ({ page }) => {
  const shakaRequests = await blockShakaScript(page);
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
  expect(shakaRequests).toHaveLength(0);
});

test('native DASH parser preserves EventStream timeline regions', async ({ page }) => {
  const shakaRequests = await blockShakaScript(page);
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const parsed = await page.evaluate(() => {
    const mpd = `<?xml version="1.0"?><MPD type="static" mediaPresentationDuration="PT8S"><Period start="PT4S" duration="PT4S">
<EventStream schemeIdUri="urn:test:events" value="markers" timescale="1000">
  <Event presentationTime="1500" duration="500" id="ad-1" messageData="payload-a"/>
  <Event presentationTime="2500" duration="1000" id="ad-2">payload-b</Event>
</EventStream>
<AdaptationSet mimeType="video/mp4"><SegmentTemplate timescale="1000" duration="2000" initialization="/i/$RepresentationID$" media="/v/$Number$"><Representation id="v1" bandwidth="800000" width="640" height="360" codecs="avc1.42c01f"/></SegmentTemplate></AdaptationSet>
<AdaptationSet mimeType="audio/mp4"><SegmentTemplate timescale="1000" duration="2000" initialization="/i/$RepresentationID$" media="/a/$Number$"><Representation id="a1" bandwidth="64000" codecs="mp4a.40.2"/></SegmentTemplate></AdaptationSet>
</Period></MPD>`;
    const out = window.NativeDashProviderForTest.parseMPD(mpd, 'https://example.test/manifest.mpd');
    return out.timelineRegions;
  });

  expect(parsed).toEqual([
    expect.objectContaining({ id: 'ad-1', schemeIdUri: 'urn:test:events', value: 'markers', startTime: 5.5, endTime: 6, eventElement: 'payload-a', source: 'dash-eventstream' }),
    expect.objectContaining({ id: 'ad-2', schemeIdUri: 'urn:test:events', value: 'markers', startTime: 6.5, endTime: 7.5, eventElement: 'payload-b', source: 'dash-eventstream' }),
  ]);
  expect(shakaRequests).toHaveLength(0);
});

test('native DASH parser derives bounded windows for dynamic number SegmentTemplate', async ({ page }) => {
  const shakaRequests = await blockShakaScript(page);
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const parsed = await page.evaluate(() => {
    const mpd = `<?xml version="1.0"?><MPD type="dynamic" availabilityStartTime="2026-05-04T00:00:00Z" publishTime="2026-05-04T00:00:10Z" minimumUpdatePeriod="PT1S" timeShiftBufferDepth="PT4S"><Period start="PT0S">
<AdaptationSet mimeType="video/mp4"><SegmentTemplate timescale="1000" duration="2000" startNumber="1" initialization="/i/$RepresentationID$" media="/v/$Number$"><Representation id="v1" bandwidth="800000" width="640" height="360" codecs="avc1.42c01f"/></SegmentTemplate></AdaptationSet>
<AdaptationSet mimeType="audio/mp4"><SegmentTemplate timescale="1000" duration="2000" startNumber="1" initialization="/i/$RepresentationID$" media="/a/$Number$"><Representation id="a1" bandwidth="64000" codecs="mp4a.40.2"/></SegmentTemplate></AdaptationSet>
</Period></MPD>`;
    const out = window.NativeDashProviderForTest.parseMPD(mpd, 'https://example.test/live/manifest.mpd');
    return {
      warnings: out.warnings,
      liveWindow: out.liveWindow,
      segments: out.video[0].templateSegments.map(seg => ({ start: seg.start, end: seg.end, url: seg.url })),
    };
  });

  expect(parsed.warnings).toEqual(['dynamic-number-template-window-derived']);
  expect(parsed.liveWindow).toEqual({ start: 6, end: 10 });
  expect(parsed.segments).toEqual([
    { start: 6, end: 8, url: 'https://example.test/v/4' },
    { start: 8, end: 10, url: 'https://example.test/v/5' },
  ]);
  expect(shakaRequests).toHaveLength(0);
});

test('native DASH parser supports simple static multi-period timelines', async ({ page }) => {
  const shakaRequests = await blockShakaScript(page);
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
  expect(shakaRequests).toHaveLength(0);
});

test('native DASH parser supports compatible dynamic multi-period timelines', async ({ page }) => {
  const shakaRequests = await blockShakaScript(page);
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
  expect(shakaRequests).toHaveLength(0);
});

test('native DASH parser resolves hierarchical BaseURL inheritance', async ({ page }) => {
  const shakaRequests = await blockShakaScript(page);
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
  expect(shakaRequests).toHaveLength(0);
});

test('native DASH parser expands bounded negative SegmentTimeline repeats', async ({ page }) => {
  const shakaRequests = await blockShakaScript(page);
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
  expect(shakaRequests).toHaveLength(0);
});

test('native DASH parser preserves codec changes across periods', async ({ page }) => {
  const shakaRequests = await blockShakaScript(page);
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const parsed = await page.evaluate(() => {
    const mpd = `<?xml version="1.0"?><MPD type="dynamic" availabilityStartTime="2026-05-04T00:00:00Z" timeShiftBufferDepth="PT8S">
<Period start="PT0S" duration="PT4S"><AdaptationSet mimeType="video/mp4"><SegmentTemplate timescale="1000" initialization="/i/$RepresentationID$" media="/v/$Time$"><SegmentTimeline><S t="0" d="2000" r="1"/></SegmentTimeline></SegmentTemplate><Representation id="v1" bandwidth="1" codecs="avc1.42c01f"/></AdaptationSet><AdaptationSet mimeType="audio/mp4"><SegmentTemplate timescale="1000" initialization="/i/$RepresentationID$" media="/a/$Time$"><SegmentTimeline><S t="0" d="2000" r="1"/></SegmentTimeline></SegmentTemplate><Representation id="a1" bandwidth="1" codecs="mp4a.40.2"/></AdaptationSet></Period>
<Period start="PT4S" duration="PT4S"><AdaptationSet mimeType="video/mp4"><SegmentTemplate timescale="1000" presentationTimeOffset="4000" initialization="/i2/$RepresentationID$" media="/v2/$Time$"><SegmentTimeline><S t="4000" d="2000" r="1"/></SegmentTimeline></SegmentTemplate><Representation id="v1" bandwidth="1" codecs="avc1.4d401f"/></AdaptationSet><AdaptationSet mimeType="audio/mp4"><SegmentTemplate timescale="1000" presentationTimeOffset="4000" initialization="/i/$RepresentationID$" media="/a2/$Time$"><SegmentTimeline><S t="4000" d="2000" r="1"/></SegmentTimeline></SegmentTemplate><Representation id="a1" bandwidth="1" codecs="mp4a.40.2"/></AdaptationSet></Period>
</MPD>`;
    const out = window.NativeDashProviderForTest.parseMPD(mpd, 'https://example.test/manifest.mpd');
    return {
      warnings: out.warnings,
      generations: out.video[0].periodGenerations.map(gen => ({ periodIndex: gen.periodIndex, codecs: gen.codecs, initUrl: gen.initUrl })),
      segments: out.video[0].templateSegments.map(seg => ({ start: seg.start, codecs: seg.codecs, initUrl: seg.initUrl })),
    };
  });

  expect(parsed.warnings).toContain('dash-multiperiod-codec-transition');
  expect(parsed.generations).toEqual([
    { periodIndex: 0, codecs: 'avc1.42c01f', initUrl: 'https://example.test/i/v1' },
    { periodIndex: 1, codecs: 'avc1.4d401f', initUrl: 'https://example.test/i2/v1' },
  ]);
  expect(parsed.segments).toEqual([
    { start: 0, codecs: 'avc1.42c01f', initUrl: 'https://example.test/i/v1' },
    { start: 2, codecs: 'avc1.42c01f', initUrl: 'https://example.test/i/v1' },
    { start: 4, codecs: 'avc1.4d401f', initUrl: 'https://example.test/i2/v1' },
    { start: 6, codecs: 'avc1.4d401f', initUrl: 'https://example.test/i2/v1' },
  ]);
  expect(shakaRequests).toHaveLength(0);
});

test('native DASH parser preserves audio track language and label metadata', async ({ page }) => {
  const shakaRequests = await blockShakaScript(page);
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const parsed = await page.evaluate(() => {
    const mpd = `<?xml version="1.0"?><MPD xmlns:cenc="urn:mpeg:cenc:2013" type="static" mediaPresentationDuration="PT4S"><Period>
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
  expect(shakaRequests).toHaveLength(0);
});

test('native DASH parser preserves track roles accessibility and text metadata', async ({ page }) => {
  const shakaRequests = await blockShakaScript(page);
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const parsed = await page.evaluate(() => {
    const mpd = `<?xml version="1.0"?><MPD type="static" mediaPresentationDuration="PT4S"><Period>
<AdaptationSet mimeType="video/mp4"><SegmentTemplate timescale="1" duration="2" initialization="/v/$RepresentationID$/init.mp4" media="/v/$RepresentationID$/$Number$.m4s"/>
<Representation id="v1" bandwidth="800000" width="640" height="360" codecs="avc1.42c01f"/></AdaptationSet>
<AdaptationSet mimeType="audio/mp4" lang="en"><Label>English main</Label><Role schemeIdUri="urn:mpeg:dash:role:2011" value="main"/><Accessibility schemeIdUri="urn:tva:metadata:cs:AudioPurposeCS:2007" value="1"/><AudioChannelConfiguration schemeIdUri="urn:mpeg:dash:23003:3:audio_channel_configuration:2011" value="2"/><SegmentTemplate timescale="1" duration="2" initialization="/a/$RepresentationID$/init.mp4" media="/a/$RepresentationID$/$Number$.m4s"/>
<Representation id="a-main" bandwidth="64000" codecs="mp4a.40.2" audioSamplingRate="48000"/></AdaptationSet>
<AdaptationSet mimeType="video/mp4"><Accessibility schemeIdUri="urn:scte:dash:cc:cea-608:2015" value="CC1=eng;CC3=spa"/><SegmentTemplate timescale="1" duration="2" initialization="/vc/$RepresentationID$/init.mp4" media="/vc/$RepresentationID$/$Number$.m4s"/>
<Representation id="v-cc" bandwidth="400000" width="426" height="240" codecs="avc1.42c01f"/></AdaptationSet>
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
        renderSupported: rep.renderSupported,
        embedded: !!rep.embedded,
        instreamId: rep.instreamId || '',
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
      id: 'cea:v-cc:CC1',
      language: 'eng',
      label: 'eng',
      mimeType: 'application/cea-608',
      roles: ['caption'],
      url: undefined,
      supported: false,
      renderSupported: false,
      embedded: true,
      instreamId: 'CC1',
      source: 'native-dash-cea',
    },
    {
      id: 'cea:v-cc:CC3',
      language: 'spa',
      label: 'spa',
      mimeType: 'application/cea-608',
      roles: ['caption'],
      url: undefined,
      supported: false,
      renderSupported: false,
      embedded: true,
      instreamId: 'CC3',
      source: 'native-dash-cea',
    },
    {
      id: 'text-en',
      language: 'en',
      label: 'English captions',
      mimeType: 'text/vtt',
      roles: ['subtitle'],
      url: 'https://example.test/captions/en.vtt',
      supported: true,
      renderSupported: true,
      embedded: false,
      instreamId: '',
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
      renderSupported: true,
      embedded: false,
      instreamId: '',
      source: 'native-dash',
    },
  ]);
  expect(shakaRequests).toHaveLength(0);
});

test('native DASH parser preserves DRM ContentProtection metadata', async ({ page }) => {
  const shakaRequests = await blockShakaScript(page);
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const parsed = await page.evaluate(() => {
    const mpd = `<?xml version="1.0"?><MPD type="static" mediaPresentationDuration="PT4S"><Period>
<AdaptationSet mimeType="video/mp4">
<ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" default_KID="00112233-4455-6677-8899-aabbccddeeff"/>
<ContentProtection schemeIdUri="urn:uuid:e2719d58-a985-b3c9-781a-b030af78d30e"><pssh>AAECAw==</pssh></ContentProtection>
<Representation id="v1" bandwidth="800000" width="640" height="360" codecs="avc1.42c01f"><BaseURL>/v.mp4</BaseURL><SegmentBase indexRange="0-1"><Initialization range="0-1"/></SegmentBase></Representation>
</AdaptationSet>
<AdaptationSet mimeType="audio/mp4"><Representation id="a1" bandwidth="64000" codecs="mp4a.40.2"><BaseURL>/a.mp4</BaseURL><SegmentBase indexRange="0-1"><Initialization range="0-1"/></SegmentBase></Representation></AdaptationSet>
</Period></MPD>`;
    const out = window.NativeDashProviderForTest.parseMPD(mpd, 'https://example.test/manifest.mpd');
    return out.video[0].drmInfos.map(info => ({
      keySystem: info.keySystem,
      schemeIdUri: info.schemeIdUri,
      defaultKid: info.defaultKid,
      pssh: info.pssh ? Array.from(info.pssh) : null,
    }));
  });

  expect(parsed).toEqual([
    expect.objectContaining({ keySystem: '', defaultKid: '00112233445566778899aabbccddeeff' }),
    expect.objectContaining({ keySystem: 'org.w3.clearkey', pssh: [0, 1, 2, 3] }),
  ]);
  expect(shakaRequests).toHaveLength(0);
});

test('native DASH audio role ordering prefers main over commentary', async ({ page }) => {
  const shakaRequests = await blockShakaScript(page);
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
  expect(shakaRequests).toHaveLength(0);
});

test('native DASH exposes audio tracks and switches audio without touching video buffer', async ({ page }) => {
  const shakaRequests = await blockShakaScript(page);
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
  expect(shakaRequests).toHaveLength(0);
});

test('native DASH appends period init and changes type at codec boundary', async ({ page }) => {
  const shakaRequests = await blockShakaScript(page);
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const state = await page.evaluate(async () => {
    function makeSourceBuffer() {
      const listeners = {};
      const appended = [];
      const types = [];
      return {
        get appended() { return appended; },
        get types() { return types; },
        updating: false,
        buffered: { length: 0, start() { return 0; }, end() { return 0; } },
        addEventListener(name, fn) { listeners[name] = fn; },
        removeEventListener(name) { delete listeners[name]; },
        appendBuffer(data) {
          appended.push(data.byteLength);
          setTimeout(() => { if (listeners.updateend) listeners.updateend(); }, 0);
        },
        changeType(type) { types.push(type); },
      };
    }

    const originalIsTypeSupported = window.MediaSource && window.MediaSource.isTypeSupported;
    Object.defineProperty(window.MediaSource, 'isTypeSupported', {
      configurable: true,
      value() { return true; },
    });
    const video = document.getElementById('player');
    const engine = new window.PlayerEngine(video, { videoId: 'TESTVIDEO01', streamToken: 'test-token' });
    engine._telemetry.record = function () {};
    const videoSb = makeSourceBuffer();
    const rep = {
      id: 'v1',
      kind: 'video',
      mimeType: 'video/mp4',
      codecs: 'avc1.42c01f',
      initData: new ArrayBuffer(1),
      _appendedInitKey: 'video|v1|p0|video/mp4|avc1.42c01f|https://example.test/i/v1|',
    };
    const seg = {
      start: 4,
      end: 6,
      url: 'https://example.test/v2/4000',
      generationKey: 'video|v1|p1|video/mp4|avc1.4d401f|https://example.test/i2/v1|',
      mimeType: 'video/mp4',
      codecs: 'avc1.4d401f',
      initUrl: 'https://example.test/i2/v1',
      appendWindow: { start: 4, end: 8 },
    };
    const provider = {
      engine,
      video,
      videoSb,
      videoMime: 'video/mp4; codecs="avc1.42c01f"',
      _fetchRange(url) {
        return Promise.resolve(url.endsWith('/i2/v1') ? new ArrayBuffer(2) : new ArrayBuffer(0));
      },
      _changeVideoTypeIfNeeded: window.NativeDashProviderForTest._changeVideoTypeIfNeeded,
      _prepareSegmentGeneration: window.NativeDashProviderForTest._prepareSegmentGeneration,
      _initDataForSegment: window.NativeDashProviderForTest._initDataForSegment,
      _appendSegmentData: window.NativeDashProviderForTest._appendSegmentData,
    };
    await provider._appendSegmentData(rep, videoSb, seg, new ArrayBuffer(3));
    if (originalIsTypeSupported) {
      Object.defineProperty(window.MediaSource, 'isTypeSupported', {
        configurable: true,
        value: originalIsTypeSupported,
      });
    }
    return {
      videoMime: provider.videoMime,
      appended: videoSb.appended,
      types: videoSb.types,
      appendedInitKey: rep._appendedInitKey,
    };
  });

  expect(state.types).toEqual(['video/mp4; codecs="avc1.4d401f"']);
  expect(state.appended).toEqual([2, 3]);
  expect(state.videoMime).toBe('video/mp4; codecs="avc1.4d401f"');
  expect(state.appendedInitKey).toContain('p1');
  expect(shakaRequests).toHaveLength(0);
});

test('native DASH rebuilds source buffer at codec boundary when changeType is unavailable', async ({ page }) => {
  const shakaRequests = await blockShakaScript(page);
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const state = await page.evaluate(async () => {
    function makeSourceBuffer(label) {
      const listeners = {};
      const appended = [];
      return {
        label,
        get appended() { return appended; },
        updating: false,
        buffered: { length: 0, start() { return 0; }, end() { return 0; } },
        addEventListener(name, fn) { listeners[name] = fn; },
        removeEventListener(name) { delete listeners[name]; },
        appendBuffer(data) {
          appended.push(data.byteLength);
          setTimeout(() => { if (listeners.updateend) listeners.updateend(); }, 0);
        },
        abort() {},
      };
    }

    const originalIsTypeSupported = window.MediaSource && window.MediaSource.isTypeSupported;
    Object.defineProperty(window.MediaSource, 'isTypeSupported', {
      configurable: true,
      value() { return true; },
    });
    const video = document.getElementById('player');
    Object.defineProperty(video, 'currentTime', { configurable: true, get() { return 4; } });
    const engine = new window.PlayerEngine(video, { videoId: 'TESTVIDEO01', streamToken: 'test-token' });
    engine._telemetry.record = function () {};
    const oldSb = makeSourceBuffer('old');
    const created = [];
    const removed = [];
    const mediaSource = {
      readyState: 'open',
      removeSourceBuffer(sb) { removed.push(sb.label); },
      addSourceBuffer(type) {
        const sb = makeSourceBuffer(type);
        created.push({ type, sb });
        return sb;
      },
    };
    const rep = {
      id: 'v1',
      kind: 'video',
      mimeType: 'video/mp4',
      codecs: 'avc1.42c01f',
      initData: new ArrayBuffer(1),
      segments: [{ start: 0, end: 2, appended: true, state: 'appended' }],
      _appendedInitKey: 'video|v1|p0|video/mp4|avc1.42c01f|https://example.test/i/v1|',
    };
    const seg = {
      start: 4,
      end: 6,
      url: 'https://example.test/v2/4000',
      generationKey: 'video|v1|p1|video/mp4|avc1.4d401f|https://example.test/i2/v1|',
      mimeType: 'video/mp4',
      codecs: 'avc1.4d401f',
      initUrl: 'https://example.test/i2/v1',
      appendWindow: { start: 4, end: 8 },
    };
    const provider = {
      engine,
      video,
      mediaSource,
      videoSb: oldSb,
      videoMime: 'video/mp4; codecs="avc1.42c01f"',
      _fetchRange(url) {
        return Promise.resolve(url.endsWith('/i2/v1') ? new ArrayBuffer(2) : new ArrayBuffer(0));
      },
      _changeVideoTypeIfNeeded: window.NativeDashProviderForTest._changeVideoTypeIfNeeded,
      _rebuildSourceBufferForPeriod: window.NativeDashProviderForTest._rebuildSourceBufferForPeriod,
      _prepareSegmentGeneration: window.NativeDashProviderForTest._prepareSegmentGeneration,
      _initDataForSegment: window.NativeDashProviderForTest._initDataForSegment,
      _appendSegmentData: window.NativeDashProviderForTest._appendSegmentData,
    };
    await provider._appendSegmentData(rep, oldSb, seg, new ArrayBuffer(3));
    if (originalIsTypeSupported) {
      Object.defineProperty(window.MediaSource, 'isTypeSupported', {
        configurable: true,
        value: originalIsTypeSupported,
      });
    }
    return {
      removed,
      createdTypes: created.map(item => item.type),
      oldAppended: oldSb.appended,
      replacementAppended: provider.videoSb.appended,
      videoMime: provider.videoMime,
      appendedInitKey: rep._appendedInitKey,
      periodTransitionCount: provider.periodTransitionCount,
      sourceBufferRebuildAttemptCount: provider.sourceBufferRebuildAttemptCount,
      sourceBufferRebuildSuccessCount: provider.sourceBufferRebuildSuccessCount,
      lastPeriodTransitionReason: provider.lastPeriodTransitionReason,
      segmentState: rep.segments[0].state,
    };
  });

  expect(state.removed).toEqual(['old']);
  expect(state.createdTypes).toEqual(['video/mp4; codecs="avc1.4d401f"']);
  expect(state.oldAppended).toEqual([]);
  expect(state.replacementAppended).toEqual([2, 3]);
  expect(state.videoMime).toBe('video/mp4; codecs="avc1.4d401f"');
  expect(state.appendedInitKey).toContain('p1');
  expect(state.periodTransitionCount).toBe(1);
  expect(state.sourceBufferRebuildAttemptCount).toBe(1);
  expect(state.sourceBufferRebuildSuccessCount).toBe(1);
  expect(state.lastPeriodTransitionReason).toBe('sourcebuffer-rebuild');
  expect(state.segmentState).toBe('pending');
  expect(shakaRequests).toHaveLength(0);
});

test('native DASH unsupported period codec transition stays native with explicit terminal reason', async ({ page }) => {
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const state = await page.evaluate(async () => {
    const originalIsTypeSupported = window.MediaSource && window.MediaSource.isTypeSupported;
    Object.defineProperty(window.MediaSource, 'isTypeSupported', {
      configurable: true,
      value(type) { return !String(type).includes('hev1'); },
    });
    const video = document.getElementById('player');
    const engine = new window.PlayerEngine(video, { videoId: 'TESTVIDEO01', streamToken: 'test-token' });
    engine._providerName = 'native-dash';
    const rep = {
      id: 'v1',
      kind: 'video',
      mimeType: 'video/mp4',
      codecs: 'avc1.42c01f',
      _appendedInitKey: 'video|v1|p0|video/mp4|avc1.42c01f|https://example.test/i/v1|',
    };
    const provider = {
      name: 'native-dash',
      engine,
      video,
      manifestUrl: '/manifest.mpd',
      videoSb: { changeType() {} },
      videoMime: 'video/mp4; codecs="avc1.42c01f"',
      appendFailures: 0,
      rebufferDuration: 0,
      activeRanges: {},
      blacklisted: {},
      videoReps: [rep],
      audioReps: [],
      textReps: [],
      activeVideo: rep,
      audio: null,
      lastError: '',
      _recordRangeError(err) { this.lastError = err.message; },
      _changeVideoTypeIfNeeded: window.NativeDashProviderForTest._changeVideoTypeIfNeeded,
      _prepareSegmentGeneration: window.NativeDashProviderForTest._prepareSegmentGeneration,
      _completeNativeRuntimeTerminal: window.NativeDashProviderForTest._completeNativeRuntimeTerminal,
      getActiveVariantTrack() { return null; },
      isLive() { return false; },
      getStats: window.NativeDashProviderForTest.getStats,
    };
    engine._provider = provider;
    try {
      await provider._prepareSegmentGeneration(rep, provider.videoSb, {
        generationKey: 'video|v1|p1|video/mp4|hev1.1.6.L93.B0|https://example.test/i2/v1|',
        mimeType: 'video/mp4',
        codecs: 'hev1.1.6.L93.B0',
        initUrl: 'https://example.test/i2/v1',
      });
      return { error: '' };
    } catch (err) {
      window.NativeDashProviderForTest._handleAppendFailure.call(provider, rep, err);
      return {
        error: err.message,
        stats: provider.getStats(),
        appendFailures: provider.appendFailures,
        lastError: provider.lastError,
        fatalError: provider.fatalError,
        nativeUnsupportedReason: provider.nativeUnsupportedReason,
        lastPeriodTransitionReason: provider.lastPeriodTransitionReason,
        lastPeriodTransitionError: provider.lastPeriodTransitionError,
      };
    } finally {
      if (originalIsTypeSupported) {
        Object.defineProperty(window.MediaSource, 'isTypeSupported', {
          configurable: true,
          value: originalIsTypeSupported,
        });
      }
    }
  });

  expect(state.error).toBe('dash-period-codec-change-unsupported');
  expect(state.appendFailures).toBe(1);
  expect(state.lastError).toBe('dash-period-codec-change-unsupported');
  expect(state.fatalError).toBe('dash-period-codec-change-unsupported');
  expect(state.nativeUnsupportedReason).toBe('dash-period-codec-change-unsupported');
  expect(state.lastPeriodTransitionReason).toBe('unsupported-codec');
  expect(state.lastPeriodTransitionError).toBe('dash-period-codec-change-unsupported');
  expect(state.stats.provider).toBe('native-dash');
  expect(state.stats.fallbackReason).toBe('');
  expect(state.stats.lastError).toBe('dash-period-codec-change-unsupported');
  expect(state.stats.fatalError).toBe('dash-period-codec-change-unsupported');
  expect(state.stats.nativeUnsupportedReason).toBe('dash-period-codec-change-unsupported');
  expect(state.stats.lastPeriodTransitionReason).toBe('unsupported-codec');
  expect(state.stats.lastPeriodTransitionError).toBe('dash-period-codec-change-unsupported');
});

test('adapter text track APIs render selected cues through the caption overlay', async ({ page }) => {
  const shakaRequests = await blockShakaScript(page);
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
  expect(shakaRequests).toHaveLength(0);
});

test('adapter merges native DASH text tracks with controller captions', async ({ page }) => {
  const shakaRequests = await blockShakaScript(page);
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
      getStats() {
        return {
          provider: this.name,
          mode: 'dash',
          fallbackReason: engine._fallbackReason || '',
          textTrackCount: engine._player.getTextTracks().length,
          nativeTextTrackCount: this.textReps.length,
          lastTextTrackError: this.lastTextTrackError || '',
        };
      },
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
  expect(shakaRequests).toHaveLength(0);
});

test('adapter routes native DASH sidecar text through caption controller', async ({ page }) => {
  const shakaRequests = await blockShakaScript(page);
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
      getStats() {
        return {
          provider: this.name,
          mode: 'dash',
          fallbackReason: engine._fallbackReason || '',
          textTrackCount: engine._player.getTextTracks().length,
          nativeTextTrackCount: this.textReps.length,
          lastTextTrackError: this.lastTextTrackError || '',
        };
      },
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
  expect(shakaRequests).toHaveLength(0);
});

test('native DASH sidecar VTT renders cues without Shaka text pipeline', async ({ page }) => {
  const shakaRequests = [];
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.abort();
  });
  await page.route('**/captions/native-dash-render.vtt**', route => {
    route.fulfill({
      status: 200,
      contentType: 'text/vtt',
      body: 'WEBVTT\n\n00:00:00.000 --> 00:00:04.000\nProvider DASH captions\n',
    });
  });
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video><div class="custom-caption-container"></div>');

  const state = await page.evaluate(async () => {
    const video = document.getElementById('player');
    const overlay = document.querySelector('.custom-caption-container');
    Object.defineProperty(video, 'currentTime', { configurable: true, get() { return 1; } });
    const engine = new window.PlayerEngine(video, { videoId: 'TESTVIDEO01', streamToken: 'test-token' });
    const provider = {
      engine,
      video,
      name: 'native-dash',
      textReps: [
        { id: 'dash-en', source: 'native-dash', language: 'en', label: 'DASH English', mimeType: 'text/vtt', roles: ['subtitle'], accessibility: [], url: '/captions/native-dash-render.vtt', supported: true },
        { id: 'dash-ttml', source: 'native-dash', language: 'es', label: 'DASH Spanish', mimeType: 'application/ttml+xml', roles: ['subtitle'], accessibility: [], url: '/captions/native-dash.ttml', supported: true },
      ],
      activeTextTrackId: '',
      textTrackVisibility: false,
      textCueCache: {},
      textLoadStates: {},
      getTextTracks: window.NativeDashProviderForTest.getTextTracks,
      getActiveTextTrack: window.NativeDashProviderForTest.getActiveTextTrack,
      selectTextTrack: window.NativeDashProviderForTest.selectTextTrack,
      setTextTrackVisibility: window.NativeDashProviderForTest.setTextTrackVisibility,
      getStats() {
        return {
          provider: this.name,
          mode: 'dash',
          fallbackReason: engine._fallbackReason || '',
          textTrackCount: engine._player.getTextTracks().length,
          nativeTextTrackCount: this.textReps.length,
          lastTextTrackError: this.lastTextTrackError || '',
        };
      },
    };
    engine._provider = provider;
    const player = engine.getPlayer();
    await player.selectTextTrack(player.getTextTracks().find(track => track.id === 'dash-en'));
    const selected = {
      active: player.getActiveTextTrack(),
      overlayText: overlay.textContent,
      cues: window._captionCues,
      visible: window._captionsVisible,
      stats: player.getStats(),
    };
    await player.setTextTrackVisibility(false);
    const hidden = {
      active: player.getActiveTextTrack(),
      overlayText: overlay.textContent,
      cues: window._captionCues,
      visible: window._captionsVisible,
    };
    const ttml = player.getTextTracks().find(track => track.id === 'dash-ttml');
    return { selected, hidden, ttml };
  });

  expect(shakaRequests).toHaveLength(0);
  expect(state.selected.active).toMatchObject({ id: 'dash-en', active: true, loadState: 'loaded', renderSupported: true });
  expect(state.selected.overlayText).toBe('Provider DASH captions');
  expect(state.selected.cues).toHaveLength(1);
  expect(state.selected.visible).toBe(true);
  expect(state.selected.stats.provider).toBe('native-dash');
  expect(state.selected.stats.fallbackReason).toBe('');
  expect(state.selected.stats.textTrackCount).toBe(2);
  expect(state.selected.stats.nativeTextTrackCount).toBe(2);
  expect(state.selected.stats.lastTextTrackError).toBe('');
  expect(state.hidden.active).toBeNull();
  expect(state.hidden.overlayText).toBe('');
  expect(state.hidden.cues).toBeNull();
  expect(state.hidden.visible).toBe(false);
  expect(state.ttml).toMatchObject({ id: 'dash-ttml', supported: true, renderSupported: true });
});

test('native TTML parser supports clock, duration, offsets, entities, and malformed XML', async ({ page }) => {
  const shakaRequests = await blockShakaScript(page);
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const parsed = await page.evaluate(() => ({
    cues: window.NativeDashProviderForTest.parseTtmlCues(`<?xml version="1.0"?>
<tt xmlns="http://www.w3.org/ns/ttml"><body><div>
<p begin="00:00:01.500" end="00:00:03.000">Hello &amp; welcome</p>
<p begin="4s" dur="1500ms">Second   cue</p>
<p begin="0.1m" end="0.125m">Offset cue</p>
</div></body></tt>`),
    malformed: window.NativeDashProviderForTest.parseTtmlCues('<tt><body><p begin="1s" end="2s">Broken'),
  }));

  expect(parsed.cues).toEqual([
    { start: 1.5, end: 3, text: 'Hello & welcome' },
    { start: 4, end: 5.5, text: 'Second cue' },
    { start: 6, end: 7.5, text: 'Offset cue' },
  ]);
  expect(parsed.malformed).toEqual([]);
  expect(shakaRequests).toHaveLength(0);
});

test('native DASH sidecar TTML renders cues without Shaka text pipeline', async ({ page }) => {
  const shakaRequests = [];
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.abort();
  });
  await page.route('**/captions/native-dash-render.ttml**', route => {
    route.fulfill({
      status: 200,
      contentType: 'application/ttml+xml',
      body: '<?xml version="1.0"?><tt xmlns="http://www.w3.org/ns/ttml"><body><div><p begin="00:00:00.000" end="00:00:04.000">Provider DASH TTML &amp; captions</p></div></body></tt>',
    });
  });
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video><div class="custom-caption-container"></div>');

  const state = await page.evaluate(async () => {
    const video = document.getElementById('player');
    const overlay = document.querySelector('.custom-caption-container');
    Object.defineProperty(video, 'currentTime', { configurable: true, get() { return 1; } });
    const engine = new window.PlayerEngine(video, { videoId: 'TESTVIDEO01', streamToken: 'test-token' });
    const provider = {
      engine,
      video,
      name: 'native-dash',
      textReps: [
        { id: 'dash-ttml', source: 'native-dash', language: 'en', label: 'DASH TTML', mimeType: 'application/ttml+xml', roles: ['subtitle'], accessibility: [], url: '/captions/native-dash-render.ttml', supported: true },
      ],
      activeTextTrackId: '',
      textTrackVisibility: false,
      textCueCache: {},
      textLoadStates: {},
      getTextTracks: window.NativeDashProviderForTest.getTextTracks,
      getActiveTextTrack: window.NativeDashProviderForTest.getActiveTextTrack,
      selectTextTrack: window.NativeDashProviderForTest.selectTextTrack,
      setTextTrackVisibility: window.NativeDashProviderForTest.setTextTrackVisibility,
      getStats() {
        return {
          provider: this.name,
          mode: 'dash',
          fallbackReason: engine._fallbackReason || '',
          textTrackCount: engine._player.getTextTracks().length,
          nativeTextTrackCount: this.textReps.length,
          lastTextTrackError: this.lastTextTrackError || '',
        };
      },
    };
    engine._provider = provider;
    const player = engine.getPlayer();
    await player.selectTextTrack(player.getTextTracks()[0]);
    return {
      active: player.getActiveTextTrack(),
      overlayText: overlay.textContent,
      cues: window._captionCues,
      visible: window._captionsVisible,
      lastTextTrackError: provider.lastTextTrackError,
      stats: player.getStats(),
    };
  });

  expect(shakaRequests).toHaveLength(0);
  expect(state.active).toMatchObject({ id: 'dash-ttml', active: true, loadState: 'loaded', renderSupported: true });
  expect(state.overlayText).toBe('Provider DASH TTML & captions');
  expect(state.cues).toEqual([{ start: 0, end: 4, text: 'Provider DASH TTML & captions' }]);
  expect(state.visible).toBe(true);
  expect(state.lastTextTrackError).toBe('');
  expect(state.stats.provider).toBe('native-dash');
  expect(state.stats.fallbackReason).toBe('');
  expect(state.stats.textTrackCount).toBe(1);
  expect(state.stats.nativeTextTrackCount).toBe(1);
  expect(state.stats.lastTextTrackError).toBe('');
});

test('native HLS subtitle VTT renders cues through the native overlay', async ({ page }) => {
  const shakaRequests = [];
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.abort();
  });
  await page.route('**/captions/native-hls-render.vtt**', route => {
    route.fulfill({
      status: 200,
      contentType: 'text/vtt',
      body: 'WEBVTT\n\n00:00:00.000 --> 00:00:04.000\nProvider HLS captions\n',
    });
  });
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video><div class="custom-caption-container"></div>');

  const state = await page.evaluate(async () => {
    const video = document.getElementById('player');
    const overlay = document.querySelector('.custom-caption-container');
    Object.defineProperty(video, 'currentTime', { configurable: true, get() { return 1; } });
    const engine = new window.PlayerEngine(video, { videoId: 'TESTVIDEO01', streamToken: 'test-token' });
    const provider = {
      engine,
      video,
      name: 'native-hls',
      subtitleRenditions: [
        { id: 'subs:English', language: 'en', label: 'English', mimeType: 'text/vtt', url: '/captions/native-hls-render.vtt', active: false },
      ],
      activeTextTrackId: '',
      textTrackVisibility: false,
      textCueCache: {},
      textLoadStates: {},
      getTextTracks: window.NativeHlsProviderForTest.getTextTracks,
      getActiveTextTrack: window.NativeHlsProviderForTest.getActiveTextTrack,
      selectTextTrack: window.NativeHlsProviderForTest.selectTextTrack,
      setTextTrackVisibility: window.NativeHlsProviderForTest.setTextTrackVisibility,
      getStats() {
        return {
          provider: this.name,
          mode: 'hls',
          fallbackReason: engine._fallbackReason || '',
          textTrackCount: engine._player.getTextTracks().length,
          nativeTextTrackCount: this.subtitleRenditions.length,
          lastTextTrackError: this.lastTextTrackError || '',
        };
      },
    };
    engine._provider = provider;
    const player = engine.getPlayer();
    await player.selectTextTrack(player.getTextTracks()[0]);
    return {
      active: player.getActiveTextTrack(),
      overlayText: overlay.textContent,
      cues: window._captionCues,
      visible: window._captionsVisible,
      stats: player.getStats(),
    };
  });

  expect(shakaRequests).toHaveLength(0);
  expect(state.active).toMatchObject({ id: 'subs:English', source: 'native-hls', active: true, loadState: 'loaded', renderSupported: true });
  expect(state.overlayText).toBe('Provider HLS captions');
  expect(state.cues).toHaveLength(1);
  expect(state.visible).toBe(true);
  expect(state.stats.provider).toBe('native-hls');
  expect(state.stats.fallbackReason).toBe('');
  expect(state.stats.textTrackCount).toBe(1);
  expect(state.stats.nativeTextTrackCount).toBe(1);
  expect(state.stats.lastTextTrackError).toBe('');
});

test('native HLS subtitle TTML renders cues through the native overlay', async ({ page }) => {
  const shakaRequests = [];
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.abort();
  });
  await page.route('**/captions/native-hls-render.ttml**', route => {
    route.fulfill({
      status: 200,
      contentType: 'application/ttml+xml',
      body: '<?xml version="1.0"?><tt xmlns="http://www.w3.org/ns/ttml"><body><div><p begin="1s" dur="3s">Provider HLS TTML captions</p></div></body></tt>',
    });
  });
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video><div class="custom-caption-container"></div>');

  const state = await page.evaluate(async () => {
    const video = document.getElementById('player');
    const overlay = document.querySelector('.custom-caption-container');
    Object.defineProperty(video, 'currentTime', { configurable: true, get() { return 2; } });
    const engine = new window.PlayerEngine(video, { videoId: 'TESTVIDEO01', streamToken: 'test-token' });
    const provider = {
      engine,
      video,
      name: 'native-hls',
      subtitleRenditions: [
        { id: 'subs:TTML', language: 'en', label: 'English TTML', mimeType: 'application/ttml+xml', url: '/captions/native-hls-render.ttml', active: false },
      ],
      activeTextTrackId: '',
      textTrackVisibility: false,
      textCueCache: {},
      textLoadStates: {},
      getTextTracks: window.NativeHlsProviderForTest.getTextTracks,
      getActiveTextTrack: window.NativeHlsProviderForTest.getActiveTextTrack,
      selectTextTrack: window.NativeHlsProviderForTest.selectTextTrack,
      setTextTrackVisibility: window.NativeHlsProviderForTest.setTextTrackVisibility,
      getStats() {
        return {
          provider: this.name,
          mode: 'hls',
          fallbackReason: engine._fallbackReason || '',
          textTrackCount: engine._player.getTextTracks().length,
          nativeTextTrackCount: this.subtitleRenditions.length,
          lastTextTrackError: this.lastTextTrackError || '',
        };
      },
    };
    engine._provider = provider;
    const player = engine.getPlayer();
    await player.selectTextTrack(player.getTextTracks()[0]);
    return {
      active: player.getActiveTextTrack(),
      overlayText: overlay.textContent,
      cues: window._captionCues,
      visible: window._captionsVisible,
      lastTextTrackError: provider.lastTextTrackError,
      stats: player.getStats(),
    };
  });

  expect(shakaRequests).toHaveLength(0);
  expect(state.active).toMatchObject({ id: 'subs:TTML', source: 'native-hls', active: true, loadState: 'loaded', renderSupported: true });
  expect(state.overlayText).toBe('Provider HLS TTML captions');
  expect(state.cues).toEqual([{ start: 1, end: 4, text: 'Provider HLS TTML captions' }]);
  expect(state.visible).toBe(true);
  expect(state.lastTextTrackError).toBe('');
  expect(state.stats.provider).toBe('native-hls');
  expect(state.stats.fallbackReason).toBe('');
  expect(state.stats.textTrackCount).toBe(1);
  expect(state.stats.nativeTextTrackCount).toBe(1);
  expect(state.stats.lastTextTrackError).toBe('');
});

test('native text track fetch failures are non-fatal and do not fall back', async ({ page }) => {
  const shakaRequests = [];
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.abort();
  });
  await page.route('**/captions/native-missing.vtt**', route => {
    route.fulfill({ status: 404, contentType: 'text/plain', body: 'missing' });
  });
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video><div class="custom-caption-container"></div>');

  const state = await page.evaluate(async () => {
    const video = document.getElementById('player');
    Object.defineProperty(video, 'currentTime', { configurable: true, get() { return 1; } });
    const engine = new window.PlayerEngine(video, { videoId: 'TESTVIDEO01', streamToken: 'test-token' });
    const provider = {
      engine,
      video,
      name: 'native-dash',
      activeVideo: { id: 'v1', height: 720, bandwidth: 1200000, mimeType: 'video/mp4', codecs: 'avc1.42c01f' },
      videoReps: [{ id: 'v1', height: 720, bandwidth: 1200000, mimeType: 'video/mp4', codecs: 'avc1.42c01f' }],
      audioReps: [],
      textReps: [
        { id: 'dash-missing', source: 'native-dash', language: 'en', label: 'Missing', mimeType: 'text/vtt', roles: ['subtitle'], accessibility: [], url: '/captions/native-missing.vtt', supported: true },
      ],
      activeTextTrackId: '',
      textTrackVisibility: false,
      textCueCache: {},
      textLoadStates: {},
      getTextTracks: window.NativeDashProviderForTest.getTextTracks,
      getActiveTextTrack: window.NativeDashProviderForTest.getActiveTextTrack,
      selectTextTrack: window.NativeDashProviderForTest.selectTextTrack,
      setTextTrackVisibility: window.NativeDashProviderForTest.setTextTrackVisibility,
      getActiveVariantTrack: window.NativeDashProviderForTest.getActiveVariantTrack,
      getStats: window.NativeDashProviderForTest.getStats,
    };
    engine._provider = provider;
    const player = engine.getPlayer();
    await player.selectTextTrack(player.getTextTracks()[0]);
    return {
      active: player.getActiveTextTrack(),
      overlayText: document.querySelector('.custom-caption-container').textContent,
      fallbackReason: engine._fallbackReason || '',
      lastTextTrackError: provider.lastTextTrackError,
      stats: player.getStats(),
    };
  });

  expect(state.active).toMatchObject({ id: 'dash-missing', active: true, loadState: 'error' });
  expect(state.overlayText).toBe('');
  expect(shakaRequests).toHaveLength(0);
  expect(state.fallbackReason).toBe('');
  expect(state.lastTextTrackError).toBe('http-404');
  expect(state.stats.provider).toBe('native-dash');
  expect(state.stats.fallbackReason).toBe('');
  expect(state.stats.textTrackCount).toBe(1);
  expect(state.stats.nativeTextTrackCount).toBe(1);
  expect(state.stats.lastTextTrackError).toBe('http-404');
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
  await expectFirstPartyNativePlayback(page, { provider: 'native-dash', mode: 'dash' });
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
  await expectFirstPartyNativePlayback(page, { provider: 'native-dash', mode: 'dash' });
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
  await expectFirstPartyNativePlayback(page, { provider: 'native-dash', mode: 'dash' });
  expect(shakaRequests).toHaveLength(0);
});

test('native DASH live number-template fixture plays without Shaka fallback', async ({ page }) => {
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
    return engine.init().then(() => engine.load('/api/stream/PLAYERTEST1/dash.mpd?fixtureLive=number'));
  });

  await expect.poll(() => page.evaluate(() => window._playerProvider)).toBe('native-dash');
  await page.evaluate(() => document.getElementById('player').play());
  await page.waitForFunction(() => document.getElementById('player').buffered.length > 0, null, { timeout: 10_000 });

  const state = await page.evaluate(() => {
    window.__player.seekToLiveEdge();
    return {
      stats: window.__player.getStats(),
      currentTime: document.getElementById('player').currentTime,
    };
  });
  expect(state.stats.isLive).toBe(true);
  expect(state.stats.liveWindowEnd).toBeGreaterThan(state.stats.liveWindowStart);
  expect(state.stats.liveLatency).toBeGreaterThanOrEqual(0);
  expect(state.stats.manifestCompatibilityWarnings).toContain('dynamic-number-template-window-derived');
  expect(state.currentTime).toBeGreaterThanOrEqual(state.stats.liveWindowStart);
  await expectFirstPartyNativePlayback(page, { provider: 'native-dash', mode: 'dash' });
  expect(shakaRequests).toHaveLength(0);
  expect(logs.some(line => line.includes('falling back to shaka'))).toBe(false);
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
  await expectFirstPartyNativePlayback(page, { provider: 'native-dash', mode: 'dash' });
  expect(shakaRequests).toHaveLength(0);
  expect(logs.some(line => line.includes('falling back to shaka'))).toBe(false);
});

test('native DASH period codec transition fixture plays without Shaka fallback', async ({ page }) => {
  const shakaRequests = [];
  const logs = [];
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.abort();
  });
  page.on('console', msg => logs.push(msg.text()));

  await page.goto('/auth/login');
  await page.setContent('<video id="player" muted playsinline style="width:1280px;height:720px"></video>');
  await page.addScriptTag({ path: 'public/native-player-engine.js' });

  await page.evaluate(() => {
    const video = document.getElementById('player');
    video.muted = true;
    const engine = new window.PlayerEngine(video, { videoId: 'PLAYERTEST1', streamToken: '' });
    window.__engine = engine;
    window.__player = engine.getPlayer();
    window.__player.configure({ streaming: { bufferingGoal: 4, startupBufferGoal: 2, maxConcurrentRequests: 2 } });
    return engine.init().then(() => engine.load('/api/stream/PLAYERTEST1/dash.mpd?fixturePeriodCodec=1'));
  });

  await expect.poll(() => page.evaluate(() => window._playerProvider)).toBe('native-dash');
  await page.evaluate(() => document.getElementById('player').play());
  await page.waitForFunction(() => document.getElementById('player').currentTime > 2.4, null, { timeout: 12_000 });

  const stats = await page.evaluate(() => window.__player.getStats());
  expect(stats.provider).toBe('native-dash');
  expect(stats.periodCount).toBe(2);
  expect(stats.manifestCompatibilityWarnings).toContain('dash-multiperiod-codec-transition');
  expect(stats.fallbackReason).toBe('');
  await expectFirstPartyNativePlayback(page, { provider: 'native-dash', mode: 'dash' });
  expect(shakaRequests).toHaveLength(0);
  expect(logs.some(line => line.includes('falling back to shaka'))).toBe(false);
});

test('native DASH sliding live fixture advances its manifest window', async ({ page }) => {
  const shakaRequests = await blockShakaScript(page);
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
  expect(shakaRequests).toHaveLength(0);
});

test('native DASH number-template live fixture advances its generated window', async ({ page }) => {
  const shakaRequests = await blockShakaScript(page);
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const windows = await page.evaluate(async () => {
    const key = 'n' + Date.now() + Math.random();
    const firstText = await fetch('/api/stream/PLAYERTEST1/dash.mpd?fixtureLive=number-sliding&fixtureLiveKey=' + key).then(resp => resp.text());
    const secondText = await fetch('/api/stream/PLAYERTEST1/dash.mpd?fixtureLive=number-sliding&fixtureLiveKey=' + key).then(resp => resp.text());
    const first = window.NativeDashProviderForTest.parseMPD(firstText, location.origin + '/api/stream/PLAYERTEST1/dash.mpd');
    const second = window.NativeDashProviderForTest.parseMPD(secondText, location.origin + '/api/stream/PLAYERTEST1/dash.mpd');
    return [first, second].map(item => ({
      liveWindow: item.liveWindow,
      urls: item.video[0].templateSegments.map(seg => seg.url),
      warnings: item.warnings,
    }));
  });

  expect(windows[0].warnings).toEqual(['dynamic-number-template-window-derived']);
  expect(windows[1].liveWindow.start).toBeGreaterThanOrEqual(windows[0].liveWindow.start);
  expect(windows[1].liveWindow.end).toBeGreaterThan(windows[0].liveWindow.end);
  expect(windows[1].urls.at(-1)).not.toBe(windows[0].urls.at(-1));
  expect(shakaRequests).toHaveLength(0);
});

test('native DASH live refresh merges a sliding window without fallback', async ({ page }) => {
  const shakaRequests = await blockShakaScript(page);
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
  expect(shakaRequests).toHaveLength(0);
});

test('native DASH live refresh preserves period codec generation metadata', async ({ page }) => {
  const shakaRequests = await blockShakaScript(page);
  const manifest = includeCodecPeriod => `<?xml version="1.0"?><MPD type="dynamic" availabilityStartTime="2026-05-04T00:00:00Z" minimumUpdatePeriod="PT1S" timeShiftBufferDepth="PT8S">
<Period id="p0" start="PT0S" duration="PT2S">
<AdaptationSet mimeType="video/mp4"><SegmentTemplate timescale="1000" initialization="/i/$RepresentationID$" media="/v/$Time$"><SegmentTimeline><S t="0" d="2000"/></SegmentTimeline></SegmentTemplate>
<Representation id="v1" bandwidth="800000" width="640" height="360" codecs="avc1.42c01f"/></AdaptationSet>
<AdaptationSet mimeType="audio/mp4"><SegmentTemplate timescale="1000" initialization="/ai/$RepresentationID$" media="/a/$Time$"><SegmentTimeline><S t="0" d="2000"/></SegmentTimeline></SegmentTemplate>
<Representation id="a1" bandwidth="64000" codecs="mp4a.40.2"/></AdaptationSet>
</Period>
${includeCodecPeriod ? `<Period id="p1" start="PT2S" duration="PT2S">
<AdaptationSet mimeType="video/mp4"><SegmentTemplate timescale="1000" presentationTimeOffset="2000" initialization="/i2/$RepresentationID$" media="/v2/$Time$"><SegmentTimeline><S t="2000" d="2000"/></SegmentTimeline></SegmentTemplate>
<Representation id="v1" bandwidth="800000" width="640" height="360" codecs="avc1.4d401f"/></AdaptationSet>
<AdaptationSet mimeType="audio/mp4"><SegmentTemplate timescale="1000" presentationTimeOffset="2000" initialization="/ai/$RepresentationID$" media="/a2/$Time$"><SegmentTimeline><S t="2000" d="2000"/></SegmentTimeline></SegmentTemplate>
<Representation id="a1" bandwidth="64000" codecs="mp4a.40.2"/></AdaptationSet>
</Period>` : ''}
</MPD>`;

  await page.route('**/live-codec.mpd**', route => {
    route.fulfill({
      status: 200,
      contentType: 'application/dash+xml',
      body: manifest(true),
    });
  });

  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const state = await page.evaluate(firstManifest => {
    const first = window.NativeDashProviderForTest.parseMPD(firstManifest, location.origin + '/live-codec.mpd');
    const videoRep = first.video[0];
    const audioRep = first.audio[0];
    videoRep.segments = videoRep.templateSegments.slice();
    audioRep.segments = audioRep.templateSegments.slice();
    videoRep.segments[0].appended = true;
    videoRep.segments[0].state = 'appended';
    const provider = {
      manifestUrl: '/live-codec.mpd',
      manifestText: '',
      live: true,
      destroyed: false,
      videoReps: [videoRep],
      audioReps: [audioRep],
      activeVideo: videoRep,
      audio: audioRep,
      liveWindow: first.liveWindow,
      minimumUpdatePeriod: 1,
      manifestCompatibilityWarnings: [],
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
      warnings: provider.manifestCompatibilityWarnings,
      generations: provider.videoReps[0].periodGenerations.map(gen => ({ periodIndex: gen.periodIndex, codecs: gen.codecs, initPath: new URL(gen.initUrl).pathname })),
      segments: provider.videoReps[0].segments.map(seg => ({ start: seg.start, codecs: seg.codecs, initPath: new URL(seg.initUrl).pathname, appended: !!seg.appended, state: seg.state || 'pending' })),
      ticked: !!provider.ticked,
    }));
  }, manifest(false));

  expect(state.refreshCount).toBe(1);
  expect(state.warnings).toContain('dash-multiperiod-codec-transition');
  expect(state.generations).toEqual([
    { periodIndex: 0, codecs: 'avc1.42c01f', initPath: '/i/v1' },
    { periodIndex: 1, codecs: 'avc1.4d401f', initPath: '/i2/v1' },
  ]);
  expect(state.segments).toEqual([
    { start: 0, codecs: 'avc1.42c01f', initPath: '/i/v1', appended: true, state: 'appended' },
    { start: 2, codecs: 'avc1.4d401f', initPath: '/i2/v1', appended: false, state: 'pending' },
  ]);
  expect(state.ticked).toBe(true);
  expect(shakaRequests).toHaveLength(0);
});

test('native live adapters expose live range and seek to live edge through lifecycle', async ({ page }) => {
  const shakaRequests = await blockShakaScript(page);
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const state = await page.evaluate(() => {
    function makeVideo() {
      const video = document.getElementById('player').cloneNode();
      let currentTime = 0;
      Object.defineProperty(video, 'currentTime', {
        configurable: true,
        get() { return currentTime; },
        set(value) { currentTime = value; },
      });
      Object.defineProperty(video, 'buffered', {
        configurable: true,
        get() { return { length: 0, start() { return 0; }, end() { return 0; } }; },
      });
      return video;
    }
    function engineFor(states) {
      return {
        _serverDown: false,
        _setState(state) { states.push(state); },
        _telemetry: { record() {} },
        _player: { config: { streaming: { bufferingGoal: 8, seekBufferGoal: 3 }, manifest: {} } },
      };
    }
    const dashStates = [];
    const dash = {
      live: true,
      liveWindow: { start: 20, end: 40 },
      video: makeVideo(),
      destroyed: false,
      activeVideo: { id: 'v', segments: [{ start: 34, end: 36, state: 'idle' }] },
      audio: { id: 'a', segments: [{ start: 34, end: 36, state: 'idle' }] },
      controllers: [],
      activeRanges: {},
      requestGeneration: 0,
      requestCancellationCount: 0,
      pendingSeek: 0,
      seekBufferPending: false,
      seekBufferReadyCount: 0,
      seekCount: 0,
      seekAbortCount: 0,
      lastSeekTarget: 0,
      liveLatency: 0,
      atLiveEdge: false,
      engine: engineFor(dashStates),
      isLive() { return true; },
      getLiveRange: window.NativeDashProviderForTest.getLiveRange,
      seekToLiveEdge: window.NativeDashProviderForTest.seekToLiveEdge,
      commitSeek: window.NativeDashProviderForTest.commitSeek,
      beginSeek: window.NativeDashProviderForTest.beginSeek,
      _onSeek: window.NativeDashProviderForTest._onSeek,
      _clampSeekTarget: window.NativeDashProviderForTest._clampSeekTarget,
      _availabilityWindowOverride: window.NativeDashProviderForTest._availabilityWindowOverride,
      _effectiveLiveWindow: window.NativeDashProviderForTest._effectiveLiveWindow,
      _seekBufferGoal: window.NativeDashProviderForTest._seekBufferGoal,
      _bufferAheadGoal: window.NativeDashProviderForTest._bufferAheadGoal,
      _abortRequests: window.NativeDashProviderForTest._abortRequests,
      _updateLiveWindowFromReps() {},
      _updateLivePositionStats: window.NativeDashProviderForTest._updateLivePositionStats,
      _tick(force) { this.ticked = force; },
    };
    const hlsStates = [];
    const hls = {
      live: true,
      liveWindow: { start: 50, end: 80 },
      video: makeVideo(),
      destroyed: false,
      segments: [{ start: 74, end: 76, state: 'idle' }],
      activeAudio: { id: 'aud', segments: [{ start: 74, end: 76, state: 'idle' }] },
      controllers: [],
      activeRanges: {},
      seekBufferPending: false,
      seekBufferReadyCount: 0,
      seekCount: 0,
      seekAbortCount: 0,
      lastSeekTarget: 0,
      liveLatency: 0,
      atLiveEdge: false,
      engine: engineFor(hlsStates),
      isLive() { return true; },
      getLiveRange: window.NativeHlsProviderForTest.getLiveRange,
      seekToLiveEdge: window.NativeHlsProviderForTest.seekToLiveEdge,
      commitSeek: window.NativeHlsProviderForTest.commitSeek,
      beginSeek: window.NativeHlsProviderForTest.beginSeek,
      _onSeek: window.NativeHlsProviderForTest._onSeek,
      _clampSeekTarget: window.NativeHlsProviderForTest._clampSeekTarget,
      _seekBufferGoal: window.NativeHlsProviderForTest._seekBufferGoal,
      _bufferAheadGoal: window.NativeDashProviderForTest._bufferAheadGoal,
      _abortRequests: window.NativeHlsProviderForTest._abortRequests,
      _tick(force) { this.ticked = force; },
    };
    window.NativeDashProviderForTest.seekToLiveEdge.call(dash);
    window.NativeHlsProviderForTest.seekToLiveEdge.call(hls);
    return {
      dash: {
        range: window.NativeDashProviderForTest.getLiveRange.call(dash),
        currentTime: dash.video.currentTime,
        seekCount: dash.seekCount,
        seekBufferPending: dash.seekBufferPending,
        lastSeekTarget: dash.lastSeekTarget,
        liveLatency: dash.liveLatency,
        atLiveEdge: dash.atLiveEdge,
        states: dashStates,
        ticked: dash.ticked,
      },
      hls: {
        range: window.NativeHlsProviderForTest.getLiveRange.call(hls),
        currentTime: hls.video.currentTime,
        seekCount: hls.seekCount,
        seekBufferPending: hls.seekBufferPending,
        lastSeekTarget: hls.lastSeekTarget,
        states: hlsStates,
        ticked: hls.ticked,
      },
    };
  });

  expect(state.dash.range).toEqual({ start: 20, end: 40 });
  expect(state.dash.currentTime).toBe(34);
  expect(state.dash.seekCount).toBe(1);
  expect(state.dash.seekBufferPending).toBe(true);
  expect(state.dash.lastSeekTarget).toBe(34);
  expect(state.dash.liveLatency).toBe(6);
  expect(state.dash.atLiveEdge).toBe(true);
  expect(state.dash.states).toContain('seeking');
  expect(state.dash.ticked).toBe(true);

  expect(state.hls.range).toEqual({ start: 50, end: 80 });
  expect(state.hls.currentTime).toBe(74);
  expect(state.hls.seekCount).toBe(1);
  expect(state.hls.seekBufferPending).toBe(true);
  expect(state.hls.lastSeekTarget).toBe(74);
  expect(state.hls.states).toContain('seeking');
  expect(state.hls.ticked).toBe(true);
  expect(shakaRequests).toHaveLength(0);
});

test('native DASH jumps small buffered gaps before stall fallback', async ({ page }) => {
  const shakaRequests = await blockShakaScript(page);
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
  expect(state.stats.fallbackReason).toBe('');
  expect(shakaRequests).toHaveLength(0);
});

test('native DASH does not jump large buffered gaps', async ({ page }) => {
  const shakaRequests = await blockShakaScript(page);
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
  expect(shakaRequests).toHaveLength(0);
});

test('native DASH applies append windows and skips expired live segments', async ({ page }) => {
  const shakaRequests = await blockShakaScript(page);
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
  expect(shakaRequests).toHaveLength(0);
});

test('native DASH ClearKey DRM initializes EME and answers license messages', async ({ page }) => {
  const shakaRequests = await blockShakaScript(page);
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const state = await page.evaluate(async () => {
    const originalAccess = navigator.requestMediaKeySystemAccess;
    let requestedKeySystem = '';
    let requestedConfig = null;
    let sessionUpdate = '';
    const video = document.getElementById('player');
    video.setMediaKeys = keys => {
      video.__mediaKeys = keys;
      return Promise.resolve();
    };
    navigator.requestMediaKeySystemAccess = (keySystem, configs) => {
      requestedKeySystem = keySystem;
      requestedConfig = configs[0];
      return Promise.resolve({
        createMediaKeys() {
          return Promise.resolve({
            createSession() {
              const listeners = {};
              return {
                addEventListener(type, fn) { listeners[type] = fn; },
                generateRequest() {
                  listeners.message({ message: new Uint8Array([1, 2, 3]).buffer });
                  return Promise.resolve();
                },
                update(payload) {
                  sessionUpdate = new TextDecoder().decode(payload);
                  return Promise.resolve();
                },
                close() { return Promise.resolve(); },
              };
            },
          });
        },
      });
    };
    try {
      const engine = new window.PlayerEngine(video, { videoId: 'TESTVIDEO01', streamToken: 'test-token' });
      const player = engine.getPlayer();
      window.__player = player;
      player.configure({
        drm: {
          clearKeys: {
            '00112233445566778899aabbccddeeff': 'ffeeddccbbaa99887766554433221100',
          },
        },
      });
      const provider = {
        engine,
        video,
        name: 'native-dash',
        manifestUrl: '/clearkey.mpd',
        live: false,
        bandwidth: 0,
        bandwidthSamples: 0,
        activeRanges: {},
        videoSb: null,
        audioSb: null,
        videoReps: [],
        audioReps: [],
        textReps: [],
        timelineRegions: [],
        activeVideo: { id: 'v1', kind: 'video', mimeType: 'video/mp4', codecs: 'avc1.42c01f', drmInfos: [{ keySystem: 'org.w3.clearkey', defaultKid: '00112233445566778899aabbccddeeff' }] },
        audio: { id: 'a1', kind: 'audio', mimeType: 'audio/mp4', codecs: 'mp4a.40.2', drmInfos: [{ keySystem: 'org.w3.clearkey', defaultKid: '00112233445566778899aabbccddeeff' }] },
        drmSessions: [],
        drmSessionCount: 0,
        drmLicenseRequestCount: 0,
        lastDrmError: '',
        getStats: window.NativeDashProviderForTest.getStats,
        getActiveVariantTrack: window.NativeDashProviderForTest.getActiveVariantTrack,
        getTextTracks: () => [],
        _ensureDrmReady: window.NativeDashProviderForTest._ensureDrmReady,
        _onEncrypted: window.NativeDashProviderForTest._onEncrypted,
        _handleDrmMessage: window.NativeDashProviderForTest._handleDrmMessage,
      };
      engine._provider = provider;
      await provider._ensureDrmReady();
      provider._onEncrypted({ initDataType: 'cenc', initData: new Uint8Array([9]).buffer });
      await new Promise(resolve => setTimeout(resolve, 0));
      return {
        requestedKeySystem,
        requestedConfig,
        hasMediaKeys: !!video.__mediaKeys,
        sessionCount: provider.drmSessionCount,
        requestCount: provider.drmLicenseRequestCount,
        lastDrmError: provider.lastDrmError,
        sessionUpdate: JSON.parse(sessionUpdate),
        stats: player.getStats(),
      };
    } finally {
      navigator.requestMediaKeySystemAccess = originalAccess;
    }
  });

  expect(state.requestedKeySystem).toBe('org.w3.clearkey');
  expect(state.requestedConfig.videoCapabilities[0].contentType).toBe('video/mp4; codecs="avc1.42c01f"');
  expect(state.hasMediaKeys).toBe(true);
  expect(state.sessionCount).toBe(1);
  expect(state.requestCount).toBe(1);
  expect(state.lastDrmError).toBe('');
  expect(state.sessionUpdate).toEqual({
    keys: [{ kty: 'oct', kid: 'ABEiM0RVZneImaq7zN3u_w', k: '_-7dzLuqmYh3ZlVEMyIRAA' }],
  });
  expect(state.stats.drmKeySystem).toBe('org.w3.clearkey');
  expect(state.stats.drmSessionCount).toBe(1);
  expect(state.stats.drmLicenseRequestCount).toBe(1);
  expect(state.stats.fallbackReason).toBe('');
  expect(shakaRequests).toHaveLength(0);
});

test('native DASH configured Widevine DRM initializes EME and requests licenses natively', async ({ page }) => {
  const shakaRequests = await blockShakaScript(page);
  const licenseRequests = [];
  await page.route('**/widevine-license', async route => {
    licenseRequests.push({
      header: route.request().headers()['x-widevine-filter'],
      body: await route.request().postDataBuffer(),
    });
    route.fulfill({
      status: 200,
      contentType: 'application/octet-stream',
      body: Buffer.from([7, 8, 9, 10]),
    });
  });

  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const state = await page.evaluate(async () => {
    const originalAccess = navigator.requestMediaKeySystemAccess;
    let requestedKeySystem = '';
    let requestedConfig = null;
    let sessionUpdate = [];
    let resolveUpdate;
    const updatePromise = new Promise(resolve => { resolveUpdate = resolve; });
    const video = document.getElementById('player');
    video.setMediaKeys = keys => {
      video.__mediaKeys = keys;
      return Promise.resolve();
    };
    navigator.requestMediaKeySystemAccess = (keySystem, configs) => {
      requestedKeySystem = keySystem;
      requestedConfig = configs[0];
      return Promise.resolve({
        createMediaKeys() {
          return Promise.resolve({
            createSession() {
              const listeners = {};
              return {
                addEventListener(type, fn) { listeners[type] = fn; },
                generateRequest() {
                  listeners.message({ message: new Uint8Array([1, 2, 3, 4]).buffer });
                  return Promise.resolve();
                },
                update(payload) {
                  sessionUpdate = Array.from(new Uint8Array(payload));
                  resolveUpdate();
                  return Promise.resolve();
                },
                close() { return Promise.resolve(); },
              };
            },
          });
        },
      });
    };
    try {
      const engine = new window.PlayerEngine(video, { videoId: 'TESTVIDEO01', streamToken: 'test-token' });
      const player = engine.getPlayer();
      window.__player = player;
      player.configure({
        drm: {
          servers: {
            'com.widevine.alpha': '/widevine-license',
          },
        },
      });
      player.getNetworkingEngine().registerRequestFilter((type, request) => {
        if (type === 'LICENSE') request.headers['X-Widevine-Filter'] = '1';
      });
      const provider = {
        engine,
        video,
        name: 'native-dash',
        manifestUrl: '/widevine.mpd',
        live: false,
        bandwidth: 0,
        bandwidthSamples: 0,
        activeRanges: {},
        videoSb: null,
        audioSb: null,
        videoReps: [],
        audioReps: [],
        textReps: [],
        timelineRegions: [],
        activeVideo: { id: 'v1', kind: 'video', mimeType: 'video/mp4', codecs: 'avc1.42c01f', drmInfos: [{ keySystem: 'com.widevine.alpha', defaultKid: '00112233445566778899aabbccddeeff' }] },
        audio: { id: 'a1', kind: 'audio', mimeType: 'audio/mp4', codecs: 'mp4a.40.2', drmInfos: [{ keySystem: 'com.widevine.alpha', defaultKid: '00112233445566778899aabbccddeeff' }] },
        drmSessions: [],
        drmSessionCount: 0,
        drmLicenseRequestCount: 0,
        lastDrmError: '',
        getStats: window.NativeDashProviderForTest.getStats,
        getActiveVariantTrack: window.NativeDashProviderForTest.getActiveVariantTrack,
        getTextTracks: () => [],
        _ensureDrmReady: window.NativeDashProviderForTest._ensureDrmReady,
        _onEncrypted: window.NativeDashProviderForTest._onEncrypted,
        _handleDrmMessage: window.NativeDashProviderForTest._handleDrmMessage,
      };
      engine._provider = provider;
      await provider._ensureDrmReady();
      provider._onEncrypted({ initDataType: 'cenc', initData: new Uint8Array([9]).buffer });
      await updatePromise;
      return {
        requestedKeySystem,
        requestedConfig,
        hasMediaKeys: !!video.__mediaKeys,
        sessionCount: provider.drmSessionCount,
        requestCount: provider.drmLicenseRequestCount,
        lastDrmError: provider.lastDrmError,
        sessionUpdate,
        stats: player.getStats(),
      };
    } finally {
      navigator.requestMediaKeySystemAccess = originalAccess;
    }
  });

  expect(licenseRequests).toHaveLength(1);
  expect(licenseRequests[0].header).toBe('1');
  expect([...licenseRequests[0].body]).toEqual([1, 2, 3, 4]);
  expect(state.requestedKeySystem).toBe('com.widevine.alpha');
  expect(state.requestedConfig.videoCapabilities[0].contentType).toBe('video/mp4; codecs="avc1.42c01f"');
  expect(state.hasMediaKeys).toBe(true);
  expect(state.sessionCount).toBe(1);
  expect(state.requestCount).toBe(1);
  expect(state.lastDrmError).toBe('');
  expect(state.sessionUpdate).toEqual([7, 8, 9, 10]);
  expect(state.stats.drmKeySystem).toBe('com.widevine.alpha');
  expect(state.stats.drmLicenseServerConfigured).toBe(true);
  expect(state.stats.drmSessionCount).toBe(1);
  expect(state.stats.drmLicenseRequestCount).toBe(1);
  expect(state.stats.networkingLicenseRequestCount).toBe(1);
  expect(state.stats.fallbackReason).toBe('');
  await expectFirstPartyNativePlayback(page, { provider: 'native-dash', mode: 'dash', drmKeySystem: 'com.widevine.alpha' });
  expect(shakaRequests).toHaveLength(0);
});

test('native DASH DRM generateRequest failure stays native with explicit terminal reason', async ({ page }) => {
  const shakaRequests = [];
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.abort();
  });

  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const state = await page.evaluate(async () => {
    const video = document.getElementById('player');
    const engine = new window.PlayerEngine(video, { videoId: 'TESTVIDEO01', streamToken: 'test-token' });
    const player = engine.getPlayer();
    const provider = {
      engine,
      video,
      name: 'native-dash',
      manifestUrl: '/drm.mpd',
      live: false,
      rebufferDuration: 0,
      activeRanges: {},
      videoReps: [],
      audioReps: [],
      textReps: [],
      timelineRegions: [],
      activeVideo: { id: 'v1', kind: 'video', mimeType: 'video/mp4', codecs: 'avc1.42c01f' },
      audio: { id: 'a1', kind: 'audio', mimeType: 'audio/mp4', codecs: 'mp4a.40.2' },
      drmInfo: { keySystem: 'com.widevine.alpha', licenseServerUrl: '/widevine-license' },
      drmSessions: [],
      drmSessionCount: 0,
      drmLicenseRequestCount: 0,
      lastDrmError: '',
      mediaKeys: {
        createSession() {
          return {
            addEventListener() {},
            generateRequest() { return Promise.reject(new Error('dash-drm-request-failed')); },
            close() { return Promise.resolve(); },
          };
        },
      },
      _completeDrmTerminalError: window.NativeDashProviderForTest._completeDrmTerminalError,
      _onEncrypted: window.NativeDashProviderForTest._onEncrypted,
      getActiveVariantTrack: window.NativeDashProviderForTest.getActiveVariantTrack,
      getStats: window.NativeDashProviderForTest.getStats,
    };
    engine._providerName = 'native-dash';
    engine._provider = provider;
    window.__player = player;
    provider._onEncrypted({ initDataType: 'cenc', initData: new Uint8Array([9]).buffer });
    await new Promise(resolve => setTimeout(resolve, 0));
    return player.getStats();
  });

  expect(shakaRequests).toHaveLength(0);
  expect(state.provider).toBe('native-dash');
  expect(state.fallbackReason).toBe('');
  expect(state.drmKeySystem).toBe('com.widevine.alpha');
  expect(state.drmSessionCount).toBe(1);
  expect(state.drmLicenseRequestCount).toBe(0);
  expect(state.lastDrmError).toBe('dash-drm-request-failed');
  expect(state.lastError).toBe('dash-drm-request-failed');
  expect(state.fatalError).toBe('dash-drm-request-failed');
  expect(state.nativeUnsupportedReason).toBe('dash-drm-request-failed');
});

test('native DASH DRM license update failure stays native with explicit terminal reason', async ({ page }) => {
  const shakaRequests = [];
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.abort();
  });
  await page.route('**/widevine-license-fail-update', route => {
    route.fulfill({
      status: 200,
      contentType: 'application/octet-stream',
      body: Buffer.from([7, 8, 9, 10]),
    });
  });

  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const state = await page.evaluate(async () => {
    const video = document.getElementById('player');
    const engine = new window.PlayerEngine(video, { videoId: 'TESTVIDEO01', streamToken: 'test-token' });
    const player = engine.getPlayer();
    const listeners = {};
    let resolveTerminal;
    const terminalPromise = new Promise(resolve => { resolveTerminal = resolve; });
    const provider = {
      engine,
      video,
      name: 'native-dash',
      manifestUrl: '/drm.mpd',
      live: false,
      rebufferDuration: 0,
      activeRanges: {},
      videoReps: [],
      audioReps: [],
      textReps: [],
      timelineRegions: [],
      activeVideo: { id: 'v1', kind: 'video', mimeType: 'video/mp4', codecs: 'avc1.42c01f' },
      audio: { id: 'a1', kind: 'audio', mimeType: 'audio/mp4', codecs: 'mp4a.40.2' },
      drmInfo: { keySystem: 'com.widevine.alpha', licenseServerUrl: '/widevine-license-fail-update' },
      drmSessions: [],
      drmSessionCount: 0,
      drmLicenseRequestCount: 0,
      lastDrmError: '',
      mediaKeys: {
        createSession() {
          return {
            addEventListener(type, fn) { listeners[type] = fn; },
            generateRequest() {
              listeners.message({ message: new Uint8Array([1, 2, 3, 4]).buffer });
              return Promise.resolve();
            },
            update() { return Promise.reject(new Error('dash-drm-license-failed')); },
            close() { return Promise.resolve(); },
          };
        },
      },
      _completeDrmTerminalError(reason) {
        window.NativeDashProviderForTest._completeDrmTerminalError.call(this, reason);
        resolveTerminal();
      },
      _onEncrypted: window.NativeDashProviderForTest._onEncrypted,
      _handleDrmMessage: window.NativeDashProviderForTest._handleDrmMessage,
      getActiveVariantTrack: window.NativeDashProviderForTest.getActiveVariantTrack,
      getStats: window.NativeDashProviderForTest.getStats,
    };
    engine._providerName = 'native-dash';
    engine._provider = provider;
    window.__player = player;
    provider._onEncrypted({ initDataType: 'cenc', initData: new Uint8Array([9]).buffer });
    await terminalPromise;
    return player.getStats();
  });

  expect(shakaRequests).toHaveLength(0);
  expect(state.provider).toBe('native-dash');
  expect(state.fallbackReason).toBe('');
  expect(state.drmKeySystem).toBe('com.widevine.alpha');
  expect(state.drmSessionCount).toBe(1);
  expect(state.drmLicenseRequestCount).toBe(1);
  expect(state.networkingLicenseRequestCount).toBe(1);
  expect(state.lastDrmError).toBe('dash-drm-license-failed');
  expect(state.lastError).toBe('dash-drm-license-failed');
  expect(state.fatalError).toBe('dash-drm-license-failed');
  expect(state.nativeUnsupportedReason).toBe('dash-drm-license-failed');
});

test('native DASH configured Widevine DRM loads through player path without Shaka fallback', async ({ page }) => {
  const shakaRequests = [];
  const licenseRequests = [];
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.abort();
  });
  await page.route('**/widevine-license', async route => {
    licenseRequests.push({
      header: route.request().headers()['x-widevine-filter'],
      body: await route.request().postDataBuffer(),
    });
    route.fulfill({
      status: 200,
      contentType: 'application/octet-stream',
      body: Buffer.from([7, 8, 9, 10]),
    });
  });

  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player" muted playsinline style="width:1280px;height:720px"></video>');

  const fixtureMpd = await (await page.request.get('/api/stream/PLAYERTEST1/dash.mpd')).text();
  const widevineProtection = '<ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/>';
  const drmMpd = fixtureMpd
    .replace(/(<AdaptationSet mimeType="video\/mp4"[^>]*>)/, `$1\n${widevineProtection}`)
    .replace(/(<AdaptationSet mimeType="audio\/mp4"[^>]*>)/, `$1\n${widevineProtection}`);
  await page.route('**/widevine-player.mpd', route => {
    route.fulfill({
      status: 200,
      contentType: 'application/dash+xml',
      body: drmMpd,
    });
  });

  const state = await page.evaluate(async () => {
    const originalAccess = navigator.requestMediaKeySystemAccess;
    let requestedKeySystem = '';
    let requestedConfig = null;
    let sessionUpdate = [];
    let resolveUpdate;
    const updatePromise = new Promise(resolve => { resolveUpdate = resolve; });
    const video = document.getElementById('player');
    video.muted = true;
    video.setMediaKeys = keys => {
      video.__mediaKeys = keys;
      return Promise.resolve();
    };
    navigator.requestMediaKeySystemAccess = (keySystem, configs) => {
      requestedKeySystem = keySystem;
      requestedConfig = configs[0];
      return Promise.resolve({
        createMediaKeys() {
          return Promise.resolve({
            createSession() {
              const listeners = {};
              return {
                addEventListener(type, fn) { listeners[type] = fn; },
                generateRequest() {
                  listeners.message({ message: new Uint8Array([1, 2, 3, 4]).buffer });
                  return Promise.resolve();
                },
                update(payload) {
                  sessionUpdate = Array.from(new Uint8Array(payload));
                  resolveUpdate();
                  return Promise.resolve();
                },
                close() { return Promise.resolve(); },
              };
            },
          });
        },
      });
    };

    try {
      const engine = new window.PlayerEngine(video, { videoId: 'PLAYERTEST1', streamToken: '' });
      const player = engine.getPlayer();
      window.__engine = engine;
      window.__player = player;
      player.configure({
        drm: {
          servers: {
            'com.widevine.alpha': '/widevine-license',
          },
        },
        streaming: { bufferingGoal: 2, startupBufferGoal: 1, maxConcurrentRequests: 1 },
      });
      player.getNetworkingEngine().registerRequestFilter((type, request) => {
        if (type === 'LICENSE') request.headers['X-Widevine-Filter'] = '1';
      });

      await engine.init();
      await engine.load('/widevine-player.mpd');
      const encryptedEvent = new Event('encrypted');
      Object.defineProperty(encryptedEvent, 'initDataType', { value: 'cenc' });
      Object.defineProperty(encryptedEvent, 'initData', { value: new Uint8Array([9]).buffer });
      video.dispatchEvent(encryptedEvent);
      await updatePromise;
      return {
        provider: window._playerProvider,
        requestedKeySystem,
        requestedConfig,
        hasMediaKeys: !!video.__mediaKeys,
        sessionUpdate,
        stats: player.getStats(),
      };
    } finally {
      navigator.requestMediaKeySystemAccess = originalAccess;
    }
  });

  expect(state.provider).toBe('native-dash');
  expect(state.requestedKeySystem).toBe('com.widevine.alpha');
  expect(state.requestedConfig.videoCapabilities[0].contentType).toBe('video/mp4; codecs="avc1.42c01f"');
  expect(state.hasMediaKeys).toBe(true);
  expect(state.sessionUpdate).toEqual([7, 8, 9, 10]);
  expect(state.stats.drmKeySystem).toBe('com.widevine.alpha');
  expect(state.stats.drmLicenseServerConfigured).toBe(true);
  expect(state.stats.drmSessionCount).toBe(1);
  expect(state.stats.drmLicenseRequestCount).toBe(1);
  expect(state.stats.networkingLicenseRequestCount).toBe(1);
  await expectFirstPartyNativePlayback(page, { provider: 'native-dash', mode: 'dash', drmKeySystem: 'com.widevine.alpha' });
  expect(licenseRequests).toHaveLength(1);
  expect(licenseRequests[0].header).toBe('1');
  expect([...licenseRequests[0].body]).toEqual([1, 2, 3, 4]);
  expect(shakaRequests).toHaveLength(0);
});

test('DRM DASH manifest stays native with explicit unconfigured Widevine reason', async ({ page }) => {
  const shakaRequests = [];
  await page.route('**/api/stream/DRMTEST0001/dash.mpd**', route => {
    route.fulfill({
      status: 200,
      contentType: 'application/dash+xml',
      body: `<?xml version="1.0"?><MPD type="static" mediaPresentationDuration="PT1S"><Period>
<AdaptationSet mimeType="video/mp4"><ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/><Representation id="v" bandwidth="1" codecs="avc1.42c01f"><BaseURL>/x</BaseURL><SegmentBase indexRange="0-1"><Initialization range="0-1"/></SegmentBase></Representation></AdaptationSet>
<AdaptationSet mimeType="audio/mp4"><Representation id="a" bandwidth="1" codecs="mp4a.40.2"><BaseURL>/a</BaseURL><SegmentBase indexRange="0-1"><Initialization range="0-1"/></SegmentBase></Representation></AdaptationSet>
</Period></MPD>`,
    });
  });
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.abort();
  });

  await page.goto('/auth/login');
  await page.setContent('<video id="player"></video>');
  await page.addScriptTag({ path: 'public/native-player-engine.js' });

  const stats = await page.evaluate(() => {
    const engine = new window.PlayerEngine(document.getElementById('player'), { videoId: 'DRMTEST0001', streamToken: 'test-token' });
    window.__player = engine.getPlayer();
    return engine.init().then(() => engine.load()).then(() => engine.getPlayer().getStats());
  });

  expect(shakaRequests).toHaveLength(0);
  expect(stats.provider).toBe('native-dash');
  expect(stats.fallbackReason).toBe('');
  expect(stats.drmKeySystem).toBe('com.widevine.alpha');
  expect(stats.drmLicenseServerConfigured).toBe(false);
  expect(stats.lastDrmError).toBe('dash-widevine-license-unconfigured');
  expect(stats.nativeUnsupportedReason).toBe('dash-widevine-license-unconfigured');
  expect(stats.fatalError).toBe('dash-widevine-license-unconfigured');
});

test('PlayReady DASH manifest stays native with explicit unsupported reason', async ({ page }) => {
  const shakaRequests = [];
  await page.route('**/api/stream/PLAYREADY01/dash.mpd**', route => {
    route.fulfill({
      status: 200,
      contentType: 'application/dash+xml',
      body: `<?xml version="1.0"?><MPD type="static" mediaPresentationDuration="PT1S"><Period>
<AdaptationSet mimeType="video/mp4"><ContentProtection schemeIdUri="urn:uuid:9a04f079-9840-4286-ab92-e65be0885f95"/><Representation id="v" bandwidth="1" codecs="avc1.42c01f"><BaseURL>/x</BaseURL><SegmentBase indexRange="0-1"><Initialization range="0-1"/></SegmentBase></Representation></AdaptationSet>
<AdaptationSet mimeType="audio/mp4"><Representation id="a" bandwidth="1" codecs="mp4a.40.2"><BaseURL>/a</BaseURL><SegmentBase indexRange="0-1"><Initialization range="0-1"/></SegmentBase></Representation></AdaptationSet>
</Period></MPD>`,
    });
  });
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.abort();
  });

  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const stats = await page.evaluate(() => {
    const engine = new window.PlayerEngine(document.getElementById('player'), { videoId: 'PLAYREADY01', streamToken: 'test-token' });
    window.__player = engine.getPlayer();
    return engine.init().then(() => engine.load()).then(() => engine.getPlayer().getStats());
  });

  expect(shakaRequests).toHaveLength(0);
  expect(stats.provider).toBe('native-dash');
  expect(stats.fallbackReason).toBe('');
  expect(stats.drmKeySystem).toBe('com.microsoft.playready');
  expect(stats.lastDrmError).toBe('dash-playready-unsupported');
  expect(stats.nativeUnsupportedReason).toBe('dash-playready-unsupported');
  expect(stats.fatalError).toBe('dash-playready-unsupported');
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
  expect(state.stats.fallbackReason).toBe('');
  await expectFirstPartyNativePlayback(page, { provider: 'native-dash', mode: 'dash' });
  expect(shakaRequests).toHaveLength(0);
  expect(logs.some(line => line.includes('falling back to shaka'))).toBe(false);
});

test('native DASH media retry count honors streaming retry parameters', async ({ page }) => {
  const shakaRequests = await blockShakaScript(page);
  let attempts = 0;
  await page.route('**/retry-configured.m4s', route => {
    attempts++;
    route.fulfill({
      status: attempts < 3 ? 500 : 200,
      contentType: 'application/octet-stream',
      body: attempts < 3 ? 'fail' : 'ok',
    });
  });
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const state = await page.evaluate(async () => {
    const video = document.getElementById('player');
    const engine = new window.PlayerEngine(video, { videoId: 'TESTVIDEO01', streamToken: 'test-token' });
    engine.getPlayer().configure({
      streaming: { retryParameters: { maxAttempts: 3, baseDelay: 1, backoffFactor: 1 } },
    });
    const provider = {
      engine,
      requestGeneration: 0,
      controllers: [],
      segmentCacheHitCount: 0,
      segmentCacheMissCount: 0,
      mediaFetchRetryCount: 0,
      recoveryCount: 0,
      _recordRangeRecovery: window.NativeDashProviderForTest._recordRangeRecovery,
      _recordRangeError: window.NativeDashProviderForTest._recordRangeError,
      _recordBandwidthSample: window.NativeDashProviderForTest._recordBandwidthSample,
      _fetchRange: window.NativeDashProviderForTest._fetchRange,
    };
    const data = await provider._fetchRange('/retry-configured.m4s', null, { phase: 'media' });
    return {
      byteLength: data.byteLength,
      retries: provider.mediaFetchRetryCount,
      recoveryCount: provider.recoveryCount,
    };
  });

  expect(attempts).toBe(3);
  expect(state.byteLength).toBe(2);
  expect(state.retries).toBe(2);
  expect(state.recoveryCount).toBe(2);
  expect(shakaRequests).toHaveLength(0);
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
  expect(state.stats.fallbackReason).toBe('');
  await expectFirstPartyNativePlayback(page, { provider: 'native-dash', mode: 'dash' });
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
  expect(stats.fallbackReason).toBe('');
  await expectFirstPartyNativePlayback(page, { provider: 'native-dash', mode: 'dash' });
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
  expect(state.stats.fallbackReason).toBe('');
  await expectFirstPartyNativePlayback(page, { provider: 'native-dash', mode: 'dash' });
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
  expect(stats.fallbackReason).toBe('');
  await expectFirstPartyNativePlayback(page, { provider: 'native-dash', mode: 'dash' });
  expect(shakaRequests).toHaveLength(0);
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
  const shakaRequests = await blockShakaScript(page);
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const parsed = await page.evaluate(() => {
    const master = `#EXTM3U
#EXT-X-SESSION-DATA:DATA-ID="com.apple.hls.chapters",URI="chapters.json",LANGUAGE="en"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio-main",NAME="English",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,URI="audio-en.m3u8",CODECS="mp4a.40.2"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English captions",LANGUAGE="en",DEFAULT=NO,AUTOSELECT=YES,URI="captions/en.vtt"
#EXT-X-MEDIA:TYPE=CLOSED-CAPTIONS,GROUP-ID="cc",NAME="CC English",LANGUAGE="en",INSTREAM-ID="CC1",DEFAULT=YES,AUTOSELECT=YES
#EXT-X-STREAM-INF:BANDWIDTH=350000,RESOLUTION=426x240,CODECS="avc1.42c01f,mp4a.40.2",AUDIO="audio-main",SUBTITLES="subs",CLOSED-CAPTIONS="cc"
low.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1800000,RESOLUTION=1280x720,CODECS="avc1.42c01f,mp4a.40.2",AUDIO="audio-main",SUBTITLES="subs",CLOSED-CAPTIONS="cc"
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
      closedCaptionRenditions: masterOut.closedCaptionRenditions,
      sessionData: masterOut.sessionData,
      map: mediaOut.map,
      segments: mediaOut.segments,
      mediaSequence: mediaOut.mediaSequence,
      duration: mediaOut.duration,
      endList: mediaOut.endList,
    };
  });

  expect(parsed.variants).toEqual([
    expect.objectContaining({ url: 'https://example.test/hls/low.m3u8', bandwidth: 350000, width: 426, height: 240, codecs: 'avc1.42c01f,mp4a.40.2', audioGroup: 'audio-main', subtitleGroup: 'subs', closedCaptions: 'cc' }),
    expect.objectContaining({ url: 'https://example.test/hls/hi.m3u8', bandwidth: 1800000, width: 1280, height: 720, codecs: 'avc1.42c01f,mp4a.40.2', audioGroup: 'audio-main', subtitleGroup: 'subs', closedCaptions: 'cc' }),
  ]);
  expect(parsed.audioRenditions).toEqual([
    expect.objectContaining({ id: 'audio-main:English', groupId: 'audio-main', language: 'en', label: 'English', url: 'https://example.test/hls/audio-en.m3u8', codecs: 'mp4a.40.2', defaultTrack: true }),
  ]);
  expect(parsed.subtitleRenditions).toEqual([
    expect.objectContaining({ id: 'subs:English captions', groupId: 'subs', language: 'en', label: 'English captions', url: 'https://example.test/hls/captions/en.vtt', mimeType: 'text/vtt' }),
  ]);
  expect(parsed.closedCaptionRenditions).toEqual([
    expect.objectContaining({ id: 'cc:CC1', groupId: 'cc', language: 'en', label: 'CC English', source: 'native-hls-cea', mimeType: 'application/cea-608', embedded: true, instreamId: 'CC1', supported: false, renderSupported: false }),
  ]);
  expect(parsed.sessionData).toEqual([
    expect.objectContaining({ dataId: 'com.apple.hls.chapters', uri: 'https://example.test/hls/chapters.json', language: 'en' }),
  ]);
  expect(parsed.map).toEqual({ url: 'https://example.test/hls/video.mp4', range: { start: 0, end: 99 } });
  expect(parsed.segments).toEqual([
    { start: 0, end: 2, duration: 2, mediaSequence: 0, discontinuity: false, discontinuitySequence: 0, url: 'https://example.test/hls/video.mp4', range: { start: 100, end: 299 } },
    { start: 2, end: 4, duration: 2, mediaSequence: 1, discontinuity: false, discontinuitySequence: 0, url: 'https://example.test/hls/video.mp4', range: { start: 300, end: 499 } },
  ]);
  expect(parsed.duration).toBe(4);
  expect(parsed.mediaSequence).toBe(0);
  expect(parsed.endList).toBe(true);
  expect(shakaRequests).toHaveLength(0);
});

test('native HLS parser preserves discontinuity metadata', async ({ page }) => {
  const shakaRequests = await blockShakaScript(page);
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const parsed = await page.evaluate(() => {
    const media = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:2
#EXT-X-MEDIA-SEQUENCE:10
#EXT-X-DISCONTINUITY-SEQUENCE:4
#EXT-X-MAP:URI="video.mp4",BYTERANGE="100@0"
#EXTINF:2.000,
#EXT-X-BYTERANGE:200@100
video.mp4
#EXT-X-DISCONTINUITY
#EXTINF:2.000,
#EXT-X-BYTERANGE:200@300
video.mp4`;
    const out = window.NativeDashProviderForTest.parseHlsPlaylist(media, 'https://example.test/hls/live.m3u8');
    return {
      discontinuity: out.discontinuity,
      discontinuitySequence: out.discontinuitySequence,
      discontinuityCount: out.discontinuityCount,
      endList: out.endList,
      segments: out.segments,
    };
  });

  expect(parsed.discontinuity).toBe(true);
  expect(parsed.discontinuitySequence).toBe(4);
  expect(parsed.discontinuityCount).toBe(1);
  expect(parsed.endList).toBe(false);
  expect(parsed.segments).toEqual([
    expect.objectContaining({ start: 20, end: 22, mediaSequence: 10, discontinuity: false, discontinuitySequence: 4 }),
    expect.objectContaining({ start: 22, end: 24, mediaSequence: 11, discontinuity: true, discontinuitySequence: 5 }),
  ]);
  expect(shakaRequests).toHaveLength(0);
});

test('native HLS parser preserves EXT-X-START and DATERANGE metadata', async ({ page }) => {
  const shakaRequests = await blockShakaScript(page);
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const parsed = await page.evaluate(() => {
    const media = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-START:TIME-OFFSET=-3.5,PRECISE=YES
#EXT-X-TARGETDURATION:2
#EXT-X-MAP:URI="video.mp4",BYTERANGE="100@0"
#EXT-X-DATERANGE:ID="ad-1",CLASS="ad",START-DATE="2026-05-10T12:00:00Z",DURATION=4.5,X-ASSET-ID="asset-7"
#EXT-X-PROGRAM-DATE-TIME:2026-05-10T12:00:00Z
#EXTINF:2.000,
seg-a.m4s
#EXTINF:2.000,
seg-b.m4s
#EXT-X-ENDLIST`;
    const out = window.NativeDashProviderForTest.parseHlsPlaylist(media, 'https://example.test/hls/live.m3u8');
    return {
      start: out.start,
      dateRanges: out.dateRanges,
      segments: out.segments.map(seg => ({ start: seg.start, end: seg.end, programDateTimeMs: seg.programDateTimeMs })),
    };
  });

  expect(parsed.start).toEqual({ timeOffset: -3.5, precise: true });
  expect(parsed.dateRanges).toEqual([
    expect.objectContaining({
      id: 'ad-1',
      class: 'ad',
      startDate: '2026-05-10T12:00:00Z',
      duration: 4.5,
      customAttributes: { 'X-ASSET-ID': 'asset-7' },
    }),
  ]);
  expect(parsed.segments[0]).toMatchObject({ start: 0, end: 2, programDateTimeMs: Date.parse('2026-05-10T12:00:00Z') });
  expect(parsed.segments[1]).toMatchObject({ start: 2, end: 4, programDateTimeMs: Date.parse('2026-05-10T12:00:02Z') });
  expect(shakaRequests).toHaveLength(0);
});

test('native HLS parser preserves AES-128 key metadata and key resets', async ({ page }) => {
  const shakaRequests = await blockShakaScript(page);
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const parsed = await page.evaluate(() => {
    const media = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:2
#EXT-X-MEDIA-SEQUENCE:7
#EXT-X-MAP:URI="video.mp4",BYTERANGE="100@0"
#EXT-X-KEY:METHOD=AES-128,URI="key-a.bin",IV=0x00000000000000000000000000000009
#EXTINF:2.000,
seg-a.m4s
#EXT-X-KEY:METHOD=AES-128,URI="key-b.bin"
#EXTINF:2.000,
seg-b.m4s
#EXT-X-KEY:METHOD=NONE
#EXTINF:2.000,
seg-c.m4s`;
    const out = window.NativeDashProviderForTest.parseHlsPlaylist(media, 'https://example.test/hls/live.m3u8');
    return {
      encrypted: out.encrypted,
      unsupportedEncryption: out.unsupportedEncryption,
      segments: out.segments.map(seg => ({
        mediaSequence: seg.mediaSequence,
        url: seg.url,
        key: seg.key ? {
          method: seg.key.method,
          uri: seg.key.uri,
          iv: seg.key.iv ? Array.from(seg.key.iv) : null,
        } : null,
      })),
    };
  });

  expect(parsed.encrypted).toBe(true);
  expect(parsed.unsupportedEncryption).toBe(false);
  expect(parsed.segments).toEqual([
    { mediaSequence: 7, url: 'https://example.test/hls/seg-a.m4s', key: { method: 'AES-128', uri: 'https://example.test/hls/key-a.bin', iv: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 9] } },
    { mediaSequence: 8, url: 'https://example.test/hls/seg-b.m4s', key: { method: 'AES-128', uri: 'https://example.test/hls/key-b.bin', iv: null } },
    { mediaSequence: 9, url: 'https://example.test/hls/seg-c.m4s', key: null },
  ]);
  expect(shakaRequests).toHaveLength(0);
});

test('native HLS parser preserves low-latency playlist metadata', async ({ page }) => {
  const shakaRequests = await blockShakaScript(page);
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const parsed = await page.evaluate(() => {
    const media = `#EXTM3U
#EXT-X-VERSION:9
#EXT-X-TARGETDURATION:2
#EXT-X-SERVER-CONTROL:CAN-SKIP-UNTIL=12.0,CAN-SKIP-DATERANGES=YES,HOLD-BACK=6.0,PART-HOLD-BACK=1.0,CAN-BLOCK-RELOAD=YES
#EXT-X-PART-INF:PART-TARGET=0.33334
#EXT-X-MAP:URI="video.mp4",BYTERANGE="100@0"
#EXT-X-SKIP:SKIPPED-SEGMENTS=3
#EXT-X-PART:DURATION=0.33334,URI="filePart271.0.m4s",INDEPENDENT=YES
#EXT-X-PART:DURATION=0.33334,URI="filePart271.1.m4s",BYTERANGE="400@100"
#EXTINF:2.000,
seg-271.m4s
#EXT-X-PRELOAD-HINT:TYPE=PART,URI="filePart272.0.m4s",BYTERANGE-START=0,BYTERANGE-LENGTH=400
#EXT-X-RENDITION-REPORT:URI="low.m3u8",LAST-MSN=271,LAST-PART=1`;
    const out = window.NativeDashProviderForTest.parseHlsPlaylist(media, 'https://example.test/hls/live/hi.m3u8');
    return {
      lowLatencyPlaylist: out.lowLatencyPlaylist,
      partTargetDuration: out.partTargetDuration,
      partialSegmentCount: out.partialSegmentCount,
      skippedSegmentCount: out.skippedSegmentCount,
      serverControl: out.serverControl,
      preloadHints: out.preloadHints,
      renditionReports: out.renditionReports,
      warnings: out.warnings,
      segments: out.segments,
    };
  });

  expect(parsed.lowLatencyPlaylist).toBe(true);
  expect(parsed.partTargetDuration).toBeCloseTo(0.33334, 5);
  expect(parsed.partialSegmentCount).toBe(2);
  expect(parsed.skippedSegmentCount).toBe(3);
  expect(parsed.serverControl).toMatchObject({ canSkipUntil: 12, canSkipDateRanges: true, holdBack: 6, partHoldBack: 1, canBlockReload: true });
  expect(parsed.preloadHints).toEqual([expect.objectContaining({ type: 'PART', url: 'https://example.test/hls/live/filePart272.0.m4s', byteRangeStart: 0, byteRangeLength: 400 })]);
  expect(parsed.renditionReports).toEqual([expect.objectContaining({ url: 'https://example.test/hls/live/low.m3u8', lastMsn: 271, lastPart: 1 })]);
  expect(parsed.warnings).toContain('hls-delta-update-skipped-segments');
  expect(parsed.segments).toHaveLength(1);
  expect(parsed.segments[0].parts).toEqual([
    expect.objectContaining({ url: 'https://example.test/hls/live/filePart271.0.m4s', duration: 0.33334, independent: true, gap: false, range: null }),
    expect.objectContaining({ url: 'https://example.test/hls/live/filePart271.1.m4s', duration: 0.33334, independent: false, gap: false, range: { start: 100, end: 499 } }),
  ]);
  expect(shakaRequests).toHaveLength(0);
});

test('native HLS parser keeps I-frame and content steering metadata out of playable variants', async ({ page }) => {
  const shakaRequests = await blockShakaScript(page);
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const parsed = await page.evaluate(() => {
    const master = `#EXTM3U
#EXT-X-CONTENT-STEERING:SERVER-URI="steering.json",PATHWAY-ID="cdn-a"
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.42c01f,mp4a.40.2",PATHWAY-ID="cdn-a"
v360.m3u8
#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=120000,RESOLUTION=640x360,CODECS="avc1.42c01f",PATHWAY-ID="cdn-a",URI="iframes-360.m3u8"`;
    const out = window.NativeDashProviderForTest.parseHlsPlaylist(master, 'https://example.test/hls/master.m3u8');
    return {
      variants: out.variants,
      iframeVariants: out.iframeVariants,
      contentSteeringUri: out.contentSteeringUri,
      contentSteeringPathwayId: out.contentSteeringPathwayId,
    };
  });

  expect(parsed.variants).toHaveLength(1);
  expect(parsed.variants[0]).toMatchObject({ url: 'https://example.test/hls/v360.m3u8', height: 360, pathwayId: 'cdn-a' });
  expect(parsed.iframeVariants).toEqual([
    expect.objectContaining({ id: 'iframe-0', url: 'https://example.test/hls/iframes-360.m3u8', height: 360, bandwidth: 120000, codecs: 'avc1.42c01f', pathwayId: 'cdn-a', iframeOnly: true }),
  ]);
  expect(parsed.contentSteeringUri).toBe('https://example.test/hls/steering.json');
  expect(parsed.contentSteeringPathwayId).toBe('cdn-a');
  expect(shakaRequests).toHaveLength(0);
});

test('native HLS parser preserves image stream playlist thumbnail metadata', async ({ page }) => {
  const shakaRequests = await blockShakaScript(page);
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const parsed = await page.evaluate(() => {
    const master = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.42c01f,mp4a.40.2"
v360.m3u8
#EXT-X-IMAGE-STREAM-INF:BANDWIDTH=24000,RESOLUTION=160x90,CODECS="jpeg",PATHWAY-ID="cdn-a",URI="images.m3u8"`;
    const images = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-IMAGES-ONLY
#EXT-X-TILES:RESOLUTION=160x90,LAYOUT=5x5,DURATION=1.0
#EXT-X-TARGETDURATION:5
#EXTINF:5.000,
#EXT-X-BYTERANGE:4000@0
sprite.jpg
#EXTINF:5.000,
#EXT-X-BYTERANGE:4000@4000
sprite.jpg
#EXT-X-ENDLIST`;
    const masterOut = window.NativeDashProviderForTest.parseHlsPlaylist(master, 'https://example.test/hls/master.m3u8');
    const imageOut = window.NativeDashProviderForTest.parseHlsPlaylist(images, 'https://example.test/hls/images.m3u8');
    return {
      imageVariants: masterOut.imageVariants,
      imagesOnly: imageOut.imagesOnly,
      segments: imageOut.segments,
      duration: imageOut.duration,
    };
  });

  expect(parsed.imageVariants).toEqual([
    expect.objectContaining({ id: 'image-0', url: 'https://example.test/hls/images.m3u8', bandwidth: 24000, width: 160, height: 90, codecs: 'jpeg', pathwayId: 'cdn-a', imageOnly: true }),
  ]);
  expect(parsed.imagesOnly).toBe(true);
  expect(parsed.duration).toBe(10);
  expect(parsed.segments).toEqual([
    expect.objectContaining({ start: 0, end: 5, url: 'https://example.test/hls/sprite.jpg', range: { start: 0, end: 3999 }, tiles: { width: 160, height: 90, columns: 5, rows: 5, duration: 1 } }),
    expect.objectContaining({ start: 5, end: 10, url: 'https://example.test/hls/sprite.jpg', range: { start: 4000, end: 7999 }, tiles: { width: 160, height: 90, columns: 5, rows: 5, duration: 1 } }),
  ]);
  expect(shakaRequests).toHaveLength(0);
});

test('native HLS session-data chapters become timeline regions without Shaka', async ({ page }) => {
  const shakaRequests = [];
  const chapterRequests = [];
  const events = [];
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.abort();
  });
  await page.route('**/chapter-master.m3u8', route => {
    route.fulfill({
      status: 200,
      contentType: 'application/vnd.apple.mpegurl',
      body: [
        '#EXTM3U',
        '#EXT-X-SESSION-DATA:DATA-ID="com.apple.hls.chapters",URI="/chapters.json",LANGUAGE="en"',
        '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.42c01f,mp4a.40.2"',
        '/chapter-media.m3u8',
      ].join('\n'),
    });
  });
  await page.route('**/chapters.json', route => {
    chapterRequests.push(route.request().url());
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ chapters: [
        { id: 'intro', title: 'Intro', startTime: 0, duration: 5 },
        { id: 'main', title: 'Main', startTime: 5, endTime: 10, image: '/chapter-main.jpg' },
      ] }),
    });
  });
  await page.route('**/chapter-media.m3u8', async route => {
    const url = new URL(route.request().url());
    const resp = await fetch(url.origin + '/api/stream/PLAYERTEST1/hls/v360.m3u8?fixtureHls=1');
    route.fulfill({ status: 200, contentType: 'application/vnd.apple.mpegurl', body: await resp.text() });
  });

  await page.goto('/auth/login');
  await page.setContent('<video id="player" muted playsinline style="width:1280px;height:720px"></video>');
  await page.addScriptTag({ path: 'public/native-player-engine.js' });
  await page.exposeFunction('recordTimelineRegion', event => events.push(event));

  await page.evaluate(() => {
    const video = document.getElementById('player');
    video.muted = true;
    video.canPlayType = () => '';
    const engine = new window.PlayerEngine(video, { videoId: 'PLAYERTEST1', streamToken: '' });
    window.__engine = engine;
    window.__player = engine.getPlayer();
    window.__player.addEventListener('timelineregionadded', event => window.recordTimelineRegion(event.detail));
    window.__player.configure({ streaming: { bufferingGoal: 2, startupBufferGoal: 1, maxConcurrentRequests: 1 } });
    return engine.init().then(() => engine.load('/chapter-master.m3u8'));
  });

  await expect.poll(() => page.evaluate(() => window._playerProvider)).toBe('native-hls');
  const state = await page.evaluate(() => {
    const stats = window.__player.getStats();
    return {
      stats,
      regions: window.__engine._provider.timelineRegions,
      textTracks: window.__player.getTextTracks(),
    };
  });

  expect(state.stats.sessionDataCount).toBe(1);
  expect(state.stats.hlsChapterCount).toBe(2);
  expect(state.stats.timelineRegionCount).toBe(2);
  expect(state.stats.lastHlsChapterError).toBe('');
  expect(state.regions).toEqual([
    expect.objectContaining({ id: 'intro', schemeIdUri: 'com.apple.hls.chapters', value: 'Intro', startTime: 0, endTime: 5, source: 'hls-session-data' }),
    expect.objectContaining({ id: 'main', schemeIdUri: 'com.apple.hls.chapters', value: 'Main', startTime: 5, endTime: 10, source: 'hls-session-data', customAttributes: expect.objectContaining({ image: '/chapter-main.jpg' }) }),
  ]);
  expect(events).toHaveLength(2);
  expect(chapterRequests).toHaveLength(1);
  expect(shakaRequests).toHaveLength(0);
});

test('native HLS content steering prefers steered pathway without Shaka fallback', async ({ page }) => {
  const shakaRequests = [];
  const mediaRequests = [];
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.abort();
  });
  await page.route('**/steering.json', route => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ VERSION: 1, TTL: 30, 'PATHWAY-PRIORITY': ['cdn-b', 'cdn-a'] }),
    });
  });
  await page.route('**/steered-master.m3u8', route => {
    route.fulfill({
      status: 200,
      contentType: 'application/vnd.apple.mpegurl',
      body: [
        '#EXTM3U',
        '#EXT-X-CONTENT-STEERING:SERVER-URI="/steering.json",PATHWAY-ID="cdn-a"',
        '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.42c01f,mp4a.40.2",PATHWAY-ID="cdn-a"',
        '/cdn-a-media.m3u8',
        '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.42c01f,mp4a.40.2",PATHWAY-ID="cdn-b"',
        '/cdn-b-media.m3u8',
      ].join('\n'),
    });
  });
  await page.route('**/cdn-*-media.m3u8', async route => {
    mediaRequests.push(route.request().url());
    const url = new URL(route.request().url());
    const resp = await fetch(url.origin + '/api/stream/PLAYERTEST1/hls/v360.m3u8?fixtureHls=1');
    route.fulfill({ status: 200, contentType: 'application/vnd.apple.mpegurl', body: await resp.text() });
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
    return engine.init().then(() => engine.load('/steered-master.m3u8'));
  });

  await expect.poll(() => page.evaluate(() => window._playerProvider)).toBe('native-hls');
  await page.evaluate(() => document.getElementById('player').play());
  await page.waitForFunction(() => document.getElementById('player').currentTime > 0, null, { timeout: 10_000 });

  const stats = await page.evaluate(() => window.__player.getStats());
  expect(stats.provider).toBe('native-hls');
  expect(stats.contentSteeringPathwayId).toBe('cdn-b');
  expect(stats.contentSteeringPriority).toEqual(['cdn-b', 'cdn-a']);
  expect(stats.contentSteeringRequestCount).toBe(1);
  expect(stats.lastContentSteeringError).toBe('');
  expect(stats.activeVariant).toMatchObject({ pathwayId: 'cdn-b' });
  expect(mediaRequests.some(url => url.includes('/cdn-b-media.m3u8'))).toBe(true);
  expect(mediaRequests.some(url => url.includes('/cdn-a-media.m3u8'))).toBe(false);
  expect(stats.fallbackReason).toBe('');
  expect(shakaRequests).toHaveLength(0);
});

test('native HLS content steering failure keeps original pathway native', async ({ page }) => {
  const shakaRequests = [];
  const mediaRequests = [];
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.abort();
  });
  await page.route('**/steering-missing.json', route => {
    route.fulfill({ status: 404, body: 'missing steering' });
  });
  await page.route('**/steering-fail-master.m3u8', route => {
    route.fulfill({
      status: 200,
      contentType: 'application/vnd.apple.mpegurl',
      body: [
        '#EXTM3U',
        '#EXT-X-CONTENT-STEERING:SERVER-URI="/steering-missing.json",PATHWAY-ID="cdn-a"',
        '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.42c01f,mp4a.40.2",PATHWAY-ID="cdn-a"',
        '/fail-cdn-a-media.m3u8',
        '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.42c01f,mp4a.40.2",PATHWAY-ID="cdn-b"',
        '/fail-cdn-b-media.m3u8',
      ].join('\n'),
    });
  });
  await page.route('**/fail-cdn-*-media.m3u8', async route => {
    mediaRequests.push(route.request().url());
    const url = new URL(route.request().url());
    const resp = await fetch(url.origin + '/api/stream/PLAYERTEST1/hls/v360.m3u8?fixtureHls=1');
    route.fulfill({ status: 200, contentType: 'application/vnd.apple.mpegurl', body: await resp.text() });
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
    return engine.init().then(() => engine.load('/steering-fail-master.m3u8'));
  });

  await expect.poll(() => page.evaluate(() => window._playerProvider)).toBe('native-hls');
  const stats = await page.evaluate(() => window.__player.getStats());
  expect(stats.contentSteeringPathwayId).toBe('cdn-a');
  expect(stats.contentSteeringRequestCount).toBe(1);
  expect(stats.lastContentSteeringError).toBe('content-steering-http-404');
  expect(stats.fallbackReason).toBe('');
  expect(mediaRequests.some(url => url.includes('/fail-cdn-a-media.m3u8'))).toBe(true);
  expect(mediaRequests.some(url => url.includes('/fail-cdn-b-media.m3u8'))).toBe(false);
  expect(shakaRequests).toHaveLength(0);
});

test('native HLS content steering reload can switch pathway on live refresh', async ({ page }) => {
  const shakaRequests = [];
  const mediaRequests = [];
  let steeringRequests = 0;
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.abort();
  });
  await page.route('**/steering-live.json', route => {
    steeringRequests++;
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        VERSION: 1,
        TTL: 0,
        'RELOAD-URI': '/steering-live.json',
        'PATHWAY-PRIORITY': steeringRequests === 1 ? ['cdn-a', 'cdn-b'] : ['cdn-b', 'cdn-a'],
      }),
    });
  });
  await page.route('**/steering-live-master.m3u8', route => {
    route.fulfill({
      status: 200,
      contentType: 'application/vnd.apple.mpegurl',
      body: [
        '#EXTM3U',
        '#EXT-X-CONTENT-STEERING:SERVER-URI="/steering-live.json",PATHWAY-ID="cdn-a"',
        '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.42c01f,mp4a.40.2",PATHWAY-ID="cdn-a"',
        '/live-cdn-a-media.m3u8',
        '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.42c01f,mp4a.40.2",PATHWAY-ID="cdn-b"',
        '/live-cdn-b-media.m3u8',
      ].join('\n'),
    });
  });
  await page.route('**/live-cdn-*-media.m3u8', async route => {
    mediaRequests.push(route.request().url());
    const url = new URL(route.request().url());
    const resp = await fetch(url.origin + '/api/stream/PLAYERTEST1/hls/v360.m3u8?fixtureHls=live');
    route.fulfill({ status: 200, contentType: 'application/vnd.apple.mpegurl', body: await resp.text() });
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
    return engine.init().then(() => engine.load('/steering-live-master.m3u8'));
  });

  await expect.poll(() => page.evaluate(() => window._playerProvider)).toBe('native-hls');
  await expect.poll(() => page.evaluate(() => window.__player.getStats().contentSteeringPathwayId)).toBe('cdn-a');

  await page.evaluate(() => window.__engine._provider._refreshMediaPlaylist('test-refresh'));

  const stats = await page.evaluate(() => window.__player.getStats());
  expect(stats.contentSteeringPathwayId).toBe('cdn-b');
  expect(stats.contentSteeringRequestCount).toBe(2);
  expect(stats.contentSteeringSwitchCount).toBeGreaterThan(0);
  expect(stats.lastSwitchReason).toBe('content-steering');
  expect(stats.fallbackReason).toBe('');
  expect(mediaRequests.some(url => url.includes('/live-cdn-a-media.m3u8'))).toBe(true);
  expect(mediaRequests.some(url => url.includes('/live-cdn-b-media.m3u8'))).toBe(true);
  expect(shakaRequests).toHaveLength(0);
});

test('native HLS lazily loads I-frame playlist and returns preview segment metadata', async ({ page }) => {
  const shakaRequests = [];
  const iframeRequests = [];
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.abort();
  });
  await page.route('**/iframe-master.m3u8', route => {
    route.fulfill({
      status: 200,
      contentType: 'application/vnd.apple.mpegurl',
      body: [
        '#EXTM3U',
        '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.42c01f,mp4a.40.2"',
        '/iframe-media.m3u8',
        '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=120000,RESOLUTION=640x360,CODECS="avc1.42c01f",URI="/iframe-only.m3u8"',
      ].join('\n'),
    });
  });
  await page.route('**/iframe-media.m3u8', async route => {
    const url = new URL(route.request().url());
    const resp = await fetch(url.origin + '/api/stream/PLAYERTEST1/hls/v360.m3u8?fixtureHls=1');
    route.fulfill({ status: 200, contentType: 'application/vnd.apple.mpegurl', body: await resp.text() });
  });
  await page.route('**/iframe-only.m3u8', route => {
    iframeRequests.push(route.request().url());
    route.fulfill({
      status: 200,
      contentType: 'application/vnd.apple.mpegurl',
      body: [
        '#EXTM3U',
        '#EXT-X-VERSION:7',
        '#EXT-X-TARGETDURATION:2',
        '#EXT-X-MAP:URI="/iframe-init.mp4",BYTERANGE="100@0"',
        '#EXTINF:2.000,',
        '#EXT-X-BYTERANGE:200@100',
        '/iframe-segments.mp4',
        '#EXTINF:2.000,',
        '#EXT-X-BYTERANGE:200@300',
        '/iframe-segments.mp4',
        '#EXT-X-ENDLIST',
      ].join('\n'),
    });
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
    return engine.init().then(() => engine.load('/iframe-master.m3u8'));
  });

  await expect.poll(() => page.evaluate(() => window._playerProvider)).toBe('native-hls');
  const before = await page.evaluate(() => ({
    tracks: window.__player.getIFrameTracks(),
    stats: window.__player.getStats(),
    variants: window.__player.getVariantTracks(),
  }));
  expect(before.tracks).toEqual([
    expect.objectContaining({ id: 'iframe-0', height: 360, iframeOnly: true, loaded: false }),
  ]);
  expect(before.stats.iframePlaylistRequestCount).toBe(0);
  expect(before.stats.fallbackReason).toBe('');
  expect(before.variants).toHaveLength(1);

  const preview = await page.evaluate(() => window.__player.getIFramePreview(2.5));
  const origin = await page.evaluate(() => location.origin);
  const after = await page.evaluate(() => ({
    tracks: window.__player.getIFrameTracks(),
    stats: window.__player.getStats(),
  }));

  expect(preview).toMatchObject({
    track: expect.objectContaining({ id: 'iframe-0', height: 360, iframeOnly: true }),
    start: 2,
    end: 4,
    url: origin + '/iframe-segments.mp4',
    range: { start: 300, end: 499 },
  });
  expect(after.tracks[0]).toMatchObject({ loaded: true });
  expect(after.stats.iframePlaylistRequestCount).toBe(1);
  expect(after.stats.iframeSegmentCount).toBe(2);
  expect(after.stats.lastIFramePlaylistError).toBe('');
  expect(after.stats.fallbackReason).toBe('');
  expect(iframeRequests).toHaveLength(1);
  expect(shakaRequests).toHaveLength(0);
});

test('native HLS lazily loads image playlist thumbnails through preview API', async ({ page }) => {
  const shakaRequests = [];
  const imageRequests = [];
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.abort();
  });
  await page.route('**/image-master.m3u8', route => {
    route.fulfill({
      status: 200,
      contentType: 'application/vnd.apple.mpegurl',
      body: [
        '#EXTM3U',
        '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.42c01f,mp4a.40.2"',
        '/image-media.m3u8',
        '#EXT-X-IMAGE-STREAM-INF:BANDWIDTH=24000,RESOLUTION=160x90,CODECS="jpeg",URI="/image-thumbnails.m3u8"',
      ].join('\n'),
    });
  });
  await page.route('**/image-media.m3u8', async route => {
    const url = new URL(route.request().url());
    const resp = await fetch(url.origin + '/api/stream/PLAYERTEST1/hls/v360.m3u8?fixtureHls=1');
    route.fulfill({ status: 200, contentType: 'application/vnd.apple.mpegurl', body: await resp.text() });
  });
  await page.route('**/image-thumbnails.m3u8', route => {
    imageRequests.push(route.request().url());
    route.fulfill({
      status: 200,
      contentType: 'application/vnd.apple.mpegurl',
      body: [
        '#EXTM3U',
        '#EXT-X-VERSION:7',
        '#EXT-X-IMAGES-ONLY',
        '#EXT-X-TILES:RESOLUTION=160x90,LAYOUT=5x5,DURATION=1.0',
        '#EXT-X-TARGETDURATION:5',
        '#EXTINF:5.000,',
        '#EXT-X-BYTERANGE:4000@0',
        '/sprites.jpg',
        '#EXTINF:5.000,',
        '#EXT-X-BYTERANGE:4000@4000',
        '/sprites.jpg',
        '#EXT-X-ENDLIST',
      ].join('\n'),
    });
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
    return engine.init().then(() => engine.load('/image-master.m3u8'));
  });

  await expect.poll(() => page.evaluate(() => window._playerProvider)).toBe('native-hls');
  const before = await page.evaluate(() => ({
    tracks: window.__player.getIFrameTracks(),
    stats: window.__player.getStats(),
  }));
  expect(before.tracks).toEqual([
    expect.objectContaining({ id: 'image-0', height: 90, imageOnly: true, thumbnailType: 'image', loaded: false }),
  ]);
  expect(before.stats.imageVariantCount).toBe(1);
  expect(before.stats.imagePlaylistRequestCount).toBe(0);
  expect(before.stats.fallbackReason).toBe('');

  const preview = await page.evaluate(() => window.__player.getIFramePreview(6, 'image-0'));
  const origin = await page.evaluate(() => location.origin);
  const after = await page.evaluate(() => ({
    tracks: window.__player.getIFrameTracks(),
    stats: window.__player.getStats(),
  }));

  expect(preview).toMatchObject({
    track: expect.objectContaining({ id: 'image-0', height: 90, imageOnly: true, thumbnailType: 'image' }),
    start: 5,
    end: 10,
    url: origin + '/sprites.jpg',
    range: { start: 4000, end: 7999 },
    tiles: { width: 160, height: 90, columns: 5, rows: 5, duration: 1 },
    imageOnly: true,
    thumbnailType: 'image',
  });
  expect(after.tracks[0]).toMatchObject({ loaded: true });
  expect(after.stats.imagePlaylistRequestCount).toBe(1);
  expect(after.stats.imageSegmentCount).toBe(2);
  expect(after.stats.lastImagePlaylistError).toBe('');
  expect(after.stats.fallbackReason).toBe('');
  expect(imageRequests).toHaveLength(1);
  expect(shakaRequests).toHaveLength(0);
});

test('native HLS bad I-frame playlist is non-fatal and keeps playback native', async ({ page }) => {
  const shakaRequests = [];
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.abort();
  });
  await page.route('**/bad-iframe-master.m3u8', route => {
    route.fulfill({
      status: 200,
      contentType: 'application/vnd.apple.mpegurl',
      body: [
        '#EXTM3U',
        '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.42c01f,mp4a.40.2"',
        '/bad-iframe-media.m3u8',
        '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=120000,RESOLUTION=640x360,CODECS="avc1.42c01f",URI="/bad-iframe-only.m3u8"',
      ].join('\n'),
    });
  });
  await page.route('**/bad-iframe-media.m3u8', async route => {
    const url = new URL(route.request().url());
    const resp = await fetch(url.origin + '/api/stream/PLAYERTEST1/hls/v360.m3u8?fixtureHls=1');
    route.fulfill({ status: 200, contentType: 'application/vnd.apple.mpegurl', body: await resp.text() });
  });
  await page.route('**/bad-iframe-only.m3u8', route => {
    route.fulfill({
      status: 200,
      contentType: 'application/vnd.apple.mpegurl',
      body: '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:2\n#EXT-X-ENDLIST',
    });
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
    return engine.init().then(() => engine.load('/bad-iframe-master.m3u8'));
  });

  await expect.poll(() => page.evaluate(() => window._playerProvider)).toBe('native-hls');
  const preview = await page.evaluate(() => window.__player.getIFramePreview(1));
  const stats = await page.evaluate(() => window.__player.getStats());
  expect(preview).toBeNull();
  expect(stats.provider).toBe('native-hls');
  expect(stats.fallbackReason).toBe('');
  expect(stats.iframePlaylistRequestCount).toBe(1);
  expect(stats.lastIFramePlaylistError).toBe('hls-iframe-playlist-empty');
  expect(shakaRequests).toHaveLength(0);
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
  await expectFirstPartyNativePlayback(page, { provider: 'native-hls', mode: 'hls' });
  expect(shakaRequests).toHaveLength(0);
});

test('native HLS low-latency playlist fetches and appends partial segments without Shaka fallback', async ({ page }) => {
  const shakaRequests = [];
  const partialRequests = [];
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.abort();
  });
  await page.route('**llpart=0', route => {
    partialRequests.push(route.request().url());
    route.continue();
  });
  await page.route('**/ll-master.m3u8', route => {
    route.fulfill({
      status: 200,
      contentType: 'application/vnd.apple.mpegurl',
      body: [
        '#EXTM3U',
        '#EXT-X-CONTENT-STEERING:SERVER-URI="/steering.json",PATHWAY-ID="cdn-a"',
        '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.42c01f,mp4a.40.2"',
        '/ll-media.m3u8',
        '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=120000,RESOLUTION=640x360,CODECS="avc1.42c01f",URI="/iframes-360.m3u8"',
      ].join('\n'),
    });
  });
  await page.route('**/ll-media.m3u8', async route => {
    const url = new URL(route.request().url());
    const resp = await fetch(url.origin + '/api/stream/PLAYERTEST1/hls/v360.m3u8?fixtureHls=1');
    let text = await resp.text();
    const firstRange = text.match(/#EXT-X-BYTERANGE:([^\n]+)\n(\/api\/stream\/PLAYERTEST1\/fmt\/v360)/);
    const partRange = firstRange ? firstRange[1] : '';
    const partUrl = firstRange ? firstRange[2] + '?llpart=0' : 'seg-0.part.m4s';
    text = text.replace('#EXTM3U', [
      '#EXTM3U',
      '#EXT-X-SERVER-CONTROL:CAN-SKIP-UNTIL=12.0,HOLD-BACK=6.0,PART-HOLD-BACK=1.0,CAN-BLOCK-RELOAD=YES',
      '#EXT-X-PART-INF:PART-TARGET=0.33334',
      '#EXT-X-SKIP:SKIPPED-SEGMENTS=2',
    ].join('\n'));
    text = text.replace('#EXTINF:', [
      `#EXT-X-PART:DURATION=0.33334,URI="${partUrl}",BYTERANGE="${partRange}",INDEPENDENT=YES`,
      '#EXTINF:',
    ].join('\n'));
    text = text.replace('#EXT-X-ENDLIST', [
      '#EXT-X-PRELOAD-HINT:TYPE=PART,URI="next.part.m4s"',
      '#EXT-X-RENDITION-REPORT:URI="low.m3u8",LAST-MSN=1,LAST-PART=1',
    ].join('\n'));
    route.fulfill({ status: 200, contentType: 'application/vnd.apple.mpegurl', body: text });
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
    return engine.init().then(() => engine.load('/ll-master.m3u8'));
  });

  await expect.poll(() => page.evaluate(() => window._playerProvider)).toBe('native-hls');
  await page.evaluate(() => document.getElementById('player').play());
  await page.waitForFunction(() => document.getElementById('player').currentTime > 0, null, { timeout: 10_000 });

  const state = await page.evaluate(() => ({
    stats: window.__player.getStats(),
    tracks: window.__player.getVariantTracks(),
  }));
  expect(state.stats.provider).toBe('native-hls');
  expect(state.stats.lowLatencyPlaylist).toBe(true);
  expect(state.stats.partialSegmentCount).toBe(1);
  expect(state.stats.partialSegmentRequestCount).toBeGreaterThan(0);
  expect(state.stats.partialSegmentAppendCount).toBeGreaterThan(0);
  expect(state.stats.partialSegmentFallbackCount).toBe(0);
  expect(state.stats.preloadHintCount).toBe(1);
  expect(state.stats.renditionReportCount).toBe(1);
  expect(state.stats.skippedSegmentCount).toBe(2);
  expect(state.stats.iframeVariantCount).toBe(1);
  expect(state.stats.contentSteeringUri).toBe('/steering.json');
  expect(state.stats.manifestCompatibilityWarnings).toContain('hls-delta-update-skipped-segments');
  expect(state.stats.fallbackReason).toBe('');
  expect(state.tracks).toHaveLength(1);
  expect(state.tracks[0]).toMatchObject({ height: 360, selectable: true });
  expect(partialRequests.length).toBeGreaterThan(0);
  await expectFirstPartyNativePlayback(page, { provider: 'native-hls', mode: 'hls' });
  expect(shakaRequests).toHaveLength(0);
});

test('native HLS falls back to full segment when a low-latency part is missing', async ({ page }) => {
  const shakaRequests = [];
  const partialRequests = [];
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.abort();
  });
  await page.route('**llpart=missing', route => {
    partialRequests.push(route.request().url());
    route.fulfill({ status: 404, body: 'missing part' });
  });
  await page.route('**/ll-missing-master.m3u8', route => {
    route.fulfill({
      status: 200,
      contentType: 'application/vnd.apple.mpegurl',
      body: [
        '#EXTM3U',
        '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.42c01f,mp4a.40.2"',
        '/ll-missing-media.m3u8',
      ].join('\n'),
    });
  });
  await page.route('**/ll-missing-media.m3u8', async route => {
    const url = new URL(route.request().url());
    const resp = await fetch(url.origin + '/api/stream/PLAYERTEST1/hls/v360.m3u8?fixtureHls=1');
    let text = await resp.text();
    const firstRange = text.match(/#EXT-X-BYTERANGE:([^\n]+)\n(\/api\/stream\/PLAYERTEST1\/fmt\/v360)/);
    const partRange = firstRange ? firstRange[1] : '';
    text = text.replace('#EXTM3U', [
      '#EXTM3U',
      '#EXT-X-SERVER-CONTROL:CAN-SKIP-UNTIL=12.0,HOLD-BACK=6.0,PART-HOLD-BACK=1.0,CAN-BLOCK-RELOAD=YES',
      '#EXT-X-PART-INF:PART-TARGET=0.33334',
    ].join('\n'));
    text = text.replace('#EXTINF:', [
      `#EXT-X-PART:DURATION=0.33334,URI="/missing.part.m4s?llpart=missing",BYTERANGE="${partRange}",INDEPENDENT=YES`,
      '#EXTINF:',
    ].join('\n'));
    text = text.replace('#EXT-X-ENDLIST', '');
    route.fulfill({ status: 200, contentType: 'application/vnd.apple.mpegurl', body: text });
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
    return engine.init().then(() => engine.load('/ll-missing-master.m3u8'));
  });

  await expect.poll(() => page.evaluate(() => window._playerProvider)).toBe('native-hls');
  await page.evaluate(() => document.getElementById('player').play());
  await page.waitForFunction(() => document.getElementById('player').currentTime > 0, null, { timeout: 10_000 });

  const stats = await page.evaluate(() => window.__player.getStats());
  expect(stats.provider).toBe('native-hls');
  expect(stats.lowLatencyPlaylist).toBe(true);
  expect(stats.partialSegmentRequestCount).toBeGreaterThan(0);
  expect(stats.partialSegmentFallbackCount).toBeGreaterThan(0);
  expect(stats.partialSegmentAppendCount).toBe(0);
  expect(stats.fallbackReason).toBe('');
  expect(partialRequests.length).toBeGreaterThan(0);
  expect(shakaRequests).toHaveLength(0);
});

test('native HLS applies EXT-X-START unless load startTime is explicit', async ({ page }) => {
  const shakaRequests = [];
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.abort();
  });
  await page.route('**/start-master.m3u8', route => {
    route.fulfill({
      status: 200,
      contentType: 'application/vnd.apple.mpegurl',
      body: [
        '#EXTM3U',
        '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.42c01f,mp4a.40.2"',
        '/start-media.m3u8',
      ].join('\n'),
    });
  });
  await page.route('**/start-media.m3u8', async route => {
    const url = new URL(route.request().url());
    const resp = await fetch(url.origin + '/api/stream/PLAYERTEST1/hls/v360.m3u8?fixtureHls=1');
    const text = await resp.text();
    route.fulfill({
      status: 200,
      contentType: 'application/vnd.apple.mpegurl',
      body: text.replace('#EXTM3U', '#EXTM3U\n#EXT-X-START:TIME-OFFSET=-2,PRECISE=YES'),
    });
  });

  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player" muted playsinline style="width:1280px;height:720px"></video>');

  const state = await page.evaluate(async () => {
    const video = document.getElementById('player');
    video.muted = true;
    video.canPlayType = () => '';
    const engine = new window.PlayerEngine(video, { videoId: 'PLAYERTEST1', streamToken: '' });
    const player = engine.getPlayer();
    window.__engine = engine;
    window.__player = player;
    await engine.init();
    await player.load('/start-master.m3u8');
    const manifestStart = { currentTime: video.currentTime, stats: player.getStats() };
    await player.unload();
    await player.load('/start-master.m3u8', 1);
    return {
      manifestStart,
      explicitStart: { currentTime: video.currentTime, stats: player.getStats() },
    };
  });

  expect(state.manifestStart.stats.provider).toBe('native-hls');
  expect(state.manifestStart.stats.manifestStartTime).toBeCloseTo(4, 1);
  expect(state.manifestStart.currentTime).toBeCloseTo(4, 1);
  expect(state.explicitStart.currentTime).toBeCloseTo(1, 1);
  expect(shakaRequests).toHaveLength(0);
});

test('native HLS AES-128 fMP4 fixture decrypts without Shaka fallback', async ({ page }) => {
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
    return engine.init().then(() => engine.load('/api/stream/PLAYERTEST1/hls.m3u8?fixtureHls=aes'));
  });

  await expect.poll(() => page.evaluate(() => window._playerProvider)).toBe('native-hls');
  await page.evaluate(() => document.getElementById('player').play());
  await page.waitForFunction(() => document.getElementById('player').currentTime > 0, null, { timeout: 10_000 });

  const stats = await page.evaluate(() => window.__player.getStats());
  expect(stats.provider).toBe('native-hls');
  expect(stats.encryptedSegmentCount).toBeGreaterThan(0);
  expect(stats.hlsKeyFetchCount).toBe(1);
  expect(stats.hlsKeyCacheHitCount).toBeGreaterThanOrEqual(0);
  expect(stats.lastDecryptionError).toBe('');
  expect(stats.fallbackReason).toBe('');
  await expectFirstPartyNativePlayback(page, { provider: 'native-hls', mode: 'hls' });
  expect(shakaRequests).toHaveLength(0);
});

test('native HLS AES-128 key rotation decrypts without Shaka fallback', async ({ page }) => {
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
    window.__player.configure({ streaming: { bufferingGoal: 4, startupBufferGoal: 1, maxConcurrentRequests: 1 } });
    return engine.init().then(() => engine.load('/api/stream/PLAYERTEST1/hls.m3u8?fixtureHls=aes-rotate'));
  });

  await expect.poll(() => page.evaluate(() => window._playerProvider)).toBe('native-hls');
  await page.evaluate(() => document.getElementById('player').play());
  await page.waitForFunction(() => document.getElementById('player').currentTime > 3, null, { timeout: 10_000 });

  const stats = await page.evaluate(() => window.__player.getStats());
  expect(stats.provider).toBe('native-hls');
  expect(stats.encryptedSegmentCount).toBeGreaterThanOrEqual(2);
  expect(stats.hlsKeyFetchCount).toBe(2);
  expect(stats.lastDecryptionError).toBe('');
  expect(stats.fallbackReason).toBe('');
  await expectFirstPartyNativePlayback(page, { provider: 'native-hls', mode: 'hls' });
  expect(shakaRequests).toHaveLength(0);
});

test('native HLS live fixture starts near live edge without Shaka fallback', async ({ page }) => {
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
    return engine.init().then(() => engine.load('/api/stream/PLAYERTEST1/hls.m3u8?fixtureHls=live'));
  });

  await expect.poll(() => page.evaluate(() => window._playerProvider)).toBe('native-hls');
  await page.evaluate(() => document.getElementById('player').play());
  await page.waitForFunction(() => document.getElementById('player').buffered.length > 0, null, { timeout: 10_000 });

  const state = await page.evaluate(() => {
    window.__player.seekToLiveEdge();
    return {
      stats: window.__player.getStats(),
      currentTime: document.getElementById('player').currentTime,
    };
  });
  expect(state.stats.provider).toBe('native-hls');
  expect(state.stats.isLive).toBe(true);
  expect(state.stats.liveWindowEnd).toBeGreaterThan(state.stats.liveWindowStart);
  expect(state.stats.playlistMediaSequence).toBe(0);
  expect(state.currentTime).toBeGreaterThanOrEqual(state.stats.liveWindowStart);
  await expectFirstPartyNativePlayback(page, { provider: 'native-hls', mode: 'hls' });
  expect(shakaRequests).toHaveLength(0);
});

test('native HLS sliding live fixture advances its playlist window', async ({ page }) => {
  const shakaRequests = await blockShakaScript(page);
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const windows = await page.evaluate(async () => {
    const key = 'hls' + Date.now() + Math.random();
    const firstText = await fetch('/api/stream/PLAYERTEST1/hls/v360.m3u8?fixtureHls=sliding&fixtureLiveKey=' + key).then(resp => resp.text());
    const secondText = await fetch('/api/stream/PLAYERTEST1/hls/v360.m3u8?fixtureHls=sliding&fixtureLiveKey=' + key).then(resp => resp.text());
    const first = window.NativeDashProviderForTest.parseHlsPlaylist(firstText, location.origin + '/api/stream/PLAYERTEST1/hls/v360.m3u8');
    const second = window.NativeDashProviderForTest.parseHlsPlaylist(secondText, location.origin + '/api/stream/PLAYERTEST1/hls/v360.m3u8');
    return [first, second].map(item => ({
      mediaSequence: item.mediaSequence,
      liveWindow: { start: item.segments[0].start, end: item.segments[item.segments.length - 1].end },
      endList: item.endList,
    }));
  });

  expect(windows[0].endList).toBe(false);
  expect(windows[1].mediaSequence).toBeGreaterThanOrEqual(windows[0].mediaSequence);
  expect(windows[1].liveWindow.start).toBeGreaterThanOrEqual(windows[0].liveWindow.start);
  expect(windows[1].liveWindow.end).toBeGreaterThanOrEqual(windows[0].liveWindow.end);
  expect(shakaRequests).toHaveLength(0);
});

test('native HLS discontinuity fixture plays across boundary without Shaka fallback', async ({ page }) => {
  const shakaRequests = [];
  const logs = [];
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.abort();
  });
  page.on('console', msg => logs.push(msg.text()));

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
    window.__player.configure({ streaming: { bufferingGoal: 4, startupBufferGoal: 1, maxConcurrentRequests: 1 } });
    return engine.init().then(() => engine.load('/api/stream/PLAYERTEST1/hls.m3u8?fixtureHls=live-discontinuity'));
  });

  await expect.poll(() => page.evaluate(() => window._playerProvider)).toBe('native-hls');
  await page.evaluate(() => document.getElementById('player').play());
  await page.waitForFunction(() => document.getElementById('player').currentTime > 3, null, { timeout: 12_000 });

  const stats = await page.evaluate(() => window.__player.getStats());
  expect(stats.provider).toBe('native-hls');
  expect(stats.isLive).toBe(true);
  expect(stats.discontinuitySequence).toBe(3);
  expect(stats.discontinuityCount).toBeGreaterThan(0);
  expect(stats.fallbackReason).toBe('');
  expect(shakaRequests).toHaveLength(0);
  expect(logs.some(line => line.includes('falling back to shaka'))).toBe(false);
});

test('native HLS unavailable MPEG-TS transmuxer stays native with explicit terminal reason', async ({ page }) => {
  const shakaRequests = [];
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.abort();
  });
  await page.route('**/unsupported-ts.m3u8', route => route.fulfill({
    status: 200,
    contentType: 'application/vnd.apple.mpegurl',
    body: [
      '#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=800000,CODECS="avc1.42c01f"',
      '/unsupported-ts-media.m3u8',
    ].join('\n'),
  }));
  await page.route('**/unsupported-ts-media.m3u8', route => route.fulfill({
    status: 200,
    contentType: 'application/vnd.apple.mpegurl',
    body: [
      '#EXTM3U',
      '#EXT-X-TARGETDURATION:2',
      '#EXT-X-MEDIA-SEQUENCE:0',
      '#EXTINF:2,',
      '/unsupported-0.ts',
      '#EXT-X-ENDLIST',
    ].join('\n'),
  }));

  await page.goto('/auth/login');
  await page.setContent('<video id="player"></video>');
  await page.addScriptTag({ path: 'public/native-player-engine.js' });

  const stats = await page.evaluate(async () => {
    window.__nativeTsTransmuxerFactory = () => Promise.reject(new Error('hls-first-party-ts-transmuxer-unavailable'));
    const video = document.getElementById('player');
    video.canPlayType = () => '';
    const engine = new window.PlayerEngine(video, { videoId: 'TESTVIDEO01', streamToken: 'test-token' });
    window.__engine = engine;
    window.__player = engine.getPlayer();
    await engine.init();
    await engine.load('/unsupported-ts.m3u8');
    return engine.getPlayer().getStats();
  });

  expect(shakaRequests).toHaveLength(0);
  expect(stats.provider).toBe('native-hls');
  expect(stats.mode).toBe('hls');
  expect(stats.fallbackReason).toBe('');
  expect(stats.lastError).toBe('hls-first-party-ts-transmuxer-unavailable');
  expect(stats.fatalError).toBe('hls-first-party-ts-transmuxer-unavailable');
  expect(stats.nativeUnsupportedReason).toBe('hls-first-party-ts-transmuxer-unavailable');
});

test('native HLS MPEG-TS remux failure stays native with explicit terminal reason', async ({ page }) => {
  const shakaRequests = [];
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.abort();
  });
  await page.goto('/auth/login');
  await page.setContent('<video id="player"></video>');
  await page.addScriptTag({ path: 'public/native-player-engine.js' });

  const state = await page.evaluate(async () => {
    const video = document.getElementById('player');
    const engine = new window.PlayerEngine(video, { videoId: 'TESTVIDEO01', streamToken: 'test-token' });
    engine._providerName = 'native-hls';
    const segment = { start: 0, end: 2, state: 'fetched', _data: new Uint8Array([0]).buffer };
    const track = { kind: 'video', id: 'video', sb: { updating: false }, segments: [segment] };
    const provider = {
      name: 'native-hls',
      engine,
      video,
      playlistUrl: '/master.m3u8',
      isTsPlaylist: true,
      appendFailures: 0,
      rebufferDuration: 0,
      lastError: '',
      blacklisted: {},
      activeVariant: { id: '360', height: 360, codecs: 'avc1.42c01f' },
      variants: [{ id: '360', height: 360, codecs: 'avc1.42c01f' }],
      audioRenditions: [],
      subtitleRenditions: [],
      tsVideoTransmuxer: {
        provider: 'first-party-ts',
        transmux() { return Promise.reject(new Error('hls-first-party-ts-no-video')); },
      },
      _mediaTracks() { return [track]; },
      _prepareDiscontinuityAppend() { return Promise.resolve(); },
      _appendTransmuxedOutput() { return Promise.resolve(); },
      _transmuxTsSegment: window.NativeHlsProviderForTest._transmuxTsSegment,
      _appendSegmentData: window.NativeHlsProviderForTest._appendSegmentData,
      _completeNativeRuntimeTerminal: window.NativeHlsProviderForTest._completeNativeRuntimeTerminal,
      _drainAppendQueue: window.NativeHlsProviderForTest._drainAppendQueue,
      _bufferAheadGoal() { return 30; },
      _bufferBehindGoal() { return 30; },
      getActiveVariantTrack() { return null; },
      getActiveAudioTrack() { return null; },
      getAudioTracks() { return []; },
      getLiveRange() { return { start: 0, end: 0 }; },
      isLive() { return false; },
      getStats: window.NativeHlsProviderForTest.getStats,
    };
    engine._provider = provider;
    window.__player = engine.getPlayer();
    provider._drainAppendQueue(track);
    await new Promise(resolve => setTimeout(resolve, 0));
    return {
      stats: provider.getStats(),
      segmentState: segment.state,
      lastError: provider.lastError,
      fatalError: provider.fatalError,
      nativeUnsupportedReason: provider.nativeUnsupportedReason,
    };
  });

  expect(shakaRequests).toHaveLength(0);
  expect(state.segmentState).toBe('failed');
  expect(state.lastError).toBe('hls-first-party-ts-no-video');
  expect(state.fatalError).toBe('hls-first-party-ts-no-video');
  expect(state.nativeUnsupportedReason).toBe('hls-first-party-ts-no-video');
  expect(state.stats.provider).toBe('native-hls');
  expect(state.stats.fallbackReason).toBe('');
  expect(state.stats.lastError).toBe('hls-first-party-ts-no-video');
  expect(state.stats.fatalError).toBe('hls-first-party-ts-no-video');
  expect(state.stats.nativeUnsupportedReason).toBe('hls-first-party-ts-no-video');
});

test('native HLS MPEG-TS fixture uses first-party transmuxer without Shaka fallback', async ({ page }) => {
  const shakaRequests = [];
  page.on('request', request => {
    if (request.url().includes('/vendor/shaka/shaka-player.compiled.js')) shakaRequests.push(request.url());
  });

  await page.goto('/auth/login');
  await page.setContent('<video id="player" muted playsinline style="width:1280px;height:720px"></video>');
  await page.addScriptTag({ path: 'public/native-player-engine.js' });

  await page.evaluate(() => {
    window.__enableFirstPartyTsTransmuxer = true;
    const video = document.getElementById('player');
    video.muted = true;
    video.canPlayType = () => '';
    const engine = new window.PlayerEngine(video, { videoId: 'PLAYERTEST1', streamToken: '' });
    window.__engine = engine;
    window.__player = engine.getPlayer();
    window.__player.configure({ streaming: { bufferingGoal: 2, startupBufferGoal: 1, maxConcurrentRequests: 1 } });
    return engine.init().then(() => engine.load('/api/stream/PLAYERTEST1/hls.m3u8?fixtureHls=ts'));
  });

  await expect.poll(() => page.evaluate(() => window._playerProvider)).toBe('native-hls');
  await page.evaluate(() => { document.getElementById('player').play().catch(() => {}); });
  await page.waitForFunction(() => document.getElementById('player').currentTime > 0, null, { timeout: 10_000 });

  const stats = await page.evaluate(() => window.__player.getStats());
  expect(stats.provider).toBe('native-hls');
  expect(stats.mode).toBe('hls');
  expect(stats.transmuxerProvider).toBe('first-party-ts');
  expect(stats.transmuxedSegmentCount).toBeGreaterThan(0);
  expect(stats.transmuxedVideoSegmentCount).toBeGreaterThan(0);
  expect(stats.transmuxerLoadMs).toBeGreaterThan(0);
  expect(stats.fallbackReason).toBe('');
  await expectNativePlayback(page, { provider: 'native-hls', mode: 'hls', transmuxerProvider: 'first-party-ts' });
  expect(shakaRequests).toHaveLength(0);
});

test('native HLS AES-128 MPEG-TS fixture decrypts before transmuxing without fallback', async ({ page }) => {
  const shakaRequests = [];
  page.on('request', request => {
    if (request.url().includes('/vendor/shaka/shaka-player.compiled.js')) shakaRequests.push(request.url());
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
    return engine.init().then(() => engine.load('/api/stream/PLAYERTEST1/hls.m3u8?fixtureHls=ts-aes'));
  });

  await expect.poll(() => page.evaluate(() => window._playerProvider)).toBe('native-hls');
  await page.evaluate(() => { document.getElementById('player').play().catch(() => {}); });
  await page.waitForFunction(() => document.getElementById('player').currentTime > 0, null, { timeout: 10_000 });

  const stats = await page.evaluate(() => window.__player.getStats());
  expect(stats.provider).toBe('native-hls');
  expect(stats.encryptedSegmentCount).toBeGreaterThan(0);
  expect(stats.transmuxerProvider).toBe('first-party-ts');
  expect(stats.transmuxedVideoSegmentCount).toBeGreaterThan(0);
  expect(stats.lastDecryptionError).toBe('');
  expect(stats.fallbackReason).toBe('');
  await expectNativePlayback(page, { provider: 'native-hls', mode: 'hls', transmuxerProvider: 'first-party-ts' });
  expect(shakaRequests).toHaveLength(0);
});

test('native HLS MPEG-TS muxed audio/video plays without Shaka fallback', async ({ page }) => {
  const shakaRequests = [];
  page.on('request', request => {
    if (request.url().includes('/vendor/shaka/shaka-player.compiled.js')) shakaRequests.push(request.url());
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
    return engine.init().then(() => engine.load('/api/stream/PLAYERTEST1/hls.m3u8?fixtureHls=ts-muxed'));
  });

  await expect.poll(() => page.evaluate(() => window._playerProvider)).toBe('native-hls');
  await page.evaluate(() => { document.getElementById('player').play().catch(() => {}); });
  await page.waitForFunction(() => document.getElementById('player').currentTime > 0, null, { timeout: 10_000 });

  const stats = await page.evaluate(() => window.__player.getStats());
  expect(stats.provider).toBe('native-hls');
  expect(stats.muxedTsAudio).toBe(true);
  expect(stats.transmuxerProvider).toBe('first-party-ts');
  expect(stats.transmuxedVideoSegmentCount).toBeGreaterThan(0);
  expect(stats.transmuxedAudioSegmentCount).toBeGreaterThan(0);
  expect(stats.fallbackReason).toBe('');
  await expectNativePlayback(page, { provider: 'native-hls', mode: 'hls', transmuxerProvider: 'first-party-ts' });
  expect(shakaRequests).toHaveLength(0);
});

test('native HLS MPEG-TS audio group plays without Shaka fallback', async ({ page }) => {
  const shakaRequests = [];
  page.on('request', request => {
    if (request.url().includes('/vendor/shaka/shaka-player.compiled.js')) shakaRequests.push(request.url());
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
    return engine.init().then(() => engine.load('/api/stream/PLAYERTEST1/hls.m3u8?fixtureHls=ts-groups'));
  });

  await expect.poll(() => page.evaluate(() => window._playerProvider)).toBe('native-hls');
  await page.evaluate(() => { document.getElementById('player').play().catch(() => {}); });
  await page.waitForFunction(() => document.getElementById('player').currentTime > 0, null, { timeout: 10_000 });

  const stats = await page.evaluate(() => window.__player.getStats());
  expect(stats.provider).toBe('native-hls');
  expect(stats.muxedTsAudio).toBe(false);
  expect(stats.activeAudio).toMatchObject({ language: 'en', label: 'English' });
  expect(stats.transmuxerProvider).toBe('first-party-ts');
  expect(stats.transmuxedVideoSegmentCount).toBeGreaterThan(0);
  expect(stats.transmuxedAudioSegmentCount).toBeGreaterThan(0);
  expect(stats.fallbackReason).toBe('');
  await expectNativePlayback(page, { provider: 'native-hls', mode: 'hls', transmuxerProvider: 'first-party-ts' });
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
  expect(stats.fallbackReason).toBe('');
  await expectFirstPartyNativePlayback(page, { provider: 'native-hls', mode: 'hls' });
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
  expect(state.stats.fallbackReason).toBe('');
  await expectFirstPartyNativePlayback(page, { provider: 'native-hls', mode: 'hls' });
  expect(shakaRequests).toHaveLength(0);
});

test('unsupported HLS audio codec stays native with explicit terminal reason', async ({ page }) => {
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
    route.abort();
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
  expect(stats.provider).toBe('native-hls');
  expect(stats.fallbackReason).toBe('');
  expect(stats.lastError).toBe('hls-no-supported-audio');
  expect(stats.fatalError).toBe('hls-no-supported-audio');
  expect(stats.nativeUnsupportedReason).toBe('hls-no-supported-audio');
  expect(stats.unsupportedAudioCount).toBeGreaterThan(0);
  expect(shakaRequests).toHaveLength(0);
});

test('unsupported HLS video variants stay native with explicit terminal reason', async ({ page }) => {
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
    route.abort();
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
  expect(stats.provider).toBe('native-hls');
  expect(stats.fallbackReason).toBe('');
  expect(stats.lastError).toBe('hls-no-supported-video');
  expect(stats.fatalError).toBe('hls-no-supported-video');
  expect(stats.nativeUnsupportedReason).toBe('hls-no-supported-video');
  expect(stats.unsupportedVideoCount).toBeGreaterThan(0);
  expect(shakaRequests).toHaveLength(0);
});

test('unsupported encrypted HLS stays native with explicit terminal reason', async ({ page }) => {
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
      body: '#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="/key"\n#EXTINF:2,\nseg.m4s\n#EXT-X-ENDLIST',
    });
  });
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.abort();
  });

  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const stats = await page.evaluate(() => {
    const video = document.getElementById('player');
    video.canPlayType = () => '';
    const engine = new window.PlayerEngine(video, { videoId: 'HLSUNSUP001', streamToken: 'test-token' });
    window.__player = engine.getPlayer();
    return engine.init().then(() => engine.load()).then(() => engine.getPlayer().getStats());
  });

  expect(shakaRequests).toHaveLength(0);
  expect(stats.provider).toBe('native-hls');
  expect(stats.fallbackReason).toBe('');
  expect(stats.lastError).toBe('hls-sample-aes-unsupported');
  expect(stats.fatalError).toBe('hls-sample-aes-unsupported');
  expect(stats.nativeUnsupportedReason).toBe('hls-sample-aes-unsupported');
  expect(stats.hlsEncryptionMethod).toBe('SAMPLE-AES');
  expect(stats.hlsKeyFormat).toBe('identity');
});

test('supported internal HLS uses first-party provider and live-like stats', async ({ page }) => {
  const shakaRequests = await blockShakaScript(page);
  await page.route('**/api/stream/PLAYERTEST1/dash.mpd**', route => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ hls: '/api/stream/PLAYERTEST1/hls.m3u8?fixtureHls=live', via: 'fixture' }),
    });
  });

  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player" muted playsinline style="width:1280px;height:720px"></video>');

  const stats = await page.evaluate(() => {
    const video = document.getElementById('player');
    video.muted = true;
    video.canPlayType = type => /mpegurl/i.test(type) ? 'probably' : '';
    const engine = new window.PlayerEngine(video, { videoId: 'PLAYERTEST1', streamToken: 'test-token' });
    window.__player = engine.getPlayer();
    window.__player.configure({ streaming: { bufferingGoal: 2, startupBufferGoal: 1, maxConcurrentRequests: 1 } });
    return engine.init().then(() => engine.load()).then(() => engine.getPlayer().getStats());
  });

  expect(await page.evaluate(() => window._playerProvider)).toBe('native-hls');
  expect(stats.provider).toBe('native-hls');
  expect(stats.mode).toBe('hls');
  expect(stats.isLive).toBe(true);
  expect(stats.assetUri).toContain('/api/stream/PLAYERTEST1/hls.m3u8?fixtureHls=live');
  expect(stats.assetUri).toContain('token=test-token');
  expect(stats.fallbackReason).toBe('');
  expect(shakaRequests).toHaveLength(0);
});

test('native URL load retries once before succeeding', async ({ page }) => {
  const shakaRequests = await blockShakaScript(page);
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
  expect(stats.fallbackReason).toBe('');
  expect(stats.recoveryCount).toBe(1);
  expect(stats.loads).toBe(2);
  expect(shakaRequests).toHaveLength(0);
});

test('native URL load exhaustion stays native with explicit terminal reason', async ({ page }) => {
  const shakaRequests = [];
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.abort();
  });

  await page.goto('/auth/login');
  await page.setContent('<video id="player"></video>');
  await page.addScriptTag({ path: 'public/native-player-engine.js' });

  const stats = await page.evaluate(() => {
    const video = document.getElementById('player');
    let loads = 0;
    video.load = () => {
      loads++;
      setTimeout(() => video.dispatchEvent(new Event('error')), 0);
    };
    const engine = new window.PlayerEngine(video, { videoId: 'TESTVIDEO03', streamToken: 'test-token' });
    window.__engine = engine;
    window.__player = engine.getPlayer();
    return engine.init().then(() => engine.load('/fixture/missing.mp4')).then(() => {
      const result = engine.getPlayer().getStats();
      result.loads = loads;
      return result;
    });
  });

  expect(shakaRequests).toHaveLength(0);
  expect(stats.provider).toBe('native-url');
  expect(stats.mode).toBe('progressive');
  expect(stats.fallbackReason).toBe('');
  expect(stats.loads).toBe(2);
  expect(stats.recoveryCount).toBe(1);
  expect(stats.lastError).toBe('native-url-error');
  expect(stats.fatalError).toBe('native-url-error');
  expect(stats.nativeUnsupportedReason).toBe('native-url-error');
});

test('native URL runtime error exhaustion stays native with explicit terminal reason', async ({ page }) => {
  const shakaRequests = [];
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.abort();
  });

  await page.goto('/auth/login');
  await page.setContent('<video id="player"></video>');
  await page.addScriptTag({ path: 'public/native-player-engine.js' });

  const stats = await page.evaluate(() => {
    const video = document.getElementById('player');
    let loads = 0;
    video.load = () => {
      loads++;
      if (loads === 1) setTimeout(() => video.dispatchEvent(new Event('loadedmetadata')), 0);
    };
    const engine = new window.PlayerEngine(video, { videoId: 'TESTVIDEO03', streamToken: 'test-token' });
    window.__engine = engine;
    window.__player = engine.getPlayer();
    return engine.init().then(() => engine.load('/fixture/video.mp4')).then(() => {
      const provider = engine._provider;
      provider._onRuntimeError();
      provider._onRuntimeError();
      const result = engine.getPlayer().getStats();
      result.loads = loads;
      return result;
    });
  });

  expect(shakaRequests).toHaveLength(0);
  expect(stats.provider).toBe('native-url');
  expect(stats.mode).toBe('progressive');
  expect(stats.fallbackReason).toBe('');
  expect(stats.loads).toBe(2);
  expect(stats.recoveryCount).toBe(1);
  expect(stats.lastError).toBe('native-url-error');
  expect(stats.fatalError).toBe('native-url-error');
  expect(stats.nativeUnsupportedReason).toBe('native-url-error');
});
