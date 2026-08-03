import type {
  DatabaseAPI,
  Download,
  LocalPlaylistItem,
  PlayerBootstrapData,
  SavedPlaylist,
  Subscription,
} from './types.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
import { calculateRssChannelStats, rankedRssItems, selectExploreRssCandidates } from './lib/explore-rss-snapshot.js';
import { mapExploreUserSignalRows } from './lib/explore-user-signals.js';
import { incrementMetric, observeMetric, setMetricGauge } from './lib/performance-metrics.js';
import {
  POSTGRES_EXPLORE_CANDIDATE_SIGNALS_SQL,
  POSTGRES_EXPLORE_USER_SIGNALS_SQL,
  POSTGRES_TODAY_COUNT_SQL,
  POSTGRES_TODAY_NEWER_CURSOR_SQL,
  POSTGRES_TODAY_OLDER_CURSOR_SQL,
  POSTGRES_TODAY_PAGE_SQL,
  POSTGRES_TODAY_ROWS_SQL,
} from './lib/postgres-performance-queries.js';

/**
 * PostgreSQL database backend — used when DATABASE_URL is set.
 * Same API as db.js (SQLite) but async with pg Pool.
 *
 * All exported functions are async (return Promises).
 * Fire-and-forget writes work because the Promise is simply ignored.
 * Read calls in async route handlers can be awaited.
 */

import pg, { type PoolClient } from 'pg';
const { Pool } = pg;

const databaseWorkerCount = Math.max(1, Number(process.env.CLUSTER_WORKER_COUNT) || 1);
const defaultDatabasePoolMax = Math.max(2, Math.floor(20 / databaseWorkerCount));
const databasePoolMax = Math.max(2, Number(process.env.DATABASE_POOL_MAX) || defaultDatabasePoolMax);
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Keep the default aggregate connection budget stable when the web process
  // is clustered. DATABASE_POOL_MAX remains an explicit per-worker override.
  max: databasePoolMax,
  connectionTimeoutMillis: Math.max(500, Number(process.env.DATABASE_CONNECT_TIMEOUT_MS) || 3000),
  idleTimeoutMillis: Math.max(1000, Number(process.env.DATABASE_IDLE_TIMEOUT_MS) || 30_000),
  query_timeout: Math.max(1000, Number(process.env.DATABASE_QUERY_TIMEOUT_MS) || 15_000),
  statement_timeout: Math.max(1000, Number(process.env.DATABASE_QUERY_TIMEOUT_MS) || 15_000),
  // Heroku / cloud providers may need SSL
  ssl: process.env.DATABASE_SSL === 'false'
    ? false
    : process.env.DATABASE_URL && process.env.DATABASE_URL.includes('sslmode=')
      ? undefined
      : process.env.DATABASE_URL && (process.env.DATABASE_URL.includes('amazonaws.com') || process.env.DATABASE_URL.includes('neon.tech') || process.env.DATABASE_URL.includes('supabase'))
        ? { rejectUnauthorized: false }
        : undefined,
});
const transactionClients = new AsyncLocalStorage<PoolClient>();

function updateDatabasePoolMetrics() {
  setMetricGauge('database_pool_connections', pool.totalCount, { state: 'total' });
  setMetricGauge('database_pool_connections', pool.idleCount, { state: 'idle' });
  setMetricGauge('database_pool_waiting_requests', pool.waitingCount);
  setMetricGauge('database_pool_connection_limit', databasePoolMax);
}

pool.on('error', (error) => {
  incrementMetric('database_pool_errors_total');
  updateDatabasePoolMetrics();
  console.error('[db-pg] idle client error:', error.message);
});
updateDatabasePoolMetrics();

// ---------- Schema creation ----------

const initSQL = `
  CREATE TABLE IF NOT EXISTS tags (
    id SERIAL PRIMARY KEY,
    user_id TEXT NOT NULL,
    video_id TEXT NOT NULL,
    tag TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, video_id, tag)
  );
  CREATE INDEX IF NOT EXISTS idx_tags_user_video ON tags(user_id, video_id);
  CREATE INDEX IF NOT EXISTS idx_tags_user_tag ON tags(user_id, tag);

  CREATE TABLE IF NOT EXISTS subscriptions (
    user_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    thumbnail TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY(user_id, channel_id)
  );
  CREATE INDEX IF NOT EXISTS idx_subs_user ON subscriptions(user_id);
  CREATE INDEX IF NOT EXISTS idx_subs_channel ON subscriptions(channel_id);
  CREATE INDEX IF NOT EXISTS idx_subs_user_title ON subscriptions(user_id, title COLLATE "C");

  CREATE TABLE IF NOT EXISTS downloads (
    video_id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '',
    channel_title TEXT NOT NULL DEFAULT '',
    thumbnail TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'downloading',
    total_bytes BIGINT NOT NULL DEFAULT 0,
    downloaded_bytes BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_downloads_created ON downloads(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_downloads_created_video ON downloads(created_at DESC, video_id);

  CREATE TABLE IF NOT EXISTS download_storage_usage (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    stored_bytes BIGINT NOT NULL DEFAULT 0,
    mutation_version BIGINT NOT NULL DEFAULT 0
  );
  INSERT INTO download_storage_usage (singleton, stored_bytes, mutation_version)
    VALUES (1, 0, 0) ON CONFLICT (singleton) DO NOTHING;

  CREATE TABLE IF NOT EXISTS channels (
    channel_id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '',
    thumbnail TEXT NOT NULL DEFAULT '',
    updated_at TIMESTAMPTZ DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS rss_cache (
    channel_id TEXT PRIMARY KEY,
    data TEXT NOT NULL DEFAULT '{}',
    etag TEXT NOT NULL DEFAULT '',
    last_modified TEXT NOT NULL DEFAULT '',
    fetched_at TIMESTAMPTZ DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS rss_videos (
    channel_id TEXT NOT NULL,
    video_id TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    published_at TEXT NOT NULL DEFAULT '',
    channel_rank INTEGER NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY(channel_id, video_id)
  );
  CREATE INDEX IF NOT EXISTS idx_rss_videos_channel_published
    ON rss_videos(channel_id, published_at DESC);
  CREATE INDEX IF NOT EXISTS idx_rss_videos_published
    ON rss_videos(published_at DESC);
  CREATE INDEX IF NOT EXISTS idx_rss_videos_published_video
    ON rss_videos(published_at DESC, video_id ASC);
  CREATE INDEX IF NOT EXISTS idx_rss_videos_video ON rss_videos(video_id);
  CREATE TABLE IF NOT EXISTS rss_channel_stats (
    channel_id TEXT PRIMARY KEY,
    video_count INTEGER NOT NULL DEFAULT 0,
    newest_published_at TEXT NOT NULL DEFAULT '',
    median_interval_ms DOUBLE PRECISION NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS video_durations (
    video_id TEXT PRIMARY KEY,
    duration DOUBLE PRECISION NOT NULL,
    live_status TEXT NOT NULL DEFAULT 'not_live',
    tags TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS watch_time (
    user_id TEXT NOT NULL,
    video_id TEXT NOT NULL,
    last_position DOUBLE PRECISION NOT NULL DEFAULT 0,
    duration DOUBLE PRECISION NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY(user_id, video_id)
  );

  CREATE TABLE IF NOT EXISTS related_videos (
    source_video_id TEXT NOT NULL,
    video_id TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    channel_title TEXT NOT NULL DEFAULT '',
    channel_id TEXT NOT NULL DEFAULT '',
    published_text TEXT NOT NULL DEFAULT '',
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY(source_video_id, video_id)
  );
  CREATE INDEX IF NOT EXISTS idx_related_source ON related_videos(source_video_id);
  CREATE INDEX IF NOT EXISTS idx_related_videos_updated ON related_videos(updated_at);

  CREATE TABLE IF NOT EXISTS dismissals (
    user_id TEXT NOT NULL,
    video_id TEXT NOT NULL,
    channel_id TEXT NOT NULL DEFAULT '',
    PRIMARY KEY(user_id, video_id)
  );
  ALTER TABLE dismissals ADD COLUMN IF NOT EXISTS channel_id TEXT NOT NULL DEFAULT '';

  CREATE TABLE IF NOT EXISTS channel_boosts (
    user_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY(user_id, channel_id)
  );

  CREATE INDEX IF NOT EXISTS idx_watch_time_video ON watch_time(video_id);
  CREATE INDEX IF NOT EXISTS idx_watch_time_video_updated ON watch_time(video_id, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_watch_time_user_updated ON watch_time(user_id, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_dismissals_user_channel ON dismissals(user_id, channel_id);

  CREATE TABLE IF NOT EXISTS watch_queue (
    user_id TEXT NOT NULL,
    video_id TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    channel_title TEXT NOT NULL DEFAULT '',
    channel_id TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY(user_id, video_id)
  );
  CREATE INDEX IF NOT EXISTS idx_watch_queue_user_channel ON watch_queue(user_id, channel_id);
  CREATE INDEX IF NOT EXISTS idx_watch_queue_user_created ON watch_queue(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_watch_queue_user_created_video ON watch_queue(user_id, created_at DESC, video_id);

  CREATE TABLE IF NOT EXISTS saved_playlists (
    user_id TEXT NOT NULL,
    playlist_id TEXT NOT NULL,
    playlist_type TEXT NOT NULL DEFAULT 'youtube',
    title TEXT NOT NULL DEFAULT '',
    channel_title TEXT NOT NULL DEFAULT '',
    channel_id TEXT NOT NULL DEFAULT '',
    thumbnail_video_id TEXT NOT NULL DEFAULT '',
    item_count_text TEXT NOT NULL DEFAULT '',
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY(user_id, playlist_id)
  );
  CREATE INDEX IF NOT EXISTS idx_downloads_created ON downloads(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_saved_playlists_user ON saved_playlists(user_id, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_saved_playlists_user_updated_id ON saved_playlists(user_id, updated_at DESC, playlist_id);

  CREATE TABLE IF NOT EXISTS local_playlist_items (
    user_id TEXT NOT NULL,
    playlist_id TEXT NOT NULL,
    video_id TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    channel_title TEXT NOT NULL DEFAULT '',
    channel_id TEXT NOT NULL DEFAULT '',
    position INTEGER NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY(user_id, playlist_id, video_id)
  );
  CREATE INDEX IF NOT EXISTS idx_local_playlist_items ON local_playlist_items(user_id, playlist_id, position);
  CREATE INDEX IF NOT EXISTS idx_local_playlist_items_page
    ON local_playlist_items(user_id, playlist_id, position, created_at, video_id);

  CREATE TABLE IF NOT EXISTS channel_mutes (
    user_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY(user_id, channel_id)
  );

  CREATE TABLE IF NOT EXISTS video_ratings (
    user_id TEXT NOT NULL,
    video_id TEXT NOT NULL,
    rating INTEGER NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY(user_id, video_id)
  );
  CREATE INDEX IF NOT EXISTS idx_video_ratings_video_user ON video_ratings(video_id, user_id);

  CREATE TABLE IF NOT EXISTS explore_events (
    user_id TEXT NOT NULL,
    video_id TEXT NOT NULL,
    channel_id TEXT NOT NULL DEFAULT '',
    event_type TEXT NOT NULL,
    impression_count INTEGER NOT NULL DEFAULT 1,
    position INTEGER NOT NULL DEFAULT 0,
    bounce_seconds INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY(user_id, video_id, event_type)
  );
  CREATE INDEX IF NOT EXISTS idx_explore_events_user_type_created
    ON explore_events(user_id, event_type, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_explore_events_user_created
    ON explore_events(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_explore_events_channel_type
    ON explore_events(channel_id, event_type);
  CREATE INDEX IF NOT EXISTS idx_explore_events_created ON explore_events(created_at);

  CREATE TABLE IF NOT EXISTS maintenance_leases (
    name TEXT PRIMARY KEY,
    expires_at TIMESTAMPTZ NOT NULL
  );

  CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS topic_filters (
    user_id TEXT NOT NULL,
    topic TEXT NOT NULL,
    filter TEXT NOT NULL,
    PRIMARY KEY(user_id, topic)
  );

  CREATE TABLE IF NOT EXISTS explore_video_rollups (
    video_id TEXT PRIMARY KEY,
    engaged_users INTEGER NOT NULL DEFAULT 0,
    rating_up INTEGER NOT NULL DEFAULT 0,
    rating_down INTEGER NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS explore_channel_rollups (
    channel_id TEXT PRIMARY KEY,
    subscriber_users INTEGER NOT NULL DEFAULT 0,
    total_impressions BIGINT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS explore_user_channel_rollups (
    user_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    impressions BIGINT NOT NULL DEFAULT 0,
    clicks INTEGER NOT NULL DEFAULT 0,
    bounces INTEGER NOT NULL DEFAULT 0,
    returns INTEGER NOT NULL DEFAULT 0,
    last_return_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY(user_id, channel_id)
  );
  CREATE INDEX IF NOT EXISTS idx_explore_user_channel_rollups_updated
    ON explore_user_channel_rollups(user_id, updated_at DESC);
  CREATE TABLE IF NOT EXISTS explore_cowatch_edges (
    user_id TEXT NOT NULL,
    source_video_id TEXT NOT NULL,
    video_id TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY(user_id, source_video_id, video_id)
  );
  CREATE INDEX IF NOT EXISTS idx_explore_cowatch_source_updated
    ON explore_cowatch_edges(source_video_id, updated_at DESC, video_id, user_id);
  CREATE INDEX IF NOT EXISTS idx_explore_cowatch_updated
    ON explore_cowatch_edges(updated_at);
`;

