/**
 * Two-tier cache abstraction:
 * - L1: per-worker LRUMap (instant sync access)
 * - L2: Redis when CACHE_REDIS_URL or REDIS_URL is set (cross-worker sharing)
 * Falls back to L1-only when no Redis.
 */
import LRUMap from './lru-map.js';
import { randomUUID } from 'node:crypto';
import { incrementMetric, observeMetric, setMetricGauge } from './performance-metrics.js';

let redis = null;
let cacheRedis = null;
let redisInitPromise: Promise<boolean> | null = null;
let redisMetricsCollectedAt = 0;
let redisMetricsInflight: Promise<void> | null = null;

function readyRedis() {
  return redis && redis.status === 'ready' ? redis : null;
}

function readyCacheRedis() {
  return cacheRedis && cacheRedis.status === 'ready' ? cacheRedis : null;
}

function resolveRedisUrls(env: NodeJS.ProcessEnv = process.env) {
  const coordinationUrl = env.REDIS_URL || '';
  return {
    coordinationUrl,
    cacheUrl: env.CACHE_REDIS_URL || coordinationUrl,
  };
}

async function connectRedis(url: string, clientName: 'coordination' | 'cache') {
  const { Redis } = await import('ioredis');
  const connectTimeout = Math.max(250, Number(process.env.REDIS_CONNECT_TIMEOUT_MS) || 2000);
  const commandTimeout = Math.max(250, Number(process.env.REDIS_COMMAND_TIMEOUT_MS) || 2000);
  const candidate = new Redis(url, {
    maxRetriesPerRequest: 1,
    lazyConnect: true,
    enableReadyCheck: true,
    enableOfflineQueue: false,
    connectTimeout,
    commandTimeout,
  });
  candidate.on('error', (err) => {
    incrementMetric('redis_errors_total', { client: clientName });
    setMetricGauge('redis_ready', 0, { client: clientName });
    console.error(`[cache] ${clientName} Redis error:`, err.message);
  });
  try {
    await candidate.connect();
    setMetricGauge('redis_ready', 1, { client: clientName });
    console.log(`[cache] ${clientName} Redis connected`);
    return candidate;
  } catch (err) {
    candidate.disconnect(false);
    setMetricGauge('redis_ready', 0, { client: clientName });
    throw err;
  }
}

