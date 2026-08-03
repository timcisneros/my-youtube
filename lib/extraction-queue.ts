/**
 * Extraction Queue — enqueues extraction jobs for the worker process.
 * When REDIS_URL is set, uses BullMQ. Falls back to in-process extraction.
 */
import { Queue, QueueEvents, type Job } from 'bullmq';
import { incrementMetric, setMetricGauge } from './performance-metrics.js';
import {
  queueAdmissionKeys,
  releaseQueueJob,
  reserveQueueJob,
  type QueueAdmissionClient,
} from './queue-admission.js';

let queue = null;
let queueEvents = null;
let connection = null;
let queueReady = false;
let queueCircuitUntil = 0;

const QUEUE_CONNECT_TIMEOUT_MS = Math.max(500, Number(process.env.REDIS_CONNECT_TIMEOUT_MS) || 2500);
const QUEUE_OPERATION_TIMEOUT_MS = Math.max(250, Number(process.env.REDIS_OPERATION_TIMEOUT_MS) || 2000);
const EXTRACTION_QUEUE_MAX_JOBS = Math.max(2, Number(process.env.EXTRACTION_QUEUE_MAX_JOBS) || 200);
const EXTRACTION_QUEUE_PLAYBACK_RESERVE = Math.max(
  1,
  Math.min(EXTRACTION_QUEUE_MAX_JOBS - 1, Number(process.env.EXTRACTION_QUEUE_PLAYBACK_RESERVE) || 50),
);
const EXTRACTION_QUEUE_MAX_BACKGROUND = EXTRACTION_QUEUE_MAX_JOBS - EXTRACTION_QUEUE_PLAYBACK_RESERVE;
const EXTRACTION_QUEUE_ADMISSION_LEASE_MS = Math.max(
  60_000,
  Number(process.env.EXTRACTION_QUEUE_ADMISSION_LEASE_MS) || 15 * 60_000,
);
const EXTRACTION_QUEUE_JOB_MAX_AGE_MS = Math.max(
  30_000,
  Number(process.env.EXTRACTION_QUEUE_JOB_MAX_AGE_MS) || 3 * 60_000,
);
const QUEUE_METRICS_INTERVAL_MS = Math.max(10_000, Number(process.env.QUEUE_METRICS_INTERVAL_MS) || 30_000);
const ownsQueueMetrics = !process.env.CLUSTER_WORKER_COUNT || process.env.CLUSTER_WORKER_SLOT === '0';
let queueMetricsTimer: NodeJS.Timeout | null = null;
let stalePrunePromise: Promise<number> | null = null;

function withDeadline<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    promise.then(
      value => { clearTimeout(timer); resolve(value); },
      err => { clearTimeout(timer); reject(err); },
    );
  });
}

function tripQueueCircuit(err: unknown) {
  queueCircuitUntil = Date.now() + 5000;
  console.warn('[extraction-queue] Producer unavailable, using in-process fallback:', (err as Error).message);
}

async function updateQueueMetrics() {
  if (!queue || !queueReady) return;
  try {
    const counts = await queue.getJobCounts('active', 'waiting', 'prioritized', 'delayed');
    setMetricGauge('extraction_queue_jobs', counts.active || 0, { state: 'active' });
    setMetricGauge('extraction_queue_jobs', counts.waiting || 0, { state: 'waiting' });
    setMetricGauge('extraction_queue_jobs', counts.prioritized || 0, { state: 'prioritized' });
    setMetricGauge('extraction_queue_jobs', counts.delayed || 0, { state: 'delayed' });
  } catch {
    // Readiness/circuit handling owns Redis outage logging.
  }
}

function scheduleQueueMetrics() {
  if (queueMetricsTimer || !ownsQueueMetrics) return;
  void updateQueueMetrics();
  queueMetricsTimer = setInterval(() => void updateQueueMetrics(), QUEUE_METRICS_INTERVAL_MS);
  queueMetricsTimer.unref?.();
}

async function admissionClient() {
  if (!queue) return null;
  return await queue.client as unknown as QueueAdmissionClient;
}

async function releaseAdmission(jobId: string) {
  const client = await admissionClient();
  if (client) await releaseQueueJob(client, 'extraction', jobId);
}

async function pruneStaleJobs(client: QueueAdmissionClient) {
  if (!queue) return 0;
  if (stalePrunePromise !== null) return stalePrunePromise;
  stalePrunePromise = (async () => {
    const jobs = await queue!.getJobs(
      ['waiting', 'prioritized', 'delayed'],
      0,
      EXTRACTION_QUEUE_MAX_JOBS * 2,
    );
    const cutoff = Date.now() - EXTRACTION_QUEUE_JOB_MAX_AGE_MS;
    let removed = 0;
    for (const staleJob of jobs) {
      if (staleJob.timestamp >= cutoff) continue;
      try {
        await staleJob.remove();
        await releaseQueueJob(client, 'extraction', String(staleJob.id));
        removed++;
      } catch {
        // A worker may have claimed it between listing and removal.
      }
    }
    if (removed > 0) incrementMetric('extraction_queue_stale_jobs_total', {}, removed);
    return removed;
  })().finally(() => { stalePrunePromise = null; });
  return stalePrunePromise;
}

