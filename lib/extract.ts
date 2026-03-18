/**
 * Shared extraction logic — used by the standalone extraction worker
 * (extraction-worker.ts). The web server uses routes/stream/extraction.ts
 * which adds caching, notifications, and Redis-aware semaphores on top of
 * the same core yt-dlp functions.
 *
 * Runs the extraction chain: yt-dlp → yt-dlp alt clients → Innertube → Invidious
 */
import { extractViaInnertube, extractViaInvidious } from '../extractors.js';
import { extractViaYtdlp, extractViaYtdlpAlt } from './ytdlp-extract.js';

// Simple in-process semaphore for the worker (no Redis)
const MAX_CONCURRENT_YTDLP = parseInt(process.env.MAX_CONCURRENT_YTDLP, 10) || 4;
let activeYtdlp = 0;
const ytdlpQueue: Array<() => void> = [];

async function withYtdlpSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (activeYtdlp >= MAX_CONCURRENT_YTDLP) {
    await new Promise<void>(resolve => ytdlpQueue.push(resolve));
  }
  activeYtdlp++;
  try {
    return await fn();
  } finally {
    activeYtdlp--;
    if (ytdlpQueue.length) ytdlpQueue.shift()!();
  }
}

/**
 * Run the full extraction chain for a video.
 * Returns the info object with formats, or null if all backends failed.
 */
async function extractVideo(videoId: string) {
  // Level 1 & 2: yt-dlp (with cookies -> browser cookies)
  let info = await extractViaYtdlp(videoId, withYtdlpSlot, 'extract');

  // If permanently unavailable (livestream, premiere), return immediately
  if (info && info._permanent) {
    const { _permanent, ...result } = info;
    return result;
  }

  // Level 3: yt-dlp with alternative clients
  if (!info) {
    console.warn(`[extract ${videoId}] yt-dlp failed, trying alt client`);
    info = await extractViaYtdlpAlt(videoId, withYtdlpSlot, 'extract-alt');
  }

  // Level 4: Innertube /player API
  if (!info) {
    console.warn(`[extract ${videoId}] yt-dlp-alt failed, trying Innertube`);
    info = await extractViaInnertube(videoId);
  }

  // Level 5: Invidious API
  if (!info) {
    console.warn(`[extract ${videoId}] Innertube failed, trying Invidious`);
    info = await extractViaInvidious(videoId);
  }

  return info;
}

export { extractVideo };
