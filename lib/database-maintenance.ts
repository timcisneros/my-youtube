import type { DatabaseAPI } from '../types.js';
import { incrementMetric, observeMetric } from './performance-metrics.js';

const MAINTENANCE_INTERVAL_MS = Math.max(
  5 * 60_000,
  Number(process.env.DATABASE_MAINTENANCE_INTERVAL_MS) || 60 * 60_000,
);
const MAINTENANCE_BATCH_SIZE = Math.min(
  10_000,
  Math.max(100, Number(process.env.DATABASE_MAINTENANCE_BATCH_SIZE) || 1000),
);
const MAINTENANCE_MAX_BATCHES = Math.min(
  100,
  Math.max(1, Number(process.env.DATABASE_MAINTENANCE_MAX_BATCHES) || 10),
);
const MAINTENANCE_INITIAL_DELAY_MS = Math.max(
  5_000,
  Number(process.env.DATABASE_MAINTENANCE_INITIAL_DELAY_MS) || 30_000,
);
const EXPLORE_COWATCH_MAX_AGE_DAYS = Math.min(365, Math.max(7,
  Number(process.env.EXPLORE_COWATCH_MAX_AGE_DAYS) || 90));

let maintenanceStarted = false;
let maintenanceRunning = false;

function yieldToRequests() {
  return new Promise<void>(resolve => setImmediate(resolve));
}

async function pruneInBatches(
  name: string,
  prune: () => Promise<number>,
) {
  const startedAt = Date.now();
  let removed = 0;
  for (let batch = 0; batch < MAINTENANCE_MAX_BATCHES; batch++) {
    const count = Number(await prune()) || 0;
    removed += count;
    if (count < MAINTENANCE_BATCH_SIZE) break;
    await yieldToRequests();
  }
  incrementMetric('database_maintenance_rows_total', { table: name }, removed);
  observeMetric('database_maintenance_duration_ms', Date.now() - startedAt, { table: name });
}

async function runDatabaseMaintenance(db: DatabaseAPI) {
  if (maintenanceRunning) return;
  maintenanceRunning = true;
  try {
    const leaseSeconds = Math.ceil(MAINTENANCE_INTERVAL_MS / 1000);
    if (!await db.claimMaintenanceLease('database-prune-v1', leaseSeconds)) return;
    incrementMetric('database_maintenance_runs_total', { result: 'claimed' });
    await pruneInBatches('related_videos', async () =>
      Number(await db.pruneRelatedVideos(30, MAINTENANCE_BATCH_SIZE)) || 0
    );
    await pruneInBatches('explore_events', async () =>
      Number(await db.pruneExploreEvents(90, MAINTENANCE_BATCH_SIZE)) || 0
    );
    await pruneInBatches('explore_sessions', async () =>
      Number(await db.pruneExploreSessions(90, MAINTENANCE_BATCH_SIZE)) || 0
    );
    await pruneInBatches('explore_cowatch_edges', async () =>
      Number(await db.pruneExploreCowatchEdges(EXPLORE_COWATCH_MAX_AGE_DAYS, MAINTENANCE_BATCH_SIZE)) || 0
    );
    if (db.optimizeDatabase) {
      await yieldToRequests();
      const optimizeStartedAt = Date.now();
      await db.optimizeDatabase();
      observeMetric('database_maintenance_duration_ms', Date.now() - optimizeStartedAt, { table: 'planner' });
    }
    incrementMetric('database_maintenance_runs_total', { result: 'completed' });
  } catch (error) {
    incrementMetric('database_maintenance_runs_total', { result: 'error' });
    console.warn('[database-maintenance] run failed:', (error as Error).message);
  } finally {
    maintenanceRunning = false;
  }
}

function startDatabaseMaintenance(db: DatabaseAPI) {
  if (maintenanceStarted) return;
  maintenanceStarted = true;
  const initialTimer = setTimeout(() => void runDatabaseMaintenance(db), MAINTENANCE_INITIAL_DELAY_MS);
  initialTimer.unref?.();
  const interval = setInterval(() => void runDatabaseMaintenance(db), MAINTENANCE_INTERVAL_MS);
  interval.unref?.();
}

export { runDatabaseMaintenance, startDatabaseMaintenance };
