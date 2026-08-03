/**
 * Today's videos — aggregates recent videos from all subscribed channels.
 */
import db from '../db.js';
import { cache, LRUMap, RSS_TTL, TODAY_TTL } from './shared.js';
import { fetchChannelRSS } from './rss.js';
import { acquireLock, renewLock, releaseLock } from '../lib/cache.js';
import { enqueueRssRefreshBatch } from '../lib/rss-refresh-queue.js';
import { randomUUID } from 'node:crypto';
import type { CursorDirection, RSSRefreshCandidate, TodayPageCursor } from '../types.js';

const TODAY_COLD_START_BUDGET_MS = 1500;
const TODAY_REFRESH_LEASE_MS = 60_000;
const TODAY_REFRESH_CHANNELS_PER_RUN = Math.max(1, Number(process.env.TODAY_REFRESH_CHANNELS_PER_RUN) || 160);
const TODAY_REFRESH_COMPLETION_BUDGET_MS = Math.max(1_000, Number(process.env.TODAY_REFRESH_COMPLETION_BUDGET_MS) || 20_000);
const TODAY_INCREMENTAL_TTL_MS = Math.min(TODAY_TTL, Math.max(60_000, Number(process.env.TODAY_INCREMENTAL_TTL_MS) || 5 * 60_000));
const TODAY_PAGE_SIZE = Math.min(200, Math.max(20, Number(process.env.TODAY_PAGE_SIZE) || 60));
const TODAY_LOCAL_REFRESH_CONCURRENCY = Math.max(1, Number(process.env.TODAY_LOCAL_REFRESH_CONCURRENCY) || 8);
const TODAY_VERSION_TTL_MS = Math.max(TODAY_TTL, 24 * 60 * 60_000);

function formatDuration(seconds: number) {
  const value = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const remainder = value % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
  return `${minutes}:${String(remainder).padStart(2, '0')}`;
}

interface TodayCursorToken extends TodayPageCursor {
  direction: CursorDirection;
}

function decodeTodayCursor(value: unknown): TodayCursorToken | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) return null;
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<TodayCursorToken>;
    if (decoded.direction !== 'older' && decoded.direction !== 'newer') return null;
    if (typeof decoded.publishedAt !== 'string' || decoded.publishedAt.length > 64) return null;
    if (!Number.isFinite(new Date(decoded.publishedAt).getTime())) return null;
    if (typeof decoded.videoId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(decoded.videoId)) return null;
    return {
      publishedAt: decoded.publishedAt,
      videoId: decoded.videoId,
      direction: decoded.direction,
    };
  } catch {
    return null;
  }
}

function encodeTodayCursor(row: TodayPageCursor, direction: CursorDirection): string {
  return Buffer.from(JSON.stringify({
    publishedAt: row.publishedAt,
    videoId: row.videoId,
    direction,
  })).toString('base64url');
}

function todayPageRequestKey(requestedCursor: unknown) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const cursor = decodeTodayCursor(requestedCursor);
  const cursorKey = cursor
    ? `${cursor.direction}:${cursor.publishedAt}:${cursor.videoId}`
    : 'first';
  return `${today.toISOString()}:${TODAY_PAGE_SIZE}:${cursorKey}`;
}

async function getTodayCacheVersion(userId: string) {
  const cached = await cache.todayVersions.getAsync(userId);
  return cached?.version || 'base';
}

function todayPageCacheKey(userId: string, version: string, requestedCursor: unknown) {
  return `${userId}:${version}:${todayPageRequestKey(requestedCursor)}`;
}

async function bumpTodayCacheVersion(userId: string) {
  await cache.todayVersions.setAsync(userId, {
    version: randomUUID(),
    expires: Date.now() + TODAY_VERSION_TTL_MS,
  });
}

async function invalidateTodayCache(userId: string) {
  await Promise.all([
    bumpTodayCacheVersion(userId),
    cache.todayRefreshState.deleteAsync(userId),
  ]);
}

async function refreshTodayLocally(refreshCandidates: RSSRefreshCandidate[]) {
  let nextIndex = 0;
  const workers = Array.from({
    length: Math.min(TODAY_LOCAL_REFRESH_CONCURRENCY, refreshCandidates.length),
  }, async () => {
    while (nextIndex < refreshCandidates.length) {
      const { channelId } = refreshCandidates[nextIndex++];
      try {
        await fetchChannelRSS(channelId, { waitForRefresh: true, priority: 'background' });
      } catch (err) {
        console.warn(`[RSS] failed for ${channelId}:`, (err as Error).message);
      }
    }
  });
  await Promise.all(workers);
}

