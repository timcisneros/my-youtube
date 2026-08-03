import 'dotenv/config';

import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import db from './db.js';
import { fetchWithBodyTimeout } from './lib/bounded-fetch.js';
import { cancelKey, type DownloadJobData, type DownloadJobFormat } from './lib/download-queue.js';
import {
  DOWNLOADS_DIR,
  downloadedFormatPath,
  invalidateDownloadedVideo,
  recordDownloadedFormats,
  removeDownloadedFormatRecords,
} from './lib/download-files.js';
import { isYouTubeCdnUrl } from './extractors.js';
import logger from './lib/logger.js';
import { acquireRedisSemaphore } from './lib/distributed-semaphore.js';
import { releaseQueueJob } from './lib/queue-admission.js';
import {
  DOWNLOAD_MAX_FORMAT_BYTES,
  DOWNLOAD_MAX_VIDEO_BYTES,
  DownloadStorageError,
  assertDownloadFreeSpace,
  estimateDownloadBytes,
  reserveDownloadStorage,
} from './lib/download-storage.js';

const queueRedisUrl = process.env.QUEUE_REDIS_URL || process.env.REDIS_URL;
if (!queueRedisUrl) {
  logger.error('download worker configuration missing', { required: 'QUEUE_REDIS_URL or REDIS_URL' });
  process.exit(1);
}

const redisUrl = new URL(queueRedisUrl);
const connection = {
  host: redisUrl.hostname,
  port: parseInt(redisUrl.port, 10) || 6379,
  password: redisUrl.password || undefined,
  username: redisUrl.username || undefined,
  db: redisUrl.pathname ? parseInt(redisUrl.pathname.slice(1), 10) || 0 : 0,
  maxRetriesPerRequest: null,
};
const cancellationRedis = new Redis(queueRedisUrl, {
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
  connectTimeout: Math.max(500, Number(process.env.REDIS_CONNECT_TIMEOUT_MS) || 2500),
});
const concurrency = Math.max(1, Number(process.env.DOWNLOAD_JOB_CONCURRENCY) || 2);
const globalFormatConcurrency = Math.max(1, Number(process.env.DOWNLOAD_FORMAT_GLOBAL_CONCURRENCY) || 4);
const formatSlotLeaseMs = Math.max(30_000, Number(process.env.DOWNLOAD_FORMAT_SLOT_LEASE_MS) || 120_000);
const formatSlotWaitMs = Math.max(5_000, Number(process.env.DOWNLOAD_FORMAT_SLOT_WAIT_MS) || 10 * 60_000);
const downloadJobMaxAgeMs = Math.max(
  60_000,
  Number(process.env.DOWNLOAD_QUEUE_JOB_MAX_AGE_MS) || 10 * 60_000,
);

function abortError() {
  const error = new Error('download-cancelled');
  error.name = 'AbortError';
  return error;
}

