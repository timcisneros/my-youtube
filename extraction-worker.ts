/**
 * Extraction Worker — runs yt-dlp and extraction backends in a separate process.
 * Communicates with web workers via Redis (BullMQ).
 *
 * Start: node extraction-worker.js
 * Requires: QUEUE_REDIS_URL or REDIS_URL environment variable
 */
import 'dotenv/config';

import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { extractVideo } from './lib/extract.js';
import logger from './lib/logger.js';
import { releaseQueueJob } from './lib/queue-admission.js';

const queueRedisUrl = process.env.QUEUE_REDIS_URL || process.env.REDIS_URL;
if (!queueRedisUrl) {
  logger.error('extraction worker configuration missing', { required: 'QUEUE_REDIS_URL or REDIS_URL' });
  process.exit(1);
}

const url = new URL(queueRedisUrl);
const connection = {
  host: url.hostname,
  port: parseInt(url.port, 10) || 6379,
  password: url.password || undefined,
  username: url.username || undefined,
  db: url.pathname ? parseInt(url.pathname.slice(1), 10) || 0 : 0,
  maxRetriesPerRequest: null,
};

const concurrency = parseInt(process.env.MAX_EXTRACTION_WORKERS, 10) || 2;
const admissionRedis = new Redis(queueRedisUrl, {
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
  connectTimeout: Math.max(500, Number(process.env.REDIS_CONNECT_TIMEOUT_MS) || 2500),
});
const extractionJobMaxAgeMs = Math.max(
  30_000,
  Number(process.env.EXTRACTION_QUEUE_JOB_MAX_AGE_MS) || 3 * 60_000,
);

const worker = new Worker('extraction', async (job) => {
  const { videoId, priority = 'playback' } = job.data;
  const jobId = String(job.id || `extract:${videoId}`);
  try {
    const queueAgeMs = Date.now() - job.timestamp;
    if (queueAgeMs > extractionJobMaxAgeMs) {
      logger.warn('discarding stale extraction job', { videoId, priority, jobId, queueAgeMs });
      return {
        formats: [],
        duration: 0,
        _unavailable: 'The extraction request expired in the queue. Try again.',
      };
    }
    logger.debug('extraction worker started', { videoId, priority, jobId });

    const info = await extractVideo(videoId, { priority });

    if (!info) {
      logger.warn('extraction worker backends failed', { videoId, priority });
      return { formats: [], duration: 0, _unavailable: 'All extraction backends failed. Try again in a few minutes.' };
    }

    const fmts = info.formats || [];
    const hlsCount = fmts.filter(f => f.protocol && f.protocol.startsWith('m3u8') && f.vcodec && f.vcodec !== 'none').length;
    const directCount = fmts.filter(f => f.url && (!f.protocol || f.protocol === 'https' || f.protocol === 'http')).length;
    logger.sampledInfo('extraction-worker-result', 'extraction worker result', {
      videoId,
      priority,
      formats: fmts.length,
      hlsFormats: hlsCount,
      directFormats: directCount,
      via: info._extractedVia || 'yt-dlp',
    });

    return info;
  } finally {
    await releaseQueueJob(admissionRedis, 'extraction', jobId).catch(error => {
      logger.warn('extraction queue admission release failed', {
        jobId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
}, {
  connection,
  concurrency,
});

worker.on('completed', (job) => {
  logger.debug('extraction worker job completed', { jobId: job.id });
});

worker.on('failed', (job, err) => {
  logger.error('extraction worker job failed', { jobId: job?.id || '?', error: err.message });
});

worker.on('error', (err) => {
  logger.error('extraction worker error', { error: err.message });
});

logger.info('extraction worker listening', { queue: 'extraction', concurrency });

let rssWorker: Worker | null = null;
const rssQueueEnabled = ['1', 'true'].includes(String(process.env.RSS_REFRESH_QUEUE_ENABLED || '').toLowerCase());
if (rssQueueEnabled) {
  try {
    const [{ initRedis }, { default: db }, { refreshChannelRSSNow }] = await Promise.all([
      import('./lib/cache.js'),
      import('./db.js'),
      import('./youtube/rss.js'),
    ]);
    if (db._ready !== undefined) await db._ready;
    await initRedis();
    const rssConcurrency = Math.max(1, Number(process.env.RSS_REFRESH_CONCURRENCY) || 6);
    rssWorker = new Worker('rss-refresh', async (job) => {
      const startedAt = Date.now();
      const result = await refreshChannelRSSNow(String(job.data.channelId || ''));
      if (!result.refreshed) throw new Error('RSS source did not publish a fresh feed');
      logger.sampledInfo('rss-worker-result', 'RSS refresh completed', {
        channelId: job.data.channelId,
        itemCount: result.itemCount,
        durationMs: Date.now() - startedAt,
      });
      return result;
    }, {
      connection,
      concurrency: rssConcurrency,
    });
    rssWorker.on('failed', (job, error) => {
      logger.warn('RSS refresh job failed', { jobId: job?.id || '?', error: error.message });
    });
    rssWorker.on('error', (error) => {
      logger.error('RSS refresh worker error', { error: error.message });
    });
    logger.info('RSS refresh worker listening', { queue: 'rss-refresh', concurrency: rssConcurrency });
  } catch (error) {
    logger.error('RSS refresh worker initialization failed', { error: (error as Error).message });
  }
}

// Graceful shutdown
async function shutdown() {
  logger.info('extraction worker shutting down');
  await Promise.allSettled([worker.close(), rssWorker?.close(), admissionRedis.quit()]);
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
