import { randomUUID } from 'node:crypto';
import { Agent as UndiciAgent, setGlobalDispatcher } from 'undici';
import LRUMap from '../../lib/lru-map.js';
import { SharedLRUMap, hasRedis, getRedisClient } from '../../lib/cache.js';
import { fetchWithBodyTimeout } from '../../lib/bounded-fetch.js';
import { incrementMetric, observeMetric, setMetricGauge } from '../../lib/performance-metrics.js';
import { insertPriorityItem } from '../../lib/ordered-priority-queue.js';
import { DOWNLOADS_DIR } from '../../lib/download-files.js';
import { runBoundedSingleFlight } from '../../lib/bounded-singleflight.js';

// Undici's `connections` option is per origin, not process-wide. Googlevideo
// signed URLs span many origins, so a separate application semaphore below is
// what enforces the aggregate cluster budget for response-body lifetimes.
const dispatcherWorkerCount = Math.max(1, Number(process.env.CLUSTER_WORKER_COUNT) || 1);
const dispatcherGlobalConnections = Math.max(16, Number(process.env.UNDICI_GLOBAL_CONNECTIONS) || 128);
const outboundMediaLimit = Math.max(1, Math.floor(
  Math.max(dispatcherWorkerCount, Number(process.env.OUTBOUND_MEDIA_GLOBAL_CONCURRENCY) || dispatcherGlobalConnections)
    / dispatcherWorkerCount,
));
const dispatcherConnections = Math.max(1, Math.min(
  outboundMediaLimit,
  Number(process.env.UNDICI_CONNECTIONS) || 16,
));
const mediaDispatcher = new UndiciAgent({
  keepAliveTimeout: 60_000,
  keepAliveMaxTimeout: 120_000,
  connections: dispatcherConnections,
  pipelining: 1
});
setGlobalDispatcher(mediaDispatcher);

type OutboundMediaPriority = 'playback' | 'interactive' | 'background';
type StreamFetchInit = RequestInit & {
  bodyIdleMs?: number;
  outboundPriority?: OutboundMediaPriority;
  outboundQueueTimeoutMs?: number;
};
type OutboundWaiter = {
  priority: number;
  priorityName: OutboundMediaPriority;
  order: number;
  resolve: () => void;
  reject: (error: Error) => void;
  signal?: AbortSignal | null;
  onAbort?: () => void;
  timer?: ReturnType<typeof setTimeout>;
  queuedAt: number;
};

const OUTBOUND_MEDIA_MAX_QUEUE = Math.max(16, Number(process.env.OUTBOUND_MEDIA_MAX_QUEUE) || 512);
const OUTBOUND_MEDIA_QUEUE_TIMEOUT_MS = Math.max(1_000, Number(process.env.OUTBOUND_MEDIA_QUEUE_TIMEOUT_MS) || 10_000);
const outboundMediaQueue: OutboundWaiter[] = [];
const streamRequestControllers = new WeakMap<object, AbortController>();
const outboundMediaActiveByPriority: Record<OutboundMediaPriority, number> = {
  playback: 0,
  interactive: 0,
  background: 0,
};
let outboundMediaActive = 0;
let outboundMediaQueueOrder = 0;

function outboundPriorityValue(priority: OutboundMediaPriority) {
  if (priority === 'playback') return 1;
  if (priority === 'interactive') return 5;
  return 10;
}

function updateOutboundMediaMetrics() {
  setMetricGauge('outbound_media_active', outboundMediaActive);
  setMetricGauge('outbound_media_waiting', outboundMediaQueue.length);
  setMetricGauge('outbound_media_limit', outboundMediaLimit);
  for (const priority of Object.keys(outboundMediaActiveByPriority) as OutboundMediaPriority[]) {
    setMetricGauge('outbound_media_active_by_priority', outboundMediaActiveByPriority[priority], { priority });
  }
  try {
    setMetricGauge('outbound_media_origins', Object.keys(mediaDispatcher.stats).length);
  } catch {
    // Origin telemetry must never become a fetch dependency.
  }
}

function removeOutboundWaiter(waiter: OutboundWaiter) {
  const index = outboundMediaQueue.indexOf(waiter);
  if (index !== -1) outboundMediaQueue.splice(index, 1);
}

function cleanupOutboundWaiter(waiter: OutboundWaiter) {
  if (waiter.timer) clearTimeout(waiter.timer);
  if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort);
}

