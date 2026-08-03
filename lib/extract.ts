/**
 * Shared extraction logic — used by the standalone extraction worker
 * (extraction-worker.ts). The web server uses routes/stream/extraction.ts
 * which adds caching, notifications, and Redis-aware semaphores on top of
 * the same core yt-dlp functions.
 *
 * Runs the extraction chain: yt-dlp → yt-dlp alt clients → Innertube → Invidious
 */
import { extractWithStrategy } from './extraction-strategy.js';
import { compactExtractionResult } from './extraction-result.js';
import { insertPriorityItem } from './ordered-priority-queue.js';

// Simple in-process semaphore for the worker (no Redis)
const MAX_CONCURRENT_YTDLP = Math.max(1, parseInt(process.env.MAX_CONCURRENT_YTDLP, 10) || 4);
const YTDLP_MAX_QUEUE = Math.max(8, Number(process.env.YTDLP_MAX_QUEUE) || 128);
const YTDLP_QUEUE_TIMEOUT_MS = Math.max(500, Number(process.env.YTDLP_QUEUE_TIMEOUT_MS) || 75_000);
let activeYtdlp = 0;
type YtdlpWaiter = {
  resolve: () => void;
  reject: (error: Error) => void;
  priority: number;
  order: number;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
};
const ytdlpQueue: YtdlpWaiter[] = [];
let queueOrder = 0;

function abortError() {
  const err = new Error('request-aborted');
  err.name = 'AbortError';
  return err;
}

function removeWaiter(waiter: YtdlpWaiter) {
  const index = ytdlpQueue.indexOf(waiter);
  if (index !== -1) ytdlpQueue.splice(index, 1);
}

function cleanupWaiter(waiter: YtdlpWaiter) {
  clearTimeout(waiter.timer);
  if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort);
}

function releaseYtdlpSlot() {
  const next = ytdlpQueue.shift();
  if (next) next.resolve();
  else activeYtdlp = Math.max(0, activeYtdlp - 1);
}

async function withYtdlpSlot<T>(fn: () => Promise<T>, options: { signal?: AbortSignal; priority?: string } = {}): Promise<T> {
  if (options.signal?.aborted) throw abortError();
  if (activeYtdlp < MAX_CONCURRENT_YTDLP) {
    activeYtdlp++;
  } else {
    if (ytdlpQueue.length >= YTDLP_MAX_QUEUE) throw new Error('ytdlp-admission-queue_full');
    await new Promise<void>((resolve, reject) => {
      let waiting = true;
      const waiter: YtdlpWaiter = {
        resolve: () => {
          if (!waiting) return;
          waiting = false;
          cleanupWaiter(waiter);
          resolve();
        },
        reject,
        priority: options.priority === 'background' || options.priority === 'prefetch' ? 10 : 1,
        order: queueOrder++,
        timer: setTimeout(() => {}, 0),
        signal: options.signal,
      };
      clearTimeout(waiter.timer);
      const fail = (error: Error) => {
        if (!waiting) return;
        waiting = false;
        removeWaiter(waiter);
        cleanupWaiter(waiter);
        reject(error);
      };
      waiter.onAbort = () => fail(abortError());
      options.signal?.addEventListener('abort', waiter.onAbort, { once: true });
      waiter.timer = setTimeout(() => fail(new Error('ytdlp-admission-timeout')), YTDLP_QUEUE_TIMEOUT_MS);
      waiter.timer.unref?.();
      insertPriorityItem(ytdlpQueue, waiter);
    });
  }
  try {
    if (options.signal?.aborted) throw abortError();
    return await fn();
  } finally {
    releaseYtdlpSlot();
  }
}

/**
 * Run the full extraction chain for a video.
 * Returns the info object with formats, or null if all backends failed.
 */
async function extractVideo(videoId: string, options = {}) {
  const info = await extractWithStrategy(videoId, withYtdlpSlot, {
    ...options,
    logTag: 'extract',
  });
  if (info?._permanent) {
    const { _permanent, ...result } = info;
    return compactExtractionResult(result);
  }
  return compactExtractionResult(info);
}

export { extractVideo };