async function initQueue() {
  const queueRedisUrl = process.env.QUEUE_REDIS_URL || process.env.REDIS_URL;
  if (!queueRedisUrl) return false;
  let candidateQueue: Queue | null = null;
  let candidateEvents: QueueEvents | null = null;
  try {
    const { default: _Redis } = await import('ioredis');
    const url = new URL(queueRedisUrl);
    connection = {
      host: url.hostname,
      port: parseInt(url.port, 10) || 6379,
      password: url.password || undefined,
      username: url.username || undefined,
      db: url.pathname ? parseInt(url.pathname.slice(1), 10) || 0 : 0,
      maxRetriesPerRequest: null,
      enableOfflineQueue: false,
      connectTimeout: QUEUE_CONNECT_TIMEOUT_MS,
      retryStrategy(times) {
        return times <= 2 ? Math.min(times * 200, 500) : null;
      },
    };
    candidateQueue = new Queue('extraction', { connection });
    candidateEvents = new QueueEvents('extraction', { connection });
    const handleConnectionError = (err: Error) => {
      queueCircuitUntil = Date.now() + 5000;
      // Readiness failure is reported once by the catch below. After startup,
      // keep both BullMQ emitters observed so a Redis outage cannot become an
      // unhandled EventEmitter error in the web process.
      if (queueReady) console.warn('[extraction-queue] Redis connection error:', err.message);
    };
    candidateQueue.on('error', handleConnectionError);
    candidateEvents.on('error', handleConnectionError);
    await withDeadline(
      Promise.all([candidateQueue.waitUntilReady(), candidateEvents.waitUntilReady()]),
      QUEUE_CONNECT_TIMEOUT_MS,
      'BullMQ connection',
    );
    queue = candidateQueue;
    queueEvents = candidateEvents;
    queueReady = true;
    setMetricGauge('extraction_queue_ready', 1);
    scheduleQueueMetrics();
    console.log('[extraction-queue] Queue initialized');
    return true;
  } catch (err) {
    console.warn('[extraction-queue] Queue unavailable:', err.message);
    // A readiness timeout does not cancel BullMQ's connection attempts. Tear
    // down the unpublished clients so an unavailable Redis cannot leave retry
    // sockets and timers behind in every web worker.
    await Promise.allSettled([
      candidateQueue?.disconnect(),
      candidateEvents?.disconnect(),
    ]);
    queue = null;
    queueEvents = null;
    queueReady = false;
    setMetricGauge('extraction_queue_ready', 0);
    return false;
  }
}