function activateOutboundSlot(priority: OutboundMediaPriority, queuedAt: number) {
  outboundMediaActive++;
  outboundMediaActiveByPriority[priority]++;
  incrementMetric('outbound_media_slots_total', { priority, result: 'acquired' });
  observeMetric('outbound_media_queue_wait_seconds', (performance.now() - queuedAt) / 1000, { priority });
  updateOutboundMediaMetrics();

  let released = false;
  return () => {
    if (released) return;
    released = true;
    outboundMediaActive = Math.max(0, outboundMediaActive - 1);
    outboundMediaActiveByPriority[priority] = Math.max(0, outboundMediaActiveByPriority[priority] - 1);
    const next = outboundMediaQueue.shift();
    if (next) {
      next.resolve();
    } else {
      updateOutboundMediaMetrics();
    }
  };
}

function acquireOutboundMediaSlot(
  priority: OutboundMediaPriority,
  signal?: AbortSignal | null,
  timeoutMs = OUTBOUND_MEDIA_QUEUE_TIMEOUT_MS,
) {
  const queuedAt = performance.now();
  if (signal?.aborted) return Promise.reject(abortError());
  if (outboundMediaActive < outboundMediaLimit) {
    return Promise.resolve(activateOutboundSlot(priority, queuedAt));
  }
  if (outboundMediaQueue.length >= OUTBOUND_MEDIA_MAX_QUEUE) {
    incrementMetric('outbound_media_slots_total', { priority, result: 'queue_full' });
    return Promise.reject(new Error('outbound-media-queue-full'));
  }

  return new Promise<() => void>((resolve, reject) => {
    let waiting = true;
    const waiter: OutboundWaiter = {
      priority: outboundPriorityValue(priority),
      priorityName: priority,
      order: outboundMediaQueueOrder++,
      queuedAt,
      signal,
      reject,
      resolve: () => {
        if (!waiting) return;
        waiting = false;
        cleanupOutboundWaiter(waiter);
        resolve(activateOutboundSlot(priority, queuedAt));
      },
    };
    const fail = (reason: 'aborted' | 'queue_timeout', error: Error) => {
      if (!waiting) return;
      waiting = false;
      removeOutboundWaiter(waiter);
      cleanupOutboundWaiter(waiter);
      incrementMetric('outbound_media_slots_total', { priority, result: reason });
      updateOutboundMediaMetrics();
      reject(error);
    };
    waiter.onAbort = () => fail('aborted', abortError());
    if (signal) signal.addEventListener('abort', waiter.onAbort, { once: true });
    waiter.timer = setTimeout(
      () => fail('queue_timeout', new Error('outbound-media-queue-timeout')),
      timeoutMs,
    );
    waiter.timer.unref?.();
    insertPriorityItem(outboundMediaQueue, waiter);
    updateOutboundMediaMetrics();
  });
}

