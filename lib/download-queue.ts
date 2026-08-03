import { Queue } from 'bullmq';
import { incrementMetric, setMetricGauge } from './performance-metrics.js';
import {
  releaseQueueJob,
  reserveQueueJob,
  type QueueAdmissionClient,
} from './queue-admission.js';

type DownloadJobFormat = {
  formatId: string;
  url: string;
  headers: Record<string, string>;
  expectedBytes?: number;
};

type DownloadJobData = {
  videoId: string;
  formats: DownloadJobFormat[];
  existingBytes?: number;
  ownerId?: string;
};

let queue: Queue<DownloadJobData> | null = null;
let queueReady = false;
let queueCircuitUntil = 0;
const OPERATION_TIMEOUT_MS = Math.max(250, Number(process.env.REDIS_OPERATION_TIMEOUT_MS) || 2000);
const DOWNLOAD_QUEUE_MAX_JOBS = Math.max(1, Number(process.env.DOWNLOAD_QUEUE_MAX_JOBS) || 100);
const DOWNLOAD_QUEUE_MAX_JOBS_PER_OWNER = Math.max(
  1,
  Math.min(DOWNLOAD_QUEUE_MAX_JOBS, Number(process.env.DOWNLOAD_QUEUE_MAX_JOBS_PER_OWNER) || 5),
);
const DOWNLOAD_QUEUE_ADMISSION_LEASE_MS = Math.max(
  60_000,
  Number(process.env.DOWNLOAD_QUEUE_ADMISSION_LEASE_MS) || 2 * 60 * 60_000,
);
const DOWNLOAD_QUEUE_JOB_MAX_AGE_MS = Math.max(
  60_000,
  Number(process.env.DOWNLOAD_QUEUE_JOB_MAX_AGE_MS) || 10 * 60_000,
);
const QUEUE_METRICS_INTERVAL_MS = Math.max(10_000, Number(process.env.QUEUE_METRICS_INTERVAL_MS) || 30_000);
const ownsQueueMetrics = !process.env.CLUSTER_WORKER_COUNT || process.env.CLUSTER_WORKER_SLOT === '0';
let queueMetricsTimer: NodeJS.Timeout | null = null;
let stalePrunePromise: Promise<number> | null = null;

function withDeadline<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
    timer.unref?.();
    promise.then(
      value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); },
    );
  });
}

function queueConnection(urlString: string) {
  const url = new URL(urlString);
  return {
    host: url.hostname,
    port: parseInt(url.port, 10) || 6379,
    password: url.password || undefined,
    username: url.username || undefined,
    db: url.pathname ? parseInt(url.pathname.slice(1), 10) || 0 : 0,
    maxRetriesPerRequest: null,
    enableOfflineQueue: false,
    connectTimeout: Math.max(500, Number(process.env.REDIS_CONNECT_TIMEOUT_MS) || 2500),
    retryStrategy(times: number) {
      return times <= 2 ? Math.min(times * 200, 500) : null;
    },
  };
}

async function updateQueueMetrics() {
  if (!queue || !queueReady) return;
  try {
    const counts = await queue.getJobCounts('active', 'waiting', 'prioritized', 'delayed');
    setMetricGauge('download_queue_jobs', counts.active || 0, { state: 'active' });
    setMetricGauge('download_queue_jobs', counts.waiting || 0, { state: 'waiting' });
    setMetricGauge('download_queue_jobs', counts.prioritized || 0, { state: 'prioritized' });
    setMetricGauge('download_queue_jobs', counts.delayed || 0, { state: 'delayed' });
  } catch {
    // Queue readiness handling reports Redis outages.
  }
}

function scheduleQueueMetrics() {
  if (queueMetricsTimer || !ownsQueueMetrics) return;
  void updateQueueMetrics();
  queueMetricsTimer = setInterval(() => void updateQueueMetrics(), QUEUE_METRICS_INTERVAL_MS);
  queueMetricsTimer.unref?.();
}

async function pruneStaleJobs(client: QueueAdmissionClient) {
  if (!queue) return 0;
  if (stalePrunePromise !== null) return stalePrunePromise;
  stalePrunePromise = (async () => {
    const jobs = await queue!.getJobs(
      ['waiting', 'prioritized', 'delayed'],
      0,
      DOWNLOAD_QUEUE_MAX_JOBS * 2,
    );
    const cutoff = Date.now() - DOWNLOAD_QUEUE_JOB_MAX_AGE_MS;
    let removed = 0;
    for (const staleJob of jobs) {
      if (staleJob.timestamp >= cutoff) continue;
      try {
        await staleJob.remove();
        await releaseQueueJob(
          client,
          'downloads',
          String(staleJob.id),
          staleJob.data.ownerId,
        );
        removed++;
      } catch {
        // A worker may have claimed it between listing and removal.
      }
    }
    if (removed > 0) incrementMetric('download_queue_stale_jobs_total', {}, removed);
    return removed;
  })().finally(() => { stalePrunePromise = null; });
  return stalePrunePromise;
}

