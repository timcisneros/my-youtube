import fs from 'fs';
import path from 'path';
import os from 'os';
import { promisify } from 'util';
import { execFile } from 'child_process';
import { YTDLP_BIN, ytdlpArgs } from '../../ytdlp.js';
import {
  withYtdlpSlot,
  isClientGone,
  vttCache,
  VTT_CACHE_TTL,
} from './shared.js';
import { getCached, extractFormats } from './extraction.js';

const execFileAsync = promisify(execFile);

// Download VTT via yt-dlp and cache it. Returns the VTT string or null.
async function fetchVttViaDlp(videoId, lang, isAuto) {
  const cacheKey = `${videoId}:${lang}`;
  const cached = vttCache.get(cacheKey);
  if (cached && Date.now() < cached.expires) return cached.vtt;

  const tmpBase = path.join(os.tmpdir(), `sub-${videoId}-${lang}-${Date.now()}`);
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
      if (!fs.existsSync(vttPath)) return null;
      const vtt = fs.readFileSync(vttPath, 'utf-8');
      try { fs.unlinkSync(vttPath); } catch {}
      vttCache.set(cacheKey, { vtt, expires: Date.now() + VTT_CACHE_TTL });
      return vtt;
    });
  } catch (e) {
    console.error(`[subtitles] yt-dlp failed for ${videoId}/${lang}:`, e.message);
    return null;
  }
}

function mountSubtitleRoutes(router) {
  // Subtitle VTT proxy — serves cached VTT content (pre-fetched by /subtitles listing)
  router.get('/:videoId/subtitles/:lang.vtt', async (req, res) => {
    try {
      const { videoId, lang } = req.params;
      if (!/^[a-zA-Z0-9_-]{1,20}$/.test(videoId) || !/^[a-zA-Z0-9_-]{1,20}$/.test(lang)) {
        return res.status(400).json({ error: 'Invalid parameters' });
      }

      // Check cache first (populated by the /subtitles listing endpoint)
      const cacheKey = `${videoId}:${lang}`;
      const cached = vttCache.get(cacheKey);
      if (cached && Date.now() < cached.expires) {
        res.set('Content-Type', 'text/vtt; charset=utf-8');
        res.set('Cache-Control', 'private, max-age=3600');
        return res.send(cached.vtt);
      }

      // Fallback: download via yt-dlp on demand
      const info = getCached(videoId, { staleOk: true }) || await extractFormats(videoId);
      const subs = info.subtitles || {};
      const isAuto = !subs[lang];
      const vtt = await fetchVttViaDlp(videoId, lang, isAuto);
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
      // Kick off VTT pre-fetch in background (capped to avoid semaphore starvation)
      const VTT_PREFETCH_LIMIT = 3;
      for (const sub of langs.slice(0, VTT_PREFETCH_LIMIT)) {
        fetchVttViaDlp(videoId, sub.lang, sub.auto).catch(err => console.warn(`[vtt-prefetch ${videoId}/${sub.lang}]`, err.message));
      }
      res.json(langs);
    } catch (err) {
      if (!res.headersSent) res.status(502).json({ error: 'Failed to list subtitles' });
    }
  });
}

export { mountSubtitleRoutes };