async function downloadFormat(
  videoId: string,
  format: DownloadJobFormat,
  signal: AbortSignal,
  onBytes: (bytes: number, declaredTotal?: number) => void,
) {
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)
    || !/^[A-Za-z0-9_-]{1,64}$/.test(format.formatId)
    || !isYouTubeCdnUrl(format.url)) {
    throw new Error('Invalid queued download format');
  }
  if ((Number(format.expectedBytes) || 0) > DOWNLOAD_MAX_FORMAT_BYTES) {
    throw new DownloadStorageError('format_too_large', 'A selected media format exceeds the configured size limit');
  }
  const slot = await acquireRedisSemaphore(cancellationRedis, {
    key: 'semaphore:download-formats',
    limit: globalFormatConcurrency,
    leaseMs: formatSlotLeaseMs,
    waitTimeoutMs: formatSlotWaitMs,
    owner: `download:${process.pid}`,
    onRenewError(error) {
      logger.warn('download format semaphore renewal failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    },
  }, signal);
  if (slot.waitMs >= 1_000) {
    logger.info('download format waited for global capacity', { videoId, waitMs: slot.waitMs });
  }
  const finalPath = downloadedFormatPath(videoId, format.formatId);
  const temporaryPath = `${finalPath}.part-${process.pid}-${randomUUID()}`;
  try {
    const response = await fetchWithBodyTimeout(format.url, {
      headers: format.headers,
      signal,
    }, {
      headerTimeoutMs: 15_000,
      bodyIdleMs: 30_000,
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`Download upstream returned HTTP ${response.status}`);
    }
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > DOWNLOAD_MAX_FORMAT_BYTES) {
      await response.body.cancel().catch(() => {});
      throw new DownloadStorageError('format_too_large', 'A selected media format exceeds the configured size limit');
    }
    if (Number.isFinite(declared) && declared > 0) onBytes(0, declared);
    let bytes = 0;
    let nextDiskCheck = 64 * 1024 * 1024;
    const progress = new Transform({
      transform(chunk, _encoding, callback) {
        bytes += chunk.length;
        try {
          if (bytes > DOWNLOAD_MAX_FORMAT_BYTES) {
            throw new DownloadStorageError('format_too_large', 'Download stopped at the configured format size limit');
          }
          onBytes(chunk.length);
        } catch (error) {
          callback(error as Error);
          return;
        }
        if (bytes >= nextDiskCheck) {
          nextDiskCheck += 64 * 1024 * 1024;
          void assertDownloadFreeSpace().then(
            () => callback(null, chunk),
            error => callback(error as Error),
          );
          return;
        }
        callback(null, chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(response.body, { highWaterMark: 256 * 1024 }),
      progress,
      fs.createWriteStream(temporaryPath, { highWaterMark: 256 * 1024 }),
      { signal },
    );
    return { temporaryPath, finalPath, bytes, formatId: format.formatId };
  } catch (error) {
    await fs.promises.unlink(temporaryPath).catch(() => {});
    throw error;
  } finally {
    await slot.release().catch(error => {
      logger.warn('download format semaphore release failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
}

async function processDownload(data: DownloadJobData) {
  const { videoId, formats } = data;
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId) || !Array.isArray(formats) || formats.length < 1 || formats.length > 2) {
    throw new Error('Invalid download job');
  }
  await fs.promises.mkdir(DOWNLOADS_DIR, { recursive: true });

  const controller = new AbortController();
  let checkingCancellation = false;
  const cancelTimer = setInterval(() => {
    if (checkingCancellation || controller.signal.aborted) return;
    checkingCancellation = true;
    void cancellationRedis.exists(cancelKey(videoId)).then(exists => {
      if (exists) controller.abort(abortError());
    }).catch(() => {}).finally(() => { checkingCancellation = false; });
  }, 1000);
  cancelTimer.unref?.();

  const existingBytes = Math.max(0, Number(data.existingBytes) || 0);
  let downloadedBytes = existingBytes;
  let totalBytes = existingBytes;
  let lastProgressAt = 0;
  let progressWrite: Promise<unknown> = Promise.resolve();
  const persistProgress = (force = false) => {
    if (!force && Date.now() - lastProgressAt < 1000) return;
    lastProgressAt = Date.now();
    const downloaded = downloadedBytes;
    const total = totalBytes;
    progressWrite = progressWrite.then(() => db.updateDownloadProgress(videoId, downloaded, total));
  };
  const onBytes = (bytes: number, declaredTotal?: number) => {
    downloadedBytes += bytes;
    if (declaredTotal) totalBytes += declaredTotal;
    if (Math.max(downloadedBytes, totalBytes) > DOWNLOAD_MAX_VIDEO_BYTES) {
      throw new DownloadStorageError('video_too_large', 'Download stopped at the configured video size limit');
    }
    persistProgress();
  };

  let completed: Array<{ temporaryPath: string; finalPath: string; bytes: number; formatId: string }> = [];
  const committed: Array<{ finalPath: string; bytes: number; formatId: string; accounted: boolean }> = [];
  try {
    const settled = await Promise.allSettled(formats.map(format => downloadFormat(
      videoId,
      format,
      controller.signal,
      onBytes,
    ).catch(error => {
      controller.abort(error);
      throw error;
    })));
    completed = settled
      .filter((entry): entry is PromiseFulfilledResult<{ temporaryPath: string; finalPath: string; bytes: number; formatId: string }> => entry.status === 'fulfilled')
      .map(entry => entry.value);
    const failure = settled.find((entry): entry is PromiseRejectedResult => entry.status === 'rejected');
    if (failure) throw failure.reason;
    totalBytes = existingBytes + completed.reduce((sum, entry) => sum + entry.bytes, 0);
    downloadedBytes = totalBytes;
    persistProgress(true);
    await progressWrite;
    for (const entry of completed) {
      const previous = await fs.promises.stat(entry.finalPath).catch(() => null);
      await fs.promises.rename(entry.temporaryPath, entry.finalPath);
      const committedEntry = { finalPath: entry.finalPath, bytes: entry.bytes, formatId: entry.formatId, accounted: false };
      committed.push(committedEntry);
      await db.adjustDownloadStorageBytes(entry.bytes - (previous?.size || 0));
      committedEntry.accounted = true;
    }
    await recordDownloadedFormats(videoId, completed.map(entry => ({
      formatId: entry.formatId,
      size: entry.bytes,
    })));
    await db.completeDownload(videoId);
    logger.info('download worker completed', { videoId, formats: completed.length, bytes: totalBytes });
    return { videoId, formats: completed.length, bytes: totalBytes };
  } catch (error) {
    controller.abort(error);
    await Promise.all(completed.map(entry => fs.promises.unlink(entry.temporaryPath).catch(() => {})));
    for (const entry of committed) {
      const removed = await fs.promises.unlink(entry.finalPath).then(() => true, () => false);
      if (removed && entry.accounted) await db.adjustDownloadStorageBytes(-entry.bytes);
    }
    await removeDownloadedFormatRecords(videoId, committed.map(entry => entry.formatId))
      .catch(() => { invalidateDownloadedVideo(videoId); });
    await db.failDownload(videoId);
    throw error;
  } finally {
    clearInterval(cancelTimer);
  }
}

if (db._ready !== undefined) await db._ready;

const worker = new Worker<DownloadJobData>('downloads', async job => {
  const jobId = String(job.id || `download:${job.data.videoId}`);
  let releaseStorage: (() => Promise<void>) | null = null;
  try {
    const queueAgeMs = Date.now() - job.timestamp;
    if (queueAgeMs > downloadJobMaxAgeMs) {
      await db.failDownload(job.data.videoId);
      throw new Error(`Download job expired after ${queueAgeMs}ms in the queue`);
    }
    const expectedBytes = estimateDownloadBytes(job.data.formats);
    const existingBytes = Math.max(0, Number(job.data.existingBytes) || 0);
    if (existingBytes + expectedBytes > DOWNLOAD_MAX_VIDEO_BYTES) {
      throw new DownloadStorageError('video_too_large', 'The selected video exceeds the configured download size limit');
    }
    releaseStorage = await reserveDownloadStorage(cancellationRedis, jobId, expectedBytes);
    return await processDownload(job.data);
  } catch (error) {
    await Promise.resolve(db.failDownload(job.data.videoId)).catch(() => {});
    throw error;
  } finally {
    if (releaseStorage) {
      await releaseStorage().catch(error => {
        logger.warn('download storage reservation release failed', {
          jobId,
          error: (error as Error).message,
        });
      });
    }
    await releaseQueueJob(
      cancellationRedis,
      'downloads',
      jobId,
      job.data.ownerId,
    ).catch(error => {
      logger.warn('download queue admission release failed', {
        jobId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
}, {
  connection,
  concurrency,
});
worker.on('failed', (job, error) => logger.error('download worker job failed', { jobId: job?.id || '?', error: error.message }));
worker.on('error', error => logger.error('download worker error', { error: error.message }));
logger.info('download worker listening', {
  queue: 'downloads',
  concurrency,
  maxLocalFormatStreams: concurrency * 2,
  maxGlobalFormatStreams: globalFormatConcurrency,
});

async function shutdown() {
  await Promise.allSettled([worker.close(), cancellationRedis.quit()]);
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