// Read only the requested page and its render metadata. The former 5,000-row
// snapshot made every cache refresh pay for pages the user never visited.
async function _buildTodayPageFromDb(userId, requestedCursor) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayISO = today.toISOString();
  const token = decodeTodayCursor(requestedCursor);
  const direction = token?.direction || 'older';
  const page = await db.getRssVideosCursorPageForUser(
    userId,
    todayISO,
    30,
    TODAY_PAGE_SIZE,
    token ? { publishedAt: token.publishedAt, videoId: token.videoId } : null,
    direction,
  );
  const durations: Record<string, string> = {};
  const liveStatuses: Record<string, string> = {};
  const videos = page.items.map(row => {
    const duration = Number(row.duration) || 0;
    if (duration > 0) durations[row.video_id] = formatDuration(duration);
    liveStatuses[row.video_id] = row.live_status || 'not_live';
    return {
      videoId: row.video_id,
      title: row.title,
      thumbnail: `https://i.ytimg.com/vi/${row.video_id}/mqdefault.jpg`,
      channelTitle: row.sub_title || '',
      channelId: row.channel_id,
      publishedAt: row.published_at,
    };
  });
  const firstRow = page.items[0];
  const lastRow = page.items[page.items.length - 1];
  const prevCursor = firstRow && (
    direction === 'newer' ? page.hasMore : token !== null
  ) ? encodeTodayCursor({ publishedAt: firstRow.published_at, videoId: firstRow.video_id }, 'newer') : null;
  const nextCursor = lastRow && (
    direction === 'older' ? page.hasMore : token !== null
  ) ? encodeTodayCursor({ publishedAt: lastRow.published_at, videoId: lastRow.video_id }, 'older') : null;
  return {
    videos,
    durations,
    liveStatuses,
    pageSize: TODAY_PAGE_SIZE,
    prevCursor,
    nextCursor,
  };
}

const _refreshInflight = new LRUMap(50);
async function _refreshTodayVideos(userId) {
  if (_refreshInflight.has(userId)) return _refreshInflight.get(userId);
  const promise = _refreshTodayVideosOwned(userId);
  _refreshInflight.set(userId, promise);
  const cleanup = () => _refreshInflight.delete(userId);
  void promise.then(cleanup, cleanup);
  return promise;
}
async function _refreshTodayVideosOwned(userId) {
  const lockKey = `today-refresh:${userId}`;
  const token = await acquireLock(lockKey, TODAY_REFRESH_LEASE_MS);
  if (!token) return { owned: false, refreshed: false };
  const renewTimer = setInterval(() => {
    void renewLock(lockKey, token, TODAY_REFRESH_LEASE_MS);
  }, Math.floor(TODAY_REFRESH_LEASE_MS / 3));
  if (typeof renewTimer.unref === 'function') renewTimer.unref();
  try {
    return { owned: true, refreshed: await _refreshTodayVideosInner(userId) };
  } finally {
    clearInterval(renewTimer);
    await releaseLock(lockKey, token);
  }
}

