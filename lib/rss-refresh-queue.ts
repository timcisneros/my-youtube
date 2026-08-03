/**
 * Durable RSS refresh producer.
 *
 * Web workers enqueue one job per channel/freshness window. The extraction
 * worker service consumes the separate `rss-refresh` queue so a Today request
 * never owns hundreds of outbound feed requests itself.
 */
import { Queue, QueueEvents, type Job } from 'bullmq';
import { incrementMetric, observeMetric, setMetricGauge } from './performance-metrics.js';
import LRUMap from './lru-map.js';

type RssRefreshPriority = 'interactive' | 'background';
type RssRefreshEnqueueResult = 'completed' | 'queued' | 'failed' | null;
type RssRefreshBatchCandidate = { channelId: string; freshnessAt?: number };
type JobCompletionStatus = 'completed' | 'failed';
type JobWaitStatus = JobCompletionStatus | 'timeout';
type PreparedJobWaiter = {
  promise: Promise<JobWaitStatus>;
  complete: (status: JobWaitStatus) => void;
  cancel: () => void;
};

let queue: Queue | null = null;
let queueEvents: QueueEvents | null = null;
let queueReady = false;
let queueCircuitUntil = 0;
let queueMetricsTimer: ReturnType<typeof setTimeout> | null = null;
let queueMetricsInflight: Promise<void> | null = null;
const jobWaiters = new Map<string, Set<(status: JobCompletionStatus) => void>>();
const recentJobResults = new LRUMap<string, { status: JobCompletionStatus; expiresAt: number }>(5000);

const QUEUE_CONNECT_TIMEOUT_MS = Math.max(500, Number(process.env.REDIS_CONNECT_TIMEOUT_MS) || 2_500);
const QUEUE_OPERATION_TIMEOUT_MS = Math.max(250, Number(process.env.REDIS_OPERATION_TIMEOUT_MS) || 2_000);
const RSS_QUEUE_WAIT_TIMEOUT_MS = Math.max(5_000, Number(process.env.RSS_QUEUE_WAIT_TIMEOUT_MS) || 25_000);
const RSS_QUEUE_BATCH_WAIT_TIMEOUT_MS = Math.max(
  RSS_QUEUE_WAIT_TIMEOUT_MS,
  Number(process.env.RSS_QUEUE_BATCH_WAIT_TIMEOUT_MS) || 180_000,
);
const RSS_REFRESH_DEDUPE_MS = Math.max(60_000, Number(process.env.RSS_REFRESH_DEDUPE_MS) || 15 * 60_000);
const RSS_REFRESH_JITTER_MS = Math.max(0, Number(process.env.RSS_REFRESH_JITTER_MS) || 5_000);

function queueEnabled() {
  const value = String(process.env.RSS_REFRESH_QUEUE_ENABLED || '').toLowerCase();
  return value === '1' || value === 'true';
}

function queueConnection(urlValue: string) {
  const url = new URL(urlValue);
  return {
    host: url.hostname,
    port: parseInt(url.port, 10) || 6379,
    password: url.password || undefined,
    username: url.username || undefined,
    db: url.pathname ? parseInt(url.pathname.slice(1), 10) || 0 : 0,
    maxRetriesPerRequest: null,
    enableOfflineQueue: false,
    connectTimeout: QUEUE_CONNECT_TIMEOUT_MS,
    retryStrategy(times: number) {
      return times <= 2 ? Math.min(times * 200, 500) : null;
    },
  };
}

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

function markQueueUnavailable(error: unknown) {
  queueCircuitUntil = Date.now() + 5_000;
  setMetricGauge('rss_queue_ready', 0);
  incrementMetric('rss_queue_operations_total', { result: 'error' });
  console.warn('[rss-refresh-queue] Producer unavailable, using local fallback:', (error as Error).message);
}

