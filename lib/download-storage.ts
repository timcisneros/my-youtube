import fs from 'node:fs';
import path from 'node:path';
import db from '../db.js';
import { DOWNLOADS_DIR } from './download-files.js';
import { incrementMetric, setMetricGauge } from './performance-metrics.js';

type StorageRedis = {
  eval(script: string, numberOfKeys: number, ...args: Array<string | number>): Promise<unknown>;
};

type DownloadSize = { expectedBytes?: number };

const GIB = 1024 * 1024 * 1024;
const DOWNLOAD_MAX_FORMAT_BYTES = Math.max(64 * 1024 * 1024,
  Number(process.env.DOWNLOAD_MAX_FORMAT_BYTES) || 12 * GIB);
const DOWNLOAD_MAX_VIDEO_BYTES = Math.max(DOWNLOAD_MAX_FORMAT_BYTES,
  Number(process.env.DOWNLOAD_MAX_VIDEO_BYTES) || 20 * GIB);
const DOWNLOAD_STORAGE_MAX_BYTES = Math.max(DOWNLOAD_MAX_VIDEO_BYTES,
  Number(process.env.DOWNLOAD_STORAGE_MAX_BYTES) || 200 * GIB);
const DOWNLOAD_MIN_FREE_BYTES = Math.max(64 * 1024 * 1024,
  Number(process.env.DOWNLOAD_MIN_FREE_BYTES) || 2 * GIB);
const DOWNLOAD_MIN_FREE_RATIO = Math.min(0.5, Math.max(0,
  Number(process.env.DOWNLOAD_MIN_FREE_RATIO) || 0.05));
const DOWNLOAD_UNKNOWN_FORMAT_RESERVATION_BYTES = Math.min(
  DOWNLOAD_MAX_FORMAT_BYTES,
  Math.max(64 * 1024 * 1024,
    Number(process.env.DOWNLOAD_UNKNOWN_FORMAT_RESERVATION_BYTES) || 2 * GIB),
);
const DOWNLOAD_STORAGE_RESERVATION_LEASE_MS = Math.max(60_000,
  Number(process.env.DOWNLOAD_STORAGE_RESERVATION_LEASE_MS) || 2 * 60 * 60_000);
const DOWNLOAD_PART_MAX_AGE_MS = Math.max(60_000,
  Number(process.env.DOWNLOAD_PART_MAX_AGE_MS) || 6 * 60 * 60_000);
const DOWNLOAD_MAINTENANCE_BATCH_SIZE = Math.min(512, Math.max(8,
  Number(process.env.DOWNLOAD_MAINTENANCE_BATCH_SIZE) || 64));
const DOWNLOAD_MAINTENANCE_TIME_BUDGET_MS = Math.max(100,
  Number(process.env.DOWNLOAD_MAINTENANCE_TIME_BUDGET_MS) || 5_000);
const DOWNLOAD_MAINTENANCE_INTERVAL_MS = Math.max(5 * 60_000,
  Number(process.env.DOWNLOAD_MAINTENANCE_INTERVAL_MS) || 60 * 60_000);
const DOWNLOAD_STORAGE_RECONCILE_INTERVAL_MS = Math.max(5 * 60_000,
  Number(process.env.DOWNLOAD_STORAGE_RECONCILE_INTERVAL_MS) || 60 * 60_000);
const DOWNLOAD_STORAGE_RECONCILE_INITIAL_DELAY_MS = Math.max(5_000,
  Number(process.env.DOWNLOAD_STORAGE_RECONCILE_INITIAL_DELAY_MS) || 60_000);
const DOWNLOAD_STORAGE_RECONCILE_BATCH_SIZE = Math.min(2_000, Math.max(16,
  Number(process.env.DOWNLOAD_STORAGE_RECONCILE_BATCH_SIZE) || 256));
const DOWNLOAD_MAINTENANCE_INITIAL_DELAY_MS = Math.max(5_000,
  Number(process.env.DOWNLOAD_MAINTENANCE_INITIAL_DELAY_MS) || 30_000);

class DownloadStorageError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'DownloadStorageError';
    this.code = code;
  }
}

function estimateDownloadBytes(formats: DownloadSize[]) {
  return formats.reduce((total, format) => {
    const declared = Math.max(0, Number(format.expectedBytes) || 0);
    return total + (declared > 0 ? declared : DOWNLOAD_UNKNOWN_FORMAT_RESERVATION_BYTES);
  }, 0);
}

