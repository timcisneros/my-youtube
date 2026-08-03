import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { promisify } from 'util';
import { execFile } from 'child_process';
import { randomUUID } from 'node:crypto';
import { YTDLP_BIN, ytdlpArgs } from '../../ytdlp.js';
import { isYouTubeCdnUrl } from '../../extractors.js';
import { incrementMetric } from '../../lib/performance-metrics.js';
import {
  withYtdlpSlot,
  fetchWithConnTimeout,
  PROXY_HEADERS,
  isClientGone,
  vttCache,
  VTT_CACHE_TTL,
  dedup,
} from './shared.js';
import { getCached, extractFormats } from './extraction.js';

const execFileAsync = promisify(execFile);
const MAX_VTT_BYTES = Math.max(256 * 1024, Number(process.env.MAX_VTT_BYTES) || 5 * 1024 * 1024);
const vttInflight = new Map<string, Promise<string | null>>();

function selectVttTrack(info, lang, isAuto) {
  const source = isAuto ? info.automatic_captions : info.subtitles;
  const tracks = source?.[lang];
  if (!Array.isArray(tracks)) return null;
  return tracks.find(track => track.ext === 'vtt' && typeof track.url === 'string') || null;
}

async function readBoundedVtt(response: Response) {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_VTT_BYTES) {
    await response.body?.cancel('subtitle-too-large').catch(() => {});
    throw new Error('subtitle-too-large');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_VTT_BYTES) {
      await reader.cancel('subtitle-too-large').catch(() => {});
      throw new Error('subtitle-too-large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map(chunk => Buffer.from(chunk)), bytes).toString('utf8');
}

async function fetchVttDirect(info, lang, isAuto) {
  const track = selectVttTrack(info, lang, isAuto);
  if (!track?.url || !isYouTubeCdnUrl(track.url)) return null;
  const response = await fetchWithConnTimeout(track.url, {
    headers: PROXY_HEADERS,
    bodyIdleMs: 10_000,
    outboundPriority: 'interactive',
  }, 10_000);
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    return null;
  }
  const vtt = await readBoundedVtt(response);
  return vtt.startsWith('WEBVTT') ? vtt : null;
}

// yt-dlp fallback for unavailable or expired direct caption URLs.
async function fetchVttViaDlp(videoId, lang, isAuto) {
  const tmpBase = path.join(os.tmpdir(), `sub-${videoId}-${lang}-${randomUUID()}`);
  const subArgs = [
    ...ytdlpArgs(), '--skip-download', '--sub-format', 'vtt', '-o', tmpBase,
  ];
  if (isAuto) {
    subArgs.push('--write-auto-subs', '--sub-langs', lang);
  } else {
    subArgs.push('--write-subs', '--sub-langs', lang);
  }
  subArgs.push('--', videoId);

  try {
    return await withYtdlpSlot(async () => {
      await execFileAsync(YTDLP_BIN, subArgs, { timeout: 30000, maxBuffer: 10 * 1024 * 1024 });
      const vttPath = `${tmpBase}.${lang}.vtt`;
      try {
        const stat = await fs.stat(vttPath);
        if (stat.size > MAX_VTT_BYTES) throw new Error('subtitle-too-large');
        const contents = await fs.readFile(vttPath);
        if (contents.byteLength > MAX_VTT_BYTES) throw new Error('subtitle-too-large');
        return contents.toString('utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      } finally {
        await fs.rm(vttPath, { force: true }).catch(() => {});
      }
    }, { priority: 'interactive' });
  } catch (e) {
    console.error(`[subtitles] yt-dlp failed for ${videoId}/${lang}:`, e.message);
    return null;
  }
}

async function fetchVtt(videoId, lang, isAuto, info) {
  const cacheKey = `${videoId}:${lang}`;
  const cached = await vttCache.getAsync(cacheKey);
  if (cached) return cached.vtt;

  return dedup(vttInflight, cacheKey, async () => {
    let vtt: string | null = null;
    try {
      vtt = await fetchVttDirect(info, lang, isAuto);
      if (vtt) incrementMetric('subtitle_fetches_total', { backend: 'direct', result: 'success' });
    } catch {
      incrementMetric('subtitle_fetches_total', { backend: 'direct', result: 'error' });
    }
    if (!vtt) {
      vtt = await fetchVttViaDlp(videoId, lang, isAuto);
      incrementMetric('subtitle_fetches_total', { backend: 'yt_dlp', result: vtt ? 'success' : 'error' });
    }
    if (vtt) await vttCache.setAsync(cacheKey, { vtt, expires: Date.now() + VTT_CACHE_TTL });
    return vtt;
  }, { name: 'stream_subtitles', maxEntries: 64 });
}

function mountSubtitleRoutes(router) {
  // Subtitle VTT proxy — serves cached content or fetches the selected track.
  router.get('/:videoId/subtitles/:lang.vtt', async (req, res) => {
    try {
      const { videoId, lang } = req.params;
      if (!/^[a-zA-Z0-9_-]{1,20}$/.test(videoId) || !/^[a-zA-Z0-9_-]{1,20}$/.test(lang)) {
        return res.status(400).json({ error: 'Invalid parameters' });
      }

      // Check the completed-content cache first.
      const cacheKey = `${videoId}:${lang}`;
      const cached = await vttCache.getAsync(cacheKey);
      if (cached) {
        res.set('Content-Type', 'text/vtt; charset=utf-8');
        res.set('Cache-Control', 'private, max-age=3600');
        return res.send(cached.vtt);
      }

      // Prefer the compact extraction result's direct VTT URL; use yt-dlp only
      // when that URL is missing, invalid, or expired.
      const info = getCached(videoId, { staleOk: true }) || await extractFormats(videoId);
      const subs = info.subtitles || {};
      const isAuto = !subs[lang];
      const vtt = await fetchVtt(videoId, lang, isAuto, info);
      if (!vtt) return res.status(404).json({ error: 'Caption not available' });

      res.set('Content-Type', 'text/vtt; charset=utf-8');
      res.set('Cache-Control', 'private, max-age=3600');
      res.send(vtt);
    } catch (err) {
      if (isClientGone(err)) return;
      console.error('[subtitles] error:', err.message);
      if (!res.headersSent) res.status(502).end();
    }
  });

  // Subtitle listing — returns available languages
  // Mirrors DASH MPD logic: all manual subtitles + auto-generated English only
  router.get('/:videoId/subtitles', async (req, res) => {
    try {
      const { videoId } = req.params;
      const info = getCached(videoId, { staleOk: true }) || await extractFormats(videoId);
      const subs = info.subtitles || {};
      const auto = info.automatic_captions || {};
      const displayNames = new Intl.DisplayNames(['en'], { type: 'language' });
      const langs = [];
      const manualLangs = new Set();
      // Manual subtitles first
      for (const lang of Object.keys(subs)) {
        if (subs[lang].some(t => t.ext === 'vtt')) {
          let name;
          try { name = displayNames.of(lang); } catch { name = lang; }
          langs.push({ lang, name, auto: false });
          manualLangs.add(lang);
        }
      }
      // Add auto-generated English if no manual English exists
      if (!manualLangs.has('en')) {
        var autoEn = auto['en'] || auto['en-orig'];
        if (autoEn && autoEn.some(t => t.ext === 'vtt')) {
          var autoKey = auto['en'] ? 'en' : 'en-orig';
          langs.push({ lang: autoKey, name: 'English (auto)', auto: true });
        }
      }
      res.json(langs);
    } catch (err) {
      if (!res.headersSent) res.status(502).json({ error: 'Failed to list subtitles' });
    }
  });
}

export { mountSubtitleRoutes };