// Coordination/session/queue state stays on REDIS_URL. Volatile shared cache
// values can use a separately-sized eviction Redis via CACHE_REDIS_URL.
async function initRedis() {
  const { coordinationUrl, cacheUrl } = resolveRedisUrls();
  if (!coordinationUrl && !cacheUrl) return false;
  if (redisInitPromise !== null) return redisInitPromise;
  redisInitPromise = (async () => {
    if (coordinationUrl) {
      try {
        redis = await connectRedis(coordinationUrl, 'coordination');
      } catch (err) {
        redis = null;
        console.warn('[cache] Coordination Redis unavailable; distributed locks and sessions will use local fallbacks:', (err as Error).message);
      }
    }

    if (cacheUrl && cacheUrl === coordinationUrl) {
      cacheRedis = redis;
    } else if (cacheUrl) {
      try {
        cacheRedis = await connectRedis(cacheUrl, 'cache');
      } catch (err) {
        cacheRedis = null;
        console.warn('[cache] Cache Redis unavailable, using in-memory caches:', (err as Error).message);
      }
    }

    return readyRedis() !== null || readyCacheRedis() !== null;
  })();
  return redisInitPromise;
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
  _maxRedisBytes: number;
  _maxL1Bytes: number;
  _maxL1ValueBytes: number;
  _l1Bytes: number;
  _l1Sizes: Map<unknown, number>;
  _pendingWrites: Map<unknown, Promise<unknown>>;
  constructor(maxSize, namespace, options: {
    maxRedisBytes?: number;
    maxL1Bytes?: number;
    maxL1ValueBytes?: number;
  } = {}) {
    super(maxSize);
    this._ns = namespace;
    this._pendingWrites = new Map();
    this._maxRedisBytes = Math.max(16 * 1024, options.maxRedisBytes
      || Number(process.env.SHARED_CACHE_MAX_VALUE_BYTES)
      || 2 * 1024 * 1024);
    this._maxL1Bytes = Math.max(64 * 1024, options.maxL1Bytes
      || Number(process.env.SHARED_CACHE_L1_MAX_BYTES)
      || 32 * 1024 * 1024);
    this._maxL1ValueBytes = Math.min(this._maxL1Bytes, Math.max(16 * 1024, options.maxL1ValueBytes
      || Number(process.env.SHARED_CACHE_L1_MAX_VALUE_BYTES)
      || Math.max(this._maxRedisBytes, 4 * 1024 * 1024)));
    this._l1Bytes = 0;
    this._l1Sizes = new Map();
    this._updateL1Metrics();
  }

  _updateL1Metrics() {
    setMetricGauge('shared_cache_l1_bytes', this._l1Bytes, { namespace: this._ns || 'local' });
    setMetricGauge('shared_cache_l1_entries', this.size, { namespace: this._ns || 'local' });
  }

  _deleteLocalEntry(key) {
    const existed = this._map.delete(key);
    if (!existed) return false;
    this._l1Bytes = Math.max(0, this._l1Bytes - (this._l1Sizes.get(key) || 0));
    this._l1Sizes.delete(key);
    return true;
  }

  _setLocalEntry(key, value, serializedBytes: number) {
    this._deleteLocalEntry(key);
    if (serializedBytes > this._maxL1ValueBytes) {
      incrementMetric('shared_cache_l1_dropped_total', { namespace: this._ns || 'local', reason: 'value_too_large' });
      this._updateL1Metrics();
      return false;
    }
    this._map.set(key, value);
    this._l1Sizes.set(key, serializedBytes);
    this._l1Bytes += serializedBytes;
    while (this._map.size > this._max || this._l1Bytes > this._maxL1Bytes) {
      const oldest = this._map.keys().next().value;
      const reason = this._map.size > this._max ? 'entry_limit' : 'byte_limit';
      this._deleteLocalEntry(oldest);
      incrementMetric('shared_cache_l1_evictions_total', { namespace: this._ns || 'local', reason });
    }
    this._updateL1Metrics();
    return true;
  }

  set(key, value) {
    let serialized: string | undefined;
    let serializedBytes = 0;
    try {
      serialized = JSON.stringify(value);
      serializedBytes = Buffer.byteLength(serialized);
      observeMetric('shared_cache_value_bytes', serializedBytes, { namespace: this._ns });
      this._setLocalEntry(key, value, serializedBytes);
    } catch {
      this._deleteLocalEntry(key);
      this._updateL1Metrics();
      incrementMetric('shared_cache_writes_dropped_total', { namespace: this._ns, reason: 'serialize_failed' });
    }
    // Write-through to Redis (fire-and-forget)
    const client = readyCacheRedis();
    if (client && this._ns && serialized !== undefined) {
      // Lock-owned producers use setAsync() so publication completes before a
      // coordination lock on a different Redis instance is released.
      const remaining = value && value.expires ? value.expires - Date.now() : 300000;
      if (remaining > 0) {
        if (serializedBytes <= this._maxRedisBytes) {
          const previous = this._pendingWrites.get(key);
          const write = Promise.resolve(previous).catch(() => undefined)
            .then(() => client.set(`c:${this._ns}:${key}`, serialized, 'PX', remaining))
            .catch(err => console.warn('[cache] Redis write failed:', err.message));
          this._pendingWrites.set(key, write);
          void write.finally(() => {
            if (this._pendingWrites.get(key) === write) this._pendingWrites.delete(key);
          });
        } else {
          incrementMetric('shared_cache_writes_dropped_total', { namespace: this._ns, reason: 'value_too_large' });
        }
      }
    }
    return this;
  }

  async setAsync(key, value) {
    this.set(key, value);
    const write = this._pendingWrites.get(key);
    if (write !== undefined) await write;
    return this;
  }

  delete(key) {
    const result = this._deleteLocalEntry(key);
    this._updateL1Metrics();
    const client = readyCacheRedis();
    if (client && this._ns) {
      const previous = this._pendingWrites.get(key);
      const deletion = Promise.resolve(previous).catch(() => undefined)
        .then(() => client.del(`c:${this._ns}:${key}`))
        .catch(err => console.warn('[cache] Redis delete failed:', err.message));
      this._pendingWrites.set(key, deletion);
      void deletion.finally(() => {
        if (this._pendingWrites.get(key) === deletion) this._pendingWrites.delete(key);
      });
    }
    return result;
  }

  async deleteAsync(key) {
    const result = this.delete(key);
    const deletion = this._pendingWrites.get(key);
    if (deletion !== undefined) await deletion;
    return result;
  }

  // Remove only this worker's stale copy. Expiry cleanup must not delete a
  // fresher value another worker may already have published to Redis.
  deleteLocal(key) {
    const result = this._deleteLocalEntry(key);
    this._updateL1Metrics();
    return result;
  }

  clear() {
    this._map.clear();
    this._l1Sizes.clear();
    this._l1Bytes = 0;
    this._updateL1Metrics();
  }

  /**
   * Async get — checks L1, then Redis on miss. Populates L1 on Redis hit.
   * Returns the value or undefined.
   */
  async getAsync(key) {
    // L1 check (sync, fast path)
    const l1 = super.get(key);
    if (l1 !== undefined) {
      if (!l1?.expires || Date.now() < l1.expires) {
        incrementMetric('cache_requests_total', { namespace: this._ns || 'local', result: 'l1_hit' });
        return l1;
      }
      this.deleteLocal(key);
    }

    // A synchronous delete intentionally updates L1 immediately while its
    // Redis mutation completes in the background. Wait here before consulting
    // L2 so the just-deleted value cannot be read back and resurrected.
    const pendingMutation = this._pendingWrites.get(key);
    if (pendingMutation !== undefined) await pendingMutation;

    // L2 (Redis) check
    const client = readyCacheRedis();
    if (!client || !this._ns) {
      incrementMetric('cache_requests_total', { namespace: this._ns || 'local', result: 'miss' });
      return undefined;
    }
    const startedAt = Date.now();
    try {
      const raw = await client.get(`c:${this._ns}:${key}`);
      observeMetric('redis_operation_duration_ms', Date.now() - startedAt, { operation: 'cache_get' });
      if (raw) {
        const value = JSON.parse(raw);
        this._setLocalEntry(key, value, Buffer.byteLength(raw)); // populate L1
        incrementMetric('cache_requests_total', { namespace: this._ns, result: 'l2_hit' });
        return value;
      }
    } catch {
      incrementMetric('redis_errors_total', { client: 'cache' });
    }
    incrementMetric('cache_requests_total', { namespace: this._ns, result: 'miss' });
    return undefined;
  }
}

