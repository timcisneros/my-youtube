import fs from 'fs';
import db from '../../db.js';
import logger from '../../lib/logger.js';
import {
  acquireLock,
  hasCacheRedis,
  hasRedis,
  releaseLock,
  renewLock,
} from '../../lib/cache.js';
import { promoteExtraction } from '../../lib/extraction-queue.js';
import {
  sanitizeHeaders,
  formatCache,
  mpdCache,
  urlLookup,
  mp4ProbeCache,
  hlsCache,
  dedup,
  fetchWithConnTimeout,
  CACHE_TTL,
  selectBestHlsFormat,
} from './shared.js';
import { listDownloadedFormats, recordDownloadedFormatRanges } from '../../lib/download-files.js';
import { extractFormats } from './extraction.js';
import { notifyExtractionStep, notifyExtractionDone } from './status.js';
import { incrementMetric, observeMetric, setMetricGauge } from '../../lib/performance-metrics.js';
import { readBodyBounded } from '../../lib/bounded-fetch.js';

function recordManifestBuild(
  priority: string,
  playback: string,
  startedAt: number,
  options: { result?: string; probeMs?: number; probedFormats?: number } = {},
) {
  const result = options.result || 'success';
  incrementMetric('manifest_builds_total', { priority, playback, result });
  observeMetric('manifest_build_duration_seconds', (Date.now() - startedAt) / 1000, {
    priority,
    playback,
    result,
  });
  if ((options.probeMs || 0) > 0) {
    observeMetric('manifest_probe_duration_seconds', options.probeMs! / 1000, { playback });
  }
  if (options.probedFormats !== undefined) {
    setMetricGauge('manifest_last_probed_formats', options.probedFormats, { playback });
  }
}

// Probe MP4 byte ranges (init + index) by walking box headers
async function probeMP4Ranges(url, headers) {
  let offset = 0, initEnd = 0, sidxStart = -1, sidxEnd = -1;
  const probeDeadline = Date.now() + 12_000;

  // Fetch a chunk starting at offset, return a Buffer
  async function fetchChunk(start, size) {
    const remaining = probeDeadline - Date.now();
    if (remaining <= 0) return null;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.min(8000, remaining));
    try {
      const resp = await fetchWithConnTimeout(url, {
        headers: { ...headers, Range: `bytes=${start}-${start + size - 1}` },
        signal: controller.signal,
        bodyIdleMs: Math.min(8000, remaining),
        outboundPriority: 'interactive',
      }, Math.min(8000, remaining));
      if (!resp.ok && resp.status !== 206) return null;
      return await readBodyBounded(resp, Math.max(64 * 1024, size), 'mp4-probe-response-too-large');
    } finally {
      clearTimeout(timeout);
    }
  }

  // First fetch — most YouTube MP4s have ftyp+moov+sidx within the first few KB
  let buf = await fetchChunk(0, 8192);
  if (!buf) return null;

  while (true) {
    // Need at least 8 bytes for a box header
    if (offset + 8 > buf.length) {
      // Fetch more from where we left off
      const more = await fetchChunk(offset, 4096);
      if (!more || more.length < 8) break;
      buf = Buffer.concat([buf, more]);
    }

    let size = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    if (size === 1) {
      if (offset + 16 > buf.length) {
        const more = await fetchChunk(buf.length, 4096);
        if (!more) break;
        buf = Buffer.concat([buf, more]);
        if (offset + 16 > buf.length) break;
      }
      const bigSize = buf.readBigUInt64BE(offset + 8);
      if (bigSize > BigInt(Number.MAX_SAFE_INTEGER)) break;
      size = Number(bigSize);
    }
    if (size === 0 || size < 8) break;

    if (type === 'moov') initEnd = offset + size - 1;
    else if (type === 'sidx') { sidxStart = offset; sidxEnd = offset + size - 1; }

    if (sidxStart >= 0 && initEnd > 0) break;

    // Skip to next box — don't need to download the box body
    offset += size;
  }

  return (initEnd > 0 && sidxStart >= 0) ? { initRange: '0-' + initEnd, indexRange: sidxStart + '-' + sidxEnd } : null;
}

