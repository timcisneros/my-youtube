import { cacheVideoDetailsFromInfo } from '../../youtube/index.js';
import logger from '../../lib/logger.js';
import { EXTRACTION_DEADLINE_MS, extractWithStrategy } from '../../lib/extraction-strategy.js';
import { acquireLock, renewLock, releaseLock, hasRedis, hasCacheRedis } from '../../lib/cache.js';
import {
  withYtdlpSlot,
  formatCache,
  dedup,
  extractionInflight,
  CACHE_TTL,
} from './shared.js';
import { notifyExtractionStep } from './status.js';
import { hasQueue as hasExtractionQueue, enqueueExtraction } from '../../lib/extraction-queue.js';
import { compactExtractionResult } from '../../lib/extraction-result.js';
import { incrementMetric, observeMetric } from '../../lib/performance-metrics.js';
import { SingleFlightCapacityError } from '../../lib/bounded-singleflight.js';

const EXTRACTION_LOCK_LEASE_MS = 30_000;
const EXTRACTION_WAIT_MS = EXTRACTION_DEADLINE_MS + 10_000;

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
      extractFormats(videoId, { priority: 'background' }).catch(err => console.warn(`[stale-refresh ${videoId}]`, err.message));
    }
    return entry.data;
  }
  formatCache.deleteLocal(videoId);
  return null;
}

function setCache(videoId, data) {
  return formatCache.setAsync(videoId, { data, expires: Date.now() + CACHE_TTL });
}

