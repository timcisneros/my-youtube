import { Worker } from 'node:worker_threads';
import type { CursorPageResult, ExploreCandidateSignals, ExploreUserSignals, PageResult, RSSVideoRow, TodayVideoRow } from '../types.js';
import type { ExploreCandidateSignalArgs } from './explore-candidate-signals.js';
import type { SQLiteExploreRssSnapshotArgs } from './explore-rss-snapshot.js';
import { insertPriorityItem } from './ordered-priority-queue.js';
import { incrementMetric, observeMetric, setMetricGauge } from './performance-metrics.js';
import type { SQLiteRssVideoCursorPageQueryArgs, SQLiteRssVideoPageQueryArgs, SQLiteRssVideoQueryArgs } from './sqlite-rss-videos.js';

interface ExploreUserSignalArgs {
  userId: string;
  relevantVideoIds: string[];
  relevantChannelIds: string[];
  maxAgeDays: number;
}

type WorkerRequest =
  | { operation: 'candidate-signals'; args: ExploreCandidateSignalArgs }
  | { operation: 'user-signals'; args: ExploreUserSignalArgs }
  | { operation: 'explore-rss-snapshot'; args: SQLiteExploreRssSnapshotArgs }
  | { operation: 'rss-videos'; args: SQLiteRssVideoQueryArgs }
  | { operation: 'rss-video-page'; args: SQLiteRssVideoPageQueryArgs }
  | { operation: 'rss-video-cursor-page'; args: SQLiteRssVideoCursorPageQueryArgs };

type SQLiteReadFailure = 'unavailable' | 'overloaded' | 'timeout' | 'error';
type SQLiteReadResult<TResult> =
  | { status: 'success'; value: TResult }
  | { status: SQLiteReadFailure };

interface QueuedRequest {
  id: number;
  request: WorkerRequest;
  priority: number;
  order: number;
  enqueuedAt: number;
  deadline: number;
  startedAt: number;
  settled: boolean;
  resolve: (value: SQLiteReadResult<unknown>) => void;
  timer: ReturnType<typeof setTimeout>;
}

const OPERATION_PRIORITY: Record<WorkerRequest['operation'], number> = {
  // Today is the app's primary landing page. Explore's user-specific signal
  // read precedes its candidate enrichment read, so preserve that order too.
  'rss-videos': 1,
  'rss-video-page': 1,
  'rss-video-cursor-page': 1,
  'explore-rss-snapshot': 2,
  'user-signals': 3,
  'candidate-signals': 4,
};

