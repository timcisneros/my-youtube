/**
 * Hot segment cache — caches frequently-requested video segments in Redis.
 * When multiple users watch the same video, segments are served from Redis
 * instead of making redundant YouTube CDN fetches.
 *
 * Only caches segments under 2MB. TTL is 30 minutes.
 * Uses CACHE_REDIS_URL when set, otherwise REDIS_URL.
 */
import { hasCacheRedis, getCacheRedisClient } from './cache.js';
import { incrementMetric, observeMetric, setMetricGauge } from './performance-metrics.js';

const MAX_SEGMENT_SIZE = 2 * 1024 * 1024; // 2MB
const SEGMENT_TTL = 30 * 60; // 30 minutes in seconds
const HOT_THRESHOLD = 2; // Cache after 2nd request
const WRITE_BUDGET_BYTES = Math.max(16 * 1024 * 1024, Number(process.env.SEGMENT_CACHE_WRITE_BUDGET_BYTES) || 128 * 1024 * 1024);
const NEGATIVE_CACHE_MS = 15_000;
const BUDGET_KEY = 'seg:write-budget';
const COLLECTION_BUDGET_BYTES = Math.max(MAX_SEGMENT_SIZE, Number(process.env.SEGMENT_CACHE_COLLECTION_BUDGET_BYTES) || 16 * 1024 * 1024);
const MAX_SEGMENT_FLIGHTS = Math.max(8, Number(process.env.MAX_SEGMENT_FLIGHTS) || 128);
const SEGMENT_FLIGHT_TIMEOUT_MS = Math.max(5_000, Number(process.env.SEGMENT_FLIGHT_TIMEOUT_MS) || 45_000);
let activeCollectionBytes = 0;

type SegmentPayload = {
  data: Buffer;
  contentType: string | null;
  contentLength: number;
  contentRange: string | null;
  status: number;
};
type SegmentFlightEntry = {
  promise: Promise<SegmentPayload | null>;
  resolve: (payload: SegmentPayload | null) => void;
  timer: ReturnType<typeof setTimeout>;
  startedAt: number;
};
type SegmentFlight = {
  leader: boolean;
  promise: Promise<SegmentPayload | null>;
  complete?: (payload: SegmentPayload | null) => void;
};

// Track request counts per segment (in-memory, per-worker)
import LRUMap from './lru-map.js';
const requestCounts = new LRUMap(5000);
const negativeRedisMisses = new LRUMap(5000);
const segmentFlights = new Map<string, SegmentFlightEntry>();

function segmentCountKey(videoId, formatId, rangeHeader) {
  return `${videoId}:${formatId}:${rangeHeader || ''}`;
}

function exactRangeBytes(rangeHeader) {
  if (typeof rangeHeader !== 'string') return null;
  const match = rangeHeader.match(/^bytes=(\d+)-(\d+)$/);
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) return null;
  const bytes = end - start + 1;
  return bytes <= MAX_SEGMENT_SIZE ? bytes : null;
}

/**
 * Collapse concurrent exact small-range requests inside a web worker. The
 * leader continues streaming immediately while followers wait for its bounded
 * collection buffer; large/open-ended media ranges never enter this map.
 */
function joinSegmentFlight(videoId, formatId, rangeHeader): SegmentFlight | null {
  if (exactRangeBytes(rangeHeader) === null) return null;
  const key = segmentCountKey(videoId, formatId, rangeHeader);
  const existing = segmentFlights.get(key);
  if (existing) {
    requestCounts.set(key, (requestCounts.get(key) || 0) + 1);
    incrementMetric('segment_singleflight_requests_total', { result: 'follower' });
    return { leader: false, promise: existing.promise };
  }
  if (segmentFlights.size >= MAX_SEGMENT_FLIGHTS) {
    incrementMetric('segment_singleflight_requests_total', { result: 'capacity' });
    return null;
  }
  requestCounts.set(key, (requestCounts.get(key) || 0) + 1);

  let resolvePromise: (payload: SegmentPayload | null) => void = () => {};
  const promise = new Promise<SegmentPayload | null>((resolve) => {
    resolvePromise = resolve;
  });
  const entry = {
    promise,
    resolve: resolvePromise,
    startedAt: performance.now(),
    timer: undefined as unknown as ReturnType<typeof setTimeout>,
  };
  const finish = (payload: SegmentPayload | null) => {
    if (segmentFlights.get(key) !== entry) return;
    segmentFlights.delete(key);
    clearTimeout(entry.timer);
    entry.resolve(payload);
    setMetricGauge('segment_singleflight_active', segmentFlights.size);
  };
  entry.timer = setTimeout(() => {
    incrementMetric('segment_singleflight_requests_total', { result: 'timeout' });
    finish(null);
  }, SEGMENT_FLIGHT_TIMEOUT_MS);
  entry.timer.unref?.();
  segmentFlights.set(key, entry);
  setMetricGauge('segment_singleflight_active', segmentFlights.size);
  incrementMetric('segment_singleflight_requests_total', { result: 'leader' });
  return {
    leader: true,
    promise,
    complete(payload) {
      observeMetric('segment_singleflight_duration_seconds', (performance.now() - entry.startedAt) / 1000, {
        result: payload ? 'shared' : 'unavailable',
      });
      finish(payload);
    },
  };
}

function isObservedSegmentHot(videoId, formatId, rangeHeader) {
  return (requestCounts.get(segmentCountKey(videoId, formatId, rangeHeader)) || 0) >= HOT_THRESHOLD;
}

/**
 * Avoid a Redis round trip for every range request. A worker checks Redis only
 * after it has observed the segment locally, and briefly remembers misses.
 */