async function initDownloadQueue() {
  const redisUrl = process.env.QUEUE_REDIS_URL || process.env.REDIS_URL;
  if (!redisUrl) return false;
  let candidate: Queue<DownloadJobData> | null = null;
  try {
    candidate = new Queue<DownloadJobData>('downloads', { connection: queueConnection(redisUrl) });
    candidate.on('error', error => {
      queueCircuitUntil = Date.now() + 5_000;
      setMetricGauge('download_queue_ready', 0);
      console.warn('[download-queue] Redis error:', error.message);
    });
    await withDeadline(candidate.waitUntilReady(), Math.max(500, Number(process.env.REDIS_CONNECT_TIMEOUT_MS) || 2500), 'Download queue connection');
    queue = candidate;
    queueReady = true;
    setMetricGauge('download_queue_ready', 1);
    scheduleQueueMetrics();
    return true;
  } catch (error) {
    await candidate?.disconnect().catch(() => {});
    queue = null;
    queueReady = false;
    setMetricGauge('download_queue_ready', 0);
    console.warn('[download-queue] Queue unavailable; single-process downloads will use the local fallback:', (error as Error).message);
    return false;
  }
}

function hasDownloadQueue() {
  const healthy = queue !== null && queueReady && Date.now() >= queueCircuitUntil;
  if (healthy) setMetricGauge('download_queue_ready', 1);
  return healthy;
}

function cancelKey(videoId: string) {
  return `download:cancel:${videoId}`;
}

async function enqueueDownload(data: DownloadJobData) {
  if (!hasDownloadQueue() || !queue) return false;
  const coordination = await queue.client.catch(() => null);
  await coordination?.del(cancelKey(data.videoId)).catch(() => {});
  const jobId = `download:${data.videoId}`;
  try {
    const existing = await withDeadline(queue.getJob(jobId), OPERATION_TIMEOUT_MS, 'Download queue lookup');
    if (existing) {
      const state = await withDeadline(existing.getState(), OPERATION_TIMEOUT_MS, 'Download queue state');
      if (state === 'active' || state === 'waiting' || state === 'delayed' || state === 'prioritized') return true;
      await withDeadline(existing.remove(), OPERATION_TIMEOUT_MS, 'Download queue cleanup').catch(() => {});
      if (coordination) {
        await releaseQueueJob(
          coordination as unknown as QueueAdmissionClient,
          'downloads',
          jobId,
          existing.data.ownerId,
        ).catch(() => {});
      }
    }
    if (!coordination) throw new Error('Download queue admission client unavailable');
    const client = coordination as unknown as QueueAdmissionClient;
    const admissionOptions = {
      namespace: 'downloads',
      jobId,
      owner: data.ownerId,
      maxJobs: DOWNLOAD_QUEUE_MAX_JOBS,
      maxOwnerJobs: DOWNLOAD_QUEUE_MAX_JOBS_PER_OWNER,
      leaseMs: DOWNLOAD_QUEUE_ADMISSION_LEASE_MS,
    };
    let admission = await withDeadline(
      reserveQueueJob(client, admissionOptions),
      OPERATION_TIMEOUT_MS,
      'Download queue admission',
    );
    if (admission.status !== 'reserved' && admission.status !== 'joined') {
      const removed = await withDeadline(
        pruneStaleJobs(client),
        OPERATION_TIMEOUT_MS * 2,
        'Download queue stale prune',
      ).catch(() => 0);
      if (removed > 0) {
        admission = await withDeadline(
          reserveQueueJob(client, admissionOptions),
          OPERATION_TIMEOUT_MS,
          'Download queue admission retry',
        );
      }
    }
    setMetricGauge('download_queue_admitted_jobs', admission.total);
    incrementMetric('download_queue_admission_total', { result: admission.status });
    if (admission.status !== 'reserved' && admission.status !== 'joined') {
      return false;
    }
    try {
      await withDeadline(queue.add('download', data, {
        jobId,
        attempts: 1,
        removeOnComplete: { age: 3600 },
        removeOnFail: { age: 3600 },
      }), OPERATION_TIMEOUT_MS, 'Download queue add');
    } catch (error) {
      const raced = await queue.getJob(jobId).catch(() => null);
      if (!raced && admission.status === 'reserved') {
        await releaseQueueJob(
          coordination as unknown as QueueAdmissionClient,
          'downloads',
          jobId,
          data.ownerId,
        ).catch(() => {});
      }
      if (!raced) throw error;
    }
    incrementMetric('download_queue_operations_total', { result: 'enqueued' });
    return true;
  } catch (error) {
    incrementMetric('download_queue_operations_total', { result: 'error' });
    console.warn('[download-queue] enqueue failed:', (error as Error).message);
    return false;
  }
}

async function cancelQueuedDownload(videoId: string) {
  const coordination = queue ? await queue.client.catch(() => null) : null;
  await coordination?.set(cancelKey(videoId), '1', 'EX', 7200).catch(() => {});
  if (!queue) return;
  const job = await queue.getJob(`download:${videoId}`).catch(() => null);
  if (!job) return;
  const state = await job.getState().catch(() => 'unknown');
  if (state !== 'active') {
    await job.remove().catch(() => {});
    if (coordination) {
      await releaseQueueJob(
        coordination as unknown as QueueAdmissionClient,
        'downloads',
        String(job.id || `download:${videoId}`),
        job.data.ownerId,
      ).catch(() => {});
    }
  }
}

export {
  cancelKey,
  cancelQueuedDownload,
  enqueueDownload,
  hasDownloadQueue,
  initDownloadQueue,
};
export type { DownloadJobData, DownloadJobFormat };