async function updateQueueDepthMetrics() {
  if (!queue || !queueReady) return;
  try {
    const counts = await withDeadline(
      queue.getJobCounts('waiting', 'prioritized', 'delayed', 'active'),
      QUEUE_OPERATION_TIMEOUT_MS,
      'RSS queue counts',
    );
    const waiting = (counts.waiting || 0) + (counts.prioritized || 0) + (counts.delayed || 0);
    setMetricGauge('rss_queue_waiting_jobs', waiting);
    setMetricGauge('rss_queue_active_jobs', counts.active || 0);
  } catch {
    // Queue depth is diagnostic; enqueueing remains available when this probe
    // times out so a metrics failure cannot force duplicate local refreshes.
  }
}

function scheduleQueueDepthMetrics(delayMs = 100) {
  if (queueMetricsTimer || queueMetricsInflight !== null) return;
  queueMetricsTimer = setTimeout(() => {
    queueMetricsTimer = null;
    queueMetricsInflight = updateQueueDepthMetrics().finally(() => {
      queueMetricsInflight = null;
    });
  }, delayMs);
  queueMetricsTimer.unref?.();
}

function recordJobResult(jobId: string, status: JobCompletionStatus) {
  recentJobResults.set(jobId, { status, expiresAt: Date.now() + RSS_REFRESH_DEDUPE_MS });
  const waiters = jobWaiters.get(jobId);
  if (waiters) {
    jobWaiters.delete(jobId);
    for (const resolve of waiters) resolve(status);
  }
  setMetricGauge('rss_queue_local_waiters', jobWaiters.size);
}

function recentJobResult(jobId: string) {
  const recent = recentJobResults.get(jobId);
  if (!recent) return null;
  if (recent.expiresAt <= Date.now()) {
    recentJobResults.delete(jobId);
    return null;
  }
  return recent.status;
}

function prepareJobWaiter(jobId: string, timeoutMs = RSS_QUEUE_WAIT_TIMEOUT_MS): PreparedJobWaiter {
  let completeWaiter: (status: JobWaitStatus) => void = () => {};
  let cancelWaiter = () => {};
  const promise = new Promise<JobWaitStatus>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const complete = (status: JobWaitStatus) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const waiters = jobWaiters.get(jobId);
      waiters?.delete(onQueueResult);
      if (waiters?.size === 0) jobWaiters.delete(jobId);
      setMetricGauge('rss_queue_local_waiters', jobWaiters.size);
      resolve(status);
    };
    const onQueueResult = (status: JobCompletionStatus) => complete(status);
    completeWaiter = complete;
    cancelWaiter = () => complete('timeout');

    const recent = recentJobResult(jobId);
    if (recent) {
      complete(recent);
      return;
    }
    let waiters = jobWaiters.get(jobId);
    if (!waiters) {
      waiters = new Set();
      jobWaiters.set(jobId, waiters);
    }
    waiters.add(onQueueResult);
    setMetricGauge('rss_queue_local_waiters', jobWaiters.size);
    timer = setTimeout(() => complete('timeout'), timeoutMs);
    timer.unref?.();
  });
  return { promise, complete: completeWaiter, cancel: cancelWaiter };
}

function completedJobStatus(job: Job): JobCompletionStatus | null {
  if (!job.finishedOn) return null;
  return job.failedReason ? 'failed' : 'completed';
}

