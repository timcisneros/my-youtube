/**
 * Two-tier cache abstraction:
 * - L1: per-worker LRUMap (instant sync access)
 * - L2: Redis when REDIS_URL is set (cross-worker sharing)
 * Falls back to L1-only when no Redis.
 */
import LRUMap from './lru-map.js';

let redis = null;

// Initialize Redis connection if REDIS_URL is set
async function initRedis() {
  if (!process.env.REDIS_URL) return false;
  try {
    const { Redis } = await import('ioredis');
    redis = new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: 3,
      lazyConnect: true,
      enableReadyCheck: true,
    });
    await redis.connect();
    console.log('[cache] Redis connected');
    redis.on('error', (err) => console.error('[cache] Redis error:', err.message));
    return true;
  } catch (err) {
    console.warn('[cache] Redis unavailable, using in-memory only:', err.message);
    redis = null;
    return false;
  }
}

/**
 * SharedLRUMap — drop-in LRUMap replacement with transparent Redis write-through.
 *
 * Sync API (get/set/has/delete) works identically to LRUMap for zero-refactor usage.
 * When Redis is connected:
 *   - set() writes to L1 synchronously + fires async Redis write (fire-and-forget)
 *   - delete() removes from L1 + fires async Redis delete
 *   - getAsync(key) checks L1 first, then Redis on miss (populates L1 on hit)
 *
 * Use getAsync() at key decision points (before expensive work like extraction)
 * to benefit from cross-worker cache sharing.
 */
class SharedLRUMap extends LRUMap {
  _ns: string;
  constructor(maxSize, namespace) {
    super(maxSize);
    this._ns = namespace;
  }

  set(key, value) {
    super.set(key, value);
    // Write-through to Redis (fire-and-forget)
    if (redis && this._ns) {
      const remaining = value && value.expires ? value.expires - Date.now() : 300000;
      if (remaining > 0) {
        redis.set(`c:${this._ns}:${key}`, JSON.stringify(value), 'PX', remaining).catch(err => console.warn('[cache] Redis write failed:', err.message));
      }
    }
    return this;
  }

  delete(key) {
    const result = super.delete(key);
    if (redis && this._ns) {
      redis.del(`c:${this._ns}:${key}`).catch(err => console.warn('[cache] Redis delete failed:', err.message));
    }
    return result;
  }

  /**
   * Async get — checks L1, then Redis on miss. Populates L1 on Redis hit.
   * Returns the value or undefined.
   */
  async getAsync(key) {
    // L1 check (sync, fast path)
    const l1 = super.get(key);
    if (l1 !== undefined) return l1;

    // L2 (Redis) check
    if (!redis || !this._ns) return undefined;
    try {
      const raw = await redis.get(`c:${this._ns}:${key}`);
      if (raw) {
        const value = JSON.parse(raw);
        super.set(key, value); // populate L1
        return value;
      }
    } catch {}
    return undefined;
  }
}

/**
 * Distributed lock via Redis SET NX PX.
 * Returns true if lock acquired, false otherwise.
 * Falls back to always-true when no Redis (single-process mode).
 */
async function acquireLock(key, ttlMs) {
  if (!redis) return true;
  try {
    const result = await redis.set(`lock:${key}`, '1', 'NX', 'PX', ttlMs || 30000);
    return result === 'OK';
  } catch {
    return true; // fail-open
  }
}

async function releaseLock(key) {
  if (!redis) return;
  try {
    await redis.del(`lock:${key}`);
  } catch {}
}

function hasRedis() {
  return redis !== null;
}

function getRedisClient() {
  return redis;
}

export { initRedis, SharedLRUMap, acquireLock, releaseLock, hasRedis, getRedisClient };
