import cluster from 'node:cluster';
import os from 'node:os';
import { fork as forkProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

type MetricsCollection = {
  requesters: Array<{ worker: import('node:cluster').Worker; requestId: string }>;
  expectedWorkerIds: Set<number>;
  bodies: string[];
  timer: NodeJS.Timeout;
};

const availableCpuCount = typeof os.availableParallelism === 'function'
  ? os.availableParallelism()
  : os.cpus().length;
const configuredWorkerCount = Number(process.env.WEB_CONCURRENCY || process.env.WORKER_COUNT);
const WORKER_COUNT = Math.max(1, Math.min(16,
  Number.isFinite(configuredWorkerCount) && configuredWorkerCount > 0
    ? Math.floor(configuredWorkerCount)
    : Math.min(availableCpuCount, 4),
));
const METRICS_COLLECTION_TIMEOUT_MS = Math.max(100, Number(process.env.CLUSTER_METRICS_TIMEOUT_MS) || 1_000);
const METRICS_SNAPSHOT_TTL_MS = Math.max(250, Number(process.env.METRICS_SNAPSHOT_TTL_MS) || 1_000);

if (cluster.isPrimary) {
  const metricsCollections = new Map<string, MetricsCollection>();
  const workerSlots = new Map<number, number>();
  let activeMetricsCollectionId: string | null = null;
  let cachedMetricsBody: { body: string; expiresAt: number } | null = null;
  console.log(`Primary ${process.pid} starting ${WORKER_COUNT} workers`);

  async function runMigrationsOnce() {
    if (process.env.SKIP_DATABASE_MIGRATIONS === '1') return;
    const migrationEntry = fileURLToPath(import.meta.url.endsWith('.ts')
      ? new URL('./migrate.ts', import.meta.url)
      : new URL('./migrate.js', import.meta.url));
    await new Promise<void>((resolve, reject) => {
      const child = forkProcess(migrationEntry, [], {
        env: process.env,
        execArgv: process.execArgv,
        stdio: 'inherit',
      });
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        if (code === 0) resolve();
        else reject(new Error(`Database migration process failed (code=${code}, signal=${signal})`));
      });
    });
  }

  function finishMetricsCollection(requestId: string) {
    const collection = metricsCollections.get(requestId);
    if (!collection) return;
    metricsCollections.delete(requestId);
    if (activeMetricsCollectionId === requestId) activeMetricsCollectionId = null;
    clearTimeout(collection.timer);
    const body = collection.bodies.join('');
    cachedMetricsBody = { body, expiresAt: Date.now() + METRICS_SNAPSHOT_TTL_MS };
    for (const requester of collection.requesters) {
      if (!requester.worker.isConnected()) continue;
      requester.worker.send({
        type: 'performance-metrics-collection',
        requestId: requester.requestId,
        bodies: [body],
      });
    }
  }

  function attachWorker(worker: import('node:cluster').Worker) {
    worker.on('message', (rawMessage: unknown) => {
      const message = rawMessage as { type?: string; requestId?: string; body?: string };
      if (!message?.requestId) return;
      if (message.type === 'performance-metrics-collect') {
        if (cachedMetricsBody && cachedMetricsBody.expiresAt > Date.now()) {
          worker.send({
            type: 'performance-metrics-collection',
            requestId: message.requestId,
            bodies: [cachedMetricsBody.body],
          });
          return;
        }
        if (activeMetricsCollectionId) {
          const active = metricsCollections.get(activeMetricsCollectionId);
          if (active) {
            active.requesters.push({ worker, requestId: message.requestId });
            return;
          }
          activeMetricsCollectionId = null;
        }
        const workers = Object.values(cluster.workers || {}).filter((entry): entry is import('node:cluster').Worker => Boolean(entry?.isConnected()));
        const timer = setTimeout(() => finishMetricsCollection(message.requestId!), METRICS_COLLECTION_TIMEOUT_MS);
        timer.unref?.();
        activeMetricsCollectionId = message.requestId;
        metricsCollections.set(message.requestId, {
          requesters: [{ worker, requestId: message.requestId }],
          expectedWorkerIds: new Set(workers.map((entry) => entry.id)),
          bodies: [],
          timer,
        });
        for (const target of workers) {
          target.send({ type: 'performance-metrics-snapshot-request', requestId: message.requestId });
        }
        if (!workers.length) finishMetricsCollection(message.requestId);
        return;
      }
      if (message.type !== 'performance-metrics-snapshot') return;
      const collection = metricsCollections.get(message.requestId);
      if (!collection || !collection.expectedWorkerIds.delete(worker.id)) return;
      if (typeof message.body === 'string') collection.bodies.push(message.body);
      if (!collection.expectedWorkerIds.size) finishMetricsCollection(message.requestId);
    });
  }

  function forkWorker(slot: number) {
    const worker = cluster.fork({
      CLUSTER_WORKER_COUNT: String(WORKER_COUNT),
      CLUSTER_WORKER_SLOT: String(slot),
    });
    workerSlots.set(worker.id, slot);
    attachWorker(worker);
    return worker;
  }

  await runMigrationsOnce();
  // The schema is ready now; every current and replacement worker can skip
  // DDL and start serving without contending on migration locks.
  process.env.SKIP_DATABASE_MIGRATIONS = '1';
  for (let i = 0; i < WORKER_COUNT; i++) {
    forkWorker(i);
  }

  cluster.on('exit', (worker, code, signal) => {
    const slot = workerSlots.get(worker.id) ?? 0;
    workerSlots.delete(worker.id);
    for (const [requestId, collection] of metricsCollections) {
      collection.requesters = collection.requesters.filter(requester => requester.worker.id !== worker.id);
      collection.expectedWorkerIds.delete(worker.id);
      if (!collection.expectedWorkerIds.size) finishMetricsCollection(requestId);
    }
    console.error(`Worker ${worker.process.pid} exited (code=${code}, signal=${signal}) — restarting`);
    forkWorker(slot);
  });
} else {
  await import('./server.js');
}
