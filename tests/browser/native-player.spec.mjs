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

test('first-party MPEG-TS timeline unwraps 33-bit PTS rollover per discontinuity generation', async ({ page }) => {
  await setPlayerContent(page, '<video id="player"></video>');

  const state = await page.evaluate(() => {
    const rolloverSeconds = 8589934592 / 90000;
    const timeline = { clockByPid: {}, rolloverCount: 0 };
    const before = {
      tracks: [{ pid: 256, type: 'video', pes: [{ dts: rolloverSeconds - 0.02, pts: rolloverSeconds - 0.01 }] }],
    };
    const after = {
      tracks: [{ pid: 256, type: 'video', pes: [{ dts: 0.01, pts: 0.02 }] }],
    };
    const firstRollovers = window.NativeTsTransmuxerForTest.normalizeHlsTsDemuxTimestamps(timeline, before);
    const secondRollovers = window.NativeTsTransmuxerForTest.normalizeHlsTsDemuxTimestamps(timeline, after);
    const nextGenerationTimeline = { clockByPid: {}, rolloverCount: 0 };
    const nextGeneration = {
      tracks: [{ pid: 256, type: 'video', pes: [{ dts: 0.01, pts: 0.02 }] }],
    };
    window.NativeTsTransmuxerForTest.normalizeHlsTsDemuxTimestamps(nextGenerationTimeline, nextGeneration);
    return {
      firstRollovers,
      secondRollovers,
      beforeDts: before.tracks[0].pes[0].normalizedDts,
      afterDts: after.tracks[0].pes[0].normalizedDts,
      afterPts: after.tracks[0].pes[0].normalizedPts,
      nextGenerationDts: nextGeneration.tracks[0].pes[0].normalizedDts,
      totalRollovers: timeline.rolloverCount,
    };
  });

  expect(state.firstRollovers).toBe(0);
  expect(state.secondRollovers).toBe(1);
  expect(state.afterDts).toBeGreaterThan(state.beforeDts);
  expect(state.afterDts - state.beforeDts).toBeCloseTo(0.03, 4);
  expect(state.afterPts - state.afterDts).toBeCloseTo(0.01, 4);
  expect(state.nextGenerationDts).toBeCloseTo(0.01, 4);
  expect(state.totalRollovers).toBe(1);
});

test('first-party MPEG-TS timeline maps a later segment before an earlier segment without rebasing', async ({ page }) => {
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const state = await page.evaluate(async () => {
    const bytes = await fetch('/api/stream/PLAYERTEST1/hls-ts/v360.ts?fixtureTs=video').then(response => response.arrayBuffer());
    const ts = window.NativeTsTransmuxerForTest;
    const hls = window.NativeHlsProviderForTest;
    const provider = { hlsTsTimelineByGeneration: {}, hlsTsOutOfOrderSegmentCount: 0 };
    const generationKey = 'video:out-of-order-seek';
    const laterDemux = ts.demuxMpegTs(bytes);
    laterDemux.tracks.forEach(track => track.pes.forEach(pes => {
      if (Number.isFinite(pes.dts)) pes.dts += 10;
      if (Number.isFinite(pes.pts)) pes.pts += 10;
    }));
    const laterContext = ts.prepareHlsTsTransmuxContext(provider, { kind: 'video' }, {
      start: 10,
      end: 16,
      _hlsTimestampGenerationKey: generationKey,
    }, bytes, laterDemux);
    const decodeOrigin = laterContext.timeline.decodeOrigin;
    const adapter = new ts.FirstPartyTsTransmuxerAdapter('video', 'avc1.42c01f');
    const laterOutput = await adapter.transmux(bytes, {
      activeVariant: { width: 640, height: 360 },
      demux: laterContext.demux,
      timeline: laterContext.timeline,
    });

    const earlierDemux = ts.demuxMpegTs(bytes);
    const earlierContext = ts.prepareHlsTsTransmuxContext(provider, { kind: 'video' }, {
      start: 0,
      end: 6,
      _hlsTimestampGenerationKey: generationKey,
    }, bytes, earlierDemux);
    const earlierOutput = await adapter.transmux(bytes, {
      activeVariant: { width: 640, height: 360 },
      demux: earlierContext.demux,
      timeline: earlierContext.timeline,
    });

    function timing(output) {
      const info = hls.parseMp4InitTrackInfo(output.init).find(track => track.handlerType === 'vide');
      const fragment = hls.parseMp4FragmentTimestamp(output.data, info.trackId);
      return {
        decode: fragment.decodeTime / info.timescale,
        mappedPresentation: fragment.presentationTime / info.timescale + output.timestampOffset,
      };
    }
    return {
      later: timing(laterOutput),
      earlier: timing(earlierOutput),
      decodeOriginStable: earlierContext.timeline.decodeOrigin === decodeOrigin,
      timestampOffsetsMatch: earlierOutput.timestampOffset === laterOutput.timestampOffset,
      outOfOrderCount: provider.hlsTsOutOfOrderSegmentCount,
    };
  });

  expect(state.decodeOriginStable).toBe(true);
  expect(state.timestampOffsetsMatch).toBe(true);
  expect(state.outOfOrderCount).toBe(1);
  expect(state.later.mappedPresentation).toBeCloseTo(10, 2);
  expect(state.earlier.mappedPresentation).toBeCloseTo(0, 2);
  expect(state.earlier.decode).toBeGreaterThan(50);
  expect(state.earlier.decode).toBeLessThan(state.later.decode);
});

test('first-party MPEG-TS timeline preserves B-frame composition and muxed A/V skew with one demux', async ({ page }) => {
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const state = await page.evaluate(async () => {
    const bytes = await fetch('/api/stream/PLAYERTEST1/hls-ts/v360.ts?fixtureTs=muxed').then(response => response.arrayBuffer());
    const ts = window.NativeTsTransmuxerForTest;
    const hls = window.NativeHlsProviderForTest;
    const demux = ts.demuxMpegTs(bytes);
    const videoTrack = demux.tracks.find(track => track.type === 'video');
    const audioTrack = demux.tracks.find(track => track.type === 'audio');
    videoTrack.pes.forEach((pes, index) => {
      if (!Number.isFinite(pes.dts)) return;
      pes.pts = pes.dts + (index % 3 === 1 ? -0.02 : 0.04);
    });
    audioTrack.pes.forEach(pes => {
      if (Number.isFinite(pes.dts)) pes.dts += 0.125;
      if (Number.isFinite(pes.pts)) pes.pts += 0.125;
    });
    const expectedFirstAvOffset = audioTrack.pes[0].pts - videoTrack.pes[0].pts;
    const provider = { hlsTsTimelineByGeneration: {} };
    const segment = {
      start: 10,
      end: 16,
      duration: 6,
      discontinuitySequence: 3,
      _hlsTimestampGenerationKey: 'video:test:disc=3',
    };
    const context = ts.prepareHlsTsTransmuxContext(provider, { kind: 'video' }, segment, bytes, demux);
    const videoAdapter = new ts.FirstPartyTsTransmuxerAdapter('video', 'avc1.42c01f');
    const audioAdapter = new ts.FirstPartyTsTransmuxerAdapter('audio', 'mp4a.40.2');
    const videoOutput = await videoAdapter.transmux(bytes, {
      activeVariant: { width: 640, height: 360 },
      demux: context.demux,
      timeline: context.timeline,
    });
    const audioOutput = await audioAdapter.transmux(bytes, {
      demux: context.demux,
      timeline: context.timeline,
    });
    const videoInfo = hls.parseMp4InitTrackInfo(videoOutput.init).find(track => track.handlerType === 'vide');
    const audioInfo = hls.parseMp4InitTrackInfo(audioOutput.init).find(track => track.handlerType === 'soun');
    const videoTiming = hls.parseMp4FragmentTimestamp(videoOutput.data, videoInfo.trackId);
    const audioTiming = hls.parseMp4FragmentTimestamp(audioOutput.data, audioInfo.trackId);
    const mappedVideoStart = videoTiming.presentationTime / videoInfo.timescale + videoOutput.timestampOffset;
    const mappedAudioStart = audioTiming.presentationTime / audioInfo.timescale + audioOutput.timestampOffset;
    return {
      sameDemux: videoAdapter.lastDemux === audioAdapter.lastDemux,
      timestampOffsetsMatch: videoOutput.timestampOffset === audioOutput.timestampOffset,
      expectedFirstAvOffset,
      mappedAvOffset: mappedAudioStart - mappedVideoStart,
      videoCompositionOffset: videoTiming.compositionOffset / videoInfo.timescale,
      compositionOffsetSampleCount: videoOutput.compositionOffsetSampleCount,
      maxCompositionOffsetMs: videoOutput.maxCompositionOffsetMs,
      providerAvOffsetMs: provider.hlsTsMuxedAvStartOffsetMs,
    };
  });

  expect(state.sameDemux).toBe(true);
  expect(state.timestampOffsetsMatch).toBe(true);
  expect(state.mappedAvOffset).toBeCloseTo(state.expectedFirstAvOffset, 3);
  expect(state.videoCompositionOffset).toBeCloseTo(0.04, 3);
  expect(state.compositionOffsetSampleCount).toBeGreaterThan(0);
  expect(state.maxCompositionOffsetMs).toBeGreaterThanOrEqual(39);
  expect(Math.abs(state.providerAvOffsetMs)).toBeGreaterThan(50);
});

test('first-party MPEG-TS appends init only when the SourceBuffer or codec configuration changes', async ({ page }) => {
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const state = await page.evaluate(async () => {
    const bytes = await fetch('/api/stream/PLAYERTEST1/hls-ts/v360.ts?fixtureTs=video').then(response => response.arrayBuffer());
    const adapter = new window.NativeTsTransmuxerForTest.FirstPartyTsTransmuxerAdapter('video', 'avc1.42c01f');
    const provider = {
      hlsTsTimelineByGeneration: {},
      hlsTsInitAppendCount: 0,
      hlsTsInitSkipCount: 0,
      hlsTransmuxedTimestampResolutionCount: 0,
      live: false,
      _alignTsStartupTime() {},
    };
    const segment = { start: 0, end: 6, _hlsTimestampGenerationKey: 'video:init-dedup' };
    const context = window.NativeTsTransmuxerForTest.prepareHlsTsTransmuxContext(
      provider,
      { kind: 'video' },
      segment,
      bytes,
    );
    const output = await adapter.transmux(bytes, {
      activeVariant: { width: 640, height: 360 },
      demux: context.demux,
      timeline: context.timeline,
    });
    const listeners = {};
    const sourceBuffer = {
      updating: false,
      timestampOffset: 0,
      appendCalls: 0,
      addEventListener(name, listener) { listeners[name] = listener; },
      removeEventListener(name) { delete listeners[name]; },
      appendBuffer() {
        this.appendCalls += 1;
        setTimeout(() => listeners.updateend?.(), 0);
      },
    };
    const track = { kind: 'video' };
    await window.NativeHlsProviderForTest._appendTransmuxedOutput.call(provider, sourceBuffer, output, track, segment);
    await window.NativeHlsProviderForTest._appendTransmuxedOutput.call(provider, sourceBuffer, output, track, segment);
    return {
      appendCalls: sourceBuffer.appendCalls,
      initAppendCount: provider.hlsTsInitAppendCount,
      initSkipCount: provider.hlsTsInitSkipCount,
    };
  });

  expect(state.appendCalls).toBe(3);
  expect(state.initAppendCount).toBe(1);
  expect(state.initSkipCount).toBe(1);
});

test('watch page loads native player without eager-loading Shaka', async ({ request }) => {
  const login = await request.post('/auth/free', { maxRedirects: 0 });
  expect(login.status()).toBeGreaterThanOrEqual(300);
  expect(login.status()).toBeLessThan(400);

  const watch = await request.get('/watch?v=dQw4w9WgXcQ');
  expect(watch.status()).toBe(200);
  const html = await watch.text();

  expect(html).toContain('/native-player-engine.min.js');
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

});

test('Today thumbnails use full document navigation for streamed watch pages', async ({ page }) => {
  const watchRequestTypes = [];
  page.on('request', request => {
    if (request.url().includes('/watch?v=TODAYVIDEO1')) watchRequestTypes.push(request.resourceType());
  });
  await page.route('**/watch?v=TODAYVIDEO1', route => route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: '<!doctype html><title>Today watch</title><main><h1 id="today-watch">Today watch</h1></main>',
  }));
  await page.goto('/auth/login');
  await page.setContent([
    '<nav><span class="nav-status"><span id="stream-via"></span><span id="load-timer"></span></span></nav>',
    '<main><div class="video-grid"><a id="today-card" class="video-card" href="/watch?v=TODAYVIDEO1">Today video</a></div></main>',
  ].join(''));
  await page.addScriptTag({ path: 'public/app.js' });

  await page.click('#today-card');
  await expect(page.locator('#today-watch')).toHaveText('Today watch');
  expect(watchRequestTypes).toEqual(['document']);
});

test('Explore thumbnails use full document navigation for streamed watch pages', async ({ page }) => {
  const watchRequestTypes = [];
  page.on('request', request => {
    if (request.url().includes('/watch?v=EXPLOREVID1')) watchRequestTypes.push(request.resourceType());
  });
  await page.route('**/watch?v=EXPLOREVID1', route => route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: '<!doctype html><title>Explore watch</title><main><h1 id="explore-watch">Explore watch</h1></main>',
  }));
  await page.goto('/auth/login');
  await page.setContent([
    '<nav><span class="nav-status"><span id="stream-via"></span><span id="load-timer"></span></span></nav>',
    '<main><div class="video-grid" data-session-id="test-session">',
    '<a id="explore-card" class="video-card" data-channel-id="channel" data-explore-pos="0" href="/watch?v=EXPLOREVID1">Explore video</a>',
    '</div></main>',
  ].join(''));
  await page.addScriptTag({ path: 'public/app.js' });

  await page.click('#explore-card');
  await expect(page.locator('#explore-watch')).toHaveText('Explore watch');
  expect(watchRequestTypes).toEqual(['document']);
});

test('PJAX navigation waits for an in-flight page runtime before initializing', async ({ page }) => {
  let releaseRuntime;
  await page.route('**/test-player-runtime.js', async route => {
    await new Promise(resolve => { releaseRuntime = resolve; });
    await route.fulfill({
      status: 200,
      contentType: 'text/javascript',
      body: 'window.__testPlayerRuntimeReady = true;',
    });
  });

  await page.goto('/auth/login');
  await page.setContent([
    '<nav><span class="nav-status"><span id="stream-via"></span><span id="load-timer"></span></span></nav>',
    '<main><div class="video-grid">',
    '<a id="runtime-first" href="/channel/runtime-first">First</a>',
    '<a id="runtime-second" href="/channel/runtime-second">Second</a>',
    '</div></main>',
  ].join(''));
  await page.addScriptTag({
    content: `
      window.fetch = function(url) {
        var href = String(url);
        var match = href.match(/\\/channel\\/(runtime-(?:first|second))/);
        if (match) {
          var pageId = match[1];
          return Promise.resolve(new Response(
            '<!doctype html><head><title>' + pageId + '</title><script src="/test-player-runtime.js"><\\/script></head>' +
            '<body><main><h1>' + pageId + '</h1><script>window.__initializedPage = window.__testPlayerRuntimeReady ? "' + pageId + '" : "missing-runtime";<\\/script></main></body>',
            { status: 200, headers: { 'Content-Type': 'text/html' } }
          ));
        }
        return Promise.resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
      };
    `,
  });
  await page.addScriptTag({ path: 'public/app.js' });

  await page.click('#runtime-first');
  await expect.poll(() => Boolean(releaseRuntime)).toBe(true);
  await page.click('#runtime-second');
  releaseRuntime();

  await expect.poll(() => page.evaluate(() => window.__initializedPage)).toBe('runtime-second');
  await expect(page.locator('main h1')).toHaveText('runtime-second');
});

test('stalled PJAX page navigation falls back to a full document request', async ({ page }) => {
  await page.route('**/channel/stalled', route => route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: '<!doctype html><title>Recovered</title><main><h1 id="recovered-page">Recovered page</h1></main>',
  }));
  await page.goto('/auth/login');
  await page.setContent([
    '<nav><span class="nav-status"><span id="stream-via"></span><span id="load-timer"></span></span></nav>',
    '<main><a id="stalled-page" href="/channel/stalled">Open page</a></main>',
  ].join(''));
  await page.addScriptTag({
    content: `
      window.__navigationTimeoutMs = 50;
      window.fetch = function(url, options) {
        if (String(url).indexOf('/channel/stalled') !== -1) {
          return new Promise(function(_resolve, reject) {
            if (options && options.signal) {
              options.signal.addEventListener('abort', function() {
                reject(new DOMException('aborted', 'AbortError'));
              }, { once: true });
            }
          });
        }
        return Promise.resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
      };
    `,
  });
  await page.addScriptTag({ path: 'public/app.js' });

  await page.click('#stalled-page');
  await expect(page.locator('#recovered-page')).toHaveText('Recovered page');
  await expect(page).toHaveURL(/\/channel\/stalled$/);
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

  const result = await page.evaluate(async () => {
    const video = document.getElementById('player');
    const engine = new window.PlayerEngine(video, { videoId: 'TESTVIDEO01', streamToken: 'test-token' });
    window.__engine = engine;
    window.__player = engine.getPlayer();
    await engine.init();
    let error = null;
    try { await engine.load(); } catch (err) {
      error = { message: err.message, nativeTerminal: !!err.nativeTerminal, phase: err.phase };
    }
    return { error, stats: engine.getPlayer().getStats() };
  });
  const { stats } = result;

  expect(shakaRequests).toHaveLength(0);
  expect(result.error).toEqual({ message: 'dash-no-supported-video', nativeTerminal: true, phase: 'load' });
  expect(await page.evaluate(() => window._playerProvider)).toBe('native-dash');
  expect(stats.provider).toBe('native-dash');
  expect(stats.fallbackReason).toBe('');
  expect(stats.lastError).toBe('dash-no-supported-video');
  expect(stats.fatalError).toBe('dash-no-supported-video');
  expect(stats.nativeUnsupportedReason).toBe('dash-no-supported-video');
  expect(stats.terminalErrorCount).toBe(1);
  expect(stats.terminalErrorPhase).toBe('load');
  expect(stats.providerTerminalQuiesced).toBe(true);
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

  const result = await page.evaluate(async () => {
    const video = document.getElementById('player');
    const engine = new window.PlayerEngine(video, { videoId: 'DASHAUDIOBAD', streamToken: 'test-token' });
    window.__engine = engine;
    window.__player = engine.getPlayer();
    await engine.init();
    let error = null;
    try { await engine.load(); } catch (err) {
      error = { message: err.message, nativeTerminal: !!err.nativeTerminal, phase: err.phase };
    }
    return { error, stats: engine.getPlayer().getStats() };
  });
  const { stats } = result;

  expect(shakaRequests).toHaveLength(0);
  expect(result.error).toEqual({ message: 'dash-no-supported-audio', nativeTerminal: true, phase: 'load' });
  expect(stats.provider).toBe('native-dash');
  expect(stats.fallbackReason).toBe('');
  expect(stats.lastError).toBe('dash-no-supported-audio');
  expect(stats.fatalError).toBe('dash-no-supported-audio');
  expect(stats.nativeUnsupportedReason).toBe('dash-no-supported-audio');
  expect(stats.terminalErrorCount).toBe(1);
  expect(stats.terminalErrorPhase).toBe('load');
  expect(stats.providerTerminalQuiesced).toBe(true);
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

  const result = await page.evaluate(async () => {
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
  expect(result.stats.playerState).toBe('error');
  expect(result.stats.terminalErrorCount).toBe(1);
  expect(result.stats.terminalErrorPhase).toBe('load');
  expect(result.stats.providerTerminalQuiesced).toBe(true);
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

  const result = await page.evaluate(async () => {
    const mpd = '<?xml version="1.0"?><MPD type="static" mediaPresentationDuration="PT1S"><Period></Period></MPD>';
    const dataUrl = 'data:application/dash+xml;base64,' + btoa(mpd);
    const video = document.getElementById('player');
    const engine = new window.PlayerEngine(video, { videoId: 'TESTVIDEO01', streamToken: 'test-token' });
    await engine.init();
    let loadError = null;
    try { await engine.load(dataUrl); } catch (err) {
      loadError = { message: err.message, nativeTerminal: !!err.nativeTerminal, phase: err.phase };
    }
    return { loadError, stats: engine.getPlayer().getStats() };
  });
  const { stats } = result;

  expect(result.loadError).toEqual({ message: 'dash-no-supported-video', nativeTerminal: true, phase: 'load' });
  expect(stats.provider).toBe('native-dash');
  expect(stats.fallbackReason).toBe('');
  expect(stats.lastError).toBe('dash-no-supported-video');
  expect(stats.nativeUnsupportedReason).toBe('dash-no-supported-video');
  expect(stats.providerTerminalQuiesced).toBe(true);
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
    let loadError = null;
    try { await engine.load('/native-only.m3u8', undefined, 'application/vnd.apple.mpegurl'); } catch (err) {
      loadError = { message: err.message, nativeTerminal: !!err.nativeTerminal, phase: err.phase };
    }
    return {
      providerName: engine._providerName,
      state: engine._state,
      loadError,
      stats: engine.getPlayer().getStats(),
    };
  });

  expect(shakaRequests).toHaveLength(0);
  expect(state.providerName).toBe('native-terminal');
  expect(state.state).toBe('error');
  expect(state.loadError).toEqual({ message: 'mse-unavailable', nativeTerminal: true, phase: 'load' });
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
    let loadError = null;
    try { await engine.load('/manifest-503.mpd'); } catch (err) {
      loadError = { message: err.message, nativeTerminal: !!err.nativeTerminal, phase: err.phase };
    }
    return {
      providerName: engine._providerName,
      state: engine._state,
      loadError,
      stats: engine.getPlayer().getStats(),
    };
  });

  expect(shakaRequests).toHaveLength(0);
  expect(state.providerName).toBe('native-terminal');
  expect(state.state).toBe('error');
  expect(state.loadError).toEqual({ message: 'manifest-http-503', nativeTerminal: true, phase: 'load' });
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
    let loadError = null;
    try { await engine.load('/bad-manifest-json'); } catch (err) {
      loadError = { message: err.message, nativeTerminal: !!err.nativeTerminal, phase: err.phase };
    }
    const stats = engine.getPlayer().getStats();
    return {
      providerName: engine._providerName,
      state: engine._state,
      loadError,
      stats,
    };
  });

  expect(shakaRequests).toHaveLength(0);
  expect(state.providerName).toBe('native-terminal');
  expect(state.state).toBe('error');
  expect(state.loadError.nativeTerminal).toBe(true);
  expect(state.loadError.phase).toBe('load');
  expect(state.loadError.message).toContain('JSON');
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
    let loadError = null;
    try { await engine.load('/opaque.mpd'); } catch (err) {
      loadError = { message: err.message, nativeTerminal: !!err.nativeTerminal, phase: err.phase };
    }
    return {
      providerName: engine._providerName,
      state: engine._state,
      loadError,
      stats: engine.getPlayer().getStats(),
    };
  });

  expect(shakaRequests).toHaveLength(0);
  expect(state.providerName).toBe('native-terminal');
  expect(state.state).toBe('error');
  expect(state.loadError).toEqual({ message: 'opaque-native-load-error', nativeTerminal: true, phase: 'load' });
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
    let loadError = null;
    try { await engine.load('/opaque-provider.mpd'); } catch (err) {
      loadError = { message: err.message, nativeTerminal: !!err.nativeTerminal, phase: err.phase };
    }
    return {
      providerName: engine._providerName,
      state: engine._state,
      loadError,
      stats: engine.getPlayer().getStats(),
    };
  });

  expect(shakaRequests).toHaveLength(0);
  expect(state.providerName).toBe('native-dash');
  expect(state.state).toBe('error');
  expect(state.loadError).toEqual({ message: 'opaque-provider-load-error', nativeTerminal: true, phase: 'load' });
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
  expect(state.current.abr.defaultBandwidthEstimate).toBe(500_000);
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
    const hlsAppendOwner = { id: 'stale-video-append' };
    hls.segments[0].state = 'appending';
    hls.segments[0]._appendOwner = hlsAppendOwner;
    hls._videoTrack = {
      segments: hls.segments,
      _appending: true,
      _appendOwner: hlsAppendOwner,
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
        appendEpoch: hls.hlsAppendEpoch || 0,
        appendInvalidationCount: hls.hlsAppendInvalidationCount || 0,
        appendInvalidationReason: hls.lastHlsAppendInvalidationReason || '',
        seekAbortCount: hls.seekAbortCount,
        seekCount: hls.seekCount,
        seekBufferPending: hls.seekBufferPending,
        seekInteractionPending: hls.seekInteractionPending,
        lastSeekTarget: hls.lastSeekTarget,
        hlsAborted,
        states: hlsStates,
        ticked: hls.ticked,
        appending: hls._appending,
        videoTrackAppending: hls._videoTrack._appending,
        videoTrackAppendOwner: hls._videoTrack._appendOwner,
        videoSegmentAppendOwner: hls.segments[0]._appendOwner || null,
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
  expect(state.hls.appendEpoch).toBe(1);
  expect(state.hls.appendInvalidationCount).toBe(1);
  expect(state.hls.appendInvalidationReason).toBe('seek');
  expect(state.hls.seekAbortCount).toBe(3);
  expect(state.hls.seekCount).toBe(1);
  expect(state.hls.seekBufferPending).toBe(true);
  expect(state.hls.seekInteractionPending).toBe(false);
  expect(state.hls.lastSeekTarget).toBe(30);
  expect(state.hls.hlsAborted).toBe(1);
  expect(state.hls.states).toContain('seeking');
  expect(state.hls.states).not.toContain('ready');
  expect(state.hls.ticked).toBe(true);
  expect(state.hls.appending).toBe(false);
  expect(state.hls.videoTrackAppending).toBe(false);
  expect(state.hls.videoTrackAppendOwner).toBe(null);
  expect(state.hls.videoSegmentAppendOwner).toBe(null);
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
  const seekBar = readFileSync('views/player/seek-bar.ejs', 'utf8');
  const controls = readFileSync('views/player/controls-setup.ejs', 'utf8');
  expect(seekBar).toContain("document.removeEventListener('mousemove', onPlayerSeekMouseMove)");
  expect(seekBar).toContain("document.removeEventListener('mouseup', onPlayerSeekMouseUp)");
  expect(controls).toContain("document.removeEventListener('click', onPlayerDocumentClick)");
  expect(controls).toContain("document.removeEventListener('fullscreenchange', updateFsIcon)");
  expect(seekBar).toContain('if (window._playerEngine !== engine) return;');
  expect(seekBar).not.toContain('seekRestoreTimer');
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
  expect(html).toContain("setMediaSessionAction('seekbackward', function () { playerSeekTo");
  expect(html).toContain("setMediaSessionAction('seekforward', function () { playerSeekTo");
  expect(html).toContain("setMediaSessionAction('seekto', function (d) { if (d.seekTime != null) playerSeekTo(d.seekTime); });");
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

test('watch page renders centralized non-blocking metadata and playlist startup', () => {
  const route = readFileSync('routes/player.ts', 'utf8');
  const player = readFileSync('views/player.ejs', 'utf8');

  expect(route).toContain('const [cachedVideo, fetchedPlaylist, bootstrap, downloadedFormats] = await Promise.all([');
  expect(route).toContain('resolveThisTurn(videoP),');
  expect(route).toContain('resolveThisTurn(playlistP),');
  expect(route).toContain('let video = cachedVideo;');
  expect(route).toContain("router.get('/playlist-context'");
  expect(route).not.toContain('video = await videoP;');
  expect(route).not.toContain('const fetchedPlaylist = await playlistP;');
  expect(player).toContain("fetch('/watch/playlist-context?' + params.toString())");
  expect(player).toMatch(
    /video\.addEventListener\('playing', function \(\) \{[\s\S]{0,300}startSupplementalPlayerData\(\)/
  );
  expect(player).toContain('scheduleSupplementalPlayerDataFallback();');
  expect(player).toContain('if (window._loadDetails) window._loadDetails();');
  expect(player).not.toContain('// Load details immediately');
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

test('native telemetry posts compositor-frame startup and seeking-to-seeked latency', async ({ page }) => {
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const state = await page.evaluate(async () => {
    window.__disablePlayerTelemetry = true;
    const video = document.getElementById('player');
    let mediaTime = 0;
    let frameCallback;
    Object.defineProperty(video, 'paused', { configurable: true, get() { return false; } });
    Object.defineProperty(video, 'currentTime', { configurable: true, get() { return mediaTime; } });
    video.requestVideoFrameCallback = function (callback) {
      frameCallback = callback;
      return 1;
    };
    video.cancelVideoFrameCallback = function () {};
    const engine = new window.PlayerEngine(video, { videoId: 'TESTVIDEO01', streamToken: '' });
    await engine.init();
    // Keep events in memory while exercising the browser event boundaries.
    window.__disablePlayerTelemetry = false;
    video.dispatchEvent(new Event('play'));
    await new Promise(resolve => setTimeout(resolve, 15));
    video.dispatchEvent(new Event('playing'));
    mediaTime = 0.25;
    frameCallback(performance.now(), { mediaTime, presentedFrames: 1 });
    video.dispatchEvent(new Event('seeking'));
    await new Promise(resolve => setTimeout(resolve, 15));
    video.dispatchEvent(new Event('seeked'));
    const events = engine._telemetry.events.slice();
    window.__disablePlayerTelemetry = true;
    engine.destroy();
    delete window.__disablePlayerTelemetry;
    return events;
  });

  const startup = state.find(event => event.type === 'playback-started');
  const firstFrame = state.find(event => event.type === 'first-frame');
  const seek = state.find(event => event.type === 'seek-complete');
  expect(startup.playToPlayingMs).toBeGreaterThanOrEqual(10);
  expect(startup.videoStartupMs).toBe(0);
  expect(firstFrame.videoStartupMs).toBeGreaterThanOrEqual(10);
  expect(firstFrame.pageToFirstFrameMs).toBeGreaterThan(0);
  expect(seek.seekLatencyMs).toBeGreaterThanOrEqual(10);
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

test('native adapter unload clears stale overlapping loads', async ({ page }) => {
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const state = await page.evaluate(async () => {
    const engine = new window.PlayerEngine(document.getElementById('player'), {
      videoId: 'TESTVIDEO01',
      streamToken: 'test-token',
    });
    const player = engine.getPlayer();
    const pending = {};
    engine._loadNative = function (url) {
      return new Promise(resolve => { pending[url] = resolve; });
    };

    const first = player.load('/slow.mpd').then(
      () => ({ ok: true }),
      err => ({ ok: false, name: err.name, message: err.message })
    );
    await Promise.resolve();
    const second = player.load('/current.mpd');
    await Promise.resolve();
    pending['/current.mpd']();
    await second;
    pending['/slow.mpd']();

    return {
      first: await first,
      state: engine._state,
      generation: engine._loadGeneration,
      pendingStartTime: engine._pendingLoadStartTime,
    };
  });

  expect(state.first).toMatchObject({ ok: false, name: 'AbortError' });
  expect(state.state).toBe('loading');
  expect(state.generation).toBe(2);
  expect(state.pendingStartTime).toBe(null);
});

test('native startup readiness ignores stale load generations and resolves only the current provider', async ({ page }) => {
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const state = await page.evaluate(async () => {
    const engine = new window.PlayerEngine(document.getElementById('player'), {
      videoId: 'STARTUPGEN01',
      streamToken: 'test-token',
      startupReadyTimeoutMs: 1000,
    });
    await engine.init();
    const providers = {};
    const startupEvents = [];
    engine.on('startup-ready', detail => startupEvents.push(detail));
    engine._loadNative = function (url) {
      const provider = {
        url,
        _usesStartupReadiness: true,
        destroyed: false,
        destroy() { this.destroyed = true; },
        quiesce() { this.destroyed = true; },
      };
      providers[url] = provider;
      this._provider = provider;
      this._providerName = 'startup-fixture';
      this._markStartupAttached(provider);
      return Promise.resolve();
    };

    const first = engine.load('/startup-first').then(
      () => ({ ok: true }),
      err => ({ ok: false, name: err.name }),
    );
    await Promise.resolve();
    await Promise.resolve();
    const firstProvider = providers['/startup-first'];

    let secondSettled = false;
    const second = engine.load('/startup-second').then(() => { secondSettled = true; });
    await Promise.resolve();
    await Promise.resolve();
    const secondProvider = providers['/startup-second'];
    const staleAccepted = engine._markStartupReady(firstProvider, firstProvider.loadGeneration);
    await new Promise(resolve => setTimeout(resolve, 0));
    const settledAfterStale = secondSettled;
    const currentAccepted = engine._markStartupReady(secondProvider, secondProvider.loadGeneration);
    await second;
    const firstResult = await first;
    const result = {
      staleAccepted,
      currentAccepted,
      settledAfterStale,
      secondSettled,
      firstResult,
      state: engine._state,
      readyGeneration: engine._startupReadyGeneration,
      loadGeneration: engine._loadGeneration,
      startupEvents,
    };
    engine.destroy();
    return result;
  });

  expect(state).toMatchObject({
    staleAccepted: false,
    currentAccepted: true,
    settledAfterStale: false,
    secondSettled: true,
    firstResult: { ok: false, name: 'AbortError' },
    state: 'ready',
    readyGeneration: 2,
    loadGeneration: 2,
  });
  expect(state.startupEvents).toEqual([{ loadGeneration: 2, provider: 'startup-fixture' }]);
});

test('native startup readiness timeout fails the load instead of reporting false success', async ({ page }) => {
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const state = await page.evaluate(async () => {
    const engine = new window.PlayerEngine(document.getElementById('player'), {
      videoId: 'STARTUPTIMEOUT01',
      streamToken: 'test-token',
      startupReadyTimeoutMs: 250,
    });
    await engine.init();
    let quiesced = 0;
    engine._loadNative = function () {
      const provider = {
        _usesStartupReadiness: true,
        destroyed: false,
        destroy() { this.destroyed = true; },
        quiesce() { quiesced++; this.destroyed = true; },
      };
      this._provider = provider;
      this._providerName = 'startup-timeout-fixture';
      this._markStartupAttached(provider);
      return Promise.resolve();
    };
    const started = performance.now();
    let outcome;
    try {
      await engine.load('/startup-never-ready');
      outcome = { ok: true };
    } catch (err) {
      outcome = {
        ok: false,
        name: err.name,
        message: err.message,
        phase: err.phase,
        loadGeneration: err.loadGeneration,
      };
    }
    const result = {
      outcome,
      elapsed: performance.now() - started,
      state: engine._state,
      quiesced,
      readyGeneration: engine._startupReadyGeneration,
      timer: engine._startupTransaction && engine._startupTransaction.timer,
    };
    engine.destroy();
    return result;
  });

  expect(state.outcome).toEqual({
    ok: false,
    name: 'TimeoutError',
    message: 'startup-buffer-timeout',
    phase: 'load',
    loadGeneration: 1,
  });
  expect(state.elapsed).toBeGreaterThanOrEqual(200);
  expect(state.state).toBe('error');
  expect(state.quiesced).toBe(1);
  expect(state.readyGeneration).toBe(-1);
  expect(state.timer).toBe(0);
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

test('native networking bounds stalled response bodies', async ({ page }) => {
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const state = await page.evaluate(async () => {
    const originalFetch = window.fetch;
    window.fetch = function (_url, opts) {
      return new Promise((_resolve, reject) => {
        opts.signal.addEventListener('abort', function () {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        }, { once: true });
      });
    };
    try {
      const video = document.getElementById('player');
      const engine = new window.PlayerEngine(video, { videoId: 'TIMEOUTTEST', streamToken: 'token' });
      await engine.init();
      const networking = engine.getPlayer().getNetworkingEngine();
      let error = null;
      try {
        await networking.request(
          networking.RequestType.SEGMENT,
          { uris: ['/never-finishes.m4s'] },
          { timeoutMs: 25, disableNetworkHold: true }
        );
      } catch (err) {
        error = { name: err.name, message: err.message };
      }
      return { error, stats: engine.getPlayer().getStats() };
    } finally {
      window.fetch = originalFetch;
    }
  });

  expect(state.error).toEqual({ name: 'TimeoutError', message: 'network-request-timeout' });
  expect(state.stats.networkTimeoutCount).toBe(1);
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
    // Default startup deliberately uses a conservative bandwidth factor and
    // has no hidden minimum-height floor. Quality can promote after the first
    // measured media request.
    expect(item.nativeHeight).toBe(240);
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
  // A first slow sample is treated as real congestion instead of being diluted
  // by the optimistic startup estimate.
  expect(state.lowBandwidthHeight).toBe(240);
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

test('native ABR upgrades safely with dual bandwidth estimates and drops decode-heavy renditions', async ({ page }) => {
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const state = await page.evaluate(() => {
    const video = document.getElementById('player');
    const engine = new window.PlayerEngine(video, { videoId: 'TESTVIDEO01', streamToken: '' });
    let quality = { droppedVideoFrames: 10, totalVideoFrames: 100 };
    video.getVideoPlaybackQuality = () => quality;

    const bandwidth = { bandwidth: 3_000_000, bandwidthFast: 0, bandwidthSlow: 0, bandwidthSamples: 0 };
    window.NativeDashProviderForTest._recordBandwidthSample.call(bandwidth, 1_000_000, 1000);
    window.NativeDashProviderForTest._recordBandwidthSample.call(bandwidth, 62_500, 1000);
    const latencyAdjusted = { bandwidth: 500_000, bandwidthFast: 0, bandwidthSlow: 0, bandwidthSamples: 0 };
    window.NativeDashProviderForTest._recordBandwidthSample.call(latencyAdjusted, 27_533, 115, 65);

    const dash = {
      engine,
      video,
      activeVideo: { id: '720', height: 720, bandwidth: 1_800_000 },
      videoReps: [
        { id: '360', height: 360, bandwidth: 800_000 },
        { id: '720', height: 720, bandwidth: 1_800_000 },
      ],
      blacklisted: {},
      manualTrackId: null,
      bandwidth: 3_000_000,
      bandwidthSamples: 3,
      lastSwitchAt: performance.now() - 10_000,
      lastFrameSampleAt: performance.now() - 3_000,
      lastDroppedFrames: 10,
      lastTotalFrames: 100,
      frameDropDownswitchCount: 0,
      _candidateVideos: window.NativeDashProviderForTest._candidateVideos,
      _chooseForBudget: window.NativeDashProviderForTest._chooseForBudget,
      _lowerVideoRep: window.NativeDashProviderForTest._lowerVideoRep,
      _switchVideo(rep, _clearBuffer, reason) {
        this.activeVideo = rep;
        this.lastSwitchReason = reason;
      },
    };
    Object.defineProperty(video, 'buffered', {
      configurable: true,
      get() {
        return { length: 1, start() { return 0; }, end() { return 20; } };
      },
    });
    quality = { droppedVideoFrames: 20, totalVideoFrames: 140 };
    window.NativeDashProviderForTest._maybeSwitchAuto.call(dash);

    return {
      fastEstimate: bandwidth.bandwidthFast,
      slowEstimate: bandwidth.bandwidthSlow,
      effectiveEstimate: bandwidth.bandwidth,
      latencyAdjustedSample: latencyAdjusted.lastBandwidthSample,
      latencyAdjustedTtfb: latencyAdjusted.bandwidthTtfbEstimate,
      selectedHeight: dash.activeVideo.height,
      switchReason: dash.lastSwitchReason,
      frameDropDownswitchCount: dash.frameDropDownswitchCount,
      frameDropRatio: dash.lastFrameDropRatio,
    };
  });

  expect(state.fastEstimate).toBeLessThan(state.slowEstimate);
  expect(state.effectiveEstimate).toBe(state.fastEstimate);
  expect(state.latencyAdjustedSample).toBeGreaterThan(4_000_000);
  expect(state.latencyAdjustedTtfb).toBeCloseTo(65, 0);
  expect(state.selectedHeight).toBe(360);
  expect(state.switchReason).toBe('dropped-frames');
  expect(state.frameDropDownswitchCount).toBe(1);
  expect(state.frameDropRatio).toBeCloseTo(0.25, 4);
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

test('manual native quality selection queues behind in-flight DASH and HLS switches', async ({ page }) => {
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const state = await page.evaluate(() => {
    const video = document.getElementById('player');
    const makeRep = (id, height) => ({
      id,
      height,
      width: Math.round(height * 16 / 9),
      bandwidth: height * 2000,
      codecs: 'avc1.42c01f',
      mimeType: 'video/mp4',
      capability: { supported: true, smooth: true, powerEfficient: true },
    });
    const low = makeRep('240', 240);
    const high = makeRep('720', 720);

    function exercise(api, kind) {
      const engine = new window.PlayerEngine(video, { videoId: 'TESTVIDEO01', streamToken: 'test-token' });
      const provider = {
        engine,
        video,
        destroyed: false,
        blacklisted: {},
        manualTrackId: null,
        _viewportMaxHeight() { return Infinity; },
      };
      if (kind === 'hls') {
        Object.assign(provider, {
          variants: [low, high],
          activeVariant: high,
          variantSwitchInFlight: true,
          pendingManualVariantSwitch: null,
          _switchVariant(rep, clearBuffer, reason) {
            this.started = { id: rep.id, clearBuffer, reason };
            this.variantSwitchInFlight = true;
          },
        });
        api.selectVariantTrack.call(provider, low, true);
        const queued = provider.pendingManualVariantSwitch && provider.pendingManualVariantSwitch.variantId;
        provider.variantSwitchInFlight = false;
        api._flushPendingVariantSwitch.call(provider);
        return { queued, started: provider.started, abrEnabled: engine.getPlayer().config.abr.enabled };
      }
      Object.assign(provider, {
        videoReps: [low, high],
        activeVideo: high,
        videoSwitchInFlight: true,
        pendingManualVideoSwitch: null,
        _switchVideo(rep, clearBuffer, reason) {
          this.started = { id: rep.id, clearBuffer, reason };
          this.videoSwitchInFlight = true;
        },
      });
      api.selectVariantTrack.call(provider, low, true);
      const queued = provider.pendingManualVideoSwitch && provider.pendingManualVideoSwitch.repId;
      provider.videoSwitchInFlight = false;
      api._flushPendingVideoSwitch.call(provider);
      return { queued, started: provider.started, abrEnabled: engine.getPlayer().config.abr.enabled };
    }

    return {
      hls: exercise(window.NativeHlsProviderForTest, 'hls'),
      dash: exercise(window.NativeDashProviderForTest, 'dash'),
    };
  });

  for (const result of [state.hls, state.dash]) {
    expect(result.queued).toBe('240');
    expect(result.started).toEqual({ id: '240', clearBuffer: true, reason: 'manual' });
    expect(result.abrEnabled).toBe(false);
  }
});

test('native request cancellation invalidates an in-flight DASH quality transition', async ({ page }) => {
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const state = await page.evaluate(async () => {
    const dash = window.NativeDashProviderForTest;
    const video = document.getElementById('player');
    const previous = {
      id: '360', kind: 'video', height: 360, mimeType: 'video/mp4', codecs: 'avc1.42c01f',
      segments: [{ start: 0, end: 2, state: 'appended' }], initData: new ArrayBuffer(1),
    };
    const target = {
      id: '720', kind: 'video', height: 720, mimeType: 'video/mp4', codecs: 'avc1.42c01f',
      segments: [{ start: 0, end: 2, state: 'pending' }], initData: new ArrayBuffer(2),
      capability: { supported: true, smooth: true },
    };
    let releasePrepare;
    const heldPrepare = new Promise(resolve => { releasePrepare = resolve; });
    const sourceBuffer = new EventTarget();
    sourceBuffer.updating = false;
    sourceBuffer.buffered = { length: 0, start() { return 0; }, end() { return 0; } };
    sourceBuffer.appendCount = 0;
    sourceBuffer.appendBuffer = () => { sourceBuffer.appendCount++; };
    sourceBuffer.changeType = () => {};
    const provider = {
      destroyed: false,
      engine: {
        _player: {
          config: { abr: { enabled: true } },
          emit() {},
        },
        _telemetry: { record() {} },
      },
      video,
      videoSb: sourceBuffer,
      audioSb: null,
      videoMime: 'video/mp4; codecs="avc1.42c01f"',
      activeVideo: previous,
      audio: null,
      videoReps: [previous, target],
      audioReps: [],
      blacklisted: {},
      controllers: [],
      activeRanges: {},
      requestGeneration: 0,
      requestCancellationCount: 0,
      pendingManualVideoSwitch: null,
      _abortRequests: dash._abortRequests,
      _prepareRep(rep) { return rep === target ? heldPrepare : Promise.resolve(rep); },
      _changeVideoTypeIfNeeded: dash._changeVideoTypeIfNeeded,
      _tick() { this.tickCount = (this.tickCount || 0) + 1; },
    };

    const switching = dash._switchVideo.call(provider, target, true, 'manual');
    await Promise.resolve();
    dash._abortRequests.call(provider, 'seek');
    releasePrepare(target);
    const committed = await switching;
    return {
      committed,
      activeId: provider.activeVideo.id,
      targetBlacklisted: provider.blacklisted[target.id] === true,
      appendCount: sourceBuffer.appendCount,
      pendingId: provider.pendingManualVideoSwitch && provider.pendingManualVideoSwitch.repId,
      transitionInFlight: !!provider.dashControlTransitionInFlight,
      videoSwitchInFlight: !!provider.videoSwitchInFlight,
      invalidations: provider.dashControlTransitionInvalidationCount || 0,
      staleAborts: provider.dashStaleControlTransitionAbortCount || 0,
      requestGeneration: provider.requestGeneration,
    };
  });

  expect(state).toEqual({
    committed: false,
    activeId: '360',
    targetBlacklisted: false,
    appendCount: 0,
    pendingId: '720',
    transitionInFlight: false,
    videoSwitchInFlight: false,
    invalidations: 1,
    staleAborts: 1,
    requestGeneration: 2,
  });
});

test('native request cancellation reconciles a DASH init append already inside SourceBuffer', async ({ page }) => {
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const state = await page.evaluate(async () => {
    const dash = window.NativeDashProviderForTest;
    const video = document.getElementById('player');
    const previous = {
      id: '360', kind: 'video', height: 360, mimeType: 'video/mp4', codecs: 'avc1.42c01f',
      segments: [{ start: 0, end: 2, state: 'appended' }], initData: new ArrayBuffer(1),
    };
    const target = {
      id: '720', kind: 'video', height: 720, mimeType: 'video/mp4', codecs: 'vp09.00.10.08',
      segments: [{ start: 0, end: 2, state: 'pending' }], initData: new ArrayBuffer(2),
      capability: { supported: true, smooth: true },
    };
    let releaseTargetAppend;
    const sourceBuffer = new EventTarget();
    sourceBuffer.updating = false;
    sourceBuffer.buffered = { length: 0, start() { return 0; }, end() { return 0; } };
    sourceBuffer.appendAttempts = [];
    sourceBuffer.changedTypes = [];
    sourceBuffer.appendBuffer = data => {
      sourceBuffer.appendAttempts.push(data.byteLength);
      sourceBuffer.updating = true;
      const complete = () => {
        sourceBuffer.updating = false;
        sourceBuffer.dispatchEvent(new Event('updateend'));
      };
      if (data.byteLength === 2) releaseTargetAppend = complete;
      else queueMicrotask(complete);
    };
    sourceBuffer.changeType = type => { sourceBuffer.changedTypes.push(type); };
    const emitted = [];
    const provider = {
      destroyed: false,
      engine: {
        _player: {
          config: { abr: { enabled: true }, streaming: {} },
          emit(name) { emitted.push(name); },
        },
        _telemetry: { record() {} },
      },
      video,
      videoSb: sourceBuffer,
      audioSb: null,
      videoMime: 'video/mp4; codecs="avc1.42c01f"',
      activeVideo: previous,
      audio: null,
      videoReps: [previous, target],
      audioReps: [],
      blacklisted: {},
      controllers: [],
      activeRanges: {},
      requestGeneration: 0,
      requestCancellationCount: 0,
      _abortRequests: dash._abortRequests,
      _prepareRep(rep) { return Promise.resolve(rep); },
      _initDataForSegment(rep) { return Promise.resolve(rep.initData); },
      _changeVideoTypeIfNeeded: dash._changeVideoTypeIfNeeded,
      _reconcileSourceBufferConfiguration: dash._reconcileSourceBufferConfiguration,
      _maxConcurrentMediaRequests() {
        this.schedulerTouches = (this.schedulerTouches || 0) + 1;
        return 1;
      },
      _tick() { this.tickCount = (this.tickCount || 0) + 1; },
    };

    const switching = dash._switchVideo.call(provider, target, false, 'bandwidth');
    for (let i = 0; i < 20 && !releaseTargetAppend; i++) await Promise.resolve();
    dash._abortRequests.call(provider, 'seek');
    const candidatesWhileUncertain = dash._buildSegmentCandidates.call(
      provider,
      4,
      [{ rep: previous, sb: sourceBuffer }],
    );
    dash._scheduleMediaRequests.call(provider, 4, [{ rep: previous, sb: sourceBuffer }]);
    const reconcileStarted = dash._flushPendingDashControlTransition.call(provider);
    releaseTargetAppend();
    const committed = await switching;
    for (let i = 0; i < 30 && (provider.dashSourceBufferConfigUncertain || provider.dashControlTransitionInFlight); i++) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }

    return {
      committed,
      activeId: provider.activeVideo.id,
      activeMime: provider.videoMime,
      targetBlacklisted: provider.blacklisted[target.id] === true,
      appendAttempts: sourceBuffer.appendAttempts,
      changedTypes: sourceBuffer.changedTypes,
      emitted,
      candidatesWhileUncertain: candidatesWhileUncertain.length,
      schedulerTouches: provider.schedulerTouches || 0,
      reconcileStarted,
      configEpoch: provider.dashSourceBufferConfigEpoch,
      committedConfigEpoch: provider.dashSourceBufferCommittedConfigEpoch,
      configUncertain: provider.dashSourceBufferConfigUncertain,
      reconcilePending: !!provider.dashSourceBufferReconcilePending,
      reconcileQueued: provider.dashSourceBufferReconcileQueuedCount,
      reconcileAttempts: provider.dashSourceBufferReconcileAttemptCount,
      reconcileSuccesses: provider.dashSourceBufferReconcileSuccessCount,
      reconcileFailures: provider.dashSourceBufferReconcileFailureCount || 0,
      oldInitRestored: !!previous._appendedInitKey,
      transitionInFlight: !!provider.dashControlTransitionInFlight,
      staleAborts: provider.dashStaleControlTransitionAbortCount || 0,
      requestGeneration: provider.requestGeneration,
    };
  });

  expect(state).toEqual({
    committed: false,
    activeId: '360',
    activeMime: 'video/mp4; codecs="avc1.42c01f"',
    targetBlacklisted: false,
    appendAttempts: [2, 1],
    changedTypes: [
      'video/mp4; codecs="vp09.00.10.08"',
      'video/mp4; codecs="avc1.42c01f"',
    ],
    emitted: [],
    candidatesWhileUncertain: 0,
    schedulerTouches: 0,
    reconcileStarted: true,
    configEpoch: 2,
    committedConfigEpoch: 2,
    configUncertain: false,
    reconcilePending: false,
    reconcileQueued: 1,
    reconcileAttempts: 1,
    reconcileSuccesses: 1,
    reconcileFailures: 0,
    oldInitRestored: true,
    transitionInFlight: false,
    staleAborts: 1,
    requestGeneration: 2,
  });
});

test('native request cancellation reconciles an in-flight DASH period init append', async ({ page }) => {
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const state = await page.evaluate(async () => {
    const dash = window.NativeDashProviderForTest;
    const video = document.getElementById('player');
    let currentTime = 4;
    Object.defineProperty(video, 'currentTime', { configurable: true, get() { return currentTime; } });
    const oldKey = 'video|v1|p0|video/mp4|avc1.42c01f|https://example.test/i/v1|';
    const newKey = 'video|v1|p1|video/mp4|avc1.4d401f|https://example.test/i2/v1|';
    const oldSegment = {
      start: 0, end: 2, state: 'appended', appended: true, generationKey: oldKey,
      mimeType: 'video/mp4', codecs: 'avc1.42c01f', initUrl: 'https://example.test/i/v1',
    };
    const newSegment = {
      start: 4, end: 6, state: 'fetched', appended: false, generationKey: newKey,
      mimeType: 'video/mp4', codecs: 'avc1.4d401f', initUrl: 'https://example.test/i2/v1',
      appendWindow: { start: 4, end: 8 }, _data: new ArrayBuffer(3),
    };
    const rep = {
      id: 'v1', kind: 'video', mimeType: 'video/mp4', codecs: 'avc1.42c01f',
      generationKey: oldKey, initData: new ArrayBuffer(1), segments: [oldSegment, newSegment],
      _appendedInitKey: oldKey,
    };
    let releaseNewInit;
    const sourceBuffer = new EventTarget();
    sourceBuffer.updating = false;
    sourceBuffer.buffered = { length: 0, start() { return 0; }, end() { return 0; } };
    sourceBuffer.appendAttempts = [];
    sourceBuffer.changedTypes = [];
    sourceBuffer.appendBuffer = data => {
      sourceBuffer.appendAttempts.push(data.byteLength);
      sourceBuffer.updating = true;
      const complete = () => {
        sourceBuffer.updating = false;
        sourceBuffer.dispatchEvent(new Event('updateend'));
      };
      if (data.byteLength === 2) releaseNewInit = complete;
      else queueMicrotask(complete);
    };
    sourceBuffer.changeType = type => { sourceBuffer.changedTypes.push(type); };
    const originalIsTypeSupported = window.MediaSource.isTypeSupported;
    Object.defineProperty(window.MediaSource, 'isTypeSupported', {
      configurable: true,
      value() { return true; },
    });
    const provider = {
      destroyed: false,
      engine: {
        _player: { config: { abr: { enabled: true }, streaming: {} }, emit() {} },
        _telemetry: { record() {} },
      },
      video,
      videoSb: sourceBuffer,
      audioSb: null,
      videoMime: 'video/mp4; codecs="avc1.42c01f"',
      activeVideo: rep,
      audio: null,
      videoReps: [rep],
      audioReps: [],
      blacklisted: {},
      controllers: [],
      activeRanges: {},
      requestGeneration: 0,
      requestCancellationCount: 0,
      schedulerDrainCount: 0,
      _abortRequests: dash._abortRequests,
      _prepareRep(value) { return Promise.resolve(value); },
      _initDataForSegment(value, segment) {
        return Promise.resolve(new ArrayBuffer(segment.generationKey === newKey ? 2 : 1));
      },
      _changeVideoTypeIfNeeded: dash._changeVideoTypeIfNeeded,
      _prepareSegmentGeneration: dash._prepareSegmentGeneration,
      _appendSegmentData: dash._appendSegmentData,
      _drainAppendQueue: dash._drainAppendQueue,
      _reconcileSourceBufferConfiguration: dash._reconcileSourceBufferConfiguration,
      _maxConcurrentMediaRequests() {
        this.schedulerTouches = (this.schedulerTouches || 0) + 1;
        return 1;
      },
      _tick() { this.tickCount = (this.tickCount || 0) + 1; },
    };

    const appendStarted = dash._drainAppendQueue.call(provider, rep, sourceBuffer);
    for (let i = 0; i < 20 && !releaseNewInit; i++) await Promise.resolve();
    currentTime = 0;
    dash._abortRequests.call(provider, 'seek');
    const initKeyAfterCancel = rep._appendedInitKey;
    dash._scheduleMediaRequests.call(provider, 4, [{ rep, sb: sourceBuffer }]);
    const reconcileStarted = dash._flushPendingDashControlTransition.call(provider);
    releaseNewInit();
    for (let i = 0; i < 30 && (provider.dashSourceBufferConfigUncertain || provider.dashControlTransitionInFlight); i++) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    Object.defineProperty(window.MediaSource, 'isTypeSupported', {
      configurable: true,
      value: originalIsTypeSupported,
    });

    return {
      appendStarted,
      initKeyAfterCancel,
      finalInitKey: rep._appendedInitKey,
      finalMime: provider.videoMime,
      appendAttempts: sourceBuffer.appendAttempts,
      changedTypes: sourceBuffer.changedTypes,
      mediaWasNotAppended: !sourceBuffer.appendAttempts.includes(3),
      segmentState: newSegment.state,
      schedulerTouches: provider.schedulerTouches || 0,
      reconcileStarted,
      configEpoch: provider.dashSourceBufferConfigEpoch,
      committedConfigEpoch: provider.dashSourceBufferCommittedConfigEpoch,
      configUncertain: provider.dashSourceBufferConfigUncertain,
      reconcilePending: !!provider.dashSourceBufferReconcilePending,
      reconcileQueued: provider.dashSourceBufferReconcileQueuedCount,
      reconcileAttempts: provider.dashSourceBufferReconcileAttemptCount,
      reconcileSuccesses: provider.dashSourceBufferReconcileSuccessCount,
      staleAppendAborts: provider.dashStaleAppendAbortCount || 0,
      requestGeneration: provider.requestGeneration,
    };
  });

  expect(state).toEqual({
    appendStarted: true,
    initKeyAfterCancel: '',
    finalInitKey: 'video|v1|p0|video/mp4|avc1.42c01f|https://example.test/i/v1|',
    finalMime: 'video/mp4; codecs="avc1.42c01f"',
    appendAttempts: [2, 1],
    changedTypes: [
      'video/mp4; codecs="avc1.4d401f"',
      'video/mp4; codecs="avc1.42c01f"',
    ],
    mediaWasNotAppended: true,
    segmentState: 'pending',
    schedulerTouches: 0,
    reconcileStarted: true,
    configEpoch: 2,
    committedConfigEpoch: 2,
    configUncertain: false,
    reconcilePending: false,
    reconcileQueued: 1,
    reconcileAttempts: 1,
    reconcileSuccesses: 1,
    staleAppendAborts: 1,
    requestGeneration: 2,
  });
});

test('manual native quality selection releases stale DASH control ownership after topology replacement', async ({ page }) => {
  await page.goto('/auth/login');
  await page.setContent('<video id="player"></video>');
  await page.addScriptTag({ path: 'public/native-player-engine.js' });

  const state = await page.evaluate(async () => {
    const video = document.getElementById('player');
    Object.defineProperty(video, 'currentTime', { configurable: true, get() { return 4; } });
    const engine = new window.PlayerEngine(video, { videoId: 'TESTVIDEO01', streamToken: 'test-token' });
    engine._telemetry.record = function () {};
    const oldSourceBuffer = { updating: false };
    const replacementSourceBuffer = { updating: false };
    const previous = {
      id: 'v1',
      kind: 'video',
      mimeType: 'video/mp4',
      codecs: 'avc1.42c01f',
      segments: [],
    };
    const target = {
      id: 'v2',
      kind: 'video',
      mimeType: 'video/mp4',
      codecs: 'avc1.42c01f',
      segments: [],
    };
    const provider = {
      engine,
      video,
      activeVideo: previous,
      videoReps: [previous, target],
      audioReps: [],
      videoSb: oldSourceBuffer,
      audioSb: null,
      requestGeneration: 0,
      videoSwitchInFlight: false,
      audioSwitchInFlight: false,
      _prepareRep() {
        this.videoSb = replacementSourceBuffer;
        return Promise.resolve(target);
      },
      _tick(force) { this.ticked = force; },
      _switchVideo: window.NativeDashProviderForTest._switchVideo,
    };

    previous._appendOwner = {};
    previous._appending = true;
    const queuedOutcome = await provider._switchVideo(target, false, 'manual');
    const queuedId = provider.pendingManualVideoSwitch?.repId || '';
    previous._appendOwner = null;
    previous._appending = false;
    provider.pendingManualVideoSwitch = null;
    const outcome = await provider._switchVideo(target, false, 'manual');
    return {
      queuedOutcome,
      queuedId,
      outcome,
      activeId: provider.activeVideo.id,
      transitionInFlight: !!provider.dashControlTransitionInFlight,
      videoSwitchInFlight: !!provider.videoSwitchInFlight,
      staleReleases: provider.dashStaleControlTransitionReleaseCount || 0,
      ticked: provider.ticked === true,
    };
  });

  expect(state).toEqual({
    queuedOutcome: false,
    queuedId: 'v2',
    outcome: false,
    activeId: 'v1',
    transitionInFlight: false,
    videoSwitchInFlight: false,
    staleReleases: 1,
    ticked: true,
  });
});

test('manual native quality selection rolls back failed DASH initialization before commit', async ({ page }) => {
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const state = await page.evaluate(async () => {
    const dash = window.NativeDashProviderForTest;
    const video = document.getElementById('player');
    Object.defineProperty(video, 'currentTime', { configurable: true, get() { return 5; } });
    const previous = {
      id: '360', kind: 'video', height: 360, mimeType: 'video/mp4', codecs: 'avc1.42c01f',
      initData: new ArrayBuffer(1), segments: [{ start: 0, end: 2, state: 'appended' }],
    };
    const target = {
      id: '720', kind: 'video', height: 720, mimeType: 'video/mp4', codecs: 'vp09.00.10.08',
      initData: new ArrayBuffer(2), segments: [{ start: 0, end: 2, state: 'pending' }],
    };
    const sourceBuffer = new EventTarget();
    sourceBuffer.updating = false;
    sourceBuffer.buffered = { length: 1, start() { return 0; }, end() { return 15; } };
    sourceBuffer.appendAttempts = [];
    sourceBuffer.changedTypes = [];
    sourceBuffer.remove = () => {
      sourceBuffer.updating = true;
      queueMicrotask(() => {
        sourceBuffer.buffered = { length: 0, start() { return 0; }, end() { return 0; } };
        sourceBuffer.updating = false;
        sourceBuffer.dispatchEvent(new Event('updateend'));
      });
    };
    sourceBuffer.appendBuffer = data => {
      sourceBuffer.appendAttempts.push(data.byteLength);
      if (data.byteLength === 2) throw new Error('target-video-init-failed');
      sourceBuffer.updating = true;
      queueMicrotask(() => {
        sourceBuffer.updating = false;
        sourceBuffer.dispatchEvent(new Event('updateend'));
      });
    };
    sourceBuffer.changeType = type => { sourceBuffer.changedTypes.push(type); };
    const emitted = [];
    const provider = {
      destroyed: false,
      engine: {
        _player: {
          config: { abr: { enabled: false } },
          emit(name) { emitted.push(name); },
        },
        _telemetry: { record() {} },
      },
      video,
      videoSb: sourceBuffer,
      audioSb: null,
      videoMime: 'video/mp4; codecs="avc1.42c01f"',
      activeVideo: previous,
      audio: null,
      videoReps: [previous, target],
      audioReps: [],
      blacklisted: {},
      controllers: [],
      activeRanges: {},
      requestGeneration: 0,
      requestCancellationCount: 0,
      _abortRequests: dash._abortRequests,
      _prepareRep(rep) { return Promise.resolve(rep); },
      _changeVideoTypeIfNeeded: dash._changeVideoTypeIfNeeded,
      _tick() { this.tickCount = (this.tickCount || 0) + 1; },
    };

    const committed = await dash._switchVideo.call(provider, target, true, 'manual');
    return {
      committed,
      activeId: provider.activeVideo.id,
      activeMime: provider.videoMime,
      targetBlacklisted: provider.blacklisted[target.id] === true,
      appendAttempts: sourceBuffer.appendAttempts,
      changedTypes: sourceBuffer.changedTypes,
      emitted,
      lastError: provider.lastError,
      rollbackCount: provider.dashControlTransitionRollbackCount || 0,
      rollbackFailures: provider.dashControlTransitionRollbackFailureCount || 0,
      transitionInFlight: !!provider.dashControlTransitionInFlight,
    };
  });

  expect(state).toEqual({
    committed: false,
    activeId: '360',
    activeMime: 'video/mp4; codecs="avc1.42c01f"',
    targetBlacklisted: true,
    appendAttempts: [2, 1],
    changedTypes: [
      'video/mp4; codecs="vp09.00.10.08"',
      'video/mp4; codecs="avc1.42c01f"',
    ],
    emitted: [],
    lastError: 'target-video-init-failed',
    rollbackCount: 1,
    rollbackFailures: 0,
    transitionInFlight: false,
  });
});

test('manual native quality selection restores DASH init after a non-clearing rollback', async ({ page }) => {
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const state = await page.evaluate(async () => {
    const dash = window.NativeDashProviderForTest;
    const video = document.getElementById('player');
    const previous = {
      id: '360', kind: 'video', mimeType: 'video/mp4', codecs: 'avc1.42c01f',
      initData: new ArrayBuffer(1), segments: [{ start: 0, end: 2, state: 'appended' }],
    };
    const target = {
      id: '720', kind: 'video', mimeType: 'video/mp4', codecs: 'vp09.00.10.08',
      initData: new ArrayBuffer(2), segments: [{ start: 0, end: 2, state: 'pending' }],
    };
    const sourceBuffer = new EventTarget();
    sourceBuffer.updating = false;
    sourceBuffer.buffered = { length: 0, start() { return 0; }, end() { return 0; } };
    sourceBuffer.appendAttempts = [];
    sourceBuffer.changedTypes = [];
    sourceBuffer.appendBuffer = data => {
      sourceBuffer.appendAttempts.push(data.byteLength);
      if (data.byteLength === 2) throw new Error('target-init-failed');
      sourceBuffer.updating = true;
      queueMicrotask(() => {
        sourceBuffer.updating = false;
        sourceBuffer.dispatchEvent(new Event('updateend'));
      });
    };
    sourceBuffer.changeType = type => { sourceBuffer.changedTypes.push(type); };
    const emitted = [];
    const provider = {
      destroyed: false,
      engine: {
        _player: { config: { abr: { enabled: false } }, emit(name) { emitted.push(name); } },
        _telemetry: { record() {} },
      },
      video,
      videoSb: sourceBuffer,
      audioSb: null,
      videoMime: 'video/mp4; codecs="avc1.42c01f"',
      activeVideo: previous,
      audio: null,
      videoReps: [previous, target],
      audioReps: [],
      blacklisted: {},
      controllers: [],
      activeRanges: {},
      requestGeneration: 0,
      requestCancellationCount: 0,
      _abortRequests: dash._abortRequests,
      _prepareRep(rep) { return Promise.resolve(rep); },
      _changeVideoTypeIfNeeded: dash._changeVideoTypeIfNeeded,
      _tick() {},
    };

    const committed = await dash._switchVideo.call(provider, target, false, 'manual');
    return {
      committed,
      activeId: provider.activeVideo.id,
      activeMime: provider.videoMime,
      targetBlacklisted: provider.blacklisted[target.id] === true,
      appendAttempts: sourceBuffer.appendAttempts,
      changedTypes: sourceBuffer.changedTypes,
      previousInitRestored: !!previous._appendedInitKey,
      emitted,
      rollbackCount: provider.dashControlTransitionRollbackCount || 0,
      rollbackFailures: provider.dashControlTransitionRollbackFailureCount || 0,
      configEpoch: provider.dashSourceBufferConfigEpoch,
      committedConfigEpoch: provider.dashSourceBufferCommittedConfigEpoch,
      transitionInFlight: !!provider.dashControlTransitionInFlight,
    };
  });

  expect(state).toEqual({
    committed: false,
    activeId: '360',
    activeMime: 'video/mp4; codecs="avc1.42c01f"',
    targetBlacklisted: true,
    appendAttempts: [2, 1],
    changedTypes: [
      'video/mp4; codecs="vp09.00.10.08"',
      'video/mp4; codecs="avc1.42c01f"',
    ],
    previousInitRestored: true,
    emitted: [],
    rollbackCount: 1,
    rollbackFailures: 0,
    configEpoch: 1,
    committedConfigEpoch: 1,
    transitionInFlight: false,
  });
});

test('manual native quality selection installs the DASH init active at the playhead', async ({ page }) => {
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const state = await page.evaluate(async () => {
    const dash = window.NativeDashProviderForTest;
    const video = document.getElementById('player');
    Object.defineProperty(video, 'currentTime', { configurable: true, get() { return 5; } });
    const previous = {
      id: '360', kind: 'video', mimeType: 'video/mp4', codecs: 'avc1.42c01f',
      initData: new ArrayBuffer(1), segments: [{ start: 0, end: 8, state: 'appended' }],
    };
    const periodKey = 'video|720|p1|video/mp4|vp09.00.10.08|https://example.test/i2/720|';
    const target = {
      id: '720', kind: 'video', mimeType: 'video/mp4', codecs: 'avc1.4d401f',
      initData: new ArrayBuffer(2),
      segments: [
        { start: 0, end: 4, state: 'pending' },
        {
          start: 4, end: 8, state: 'pending', generationKey: periodKey,
          mimeType: 'video/mp4', codecs: 'vp09.00.10.08', initUrl: 'https://example.test/i2/720',
          appendWindow: { start: 4, end: 8 },
        },
      ],
    };
    const sourceBuffer = new EventTarget();
    sourceBuffer.updating = false;
    sourceBuffer.buffered = { length: 0, start() { return 0; }, end() { return 0; } };
    sourceBuffer.appendAttempts = [];
    sourceBuffer.changedTypes = [];
    sourceBuffer.appendBuffer = data => {
      sourceBuffer.appendAttempts.push(data.byteLength);
      sourceBuffer.updating = true;
      queueMicrotask(() => {
        sourceBuffer.updating = false;
        sourceBuffer.dispatchEvent(new Event('updateend'));
      });
    };
    sourceBuffer.changeType = type => { sourceBuffer.changedTypes.push(type); };
    const emitted = [];
    const provider = {
      destroyed: false,
      engine: {
        _player: { config: { abr: { enabled: false } }, emit(name) { emitted.push(name); } },
        _telemetry: { record() {} },
      },
      video,
      videoSb: sourceBuffer,
      audioSb: null,
      videoMime: 'video/mp4; codecs="avc1.42c01f"',
      activeVideo: previous,
      audio: null,
      videoReps: [previous, target],
      audioReps: [],
      blacklisted: {},
      controllers: [],
      activeRanges: {},
      requestGeneration: 0,
      requestCancellationCount: 0,
      _abortRequests: dash._abortRequests,
      _prepareRep(rep) { return Promise.resolve(rep); },
      _initDataForSegment(rep, segment) {
        return Promise.resolve(new ArrayBuffer(segment.generationKey === periodKey ? 4 : rep.initData.byteLength));
      },
      _changeVideoTypeIfNeeded: dash._changeVideoTypeIfNeeded,
      _tick() {},
    };

    const committed = await dash._switchVideo.call(provider, target, false, 'manual');
    return {
      committed,
      activeId: provider.activeVideo.id,
      activeMime: provider.videoMime,
      appendedInitKey: target._appendedInitKey,
      appendAttempts: sourceBuffer.appendAttempts,
      changedTypes: sourceBuffer.changedTypes,
      emitted,
    };
  });

  expect(state).toEqual({
    committed: true,
    activeId: '720',
    activeMime: 'video/mp4; codecs="vp09.00.10.08"',
    appendedInitKey: 'video|720|p1|video/mp4|vp09.00.10.08|https://example.test/i2/720|',
    appendAttempts: [4],
    changedTypes: ['video/mp4; codecs="vp09.00.10.08"'],
    emitted: ['variantchanged'],
  });
});

test('native stats expose active quality and playback health', async ({ page }) => {
  const shakaRequests = [];
  await page.route('**/vendor/shaka/shaka-player.compiled.js', route => {
    shakaRequests.push(route.request().url());
    route.abort();
  });

  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const stats = await page.evaluate(async () => {
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

test('native buffer scheduler persistently closes VOD after terminal DASH and HLS segments', async ({ page }) => {
  await setPlayerContent(page, '<video id="player"></video>');

  const state = await page.evaluate(async () => {
    function mediaSourceState() {
      return {
        readyState: 'open',
        ended: 0,
        endOfStream() { this.ended++; this.readyState = 'ended'; },
      };
    }
    function queuedSourceBuffer() {
      let releaseQueue;
      const listeners = new Map();
      const sb = {
        updating: true,
        _nativeQueueDepth: 1,
        addEventListener(type, listener) { listeners.set(type, listener); },
        removeEventListener(type, listener) {
          if (listeners.get(type) === listener) listeners.delete(type);
        },
      };
      sb._nativeQueue = new Promise(resolve => { releaseQueue = resolve; });
      return {
        sb,
        release() {
          sb.updating = false;
          sb._nativeQueueDepth = 0;
          releaseQueue();
          const listener = listeners.get('updateend');
          if (listener) listener();
        },
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

    const busyVideo = queuedSourceBuffer();
    const busyDashMediaSource = mediaSourceState();
    const busyDash = {
      live: false,
      duration: 6,
      mediaSource: busyDashMediaSource,
      videoSb: busyVideo.sb,
      audioSb: { updating: false },
      activeVideo: { duration: 6, segments: [{ start: 4, end: 6, state: 'appended', appended: true }] },
      audio: { duration: 6, segments: [{ start: 4, end: 6, state: 'appended', appended: true }] },
      vodEndOfStreamCount: 0,
      _maybeEndVodStream: window.NativeDashProviderForTest._maybeEndVodStream,
    };
    const busyDashClosedImmediately = busyDash._maybeEndVodStream();
    const busyDashPendingBeforeRelease = busyDash.vodEndOfStreamPending;
    busyVideo.release();
    await new Promise(resolve => setTimeout(resolve, 0));

    const retryMediaSource = {
      readyState: 'open',
      attempts: 0,
      endOfStream() {
        this.attempts++;
        if (this.attempts === 1) throw new Error('source-buffer-still-transitioning');
        this.readyState = 'ended';
      },
    };
    const retryHls = {
      live: false,
      duration: 6,
      mediaSource: retryMediaSource,
      sb: { updating: false },
      audioSb: null,
      segments: [{ start: 4, end: 6, state: 'appended', appended: true }],
      activeAudio: null,
      audioSegments: [],
      vodEndOfStreamCount: 0,
      _maybeEndVodStream: window.NativeHlsProviderForTest._maybeEndVodStream,
    };
    const retryHlsClosedImmediately = retryHls._maybeEndVodStream();
    await new Promise(resolve => setTimeout(resolve, 80));

    const gapMediaSource = mediaSourceState();
    const gapHls = {
      live: false,
      duration: 6,
      mediaSource: gapMediaSource,
      sb: { updating: false },
      audioSb: null,
      segments: [
        { start: 0, end: 4, state: 'appended', appended: true },
        { start: 4, end: 6, state: 'pending', appended: false, gap: true },
      ],
      activeAudio: null,
      audioSegments: [],
      vodEndOfStreamCount: 0,
    };
    const gapHlsClosed = window.NativeHlsProviderForTest._maybeEndVodStream.call(gapHls);

    const uncoveredMediaSource = mediaSourceState();
    const uncoveredHls = {
      live: false,
      duration: 6,
      mediaSource: uncoveredMediaSource,
      sb: {
        updating: false,
        buffered: { length: 1, start() { return 0; }, end() { return 4; } },
      },
      audioSb: null,
      segments: [{ start: 4, end: 6, state: 'appended', appended: true }],
      activeAudio: null,
      audioSegments: [],
      vodEndOfStreamCount: 0,
    };
    const uncoveredHlsClosed = window.NativeHlsProviderForTest._maybeEndVodStream.call(uncoveredHls);

    return {
      dashClosed,
      dashEnded: dashMediaSource.ended,
      dashCount: dash.vodEndOfStreamCount,
      hlsClosed,
      hlsEnded: hlsMediaSource.ended,
      hlsCount: hls.vodEndOfStreamCount,
      busyDashClosedImmediately,
      busyDashPendingBeforeRelease,
      busyDashReadyState: busyDashMediaSource.readyState,
      busyDashCount: busyDash.vodEndOfStreamCount,
      busyDashPendingAfterRelease: busyDash.vodEndOfStreamPending,
      retryHlsClosedImmediately,
      retryHlsReadyState: retryMediaSource.readyState,
      retryHlsAttempts: retryMediaSource.attempts,
      retryHlsCount: retryHls.vodEndOfStreamCount,
      retryHlsRetryCount: retryHls.vodEndOfStreamRetryCount,
      gapHlsClosed,
      gapHlsReadyState: gapMediaSource.readyState,
      gapHlsFinalDuration: gapHls.vodFinalDuration,
      uncoveredHlsClosed,
      uncoveredHlsReadyState: uncoveredMediaSource.readyState,
    };
  });

  expect(state).toEqual({
    dashClosed: true,
    dashEnded: 1,
    dashCount: 1,
    hlsClosed: true,
    hlsEnded: 1,
    hlsCount: 1,
    busyDashClosedImmediately: false,
    busyDashPendingBeforeRelease: true,
    busyDashReadyState: 'ended',
    busyDashCount: 1,
    busyDashPendingAfterRelease: false,
    retryHlsClosedImmediately: false,
    retryHlsReadyState: 'ended',
    retryHlsAttempts: 2,
    retryHlsCount: 1,
    retryHlsRetryCount: 1,
    gapHlsClosed: true,
    gapHlsReadyState: 'ended',
    gapHlsFinalDuration: 4,
    uncoveredHlsClosed: false,
    uncoveredHlsReadyState: 'open',
  });
});

test('native HLS presentation state waits for active audio before finalizing live to VOD', async ({ page }) => {
  await setPlayerContent(page, '<video id="player"></video>');

  const state = await page.evaluate(() => {
    const liveStates = [];
    const provider = {
      live: true,
      videoDuration: 6,
      videoEndList: true,
      audioEndList: false,
      activeAudio: { duration: 6, endList: false },
      liveToVodTransitionCount: 0,
      engine: { setLive(value) { liveStates.push(value); } },
      _syncPresentationState: window.NativeHlsProviderForTest._syncPresentationState,
    };
    provider._syncPresentationState();
    const whileAudioLive = provider.live;
    provider.audioEndList = true;
    provider.activeAudio.endList = true;
    provider._syncPresentationState();
    return {
      whileAudioLive,
      finalLive: provider.live,
      duration: provider.duration,
      transitionCount: provider.liveToVodTransitionCount,
      liveStates,
    };
  });

  expect(state).toEqual({
    whileAudioLive: true,
    finalLive: false,
    duration: 6,
    transitionCount: 1,
    liveStates: [true, false],
  });
});

test('native DASH and HLS finalize delayed VOD queues and replay after trimmed EOS', async ({ page }) => {
  const sources = [
    { provider: 'native-dash', url: '/api/stream/PLAYERTEST1/dash.mpd' },
    { provider: 'native-hls', url: '/api/stream/PLAYERTEST1/hls.m3u8?fixtureHls=benchmark-groups' },
  ];

  for (const source of sources) {
    await page.goto('/auth/login');
    await setPlayerContent(page, '<video id="player" muted playsinline style="width:640px;height:360px"></video>');
    await page.evaluate(async ({ url }) => {
      const video = document.getElementById('player');
      const engine = new window.PlayerEngine(video, { videoId: 'PLAYERTEST1', streamToken: '' });
      window.__engine = engine;
      window.__player = engine.getPlayer();
      window.__player.configure({
        streaming: {
          bufferingGoal: 1,
          startupBufferGoal: 1,
          bufferBehind: 0.25,
          maxConcurrentRequests: 1,
        },
      });
      await engine.init();
      await engine.load(url);
    }, source);

    await page.waitForFunction(() => {
      const provider = window.__engine && window.__engine._provider;
      if (!provider || !provider.audioSb) return false;
      const audioSegments = provider.audio ? provider.audio.segments : provider.audioSegments;
      const videoSegments = provider.activeVideo ? provider.activeVideo.segments : provider.segments;
      const audioTerminal = audioSegments && audioSegments[audioSegments.length - 1];
      const videoTerminal = videoSegments && videoSegments[videoSegments.length - 1];
      return audioTerminal
        && (audioTerminal.appended || audioTerminal.state === 'appended')
        && videoTerminal
        && !videoTerminal.appended
        && videoTerminal.state !== 'appended';
    }, null, { timeout: 10_000 });

    await page.evaluate(() => {
      const provider = window.__engine._provider;
      const sb = provider.audioSb;
      const previous = Promise.resolve(sb._nativeQueue).catch(() => {});
      let release;
      sb._nativeQueueDepth = (sb._nativeQueueDepth || 0) + 1;
      const blocker = previous.then(() => new Promise(resolve => { release = resolve; }));
      sb._nativeQueue = blocker.then(() => {
        sb._nativeQueueDepth = Math.max(0, (sb._nativeQueueDepth || 1) - 1);
      });
      window.__releaseVodQueue = () => release();
      const video = document.getElementById('player');
      video.playbackRate = 2;
      return video.play();
    });

    await page.waitForFunction(() => {
      const provider = window.__engine && window.__engine._provider;
      return provider && provider.vodEndOfStreamPending === true;
    }, null, { timeout: 10_000 });

    const pendingState = await page.evaluate(() => {
      const video = document.getElementById('player');
      const provider = window.__engine._provider;
      return {
        ended: video.ended,
        mediaSourceState: provider.mediaSource.readyState,
        count: provider.vodEndOfStreamCount,
      };
    });
    expect(pendingState).toEqual({ ended: false, mediaSourceState: 'open', count: 0 });

    await page.evaluate(() => window.__releaseVodQueue());
    await page.waitForFunction(() => document.getElementById('player').ended, null, { timeout: 10_000 });

    const endedState = await page.evaluate(() => {
      const video = document.getElementById('player');
      const provider = window.__engine._provider;
      return {
        provider: window._playerProvider,
        ended: video.ended,
        paused: video.paused,
        bufferedStart: video.buffered.length ? video.buffered.start(0) : 0,
        mediaSourceState: provider.mediaSource.readyState,
        count: provider.vodEndOfStreamCount,
        pending: provider.vodEndOfStreamPending,
        stats: window.__player.getStats(),
      };
    });

    expect(endedState.provider).toBe(source.provider);
    expect(endedState.ended).toBe(true);
    expect(endedState.paused).toBe(true);
    expect(endedState.bufferedStart).toBeGreaterThan(0.1);
    expect(endedState.mediaSourceState).toBe('ended');
    expect(endedState.count).toBe(1);
    expect(endedState.pending).toBe(false);
    expect(endedState.stats.vodEndOfStreamCount).toBe(1);
    expect(endedState.stats.vodEndOfStreamPending).toBe(false);

    const fetchesBeforeReplay = endedState.stats.mediaFetchCompletedCount;
    await page.evaluate(() => {
      const video = document.getElementById('player');
      video.play().catch(() => {});
    });
    await page.waitForFunction(fetchCount => {
      const video = document.getElementById('player');
      const stats = window.__player.getStats();
      return !video.ended && video.currentTime > 0.25 && stats.mediaFetchCompletedCount > fetchCount;
    }, fetchesBeforeReplay, { timeout: 10_000 });

    const replayingState = await page.evaluate(() => {
      const video = document.getElementById('player');
      const provider = window.__engine._provider;
      return {
        currentTime: video.currentTime,
        mediaSourceState: provider.mediaSource.readyState,
        stats: window.__player.getStats(),
      };
    });
    expect(replayingState.currentTime).toBeGreaterThan(0.25);
    expect(replayingState.mediaSourceState).toBe('open');
    expect(replayingState.stats.vodEndOfStreamReopenCount).toBe(1);
    expect(replayingState.stats.vodEndOfStreamRefillPending).toBe(true);

    await page.waitForFunction(() => document.getElementById('player').ended, null, { timeout: 10_000 });
    const replayEndedStats = await page.evaluate(() => window.__player.getStats());
    expect(replayEndedStats.vodEndOfStreamCount).toBe(2);
    expect(replayEndedStats.vodEndOfStreamRefillPending).toBe(false);
    await page.evaluate(() => window.__engine.destroy());
  }
});

test('watch page renders centralized autoplay retry and end buffering cleanup', () => {
  const player = readFileSync('views/player.ejs', 'utf8');
  const controls = readFileSync('views/player/controls-setup.ejs', 'utf8');

  expect(player).toContain("var blocked = err && err.name === 'NotAllowedError';");
  expect(player).not.toContain("err.name === 'NotAllowedError' || err.name === 'AbortError'");
  expect(player).toContain('autoplayRetryTimer = setPlayerTimeout(retry, 250);');
  expect(player).toContain("video.addEventListener('ended', function () {");
  expect(player).toContain("container.classList.remove('player-buffering');");
  expect(player).toContain("video.addEventListener('pause', function () { clearBufferingIndicator(true); });");
  expect(player).toContain('var providerFinalDuration = Number(stats.vodFinalDuration) || 0;');
  expect(player).toContain("return player.load(data.progressive, startupResumeTime, 'video/mp4')");
  expect(player).toContain('return player.load(loadUrl, startupResumeTime)');
  expect(player).not.toContain('video.currentTime = resumeTime;');
  expect(player).not.toContain('video.src = data.progressive');
  expect(player).toContain("player.addEventListener('error', onPlayerTerminalError)");
  expect(player).toContain("if (detail.phase === 'load') return;");
  expect(player).toContain('.catch(handlePlayerFailure);');
  expect(player).toContain("engine._state === 'error'");
  expect(player).toContain('handledPlayerFailureGeneration === successfulLoadGeneration');
  expect(player).toContain('function activateSuccessfulLoad(options)');
  expect(player).toContain('activatedLoadGeneration === successfulLoadGeneration');
  expect(player).toContain('function beginPlayerLoadTransaction()');
  expect(player).toContain('fetchWithPlayerTimeout(manifestBaseUrl, 15000, transaction.signal)');
  expect(player).toContain('waitForExtractionCompletion(transaction)');
  expect(player).toContain('function setMediaSessionAction(action, handler)');
  expect(player).toContain("setMediaSessionAction(action, null)");
  expect(player).not.toContain("navigator.mediaSession.setActionHandler('play', function");
  expect(player).not.toContain('video.currentTime = 0;');
  expect(player).toContain('player.load() now resolves only after the current generation');
  expect(player).not.toContain("video.addEventListener('loadeddata', reveal, { once: true })");
  expect(player).not.toContain('setPlayerTimeout(reveal, 2000)');
  expect(player).toContain('!video.isConnected');
  expect(player).toContain("container.querySelector('.player-recovery-surface')");
  expect(player).toContain('if (!isFinite(countdownEnd))');
  expect(player).toContain('function replacePlayerWithError(message)');
  expect(player).not.toContain("container.innerHTML = '<div class=\"player-error\">Failed to load video: ' +");
  expect(controls).toContain("localStorage.getItem('player-muted-v2')");
  expect(controls).toContain("if (!autoplayPolicyMuted) localStorage.setItem('player-muted-v2'");
});

test('watch page renders centralized scheduled live reconnect without detaching player DOM', async ({ page }) => {
  await page.goto('/auth/login');
  await page.setContent([
    '<nav><span id="stream-via"></span><span id="load-timer"></span></nav>',
    '<main>',
    '<div class="player-embed" id="player-container">',
    '<div class="player-loading"><div class="player-spinner"></div></div>',
    '<video id="player" class="player-video"></video>',
    '</div>',
    '<h1 class="player-title">Scheduled fixture</h1>',
    '<span class="player-channel">Fixture channel</span>',
    '<div class="player-description"><pre></pre></div>',
    '</main>',
  ].join(''));

  await page.addScriptTag({ content: `
    localStorage.setItem('autoplay', '0');
    window.__mediaSessionActions = [];
    var mediaSessionFixture = {
      metadata: null,
      setActionHandler: function (action) {
        window.__mediaSessionActions.push(action);
        if (action === 'seekto') throw new DOMException('Unsupported action', 'NotSupportedError');
      }
    };
    try {
      Object.defineProperty(navigator, 'mediaSession', { configurable: true, value: mediaSessionFixture });
    } catch (e) {
      if ('mediaSession' in navigator) navigator.mediaSession.setActionHandler = mediaSessionFixture.setActionHandler;
    }
    window.__playerBootstrap = {
      videoId: 'SCHEDULED01',
      streamToken: 'test-token',
      playerDrmServers: {},
      liveStatus: 'upcoming',
      title: 'Scheduled fixture',
      channelTitle: 'Fixture channel',
      duration: 0,
      startTime: 0,
      savedPosition: 0
    };
    window.__scheduledLoadAttempts = 0;
    window.__scheduledReconnectSnapshot = null;
    window.__scheduledFallbackSignal = null;
    window.fetch = function (url, options) {
      var target = String(url);
      if (target.indexOf('/dash.mpd') !== -1) {
        if (options && options.signal) window.__scheduledFallbackSignal = options.signal;
        return Promise.resolve(new Response(JSON.stringify({
          error: 'Premieres in a moment',
          scheduledStart: new Date(Date.now() - 1000).toISOString()
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      if (target.indexOf('/cache/status') !== -1) {
        return Promise.resolve(new Response(JSON.stringify({ status: 'idle' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        }));
      }
      return Promise.resolve(new Response('[]', {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      }));
    };
    window.WebSocket = function () {
      this.close = function () {};
    };
    window.EventSource = function () {
      this.addEventListener = function () {};
      this.close = function () {};
    };
    function MockPlayer(engine) {
      this.engine = engine;
      this.events = {};
    }
    MockPlayer.prototype.load = function (url, startTime, mimeType) {
      return this.engine.load(url, startTime, mimeType);
    };
    MockPlayer.prototype.configure = function () {};
    MockPlayer.prototype.addEventListener = function (name, fn) {
      (this.events[name] = this.events[name] || []).push(fn);
    };
    MockPlayer.prototype.removeEventListener = function (name, fn) {
      this.events[name] = (this.events[name] || []).filter(function (listener) { return listener !== fn; });
    };
    MockPlayer.prototype.emit = function (name, detail) {
      (this.events[name] || []).slice().forEach(function (fn) { fn({ type: name, detail: detail }); });
    };
    MockPlayer.prototype.getStats = function () { return { provider: 'scheduled-fixture', fallbackReason: '' }; };
    MockPlayer.prototype.getVariantTracks = function () { return []; };
    MockPlayer.prototype.getActiveVariantTrack = function () { return null; };
    MockPlayer.prototype.getTextTracks = function () { return []; };
    MockPlayer.prototype.getIFrameTracks = function () { return []; };
    MockPlayer.prototype.getIFramePreview = function () { return Promise.resolve(null); };
    MockPlayer.prototype.getPlaybackRate = function () { return this.engine.video.playbackRate; };
    MockPlayer.prototype.setPlaybackRate = function (rate) { this.engine.video.playbackRate = rate; };
    MockPlayer.prototype.isLive = function () { return false; };
    MockPlayer.prototype.seekRange = function () { return { start: 0, end: 0 }; };
    MockPlayer.prototype.getAssetUri = function () { return null; };
    MockPlayer.prototype.setTextTrackVisibility = function () {};
    function MockPlayerEngine(video) {
      this.video = video;
      this._player = new MockPlayer(this);
      this._listeners = {};
      this._loadGeneration = 0;
      this._state = 'idle';
      this._provider = null;
      this._internalStallWatch = true;
      this.recovering = false;
      this.recoveryTransition = false;
      this.networkTrouble = false;
      this.isLive = false;
      this.videoUnavailable = false;
      window.__scheduledEngine = this;
    }
    MockPlayerEngine.prototype.getPlayer = function () { return this._player; };
    MockPlayerEngine.prototype.init = function () { return Promise.resolve(); };
    MockPlayerEngine.prototype.on = function (name, fn) {
      (this._listeners[name] = this._listeners[name] || []).push(fn);
    };
    MockPlayerEngine.prototype.load = function () {
      var self = this;
      var attempt = ++window.__scheduledLoadAttempts;
      this._loadGeneration++;
      this._state = 'loading';
      if (attempt === 1) return Promise.reject(new Error('initial native load failed'));
      window.__scheduledReconnectSnapshot = {
        videoConnected: this.video.isConnected,
        videoContained: document.getElementById('player-container').contains(this.video),
        controlsConnected: !!document.querySelector('.player-controls-container'),
        recoveryVisible: !!document.querySelector('.player-recovery-surface')
      };
      return new Promise(function (resolve) {
        setTimeout(function () {
          self._state = 'ready';
          self._player.emit('loaded');
          resolve();
          setTimeout(function () { self.video.dispatchEvent(new Event('loadeddata')); }, 0);
        }, 50);
      });
    };
    MockPlayerEngine.prototype.isRecovering = function () { return false; };
    MockPlayerEngine.prototype.setLive = function (live) { this.isLive = !!live; };
    MockPlayerEngine.prototype.setTextController = function () {};
    MockPlayerEngine.prototype.reportStall = function () {};
    MockPlayerEngine.prototype.destroy = function () { this._state = 'destroyed'; };
    window.PlayerEngine = MockPlayerEngine;
  ` });

  await page.addScriptTag({ path: 'public/player-page.js' });
  await expect.poll(() => page.evaluate(() => window.__scheduledLoadAttempts)).toBe(2);
  await expect(page.locator('#player-container')).toHaveClass(/player-ready/);
  await expect(page.locator('#player-container')).not.toHaveClass(/player-fallback/);
  await expect(page.locator('.player-recovery-surface')).toHaveCount(0);
  await expect(page.locator('#player')).toHaveCount(1);
  await expect(page.locator('.player-controls-container')).toHaveCount(1);

  const state = await page.evaluate(() => ({
    snapshot: window.__scheduledReconnectSnapshot,
    videoConnected: document.getElementById('player').isConnected,
    videoContained: document.getElementById('player-container').contains(document.getElementById('player')),
    generation: window.__scheduledEngine._loadGeneration,
    engineState: window.__scheduledEngine._state,
    fallbackSignalAborted: window.__scheduledFallbackSignal && window.__scheduledFallbackSignal.aborted,
    mediaSessionActions: window.__mediaSessionActions,
  }));
  expect(state.snapshot).toEqual({
    videoConnected: true,
    videoContained: true,
    controlsConnected: true,
    recoveryVisible: true,
  });
  expect(state.videoConnected).toBe(true);
  expect(state.videoContained).toBe(true);
  expect(state.generation).toBe(2);
  expect(state.engineState).toBe('ready');
  expect(state.fallbackSignalAborted).toBe(true);
  expect(state.mediaSessionActions).toContain('seekto');
  expect(state.mediaSessionActions).toContain('nexttrack');

  await page.evaluate(() => {
    const err = new Error('<img id="injected-player-error">unsafe</img>');
    err.permanent = true;
    err.scheduledStart = 'not-a-valid-date';
    err.loadGeneration = window.__scheduledEngine._loadGeneration;
    window._player.emit('error', {
      phase: 'runtime',
      error: err,
      loadGeneration: err.loadGeneration,
    });
  });
  await expect(page.locator('.player-error')).toContainText('<img id="injected-player-error">unsafe</img>');
  await expect(page.locator('#injected-player-error')).toHaveCount(0);
  await expect(page.locator('.player-recovery-surface')).toHaveCount(0);
});

test('service-worker caches versioned player runtime without per-navigation revalidation', () => {
  const worker = readFileSync('public/sw.js', 'utf8');
  const route = readFileSync('routes/player.ts', 'utf8');
  const head = readFileSync('views/partials/head.ejs', 'utf8');

  expect(worker).toContain("var STATIC_CACHE = 'my-youtube-static-' + RUNTIME_ASSET_URLS.revision;");
  expect(worker).toContain("var SEGMENT_CACHE = 'my-youtube-segments-v7';");
  expect(worker).not.toContain("'/native-player-engine.js?v=18'");
  expect(worker).toContain("VERSIONED_RUNTIME_ASSETS.indexOf(url.pathname + url.search) !== -1");
  expect(worker).toContain("url.searchParams.get('kind') === 'playlist'");
  expect(worker).toContain("body.indexOf('#EXT-X-ENDLIST') !== -1");
  expect(worker).toContain('requestRequiresRevalidation(event.request)');
  expect(worker).toContain("request.headers.get('Cache-Control')");
  expect(worker).toContain('RUNTIME_ASSET_URLS.playerPage');
  expect(worker).not.toContain('NETWORK_FIRST_STATIC');
  expect(route).toContain("runtimeAssetUrl('native-player-engine.min.js')");
  expect(route).toContain("runtimeAssetUrl('player-page.min.js')");
  expect(head).not.toContain('/native-player-engine.js?v=18');
  expect(head).toContain("<script src=\"<%= runtimeAssetUrl('app.js') %>\" defer></script>");
  expect(head).toContain("<script src=\"<%= runtimeAssetUrl('idb-helpers.js') %>\" defer></script>");
});

test('offline format writer drains full chunks without locking the tab', async ({ page }) => {
  await page.goto('/auth/login');
  await page.addScriptTag({ path: 'public/app.js' });
  const result = await page.evaluate(async () => {
    const chunkSizes = [];
    const metaWrites = [];
    window.IDBHelpers = {
      CHUNK_SIZE: 2 * 1024 * 1024,
      getMeta: async () => null,
      putChunk: async (_key, _index, blob) => { chunkSizes.push(blob.size); },
      putMeta: async (_key, meta) => { metaWrites.push(meta); },
      deleteFormat: async () => {},
    };
    const originalFetch = window.fetch;
    window.fetch = async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(1024 * 1024));
        controller.enqueue(new Uint8Array(1024 * 1024));
        controller.enqueue(new Uint8Array(1024 * 1024));
        controller.close();
      },
    }), {
      status: 200,
      headers: { 'Content-Length': String(3 * 1024 * 1024) },
    });
    try {
      await Promise.race([
        window.downloadFormatToIDB('dQw4w9WgXcQ', '140', 'test-token'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('offline writer stalled')), 2000)),
      ]);
      return { chunkSizes, finalMeta: metaWrites[metaWrites.length - 1] };
    } finally {
      window.fetch = originalFetch;
    }
  });

  expect(result.chunkSizes).toEqual([2 * 1024 * 1024, 1024 * 1024]);
  expect(result.finalMeta.done).toBe(true);
  expect(result.finalMeta.totalSize).toBe(3 * 1024 * 1024);
  expect(result.finalMeta.totalChunks).toBe(2);
});

test('offline download catalog is record-based and only exposes prepared videos', async ({ page }) => {
  await page.goto('/auth/login');
  await page.addScriptTag({ path: 'public/idb-helpers.js' });
  const result = await page.evaluate(async () => {
    const first = 'offline-test-a';
    const second = 'offline-test-b';
    await window.IDBHelpers.deleteAllForVideo(first);
    await window.IDBHelpers.deleteAllForVideo(second);
    await window.IDBHelpers.upsertDownloadRecords([
      { video_id: first, title: 'First', channel_title: 'Channel A' },
      { video_id: second, title: 'Second', channel_title: 'Channel B' },
    ]);
    await window.IDBHelpers.setDownloadPrepared(second, true);
    const prepared = await window.IDBHelpers.getPreparedDownloadRecords();
    const firstRecord = await window.IDBHelpers.getDownloadRecord(first);
    const secondRecord = await window.IDBHelpers.getDownloadRecord(second);
    await window.IDBHelpers.deleteAllForVideo(first);
    await window.IDBHelpers.deleteAllForVideo(second);
    return {
      preparedIds: prepared.map(item => item.video_id).filter(id => id === first || id === second),
      firstPrepared: firstRecord.prepared,
      secondPrepared: secondRecord.prepared,
    };
  });

  expect(result).toEqual({
    preparedIds: ['offline-test-b'],
    firstPrepared: 0,
    secondPrepared: 1,
  });
});

test('offline download catalog pages prepared records and scopes visible-card lookups', async ({ page }) => {
  await page.goto('/auth/login');
  await page.addScriptTag({ path: 'public/idb-helpers.js' });
  const result = await page.evaluate(async () => {
    const ids = ['offline-page-a', 'offline-page-b', 'offline-page-c'];
    await Promise.all(ids.map(id => window.IDBHelpers.deleteAllForVideo(id)));
    await window.IDBHelpers.upsertDownloadRecords([
      { video_id: ids[0], title: 'First', prepared: 1, updated_at: 100 },
      { video_id: ids[1], title: 'Second', prepared: 1, updated_at: 200 },
      { video_id: ids[2], title: 'Third', prepared: 1, updated_at: 300 },
    ]);
    const firstPage = await window.IDBHelpers.getPreparedDownloadPage({ limit: 2 });
    const secondPage = await window.IDBHelpers.getPreparedDownloadPage({ limit: 2, cursor: firstPage.nextCursor });
    const visible = await window.IDBHelpers.getDownloadRecords([ids[0], ids[2]]);
    await Promise.all(ids.map(id => window.IDBHelpers.deleteAllForVideo(id)));
    return {
      first: firstPage.items.map(item => item.video_id),
      second: secondPage.items.map(item => item.video_id),
      hasMore: Boolean(firstPage.nextCursor),
      finished: secondPage.nextCursor === null,
      visible: visible.map(item => item.video_id),
    };
  });

  expect(result).toEqual({
    first: ['offline-page-c', 'offline-page-b'],
    second: ['offline-page-a'],
    hasMore: true,
    finished: true,
    visible: ['offline-page-a', 'offline-page-c'],
  });
});

test('server download completion no longer starts an automatic browser copy', () => {
  const player = readFileSync('views/player.ejs', 'utf8');
  const app = readFileSync('public/app.js', 'utf8');
  expect(player).not.toContain('prepareForOffline(dlVideoId)');
  expect(app).not.toContain("localStorage.setItem('offline_");
  expect(app).toContain("button.addEventListener('click'");
});

test('watch seek preview defers storyboard work until user interaction', () => {
  const player = readFileSync('views/player.ejs', 'utf8');
  const preview = readFileSync('views/player/thumbnail-preview.ejs', 'utf8');

  expect(player).not.toContain("idleCb(function () { if (window._loadStoryboard) window._loadStoryboard(); });");
  expect(preview).toContain('var storyboardLoadPromise = null;');
  expect(preview).toContain("seekBarContainer.addEventListener('pointerenter', requestStoryboardOnInteraction");
  expect(preview).toContain("seekBarContainer.addEventListener('focusin', requestStoryboardOnInteraction");
});

test('duration batches keep concurrent SSE streams', async ({ page }) => {
  await page.goto('/auth/login');
  await page.addScriptTag({ path: 'public/app.js' });
  const state = await page.evaluate(() => {
    const sources = [];
    class FakeEventSource {
      constructor(url) {
        this.url = url;
        this.closed = false;
        sources.push(this);
      }
      addEventListener() {}
      close() { this.closed = true; }
    }
    window.EventSource = FakeEventSource;
    document.body.innerHTML = Array.from({ length: 51 }, function (_, index) {
      var id = String(index).padStart(11, '0');
      return '<span class="video-duration" data-video-id="' + id + '"></span>';
    }).join('');
    window.loadDurations(true);
    return sources.map(function (source) {
      return { url: source.url, closed: source.closed };
    });
  });

  expect(state).toHaveLength(3);
  expect(state[0].closed).toBe(false);
  expect(state[1].closed).toBe(false);
  expect(state[2].closed).toBe(false);
  for (const source of state) {
    expect(new URL(source.url, 'http://localhost').searchParams.get('ids').split(',').length).toBeLessThanOrEqual(20);
  }
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

test('native provider seek lifecycle clamps buffered targets without scheduler churn', async ({ page }) => {
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const state = await page.evaluate(() => {
    function makeVideo() {
      const video = document.getElementById('player').cloneNode();
      let currentTime = 1.5;
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
            start() { return 0; },
            end() { return 6; },
          };
        },
      });
      return video;
    }

    function engine(states, events) {
      return {
        _serverDown: false,
        _setState(value) { states.push(value); },
        _telemetry: {
          record(type, payload) { events.push({ type, payload: payload || null }); },
        },
      };
    }

    function exercise(kind) {
      const states = [];
      const events = [];
      let abortCalls = 0;
      let tickCalls = 0;
      let beginCalls = 0;
      const proto = kind === 'hls'
        ? window.NativeHlsProviderForTest
        : window.NativeDashProviderForTest;
      const provider = {
        video: makeVideo(),
        engine: engine(states, events),
        destroyed: false,
        live: false,
        liveWindow: null,
        seekBufferPending: false,
        seekBufferReadyCount: 0,
        bufferedSeekCount: 0,
        seekCount: 0,
        seekAbortCount: 0,
        lastSeekTarget: 0,
        lastSeekStartedAt: 0,
        lastSeekMs: 0,
        _lastSeekHandledTarget: null,
        _lastSeekHandledAt: 0,
        pendingSeek: 0,
        variantSwitchInFlight: false,
        _clampSeekTarget: proto._clampSeekTarget,
        _onSeek: proto._onSeek,
        beginSeek(target) {
          beginCalls++;
          return proto.beginSeek.call(this, target);
        },
        _abortRequests() {
          abortCalls++;
          return 1;
        },
        _tick() {
          tickCalls++;
        },
      };

      proto.beginSeek.call(provider, 4.5);
      beginCalls++;
      const startedAt = provider.lastSeekStartedAt;
      const target = proto.commitSeek.call(provider, 4.5);
      const reusedBeginTimestamp = provider.lastSeekStartedAt === startedAt;
      proto._onSeek.call(provider, 4.5);
      proto.endSeek.call(provider);

      return {
        target,
        currentTime: provider.video.currentTime,
        beginCalls,
        reusedBeginTimestamp,
        abortCalls,
        tickCalls,
        seekCount: provider.seekCount,
        seekBufferPending: provider.seekBufferPending,
        seekBufferReadyCount: provider.seekBufferReadyCount,
        bufferedSeekCount: provider.bufferedSeekCount,
        pendingSeek: provider.pendingSeek,
        states,
        events,
      };
    }

    return {
      hls: exercise('hls'),
      dash: exercise('dash'),
    };
  });

  for (const provider of [state.hls, state.dash]) {
    expect(provider.target).toBe(4.5);
    expect(provider.currentTime).toBe(4.5);
    expect(provider.beginCalls).toBe(1);
    expect(provider.reusedBeginTimestamp).toBe(true);
    expect(provider.abortCalls).toBe(0);
    expect(provider.tickCalls).toBe(0);
    expect(provider.seekCount).toBe(1);
    expect(provider.seekBufferPending).toBe(false);
    expect(provider.seekBufferReadyCount).toBe(1);
    expect(provider.bufferedSeekCount).toBe(1);
    expect(provider.states).toContain('seeking');
    expect(provider.states.at(-1)).toBe('ready');
    expect(provider.events).toEqual([
      { type: 'seek-buffer-ready', payload: { buffered: true } },
    ]);
  }
  expect(state.hls.pendingSeek).toBe(0);
  expect(state.dash.pendingSeek).toBe(0);
});

test('native provider seek lifecycle clamps rapid seek generations to the latest operation', async ({ page }) => {
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const state = await page.evaluate(() => {
    function makeVideo() {
      const video = document.getElementById('player').cloneNode();
      let currentTime = 0;
      let bufferedRanges = [];
      Object.defineProperty(video, 'currentTime', {
        configurable: true,
        get() { return currentTime; },
        set(value) { currentTime = value; },
      });
      Object.defineProperty(video, 'buffered', {
        configurable: true,
        get() {
          return {
            length: bufferedRanges.length,
            start(index) { return bufferedRanges[index][0]; },
            end(index) { return bufferedRanges[index][1]; },
          };
        },
      });
      video.__setBufferedRanges = ranges => { bufferedRanges = ranges; };
      return video;
    }

    function exercise(kind) {
      const proto = kind === 'hls'
        ? window.NativeHlsProviderForTest
        : window.NativeDashProviderForTest;
      const states = [];
      const events = [];
      const engine = {
        _state: 'ready',
        _serverDown: false,
        _setState(next) {
          if (this._state === next) return;
          this._state = next;
          states.push(next);
        },
        _telemetry: {
          record(type, payload) { events.push({ type, payload: payload || null }); },
        },
        _player: {
          config: {
            streaming: { bufferingGoal: 8, seekBufferGoal: 3 },
            manifest: {},
          },
        },
      };
      const provider = {
        video: makeVideo(),
        engine,
        destroyed: false,
        live: false,
        liveWindow: null,
        controllers: [],
        activeRanges: {},
        startupBufferComplete: true,
        startupBufferStartedAt: 0,
        startupBufferMs: 0,
        firstPlayableRange: null,
        seekBufferPending: false,
        seekInteractionPending: false,
        seekBufferReadyCount: 0,
        bufferedSeekCount: 0,
        seekCount: 0,
        seekCancelCount: 0,
        seekAbortCount: 0,
        seekGeneration: 0,
        activeSeekGeneration: 0,
        completedSeekGeneration: 0,
        lastSeekTarget: 0,
        lastSeekStartedAt: 0,
        lastSeekMs: 0,
        _lastSeekHandledTarget: null,
        _lastSeekHandledAt: 0,
        _lastSeekHandledGeneration: 0,
        beginSeek: proto.beginSeek,
        _onSeek: proto._onSeek,
        _clampSeekTarget: proto._clampSeekTarget,
        _seekBufferGoal: proto._seekBufferGoal,
        _bufferAheadGoal: proto._bufferAheadGoal,
        _abortRequests() { return 0; },
        _tick() {},
      };
      if (kind === 'hls') {
        provider.variantSwitchInFlight = false;
        provider.segments = [
          { start: 8, end: 12, state: 'idle' },
          { start: 18, end: 22, state: 'idle' },
          { start: 28, end: 32, state: 'idle' },
        ];
        provider.activeAudio = null;
      } else {
        provider.requestGeneration = 0;
        provider.requestCancellationCount = 0;
        provider._availabilityWindowOverride = proto._availabilityWindowOverride;
        provider._effectiveLiveWindow = proto._effectiveLiveWindow;
        provider.activeVideo = {
          id: 'video',
          segments: [
            { start: 8, end: 12, state: 'idle' },
            { start: 18, end: 22, state: 'idle' },
            { start: 28, end: 32, state: 'idle' },
          ],
        };
        provider.audio = {
          id: 'audio',
          segments: [
            { start: 8, end: 12, state: 'idle' },
            { start: 18, end: 22, state: 'idle' },
            { start: 28, end: 32, state: 'idle' },
          ],
        };
      }

      proto.commitSeek.call(provider, 10);
      const firstGeneration = provider.activeSeekGeneration;
      proto.commitSeek.call(provider, 20);
      const secondGeneration = provider.activeSeekGeneration;
      provider.video.currentTime = 10;
      provider.video.__setBufferedRanges([[8, 14]]);
      proto._checkBufferMilestones.call(provider);
      const oldTargetBufferMarkedReady = !provider.seekBufferPending;
      provider.video.currentTime = 20;
      provider.video.__setBufferedRanges([]);
      const staleCompletionAccepted = proto._completeSeekBuffer.call(provider, firstGeneration, false);
      proto.endSeek.call(provider, secondGeneration);
      const afterInteraction = {
        state: engine._state,
        seekBufferPending: provider.seekBufferPending,
        seekInteractionPending: provider.seekInteractionPending,
      };
      const currentCompletionAccepted = proto._completeSeekBuffer.call(provider, secondGeneration, false);
      const afterCurrentCompletion = {
        state: engine._state,
        seekBufferPending: provider.seekBufferPending,
        completedSeekGeneration: provider.completedSeekGeneration,
        readyCount: provider.seekBufferReadyCount,
      };

      proto.commitSeek.call(provider, 30);
      const cancelledGeneration = provider.activeSeekGeneration;
      proto.cancelSeek.call(provider);
      const cancelledCompletionAccepted = proto._completeSeekBuffer.call(provider, cancelledGeneration, false);

      return {
        firstGeneration,
        secondGeneration,
        oldTargetBufferMarkedReady,
        staleCompletionAccepted,
        afterInteraction,
        currentCompletionAccepted,
        afterCurrentCompletion,
        cancelledGeneration,
        cancelledCompletionAccepted,
        activeSeekGeneration: provider.activeSeekGeneration,
        seekBufferPending: provider.seekBufferPending,
        seekInteractionPending: provider.seekInteractionPending,
        readyCount: provider.seekBufferReadyCount,
        states,
        events,
        onSeekUsesTimer: String(proto._onSeek).includes('setTimeout'),
      };
    }

    return { hls: exercise('hls'), dash: exercise('dash') };
  });

  for (const provider of [state.hls, state.dash]) {
    expect(provider.secondGeneration).toBeGreaterThan(provider.firstGeneration);
    expect(provider.oldTargetBufferMarkedReady).toBe(false);
    expect(provider.staleCompletionAccepted).toBe(false);
    expect(provider.afterInteraction).toEqual({
      state: 'seeking',
      seekBufferPending: true,
      seekInteractionPending: false,
    });
    expect(provider.currentCompletionAccepted).toBe(true);
    expect(provider.afterCurrentCompletion).toEqual({
      state: 'ready',
      seekBufferPending: false,
      completedSeekGeneration: provider.secondGeneration,
      readyCount: 1,
    });
    expect(provider.cancelledGeneration).toBeGreaterThan(provider.secondGeneration);
    expect(provider.cancelledCompletionAccepted).toBe(false);
    expect(provider.activeSeekGeneration).toBe(0);
    expect(provider.seekBufferPending).toBe(false);
    expect(provider.seekInteractionPending).toBe(false);
    expect(provider.readyCount).toBe(1);
    expect(provider.states).toEqual(['seeking', 'ready', 'seeking', 'ready']);
    expect(provider.events).toEqual([{ type: 'seek-buffer-ready', payload: null }]);
    expect(provider.onSeekUsesTimer).toBe(false);
  }
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

test('native startup chooses concurrent initialization for independent audio and video buffers', async ({ page }) => {
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const state = await page.evaluate(async () => {
    function sourceBuffer(name) {
      const listeners = {};
      return {
        name,
        mode: '',
        updating: false,
        addEventListener(type, fn) { listeners[type] = fn; },
        removeEventListener(type) { delete listeners[type]; },
        appendBuffer() {
          this.updating = true;
          window.__startupOrder.push('append-' + name);
          setTimeout(() => {
            this.updating = false;
            if (listeners.updateend) listeners.updateend();
          }, 25);
        },
      };
    }

    const video = document.getElementById('player');
    window.__startupOrder = [];
    const engine = new window.PlayerEngine(video, { videoId: 'TESTVIDEO01', streamToken: '' });
    engine._setState = function () {};
    engine._player.emit = function () {};
    const videoSb = sourceBuffer('video');
    const audioSb = sourceBuffer('audio');
    const hls = {
      mediaSource: {
        duration: NaN,
        addSourceBuffer(type) { return type.startsWith('video/') ? videoSb : audioSb; },
      },
      video,
      live: false,
      duration: 6,
      mimeType: 'video/mp4; codecs="avc1.42c01f"',
      audioMimeType: 'audio/mp4; codecs="mp4a.40.2"',
      initSegment: { url: '/video-init', range: null },
      audioInitSegment: { url: '/audio-init', range: null },
      activeAudio: { id: 'audio' },
      segments: [],
      engine,
      _fetchRange(url) {
        window.__startupOrder.push('fetch-' + url.slice(1));
        return new Promise(resolve => setTimeout(() => resolve(new ArrayBuffer(1)), url.includes('video') ? 30 : 10));
      },
      _schedulePlaylistRefresh() {},
      _tick() {},
    };

    const hlsOpen = window.NativeHlsProviderForTest._open.call(hls);
    await new Promise(resolve => setTimeout(resolve, 0));
    const hlsRequestsBeforeFirstResolution = window.__startupOrder.slice();
    await hlsOpen;

    window.__startupOrder = [];
    const dash = {
      mediaSource: {
        duration: NaN,
        addSourceBuffer(type) { return type.startsWith('video/') ? videoSb : audioSb; },
      },
      video,
      live: false,
      duration: 6,
      activeVideo: { id: 'video', mimeType: 'video/mp4', codecs: 'avc1.42c01f', initData: new ArrayBuffer(1) },
      audio: { id: 'audio', mimeType: 'audio/mp4', codecs: 'mp4a.40.2', initData: new ArrayBuffer(1) },
      engine,
      _prepareRep(rep) { return Promise.resolve(rep); },
      _tick() {},
      _scheduleManifestRefresh() {},
    };
    await window.NativeDashProviderForTest._open.call(dash);
    clearInterval(dash.fillTimer);
    const dashAppendOrder = window.__startupOrder.slice();

    return { hlsRequestsBeforeFirstResolution, dashAppendOrder };
  });

  expect(state.hlsRequestsBeforeFirstResolution).toEqual(['fetch-video-init', 'fetch-audio-init']);
  expect(state.dashAppendOrder.slice(0, 2)).toEqual(['append-video', 'append-audio']);
});

test('native HLS low-latency playlist honors advertised live-edge startup and bounded buffers', async ({ page }) => {
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const state = await page.evaluate(() => {
    const video = document.getElementById('player');
    const engine = new window.PlayerEngine(video, { videoId: 'TESTVIDEO01', streamToken: '' });
    const provider = {
      video,
      engine,
      live: true,
      lowLatencyPlaylist: true,
      liveWindow: { start: 100, end: 200 },
      partTargetDuration: 0.5,
      serverControl: { partHoldBack: 1.5 },
      _bufferAheadGoal: window.NativeHlsProviderForTest._bufferAheadGoal,
      _targetLiveLatency: window.NativeHlsProviderForTest._targetLiveLatency,
    };
    video.currentTime = 198;
    window.NativeHlsProviderForTest._updateLivePositionStats.call(provider);
    const result = {
      start: window.NativeHlsProviderForTest._defaultLiveStartTime.call(provider),
      startup: window.NativeHlsProviderForTest._startupBufferGoal.call(provider),
      ahead: window.NativeHlsProviderForTest._bufferAheadGoal.call(provider),
      behind: window.NativeHlsProviderForTest._bufferBehindGoal.call(provider),
      targetLatency: window.NativeHlsProviderForTest._targetLiveLatency.call(provider),
      atLiveEdge: provider.atLiveEdge,
    };
    const normalProvider = {
      video,
      engine,
      live: true,
      lowLatencyPlaylist: false,
      liveWindow: { start: 100, end: 200 },
      targetDuration: 4,
      serverControl: { holdBack: 8 },
      _targetLiveLatency: window.NativeHlsProviderForTest._targetLiveLatency,
    };
    result.normal = {
      start: window.NativeHlsProviderForTest._defaultLiveStartTime.call(normalProvider),
      ahead: window.NativeHlsProviderForTest._bufferAheadGoal.call(normalProvider),
      behind: window.NativeHlsProviderForTest._bufferBehindGoal.call(normalProvider),
      targetLatency: window.NativeHlsProviderForTest._targetLiveLatency.call(normalProvider),
    };
    engine.getPlayer().configure('streaming.bufferingGoal', 2);
    result.explicitAhead = window.NativeHlsProviderForTest._bufferAheadGoal.call(provider);
    return result;
  });

  expect(state).toEqual({
    start: 198.5,
    startup: 1,
    ahead: 4,
    behind: 8,
    targetLatency: 1.5,
    atLiveEdge: true,
    normal: {
      start: 192,
      ahead: 30,
      behind: 8,
      targetLatency: 8,
    },
    explicitAhead: 2,
  });
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
      startupBufferComplete: true,
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

test('native media scheduler respects startup-critical video and audio bandwidth', async ({ page }) => {
  const shakaRequests = await blockShakaScript(page);
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const state = await page.evaluate(() => {
    const video = document.getElementById('player');
    Object.defineProperty(video, 'currentTime', { configurable: true, get() { return 0; } });
    Object.defineProperty(video, 'buffered', {
      configurable: true,
      get() {
        return { length: 0, start() { return 0; }, end() { return 0; } };
      },
    });
    const provider = {
      video,
      destroyed: false,
      startupBufferComplete: false,
      seekBufferPending: false,
      activeRanges: {},
      engine: { _telemetry: { record() {} } },
      _bufferAheadGoal() { return 30; },
      _maxConcurrentMediaRequests() { return 3; },
      _drainAppendQueue: window.NativeDashProviderForTest._drainAppendQueue,
      _buildSegmentCandidates: window.NativeDashProviderForTest._buildSegmentCandidates,
      _startSegmentFetch: window.NativeDashProviderForTest._startSegmentFetch,
      _scheduleMediaRequests: window.NativeDashProviderForTest._scheduleMediaRequests,
      _fetchRange() { return new Promise(() => {}); },
    };
    const videoRep = {
      id: 'v',
      kind: 'video',
      baseUrl: '/video',
      segments: [
        { id: 'v0', start: 0, end: 2, range: { start: 0, end: 99 } },
        { id: 'v1', start: 2, end: 4, range: { start: 100, end: 199 } },
      ],
    };
    const audioRep = {
      id: 'a',
      kind: 'audio',
      baseUrl: '/audio',
      segments: [
        { id: 'a0', start: 0, end: 2, range: { start: 0, end: 49 } },
        { id: 'a1', start: 2, end: 4, range: { start: 50, end: 99 } },
      ],
    };
    provider._scheduleMediaRequests(4, [
      { rep: videoRep, sb: { updating: false } },
      { rep: audioRep, sb: { updating: false } },
    ]);
    return {
      videoFetching: videoRep.segments.filter(seg => seg.state === 'fetching').map(seg => seg.id),
      audioFetching: audioRep.segments.filter(seg => seg.state === 'fetching').map(seg => seg.id),
      activeRangeCount: Object.keys(provider.activeRanges).length,
    };
  });

  expect(state).toEqual({
    videoFetching: ['v0'],
    audioFetching: ['a0'],
    activeRangeCount: 2,
  });
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

test('native networking holds transient online service-worker offline 503 responses', async ({ page }) => {
  let segmentAttempts = 0;
  let probeAttempts = 0;

  await page.route('**/sw-network-miss-segment.m4s', route => {
    segmentAttempts++;
    route.fulfill({
      status: segmentAttempts === 1 ? 503 : 200,
      contentType: 'application/octet-stream',
      headers: segmentAttempts === 1 ? {
        'X-SW-Cached': '0',
        'X-SW-Offline': '1',
        'X-SW-Source': 'miss',
      } : {},
      body: segmentAttempts === 1 ? '' : 'ok',
    });
  });
  await page.route('**/api/stream/SWHOLDTEST/dash.mpd**', route => {
    probeAttempts++;
    route.fulfill({ status: 200, contentType: 'application/dash+xml', body: '' });
  });
  await page.route('**/api/player-events', route => route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }));

  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const state = await page.evaluate(async () => {
    const video = document.getElementById('player');
    const engine = new window.PlayerEngine(video, { videoId: 'SWHOLDTEST', streamToken: 'test-token' });
    await engine.init();
    engine._setState('ready');
    const events = [];
    engine.on('server-down', reason => events.push({ type: 'server-down', reason }));
    engine.on('server-up', () => events.push({ type: 'server-up' }));
    const networking = engine.getPlayer().getNetworkingEngine();
    const response = await networking.request(
      networking.RequestType.SEGMENT,
      { uris: ['/sw-network-miss-segment.m4s'] },
      { forceNetworkHold: true }
    );
    return {
      status: response.status,
      body: new TextDecoder().decode(response.data),
      events,
      stats: engine.getPlayer().getStats(),
    };
  });

  expect(segmentAttempts).toBe(2);
  expect(probeAttempts).toBeGreaterThan(0);
  expect(state.status).toBe(200);
  expect(state.body).toBe('ok');
  expect(state.events).toEqual([{ type: 'server-down', reason: 'server-error' }, { type: 'server-up' }]);
  expect(state.stats.networkHoldCount).toBe(1);
  expect(state.stats.networkResumeCount).toBe(1);
  expect(state.stats.networkHeldRequestCount).toBe(0);
});

test('native networking holds transient errors without looping forever on persistent failures', async ({ page }) => {
  let segmentAttempts = 0;
  let probeAttempts = 0;

  await page.route('**/persistent-server-error.m4s', route => {
    segmentAttempts++;
    route.fulfill({ status: 503, contentType: 'text/plain', body: 'still unavailable' });
  });
  await page.route('**/api/stream/HOLDBUDGET1/dash.mpd**', route => {
    probeAttempts++;
    route.fulfill({ status: 200, contentType: 'application/dash+xml', body: '' });
  });
  await page.route('**/api/player-events', route => route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }));

  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const state = await page.evaluate(async () => {
    const video = document.getElementById('player');
    const engine = new window.PlayerEngine(video, { videoId: 'HOLDBUDGET1', streamToken: 'test-token' });
    await engine.init();
    engine._setState('ready');
    const networking = engine.getPlayer().getNetworkingEngine();
    const response = await networking.request(
      networking.RequestType.SEGMENT,
      { uris: ['/persistent-server-error.m4s'] },
      { forceNetworkHold: true }
    );
    return {
      status: response.status,
      recovering: engine.isRecovering(),
      stats: engine.getPlayer().getStats(),
    };
  });

  expect(segmentAttempts).toBe(3);
  expect(probeAttempts).toBe(2);
  expect(state.status).toBe(503);
  expect(state.recovering).toBe(false);
  expect(state.stats.networkHoldCount).toBe(2);
  expect(state.stats.networkResumeCount).toBe(2);
  expect(state.stats.networkHeldRequestCount).toBe(0);
});

test('native networking does not hold a service-worker 503 while the browser is offline', async ({ page }) => {
  let segmentAttempts = 0;
  let probeAttempts = 0;

  await page.route('**/sw-offline-segment.m4s', route => {
    segmentAttempts++;
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
  await page.route('**/api/stream/SWOFFLINE/dash.mpd**', route => {
    probeAttempts++;
    route.fulfill({ status: 200, contentType: 'application/dash+xml', body: '' });
  });

  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const state = await page.evaluate(async () => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
    const video = document.getElementById('player');
    const engine = new window.PlayerEngine(video, { videoId: 'SWOFFLINE', streamToken: 'test-token' });
    await engine.init();
    engine._setState('ready');
    const networking = engine.getPlayer().getNetworkingEngine();
    const response = await networking.request(
      networking.RequestType.SEGMENT,
      { uris: ['/sw-offline-segment.m4s'] },
      { forceNetworkHold: true }
    );
    return {
      status: response.status,
      stats: engine.getPlayer().getStats(),
    };
  });

  expect(segmentAttempts).toBe(1);
  expect(probeAttempts).toBe(0);
  expect(state.status).toBe(503);
  expect(state.stats.networkHoldCount).toBe(0);
  expect(state.stats.networkResumeCount).toBe(0);
});

test('native networking holds transient hung server probes with bounded timeouts', async ({ page }) => {
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const state = await page.evaluate(async () => {
    const originalFetch = window.fetch;
    let abortCount = 0;
    window.fetch = function (_url, opts) {
      return new Promise((_resolve, reject) => {
        opts.signal.addEventListener('abort', () => {
          abortCount++;
          const err = new Error('probe-aborted');
          err.name = 'AbortError';
          reject(err);
        }, { once: true });
      });
    };
    try {
      const video = document.getElementById('player');
      const engine = new window.PlayerEngine(video, {
        videoId: 'PROBETIMEOUT',
        streamToken: 'test-token',
        serverProbeTimeoutMs: 100,
      });
      await engine.init();
      engine._enterServerDown('network-error');
      await new Promise(resolve => setTimeout(resolve, 160));
      const result = {
        abortCount,
        recovering: engine.isRecovering(),
        activeProbe: !!engine._serverProbeController,
        retryScheduled: !!engine._serverProbeTimer,
      };
      engine.destroy();
      return result;
    } finally {
      window.fetch = originalFetch;
    }
  });

  expect(state.abortCount).toBe(1);
  expect(state.recovering).toBe(true);
  expect(state.activeProbe).toBe(false);
  expect(state.retryScheduled).toBe(true);
});

test('native networking refreshes token without expiring transient server failures', async ({ page }) => {
  await page.route('**/watch/token**', route => {
    route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"restarting"}' });
  });
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const state = await page.evaluate(async () => {
    const video = document.getElementById('player');
    const engine = new window.PlayerEngine(video, { videoId: 'TOKENRETRY1', streamToken: 'old-token' });
    await engine.init();
    engine._startServerProbe = function () {};
    engine._serverDown = true;
    engine.networkTrouble = true;
    let authExpired = 0;
    engine.on('auth-expired', () => { authExpired++; });
    const held = engine._waitForServerRecovery().catch(() => {});
    await engine._refreshToken();
    const result = {
      authExpired,
      recovering: engine.isRecovering(),
      networkTrouble: engine.networkTrouble,
      heldRequests: engine._heldRequests.length,
      refreshingToken: engine._refreshingToken,
    };
    engine.destroy();
    await held;
    return result;
  });

  expect(state.authExpired).toBe(0);
  expect(state.recovering).toBe(true);
  expect(state.networkTrouble).toBe(true);
  expect(state.heldRequests).toBe(1);
  expect(state.refreshingToken).toBe(false);
});

test('native URL runtime error enters server recovery and reloads with a fresh token', async ({ page }) => {
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const state = await page.evaluate(async () => {
    const video = document.getElementById('player');
    let loadCount = 0;
    video.load = function () { loadCount++; };
    Object.defineProperty(video, 'error', { configurable: true, get: () => ({ code: 2 }) });
    const engine = new window.PlayerEngine(video, { videoId: 'URLRECOVERY', streamToken: 'old-token' });
    await engine.init();
    engine._startServerProbe = function () {};
    const native = window.NativeUrlProviderForTest;
    const provider = {
      engine,
      video,
      url: '/api/stream/URLRECOVERY/proxy/18?token=old-token',
      mode: 'progressive',
      retryCount: 0,
      recoveryCount: 0,
      lastError: '',
      assetUri: '',
      isLive: native.isLive,
      resumeAfterServerRecovery: native.resumeAfterServerRecovery,
    };
    engine._provider = provider;
    native._onRuntimeError.call(provider);
    const enteredRecovery = engine.isRecovering();
    engine.streamToken = 'fresh-token';
    engine._exitServerDown();
    return {
      enteredRecovery,
      recoveringAfterExit: engine.isRecovering(),
      loadCount,
      recoveryCount: provider.recoveryCount,
      lastError: provider.lastError,
      assetUri: provider.assetUri,
    };
  });

  expect(state.enteredRecovery).toBe(true);
  expect(state.recoveringAfterExit).toBe(false);
  expect(state.loadCount).toBe(1);
  expect(state.recoveryCount).toBe(1);
  expect(state.lastError).toBe('server-recovery');
  expect(state.assetUri).toContain('token=fresh-token');
  expect(state.assetUri).not.toContain('token=old-token');
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

test('native networking holds transient server restart during DASH playback and resumes media', async ({ page }) => {
  let serverDown = false;
  await page.route('**/api/stream/PLAYERTEST1/**', route => {
    if (!serverDown) return route.continue();
    return route.fulfill({
      status: 503,
      contentType: 'text/plain',
      body: 'server restarting',
    });
  });

  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player" muted playsinline></video>');

  await page.evaluate(async () => {
    const video = document.getElementById('player');
    video.muted = true;
    const engine = new window.PlayerEngine(video, {
      videoId: 'PLAYERTEST1',
      streamToken: '',
      serverProbeTimeoutMs: 500,
    });
    const events = [];
    engine.on('server-down', () => events.push('down'));
    engine.on('server-up', () => events.push('up'));
    window.__engine = engine;
    window.__player = engine.getPlayer();
    window.__recoveryEvents = events;
    window.__player.configure({
      streaming: { bufferingGoal: 1, startupBufferGoal: 0.5, maxConcurrentRequests: 1 },
    });
    await engine.init();
    await window.__player.load('/api/stream/PLAYERTEST1/dash.mpd?fixtureTemplate=timeline');
    await video.play();
  });

  await page.waitForFunction(() => document.getElementById('player').currentTime > 0.15);
  const before = await page.evaluate(() => document.getElementById('player').currentTime);
  serverDown = true;

  await expect.poll(
    () => page.evaluate(() => window.__engine.isRecovering()),
    { timeout: 10_000 }
  ).toBe(true);
  await expect.poll(
    () => page.evaluate(() => window.__recoveryEvents.includes('down'))
  ).toBe(true);

  serverDown = false;
  await expect.poll(
    () => page.evaluate(() => window.__recoveryEvents.includes('up')),
    { timeout: 12_000 }
  ).toBe(true);
  await page.waitForFunction(
    target => document.getElementById('player').currentTime > target + 1,
    before,
    { timeout: 12_000 }
  );

  const state = await page.evaluate(() => ({
    recovering: window.__engine.isRecovering(),
    events: window.__recoveryEvents,
    stats: window.__player.getStats(),
  }));
  expect(state.recovering).toBe(false);
  expect(state.events).toEqual(['down', 'up']);
  expect(state.stats.networkHoldCount).toBeGreaterThan(0);
  expect(state.stats.networkResumeCount).toBeGreaterThan(0);
  expect(state.stats.fallbackReason).toBe('');
});

test('native networking holds transient server restart during HLS playback and resumes media', async ({ page }) => {
  let serverDown = false;
  await page.route('**/api/stream/PLAYERTEST1/**', route => {
    if (!serverDown) return route.continue();
    return route.fulfill({ status: 503, contentType: 'text/plain', body: 'server restarting' });
  });

  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player" muted playsinline></video>');

  await page.evaluate(async () => {
    const video = document.getElementById('player');
    video.muted = true;
    video.canPlayType = () => '';
    const engine = new window.PlayerEngine(video, {
      videoId: 'PLAYERTEST1',
      streamToken: '',
      serverProbeTimeoutMs: 500,
    });
    const events = [];
    engine.on('server-down', () => events.push('down'));
    engine.on('server-up', () => events.push('up'));
    window.__engine = engine;
    window.__player = engine.getPlayer();
    window.__recoveryEvents = events;
    window.__player.configure({
      streaming: { bufferingGoal: 1, startupBufferGoal: 0.5, maxConcurrentRequests: 1 },
    });
    await engine.init();
    await window.__player.load('/api/stream/PLAYERTEST1/hls.m3u8?fixtureHls=1');
    await video.play();
  });

  await page.waitForFunction(() => document.getElementById('player').currentTime > 0.15);
  const before = await page.evaluate(() => document.getElementById('player').currentTime);
  serverDown = true;

  await expect.poll(
    () => page.evaluate(() => window.__engine.isRecovering()),
    { timeout: 10_000 }
  ).toBe(true);
  serverDown = false;
  await expect.poll(
    () => page.evaluate(() => window.__recoveryEvents.includes('up')),
    { timeout: 12_000 }
  ).toBe(true);
  await page.waitForFunction(
    target => document.getElementById('player').currentTime > target + 1,
    before,
    { timeout: 12_000 }
  );

  const state = await page.evaluate(() => ({
    recovering: window.__engine.isRecovering(),
    events: window.__recoveryEvents,
    stats: window.__player.getStats(),
  }));
  expect(state.recovering).toBe(false);
  expect(state.events).toEqual(['down', 'up']);
  expect(state.stats.provider).toBe('native-hls');
  expect(state.stats.networkHoldCount).toBeGreaterThan(0);
  expect(state.stats.networkResumeCount).toBeGreaterThan(0);
  expect(state.stats.fallbackReason).toBe('');
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

test('native DASH quota recovery replays period init before media after init quota pressure', async ({ page }) => {
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const state = await page.evaluate(async () => {
    const dash = window.NativeDashProviderForTest;
    const video = document.getElementById('player');
    Object.defineProperty(video, 'currentTime', { configurable: true, get() { return 10; } });
    const oldKey = 'video|v1|p0|video/mp4|avc1.42c01f|https://example.test/i/v1|';
    const newKey = 'video|v1|p1|video/mp4|avc1.4d401f|https://example.test/i2/v1|';
    function makeSourceBuffer(failFirstInit) {
      const sb = new EventTarget();
      sb.updating = false;
      sb.buffered = { length: 1, start() { return 0; }, end() { return 20; } };
      sb.appendAttempts = [];
      sb.removeCount = 0;
      sb.changedTypes = [];
      sb.appendBuffer = data => {
        sb.appendAttempts.push(data.byteLength);
        if (failFirstInit && data.byteLength === 2 && sb.appendAttempts.filter(size => size === 2).length === 1) {
          const error = new Error('init-quota');
          error.name = 'QuotaExceededError';
          throw error;
        }
        sb.updating = true;
        queueMicrotask(() => {
          sb.updating = false;
          sb.dispatchEvent(new Event('updateend'));
        });
      };
      sb.remove = () => {
        sb.removeCount++;
        sb.updating = true;
        queueMicrotask(() => {
          sb.updating = false;
          sb.dispatchEvent(new Event('updateend'));
        });
      };
      sb.changeType = type => { sb.changedTypes.push(type); };
      return sb;
    }
    const videoSb = makeSourceBuffer(true);
    const audioSb = makeSourceBuffer(false);
    const segment = {
      start: 10, end: 12, generationKey: newKey, mimeType: 'video/mp4', codecs: 'avc1.4d401f',
      initUrl: 'https://example.test/i2/v1', appendWindow: { start: 10, end: 14 },
    };
    const rep = {
      id: 'v1', kind: 'video', mimeType: 'video/mp4', codecs: 'avc1.42c01f',
      generationKey: oldKey, initData: new ArrayBuffer(1), segments: [segment], _appendedInitKey: oldKey,
    };
    const originalIsTypeSupported = window.MediaSource.isTypeSupported;
    Object.defineProperty(window.MediaSource, 'isTypeSupported', {
      configurable: true,
      value() { return true; },
    });
    const provider = {
      destroyed: false,
      engine: { _telemetry: { record() {} } },
      video,
      videoSb,
      audioSb,
      videoMime: 'video/mp4; codecs="avc1.42c01f"',
      activeVideo: rep,
      audio: null,
      requestGeneration: 0,
      quotaRecoveries: 0,
      lastError: '',
      blacklisted: {},
      _initDataForSegment() { return Promise.resolve(new ArrayBuffer(2)); },
      _changeVideoTypeIfNeeded: dash._changeVideoTypeIfNeeded,
      _prepareSegmentGeneration: dash._prepareSegmentGeneration,
      _recoverQuota: dash._recoverQuota,
      _lowerVideoRep() { return null; },
    };

    await dash._appendSegmentData.call(provider, rep, videoSb, segment, new ArrayBuffer(3));
    Object.defineProperty(window.MediaSource, 'isTypeSupported', {
      configurable: true,
      value: originalIsTypeSupported,
    });
    return {
      appendAttempts: videoSb.appendAttempts,
      changedTypes: videoSb.changedTypes,
      videoRemoveCount: videoSb.removeCount,
      audioRemoveCount: audioSb.removeCount,
      appendedInitKey: rep._appendedInitKey,
      quotaRecoveries: provider.quotaRecoveries,
      lastError: provider.lastError,
      configEpoch: provider.dashSourceBufferConfigEpoch,
      committedConfigEpoch: provider.dashSourceBufferCommittedConfigEpoch,
      configUncertain: !!provider.dashSourceBufferConfigUncertain,
    };
  });

  expect(state).toEqual({
    appendAttempts: [2, 2, 3],
    changedTypes: ['video/mp4; codecs="avc1.4d401f"'],
    videoRemoveCount: 1,
    audioRemoveCount: 1,
    appendedInitKey: 'video|v1|p1|video/mp4|avc1.4d401f|https://example.test/i2/v1|',
    quotaRecoveries: 1,
    lastError: 'quota-exceeded',
    configEpoch: 1,
    committedConfigEpoch: 1,
    configUncertain: false,
  });
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
    const activeVideo = {
      id: '720',
      kind: 'video',
      mimeType: 'video/mp4',
      codecs: 'avc1.42c01f',
      initData: new ArrayBuffer(2),
      segments: [
        { start: 9, end: 11, state: 'failed' },
        { start: 8, end: 9.5, appended: true, state: 'appended' },
        { start: 12, end: 14, appended: true, state: 'appended' },
      ],
    };
    const audio = {
      id: 'a64',
      kind: 'audio',
      mimeType: 'audio/mp4',
      codecs: 'mp4a.40.2',
      initData: new ArrayBuffer(1),
      segments: [
        { start: 9, end: 11, state: 'failed' },
        { start: 8, end: 9.5, appended: true, state: 'appended' },
        { start: 12, end: 14, appended: true, state: 'appended' },
      ],
    };
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
      removedVideoState: activeVideo.segments[1].state,
      removedAudioState: audio.segments[1].state,
      preservedVideoState: activeVideo.segments[2].state,
      preservedAudioState: audio.segments[2].state,
      ledgerReconciles: provider.dashSegmentLedgerReconcileCount,
      ledgerInvalidations: provider.dashSegmentLedgerInvalidationCount,
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
    removedVideoState: 'pending',
    removedAudioState: 'pending',
    preservedVideoState: 'appended',
    preservedAudioState: 'appended',
    ledgerReconciles: 2,
    ledgerInvalidations: 4,
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
      .call(provider, { kind: 'video', id: 'video', sb: videoSb }, {
        url: '/quota-segment.m4s',
        _hlsInitSegment: { url: '/quota-init.mp4' },
      }, new ArrayBuffer(1))
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

test('native request cancellation fences stale HLS append ownership from a replacement', async ({ page }) => {
  await page.goto('/auth/login');
  await page.setContent('<video id="player"></video>');
  await page.addScriptTag({ path: 'public/native-player-engine.js' });

  const state = await page.evaluate(async () => {
    const hls = window.NativeHlsProviderForTest;
    const sourceBuffer = { updating: false, buffered: { length: 0 } };
    const segment = {
      start: 0,
      end: 6,
      state: 'fetched',
      appended: false,
      _data: new ArrayBuffer(1),
    };
    const track = {
      id: 'video',
      kind: 'video',
      sb: sourceBuffer,
      segments: [segment],
    };
    const pending = [];
    const provider = {
      destroyed: false,
      hlsAppendEpoch: 0,
      playlistManifestCommitInProgress: false,
      video: { currentTime: 0 },
      sb: sourceBuffer,
      audioSb: null,
      segments: track.segments,
      _videoTrack: track,
      activeAudio: null,
      controllers: [],
      activeRanges: {},
      engine: {
        _player: { emit() {} },
        _telemetry: { record() {} },
      },
      appendFailures: 0,
      stallReports: 0,
      stallRecoveryStage: 0,
      schedulerDrainCount: 0,
      _appendSegmentData(_track, _segment, _data, transaction) {
        return new Promise((resolve, reject) => pending.push({ resolve, reject, transaction }));
      },
      _alignHlsBufferedTarget() {},
      _maybeEndVodStream() { return false; },
      _tick() {},
      _handleAppendFailure() {},
      _abortRequests: hls._abortRequests,
    };

    hls._drainAppendQueue.call(provider, track);
    const staleOwner = track._appendOwner;
    hls.invalidateHlsAppendTransactions(provider, 'seek');
    hls._abortRequests.call(provider);
    segment.state = 'fetched';
    segment._data = new ArrayBuffer(1);
    hls._drainAppendQueue.call(provider, track);
    const replacementOwner = track._appendOwner;
    const abort = new Error('request-aborted');
    abort.name = 'AbortError';
    pending[0].reject(abort);
    await new Promise(resolve => setTimeout(resolve, 0));
    const preservedAfterStaleCallback = track._appendOwner === replacementOwner
      && segment._appendOwner === replacementOwner
      && segment.state === 'appending';
    pending[1].resolve();
    await new Promise(resolve => setTimeout(resolve, 0));
    return {
      ownersDiffer: staleOwner !== replacementOwner,
      preservedAfterStaleCallback,
      finalState: segment.state,
      finalAppended: segment.appended,
      finalTrackOwner: track._appendOwner,
      finalSegmentOwner: segment._appendOwner || null,
      schedulerDrainCount: provider.schedulerDrainCount,
    };
  });

  expect(state).toEqual({
    ownersDiffer: true,
    preservedAfterStaleCallback: true,
    finalState: 'appended',
    finalAppended: true,
    finalTrackOwner: null,
    finalSegmentOwner: null,
    schedulerDrainCount: 1,
  });
});

test('native request cancellation fences stale DASH append ownership from a replacement', async ({ page }) => {
  await page.goto('/auth/login');
  await page.setContent('<video id="player"></video>');
  await page.addScriptTag({ path: 'public/native-player-engine.js' });

  const state = await page.evaluate(async () => {
    const dash = window.NativeDashProviderForTest;
    const sourceBuffer = { updating: false, buffered: { length: 0 } };
    const segment = {
      start: 0,
      end: 6,
      state: 'fetched',
      appended: false,
      _data: new ArrayBuffer(1),
    };
    const rep = {
      id: 'video-360',
      kind: 'video',
      segments: [segment],
    };
    const pending = [];
    const provider = {
      destroyed: false,
      requestGeneration: 0,
      video: { currentTime: 0 },
      videoSb: sourceBuffer,
      audioSb: null,
      activeVideo: rep,
      audio: null,
      controllers: [],
      activeRanges: {},
      requestCancellationCount: 0,
      videoSwitchInFlight: false,
      engine: {
        _player: { emit() {} },
        _telemetry: { record() {} },
      },
      appendFailures: 0,
      stallReports: 0,
      stallRecoveryStage: 0,
      schedulerDrainCount: 0,
      _appendSegmentData(_rep, _sourceBuffer, _segment, _data, transaction) {
        return new Promise((resolve, reject) => pending.push({ resolve, reject, transaction }));
      },
      _schedulerQueueDepth() { return 0; },
      _maybeEndVodStream() { return false; },
      _tick() {},
      _handleAppendFailure() {},
      _abortRequests: dash._abortRequests,
    };

    dash._drainAppendQueue.call(provider, rep, sourceBuffer);
    const staleOwner = rep._appendOwner;
    const cancelled = dash._abortRequests.call(provider);
    let staleGuardOutcome = '';
    try {
      dash.assertDashAppendTransactionCurrent(provider, staleOwner);
    } catch (error) {
      staleGuardOutcome = error.name;
    }
    segment.state = 'fetched';
    segment._data = new ArrayBuffer(1);
    dash._drainAppendQueue.call(provider, rep, sourceBuffer);
    const replacementOwner = rep._appendOwner;
    const abort = new Error('request-aborted');
    abort.name = 'AbortError';
    pending[0].reject(abort);
    await new Promise(resolve => setTimeout(resolve, 0));
    const preservedAfterStaleCallback = rep._appendOwner === replacementOwner
      && segment._appendOwner === replacementOwner
      && segment.state === 'appending';
    pending[1].resolve();
    await new Promise(resolve => setTimeout(resolve, 0));
    return {
      ownersDiffer: staleOwner !== replacementOwner,
      cancelled,
      staleGuardOutcome,
      staleAbortCount: provider.dashStaleAppendAbortCount || 0,
      preservedAfterStaleCallback,
      finalState: segment.state,
      finalAppended: segment.appended,
      finalRepOwner: rep._appendOwner,
      finalSegmentOwner: segment._appendOwner || null,
      schedulerDrainCount: provider.schedulerDrainCount,
    };
  });

  expect(state).toEqual({
    ownersDiffer: true,
    cancelled: 1,
    staleGuardOutcome: 'AbortError',
    staleAbortCount: 1,
    preservedAfterStaleCallback: true,
    finalState: 'appended',
    finalAppended: true,
    finalRepOwner: null,
    finalSegmentOwner: null,
    schedulerDrainCount: 1,
  });
});

test('native DASH quota recovery cannot mutate buffers after transaction invalidation', async ({ page }) => {
  await page.goto('/auth/login');
  await page.setContent('<video id="player"></video>');
  await page.addScriptTag({ path: 'public/native-player-engine.js' });

  const state = await page.evaluate(async () => {
    const dash = window.NativeDashProviderForTest;
    let releaseQueue;
    const priorQueue = new Promise(resolve => { releaseQueue = resolve; });
    let removeCalls = 0;
    let appendCalls = 0;
    const sourceBuffer = {
      updating: false,
      _nativeQueue: priorQueue,
      buffered: {
        length: 1,
        start() { return 0; },
        end() { return 20; },
      },
      addEventListener() {},
      removeEventListener() {},
      remove() { removeCalls += 1; },
      appendBuffer() { appendCalls += 1; },
    };
    const segment = { start: 8, end: 10, state: 'appending', appended: false };
    const rep = { id: 'video-360', kind: 'video', segments: [segment] };
    const provider = {
      destroyed: false,
      requestGeneration: 3,
      video: { currentTime: 10 },
      videoSb: sourceBuffer,
      audioSb: null,
      activeVideo: rep,
      audio: null,
      blacklisted: {},
      _lowerVideoRep() { return null; },
    };
    const transaction = dash.createDashAppendTransaction(provider, rep, segment, sourceBuffer, true);
    rep._appendOwner = transaction;
    segment._appendOwner = transaction;
    const recovery = dash._recoverQuota.call(
      provider,
      rep,
      sourceBuffer,
      new ArrayBuffer(1),
      transaction,
    ).then(
      () => 'resolved',
      error => error.name,
    );
    await new Promise(resolve => setTimeout(resolve, 0));
    provider.requestGeneration += 1;
    rep._appendOwner = null;
    delete segment._appendOwner;
    releaseQueue();
    const outcome = await recovery;
    await Promise.resolve(sourceBuffer._nativeQueue);
    return {
      outcome,
      removeCalls,
      appendCalls,
      staleAbortCount: provider.dashStaleAppendAbortCount || 0,
      queueDepth: sourceBuffer._nativeQueueDepth || 0,
    };
  });

  expect(state).toEqual({
    outcome: 'AbortError',
    removeCalls: 0,
    appendCalls: 0,
    staleAbortCount: 1,
    queueDepth: 0,
  });
});

test('native DASH period rebuild drains queued SourceBuffer mutations before replacement', async ({ page }) => {
  await page.goto('/auth/login');
  await page.setContent('<video id="player"></video>');
  await page.addScriptTag({ path: 'public/native-player-engine.js' });

  const state = await page.evaluate(async () => {
    const dash = window.NativeDashProviderForTest;
    let releaseQueue;
    const priorQueue = new Promise(resolve => { releaseQueue = resolve; });
    const oldSourceBuffer = {
      updating: false,
      _nativeQueue: priorQueue,
      abortCalls: 0,
      abort() { this.abortCalls += 1; },
    };
    const replacement = { updating: false, mode: '' };
    let removeCalls = 0;
    const provider = {
      destroyed: false,
      videoSb: oldSourceBuffer,
      videoMime: 'video/mp4; codecs="avc1.42c01f"',
      mediaSource: {
        readyState: 'open',
        removeSourceBuffer(sourceBuffer) {
          if (sourceBuffer !== oldSourceBuffer) throw new Error('wrong-sourcebuffer');
          removeCalls += 1;
        },
        addSourceBuffer() { return replacement; },
      },
      engine: { _telemetry: { record() {} } },
      periodTransitionCount: 0,
      sourceBufferRebuildAttemptCount: 0,
      sourceBufferRebuildSuccessCount: 0,
    };
    const rep = {
      id: 'video-360',
      kind: 'video',
      segments: [{ start: 0, end: 2, state: 'appended', appended: true }],
    };
    const segment = { start: 2, end: 4 };
    const rebuilding = dash._rebuildSourceBufferForPeriod.call(
      provider,
      rep,
      oldSourceBuffer,
      segment,
      'video/mp4; codecs="avc1.4d401f"',
      new Error('changeType-unavailable'),
    );
    await new Promise(resolve => setTimeout(resolve, 0));
    const removedBeforeDrain = removeCalls;
    releaseQueue();
    const result = await rebuilding;
    return {
      removedBeforeDrain,
      removeCalls,
      replaced: provider.videoSb === replacement && result === replacement,
      replacementMode: replacement.mode,
      abortCalls: oldSourceBuffer.abortCalls,
      queueDrainCount: provider.dashSourceBufferQueueDrainCount || 0,
      rebuildSuccessCount: provider.sourceBufferRebuildSuccessCount,
    };
  });

  expect(state).toEqual({
    removedBeforeDrain: 0,
    removeCalls: 1,
    replaced: true,
    replacementMode: 'segments',
    abortCalls: 1,
    queueDrainCount: 1,
    rebuildSuccessCount: 1,
  });
});

test('native HLS quota pressure releases a stuck SourceBuffer removal queue', async ({ page }) => {
  await page.goto('/auth/login');
  await page.setContent('<video id="player"></video>');
  await page.addScriptTag({ path: 'public/native-player-engine.js' });

  const state = await page.evaluate(async () => {
    const listeners = {};
    let removeCalls = 0;
    let abortCalls = 0;
    const sourceBuffer = {
      updating: false,
      buffered: {
        length: 1,
        start() { return 0; },
        end() { return 20; },
      },
      addEventListener(name, listener) {
        listeners[name] = listeners[name] || new Set();
        listeners[name].add(listener);
      },
      removeEventListener(name, listener) { listeners[name]?.delete(listener); },
      dispatch(name) { for (const listener of [...(listeners[name] || [])]) listener(); },
      remove() {
        removeCalls += 1;
        this.updating = true;
        if (removeCalls === 1) return;
        setTimeout(() => {
          this.updating = false;
          this.dispatch('updateend');
        }, 0);
      },
      abort() {
        abortCalls += 1;
        this.updating = false;
      },
    };
    const api = window.NativePlayerSourceBufferForTest;
    const startedAt = performance.now();
    const first = api.removeBefore(sourceBuffer, 5).then(
      () => 'resolved',
      error => error.message,
    );
    const second = api.removeAfter(sourceBuffer, 15).then(
      () => 'resolved',
      error => error.message,
    );
    const outcomes = await Promise.all([first, second]);
    return {
      outcomes,
      elapsed: performance.now() - startedAt,
      removeCalls,
      abortCalls,
      queueDepth: sourceBuffer._nativeQueueDepth || 0,
      timeoutCount: sourceBuffer._nativeMutationTimeoutCount || 0,
      mutationAbortCount: sourceBuffer._nativeMutationAbortCount || 0,
    };
  });

  expect(state.outcomes).toEqual(['sourcebuffer-remove-timeout', 'resolved']);
  expect(state.elapsed).toBeGreaterThanOrEqual(1100);
  expect(state.elapsed).toBeLessThan(3500);
  expect(state.removeCalls).toBe(2);
  expect(state.abortCalls).toBe(1);
  expect(state.queueDepth).toBe(0);
  expect(state.timeoutCount).toBe(1);
  expect(state.mutationAbortCount).toBe(1);
});

test('native HLS MPEG-TS muxed quota recovery resumes audio first and completes video atomically', async ({ page }) => {
  await page.goto('/auth/login');
  await page.setContent('<video id="player"></video>');
  await page.addScriptTag({ path: 'public/native-player-engine.js' });

  const state = await page.evaluate(async () => {
    const bytes = await fetch('/api/stream/PLAYERTEST1/hls-ts/v360.ts?fixtureTs=muxed').then(response => response.arrayBuffer());
    function makeSourceBuffer(quotaAtCalls) {
      const listeners = {};
      const quotaCalls = new Set(Array.isArray(quotaAtCalls) ? quotaAtCalls : [quotaAtCalls]);
      let appendCalls = 0;
      let removeCalls = 0;
      return {
        get appendCalls() { return appendCalls; },
        get removeCalls() { return removeCalls; },
        updating: false,
        timestampOffset: 0,
        buffered: {
          length: 1,
          start() { return 0; },
          end() { return 20; },
        },
        addEventListener(name, listener) { listeners[name] = listener; },
        removeEventListener(name) { delete listeners[name]; },
        appendBuffer() {
          appendCalls += 1;
          if (quotaCalls.has(appendCalls)) {
            const error = new Error('audio-quota');
            error.name = 'QuotaExceededError';
            throw error;
          }
          setTimeout(() => listeners.updateend?.(), 0);
        },
        remove() {
          removeCalls += 1;
          setTimeout(() => listeners.updateend?.(), 0);
        },
      };
    }

    const hls = window.NativeHlsProviderForTest;
    const ts = window.NativeTsTransmuxerForTest;
    const video = document.getElementById('player');
    Object.defineProperty(video, 'currentTime', { configurable: true, get() { return 10; } });
    async function runScenario(quotaTrack) {
      const videoSb = makeSourceBuffer(
        quotaTrack === 'video-downswitch' ? [2, 3, 4] : quotaTrack === 'video-forward' ? [2, 3] : quotaTrack === 'video' ? 2 : -1,
      );
      const audioSb = makeSourceBuffer(quotaTrack === 'audio' ? 2 : -1);
      const provider = {
        engine: { _telemetry: { record() {} } },
        video,
        sb: videoSb,
        audioSb,
        muxedTsAudio: true,
        activeVariant: {
          id: 'high',
          rawCodecs: 'avc1.42c01f,mp4a.40.2',
          audioCodecs: 'mp4a.40.2',
          width: 640,
          height: 360,
        },
        tsVideoTransmuxer: new ts.FirstPartyTsTransmuxerAdapter('video', 'avc1.42c01f'),
        tsAudioTransmuxer: new ts.FirstPartyTsTransmuxerAdapter('audio', 'mp4a.40.2'),
        hlsTsTimelineByGeneration: {},
        transmuxedSegmentCount: 0,
        transmuxedVideoSegmentCount: 0,
        transmuxedAudioSegmentCount: 0,
        quotaRecoveries: 0,
        lastError: '',
        blacklisted: {},
        variants: [],
        _ensureTsTransmuxer() { return Promise.resolve(); },
        _prepareDiscontinuityAppend() { return Promise.resolve(); },
        _transmuxTsSegment: hls._transmuxTsSegment,
        _appendTransmuxedOutput: hls._appendTransmuxedOutput,
        _recoverQuota: hls._recoverQuota,
        _alignTsStartupTime() {},
        _lowerVariant() { return quotaTrack === 'video-downswitch' ? { id: 'low' } : null; },
        _switchVariant(variant) {
          this.switched = true;
          this.switchedVariantId = variant.id;
        },
      };
      const track = { id: 'video', kind: 'video', sb: videoSb };
      const segment = {
        start: 0,
        end: 6,
        duration: 6,
        _hlsTimestampGenerationKey: `video:muxed-quota:${quotaTrack}`,
      };
      const outcome = await hls._appendSegmentData.call(provider, track, segment, bytes).then(
        () => 'resolved',
        error => error.name,
      );
      return {
        outcome,
        audioAppendCalls: audioSb.appendCalls,
        videoAppendCalls: videoSb.appendCalls,
        audioRemoveCalls: audioSb.removeCalls,
        videoRemoveCalls: videoSb.removeCalls,
        quotaRecoveries: provider.quotaRecoveries,
        muxedQuotaRetries: provider.hlsTsMuxedQuotaRetryCount,
        audioResumeCount: provider.hlsTsMuxedQuotaAudioResumeCount || 0,
        videoResumeCount: provider.hlsTsMuxedQuotaVideoResumeCount || 0,
        sharedDemuxCount: provider.hlsTsSharedDemuxCount,
        transmuxedSegmentCount: provider.transmuxedSegmentCount,
        initAppendCount: provider.hlsTsInitAppendCount,
        initSkipCount: provider.hlsTsInitSkipCount,
        forwardEvictionCount: provider.hlsQuotaForwardEvictionCount || 0,
        downswitchCount: provider.hlsQuotaDownswitchCount || 0,
        blacklistedVariantIds: Object.keys(provider.blacklisted),
        switched: !!provider.switched,
        switchedVariantId: provider.switchedVariantId || '',
      };
    }
    return {
      audioFailure: await runScenario('audio'),
      videoFailure: await runScenario('video'),
      forwardRecovery: await runScenario('video-forward'),
      downswitch: await runScenario('video-downswitch'),
    };
  });

  expect(state.audioFailure).toMatchObject({
    audioAppendCalls: 3,
    videoAppendCalls: 2,
    audioRemoveCalls: 1,
    videoRemoveCalls: 1,
    quotaRecoveries: 1,
    muxedQuotaRetries: 1,
    audioResumeCount: 1,
    videoResumeCount: 1,
    sharedDemuxCount: 1,
    transmuxedSegmentCount: 2,
    initAppendCount: 2,
    initSkipCount: 1,
    switched: false,
  });
  expect(state.videoFailure).toMatchObject({
    audioAppendCalls: 2,
    videoAppendCalls: 3,
    audioRemoveCalls: 1,
    videoRemoveCalls: 1,
    quotaRecoveries: 1,
    muxedQuotaRetries: 1,
    audioResumeCount: 0,
    videoResumeCount: 1,
    sharedDemuxCount: 1,
    transmuxedSegmentCount: 2,
    initAppendCount: 2,
    initSkipCount: 1,
    switched: false,
  });
  expect(state.forwardRecovery).toMatchObject({
    audioAppendCalls: 2,
    videoAppendCalls: 4,
    audioRemoveCalls: 2,
    videoRemoveCalls: 2,
    quotaRecoveries: 1,
    muxedQuotaRetries: 2,
    audioResumeCount: 0,
    videoResumeCount: 2,
    sharedDemuxCount: 1,
    transmuxedSegmentCount: 2,
    initAppendCount: 2,
    initSkipCount: 2,
    forwardEvictionCount: 1,
    switched: false,
  });
  expect(state.downswitch).toMatchObject({
    outcome: 'AbortError',
    audioAppendCalls: 2,
    videoAppendCalls: 4,
    audioRemoveCalls: 2,
    videoRemoveCalls: 2,
    quotaRecoveries: 1,
    muxedQuotaRetries: 2,
    audioResumeCount: 0,
    videoResumeCount: 2,
    forwardEvictionCount: 1,
    downswitchCount: 1,
    blacklistedVariantIds: [],
    switched: true,
    switchedVariantId: 'low',
  });
});

test('native HLS MPEG-TS invalidates an in-flight muxed quota retry before stale media can resume', async ({ page }) => {
  await page.goto('/auth/login');
  await page.setContent('<video id="player"></video>');
  await page.addScriptTag({ path: 'public/native-player-engine.js' });

  const state = await page.evaluate(async () => {
    const bytes = await fetch('/api/stream/PLAYERTEST1/hls-ts/v360.ts?fixtureTs=muxed').then(response => response.arrayBuffer());
    function makeSourceBuffer(quotaAtCall) {
      const listeners = {};
      let appendCalls = 0;
      let removeCalls = 0;
      let releaseRemove = null;
      return {
        get appendCalls() { return appendCalls; },
        get removeCalls() { return removeCalls; },
        updating: false,
        timestampOffset: 0,
        buffered: {
          length: 1,
          start() { return 0; },
          end() { return 20; },
        },
        addEventListener(name, listener) { listeners[name] = listener; },
        removeEventListener(name) { delete listeners[name]; },
        appendBuffer() {
          appendCalls += 1;
          if (appendCalls === quotaAtCall) {
            const error = new Error('quota');
            error.name = 'QuotaExceededError';
            throw error;
          }
          setTimeout(() => listeners.updateend?.(), 0);
        },
        remove() {
          removeCalls += 1;
          releaseRemove = () => listeners.updateend?.();
        },
        releaseRemove() { releaseRemove?.(); },
      };
    }

    const hls = window.NativeHlsProviderForTest;
    const ts = window.NativeTsTransmuxerForTest;
    const video = document.getElementById('player');
    Object.defineProperty(video, 'currentTime', { configurable: true, get() { return 10; } });
    const videoSb = makeSourceBuffer(2);
    const audioSb = makeSourceBuffer(-1);
    const provider = {
      engine: { _telemetry: { record() {} } },
      video,
      sb: videoSb,
      audioSb,
      muxedTsAudio: true,
      activeVariant: {
        rawCodecs: 'avc1.42c01f,mp4a.40.2',
        audioCodecs: 'mp4a.40.2',
      },
      tsVideoTransmuxer: new ts.FirstPartyTsTransmuxerAdapter('video', 'avc1.42c01f'),
      tsAudioTransmuxer: new ts.FirstPartyTsTransmuxerAdapter('audio', 'mp4a.40.2'),
      hlsTsTimelineByGeneration: {},
      transmuxedSegmentCount: 0,
      transmuxedVideoSegmentCount: 0,
      transmuxedAudioSegmentCount: 0,
      quotaRecoveries: 0,
      lastError: '',
      blacklisted: {},
      variants: [],
      _ensureTsTransmuxer() { return Promise.resolve(); },
      _prepareDiscontinuityAppend() { return Promise.resolve(); },
      _transmuxTsSegment: hls._transmuxTsSegment,
      _appendTransmuxedOutput: hls._appendTransmuxedOutput,
      _recoverQuota: hls._recoverQuota,
      _alignTsStartupTime() {},
      _lowerVariant() { return null; },
    };
    const track = { id: 'video', kind: 'video', sb: videoSb };
    const segment = {
      start: 0,
      end: 6,
      duration: 6,
      state: 'appending',
      _hlsTimestampGenerationKey: 'video:muxed-quota:stale',
    };
    const append = hls._appendSegmentData.call(provider, track, segment, bytes).then(
      () => 'resolved',
      error => error.name,
    );
    while (videoSb.removeCalls < 1 || audioSb.removeCalls < 1) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    hls.invalidateHlsAppendTransactions(provider, 'seek');
    segment.state = 'pending';
    videoSb.releaseRemove();
    audioSb.releaseRemove();
    const outcome = await append;
    const resumedOutcome = await hls._appendSegmentData.call(provider, track, segment, bytes).then(
      () => 'resolved',
      error => error.name,
    );
    return {
      outcome,
      resumedOutcome,
      segmentState: segment.state,
      videoAppendCalls: videoSb.appendCalls,
      audioAppendCalls: audioSb.appendCalls,
      muxedQuotaRetries: provider.hlsTsMuxedQuotaRetryCount || 0,
      staleAppendAborts: provider.hlsStaleAppendAbortCount || 0,
      appendEpoch: provider.hlsAppendEpoch || 0,
      invalidationReason: provider.lastHlsAppendInvalidationReason,
      partialCarryCount: provider.hlsMuxedPartialCarryCount || 0,
      ledgerResumeCount: provider.hlsMuxedLedgerResumeCount || 0,
      ledgerCompletionCount: provider.hlsMuxedLedgerCompletionCount || 0,
      ledgerSize: Object.keys(provider.hlsMuxedAppendLedger || {}).length,
    };
  });

  expect(state).toEqual({
    outcome: 'AbortError',
    resumedOutcome: 'resolved',
    segmentState: 'pending',
    videoAppendCalls: 3,
    audioAppendCalls: 2,
    muxedQuotaRetries: 0,
    staleAppendAborts: 1,
    appendEpoch: 1,
    invalidationReason: 'seek',
    partialCarryCount: 1,
    ledgerResumeCount: 1,
    ledgerCompletionCount: 1,
    ledgerSize: 0,
  });
});

test('native HLS MPEG-TS muxed append watchdog and VOD end state require audio and video coverage', async ({ page }) => {
  await page.goto('/auth/login');
  await page.setContent('<video id="player"></video>');
  await page.addScriptTag({ path: 'public/native-player-engine.js' });

  const state = await page.evaluate(async () => {
    const hls = window.NativeHlsProviderForTest;
    const segment = { start: 0, end: 6, duration: 6, appended: true, state: 'appended' };
    function sourceBuffer(end) {
      return {
        updating: false,
        buffered: {
          length: 1,
          start() { return 0; },
          end() { return end; },
        },
      };
    }
    function watchdogScenario(audioEnd) {
      const sb = sourceBuffer(6);
      const audioSb = sourceBuffer(audioEnd);
      const provider = {
        destroyed: false,
        hlsAppendEpoch: 0,
        muxedTsAudio: true,
        sb,
        audioSb,
        _appendSegmentData() { return new Promise(() => {}); },
      };
      const track = { id: 'video', kind: 'video', sb };
      const transaction = hls.createHlsAppendTransaction(provider, track, segment);
      return hls.hlsAppendSegmentWithWatchdog(provider, track, segment, new ArrayBuffer(1), transaction).then(
        () => ({ outcome: 'resolved', completions: provider.hlsMuxedWatchdogCompletionCount || 0 }),
        error => ({ outcome: error.message, completions: provider.hlsMuxedWatchdogCompletionCount || 0 }),
      );
    }
    const [missingAudio, complete] = await Promise.all([
      watchdogScenario(4),
      watchdogScenario(6),
    ]);

    let endCalls = 0;
    const eosProvider = {
      live: false,
      destroyed: false,
      duration: 6,
      segments: [segment],
      audioSegments: [],
      activeAudio: null,
      muxedTsAudio: true,
      sb: sourceBuffer(6),
      audioSb: sourceBuffer(4),
      mediaSource: {
        readyState: 'open',
        endOfStream() { endCalls += 1; },
      },
      vodEndOfStreamPending: false,
    };
    const endedWithoutAudio = hls._maybeEndVodStream.call(eosProvider);
    eosProvider.audioSb = sourceBuffer(6);
    const endedWithAudio = hls._maybeEndVodStream.call(eosProvider);
    return { missingAudio, complete, endedWithoutAudio, endedWithAudio, endCalls };
  });

  expect(state).toEqual({
    missingAudio: { outcome: 'hls-append-timeout', completions: 0 },
    complete: { outcome: 'resolved', completions: 1 },
    endedWithoutAudio: false,
    endedWithAudio: true,
    endCalls: 1,
  });
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

test('native HLS stall recovery starts before the first playing event', async ({ page }) => {
  const shakaRequests = await blockShakaScript(page);
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const state = await page.evaluate(async () => {
    const video = document.getElementById('player');
    const defaultEngine = new window.PlayerEngine(video, {
      videoId: 'TESTVIDEO01',
      streamToken: 'test-token',
    });
    const defaultDelay = defaultEngine._stallRecoveryDelayMs;
    defaultEngine.destroy();
    const engine = new window.PlayerEngine(video, {
      videoId: 'TESTVIDEO01',
      streamToken: 'test-token',
      stallRecoveryDelayMs: 100,
    });
    let providerReports = 0;
    engine._providerName = 'native-hls';
    engine._provider = {
      startupBufferComplete: false,
      reportStall() { providerReports++; },
    };
    await engine.init();
    video.dispatchEvent(new Event('waiting'));
    await new Promise(resolve => setTimeout(resolve, 160));
    const beforePlaying = {
      providerReports,
      watchdogReports: engine._stallWatchReportCount,
      waiting: engine._stallWatchWaiting,
    };
    video.dispatchEvent(new Event('playing'));
    await new Promise(resolve => setTimeout(resolve, 160));
    const afterPlaying = {
      providerReports,
      watchdogReports: engine._stallWatchReportCount,
      waiting: engine._stallWatchWaiting,
    };
    video.dispatchEvent(new Event('waiting'));
    await new Promise(resolve => setTimeout(resolve, 40));
    video.dispatchEvent(new Event('waiting'));
    await new Promise(resolve => setTimeout(resolve, 40));
    video.dispatchEvent(new Event('waiting'));
    await new Promise(resolve => setTimeout(resolve, 100));
    const afterRepeatedWaiting = {
      providerReports,
      watchdogReports: engine._stallWatchReportCount,
      waiting: engine._stallWatchWaiting,
    };
    engine.destroy();
    return { defaultDelay, beforePlaying, afterPlaying, afterRepeatedWaiting, timerCleared: engine._stallWatchTimer === 0 };
  });

  expect(state.defaultDelay).toBe(0);
  expect(state.beforePlaying.providerReports).toBe(1);
  expect(state.beforePlaying.watchdogReports).toBe(1);
  expect(state.beforePlaying.waiting).toBe(true);
  expect(state.afterPlaying.providerReports).toBe(1);
  expect(state.afterPlaying.watchdogReports).toBe(1);
  expect(state.afterPlaying.waiting).toBe(false);
  expect(state.afterRepeatedWaiting.providerReports).toBeGreaterThanOrEqual(2);
  expect(state.afterRepeatedWaiting.watchdogReports).toBeGreaterThanOrEqual(2);
  expect(state.afterRepeatedWaiting.waiting).toBe(true);
  expect(state.timerCleared).toBe(true);
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
      segments: [
        { start: 9, end: 11, state: 'failed' },
        { start: 8, end: 9.5, appended: true, state: 'appended' },
        { start: 12, end: 14, appended: true, state: 'appended' },
      ],
      activeAudio: {
        id: 'a64',
        segments: [
          { start: 9, end: 11, state: 'failed' },
          { start: 8, end: 9.5, appended: true, state: 'appended' },
          { start: 12, end: 14, appended: true, state: 'appended' },
        ],
      },
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
      removedVideoState: provider.segments[1].state,
      removedAudioState: provider.activeAudio.segments[1].state,
      preservedVideoState: provider.segments[2].state,
      preservedAudioState: provider.activeAudio.segments[2].state,
      ledgerReconciles: provider.hlsSegmentLedgerReconcileCount,
      ledgerInvalidations: provider.hlsSegmentLedgerInvalidationCount,
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
    removedVideoState: 'pending',
    removedAudioState: 'pending',
    preservedVideoState: 'appended',
    preservedAudioState: 'appended',
    ledgerReconciles: 2,
    ledgerInvalidations: 4,
    videoRemoveCalls: 1,
    audioRemoveCalls: 1,
    videoAppendCalls: 1,
    audioAppendCalls: 1,
    ticked: true,
  });
  expect(shakaRequests).toHaveLength(0);
});

test('native request cancellation invalidates stale DASH and HLS recovery transactions', async ({ page }) => {
  await page.goto('/auth/login');
  await page.setContent('<video id="player"></video>');
  await page.addScriptTag({ path: 'public/native-player-engine.js' });

  const state = await page.evaluate(async () => {
    function heldSourceBuffer() {
      const buffer = new EventTarget();
      buffer.updating = false;
      buffer.buffered = { length: 1, start() { return 0; }, end() { return 20; } };
      buffer.removeCount = 0;
      buffer.appendCount = 0;
      buffer.remove = () => {
        buffer.removeCount++;
        buffer.updating = true;
      };
      buffer.appendBuffer = () => {
        buffer.appendCount++;
        buffer.updating = true;
        queueMicrotask(() => {
          buffer.updating = false;
          buffer.dispatchEvent(new Event('updateend'));
        });
      };
      buffer.changeType = () => {};
      buffer.release = () => {
        buffer.updating = false;
        buffer.buffered = { length: 0, start() { return 0; }, end() { return 0; } };
        buffer.dispatchEvent(new Event('updateend'));
      };
      return buffer;
    }
    async function waitForRemoval(buffer) {
      for (let i = 0; i < 20 && !buffer.removeCount; i++) {
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }

    const video = document.getElementById('player');
    Object.defineProperty(video, 'currentTime', { configurable: true, get() { return 10; } });
    const dash = window.NativeDashProviderForTest;
    const dashBuffer = heldSourceBuffer();
    const dashVideo = {
      id: 'video', kind: 'video', mimeType: 'video/mp4', codecs: 'avc1.42c01f',
      initData: new ArrayBuffer(2), segments: [{ start: 9, end: 11, state: 'failed' }],
    };
    const dashProvider = {
      destroyed: false,
      engine: { _telemetry: { record() {} }, _player: { config: { abr: { enabled: true } } } },
      video,
      videoSb: dashBuffer,
      audioSb: null,
      videoMime: 'video/mp4; codecs="avc1.42c01f"',
      activeVideo: dashVideo,
      audio: null,
      videoReps: [dashVideo],
      audioReps: [],
      controllers: [],
      activeRanges: {},
      requestGeneration: 0,
      requestCancellationCount: 0,
      appendFailures: 1,
      stallReports: 1,
      recoveryCount: 0,
      nativeRecoveryAttemptCount: 0,
      nativeRecoverySuccessCount: 0,
      nativeRecoveryReasons: {},
      _abortRequests: dash._abortRequests,
      _bufferAheadGoal() { return 30; },
      _changeVideoTypeIfNeeded: dash._changeVideoTypeIfNeeded,
      _tick() { this.tickCount = (this.tickCount || 0) + 1; },
    };
    const dashRecovery = dash._tryNativeRecovery.call(dashProvider, 'native-video-append');
    await waitForRemoval(dashBuffer);
    dash._abortRequests.call(dashProvider, 'seek');
    dashBuffer.release();
    const dashRecovered = await dashRecovery;

    const hls = window.NativeHlsProviderForTest;
    const hlsBuffer = heldSourceBuffer();
    const hlsProvider = {
      destroyed: false,
      trackTransitionInFlight: null,
      engine: { _telemetry: { record() {} } },
      video,
      sb: hlsBuffer,
      audioSb: null,
      initSegment: { url: '/video-init.mp4', range: null },
      audioInitSegment: null,
      activeAudio: null,
      segments: [{ start: 9, end: 11, state: 'failed' }],
      controllers: [],
      activeRanges: {},
      hlsAppendEpoch: 0,
      hlsMuxedAppendLedger: {},
      appendFailures: 1,
      stallReports: 1,
      recoveryCount: 0,
      nativeRecoveryAttemptCount: 0,
      nativeRecoverySuccessCount: 0,
      nativeRecoveryReasons: {},
      _abortRequests() {},
      _bufferAheadGoal() { return 30; },
      _fetchRange() { this.fetchCount = (this.fetchCount || 0) + 1; return Promise.resolve(new ArrayBuffer(1)); },
      _tick() { this.tickCount = (this.tickCount || 0) + 1; },
    };
    const hlsRecovery = hls._tryNativeRecovery.call(hlsProvider, 'hls-video-append');
    await waitForRemoval(hlsBuffer);
    hls.invalidateHlsAppendTransactions(hlsProvider, 'seek');
    hlsBuffer.release();
    const hlsRecovered = await hlsRecovery;

    return {
      dash: {
        recovered: dashRecovered,
        appendCount: dashBuffer.appendCount,
        successCount: dashProvider.nativeRecoverySuccessCount,
        staleAborts: dashProvider.dashStaleControlTransitionAbortCount || 0,
        invalidations: dashProvider.dashControlTransitionInvalidationCount || 0,
        transitionInFlight: !!dashProvider.dashControlTransitionInFlight,
        retryAllowed: !dashProvider.nativeRecoveryReasons['native-video-append'],
        lastError: dashProvider.lastError,
      },
      hls: {
        recovered: hlsRecovered,
        fetchCount: hlsProvider.fetchCount || 0,
        appendCount: hlsBuffer.appendCount,
        successCount: hlsProvider.nativeRecoverySuccessCount,
        staleAborts: hlsProvider.hlsStaleRecoveryAbortCount || 0,
        recoveryInFlight: !!hlsProvider.nativeRecoveryInProgress,
        retryAllowed: !hlsProvider.nativeRecoveryReasons['hls-video-append'],
        lastError: hlsProvider.lastError,
      },
    };
  });

  expect(state.dash).toEqual({
    recovered: false,
    appendCount: 0,
    successCount: 0,
    staleAborts: 1,
    invalidations: 1,
    transitionInFlight: false,
    retryAllowed: true,
    lastError: 'native-video-append',
  });
  expect(state.hls).toEqual({
    recovered: false,
    fetchCount: 0,
    appendCount: 0,
    successCount: 0,
    staleAborts: 1,
    recoveryInFlight: false,
    retryAllowed: true,
    lastError: 'hls-video-append',
  });
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

test('native HLS jumps small gaps and declared large gaps only when manifests authorize them', async ({ page }) => {
  const shakaRequests = await blockShakaScript(page);
  await setPlayerContent(page, '<video id="player"></video>');

  const state = await page.evaluate(() => {
    const video = document.getElementById('player');
    let currentTime = 0.97;
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
          start(i) { return i === 0 ? 0 : 2; },
          end(i) { return i === 0 ? 1 : 5; },
        };
      },
    });
    const engine = new window.PlayerEngine(video, { videoId: 'TESTVIDEO01', streamToken: 'test-token' });
    engine._telemetry.record = function () {};
    const hls = {
      engine,
      video,
      destroyed: false,
      segments: [
        { start: 0, end: 1 },
        { start: 1, end: 2, gap: true },
        { start: 2, end: 5 },
      ],
      manifestGapJumpCount: 0,
      _jumpManifestGap: window.NativeHlsProviderForTest._jumpManifestGap,
    };
    const hlsJumped = hls._jumpManifestGap();
    const hlsTime = currentTime;

    currentTime = 0.97;
    const continuousRanges = {
      length: 1,
      start() { return 0; },
      end() { return 5; },
    };
    const audioGapRanges = {
      length: 2,
      start(i) { return i === 0 ? 0 : 2; },
      end(i) { return i === 0 ? 1 : 5; },
    };
    const audioGapHls = {
      engine,
      video,
      destroyed: false,
      segments: [{ start: 0, end: 5 }],
      sb: { buffered: continuousRanges },
      activeAudio: {},
      audioSegments: [
        { start: 0, end: 1 },
        { start: 1, end: 2, gap: true },
        { start: 2, end: 5 },
      ],
      audioSb: { buffered: audioGapRanges },
      manifestGapJumpCount: 0,
      _jumpManifestGap: window.NativeHlsProviderForTest._jumpManifestGap,
    };
    const audioGapJumped = audioGapHls._jumpManifestGap();
    const audioGapTime = currentTime;

    currentTime = 0.97;
    const dash = {
      engine,
      video,
      destroyed: false,
      activeVideo: { segments: [{ start: 0, end: 1 }, { start: 2, end: 5 }] },
      audio: { segments: [{ start: 0, end: 1 }, { start: 2, end: 5 }] },
      manifestGapJumpCount: 0,
      _jumpManifestGap: window.NativeDashProviderForTest._jumpManifestGap,
    };
    const dashJumped = dash._jumpManifestGap();
    return {
      hlsJumped,
      hlsTime,
      hlsCount: hls.manifestGapJumpCount,
      hlsSize: hls.lastManifestGapSize,
      audioGapJumped,
      audioGapTime,
      audioGapTrack: audioGapHls.lastManifestGapTrack,
      dashJumped,
      dashTime: currentTime,
      dashCount: dash.manifestGapJumpCount,
      dashSize: dash.lastManifestGapSize,
    };
  });

  expect(state).toEqual({
    hlsJumped: true,
    hlsTime: 2.01,
    hlsCount: 1,
    hlsSize: 1,
    audioGapJumped: true,
    audioGapTime: 2.01,
    audioGapTrack: 'audio',
    dashJumped: true,
    dashTime: 2.01,
    dashCount: 1,
    dashSize: 1,
  });
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
  expect(state.activeTrack.height).toBeGreaterThanOrEqual(240);
  await expectFirstPartyNativePlayback(page, { provider: 'native-dash', mode: 'dash' });
  expect(shakaRequests).toHaveLength(0);
  expect(logs.some(line => line.includes('falling back to shaka'))).toBe(false);
});

test('native ABR upgrades DASH and serializes the switch before scheduling new media', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player" muted playsinline style="width:1280px;height:720px"></video>');

  await page.evaluate(() => {
    const video = document.getElementById('player');
    video.muted = true;
    const engine = new window.PlayerEngine(video, { videoId: 'PLAYERTEST1', streamToken: '' });
    window.__engine = engine;
    window.__player = engine.getPlayer();
    window.__player.configure({
      streaming: {
        bufferingGoal: 4,
        startupBufferGoal: 1,
        maxConcurrentRequests: 3,
      },
    });
    return engine.init()
      .then(() => engine.load('/api/stream/PLAYERTEST1/dash.mpd'))
      .then(() => video.play());
  });

  await page.waitForFunction(() => {
    const video = document.getElementById('player');
    const track = window.__player.getActiveVariantTrack();
    return video.currentTime > 0
      && video.videoHeight >= 720
      && track
      && track.height >= 720;
  }, null, { timeout: 12_000 });

  const state = await page.evaluate(() => {
    const video = document.getElementById('player');
    return {
      mediaError: video.error && (video.error.message || video.error.code),
      height: video.videoHeight,
      stats: window.__player.getStats(),
    };
  });
  expect(state.mediaError).toBeFalsy();
  expect(state.height).toBeGreaterThanOrEqual(720);
  expect(state.stats.activeVariant.height).toBeGreaterThanOrEqual(720);
  expect(state.stats.lastSwitchReason).toBe('bandwidth');
  expect(state.stats.fatalError).toBe('');
  expect(pageErrors).toEqual([]);
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
    let resolveTick;
    const switched = new Promise(resolve => { resolveTick = resolve; });
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
      _tick() {
        this.ticked = true;
        resolveTick();
      },
      getActiveAudioTrack: window.NativeDashProviderForTest.getActiveAudioTrack,
      getAudioTracks: window.NativeDashProviderForTest.getAudioTracks,
      _switchAudio: window.NativeDashProviderForTest._switchAudio,
      selectAudioTrack: window.NativeDashProviderForTest.selectAudioTrack,
    };
    engine._provider = provider;
    const before = provider.getAudioTracks();
    provider.selectAudioTrack({ id: 'a-es' });
    return switched.then(() => ({
      before,
      active: provider.getActiveAudioTrack(),
      videoRemoveCalls: videoSb.removeCalls,
      audioRemoveCalls: audioSb.removeCalls,
      audioAppendCalls: audioSb.appendCalls,
      generation: provider.requestGeneration,
      ticked: !!provider.ticked,
    }));
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

test('native request cancellation preserves the latest queued DASH audio transition', async ({ page }) => {
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const state = await page.evaluate(async () => {
    const dash = window.NativeDashProviderForTest;
    const video = document.getElementById('player');
    Object.defineProperty(video, 'currentTime', { configurable: true, get() { return 6; } });
    function audioRep(id, language, size) {
      return {
        id, language, label: language, kind: 'audio', mimeType: 'audio/mp4', codecs: 'mp4a.40.2',
        initData: new ArrayBuffer(size), segments: [{ start: 0, end: 2, state: 'pending' }],
      };
    }
    const initial = audioRep('audio-en', 'en', 1);
    const first = audioRep('audio-es', 'es', 2);
    const latest = audioRep('audio-fr', 'fr', 3);
    let releaseFirst;
    const heldFirst = new Promise(resolve => { releaseFirst = resolve; });
    const sourceBuffer = new EventTarget();
    sourceBuffer.updating = false;
    sourceBuffer.buffered = { length: 0, start() { return 0; }, end() { return 0; } };
    sourceBuffer.appended = [];
    sourceBuffer.appendBuffer = data => {
      sourceBuffer.appended.push(data.byteLength);
      sourceBuffer.updating = true;
      queueMicrotask(() => {
        sourceBuffer.updating = false;
        sourceBuffer.dispatchEvent(new Event('updateend'));
      });
    };
    sourceBuffer.changeType = () => {};
    const emitted = [];
    const provider = {
      destroyed: false,
      engine: {
        _player: {
          config: { abr: { enabled: true } },
          emit(name) { emitted.push(name); },
        },
        _telemetry: { record() {} },
      },
      video,
      videoSb: null,
      audioSb: sourceBuffer,
      audioMime: 'audio/mp4; codecs="mp4a.40.2"',
      activeVideo: null,
      audio: initial,
      audioReps: [initial, first, latest],
      controllers: [],
      activeRanges: {},
      requestGeneration: 0,
      requestCancellationCount: 0,
      pendingAudioSwitch: null,
      _abortRequests: dash._abortRequests,
      _prepareRep(rep) { return rep === first ? heldFirst : Promise.resolve(rep); },
      _changeAudioTypeIfNeeded: dash._changeAudioTypeIfNeeded,
      _switchAudio: dash._switchAudio,
      _tick() { this.tickCount = (this.tickCount || 0) + 1; },
      getActiveAudioTrack: dash.getActiveAudioTrack,
    };

    const firstSwitch = provider._switchAudio(first);
    dash.selectAudioTrack.call(provider, { id: latest.id });
    dash._abortRequests.call(provider, 'seek');
    releaseFirst(first);
    const firstCommitted = await firstSwitch;
    const pendingAfterCancel = provider.pendingAudioSwitch && provider.pendingAudioSwitch.repId;
    dash._flushPendingDashControlTransition.call(provider);
    for (let i = 0; i < 20 && provider.dashControlTransitionInFlight; i++) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    return {
      firstCommitted,
      pendingAfterCancel,
      activeId: provider.audio.id,
      appended: sourceBuffer.appended,
      emitted,
      transitionInFlight: !!provider.dashControlTransitionInFlight,
      invalidations: provider.dashControlTransitionInvalidationCount || 0,
      commits: provider.dashControlTransitionCommitCount || 0,
      staleAborts: provider.dashStaleControlTransitionAbortCount || 0,
    };
  });

  expect(state).toEqual({
    firstCommitted: false,
    pendingAfterCancel: 'audio-fr',
    activeId: 'audio-fr',
    appended: [3],
    emitted: ['audiotrackchanged'],
    transitionInFlight: false,
    invalidations: 1,
    commits: 1,
    staleAborts: 1,
  });
});

test('native DASH exposes audio tracks and rolls back a failed switch before metadata commit', async ({ page }) => {
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const state = await page.evaluate(async () => {
    const dash = window.NativeDashProviderForTest;
    const video = document.getElementById('player');
    Object.defineProperty(video, 'currentTime', { configurable: true, get() { return 4; } });
    const previous = {
      id: 'audio-old', language: 'en', kind: 'audio', mimeType: 'audio/mp4', codecs: 'mp4a.40.2',
      initData: new ArrayBuffer(1), segments: [{ start: 0, end: 2, state: 'appended' }],
    };
    const target = {
      id: 'audio-new', language: 'es', kind: 'audio', mimeType: 'audio/mp4', codecs: 'mp4a.40.5',
      initData: new ArrayBuffer(2), segments: [{ start: 0, end: 2, state: 'pending' }],
    };
    const sourceBuffer = new EventTarget();
    sourceBuffer.updating = false;
    sourceBuffer.buffered = { length: 1, start() { return 0; }, end() { return 12; } };
    sourceBuffer.appendAttempts = [];
    sourceBuffer.changedTypes = [];
    sourceBuffer.remove = () => {
      sourceBuffer.updating = true;
      queueMicrotask(() => {
        sourceBuffer.buffered = { length: 0, start() { return 0; }, end() { return 0; } };
        sourceBuffer.updating = false;
        sourceBuffer.dispatchEvent(new Event('updateend'));
      });
    };
    sourceBuffer.appendBuffer = data => {
      sourceBuffer.appendAttempts.push(data.byteLength);
      if (data.byteLength === 2) throw new Error('target-init-failed');
      sourceBuffer.updating = true;
      queueMicrotask(() => {
        sourceBuffer.updating = false;
        sourceBuffer.dispatchEvent(new Event('updateend'));
      });
    };
    sourceBuffer.changeType = type => { sourceBuffer.changedTypes.push(type); };
    const emitted = [];
    const provider = {
      destroyed: false,
      engine: {
        _player: {
          config: { abr: { enabled: true } },
          emit(name) { emitted.push(name); },
        },
        _telemetry: { record() {} },
      },
      video,
      videoSb: null,
      audioSb: sourceBuffer,
      audioMime: 'audio/mp4; codecs="mp4a.40.2"',
      activeVideo: null,
      audio: previous,
      audioReps: [previous, target],
      controllers: [],
      activeRanges: {},
      requestGeneration: 0,
      requestCancellationCount: 0,
      _abortRequests: dash._abortRequests,
      _prepareRep(rep) { return Promise.resolve(rep); },
      _changeAudioTypeIfNeeded: dash._changeAudioTypeIfNeeded,
      _tick() { this.tickCount = (this.tickCount || 0) + 1; },
      getActiveAudioTrack: dash.getActiveAudioTrack,
    };

    const committed = await dash._switchAudio.call(provider, target);
    return {
      committed,
      activeId: provider.audio.id,
      activeMime: provider.audioMime,
      appendAttempts: sourceBuffer.appendAttempts,
      changedTypes: sourceBuffer.changedTypes,
      emitted,
      lastError: provider.lastError,
      rollbackCount: provider.dashControlTransitionRollbackCount || 0,
      rollbackFailures: provider.dashControlTransitionRollbackFailureCount || 0,
      transitionInFlight: !!provider.dashControlTransitionInFlight,
    };
  });

  expect(state).toEqual({
    committed: false,
    activeId: 'audio-old',
    activeMime: 'audio/mp4; codecs="mp4a.40.2"',
    appendAttempts: [2, 1],
    changedTypes: [
      'audio/mp4; codecs="mp4a.40.5"',
      'audio/mp4; codecs="mp4a.40.2"',
    ],
    emitted: [],
    lastError: 'target-init-failed',
    rollbackCount: 1,
    rollbackFailures: 0,
    transitionInFlight: false,
  });
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
    const audioSb = makeSourceBuffer('audio');
    const peerOwner = {};
    const audio = { id: 'a1', kind: 'audio', _appendOwner: peerOwner, _appending: true };
    const created = [];
    const removed = [];
    let removedWhilePeerActive = false;
    const mediaSource = {
      readyState: 'open',
      removeSourceBuffer(sb) {
        removedWhilePeerActive = !!audio._appendOwner;
        removed.push(sb.label);
      },
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
    const alternateRep = {
      id: 'v2',
      kind: 'video',
      mimeType: 'video/mp4',
      codecs: 'avc1.42c01f',
      segments: [{ start: 0, end: 2, appended: true, state: 'appended' }],
      _appendedInitKey: 'stale-shared-buffer-init',
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
      audioSb,
      audio,
      videoMime: 'video/mp4; codecs="avc1.42c01f"',
      videoReps: [rep, alternateRep],
      _fetchRange(url) {
        return Promise.resolve(url.endsWith('/i2/v1') ? new ArrayBuffer(2) : new ArrayBuffer(0));
      },
      _changeVideoTypeIfNeeded: window.NativeDashProviderForTest._changeVideoTypeIfNeeded,
      _rebuildSourceBufferForPeriod: window.NativeDashProviderForTest._rebuildSourceBufferForPeriod,
      _prepareSegmentGeneration: window.NativeDashProviderForTest._prepareSegmentGeneration,
      _initDataForSegment: window.NativeDashProviderForTest._initDataForSegment,
      _appendSegmentData: window.NativeDashProviderForTest._appendSegmentData,
    };
    setTimeout(() => {
      audio._appendOwner = null;
      audio._appending = false;
    }, 20);
    await provider._appendSegmentData(rep, oldSb, seg, new ArrayBuffer(3));
    if (originalIsTypeSupported) {
      Object.defineProperty(window.MediaSource, 'isTypeSupported', {
        configurable: true,
        value: originalIsTypeSupported,
      });
    }
    return {
      removed,
      removedWhilePeerActive,
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
      alternateSegmentState: alternateRep.segments[0].state,
      alternateInitKey: alternateRep._appendedInitKey,
      ledgerReconciles: provider.dashSegmentLedgerReconcileCount,
      ledgerInvalidations: provider.dashSegmentLedgerInvalidationCount,
    };
  });

  expect(state.removed).toEqual(['old']);
  expect(state.removedWhilePeerActive).toBe(false);
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
  expect(state.alternateSegmentState).toBe('pending');
  expect(state.alternateInitKey).toBe('');
  expect(state.ledgerReconciles).toBe(1);
  expect(state.ledgerInvalidations).toBe(2);
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
  // Live startup deliberately uses the conservative cold-start ABR prior.
  // Promotion is covered by the dedicated ABR tests; this fixture verifies
  // that the selected native representation is playable at the live edge.
  expect(stats.activeVariant.height).toBeGreaterThan(0);
  expect(stats.fatalError).toBe('');
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

test('native DASH live refresh keeps single-flight windows monotonic', async ({ page }) => {
  const shakaRequests = await blockShakaScript(page);
  const manifest = (start, publishSecond) => `<?xml version="1.0"?><MPD type="dynamic" availabilityStartTime="2026-05-04T00:00:00Z" publishTime="2026-05-04T00:00:${String(publishSecond).padStart(2, '0')}Z" minimumUpdatePeriod="PT1S" timeShiftBufferDepth="PT4S"><Period start="PT0S">
<AdaptationSet mimeType="video/mp4"><SegmentTemplate timescale="1000" initialization="/i/$RepresentationID$" media="/v/$Time$"><SegmentTimeline><S t="${start * 1000}" d="2000" r="1"/></SegmentTimeline></SegmentTemplate><Representation id="v1" bandwidth="800000" width="640" height="360" codecs="avc1.42c01f"/></AdaptationSet>
<AdaptationSet mimeType="audio/mp4"><SegmentTemplate timescale="1000" initialization="/ai/$RepresentationID$" media="/a/$Time$"><SegmentTimeline><S t="${start * 1000}" d="2000" r="1"/></SegmentTimeline></SegmentTemplate><Representation id="a1" bandwidth="64000" codecs="mp4a.40.2"/></AdaptationSet>
</Period></MPD>`;
  const initialManifest = manifest(0, 2);
  const newerManifest = manifest(4, 6);
  const staleManifest = manifest(2, 4);
  let manifestRequests = 0;
  await page.route('**/monotonic-live.mpd', async route => {
    manifestRequests++;
    if (manifestRequests === 1) await new Promise(resolve => setTimeout(resolve, 150));
    await route.fulfill({
      status: 200,
      contentType: 'application/dash+xml',
      body: manifestRequests === 1 ? newerManifest : staleManifest,
    });
  });
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const state = await page.evaluate(initialText => {
    const initial = window.NativeDashProviderForTest.parseMPD(initialText, location.origin + '/monotonic-live.mpd');
    const videoRep = initial.video[0];
    const audioRep = initial.audio[0];
    videoRep.segments = videoRep.templateSegments.slice();
    audioRep.segments = audioRep.templateSegments.slice();
    const provider = {
      manifestUrl: '/monotonic-live.mpd',
      manifestText: initialText,
      live: true,
      duration: 0,
      destroyed: false,
      presentationEnded: false,
      lastManifestPublishTime: initial.publishTime,
      manifestRefreshPromise: null,
      videoReps: [videoRep],
      audioReps: [audioRep],
      activeVideo: videoRep,
      audio: audioRep,
      liveWindow: initial.liveWindow,
      minimumUpdatePeriod: 1,
      manifestRefreshCount: 0,
      manifestRefreshFailed: false,
      staleManifestResponseCount: 0,
      recoveryCount: 0,
      lastError: '',
      engine: {
        streamToken: '',
        setLive() {},
        _telemetry: { record() {} },
      },
      _tick() {},
      _updateLiveWindowFromReps: window.NativeDashProviderForTest._updateLiveWindowFromReps,
      _evictExpiredLiveSegmentState: window.NativeDashProviderForTest._evictExpiredLiveSegmentState,
    };
    const refresh = window.NativeDashProviderForTest._refreshPlaybackManifest;
    return Promise.all([
      refresh.call(provider, 'concurrent-video'),
      refresh.call(provider, 'concurrent-audio'),
    ]).then(() => refresh.call(provider, 'stale-sequential')).then(() => ({
      liveWindow: provider.liveWindow,
      segmentStart: provider.videoReps[0].segments[0].start,
      segmentEnd: provider.videoReps[0].segments.at(-1).end,
      refreshCount: provider.manifestRefreshCount,
      staleCount: provider.staleManifestResponseCount,
      publishTime: provider.lastManifestPublishTime,
      refreshInFlight: !!provider.manifestRefreshPromise,
    }));
  }, initialManifest);

  expect(manifestRequests).toBe(2);
  expect(state.liveWindow).toEqual({ start: 4, end: 8 });
  expect(state.segmentStart).toBe(4);
  expect(state.segmentEnd).toBe(8);
  expect(state.refreshCount).toBe(1);
  expect(state.staleCount).toBe(1);
  expect(state.publishTime).toBe(Date.parse('2026-05-04T00:00:06Z'));
  expect(state.refreshInFlight).toBe(false);
  expect(shakaRequests).toHaveLength(0);
});

test('native DASH media recovery waits for a causally newer manifest refresh', async ({ page }) => {
  const manifest = (start, publishSecond) => `<?xml version="1.0"?><MPD type="dynamic" availabilityStartTime="2026-05-04T00:00:00Z" publishTime="2026-05-04T00:00:${String(publishSecond).padStart(2, '0')}Z" minimumUpdatePeriod="PT1S" timeShiftBufferDepth="PT4S"><Period start="PT0S">
<AdaptationSet mimeType="video/mp4"><SegmentTemplate timescale="1000" initialization="/i/$RepresentationID$" media="/v/$Time$"><SegmentTimeline><S t="${start * 1000}" d="2000" r="1"/></SegmentTimeline></SegmentTemplate><Representation id="v1" bandwidth="800000" width="640" height="360" codecs="avc1.42c01f"/></AdaptationSet>
<AdaptationSet mimeType="audio/mp4"><SegmentTemplate timescale="1000" initialization="/ai/$RepresentationID$" media="/a/$Time$"><SegmentTimeline><S t="${start * 1000}" d="2000" r="1"/></SegmentTimeline></SegmentTemplate><Representation id="a1" bandwidth="64000" codecs="mp4a.40.2"/></AdaptationSet>
</Period></MPD>`;
  const initialManifest = manifest(0, 2);
  const responses = [manifest(2, 4), manifest(4, 6)];
  let manifestRequests = 0;
  await page.route('**/causal-live.mpd', async route => {
    const requestNumber = ++manifestRequests;
    if (requestNumber === 1) await new Promise(resolve => setTimeout(resolve, 150));
    await route.fulfill({
      status: 200,
      contentType: 'application/dash+xml',
      body: responses[Math.min(requestNumber - 1, responses.length - 1)],
    });
  });
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const state = await page.evaluate(async initialText => {
    const initial = window.NativeDashProviderForTest.parseMPD(initialText, location.origin + '/causal-live.mpd');
    const videoRep = initial.video[0];
    const audioRep = initial.audio[0];
    videoRep.segments = videoRep.templateSegments.slice();
    audioRep.segments = audioRep.templateSegments.slice();
    const provider = {
      manifestUrl: '/causal-live.mpd',
      manifestText: initialText,
      live: true,
      duration: 0,
      destroyed: false,
      presentationEnded: false,
      lastManifestPublishTime: initial.publishTime,
      manifestRefreshPromise: null,
      manifestRefreshReasonInFlight: '',
      videoReps: [videoRep],
      audioReps: [audioRep],
      activeVideo: videoRep,
      audio: audioRep,
      liveWindow: initial.liveWindow,
      minimumUpdatePeriod: 1,
      manifestRefreshCount: 0,
      manifestRefreshFailed: false,
      staleManifestResponseCount: 0,
      recoveryCount: 0,
      lastError: '',
      engine: {
        streamToken: '',
        setLive() {},
        _telemetry: { record() {} },
      },
      _tick() {},
      _updateLiveWindowFromReps: window.NativeDashProviderForTest._updateLiveWindowFromReps,
      _evictExpiredLiveSegmentState: window.NativeDashProviderForTest._evictExpiredLiveSegmentState,
    };
    const refresh = window.NativeDashProviderForTest._refreshPlaybackManifest;
    const scheduled = refresh.call(provider, 'live');
    await new Promise(resolve => setTimeout(resolve, 20));
    const recovery = refresh.call(provider, 'media-error');
    const outcomes = await Promise.all([scheduled, recovery]);
    let staleRecoveryCalls = 0;
    const staleRecoveryProvider = {
      mediaUrlRefreshCount: 0,
      recoveryCount: 0,
      lastRecoveryReason: '',
      manifestRefreshReason: '',
      lastError: '',
      lastHttpStatus: 0,
      engine: { _telemetry: { record() {} } },
      _refreshPlaybackManifest() {
        staleRecoveryCalls++;
        return Promise.resolve(staleRecoveryCalls === 1
          ? { applied: false, stale: true }
          : { applied: true, stale: false });
      },
    };
    await window.NativeDashProviderForTest._recoverMediaRequest.call(
      staleRecoveryProvider,
      { id: 'v1' },
      { message: 'range-http-416', status: 416 },
    );
    return {
      outcomes,
      liveWindow: provider.liveWindow,
      refreshCount: provider.manifestRefreshCount,
      refreshReason: provider.manifestRefreshReason,
      inFlightReason: provider.manifestRefreshReasonInFlight,
      refreshInFlight: !!provider.manifestRefreshPromise,
      staleRecoveryCalls,
    };
  }, initialManifest);

  expect(manifestRequests).toBe(2);
  expect(state.outcomes[0]).toMatchObject({ applied: true, stale: false, reason: 'live' });
  expect(state.outcomes[1]).toMatchObject({ applied: true, stale: false, reason: 'media-error' });
  expect(state.liveWindow).toEqual({ start: 4, end: 8 });
  expect(state.refreshCount).toBe(2);
  expect(state.refreshReason).toBe('media-error');
  expect(state.inFlightReason).toBe('');
  expect(state.refreshInFlight).toBe(false);
  expect(state.staleRecoveryCalls).toBe(2);
});

test('native DASH refresh transitions a completed dynamic presentation to static VOD', async ({ page }) => {
  const shakaRequests = await blockShakaScript(page);
  const staticManifest = `<?xml version="1.0"?><MPD type="static" mediaPresentationDuration="PT6S"><Period start="PT0S" duration="PT6S">
<AdaptationSet mimeType="video/mp4"><SegmentTemplate timescale="1000" initialization="/i/$RepresentationID$" media="/v/$Time$"><SegmentTimeline><S t="0" d="2000" r="2"/></SegmentTimeline></SegmentTemplate>
<Representation id="v1" bandwidth="800000" width="640" height="360" codecs="avc1.42c01f"/></AdaptationSet>
<AdaptationSet mimeType="audio/mp4"><SegmentTemplate timescale="1000" initialization="/i/$RepresentationID$" media="/a/$Time$"><SegmentTimeline><S t="0" d="2000" r="2"/></SegmentTimeline></SegmentTemplate>
<Representation id="a1" bandwidth="64000" codecs="mp4a.40.2"/></AdaptationSet>
</Period></MPD>`;
  const staleDynamicManifest = staticManifest
    .replace('type="static" mediaPresentationDuration="PT6S"', 'type="dynamic" availabilityStartTime="2026-05-04T00:00:00Z" minimumUpdatePeriod="PT1S" timeShiftBufferDepth="PT6S"')
    .replace(' duration="PT6S"', '');

  let manifestRequests = 0;
  await page.route('**/event-complete.mpd**', route => {
    manifestRequests++;
    route.fulfill({
      status: 200,
      contentType: 'application/dash+xml',
      body: manifestRequests === 1 ? staticManifest : staleDynamicManifest,
    });
  });
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const state = await page.evaluate(() => {
    const initial = window.NativeDashProviderForTest.parseMPD(`<?xml version="1.0"?><MPD type="dynamic" availabilityStartTime="2026-05-04T00:00:00Z" minimumUpdatePeriod="PT1S" timeShiftBufferDepth="PT4S"><Period start="PT0S">
<AdaptationSet mimeType="video/mp4"><SegmentTemplate timescale="1000" initialization="/i/$RepresentationID$" media="/v/$Time$"><SegmentTimeline><S t="0" d="2000" r="1"/></SegmentTimeline></SegmentTemplate><Representation id="v1" bandwidth="800000" width="640" height="360" codecs="avc1.42c01f"/></AdaptationSet>
<AdaptationSet mimeType="audio/mp4"><SegmentTemplate timescale="1000" initialization="/i/$RepresentationID$" media="/a/$Time$"><SegmentTimeline><S t="0" d="2000" r="1"/></SegmentTimeline></SegmentTemplate><Representation id="a1" bandwidth="64000" codecs="mp4a.40.2"/></AdaptationSet>
</Period></MPD>`, location.origin + '/event-complete.mpd');
    const videoRep = initial.video[0];
    const audioRep = initial.audio[0];
    videoRep.segments = videoRep.templateSegments.slice();
    audioRep.segments = audioRep.templateSegments.slice();
    const engineLiveStates = [];
    const provider = {
      manifestUrl: '/event-complete.mpd',
      manifestText: '',
      live: true,
      duration: 0,
      destroyed: false,
      videoReps: [videoRep],
      audioReps: [audioRep],
      activeVideo: videoRep,
      audio: audioRep,
      liveWindow: initial.liveWindow,
      minimumUpdatePeriod: 1,
      manifestRefreshCount: 0,
      manifestRefreshFailed: false,
      recoveryCount: 0,
      liveToVodTransitionCount: 0,
      staleManifestResponseCount: 0,
      lastError: '',
      engine: {
        streamToken: '',
        setLive(value) { engineLiveStates.push(value); },
        _telemetry: { record() {} },
      },
      _tick() { this.ticked = true; },
      _updateLiveWindowFromReps: window.NativeDashProviderForTest._updateLiveWindowFromReps,
      _evictExpiredLiveSegmentState: window.NativeDashProviderForTest._evictExpiredLiveSegmentState,
      _refreshManifest: window.NativeDashProviderForTest._refreshManifest,
    };
    return provider._refreshManifest().then(() => (
      window.NativeDashProviderForTest._refreshPlaybackManifest.call(provider, 'stale-after-static')
    )).then(() => ({
        live: provider.live,
        duration: provider.duration,
        liveWindow: provider.liveWindow,
        minimumUpdatePeriod: provider.minimumUpdatePeriod,
        transitionCount: provider.liveToVodTransitionCount,
        staleManifestResponseCount: provider.staleManifestResponseCount,
        engineLiveStates,
        terminalEnd: provider.videoReps[0].segments.at(-1).end,
        ticked: !!provider.ticked,
      }));
  });

  expect(state).toEqual({
    live: false,
    duration: 6,
    liveWindow: null,
    minimumUpdatePeriod: 0,
    transitionCount: 1,
    staleManifestResponseCount: 1,
    engineLiveStates: [false],
    terminalEnd: 6,
    ticked: true,
  });
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
      _targetLiveLatency: window.NativeHlsProviderForTest._targetLiveLatency,
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
  expect(state.hls.currentTime).toBe(74.05);
  expect(state.hls.seekCount).toBe(1);
  expect(state.hls.seekBufferPending).toBe(true);
  expect(state.hls.lastSeekTarget).toBe(74.05);
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

  const result = await page.evaluate(async () => {
    const engine = new window.PlayerEngine(document.getElementById('player'), { videoId: 'DRMTEST0001', streamToken: 'test-token' });
    window.__player = engine.getPlayer();
    await engine.init();
    let loadError = null;
    try { await engine.load(); } catch (err) {
      loadError = { message: err.message, nativeTerminal: !!err.nativeTerminal, phase: err.phase };
    }
    return { loadError, stats: engine.getPlayer().getStats() };
  });
  const { stats } = result;

  expect(shakaRequests).toHaveLength(0);
  expect(result.loadError).toEqual({ message: 'dash-widevine-license-unconfigured', nativeTerminal: true, phase: 'load' });
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

  const result = await page.evaluate(async () => {
    const engine = new window.PlayerEngine(document.getElementById('player'), { videoId: 'PLAYREADY01', streamToken: 'test-token' });
    window.__player = engine.getPlayer();
    await engine.init();
    let loadError = null;
    try { await engine.load(); } catch (err) {
      loadError = { message: err.message, nativeTerminal: !!err.nativeTerminal, phase: err.phase };
    }
    return { loadError, stats: engine.getPlayer().getStats() };
  });
  const { stats } = result;

  expect(shakaRequests).toHaveLength(0);
  expect(result.loadError).toEqual({ message: 'dash-playready-unsupported', nativeTerminal: true, phase: 'load' });
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
    return engine.init().then(() => engine.load('/api/stream/PLAYERTEST1/dash.mpd?fixtureFailStatus=500&fixtureFailCount=1&fixtureFailFormat=v240&fixtureFailPhase=media'));
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
    return engine.init().then(() => engine.load('/api/stream/PLAYERTEST1/dash.mpd?fixtureFailStatus=410&fixtureFailCount=3&fixtureFailFormat=v240&fixtureFailPhase=media'));
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
    return engine.init().then(() => engine.load('/api/stream/PLAYERTEST1/dash.mpd?fixtureFailStatus=416&fixtureFailCount=3&fixtureFailFormat=v240&fixtureFailPhase=media'));
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
    return engine.init().then(() => engine.load('/api/stream/PLAYERTEST1/dash.mpd?fixtureFailStatus=401&fixtureFailCount=1&fixtureFailFormat=v240&fixtureFailPhase=media'));
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
    expect.objectContaining({ start: 0, end: 2, duration: 2, mediaSequence: 0, discontinuity: false, discontinuitySequence: 0, gap: false, _hlsPartialOnly: false, _hlsPlaylistUrl: 'https://example.test/hls/hi.m3u8', url: 'https://example.test/hls/video.mp4', range: { start: 100, end: 299 } }),
    expect.objectContaining({ start: 2, end: 4, duration: 2, mediaSequence: 1, discontinuity: false, discontinuitySequence: 0, gap: false, _hlsPartialOnly: false, _hlsPlaylistUrl: 'https://example.test/hls/hi.m3u8', url: 'https://example.test/hls/video.mp4', range: { start: 300, end: 499 } }),
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
#EXT-X-MAP:URI="init-a.mp4",BYTERANGE="100@0"
#EXTINF:2.000,
#EXT-X-BYTERANGE:200@100
video.mp4
#EXT-X-DISCONTINUITY
#EXT-X-MAP:URI="init-b.mp4",BYTERANGE="120@0"
#EXTINF:2.000,
#EXT-X-BYTERANGE:200@300
video.mp4`;
    const out = window.NativeDashProviderForTest.parseHlsPlaylist(media, 'https://example.test/hls/live.m3u8');
    const provider = { hlsTimestampGenerationByKey: {} };
    window.NativeHlsProviderForTest.assignHlsTimestampGenerations(provider, 'https://example.test/hls/live.m3u8', out, 'video');
    provider.segments = out.segments;
    provider.hlsTimestampGenerationByKey.obsolete = { key: 'obsolete' };
    provider.hlsInitTimescaleByKey = { 'video:init:generation=obsolete': { timescale: 1 } };
    provider.hlsTsTimelineByGeneration = {
      obsolete: { key: 'obsolete' },
      [out.segments[0]._hlsTimestampGenerationKey]: { key: out.segments[0]._hlsTimestampGenerationKey },
    };
    const pruned = window.NativeHlsProviderForTest.pruneHlsTimestampGenerations(provider);
    return {
      discontinuity: out.discontinuity,
      discontinuitySequence: out.discontinuitySequence,
      discontinuityCount: out.discontinuityCount,
      endList: out.endList,
      map: out.map,
      maps: out.maps,
      segments: out.segments,
      generations: provider.hlsTimestampGenerationByKey,
      pruned,
      generationCacheKeys: Object.keys(provider.hlsInitTimescaleByKey),
      tsTimelineKeys: Object.keys(provider.hlsTsTimelineByGeneration),
    };
  });

  expect(parsed.discontinuity).toBe(true);
  expect(parsed.discontinuitySequence).toBe(4);
  expect(parsed.discontinuityCount).toBe(1);
  expect(parsed.endList).toBe(false);
  expect(parsed.map).toEqual({ url: 'https://example.test/hls/init-a.mp4', range: { start: 0, end: 99 } });
  expect(parsed.maps).toEqual([
    { url: 'https://example.test/hls/init-a.mp4', range: { start: 0, end: 99 } },
    { url: 'https://example.test/hls/init-b.mp4', range: { start: 0, end: 119 } },
  ]);
  expect(parsed.segments).toEqual([
    expect.objectContaining({
      start: 20,
      end: 22,
      mediaSequence: 10,
      discontinuity: false,
      discontinuitySequence: 4,
      _hlsInitSegment: { url: 'https://example.test/hls/init-a.mp4', range: { start: 0, end: 99 } },
    }),
    expect.objectContaining({
      start: 22,
      end: 24,
      mediaSequence: 11,
      discontinuity: true,
      discontinuitySequence: 5,
      _hlsInitSegment: { url: 'https://example.test/hls/init-b.mp4', range: { start: 0, end: 119 } },
    }),
  ]);
  const generationEntries = Object.values(parsed.generations);
  expect(generationEntries).toHaveLength(2);
  expect(parsed.pruned).toBe(1);
  expect(parsed.generationCacheKeys).toEqual([]);
  expect(parsed.tsTimelineKeys).toEqual([generationEntries[0].key]);
  expect(generationEntries[0]).toMatchObject({ discontinuitySequence: 4, initKey: 'https://example.test/hls/init-a.mp4:0-99', discontinuity: false });
  expect(generationEntries[1]).toMatchObject({ discontinuitySequence: 5, initKey: 'https://example.test/hls/init-b.mp4:0-119', discontinuity: true, previousKey: generationEntries[0].key });
  expect(parsed.segments[0]._hlsTimestampGenerationKey).toBe(generationEntries[0].key);
  expect(parsed.segments[1]._hlsTimestampGenerationKey).toBe(generationEntries[1].key);
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
    const encryptedMap = window.NativeDashProviderForTest.parseHlsPlaylist(`#EXTM3U
#EXT-X-KEY:METHOD=AES-128,URI="map.key",IV=0x00000000000000000000000000000001
#EXT-X-MAP:URI="encrypted-init.mp4"
#EXTINF:2,
seg.m4s`, 'https://example.test/hls/map.m3u8');
    const invalidMap = window.NativeDashProviderForTest.parseHlsPlaylist(`#EXTM3U
#EXT-X-KEY:METHOD=AES-128,URI="map.key"
#EXT-X-MAP:URI="encrypted-init.mp4"
#EXTINF:2,
seg.m4s`, 'https://example.test/hls/map-invalid.m3u8');
    return {
      encrypted: out.encrypted,
      unsupportedEncryption: out.unsupportedEncryption,
      encryptedMap: {
        keyUri: encryptedMap.map.key.uri,
        iv: Array.from(encryptedMap.map.key.iv),
      },
      invalidMap: {
        unsupportedEncryption: invalidMap.unsupportedEncryption,
        reason: invalidMap.unsupportedEncryptionReason,
      },
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
  expect(parsed.encryptedMap).toEqual({
    keyUri: 'https://example.test/hls/map.key',
    iv: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
  });
  expect(parsed.invalidMap).toEqual({ unsupportedEncryption: true, reason: 'hls-map-iv-required' });
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

test('native HLS treats trailing parts as the in-progress parent and preserves implicit ranges', async ({ page }) => {
  const shakaRequests = await blockShakaScript(page);
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const state = await page.evaluate(() => {
    const media = `#EXTM3U
#EXT-X-VERSION:9
#EXT-X-TARGETDURATION:2
#EXT-X-MEDIA-SEQUENCE:270
#EXT-X-SERVER-CONTROL:PART-HOLD-BACK=1.0,CAN-BLOCK-RELOAD=YES
#EXT-X-PART-INF:PART-TARGET=0.5
#EXT-X-MAP:URI="init.mp4"
#EXTINF:2.000,
seg-270.m4s
#EXT-X-PART:DURATION=0.5,URI="parts-271.m4s",BYTERANGE="100@0",INDEPENDENT=YES
#EXT-X-PART:DURATION=0.5,URI="parts-271.m4s",BYTERANGE="120"
#EXT-X-PART:DURATION=0.5,URI="missing-271.m4s",GAP=YES`;
    const parsed = window.NativeDashProviderForTest.parseHlsPlaylist(media, 'https://example.test/live/high.m3u8?token=abc');
    const provider = {
      live: true,
      liveWindow: { start: parsed.segments[0].start, end: parsed.segments.at(-1).end },
      lowLatencyPlaylist: parsed.lowLatencyPlaylist,
      partTargetDuration: parsed.partTargetDuration,
      partialSegmentCount: parsed.partialSegmentCount,
      serverControl: parsed.serverControl,
      segments: parsed.segments,
      preloadHints: [],
      mediaSequence: parsed.mediaSequence,
      discontinuitySequence: parsed.discontinuitySequence,
      isTsPlaylist: false,
      video: { currentTime: parsed.segments.at(-1).start, buffered: { length: 0 } },
      _schedulerTime() { return parsed.segments.at(-1).start; },
      _targetLiveLatency() { return 1; },
      _bufferAheadGoal() { return 4; },
      _startupBufferGoal() { return 1; },
    };
    const playable = window.NativeHlsProviderForTest.hlsPlayableSegments(provider, provider, parsed.segments);
    const blockingUrl = window.NativeHlsProviderForTest.hlsBlockingReloadUrl(
      'https://example.test/live/high.m3u8?token=abc',
      provider,
    );
    return {
      parsed,
      playable: playable.map(segment => ({
        url: segment.url,
        range: segment.range,
        gap: !!segment.gap,
        partial: !!segment._hlsPart,
      })),
      blockingUrl,
    };
  });

  expect(state.parsed.segments).toHaveLength(2);
  expect(state.parsed.segments[0]).toMatchObject({ mediaSequence: 270, url: 'https://example.test/live/seg-270.m4s' });
  expect(state.parsed.segments[1]).toMatchObject({
    mediaSequence: 271,
    duration: 1.5,
    url: '',
    _hlsPartialOnly: true,
  });
  expect(state.parsed.segments[1].parts).toEqual([
    expect.objectContaining({ partIndex: 0, range: { start: 0, end: 99 }, independent: true, gap: false }),
    expect.objectContaining({ partIndex: 1, range: { start: 100, end: 219 }, independent: false, gap: false }),
    expect.objectContaining({ partIndex: 2, range: null, gap: true }),
  ]);
  expect(state.parsed.partialSegmentCount).toBe(3);
  expect(state.parsed.partialSegmentGapCount).toBe(1);
  expect(state.playable).toEqual([
    expect.objectContaining({ url: 'https://example.test/live/seg-270.m4s', partial: false }),
    expect.objectContaining({ url: 'https://example.test/live/parts-271.m4s', range: { start: 0, end: 99 }, partial: true }),
    expect.objectContaining({ url: 'https://example.test/live/parts-271.m4s', range: { start: 100, end: 219 }, partial: true }),
  ]);
  expect(state.playable.some(segment => !segment.url || segment.gap)).toBe(false);
  const reloadUrl = new URL(state.blockingUrl);
  expect(reloadUrl.searchParams.get('token')).toBe('abc');
  expect(reloadUrl.searchParams.get('_HLS_msn')).toBe('271');
  expect(reloadUrl.searchParams.get('_HLS_part')).toBe('3');
  expect(shakaRequests).toHaveLength(0);
});

test('native HLS carries appended trailing-part state into the completed parent', async ({ page }) => {
  const shakaRequests = await blockShakaScript(page);
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const merged = await page.evaluate(() => {
    const prefix = `#EXTM3U
#EXT-X-VERSION:9
#EXT-X-TARGETDURATION:2
#EXT-X-MEDIA-SEQUENCE:9
#EXT-X-SERVER-CONTROL:PART-HOLD-BACK=1.0,CAN-BLOCK-RELOAD=YES
#EXT-X-PART-INF:PART-TARGET=1
#EXT-X-MAP:URI="init.mp4"
#EXT-X-PART:DURATION=1,URI="part-9.0.m4s",INDEPENDENT=YES
#EXT-X-PART:DURATION=1,URI="part-9.1.m4s"`;
    const oldPlaylist = window.NativeDashProviderForTest.parseHlsPlaylist(
      prefix,
      'https://example.test/live/high.m3u8',
    );
    oldPlaylist.segments[0].parts.forEach(part => {
      part.appended = true;
      part.state = 'appended';
    });
    const completedPlaylist = window.NativeDashProviderForTest.parseHlsPlaylist(
      `${prefix}
#EXTINF:2,
seg-9.m4s`,
      'https://example.test/live/high.m3u8',
    );
    return window.NativeHlsProviderForTest.mergeSegmentState(
      oldPlaylist.segments,
      completedPlaylist.segments,
    );
  });

  expect(merged).toHaveLength(1);
  expect(merged[0]).toMatchObject({
    mediaSequence: 9,
    url: 'https://example.test/live/seg-9.m4s',
    appended: true,
    state: 'appended',
    _hlsPartialOnly: false,
  });
  expect(merged[0].parts.every(part => part.appended && part.state === 'appended')).toBe(true);
  expect(shakaRequests).toHaveLength(0);
});

test('native HLS schedules and reuses video preload hints', async ({ page }) => {
  const shakaRequests = await blockShakaScript(page);
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const state = await page.evaluate(() => {
    const provider = {
      live: true,
      lowLatencyPlaylist: true,
      isTsPlaylist: false,
      partTargetDuration: 0.5,
      mediaSequence: 40,
      discontinuitySequence: 0,
      mediaPlaylistUrl: 'https://example.test/live/high.m3u8',
      segments: [{
        start: 80,
        end: 80.5,
        duration: 0.5,
        mediaSequence: 40,
        discontinuitySequence: 0,
        url: '',
        _hlsPartialOnly: true,
        _hlsPlaylistUrl: 'https://example.test/live/high.m3u8',
        parts: [{
          start: 80,
          end: 80.5,
          duration: 0.5,
          mediaSequence: 40,
          partIndex: 0,
          discontinuitySequence: 0,
          independent: true,
          url: 'https://example.test/live/part-40.0.m4s',
          range: null,
          _hlsPart: true,
        }],
      }],
      preloadHints: [{
        type: 'PART',
        url: 'https://example.test/live/part-40.1.m4s',
        byteRangeStart: NaN,
        byteRangeLength: NaN,
      }],
      video: { currentTime: 80, buffered: { length: 0 } },
      liveWindow: { start: 80, end: 80.5 },
      _schedulerTime() { return 80; },
      _targetLiveLatency() { return 1; },
      _bufferAheadGoal() { return 4; },
      _startupBufferGoal() { return 1; },
      preloadHintReuseCount: 0,
      preloadHintDiscardCount: 0,
    };
    provider.segments[0].parts[0]._parentSegment = provider.segments[0];
    const playable = window.NativeHlsProviderForTest.hlsPlayableSegments(provider, provider, provider.segments);
    const hinted = playable.find(segment => segment._hlsPreloadHint);
    hinted.state = 'fetched';
    hinted.appended = false;
    hinted._data = new ArrayBuffer(8);
    const speculativeAppend = window.NativeHlsProviderForTest.nextFetchedSegmentForAppend(
      { segments: [hinted] },
      80,
    );

    const official = window.NativeDashProviderForTest.parseHlsPlaylist(`#EXTM3U
#EXT-X-TARGETDURATION:2
#EXT-X-MEDIA-SEQUENCE:40
#EXT-X-SERVER-CONTROL:PART-HOLD-BACK=1.0,CAN-BLOCK-RELOAD=YES
#EXT-X-PART-INF:PART-TARGET=0.5
#EXT-X-MAP:URI="init.mp4"
#EXT-X-PART:DURATION=0.5,URI="part-40.0.m4s",INDEPENDENT=YES
#EXT-X-PART:DURATION=0.5,URI="part-40.1.m4s"`, 'https://example.test/live/high.m3u8');
    window.NativeHlsProviderForTest.reconcileHlsPreloadHints(provider, provider, official);
    const reused = official.segments[0].parts[1];
    const confirmedAppend = window.NativeHlsProviderForTest.nextFetchedSegmentForAppend(
      { segments: official.segments[0].parts },
      80,
    );
    return {
      hinted: {
        url: hinted.url,
        mediaSequence: hinted.mediaSequence,
        partIndex: hinted.partIndex,
      },
      reused: {
        url: reused.url,
        appended: reused.appended,
        state: reused.state,
        retainedBytes: reused._data.byteLength,
        preload: !!reused._hlsPreloadHint,
        parentSequence: reused._parentSegment.mediaSequence,
      },
      preloadHintReuseCount: provider.preloadHintReuseCount,
      speculativeAppend: !!speculativeAppend,
      confirmedAppendUrl: confirmedAppend && confirmedAppend.url,
    };
  });

  expect(state.hinted).toEqual({
    url: 'https://example.test/live/part-40.1.m4s',
    mediaSequence: 40,
    partIndex: 1,
  });
  expect(state.reused).toEqual({
    url: 'https://example.test/live/part-40.1.m4s',
    appended: false,
    state: 'fetched',
    retainedBytes: 8,
    preload: false,
    parentSequence: 40,
  });
  expect(state.preloadHintReuseCount).toBe(1);
  expect(state.speculativeAppend).toBe(false);
  expect(state.confirmedAppendUrl).toBe('https://example.test/live/part-40.1.m4s');
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
  expect(stats.contentSteeringSwitchCount).toBe(1);
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

test('native HLS fixture plays through MSE across declared gaps and keeps terminal playlists monotonic', async ({ page }) => {
  const shakaRequests = await blockShakaScript(page);
  await page.route('**/manifest-gap.m3u8', async route => {
    const url = new URL(route.request().url());
    const resp = await fetch(url.origin + '/api/stream/PLAYERTEST1/hls/v360.m3u8?fixtureHls=1');
    let mediaIndex = 0;
    const body = (await resp.text()).split('\n').map(line => {
      if (!line || line.startsWith('#')) return line;
      const declaredGap = mediaIndex === 1;
      mediaIndex++;
      return declaredGap ? '#EXT-X-GAP\n' + line : line;
    }).join('\n');
    route.fulfill({ status: 200, contentType: 'application/vnd.apple.mpegurl', body });
  });
  await page.route('**/all-gap.m3u8', async route => {
    const url = new URL(route.request().url());
    const resp = await fetch(url.origin + '/api/stream/PLAYERTEST1/hls/v360.m3u8?fixtureHls=1');
    const body = (await resp.text()).split('\n').map(line => (
      line && !line.startsWith('#') ? '#EXT-X-GAP\n' + line : line
    )).join('\n');
    route.fulfill({ status: 200, contentType: 'application/vnd.apple.mpegurl', body });
  });

  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player" muted playsinline></video>');
  await page.evaluate(async () => {
    const video = document.getElementById('player');
    video.canPlayType = () => '';
    const engine = new window.PlayerEngine(video, { videoId: 'PLAYERTEST1', streamToken: '' });
    window.__engine = engine;
    window.__player = engine.getPlayer();
    window.__player.configure({ streaming: { bufferingGoal: 6, startupBufferGoal: 1, maxConcurrentRequests: 3 } });
    await engine.init();
    await engine.load('/manifest-gap.m3u8');
    video.playbackRate = 2;
    await video.play();
  });

  await page.waitForFunction(() => {
    const stats = window.__player.getStats();
    return stats.manifestGapJumpCount > 0 && document.getElementById('player').currentTime > 2.1;
  }, null, { timeout: 10_000 });
  await page.waitForFunction(() => document.getElementById('player').ended, null, { timeout: 10_000 });

  const gapState = await page.evaluate(async () => {
    const provider = window.__engine._provider;
    const stale = await fetch('/manifest-gap.m3u8').then(resp => resp.text());
    provider._loadMediaPlaylist(stale.replace('#EXT-X-ENDLIST', ''), provider.mediaPlaylistUrl);
    return {
      live: provider.live,
      videoEndList: provider.videoEndList,
      stats: window.__player.getStats(),
    };
  });
  expect(gapState.live).toBe(false);
  expect(gapState.videoEndList).toBe(true);
  expect(gapState.stats.manifestGapJumpCount).toBe(1);
  expect(gapState.stats.lastManifestGapSize).toBeCloseTo(1);
  expect(gapState.stats.staleManifestResponseCount).toBe(1);
  expect(gapState.stats.vodEndOfStreamCount).toBe(1);
  await page.evaluate(() => window.__engine.destroy());

  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player" muted playsinline></video>');
  await page.evaluate(async () => {
    const video = document.getElementById('player');
    video.canPlayType = () => '';
    const engine = new window.PlayerEngine(video, { videoId: 'PLAYERTEST1', streamToken: '' });
    window.__engine = engine;
    window.__player = engine.getPlayer();
    await engine.init();
    await engine.load('/all-gap.m3u8');
    video.play().catch(() => {});
  });
  await page.waitForFunction(() => document.getElementById('player').ended, null, { timeout: 5_000 });
  await page.evaluate(() => { document.getElementById('player').play().catch(() => {}); });
  await page.waitForTimeout(500);
  const emptyReplay = await page.evaluate(() => ({
    ended: document.getElementById('player').ended,
    stats: window.__player.getStats(),
  }));
  expect(emptyReplay.ended).toBe(true);
  expect(emptyReplay.stats.vodEndOfStreamRefillPending).toBe(false);
  expect(emptyReplay.stats.vodEndOfStreamReopenCount).toBe(0);
  await page.evaluate(() => window.__engine.destroy());
  expect(shakaRequests).toHaveLength(0);
});

test('native HLS fixture plays through MSE when one rendition is entirely declared gaps', async ({ page }) => {
  const shakaRequests = await blockShakaScript(page);
  const master = (videoPlaylist, audioPlaylist) => [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio-main",NAME="English",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,URI="${audioPlaylist}",CODECS="mp4a.40.2"`,
    '#EXT-X-STREAM-INF:BANDWIDTH=864000,RESOLUTION=640x360,CODECS="avc1.42c01f,mp4a.40.2",AUDIO="audio-main"',
    videoPlaylist,
  ].join('\n');
  const gapEverySegment = text => text.split('\n').map(line => (
    line && !line.startsWith('#') ? '#EXT-X-GAP\n' + line : line
  )).join('\n');
  await page.route('**/audio-gap-master.m3u8', route => route.fulfill({
    status: 200,
    contentType: 'application/vnd.apple.mpegurl',
    body: master('/playable-video.m3u8', '/gap-audio.m3u8'),
  }));
  await page.route('**/video-gap-master.m3u8', route => route.fulfill({
    status: 200,
    contentType: 'application/vnd.apple.mpegurl',
    body: master('/gap-video.m3u8', '/playable-audio.m3u8'),
  }));
  await page.route('**/playable-video.m3u8', async route => {
    const url = new URL(route.request().url());
    const response = await fetch(url.origin + '/api/stream/PLAYERTEST1/hls/v360.m3u8?fixtureHls=groups');
    route.fulfill({ status: 200, contentType: 'application/vnd.apple.mpegurl', body: await response.text() });
  });
  await page.route('**/gap-video.m3u8', async route => {
    const url = new URL(route.request().url());
    const response = await fetch(url.origin + '/api/stream/PLAYERTEST1/hls/v360.m3u8?fixtureHls=groups');
    route.fulfill({ status: 200, contentType: 'application/vnd.apple.mpegurl', body: gapEverySegment(await response.text()) });
  });
  await page.route('**/playable-audio.m3u8', async route => {
    const url = new URL(route.request().url());
    const response = await fetch(url.origin + '/api/stream/PLAYERTEST1/hls/a64.m3u8?fixtureHls=groups');
    route.fulfill({ status: 200, contentType: 'application/vnd.apple.mpegurl', body: await response.text() });
  });
  await page.route('**/gap-audio.m3u8', async route => {
    const url = new URL(route.request().url());
    const response = await fetch(url.origin + '/api/stream/PLAYERTEST1/hls/a64.m3u8?fixtureHls=groups');
    route.fulfill({ status: 200, contentType: 'application/vnd.apple.mpegurl', body: gapEverySegment(await response.text()) });
  });

  async function playCase(manifest) {
    await page.goto('/auth/login');
    await setPlayerContent(page, '<video id="player" muted playsinline></video>');
    await page.evaluate(async source => {
      const video = document.getElementById('player');
      video.canPlayType = () => '';
      const engine = new window.PlayerEngine(video, { videoId: 'PLAYERTEST1', streamToken: '' });
      window.__engine = engine;
      window.__player = engine.getPlayer();
      window.__player.configure({ abr: { enabled: false }, streaming: { bufferingGoal: 6, startupBufferGoal: 1, maxConcurrentRequests: 3 } });
      await engine.init();
      await engine.load(source);
      video.playbackRate = 2;
      video.play().catch(() => {});
    }, manifest);
    await page.waitForFunction(() => document.getElementById('player').ended, null, { timeout: 10_000 });
    const state = await page.evaluate(() => ({
      currentTime: document.getElementById('player').currentTime,
      stats: window.__player.getStats(),
    }));
    await page.evaluate(() => window.__engine.destroy());
    return state;
  }

  const audioGap = await playCase('/audio-gap-master.m3u8');
  expect(audioGap.currentTime).toBeGreaterThan(5.5);
  expect(audioGap.stats.suppressedAudioGapTrack).toBe(true);
  expect(audioGap.stats.suppressedVideoGapTrack).toBe(false);
  expect(audioGap.stats.suppressedGapTrackCount).toBe(1);
  expect(audioGap.stats.vodEndOfStreamCount).toBe(1);

  const videoGap = await playCase('/video-gap-master.m3u8');
  expect(videoGap.currentTime).toBeGreaterThan(5.5);
  expect(videoGap.stats.suppressedAudioGapTrack).toBe(false);
  expect(videoGap.stats.suppressedVideoGapTrack).toBe(true);
  expect(videoGap.stats.suppressedGapTrackCount).toBe(1);
  expect(videoGap.stats.vodEndOfStreamCount).toBe(1);
  expect(shakaRequests).toHaveLength(0);
});

test('native HLS reactivates transient gap renditions and changes codecs safely', async ({ page }) => {
  await page.goto('/auth/login');
  await page.setContent('<video id="player"></video>');
  await page.addScriptTag({ path: 'public/native-player-engine.js' });

  const state = await page.evaluate(async () => {
    function sourceBuffer(type) {
      const buffer = new EventTarget();
      buffer.type = type;
      buffer.updating = false;
      buffer.buffered = { length: 0, start() { return 0; }, end() { return 0; } };
      buffer.changedTypes = [];
      buffer.changeType = nextType => {
        buffer.type = nextType;
        buffer.changedTypes.push(nextType);
      };
      buffer.appendBuffer = () => {
        buffer.updating = true;
        queueMicrotask(() => {
          buffer.updating = false;
          buffer.dispatchEvent(new Event('updateend'));
        });
      };
      return buffer;
    }
    const initialVideoBuffer = sourceBuffer('video/mp4; codecs="avc1.42c01f"');
    const initialAudioBuffer = sourceBuffer('audio/mp4; codecs="mp4a.40.2"');
    const mediaSource = {
      readyState: 'open',
      added: [],
      removed: [],
      addSourceBuffer(type) {
        const buffer = sourceBuffer(type);
        this.added.push(buffer);
        return buffer;
      },
      removeSourceBuffer(buffer) {
        this.removed.push(buffer);
      },
    };
    const audio = {
      kind: 'audio',
      isTsPlaylist: true,
      segments: [{ start: 0, end: 2, gap: true }],
    };
    const provider = {
      destroyed: false,
      mediaSource,
      video: { currentTime: 0 },
      sb: initialVideoBuffer,
      audioSb: initialAudioBuffer,
      mimeType: 'video/mp4; codecs="avc1.42c01f"',
      audioMimeType: 'audio/mp4; codecs="mp4a.40.2"',
      videoSourceBufferMime: 'video/mp4; codecs="avc1.42c01f"',
      audioSourceBufferMime: 'audio/mp4; codecs="mp4a.40.2"',
      segments: [{ start: 0, end: 2, gap: false }],
      activeAudio: audio,
      audioSegments: audio.segments,
      initSegment: null,
      audioInitSegment: null,
      muxedTsAudio: false,
      suppressedVideoGapTrack: false,
      suppressedAudioGapTrack: false,
      suppressedGapTrackCount: 0,
      trackActivationCount: 0,
      trackSuppressionCount: 0,
      sourceBufferTypeChangeCount: 0,
      sourceBufferTypeRebuildCount: 0,
      abortCount: 0,
      _abortRequests() { this.abortCount++; },
      _fetchRange() { return Promise.resolve(new Uint8Array([1]).buffer); },
      _appendTrackInitIfNeeded: window.NativeHlsProviderForTest._appendTrackInitIfNeeded,
      _transitionTrackSourceBuffer: window.NativeHlsProviderForTest._transitionTrackSourceBuffer,
    };
    const apply = window.NativeHlsProviderForTest._applyTrackLifecycle;

    await apply.call(provider);
    const afterAudioSuppression = { audioRemoved: provider.audioSb === null, suppressed: provider.suppressedAudioGapTrack };

    audio.segments = [{ start: 2, end: 4, gap: false }];
    provider.audioSegments = audio.segments;
    await apply.call(provider);
    const reactivatedAudioBuffer = provider.audioSb;
    const afterAudioReactivation = { active: !!provider.audioSb, suppressed: provider.suppressedAudioGapTrack };

    provider.mimeType = 'video/mp4; codecs="vp09.00.10.08"';
    await apply.call(provider);
    const videoTypeChanges = initialVideoBuffer.changedTypes.slice();

    provider.segments = [{ start: 4, end: 6, gap: true }];
    await apply.call(provider);
    const afterVideoSuppression = { videoRemoved: provider.sb === null, suppressed: provider.suppressedVideoGapTrack };

    provider.segments = [{ start: 6, end: 8, gap: false }];
    await apply.call(provider);
    const reactivatedVideoBuffer = provider.sb;
    provider.segments[0].appended = true;
    provider.segments[0].state = 'appended';
    reactivatedVideoBuffer.changeType = () => { throw new Error('changeType rejected'); };
    provider.mimeType = 'video/mp4; codecs="av01.0.04M.08"';
    await apply.call(provider);
    return {
      afterAudioSuppression,
      afterAudioReactivation,
      afterVideoSuppression,
      videoReactivated: !!provider.sb && provider.sb !== initialVideoBuffer,
      videoRebuiltWithoutChangeType: provider.sb !== reactivatedVideoBuffer,
      reactivatedAudioWasNew: reactivatedAudioBuffer !== initialAudioBuffer,
      videoTypeChanges,
      activationCount: provider.trackActivationCount,
      suppressionCount: provider.trackSuppressionCount,
      typeChangeCount: provider.sourceBufferTypeChangeCount,
      rebuildCount: provider.sourceBufferTypeRebuildCount,
      rebuiltSegmentState: provider.segments[0].state,
      ledgerReconciles: provider.hlsSegmentLedgerReconcileCount,
      ledgerInvalidations: provider.hlsSegmentLedgerInvalidationCount,
      abortCount: provider.abortCount,
    };
  });

  expect(state.afterAudioSuppression).toEqual({ audioRemoved: true, suppressed: true });
  expect(state.afterAudioReactivation).toEqual({ active: true, suppressed: false });
  expect(state.reactivatedAudioWasNew).toBe(true);
  expect(state.videoTypeChanges).toEqual(['video/mp4; codecs="vp09.00.10.08"']);
  expect(state.afterVideoSuppression).toEqual({ videoRemoved: true, suppressed: true });
  expect(state.videoReactivated).toBe(true);
  expect(state.videoRebuiltWithoutChangeType).toBe(true);
  expect(state.activationCount).toBe(2);
  expect(state.suppressionCount).toBe(2);
  expect(state.typeChangeCount).toBe(1);
  expect(state.rebuildCount).toBe(1);
  expect(state.rebuiltSegmentState).toBe('pending');
  expect(state.ledgerReconciles).toBeGreaterThanOrEqual(1);
  expect(state.ledgerInvalidations).toBeGreaterThanOrEqual(1);
  expect(state.abortCount).toBeGreaterThanOrEqual(5);
});

test('native HLS append failure rebuilds the previous SourceBuffer when codec reconstruction fails', async ({ page }) => {
  await page.goto('/auth/login');
  await page.setContent('<video id="player"></video>');
  await page.addScriptTag({ path: 'public/native-player-engine.js' });

  const state = await page.evaluate(async () => {
    function sourceBuffer(type, rejectChangeType = false) {
      const buffer = new EventTarget();
      buffer.type = type;
      buffer.updating = false;
      buffer.buffered = { length: 0, start() { return 0; }, end() { return 0; } };
      buffer.appendCount = 0;
      buffer.changeType = nextType => {
        if (rejectChangeType) throw new Error('changeType rejected');
        buffer.type = nextType;
      };
      buffer.appendBuffer = () => {
        buffer.appendCount++;
        buffer.updating = true;
        queueMicrotask(() => {
          buffer.updating = false;
          buffer.dispatchEvent(new Event('updateend'));
        });
      };
      return buffer;
    }

    const oldMime = 'video/mp4; codecs="avc1.42c01f"';
    const newMime = 'video/mp4; codecs="vp09.00.10.08"';
    const oldInit = { url: '/old-init.mp4', range: null };
    const oldBuffer = sourceBuffer(oldMime, true);
    const mediaSource = {
      readyState: 'open',
      addedTypes: [],
      removed: [],
      addSourceBuffer(type) {
        this.addedTypes.push(type);
        if (type === newMime) throw new Error('new codec rejected');
        return sourceBuffer(type);
      },
      removeSourceBuffer(buffer) { this.removed.push(buffer); },
    };
    const provider = {
      destroyed: false,
      trackTransitionGeneration: 3,
      mediaSource,
      sb: oldBuffer,
      audioSb: null,
      mimeType: newMime,
      videoSourceBufferMime: oldMime,
      _appendedVideoInitKey: '/old-init.mp4',
      _sourceBufferVideoInitSegment: oldInit,
      initSegment: { url: '/new-init.mp4', range: null },
      trackActivationCount: 0,
      sourceBufferTypeChangeCount: 0,
      sourceBufferTypeRebuildCount: 0,
      sourceBufferTypeRollbackCount: 0,
      _fetchRange() { return Promise.resolve(new Uint8Array([1, 2, 3]).buffer); },
      _appendTrackInitIfNeeded: window.NativeHlsProviderForTest._appendTrackInitIfNeeded,
      _restoreTrackSourceBuffer: window.NativeHlsProviderForTest._restoreTrackSourceBuffer,
      _transitionTrackSourceBuffer: window.NativeHlsProviderForTest._transitionTrackSourceBuffer,
    };

    let error = '';
    try { await provider._transitionTrackSourceBuffer('video', false, 3); } catch (err) { error = err.message; }
    return {
      error,
      restored: provider.sb !== null && provider.sb !== oldBuffer,
      restoredMime: provider.videoSourceBufferMime,
      restoredInit: provider._sourceBufferVideoInitSegment && provider._sourceBufferVideoInitSegment.url,
      restoredAppendCount: provider.sb ? provider.sb.appendCount : 0,
      addedTypes: mediaSource.addedTypes,
      removedOldBuffer: mediaSource.removed.includes(oldBuffer),
      rollbackCount: provider.sourceBufferTypeRollbackCount,
    };
  });

  expect(state.error).toBe('hls-video-sourcebuffer-rebuild-failed');
  expect(state.restored).toBe(true);
  expect(state.restoredMime).toBe('video/mp4; codecs="avc1.42c01f"');
  expect(state.restoredInit).toBe('/old-init.mp4');
  expect(state.restoredAppendCount).toBe(1);
  expect(state.addedTypes).toEqual([
    'video/mp4; codecs="vp09.00.10.08"',
    'video/mp4; codecs="avc1.42c01f"',
  ]);
  expect(state.removedOldBuffer).toBe(true);
  expect(state.rollbackCount).toBe(1);
});

test('manual native quality selection rolls back failed HLS variant state and fully clears switch buffers', async ({ page }) => {
  await page.goto('/auth/login');
  await page.setContent('<video id="player"></video>');
  await page.addScriptTag({ path: 'public/native-player-engine.js' });

  const state = await page.evaluate(async () => {
    const removedRanges = [];
    const clearBuffer = new EventTarget();
    clearBuffer.updating = false;
    clearBuffer.buffered = {
      length: 2,
      start(index) { return index === 0 ? 2 : 20; },
      end(index) { return index === 0 ? 10 : 30; },
    };
    clearBuffer.remove = (start, end) => {
      removedRanges.push([start, end]);
      clearBuffer.updating = true;
      queueMicrotask(() => {
        clearBuffer.buffered = { length: 0, start() { return 0; }, end() { return 0; } };
        clearBuffer.updating = false;
        clearBuffer.dispatchEvent(new Event('updateend'));
      });
    };
    await window.NativePlayerSourceBufferForTest.clear(clearBuffer);

    const oldVariant = { id: 'old', url: '/old.m3u8', active: true, codecs: 'avc1.42c01f' };
    const nextVariant = { id: 'next', url: '/next.m3u8', active: false, codecs: 'vp09.00.10.08' };
    const emitted = [];
    const provider = {
      destroyed: false,
      trackTransitionGeneration: 0,
      trackTransitionInFlight: null,
      variantSwitchInFlight: false,
      pendingManualVariantSwitch: null,
      pendingAudioTrackSwitch: null,
      variants: [oldVariant, nextVariant],
      audioRenditions: [],
      activeVariant: oldVariant,
      activeAudio: null,
      manualTrackId: '',
      segments: [{ url: '/old-1.m4s', start: 0, end: 2, appended: true, state: 'appended' }],
      initSegment: null,
      audioSegments: [],
      audioInitSegment: null,
      mimeType: 'video/mp4; codecs="avc1.42c01f"',
      audioMimeType: '',
      sb: null,
      audioSb: null,
      videoSourceBufferMime: '',
      audioSourceBufferMime: '',
      playlistCursorByUrl: { '/old.m3u8': { msn: 5, part: -1, partial: false } },
      playlistResetCandidateByUrl: { '/old.m3u8': { cursor: { msn: 1, part: -1, partial: false } } },
      playlistEpochByUrl: { '/old.m3u8': { id: 2, timelineOffset: 40, discontinuityOffset: 1 } },
      mediaSource: { readyState: 'open', addSourceBuffer() {}, removeSourceBuffer() {} },
      video: { currentTime: 0, buffered: { length: 0, start() { return 0; }, end() { return 0; } } },
      engine: { _player: { config: { abr: { enabled: true } }, emit(name) { emitted.push(name); } } },
      _abortRequests() {},
      _chooseAudioRendition: window.NativeHlsProviderForTest._chooseAudioRendition,
      _beginTrackTransition: window.NativeHlsProviderForTest._beginTrackTransition,
      _isTrackTransitionCurrent: window.NativeHlsProviderForTest._isTrackTransitionCurrent,
      _ownsTrackTransition: window.NativeHlsProviderForTest._ownsTrackTransition,
      _finishTrackTransition: window.NativeHlsProviderForTest._finishTrackTransition,
      _rollbackTrackTransition: window.NativeHlsProviderForTest._rollbackTrackTransition,
      _restoreTrackSourceBuffer: window.NativeHlsProviderForTest._restoreTrackSourceBuffer,
      _flushPendingVariantSwitch: window.NativeHlsProviderForTest._flushPendingVariantSwitch,
      _flushPendingTrackSwitch: window.NativeHlsProviderForTest._flushPendingTrackSwitch,
      _completeNativeRuntimeTerminal(reason) { this.terminal = reason; },
      _tick() {},
      _refreshMediaPlaylist() {
        this.segments = [{ url: '/next-1.m4s', start: 0, end: 2 }];
        this.mimeType = 'video/mp4; codecs="vp09.00.10.08"';
        this.playlistCursorByUrl = { '/next.m3u8': { msn: 9, part: -1, partial: false } };
        this.playlistResetCandidateByUrl = { '/next.m3u8': { cursor: { msn: 0, part: -1, partial: false } } };
        this.playlistEpochByUrl = { '/next.m3u8': { id: 7, timelineOffset: 80, discontinuityOffset: 3 } };
        return Promise.reject(new Error('injected-playlist-failure'));
      },
    };
    provider._switchVariant = window.NativeHlsProviderForTest._switchVariant;
    provider._switchVariant(nextVariant, true, 'manual');
    for (let i = 0; i < 20 && (provider.variantSwitchInFlight || provider.trackTransitionInFlight); i++) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    return {
      removedRanges,
      activeVariant: provider.activeVariant && provider.activeVariant.id,
      activeFlags: provider.variants.map(item => item.active),
      segmentUrl: provider.segments[0] && provider.segments[0].url,
      mimeType: provider.mimeType,
      cursorKeys: Object.keys(provider.playlistCursorByUrl),
      resetCandidateKeys: Object.keys(provider.playlistResetCandidateByUrl),
      epochKeys: Object.keys(provider.playlistEpochByUrl),
      epochId: provider.playlistEpochByUrl['/old.m3u8'] && provider.playlistEpochByUrl['/old.m3u8'].id,
      manualTrackId: provider.manualTrackId,
      abrEnabled: provider.engine._player.config.abr.enabled,
      emitted,
      rollbackCount: provider.trackTransitionRollbackCount || 0,
      rollbackFailures: provider.trackTransitionRollbackFailureCount || 0,
      transitionInFlight: !!provider.trackTransitionInFlight,
      terminal: provider.terminal || '',
    };
  });

  expect(state.removedRanges).toEqual([[2, 30]]);
  expect(state.activeVariant).toBe('old');
  expect(state.activeFlags).toEqual([true, false]);
  expect(state.segmentUrl).toBe('/old-1.m4s');
  expect(state.mimeType).toBe('video/mp4; codecs="avc1.42c01f"');
  expect(state.cursorKeys).toEqual(['/old.m3u8']);
  expect(state.resetCandidateKeys).toEqual(['/old.m3u8']);
  expect(state.epochKeys).toEqual(['/old.m3u8']);
  expect(state.epochId).toBe(2);
  expect(state.manualTrackId).toBe('');
  expect(state.abrEnabled).toBe(true);
  expect(state.emitted).not.toContain('variantchanged');
  expect(state.rollbackCount).toBe(1);
  expect(state.rollbackFailures).toBe(0);
  expect(state.transitionInFlight).toBe(false);
  expect(state.terminal).toBe('');
});

test('destroy rejects held network requests before stale native HLS init data can append', async ({ page }) => {
  await page.goto('/auth/login');
  await page.setContent('<video id="player"></video>');
  await page.addScriptTag({ path: 'public/native-player-engine.js' });

  const state = await page.evaluate(async () => {
    let resolveFetch;
    const buffer = new EventTarget();
    buffer.updating = false;
    buffer.buffered = { length: 0, start() { return 0; }, end() { return 0; } };
    buffer.appendCount = 0;
    buffer.appendBuffer = () => { buffer.appendCount++; };
    const provider = {
      destroyed: false,
      trackTransitionGeneration: 7,
      mediaSource: { readyState: 'open' },
      sb: buffer,
      initSegment: { url: '/late-init.mp4', range: null },
      _appendedVideoInitKey: '',
      _fetchRange() { return new Promise(resolve => { resolveFetch = resolve; }); },
    };
    const pending = window.NativeHlsProviderForTest._appendTrackInitIfNeeded.call(provider, 'video', true, 7);
    provider.destroyed = true;
    provider.trackTransitionGeneration++;
    resolveFetch(new Uint8Array([1]).buffer);
    let errorName = '';
    try { await pending; } catch (err) { errorName = err.name; }
    return { errorName, appendCount: buffer.appendCount, initKey: provider._appendedVideoInitKey };
  });

  expect(state.errorName).toBe('AbortError');
  expect(state.appendCount).toBe(0);
  expect(state.initKey).toBe('');
});

test('native HLS low-latency playlist fetches and appends partial segments without Shaka fallback', async ({ page }) => {
  const shakaRequests = [];
  const partialRequests = [];
  const blockingReloads = [];
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
  await page.route('**/ll-media.m3u8**', async route => {
    const url = new URL(route.request().url());
    if (url.searchParams.has('_HLS_msn')) blockingReloads.push(url);
    const resp = await fetch(url.origin + '/api/stream/PLAYERTEST1/hls/v360.m3u8?fixtureHls=1');
    let text = await resp.text();
    const mediaRanges = [...text.matchAll(/#EXT-X-BYTERANGE:([^\n]+)\n(\/api\/stream\/PLAYERTEST1\/fmt\/v360)/g)];
    const liveEdgeRange = mediaRanges.at(-1);
    const partRange = liveEdgeRange ? liveEdgeRange[1] : '';
    const partUrl = liveEdgeRange ? liveEdgeRange[2] + '?llpart=0' : 'seg-live.part.m4s';
    text = text.replace('#EXTM3U', [
      '#EXTM3U',
      '#EXT-X-SERVER-CONTROL:CAN-SKIP-UNTIL=12.0,HOLD-BACK=6.0,PART-HOLD-BACK=1.0,CAN-BLOCK-RELOAD=YES',
      '#EXT-X-PART-INF:PART-TARGET=0.33334',
    ].join('\n'));
    const lastSegment = text.lastIndexOf('#EXTINF:');
    text = text.slice(0, lastSegment) + [
      `#EXT-X-PART:DURATION=0.33334,URI="${partUrl}",BYTERANGE="${partRange}",INDEPENDENT=YES`,
      '#EXTINF:',
    ].join('\n') + text.slice(lastSegment + '#EXTINF:'.length);
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
  await expect.poll(() => page.evaluate(() => window.__player.getStats().blockingReloadRequestCount)).toBeGreaterThan(0);

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
  expect(state.stats.blockingReloadResponseCount).toBeGreaterThan(0);
  expect(state.stats.renditionReportCount).toBe(1);
  // EXT-X-SKIP is intentionally absent here: a delta update is only valid
  // when merged with a previously loaded complete Playlist.
  expect(state.stats.skippedSegmentCount).toBe(0);
  expect(state.stats.iframeVariantCount).toBe(1);
  expect(state.stats.contentSteeringUri).toBe('/steering.json');
  expect(state.stats.manifestCompatibilityWarnings).not.toContain('hls-delta-update-skipped-segments');
  expect(state.stats.fallbackReason).toBe('');
  expect(state.tracks).toHaveLength(1);
  expect(state.tracks[0]).toMatchObject({ height: 360, selectable: true });
  expect(partialRequests.length).toBeGreaterThan(0);
  expect(blockingReloads.length).toBeGreaterThan(0);
  expect(blockingReloads[0].searchParams.get('_HLS_part')).toBe('0');
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
  await page.route('**/ll-missing-media.m3u8**', async route => {
    const url = new URL(route.request().url());
    const resp = await fetch(url.origin + '/api/stream/PLAYERTEST1/hls/v360.m3u8?fixtureHls=1');
    let text = await resp.text();
    const mediaRanges = [...text.matchAll(/#EXT-X-BYTERANGE:([^\n]+)\n(\/api\/stream\/PLAYERTEST1\/fmt\/v360)/g)];
    const liveEdgeRange = mediaRanges.at(-1);
    const partRange = liveEdgeRange ? liveEdgeRange[1] : '';
    text = text.replace('#EXTM3U', [
      '#EXTM3U',
      '#EXT-X-SERVER-CONTROL:CAN-SKIP-UNTIL=12.0,HOLD-BACK=6.0,PART-HOLD-BACK=1.0,CAN-BLOCK-RELOAD=YES',
      '#EXT-X-PART-INF:PART-TARGET=0.33334',
    ].join('\n'));
    const lastSegment = text.lastIndexOf('#EXTINF:');
    text = text.slice(0, lastSegment) + [
      `#EXT-X-PART:DURATION=0.33334,URI="/missing.part.m4s?llpart=missing",BYTERANGE="${partRange}",INDEPENDENT=YES`,
      '#EXTINF:',
    ].join('\n') + text.slice(lastSegment + '#EXTINF:'.length);
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

test('native HLS AES-128 encrypted EXT-X-MAP decrypts initialization before MSE append', async ({ page }) => {
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
    return engine.init().then(() => engine.load('/api/stream/PLAYERTEST1/hls.m3u8?fixtureHls=aes-map'));
  });

  await expect.poll(() => page.evaluate(() => window._playerProvider)).toBe('native-hls');
  await page.evaluate(() => document.getElementById('player').play());
  await page.waitForFunction(() => document.getElementById('player').currentTime > 0, null, { timeout: 10_000 });

  const stats = await page.evaluate(() => window.__player.getStats());
  expect(stats.provider).toBe('native-hls');
  expect(stats.encryptedInitSegmentCount).toBeGreaterThan(0);
  expect(stats.encryptedSegmentCount).toBeGreaterThan(0);
  expect(stats.hlsKeyFetchCount).toBe(1);
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

test('native HLS live fixture starts without rewinding playback or refetching an aborted ABR segment', async ({ page }) => {
  const shakaRequests = await blockShakaScript(page);
  const videoRanges = [];
  await page.route('**/api/stream/PLAYERTEST1/fmt/v720', async route => {
    const range = route.request().headers().range || '';
    if (range && range !== 'bytes=0-790') videoRanges.push(range);
    const response = await route.fetch();
    const delayMs = range === 'bytes=386407-466274' ? 650 : (range ? 350 : 0);
    if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
    await route.fulfill({ response });
  });

  await page.goto('/auth/login');
  await page.setContent('<video id="player" muted playsinline style="width:1280px;height:720px"></video>');
  await page.addScriptTag({ path: 'public/native-player-engine.js' });

  await page.evaluate(() => {
    const video = document.getElementById('player');
    video.muted = true;
    video.canPlayType = () => '';
    window.__postStartWaitingCount = 0;
    window.__firstAdvancingFrameSeen = false;
    window.__largestFrameRewind = 0;
    let lastMediaTime = 0;
    const trackFrames = (_now, metadata) => {
      const mediaTime = Number(metadata.mediaTime) || video.currentTime || 0;
      if (mediaTime > 0) window.__firstAdvancingFrameSeen = true;
      if (lastMediaTime > 0) {
        window.__largestFrameRewind = Math.min(
          window.__largestFrameRewind,
          mediaTime - lastMediaTime
        );
      }
      lastMediaTime = mediaTime;
      if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(trackFrames);
    };
    if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(trackFrames);
    video.addEventListener('waiting', () => {
      if (window.__firstAdvancingFrameSeen) window.__postStartWaitingCount++;
    });

    const engine = new window.PlayerEngine(video, { videoId: 'PLAYERTEST1', streamToken: '' });
    window.__engine = engine;
    window.__player = engine.getPlayer();
    window.__player.configure({
      streaming: {
        bufferingGoal: 4,
        startupBufferGoal: 1,
        maxConcurrentRequests: 3,
      },
    });
    return engine.init()
      .then(() => engine.load('/api/stream/PLAYERTEST1/hls.m3u8?fixtureHls=live&fixtureLiveKey=no-rewind'))
      .then(() => video.play());
  });

  await page.waitForFunction(() => document.getElementById('player').currentTime >= 4.4, null, { timeout: 12_000 });
  const state = await page.evaluate(() => ({
    currentTime: document.getElementById('player').currentTime,
    postStartWaitingCount: window.__postStartWaitingCount,
    largestFrameRewind: window.__largestFrameRewind,
    stats: window.__player.getStats(),
  }));

  expect(state.currentTime).toBeGreaterThanOrEqual(4.4);
  expect(state.postStartWaitingCount).toBe(0);
  expect(state.largestFrameRewind).toBeGreaterThanOrEqual(-0.1);
  expect(state.stats.seekAbortCount).toBe(0);
  expect(state.stats.mediaFetchRetryCount).toBe(0);
  expect(videoRanges.length).toBeGreaterThanOrEqual(2);
  expect(new Set(videoRanges).size).toBe(videoRanges.length);
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

  const monotonic = await page.evaluate(async () => {
    const video = document.getElementById('player');
    video.canPlayType = () => '';
    const key = 'hls-monotonic-' + Date.now() + Math.random();
    const engine = new window.PlayerEngine(video, { videoId: 'PLAYERTEST1', streamToken: '' });
    window.__engine = engine;
    window.__player = engine.getPlayer();
    await engine.init();
    await engine.load('/api/stream/PLAYERTEST1/hls.m3u8?fixtureHls=sliding&fixtureLiveKey=' + key);
    const provider = engine._provider;
    clearTimeout(provider.playlistRefreshTimer);
    const url = provider.mediaPlaylistUrl;
    const olderText = await fetch(url).then(response => response.text());
    const newerText = await fetch(url).then(response => response.text());
    await Promise.resolve(provider._loadMediaPlaylist(newerText, url, provider.activeVariant));
    const afterNewer = {
      sequence: provider.mediaSequence,
      start: provider.liveWindow.start,
      end: provider.liveWindow.end,
    };
    await Promise.resolve(provider._loadMediaPlaylist(olderText, url, provider.activeVariant));
    const result = {
      afterNewer,
      afterOlder: {
        sequence: provider.mediaSequence,
        start: provider.liveWindow.start,
        end: provider.liveWindow.end,
      },
      staleCount: provider.staleManifestResponseCount,
    };
    engine.destroy();
    return result;
  });

  expect(windows[0].endList).toBe(false);
  expect(windows[1].mediaSequence).toBeGreaterThanOrEqual(windows[0].mediaSequence);
  expect(windows[1].liveWindow.start).toBeGreaterThanOrEqual(windows[0].liveWindow.start);
  expect(windows[1].liveWindow.end).toBeGreaterThanOrEqual(windows[0].liveWindow.end);
  expect(monotonic.afterOlder).toEqual(monotonic.afterNewer);
  expect(monotonic.staleCount).toBe(1);
  expect(shakaRequests).toHaveLength(0);
});

test('native HLS sliding live fixture recovers a confirmed origin epoch reset without accepting one stale response', async ({ page }) => {
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const state = await page.evaluate(async () => {
    const hls = window.NativeHlsProviderForTest;
    const playlistUrl = location.origin + '/epoch-live.m3u8';
    const oldVariant = {
      id: 'video',
      url: playlistUrl,
      codecs: 'avc1.42c01f',
      rawCodecs: 'avc1.42c01f',
      active: true,
    };
    const oldSegments = [{
      start: 204,
      end: 206,
      duration: 2,
      mediaSequence: 102,
      discontinuitySequence: 4,
      url: location.origin + '/seg-102.m4s',
      _hlsPlaylistUrl: playlistUrl,
      appended: true,
      state: 'appended',
    }];
    const provider = {
      live: true,
      destroyed: false,
      activeVariant: oldVariant,
      variants: [oldVariant],
      activeAudio: null,
      audioRenditions: [],
      segments: oldSegments,
      initSegment: { url: location.origin + '/init.mp4', range: null },
      videoEndList: false,
      mediaSequence: 102,
      discontinuitySequence: 4,
      discontinuityCount: 0,
      targetDuration: 2,
      liveWindow: { start: 204, end: 206 },
      playlistRefreshCount: 1,
      staleManifestResponseCount: 0,
      playlistCursorByUrl: {
        [playlistUrl]: {
          msn: 102,
          part: -1,
          partial: false,
          discontinuitySequence: 4,
          programDateTimeMs: null,
        },
      },
      playlistResetCandidateByUrl: {},
      playlistEpochByUrl: {},
      playlistEpochResetCount: 0,
      preloadHintDiscardCount: 0,
      _preloadHintSegments: {},
      manifestCompatibilityWarnings: [],
      _syncPresentationState() {},
      _addTimelineRegions() {},
    };
    const media = sequence => `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:2
#EXT-X-MEDIA-SEQUENCE:${sequence}
#EXT-X-MAP:URI="init.mp4"
#EXTINF:2,
seg-${sequence}.m4s`;

    const stale = await Promise.resolve(hls._loadMediaPlaylist.call(provider, media(98), playlistUrl, oldVariant));
    const firstResetEvidence = await Promise.resolve(hls._loadMediaPlaylist.call(provider, media(0), playlistUrl, oldVariant));
    const confirmedReset = await Promise.resolve(hls._loadMediaPlaylist.call(provider, media(1), playlistUrl, oldVariant));
    const nextEpochReload = await Promise.resolve(hls._loadMediaPlaylist.call(provider, media(2), playlistUrl, oldVariant));
    const firstResetSegment = provider.segments[0];
    const sourceBuffer = new EventTarget();
    sourceBuffer.updating = false;
    sourceBuffer.timestampOffset = 0;
    sourceBuffer.appendBuffer = () => queueMicrotask(() => sourceBuffer.dispatchEvent(new Event('updateend')));
    let appendError = '';
    try {
      await hls._appendSegmentData.call(provider, { kind: 'video', sb: sourceBuffer }, firstResetSegment, new ArrayBuffer(1));
    } catch (err) {
      appendError = err.message;
    }
    const backupUrl = location.origin + '/epoch-backup.m3u8';
    const backupVariant = { ...oldVariant, id: 'backup', url: backupUrl };
    provider.activeVariant = backupVariant;
    provider.variants.push(backupVariant);
    const backupReload = await Promise.resolve(hls._loadMediaPlaylist.call(provider, media(3), backupUrl, backupVariant));
    const carriedSegment = provider.segments[0];
    const pdtUrl = location.origin + '/epoch-pdt.m3u8';
    const oldProgramDate = Date.parse('2026-08-03T12:00:00.000Z');
    const pdtProvider = {
      live: true,
      segments: [{
        start: 204,
        end: 206,
        duration: 2,
        mediaSequence: 102,
        discontinuitySequence: 2,
        programDateTimeMs: oldProgramDate,
      }],
      playlistCursorByUrl: {
        [pdtUrl]: {
          msn: 102,
          part: -1,
          partial: false,
          discontinuitySequence: 2,
          programDateTimeMs: oldProgramDate + 2000,
        },
      },
      playlistResetCandidateByUrl: {},
      playlistEpochByUrl: {},
    };
    const pdtParsed = window.NativeDashProviderForTest.parseHlsPlaylist(`#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:2
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-MAP:URI="init.mp4"
#EXT-X-PROGRAM-DATE-TIME:2026-08-03T12:00:02.000Z
#EXTINF:2,
seg-0.m4s`, pdtUrl);
    const pdtAccepted = hls.acceptHlsPlaylistCursor(pdtProvider, pdtUrl, pdtParsed, 'video');
    hls.applyHlsPlaylistEpoch(pdtProvider, pdtUrl, pdtParsed, pdtProvider.segments, 'video');
    return {
      outcomes: [stale, firstResetEvidence, confirmedReset, nextEpochReload, backupReload],
      mediaSequence: provider.mediaSequence,
      cursor: provider.playlistCursorByUrl[playlistUrl],
      resetCount: provider.playlistEpochResetCount,
      resetTrack: provider.lastPlaylistEpochResetTrack,
      resetOffset: provider.lastPlaylistEpochResetOffset,
      epoch: provider.playlistEpochByUrl[playlistUrl],
      backupEpoch: provider.playlistEpochByUrl[backupUrl],
      programDateReset: {
        accepted: pdtAccepted,
        epochReset: !!pdtParsed._hlsEpochReset,
        start: pdtParsed.segments[0].start,
        timestampResolved: Number.isFinite(pdtParsed.segments[0]._hlsEpochTimestampOffset),
        manifestOffset: pdtParsed.segments[0]._hlsEpochManifestOffset,
      },
      staleCount: provider.staleManifestResponseCount,
      appendError,
      appendedTimestampOffset: sourceBuffer.timestampOffset,
      segment: {
        start: carriedSegment.start,
        end: carriedSegment.end,
        mediaSequence: carriedSegment.mediaSequence,
        discontinuity: carriedSegment.discontinuity,
        discontinuitySequence: carriedSegment.discontinuitySequence,
        epoch: carriedSegment._hlsPlaylistEpoch,
        timestampResolved: Number.isFinite(carriedSegment._hlsEpochTimestampOffset),
        manifestOffset: carriedSegment._hlsEpochManifestOffset,
      },
    };
  });

  expect(state.outcomes[0]).toMatchObject({ applied: false, stale: true });
  expect(state.outcomes[1]).toMatchObject({ applied: false, stale: true });
  expect(state.outcomes[2]).toMatchObject({ applied: true, stale: false, advanced: true, epochReset: true, playlistEpoch: 1 });
  expect(state.outcomes[3]).toMatchObject({ applied: true, stale: false, advanced: true, epochReset: false, playlistEpoch: 1 });
  expect(state.outcomes[4]).toMatchObject({ applied: true, stale: false, advanced: true, epochReset: false, playlistEpoch: 1 });
  expect(state.staleCount).toBe(2);
  expect(state.resetCount).toBe(1);
  expect(state.resetTrack).toBe('video');
  expect(state.resetOffset).toBe(204);
  expect(state.appendError).toBe('hls-timestamp-unresolved');
  expect(state.appendedTimestampOffset).toBe(0);
  expect(state.epoch).toMatchObject({ id: 1, timelineOffset: 204, discontinuityOffset: 5, kind: 'video' });
  expect(state.backupEpoch).toMatchObject({ id: 1, timelineOffset: 204, discontinuityOffset: 5, kind: 'video' });
  expect(state.programDateReset).toEqual({ accepted: true, epochReset: true, start: 206, timestampResolved: false, manifestOffset: 206 });
  expect(state.mediaSequence).toBe(3);
  expect(state.cursor).toMatchObject({ msn: 2, part: -1, partial: false, discontinuitySequence: 0 });
  expect(state.segment).toEqual({
    start: 210,
    end: 212,
    mediaSequence: 3,
    discontinuity: false,
    discontinuitySequence: 5,
    epoch: 1,
    timestampResolved: false,
    manifestOffset: 204,
  });
});

test('native HLS sliding live fixture resolves epoch offsets from real fMP4 timestamps through MSE', async ({ page }) => {
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player" muted playsinline></video>');

  const state = await page.evaluate(async () => {
    const hls = window.NativeHlsProviderForTest;
    const playlistUrl = location.origin + '/api/stream/PLAYERTEST1/hls/v360.m3u8?fixtureHls=1';
    const playlistText = await fetch(playlistUrl).then(response => response.text());
    const parsed = window.NativeDashProviderForTest.parseHlsPlaylist(playlistText, playlistUrl);
    const fetchRange = async (item) => {
      const headers = item.range ? { Range: `bytes=${item.range.start}-${item.range.end}` } : {};
      const response = await fetch(item.url, { headers });
      if (!response.ok) throw new Error(`fixture-range-${response.status}`);
      return response.arrayBuffer();
    };
    const initData = await fetchRange(parsed.map);
    const mediaData = await fetchRange(parsed.segments[0]);
    const initTracks = hls.parseMp4InitTrackInfo(initData);
    const videoInit = initTracks.find(item => item.handlerType === 'vide') || initTracks[0];
    const fragmentTiming = hls.parseMp4FragmentTimestamp(mediaData, videoInit.trackId);
    const video = document.getElementById('player');
    const mediaSource = new MediaSource();
    const objectUrl = URL.createObjectURL(mediaSource);
    video.src = objectUrl;
    await new Promise((resolve, reject) => {
      mediaSource.addEventListener('sourceopen', resolve, { once: true });
      mediaSource.addEventListener('error', reject, { once: true });
    });
    const sourceBuffer = mediaSource.addSourceBuffer('video/mp4; codecs="avc1.42c01f"');
    const append = data => new Promise((resolve, reject) => {
      const onEnd = () => { cleanup(); resolve(); };
      const onError = () => { cleanup(); reject(new Error('fixture-append-failed')); };
      const cleanup = () => {
        sourceBuffer.removeEventListener('updateend', onEnd);
        sourceBuffer.removeEventListener('error', onError);
      };
      sourceBuffer.addEventListener('updateend', onEnd);
      sourceBuffer.addEventListener('error', onError);
      sourceBuffer.appendBuffer(data);
    });
    await append(initData);
    await append(mediaData);
    const previousEnd = sourceBuffer.buffered.end(sourceBuffer.buffered.length - 1);
    const desiredStart = previousEnd;
    const segment = {
      ...parsed.segments[0],
      start: desiredStart,
      end: desiredStart + parsed.segments[0].duration,
      _hlsPlaylistEpoch: 1,
      _hlsEpochManifestOffset: 99,
      _hlsEpochTimestampOffset: NaN,
      _hlsPlaylistUrl: playlistUrl,
    };
    const provider = {
      initSegment: parsed.map,
      segments: [segment],
      sb: sourceBuffer,
      isTsPlaylist: false,
      quotaRecoveries: 0,
      hlsInitTimescaleByKey: {},
      hlsFragmentTimestampParseCount: 0,
      hlsFragmentTimestampFallbackCount: 0,
      playlistEpochByUrl: {
        [playlistUrl]: {
          id: 1,
          timelineOffset: 99,
          discontinuityOffset: 1,
          mediaTimestampOffset: null,
          mediaTimestampResolved: false,
          kind: 'video',
        },
      },
    };
    hls.recordHlsInitTimescale(provider, provider, parsed.map, initData);
    await hls._appendSegmentData.call(provider, provider, segment, mediaData);
    const bufferedStart = sourceBuffer.buffered.length ? sourceBuffer.buffered.start(0) : NaN;
    const bufferedEnd = sourceBuffer.buffered.length ? sourceBuffer.buffered.end(sourceBuffer.buffered.length - 1) : NaN;
    const expectedOffset = desiredStart - fragmentTiming.presentationTime / videoInit.timescale;
    const result = {
      timescale: videoInit.timescale,
      decodeTime: fragmentTiming.decodeTime,
      compositionOffset: fragmentTiming.compositionOffset,
      expectedOffset,
      appliedOffset: sourceBuffer.timestampOffset,
      previousEnd,
      bufferedRangeCount: sourceBuffer.buffered.length,
      bufferedStart,
      bufferedEnd,
      parseCount: provider.hlsFragmentTimestampParseCount,
      fallbackCount: provider.hlsFragmentTimestampFallbackCount,
      epoch: provider.playlistEpochByUrl[playlistUrl],
    };
    try { mediaSource.endOfStream(); } catch {}
    URL.revokeObjectURL(objectUrl);
    return result;
  });

  expect(state.timescale).toBeGreaterThan(0);
  expect(state.decodeTime).toBeGreaterThanOrEqual(0);
  expect(state.appliedOffset).toBeCloseTo(state.expectedOffset, 4);
  expect(state.bufferedRangeCount).toBe(1);
  expect(state.bufferedStart).toBeLessThan(state.previousEnd);
  expect(state.bufferedEnd).toBeGreaterThan(state.previousEnd);
  expect(state.parseCount).toBe(1);
  expect(state.fallbackCount).toBe(0);
  expect(state.epoch).toMatchObject({ mediaTimestampResolved: true, mediaTimestampOffset: state.expectedOffset });
});

test('native HLS discontinuity fixture appends the generation init and remaps reset fMP4 timestamps through MSE', async ({ page }) => {
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player" muted playsinline></video>');

  const state = await page.evaluate(async () => {
    const hls = window.NativeHlsProviderForTest;
    const playlistUrl = location.origin + '/api/stream/PLAYERTEST1/hls/v360.m3u8?fixtureHls=1';
    const playlistText = await fetch(playlistUrl).then(response => response.text());
    const parsed = window.NativeDashProviderForTest.parseHlsPlaylist(playlistText, playlistUrl);
    const fetchRange = async (item) => {
      const headers = item.range ? { Range: `bytes=${item.range.start}-${item.range.end}` } : {};
      const response = await fetch(item.url, { headers });
      if (!response.ok) throw new Error(`fixture-range-${response.status}`);
      return response.arrayBuffer();
    };
    const initData = await fetchRange(parsed.map);
    const mediaData = await fetchRange(parsed.segments[0]);
    const initTracks = hls.parseMp4InitTrackInfo(initData);
    const videoInit = initTracks.find(item => item.handlerType === 'vide') || initTracks[0];
    const fragmentTiming = hls.parseMp4FragmentTimestamp(mediaData, videoInit.trackId);
    const video = document.getElementById('player');
    const mediaSource = new MediaSource();
    const objectUrl = URL.createObjectURL(mediaSource);
    video.src = objectUrl;
    await new Promise((resolve, reject) => {
      mediaSource.addEventListener('sourceopen', resolve, { once: true });
      mediaSource.addEventListener('error', reject, { once: true });
    });
    const sourceBuffer = mediaSource.addSourceBuffer('video/mp4; codecs="avc1.42c01f"');
    const append = data => new Promise((resolve, reject) => {
      const onEnd = () => { cleanup(); resolve(); };
      const onError = () => { cleanup(); reject(new Error('fixture-append-failed')); };
      const cleanup = () => {
        sourceBuffer.removeEventListener('updateend', onEnd);
        sourceBuffer.removeEventListener('error', onError);
      };
      sourceBuffer.addEventListener('updateend', onEnd);
      sourceBuffer.addEventListener('error', onError);
      sourceBuffer.appendBuffer(data);
    });
    await append(initData);
    const initialMap = parsed.map;
    const initialMapKey = initialMap.url + (initialMap.range ? `:${initialMap.range.start}-${initialMap.range.end}` : '');
    const resetMap = { ...initialMap, range: initialMap.range ? { ...initialMap.range } : null };
    const first = {
      ...parsed.segments[0],
      _hlsInitSegment: initialMap,
      _hlsPlaylistUrl: playlistUrl,
    };
    let initFetchCount = 0;
    let initRevalidated = false;
    const provider = {
      kind: 'video',
      initSegment: initialMap,
      segments: [first],
      sb: sourceBuffer,
      isTsPlaylist: false,
      quotaRecoveries: 0,
      hlsInitTimescaleByKey: {},
      hlsInitTrackInfoByKey: {},
      hlsTimestampGenerationByKey: {},
      playlistEpochByUrl: {},
      _appendedVideoInitKey: initialMapKey,
      _sourceBufferVideoInitSegment: initialMap,
      _prepareDiscontinuityAppend: hls._prepareDiscontinuityAppend,
      _appendSegmentData: hls._appendSegmentData,
      _fetchRange(url, _range, options) {
        if (url !== resetMap.url) throw new Error('unexpected-generation-init');
        initFetchCount += 1;
        initRevalidated = options?.revalidate === true;
        return Promise.resolve(initData.slice(0));
      },
    };
    hls.assignHlsTimestampGenerations(provider, playlistUrl, { segments: [first], map: initialMap, preloadHints: [] }, 'video');
    provider._appendedVideoInitGenerationKey = first._hlsTimestampGenerationKey;
    hls.recordHlsInitTimescale(provider, provider, initialMap, initData, first._hlsTimestampGenerationKey);
    await hls._appendSegmentData.call(provider, provider, first, mediaData);
    const previousEnd = sourceBuffer.buffered.end(sourceBuffer.buffered.length - 1);
    const second = {
      ...parsed.segments[0],
      start: previousEnd,
      end: previousEnd + parsed.segments[0].duration,
      mediaSequence: parsed.segments[0].mediaSequence + 1,
      discontinuity: true,
      discontinuitySequence: (parsed.segments[0].discontinuitySequence || 0) + 1,
      _hlsInitSegment: resetMap,
      _hlsPlaylistUrl: playlistUrl,
    };
    provider.segments = [first, second];
    hls.assignHlsTimestampGenerations(provider, playlistUrl, { segments: provider.segments, map: initialMap, preloadHints: [] }, 'video');
    await hls._appendSegmentData.call(provider, provider, second, mediaData.slice(0));
    const expectedOffset = second.start - fragmentTiming.presentationTime / videoInit.timescale;
    const generations = Object.values(provider.hlsTimestampGenerationByKey);
    const result = {
      expectedOffset,
      appliedOffset: sourceBuffer.timestampOffset,
      previousEnd,
      bufferedRangeCount: sourceBuffer.buffered.length,
      bufferedEnd: sourceBuffer.buffered.end(sourceBuffer.buffered.length - 1),
      initFetchCount,
      initRevalidated,
      initMapSwitchCount: provider.hlsInitMapSwitchCount || 0,
      initGenerationRefreshCount: provider.hlsInitGenerationRefreshCount || 0,
      fragmentParseCount: provider.hlsFragmentTimestampParseCount || 0,
      generationResolutionCount: provider.hlsTimestampGenerationResolutionCount || 0,
      discontinuityResolutionCount: provider.hlsDiscontinuityTimestampResolutionCount || 0,
      discontinuityFallbackCount: provider.hlsDiscontinuityTimestampFallbackCount || 0,
      generations,
      lastGenerationKey: provider.lastHlsTimestampGenerationKey,
    };
    try { mediaSource.endOfStream(); } catch {}
    URL.revokeObjectURL(objectUrl);
    return result;
  });

  expect(state.appliedOffset).toBeCloseTo(state.expectedOffset, 4);
  expect(state.bufferedRangeCount).toBe(1);
  expect(state.bufferedEnd).toBeGreaterThan(state.previousEnd);
  expect(state.initFetchCount).toBe(1);
  expect(state.initRevalidated).toBe(true);
  expect(state.initMapSwitchCount).toBe(0);
  expect(state.initGenerationRefreshCount).toBe(1);
  expect(state.fragmentParseCount).toBe(2);
  expect(state.generationResolutionCount).toBe(2);
  expect(state.discontinuityResolutionCount).toBe(1);
  expect(state.discontinuityFallbackCount).toBe(0);
  expect(state.generations).toHaveLength(2);
  expect(state.generations[1]).toMatchObject({
    discontinuity: true,
    mediaTimestampResolved: true,
    mediaTimestampOffset: state.expectedOffset,
    previousKey: state.generations[0].key,
  });
  expect(state.lastGenerationKey).toBe(state.generations[1].key);
});

test('native HLS discontinuity fixture refetches init when generation timing cannot initially resolve', async ({ page }) => {
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player" muted playsinline></video>');

  const state = await page.evaluate(async () => {
    const hls = window.NativeHlsProviderForTest;
    const playlistUrl = location.origin + '/api/stream/PLAYERTEST1/hls/v360.m3u8?fixtureHls=1';
    const parsed = window.NativeDashProviderForTest.parseHlsPlaylist(
      await fetch(playlistUrl).then(response => response.text()),
      playlistUrl,
    );
    const fetchRange = async item => {
      const headers = item.range ? { Range: `bytes=${item.range.start}-${item.range.end}` } : {};
      return fetch(item.url, { headers }).then(response => response.arrayBuffer());
    };
    const initData = await fetchRange(parsed.map);
    const mediaData = await fetchRange(parsed.segments[0]);
    const mediaSource = new MediaSource();
    const video = document.getElementById('player');
    const objectUrl = URL.createObjectURL(mediaSource);
    video.src = objectUrl;
    await new Promise((resolve, reject) => {
      mediaSource.addEventListener('sourceopen', resolve, { once: true });
      mediaSource.addEventListener('error', reject, { once: true });
    });
    const sourceBuffer = mediaSource.addSourceBuffer('video/mp4; codecs="avc1.42c01f"');
    const append = data => new Promise((resolve, reject) => {
      const end = () => { cleanup(); resolve(); };
      const error = () => { cleanup(); reject(new Error('fixture-append-failed')); };
      const cleanup = () => {
        sourceBuffer.removeEventListener('updateend', end);
        sourceBuffer.removeEventListener('error', error);
      };
      sourceBuffer.addEventListener('updateend', end);
      sourceBuffer.addEventListener('error', error);
      sourceBuffer.appendBuffer(data);
    });
    await append(initData);
    const segment = { ...parsed.segments[0], _hlsInitSegment: parsed.map, _hlsPlaylistUrl: playlistUrl };
    let initFetchCount = 0;
    let initRevalidated = false;
    const mapKey = parsed.map.url + (parsed.map.range ? `:${parsed.map.range.start}-${parsed.map.range.end}` : '');
    const provider = {
      kind: 'video',
      initSegment: parsed.map,
      segments: [segment],
      sb: sourceBuffer,
      isTsPlaylist: false,
      quotaRecoveries: 0,
      hlsInitTimescaleByKey: {},
      hlsInitTrackInfoByKey: {},
      hlsTimestampGenerationByKey: {},
      playlistEpochByUrl: {},
      _appendedVideoInitKey: mapKey,
      _sourceBufferVideoInitSegment: parsed.map,
      _prepareDiscontinuityAppend: hls._prepareDiscontinuityAppend,
      _refreshHlsGenerationInit: hls._refreshHlsGenerationInit,
      _appendSegmentData: hls._appendSegmentData,
      _fetchRange(_url, _range, options) {
        initFetchCount += 1;
        initRevalidated = options?.revalidate === true;
        return Promise.resolve(initData.slice(0));
      },
    };
    hls.assignHlsTimestampGenerations(provider, playlistUrl, { segments: [segment], map: parsed.map, preloadHints: [] }, 'video');
    provider._appendedVideoInitGenerationKey = segment._hlsTimestampGenerationKey;
    await hls._appendSegmentData.call(provider, provider, segment, mediaData);
    const result = {
      initFetchCount,
      initRevalidated,
      retryCount: provider.hlsTimestampResolutionRetryCount || 0,
      failureCount: provider.hlsTimestampResolutionFailureCount || 0,
      parseCount: provider.hlsFragmentTimestampParseCount || 0,
      bufferedEnd: sourceBuffer.buffered.end(sourceBuffer.buffered.length - 1),
    };
    try { mediaSource.endOfStream(); } catch {}
    URL.revokeObjectURL(objectUrl);
    return result;
  });

  expect(state.initFetchCount).toBe(1);
  expect(state.initRevalidated).toBe(true);
  expect(state.retryCount).toBe(1);
  expect(state.failureCount).toBe(1);
  expect(state.parseCount).toBe(1);
  expect(state.bufferedEnd).toBeGreaterThan(0);
});

test('native HLS sliding live fixture holds split video and audio epoch refreshes until both tracks advance', async ({ page }) => {
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const state = await page.evaluate(async () => {
    const hls = window.NativeHlsProviderForTest;
    const videoUrl = location.origin + '/atomic-video.m3u8';
    const audioUrl = location.origin + '/atomic-audio.m3u8';
    const variant = { id: 'video', url: videoUrl, codecs: 'avc1.42c01f', rawCodecs: 'avc1.42c01f', active: true };
    const audio = {
      id: 'audio',
      kind: 'audio',
      url: audioUrl,
      codecs: 'mp4a.40.2',
      active: true,
      segments: [{ start: 204, end: 206, duration: 2, mediaSequence: 102, discontinuitySequence: 0, url: '/old-audio.m4s', _hlsPlaylistUrl: audioUrl }],
      initSegment: { url: '/audio-init.mp4', range: null },
      targetDuration: 2,
      endList: false,
    };
    const provider = {
      live: true,
      destroyed: false,
      activeVariant: variant,
      variants: [variant],
      activeAudio: audio,
      audioRenditions: [audio],
      segments: [{ start: 204, end: 206, duration: 2, mediaSequence: 102, discontinuitySequence: 0, url: '/old-video.m4s', _hlsPlaylistUrl: videoUrl }],
      initSegment: { url: '/video-init.mp4', range: null },
      audioSegments: audio.segments,
      audioInitSegment: audio.initSegment,
      videoEndList: false,
      audioEndList: false,
      mediaSequence: 102,
      discontinuitySequence: 0,
      discontinuityCount: 0,
      targetDuration: 2,
      liveWindow: { start: 204, end: 206 },
      playlistRefreshCount: 1,
      playlistRefreshGeneration: 0,
      playlistCursorByUrl: {
        [videoUrl]: { msn: 102, part: -1, partial: false, discontinuitySequence: 0, programDateTimeMs: null },
        [audioUrl]: { msn: 102, part: -1, partial: false, discontinuitySequence: 0, programDateTimeMs: null },
      },
      playlistResetCandidateByUrl: {
        [videoUrl]: { cursor: { msn: 0, part: -1, partial: false, discontinuitySequence: 0, programDateTimeMs: null } },
      },
      playlistEpochByUrl: {},
      playlistEpochResetCount: 0,
      playlistEpochHoldCount: 0,
      manifestCompatibilityWarnings: [],
      _preloadHintSegments: {},
      engine: { _player: { config: { abr: { enabled: true } }, emit() {} } },
      _refreshContentSteering() { this.refreshCycle = (this.refreshCycle || 0) + 1; return Promise.resolve(false); },
      _applyContentSteeringToActiveVariant() { return null; },
      _fetchReloadPlaylist(url) {
        const sequence = this.refreshCycle === 1
          ? (url === videoUrl ? 1 : 0)
          : (url === videoUrl ? 2 : 1);
        return Promise.resolve(`#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:${sequence}\n#EXT-X-MAP:URI="${url.includes('video') ? 'video' : 'audio'}-init.mp4"\n#EXTINF:2,\n${url.includes('video') ? 'video' : 'audio'}-${sequence}.m4s`);
      },
      _loadMediaPlaylist: hls._loadMediaPlaylist,
      _loadAudioPlaylist: hls._loadAudioPlaylist,
      _syncPresentationState() {},
      _addTimelineRegions() {},
      _tick() {},
    };

    const first = await hls._refreshMediaPlaylist.call(provider, 'live');
    const afterFirst = {
      videoSequence: provider.segments[0].mediaSequence,
      audioSequence: provider.activeAudio.segments[0].mediaSequence,
      cursorVideo: provider.playlistCursorByUrl[videoUrl].msn,
      cursorAudio: provider.playlistCursorByUrl[audioUrl].msn,
      candidateVideo: provider.playlistResetCandidateByUrl[videoUrl].cursor.msn,
      candidateAudio: provider.playlistResetCandidateByUrl[audioUrl].cursor.msn,
      resetCount: provider.playlistEpochResetCount,
      holdCount: provider.playlistEpochHoldCount,
    };
    const second = await hls._refreshMediaPlaylist.call(provider, 'live');
    return {
      first,
      afterFirst,
      second,
      final: {
        videoSequence: provider.segments[0].mediaSequence,
        audioSequence: provider.activeAudio.segments[0].mediaSequence,
        videoStart: provider.segments[0].start,
        audioStart: provider.activeAudio.segments[0].start,
        resetCount: provider.playlistEpochResetCount,
        holdCount: provider.playlistEpochHoldCount,
        holdReason: provider.lastPlaylistEpochHoldReason,
      },
    };
  });

  expect(state.first).toMatchObject({ applied: false, stale: true, epochHeld: true });
  expect(state.afterFirst).toEqual({
    videoSequence: 102,
    audioSequence: 102,
    cursorVideo: 102,
    cursorAudio: 102,
    candidateVideo: 1,
    candidateAudio: 0,
    resetCount: 0,
    holdCount: 1,
  });
  expect(state.second).toMatchObject({ applied: true, stale: false });
  expect(state.second.video).toMatchObject({ epochReset: true });
  expect(state.second.audio).toMatchObject({ epochReset: true });
  expect(state.final).toEqual({
    videoSequence: 2,
    audioSequence: 1,
    videoStart: 206,
    audioStart: 206,
    resetCount: 2,
    holdCount: 1,
    holdReason: '',
  });
});

test('native HLS stages split-rendition manifests until the delayed sibling is ready', async ({ page }) => {
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const state = await page.evaluate(async () => {
    const hls = window.NativeHlsProviderForTest;
    const videoUrl = location.origin + '/staged-video.m3u8';
    const audioUrl = location.origin + '/staged-audio.m3u8';
    const variant = { id: 'video', url: videoUrl, codecs: 'avc1.42c01f', rawCodecs: 'avc1.42c01f', active: true };
    const audio = {
      id: 'audio',
      kind: 'audio',
      url: audioUrl,
      codecs: 'mp4a.40.2',
      active: true,
      segments: [{ start: 200, end: 202, duration: 2, mediaSequence: 100, discontinuitySequence: 0, url: '/old-audio.m4s', _hlsPlaylistUrl: audioUrl }],
      initSegment: { url: '/audio-init.mp4', range: null },
      targetDuration: 2,
      endList: false,
    };
    let resolveAudio;
    const observations = [];
    const playlist = (kind, sequence) => `#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:${sequence}\n#EXT-X-MAP:URI="${kind}-init.mp4"\n#EXTINF:2,\n${kind}-${sequence}.m4s`;
    const provider = {
      live: true,
      destroyed: false,
      activeVariant: variant,
      variants: [variant],
      activeAudio: audio,
      audioRenditions: [audio],
      segments: [{ start: 200, end: 202, duration: 2, mediaSequence: 100, discontinuitySequence: 0, url: '/old-video.m4s', _hlsPlaylistUrl: videoUrl }],
      initSegment: { url: '/video-init.mp4', range: null },
      audioSegments: audio.segments,
      audioInitSegment: audio.initSegment,
      videoEndList: false,
      audioEndList: false,
      mediaSequence: 100,
      discontinuitySequence: 0,
      discontinuityCount: 0,
      targetDuration: 2,
      liveWindow: { start: 200, end: 202 },
      playlistRefreshCount: 1,
      playlistRefreshGeneration: 0,
      playlistCursorByUrl: {
        [videoUrl]: { msn: 100, part: -1, partial: false, discontinuitySequence: 0, programDateTimeMs: null },
        [audioUrl]: { msn: 100, part: -1, partial: false, discontinuitySequence: 0, programDateTimeMs: null },
      },
      playlistResetCandidateByUrl: {},
      playlistEpochByUrl: {},
      manifestCompatibilityWarnings: [],
      _preloadHintSegments: {},
      engine: { _player: { config: { abr: { enabled: true } }, emit() {} } },
      _refreshContentSteering() { return Promise.resolve(false); },
      _applyContentSteeringToActiveVariant() { return null; },
      _fetchReloadPlaylist(url) {
        if (url === videoUrl) return Promise.resolve(playlist('video', 101));
        return new Promise(resolve => { resolveAudio = resolve; });
      },
      _loadMediaPlaylist: hls._loadMediaPlaylist,
      _loadAudioPlaylist: hls._loadAudioPlaylist,
      _syncPresentationState() {},
      _addTimelineRegions() {},
      _tick() {
        observations.push({
          videoSequence: this.segments[0].mediaSequence,
          audioSequence: this.activeAudio.segments[0].mediaSequence,
          commitInProgress: !!this.playlistManifestCommitInProgress,
        });
      },
    };

    const refresh = hls._refreshMediaPlaylist.call(provider, 'live');
    for (let i = 0; i < 20 && !resolveAudio; i += 1) await new Promise(resolve => setTimeout(resolve, 0));
    provider._tick();
    const beforeAudio = {
      videoSequence: provider.segments[0].mediaSequence,
      audioSequence: provider.activeAudio.segments[0].mediaSequence,
      refreshCount: provider.playlistRefreshCount,
      stageCount: provider.playlistManifestStageCount || 0,
      commitCount: provider.playlistManifestCommitCount || 0,
    };
    resolveAudio(playlist('audio', 101));
    const outcome = await refresh;
    return {
      beforeAudio,
      observations,
      outcome,
      final: {
        videoSequence: provider.segments[0].mediaSequence,
        audioSequence: provider.activeAudio.segments[0].mediaSequence,
        refreshCount: provider.playlistRefreshCount,
        stageCount: provider.playlistManifestStageCount,
        commitCount: provider.playlistManifestCommitCount,
        commitGeneration: provider.playlistManifestCommitGeneration,
        discardCount: provider.playlistManifestDiscardCount || 0,
        commitInProgress: !!provider.playlistManifestCommitInProgress,
      },
    };
  });

  expect(state.beforeAudio).toEqual({
    videoSequence: 100,
    audioSequence: 100,
    refreshCount: 1,
    stageCount: 0,
    commitCount: 0,
  });
  expect(state.observations).toEqual([
    { videoSequence: 100, audioSequence: 100, commitInProgress: false },
    { videoSequence: 101, audioSequence: 101, commitInProgress: false },
  ]);
  expect(state.outcome).toMatchObject({ applied: true, stale: false, partial: false });
  expect(state.final).toEqual({
    videoSequence: 101,
    audioSequence: 101,
    refreshCount: 2,
    stageCount: 1,
    commitCount: 1,
    commitGeneration: 1,
    discardCount: 0,
    commitInProgress: false,
  });
});

test('native HLS manifest commit barrier blocks scheduler fetch and append work', async ({ page }) => {
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const state = await page.evaluate(() => {
    const hls = window.NativeHlsProviderForTest;
    const calls = { fetch: 0, append: 0, schedule: 0 };
    const segment = { start: 0, end: 2, duration: 2, url: '/segment.m4s', state: '' };
    const track = { id: 'video', kind: 'video', sb: {}, segments: [segment], _appending: false };
    const provider = {
      destroyed: false,
      playlistManifestCommitInProgress: true,
      sb: track.sb,
      audioSb: null,
      segments: [segment],
      activeRanges: {},
      video: { currentTime: 0 },
      _fetchRange() { calls.fetch += 1; return Promise.resolve(new ArrayBuffer(1)); },
      _appendSegmentData() { calls.append += 1; return Promise.resolve(); },
      _mediaTracks() { return [track]; },
      _buildSegmentCandidates() { calls.schedule += 1; return [{ track, seg: segment }]; },
      _maxConcurrentMediaRequests() { return 1; },
    };
    return {
      tick: hls._tick.call(provider, true),
      schedule: hls._scheduleMediaRequests.call(provider, 4),
      fetch: hls._startSegmentFetch.call(provider, track, segment),
      append: hls._drainAppendQueue.call(provider, track),
      calls,
      segmentState: segment.state,
    };
  });

  expect(state).toEqual({
    schedule: undefined,
    fetch: false,
    append: false,
    calls: { fetch: 0, append: 0, schedule: 0 },
    segmentState: '',
  });
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

  const result = await page.evaluate(async () => {
    window.__nativeTsTransmuxerFactory = () => Promise.reject(new Error('hls-first-party-ts-transmuxer-unavailable'));
    const video = document.getElementById('player');
    video.canPlayType = () => '';
    const engine = new window.PlayerEngine(video, { videoId: 'TESTVIDEO01', streamToken: 'test-token' });
    window.__engine = engine;
    window.__player = engine.getPlayer();
    await engine.init();
    let loadError = null;
    try { await engine.load('/unsupported-ts.m3u8'); } catch (err) {
      loadError = { message: err.message, nativeTerminal: !!err.nativeTerminal, phase: err.phase };
    }
    return { loadError, stats: engine.getPlayer().getStats() };
  });
  const { stats } = result;

  expect(shakaRequests).toHaveLength(0);
  expect(result.loadError).toEqual({ message: 'hls-first-party-ts-transmuxer-unavailable', nativeTerminal: true, phase: 'load' });
  expect(stats.provider).toBe('native-hls');
  expect(stats.mode).toBe('hls');
  expect(stats.fallbackReason).toBe('');
  expect(stats.lastError).toBe('hls-first-party-ts-transmuxer-unavailable');
  expect(stats.fatalError).toBe('hls-first-party-ts-transmuxer-unavailable');
  expect(stats.nativeUnsupportedReason).toBe('hls-first-party-ts-transmuxer-unavailable');
  expect(stats.terminalErrorCount).toBe(1);
  expect(stats.terminalErrorPhase).toBe('load');
  expect(stats.providerTerminalQuiesced).toBe(true);
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
    const segment = { start: 0, end: 2, url: '/broken-segment.ts', state: 'fetched', _data: new Uint8Array([0]).buffer };
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

test('native HLS MPEG-TS extensionless fixture detects its container from media bytes', async ({ page }) => {
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
    return engine.init().then(() => engine.load('/api/stream/PLAYERTEST1/hls.m3u8?fixtureHls=ts-extensionless'));
  });

  await expect.poll(() => page.evaluate(() => window._playerProvider)).toBe('native-hls');
  await page.evaluate(() => { document.getElementById('player').play().catch(() => {}); });
  await page.waitForFunction(() => document.getElementById('player').currentTime > 0, null, { timeout: 10_000 });

  const stats = await page.evaluate(() => window.__player.getStats());
  expect(stats.transmuxerProvider).toBe('first-party-ts');
  expect(stats.transmuxedVideoSegmentCount).toBeGreaterThan(0);
  expect(stats.hlsContainerDetectionCount).toBeGreaterThan(0);
  expect(stats.hlsContainerMismatchCount).toBe(0);
  expect(stats.fallbackReason).toBe('');
  expect(shakaRequests).toHaveLength(0);
});

test('native HLS MPEG-TS mixed-container fixture transitions from fMP4 at a discontinuity', async ({ page }) => {
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
    window.__player.configure({ streaming: { bufferingGoal: 8, startupBufferGoal: 1, maxConcurrentRequests: 1 } });
    return engine.init().then(() => engine.load('/api/stream/PLAYERTEST1/hls.m3u8?fixtureHls=mixed-container'));
  });

  await expect.poll(() => page.evaluate(() => window._playerProvider)).toBe('native-hls');
  await page.evaluate(() => { document.getElementById('player').play().catch(() => {}); });
  await page.waitForFunction(() => document.getElementById('player').currentTime > 2.5, null, { timeout: 12_000 });

  const stats = await page.evaluate(() => window.__player.getStats());
  expect(stats.transmuxerProvider).toBe('first-party-ts');
  expect(stats.transmuxedVideoSegmentCount).toBeGreaterThan(0);
  expect(stats.hlsContainerDetectionCount).toBeGreaterThanOrEqual(2);
  expect(stats.hlsContainerMismatchCount).toBe(0);
  expect(stats.hlsTransmuxedTimestampResolutionCount).toBeGreaterThan(0);
  expect(stats.discontinuityCount).toBe(1);
  expect(stats.fallbackReason).toBe('');
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
    window.__postStartWaitingCount = 0;
    video.addEventListener('waiting', () => {
      if (video.currentTime > 0) window.__postStartWaitingCount++;
    });
    const engine = new window.PlayerEngine(video, { videoId: 'PLAYERTEST1', streamToken: '' });
    window.__engine = engine;
    window.__player = engine.getPlayer();
    window.__player.configure({ streaming: { bufferingGoal: 2, startupBufferGoal: 1, maxConcurrentRequests: 1 } });
    return engine.init().then(() => engine.load('/api/stream/PLAYERTEST1/hls.m3u8?fixtureHls=ts-muxed'));
  });

  await expect.poll(() => page.evaluate(() => window._playerProvider)).toBe('native-hls');
  await page.evaluate(() => { document.getElementById('player').play().catch(() => {}); });
  await page.waitForFunction(() => document.getElementById('player').currentTime > 1.5, null, { timeout: 10_000 });

  const { stats, postStartWaitingCount } = await page.evaluate(() => ({
    stats: window.__player.getStats(),
    postStartWaitingCount: window.__postStartWaitingCount,
  }));
  expect(stats.provider).toBe('native-hls');
  expect(stats.muxedTsAudio).toBe(true);
  expect(stats.transmuxerProvider).toBe('first-party-ts');
  expect(stats.transmuxedVideoSegmentCount).toBeGreaterThan(0);
  expect(stats.transmuxedAudioSegmentCount).toBeGreaterThan(0);
  expect(stats.hlsTsSharedDemuxCount).toBeGreaterThan(0);
  expect(stats.hlsTsTimelineGenerationCount).toBeGreaterThan(0);
  expect(stats.hlsTsInitAppendCount).toBe(2);
  expect(stats.hlsTransmuxedTimestampResolutionCount).toBeGreaterThanOrEqual(2);
  expect(postStartWaitingCount).toBe(0);
  expect(stats.fallbackReason).toBe('');
  await expectNativePlayback(page, { provider: 'native-hls', mode: 'hls', transmuxerProvider: 'first-party-ts' });
  expect(shakaRequests).toHaveLength(0);
});

test('native HLS MPEG-TS preserves B-frame timing and muxed A/V skew through MSE', async ({ page }) => {
  const shakaRequests = [];
  page.on('request', request => {
    if (request.url().includes('/vendor/shaka/shaka-player.compiled.js')) shakaRequests.push(request.url());
  });

  await page.goto('/auth/login');
  await page.setContent('<video id="player" muted playsinline style="width:640px;height:360px"></video>');
  await page.addScriptTag({ path: 'public/native-player-engine.js' });

  await page.evaluate(() => {
    const video = document.getElementById('player');
    video.muted = true;
    video.canPlayType = () => '';
    window.__timelineWaitingCount = 0;
    video.addEventListener('waiting', () => {
      if (video.currentTime > 0) window.__timelineWaitingCount++;
    });
    const engine = new window.PlayerEngine(video, { videoId: 'PLAYERTEST1', streamToken: '' });
    window.__engine = engine;
    window.__player = engine.getPlayer();
    window.__player.configure({ streaming: { bufferingGoal: 3, startupBufferGoal: 1, maxConcurrentRequests: 1 } });
    return engine.init().then(() => engine.load('/api/stream/PLAYERTEST1/hls.m3u8?fixtureHls=ts-timeline'));
  });

  await expect.poll(() => page.evaluate(() => window._playerProvider)).toBe('native-hls');
  await page.evaluate(() => { document.getElementById('player').play().catch(() => {}); });
  await page.waitForFunction(() => document.getElementById('player').currentTime > 1.5, null, { timeout: 12_000 });

  const { stats, waitingCount } = await page.evaluate(() => ({
    stats: window.__player.getStats(),
    waitingCount: window.__timelineWaitingCount,
  }));
  expect(stats.provider).toBe('native-hls');
  expect(stats.muxedTsAudio).toBe(true);
  expect(stats.hlsTsSharedDemuxCount).toBeGreaterThan(0);
  expect(stats.hlsTsCompositionOffsetSampleCount).toBeGreaterThan(0);
  expect(stats.hlsTsMaxCompositionOffsetMs).toBeGreaterThan(0);
  expect(Math.abs(stats.hlsTsMuxedAvStartOffsetMs)).toBeGreaterThan(50);
  expect(stats.hlsTsInitAppendCount).toBe(2);
  expect(waitingCount).toBe(0);
  expect(stats.fallbackReason).toBe('');
  expect(shakaRequests).toHaveLength(0);
});

test('native HLS MPEG-TS remaps an unbuffered backward seek within one timestamp generation', async ({ page }) => {
  const segmentRequests = [];
  const shakaRequests = [];
  page.on('request', request => {
    if (request.url().includes('fixtureTs=seek-')) segmentRequests.push(request.url());
    if (request.url().includes('/vendor/shaka/shaka-player.compiled.js')) shakaRequests.push(request.url());
  });

  await page.goto('/auth/login');
  await page.setContent('<video id="player" muted playsinline style="width:640px;height:360px"></video>');
  await page.addScriptTag({ path: 'public/native-player-engine.js' });

  await page.evaluate(() => {
    const video = document.getElementById('player');
    video.muted = true;
    video.canPlayType = () => '';
    const engine = new window.PlayerEngine(video, { videoId: 'PLAYERTEST1', streamToken: '' });
    window.__engine = engine;
    window.__player = engine.getPlayer();
    window.__player.configure({
      streaming: {
        bufferingGoal: 3,
        startupBufferGoal: 1,
        seekBufferGoal: 2,
        maxConcurrentRequests: 1,
      },
    });
    return engine.init().then(() => engine.load('/api/stream/PLAYERTEST1/hls.m3u8?fixtureHls=ts-seek', 7));
  });

  await expect.poll(() => page.evaluate(() => window._playerProvider)).toBe('native-hls');
  await page.evaluate(() => { document.getElementById('player').play().catch(() => {}); });
  await page.waitForFunction(() => document.getElementById('player').currentTime > 7.2, null, { timeout: 12_000 });
  expect(segmentRequests.filter(url => url.includes('fixtureTs=seek-0'))).toHaveLength(0);
  expect(segmentRequests.filter(url => url.includes('fixtureTs=seek-1')).length).toBeGreaterThan(0);

  await page.evaluate(() => {
    window.__player.beginSeek(0.5);
    window.__player.commitSeek(0.5);
    document.getElementById('player').play().catch(() => {});
  });
  await page.waitForFunction(() => {
    const video = document.getElementById('player');
    if (!(video.currentTime > 0.8 && video.currentTime < 5)) return false;
    for (let index = 0; index < video.buffered.length; index++) {
      if (video.buffered.start(index) <= 0.5 && video.buffered.end(index) > 1) return true;
    }
    return false;
  }, null, { timeout: 12_000 });

  const stats = await page.evaluate(() => window.__player.getStats());
  expect(segmentRequests.filter(url => url.includes('fixtureTs=seek-0')).length).toBeGreaterThan(0);
  expect(stats.provider).toBe('native-hls');
  expect(stats.hlsTsOutOfOrderSegmentCount).toBeGreaterThan(0);
  expect(stats.hlsTsTimelineGenerationCount).toBe(1);
  expect(stats.fallbackReason).toBe('');
  expect(stats.fatalError).toBe('');
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

  await expect.poll(async () => {
    const height = await page.evaluate(() => window.__player.getActiveVariantTrack()?.height);
    return height;
  }).toBe(240);
  const stats = await page.evaluate(() => window.__player.getStats());
  expect(stats.provider).toBe('native-hls');
  expect(stats.lastSwitchReason).toBe('manual');
  expect(stats.fallbackReason).toBe('');
  await expectFirstPartyNativePlayback(page, { provider: 'native-hls', mode: 'hls' });
  expect(shakaRequests).toHaveLength(0);
});

test('native ABR upgrades HLS seek playback to 720p without a decode error', async ({ page }) => {
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
    window.__player.configure({
      streaming: {
        bufferingGoal: 4,
        startupBufferGoal: 1,
        seekBufferGoal: 1,
        maxConcurrentRequests: 3,
      },
    });
    return engine.init()
      .then(() => engine.load('/api/stream/PLAYERTEST1/hls.m3u8?fixtureHls=benchmark-groups'))
      .then(() => video.play());
  });

  await page.waitForFunction(() => document.getElementById('player').currentTime > 0, null, { timeout: 10_000 });
  await page.evaluate(() => window.__player.commitSeek(4.5));
  await page.waitForFunction(() => {
    const video = document.getElementById('player');
    return video.currentTime >= 4.4 && video.videoHeight >= 720;
  }, null, { timeout: 10_000 });

  const state = await page.evaluate(() => {
    const video = document.getElementById('player');
    return {
      mediaError: video.error && (video.error.message || video.error.code),
      width: video.videoWidth,
      height: video.videoHeight,
      stats: window.__player.getStats(),
    };
  });

  expect(state.mediaError).toBeFalsy();
  expect(state.width).toBeGreaterThanOrEqual(1280);
  expect(state.height).toBeGreaterThanOrEqual(720);
  expect(state.stats.activeVariant.height).toBe(720);
  expect(state.stats.bandwidthTimeToFirstByteEstimateMs).toBeGreaterThan(0);
  expect(state.stats.seekBufferPending).toBe(false);
  expect(state.stats.fatalError).toBe('');
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

test('native HLS media groups expose cancellable rapid alternate-audio transitions', async ({ page }) => {
  await page.goto('/auth/login');
  await setPlayerContent(page, '<video id="player"></video>');

  const state = await page.evaluate(async () => {
    const hls = window.NativeHlsProviderForTest;
    const oldAudio = { id: 'audio-en', language: 'en', codecs: 'mp4a.40.2', active: true };
    const firstAudio = { id: 'audio-es', language: 'es', codecs: 'mp4a.40.2', url: '/audio-es.m3u8', active: false };
    const latestAudio = { id: 'audio-fr', language: 'fr', codecs: 'mp4a.40.2', url: '/audio-fr.m3u8', active: false };
    const emitted = [];
    const requestSignals = [];
    let rejectedOnAbort = 0;
    let rollbackCount = 0;
    let flushedTrack = null;
    const provider = {
      destroyed: false,
      trackTransitionGeneration: 0,
      trackTransitionInFlight: null,
      playlistRefreshGeneration: 0,
      pendingAudioTrackSwitch: null,
      pendingManualVariantSwitch: null,
      variantSwitchInFlight: false,
      activeVariant: { id: 'video', codecs: 'avc1.42c01f', active: true },
      variants: [],
      activeAudio: oldAudio,
      audioRenditions: [oldAudio, firstAudio, latestAudio],
      segments: [],
      audioSegments: [],
      sb: null,
      audioSb: null,
      playlistCursorByUrl: {},
      playlistResetCandidateByUrl: {},
      playlistEpochByUrl: {},
      engine: {
        _player: {
          config: { abr: { enabled: true } },
          emit(name) { emitted.push(name); },
        },
      },
      _abortRequests() { return 0; },
      _beginTrackTransition: hls._beginTrackTransition,
      _isTrackTransitionCurrent: hls._isTrackTransitionCurrent,
      _ownsTrackTransition: hls._ownsTrackTransition,
      _finishTrackTransition: hls._finishTrackTransition,
      _cancelTrackTransitionForViewerIntent: hls._cancelTrackTransitionForViewerIntent,
      _fetchPlaylistText(url, options) {
        const signal = options && options.signal;
        requestSignals.push({ url, signal });
        return new Promise((resolve, reject) => {
          const abort = () => {
            rejectedOnAbort++;
            reject(new DOMException('Aborted', 'AbortError'));
          };
          if (signal.aborted) abort();
          else signal.addEventListener('abort', abort, { once: true });
        });
      },
      _rollbackTrackTransition() {
        rollbackCount++;
        this.activeAudio = oldAudio;
        this.audioRenditions.forEach(item => { item.active = item === oldAudio; });
        return Promise.resolve(true);
      },
      _flushPendingTrackSwitch() {
        flushedTrack = this.pendingAudioTrackSwitch;
        this.pendingAudioTrackSwitch = null;
        return true;
      },
      _tick() {},
    };

    hls.selectAudioTrack.call(provider, { id: firstAudio.id });
    const firstSignal = requestSignals[0] && requestSignals[0].signal;
    hls.selectAudioTrack.call(provider, { id: latestAudio.id });
    for (let i = 0; i < 10 && provider.trackTransitionInFlight; i++) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    return {
      requestCount: requestSignals.length,
      firstRequestUrl: requestSignals[0] && requestSignals[0].url,
      signalPresent: firstSignal instanceof AbortSignal,
      signalAborted: !!(firstSignal && firstSignal.aborted),
      rejectedOnAbort,
      rollbackCount,
      flushedTrack,
      activeAudio: provider.activeAudio.id,
      activeFlags: provider.audioRenditions.map(item => item.active),
      transitionInFlight: !!provider.trackTransitionInFlight,
      emitted,
    };
  });

  expect(state).toMatchObject({
    requestCount: 1,
    firstRequestUrl: '/audio-es.m3u8',
    signalPresent: true,
    signalAborted: true,
    rejectedOnAbort: 1,
    rollbackCount: 1,
    flushedTrack: { id: 'audio-fr', language: 'fr' },
    activeAudio: 'audio-en',
    activeFlags: [true, false, false],
    transitionInFlight: false,
    emitted: [],
  });
});

test('native HLS media groups expose concurrent startup and refresh playlist requests', async ({ page }) => {
  await page.goto('/auth/login');
  await page.setContent('<video id="player"></video>');
  await page.addScriptTag({ path: 'public/native-player-engine.js' });

  const state = await page.evaluate(async () => {
    const requested = [];
    const parsed = [];
    const resolvers = {};
    const variant = { id: 'video-240', url: '/video.m3u8' };
    const audio = { id: 'audio-en', url: '/audio.m3u8' };
    const provider = {
      variants: [variant],
      activeVariant: variant,
      activeAudio: audio,
      blacklisted: {},
      _fetchPlaylistText(url) {
        requested.push(url);
        return new Promise(resolve => {
          resolvers[url] = resolve;
        });
      },
      _loadMediaPlaylist(text, url) {
        parsed.push({ kind: 'video', text, url });
        return { kind: 'video', applied: true, stale: false, advanced: true, changed: true, failed: false };
      },
      _loadAudioPlaylist(text, url) {
        parsed.push({ kind: 'audio', text, url });
        return { kind: 'audio', applied: true, stale: false, advanced: true, changed: true, failed: false };
      },
      _fetchReloadPlaylist: window.NativeHlsProviderForTest._fetchReloadPlaylist,
    };

    const loading = window.NativeHlsProviderForTest._loadStartupMediaPlaylists.call(provider);
    await Promise.resolve();
    const requestedBeforeEitherResponse = requested.slice();
    resolvers['/video.m3u8']('video-playlist');
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    const parsedBeforeAudioResponse = parsed.slice();
    resolvers['/audio.m3u8']('audio-playlist');
    await loading;
    const startupParsed = parsed.slice();

    requested.length = 0;
    parsed.length = 0;
    provider._refreshContentSteering = () => Promise.resolve();
    provider._applyContentSteeringToActiveVariant = () => {};
    const refreshing = window.NativeHlsProviderForTest._refreshMediaPlaylist.call(provider, 'live');
    await Promise.resolve();
    await Promise.resolve();
    const refreshRequestedBeforeEitherResponse = requested.slice();
    resolvers['/video.m3u8']('refreshed-video-playlist');
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    const refreshParsedBeforeAudioResponse = parsed.slice();
    resolvers['/audio.m3u8']('refreshed-audio-playlist');
    await refreshing;
    const refreshParsed = parsed.slice();

    requested.length = 0;
    parsed.length = 0;
    const scheduledRefresh = window.NativeHlsProviderForTest._refreshMediaPlaylist.call(provider, 'live');
    await Promise.resolve();
    await Promise.resolve();
    const recoveryRefresh = window.NativeHlsProviderForTest._refreshMediaPlaylist.call(provider, 'media-error', 'video');
    const requestsBeforeScheduledRefreshSettled = requested.slice();
    resolvers['/video.m3u8']('scheduled-video-playlist');
    resolvers['/audio.m3u8']('scheduled-audio-playlist');
    await scheduledRefresh;
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    const requestsAfterCausalRefreshStarted = requested.slice();
    resolvers['/video.m3u8']('recovery-video-playlist');
    resolvers['/audio.m3u8']('recovery-audio-playlist');
    await recoveryRefresh;

    requested.length = 0;
    parsed.length = 0;
    provider._fetchReloadPlaylist = url => {
      requested.push(url);
      return url === '/audio.m3u8'
        ? Promise.reject(new Error('audio-playlist-unavailable'))
        : Promise.resolve('healthy-video-playlist');
    };
    const partialOutcome = await window.NativeHlsProviderForTest._refreshMediaPlaylist.call(provider, 'live');
    let staleRecoveryCalls = 0;
    provider.mediaUrlRefreshCount = 0;
    provider.recoveryCount = 0;
    provider._refreshMediaPlaylist = () => {
      staleRecoveryCalls++;
      return Promise.resolve(staleRecoveryCalls === 1
        ? { video: { stale: true } }
        : { video: { stale: false, applied: true } });
    };
    await window.NativeHlsProviderForTest._recoverMediaRequest.call(
      provider,
      { message: 'range-http-410', status: 410 },
      { kind: 'video' },
    );
    return {
      requestedBeforeEitherResponse,
      parsedBeforeAudioResponse,
      startupParsed,
      refreshRequestedBeforeEitherResponse,
      refreshParsedBeforeAudioResponse,
      refreshParsed,
      requestsBeforeScheduledRefreshSettled,
      requestsAfterCausalRefreshStarted,
      refreshReasonCleared: provider.playlistRefreshReasonInFlight === '',
      partialOutcome,
      partialRequests: requested,
      partialParsed: parsed,
      staleRecoveryCalls,
    };
  });

  expect(state.requestedBeforeEitherResponse).toEqual(['/video.m3u8', '/audio.m3u8']);
  expect(state.parsedBeforeAudioResponse).toEqual([]);
  expect(state.startupParsed).toEqual([
    { kind: 'video', text: 'video-playlist', url: '/video.m3u8' },
    { kind: 'audio', text: 'audio-playlist', url: '/audio.m3u8' },
  ]);
  expect(state.refreshRequestedBeforeEitherResponse).toEqual(['/video.m3u8', '/audio.m3u8']);
  expect(state.refreshParsedBeforeAudioResponse).toEqual([]);
  expect(state.refreshParsed).toEqual([
    { kind: 'video', text: 'refreshed-video-playlist', url: '/video.m3u8' },
    { kind: 'audio', text: 'refreshed-audio-playlist', url: '/audio.m3u8' },
    { kind: 'video', text: 'refreshed-video-playlist', url: '/video.m3u8' },
    { kind: 'audio', text: 'refreshed-audio-playlist', url: '/audio.m3u8' },
  ]);
  expect(state.requestsBeforeScheduledRefreshSettled).toEqual(['/video.m3u8', '/audio.m3u8']);
  expect(state.requestsAfterCausalRefreshStarted).toEqual([
    '/video.m3u8',
    '/audio.m3u8',
    '/video.m3u8',
    '/audio.m3u8',
  ]);
  expect(state.refreshReasonCleared).toBe(true);
  expect(state.partialOutcome).toMatchObject({ applied: true, partial: true });
  expect(state.partialRequests).toEqual(['/video.m3u8', '/audio.m3u8']);
  expect(state.partialParsed).toEqual([
    { kind: 'video', text: 'healthy-video-playlist', url: '/video.m3u8' },
    { kind: 'video', text: 'healthy-video-playlist', url: '/video.m3u8' },
  ]);
  expect(state.staleRecoveryCalls).toBe(2);
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

  const loadError = await page.evaluate(async () => {
    const video = document.getElementById('player');
    video.canPlayType = () => '';
    const engine = new window.PlayerEngine(video, { videoId: 'HLSAUDIOBAD', streamToken: 'test-token' });
    window.__engine = engine;
    window.__player = engine.getPlayer();
    await engine.init();
    try { await engine.load(); return null; } catch (err) {
      return { message: err.message, nativeTerminal: !!err.nativeTerminal, phase: err.phase };
    }
  });

  const stats = await page.evaluate(() => window.__player.getStats());
  expect(loadError).toEqual({ message: 'hls-no-supported-audio', nativeTerminal: true, phase: 'load' });
  expect(stats.provider).toBe('native-hls');
  expect(stats.fallbackReason).toBe('');
  expect(stats.lastError).toBe('hls-no-supported-audio');
  expect(stats.fatalError).toBe('hls-no-supported-audio');
  expect(stats.nativeUnsupportedReason).toBe('hls-no-supported-audio');
  expect(stats.unsupportedAudioCount).toBeGreaterThan(0);
  expect(stats.terminalErrorCount).toBe(1);
  expect(stats.terminalErrorPhase).toBe('load');
  expect(stats.providerTerminalQuiesced).toBe(true);
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

  const loadError = await page.evaluate(async () => {
    const video = document.getElementById('player');
    video.canPlayType = () => '';
    const engine = new window.PlayerEngine(video, { videoId: 'HLSVIDEOBAD', streamToken: 'test-token' });
    window.__engine = engine;
    window.__player = engine.getPlayer();
    await engine.init();
    try { await engine.load(); return null; } catch (err) {
      return { message: err.message, nativeTerminal: !!err.nativeTerminal, phase: err.phase };
    }
  });

  const stats = await page.evaluate(() => window.__player.getStats());
  expect(loadError).toEqual({ message: 'hls-no-supported-video', nativeTerminal: true, phase: 'load' });
  expect(stats.provider).toBe('native-hls');
  expect(stats.fallbackReason).toBe('');
  expect(stats.lastError).toBe('hls-no-supported-video');
  expect(stats.fatalError).toBe('hls-no-supported-video');
  expect(stats.nativeUnsupportedReason).toBe('hls-no-supported-video');
  expect(stats.unsupportedVideoCount).toBeGreaterThan(0);
  expect(stats.terminalErrorCount).toBe(1);
  expect(stats.terminalErrorPhase).toBe('load');
  expect(stats.providerTerminalQuiesced).toBe(true);
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

  const result = await page.evaluate(async () => {
    const video = document.getElementById('player');
    video.canPlayType = () => '';
    const engine = new window.PlayerEngine(video, { videoId: 'HLSUNSUP001', streamToken: 'test-token' });
    window.__player = engine.getPlayer();
    await engine.init();
    let loadError = null;
    try { await engine.load(); } catch (err) {
      loadError = { message: err.message, nativeTerminal: !!err.nativeTerminal, phase: err.phase };
    }
    return { loadError, stats: engine.getPlayer().getStats() };
  });
  const { stats } = result;

  expect(shakaRequests).toHaveLength(0);
  expect(result.loadError).toEqual({ message: 'hls-sample-aes-unsupported', nativeTerminal: true, phase: 'load' });
  expect(stats.provider).toBe('native-hls');
  expect(stats.fallbackReason).toBe('');
  expect(stats.lastError).toBe('hls-sample-aes-unsupported');
  expect(stats.fatalError).toBe('hls-sample-aes-unsupported');
  expect(stats.nativeUnsupportedReason).toBe('hls-sample-aes-unsupported');
  expect(stats.hlsEncryptionMethod).toBe('SAMPLE-AES');
  expect(stats.hlsKeyFormat).toBe('identity');
  expect(stats.terminalErrorCount).toBe(1);
  expect(stats.terminalErrorPhase).toBe('load');
  expect(stats.providerTerminalQuiesced).toBe(true);
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
    let mediaReady = false;
    Object.defineProperty(video, 'readyState', { configurable: true, get() { return mediaReady ? 2 : 0; } });
    video.load = () => {
      loads++;
      setTimeout(() => {
        if (loads === 1) {
          video.dispatchEvent(new Event('error'));
        } else {
          mediaReady = true;
          video.dispatchEvent(new Event('loadedmetadata'));
          video.dispatchEvent(new Event('loadeddata'));
        }
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

  const result = await page.evaluate(async () => {
    const video = document.getElementById('player');
    let loads = 0;
    video.load = () => {
      loads++;
      setTimeout(() => video.dispatchEvent(new Event('error')), 0);
    };
    const engine = new window.PlayerEngine(video, { videoId: 'TESTVIDEO03', streamToken: 'test-token' });
    window.__engine = engine;
    window.__player = engine.getPlayer();
    await engine.init();
    let loadError = null;
    try { await engine.load('/fixture/missing.mp4'); } catch (err) {
      loadError = { message: err.message, nativeTerminal: !!err.nativeTerminal, phase: err.phase };
    }
    const stats = engine.getPlayer().getStats();
    stats.loads = loads;
    return { loadError, stats };
  });
  const { stats } = result;

  expect(shakaRequests).toHaveLength(0);
  expect(result.loadError).toEqual({ message: 'native-url-error', nativeTerminal: true, phase: 'load' });
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

  const state = await page.evaluate(() => {
    const video = document.getElementById('player');
    let loads = 0;
    let mediaReady = false;
    Object.defineProperty(video, 'readyState', { configurable: true, get() { return mediaReady ? 2 : 0; } });
    video.load = () => {
      loads++;
      if (loads === 1) setTimeout(() => {
        mediaReady = true;
        video.dispatchEvent(new Event('loadedmetadata'));
        video.dispatchEvent(new Event('loadeddata'));
      }, 0);
    };
    const engine = new window.PlayerEngine(video, { videoId: 'TESTVIDEO03', streamToken: 'test-token' });
    window.__engine = engine;
    window.__player = engine.getPlayer();
    const terminalEvents = [];
    const stateEvents = [];
    window.__player.addEventListener('error', event => terminalEvents.push({
      reason: event.detail.reason,
      phase: event.detail.phase,
      loadGeneration: event.detail.loadGeneration,
    }));
    window.__player.addEventListener('statechanged', event => stateEvents.push(event.detail.state));
    return engine.init().then(() => engine.load('/fixture/video.mp4')).then(() => {
      const provider = engine._provider;
      provider._onRuntimeError();
      provider._onRuntimeError();
      provider._onRuntimeError();
      const stats = engine.getPlayer().getStats();
      stats.loads = loads;
      return {
        stats,
        terminalEvents,
        stateEvents,
        providerDestroyed: provider.destroyed,
        providerQuiesced: provider._terminalQuiesced,
        engineState: engine._state,
      };
    });
  });
  const { stats } = state;

  expect(shakaRequests).toHaveLength(0);
  expect(stats.provider).toBe('native-url');
  expect(stats.mode).toBe('progressive');
  expect(stats.fallbackReason).toBe('');
  expect(stats.loads).toBe(2);
  expect(stats.recoveryCount).toBe(1);
  expect(stats.lastError).toBe('native-url-error');
  expect(stats.fatalError).toBe('native-url-error');
  expect(stats.nativeUnsupportedReason).toBe('native-url-error');
  expect(stats.terminalErrorCount).toBe(1);
  expect(stats.terminalErrorPhase).toBe('runtime');
  expect(stats.providerTerminalQuiesced).toBe(true);
  expect(state.providerDestroyed).toBe(true);
  expect(state.providerQuiesced).toBe(true);
  expect(state.engineState).toBe('error');
  expect(state.terminalEvents).toEqual([{
    reason: 'native-url-error',
    phase: 'runtime',
    loadGeneration: 1,
  }]);
  expect(state.stateEvents).toContain('error');
});
