/**
 * Shared cache instances, TTL constants, and YouTube request semaphore.
 * Used by all youtube/ sub-modules.
 */
import LRUMap from '../lib/lru-map.js';
import { randomUUID } from 'node:crypto';
import { SharedLRUMap, getRedisClient } from '../lib/cache.js';
import { incrementMetric, observeMetric, setMetricGauge } from '../lib/performance-metrics.js';
import { insertPriorityItem } from '../lib/ordered-priority-queue.js';

// In-memory cache (LRU-bounded to prevent OOM)
// Shared caches use SharedLRUMap for Redis write-through across workers
// Per-user caches stay as plain LRUMap (user-scoped, not worth sharing)
const cache = {
  subscriptions: new SharedLRUMap(100, 'subscriptions', { maxL1Bytes: 8 * 1024 * 1024 }),
  todayVideos: new SharedLRUMap(500, 'today-pages-v2', { maxL1Bytes: 16 * 1024 * 1024 }),
  todayVersions: new SharedLRUMap(1000, 'today-versions-v1', { maxL1Bytes: 2 * 1024 * 1024 }),
  todayRefreshState: new SharedLRUMap(1000, 'today-refresh-state-v1', { maxL1Bytes: 2 * 1024 * 1024 }),
  exploreVideos: new SharedLRUMap(100, 'explore-v2', { maxL1Bytes: 16 * 1024 * 1024 }), // userId -> { data, expires }
  channelHandles: new SharedLRUMap(1000, 'chh-v1', { maxL1Bytes: 2 * 1024 * 1024 }),
  channelInfo: new SharedLRUMap(500, 'ch', { maxL1Bytes: 8 * 1024 * 1024 }),   // channelId -> { data, expires }
  channelVideos: new SharedLRUMap(1000, 'chv-v1', { maxL1Bytes: 32 * 1024 * 1024 }), // channelId:tab first-page browse result
  videoDetails: new SharedLRUMap(2000, 'vid', { maxL1Bytes: 32 * 1024 * 1024 }), // videoId -> { data, expires }
  watchNext: new SharedLRUMap(1000, 'watch-next-v1', {
    maxL1Bytes: 8 * 1024 * 1024,
    maxL1ValueBytes: 256 * 1024,
    maxRedisBytes: 256 * 1024,
  }),
  playlists: new SharedLRUMap(300, 'pl', { maxL1Bytes: 16 * 1024 * 1024 }),      // playlistId -> { data, expires }
  playlistContinuations: new SharedLRUMap(1000, 'pl-cont-v1', { maxL1Bytes: 32 * 1024 * 1024 }),
  rss: new SharedLRUMap(1000, 'rss', { maxL1Bytes: 32 * 1024 * 1024 }),          // channelId -> { data, expires }
  comments: new SharedLRUMap(500, 'comments-v1', {
    maxL1Bytes: 16 * 1024 * 1024,
    maxL1ValueBytes: 512 * 1024,
    maxRedisBytes: 512 * 1024,
  }),
};

const SUB_TTL = 6 * 60 * 60 * 1000;      // 6 hours
const TODAY_TTL = 30 * 60 * 1000;         // 30 minutes
const EXPLORE_TTL = 15 * 60 * 1000;       // 15 minutes
const CHANNEL_TTL = 60 * 60 * 1000;       // 1 hour
const CHANNEL_HANDLE_TTL = 24 * 60 * 60 * 1000; // 24 hours
const CHANNEL_VIDEOS_TTL = 5 * 60 * 1000; // 5 minutes
const VIDEO_DETAILS_TTL = 24 * 60 * 60 * 1000; // 24 hours
const PLAYLIST_TTL = 30 * 60 * 1000;      // 30 minutes
const RSS_TTL = 15 * 60 * 1000;          // 15 minutes

// Two-level semaphore — a worker-aware local cap prevents overload without
// Redis, while a renewable Redis lease enforces the aggregate cluster budget.
const MAX_CONCURRENT_YT_REQUESTS = Math.max(1, Number(process.env.YT_REQUEST_GLOBAL_CONCURRENCY) || 30);
const ytWorkerCount = Math.max(1, Number(process.env.CLUSTER_WORKER_COUNT) || 1);
const LOCAL_YT_REQUEST_LIMIT = Math.max(1, Number(process.env.YT_REQUEST_CONCURRENCY)
  || Math.floor(MAX_CONCURRENT_YT_REQUESTS / ytWorkerCount));
const YT_REQUEST_MAX_QUEUE = Math.max(10, Number(process.env.YT_REQUEST_MAX_QUEUE) || 1000);
const YT_REQUEST_QUEUE_TIMEOUT_MS = Math.max(500, Number(process.env.YT_REQUEST_QUEUE_TIMEOUT_MS) || 10_000);
const YT_REQUEST_LEASE_MS = Math.max(5_000, Number(process.env.YT_REQUEST_LEASE_MS) || 20_000);
let _activeYtRequests = 0;
const _ytRequestQueue: Array<{
  resolve: () => void;
  reject: (error: Error) => void;
  priority: number;
  order: number;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
}> = [];
let _ytQueueOrder = 0;