async function storageSnapshot() {
  await fs.promises.mkdir(DOWNLOADS_DIR, { recursive: true });
  const [statfs, usage] = await Promise.all([
    fs.promises.statfs(DOWNLOADS_DIR),
    db.getDownloadStorageUsage(),
  ]);
  const storedBytes = Math.max(0, Number(usage.storedBytes) || 0);
  const blockSize = Number(statfs.bsize) || 0;
  const totalBytes = blockSize * (Number(statfs.blocks) || 0);
  const freeBytes = blockSize * (Number(statfs.bavail) || 0);
  setMetricGauge('download_storage_bytes', storedBytes, { state: 'stored' });
  setMetricGauge('download_storage_bytes', freeBytes, { state: 'free' });
  setMetricGauge('download_storage_bytes', totalBytes, { state: 'capacity' });
  return { storedBytes, freeBytes, totalBytes };
}

async function reconcileDownloadStorageUsage() {
  await fs.promises.mkdir(DOWNLOADS_DIR, { recursive: true });
  const before = await db.getDownloadStorageUsage();
  const directory = await fs.promises.opendir(DOWNLOADS_DIR);
  let storedBytes = 0;
  let files = 0;
  let batch: string[] = [];
  const consumeBatch = async () => {
    const paths = batch;
    batch = [];
    const sizes = await Promise.all(paths.map(async filePath => {
      const stat = await fs.promises.stat(filePath).catch(() => null);
      return stat?.isFile() ? stat.size : 0;
    }));
    storedBytes += sizes.reduce((total, size) => total + size, 0);
    files += sizes.filter(size => size > 0).length;
    await new Promise<void>(resolve => setImmediate(resolve));
  };
  for await (const entry of directory) {
    if (!entry.isFile() || !/^mycache-[A-Za-z0-9_-]{11}-[A-Za-z0-9_-]{1,64}\.dat$/.test(entry.name)) continue;
    batch.push(path.join(DOWNLOADS_DIR, entry.name));
    if (batch.length >= DOWNLOAD_STORAGE_RECONCILE_BATCH_SIZE) await consumeBatch();
  }
  if (batch.length > 0) await consumeBatch();
  const applied = await db.reconcileDownloadStorageBytes(storedBytes, before.version);
  incrementMetric('download_storage_reconciliations_total', { result: applied ? 'applied' : 'concurrent_mutation' });
  if (applied) setMetricGauge('download_storage_bytes', storedBytes, { state: 'stored' });
  return { applied, files, storedBytes };
}

let reconciliationTimer: NodeJS.Timeout | null = null;
let reconciliationInitialTimer: NodeJS.Timeout | null = null;
function scheduleDownloadStorageReconciliation() {
  if (reconciliationTimer || reconciliationInitialTimer) return;
  let running = false;
  const run = () => {
    if (running) return;
    running = true;
    void reconcileDownloadStorageUsage()
      .catch(() => incrementMetric('download_storage_reconciliations_total', { result: 'error' }))
      .finally(() => { running = false; });
  };
  reconciliationInitialTimer = setTimeout(() => {
    reconciliationInitialTimer = null;
    run();
    reconciliationTimer = setInterval(run, DOWNLOAD_STORAGE_RECONCILE_INTERVAL_MS);
    reconciliationTimer.unref?.();
  }, DOWNLOAD_STORAGE_RECONCILE_INITIAL_DELAY_MS);
  reconciliationInitialTimer.unref?.();
}

async function filesystemCapacity() {
  await fs.promises.mkdir(DOWNLOADS_DIR, { recursive: true });
  const statfs = await fs.promises.statfs(DOWNLOADS_DIR);
  const blockSize = Number(statfs.bsize) || 0;
  const totalBytes = blockSize * (Number(statfs.blocks) || 0);
  const freeBytes = blockSize * (Number(statfs.bavail) || 0);
  setMetricGauge('download_storage_bytes', freeBytes, { state: 'free' });
  setMetricGauge('download_storage_bytes', totalBytes, { state: 'capacity' });
  return { freeBytes, totalBytes };
}

function reservableBytes(snapshot: { storedBytes: number; freeBytes: number; totalBytes: number }) {
  const minimumFree = Math.max(DOWNLOAD_MIN_FREE_BYTES, snapshot.totalBytes * DOWNLOAD_MIN_FREE_RATIO);
  return Math.max(0, Math.min(
    DOWNLOAD_STORAGE_MAX_BYTES - snapshot.storedBytes,
    snapshot.freeBytes - minimumFree,
  ));
}