const exploreCowatchMaxAgeDays = Math.min(365, Math.max(7,
  Number(process.env.EXPLORE_COWATCH_MAX_AGE_DAYS) || 90));
const exploreCowatchPerUserLimit = Math.min(200, Math.max(5,
  Number(process.env.EXPLORE_COWATCH_PER_USER_LIMIT) || 50));
const exploreCowatchRefreshIntervalMinutes = Math.min(24 * 60, Math.max(5,
  Number(process.env.EXPLORE_COWATCH_REFRESH_INTERVAL_MINUTES) || 60));
const exploreRollupTriggerSQL = `
  CREATE OR REPLACE FUNCTION maintain_explore_watch_rollups() RETURNS TRIGGER AS $$
  DECLARE
    old_qualified BOOLEAN := FALSE;
    new_qualified BOOLEAN := FALSE;
  BEGIN
    IF TG_OP != 'INSERT' THEN
      old_qualified := OLD.duration > 0 AND (OLD.last_position = 0 OR OLD.last_position / OLD.duration > 0.3);
    END IF;
    IF TG_OP != 'DELETE' THEN
      new_qualified := NEW.duration > 0 AND (NEW.last_position = 0 OR NEW.last_position / NEW.duration > 0.3);
    END IF;

    IF old_qualified AND NOT new_qualified THEN
      UPDATE explore_video_rollups SET engaged_users = GREATEST(0, engaged_users - 1), updated_at = NOW()
        WHERE video_id = OLD.video_id;
      DELETE FROM explore_cowatch_edges
        WHERE user_id = OLD.user_id AND (source_video_id = OLD.video_id OR video_id = OLD.video_id);
    END IF;

    IF new_qualified AND NOT old_qualified THEN
      INSERT INTO explore_video_rollups(video_id, engaged_users, updated_at)
      VALUES (NEW.video_id, 1, NOW())
      ON CONFLICT(video_id) DO UPDATE SET
        engaged_users = explore_video_rollups.engaged_users + 1, updated_at = NOW();
    END IF;

    IF new_qualified AND (
      NOT old_qualified OR TG_OP = 'INSERT'
      OR (TG_OP = 'UPDATE' AND OLD.updated_at < NOW() - INTERVAL '1 minute' * ${exploreCowatchRefreshIntervalMinutes})
    ) THEN
      INSERT INTO explore_cowatch_edges(user_id, source_video_id, video_id, updated_at)
      SELECT NEW.user_id, NEW.video_id, recent.video_id, LEAST(NEW.updated_at, recent.updated_at)
      FROM (
        SELECT video_id, updated_at FROM watch_time
        WHERE user_id = NEW.user_id AND video_id != NEW.video_id
          AND updated_at > NOW() - INTERVAL '1 day' * ${exploreCowatchMaxAgeDays}
          AND duration > 0 AND (last_position = 0 OR last_position / duration > 0.3)
        ORDER BY updated_at DESC LIMIT ${exploreCowatchPerUserLimit}
      ) recent
      ON CONFLICT(user_id, source_video_id, video_id) DO UPDATE SET
        updated_at = GREATEST(explore_cowatch_edges.updated_at, EXCLUDED.updated_at);
      INSERT INTO explore_cowatch_edges(user_id, source_video_id, video_id, updated_at)
      SELECT NEW.user_id, recent.video_id, NEW.video_id, LEAST(NEW.updated_at, recent.updated_at)
      FROM (
        SELECT video_id, updated_at FROM watch_time
        WHERE user_id = NEW.user_id AND video_id != NEW.video_id
          AND updated_at > NOW() - INTERVAL '1 day' * ${exploreCowatchMaxAgeDays}
          AND duration > 0 AND (last_position = 0 OR last_position / duration > 0.3)
        ORDER BY updated_at DESC LIMIT ${exploreCowatchPerUserLimit}
      ) recent
      ON CONFLICT(user_id, source_video_id, video_id) DO UPDATE SET
        updated_at = GREATEST(explore_cowatch_edges.updated_at, EXCLUDED.updated_at);
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql;
  DROP TRIGGER IF EXISTS trg_explore_watch_rollups ON watch_time;
  CREATE TRIGGER trg_explore_watch_rollups AFTER INSERT OR UPDATE OR DELETE ON watch_time
    FOR EACH ROW EXECUTE FUNCTION maintain_explore_watch_rollups();

  CREATE OR REPLACE FUNCTION maintain_explore_rating_rollups() RETURNS TRIGGER AS $$
  BEGIN
    IF TG_OP = 'INSERT' THEN
      INSERT INTO explore_video_rollups(video_id, rating_up, rating_down, updated_at)
      VALUES (NEW.video_id, CASE WHEN NEW.rating = 1 THEN 1 ELSE 0 END,
        CASE WHEN NEW.rating = -1 THEN 1 ELSE 0 END, NOW())
      ON CONFLICT(video_id) DO UPDATE SET
        rating_up = explore_video_rollups.rating_up + CASE WHEN NEW.rating = 1 THEN 1 ELSE 0 END,
        rating_down = explore_video_rollups.rating_down + CASE WHEN NEW.rating = -1 THEN 1 ELSE 0 END,
        updated_at = NOW();
    ELSIF TG_OP = 'UPDATE' THEN
      UPDATE explore_video_rollups SET
        rating_up = GREATEST(0, rating_up + CASE WHEN NEW.rating = 1 THEN 1 ELSE 0 END - CASE WHEN OLD.rating = 1 THEN 1 ELSE 0 END),
        rating_down = GREATEST(0, rating_down + CASE WHEN NEW.rating = -1 THEN 1 ELSE 0 END - CASE WHEN OLD.rating = -1 THEN 1 ELSE 0 END),
        updated_at = NOW() WHERE video_id = NEW.video_id;
    ELSE
      UPDATE explore_video_rollups SET
        rating_up = GREATEST(0, rating_up - CASE WHEN OLD.rating = 1 THEN 1 ELSE 0 END),
        rating_down = GREATEST(0, rating_down - CASE WHEN OLD.rating = -1 THEN 1 ELSE 0 END),
        updated_at = NOW() WHERE video_id = OLD.video_id;
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql;
  DROP TRIGGER IF EXISTS trg_explore_rating_rollups ON video_ratings;
  CREATE TRIGGER trg_explore_rating_rollups AFTER INSERT OR UPDATE OR DELETE ON video_ratings
    FOR EACH ROW EXECUTE FUNCTION maintain_explore_rating_rollups();

  CREATE OR REPLACE FUNCTION maintain_explore_subscription_rollups() RETURNS TRIGGER AS $$
  BEGIN
    IF TG_OP = 'INSERT' THEN
      INSERT INTO explore_channel_rollups(channel_id, subscriber_users, updated_at)
      VALUES (NEW.channel_id, 1, NOW())
      ON CONFLICT(channel_id) DO UPDATE SET
        subscriber_users = explore_channel_rollups.subscriber_users + 1, updated_at = NOW();
    ELSIF TG_OP = 'DELETE' THEN
      UPDATE explore_channel_rollups SET subscriber_users = GREATEST(0, subscriber_users - 1), updated_at = NOW()
        WHERE channel_id = OLD.channel_id;
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql;
  DROP TRIGGER IF EXISTS trg_explore_subscription_rollups ON subscriptions;
  CREATE TRIGGER trg_explore_subscription_rollups AFTER INSERT OR DELETE ON subscriptions
    FOR EACH ROW EXECUTE FUNCTION maintain_explore_subscription_rollups();

  CREATE OR REPLACE FUNCTION maintain_explore_event_rollups() RETURNS TRIGGER AS $$
  BEGIN
    IF TG_OP = 'DELETE' THEN
      IF OLD.event_type = 'impression' THEN
        UPDATE explore_channel_rollups SET
          total_impressions = GREATEST(0, total_impressions - OLD.impression_count), updated_at = NOW()
          WHERE channel_id = OLD.channel_id;
      END IF;
      UPDATE explore_user_channel_rollups SET
        impressions = GREATEST(0, impressions - CASE WHEN OLD.event_type = 'impression' THEN OLD.impression_count ELSE 0 END),
        clicks = GREATEST(0, clicks - CASE WHEN OLD.event_type = 'click' THEN 1 ELSE 0 END),
        bounces = GREATEST(0, bounces - CASE WHEN OLD.event_type = 'bounce' THEN 1 ELSE 0 END),
        returns = GREATEST(0, returns - CASE WHEN OLD.event_type = 'return' THEN OLD.impression_count ELSE 0 END),
        updated_at = NOW()
      WHERE user_id = OLD.user_id AND channel_id = OLD.channel_id;
      RETURN OLD;
    END IF;

    -- Impression inserts/updates are aggregated once per channel by
    -- logExploreImpressions; do not turn a bulk request into row-lock churn.
    IF NEW.event_type = 'impression' THEN RETURN NEW; END IF;

    IF TG_OP = 'INSERT' THEN
      INSERT INTO explore_user_channel_rollups(
        user_id, channel_id, clicks, bounces, returns, last_return_at, updated_at
      ) VALUES (
        NEW.user_id, NEW.channel_id,
        CASE WHEN NEW.event_type = 'click' THEN 1 ELSE 0 END,
        CASE WHEN NEW.event_type = 'bounce' THEN 1 ELSE 0 END,
        CASE WHEN NEW.event_type = 'return' THEN NEW.impression_count ELSE 0 END,
        CASE WHEN NEW.event_type = 'return' THEN NEW.created_at ELSE NULL END,
        NOW()
      ) ON CONFLICT(user_id, channel_id) DO UPDATE SET
        clicks = explore_user_channel_rollups.clicks + CASE WHEN NEW.event_type = 'click' THEN 1 ELSE 0 END,
        bounces = explore_user_channel_rollups.bounces + CASE WHEN NEW.event_type = 'bounce' THEN 1 ELSE 0 END,
        returns = explore_user_channel_rollups.returns + CASE WHEN NEW.event_type = 'return' THEN NEW.impression_count ELSE 0 END,
        last_return_at = CASE WHEN NEW.event_type = 'return' THEN NEW.created_at ELSE explore_user_channel_rollups.last_return_at END,
        updated_at = NOW();
    ELSIF NEW.event_type = 'return' THEN
      UPDATE explore_user_channel_rollups SET
        returns = GREATEST(0, returns + NEW.impression_count - OLD.impression_count),
        last_return_at = NEW.created_at,
        updated_at = NOW()
      WHERE user_id = NEW.user_id AND channel_id = NEW.channel_id;
    END IF;
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql;
  DROP TRIGGER IF EXISTS trg_explore_impression_rollups ON explore_events;
  DROP TRIGGER IF EXISTS trg_explore_event_rollups ON explore_events;
  CREATE TRIGGER trg_explore_event_rollups AFTER INSERT OR UPDATE OR DELETE ON explore_events
    FOR EACH ROW EXECUTE FUNCTION maintain_explore_event_rollups();
`;

function assertSchemaMigrationName(name: string) {
  if (!/^[A-Za-z0-9_.:-]{1,160}$/.test(name)) {
    throw new Error('Invalid schema migration name');
  }
}

