// Shared extraction utilities and fallback backends for video format extraction.
// Used by routes/stream.js (format extraction) and yt-meta.js (metadata fetching).

import { promises as fs } from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import os from 'os';
import { withYtSlot } from './youtube/shared.js';
import { readJsonBounded, readTextBounded } from './lib/bounded-fetch.js';
import { parseEmbeddedJsonBuffer } from './lib/upstream-parser.js';

const execFileAsync = promisify(execFile);

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const ANDROID_VR_UA = 'com.google.android.apps.youtube.vr.oculus/1.57.29 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip';
const INNERTUBE_KEY = 'AIzaSyA8eiZmM1FaDVjRy-df2KTyQ_vz_yYM39w';

// ---------------------------------------------------------------------------
// Circuit breaker — shared across strategies
// ---------------------------------------------------------------------------
function createCircuitBreaker(name, { threshold = 8, cooldownMs = 2 * 60 * 1000 } = {}) {
  let failures = 0;
  let openUntil = 0;
  let cooldownMultiplier = 1;
  return {
    get isOpen() {
      if (Date.now() > openUntil) { failures = 0; openUntil = 0; }
      return failures >= threshold;
    },
    recordSuccess() { failures = 0; openUntil = 0; cooldownMultiplier = 1; },
    recordFailure() {
      failures++;
      if (failures >= threshold) {
        const cooldown = cooldownMs * cooldownMultiplier;
        openUntil = Date.now() + cooldown;
        cooldownMultiplier = Math.min(cooldownMultiplier * 2, 8); // exponential backoff, max 16 minutes
        console.warn(`[extractors] ${name} circuit open — ${threshold} consecutive failures, cooldown ${cooldown / 1000}s`);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Client version — auto-refreshed from YouTube's main page
// ---------------------------------------------------------------------------
let clientVersion = '2.20241126.01.00';
let clientVersionExpires = 0;

// Visitor data — needed for Innertube ANDROID_VR client
let visitorData = '';
let visitorDataExpires = 0;
let clientVersionRefreshInflight: Promise<void> | null = null;

interface ExtractorOptions {
  signal?: AbortSignal;
  deadlineAt?: number;
}

interface LiveStoryboardOptions extends ExtractorOptions {
  withRequestSlot?: <T>(task: () => Promise<T>) => Promise<T>;
  withProcessSlot?: <T>(task: () => Promise<T>) => Promise<T>;
}

function requestController(parentSignal?: AbortSignal, timeoutMs = 8000) {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromParent = () => controller.abort();
  if (parentSignal) {
    if (parentSignal.aborted) controller.abort();
    else parentSignal.addEventListener('abort', abortFromParent, { once: true });
  }
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, Math.max(1, timeoutMs));
  return {
    signal: controller.signal,
    get timedOut() { return timedOut; },
    cleanup() {
      clearTimeout(timer);
      if (parentSignal) parentSignal.removeEventListener('abort', abortFromParent);
    },
  };
}

function remainingTimeout(options, capMs) {
  const remaining = options?.deadlineAt ? options.deadlineAt - Date.now() : capMs;
  return Math.max(1, Math.min(capMs, remaining));
}

async function performClientVersionRefresh() {
  const request = requestController(undefined, 8000);
  try {
    const resp = await fetch('https://www.youtube.com/', {
      signal: request.signal,
      headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'en' },
    });
    const html = await readTextBounded(resp, 4 * 1024 * 1024, 'youtube-homepage-too-large');
    const m = html.match(/"clientVersion"\s*:\s*"(2\.\d{8}\.\d{2}\.\d{2})"/);
    if (m) {
      clientVersion = m[1];
      clientVersionExpires = Date.now() + 24 * 60 * 60 * 1000;
    } else {
      clientVersionExpires = Date.now() + 60 * 60 * 1000;
    }
    // Extract visitor data for Innertube API
    const vd = html.match(/"VISITOR_DATA"\s*:\s*"([^"]+)"/);
    if (vd) {
      visitorData = vd[1];
      visitorDataExpires = Date.now() + 6 * 60 * 60 * 1000; // refresh every 6h
    } else {
      // Avoid repeatedly downloading the homepage when YouTube omits visitor
      // data from a valid response. The next scheduled refresh can try again.
      visitorDataExpires = Date.now() + 60 * 60 * 1000;
    }
  } catch {
    clientVersionExpires = Date.now() + 60 * 60 * 1000;
    visitorDataExpires = Date.now() + 60 * 60 * 1000;
  } finally {
    request.cleanup();
  }
}

function waitForClientVersionRefresh(refresh: Promise<void>, signal?: AbortSignal) {
  if (!signal) return refresh;
  if (signal.aborted) {
    return Promise.reject(signal.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError'));
  }
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(signal.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError'));
    };
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    void refresh.then(
      () => { cleanup(); resolve(); },
      error => { cleanup(); reject(error); },
    );
  });
}