async function extractFormats(videoId, options: { priority?: 'playback' | 'background' | 'prefetch' } = {}) {
  const priority = options.priority || 'playback';
  const cached = getCached(videoId);
  if (cached) return cached;
  const localRequest = extractionInflight.get(videoId);
  if (localRequest) return localRequest;

  // Cross-worker dedup: check if another worker already has the result in Redis
  let extractionLockToken: string | null = null;
  let lockRenewTimer: NodeJS.Timeout | null = null;
  if (hasCacheRedis()) {
    const redisEntry = await formatCache.getAsync(videoId);
    if (redisEntry && redisEntry.data && Date.now() < redisEntry.expires) return redisEntry.data;
  }

  // A distributed lock is only useful when its owner can publish the result
  // to a shared cache for waiters. BullMQ still deduplicates extraction jobs if
  // the volatile cache Redis is temporarily unavailable.
  if (hasRedis() && hasCacheRedis()) {
    // Try to acquire extraction lock — if another worker is extracting, wait for result
    extractionLockToken = await acquireLock(`extract:${videoId}`, EXTRACTION_LOCK_LEASE_MS);
    if (!extractionLockToken) {
      // A request in this process may have populated the in-flight map while
      // the Redis checks above were pending. Join it instead of polling Redis.
      const newlyLocalRequest = extractionInflight.get(videoId);
      if (newlyLocalRequest) return newlyLocalRequest;
      // Another worker is extracting — poll Redis for result
      const waitDeadline = Date.now() + EXTRACTION_WAIT_MS;
      while (Date.now() < waitDeadline) {
        await new Promise(r => setTimeout(r, 1000 + Math.random() * 500));
        const entry = await formatCache.getAsync(videoId);
        if (entry && entry.data && Date.now() < entry.expires) return entry.data;
      }
      // Do not start a duplicate after waiting. The current owner may still be
      // publishing its result, and a retry will join the same queue job.
      return { formats: [], duration: 0, _pending: true, _unavailable: 'Extraction is still in progress. Try again in a moment.' };
    }
    if (extractionLockToken !== 'local') {
      lockRenewTimer = setInterval(() => {
        void renewLock(`extract:${videoId}`, extractionLockToken, EXTRACTION_LOCK_LEASE_MS).then((renewed) => {
          if (!renewed) console.warn(`[stream ${videoId}] extraction ownership lease was lost`);
        });
      }, Math.floor(EXTRACTION_LOCK_LEASE_MS / 3));
      if (typeof lockRenewTimer.unref === 'function') lockRenewTimer.unref();
    }
  }

  try {
    return await dedup(extractionInflight, videoId, async () => {
      const startedAt = Date.now();
      let queueWaitMs = 0;
      let metricResult = 'error';
      let metricMode = 'local';
      try {
      // Redis deployments have one authoritative extraction path: the BullMQ
      // worker. A wait timeout never starts the same expensive job in the web
      // process while the worker is still alive.
      if (hasExtractionQueue()) {
        metricMode = 'worker';
        notifyExtractionStep(videoId, 'queue');
        const queued = await enqueueExtraction(videoId, {
          timeoutMs: EXTRACTION_WAIT_MS,
          priority,
        });
        queueWaitMs = queued?.waitMs || 0;
        if (queued?.status === 'completed' && queued.result) {
          const result = compactExtractionResult(queued.result);
          const fmts = result.formats || [];
          if (fmts.length > 0) {
            const hlsCount = fmts.filter(f => f.protocol && f.protocol.startsWith('m3u8') && f.vcodec && f.vcodec !== 'none').length;
            const directCount = fmts.filter(f => f.url && (!f.protocol || f.protocol === 'https' || f.protocol === 'http')).length;
            console.log(`[stream ${videoId}] ${fmts.length} formats (${hlsCount} HLS, ${directCount} direct) via extraction-worker (${result._extractedVia || 'unknown'})`);
            await setCache(videoId, result);
            await cacheVideoDetailsFromInfo(videoId, result);
          } else {
            await formatCache.setAsync(videoId, { data: result, expires: Date.now() + 15_000 });
          }
          metricResult = fmts.length > 0 ? 'success' : 'unavailable';
          logger.sampledInfo('extraction-perf', 'extraction-perf', {
            videoId,
            priority,
            via: result._extractedVia || 'worker',
            queueWaitMs,
            totalMs: Date.now() - startedAt,
            workerTimings: result._extractionTimings || null,
          });
          return result;
        }
        if (queued?.status === 'pending') {
          metricResult = 'pending';
          logger.sampledInfo('extraction-perf', 'extraction-perf', {
            videoId,
            priority,
            status: 'pending',
            queueWaitMs,
            totalMs: Date.now() - startedAt,
          });
          return { formats: [], duration: 0, _pending: true, _unavailable: 'Extraction is queued and still running. Try again in a moment.' };
        }
        if (queued?.status === 'overloaded') {
          metricResult = 'overloaded';
          return {
            formats: [],
            duration: 0,
            _overloaded: true,
            _unavailable: priority === 'playback'
              ? 'Playback capacity is temporarily full. Try again in a moment.'
              : 'Background extraction capacity is full.',
          };
        }
        metricResult = 'unavailable';
        return { formats: [], duration: 0, _unavailable: 'The extraction worker could not complete this video. Try again shortly.' };
      }

      const extractedInfo = await extractWithStrategy(videoId, withYtdlpSlot, {
        priority,
        onStep: (step) => notifyExtractionStep(videoId, step),
        logTag: 'yt-dlp',
      });
      const info = compactExtractionResult(extractedInfo);

      if (!info) {
        metricResult = 'unavailable';
        const msg = 'Extraction failed within the bounded backend deadline. YouTube may be rate-limiting or requiring fresh cookies.';
        console.error(`[stream ${videoId}] ${msg}`);
        const empty = { formats: [], duration: 0, _unavailable: msg };
        await formatCache.setAsync(videoId, { data: empty, expires: Date.now() + 15_000 });
        return empty;
      }

      if (info._permanent) {
        metricResult = 'permanent';
        const { _permanent, ...result } = info;
        await setCache(videoId, result);
        return result;
      }

      const fmts = info.formats || [];
      const hlsCount = fmts.filter(f => f.protocol && f.protocol.startsWith('m3u8') && f.vcodec && f.vcodec !== 'none').length;
      const directCount = fmts.filter(f => f.url && (!f.protocol || f.protocol === 'https' || f.protocol === 'http')).length;
      console.log(`[stream ${videoId}] ${fmts.length} formats (${hlsCount} HLS, ${directCount} direct), duration=${info.duration}s via ${info._extractedVia || 'yt-dlp'}`);
      await setCache(videoId, info);
      await cacheVideoDetailsFromInfo(videoId, info);
      metricResult = 'success';
      logger.sampledInfo('extraction-perf', 'extraction-perf', {
        videoId,
        priority,
        via: info._extractedVia || 'yt-dlp',
        queueWaitMs,
        totalMs: Date.now() - startedAt,
        backendTimings: info._extractionTimings || null,
      });
      return info;
      } finally {
        incrementMetric('extraction_requests_total', {
          priority,
          mode: metricMode,
          result: metricResult,
        });
        observeMetric('extraction_request_duration_seconds', (Date.now() - startedAt) / 1000, {
          priority,
          mode: metricMode,
          result: metricResult,
        });
        if (queueWaitMs > 0) {
          observeMetric('extraction_queue_wait_seconds', queueWaitMs / 1000, { priority });
        }
        if (lockRenewTimer) clearInterval(lockRenewTimer);
        if (extractionLockToken) await releaseLock(`extract:${videoId}`, extractionLockToken);
      }
    }, { name: 'stream_extraction', maxEntries: 256 });
  } catch (error) {
    // Capacity can be reached after a distributed lease was acquired but before
    // the single-flight owner starts. Release that unused lease immediately.
    if (error instanceof SingleFlightCapacityError) {
      if (lockRenewTimer) clearInterval(lockRenewTimer);
      if (extractionLockToken) await releaseLock(`extract:${videoId}`, extractionLockToken);
    }
    throw error;
  }
}

export {
  getCached,
  extractFormats,
};