function releaseWithResponseBody(response: Response, release: () => void) {
  if (!response.body) {
    release();
    return response;
  }
  const reader = response.body.getReader();
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    release();
  };
  void reader.closed.then(finish, finish);
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          finish();
          controller.close();
        } else {
          controller.enqueue(value);
        }
      } catch (error) {
        finish();
        controller.error(error);
      }
    },
    async cancel(reason) {
      finish();
      await reader.cancel(reason).catch(() => {});
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function getOutboundMediaState() {
  return {
    active: outboundMediaActive,
    waiting: outboundMediaQueue.length,
    limit: outboundMediaLimit,
    activeByPriority: { ...outboundMediaActiveByPriority },
  };
}

function streamRequestSignal(req, res) {
  const existing = streamRequestControllers.get(req);
  if (existing) return existing.signal;
  const controller = new AbortController();
  const abort = () => {
    if (!res.writableFinished && !controller.signal.aborted) controller.abort(abortError());
  };
  req.once('aborted', abort);
  res.once('close', abort);
  streamRequestControllers.set(req, controller);
  return controller.signal;
}

updateOutboundMediaMetrics();

// yt-dlp concurrency semaphore — caps parallel processes across all videos.
// Admission and task execution are deliberately separate: a task failure must
// never be mistaken for a Redis coordination failure and replayed locally.
const MAX_CONCURRENT_YTDLP = Math.max(1, parseInt(process.env.MAX_CONCURRENT_YTDLP, 10) || 4);
const YTDLP_MAX_QUEUE = Math.max(8, Number(process.env.YTDLP_MAX_QUEUE) || 128);
const YTDLP_QUEUE_TIMEOUT_MS = Math.max(500, Number(process.env.YTDLP_QUEUE_TIMEOUT_MS) || 75_000);
const YTDLP_LEASE_MS = 45_000;
const YTDLP_LEASE_RENEW_MS = 15_000;
let activeLocalYtdlp = 0;
let activeRedisYtdlp = 0;
let redisYtdlpWaiters = 0;
let ytdlpQueueOrder = 0;

type YtdlpPriority = 'playback' | 'interactive' | 'background' | 'prefetch';
type YtdlpRedisClient = {
  eval(script: string, numberOfKeys: number, ...args: string[]): Promise<unknown>;
  zrem(key: string, token: string): Promise<unknown>;
};
type YtdlpWaiter = {
  priority: number;
  priorityName: YtdlpPriority;
  order: number;
  queuedAt: number;
  signal?: AbortSignal;
  timer: ReturnType<typeof setTimeout>;
  onAbort?: () => void;
  resolve: () => void;
  reject: (error: Error) => void;
};
const ytdlpQueue: YtdlpWaiter[] = [];

class YtdlpAdmissionError extends Error {
  readonly reason: 'queue_full' | 'timeout';

  constructor(reason: 'queue_full' | 'timeout') {
    super(`ytdlp-admission-${reason}`);
    this.name = 'YtdlpAdmissionError';
    this.reason = reason;
  }
}

function abortError() {
  const err = new Error('request-aborted');
  err.name = 'AbortError';
  return err;
}

function priorityValue(priority) {
  return priority === 'background' || priority === 'prefetch' ? 10 : 1;
}

interface YtdlpSlotOptions {
  signal?: AbortSignal;
  priority?: string;
  queueTimeoutMs?: number;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}

function ytdlpPriorityName(priority?: string): YtdlpPriority {
  if (priority === 'background' || priority === 'prefetch' || priority === 'interactive') return priority;
  return 'playback';
}

function updateYtdlpMetrics() {
  setMetricGauge('ytdlp_active_jobs', activeLocalYtdlp + activeRedisYtdlp);
  setMetricGauge('ytdlp_active_jobs_backend', activeLocalYtdlp, { backend: 'local' });
  setMetricGauge('ytdlp_active_jobs_backend', activeRedisYtdlp, { backend: 'redis' });
  setMetricGauge('ytdlp_waiting_jobs', ytdlpQueue.length + redisYtdlpWaiters);
  setMetricGauge('ytdlp_waiting_jobs_backend', ytdlpQueue.length, { backend: 'local' });
  setMetricGauge('ytdlp_waiting_jobs_backend', redisYtdlpWaiters, { backend: 'redis' });
}

function removeYtdlpWaiter(waiter: YtdlpWaiter) {
  const index = ytdlpQueue.indexOf(waiter);
  if (index !== -1) ytdlpQueue.splice(index, 1);
}

function cleanupYtdlpWaiter(waiter: YtdlpWaiter) {
  clearTimeout(waiter.timer);
  if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort);
}

async function acquireLocalYtdlpSlot(options: YtdlpSlotOptions, deadline: number) {
  const priorityName = ytdlpPriorityName(options.priority);
  throwIfAborted(options.signal);
  if (activeLocalYtdlp < MAX_CONCURRENT_YTDLP) {
    activeLocalYtdlp++;
    incrementMetric('ytdlp_admission_total', { backend: 'local', priority: priorityName, result: 'acquired' });
    updateYtdlpMetrics();
    return;
  }
  if (ytdlpQueue.length >= YTDLP_MAX_QUEUE) {
    incrementMetric('ytdlp_admission_total', { backend: 'local', priority: priorityName, result: 'queue_full' });
    throw new YtdlpAdmissionError('queue_full');
  }

  await new Promise<void>((resolve, reject) => {
    let waiting = true;
    const waiter: YtdlpWaiter = {
      priority: priorityValue(priorityName),
      priorityName,
      order: ytdlpQueueOrder++,
      queuedAt: Date.now(),
      signal: options.signal,
      timer: setTimeout(() => {}, 0),
      resolve: () => {
        if (!waiting) return;
        waiting = false;
        cleanupYtdlpWaiter(waiter);
        observeMetric('ytdlp_slot_wait_ms', Date.now() - waiter.queuedAt, { backend: 'local', priority: priorityName });
        incrementMetric('ytdlp_admission_total', { backend: 'local', priority: priorityName, result: 'acquired' });
        updateYtdlpMetrics();
        resolve();
      },
      reject,
    };
    clearTimeout(waiter.timer);
    const fail = (error: Error, result: 'aborted' | 'timeout') => {
      if (!waiting) return;
      waiting = false;
      removeYtdlpWaiter(waiter);
      cleanupYtdlpWaiter(waiter);
      incrementMetric('ytdlp_admission_total', { backend: 'local', priority: priorityName, result });
      updateYtdlpMetrics();
      reject(error);
    };
    waiter.onAbort = () => fail(abortError(), 'aborted');
    if (options.signal) options.signal.addEventListener('abort', waiter.onAbort, { once: true });
    waiter.timer = setTimeout(
      () => fail(new YtdlpAdmissionError('timeout'), 'timeout'),
      Math.max(1, deadline - Date.now()),
    );
    waiter.timer.unref?.();
    insertPriorityItem(ytdlpQueue, waiter);
    updateYtdlpMetrics();
  });
}