async function checkDownloadStorageCapacity(requestedBytes: number) {
  const requested = Math.max(0, Number(requestedBytes) || 0);
  if (requested > DOWNLOAD_MAX_VIDEO_BYTES) {
    throw new DownloadStorageError('video_too_large', 'The selected video exceeds the configured download size limit');
  }
  const snapshot = await storageSnapshot();
  const minimumFree = Math.max(DOWNLOAD_MIN_FREE_BYTES, snapshot.totalBytes * DOWNLOAD_MIN_FREE_RATIO);
  if (snapshot.storedBytes + requested > DOWNLOAD_STORAGE_MAX_BYTES) {
    throw new DownloadStorageError('library_limit', 'The download library has reached its configured size limit');
  }
  if (snapshot.freeBytes - requested < minimumFree) {
    throw new DownloadStorageError('low_disk', 'Not enough disk space is available for this download');
  }
  return snapshot;
}

async function assertDownloadFreeSpace() {
  const snapshot = await filesystemCapacity();
  const minimumFree = Math.max(DOWNLOAD_MIN_FREE_BYTES, snapshot.totalBytes * DOWNLOAD_MIN_FREE_RATIO);
  if (snapshot.freeBytes < minimumFree) {
    throw new DownloadStorageError('low_disk', 'Download stopped before exhausting disk space');
  }
}

const RESERVE_SCRIPT = `
local expired = redis.call('zrangebyscore', KEYS[1], '-inf', ARGV[1])
for _, id in ipairs(expired) do
  redis.call('zrem', KEYS[1], id)
  redis.call('hdel', KEYS[2], id)
end
local total = 0
for _, value in ipairs(redis.call('hvals', KEYS[2])) do
  total = total + tonumber(value)
end
local requested = tonumber(ARGV[3])
local existing = tonumber(redis.call('hget', KEYS[2], ARGV[5]) or '0')
local adjusted = total - existing
if adjusted + requested > tonumber(ARGV[4]) then return {-1, adjusted} end
redis.call('zadd', KEYS[1], ARGV[2], ARGV[5])
redis.call('hset', KEYS[2], ARGV[5], requested)
return {adjusted + requested, adjusted}
`;

const RELEASE_SCRIPT = `
redis.call('zrem', KEYS[1], ARGV[1])
redis.call('hdel', KEYS[2], ARGV[1])
local total = 0
for _, value in ipairs(redis.call('hvals', KEYS[2])) do total = total + tonumber(value) end
return total
`;

async function reserveDownloadStorage(redis: StorageRedis, reservationId: string, requestedBytes: number) {
  const requested = Math.max(1, Math.floor(requestedBytes));
  const snapshot = await checkDownloadStorageCapacity(requested);
  const remainingCapacity = reservableBytes(snapshot);
  const now = Date.now();
  const result = await redis.eval(
    RESERVE_SCRIPT,
    2,
    '{download-storage}:leases',
    '{download-storage}:bytes',
    String(now),
    String(now + DOWNLOAD_STORAGE_RESERVATION_LEASE_MS),
    String(requested),
    String(remainingCapacity),
    reservationId,
  ) as number[];
  const reserved = Number(result?.[0] || 0);
  if (reserved < 0) {
    incrementMetric('download_storage_rejections_total', { reason: 'reserved_capacity' });
    throw new DownloadStorageError('reserved_capacity', 'Download storage capacity is currently reserved by other jobs');
  }
  setMetricGauge('download_storage_bytes', reserved, { state: 'reserved' });
  return async () => {
    const remaining = Number(await redis.eval(
      RELEASE_SCRIPT,
      2,
      '{download-storage}:leases',
      '{download-storage}:bytes',
      reservationId,
    ) || 0);
    setMetricGauge('download_storage_bytes', remaining, { state: 'reserved' });
  };
}

const localReservations = new Map<string, number>();
let localReservationTail: Promise<void> = Promise.resolve();

async function withLocalReservationLock<T>(operation: () => Promise<T> | T): Promise<T> {
  const previous = localReservationTail;
  let unlock = () => {};
  localReservationTail = new Promise<void>(resolve => { unlock = resolve; });
  await previous;
  try {
    return await operation();
  } finally {
    unlock();
  }
}