// Probe MP4 byte ranges from a local file (no network)
async function probeLocalMP4Ranges(filePath) {
  const fd = await fs.promises.open(filePath, 'r');
  try {
    const headerBuf = Buffer.alloc(8192);
    const { bytesRead } = await fd.read(headerBuf, 0, 8192, 0);
    if (bytesRead < 8) return null;
    const buf = headerBuf.subarray(0, bytesRead);
    let offset = 0, initEnd = 0, sidxStart = -1, sidxEnd = -1;
    while (offset + 8 <= buf.length) {
      let size = buf.readUInt32BE(offset);
      const type = buf.toString('ascii', offset + 4, offset + 8);
      if (size === 1 && offset + 16 <= buf.length) {
        const bigSize = buf.readBigUInt64BE(offset + 8);
        if (bigSize > BigInt(Number.MAX_SAFE_INTEGER)) break;
        size = Number(bigSize);
      }
      if (size === 0 || size < 8) break;
      if (type === 'moov') initEnd = offset + size - 1;
      else if (type === 'sidx') { sidxStart = offset; sidxEnd = offset + size - 1; }
      if (sidxStart >= 0 && initEnd > 0) break;
      offset += size;
    }
    return (initEnd > 0 && sidxStart >= 0) ? { initRange: '0-' + initEnd, indexRange: sidxStart + '-' + sidxEnd } : null;
  } finally {
    await fd.close();
  }
}

function formatDuration(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = (sec % 60).toFixed(3);
  return 'PT' + (h ? h + 'H' : '') + (m ? m + 'M' : '') + s + 'S';
}

function escapeXML(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function generateMPD(videoId, duration, formats, rangeMap) {
  const dur = formatDuration(duration);
  let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" profiles="urn:mpeg:dash:profile:isoff-on-demand:2011" type="static" mediaPresentationDuration="${dur}" minBufferTime="PT2S">\n<Period duration="${dur}">\n`;

  // Video AdaptationSet
  const videos = formats.filter(f => f.vcodec && f.vcodec !== 'none' && (!f.acodec || f.acodec === 'none'));
  if (videos.length) {
    xml += `<AdaptationSet mimeType="video/mp4" segmentAlignment="true" startWithSAP="1">\n`;
    for (const f of videos) {
      const r = rangeMap[f.format_id];
      if (!r) continue;
      xml += `<Representation id="${escapeXML(f.format_id)}" bandwidth="${f.tbr ? Math.round(f.tbr * 1000) : 0}" width="${f.width || 0}" height="${f.height || 0}" codecs="${escapeXML(f.vcodec)}">\n`;
      xml += `<BaseURL>/api/stream/${videoId}/fmt/${f.format_id}</BaseURL>\n`;
      xml += `<SegmentBase indexRange="${r.indexRange}"><Initialization range="${r.initRange}"/></SegmentBase>\n`;
      xml += `</Representation>\n`;
    }
    xml += `</AdaptationSet>\n`;
  }

  // Audio AdaptationSet
  const audios = formats.filter(f => f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none'));
  if (audios.length) {
    xml += `<AdaptationSet mimeType="audio/mp4" segmentAlignment="true" startWithSAP="1">\n`;
    for (const f of audios) {
      const r = rangeMap[f.format_id];
      if (!r) continue;
      xml += `<Representation id="${escapeXML(f.format_id)}" bandwidth="${f.tbr ? Math.round(f.tbr * 1000) : 0}" codecs="${escapeXML(f.acodec)}" audioSamplingRate="${f.asr || 44100}">\n`;
      xml += `<BaseURL>/api/stream/${videoId}/fmt/${f.format_id}</BaseURL>\n`;
      xml += `<SegmentBase indexRange="${r.indexRange}"><Initialization range="${r.initRange}"/></SegmentBase>\n`;
      xml += `</Representation>\n`;
    }
    xml += `</AdaptationSet>\n`;
  }

  xml += `</Period>\n</MPD>`;
  return xml;
}

function representativeFormats(formats, maxCount) {
  const byHeight = new Map();
  for (const format of formats) {
    const height = Number(format.height) || 0;
    const previous = byHeight.get(height);
    if (!previous || (Number(format.tbr) || 0) > (Number(previous.tbr) || 0)) byHeight.set(height, format);
  }
  const unique = [...byHeight.values()].sort((a, b) => (a.height || 0) - (b.height || 0));
  if (unique.length <= maxCount) return unique;
  const picked = [];
  const seen = new Set();
  for (let i = 0; i < maxCount; i++) {
    const index = Math.round(i * (unique.length - 1) / (maxCount - 1));
    const format = unique[index];
    if (!seen.has(format.format_id)) {
      seen.add(format.format_id);
      picked.push(format);
    }
  }
  return picked;
}

function selectStartupProbeFormats(videoFormats, audioFormats, language) {
  const avc = videoFormats.filter(f => /^avc1/i.test(f.vcodec || ''));
  const preferredVideoFamily = avc.length ? avc : videoFormats;
  const videos = representativeFormats(preferredVideoFamily, 6);

  const preferredAudio = audioFormats.filter(f => /^mp4a/i.test(f.acodec || ''));
  const audioPool = preferredAudio.length ? preferredAudio : audioFormats;
  const languageRoot = String(language || '').split('-')[0];
  const audios = [...audioPool]
    .sort((a, b) => {
      const aOriginal = /original/i.test(a.format_note || '') || (languageRoot && String(a.language || '').split('-')[0] === languageRoot) ? 1 : 0;
      const bOriginal = /original/i.test(b.format_note || '') || (languageRoot && String(b.language || '').split('-')[0] === languageRoot) ? 1 : 0;
      return bOriginal - aOriginal || (Number(b.tbr) || 0) - (Number(a.tbr) || 0);
    })
    .slice(0, 2);
  return { videos, audios };
}

async function mapWithConcurrency(items, concurrency, fn) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      await fn(items[index], index);
    }
  });
  await Promise.all(workers);
}