function refreshClientVersion(parentSignal?: AbortSignal) {
  const now = Date.now();
  if (now < clientVersionExpires && now < visitorDataExpires) return Promise.resolve();
  if (clientVersionRefreshInflight === null) {
    const refresh = performClientVersionRefresh();
    clientVersionRefreshInflight = refresh;
    void refresh.finally(() => {
      if (clientVersionRefreshInflight === refresh) clientVersionRefreshInflight = null;
    });
  }
  return waitForClientVersionRefresh(clientVersionRefreshInflight, parentSignal);
}

function getClientVersion() {
  return clientVersion;
}

// Fire-and-forget on startup
void refreshClientVersion();

// ---------------------------------------------------------------------------
// YouTube CDN domain validator (SSRF protection)
// ---------------------------------------------------------------------------
function isYouTubeCdnUrl(url) {
  let parsed;
  try { parsed = new URL(url); } catch { return false; }
  return /^([a-z0-9-]+\.)*(googlevideo|youtube|ggpht|googleusercontent|ytimg)\.com$/.test(parsed.hostname);
}

// ---------------------------------------------------------------------------
// Innertube /player API extractor (ANDROID_VR client — returns direct URLs)
// ---------------------------------------------------------------------------
const innertubeBreaker = createCircuitBreaker('innertube');