async function initRssRefreshQueue() {
  const redisUrl = process.env.QUEUE_REDIS_URL || process.env.REDIS_URL;
  if (!queueEnabled() || !redisUrl) {
    setMetricGauge('rss_queue_ready', 0);
    return false;
  }
  if (queueReady && queue && queueEvents) return true;

  let candidateQueue: Queue | null = null;
  let candidateEvents: QueueEvents | null = null;
  try {
    const connection = queueConnection(redisUrl);
    candidateQueue = new Queue('rss-refresh', { connection });
    candidateEvents = new QueueEvents('rss-refresh', { connection });
    const handleError = (error: Error) => {
      if (queueReady) markQueueUnavailable(error);
    };
    candidateQueue.on('error', handleError);
    candidateEvents.on('error', handleError);
    candidateEvents.on('completed', ({ jobId }) => recordJobResult(jobId, 'completed'));
    candidateEvents.on('failed', ({ jobId }) => recordJobResult(jobId, 'failed'));
    await withDeadline(
      Promise.all([candidateQueue.waitUntilReady(), candidateEvents.waitUntilReady()]),
      QUEUE_CONNECT_TIMEOUT_MS,
      'RSS BullMQ connection',
    );
    queue = candidateQueue;
    queueEvents = candidateEvents;
    queueReady = true;
    queueCircuitUntil = 0;
    setMetricGauge('rss_queue_ready', 1);
    scheduleQueueDepthMetrics(0);
    return true;
  } catch (error) {
    await Promise.allSettled([candidateQueue?.disconnect(), candidateEvents?.disconnect()]);
    queue = null;
    queueEvents = null;
    queueReady = false;
    markQueueUnavailable(error);
    return false;
  }
}

function hasRssRefreshQueue() {
  const available = queue !== null && queueEvents !== null && queueReady && Date.now() >= queueCircuitUntil;
  if (available) setMetricGauge('rss_queue_ready', 1);
  return available;
}

function freshnessJobId(channelId: string, freshnessAt = Date.now()) {
  const bucket = Math.floor(freshnessAt / RSS_REFRESH_DEDUPE_MS);
  return `rss-${channelId}-${bucket}`;
}

function refreshJobDefinition(
  candidate: RssRefreshBatchCandidate,
  priorityName: RssRefreshPriority,
) {
  return {
    name: 'refresh-channel',
    data: { channelId: candidate.channelId },
    opts: {
      jobId: freshnessJobId(candidate.channelId, candidate.freshnessAt),
      priority: priorityName === 'interactive' ? 1 : 10,
      delay: priorityName === 'background' ? Math.floor(Math.random() * RSS_REFRESH_JITTER_MS) : 0,
      attempts: 2,
      backoff: { type: 'exponential', delay: 1_000 },
      removeOnComplete: { age: Math.ceil(RSS_REFRESH_DEDUPE_MS / 1_000) },
      removeOnFail: { age: 300 },
    },
  };
}

async function enqueueRssRefresh(
  channelId: string,
  options: { priority?: RssRefreshPriority; waitForRefresh?: boolean; freshnessAt?: number } = {},
): Promise<RssRefreshEnqueueResult> {
  if (!hasRssRefreshQueue() || !queue || !queueEvents) return null;
  const priorityName = options.priority || 'background';
  const enqueueStartedAt = Date.now();
  const definition = refreshJobDefinition({ channelId, freshnessAt: options.freshnessAt }, priorityName);
  const waiter = options.waitForRefresh
    ? prepareJobWaiter(String(definition.opts.jobId), RSS_QUEUE_WAIT_TIMEOUT_MS)
    : null;
  let job: Job;
  try {
    job = await withDeadline(
      queue.add(definition.name, definition.data, definition.opts),
      QUEUE_OPERATION_TIMEOUT_MS,
      'RSS queue add',
    );
    incrementMetric('rss_queue_operations_total', { result: 'enqueued', priority: priorityName });
    observeMetric('rss_queue_enqueue_duration_ms', Date.now() - enqueueStartedAt, { priority: priorityName });
    scheduleQueueDepthMetrics();
  } catch (error) {
    waiter?.cancel();
    markQueueUnavailable(error);
    return null;
  }

  if (!options.waitForRefresh) return 'queued';
  const knownStatus = completedJobStatus(job);
  if (knownStatus) waiter!.complete(knownStatus);
  const waitStartedAt = Date.now();
  const finishStatus = await waiter!.promise;
  if (finishStatus === 'completed') {
    incrementMetric('rss_queue_operations_total', { result: 'completed', priority: priorityName });
    observeMetric('rss_queue_wait_duration_ms', Date.now() - waitStartedAt, { priority: priorityName });
    scheduleQueueDepthMetrics();
    return 'completed';
  }
  incrementMetric('rss_queue_operations_total', {
    result: finishStatus === 'timeout' ? 'wait_timeout' : 'failed',
    priority: priorityName,
  });
  observeMetric('rss_queue_wait_duration_ms', Date.now() - waitStartedAt, { priority: priorityName });
  return finishStatus === 'timeout' ? 'queued' : 'failed';
}