async function runPostgresSchemaMigration(
  name: string,
  operation: (client: PoolClient) => Promise<void>,
) {
  assertSchemaMigrationName(name);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`my-youtube-schema:${name}`]);
    const { rowCount } = await client.query('SELECT 1 FROM schema_migrations WHERE name = $1', [name]);
    if (rowCount) {
      await client.query('COMMIT');
      return false;
    }
    await operation(client);
    await client.query(
      'INSERT INTO schema_migrations(name, applied_at) VALUES ($1, NOW()) ON CONFLICT (name) DO NOTHING',
      [name],
    );
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// Clustered entrypoints run this phase once before forking. Single-process and
// standalone worker entrypoints retain the safe auto-migration default.
const _ready = (process.env.SKIP_DATABASE_MIGRATIONS === '1' ? Promise.resolve() : pool.query(initSQL).then(async () => {
  await pool.query(exploreRollupTriggerSQL);
  await pool.query("ALTER TABLE rss_cache ADD COLUMN IF NOT EXISTS etag TEXT NOT NULL DEFAULT ''").catch(() => {});
  await pool.query("ALTER TABLE rss_cache ADD COLUMN IF NOT EXISTS last_modified TEXT NOT NULL DEFAULT ''").catch(() => {});
  await pool.query('ALTER TABLE rss_videos ADD COLUMN IF NOT EXISTS channel_rank INTEGER NOT NULL DEFAULT 0').catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_rss_videos_channel_rank
    ON rss_videos(channel_id, channel_rank, published_at DESC)`).catch(() => {});
  // Migrate: add position column to explore_events if missing
  await pool.query('ALTER TABLE explore_events ADD COLUMN IF NOT EXISTS position INTEGER NOT NULL DEFAULT 0').catch(() => {});
  await pool.query("ALTER TABLE saved_playlists ADD COLUMN IF NOT EXISTS playlist_type TEXT NOT NULL DEFAULT 'youtube'").catch(() => {});
  await pool.query("CREATE INDEX IF NOT EXISTS idx_saved_playlists_youtube_refresh ON saved_playlists(user_id, updated_at DESC) WHERE playlist_type = 'youtube'").catch(() => {});
  // Create explore_sessions table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS explore_sessions (
      user_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      started_at TIMESTAMPTZ DEFAULT NOW(),
      clicks INTEGER DEFAULT 0,
      total_watch_seconds DOUBLE PRECISION DEFAULT 0,
      best_completion DOUBLE PRECISION DEFAULT 0,
      PRIMARY KEY(user_id, session_id)
    );
    CREATE INDEX IF NOT EXISTS idx_explore_sessions_user_started
      ON explore_sessions(user_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_explore_sessions_started ON explore_sessions(started_at);
  `).catch(() => {});
  // Migrate: add channel_id column to dismissals if missing
  await pool.query("ALTER TABLE dismissals ADD COLUMN IF NOT EXISTS channel_id TEXT NOT NULL DEFAULT ''").catch(() => {});
  // Migrate: add bounce_seconds column to explore_events if missing
  await pool.query("ALTER TABLE explore_events ADD COLUMN IF NOT EXISTS bounce_seconds INTEGER NOT NULL DEFAULT 0").catch(() => {});
  // Backfill only user/channel pairs that predate the incremental behavior
  // rollup. Existing pairs are maintained transactionally by event writes.
  await runPostgresSchemaMigration('explore-user-channel-rollup-backfill-v1', async client => {
    await client.query(`INSERT INTO explore_user_channel_rollups(
        user_id, channel_id, impressions, clicks, bounces, returns, last_return_at, updated_at
      )
      SELECT events.user_id, events.channel_id,
        SUM(CASE WHEN events.event_type = 'impression' THEN events.impression_count ELSE 0 END)::bigint,
        SUM(CASE WHEN events.event_type = 'click' THEN 1 ELSE 0 END)::int,
        SUM(CASE WHEN events.event_type = 'bounce' THEN 1 ELSE 0 END)::int,
        SUM(CASE WHEN events.event_type = 'return' THEN events.impression_count ELSE 0 END)::int,
        MAX(CASE WHEN events.event_type = 'return' THEN events.created_at ELSE NULL END),
        NOW()
      FROM explore_events events
      LEFT JOIN explore_user_channel_rollups rollups
        ON rollups.user_id = events.user_id AND rollups.channel_id = events.channel_id
      WHERE rollups.user_id IS NULL
      GROUP BY events.user_id, events.channel_id
      ON CONFLICT(user_id, channel_id) DO NOTHING`);
  });
  // pg_trgm makes case-insensitive contains search scale with the subscription
  // library. Some managed roles cannot create extensions, so keep this
  // optimization optional rather than making application startup fail.
  await pool.query('CREATE EXTENSION IF NOT EXISTS pg_trgm')
    .then(() => pool.query(`CREATE INDEX IF NOT EXISTS idx_subscriptions_title_trgm
      ON subscriptions USING GIN (lower(title) gin_trgm_ops)`))
    .catch(error => console.warn('[db-pg] pg_trgm subscription index unavailable:', error.message));
  // Backfill normalized RSS rows once. This keeps upgrades warm without
  // reparsing every user's JSON feed on each Today/Explore request.
  await runPostgresSchemaMigration('normalized-rss-from-cache-v1', async client => {
    const { rows: rssRows } = await client.query('SELECT EXISTS(SELECT 1 FROM rss_videos) AS exists');
    if (rssRows[0]?.exists) return;
    const { rows: cachedFeeds } = await client.query('SELECT channel_id, data FROM rss_cache');
    const channelIds: string[] = [];
    const videoIds: string[] = [];
    const titles: string[] = [];
    const publishedAt: string[] = [];
    const channelRanks: number[] = [];
    for (const row of cachedFeeds) {
      try {
        const parsed = JSON.parse(row.data);
        for (const [index, item] of rankedRssItems(parsed).entries()) {
          channelIds.push(row.channel_id);
          videoIds.push(item.videoId);
          titles.push(item.title || '');
          publishedAt.push(item.publishedAt || '');
          channelRanks.push(index + 1);
        }
      } catch { /* skip malformed legacy rows */ }
    }
    if (videoIds.length > 0) {
      await client.query(
        `INSERT INTO rss_videos (channel_id, video_id, title, published_at, channel_rank)
         SELECT * FROM UNNEST($1::text[], $2::text[], $3::text[], $4::text[], $5::integer[])
         ON CONFLICT (channel_id, video_id) DO UPDATE SET
           title = EXCLUDED.title, published_at = EXCLUDED.published_at,
           channel_rank = EXCLUDED.channel_rank, updated_at = NOW()`,
        [channelIds, videoIds, titles, publishedAt, channelRanks],
      );
    }
  });
  await runPostgresSchemaMigration('rss-video-channel-rank-v1', async client => {
    await client.query(`
      WITH ranked AS (
        SELECT channel_id, video_id,
          (ROW_NUMBER() OVER (PARTITION BY channel_id ORDER BY published_at DESC, video_id))::integer AS next_rank
        FROM rss_videos WHERE channel_rank = 0
      )
      UPDATE rss_videos rv SET channel_rank = ranked.next_rank
      FROM ranked
      WHERE rv.channel_id = ranked.channel_id AND rv.video_id = ranked.video_id
    `);
  });
  await runPostgresSchemaMigration('rss-channel-stats-from-cache-v1', async client => {
    const { rows: statRows } = await client.query('SELECT EXISTS(SELECT 1 FROM rss_channel_stats) AS exists');
    if (statRows[0]?.exists) return;
    const { rows: cachedFeeds } = await client.query('SELECT channel_id, data FROM rss_cache');
    const stats = cachedFeeds.flatMap(row => {
      try { return [calculateRssChannelStats(row.channel_id, JSON.parse(row.data))]; } catch { return []; }
    });
    if (stats.length > 0) {
      await client.query(
        `INSERT INTO rss_channel_stats
           (channel_id, video_count, newest_published_at, median_interval_ms, updated_at)
         SELECT *, NOW() FROM UNNEST($1::text[], $2::integer[], $3::text[], $4::double precision[])
         ON CONFLICT (channel_id) DO UPDATE SET video_count = EXCLUDED.video_count,
           newest_published_at = EXCLUDED.newest_published_at,
           median_interval_ms = EXCLUDED.median_interval_ms, updated_at = NOW()`,
        [
          stats.map(stat => stat.channel_id),
          stats.map(stat => stat.video_count),
          stats.map(stat => stat.newest_published_at),
          stats.map(stat => stat.median_interval_ms),
        ],
      );
    }
  });
  await runPostgresSchemaMigration('double-protocol-thumbnails-v1', async client => {
    const r1 = await client.query(
      `UPDATE subscriptions SET thumbnail = SUBSTRING(thumbnail FROM 7) WHERE thumbnail LIKE 'https:https:%'`,
    );
    const r2 = await client.query(
      `UPDATE channels SET thumbnail = SUBSTRING(thumbnail FROM 7) WHERE thumbnail LIKE 'https:https:%'`,
    );
    if (r1.rowCount || r2.rowCount) {
      console.log(`[db-pg] fixed double-protocol thumbnails: ${r1.rowCount} subscriptions, ${r2.rowCount} channels`);
    }
  });
})).catch(err => {
  console.error('[db-pg] init error:', err);
  process.exit(1);
});

// ---------- Helpers ----------

function normalizeThumbnail(url) {
  if (!url) return '';
  if (url.startsWith('https:https:') || url.startsWith('http:https:')) {
    url = url.slice(url.lastIndexOf('https:'));
  }
  if (url.startsWith('//')) url = 'https:' + url;
  return url;
}

function normalizeTag(raw) {
  const t = raw.replace(/^#/, '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 30);
  return t || null;
}

function escapeLikePattern(value: unknown) {
  return String(value || '').replace(/[\\%_]/g, '\\$&').toLowerCase();
}

type WindowCountRow<T> = T & { _total?: unknown };

function databaseQueryOperation(text: string) {
  const command = text.trimStart().match(/^(?:WITH\b[\s\S]*?\)\s*)?(SELECT|INSERT|UPDATE|DELETE)/i)?.[1]
    ?.toLowerCase() || 'other';
  const relation = text.match(/\b(?:FROM|INTO|UPDATE|JOIN)\s+([A-Za-z_][A-Za-z0-9_.]*)/i)?.[1]
    ?.toLowerCase().replace(/[^a-z0-9_.]/g, '_') || 'other';
  return `${command}_${relation}`.slice(0, 80);
}

async function pageFromWindowRows<T extends object>(
  rows: Array<WindowCountRow<T>>,
  offset: number,
  countFallback: () => Promise<number>,
) {
  if (rows.length > 0) {
    const totalResults = Number(rows[0]._total || 0);
    const items = rows.map((row) => {
      const { _total, ...item } = row;
      return item as T;
    });
    return { items, totalResults };
  }
  // COUNT(*) OVER() has no row on an out-of-range page. Only that uncommon
  // recovery path needs a second query; the first/ordinary page uses one pool
  // checkout instead of two concurrent checkouts.
  return {
    items: [],
    totalResults: offset > 0 ? await countFallback() : 0,
  };
}

/** Ensure schema is ready before any query */
async function q(text: string, params?: (string | number | boolean | null | undefined | string[] | number[])[]) {
  await _ready;
  const client = transactionClients.getStore();
  const startedAt = performance.now();
  const scope = client ? 'transaction' : 'pool';
  const operation = databaseQueryOperation(text);
  updateDatabasePoolMetrics();
  try {
    const result = await (client || pool).query(text, params);
    incrementMetric('database_queries_total', { backend: 'postgres', operation, result: 'success', scope });
    observeMetric('database_query_duration_ms', performance.now() - startedAt, { backend: 'postgres', operation, result: 'success', scope });
    return result;
  } catch (error) {
    incrementMetric('database_queries_total', { backend: 'postgres', operation, result: 'error', scope });
    observeMetric('database_query_duration_ms', performance.now() - startedAt, { backend: 'postgres', operation, result: 'error', scope });
    throw error;
  } finally {
    updateDatabasePoolMetrics();
  }
}

async function acquirePoolClient() {
  await _ready;
  const startedAt = performance.now();
  updateDatabasePoolMetrics();
  try {
    const client = await pool.connect();
    incrementMetric('database_pool_acquisitions_total', { result: 'success' });
    observeMetric('database_pool_acquire_duration_ms', performance.now() - startedAt, { result: 'success' });
    return client;
  } catch (error) {
    incrementMetric('database_pool_acquisitions_total', { result: 'error' });
    observeMetric('database_pool_acquire_duration_ms', performance.now() - startedAt, { result: 'error' });
    throw error;
  } finally {
    updateDatabasePoolMetrics();
  }
}

// ---------- Exported API (mirrors db.js) ----------