/**
 * Distributed lock via Redis SET NX PX.
 *
 * The random ownership token is required for safe renewal/release. A plain
 * DEL can remove a successor's lock if the first owner's lease expires while
 * it is still working.
 */
async function acquireLock(key, ttlMs) {
  const client = readyRedis();
  if (!client) return 'local';
  const token = randomUUID();
  try {
    const result = await client.set(`lock:${key}`, token, 'NX', 'PX', ttlMs || 30000);
    return result === 'OK' ? token : null;
  } catch {
    return 'local'; // fail-open; the process-local in-flight map still deduplicates
  }
}

async function renewLock(key, token, ttlMs) {
  const client = readyRedis();
  if (!client || token === 'local') return true;
  if (!token) return false;
  try {
    const result = await client.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end",
      1,
      `lock:${key}`,
      token,
      String(ttlMs || 30000),
    );
    return Number(result) === 1;
  } catch {
    return false;
  }
}

async function releaseLock(key, token) {
  const client = readyRedis();
  if (!client || token === 'local' || !token) return;
  try {
    await client.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
      1,
      `lock:${key}`,
      token,
    );
  } catch {}
}

function hasRedis() {
  return readyRedis() !== null;
}

function getRedisClient() {
  return readyRedis();
}

function hasCacheRedis() {
  return readyCacheRedis() !== null;
}

function getCacheRedisClient() {
  return readyCacheRedis();
}

function parseRedisInfo(raw: string) {
  const fields = new Map<string, number>();
  for (const line of raw.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf(':');
    if (separator < 1) continue;
    const value = Number(line.slice(separator + 1).trim());
    if (Number.isFinite(value)) fields.set(line.slice(0, separator), value);
  }
  return fields;
}

async function collectRedisMetrics() {
  if (Date.now() - redisMetricsCollectedAt < 5_000) return;
  if (redisMetricsInflight !== null) return redisMetricsInflight;
  redisMetricsInflight = (async () => {
    const clients: Array<{ name: string; client: NonNullable<ReturnType<typeof readyRedis>> }> = [];
    const coordination = readyRedis();
    const volatileCache = readyCacheRedis();
    if (coordination) clients.push({ name: 'coordination', client: coordination });
    if (volatileCache && volatileCache !== coordination) clients.push({ name: 'cache', client: volatileCache });
    await Promise.all(clients.map(async ({ name, client }) => {
      const startedAt = Date.now();
      try {
        const fields = parseRedisInfo(await client.info());
        const mappings = [
          ['used_memory', 'redis_used_memory_bytes'],
          ['maxmemory', 'redis_maxmemory_bytes'],
          ['evicted_keys', 'redis_evicted_keys'],
          ['connected_clients', 'redis_connected_clients'],
          ['instantaneous_ops_per_sec', 'redis_operations_per_second'],
          ['total_commands_processed', 'redis_commands_processed'],
        ] as const;
        for (const [field, metric] of mappings) {
          const value = fields.get(field);
          if (value !== undefined) setMetricGauge(metric, value, { client: name });
        }
        observeMetric('redis_operation_duration_ms', Date.now() - startedAt, { operation: 'info', client: name });
      } catch {
        incrementMetric('redis_errors_total', { client: name, operation: 'info' });
      }
    }));
    redisMetricsCollectedAt = Date.now();
  })().finally(() => {
    redisMetricsInflight = null;
  });
  return redisMetricsInflight;
}

export {
  initRedis,
  SharedLRUMap,
  acquireLock,
  renewLock,
  releaseLock,
  hasRedis,
  getRedisClient,
  hasCacheRedis,
  getCacheRedisClient,
  collectRedisMetrics,
  resolveRedisUrls,
};
