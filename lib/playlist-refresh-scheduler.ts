import db from '../db.js';
import { getPlaylistDetails } from '../youtube/playlists.js';
import { acquireLock, getRedisClient, releaseLock, renewLock } from './cache.js';
import { acquireRedisSemaphore } from './distributed-semaphore.js';
import { incrementMetric, observeMetric, setMetricGauge } from './performance-metrics.js';

type PlaylistRefreshResult = 'refreshed' | 'deduplicated';
type QueuedTask = {
  key: string;
  userId: string;
  playlistId: string;
  resolve: (result: PlaylistRefreshResult) => void;
  reject: (error: unknown) => void;
};

const LOCAL_CONCURRENCY = Math.min(16, Math.max(1,
  Number(process.env.PLAYLIST_REFRESH_CONCURRENCY) || 2,
));
const GLOBAL_CONCURRENCY = Math.min(64, Math.max(1,
  Number(process.env.PLAYLIST_REFRESH_GLOBAL_CONCURRENCY) || 4,
));
const MAX_QUEUE = Math.max(20, Number(process.env.PLAYLIST_REFRESH_MAX_QUEUE) || 500);
const LEASE_MS = Math.max(15_000, Number(process.env.PLAYLIST_REFRESH_LEASE_MS) || 60_000);
const WAIT_MS = Math.max(1_000, Number(process.env.PLAYLIST_REFRESH_WAIT_MS) || 60_000);

const queue: QueuedTask[] = [];
const inflight = new Map<string, Promise<PlaylistRefreshResult>>();
let active = 0;

function updateMetrics() {
  setMetricGauge('playlist_refresh_queue_depth', queue.length);
  setMetricGauge('playlist_refresh_active', active);
}

function taskKey(userId: string, playlistId: string) {
  return `${userId}\u0000${playlistId}`;
}

async function runRefresh(userId: string, playlistId: string): Promise<PlaylistRefreshResult> {
  const startedAt = Date.now();
  const lockKey = `playlist-refresh:${userId}:${playlistId}`;
  const lockToken = await acquireLock(lockKey, LEASE_MS);
  if (!lockToken) {
    incrementMetric('playlist_refresh_jobs_total', { result: 'deduplicated' });
    return 'deduplicated';
  }
  const renewTimer = setInterval(() => {
    void renewLock(lockKey, lockToken, LEASE_MS);
  }, Math.max(5_000, Math.floor(LEASE_MS / 3)));
  renewTimer.unref?.();

  let globalLease: Awaited<ReturnType<typeof acquireRedisSemaphore>> | null = null;
  try {
    const redis = getRedisClient();
    if (redis) {
      globalLease = await acquireRedisSemaphore(redis, {
        key: 'semaphore:playlist-refresh',
        limit: GLOBAL_CONCURRENCY,
        leaseMs: LEASE_MS,
        waitTimeoutMs: WAIT_MS,
        owner: `playlist:${process.pid}`,
        onRenewError: () => incrementMetric('playlist_refresh_coordination_errors_total', { operation: 'renew' }),
      });
      observeMetric('playlist_refresh_slot_wait_ms', globalLease.waitMs);
    }

    const playlist = await getPlaylistDetails(playlistId, { priority: 'background' });
    await db.savePlaylist(
      userId,
      playlist.playlistId,
      playlist.title,
      playlist.channelTitle,
      playlist.channelId,
      playlist.thumbnailVideoId,
      playlist.itemCountText,
      'youtube',
    );
    incrementMetric('playlist_refresh_jobs_total', { result: 'refreshed' });
    observeMetric('playlist_refresh_duration_ms', Date.now() - startedAt, { result: 'refreshed' });
    return 'refreshed';
  } catch (error) {
    incrementMetric('playlist_refresh_jobs_total', { result: 'failed' });
    observeMetric('playlist_refresh_duration_ms', Date.now() - startedAt, { result: 'failed' });
    throw error;
  } finally {
    if (globalLease) {
      await globalLease.release().catch(() => {
        incrementMetric('playlist_refresh_coordination_errors_total', { operation: 'release_slot' });
      });
    }
    clearInterval(renewTimer);
    await releaseLock(lockKey, lockToken);
  }
}

function drainQueue() {
  while (active < LOCAL_CONCURRENCY && queue.length > 0) {
    const task = queue.shift()!;
    active++;
    updateMetrics();
    void runRefresh(task.userId, task.playlistId)
      .then(task.resolve, task.reject)
      .finally(() => {
        active--;
        inflight.delete(task.key);
        updateMetrics();
        drainQueue();
      });
  }
}

function enqueuePlaylistRefresh(userId: string, playlistId: string) {
  const key = taskKey(userId, playlistId);
  const existing = inflight.get(key);
  if (existing !== undefined) {
    incrementMetric('playlist_refresh_jobs_total', { result: 'local_deduplicated' });
    return existing;
  }
  if (queue.length >= MAX_QUEUE) {
    incrementMetric('playlist_refresh_jobs_total', { result: 'queue_full' });
    return Promise.reject(new Error('playlist-refresh-queue-full'));
  }
  let resolveTask!: (result: PlaylistRefreshResult) => void;
  let rejectTask!: (error: unknown) => void;
  const promise = new Promise<PlaylistRefreshResult>((resolve, reject) => {
    resolveTask = resolve;
    rejectTask = reject;
  });
  inflight.set(key, promise);
  queue.push({ key, userId, playlistId, resolve: resolveTask, reject: rejectTask });
  incrementMetric('playlist_refresh_jobs_total', { result: 'queued' });
  updateMetrics();
  queueMicrotask(drainQueue);
  return promise;
}

function enqueuePlaylistRefreshBatch(userId: string, playlistIds: string[]) {
  const uniqueIds = [...new Set(playlistIds)].filter(Boolean);
  for (const playlistId of uniqueIds) {
    void enqueuePlaylistRefresh(userId, playlistId).catch((error) => {
      console.warn('[playlists] metadata refresh failed for', playlistId, (error as Error).message);
    });
  }
  return uniqueIds.length;
}

export { enqueuePlaylistRefresh, enqueuePlaylistRefreshBatch };
export type { PlaylistRefreshResult };
