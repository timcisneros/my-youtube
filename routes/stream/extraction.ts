import { cacheVideoDetailsFromInfo } from '../../youtube/index.js';
import { extractViaInnertube, extractViaInvidious } from '../../extractors.js';
import { extractViaYtdlp, extractViaYtdlpAlt } from '../../lib/ytdlp-extract.js';
import { acquireLock, releaseLock, hasRedis } from '../../lib/cache.js';
import {
  withYtdlpSlot,
  formatCache,
  dedup,
  extractionInflight,
  CACHE_TTL,
} from './shared.js';
import { notifyExtractionStep, notifyExtractionDone } from './status.js';
import { hasQueue as hasExtractionQueue, enqueueExtraction } from '../../lib/extraction-queue.js';

// Stale-while-revalidate: return expired data immediately, refresh in background
function getCached(videoId, { staleOk = false } = {}) {
  const entry = formatCache.get(videoId);
  if (!entry) return null;
  if (Date.now() < entry.expires) return entry.data;
  // Entry is expired — serve stale if allowed, trigger background refresh
  if (staleOk) {
    if (!extractionInflight.has(videoId)) {
      // Keep stale entry — extractFormats overwrites on success via setCache.
      // If refresh fails, stale data is still available for the next caller.
      extractFormats(videoId).catch(err => console.warn(`[stale-refresh ${videoId}]`, err.message));
    }
    return entry.data;
  }
  formatCache.delete(videoId);
  return null;
}

function setCache(videoId, data) {
  formatCache.set(videoId, { data, expires: Date.now() + CACHE_TTL });
}

async function extractFormats(videoId) {
  const cached = getCached(videoId);
  if (cached) return cached;

  // Cross-worker dedup: check if another worker already has the result in Redis
  if (hasRedis()) {
    const redisEntry = await formatCache.getAsync(videoId);
    if (redisEntry && redisEntry.data && Date.now() < redisEntry.expires) return redisEntry.data;

    // Try to acquire extraction lock — if another worker is extracting, wait for result
    const lockAcquired = await acquireLock(`extract:${videoId}`, 60000);
    if (!lockAcquired) {
      // Another worker is extracting — poll Redis for result
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 1000 + Math.random() * 500));
        const entry = await formatCache.getAsync(videoId);
        if (entry && entry.data && Date.now() < entry.expires) return entry.data;
      }
      // Timeout — return temporary failure instead of duplicate extraction
      const timeoutResult = { formats: [], duration: 0, _unavailable: 'Extraction in progress. Try again in a moment.' };
      formatCache.set(videoId, { data: timeoutResult, expires: Date.now() + 10000 }); // short 10s TTL
      return timeoutResult;
    }
  }

  return dedup(extractionInflight, videoId, async () => {
    // Try extraction queue (separate worker process) if available
    if (hasExtractionQueue()) {
      try {
        notifyExtractionStep(videoId, 'queue');
        const result = await enqueueExtraction(videoId, 60000);
        if (result && result.formats) {
          const fmts = result.formats || [];
          const hlsCount = fmts.filter(f => f.protocol && f.protocol.startsWith('m3u8') && f.vcodec && f.vcodec !== 'none').length;
          const directCount = fmts.filter(f => f.url && (!f.protocol || f.protocol === 'https' || f.protocol === 'http')).length;
          console.log(`[stream ${videoId}] ${fmts.length} formats (${hlsCount} HLS, ${directCount} direct) via extraction-worker (${result._extractedVia || 'unknown'})`);
          setCache(videoId, result);
          cacheVideoDetailsFromInfo(videoId, result);
          releaseLock(`extract:${videoId}`).catch(err => console.warn('[extraction] lock release failed:', err.message));
          return result;
        }
        // Queue returned empty/null — fall through to in-process extraction
        console.warn(`[stream ${videoId}] extraction queue returned no result, falling back to in-process`);
      } catch (err) {
        console.warn(`[stream ${videoId}] extraction queue error, falling back to in-process:`, err.message);
      }
    }

    // Level 1 & 2: yt-dlp (with cookies -> browser cookies)
    notifyExtractionStep(videoId,'yt-dlp');
    const failedBackends: string[] = [];
    let lastError = '';
    let info = await extractViaYtdlp(videoId, withYtdlpSlot, 'yt-dlp');

    // If permanently unavailable (livestream, premiere), cache and return immediately
    if (info && info._permanent) {
      const { _permanent, ...result } = info;
      notifyExtractionDone(videoId);
      setCache(videoId, result);
      return result;
    }

    // Level 3: yt-dlp with alternative client
    if (!info) {
      failedBackends.push('yt-dlp');
      notifyExtractionStep(videoId,'yt-dlp-alt');
      lastError = `[stream ${videoId}] yt-dlp failed, trying alt client`;
      console.warn(lastError);
      info = await extractViaYtdlpAlt(videoId, withYtdlpSlot, 'yt-dlp-alt');
    }

    // Level 4: Innertube /player API (ANDROID_VR client)
    if (!info) {
      failedBackends.push('yt-dlp-alt');
      notifyExtractionStep(videoId,'innertube');
      lastError = `[stream ${videoId}] yt-dlp-alt failed, trying Innertube`;
      console.warn(lastError);
      info = await extractViaInnertube(videoId);
    }

    // Level 5: Invidious API (third-party extraction)
    if (!info) {
      failedBackends.push('innertube');
      notifyExtractionStep(videoId,'invidious');
      lastError = `[stream ${videoId}] Innertube failed, trying Invidious`;
      console.warn(lastError);
      info = await extractViaInvidious(videoId);
    }

    // All backends failed — short 15s negative cache so manual retry works quickly
    if (!info) {
      failedBackends.push('invidious');
      const msg = `Extraction failed (${failedBackends.join(' → ')}). Retrying may help — YouTube may be rate-limiting or requiring fresh cookies.`;
      console.error(`[stream ${videoId}] ${msg}`);
      const empty = { formats: [], duration: 0, _unavailable: msg };
      formatCache.set(videoId, { data: empty, expires: Date.now() + 15 * 1000 });
      return empty;
    }

    const fmts = info.formats || [];
    const hlsCount = fmts.filter(f => f.protocol && f.protocol.startsWith('m3u8') && f.vcodec && f.vcodec !== 'none').length;
    const directCount = fmts.filter(f => f.url && (!f.protocol || f.protocol === 'https' || f.protocol === 'http')).length;
    console.log(`[stream ${videoId}] ${fmts.length} formats (${hlsCount} HLS, ${directCount} direct), duration=${info.duration}s via ${info._extractedVia || 'yt-dlp'}`);
    setCache(videoId, info);
    // Populate video details cache so /watch/details can return instantly
    cacheVideoDetailsFromInfo(videoId, info);
    releaseLock(`extract:${videoId}`).catch(err => console.warn('[extraction] lock release failed:', err.message));
    return info;
  });
}

export {
  getCached,
  extractFormats,
};