/**
 * Enqueue an entire Today refresh slice with one Redis transaction. Waiting
 * remains event-driven through the shared QueueEvents listener, so large
 * subscription libraries do not create a listener or Redis add round-trip per
 * channel in the web process.
 */
async function enqueueRssRefreshBatch(
  candidates: RssRefreshBatchCandidate[],
  options: { priority?: RssRefreshPriority; waitForRefresh?: boolean } = {},
): Promise<RssRefreshEnqueueResult> {
  if (candidates.length === 0) return 'completed';
  if (!hasRssRefreshQueue() || !queue || !queueEvents) return null;

  const priorityName = options.priority || 'background';
  const uniqueCandidates = [...new Map(candidates.map(candidate => [candidate.channelId, candidate])).values()];
  const definitions = uniqueCandidates.map(candidate => refreshJobDefinition(candidate, priorityName));
  const waiters = options.waitForRefresh
    ? definitions.map(definition => prepareJobWaiter(String(definition.opts.jobId), RSS_QUEUE_BATCH_WAIT_TIMEOUT_MS))
    : [];
  const enqueueStartedAt = Date.now();
  let jobs: Job[];
  try {
    const operationTimeoutMs = Math.max(
      QUEUE_OPERATION_TIMEOUT_MS,
      Math.min(15_000, 1_000 + uniqueCandidates.length * 25),
    );
    jobs = await withDeadline(
      queue.addBulk(definitions),
      operationTimeoutMs,
      'RSS queue bulk add',
    );
    incrementMetric('rss_queue_operations_total', { result: 'enqueued', priority: priorityName }, jobs.length);
    incrementMetric('rss_queue_batches_total', { result: 'enqueued', priority: priorityName });
    observeMetric('rss_queue_batch_size', jobs.length, { priority: priorityName });
    observeMetric('rss_queue_enqueue_duration_ms', Date.now() - enqueueStartedAt, { priority: priorityName });
    scheduleQueueDepthMetrics();
  } catch (error) {
    for (const waiter of waiters) waiter.cancel();
    markQueueUnavailable(error);
    incrementMetric('rss_queue_batches_total', { result: 'failed', priority: priorityName });
    return null;
  }

  if (!options.waitForRefresh) return 'queued';
  jobs.forEach((job, index) => {
    const knownStatus = completedJobStatus(job);
    if (knownStatus) waiters[index]?.complete(knownStatus);
  });
  const waitStartedAt = Date.now();
  const statuses = await Promise.all(waiters.map(waiter => waiter.promise));
  const completed = statuses.filter(status => status === 'completed').length;
  const failed = statuses.filter(status => status === 'failed').length;
  const timedOut = statuses.length - completed - failed;
  if (completed) incrementMetric('rss_queue_operations_total', { result: 'completed', priority: priorityName }, completed);
  if (failed) incrementMetric('rss_queue_operations_total', { result: 'failed', priority: priorityName }, failed);
  if (timedOut) incrementMetric('rss_queue_operations_total', { result: 'wait_timeout', priority: priorityName }, timedOut);
  observeMetric('rss_queue_batch_wait_duration_ms', Date.now() - waitStartedAt, { priority: priorityName });
  scheduleQueueDepthMetrics();

  const result = timedOut > 0 ? 'queued' : failed > 0 ? 'failed' : 'completed';
  incrementMetric('rss_queue_batches_total', { result, priority: priorityName });
  return result;
}

export {
  enqueueRssRefresh,
  enqueueRssRefreshBatch,
  hasRssRefreshQueue,
  initRssRefreshQueue,
};
export type { RssRefreshBatchCandidate, RssRefreshEnqueueResult };