const api: DatabaseAPI = {
  // Expose the ready promise so callers can await startup if needed
  _ready,

  async addTag(userId, videoId, rawTag) {
    const tag = normalizeTag(rawTag);
    if (!tag) return { ok: false, error: 'Invalid tag' };
    const { rows: existing } = await q(
      'SELECT tag FROM tags WHERE user_id = $1 AND video_id = $2',
      [userId, videoId]
    );
    if (existing.length >= 20) return { ok: false, error: 'Max 20 tags per video' };
    await q(
      'INSERT INTO tags (user_id, video_id, tag) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [userId, videoId, tag]
    );
    return { ok: true, tag };
  },

  async removeTag(userId, videoId, rawTag) {
    const tag = normalizeTag(rawTag);
    if (!tag) return { ok: false, error: 'Invalid tag' };
    await q(
      'DELETE FROM tags WHERE user_id = $1 AND video_id = $2 AND tag = $3',
      [userId, videoId, tag]
    );
    return { ok: true };
  },

  async getTags(userId, videoId) {
    const { rows } = await q(
      'SELECT tag FROM tags WHERE user_id = $1 AND video_id = $2 ORDER BY created_at',
      [userId, videoId]
    );
    return rows.map(r => r.tag);
  },

  async upsertSubscriptions(userId, subs, { fullSync = false } = {}) {
    const client = await acquirePoolClient();
    try {
      await client.query('BEGIN');
      if (subs.length > 0) {
        const normalized = subs.map(s => ({
          channelId: s.channelId,
          title: s.title || '',
          thumbnail: normalizeThumbnail(s.thumbnail),
          description: s.description || '',
        }));
        await client.query(
          `INSERT INTO subscriptions (user_id, channel_id, title, thumbnail, description, updated_at)
           SELECT $1, input.channel_id, input.title, input.thumbnail, input.description, NOW()
           FROM UNNEST($2::text[], $3::text[], $4::text[], $5::text[])
             AS input(channel_id, title, thumbnail, description)
           ON CONFLICT (user_id, channel_id) DO UPDATE SET
             title = EXCLUDED.title, thumbnail = EXCLUDED.thumbnail,
             description = EXCLUDED.description, updated_at = NOW()`,
          [
            userId,
            normalized.map(s => s.channelId),
            normalized.map(s => s.title),
            normalized.map(s => s.thumbnail),
            normalized.map(s => s.description),
          ]
        );
      }
      if (fullSync && subs.length > 0) {
        const keep = subs.map(s => s.channelId);
        await client.query(
          'DELETE FROM subscriptions WHERE user_id = $1 AND channel_id != ALL($2::text[])',
          [userId, keep]
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
      updateDatabasePoolMetrics();
    }
  },

  async getSubscriptions(userId) {
    const { rows } = await q(
      `SELECT channel_id AS "channelId", title, thumbnail, description
       FROM subscriptions WHERE user_id = $1 ORDER BY title COLLATE "C"`,
      [userId]
    );
    return rows;
  },

  async searchSubscriptions(userId, query, limit, offset) {
    const boundedLimit = Math.min(100, Math.max(1, Number(limit) || 20));
    const boundedOffset = Math.max(0, Number(offset) || 0);
    const pattern = `%${escapeLikePattern(String(query || '').toLowerCase())}%`;
    const { rows } = await q(
      `SELECT channel_id AS "channelId", title, thumbnail, description,
         (COUNT(*) OVER ())::int AS _total
       FROM subscriptions
       WHERE user_id = $1 AND lower(title) LIKE $2 ESCAPE E'\\\\'
       ORDER BY title COLLATE "C", channel_id LIMIT $3 OFFSET $4`,
      [userId, pattern, boundedLimit, boundedOffset]
    );
    return pageFromWindowRows<Subscription>(rows as Array<WindowCountRow<Subscription>>, boundedOffset, async () => {
      const result = await q(
        `SELECT COUNT(*)::int AS total FROM subscriptions
         WHERE user_id = $1 AND lower(title) LIKE $2 ESCAPE E'\\\\'`,
        [userId, pattern],
      );
      return Number(result.rows[0]?.total || 0);
    });
  },

  async getSubscriptionsCursorPage(userId, query, limit, cursor, direction) {
    const boundedLimit = Math.min(100, Math.max(1, Number(limit) || 20));
    const pattern = `%${escapeLikePattern(String(query || '').trim().slice(0, 200).toLowerCase())}%`;
    const reverse = direction === 'previous';
    const cursorPredicate = cursor
      ? reverse
        ? `AND (title COLLATE "C" < $4 COLLATE "C"
            OR (title COLLATE "C" = $4 COLLATE "C" AND channel_id < $5))`
        : `AND (title COLLATE "C" > $4 COLLATE "C"
            OR (title COLLATE "C" = $4 COLLATE "C" AND channel_id > $5))`
      : '';
    const order = reverse
      ? 'ORDER BY title COLLATE "C" DESC, channel_id DESC'
      : 'ORDER BY title COLLATE "C", channel_id';
    const params: Array<string | number> = [userId, pattern, boundedLimit + 1];
    if (cursor) params.push(cursor.title, cursor.channelId);
    const { rows } = await q(
      `SELECT channel_id AS "channelId", title, thumbnail, description
       FROM subscriptions
       WHERE user_id = $1 AND lower(title) LIKE $2 ESCAPE E'\\\\'
       ${cursorPredicate}
       ${order}
       LIMIT $3`,
      params,
    );
    const hasMore = rows.length > boundedLimit;
    if (hasMore) rows.pop();
    if (reverse) rows.reverse();
    return { items: rows, hasMore };
  },

  async deleteSubscription(userId, channelId) {
    await q('DELETE FROM subscriptions WHERE user_id = $1 AND channel_id = $2', [userId, channelId]);
  },

  async getRecentSubscriptionDates(userId, days) {
    const result = new Map<string, string>();
    const { rows } = await q(
      "SELECT channel_id, updated_at FROM subscriptions WHERE user_id = $1 AND updated_at > NOW() - INTERVAL '1 day' * $2",
      [userId, days]
    );
    for (const row of rows) result.set(row.channel_id, row.updated_at);
    return result;
  },

  async upsertChannel(channelId, title, thumbnail) {
    await q(
      `INSERT INTO channels (channel_id, title, thumbnail, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (channel_id) DO UPDATE SET
         title = EXCLUDED.title, thumbnail = EXCLUDED.thumbnail, updated_at = NOW()`,
      [channelId, title || '', normalizeThumbnail(thumbnail)]
    );
  },

  async getChannel(channelId) {
    const { rows } = await q(
      'SELECT channel_id AS "channelId", title, thumbnail FROM channels WHERE channel_id = $1',
      [channelId]
    );
    return rows[0] || null;
  },

  async getSubByChannel(channelId) {
    const { rows } = await q(
      'SELECT channel_id AS "channelId", title, thumbnail FROM subscriptions WHERE channel_id = $1 LIMIT 1',
      [channelId]
    );
    return rows[0] || null;
  },

  async getRssCache(channelId) {
    const { rows } = await q(
      'SELECT data, fetched_at, etag, last_modified FROM rss_cache WHERE channel_id = $1',
      [channelId]
    );
    if (!rows[0]) return null;
    try {
      return {
        data: JSON.parse(rows[0].data),
        fetchedAt: rows[0].fetched_at,
        validators: {
          etag: rows[0].etag || '',
          lastModified: rows[0].last_modified || '',
        },
      };
    } catch { return null; }
  },

  async setRssCache(channelId, data, validators = {}) {
    await api.runInSavepoint(async () => {
      await q(
        `INSERT INTO rss_cache (channel_id, data, etag, last_modified, fetched_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (channel_id) DO UPDATE SET data = EXCLUDED.data,
           etag = EXCLUDED.etag, last_modified = EXCLUDED.last_modified,
           fetched_at = NOW()`,
        [channelId, JSON.stringify(data), validators.etag || '', validators.lastModified || '']
      );
      const items = rankedRssItems(data);
      if (items.length > 0) {
        await q(
          `INSERT INTO rss_videos (channel_id, video_id, title, published_at, channel_rank)
           SELECT * FROM UNNEST($1::text[], $2::text[], $3::text[], $4::text[], $5::integer[])
           ON CONFLICT (channel_id, video_id) DO UPDATE SET
             title = EXCLUDED.title, published_at = EXCLUDED.published_at,
             channel_rank = EXCLUDED.channel_rank, updated_at = NOW()
           WHERE rss_videos.title IS DISTINCT FROM EXCLUDED.title
             OR rss_videos.published_at IS DISTINCT FROM EXCLUDED.published_at
             OR rss_videos.channel_rank IS DISTINCT FROM EXCLUDED.channel_rank`,
          [
            items.map(() => channelId),
            items.map(item => item.videoId),
            items.map(item => item.title || ''),
            items.map(item => item.publishedAt || ''),
            items.map((_item, index) => index + 1),
          ]
        );
      }
      await q(
        'DELETE FROM rss_videos WHERE channel_id = $1 AND video_id <> ALL($2::text[])',
        [channelId, items.map(item => item.videoId)],
      );
      const stats = calculateRssChannelStats(channelId, data);
      await q(
        `INSERT INTO rss_channel_stats
           (channel_id, video_count, newest_published_at, median_interval_ms, updated_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (channel_id) DO UPDATE SET video_count = EXCLUDED.video_count,
           newest_published_at = EXCLUDED.newest_published_at,
           median_interval_ms = EXCLUDED.median_interval_ms, updated_at = NOW()
         WHERE rss_channel_stats.video_count IS DISTINCT FROM EXCLUDED.video_count
           OR rss_channel_stats.newest_published_at IS DISTINCT FROM EXCLUDED.newest_published_at
           OR rss_channel_stats.median_interval_ms IS DISTINCT FROM EXCLUDED.median_interval_ms`,
        [stats.channel_id, stats.video_count, stats.newest_published_at, stats.median_interval_ms]
      );
    });
  },

  async touchRssCache(channelId, validators = {}) {
    await q(
      `UPDATE rss_cache SET fetched_at = NOW(),
         etag = CASE WHEN $2 != '' THEN $2 ELSE etag END,
         last_modified = CASE WHEN $3 != '' THEN $3 ELSE last_modified END
       WHERE channel_id = $1`,
      [channelId, validators.etag || '', validators.lastModified || ''],
    );
  },

  async backfillLegacyRssBatch(_limit) {
    // PostgreSQL normalizes legacy RSS rows in its schema migration path.
    return 0;
  },

  async getAllRssCacheForUser(userId) {
    const { rows } = await q(
      `SELECT r.channel_id, r.data, s.title AS sub_title
       FROM rss_cache r
       JOIN subscriptions s ON s.channel_id = r.channel_id
       WHERE s.user_id = $1`,
      [userId]
    );
    return rows;
  },

  async getRssVideosForUser(userId, publishedAfter, perChannelLimit, limit) {
    const { rows } = await q(
      POSTGRES_TODAY_ROWS_SQL,
      [userId, publishedAfter, perChannelLimit, limit]
    );
    return rows;
  },

  async getRssVideosPageForUser(userId, publishedAfter, perChannelLimit, limit, offset) {
    const boundedLimit = Math.min(200, Math.max(1, Number(limit) || 60));
    const boundedOffset = Math.max(0, Number(offset) || 0);
    const params = [userId, publishedAfter, perChannelLimit];
    const { rows } = await q(
      POSTGRES_TODAY_PAGE_SQL,
      [...params, boundedLimit, boundedOffset],
    );
    return pageFromWindowRows(rows, boundedOffset, async () => {
      const count = await q(POSTGRES_TODAY_COUNT_SQL, params);
      return Number(count.rows[0]?.total || 0);
    });
  },

  async getRssVideosCursorPageForUser(userId, publishedAfter, perChannelLimit, limit, cursor, direction) {
    const boundedLimit = Math.min(200, Math.max(1, Number(limit) || 60));
    const isNewer = direction === 'newer';
    const { rows } = await q(
      isNewer ? POSTGRES_TODAY_NEWER_CURSOR_SQL : POSTGRES_TODAY_OLDER_CURSOR_SQL,
      [
        userId,
        publishedAfter,
        perChannelLimit,
        cursor?.publishedAt || null,
        cursor?.videoId || null,
        boundedLimit + 1,
      ],
    );
    const hasMore = rows.length > boundedLimit;
    const items = rows.slice(0, boundedLimit);
    if (isNewer) items.reverse();
    return { items, hasMore };
  },

  async getExploreRssSnapshotForUser(userId, perChannelLimit, candidateLimit, watchMaxAgeDays, deepCutBefore) {
    const shortlistLimit = Math.max(candidateLimit, Math.min(10_000, candidateLimit * 2));
    const { rows: snapshots } = await q(
      `SELECT
         COALESCE((
           SELECT jsonb_agg(to_jsonb(candidate_rows))
           FROM (
             SELECT rv.channel_id, rv.video_id, rv.title, rv.published_at, s.title AS sub_title
           FROM rss_videos rv
           JOIN subscriptions s ON s.channel_id = rv.channel_id AND s.user_id = $1
           LEFT JOIN watch_time wt
             ON wt.user_id = $1 AND wt.video_id = rv.video_id
             AND wt.updated_at > NOW() - INTERVAL '1 day' * $4
           WHERE rv.channel_rank <= $2
             AND NOT EXISTS (SELECT 1 FROM tags t WHERE t.user_id = $1 AND t.video_id = rv.video_id)
             AND NOT EXISTS (SELECT 1 FROM dismissals d WHERE d.user_id = $1 AND d.video_id = rv.video_id)
             AND NOT EXISTS (SELECT 1 FROM channel_mutes m WHERE m.user_id = $1 AND m.channel_id = rv.channel_id)
             AND (
               wt.video_id IS NULL OR wt.duration <= 0
               OR (wt.last_position != 0 AND wt.last_position / wt.duration < 0.5)
               OR ((wt.last_position = 0 OR wt.last_position / wt.duration > 0.9) AND (
                 EXISTS (SELECT 1 FROM channel_boosts b WHERE b.user_id = $1 AND b.channel_id = rv.channel_id)
                 OR EXISTS (SELECT 1 FROM watch_queue q WHERE q.user_id = $1 AND q.channel_id = rv.channel_id)
               ))
             )
             ORDER BY rv.published_at DESC
             LIMIT $3
           ) candidate_rows
         ), '[]'::jsonb) AS videos,
         COALESCE((
           SELECT jsonb_agg(to_jsonb(channel_rows))
           FROM (
             SELECT rcs.channel_id, rcs.video_count,
               rcs.newest_published_at, rcs.median_interval_ms
             FROM rss_channel_stats rcs
             JOIN subscriptions s ON s.channel_id = rcs.channel_id
             WHERE s.user_id = $1
           ) channel_rows
         ), '[]'::jsonb) AS channel_stats`,
      [userId, perChannelLimit, shortlistLimit, watchMaxAgeDays],
    );
    const snapshot = snapshots[0] || {};
    const candidateRows = Array.isArray(snapshot.videos) ? snapshot.videos : [];
    const channelStats = Array.isArray(snapshot.channel_stats) ? snapshot.channel_stats : [];
    const videos = selectExploreRssCandidates(candidateRows, candidateLimit, deepCutBefore);
    return { videos, channelStats };
  },

  async getStaleRssRefreshCandidatesForUser(userId, staleBefore, limit) {
    const { rows } = await q(
      `SELECT s.channel_id AS "channelId", rc.fetched_at AS "fetchedAt"
       FROM subscriptions s
       LEFT JOIN rss_cache rc ON rc.channel_id = s.channel_id
       WHERE s.user_id = $1
         AND (rc.fetched_at IS NULL OR rc.fetched_at <= $2::timestamptz)
       ORDER BY CASE WHEN rc.fetched_at IS NULL THEN 0 ELSE 1 END,
         rc.fetched_at ASC, s.channel_id ASC
       LIMIT $3`,
      [userId, staleBefore, limit]
    );
    return rows;
  },

  async upsertDownload(videoId, title, channelTitle, thumbnail) {
    await q(
      `INSERT INTO downloads (video_id, title, channel_title, thumbnail, status, total_bytes, downloaded_bytes)
       VALUES ($1, $2, $3, $4, 'downloading', 0, 0)
       ON CONFLICT (video_id) DO UPDATE SET status = 'downloading', total_bytes = 0, downloaded_bytes = 0`,
      [videoId, title || '', channelTitle || '', thumbnail || '']
    );
  },

  async updateDownloadProgress(videoId, downloadedBytes, totalBytes) {
    await q(
      'UPDATE downloads SET downloaded_bytes = $1, total_bytes = $2 WHERE video_id = $3',
      [downloadedBytes, totalBytes, videoId]
    );
  },

  async completeDownload(videoId) {
    await q(
      "UPDATE downloads SET status = 'complete', downloaded_bytes = total_bytes WHERE video_id = $1",
      [videoId]
    );
  },

  async failDownload(videoId) {
    await q(
      "UPDATE downloads SET status = 'error' WHERE video_id = $1",
      [videoId]
    );
  },

  async deleteDownload(videoId) {
    await q('DELETE FROM downloads WHERE video_id = $1', [videoId]);
  },

  async getDownload(videoId) {
    const { rows } = await q('SELECT * FROM downloads WHERE video_id = $1', [videoId]);
    return rows[0] || null;
  },

  async getAllDownloads() {
    const { rows } = await q('SELECT * FROM downloads ORDER BY created_at DESC');
    return rows;
  },

  async getDownloadsPage(limit, offset) {
    const boundedLimit = Math.min(100, Math.max(1, Number(limit) || 40));
    const boundedOffset = Math.max(0, Number(offset) || 0);
    const { rows } = await q(
      `SELECT downloads.*, (COUNT(*) OVER ())::int AS _total
       FROM downloads ORDER BY created_at DESC, video_id LIMIT $1 OFFSET $2`,
      [boundedLimit, boundedOffset],
    );
    return pageFromWindowRows<Download>(rows as Array<WindowCountRow<Download>>, boundedOffset, async () => {
      const result = await q('SELECT COUNT(*)::int AS total FROM downloads');
      return Number(result.rows[0]?.total || 0);
    });
  },

  async getDownloadsCursorPage(limit, cursor, direction) {
    const boundedLimit = Math.min(100, Math.max(1, Number(limit) || 40));
    const previous = direction === 'previous' && cursor !== null;
    const { rows } = !cursor
      ? await q('SELECT * FROM downloads ORDER BY created_at DESC, video_id ASC LIMIT $1', [boundedLimit + 1])
      : await q(previous
        ? `SELECT * FROM downloads
           WHERE created_at > $1 OR (created_at = $1 AND video_id < $2)
           ORDER BY created_at ASC, video_id DESC LIMIT $3`
        : `SELECT * FROM downloads
           WHERE created_at < $1 OR (created_at = $1 AND video_id > $2)
           ORDER BY created_at DESC, video_id ASC LIMIT $3`,
      [cursor.timestamp, cursor.id, boundedLimit + 1]);
    const hasMore = rows.length > boundedLimit;
    const items = rows.slice(0, boundedLimit);
    if (previous) items.reverse();
    return { items, hasMore };
  },

  async getDownloadStorageUsage() {
    const { rows } = await q(
      'SELECT stored_bytes, mutation_version FROM download_storage_usage WHERE singleton = 1',
    );
    return {
      storedBytes: Number(rows[0]?.stored_bytes || 0),
      version: Number(rows[0]?.mutation_version || 0),
    };
  },

  async adjustDownloadStorageBytes(deltaBytes) {
    const { rows } = await q(
      `UPDATE download_storage_usage
       SET stored_bytes = GREATEST(0, stored_bytes + $1::bigint),
           mutation_version = mutation_version + 1
       WHERE singleton = 1 RETURNING stored_bytes`,
      [Math.trunc(Number(deltaBytes) || 0)],
    );
    return Number(rows[0]?.stored_bytes || 0);
  },

  async reconcileDownloadStorageBytes(storedBytes, expectedVersion) {
    const { rowCount } = await q(
      `UPDATE download_storage_usage
       SET stored_bytes = $1::bigint, mutation_version = mutation_version + 1
       WHERE singleton = 1 AND mutation_version = $2::bigint`,
      [Math.max(0, Math.trunc(Number(storedBytes) || 0)), Math.max(0, Math.trunc(Number(expectedVersion) || 0))],
    );
    return (rowCount || 0) > 0;
  },

  async setDuration(videoId, duration, liveStatus) {
    await q(
      `INSERT INTO video_durations (video_id, duration, live_status) VALUES ($1, $2, $3)
       ON CONFLICT (video_id) DO UPDATE SET duration = EXCLUDED.duration, live_status = EXCLUDED.live_status`,
      [videoId, duration, liveStatus || 'not_live']
    );
  },

  async getDuration(videoId) {
    const { rows } = await q(
      'SELECT duration, live_status FROM video_durations WHERE video_id = $1',
      [videoId]
    );
    return rows[0] ? rows[0].duration : null;
  },

  async getLiveStatus(videoId) {
    const { rows } = await q(
      'SELECT live_status FROM video_durations WHERE video_id = $1',
      [videoId]
    );
    return rows[0] ? (rows[0].live_status || 'not_live') : null;
  },

  async getVideoDisplayMetadata(videoId) {
    const { rows } = await q(
      `SELECT rv.title, rv.channel_id AS "channelId",
         COALESCE(
           (SELECT NULLIF(title, '') FROM subscriptions
            WHERE channel_id = rv.channel_id ORDER BY updated_at DESC LIMIT 1),
           NULLIF(c.title, ''), ''
         ) AS "channelTitle"
       FROM rss_videos rv
       LEFT JOIN channels c ON c.channel_id = rv.channel_id
       WHERE rv.video_id = $1
       ORDER BY rv.updated_at DESC
       LIMIT 1`,
      [videoId],
    );
    return rows[0] || null;
  },

  async getPlayerBootstrapData(userId, videoId, includeWatchTime) {
    const { rows } = await q(
      `SELECT display.title AS display_title,
         display.channel_id AS display_channel_id,
         display.channel_title AS display_channel_title,
         download.video_id AS download_video_id,
         download.title AS download_title,
         download.channel_title AS download_channel_title,
         download.thumbnail AS download_thumbnail,
         download.status AS download_status,
         download.total_bytes AS download_total_bytes,
         download.downloaded_bytes AS download_downloaded_bytes,
         download.created_at AS download_created_at,
         COALESCE(tag_list.tags, ARRAY[]::text[]) AS tags,
         COALESCE(rating.rating, 0) AS rating,
         CASE WHEN $3::boolean THEN watch.last_position ELSE NULL END AS last_position,
         CASE WHEN $3::boolean THEN watch.duration ELSE NULL END AS watch_duration,
         duration.live_status AS live_status
       FROM (VALUES (1)) AS seed(value)
       LEFT JOIN LATERAL (
         SELECT rv.title, rv.channel_id,
           COALESCE(
             (SELECT NULLIF(title, '') FROM subscriptions
              WHERE channel_id = rv.channel_id ORDER BY updated_at DESC LIMIT 1),
             NULLIF(channel.title, ''), ''
           ) AS channel_title
         FROM rss_videos rv
         LEFT JOIN channels channel ON channel.channel_id = rv.channel_id
         WHERE rv.video_id = $2
         ORDER BY rv.updated_at DESC
         LIMIT 1
       ) display ON TRUE
       LEFT JOIN downloads download ON download.video_id = $2
       LEFT JOIN video_ratings rating ON rating.user_id = $1 AND rating.video_id = $2
       LEFT JOIN watch_time watch ON watch.user_id = $1 AND watch.video_id = $2
       LEFT JOIN video_durations duration ON duration.video_id = $2
       LEFT JOIN LATERAL (
         SELECT array_agg(tag ORDER BY created_at) AS tags
         FROM tags WHERE user_id = $1 AND video_id = $2
       ) tag_list ON TRUE`,
      [userId, videoId, includeWatchTime],
    );
    const row = rows[0];
    const display = row.display_title === null
      ? null
      : {
          title: row.display_title,
          channelTitle: row.display_channel_title || '',
          channelId: row.display_channel_id || '',
        };
    const download = row.download_video_id && row.download_status
      ? {
          video_id: row.download_video_id,
          title: row.download_title || '',
          channel_title: row.download_channel_title || '',
          thumbnail: row.download_thumbnail || '',
          status: row.download_status as Download['status'],
          total_bytes: Number(row.download_total_bytes) || 0,
          downloaded_bytes: Number(row.download_downloaded_bytes) || 0,
          created_at: row.download_created_at instanceof Date
            ? row.download_created_at.toISOString()
            : String(row.download_created_at || ''),
        }
      : null;
    return {
      display,
      download,
      tags: Array.isArray(row.tags) ? row.tags.filter((tag): tag is string => typeof tag === 'string') : [],
      rating: Number(row.rating) || 0,
      watchTime: includeWatchTime && row.last_position !== null
        ? { last_position: Number(row.last_position) || 0, duration: Number(row.watch_duration) || 0 }
        : null,
      liveStatus: row.live_status || null,
    } satisfies PlayerBootstrapData;
  },

  async getDurations(videoIds) {
    if (!videoIds.length) return {};
    const { rows } = await q(
      'SELECT video_id, duration, live_status FROM video_durations WHERE video_id = ANY($1::text[])',
      [videoIds]
    );
    const result = {};
    for (const r of rows) result[r.video_id] = r.duration;
    return result;
  },

  async getLiveStatuses(videoIds) {
    if (!videoIds.length) return {};
    const { rows } = await q(
      'SELECT video_id, live_status FROM video_durations WHERE video_id = ANY($1::text[])',
      [videoIds]
    );
    const result = {};
    for (const r of rows) result[r.video_id] = r.live_status || 'not_live';
    return result;
  },

  async getDurationsAndLiveStatuses(videoIds) {
    if (!videoIds.length) return { durations: {}, liveStatuses: {} };
    const { rows } = await q(
      'SELECT video_id, duration, live_status FROM video_durations WHERE video_id = ANY($1::text[])',
      [videoIds]
    );
    const durations = {};
    const liveStatuses = {};
    for (const r of rows) {
      durations[r.video_id] = r.duration;
      liveStatuses[r.video_id] = r.live_status || 'not_live';
    }
    return { durations, liveStatuses };
  },

  async setWatchTime(userId, videoId, position, duration) {
    await q(
      `INSERT INTO watch_time (user_id, video_id, last_position, duration, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (user_id, video_id) DO UPDATE SET
         last_position = EXCLUDED.last_position, duration = EXCLUDED.duration, updated_at = NOW()`,
      [userId, videoId, position, duration]
    );
  },

  async getWatchTime(userId, videoId) {
    const { rows } = await q(
      'SELECT last_position, duration FROM watch_time WHERE user_id = $1 AND video_id = $2',
      [userId, videoId]
    );
    return rows[0] || null;
  },

  async getWatchTimes(userId, videoIds) {
    if (!videoIds.length) return {};
    const { rows } = await q(
      'SELECT video_id, last_position, duration FROM watch_time WHERE user_id = $1 AND video_id = ANY($2::text[])',
      [userId, videoIds]
    );
    const result = {};
    for (const r of rows) result[r.video_id] = { last_position: r.last_position, duration: r.duration };
    return result;
  },

  async getAllWatchTimesForUser(userId) {
    const { rows } = await q(
      'SELECT video_id, last_position, duration, updated_at FROM watch_time WHERE user_id = $1',
      [userId]
    );
    return rows;
  },

  async getExploreWatchTimes(userId, maxAgeDays, limit) {
    const { rows } = await q(
      `SELECT wt.video_id, wt.last_position, wt.duration, wt.updated_at,
         MAX(CASE WHEN s.channel_id IS NOT NULL THEN rv.channel_id END) AS channel_id,
         MAX(CASE WHEN s.channel_id IS NOT NULL THEN rv.title END) AS title,
         MAX(CASE WHEN s.channel_id IS NOT NULL THEN rv.published_at END) AS published_at
       FROM watch_time wt
       LEFT JOIN rss_videos rv ON rv.video_id = wt.video_id
       LEFT JOIN subscriptions s ON s.user_id = wt.user_id AND s.channel_id = rv.channel_id
       WHERE wt.user_id = $1 AND wt.updated_at > NOW() - INTERVAL '1 day' * $2
       GROUP BY wt.video_id, wt.last_position, wt.duration, wt.updated_at
       ORDER BY wt.updated_at DESC LIMIT $3`,
      [userId, maxAgeDays, limit]
    );
    return rows;
  },

  async getAllTaggedVideoIds(userId) {
    const { rows } = await q(
      'SELECT DISTINCT video_id FROM tags WHERE user_id = $1',
      [userId]
    );
    return rows.map(r => r.video_id);
  },

  async upsertRelatedVideos(sourceVideoId, videos) {
    if (!videos.length) return;
    await q(
      `INSERT INTO related_videos (source_video_id, video_id, title, channel_title, channel_id, published_text, updated_at)
       SELECT $1, input.video_id, input.title, input.channel_title, input.channel_id, input.published_text, NOW()
       FROM UNNEST($2::text[], $3::text[], $4::text[], $5::text[], $6::text[])
         AS input(video_id, title, channel_title, channel_id, published_text)
       ON CONFLICT (source_video_id, video_id) DO UPDATE SET
         title = EXCLUDED.title, channel_title = EXCLUDED.channel_title,
         channel_id = EXCLUDED.channel_id, published_text = EXCLUDED.published_text, updated_at = NOW()`,
      [
        sourceVideoId,
        videos.map(v => v.videoId),
        videos.map(v => v.title || ''),
        videos.map(v => v.channelTitle || ''),
        videos.map(v => v.channelId || ''),
        videos.map(v => v.publishedText || ''),
      ]
    );
  },

  async getRelatedVideosForSources(sourceVideoIds) {
    if (!sourceVideoIds.length) return [];
    const { rows } = await q(
      'SELECT source_video_id, video_id, title, channel_title, channel_id, published_text FROM related_videos WHERE source_video_id = ANY($1::text[])',
      [sourceVideoIds]
    );
    return rows;
  },

  async pruneRelatedVideos(maxAgeDays, limit = 1000) {
    const boundedLimit = Math.min(10_000, Math.max(1, Number(limit) || 1000));
    const { rowCount } = await q(
      `WITH stale AS (
         SELECT ctid FROM related_videos
         WHERE updated_at < NOW() - INTERVAL '1 day' * $1
         ORDER BY updated_at LIMIT $2
       )
       DELETE FROM related_videos target USING stale WHERE target.ctid = stale.ctid`,
      [maxAgeDays, boundedLimit]
    );
    return rowCount || 0;
  },

  async dismissVideo(userId, videoId, channelId) {
    await q(
      'INSERT INTO dismissals (user_id, video_id, channel_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [userId, videoId, channelId || '']
    );
  },

  async undismissVideo(userId, videoId) {
    await q(
      'DELETE FROM dismissals WHERE user_id = $1 AND video_id = $2',
      [userId, videoId]
    );
  },

  async getDismissedVideoIds(userId) {
    const { rows } = await q(
      'SELECT video_id FROM dismissals WHERE user_id = $1',
      [userId]
    );
    return rows.map(r => r.video_id);
  },

  async getDismissalCountByChannel(userId, channelId) {
    const { rows } = await q(
      "SELECT COUNT(*)::int AS cnt FROM dismissals WHERE user_id = $1 AND channel_id = $2 AND channel_id != ''",
      [userId, channelId]
    );
    return rows[0]?.cnt || 0;
  },

  async boostChannel(userId, channelId) {
    await q('INSERT INTO channel_boosts (user_id, channel_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [userId, channelId]);
  },

  async unboostChannel(userId, channelId) {
    await q('DELETE FROM channel_boosts WHERE user_id = $1 AND channel_id = $2', [userId, channelId]);
  },

  async getBoostedChannelIds(userId) {
    const { rows } = await q('SELECT channel_id FROM channel_boosts WHERE user_id = $1', [userId]);
    return rows.map(r => r.channel_id);
  },

  async queueVideo(userId, videoId, title, channelTitle, channelId) {
    await q(
      'INSERT INTO watch_queue (user_id, video_id, title, channel_title, channel_id) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING',
      [userId, videoId, title, channelTitle, channelId]
    );
  },

  async unqueueVideo(userId, videoId) {
    await q('DELETE FROM watch_queue WHERE user_id = $1 AND video_id = $2', [userId, videoId]);
  },

  async getQueuedVideos(userId) {
    const { rows } = await q(
      'SELECT video_id, title, channel_title, channel_id, created_at FROM watch_queue WHERE user_id = $1 ORDER BY created_at DESC',
      [userId]
    );
    return rows;
  },

  async getQueuedVideosPage(userId, limit, offset) {
    const boundedLimit = Math.min(100, Math.max(1, Number(limit) || 40));
    const boundedOffset = Math.max(0, Number(offset) || 0);
    const { rows } = await q(
      `SELECT video_id, title, channel_title, channel_id, created_at,
         (COUNT(*) OVER ())::int AS _total
       FROM watch_queue WHERE user_id = $1
       ORDER BY created_at DESC, video_id LIMIT $2 OFFSET $3`,
      [userId, boundedLimit, boundedOffset],
    );
    return pageFromWindowRows<{
      video_id: string;
      title: string;
      channel_title: string;
      channel_id: string;
      created_at: string;
    }>(rows, boundedOffset, async () => {
      const result = await q('SELECT COUNT(*)::int AS total FROM watch_queue WHERE user_id = $1', [userId]);
      return Number(result.rows[0]?.total || 0);
    });
  },

  async getQueuedVideosCursorPage(userId, limit, cursor, direction) {
    const boundedLimit = Math.min(100, Math.max(1, Number(limit) || 40));
    const previous = direction === 'previous' && cursor !== null;
    const select = 'SELECT video_id, title, channel_title, channel_id, created_at FROM watch_queue';
    const { rows } = !cursor
      ? await q(`${select} WHERE user_id = $1 ORDER BY created_at DESC, video_id ASC LIMIT $2`,
        [userId, boundedLimit + 1])
      : await q(previous
        ? `${select} WHERE user_id = $1 AND (created_at > $2 OR (created_at = $2 AND video_id < $3))
           ORDER BY created_at ASC, video_id DESC LIMIT $4`
        : `${select} WHERE user_id = $1 AND (created_at < $2 OR (created_at = $2 AND video_id > $3))
           ORDER BY created_at DESC, video_id ASC LIMIT $4`,
      [userId, cursor.timestamp, cursor.id, boundedLimit + 1]);
    const hasMore = rows.length > boundedLimit;
    const items = rows.slice(0, boundedLimit);
    if (previous) items.reverse();
    return { items, hasMore };
  },

  async getQueuedVideoIds(userId) {
    const { rows } = await q('SELECT video_id FROM watch_queue WHERE user_id = $1', [userId]);
    return rows.map(r => r.video_id);
  },

  async savePlaylist(userId, playlistId, title, channelTitle, channelId, thumbnailVideoId, itemCountText, playlistType) {
    await q(
      `INSERT INTO saved_playlists (user_id, playlist_id, playlist_type, title, channel_title, channel_id, thumbnail_video_id, item_count_text, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
       ON CONFLICT (user_id, playlist_id) DO UPDATE SET
         playlist_type = EXCLUDED.playlist_type,
         title = EXCLUDED.title,
         channel_title = EXCLUDED.channel_title,
         channel_id = EXCLUDED.channel_id,
         thumbnail_video_id = EXCLUDED.thumbnail_video_id,
         item_count_text = EXCLUDED.item_count_text,
         updated_at = NOW()`,
      [userId, playlistId, playlistType || 'youtube', title || '', channelTitle || '', channelId || '', thumbnailVideoId || '', itemCountText || '']
    );
  },

  async unsavePlaylist(userId, playlistId) {
    await q('DELETE FROM saved_playlists WHERE user_id = $1 AND playlist_id = $2', [userId, playlistId]);
    await q('DELETE FROM local_playlist_items WHERE user_id = $1 AND playlist_id = $2', [userId, playlistId]);
  },

  async getSavedPlaylists(userId) {
    const { rows } = await q(
      'SELECT playlist_id, playlist_type, title, channel_title, channel_id, thumbnail_video_id, item_count_text, updated_at FROM saved_playlists WHERE user_id = $1 ORDER BY updated_at DESC',
      [userId]
    );
    return rows;
  },

  async getSavedYoutubePlaylistIds(userId, limit) {
    const boundedLimit = Math.min(100, Math.max(1, Number(limit) || 20));
    const { rows } = await q(
      "SELECT playlist_id FROM saved_playlists WHERE user_id = $1 AND playlist_type = 'youtube' ORDER BY updated_at DESC LIMIT $2",
      [userId, boundedLimit],
    );
    return rows.map(row => row.playlist_id);
  },

  async getSavedPlaylistsPage(userId, limit, offset) {
    const boundedLimit = Math.min(100, Math.max(1, Number(limit) || 40));
    const boundedOffset = Math.max(0, Number(offset) || 0);
    const { rows } = await q(
      `SELECT playlist_id, playlist_type, title, channel_title, channel_id,
         thumbnail_video_id, item_count_text, updated_at,
         (COUNT(*) OVER ())::int AS _total
       FROM saved_playlists WHERE user_id = $1
       ORDER BY updated_at DESC, playlist_id LIMIT $2 OFFSET $3`,
      [userId, boundedLimit, boundedOffset],
    );
    return pageFromWindowRows<SavedPlaylist>(rows as Array<WindowCountRow<SavedPlaylist>>, boundedOffset, async () => {
      const result = await q('SELECT COUNT(*)::int AS total FROM saved_playlists WHERE user_id = $1', [userId]);
      return Number(result.rows[0]?.total || 0);
    });
  },

  async getSavedPlaylistsCursorPage(userId, limit, cursor, direction) {
    const boundedLimit = Math.min(100, Math.max(1, Number(limit) || 40));
    const previous = direction === 'previous' && cursor !== null;
    const select = `SELECT playlist_id, playlist_type, title, channel_title, channel_id,
      thumbnail_video_id, item_count_text, updated_at FROM saved_playlists`;
    const { rows } = !cursor
      ? await q(`${select} WHERE user_id = $1 ORDER BY updated_at DESC, playlist_id ASC LIMIT $2`,
        [userId, boundedLimit + 1])
      : await q(previous
        ? `${select} WHERE user_id = $1 AND (updated_at > $2 OR (updated_at = $2 AND playlist_id < $3))
           ORDER BY updated_at ASC, playlist_id DESC LIMIT $4`
        : `${select} WHERE user_id = $1 AND (updated_at < $2 OR (updated_at = $2 AND playlist_id > $3))
           ORDER BY updated_at DESC, playlist_id ASC LIMIT $4`,
      [userId, cursor.timestamp, cursor.id, boundedLimit + 1]);
    const hasMore = rows.length > boundedLimit;
    const items = rows.slice(0, boundedLimit);
    if (previous) items.reverse();
    return { items, hasMore };
  },

  async getSavedPlaylist(userId, playlistId) {
    const { rows } = await q(
      'SELECT playlist_id, playlist_type, title, channel_title, channel_id, thumbnail_video_id, item_count_text, updated_at FROM saved_playlists WHERE user_id = $1 AND playlist_id = $2',
      [userId, playlistId]
    );
    return rows[0] || null;
  },

  async isPlaylistSaved(userId, playlistId) {
    const { rows } = await q('SELECT 1 FROM saved_playlists WHERE user_id = $1 AND playlist_id = $2', [userId, playlistId]);
    return rows.length > 0;
  },

  async addLocalPlaylistItem(userId, playlistId, videoId, title, channelTitle, channelId) {
    const { rows } = await q(
      'SELECT COALESCE(MAX(position), 0) + 1 AS pos FROM local_playlist_items WHERE user_id = $1 AND playlist_id = $2',
      [userId, playlistId]
    );
    await q(
      `INSERT INTO local_playlist_items (user_id, playlist_id, video_id, title, channel_title, channel_id, position)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (user_id, playlist_id, video_id) DO UPDATE SET
         title = EXCLUDED.title,
         channel_title = EXCLUDED.channel_title,
         channel_id = EXCLUDED.channel_id`,
      [userId, playlistId, videoId, title || '', channelTitle || '', channelId || '', rows[0]?.pos || 1]
    );
  },

  async removeLocalPlaylistItem(userId, playlistId, videoId) {
    await q('DELETE FROM local_playlist_items WHERE user_id = $1 AND playlist_id = $2 AND video_id = $3', [userId, playlistId, videoId]);
  },

  async moveLocalPlaylistItem(userId, playlistId, videoId, direction) {
    const { rows } = await q('SELECT video_id, position FROM local_playlist_items WHERE user_id = $1 AND playlist_id = $2 AND video_id = $3', [userId, playlistId, videoId]);
    const current = rows[0];
    if (!current) return;
    const adjacentQuery = direction === 'up'
      ? 'SELECT video_id, position FROM local_playlist_items WHERE user_id = $1 AND playlist_id = $2 AND position < $3 ORDER BY position DESC LIMIT 1'
      : 'SELECT video_id, position FROM local_playlist_items WHERE user_id = $1 AND playlist_id = $2 AND position > $3 ORDER BY position ASC LIMIT 1';
    const adjacentRows = await q(adjacentQuery, [userId, playlistId, current.position]);
    const adjacent = adjacentRows.rows[0];
    if (!adjacent) return;
    await q('UPDATE local_playlist_items SET position = $1 WHERE user_id = $2 AND playlist_id = $3 AND video_id = $4', [adjacent.position, userId, playlistId, current.video_id]);
    await q('UPDATE local_playlist_items SET position = $1 WHERE user_id = $2 AND playlist_id = $3 AND video_id = $4', [current.position, userId, playlistId, adjacent.video_id]);
  },

  async getLocalPlaylistItems(userId, playlistId) {
    const { rows } = await q(
      'SELECT playlist_id, video_id, title, channel_title, channel_id, position, created_at FROM local_playlist_items WHERE user_id = $1 AND playlist_id = $2 ORDER BY position ASC, created_at ASC',
      [userId, playlistId]
    );
    return rows;
  },

  async getLocalPlaylistItemsPage(userId, playlistId, limit, offset) {
    const boundedLimit = Math.min(100, Math.max(1, Number(limit) || 50));
    const boundedOffset = Math.max(0, Number(offset) || 0);
    const { rows } = await q(
      `SELECT playlist_id, video_id, title, channel_title, channel_id, position, created_at,
         (COUNT(*) OVER ())::int AS _total
       FROM local_playlist_items WHERE user_id = $1 AND playlist_id = $2
       ORDER BY position ASC, created_at ASC, video_id LIMIT $3 OFFSET $4`,
      [userId, playlistId, boundedLimit, boundedOffset],
    );
    return pageFromWindowRows<LocalPlaylistItem>(rows as Array<WindowCountRow<LocalPlaylistItem>>, boundedOffset, async () => {
      const result = await q(
        'SELECT COUNT(*)::int AS total FROM local_playlist_items WHERE user_id = $1 AND playlist_id = $2',
        [userId, playlistId],
      );
      return Number(result.rows[0]?.total || 0);
    });
  },

  async getLocalPlaylistItemsCursorPage(userId, playlistId, limit, cursor, direction) {
    const boundedLimit = Math.min(100, Math.max(1, Number(limit) || 50));
    const previous = direction === 'previous' && cursor !== null;
    const select = `SELECT playlist_id, video_id, title, channel_title, channel_id, position, created_at
      FROM local_playlist_items`;
    const { rows } = !cursor
      ? await q(`${select} WHERE user_id = $1 AND playlist_id = $2
          ORDER BY position ASC, created_at ASC, video_id ASC LIMIT $3`,
        [userId, playlistId, boundedLimit + 1])
      : await q(previous
        ? `${select} WHERE user_id = $1 AND playlist_id = $2 AND
             (position < $3 OR (position = $3 AND created_at < $4)
              OR (position = $3 AND created_at = $4 AND video_id < $5))
           ORDER BY position DESC, created_at DESC, video_id DESC LIMIT $6`
        : `${select} WHERE user_id = $1 AND playlist_id = $2 AND
             (position > $3 OR (position = $3 AND created_at > $4)
              OR (position = $3 AND created_at = $4 AND video_id > $5))
           ORDER BY position ASC, created_at ASC, video_id ASC LIMIT $6`,
      [userId, playlistId, cursor.position, cursor.createdAt, cursor.videoId, boundedLimit + 1]);
    const hasMore = rows.length > boundedLimit;
    const items = rows.slice(0, boundedLimit);
    if (previous) items.reverse();
    return { items, hasMore };
  },

  async getLocalPlaylistSummary(userId, playlistId) {
    const { rows } = await q(
      `SELECT COUNT(*)::int AS total,
         COALESCE((ARRAY_AGG(video_id ORDER BY position ASC, created_at ASC))[1], '') AS thumbnail_video_id
       FROM local_playlist_items WHERE user_id = $1 AND playlist_id = $2`,
      [userId, playlistId],
    );
    return { totalResults: Number(rows[0]?.total || 0), thumbnailVideoId: rows[0]?.thumbnail_video_id || '' };
  },

  async muteChannel(userId, channelId) {
    await q('INSERT INTO channel_mutes (user_id, channel_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [userId, channelId]);
  },

  async unmuteChannel(userId, channelId) {
    await q('DELETE FROM channel_mutes WHERE user_id = $1 AND channel_id = $2', [userId, channelId]);
  },

  async getMutedChannelIds(userId) {
    const { rows } = await q('SELECT channel_id FROM channel_mutes WHERE user_id = $1', [userId]);
    return rows.map(r => r.channel_id);
  },

  async rateVideo(userId, videoId, rating) {
    await q(
      `INSERT INTO video_ratings (user_id, video_id, rating)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, video_id) DO UPDATE SET rating = EXCLUDED.rating, created_at = NOW()`,
      [userId, videoId, rating]
    );
  },
  async unrateVideo(userId, videoId) {
    await q('DELETE FROM video_ratings WHERE user_id = $1 AND video_id = $2', [userId, videoId]);
  },
  async getVideoRatings(userId) {
    const { rows } = await q('SELECT video_id, rating FROM video_ratings WHERE user_id = $1', [userId]);
    return rows;
  },
  async getVideoRating(userId, videoId) {
    const { rows } = await q('SELECT rating FROM video_ratings WHERE user_id = $1 AND video_id = $2', [userId, videoId]);
    return rows.length ? rows[0].rating : 0;
  },
  async getCommunityRatings(videoIds, excludeUserId) {
    if (!videoIds.length) return {};
    const { rows } = await q(
      `SELECT video_id,
         SUM(CASE WHEN rating = 1 THEN 1 ELSE 0 END)::int AS up,
         SUM(CASE WHEN rating = -1 THEN 1 ELSE 0 END)::int AS down
       FROM video_ratings
       WHERE video_id = ANY($1::text[]) AND user_id != $2
       GROUP BY video_id`,
      [videoIds, excludeUserId]
    );
    const result: Record<string, { up: number; down: number }> = {};
    for (const r of rows) result[r.video_id] = { up: Number(r.up), down: Number(r.down) };
    return result;
  },

  async setTopicFilter(userId, topic, filter) {
    await q(
      `INSERT INTO topic_filters (user_id, topic, filter) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, topic) DO UPDATE SET filter = EXCLUDED.filter`,
      [userId, topic, filter]
    );
  },
  async removeTopicFilter(userId, topic) {
    await q('DELETE FROM topic_filters WHERE user_id = $1 AND topic = $2', [userId, topic]);
  },
  async getTopicFilters(userId) {
    const { rows } = await q('SELECT topic, filter FROM topic_filters WHERE user_id = $1', [userId]);
    return rows;
  },

  async startExploreSession(userId, sessionId) {
    await q(
      'INSERT INTO explore_sessions (user_id, session_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [userId, sessionId]
    );
  },

  async updateExploreSession(userId, sessionId, clicks, totalWatchSeconds, bestCompletion) {
    await q(
      'UPDATE explore_sessions SET clicks = $1, total_watch_seconds = $2, best_completion = $3 WHERE user_id = $4 AND session_id = $5',
      [clicks, totalWatchSeconds, bestCompletion, userId, sessionId]
    );
  },

  async getRecentExploreSessions(userId, limit) {
    const { rows } = await q(
      'SELECT session_id, clicks, total_watch_seconds, best_completion, started_at FROM explore_sessions WHERE user_id = $1 ORDER BY started_at DESC LIMIT $2',
      [userId, limit]
    );
    return rows;
  },

  async getExploreSessionsForBackfill(userId) {
    const { rows } = await q(
      `WITH recent_sessions AS (
         SELECT session_id, clicks, total_watch_seconds, best_completion, started_at
         FROM explore_sessions
         WHERE user_id = $1 AND clicks > 0 AND started_at > NOW() - INTERVAL '1 day'
         ORDER BY started_at DESC LIMIT 50
       )
       SELECT sessions.session_id, sessions.clicks, sessions.total_watch_seconds,
         sessions.best_completion, sessions.started_at,
         GREATEST(sessions.best_completion, COALESCE(MAX(
           CASE WHEN wt.duration > 0 THEN
             CASE WHEN wt.last_position = 0 THEN 1.0
                  ELSE LEAST(1.0, wt.last_position::double precision / wt.duration) END
           END
         ), 0)) AS observed_best_completion
       FROM recent_sessions sessions
       LEFT JOIN watch_time wt ON wt.user_id = $1 AND wt.updated_at >= sessions.started_at
       GROUP BY sessions.session_id, sessions.clicks, sessions.total_watch_seconds,
         sessions.best_completion, sessions.started_at
       ORDER BY sessions.started_at DESC`,
      [userId]
    );
    return rows;
  },

  async pruneExploreSessions(maxAgeDays, limit = 1000) {
    const boundedLimit = Math.min(10_000, Math.max(1, Number(limit) || 1000));
    const { rowCount } = await q(
      `WITH stale AS (
         SELECT ctid FROM explore_sessions
         WHERE started_at < NOW() - INTERVAL '1 day' * $1
         ORDER BY started_at LIMIT $2
       )
       DELETE FROM explore_sessions target USING stale WHERE target.ctid = stale.ctid`,
      [maxAgeDays, boundedLimit]
    );
    return rowCount || 0;
  },

  async logExploreBounce(userId, videoId, channelId, bounceSeconds) {
    await q(
      `INSERT INTO explore_events (user_id, video_id, channel_id, event_type, bounce_seconds, created_at)
       VALUES ($1, $2, $3, 'bounce', $4, NOW())
       ON CONFLICT (user_id, video_id, event_type) DO UPDATE SET bounce_seconds = EXCLUDED.bounce_seconds, created_at = NOW()`,
      [userId, videoId, channelId, bounceSeconds]
    );
  },

  async getExploreBounces(userId, maxAgeDays = 90) {
    const { rows } = await q(
      `SELECT video_id, channel_id, bounce_seconds FROM explore_events
       WHERE user_id = $1 AND event_type = 'bounce'
         AND created_at > NOW() - INTERVAL '1 day' * $2`,
      [userId, maxAgeDays]
    );
    return rows;
  },

  async logExploreReturn(userId, videoId, channelId) {
    await q(
      `INSERT INTO explore_events (user_id, video_id, channel_id, event_type, impression_count, created_at)
       VALUES ($1, $2, $3, 'return', 1, NOW())
       ON CONFLICT (user_id, video_id, event_type) DO UPDATE SET impression_count = explore_events.impression_count + 1, created_at = NOW()`,
      [userId, videoId, channelId]
    );
  },

  async getExploreReturnChannels(userId) {
    const { rows } = await q(
      `SELECT channel_id, SUM(impression_count)::int AS cnt FROM explore_events
       WHERE user_id = $1 AND event_type = 'return' AND created_at > NOW() - INTERVAL '1 day'
       GROUP BY channel_id`,
      [userId]
    );
    const result: Record<string, number> = {};
    for (const r of rows) result[r.channel_id] = Number(r.cnt);
    return result;
  },

  async logExploreImpressions(userId, videos) {
    if (!videos.length) return;
    const channelDeltas = new Map<string, number>();
    for (const video of videos) {
      const channelId = video.channelId || '';
      channelDeltas.set(channelId, (channelDeltas.get(channelId) || 0) + 1);
    }
    const channelIds = [...channelDeltas.keys()];
    const deltas = channelIds.map(channelId => channelDeltas.get(channelId) || 0);
    const client = await acquirePoolClient();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO explore_events (user_id, video_id, channel_id, event_type, impression_count, position, created_at)
         SELECT $1, input.video_id, input.channel_id, 'impression', 1, input.position, NOW()
         FROM UNNEST($2::text[], $3::text[], $4::int[]) AS input(video_id, channel_id, position)
         ON CONFLICT (user_id, video_id, event_type) DO UPDATE SET
           impression_count = explore_events.impression_count + 1,
           position = EXCLUDED.position,
           created_at = NOW()`,
        [
          userId,
          videos.map(v => v.videoId),
          videos.map(v => v.channelId || ''),
          videos.map(v => v.position || 0),
        ],
      );
      await client.query(
        `INSERT INTO explore_channel_rollups(channel_id, total_impressions, updated_at)
         SELECT input.channel_id, input.delta, NOW()
         FROM UNNEST($1::text[], $2::bigint[]) AS input(channel_id, delta)
         ON CONFLICT(channel_id) DO UPDATE SET
           total_impressions = explore_channel_rollups.total_impressions + EXCLUDED.total_impressions,
           updated_at = NOW()`,
        [channelIds, deltas],
      );
      await client.query(
        `INSERT INTO explore_user_channel_rollups(user_id, channel_id, impressions, updated_at)
         SELECT $1, input.channel_id, input.delta, NOW()
         FROM UNNEST($2::text[], $3::bigint[]) AS input(channel_id, delta)
         ON CONFLICT(user_id, channel_id) DO UPDATE SET
           impressions = explore_user_channel_rollups.impressions + EXCLUDED.impressions,
           updated_at = NOW()`,
        [userId, channelIds, deltas],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
      updateDatabasePoolMetrics();
    }
  },

  async logExploreClick(userId, videoId, channelId) {
    await q(
      `INSERT INTO explore_events (user_id, video_id, channel_id, event_type, impression_count, created_at)
       VALUES ($1, $2, $3, 'click', 1, NOW())
       ON CONFLICT (user_id, video_id, event_type) DO UPDATE SET created_at = NOW()`,
      [userId, videoId, channelId]
    );
  },

  async getExploreEventsForUser(userId, maxAgeDays = 90) {
    const { rows } = await q(
      `SELECT video_id, channel_id, event_type, impression_count, position, created_at
       FROM explore_events
       WHERE user_id = $1 AND created_at > NOW() - INTERVAL '1 day' * $2`,
      [userId, maxAgeDays]
    );
    return rows;
  },

  async pruneExploreEvents(maxAgeDays, limit = 1000) {
    const boundedLimit = Math.min(10_000, Math.max(1, Number(limit) || 1000));
    const { rowCount } = await q(
      `WITH stale AS (
         SELECT ctid FROM explore_events
         WHERE created_at < NOW() - INTERVAL '1 day' * $1
         ORDER BY created_at LIMIT $2
       )
       DELETE FROM explore_events target USING stale WHERE target.ctid = stale.ctid`,
      [maxAgeDays, boundedLimit]
    );
    return rowCount || 0;
  },

  async getVideoPopularity(videoIds) {
    if (!videoIds.length) return {};
    const { rows } = await q(
      `SELECT video_id, COUNT(DISTINCT user_id) AS user_count FROM watch_time
       WHERE video_id = ANY($1::text[]) AND duration > 0
         AND (last_position = 0 OR last_position / duration > 0.3)
       GROUP BY video_id`,
      [videoIds]
    );
    const result = {};
    for (const r of rows) result[r.video_id] = Number(r.user_count);
    return result;
  },

  async getRecentVideoPopularity(videoIds, withinHours) {
    if (!videoIds.length) return {};
    const { rows } = await q(
      `SELECT video_id, COUNT(DISTINCT user_id) AS user_count FROM watch_time
       WHERE video_id = ANY($1::text[]) AND duration > 0
         AND (last_position = 0 OR last_position / duration > 0.3)
         AND updated_at > NOW() - INTERVAL '1 hour' * $2
       GROUP BY video_id`,
      [videoIds, withinHours]
    );
    const result = {};
    for (const r of rows) result[r.video_id] = Number(r.user_count);
    return result;
  },

  async getChannelSubscriberCounts(channelIds, excludeUserId) {
    if (!channelIds.length) return {};
    const { rows } = await q(
      `SELECT channel_id, COUNT(DISTINCT user_id) AS sub_count FROM subscriptions
       WHERE channel_id = ANY($1::text[]) AND user_id != $2
       GROUP BY channel_id`,
      [channelIds, excludeUserId]
    );
    const result = {};
    for (const r of rows) result[r.channel_id] = Number(r.sub_count);
    return result;
  },

  async getChannelImpressionCounts(channelIds) {
    if (!channelIds.length) return {};
    const { rows } = await q(
      `SELECT channel_id, SUM(impression_count)::int AS total_impressions FROM explore_events
       WHERE channel_id = ANY($1::text[]) AND event_type = 'impression'
       GROUP BY channel_id`,
      [channelIds]
    );
    const result = {};
    for (const r of rows) result[r.channel_id] = Number(r.total_impressions);
    return result;
  },

  async rebuildExploreSignalRollups(maxAgeDays = 90, perUserLimit = 50) {
    const boundedDays = Math.min(365, Math.max(7, Number(maxAgeDays) || 90));
    const boundedPerUser = Math.min(200, Math.max(5, Number(perUserLimit) || 50));
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM explore_video_rollups');
      const videos = await client.query(`INSERT INTO explore_video_rollups
          (video_id, engaged_users, rating_up, rating_down, updated_at)
        SELECT ids.video_id,
          COALESCE(w.engaged_users, 0)::int, COALESCE(r.rating_up, 0)::int,
          COALESCE(r.rating_down, 0)::int, NOW()
        FROM (
          SELECT video_id FROM watch_time
          UNION SELECT video_id FROM video_ratings
        ) ids
        LEFT JOIN (
          SELECT video_id, COUNT(DISTINCT user_id)::int AS engaged_users
          FROM watch_time WHERE duration > 0
            AND (last_position = 0 OR last_position / duration > 0.3)
          GROUP BY video_id
        ) w ON w.video_id = ids.video_id
        LEFT JOIN (
          SELECT video_id,
            SUM(CASE WHEN rating = 1 THEN 1 ELSE 0 END)::int AS rating_up,
            SUM(CASE WHEN rating = -1 THEN 1 ELSE 0 END)::int AS rating_down
          FROM video_ratings GROUP BY video_id
        ) r ON r.video_id = ids.video_id`);

      await client.query('DELETE FROM explore_channel_rollups');
      const channels = await client.query(`INSERT INTO explore_channel_rollups
          (channel_id, subscriber_users, total_impressions, updated_at)
        SELECT ids.channel_id, COALESCE(s.subscriber_users, 0)::int,
          COALESCE(e.total_impressions, 0), NOW()
        FROM (
          SELECT channel_id FROM subscriptions
          UNION SELECT channel_id FROM explore_events WHERE event_type = 'impression'
        ) ids
        LEFT JOIN (
          SELECT channel_id, COUNT(DISTINCT user_id)::int AS subscriber_users
          FROM subscriptions GROUP BY channel_id
        ) s ON s.channel_id = ids.channel_id
        LEFT JOIN (
          SELECT channel_id, SUM(impression_count)::bigint AS total_impressions
          FROM explore_events WHERE event_type = 'impression' GROUP BY channel_id
        ) e ON e.channel_id = ids.channel_id`);

      await client.query('DELETE FROM explore_user_channel_rollups');
      await client.query(`INSERT INTO explore_user_channel_rollups(
          user_id, channel_id, impressions, clicks, bounces, returns, last_return_at, updated_at
        )
        SELECT user_id, channel_id,
          SUM(CASE WHEN event_type = 'impression' THEN impression_count ELSE 0 END)::bigint,
          SUM(CASE WHEN event_type = 'click' THEN 1 ELSE 0 END)::int,
          SUM(CASE WHEN event_type = 'bounce' THEN 1 ELSE 0 END)::int,
          SUM(CASE WHEN event_type = 'return' THEN impression_count ELSE 0 END)::int,
          MAX(CASE WHEN event_type = 'return' THEN created_at ELSE NULL END),
          NOW()
        FROM explore_events
        GROUP BY user_id, channel_id`);

      await client.query('DELETE FROM explore_cowatch_edges');
      const cowatch = await client.query(`WITH recent AS (
          SELECT user_id, video_id, updated_at,
            ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY updated_at DESC, video_id) AS recent_rank
          FROM watch_time
          WHERE updated_at > NOW() - INTERVAL '1 day' * $1
            AND duration > 0 AND (last_position = 0 OR last_position / duration > 0.3)
        )
        INSERT INTO explore_cowatch_edges(user_id, source_video_id, video_id, updated_at)
        SELECT source.user_id, source.video_id, related.video_id,
          LEAST(source.updated_at, related.updated_at)
        FROM recent source
        JOIN recent related ON related.user_id = source.user_id AND related.video_id != source.video_id
        WHERE source.recent_rank <= $2 AND related.recent_rank <= $2`, [boundedDays, boundedPerUser]);
      await client.query('COMMIT');
      return {
        videos: videos.rowCount || 0,
        channels: channels.rowCount || 0,
        cowatchEdges: cowatch.rowCount || 0,
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  },

  async pruneExploreCowatchEdges(maxAgeDays, limit = 1000) {
    const boundedDays = Math.min(365, Math.max(7, Number(maxAgeDays) || 90));
    const boundedLimit = Math.min(10_000, Math.max(1, Number(limit) || 1000));
    const { rowCount } = await q(
      `WITH stale AS (
         SELECT ctid FROM explore_cowatch_edges
         WHERE updated_at < NOW() - INTERVAL '1 day' * $1
         ORDER BY updated_at LIMIT $2
       )
       DELETE FROM explore_cowatch_edges target USING stale WHERE target.ctid = stale.ctid`,
      [boundedDays, boundedLimit],
    );
    return rowCount || 0;
  },

  async setVideoTags(videoId, tags) {
    await q('UPDATE video_durations SET tags = $1 WHERE video_id = $2', [JSON.stringify(tags), videoId]);
  },

  async getVideoTags(videoIds) {
    if (!videoIds.length) return {};
    const { rows } = await q(
      "SELECT video_id, tags FROM video_durations WHERE video_id = ANY($1::text[]) AND tags != ''",
      [videoIds]
    );
    const result: Record<string, string[]> = {};
    for (const r of rows) {
      try { result[r.video_id] = JSON.parse(r.tags); } catch { /* skip */ }
    }
    return result;
  },

  async setVideoDescription(videoId, description) {
    await q('UPDATE video_durations SET description = $1 WHERE video_id = $2', [description, videoId]);
  },

  async getVideoDescriptions(videoIds) {
    if (!videoIds.length) return {};
    const { rows } = await q(
      "SELECT video_id, description FROM video_durations WHERE video_id = ANY($1::text[]) AND description != ''",
      [videoIds]
    );
    const result: Record<string, string> = {};
    for (const r of rows) result[r.video_id] = r.description;
    return result;
  },

  async getVideoMetadata(videoIds) {
    if (!videoIds.length) return { durations: {}, liveStatuses: {}, tags: {}, descriptions: {} };
    const { rows } = await q(
      `SELECT video_id, duration, live_status, tags, description
       FROM video_durations WHERE video_id = ANY($1::text[])`,
      [videoIds]
    );
    const durations: Record<string, number> = {};
    const liveStatuses: Record<string, string> = {};
    const tags: Record<string, string[]> = {};
    const descriptions: Record<string, string> = {};
    for (const row of rows) {
      durations[row.video_id] = Number(row.duration);
      liveStatuses[row.video_id] = row.live_status || 'not_live';
      if (row.tags) {
        try { tags[row.video_id] = JSON.parse(row.tags); } catch { /* skip malformed metadata */ }
      }
      if (row.description) descriptions[row.video_id] = row.description;
    }
    return { durations, liveStatuses, tags, descriptions };
  },

  async getExploreCandidateSignals(metadataVideoIds, richMetadataVideoIds, candidateVideoIds, candidateChannelIds, excludeUserId, recentWithinHours) {
    if (!metadataVideoIds.length && !candidateChannelIds.length) {
      return {
        videoMetadata: { durations: {}, liveStatuses: {}, tags: {}, descriptions: {} },
        videoPopularity: {}, recentVideoPopularity: {}, communityRatings: {},
        channelSubscriberCounts: {}, channelImpressionCounts: {},
      };
    }
    const { rows } = await q(
      POSTGRES_EXPLORE_CANDIDATE_SIGNALS_SQL,
      [
        metadataVideoIds, richMetadataVideoIds, candidateVideoIds,
        candidateChannelIds, excludeUserId, recentWithinHours,
      ]
    );
    const result = {
      videoMetadata: { durations: {}, liveStatuses: {}, tags: {}, descriptions: {} },
      videoPopularity: {}, recentVideoPopularity: {}, communityRatings: {},
      channelSubscriberCounts: {}, channelImpressionCounts: {},
    };
    for (const row of rows) {
      if (row.entity_type === 'channel') {
        if (row.subscriber_count !== null) result.channelSubscriberCounts[row.entity_id] = Number(row.subscriber_count);
        if (row.impression_count !== null) result.channelImpressionCounts[row.entity_id] = Number(row.impression_count);
        continue;
      }
      if (row.duration !== null) result.videoMetadata.durations[row.entity_id] = Number(row.duration);
      if (row.live_status !== null) result.videoMetadata.liveStatuses[row.entity_id] = row.live_status || 'not_live';
      if (row.tags) {
        try { result.videoMetadata.tags[row.entity_id] = JSON.parse(row.tags); } catch { /* skip malformed */ }
      }
      if (row.description) result.videoMetadata.descriptions[row.entity_id] = row.description;
      if (row.popularity !== null) result.videoPopularity[row.entity_id] = Number(row.popularity);
      if (row.recent_popularity !== null) result.recentVideoPopularity[row.entity_id] = Number(row.recent_popularity);
      if (row.rating_up !== null || row.rating_down !== null) {
        result.communityRatings[row.entity_id] = { up: Number(row.rating_up) || 0, down: Number(row.rating_down) || 0 };
      }
    }
    return result;
  },

  async getExploreUserSignals(userId, relevantVideoIds, relevantChannelIds, maxAgeDays = 90) {
    const videoIds = [...new Set(relevantVideoIds)].slice(0, 3_500);
    const channelIds = [...new Set(relevantChannelIds)].slice(0, 2_500);
    const { rows } = await q(
      POSTGRES_EXPLORE_USER_SIGNALS_SQL,
      [videoIds, channelIds, userId, maxAgeDays],
    );
    return mapExploreUserSignalRows(rows);
  },

  async resetRecommendations(userId) {
    await q('DELETE FROM watch_time WHERE user_id = $1', [userId]);
    await q('DELETE FROM explore_events WHERE user_id = $1', [userId]);
    await q('DELETE FROM explore_sessions WHERE user_id = $1', [userId]);
    await q('DELETE FROM dismissals WHERE user_id = $1', [userId]);
    await q('DELETE FROM channel_boosts WHERE user_id = $1', [userId]);
    await q('DELETE FROM channel_mutes WHERE user_id = $1', [userId]);
    await q('DELETE FROM video_ratings WHERE user_id = $1', [userId]);
    await q('DELETE FROM topic_filters WHERE user_id = $1', [userId]);
    await q('DELETE FROM watch_queue WHERE user_id = $1', [userId]);
    await q('DELETE FROM tags WHERE user_id = $1', [userId]);
    await q('DELETE FROM explore_user_channel_rollups WHERE user_id = $1', [userId]);
  },
  async claimMaintenanceLease(name, leaseSeconds) {
    const boundedLease = Math.min(7 * 24 * 60 * 60, Math.max(60, Number(leaseSeconds) || 3600));
    const { rowCount } = await q(
      `INSERT INTO maintenance_leases (name, expires_at)
       VALUES ($1, NOW() + INTERVAL '1 second' * $2)
       ON CONFLICT (name) DO UPDATE SET expires_at = EXCLUDED.expires_at
       WHERE maintenance_leases.expires_at <= NOW()
       RETURNING name`,
      [name, boundedLease],
    );
    return (rowCount || 0) > 0;
  },
  async hasSchemaMigration(name) {
    assertSchemaMigrationName(name);
    const { rowCount } = await q('SELECT 1 FROM schema_migrations WHERE name = $1', [name]);
    return Boolean(rowCount);
  },
  async recordSchemaMigration(name) {
    assertSchemaMigrationName(name);
    await q(
      'INSERT INTO schema_migrations(name, applied_at) VALUES ($1, NOW()) ON CONFLICT (name) DO NOTHING',
      [name],
    );
  },
  async runInSavepoint(fn) {
    const client = await acquirePoolClient();
    try {
      await client.query('BEGIN');
      const result = await transactionClients.run(client, fn);
      await client.query('COMMIT');
      return result;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
      updateDatabasePoolMetrics();
    }
  },
  async getCoWatchedVideos(videoIds, excludeUserId, limit, maxAgeDays = 90, maxUsers = 500) {
    if (!videoIds.length) return [];
    const boundedDays = Math.min(365, Math.max(7, Number(maxAgeDays) || 90));
    const boundedUsers = Math.min(5000, Math.max(10, Number(maxUsers) || 500));
    const { rows } = await q(
      `WITH co_users AS (
         SELECT user_id, MAX(updated_at) AS recent_match FROM explore_cowatch_edges
         WHERE source_video_id = ANY($1::text[]) AND user_id != $2
           AND updated_at > NOW() - INTERVAL '1 day' * $4
         GROUP BY user_id
         ORDER BY recent_match DESC
         LIMIT $5
       )
       SELECT edge.video_id, COUNT(DISTINCT edge.user_id)::int AS score
       FROM explore_cowatch_edges edge
       INNER JOIN co_users cu ON cu.user_id = edge.user_id
       WHERE edge.source_video_id = ANY($1::text[])
         AND edge.video_id != ALL($1::text[])
         AND edge.updated_at > NOW() - INTERVAL '1 day' * $4
       GROUP BY edge.video_id
       ORDER BY score DESC
       LIMIT $3`,
      [videoIds, excludeUserId, limit, boundedDays, boundedUsers]
    );
    return rows.map(r => ({ video_id: r.video_id, score: Number(r.score) }));
  },
};

export default api;
