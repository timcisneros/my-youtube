/**
 * Extraction Queue — enqueues extraction jobs for the worker process.
 * When REDIS_URL is set, uses BullMQ. Falls back to in-process extraction.
 */
import { Queue, QueueEvents } from 'bullmq';

let queue = null;
let queueEvents = null;
let connection = null;

async function initQueue() {
  if (!process.env.REDIS_URL) return false;
  try {
    const { default: _Redis } = await import('ioredis');
    const url = new URL(process.env.REDIS_URL);
    connection = {
      host: url.hostname,
      port: parseInt(url.port, 10) || 6379,
      password: url.password || undefined,
      username: url.username || undefined,
      db: url.pathname ? parseInt(url.pathname.slice(1), 10) || 0 : 0,
      maxRetriesPerRequest: null,
    };
    queue = new Queue('extraction', { connection });
    queueEvents = new QueueEvents('extraction', { connection });
    console.log('[extraction-queue] Queue initialized');
    return true;
  } catch (err) {
    console.warn('[extraction-queue] Queue unavailable:', err.message);
    queue = null;
    queueEvents = null;
    return false;
  }
}

async function enqueueExtraction(videoId, timeoutMs) {
  if (!queue) return null; // No queue -> caller should extract in-process

  const job = await queue.add('extract', { videoId }, {
    jobId: `extract:${videoId}`, // dedup by videoId
    removeOnComplete: { age: 300 }, // keep results 5 min
    removeOnFail: { age: 60 },
    attempts: 1,
  });

  // Wait for result with timeout
  try {
    const result = await job.waitUntilFinished(queueEvents, timeoutMs || 60000);
    return result;
  } catch (err) {
    console.warn(`[extraction-queue] Job ${videoId} failed:`, err.message);
    return null;
  }
}

function hasQueue() { return queue !== null; }

export { initQueue, enqueueExtraction, hasQueue };