function youtubeQueueError(reason: 'full' | 'timeout') {
  const error = new Error(`youtube-request-queue-${reason}`);
  error.name = 'YouTubeRequestQueueError';
  return error;
}

function youtubeAbortError(signal?: AbortSignal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error('youtube-request-aborted');
  error.name = 'AbortError';
  return error;
}

function throwIfYoutubeAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw youtubeAbortError(signal);
}

function abortableYoutubeDelay(ms: number, signal?: AbortSignal) {
  if (!signal) return new Promise(resolve => setTimeout(resolve, ms));
  throwIfYoutubeAborted(signal);
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(youtubeAbortError(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function acquireLocalYtSlot(priority: string, deadline: number, signal?: AbortSignal) {
  throwIfYoutubeAborted(signal);
  if (_activeYtRequests < LOCAL_YT_REQUEST_LIMIT) {
    _activeYtRequests++;
    setMetricGauge('youtube_requests_active', _activeYtRequests);
    return;
  }
  if (_ytRequestQueue.length >= YT_REQUEST_MAX_QUEUE) {
    incrementMetric('youtube_request_rejections_total', { reason: 'queue_full', priority });
    throw youtubeQueueError('full');
  }
  await new Promise<void>((resolve, reject) => {
    const waiter: typeof _ytRequestQueue[number] = {
      resolve: () => {
        clearTimeout(waiter.timer);
        if (waiter.onAbort) waiter.signal?.removeEventListener('abort', waiter.onAbort);
        resolve();
      },
      reject: (error) => {
        clearTimeout(waiter.timer);
        if (waiter.onAbort) waiter.signal?.removeEventListener('abort', waiter.onAbort);
        reject(error);
      },
      priority: priority === 'background' ? 10 : 1,
      order: _ytQueueOrder++,
      timer: setTimeout(() => {}, 0),
      signal,
    };
    clearTimeout(waiter.timer);
    waiter.timer = setTimeout(() => {
      const index = _ytRequestQueue.indexOf(waiter);
      if (index !== -1) _ytRequestQueue.splice(index, 1);
      setMetricGauge('youtube_request_queue', _ytRequestQueue.length);
      incrementMetric('youtube_request_rejections_total', { reason: 'timeout', priority });
      waiter.reject(youtubeQueueError('timeout'));
    }, Math.max(1, deadline - Date.now()));
    waiter.timer.unref?.();
    if (signal) {
      waiter.onAbort = () => {
        const index = _ytRequestQueue.indexOf(waiter);
        if (index !== -1) _ytRequestQueue.splice(index, 1);
        setMetricGauge('youtube_request_queue', _ytRequestQueue.length);
        waiter.reject(youtubeAbortError(signal));
      };
      signal.addEventListener('abort', waiter.onAbort, { once: true });
    }
    insertPriorityItem(_ytRequestQueue, waiter);
    setMetricGauge('youtube_request_queue', _ytRequestQueue.length);
  });
}

function releaseLocalYtSlot() {
  const waiter = _ytRequestQueue.shift();
  if (waiter) {
    // Transfer the existing slot directly; keeping the active count unchanged
    // avoids a race where a new request can overbook before the waiter wakes.
    waiter.resolve();
  } else {
    _activeYtRequests = Math.max(0, _activeYtRequests - 1);
  }
  setMetricGauge('youtube_requests_active', _activeYtRequests);
  setMetricGauge('youtube_request_queue', _ytRequestQueue.length);
}

async function acquireClusterYtSlot(priority: string, deadline: number, signal?: AbortSignal) {
  const redis = getRedisClient();
  if (!redis) return null;
  const key = 'semaphore:youtube-requests';
  const token = `${process.pid}:${randomUUID()}`;
  let attempt = 0;
  try {
    while (Date.now() < deadline) {
      throwIfYoutubeAborted(signal);
      const now = Date.now();
      const acquired = await redis.eval(
        `redis.call('zremrangebyscore', KEYS[1], '-inf', ARGV[1])
         if redis.call('zcard', KEYS[1]) < tonumber(ARGV[2]) then
           redis.call('zadd', KEYS[1], ARGV[3], ARGV[4])
           redis.call('pexpire', KEYS[1], ARGV[5])
           return 1
         end
         return 0`,
        1,
        key,
        String(now),
        String(MAX_CONCURRENT_YT_REQUESTS),
        String(now + YT_REQUEST_LEASE_MS),
        token,
        String(YT_REQUEST_LEASE_MS * 2),
      );
      if (Number(acquired) === 1) {
        const renewTimer = setInterval(() => {
          const client = getRedisClient();
          if (!client) return;
          void client.eval(
            "if redis.call('zscore', KEYS[1], ARGV[1]) then redis.call('zadd', KEYS[1], 'XX', ARGV[2], ARGV[1]); redis.call('pexpire', KEYS[1], ARGV[3]); return 1 else return 0 end",
            1,
            key,
            token,
            String(Date.now() + YT_REQUEST_LEASE_MS),
            String(YT_REQUEST_LEASE_MS * 2),
          ).catch(() => {});
        }, Math.floor(YT_REQUEST_LEASE_MS / 3));
        renewTimer.unref?.();
        return { key, token, renewTimer };
      }
      const delay = Math.min(750, 75 * Math.pow(1.6, attempt++));
      await abortableYoutubeDelay(delay * (0.8 + Math.random() * 0.4), signal);
    }
  } catch {
    throwIfYoutubeAborted(signal);
    incrementMetric('youtube_coordination_fallbacks_total', { reason: 'redis' });
    return null;
  }
  incrementMetric('youtube_request_rejections_total', { reason: 'cluster_timeout', priority });
  throw youtubeQueueError('timeout');
}

async function releaseClusterYtSlot(lease: Awaited<ReturnType<typeof acquireClusterYtSlot>>) {
  if (!lease) return;
  clearInterval(lease.renewTimer);
  const redis = getRedisClient();
  if (redis) await redis.zrem(lease.key, lease.token).catch(() => {});
}

async function withYtSlot<T>(fn: () => Promise<T>, priority = 'interactive', signal?: AbortSignal): Promise<T> {
  const queuedAt = Date.now();
  const deadline = queuedAt + YT_REQUEST_QUEUE_TIMEOUT_MS;
  await acquireLocalYtSlot(priority, deadline, signal);
  let clusterLease: Awaited<ReturnType<typeof acquireClusterYtSlot>> = null;
  try {
    clusterLease = await acquireClusterYtSlot(priority, deadline, signal);
    throwIfYoutubeAborted(signal);
    if (Date.now() > queuedAt) {
      observeMetric('youtube_slot_wait_ms', Date.now() - queuedAt, { priority });
    }
    return await fn();
  } finally {
    releaseLocalYtSlot();
    await releaseClusterYtSlot(clusterLease);
  }
}

// Periodic cache sweep — prevents unbounded growth from one-time entries
const cacheSweepTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of cache.subscriptions) {
    if (now > entry.expires) cache.subscriptions.deleteLocal(key);
  }
  for (const [key, entry] of cache.todayVideos) {
    if (now > entry.expires) cache.todayVideos.deleteLocal(key);
  }
  for (const [key, entry] of cache.todayVersions) {
    if (now > entry.expires) cache.todayVersions.deleteLocal(key);
  }
  for (const [key, entry] of cache.todayRefreshState) {
    if (now > entry.expires) cache.todayRefreshState.deleteLocal(key);
  }
  for (const [key, entry] of cache.exploreVideos) {
    if (now > entry.expires) cache.exploreVideos.deleteLocal(key);
  }
  for (const [key, entry] of cache.channelInfo) {
    if (now > entry.expires) cache.channelInfo.deleteLocal(key);
  }
  for (const [key, entry] of cache.channelHandles) {
    if (now > entry.expires) cache.channelHandles.deleteLocal(key);
  }
  for (const [key, entry] of cache.channelVideos) {
    if (now > entry.expires) cache.channelVideos.deleteLocal(key);
  }
  for (const [key, entry] of cache.videoDetails) {
    if (now > entry.expires) cache.videoDetails.deleteLocal(key);
  }
  for (const [key, entry] of cache.watchNext) {
    if (now > entry.expires) cache.watchNext.deleteLocal(key);
  }
  for (const [key, entry] of cache.playlists) {
    if (now > entry.expires) cache.playlists.deleteLocal(key);
  }
  for (const [key, entry] of cache.playlistContinuations) {
    if (now > entry.expires) cache.playlistContinuations.deleteLocal(key);
  }
  for (const [key, entry] of cache.rss) {
    if (now > entry.expires) cache.rss.deleteLocal(key);
  }
  for (const [key, entry] of cache.comments) {
    if (now > entry.expires) cache.comments.deleteLocal(key);
  }
}, 10 * 60 * 1000);
if (typeof cacheSweepTimer.unref === 'function') cacheSweepTimer.unref();

export {
  cache, LRUMap, withYtSlot,
  SUB_TTL, TODAY_TTL, EXPLORE_TTL, CHANNEL_TTL, CHANNEL_HANDLE_TTL,
  CHANNEL_VIDEOS_TTL, VIDEO_DETAILS_TTL, PLAYLIST_TTL, RSS_TTL,
};