// In-flight MPD build promises to deduplicate concurrent buildMPD calls
const mpdInflight = new Map();
const MANIFEST_LOCK_LEASE_MS = 30_000;
const MANIFEST_LOCK_WAIT_MS = 15_000;

async function getSharedManifest(videoId: string) {
  const entry = await mpdCache.getAsync(videoId);
  return entry?.data && Date.now() < entry.expires ? entry.data : null;
}

// Route admission must consult both cache tiers. A worker-local miss does not
// mean extraction is needed when another worker already published the result.
async function hasCachedPlayback(videoId) {
  const manifest = await mpdCache.getAsync(videoId);
  if (manifest && Date.now() < manifest.expires) return true;
  const formats = await formatCache.getAsync(videoId);
  return Boolean(formats?.data && Date.now() < formats.expires);
}

// Build (or return cached) MPD for a videoId
async function buildMPD(videoId, options: { priority?: 'playback' | 'background' | 'prefetch'; preferLocal?: boolean } = {}) {
  const priority = options.priority || 'playback';
  const preferLocal = options.preferLocal === true;
  const buildStartedAt = Date.now();
  if (!preferLocal) {
    const cached = mpdCache.get(videoId);
    if (cached && Date.now() < cached.expires) {
      incrementMetric('manifest_requests_total', { result: 'l1_hit' });
      return cached.data;
    }
  }

  // Check Redis for cross-worker cache hit before rebuilding
  if (!preferLocal && hasCacheRedis()) {
    const redisEntry = await mpdCache.getAsync(videoId);
    if (redisEntry && redisEntry.data && Date.now() < redisEntry.expires) {
      incrementMetric('manifest_requests_total', { result: 'l2_hit' });
      return redisEntry.data;
    }
  }
  incrementMetric('manifest_requests_total', { result: 'miss' });

  if (priority === 'playback') void promoteExtraction(videoId);

  return dedup(mpdInflight, `${videoId}:${preferLocal ? 'local' : 'default'}`, async () => {
    const manifestLockKey = `manifest:${videoId}`;
    let manifestLockToken: string | null = null;
    let manifestLockRenewTimer: NodeJS.Timeout | null = null;

    // Extraction has its own cluster-wide single-flight, but MP4 probing and
    // manifest publication happen afterwards. Coordinate that second stage as
    // well so page preloads landing on different workers do not repeat every
    // CDN range probe.
    if (!preferLocal && hasRedis() && hasCacheRedis()) {
      manifestLockToken = await acquireLock(manifestLockKey, MANIFEST_LOCK_LEASE_MS);
      if (!manifestLockToken) {
        const waitStartedAt = Date.now();
        incrementMetric('manifest_lock_contention_total');
        const waitDeadline = waitStartedAt + MANIFEST_LOCK_WAIT_MS;
        while (Date.now() < waitDeadline) {
          await new Promise(resolve => setTimeout(resolve, 500 + Math.random() * 250));
          const sharedManifest = await getSharedManifest(videoId);
          if (sharedManifest) {
            observeMetric('manifest_lock_wait_seconds', (Date.now() - waitStartedAt) / 1000, { result: 'cache_hit' });
            incrementMetric('manifest_requests_total', { result: 'lock_wait_hit' });
            return sharedManifest;
          }
        }
        observeMetric('manifest_lock_wait_seconds', (Date.now() - waitStartedAt) / 1000, { result: 'timeout' });
        incrementMetric('manifest_requests_total', { result: 'lock_wait_timeout' });
        return {
          unavailable: 'The stream manifest is still being prepared. Try again in a moment.',
          overloaded: true,
        };
      }

      // The first cache check and lock acquisition are separate operations.
      // Re-check after becoming owner in case the preceding worker published
      // immediately before releasing its lease.
      const sharedManifest = await getSharedManifest(videoId);
      if (sharedManifest) {
        await releaseLock(manifestLockKey, manifestLockToken);
        incrementMetric('manifest_requests_total', { result: 'lock_double_check_hit' });
        return sharedManifest;
      }
      if (manifestLockToken !== 'local') {
        manifestLockRenewTimer = setInterval(() => {
          void renewLock(manifestLockKey, manifestLockToken!, MANIFEST_LOCK_LEASE_MS).then((renewed) => {
            if (!renewed) console.warn(`[stream ${videoId}] manifest ownership lease was lost`);
          });
        }, Math.floor(MANIFEST_LOCK_LEASE_MS / 3));
        manifestLockRenewTimer.unref?.();
      }
    }

    try {
    // Fast path: if local downloads exist, build MPD from disk (no extraction needed)
    const localFormats = (await listDownloadedFormats(videoId))
      .map(entry => ({
        itag: entry.formatId,
        filePath: entry.filePath,
        size: entry.size,
        ranges: entry.ranges,
      }));
    if (localFormats.length >= 2) { // need at least video + audio
      const rangeMap = {};
      const fakeFormats = [];
      // Known itag metadata for MPD generation
      const itagMeta: Record<string, { height?: number; width?: number; vcodec?: string; acodec?: string; tbr?: number; asr?: number; ext?: string }> = {
        '160': { height: 144, width: 256, vcodec: 'avc1.4d400c', ext: 'mp4' },
        '133': { height: 240, width: 426, vcodec: 'avc1.4d4015', ext: 'mp4' },
        '134': { height: 360, width: 640, vcodec: 'avc1.4d401e', ext: 'mp4' },
        '135': { height: 480, width: 854, vcodec: 'avc1.4d401f', ext: 'mp4' },
        '136': { height: 720, width: 1280, vcodec: 'avc1.4d401f', ext: 'mp4' },
        '137': { height: 1080, width: 1920, vcodec: 'avc1.640028', ext: 'mp4' },
        '298': { height: 720, width: 1280, vcodec: 'avc1.4d4020', ext: 'mp4' },
        '299': { height: 1080, width: 1920, vcodec: 'avc1.64002a', ext: 'mp4' },
        '264': { height: 1440, width: 2560, vcodec: 'avc1.640032', ext: 'mp4' },
        '304': { height: 720, width: 1280, vcodec: 'avc1.4d4020', ext: 'mp4' },
        '303': { height: 1080, width: 1920, vcodec: 'avc1.640028', ext: 'mp4' },
        '308': { height: 1440, width: 2560, vcodec: 'avc1.640032', ext: 'mp4' },
        '315': { height: 2160, width: 3840, vcodec: 'avc1.640033', ext: 'mp4' },
        '394': { height: 144, width: 256, vcodec: 'av01.0.00M.08', ext: 'mp4' },
        '395': { height: 240, width: 426, vcodec: 'av01.0.00M.08', ext: 'mp4' },
        '396': { height: 360, width: 640, vcodec: 'av01.0.01M.08', ext: 'mp4' },
        '397': { height: 480, width: 854, vcodec: 'av01.0.04M.08', ext: 'mp4' },
        '398': { height: 720, width: 1280, vcodec: 'av01.0.05M.08', ext: 'mp4' },
        '399': { height: 1080, width: 1920, vcodec: 'av01.0.08M.08', ext: 'mp4' },
        '400': { height: 1440, width: 2560, vcodec: 'av01.0.12M.08', ext: 'mp4' },
        '401': { height: 2160, width: 3840, vcodec: 'av01.0.12M.08', ext: 'mp4' },
        '140': { acodec: 'mp4a.40.2', tbr: 128, asr: 44100, ext: 'm4a' },
        '141': { acodec: 'mp4a.40.2', tbr: 256, asr: 44100, ext: 'm4a' },
        '249': { acodec: 'opus', tbr: 50, asr: 48000, ext: 'm4a' },
        '250': { acodec: 'opus', tbr: 70, asr: 48000, ext: 'm4a' },
        '251': { acodec: 'opus', tbr: 160, asr: 48000, ext: 'm4a' },
      };
      const newlyProbedRanges = {};
      const localProbeResults = new Array(localFormats.length);
      await mapWithConcurrency(localFormats, 4, async (lf, index) => {
        const meta = itagMeta[lf.itag];
        if (!meta) return;
        try {
          const ranges = lf.ranges || await probeLocalMP4Ranges(lf.filePath);
          if (!ranges) return;
          if (!lf.ranges) newlyProbedRanges[lf.itag] = ranges;
          localProbeResults[index] = {
            ranges,
            format: {
              format_id: lf.itag,
              height: meta.height || 0,
              width: meta.width || 0,
              vcodec: meta.vcodec || 'none',
              acodec: meta.acodec || 'none',
              tbr: meta.tbr || (lf.size * 8 / 1000 / 300), // estimate ~5min
              asr: meta.asr || 0,
              ext: meta.ext || 'mp4',
            },
          };
        } catch {}
      });
      const allProbed = localProbeResults.every(Boolean);
      for (const result of localProbeResults) {
        if (!result) continue;
        rangeMap[result.format.format_id] = result.ranges;
        fakeFormats.push(result.format);
      }
      if (allProbed && Object.keys(rangeMap).length >= 2) {
        const [duration] = await Promise.all([
          db.getDuration(videoId),
          Object.keys(newlyProbedRanges).length
            ? recordDownloadedFormatRanges(videoId, newlyProbedRanges).catch(error => {
                console.warn(`[stream ${videoId}] could not persist local MP4 ranges:`, error.message);
              })
            : Promise.resolve(),
        ]);
        const mpd = generateMPD(videoId, duration || 0, fakeFormats, rangeMap);
        console.log(`[stream ${videoId}] using local downloads (${localFormats.length} files)`);
        await mpdCache.setAsync(videoId, { data: mpd, meta: { playback: 'dash', via: 'local' }, expires: Date.now() + CACHE_TTL });
        notifyExtractionDone(videoId);
        recordManifestBuild(priority, 'dash', buildStartedAt, { result: 'local' });
        return mpd;
      }
    }

    let info;
    try {
      info = await extractFormats(videoId, { priority });
    } catch (err) {
      // Always close WebSocket/SSE status listeners when extraction itself
      // fails before manifest construction begins.
      notifyExtractionDone(videoId);
      throw err;
    }
    if (info._unavailable) {
      notifyExtractionDone(videoId);
      recordManifestBuild(priority, 'none', buildStartedAt, {
        result: info._overloaded ? 'overloaded' : info._pending ? 'pending' : 'unavailable',
      });
      return {
        unavailable: info._unavailable,
        overloaded: info._overloaded === true,
        scheduledStart: info._scheduledStart,
      };
    }
    notifyExtractionStep(videoId, 'building');

    try {
    const isDirect = f => f.url && (!f.protocol || f.protocol === 'https' || f.protocol === 'http');
    const allFmts = (info.formats || []).filter(f => isDirect(f));

    // Try DASH first — separate video-only + audio-only MP4 streams
    const videoFmts = allFmts.filter(f => f.vcodec && f.vcodec !== 'none' && (!f.acodec || f.acodec === 'none'));
    const audioFmts = allFmts.filter(f => f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none'));
    const mp4Video = videoFmts.filter(f => f.ext === 'mp4');
    const mp4Audio = audioFmts.filter(f => f.ext === 'm4a');
    let dashProbeMs = 0;
    let probedFormatsCount = 0;

    if (mp4Video.length && mp4Audio.length) {
      // Probe a representative, broadly-compatible startup ladder. Probing
      // every duplicate codec/height caused dozens of simultaneous CDN range
      // requests and made the slowest optional rendition gate first playback.
      const selected = selectStartupProbeFormats(mp4Video, mp4Audio, info.language);
      let manifestFormats = [...selected.videos, ...selected.audios];
      const rangeMap = {};
      const probeStartedAt = Date.now();
      const probeFormats = async (formats) => mapWithConcurrency(formats, 4, async (f) => {
        const probeKey = `${videoId}:${f.format_id}`;
        const cached = mp4ProbeCache.get(probeKey);
        if (cached) { rangeMap[f.format_id] = cached; return; }
        try {
          const ranges = await probeMP4Ranges(f.url, sanitizeHeaders(f.http_headers));
          if (ranges) {
            rangeMap[f.format_id] = ranges;
            mp4ProbeCache.set(probeKey, ranges);
          }
        } catch (e) { if (e.name !== 'AbortError') console.warn(`[stream ${videoId}] probe failed for ${f.format_id}:`, e.message); }
      });
      await probeFormats(manifestFormats);

      // If the preferred ladder did not produce both tracks, try only a small
      // bounded reserve set before falling back to HLS/progressive playback.
      let videoCount = selected.videos.filter(f => rangeMap[f.format_id]).length;
      let audioCount = selected.audios.filter(f => rangeMap[f.format_id]).length;
      if (!videoCount || !audioCount) {
        const selectedIds = new Set(manifestFormats.map(f => f.format_id));
        const reserve = [
          ...mp4Video.filter(f => !selectedIds.has(f.format_id)).slice(0, 2),
          ...mp4Audio.filter(f => !selectedIds.has(f.format_id)).slice(0, 1),
        ];
        await probeFormats(reserve);
        manifestFormats = [...manifestFormats, ...reserve];
        videoCount = manifestFormats.filter(f => f.vcodec && f.vcodec !== 'none' && rangeMap[f.format_id]).length;
        audioCount = manifestFormats.filter(f => f.acodec && f.acodec !== 'none' && rangeMap[f.format_id]).length;
      }
      dashProbeMs = Date.now() - probeStartedAt;
      probedFormatsCount = manifestFormats.length;

      const hasRanges = videoCount > 0 && audioCount > 0;
      if (hasRanges) {
        const mpd = generateMPD(videoId, info.duration || 0, manifestFormats, rangeMap);
        const via = info._extractedVia || 'yt-dlp';
        console.log(`[stream ${videoId}] using DASH (${videoCount} video + ${audioCount} audio), duration=${info.duration}s via ${via}`);
        const expires = Date.now() + CACHE_TTL;
        const publishedFormats = manifestFormats.filter(f => rangeMap[f.format_id]);
        await Promise.all([
          ...publishedFormats.map(f => urlLookup.setAsync(`${videoId}:${f.format_id}`, {
            url: f.url,
            headers: sanitizeHeaders(f.http_headers),
            expires,
          })),
          mpdCache.setAsync(videoId, { data: mpd, meta: { playback: 'dash', via }, expires }),
        ]);
        logger.sampledInfo('manifest-perf', 'manifest-perf', {
          videoId,
          priority,
          playback: 'dash',
          via,
          probeMs: dashProbeMs,
          probedFormats: probedFormatsCount,
          sourceFormats: mp4Video.length + mp4Audio.length,
          totalMs: Date.now() - buildStartedAt,
        });
        recordManifestBuild(priority, 'dash', buildStartedAt, {
          probeMs: dashProbeMs,
          probedFormats: probedFormatsCount,
        });
        return mpd;
      }
    }

    // HLS fallback
    const hlsFmt = selectBestHlsFormat(info.formats || [], info.language);

    if (hlsFmt) {
      const via = info._extractedVia || 'yt-dlp';
      console.log(`[stream ${videoId}] using HLS (${hlsFmt.height || '?'}p), duration=${info.duration}s via ${via}`);
      const expires = Date.now() + CACHE_TTL;
      const hlsResult = { hls: `/api/stream/${videoId}/hls.m3u8`, via };
      await Promise.all([
        hlsCache.setAsync(videoId, { url: hlsFmt.manifest_url || hlsFmt.url, headers: sanitizeHeaders(hlsFmt.http_headers), expires }),
        mpdCache.setAsync(videoId, { data: hlsResult, meta: { playback: 'hls', via }, expires }),
      ]);
      logger.sampledInfo('manifest-perf', 'manifest-perf', {
        videoId,
        priority,
        playback: 'hls',
        via,
        probeMs: dashProbeMs,
        probedFormats: probedFormatsCount,
        sourceFormats: mp4Video.length + mp4Audio.length,
        totalMs: Date.now() - buildStartedAt,
      });
      recordManifestBuild(priority, 'hls', buildStartedAt, {
        probeMs: dashProbeMs,
        probedFormats: probedFormatsCount,
      });
      return hlsResult;
    }

    // Progressive fallback
    const muxed = allFmts
      .filter(f => f.vcodec && f.vcodec !== 'none' && f.acodec && f.acodec !== 'none')
      .sort((a, b) => (b.height || 0) - (a.height || 0))[0];
    if (muxed) {
      const via = info._extractedVia || 'yt-dlp';
      const expires = Date.now() + CACHE_TTL;
      const result = { progressive: `/api/stream/${videoId}/progressive`, via };
      await Promise.all([
        urlLookup.setAsync(`${videoId}:${muxed.format_id}`, { url: muxed.url, headers: sanitizeHeaders(muxed.http_headers), expires }),
        mpdCache.setAsync(videoId, { data: result, meta: { playback: 'progressive', via }, expires }),
      ]);
      console.log(`[stream ${videoId}] using progressive (${muxed.height || '?'}p), duration=${info.duration}s via ${via}`);
      logger.sampledInfo('manifest-perf', 'manifest-perf', {
        videoId,
        priority,
        playback: 'progressive',
        via,
        probeMs: dashProbeMs,
        probedFormats: probedFormatsCount,
        sourceFormats: mp4Video.length + mp4Audio.length,
        totalMs: Date.now() - buildStartedAt,
      });
      recordManifestBuild(priority, 'progressive', buildStartedAt, {
        probeMs: dashProbeMs,
        probedFormats: probedFormatsCount,
      });
      return result;
    }

    recordManifestBuild(priority, 'none', buildStartedAt, { result: 'no_formats' });
    return null;
    } finally {
      notifyExtractionDone(videoId);
    }
    } finally {
      if (manifestLockRenewTimer) clearInterval(manifestLockRenewTimer);
      if (manifestLockToken) await releaseLock(manifestLockKey, manifestLockToken);
    }
  }, { name: 'stream_manifests', maxEntries: 256 });
}

export {
  buildMPD,
  hasCachedPlayback,
};