async function extractViaInnertube(videoId, options: ExtractorOptions = {}) {
  if (innertubeBreaker.isOpen) return null;
  if (options.signal?.aborted || (options.deadlineAt && Date.now() >= options.deadlineAt)) return null;

  try {
    // Ensure we have visitor data
    if (!visitorData) {
      await refreshClientVersion(options.signal);
    }

    const request = requestController(options.signal, remainingTimeout(options, 12000));
    try {
      const resp = await fetch(`https://www.youtube.com/youtubei/v1/player?key=${INNERTUBE_KEY}`, {
        method: 'POST',
        signal: request.signal,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': ANDROID_VR_UA,
          'X-Goog-Visitor-Id': visitorData,
        },
        body: JSON.stringify({
          videoId,
          context: {
            client: {
              clientName: 'ANDROID_VR',
              clientVersion: '1.57.29',
              hl: 'en',
            },
          },
        }),
      });

      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await readJsonBounded(resp, 4 * 1024 * 1024, 'innertube-response-too-large');

      if (data.playabilityStatus?.status !== 'OK') {
        throw new Error(`Playability: ${data.playabilityStatus?.status} — ${data.playabilityStatus?.reason || 'unknown'}`);
      }

      const streamingData = data.streamingData;
      if (!streamingData) throw new Error('No streamingData in Innertube response');

      const formats = [];
      const allStreams = [
        ...(streamingData.adaptiveFormats || []),
        ...(streamingData.formats || []),
      ];

      for (const f of allStreams) {
      // Skip formats requiring signature deobfuscation
      if (f.signatureCipher || f.cipher) continue;
      if (!f.url) continue;

      // Validate URL against YouTube CDN domain allowlist
      if (!isYouTubeCdnUrl(f.url)) continue;

      const mimeMatch = (f.mimeType || '').match(/^(video|audio)\/(\w+);\s*codecs="([^"]+)"/);
      if (!mimeMatch) continue;

      const mediaType = mimeMatch[1]; // 'video' or 'audio'
      const container = mimeMatch[2]; // 'mp4', 'webm'
      const codec = mimeMatch[3];     // 'avc1.4d401f', 'mp4a.40.2', etc.

      const normalized = {
        format_id: String(f.itag),
        url: f.url,
        vcodec: mediaType === 'video' ? codec : 'none',
        acodec: mediaType === 'audio' ? codec : (f.audioQuality ? codec : 'none'),
        height: f.height || 0,
        width: f.width || 0,
        ext: container === 'mp4' ? (mediaType === 'audio' ? 'm4a' : 'mp4') : container,
        tbr: f.bitrate ? Math.round(f.bitrate / 1000) : 0,
        asr: f.audioSampleRate ? parseInt(f.audioSampleRate, 10) : 0,
        protocol: 'https',
        http_headers: {},
      };

      // Handle muxed formats (both video + audio)
      if (mediaType === 'video' && f.audioQuality) {
        const audioCodecMatch = (f.mimeType || '').match(/codecs="([^,]+),\s*([^"]+)"/);
        if (audioCodecMatch) {
          normalized.vcodec = audioCodecMatch[1];
          normalized.acodec = audioCodecMatch[2];
        }
      }

        formats.push(normalized);
      }

      if (formats.length === 0) throw new Error('No usable formats from Innertube');

      innertubeBreaker.recordSuccess();

      // Build yt-dlp-compatible info object
      const videoDetails = data.videoDetails || {};
      return {
        formats,
        duration: parseInt(videoDetails.lengthSeconds, 10) || 0,
        title: videoDetails.title || '',
        description: videoDetails.shortDescription || '',
        _extractedVia: 'innertube',
      };
    } finally {
      request.cleanup();
    }
  } catch (err) {
    if (options.signal?.aborted && err?.name === 'AbortError') return null;
    innertubeBreaker.recordFailure();
    console.warn(`[extractors] Innertube failed for ${videoId}: ${err.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Invidious API extractor (third-party extraction service)
// ---------------------------------------------------------------------------
const DEFAULT_INVIDIOUS_INSTANCES = [
  'invidious.protokolla.fi',
  'inv.nadeko.net',
  'invidious.nerdvpn.de',
  'vid.puffyan.us',
];

const invidiousInstances = (process.env.INVIDIOUS_INSTANCES || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
if (invidiousInstances.length === 0) invidiousInstances.push(...DEFAULT_INVIDIOUS_INSTANCES);

const invidiousBreakers = new Map();
for (const inst of invidiousInstances) {
  invidiousBreakers.set(inst, createCircuitBreaker(`invidious:${inst}`, { threshold: 5, cooldownMs: 3 * 60 * 1000 }));
}

async function extractViaInvidious(videoId, options: ExtractorOptions = {}) {
  for (const instance of invidiousInstances) {
    if (options.signal?.aborted || (options.deadlineAt && Date.now() >= options.deadlineAt)) return null;
    const breaker = invidiousBreakers.get(instance);
    if (breaker.isOpen) continue;

    try {
      const request = requestController(options.signal, remainingTimeout(options, 8000));
      try {
        const resp = await fetch(`https://${instance}/api/v1/videos/${videoId}?fields=title,description,lengthSeconds,adaptiveFormats,formatStreams`, {
          signal: request.signal,
          headers: { 'User-Agent': 'Mozilla/5.0' },
        });

        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        // Captcha HTML naturally fails the bounded JSON parser and is handled
        // by this strategy's circuit breaker below.
        const data = await readJsonBounded(resp, 4 * 1024 * 1024, 'invidious-response-too-large');

        if (data.error) throw new Error(data.error);

        const formats = [];
        const allStreams = [
          ...(data.adaptiveFormats || []).map(s => ({ ...s, _source: 'adaptive' })),
          ...(data.formatStreams || []).map(s => ({ ...s, _source: 'muxed' })),
        ];

        for (const s of allStreams) {
          if (!s.url) continue;

          // Validate URL against YouTube CDN domain allowlist
          if (!isYouTubeCdnUrl(s.url)) continue;

          // Parse type field: 'video/mp4; codecs="avc1.4d401f"' or 'audio/mp4; codecs="mp4a.40.2"'
          const typeMatch = (s.type || '').match(/^(video|audio)\/(\w+)(?:;\s*codecs="([^"]+)")?/);
          if (!typeMatch) continue;

          const mediaType = typeMatch[1];
          const container = typeMatch[2];
          const codec = typeMatch[3] || '';

          const isMuxed = s._source === 'muxed';

          const normalized = {
            format_id: String(s.itag || 0),
            url: s.url,
            vcodec: mediaType === 'video' ? codec : 'none',
            acodec: mediaType === 'audio' ? codec : (isMuxed ? codec : 'none'),
            height: parseInt(s.resolution, 10) || 0,
            width: 0,
            ext: container === 'mp4' ? (mediaType === 'audio' ? 'm4a' : 'mp4') : container,
            tbr: s.bitrate ? Math.round(parseInt(s.bitrate, 10) / 1000) : 0,
            asr: 0,
            protocol: 'https',
            http_headers: {},
          };

          // For muxed, parse codecs from type like 'codecs="avc1, mp4a.40.2"'
          if (isMuxed && codec.includes(',')) {
            const parts = codec.split(',').map(c => c.trim());
            normalized.vcodec = parts[0];
            normalized.acodec = parts[1] || '';
          }

          formats.push(normalized);
        }

        if (formats.length === 0) throw new Error('No usable formats from Invidious');

        breaker.recordSuccess();
        console.log(`[extractors] Invidious (${instance}) returned ${formats.length} formats for ${videoId}`);

        return {
          formats,
          duration: data.lengthSeconds || 0,
          title: data.title || '',
          description: data.description || '',
          _extractedVia: `invidious:${instance}`,
        };
      } finally {
        request.cleanup();
      }
    } catch (err) {
      if (options.signal?.aborted && err?.name === 'AbortError') return null;
      breaker.recordFailure();
      console.warn(`[extractors] Invidious (${instance}) failed for ${videoId}: ${err.message}`);
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Live storyboard spec — tries unauthenticated Innertube first,
// falls back to yt-dlp --write-pages for authenticated extraction
// ---------------------------------------------------------------------------

function parseLiveStoryboardSpec(spec) {
  const parts = spec.split('#');
  return {
    urlTemplate: parts[0],
    thumbW: parseInt(parts[1]) || 159,
    thumbH: parseInt(parts[2]) || 90,
    cols: parseInt(parts[3]) || 3,
    rows: parseInt(parts[4]) || 3,
  };
}

async function fetchLiveStoryboardSpec(videoId: string, options: LiveStoryboardOptions = {}) {
  const runRequest = options.withRequestSlot || (async <T>(task: () => Promise<T>) => task());
  const runProcess = options.withProcessSlot || (async <T>(task: () => Promise<T>) => task());
  // Strategy 1: unauthenticated Innertube (works when IP isn't bot-flagged)
  if (!visitorData) await runRequest(() => refreshClientVersion(options.signal));
  try {
    const data = await runRequest(async () => {
      const request = requestController(options.signal, remainingTimeout(options, 10_000));
      try {
        const resp = await fetch(`https://www.youtube.com/youtubei/v1/player?key=${INNERTUBE_KEY}`, {
          method: 'POST',
          signal: request.signal,
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': ANDROID_VR_UA,
            'X-Goog-Visitor-Id': visitorData,
          },
          body: JSON.stringify({
            videoId,
            context: { client: { clientName: 'ANDROID_VR', clientVersion: '1.57.29', hl: 'en' } },
          }),
        });
        return resp.ok ? readJsonBounded(resp, 2 * 1024 * 1024, 'storyboard-response-too-large') : null;
      } finally {
        request.cleanup();
      }
    });
    const spec = data?.storyboards?.playerLiveStoryboardSpecRenderer?.spec;
    if (spec) return parseLiveStoryboardSpec(spec);
  } catch {}

  // Strategy 2: yt-dlp with browser cookies fetches the watch page,
  // which contains the storyboard spec in ytInitialPlayerResponse
  const { YTDLP_BIN, ytdlpBrowserArgs } = await import('./ytdlp.js');
  const browserArgs = await ytdlpBrowserArgs();
  if (!browserArgs) return null;

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sb-'));
  try {
    await runProcess(() => execFileAsync(YTDLP_BIN, [
        ...browserArgs, '--write-pages', '--skip-download', '--no-warnings',
        '-o', path.join(tmpDir, '%(id)s'), '--', videoId
      ], { timeout: remainingTimeout(options, 20_000), signal: options.signal, maxBuffer: 10 * 1024 * 1024 }));
    // Find the dumped watch page
    const files = (await fs.readdir(tmpDir)).filter(f => f.endsWith('.dump'));
    for (const file of files) {
      const dumpPath = path.join(tmpDir, file);
      const stat = await fs.stat(dumpPath);
      if (stat.size > 4 * 1024 * 1024) continue;
      const html = await fs.readFile(dumpPath);
      if (html.byteLength > 4 * 1024 * 1024) continue;
      const player = await parseEmbeddedJsonBuffer(html, 'ytInitialPlayerResponse');
      const spec = player?.storyboards?.playerLiveStoryboardSpecRenderer?.spec;
      if (spec) return parseLiveStoryboardSpec(spec);
    }
  } catch (err) {
    console.warn(`[extractors] live storyboard yt-dlp fallback failed for ${videoId}:`, (err as Error).message);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
  return null;
}

// Fetch the scheduled start time for an upcoming livestream/premiere via Innertube
async function fetchScheduledStart(videoId: string, parentSignal?: AbortSignal): Promise<string | undefined> {
  try {
    if (!visitorData) await refreshClientVersion(parentSignal);
    return await withYtSlot(async () => {
      const request = requestController(parentSignal, 6000);
      try {
        const resp = await fetch(`https://www.youtube.com/youtubei/v1/player?key=${INNERTUBE_KEY}`, {
          method: 'POST',
          signal: request.signal,
          headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT, 'X-Goog-Visitor-Id': visitorData },
          body: JSON.stringify({
            videoId,
            context: { client: { clientName: 'WEB', clientVersion: clientVersion, hl: 'en' } },
          }),
        });
        if (!resp.ok) return undefined;
        const data = await readJsonBounded(resp, 1024 * 1024, 'scheduled-start-response-too-large');
        const ts = data?.playabilityStatus?.liveStreamability?.liveStreamabilityRenderer?.offlineSlate
          ?.liveStreamOfflineSlateRenderer?.scheduledStartTime;
        return ts ? new Date(parseInt(ts, 10) * 1000).toISOString() : undefined;
      } finally {
        request.cleanup();
      }
    }, 'background', parentSignal);
  } catch {}
  return undefined;
}

export {
  createCircuitBreaker,
  getClientVersion,
  isYouTubeCdnUrl,
  extractViaInnertube,
  extractViaInvidious,
  fetchLiveStoryboardSpec,
  fetchScheduledStart,
  USER_AGENT,
};
