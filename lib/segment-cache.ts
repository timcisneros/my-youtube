/**
 * Hot segment cache — caches frequently-requested video segments in Redis.
 * When multiple users watch the same video, segments are served from Redis
 * instead of making redundant YouTube CDN fetches.
 *
 * Only caches segments under 2MB. TTL is 30 minutes.
 * Requires REDIS_URL to be set.
 */
import { hasRedis, getRedisClient } from './cache.js';

const MAX_SEGMENT_SIZE = 2 * 1024 * 1024; // 2MB
const SEGMENT_TTL = 30 * 60; // 30 minutes in seconds
const HOT_THRESHOLD = 2; // Cache after 2nd request

// Track request counts per segment (in-memory, per-worker)
import LRUMap from './lru-map.js';
const requestCounts = new LRUMap(5000);

/**
 * Check if a segment is cached in Redis.
 * Returns { data: Buffer, contentType, contentLength } or null.
 */
async function getSegment(videoId, formatId, rangeHeader) {
  if (!hasRedis()) return null;
  const redis = getRedisClient();
  const key = _segKey(videoId, formatId, rangeHeader);
  try {
    const data = await redis.getBuffer(key);
    if (!data) return null;
    // Metadata stored alongside
    const meta = await redis.get(key + ':meta');
    const parsed = meta ? JSON.parse(meta) : {};
    return {
      data,
      contentType: parsed.ct || 'video/mp4',
      contentLength: data.length,
      contentRange: parsed.cr || null,
      status: parsed.st || 200,
    };
  } catch {
    return null;
  }
}

/**
 * Store a segment in Redis if it meets caching criteria.
 * Called after successful upstream fetch.
 */
async function putSegment(videoId, formatId, rangeHeader, buffer, meta) {
  if (!hasRedis()) return;
  if (buffer.length > MAX_SEGMENT_SIZE) return;

  const countKey = `${videoId}:${formatId}:${rangeHeader || ''}`;
  const count = (requestCounts.get(countKey) || 0) + 1;
  requestCounts.set(countKey, count);

  // Only cache after HOT_THRESHOLD requests (avoid caching one-off segments)
  if (count < HOT_THRESHOLD) return;

  const redis = getRedisClient();
  const key = _segKey(videoId, formatId, rangeHeader);
  try {
    await redis.setex(key, SEGMENT_TTL, buffer);
    await redis.setex(key + ':meta', SEGMENT_TTL, JSON.stringify({
      ct: meta.contentType,
      cr: meta.contentRange,
      st: meta.status,
    }));
  } catch (err) { console.warn('[segment-cache] write failed:', err.message); }
}

function _segKey(videoId, formatId, rangeHeader) {
  return `seg:${videoId}:${formatId}:${rangeHeader || 'full'}`;
}

export { getSegment, putSegment };