async function reserveLocalDownloadStorage(reservationId: string, requestedBytes: number) {
  const requested = Math.max(1, Math.floor(requestedBytes));
  return withLocalReservationLock(async () => {
    const snapshot = await checkDownloadStorageCapacity(requested);
    const existing = localReservations.get(reservationId) || 0;
    const reserved = [...localReservations.values()].reduce((total, bytes) => total + bytes, 0) - existing;
    if (reserved + requested > reservableBytes(snapshot)) {
      incrementMetric('download_storage_rejections_total', { reason: 'reserved_capacity' });
      throw new DownloadStorageError('reserved_capacity', 'Download storage capacity is currently reserved by other jobs');
    }
    localReservations.set(reservationId, requested);
    setMetricGauge('download_storage_bytes', reserved + requested, { state: 'reserved' });
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      await withLocalReservationLock(() => {
        localReservations.delete(reservationId);
        const remaining = [...localReservations.values()].reduce((total, bytes) => total + bytes, 0);
        setMetricGauge('download_storage_bytes', remaining, { state: 'reserved' });
      });
    };
  });
}

let stalePartDirectory: fs.Dir | null = null;
async function cleanupStaleDownloadParts(options: { batchSize?: number; timeBudgetMs?: number } = {}) {
  await fs.promises.mkdir(DOWNLOADS_DIR, { recursive: true });
  const directory = stalePartDirectory || await fs.promises.opendir(DOWNLOADS_DIR);
  stalePartDirectory = directory;
  const cutoff = Date.now() - DOWNLOAD_PART_MAX_AGE_MS;
  const batchSize = Math.min(512, Math.max(1, options.batchSize || DOWNLOAD_MAINTENANCE_BATCH_SIZE));
  const timeBudgetMs = Math.max(100, options.timeBudgetMs || DOWNLOAD_MAINTENANCE_TIME_BUDGET_MS);
  const startedAt = Date.now();
  let removed = 0;
  let removedBytes = 0;
  let complete = true;
  let batch: string[] = [];
  const consumeBatch = async () => {
    const paths = batch;
    batch = [];
    const results = await Promise.all(paths.map(async filePath => {
      const stat = await fs.promises.stat(filePath).catch(() => null);
      if (!stat?.isFile() || stat.mtimeMs > cutoff) return 0;
      const deleted = await fs.promises.unlink(filePath).then(() => true, () => false);
      return deleted ? stat.size : 0;
    }));
    removed += results.filter(size => size > 0).length;
    removedBytes += results.reduce((total, size) => total + size, 0);
    await new Promise<void>(resolve => setImmediate(resolve));
  };
  try {
    while (true) {
      const entry = await directory.read();
      if (!entry) {
        await directory.close();
        stalePartDirectory = null;
        break;
      }
      if (entry.isFile() && entry.name.includes('.part-')) {
        batch.push(path.join(DOWNLOADS_DIR, entry.name));
        if (batch.length >= batchSize) await consumeBatch();
      }
      if (Date.now() - startedAt >= timeBudgetMs) {
        complete = false;
        break;
      }
    }
  } catch (error) {
    await directory.close().catch(() => {});
    if (stalePartDirectory === directory) stalePartDirectory = null;
    throw error;
  }
  if (batch.length > 0) await consumeBatch();
  if (removed > 0) {
    incrementMetric('download_stale_parts_removed_total', {}, removed);
    incrementMetric('download_stale_part_bytes_removed_total', {}, removedBytes);
  }
  incrementMetric('download_stale_part_cleanup_runs_total', { result: complete ? 'complete' : 'budget_exhausted' });
  return { removed, removedBytes, complete };
}

let stalePartCleanupTimer: NodeJS.Timeout | null = null;
function scheduleStaleDownloadPartCleanup() {
  if (stalePartCleanupTimer) return;
  const schedule = (delayMs: number) => {
    stalePartCleanupTimer = setTimeout(() => {
      stalePartCleanupTimer = null;
      void cleanupStaleDownloadParts()
        .then(result => schedule(result.complete ? DOWNLOAD_MAINTENANCE_INTERVAL_MS : 1_000))
        .catch(() => schedule(DOWNLOAD_MAINTENANCE_INTERVAL_MS));
    }, delayMs);
    stalePartCleanupTimer.unref?.();
  };
  schedule(DOWNLOAD_MAINTENANCE_INITIAL_DELAY_MS);
}

export {
  DOWNLOAD_MAX_FORMAT_BYTES,
  DOWNLOAD_MAX_VIDEO_BYTES,
  DownloadStorageError,
  assertDownloadFreeSpace,
  checkDownloadStorageCapacity,
  cleanupStaleDownloadParts,
  estimateDownloadBytes,
  reconcileDownloadStorageUsage,
  reserveLocalDownloadStorage,
  reserveDownloadStorage,
  scheduleStaleDownloadPartCleanup,
  scheduleDownloadStorageReconciliation,
};