function fetchedAtMs(value: RSSRefreshCandidate['fetchedAt']) {
  if (value instanceof Date) return value.getTime();
  if (typeof value !== 'string' || !value) return 0;
  // SQLite datetime() is UTC but omits its timezone marker.
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value;
  const ms = new Date(normalized).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

async function publishTodayPage(userId, requestedCursor) {
  const page = await _buildTodayPageFromDb(userId, requestedCursor);
  const version = await getTodayCacheVersion(userId);
  await cache.todayVideos.setAsync(todayPageCacheKey(userId, version, requestedCursor), {
    data: page,
    expires: Date.now() + TODAY_INCREMENTAL_TTL_MS,
  });
  return page;
}

async function _refreshTodayVideosInner(userId) {
  const staleBefore = new Date(Date.now() - RSS_TTL).toISOString();
  const refreshCandidates = await db.getStaleRssRefreshCandidatesForUser(
    userId,
    staleBefore,
    TODAY_REFRESH_CHANNELS_PER_RUN,
  );
  if (refreshCandidates.length === 0) return false;

  // One database read identifies only stale channels and one BullMQ addBulk
  // transaction publishes the slice. Successfully refreshed channels leave
  // this set automatically, making fetched_at the distributed cursor.
  const completion = (async () => {
    const queueResult = await enqueueRssRefreshBatch(refreshCandidates.map((candidate) => {
      const fetchedAt = fetchedAtMs(candidate.fetchedAt);
      return {
        channelId: candidate.channelId,
        freshnessAt: fetchedAt > 0 ? fetchedAt + RSS_TTL : Date.now(),
      };
    }), { priority: 'background', waitForRefresh: true });
    if (queueResult !== null && queueResult !== 'failed') return;

    // Redis and the worker are optional. Preserve the bounded local scheduler
    // as a fail-open path rather than coupling Today availability to BullMQ.
    await refreshTodayLocally(refreshCandidates);
  })();
  const publishFreshVersion = completion.then(async () => {
    await bumpTodayCacheVersion(userId);
    return true;
  });
  const completedWithinBudget = await Promise.race([
    publishFreshVersion,
    new Promise<false>(resolve => {
      const timer = setTimeout(() => resolve(false), TODAY_REFRESH_COMPLETION_BUDGET_MS);
      timer.unref?.();
    }),
  ]);

  if (!completedWithinBudget) {
    // Pages are versioned, so completion atomically makes every older page
    // unreachable without scanning or deleting another worker's cache keys.
    void publishFreshVersion.catch(() => {});
  }
  return true;
}

async function refreshTodayFeedIfDue(userId: string) {
  const fresh = await cache.todayRefreshState.getAsync(userId);
  if (fresh) return false;
  const result = await _refreshTodayVideos(userId);
  if (result?.owned) {
    await cache.todayRefreshState.setAsync(userId, {
      expires: Date.now() + TODAY_INCREMENTAL_TTL_MS,
    });
  }
  return result?.refreshed === true;
}

// Today's videos using RSS (no API quota). Feed freshness is independent of
// the small page snapshots, so pagination cannot repeatedly enqueue RSS work.
async function getTodayVideosPage(userId, requestedCursor) {
  const version = await getTodayCacheVersion(userId);
  const cacheKey = todayPageCacheKey(userId, version, requestedCursor);
  const staleLocal = cache.todayVideos.get(cacheKey);
  const shared = await cache.todayVideos.getAsync(cacheKey);
  const cached = shared || staleLocal;
  if (cached && Date.now() < cached.expires) return cached.data;
  if (cached) {
    publishTodayPage(userId, requestedCursor).catch(err =>
      console.error('Background page refresh failed:', err.message)
    );
    refreshTodayFeedIfDue(userId).catch(err =>
      console.error('Background feed refresh failed:', err.message)
    );
    return cached.data;
  }

  const fromDb = await _buildTodayPageFromDb(userId, requestedCursor);
  if (fromDb.videos.length > 0) {
    await cache.todayVideos.setAsync(cacheKey, {
      data: fromDb,
      expires: Date.now() + TODAY_INCREMENTAL_TTL_MS,
    });
    refreshTodayFeedIfDue(userId).catch(err =>
      console.error('Background feed refresh failed:', err.message)
    );
    return fromDb;
  }

  const refresh = refreshTodayFeedIfDue(userId);
  // An empty continuation is a valid end-of-feed result; only a cold first
  // page waits briefly for RSS data to arrive.
  if (decodeTodayCursor(requestedCursor)) {
    void refresh.catch(err => console.error('Background feed refresh failed:', err.message));
    return fromDb;
  }
  const first = await Promise.race([
    refresh.then(async refreshed => ({
      done: true,
      data: refreshed ? await publishTodayPage(userId, requestedCursor) : fromDb,
    })).catch(() => ({ done: true, data: fromDb })),
    new Promise<{ done: false; data: null }>(resolve => {
      const timer = setTimeout(() => resolve({ done: false, data: null }), TODAY_COLD_START_BUDGET_MS);
      if (typeof timer.unref === 'function') timer.unref();
    }),
  ]);
  if (first.done) return first.data;
  return fromDb;
}

async function getTodayVideos(userId) {
  return (await getTodayVideosPage(userId, null)).videos;
}

function paginateTodayVideos(videos, requestedPage, pageSize = TODAY_PAGE_SIZE) {
  const boundedPageSize = Math.min(200, Math.max(1, Number(pageSize) || TODAY_PAGE_SIZE));
  const totalResults = videos.length;
  const totalPages = Math.max(1, Math.ceil(totalResults / boundedPageSize));
  const parsedPage = Math.max(1, Math.floor(Number(requestedPage) || 1));
  const page = Math.min(parsedPage, totalPages);
  const start = (page - 1) * boundedPageSize;
  return {
    videos: videos.slice(start, start + boundedPageSize),
    page,
    pageSize: boundedPageSize,
    totalPages,
    totalResults,
    prevPage: page > 1 ? page - 1 : null,
    nextPage: page < totalPages ? page + 1 : null,
  };
}

export { getTodayVideos, getTodayVideosPage, invalidateTodayCache, paginateTodayVideos, TODAY_PAGE_SIZE };