function createSqliteReadWorker(databasePath: string) {
  if (process.env.SQLITE_EXPLORE_WORKER === '0') return null;
  const workerUrl = import.meta.url.endsWith('.ts')
    ? new URL('./sqlite-explore-worker.ts', import.meta.url)
    : new URL('./sqlite-explore-worker.js', import.meta.url);
  const maxPending = Math.max(4, Number(process.env.SQLITE_EXPLORE_WORKER_MAX_PENDING) || 64);
  const timeoutMs = Math.max(250, Number(process.env.SQLITE_EXPLORE_WORKER_TIMEOUT_MS) || 5_000);
  let sequence = 0;
  let queueOrder = 0;
  let available = true;
  let active: QueuedRequest | null = null;
  const queue: QueuedRequest[] = [];
  const worker = new Worker(workerUrl, { workerData: { databasePath } });

  const updateMetrics = () => {
    setMetricGauge('sqlite_read_queue_depth', queue.length);
    setMetricGauge('sqlite_read_active', active ? 1 : 0);
    setMetricGauge('sqlite_read_pending', queue.length + (active ? 1 : 0));
  };

  const settle = (task: QueuedRequest, result: SQLiteReadResult<unknown>) => {
    if (task.settled) return;
    task.settled = true;
    clearTimeout(task.timer);
    incrementMetric('sqlite_read_requests_total', {
      operation: task.request.operation,
      result: result.status,
    });
    task.resolve(result);
  };

  const failPending = (reason: SQLiteReadFailure = 'unavailable') => {
    available = false;
    if (active) settle(active, { status: reason });
    for (const request of queue) settle(request, { status: reason });
    active = null;
    queue.length = 0;
    updateMetrics();
    worker.unref();
  };

  const dispatchNext = () => {
    if (!available || active) return;
    let task = queue.shift();
    while (task?.settled) task = queue.shift();
    if (!task) {
      updateMetrics();
      worker.unref();
      return;
    }
    if (Date.now() >= task.deadline) {
      settle(task, { status: 'timeout' });
      dispatchNext();
      return;
    }

    active = task;
    task.startedAt = Date.now();
    observeMetric('sqlite_read_queue_wait_ms', task.startedAt - task.enqueuedAt, {
      operation: task.request.operation,
    });
    updateMetrics();
    try {
      worker.postMessage({ id: task.id, deadline: task.deadline, ...task.request });
    } catch {
      failPending('unavailable');
    }
  };

  worker.on('error', (error) => {
    console.warn('[sqlite-read-worker] unavailable; heavy SQLite reads will degrade:', error.message);
    failPending();
  });
  worker.on('exit', (code) => {
    if (code !== 0 && available) console.warn(`[sqlite-read-worker] exited with code ${code}`);
    failPending();
  });
  worker.on('message', (message: { id: number; result?: unknown; error?: string; expired?: boolean }) => {
    const task = active;
    if (!task || task.id !== message.id) return;
    active = null;
    if (!task.settled) {
      observeMetric('sqlite_read_duration_ms', Date.now() - task.startedAt, {
        operation: task.request.operation,
      });
      if (message.expired) settle(task, { status: 'timeout' });
      else if (message.error) {
        console.warn('[sqlite-read-worker] query failed; serving a degraded result:', message.error);
        settle(task, { status: 'error' });
      } else {
        settle(task, { status: 'success', value: message.result });
      }
    }
    updateMetrics();
    dispatchNext();
  });
  // Event listeners ref the underlying MessagePort; unref after installing them
  // so this optimization cannot keep short-lived scripts or graceful shutdowns alive.
  worker.unref();
  updateMetrics();

  function query<TResult>(request: WorkerRequest): Promise<SQLiteReadResult<TResult>> {
    if (!available) {
      incrementMetric('sqlite_read_requests_total', {
        operation: request.operation,
        result: 'unavailable',
      });
      return Promise.resolve({ status: 'unavailable' });
    }
    if (queue.length + (active ? 1 : 0) >= maxPending) {
      incrementMetric('sqlite_read_requests_total', {
        operation: request.operation,
        result: 'overloaded',
      });
      return Promise.resolve({ status: 'overloaded' });
    }

    const id = ++sequence;
    const enqueuedAt = Date.now();
    return new Promise(resolve => {
      const task: QueuedRequest = {
        id,
        request,
        priority: OPERATION_PRIORITY[request.operation],
        order: queueOrder++,
        enqueuedAt,
        deadline: enqueuedAt + timeoutMs,
        startedAt: 0,
        settled: false,
        resolve: resolve as (value: SQLiteReadResult<unknown>) => void,
        timer: setTimeout(() => {}, 0),
      };
      clearTimeout(task.timer);
      task.timer = setTimeout(() => {
        if (task === active) {
          // better-sqlite3 cannot interrupt this synchronous statement safely.
          // Resolve the caller, but keep the worker occupied until it reports
          // completion so another query is never run concurrently by accident.
          settle(task, { status: 'timeout' });
        } else {
          const index = queue.indexOf(task);
          if (index !== -1) queue.splice(index, 1);
          settle(task, { status: 'timeout' });
        }
        updateMetrics();
      }, timeoutMs);
      task.timer.unref?.();
      insertPriorityItem(queue, task);
      worker.ref();
      updateMetrics();
      dispatchNext();
    }) as Promise<SQLiteReadResult<TResult>>;
  }

  return {
    queryCandidateSignals(args: ExploreCandidateSignalArgs) {
      return query<ExploreCandidateSignals>({ operation: 'candidate-signals', args });
    },
    queryUserSignals(args: ExploreUserSignalArgs) {
      return query<ExploreUserSignals>({ operation: 'user-signals', args });
    },
    queryExploreRssSnapshot(args: SQLiteExploreRssSnapshotArgs) {
      return query<{ videos: RSSVideoRow[]; channelStats: import('../types.js').RSSChannelStatsRow[] }>({
        operation: 'explore-rss-snapshot',
        args,
      });
    },
    queryRssVideos(args: SQLiteRssVideoQueryArgs) {
      return query<RSSVideoRow[]>({ operation: 'rss-videos', args });
    },
    queryRssVideoPage(args: SQLiteRssVideoPageQueryArgs) {
      return query<PageResult<TodayVideoRow>>({ operation: 'rss-video-page', args });
    },
    queryRssVideoCursorPage(args: SQLiteRssVideoCursorPageQueryArgs) {
      return query<CursorPageResult<TodayVideoRow>>({ operation: 'rss-video-cursor-page', args });
    },
    async close() {
      if (!available) return;
      failPending();
      await worker.terminate();
    },
  };
}

export { createSqliteReadWorker };
export type { ExploreUserSignalArgs, SQLiteReadResult };
