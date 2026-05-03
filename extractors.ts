// Shared extraction utilities and fallback backends for video format extraction.
// Used by routes/stream.js (format extraction) and yt-meta.js (metadata fetching).

import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import os from 'os';

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

async function refreshClientVersion() {
  if (Date.now() < clientVersionExpires && Date.now() < visitorDataExpires) return;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const resp = await fetch('https://www.youtube.com/', {
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'en' },
    });
    const html = await resp.text();
    clearTimeout(timer);
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
    }
  } catch {
    clientVersionExpires = Date.now() + 60 * 60 * 1000;
  }
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

async function extractViaInnertube(videoId) {
  if (innertubeBreaker.isOpen) return null;

  try {
    // Ensure we have visitor data
    if (!visitorData) {
      await refreshClientVersion();
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const resp = await fetch(`https://www.youtube.com/youtubei/v1/player?key=${INNERTUBE_KEY}`, {
      method: 'POST',
      signal: controller.signal,
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

    if (!resp.ok) { clearTimeout(timer); throw new Error(`HTTP ${resp.status}`); }
    const data = await resp.json();
    clearTimeout(timer);

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
  } catch (err) {
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

async function extractViaInvidious(videoId) {
  for (const instance of invidiousInstances) {
    const breaker = invidiousBreakers.get(instance);
    if (breaker.isOpen) continue;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      const resp = await fetch(`https://${instance}/api/v1/videos/${videoId}?fields=title,description,lengthSeconds,adaptiveFormats,formatStreams`, {
        signal: controller.signal,
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });

      if (!resp.ok) { clearTimeout(timer); throw new Error(`HTTP ${resp.status}`); }
      const text = await resp.text();
      clearTimeout(timer);
      // Invidious may return HTML (captcha page) instead of JSON
      if (text.startsWith('<') || text.startsWith('<!')) throw new Error('Got HTML instead of JSON (likely captcha)');
      const data = JSON.parse(text);

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
    } catch (err) {
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

async function fetchLiveStoryboardSpec(videoId) {
  // Strategy 1: unauthenticated Innertube (works when IP isn't bot-flagged)
  if (!visitorData) await refreshClientVersion();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    const resp = await fetch(`https://www.youtube.com/youtubei/v1/player?key=${INNERTUBE_KEY}`, {
      method: 'POST',
      signal: controller.signal,
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
    if (resp.ok) {
      const data = await resp.json();
      clearTimeout(timer);
      const spec = data?.storyboards?.playerLiveStoryboardSpecRenderer?.spec;
      if (spec) return parseLiveStoryboardSpec(spec);
    } else {
      clearTimeout(timer);
    }
  } catch {}

  // Strategy 2: yt-dlp with browser cookies fetches the watch page,
  // which contains the storyboard spec in ytInitialPlayerResponse
  const { ytdlpBrowserArgs } = await import('./ytdlp.js');
  const browserArgs = ytdlpBrowserArgs();
  if (!browserArgs) return null;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-'));
  try {
    await execFileAsync('yt-dlp', [
      ...browserArgs, '--write-pages', '--skip-download', '--no-warnings',
      '-o', path.join(tmpDir, '%(id)s'), '--', videoId
    ], { timeout: 20000 });
    // Find the dumped watch page
    const files = fs.readdirSync(tmpDir).filter(f => f.endsWith('.dump'));
    for (const file of files) {
      const html = fs.readFileSync(path.join(tmpDir, file), 'utf-8');
      const marker = 'var ytInitialPlayerResponse = ';
      const idx = html.indexOf(marker);
      if (idx === -1) continue;
      const start = idx + marker.length;
      let depth = 0;
      for (let i = start; i < html.length; i++) {
        if (html[i] === '{') depth++;
        else if (html[i] === '}') { depth--; if (depth === 0) {
          const player = JSON.parse(html.slice(start, i + 1));
          const spec = player?.storyboards?.playerLiveStoryboardSpecRenderer?.spec;
          if (spec) return parseLiveStoryboardSpec(spec);
          break;
        }}
      }
    }
  } catch (err) {
    console.warn(`[extractors] live storyboard yt-dlp fallback failed for ${videoId}:`, err.message);
  } finally {
    // Clean up temp dir
    try {
      for (const f of fs.readdirSync(tmpDir)) fs.unlinkSync(path.join(tmpDir, f));
      fs.rmdirSync(tmpDir);
    } catch {}
  }
  return null;
}

// Fetch the scheduled start time for an upcoming livestream/premiere via Innertube
async function fetchScheduledStart(videoId: string): Promise<string | undefined> {
  try {
    if (!visitorData) await refreshClientVersion();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    const resp = await fetch(`https://www.youtube.com/youtubei/v1/player?key=${INNERTUBE_KEY}`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT, 'X-Goog-Visitor-Id': visitorData },
      body: JSON.stringify({
        videoId,
        context: { client: { clientName: 'WEB', clientVersion: clientVersion, hl: 'en' } },
      }),
    });
    if (!resp.ok) { clearTimeout(timer); return undefined; }
    const data = await resp.json();
    clearTimeout(timer);
    const ts = data?.playabilityStatus?.liveStreamability?.liveStreamabilityRenderer?.offlineSlate
      ?.liveStreamOfflineSlateRenderer?.scheduledStartTime;
    if (ts) return new Date(parseInt(ts, 10) * 1000).toISOString();
  } catch {}
  return undefined;
}

export {
  createCircuitBreaker,
  refreshClientVersion,
  getClientVersion,
  isYouTubeCdnUrl,
  extractViaInnertube,
  extractViaInvidious,
  fetchLiveStoryboardSpec,
  fetchScheduledStart,
  USER_AGENT,
};