function shouldCheckSegment(videoId, formatId, rangeHeader) {
  if (!hasCacheRedis()) return false;
  const countKey = segmentCountKey(videoId, formatId, rangeHeader);
  if ((requestCounts.get(countKey) || 0) < HOT_THRESHOLD - 1) return false;
  const negativeUntil = negativeRedisMisses.get(countKey) || 0;
  if (negativeUntil > Date.now()) {
    incrementMetric('segment_cache_redis_skips_total', { reason: 'negative_cache' });
    return false;
  }
  if (negativeUntil) negativeRedisMisses.delete(countKey);
  return true;
}

/**
 * Check if a segment is cached in Redis.
 * Returns { data: Buffer, contentType, contentLength } or null.
 */
async function getSegment(videoId, formatId, rangeHeader) {
  if (!hasCacheRedis()) return null;
  const redis = getCacheRedisClient();
  if (!redis) return null;
  const key = _segKey(videoId, formatId, rangeHeader);
  const countKey = segmentCountKey(videoId, formatId, rangeHeader);
  const startedAt = performance.now();
  try {
    const replies = await redis.pipeline().getBuffer(key).get(key + ':meta').exec();
    const data = replies?.[0]?.[1] as Buffer | null;
    if (!data) {
      negativeRedisMisses.set(countKey, Date.now() + NEGATIVE_CACHE_MS);
      incrementMetric('segment_cache_requests_total', { result: 'miss' });
      return null;
    }
    const meta = replies?.[1]?.[1] as string | null;
    const parsed = meta ? JSON.parse(meta) : {};
    incrementMetric('segment_cache_requests_total', { result: 'hit' });
    return {
      data,
      contentType: parsed.ct || 'video/mp4',
      contentLength: data.length,
      contentRange: parsed.cr || null,
      status: parsed.st || 200,
    };
  } catch {
    incrementMetric('segment_cache_requests_total', { result: 'error' });
    return null;
  } finally {
    observeMetric('segment_cache_redis_duration_seconds', (performance.now() - startedAt) / 1000);
  }
}

/**
 * Store a segment in Redis if it meets caching criteria.
 * Called after successful upstream fetch.
 */
function shouldStoreSegment(videoId, formatId, rangeHeader) {
  if (!hasCacheRedis()) return;
  const countKey = segmentCountKey(videoId, formatId, rangeHeader);
  const count = (requestCounts.get(countKey) || 0) + 1;
  requestCounts.set(countKey, count);
  return count >= HOT_THRESHOLD;
}

function reserveSegmentCollection(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0 || bytes > MAX_SEGMENT_SIZE) return null;
  if (activeCollectionBytes + bytes > COLLECTION_BUDGET_BYTES) {
    incrementMetric('segment_cache_writes_total', { result: 'collection_budget_exhausted' });
    return null;
  }
  activeCollectionBytes += bytes;
  setMetricGauge('segment_cache_collection_bytes', activeCollectionBytes);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeCollectionBytes = Math.max(0, activeCollectionBytes - bytes);
    setMetricGauge('segment_cache_collection_bytes', activeCollectionBytes);
  };
}

async function storeSegment(videoId, formatId, rangeHeader, buffer, meta) {
  if (!hasCacheRedis()) return;
  if (buffer.length > MAX_SEGMENT_SIZE) return;

  const redis = getCacheRedisClient();
  if (!redis) return;
  const key = _segKey(videoId, formatId, rangeHeader);
  try {
    // Shared rolling budget bounds the segment bytes all workers can add
    // during one cache TTL.
    const reserved = await redis.eval(
      `local current = tonumber(redis.call('GET', KEYS[1]) or '0')
       local bytes = tonumber(ARGV[1])
       local budget = tonumber(ARGV[2])
       if current + bytes > budget then return 0 end
       redis.call('INCRBY', KEYS[1], bytes)
       if current == 0 then redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3])) end
       return 1`,
      1,
      BUDGET_KEY,
      String(buffer.length),
      String(WRITE_BUDGET_BYTES),
      String(SEGMENT_TTL),
    );
    if (Number(reserved) !== 1) {
      incrementMetric('segment_cache_writes_total', { result: 'budget_exhausted' });
      return;
    }
    await redis.pipeline()
      .setex(key, SEGMENT_TTL, buffer)
      .setex(key + ':meta', SEGMENT_TTL, JSON.stringify({
        ct: meta.contentType,
        cr: meta.contentRange,
        st: meta.status,
      }))
      .exec();
    negativeRedisMisses.delete(`${videoId}:${formatId}:${rangeHeader || ''}`);
    incrementMetric('segment_cache_writes_total', { result: 'stored' });
    incrementMetric('segment_cache_bytes_written_total', {}, buffer.length);
  } catch (err) {
    incrementMetric('segment_cache_writes_total', { result: 'error' });
    console.warn('[segment-cache] write failed:', err.message);
  }
}

async function putSegment(videoId, formatId, rangeHeader, buffer, meta) {
  if (!shouldStoreSegment(videoId, formatId, rangeHeader)) return;
  await storeSegment(videoId, formatId, rangeHeader, buffer, meta);
}

function _segKey(videoId, formatId, rangeHeader) {
  return `seg:${videoId}:${formatId}:${rangeHeader || 'full'}`;
}

export {
  getSegment,
  isObservedSegmentHot,
  joinSegmentFlight,
  putSegment,
  reserveSegmentCollection,
  shouldCheckSegment,
  shouldStoreSegment,
  storeSegment,
};
export type { SegmentFlight, SegmentPayload };
