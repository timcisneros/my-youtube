/**
 * RSS feed fetching for YouTube channels.
 */
import { XMLParser } from 'fast-xml-parser';
import { randomUUID } from 'node:crypto';
import db from '../db.js';
import { cache, LRUMap, withYtSlot, RSS_TTL } from './shared.js';
import { acquireLock, getRedisClient, renewLock, releaseLock } from '../lib/cache.js';
import { incrementMetric, observeMetric, setMetricGauge } from '../lib/performance-metrics.js';
import { enqueueRssRefresh, hasRssRefreshQueue } from '../lib/rss-refresh-queue.js';
import { readTextBounded } from '../lib/bounded-fetch.js';
import { runBoundedSingleFlight } from '../lib/bounded-singleflight.js';
import type { RSSCacheValidators, RSSData } from '../types.js';

const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
const rssInflight = new Map<string, Promise<{ items: unknown[]; channelTitle: string }>>();
const rssSingleFlight = { name: 'rss_fetch', maxEntries: 500 } as const;
const RSS_REFRESH_LEASE_MS = 15_000;
const RSS_REFRESH_CONCURRENCY = Math.max(1, Number(process.env.RSS_REFRESH_CONCURRENCY) || 6);
const RSS_REFRESH_MAX_QUEUE = Math.max(100, Number(process.env.RSS_REFRESH_MAX_QUEUE) || 1000);
const RSS_REFRESH_START_SPACING_MS = Math.max(0, Number(process.env.RSS_REFRESH_START_SPACING_MS) || 100);
const RSS_REFRESH_JITTER_MS = Math.max(0, Number(process.env.RSS_REFRESH_JITTER_MS) || 5000);
const RSS_REFRESH_GLOBAL_CONCURRENCY = Math.max(1, Number(process.env.RSS_REFRESH_GLOBAL_CONCURRENCY) || 8);
const RSS_GLOBAL_SLOT_LEASE_MS = Math.max(10_000, Number(process.env.RSS_GLOBAL_SLOT_LEASE_MS) || 20_000);
const rssRefreshQueue: Array<{
  channelId: string;
  staleData?: { items: unknown[]; channelTitle: string };
  priority: number;
  dueAt: number;
  resolve: (value: { items: unknown[]; channelTitle: string }) => void;
}> = [];
const scheduledRssRefreshes = new Map<string, Promise<{ items: unknown[]; channelTitle: string }>>();
const rssRefreshFailures = new LRUMap<string, { count: number; retryAt: number }>(2000);
const rssValidators = new LRUMap<string, RSSCacheValidators>(2000);
let activeRssRefreshes = 0;
let lastRssRefreshStart = 0;
let rssRefreshTimer: ReturnType<typeof setTimeout> | null = null;

function updateRssSchedulerMetrics() {
  setMetricGauge('rss_refresh_active', activeRssRefreshes);
  setMetricGauge('rss_refresh_queued', rssRefreshQueue.length);
}

function armRssRefreshPump(delayMs = 0) {
  if (rssRefreshTimer) return;
  rssRefreshTimer = setTimeout(() => {
    rssRefreshTimer = null;
    pumpRssRefreshQueue();
  }, Math.max(0, delayMs));
  if (typeof rssRefreshTimer.unref === 'function') rssRefreshTimer.unref();
}

function pumpRssRefreshQueue() {
  updateRssSchedulerMetrics();
  if (activeRssRefreshes >= RSS_REFRESH_CONCURRENCY || rssRefreshQueue.length === 0) return;
  const next = rssRefreshQueue[0];
  const earliestStart = Math.max(next.dueAt, lastRssRefreshStart + RSS_REFRESH_START_SPACING_MS);
  if (earliestStart > Date.now()) {
    armRssRefreshPump(earliestStart - Date.now());
    return;
  }

  rssRefreshQueue.shift();
  activeRssRefreshes++;
  lastRssRefreshStart = Date.now();
  updateRssSchedulerMetrics();
  const startedAt = Date.now();
  void refreshChannelRSS(next.channelId, next.staleData).then((data) => {
    const refreshed = cache.rss.get(next.channelId);
    if (refreshed && Date.now() < refreshed.expires) {
      rssRefreshFailures.delete(next.channelId);
      incrementMetric('rss_refresh_total', { result: 'success' });
    } else {
      const previous = rssRefreshFailures.get(next.channelId)?.count || 0;
      const count = Math.min(previous + 1, 8);
      const retryMs = Math.min(60 * 60 * 1000, 30_000 * Math.pow(2, count - 1));
      rssRefreshFailures.set(next.channelId, { count, retryAt: Date.now() + retryMs });
      incrementMetric('rss_refresh_total', { result: 'stale_fallback' });
    }
    next.resolve(data);
  }).catch(() => {
    incrementMetric('rss_refresh_total', { result: 'error' });
    next.resolve(next.staleData || { items: [], channelTitle: '' });
  }).finally(() => {
    observeMetric('rss_refresh_duration_ms', Date.now() - startedAt);
    activeRssRefreshes--;
    scheduledRssRefreshes.delete(next.channelId);
    updateRssSchedulerMetrics();
    armRssRefreshPump();
  });
  armRssRefreshPump(RSS_REFRESH_START_SPACING_MS);
}