async function enqueueExtraction(videoId, timeoutMs) {
  if (!hasQueue()) return null; // No healthy queue -> caller should extract in-process

  const options = typeof timeoutMs === 'object' && timeoutMs !== null
    ? timeoutMs
    : { timeoutMs };
  const priorityName = options.priority === 'prefetch' || options.priority === 'background'
    ? 'background'
    : 'playback';
  const priority = priorityName === 'playback' ? 1 : 10;
  const jobId = `extract:${videoId}`;

  let job;
  let admissionStatus: 'reserved' | 'joined' | null = null;
  try {
    const client = await withDeadline(admissionClient(), QUEUE_OPERATION_TIMEOUT_MS, 'BullMQ admission client');
    if (!client) throw new Error('BullMQ admission client unavailable');
    const admissionOptions = {
      namespace: 'extraction',
      jobId,
      maxJobs: EXTRACTION_QUEUE_MAX_JOBS,
      leaseMs: EXTRACTION_QUEUE_ADMISSION_LEASE_MS,
      background: priorityName === 'background',
      maxBackgroundJobs: EXTRACTION_QUEUE_MAX_BACKGROUND,
    };
    let admission = await withDeadline(
      reserveQueueJob(client, admissionOptions),
      QUEUE_OPERATION_TIMEOUT_MS,
      'BullMQ admission',
    );
    if (admission.status !== 'reserved' && admission.status !== 'joined') {
      const removed = await withDeadline(
        pruneStaleJobs(client),
        QUEUE_OPERATION_TIMEOUT_MS * 2,
        'BullMQ stale prune',
      ).catch(() => 0);
      if (removed > 0) {
        admission = await withDeadline(
          reserveQueueJob(client, admissionOptions),
          QUEUE_OPERATION_TIMEOUT_MS,
          'BullMQ admission retry',
        );
      }
    }
    setMetricGauge('extraction_queue_admitted_jobs', admission.total);
    setMetricGauge('extraction_queue_admitted_background_jobs', admission.background);
    incrementMetric('extraction_queue_admission_total', {
      priority: priorityName,
      result: admission.status,
    });
    if (admission.status !== 'reserved' && admission.status !== 'joined') {
      return {
        status: 'overloaded',
        reason: admission.status,
        waitMs: 0,
      };
    }
    admissionStatus = admission.status;

    job = await withDeadline(queue.getJob(jobId), QUEUE_OPERATION_TIMEOUT_MS, 'BullMQ getJob');
    if (!job) {
      try {
        job = await withDeadline(queue.add('extract', { videoId, priority: priorityName }, {
          jobId, // dedup by videoId
          priority,
          removeOnComplete: { age: 300 }, // keep results 5 min
          removeOnFail: { age: 60 },
          attempts: 1,
        }), QUEUE_OPERATION_TIMEOUT_MS, 'BullMQ add');
      } catch (error) {
        // Another producer can win the add after both reserve the same job ID.
        // Join that job; otherwise release our unused reservation immediately.
        job = await withDeadline(queue.getJob(jobId), QUEUE_OPERATION_TIMEOUT_MS, 'BullMQ add race lookup')
          .catch(() => undefined);
        if (!job && admissionStatus === 'reserved') {
          const keys = queueAdmissionKeys('extraction');
          await Promise.all([
            client.zrem(keys.global, jobId),
            client.zrem(keys.background, jobId),
          ]).catch(() => {});
        }
        if (!job) throw error;
      }
    } else if (priorityName === 'playback') {
      // Promote an existing speculative job when the user actually clicks it.
      // changePriority is harmlessly rejected once a job is already active.
      await withDeadline(Promise.all([
        job.changePriority({ priority }).catch(() => {}),
        job.updateData({ ...job.data, priority: 'playback' }).catch(() => {}),
      ]), QUEUE_OPERATION_TIMEOUT_MS, 'BullMQ promote');
      const keys = queueAdmissionKeys('extraction');
      await client.zrem(keys.background, jobId).catch(() => {});
    }
  } catch (err) {
    tripQueueCircuit(err);
    return null;
  }

  // Wait for result with timeout
  const startedAt = Date.now();
  const waitTimeoutMs = options.timeoutMs || 90000;
  try {
    const result = await withDeadline(
      job.waitUntilFinished(queueEvents, waitTimeoutMs),
      waitTimeoutMs + QUEUE_OPERATION_TIMEOUT_MS,
      'BullMQ wait',
    );
    await releaseAdmission(jobId).catch(() => {});
    return { status: 'completed', result, waitMs: Date.now() - startedAt };
  } catch (err) {
    const state = await withDeadline(job.getState(), QUEUE_OPERATION_TIMEOUT_MS, 'BullMQ getState')
      .catch(() => 'unknown');
    if (state === 'completed') {
      const refreshed = await withDeadline<{ returnvalue?: unknown } | null>(
        queue.getJob(jobId),
        QUEUE_OPERATION_TIMEOUT_MS,
        'BullMQ refresh',
      ).catch(() => null);
      await releaseAdmission(jobId).catch(() => {});
      return { status: 'completed', result: refreshed?.returnvalue, waitMs: Date.now() - startedAt };
    }
    if (state === 'failed') {
      await releaseAdmission(jobId).catch(() => {});
      console.warn(`[extraction-queue] Job ${videoId} failed:`, err.message);
      return { status: 'failed', error: err.message, waitMs: Date.now() - startedAt };
    }
    console.warn(`[extraction-queue] Job ${videoId} still ${state} after wait deadline`);
    return { status: 'pending', waitMs: Date.now() - startedAt };
  }
}

async function promoteExtraction(videoId) {
  if (!hasQueue()) return false;
  try {
    const job = await withDeadline<Job | undefined>(
      queue.getJob(`extract:${videoId}`),
      QUEUE_OPERATION_TIMEOUT_MS,
      'BullMQ promote getJob',
    );
    if (!job) return false;
    await withDeadline(
      Promise.all([
        job.changePriority({ priority: 1 }).catch(() => {}),
        job.updateData({ ...job.data, priority: 'playback' }).catch(() => {}),
      ]),
      QUEUE_OPERATION_TIMEOUT_MS,
      'BullMQ promote',
    );
    const client = await admissionClient();
    const keys = queueAdmissionKeys('extraction');
    await client?.zrem(keys.background, `extract:${videoId}`).catch(() => {});
    return true;
  } catch {
    return false;
  }
}

function hasQueue() { return queue !== null && queueEvents !== null && queueReady && Date.now() >= queueCircuitUntil; }

export { initQueue, enqueueExtraction, promoteExtraction, hasQueue };