function releaseLocalYtdlpSlot() {
  const next = ytdlpQueue.shift();
  if (next) {
    // Transfer the slot directly so a new arrival cannot overbook between the
    // release and the queued task resuming.
    next.resolve();
  } else {
    activeLocalYtdlp = Math.max(0, activeLocalYtdlp - 1);
    updateYtdlpMetrics();
  }
}

function abortableYtdlpDelay(ms: number, signal?: AbortSignal) {
  throwIfAborted(signal);
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, Math.max(1, ms));
    timer.unref?.();
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function acquireRedisYtdlpSlot(
  redis: YtdlpRedisClient,
  options: YtdlpSlotOptions,
  deadline: number,
) {
  const key = 'ytdlp:leases';
  const token = randomUUID();
  const acquireScript = `
    redis.call('zremrangebyscore', KEYS[1], '-inf', ARGV[1])
    if redis.call('zcard', KEYS[1]) < tonumber(ARGV[2]) then
      redis.call('zadd', KEYS[1], ARGV[3], ARGV[4])
      redis.call('pexpire', KEYS[1], ARGV[5])
      return 1
    end
    return 0
  `;

  const priorityName = ytdlpPriorityName(options.priority);
  const coordinationStartedAt = Date.now();
  while (Date.now() < deadline) {
    throwIfAborted(options?.signal);
    const now = Date.now();
    let acquired: unknown;
    try {
      acquired = await redis.eval(
        acquireScript,
        1,
        key,
        String(now),
        String(MAX_CONCURRENT_YTDLP),
        String(now + YTDLP_LEASE_MS),
        token,
        String(YTDLP_LEASE_MS * 3),
      );
    } catch (error) {
      // A client-side command timeout has an uncertain outcome. Queue a token
      // cleanup before falling back locally so a late Redis execution cannot
      // leave a ghost lease consuming cluster capacity.
      await redis.zrem(key, token).catch(() => {});
      throw error;
    }
    if (Number(acquired) === 1) {
      observeMetric('ytdlp_slot_wait_ms', Date.now() - coordinationStartedAt, { backend: 'redis', priority: priorityName });
      incrementMetric('ytdlp_admission_total', { backend: 'redis', priority: priorityName, result: 'acquired' });
      const renewTimer = setInterval(() => {
        const expires = Date.now() + YTDLP_LEASE_MS;
        void redis.eval(
          "if redis.call('zscore', KEYS[1], ARGV[1]) then redis.call('zadd', KEYS[1], ARGV[2], ARGV[1]); redis.call('pexpire', KEYS[1], ARGV[3]); return 1 else return 0 end",
          1,
          key,
          token,
          String(expires),
          String(YTDLP_LEASE_MS * 3),
        ).catch(() => {});
      }, YTDLP_LEASE_RENEW_MS);
      renewTimer.unref?.();
      let released = false;
      return {
        async release() {
          if (released) return;
          released = true;
          clearInterval(renewTimer);
          await redis.zrem(key, token).catch(() => {});
        },
      };
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await abortableYtdlpDelay(Math.min(remaining, 200 + Math.random() * 300), options.signal);
  }
  incrementMetric('ytdlp_admission_total', { backend: 'redis', priority: priorityName, result: 'timeout' });
  throw new YtdlpAdmissionError('timeout');
}

async function runYtdlpTaskWithAdmission<T>(
  fn: () => Promise<T>,
  options: YtdlpSlotOptions = {},
  redis: YtdlpRedisClient | null = null,
): Promise<T> {
  throwIfAborted(options.signal);
  const timeoutMs = Math.max(25, Number(options.queueTimeoutMs) || YTDLP_QUEUE_TIMEOUT_MS);
  const deadline = Date.now() + timeoutMs;

  if (redis) {
    const priorityName = ytdlpPriorityName(options.priority);
    if (redisYtdlpWaiters >= YTDLP_MAX_QUEUE) {
      incrementMetric('ytdlp_admission_total', { backend: 'redis', priority: priorityName, result: 'queue_full' });
      throw new YtdlpAdmissionError('queue_full');
    }
    redisYtdlpWaiters++;
    updateYtdlpMetrics();
    let lease: Awaited<ReturnType<typeof acquireRedisYtdlpSlot>> | null = null;
    try {
      lease = await acquireRedisYtdlpSlot(redis, options, deadline);
    } catch (error) {
      throwIfAborted(options.signal);
      if (error instanceof YtdlpAdmissionError) throw error;
      // Only acquisition errors enter the local fallback. The task itself runs
      // outside this catch block and therefore can never be replayed.
      incrementMetric('ytdlp_coordination_fallbacks_total', { reason: 'redis' });
      console.warn('[ytdlp] Redis coordination unavailable, using local slots:', (error as Error).message);
    } finally {
      redisYtdlpWaiters = Math.max(0, redisYtdlpWaiters - 1);
      updateYtdlpMetrics();
    }
    if (lease) {
      activeRedisYtdlp++;
      updateYtdlpMetrics();
      try {
        throwIfAborted(options.signal);
        return await fn();
      } finally {
        activeRedisYtdlp = Math.max(0, activeRedisYtdlp - 1);
        updateYtdlpMetrics();
        await lease.release();
      }
    }
  }

  await acquireLocalYtdlpSlot(options, deadline);
  try {
    throwIfAborted(options.signal);
    return await fn();
  } finally {
    releaseLocalYtdlpSlot();
  }
}

async function withYtdlpSlot<T>(fn: () => Promise<T>, options: YtdlpSlotOptions = {}): Promise<T> {
  const redis = hasRedis() ? getRedisClient() as YtdlpRedisClient | null : null;
  return runYtdlpTaskWithAdmission(fn, options, redis);
}

updateYtdlpMetrics();

// Privacy-safe headers for outbound proxy requests — no Referer, no Cookie, minimal UA
const PROXY_HEADERS = { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': '*', Referer: '', Cookie: '' };

// Fetch with both a header deadline and a renewable body-idle deadline. A CDN
// can return headers and then stop sending bytes; keeping the same controller
// alive through body consumption prevents those sockets from pinning workers.
async function fetchWithConnTimeout(url: string, opts: StreamFetchInit = {}, ms?: number) {
  const {
    bodyIdleMs = 30_000,
    outboundPriority = 'playback',
    outboundQueueTimeoutMs = OUTBOUND_MEDIA_QUEUE_TIMEOUT_MS,
    ...fetchOpts
  } = opts;
  const release = await acquireOutboundMediaSlot(outboundPriority, fetchOpts.signal, outboundQueueTimeoutMs);
  try {
    const response = await fetchWithBodyTimeout(url, fetchOpts, {
      headerTimeoutMs: ms || 15_000,
      bodyIdleMs,
    });
    return releaseWithResponseBody(response, release);
  } catch (error) {
    release();
    throw error;
  }
}

// Strip yt-dlp http_headers down to privacy-safe defaults.
// yt-dlp returns headers like Accept-Language (leaks locale), Sec-Fetch-Mode (fingerprints
// extraction), and User-Agent. CDN URLs are pre-signed so no auth headers are needed.
function sanitizeHeaders(_headers?) {
  return { ...PROXY_HEADERS };
}

// Errors expected when the client disconnects mid-stream (e.g. page refresh)
function isClientGone(err) {
  return err.code === 'ERR_STREAM_PREMATURE_CLOSE'
    || err.code === 'ERR_STREAM_DESTROYED'
    || err.code === 'ECONNRESET'
    || err.code === 'ERR_STREAM_WRITE_AFTER_END'
    || (err.message && err.message.includes('closed or destroyed'));
}

// Cache yt-dlp output per videoId (TTL 4 hours)
const formatCache = new SharedLRUMap(200, 'fmt', {
  maxRedisBytes: Math.max(128 * 1024, Number(process.env.EXTRACTION_CACHE_MAX_BYTES) || 1024 * 1024),
  maxL1Bytes: Math.max(4 * 1024 * 1024, Number(process.env.FORMAT_CACHE_L1_BYTES) || 64 * 1024 * 1024),
  maxL1ValueBytes: Math.max(1024 * 1024, Number(process.env.FORMAT_CACHE_L1_MAX_VALUE_BYTES) || 4 * 1024 * 1024),
});
// Cache generated MPD per videoId
const mpdCache = new SharedLRUMap(500, 'mpd', { maxL1Bytes: 32 * 1024 * 1024, maxL1ValueBytes: 2 * 1024 * 1024 });
// Fast lookup: "videoId:itag" -> direct YouTube CDN URL
const urlLookup = new SharedLRUMap(2000, 'url', { maxL1Bytes: 16 * 1024 * 1024, maxL1ValueBytes: 64 * 1024 });
// Cache MP4 probe results to avoid redundant Range requests for same format
const mp4ProbeCache = new LRUMap(500);
// HLS manifest URL cache
const hlsCache = new SharedLRUMap(300, 'hls', { maxL1Bytes: 16 * 1024 * 1024, maxL1ValueBytes: 2 * 1024 * 1024 });
// In-memory VTT cache: "videoId:lang" -> { vtt: string, expires: number }
const vttCache = new SharedLRUMap(100, 'vtt', {
  maxL1Bytes: Math.max(8 * 1024 * 1024, Number(process.env.VTT_CACHE_L1_BYTES) || 32 * 1024 * 1024),
  maxL1ValueBytes: Math.max(256 * 1024, Number(process.env.MAX_VTT_BYTES) || 5 * 1024 * 1024),
});
// Storyboard sheet cache: videoId -> array of YouTube URLs
const storyboardUrlCache = new LRUMap(500);
// Live storyboard results, including short-lived misses, are shared so a cold
// cluster does not repeat the same Innertube/yt-dlp fallback per worker.
const liveStoryboardCache = new SharedLRUMap(100, 'live-storyboard-v1', { maxL1Bytes: 8 * 1024 * 1024, maxL1ValueBytes: 2 * 1024 * 1024 });
// Extraction status visible to the client via /status endpoint
const extractionStatus = new LRUMap(100);

// Deduplicates concurrent async calls for the same key.
// While a call for key K is in-flight, subsequent calls return the same promise.
function dedup<TResult>(
  map: Map<unknown, unknown>,
  key: unknown,
  fn: () => Promise<TResult> | TResult,
  options = { name: 'stream', maxEntries: 256 },
): Promise<TResult> {
  return runBoundedSingleFlight(
    map as Map<unknown, Promise<TResult>>,
    key,
    fn,
    options,
  );
}
const extractionInflight = new Map();

const CACHE_TTL = 4 * 60 * 60 * 1000;
const PROACTIVE_REFRESH_AGE = 3 * 60 * 60 * 1000; // refresh in background when cache older than 3h
const VTT_CACHE_TTL = 4 * 60 * 60 * 1000;
const MAX_BG_DOWNLOADS = 4;
const BG_MAX_AGE = 60 * 60 * 1000; // 1 hour

// Select the best HLS variant: prefer original-language, then highest resolution
function selectBestHlsFormat(formats, language) {
  const candidates = formats
    .filter(f => f.protocol && f.protocol.startsWith('m3u8') && f.url && f.vcodec && f.vcodec !== 'none')
    .sort((a, b) => (b.height || 0) - (a.height || 0));
  const origLang = language || '';
  const isOrig = f => (f.format_note && /original/i.test(f.format_note))
    || (origLang && f.language && f.language.split('-')[0] === origLang.split('-')[0]);
  return candidates.find(f => isOrig(f)) || candidates[0] || null;
}

export {
  DOWNLOADS_DIR,
  withYtdlpSlot,
  runYtdlpTaskWithAdmission,
  YtdlpAdmissionError,
  PROXY_HEADERS,
  fetchWithConnTimeout,
  getOutboundMediaState,
  streamRequestSignal,
  sanitizeHeaders,
  isClientGone,
  formatCache,
  mpdCache,
  urlLookup,
  mp4ProbeCache,
  hlsCache,
  vttCache,
  storyboardUrlCache,
  liveStoryboardCache,
  extractionStatus,
  dedup,
  extractionInflight,
  CACHE_TTL,
  PROACTIVE_REFRESH_AGE,
  VTT_CACHE_TTL,
  MAX_BG_DOWNLOADS,
  BG_MAX_AGE,
  selectBestHlsFormat,
};