function insertRssRefresh(task: typeof rssRefreshQueue[number]) {
  // Keep the fallback queue ordered at insertion time. Re-sorting the entire
  // queue before every dequeue made a 160-channel Today slice do redundant
  // O(n log n) work repeatedly.
  let low = 0;
  let high = rssRefreshQueue.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    const candidate = rssRefreshQueue[middle];
    const comesBefore = candidate.priority < task.priority
      || (candidate.priority === task.priority && candidate.dueAt <= task.dueAt);
    if (comesBefore) low = middle + 1;
    else high = middle;
  }
  rssRefreshQueue.splice(low, 0, task);
}

function scheduleRssRefresh(
  channelId: string,
  staleData?: { items: unknown[]; channelTitle: string },
  priority: 'interactive' | 'background' = 'background',
) {
  const active = scheduledRssRefreshes.get(channelId);
  if (active !== undefined) return active;
  const failure = rssRefreshFailures.get(channelId);
  if (failure && Date.now() < failure.retryAt) {
    incrementMetric('rss_refresh_total', { result: 'backoff' });
    return Promise.resolve(staleData || { items: [], channelTitle: '' });
  }
  if (rssRefreshQueue.length >= RSS_REFRESH_MAX_QUEUE) {
    incrementMetric('rss_refresh_total', { result: 'queue_full' });
    return Promise.resolve(staleData || { items: [], channelTitle: '' });
  }
  let resolveTask!: (value: { items: unknown[]; channelTitle: string }) => void;
  const request = new Promise<{ items: unknown[]; channelTitle: string }>((resolve) => {
    resolveTask = resolve;
  });
  scheduledRssRefreshes.set(channelId, request);
  insertRssRefresh({
    channelId,
    staleData,
    priority: priority === 'interactive' ? 1 : 10,
    dueAt: Date.now() + (priority === 'background' ? Math.random() * RSS_REFRESH_JITTER_MS : 0),
    resolve: resolveTask,
  });
  updateRssSchedulerMetrics();
  armRssRefreshPump();
  return request;
}

function fetchedAtMs(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value !== 'string' || !value) return 0;
  // SQLite datetime() is UTC but omits its timezone marker.
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? value.replace(' ', 'T') + 'Z'
    : value;
  const ms = new Date(normalized).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function rssDataEqual(left: RSSData | undefined, right: RSSData) {
  if (!left || left.channelTitle !== right.channelTitle) return false;
  const leftItems = Array.isArray(left.items) ? left.items : [];
  const rightItems = Array.isArray(right.items) ? right.items : [];
  if (leftItems.length !== rightItems.length) return false;
  for (let index = 0; index < leftItems.length; index++) {
    const a = leftItems[index];
    const b = rightItems[index];
    if (a.videoId !== b.videoId || a.title !== b.title
      || a.publishedAt !== b.publishedAt || a.channelId !== b.channelId) return false;
  }
  return true;
}

function refreshChannelRSS(channelId, staleData?) {
  return runBoundedSingleFlight(
    rssInflight,
    channelId,
    () => refreshChannelRSSOwned(channelId, staleData),
    rssSingleFlight,
  );
}

async function refreshChannelRSSOwned(channelId, staleData?) {
  const lockKey = `rss-refresh:${channelId}`;
  const token = await acquireLock(lockKey, RSS_REFRESH_LEASE_MS);
  if (!token) {
    // Another worker owns the fetch. Briefly wait for its shared result, then
    // serve persistent stale data instead of duplicating the YouTube request.
    for (let attempt = 0; attempt < 10; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      const shared = await cache.rss.getAsync(channelId);
      if (shared && Date.now() < shared.expires) return shared.data;
    }
    if (staleData) return staleData;
    const dbCached = await db.getRssCache(channelId);
    return dbCached?.data || { items: [], channelTitle: '' };
  }

  const renewTimer = setInterval(() => {
    void renewLock(lockKey, token, RSS_REFRESH_LEASE_MS);
  }, Math.floor(RSS_REFRESH_LEASE_MS / 3));
  if (typeof renewTimer.unref === 'function') renewTimer.unref();
  try {
    return await fetchChannelRSSFromYouTube(channelId, staleData);
  } finally {
    clearInterval(renewTimer);
    await releaseLock(lockKey, token);
  }
}

