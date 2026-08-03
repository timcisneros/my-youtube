import db from '../db.js';
import { fetchVideoMeta } from '../yt-meta.js';
import { acquireLock, renewLock, releaseLock, SharedLRUMap } from './cache.js';
import { incrementMetric, setMetricGauge } from './performance-metrics.js';

interface VideoMetadata {
  id: string;
  duration: number;
  liveStatus: string;
}

interface ActiveMetadataRequest {
  controller: AbortController;
  consumers: number;
  promise: Promise<VideoMetadata | null>;
}

interface ResolveMetadataOptions {
  signal?: AbortSignal;
  mode?: 'full' | 'lightweight';
  skipStoredLookup?: boolean;
}

const metadataInflight = new Map<string, ActiveMetadataRequest>();
const MAX_METADATA_INFLIGHT = Math.max(16, Number(process.env.MAX_METADATA_INFLIGHT) || 256);
const metadataNegativeCache = new SharedLRUMap(2000, 'duration-negative-v1', { maxL1Bytes: 2 * 1024 * 1024, maxL1ValueBytes: 16 * 1024 });
const METADATA_LEASE_MS = 30_000;
const METADATA_NEGATIVE_TTL_MS = Math.max(60_000, Number(process.env.DURATION_NEGATIVE_TTL_MS) || 10 * 60_000);

function abortError(signal?: AbortSignal) {
  return signal?.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError');
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw abortError(signal);
}

function abortableDelay(ms: number, signal?: AbortSignal) {
  if (!signal) return new Promise(resolve => setTimeout(resolve, ms));
  throwIfAborted(signal);
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function isNegativeCached(videoId: string) {
  const entry = await metadataNegativeCache.getAsync(videoId);
  return Boolean(entry && Date.now() < entry.expires);
}

async function readStoredMetadata(videoId: string): Promise<VideoMetadata | null> {
  const stored = await db.getDurationsAndLiveStatuses([videoId]);
  const duration = stored.durations[videoId];
  const liveStatus = stored.liveStatuses[videoId];
  if (duration === undefined && liveStatus === undefined) return null;
  return { id: videoId, duration: duration || 0, liveStatus: liveStatus || 'not_live' };
}

async function resolveOwned(
  videoId: string,
  signal: AbortSignal | undefined,
  options: ResolveMetadataOptions,
): Promise<VideoMetadata | null> {
  throwIfAborted(signal);
  if (!options.skipStoredLookup) {
    const stored = await readStoredMetadata(videoId);
    if (stored) return stored;
  }
  if (await isNegativeCached(videoId)) return null;

  const lockKey = `duration-meta:${videoId}`;
  let token = await acquireLock(lockKey, METADATA_LEASE_MS);
  if (!token) {
    // Another worker owns the lookup. Poll the shared database instead of
    // launching the same API/scrape/yt-dlp fallback chain again.
    for (let attempt = 0; attempt < 40; attempt++) {
      await abortableDelay(250, signal);
      const value = await readStoredMetadata(videoId);
      if (value) return value;
      if (await isNegativeCached(videoId)) return null;
      if ((options.mode || 'full') === 'full') {
        token = await acquireLock(lockKey, METADATA_LEASE_MS);
        if (token) break;
      }
    }
    // A lightweight badge lookup may have released the lease without finding
    // metadata. Give a full caller one chance to take ownership and continue
    // through its heavier compatibility fallbacks.
    if (!token && (options.mode || 'full') === 'full') {
      token = await acquireLock(lockKey, METADATA_LEASE_MS);
    }
    if (!token) return null;
  }

  const renewTimer = setInterval(() => {
    void renewLock(lockKey, token, METADATA_LEASE_MS);
  }, 10_000);
  if (typeof renewTimer.unref === 'function') renewTimer.unref();
  try {
    const mode = options.mode || 'full';
    const value = await fetchVideoMeta(videoId, { timeoutMs: 6000, signal, mode });
    throwIfAborted(signal);
    if (!value) {
      // API-only cosmetic lookups must not suppress a later full resolver.
      if (mode === 'full') {
        await metadataNegativeCache.setAsync(videoId, { expires: Date.now() + METADATA_NEGATIVE_TTL_MS });
      }
      return null;
    }
    metadataNegativeCache.delete(videoId);
    await db.setDuration(videoId, value.duration, value.liveStatus);
    return value;
  } finally {
    clearInterval(renewTimer);
    await releaseLock(lockKey, token);
  }
}

function subscribe(active: ActiveMetadataRequest, signal?: AbortSignal): Promise<VideoMetadata | null> {
  active.consumers++;
  return new Promise((resolve, reject) => {
    let settled = false;
    const release = () => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      active.consumers--;
      if (active.consumers === 0) active.controller.abort(new Error('duration metadata has no consumers'));
    };
    const onAbort = () => {
      release();
      reject(abortError(signal));
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
    active.promise.then(
      value => { release(); resolve(value); },
      error => { release(); reject(error); },
    );
  });
}

function resolveOne(videoId: string, options: ResolveMetadataOptions): Promise<VideoMetadata | null> {
  const mode = options.mode || 'full';
  const inflightKey = `${mode}:${videoId}`;
  const existing = metadataInflight.get(inflightKey);
  if (existing !== undefined) return subscribe(existing, options.signal);
  if (metadataInflight.size >= MAX_METADATA_INFLIGHT) {
    incrementMetric('singleflight_rejections_total', { registry: 'duration_metadata' });
    return Promise.resolve(null);
  }
  const controller = new AbortController();
  const active: ActiveMetadataRequest = {
    controller,
    consumers: 0,
    promise: resolveOwned(videoId, controller.signal, options),
  };
  metadataInflight.set(inflightKey, active);
  setMetricGauge('singleflight_active', metadataInflight.size, { registry: 'duration_metadata' });
  const cleanup = () => {
    if (metadataInflight.get(inflightKey) === active) metadataInflight.delete(inflightKey);
    setMetricGauge('singleflight_active', metadataInflight.size, { registry: 'duration_metadata' });
  };
  void active.promise.then(cleanup, cleanup);
  return subscribe(active, options.signal);
}

async function resolveVideoMetadata(videoIds: string[], concurrency = 3, options: ResolveMetadataOptions = {}): Promise<Map<string, VideoMetadata>> {
  const unique = [...new Set(videoIds)];
  const results = new Map<string, VideoMetadata>();
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, unique.length) }, async () => {
    while (next < unique.length && !options.signal?.aborted) {
      const videoId = unique[next++];
      try {
        const value = await resolveOne(videoId, options);
        if (value) results.set(videoId, value);
      } catch (error) {
        if (options.signal?.aborted) return;
        throw error;
      }
    }
  });
  await Promise.all(workers);
  return results;
}

export { resolveVideoMetadata };