async function fetchChannelRSSFromYouTube(channelId, staleData?) {
  const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
  try {
    // Resolve persistent validators before taking a scarce outbound request
    // slot. A local database read must not reduce RSS fetch concurrency.
    let validators = rssValidators.get(channelId);
    if (!validators) {
      const persisted = await db.getRssCache(channelId);
      if (persisted) {
        validators = persisted.validators;
        rssValidators.set(channelId, validators);
        staleData ||= persisted.data;
      }
    }
    return await withGlobalRssSlot(() => withYtSlot(async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      try {
        const headers: Record<string, string> = {
          'User-Agent': 'Mozilla/5.0',
          'Accept-Language': '*',
          'Referer': '',
          'Cookie': '',
        };
        if (validators?.etag) headers['If-None-Match'] = validators.etag;
        if (validators?.lastModified) headers['If-Modified-Since'] = validators.lastModified;
        const res = await fetch(url, { signal: controller.signal, headers });
        const responseValidators: RSSCacheValidators = {
          etag: res.headers.get('etag') || validators?.etag || '',
          lastModified: res.headers.get('last-modified') || validators?.lastModified || '',
        };
        if (res.status === 304 && staleData) {
          await res.body?.cancel().catch(() => {});
          await db.touchRssCache(channelId, responseValidators);
          rssValidators.set(channelId, responseValidators);
          await cache.rss.setAsync(channelId, { data: staleData, expires: Date.now() + RSS_TTL });
          incrementMetric('rss_feed_updates_total', { result: 'not_modified' });
          return staleData;
        }
        if (!res.ok) {
          await res.body?.cancel().catch(() => {});
          return staleData || { items: [], channelTitle: '' };
        }
        // Keep the deadline and YouTube semaphore slot until the body has been
        // consumed; fetch() resolving headers is not completion.
        const xml = await readTextBounded(res, 2 * 1024 * 1024, 'rss-response-too-large');
        const parsed = xmlParser.parse(xml);
        const channelTitle = parsed?.feed?.author?.name || '';
        const entries = parsed?.feed?.entry;
        const items = entries ? (Array.isArray(entries) ? entries : [entries]) : [];
        const data: RSSData = {
          items: items.map(entry => {
            const pub = entry.published || '';
            const upd = entry.updated || '';
            return {
              videoId: (entry['yt:videoId'] || '').toString(),
              title: entry.title || '',
              publishedAt: pub || upd,
              channelId
            };
          }),
          channelTitle
        };
        if (rssDataEqual(staleData, data)) {
          await db.touchRssCache(channelId, responseValidators);
          incrementMetric('rss_feed_updates_total', { result: 'unchanged' });
        } else {
          await db.setRssCache(channelId, data, responseValidators);
          incrementMetric('rss_feed_updates_total', { result: 'changed' });
        }
        rssValidators.set(channelId, responseValidators);
        await cache.rss.setAsync(channelId, { data, expires: Date.now() + RSS_TTL });
        return data;
      } finally {
        clearTimeout(timer);
      }
    }, 'background'));
  } catch {
    return staleData || { items: [], channelTitle: '' };
  }
}

async function withGlobalRssSlot<T>(fn: () => Promise<T>) {
  const redis = getRedisClient();
  if (!redis) return fn();
  const token = `${process.pid}:${randomUUID()}`;
  const semaphoreKey = 'semaphore:rss-refresh';
  const queuedAt = Date.now();
  let acquired = false;
  let attempt = 0;
  try {
    while (!acquired) {
      const now = Date.now();
      const result = await redis.eval(
        `redis.call('zremrangebyscore', KEYS[1], '-inf', ARGV[1])
         if redis.call('zcard', KEYS[1]) < tonumber(ARGV[2]) then
           redis.call('zadd', KEYS[1], ARGV[3], ARGV[4])
           redis.call('pexpire', KEYS[1], ARGV[5])
           return 1
         end
         return 0`,
        1,
        semaphoreKey,
        String(now),
        String(RSS_REFRESH_GLOBAL_CONCURRENCY),
        String(now + RSS_GLOBAL_SLOT_LEASE_MS),
        token,
        String(RSS_GLOBAL_SLOT_LEASE_MS * 2),
      );
      acquired = Number(result) === 1;
      if (!acquired) {
        // Exponential jitter avoids turning a saturated cluster into a Redis
        // polling storm while still handing short RSS slots over promptly.
        const delay = Math.min(1_000, 100 * Math.pow(1.6, attempt++));
        await new Promise(resolve => setTimeout(resolve, delay * (0.8 + Math.random() * 0.4)));
      }
    }
  } catch {
    // Redis availability must not make RSS unavailable; local scheduling and
    // the outbound-request semaphore remain as the fail-open fallback.
    return fn();
  }

  observeMetric('rss_global_slot_wait_ms', Date.now() - queuedAt);
  const renewTimer = setInterval(() => {
    const client = getRedisClient();
    if (!client) return;
    const expiresAt = Date.now() + RSS_GLOBAL_SLOT_LEASE_MS;
    void client.eval(
      "if redis.call('zscore', KEYS[1], ARGV[1]) then return redis.call('zadd', KEYS[1], 'XX', ARGV[2], ARGV[1]) else return 0 end",
      1,
      semaphoreKey,
      token,
      String(expiresAt),
    ).catch(() => {});
  }, Math.floor(RSS_GLOBAL_SLOT_LEASE_MS / 3));
  renewTimer.unref?.();
  try {
    return await fn();
  } finally {
    clearInterval(renewTimer);
    const client = getRedisClient();
    if (client) await client.zrem(semaphoreKey, token).catch(() => {});
  }
}

// Fetch a channel's recent videos via RSS feed (zero API quota cost)
// Cache hierarchy: in-memory -> SQLite -> YouTube RSS fetch
async function fetchChannelRSS(
  channelId,
  options: { waitForRefresh?: boolean; priority?: 'interactive' | 'background' } = {},
) {
  const staleLocal = cache.rss.get(channelId);
  const shared = await cache.rss.getAsync(channelId);
  let cached = shared || staleLocal;
  if (cached && Date.now() < cached.expires) return cached.data;

  // Persistent cache survives process restarts. Honor its original fetch time
  // before issuing any network work, and retain stale data for SWR fallback.
  if (!cached) {
    const dbCached = await db.getRssCache(channelId);
    if (dbCached) {
      rssValidators.set(channelId, dbCached.validators);
      const expires = fetchedAtMs(dbCached.fetchedAt) + RSS_TTL;
      cached = { data: dbCached.data, expires };
      cache.rss.set(channelId, cached);
      if (Date.now() < expires) return dbCached.data;
    }
  }

  if (cached) {
    if (hasRssRefreshQueue()) {
      const enqueue = enqueueRssRefresh(channelId, {
        priority: options.priority || 'background',
        waitForRefresh: Boolean(options.waitForRefresh),
        // Tie deduplication to the version of stale data being refreshed. A
        // successful worker publication advances expires and therefore the
        // next genuinely stale version receives a new job id.
        freshnessAt: cached.expires,
      });
      if (!options.waitForRefresh) {
        void enqueue.then((result) => {
          if (result === null || result === 'failed') {
            void scheduleRssRefresh(channelId, cached!.data, options.priority || 'background').catch(() => {});
          }
        }).catch(() => {
          void scheduleRssRefresh(channelId, cached!.data, options.priority || 'background').catch(() => {});
        });
        return cached.data;
      }
      const result = await enqueue;
      if (result === 'completed') {
        const refreshed = await cache.rss.getAsync(channelId);
        if (refreshed && Date.now() < refreshed.expires) return refreshed.data;
        const persisted = await db.getRssCache(channelId);
        if (persisted) return persisted.data;
      }
      // A still-running durable job owns the refresh. Preserve stale-while-
      // revalidate behavior instead of duplicating it in this web worker.
      if (result === 'queued') return cached.data;
      // Failed/circuit-open queue operations fall through to the local safety
      // path so Redis availability never makes feeds unavailable.
    }
    const refresh = scheduleRssRefresh(channelId, cached.data, options.priority || 'background');
    if (options.waitForRefresh) return refresh;
    void refresh.catch(() => {});
    return cached.data;
  }
  if (hasRssRefreshQueue()) {
    const result = await enqueueRssRefresh(channelId, {
      priority: options.priority || 'interactive',
      waitForRefresh: true,
    });
    if (result === 'completed') {
      const refreshed = await cache.rss.getAsync(channelId);
      if (refreshed && Date.now() < refreshed.expires) return refreshed.data;
      const persisted = await db.getRssCache(channelId);
      if (persisted) return persisted.data;
    }
    if (result === 'queued') return { items: [], channelTitle: '' };
  }
  return scheduleRssRefresh(channelId, undefined, options.priority || 'interactive');
}

async function refreshChannelRSSNow(channelId: string) {
  const persisted = await db.getRssCache(channelId);
  if (persisted) rssValidators.set(channelId, persisted.validators);
  const data = await refreshChannelRSS(channelId, persisted?.data);
  const refreshed = cache.rss.get(channelId);
  return {
    refreshed: Boolean(refreshed && Date.now() < refreshed.expires),
    itemCount: Array.isArray(data.items) ? data.items.length : 0,
  };
}

export { fetchChannelRSS, refreshChannelRSSNow };
