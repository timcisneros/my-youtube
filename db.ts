import type { DatabaseAPI, Download, LocalPlaylistItem, PlayerBootstrapData, SavedPlaylist, SyncDatabaseAPI } from './types.js';
import path from 'path';
import fs from 'fs';
import { projectPath } from './lib/project-paths.js';
import { calculateRssChannelStats, querySqliteExploreRssSnapshot, rankedRssItems } from './lib/explore-rss-snapshot.js';
import { emptyExploreCandidateSignals, querySqliteExploreCandidateSignals } from './lib/explore-candidate-signals.js';
import { emptyExploreUserSignals, querySqliteExploreUserSignals } from './lib/explore-user-signals.js';
import { createSqliteReadWorker } from './lib/sqlite-explore-reader.js';
import {
  querySqliteRssVideosCursorPageForUser,
  querySqliteRssVideosForUser,
  querySqliteRssVideosPageForUser,
} from './lib/sqlite-rss-videos.js';

let api: DatabaseAPI | SyncDatabaseAPI;

// When DATABASE_URL is set, use PostgreSQL instead of SQLite
if (process.env.DATABASE_URL) {
  api = (await import('./db-pg.js')).default;
} else {

const { default: Database } = await import('better-sqlite3');

const dataDir = projectPath('data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);

const databasePath = path.join(dataDir, 'tags.db');
const db = new Database(databasePath);
db.pragma('journal_mode = WAL');
let sqliteOptimizeInitialized = false;

const shouldRunDatabaseMigrations = process.env.SKIP_DATABASE_MIGRATIONS !== '1';
if (shouldRunDatabaseMigrations) {
db.exec(`
  CREATE TABLE IF NOT EXISTS tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    video_id TEXT NOT NULL,
    tag TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
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
    updated_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY(user_id, channel_id)
  );
  CREATE INDEX IF NOT EXISTS idx_subs_user ON subscriptions(user_id);
  CREATE INDEX IF NOT EXISTS idx_subs_channel ON subscriptions(channel_id);
  CREATE INDEX IF NOT EXISTS idx_subs_user_title ON subscriptions(user_id, title COLLATE NOCASE);

  CREATE TABLE IF NOT EXISTS downloads (
    video_id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '',
    channel_title TEXT NOT NULL DEFAULT '',
    thumbnail TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'downloading',
    total_bytes INTEGER NOT NULL DEFAULT 0,
    downloaded_bytes INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_downloads_created ON downloads(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_downloads_created_video ON downloads(created_at DESC, video_id);

  CREATE TABLE IF NOT EXISTS download_storage_usage (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    stored_bytes INTEGER NOT NULL DEFAULT 0,
    mutation_version INTEGER NOT NULL DEFAULT 0
  );
  INSERT OR IGNORE INTO download_storage_usage (singleton, stored_bytes, mutation_version)
    VALUES (1, 0, 0);

  CREATE TABLE IF NOT EXISTS channels (
    channel_id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '',
    thumbnail TEXT NOT NULL DEFAULT '',
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS rss_cache (
    channel_id TEXT PRIMARY KEY,
    data TEXT NOT NULL DEFAULT '{}',
    etag TEXT NOT NULL DEFAULT '',
    last_modified TEXT NOT NULL DEFAULT '',
    fetched_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS rss_videos (
    channel_id TEXT NOT NULL,
    video_id TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    published_at TEXT NOT NULL DEFAULT '',
    channel_rank INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT DEFAULT (datetime('now')),
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
    median_interval_ms REAL NOT NULL DEFAULT 0,
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS video_durations (
    video_id TEXT PRIMARY KEY,
    duration REAL NOT NULL,
    live_status TEXT NOT NULL DEFAULT 'not_live',
    tags TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS watch_time (
    user_id TEXT NOT NULL,
    video_id TEXT NOT NULL,
    last_position REAL NOT NULL DEFAULT 0,
    duration REAL NOT NULL DEFAULT 0,
    updated_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY(user_id, video_id)
  );

  CREATE TABLE IF NOT EXISTS related_videos (
    source_video_id TEXT NOT NULL,
    video_id TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    channel_title TEXT NOT NULL DEFAULT '',
    channel_id TEXT NOT NULL DEFAULT '',
    published_text TEXT NOT NULL DEFAULT '',
    updated_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY(source_video_id, video_id)
  );
  CREATE INDEX IF NOT EXISTS idx_related_source ON related_videos(source_video_id);

  CREATE TABLE IF NOT EXISTS dismissals (
    user_id TEXT NOT NULL,
    video_id TEXT NOT NULL,
    channel_id TEXT NOT NULL DEFAULT '',
    PRIMARY KEY(user_id, video_id)
  );

  CREATE TABLE IF NOT EXISTS channel_boosts (
    user_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY(user_id, channel_id)
  );

  CREATE INDEX IF NOT EXISTS idx_watch_time_video ON watch_time(video_id);
  CREATE INDEX IF NOT EXISTS idx_watch_time_video_updated ON watch_time(video_id, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_watch_time_user_updated ON watch_time(user_id, updated_at DESC);

  CREATE TABLE IF NOT EXISTS watch_queue (
    user_id TEXT NOT NULL,
    video_id TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    channel_title TEXT NOT NULL DEFAULT '',
    channel_id TEXT NOT NULL DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
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
    updated_at TEXT DEFAULT (datetime('now')),
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
    created_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY(user_id, playlist_id, video_id)
  );
  CREATE INDEX IF NOT EXISTS idx_local_playlist_items ON local_playlist_items(user_id, playlist_id, position);
  CREATE INDEX IF NOT EXISTS idx_local_playlist_items_page
    ON local_playlist_items(user_id, playlist_id, position, created_at, video_id);

  CREATE TABLE IF NOT EXISTS channel_mutes (
    user_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY(user_id, channel_id)
  );

  CREATE TABLE IF NOT EXISTS video_ratings (
    user_id TEXT NOT NULL,
    video_id TEXT NOT NULL,
    rating INTEGER NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY(user_id, video_id)
  );
  CREATE INDEX IF NOT EXISTS idx_video_ratings_video_user ON video_ratings(video_id, user_id);

  CREATE TABLE IF NOT EXISTS explore_events (
    user_id TEXT NOT NULL,
    video_id TEXT NOT NULL,
    channel_id TEXT NOT NULL DEFAULT '',
    event_type TEXT NOT NULL,
    impression_count INTEGER NOT NULL DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
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
    expires_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

const hasSchemaMigrationStatement = db.prepare('SELECT 1 FROM schema_migrations WHERE name = ?');
const recordSchemaMigrationStatement = db.prepare(
  "INSERT OR IGNORE INTO schema_migrations(name, applied_at) VALUES (?, datetime('now'))",
);

function assertSchemaMigrationName(name: string) {
  if (!/^[A-Za-z0-9_.:-]{1,160}$/.test(name)) {
    throw new Error('Invalid schema migration name');
  }
}

function runSqliteSchemaMigration(name: string, operation: () => void) {
  assertSchemaMigrationName(name);
  if (!shouldRunDatabaseMigrations || hasSchemaMigrationStatement.get(name)) return false;
  const run = db.transaction(() => {
    if (hasSchemaMigrationStatement.get(name)) return false;
    operation();
    recordSchemaMigrationStatement.run(name);
    return true;
  });
  return run();
}

// FTS keeps subscription search independent of library size. The user-facing
// search is token-prefix based; the primary subscriptions table remains the
// source of truth and these triggers maintain the index transactionally.
db.exec(`
  CREATE VIRTUAL TABLE IF NOT EXISTS subscription_search USING fts5(
    user_id UNINDEXED,
    channel_id UNINDEXED,
    title,
    tokenize = 'unicode61 remove_diacritics 2'
  );
  CREATE TRIGGER IF NOT EXISTS trg_subscription_search_insert AFTER INSERT ON subscriptions BEGIN
    INSERT INTO subscription_search(user_id, channel_id, title)
    VALUES (NEW.user_id, NEW.channel_id, NEW.title);
  END;
  CREATE TRIGGER IF NOT EXISTS trg_subscription_search_update AFTER UPDATE OF title ON subscriptions BEGIN
    DELETE FROM subscription_search WHERE user_id = OLD.user_id AND channel_id = OLD.channel_id;
    INSERT INTO subscription_search(user_id, channel_id, title)
    VALUES (NEW.user_id, NEW.channel_id, NEW.title);
  END;
  CREATE TRIGGER IF NOT EXISTS trg_subscription_search_delete AFTER DELETE ON subscriptions BEGIN
    DELETE FROM subscription_search WHERE user_id = OLD.user_id AND channel_id = OLD.channel_id;
  END;
`);
runSqliteSchemaMigration('subscription-search-backfill-v1', () => {
  db.exec(`INSERT INTO subscription_search(user_id, channel_id, title)
    SELECT subscriptions.user_id, subscriptions.channel_id, subscriptions.title
    FROM subscriptions
    LEFT JOIN subscription_search search_index
      ON search_index.user_id = subscriptions.user_id AND search_index.channel_id = subscriptions.channel_id
    WHERE search_index.channel_id IS NULL`);
});

// Conditional RSS validators were added after the original cache schema.
try {
  db.prepare('SELECT etag, last_modified FROM rss_cache LIMIT 1').get();
} catch {
  try { db.exec("ALTER TABLE rss_cache ADD COLUMN etag TEXT NOT NULL DEFAULT ''"); } catch { /* already added */ }
  try { db.exec("ALTER TABLE rss_cache ADD COLUMN last_modified TEXT NOT NULL DEFAULT ''"); } catch { /* already added */ }
}

// Migrate normalized RSS rows created before channel rank was materialized.
try {
  db.prepare('SELECT channel_rank FROM rss_videos LIMIT 1').get();
} catch {
  db.exec('ALTER TABLE rss_videos ADD COLUMN channel_rank INTEGER NOT NULL DEFAULT 0');
}
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_rss_videos_channel_rank
    ON rss_videos(channel_id, channel_rank, published_at DESC);
`);
runSqliteSchemaMigration('rss-video-channel-rank-v1', () => {
  db.exec(`WITH ranked AS (
    SELECT rowid AS target_rowid,
      ROW_NUMBER() OVER (PARTITION BY channel_id ORDER BY published_at DESC, video_id) AS next_rank
    FROM rss_videos WHERE channel_rank = 0
  )
  UPDATE rss_videos
  SET channel_rank = (SELECT next_rank FROM ranked WHERE target_rowid = rss_videos.rowid)
  WHERE channel_rank = 0`);
});
db.exec('CREATE INDEX IF NOT EXISTS idx_related_videos_updated ON related_videos(updated_at)');

// Migrate: add live_status column if missing (existing DBs)
try {
  db.prepare("SELECT live_status FROM video_durations LIMIT 1").get();
} catch {
  db.exec("ALTER TABLE video_durations ADD COLUMN live_status TEXT NOT NULL DEFAULT 'not_live'");
}

// Migrate: add tags column if missing (existing DBs)
try {
  db.prepare("SELECT tags FROM video_durations LIMIT 1").get();
} catch {
  db.exec("ALTER TABLE video_durations ADD COLUMN tags TEXT NOT NULL DEFAULT ''");
}

// Migrate: add description column if missing (existing DBs)
try {
  db.prepare("SELECT description FROM video_durations LIMIT 1").get();
} catch {
  db.exec("ALTER TABLE video_durations ADD COLUMN description TEXT NOT NULL DEFAULT ''");
}

// Migrate: add playlist_type column if missing (existing DBs)
try {
  db.prepare("SELECT playlist_type FROM saved_playlists LIMIT 1").get();
} catch {
  db.exec("ALTER TABLE saved_playlists ADD COLUMN playlist_type TEXT NOT NULL DEFAULT 'youtube'");
}
db.exec("CREATE INDEX IF NOT EXISTS idx_saved_playlists_youtube_refresh ON saved_playlists(user_id, updated_at DESC) WHERE playlist_type = 'youtube'");

// Migrate: add position column to explore_events if missing
try {
  db.prepare("SELECT position FROM explore_events LIMIT 1").get();
} catch {
  db.exec("ALTER TABLE explore_events ADD COLUMN position INTEGER NOT NULL DEFAULT 0");
}

// Migrate: add bounce_seconds column to explore_events if missing
try {
  db.prepare("SELECT bounce_seconds FROM explore_events LIMIT 1").get();
} catch {
  db.exec("ALTER TABLE explore_events ADD COLUMN bounce_seconds INTEGER NOT NULL DEFAULT 0");
}

// Create explore_sessions table
db.exec(`
  CREATE TABLE IF NOT EXISTS explore_sessions (
    user_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    started_at TEXT DEFAULT (datetime('now')),
    clicks INTEGER DEFAULT 0,
    total_watch_seconds REAL DEFAULT 0,
    best_completion REAL DEFAULT 0,
    PRIMARY KEY(user_id, session_id)
  );
  CREATE INDEX IF NOT EXISTS idx_explore_sessions_user_started
    ON explore_sessions(user_id, started_at DESC);
  CREATE INDEX IF NOT EXISTS idx_explore_sessions_started ON explore_sessions(started_at);
`);

// Migrate: add channel_id column to dismissals if missing
try {
  db.prepare("SELECT channel_id FROM dismissals LIMIT 1").get();
} catch {
  db.exec("ALTER TABLE dismissals ADD COLUMN channel_id TEXT NOT NULL DEFAULT ''");
}
db.exec('CREATE INDEX IF NOT EXISTS idx_dismissals_user_channel ON dismissals(user_id, channel_id)');

// Create topic_filters table
db.exec(`
  CREATE TABLE IF NOT EXISTS topic_filters (
    user_id TEXT NOT NULL,
    topic TEXT NOT NULL,
    filter TEXT NOT NULL,
    PRIMARY KEY(user_id, topic)
  );
`);

// Incremental Explore aggregates keep cold builds proportional to the
// candidate set rather than total multi-user history. Per-user co-watch edges
// materialize the expensive self-join while retaining exact DISTINCT-user
// semantics at read time.
const exploreCowatchMaxAgeDays = Math.min(365, Math.max(7,
  Number(process.env.EXPLORE_COWATCH_MAX_AGE_DAYS) || 90));
const exploreCowatchPerUserLimit = Math.min(200, Math.max(5,
  Number(process.env.EXPLORE_COWATCH_PER_USER_LIMIT) || 50));
const exploreCowatchRefreshIntervalMinutes = Math.min(24 * 60, Math.max(5,
  Number(process.env.EXPLORE_COWATCH_REFRESH_INTERVAL_MINUTES) || 60));
if (shouldRunDatabaseMigrations) {
  db.exec(`
    DROP TRIGGER IF EXISTS trg_explore_watch_insert;
    DROP TRIGGER IF EXISTS trg_explore_watch_qualified;
    DROP TRIGGER IF EXISTS trg_explore_watch_unqualified;
    DROP TRIGGER IF EXISTS trg_explore_watch_refresh;
    DROP TRIGGER IF EXISTS trg_explore_watch_delete;
    DROP TRIGGER IF EXISTS trg_explore_impression_insert;
    DROP TRIGGER IF EXISTS trg_explore_impression_update;
    DROP TRIGGER IF EXISTS trg_explore_user_event_insert;
    DROP TRIGGER IF EXISTS trg_explore_user_event_update;
    DROP TRIGGER IF EXISTS trg_explore_user_event_delete;
  `);
}
db.exec(`
  CREATE TABLE IF NOT EXISTS explore_video_rollups (
    video_id TEXT PRIMARY KEY,
    engaged_users INTEGER NOT NULL DEFAULT 0,
    rating_up INTEGER NOT NULL DEFAULT 0,
    rating_down INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS explore_channel_rollups (
    channel_id TEXT PRIMARY KEY,
    subscriber_users INTEGER NOT NULL DEFAULT 0,
    total_impressions INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS explore_user_channel_rollups (
    user_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    impressions INTEGER NOT NULL DEFAULT 0,
    clicks INTEGER NOT NULL DEFAULT 0,
    bounces INTEGER NOT NULL DEFAULT 0,
    returns INTEGER NOT NULL DEFAULT 0,
    last_return_at TEXT,
    updated_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY(user_id, channel_id)
  );
  CREATE INDEX IF NOT EXISTS idx_explore_user_channel_rollups_updated
    ON explore_user_channel_rollups(user_id, updated_at DESC);
  CREATE TABLE IF NOT EXISTS explore_cowatch_edges (
    user_id TEXT NOT NULL,
    source_video_id TEXT NOT NULL,
    video_id TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(user_id, source_video_id, video_id)
  );
  CREATE INDEX IF NOT EXISTS idx_explore_cowatch_source_updated
    ON explore_cowatch_edges(source_video_id, updated_at DESC, video_id, user_id);
  CREATE INDEX IF NOT EXISTS idx_explore_cowatch_updated
    ON explore_cowatch_edges(updated_at);

  CREATE TRIGGER IF NOT EXISTS trg_explore_watch_insert
  AFTER INSERT ON watch_time
  WHEN NEW.duration > 0 AND (NEW.last_position = 0 OR CAST(NEW.last_position AS REAL) / NEW.duration > 0.3)
  BEGIN
    INSERT INTO explore_video_rollups(video_id, engaged_users, updated_at)
    VALUES (NEW.video_id, 1, datetime('now'))
    ON CONFLICT(video_id) DO UPDATE SET
      engaged_users = engaged_users + 1, updated_at = datetime('now');
    INSERT OR IGNORE INTO explore_cowatch_edges(user_id, source_video_id, video_id, updated_at)
    SELECT NEW.user_id, NEW.video_id, recent.video_id, MIN(NEW.updated_at, recent.updated_at)
    FROM (
      SELECT video_id, updated_at FROM watch_time
      WHERE user_id = NEW.user_id AND video_id != NEW.video_id
        AND updated_at > datetime('now', '-${exploreCowatchMaxAgeDays} days')
        AND duration > 0 AND (last_position = 0 OR CAST(last_position AS REAL) / duration > 0.3)
      ORDER BY updated_at DESC LIMIT ${exploreCowatchPerUserLimit}
    ) recent;
    INSERT OR IGNORE INTO explore_cowatch_edges(user_id, source_video_id, video_id, updated_at)
    SELECT NEW.user_id, recent.video_id, NEW.video_id, MIN(NEW.updated_at, recent.updated_at)
    FROM (
      SELECT video_id, updated_at FROM watch_time
      WHERE user_id = NEW.user_id AND video_id != NEW.video_id
        AND updated_at > datetime('now', '-${exploreCowatchMaxAgeDays} days')
        AND duration > 0 AND (last_position = 0 OR CAST(last_position AS REAL) / duration > 0.3)
      ORDER BY updated_at DESC LIMIT ${exploreCowatchPerUserLimit}
    ) recent;
  END;

  CREATE TRIGGER IF NOT EXISTS trg_explore_watch_qualified
  AFTER UPDATE OF last_position, duration ON watch_time
  WHEN NOT (OLD.duration > 0 AND (OLD.last_position = 0 OR CAST(OLD.last_position AS REAL) / OLD.duration > 0.3))
    AND NEW.duration > 0 AND (NEW.last_position = 0 OR CAST(NEW.last_position AS REAL) / NEW.duration > 0.3)
  BEGIN
    INSERT INTO explore_video_rollups(video_id, engaged_users, updated_at)
    VALUES (NEW.video_id, 1, datetime('now'))
    ON CONFLICT(video_id) DO UPDATE SET
      engaged_users = engaged_users + 1, updated_at = datetime('now');
    INSERT OR IGNORE INTO explore_cowatch_edges(user_id, source_video_id, video_id, updated_at)
    SELECT NEW.user_id, NEW.video_id, recent.video_id, MIN(NEW.updated_at, recent.updated_at)
    FROM (
      SELECT video_id, updated_at FROM watch_time
      WHERE user_id = NEW.user_id AND video_id != NEW.video_id
        AND updated_at > datetime('now', '-${exploreCowatchMaxAgeDays} days')
        AND duration > 0 AND (last_position = 0 OR CAST(last_position AS REAL) / duration > 0.3)
      ORDER BY updated_at DESC LIMIT ${exploreCowatchPerUserLimit}
    ) recent;
    INSERT OR IGNORE INTO explore_cowatch_edges(user_id, source_video_id, video_id, updated_at)
    SELECT NEW.user_id, recent.video_id, NEW.video_id, MIN(NEW.updated_at, recent.updated_at)
    FROM (
      SELECT video_id, updated_at FROM watch_time
      WHERE user_id = NEW.user_id AND video_id != NEW.video_id
        AND updated_at > datetime('now', '-${exploreCowatchMaxAgeDays} days')
        AND duration > 0 AND (last_position = 0 OR CAST(last_position AS REAL) / duration > 0.3)
      ORDER BY updated_at DESC LIMIT ${exploreCowatchPerUserLimit}
    ) recent;
  END;

  CREATE TRIGGER IF NOT EXISTS trg_explore_watch_unqualified
  AFTER UPDATE OF last_position, duration ON watch_time
  WHEN OLD.duration > 0 AND (OLD.last_position = 0 OR CAST(OLD.last_position AS REAL) / OLD.duration > 0.3)
    AND NOT (NEW.duration > 0 AND (NEW.last_position = 0 OR CAST(NEW.last_position AS REAL) / NEW.duration > 0.3))
  BEGIN
    UPDATE explore_video_rollups SET engaged_users = MAX(0, engaged_users - 1), updated_at = datetime('now')
      WHERE video_id = OLD.video_id;
    DELETE FROM explore_cowatch_edges
      WHERE user_id = OLD.user_id AND (source_video_id = OLD.video_id OR video_id = OLD.video_id);
  END;

  CREATE TRIGGER IF NOT EXISTS trg_explore_watch_refresh
  AFTER UPDATE ON watch_time
  WHEN OLD.duration > 0 AND (OLD.last_position = 0 OR CAST(OLD.last_position AS REAL) / OLD.duration > 0.3)
    AND NEW.duration > 0 AND (NEW.last_position = 0 OR CAST(NEW.last_position AS REAL) / NEW.duration > 0.3)
    AND OLD.updated_at < datetime('now', '-${exploreCowatchRefreshIntervalMinutes} minutes')
  BEGIN
    INSERT INTO explore_cowatch_edges(user_id, source_video_id, video_id, updated_at)
    SELECT NEW.user_id, NEW.video_id, recent.video_id, MIN(NEW.updated_at, recent.updated_at)
    FROM (
      SELECT video_id, updated_at FROM watch_time
      WHERE user_id = NEW.user_id AND video_id != NEW.video_id
        AND updated_at > datetime('now', '-${exploreCowatchMaxAgeDays} days')
        AND duration > 0 AND (last_position = 0 OR CAST(last_position AS REAL) / duration > 0.3)
      ORDER BY updated_at DESC LIMIT ${exploreCowatchPerUserLimit}
    ) recent
    WHERE true
    ON CONFLICT(user_id, source_video_id, video_id) DO UPDATE SET
      updated_at = MAX(updated_at, excluded.updated_at);
    INSERT INTO explore_cowatch_edges(user_id, source_video_id, video_id, updated_at)
    SELECT NEW.user_id, recent.video_id, NEW.video_id, MIN(NEW.updated_at, recent.updated_at)
    FROM (
      SELECT video_id, updated_at FROM watch_time
      WHERE user_id = NEW.user_id AND video_id != NEW.video_id
        AND updated_at > datetime('now', '-${exploreCowatchMaxAgeDays} days')
        AND duration > 0 AND (last_position = 0 OR CAST(last_position AS REAL) / duration > 0.3)
      ORDER BY updated_at DESC LIMIT ${exploreCowatchPerUserLimit}
    ) recent
    WHERE true
    ON CONFLICT(user_id, source_video_id, video_id) DO UPDATE SET
      updated_at = MAX(updated_at, excluded.updated_at);
  END;

  CREATE TRIGGER IF NOT EXISTS trg_explore_watch_delete
  AFTER DELETE ON watch_time
  WHEN OLD.duration > 0 AND (OLD.last_position = 0 OR CAST(OLD.last_position AS REAL) / OLD.duration > 0.3)
  BEGIN
    UPDATE explore_video_rollups SET engaged_users = MAX(0, engaged_users - 1), updated_at = datetime('now')
      WHERE video_id = OLD.video_id;
    DELETE FROM explore_cowatch_edges
      WHERE user_id = OLD.user_id AND (source_video_id = OLD.video_id OR video_id = OLD.video_id);
  END;

  CREATE TRIGGER IF NOT EXISTS trg_explore_rating_insert AFTER INSERT ON video_ratings BEGIN
    INSERT INTO explore_video_rollups(video_id, rating_up, rating_down, updated_at)
    VALUES (NEW.video_id, CASE WHEN NEW.rating = 1 THEN 1 ELSE 0 END,
      CASE WHEN NEW.rating = -1 THEN 1 ELSE 0 END, datetime('now'))
    ON CONFLICT(video_id) DO UPDATE SET
      rating_up = MAX(0, rating_up + CASE WHEN NEW.rating = 1 THEN 1 ELSE 0 END),
      rating_down = MAX(0, rating_down + CASE WHEN NEW.rating = -1 THEN 1 ELSE 0 END),
      updated_at = datetime('now');
  END;
  CREATE TRIGGER IF NOT EXISTS trg_explore_rating_update AFTER UPDATE OF rating ON video_ratings BEGIN
    UPDATE explore_video_rollups SET
      rating_up = MAX(0, rating_up + CASE WHEN NEW.rating = 1 THEN 1 ELSE 0 END - CASE WHEN OLD.rating = 1 THEN 1 ELSE 0 END),
      rating_down = MAX(0, rating_down + CASE WHEN NEW.rating = -1 THEN 1 ELSE 0 END - CASE WHEN OLD.rating = -1 THEN 1 ELSE 0 END),
      updated_at = datetime('now') WHERE video_id = NEW.video_id;
  END;
  CREATE TRIGGER IF NOT EXISTS trg_explore_rating_delete AFTER DELETE ON video_ratings BEGIN
    UPDATE explore_video_rollups SET
      rating_up = MAX(0, rating_up - CASE WHEN OLD.rating = 1 THEN 1 ELSE 0 END),
      rating_down = MAX(0, rating_down - CASE WHEN OLD.rating = -1 THEN 1 ELSE 0 END),
      updated_at = datetime('now') WHERE video_id = OLD.video_id;
  END;

  CREATE TRIGGER IF NOT EXISTS trg_explore_subscription_insert AFTER INSERT ON subscriptions BEGIN
    INSERT INTO explore_channel_rollups(channel_id, subscriber_users, updated_at)
    VALUES (NEW.channel_id, 1, datetime('now'))
    ON CONFLICT(channel_id) DO UPDATE SET subscriber_users = subscriber_users + 1, updated_at = datetime('now');
  END;
  CREATE TRIGGER IF NOT EXISTS trg_explore_subscription_delete AFTER DELETE ON subscriptions BEGIN
    UPDATE explore_channel_rollups SET subscriber_users = MAX(0, subscriber_users - 1), updated_at = datetime('now')
      WHERE channel_id = OLD.channel_id;
  END;

  CREATE TRIGGER IF NOT EXISTS trg_explore_impression_delete AFTER DELETE ON explore_events
  WHEN OLD.event_type = 'impression' BEGIN
    UPDATE explore_channel_rollups SET total_impressions = MAX(0, total_impressions - OLD.impression_count),
      updated_at = datetime('now') WHERE channel_id = OLD.channel_id;
  END;

  CREATE TRIGGER IF NOT EXISTS trg_explore_user_event_insert AFTER INSERT ON explore_events
  WHEN NEW.event_type != 'impression' BEGIN
    INSERT INTO explore_user_channel_rollups(
      user_id, channel_id, clicks, bounces, returns, last_return_at, updated_at
    ) VALUES (
      NEW.user_id, NEW.channel_id,
      CASE WHEN NEW.event_type = 'click' THEN 1 ELSE 0 END,
      CASE WHEN NEW.event_type = 'bounce' THEN 1 ELSE 0 END,
      CASE WHEN NEW.event_type = 'return' THEN NEW.impression_count ELSE 0 END,
      CASE WHEN NEW.event_type = 'return' THEN NEW.created_at ELSE NULL END,
      datetime('now')
    ) ON CONFLICT(user_id, channel_id) DO UPDATE SET
      clicks = clicks + CASE WHEN NEW.event_type = 'click' THEN 1 ELSE 0 END,
      bounces = bounces + CASE WHEN NEW.event_type = 'bounce' THEN 1 ELSE 0 END,
      returns = returns + CASE WHEN NEW.event_type = 'return' THEN NEW.impression_count ELSE 0 END,
      last_return_at = CASE WHEN NEW.event_type = 'return' THEN NEW.created_at ELSE last_return_at END,
      updated_at = datetime('now');
  END;
  CREATE TRIGGER IF NOT EXISTS trg_explore_user_event_update AFTER UPDATE ON explore_events
  WHEN NEW.event_type = 'return' BEGIN
    UPDATE explore_user_channel_rollups SET
      returns = MAX(0, returns + NEW.impression_count - OLD.impression_count),
      last_return_at = NEW.created_at,
      updated_at = datetime('now')
    WHERE user_id = NEW.user_id AND channel_id = NEW.channel_id;
  END;
  CREATE TRIGGER IF NOT EXISTS trg_explore_user_event_delete AFTER DELETE ON explore_events BEGIN
    UPDATE explore_user_channel_rollups SET
      impressions = MAX(0, impressions - CASE WHEN OLD.event_type = 'impression' THEN OLD.impression_count ELSE 0 END),
      clicks = MAX(0, clicks - CASE WHEN OLD.event_type = 'click' THEN 1 ELSE 0 END),
      bounces = MAX(0, bounces - CASE WHEN OLD.event_type = 'bounce' THEN 1 ELSE 0 END),
      returns = MAX(0, returns - CASE WHEN OLD.event_type = 'return' THEN OLD.impression_count ELSE 0 END),
      updated_at = datetime('now')
    WHERE user_id = OLD.user_id AND channel_id = OLD.channel_id;
  END;
`);
runSqliteSchemaMigration('explore-user-channel-rollup-backfill-v1', () => {
  db.exec(`INSERT INTO explore_user_channel_rollups(
      user_id, channel_id, impressions, clicks, bounces, returns, last_return_at, updated_at
    )
    SELECT events.user_id, events.channel_id,
      SUM(CASE WHEN events.event_type = 'impression' THEN events.impression_count ELSE 0 END),
      SUM(CASE WHEN events.event_type = 'click' THEN 1 ELSE 0 END),
      SUM(CASE WHEN events.event_type = 'bounce' THEN 1 ELSE 0 END),
      SUM(CASE WHEN events.event_type = 'return' THEN events.impression_count ELSE 0 END),
      MAX(CASE WHEN events.event_type = 'return' THEN events.created_at ELSE NULL END),
      datetime('now')
    FROM explore_events events
    LEFT JOIN explore_user_channel_rollups rollups
      ON rollups.user_id = events.user_id AND rollups.channel_id = events.channel_id
    WHERE rollups.user_id IS NULL
    GROUP BY events.user_id, events.channel_id`);
});
}

// Normalize thumbnail URLs: ensure absolute https, strip double-protocol artifacts
function normalizeThumbnail(url) {
  if (!url) return '';
  // Strip any repeated protocol prefixes (e.g. "https:https://...")
  if (url.startsWith('https:https:') || url.startsWith('http:https:')) {
    url = url.slice(url.lastIndexOf('https:'));
  }
  // Protocol-relative → absolute
  if (url.startsWith('//')) url = 'https:' + url;
  return url;
}

// Migrate: fix double-protocol thumbnail URLs (e.g. "https:https://...")
if (shouldRunDatabaseMigrations) {
  const fixed = db.prepare(`UPDATE subscriptions SET thumbnail = SUBSTR(thumbnail, 7) WHERE thumbnail LIKE 'https:https:%'`).run();
  const fixed2 = db.prepare(`UPDATE channels SET thumbnail = SUBSTR(thumbnail, 7) WHERE thumbnail LIKE 'https:https:%'`).run();
  if (fixed.changes || fixed2.changes) {
    console.log(`[db] fixed double-protocol thumbnails: ${fixed.changes} subscriptions, ${fixed2.changes} channels`);
  }
}

const stmts = {
  add: db.prepare('INSERT OR IGNORE INTO tags (user_id, video_id, tag) VALUES (?, ?, ?)'),
  remove: db.prepare('DELETE FROM tags WHERE user_id = ? AND video_id = ? AND tag = ?'),
  getForVideo: db.prepare('SELECT tag FROM tags WHERE user_id = ? AND video_id = ? ORDER BY created_at'),
  upsertSub: db.prepare(`INSERT INTO subscriptions (user_id, channel_id, title, thumbnail, description, updated_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(user_id, channel_id) DO UPDATE SET title=excluded.title, thumbnail=excluded.thumbnail, description=excluded.description, updated_at=datetime('now')`),
  getSubs: db.prepare('SELECT channel_id AS channelId, title, thumbnail, description FROM subscriptions WHERE user_id = ? ORDER BY title COLLATE NOCASE'),
  countSearchSubs: db.prepare(
    'SELECT COUNT(*) AS total FROM subscriptions WHERE user_id = ? AND instr(lower(title), lower(?)) > 0'
  ),
  searchSubs: db.prepare(`SELECT channel_id AS channelId, title, thumbnail, description
    FROM subscriptions
    WHERE user_id = ? AND instr(lower(title), lower(?)) > 0
    ORDER BY title COLLATE NOCASE
    LIMIT ? OFFSET ?`),
  subscriptionsCursorFirst: db.prepare(`SELECT channel_id AS channelId, title, thumbnail, description
    FROM subscriptions WHERE user_id = ?
    ORDER BY title COLLATE NOCASE, channel_id LIMIT ?`),
  subscriptionsCursorNext: db.prepare(`SELECT channel_id AS channelId, title, thumbnail, description
    FROM subscriptions WHERE user_id = ?
      AND (title COLLATE NOCASE > ? COLLATE NOCASE
        OR (title COLLATE NOCASE = ? COLLATE NOCASE AND channel_id > ?))
    ORDER BY title COLLATE NOCASE, channel_id LIMIT ?`),
  subscriptionsCursorPrevious: db.prepare(`SELECT channel_id AS channelId, title, thumbnail, description
    FROM subscriptions WHERE user_id = ?
      AND (title COLLATE NOCASE < ? COLLATE NOCASE
        OR (title COLLATE NOCASE = ? COLLATE NOCASE AND channel_id < ?))
    ORDER BY title COLLATE NOCASE DESC, channel_id DESC LIMIT ?`),
  subscriptionSearchCursorFirst: db.prepare(`SELECT s.channel_id AS channelId, s.title, s.thumbnail, s.description
    FROM subscription_search search
    JOIN subscriptions s ON s.user_id = search.user_id AND s.channel_id = search.channel_id
    WHERE subscription_search MATCH ? AND s.user_id = ?
    ORDER BY s.title COLLATE NOCASE, s.channel_id LIMIT ?`),
  subscriptionSearchCursorNext: db.prepare(`SELECT s.channel_id AS channelId, s.title, s.thumbnail, s.description
    FROM subscription_search search
    JOIN subscriptions s ON s.user_id = search.user_id AND s.channel_id = search.channel_id
    WHERE subscription_search MATCH ? AND s.user_id = ?
      AND (s.title COLLATE NOCASE > ? COLLATE NOCASE
        OR (s.title COLLATE NOCASE = ? COLLATE NOCASE AND s.channel_id > ?))
    ORDER BY s.title COLLATE NOCASE, s.channel_id LIMIT ?`),
  subscriptionSearchCursorPrevious: db.prepare(`SELECT s.channel_id AS channelId, s.title, s.thumbnail, s.description
    FROM subscription_search search
    JOIN subscriptions s ON s.user_id = search.user_id AND s.channel_id = search.channel_id
    WHERE subscription_search MATCH ? AND s.user_id = ?
      AND (s.title COLLATE NOCASE < ? COLLATE NOCASE
        OR (s.title COLLATE NOCASE = ? COLLATE NOCASE AND s.channel_id < ?))
    ORDER BY s.title COLLATE NOCASE DESC, s.channel_id DESC LIMIT ?`),
  deleteSub: db.prepare('DELETE FROM subscriptions WHERE user_id = ? AND channel_id = ?'),
  upsertChannel: db.prepare(`INSERT INTO channels (channel_id, title, thumbnail, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(channel_id) DO UPDATE SET title=excluded.title, thumbnail=excluded.thumbnail, updated_at=datetime('now')`),
  getChannel: db.prepare('SELECT channel_id AS channelId, title, thumbnail FROM channels WHERE channel_id = ?'),
  getSubByChannel: db.prepare('SELECT channel_id AS channelId, title, thumbnail FROM subscriptions WHERE channel_id = ? LIMIT 1'),
  getRssCache: db.prepare('SELECT data, fetched_at, etag, last_modified FROM rss_cache WHERE channel_id = ?'),
  upsertRssCache: db.prepare(`INSERT INTO rss_cache (channel_id, data, etag, last_modified, fetched_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(channel_id) DO UPDATE SET data=excluded.data, etag=excluded.etag,
      last_modified=excluded.last_modified, fetched_at=datetime('now')`),
  touchRssCache: db.prepare(`UPDATE rss_cache SET fetched_at=datetime('now'),
    etag=CASE WHEN ? != '' THEN ? ELSE etag END,
    last_modified=CASE WHEN ? != '' THEN ? ELSE last_modified END
    WHERE channel_id = ?`),
  deleteStaleRssVideos: db.prepare(`DELETE FROM rss_videos
    WHERE channel_id = ? AND video_id NOT IN (SELECT value FROM json_each(?))`),
  upsertRssVideo: db.prepare(`INSERT INTO rss_videos (channel_id, video_id, title, published_at, channel_rank, updated_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(channel_id, video_id) DO UPDATE SET
      title=excluded.title, published_at=excluded.published_at, channel_rank=excluded.channel_rank, updated_at=datetime('now')
    WHERE rss_videos.title != excluded.title
      OR rss_videos.published_at != excluded.published_at
      OR rss_videos.channel_rank != excluded.channel_rank`),
  upsertRssChannelStats: db.prepare(`INSERT INTO rss_channel_stats
      (channel_id, video_count, newest_published_at, median_interval_ms, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(channel_id) DO UPDATE SET video_count=excluded.video_count,
      newest_published_at=excluded.newest_published_at,
      median_interval_ms=excluded.median_interval_ms, updated_at=datetime('now')
    WHERE rss_channel_stats.video_count != excluded.video_count
      OR rss_channel_stats.newest_published_at != excluded.newest_published_at
      OR rss_channel_stats.median_interval_ms != excluded.median_interval_ms`),
  getLegacyRssBackfillBatch: db.prepare(`SELECT rc.channel_id, rc.data
    FROM rss_cache rc
    LEFT JOIN rss_channel_stats stats ON stats.channel_id = rc.channel_id
    WHERE stats.channel_id IS NULL OR (
      NOT EXISTS (SELECT 1 FROM rss_videos rv WHERE rv.channel_id = rc.channel_id)
      AND json_valid(rc.data)
      AND json_array_length(json_extract(rc.data, '$.items')) > 0
    )
    ORDER BY rc.channel_id ASC
    LIMIT ?`),
  getAllRssCacheForUser: db.prepare(`SELECT r.channel_id, r.data, s.title AS sub_title
    FROM rss_cache r
    JOIN subscriptions s ON s.channel_id = r.channel_id
    WHERE s.user_id = ?`),
  getStaleRssRefreshCandidates: db.prepare(`SELECT s.channel_id AS channelId, rc.fetched_at AS fetchedAt
    FROM subscriptions s
    LEFT JOIN rss_cache rc ON rc.channel_id = s.channel_id
    WHERE s.user_id = ?
      AND (rc.fetched_at IS NULL OR rc.fetched_at <= datetime(?))
    ORDER BY CASE WHEN rc.fetched_at IS NULL THEN 0 ELSE 1 END,
      rc.fetched_at ASC, s.channel_id ASC
    LIMIT ?`),
  upsertDownload: db.prepare(`INSERT INTO downloads (video_id, title, channel_title, thumbnail, status, total_bytes, downloaded_bytes)
    VALUES (?, ?, ?, ?, 'downloading', 0, 0)
    ON CONFLICT(video_id) DO UPDATE SET status='downloading', total_bytes=0, downloaded_bytes=0`),
  updateDownloadProgress: db.prepare('UPDATE downloads SET downloaded_bytes = ?, total_bytes = ? WHERE video_id = ?'),
  completeDownload: db.prepare('UPDATE downloads SET status = \'complete\', downloaded_bytes = total_bytes WHERE video_id = ?'),
  failDownload: db.prepare('UPDATE downloads SET status = \'error\' WHERE video_id = ?'),
  deleteDownload: db.prepare('DELETE FROM downloads WHERE video_id = ?'),
  getDownload: db.prepare('SELECT * FROM downloads WHERE video_id = ?'),
  getAllDownloads: db.prepare('SELECT * FROM downloads ORDER BY created_at DESC'),
  getDownloadsPage: db.prepare('SELECT * FROM downloads ORDER BY created_at DESC LIMIT ? OFFSET ?'),
  getDownloadsCursorFirst: db.prepare('SELECT * FROM downloads ORDER BY created_at DESC, video_id ASC LIMIT ?'),
  getDownloadsCursorNext: db.prepare(`SELECT * FROM downloads
    WHERE created_at < ? OR (created_at = ? AND video_id > ?)
    ORDER BY created_at DESC, video_id ASC LIMIT ?`),
  getDownloadsCursorPrevious: db.prepare(`SELECT * FROM downloads
    WHERE created_at > ? OR (created_at = ? AND video_id < ?)
    ORDER BY created_at ASC, video_id DESC LIMIT ?`),
  countDownloads: db.prepare('SELECT COUNT(*) AS total FROM downloads'),
  getDownloadStorageUsage: db.prepare('SELECT stored_bytes, mutation_version FROM download_storage_usage WHERE singleton = 1'),
  adjustDownloadStorageBytes: db.prepare(`UPDATE download_storage_usage
    SET stored_bytes = MAX(0, stored_bytes + ?), mutation_version = mutation_version + 1
    WHERE singleton = 1 RETURNING stored_bytes`),
  reconcileDownloadStorageBytes: db.prepare(`UPDATE download_storage_usage
    SET stored_bytes = MAX(0, ?), mutation_version = mutation_version + 1
    WHERE singleton = 1 AND mutation_version = ?`),
  upsertDuration: db.prepare(`INSERT INTO video_durations (video_id, duration, live_status) VALUES (?, ?, ?)
    ON CONFLICT(video_id) DO UPDATE SET duration=excluded.duration, live_status=excluded.live_status`),
  getDuration: db.prepare('SELECT duration, live_status FROM video_durations WHERE video_id = ?'),
  getVideoDisplayMetadata: db.prepare(`SELECT rv.title, rv.channel_id AS channelId,
    COALESCE(
      (SELECT NULLIF(title, '') FROM subscriptions
       WHERE channel_id = rv.channel_id ORDER BY updated_at DESC LIMIT 1),
      NULLIF(c.title, ''), ''
    ) AS channelTitle
    FROM rss_videos rv
    LEFT JOIN channels c ON c.channel_id = rv.channel_id
    WHERE rv.video_id = ?
    ORDER BY rv.updated_at DESC
    LIMIT 1`),
  getPlayerBootstrapData: db.prepare(`WITH input(user_id, video_id, include_watch_time) AS (
      VALUES (?, ?, ?)
    ), display AS (
      SELECT rv.title, rv.channel_id AS channel_id,
        COALESCE(
          (SELECT NULLIF(title, '') FROM subscriptions
           WHERE channel_id = rv.channel_id ORDER BY updated_at DESC LIMIT 1),
          NULLIF(c.title, ''), ''
        ) AS channel_title
      FROM rss_videos rv
      LEFT JOIN channels c ON c.channel_id = rv.channel_id
      JOIN input ON input.video_id = rv.video_id
      ORDER BY rv.updated_at DESC
      LIMIT 1
    )
    SELECT display.title AS display_title,
      display.channel_id AS display_channel_id,
      display.channel_title AS display_channel_title,
      downloads.video_id AS download_video_id,
      downloads.title AS download_title,
      downloads.channel_title AS download_channel_title,
      downloads.thumbnail AS download_thumbnail,
      downloads.status AS download_status,
      downloads.total_bytes AS download_total_bytes,
      downloads.downloaded_bytes AS download_downloaded_bytes,
      downloads.created_at AS download_created_at,
      COALESCE((SELECT json_group_array(tag) FROM tags
        WHERE user_id = input.user_id AND video_id = input.video_id), '[]') AS tags_json,
      COALESCE(rating.rating, 0) AS rating,
      CASE WHEN input.include_watch_time = 1 THEN watch.last_position ELSE NULL END AS last_position,
      CASE WHEN input.include_watch_time = 1 THEN watch.duration ELSE NULL END AS watch_duration,
      duration.live_status AS live_status
    FROM input
    LEFT JOIN display ON 1 = 1
    LEFT JOIN downloads ON downloads.video_id = input.video_id
    LEFT JOIN video_ratings rating
      ON rating.user_id = input.user_id AND rating.video_id = input.video_id
    LEFT JOIN watch_time watch
      ON watch.user_id = input.user_id AND watch.video_id = input.video_id
    LEFT JOIN video_durations duration ON duration.video_id = input.video_id`),
  setVideoTags: db.prepare("UPDATE video_durations SET tags = ? WHERE video_id = ?"),
  setVideoDescription: db.prepare("UPDATE video_durations SET description = ? WHERE video_id = ?"),
  upsertWatchTime: db.prepare(`INSERT INTO watch_time (user_id, video_id, last_position, duration, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(user_id, video_id) DO UPDATE SET last_position=excluded.last_position, duration=excluded.duration, updated_at=datetime('now')`),
  getWatchTime: db.prepare('SELECT last_position, duration FROM watch_time WHERE user_id = ? AND video_id = ?'),
  getAllWatchTimesForUser: db.prepare('SELECT video_id, last_position, duration, updated_at FROM watch_time WHERE user_id = ?'),
  getExploreWatchTimes: db.prepare(`SELECT wt.video_id, wt.last_position, wt.duration, wt.updated_at,
      MAX(CASE WHEN s.channel_id IS NOT NULL THEN rv.channel_id END) AS channel_id,
      MAX(CASE WHEN s.channel_id IS NOT NULL THEN rv.title END) AS title,
      MAX(CASE WHEN s.channel_id IS NOT NULL THEN rv.published_at END) AS published_at
    FROM watch_time wt
    LEFT JOIN rss_videos rv ON rv.video_id = wt.video_id
    LEFT JOIN subscriptions s ON s.user_id = wt.user_id AND s.channel_id = rv.channel_id
    WHERE wt.user_id = ? AND wt.updated_at > datetime('now', '-' || ? || ' days')
    GROUP BY wt.video_id, wt.last_position, wt.duration, wt.updated_at
    ORDER BY wt.updated_at DESC LIMIT ?`),
  getAllTaggedVideoIds: db.prepare('SELECT DISTINCT video_id FROM tags WHERE user_id = ?'),
  upsertRelated: db.prepare(`INSERT INTO related_videos (source_video_id, video_id, title, channel_title, channel_id, published_text, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(source_video_id, video_id) DO UPDATE SET title=excluded.title, channel_title=excluded.channel_title, channel_id=excluded.channel_id, published_text=excluded.published_text, updated_at=datetime('now')`),
  pruneRelated: db.prepare(`DELETE FROM related_videos WHERE rowid IN (
    SELECT rowid FROM related_videos
    WHERE updated_at < datetime('now', '-' || ? || ' days')
    ORDER BY updated_at LIMIT ?
  )`),
  dismissVideo: db.prepare('INSERT OR IGNORE INTO dismissals (user_id, video_id, channel_id) VALUES (?, ?, ?)'),
  getDismissalCountByChannel: db.prepare("SELECT COUNT(*) AS cnt FROM dismissals WHERE user_id = ? AND channel_id = ? AND channel_id != ''"),
  undismissVideo: db.prepare('DELETE FROM dismissals WHERE user_id = ? AND video_id = ?'),
  getDismissedVideoIds: db.prepare('SELECT video_id FROM dismissals WHERE user_id = ?'),
  boostChannel: db.prepare('INSERT OR IGNORE INTO channel_boosts (user_id, channel_id) VALUES (?, ?)'),
  unboostChannel: db.prepare('DELETE FROM channel_boosts WHERE user_id = ? AND channel_id = ?'),
  getBoostedChannelIds: db.prepare('SELECT channel_id FROM channel_boosts WHERE user_id = ?'),
  queueVideo: db.prepare('INSERT OR IGNORE INTO watch_queue (user_id, video_id, title, channel_title, channel_id) VALUES (?, ?, ?, ?, ?)'),
  unqueueVideo: db.prepare('DELETE FROM watch_queue WHERE user_id = ? AND video_id = ?'),
  getQueuedVideos: db.prepare('SELECT video_id, title, channel_title, channel_id, created_at FROM watch_queue WHERE user_id = ? ORDER BY created_at DESC'),
  getQueuedVideosPage: db.prepare('SELECT video_id, title, channel_title, channel_id, created_at FROM watch_queue WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?'),
  getQueuedVideosCursorFirst: db.prepare('SELECT video_id, title, channel_title, channel_id, created_at FROM watch_queue WHERE user_id = ? ORDER BY created_at DESC, video_id ASC LIMIT ?'),
  getQueuedVideosCursorNext: db.prepare(`SELECT video_id, title, channel_title, channel_id, created_at FROM watch_queue
    WHERE user_id = ? AND (created_at < ? OR (created_at = ? AND video_id > ?))
    ORDER BY created_at DESC, video_id ASC LIMIT ?`),
  getQueuedVideosCursorPrevious: db.prepare(`SELECT video_id, title, channel_title, channel_id, created_at FROM watch_queue
    WHERE user_id = ? AND (created_at > ? OR (created_at = ? AND video_id < ?))
    ORDER BY created_at ASC, video_id DESC LIMIT ?`),
  countQueuedVideos: db.prepare('SELECT COUNT(*) AS total FROM watch_queue WHERE user_id = ?'),
  getQueuedVideoIds: db.prepare('SELECT video_id FROM watch_queue WHERE user_id = ?'),
  savePlaylist: db.prepare(`INSERT INTO saved_playlists (user_id, playlist_id, playlist_type, title, channel_title, channel_id, thumbnail_video_id, item_count_text, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(user_id, playlist_id) DO UPDATE SET playlist_type=excluded.playlist_type, title=excluded.title, channel_title=excluded.channel_title, channel_id=excluded.channel_id, thumbnail_video_id=excluded.thumbnail_video_id, item_count_text=excluded.item_count_text, updated_at=datetime('now')`),
  unsavePlaylist: db.prepare('DELETE FROM saved_playlists WHERE user_id = ? AND playlist_id = ?'),
  deleteLocalPlaylistItems: db.prepare('DELETE FROM local_playlist_items WHERE user_id = ? AND playlist_id = ?'),
  getSavedPlaylists: db.prepare('SELECT playlist_id, playlist_type, title, channel_title, channel_id, thumbnail_video_id, item_count_text, updated_at FROM saved_playlists WHERE user_id = ? ORDER BY updated_at DESC'),
  getSavedYoutubePlaylistIds: db.prepare("SELECT playlist_id FROM saved_playlists WHERE user_id = ? AND playlist_type = 'youtube' ORDER BY updated_at DESC LIMIT ?"),
  getSavedPlaylistsPage: db.prepare('SELECT playlist_id, playlist_type, title, channel_title, channel_id, thumbnail_video_id, item_count_text, updated_at FROM saved_playlists WHERE user_id = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?'),
  getSavedPlaylistsCursorFirst: db.prepare('SELECT playlist_id, playlist_type, title, channel_title, channel_id, thumbnail_video_id, item_count_text, updated_at FROM saved_playlists WHERE user_id = ? ORDER BY updated_at DESC, playlist_id ASC LIMIT ?'),
  getSavedPlaylistsCursorNext: db.prepare(`SELECT playlist_id, playlist_type, title, channel_title, channel_id, thumbnail_video_id, item_count_text, updated_at FROM saved_playlists
    WHERE user_id = ? AND (updated_at < ? OR (updated_at = ? AND playlist_id > ?))
    ORDER BY updated_at DESC, playlist_id ASC LIMIT ?`),
  getSavedPlaylistsCursorPrevious: db.prepare(`SELECT playlist_id, playlist_type, title, channel_title, channel_id, thumbnail_video_id, item_count_text, updated_at FROM saved_playlists
    WHERE user_id = ? AND (updated_at > ? OR (updated_at = ? AND playlist_id < ?))
    ORDER BY updated_at ASC, playlist_id DESC LIMIT ?`),
  countSavedPlaylists: db.prepare('SELECT COUNT(*) AS total FROM saved_playlists WHERE user_id = ?'),
  getSavedPlaylist: db.prepare('SELECT playlist_id, playlist_type, title, channel_title, channel_id, thumbnail_video_id, item_count_text, updated_at FROM saved_playlists WHERE user_id = ? AND playlist_id = ?'),
  getLocalPlaylistNextPosition: db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS pos FROM local_playlist_items WHERE user_id = ? AND playlist_id = ?'),
  addLocalPlaylistItem: db.prepare(`INSERT INTO local_playlist_items (user_id, playlist_id, video_id, title, channel_title, channel_id, position)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, playlist_id, video_id) DO UPDATE SET title=excluded.title, channel_title=excluded.channel_title, channel_id=excluded.channel_id`),
  removeLocalPlaylistItem: db.prepare('DELETE FROM local_playlist_items WHERE user_id = ? AND playlist_id = ? AND video_id = ?'),
  getLocalPlaylistItems: db.prepare('SELECT playlist_id, video_id, title, channel_title, channel_id, position, created_at FROM local_playlist_items WHERE user_id = ? AND playlist_id = ? ORDER BY position ASC, created_at ASC'),
  getLocalPlaylistItemsPage: db.prepare('SELECT playlist_id, video_id, title, channel_title, channel_id, position, created_at FROM local_playlist_items WHERE user_id = ? AND playlist_id = ? ORDER BY position ASC, created_at ASC LIMIT ? OFFSET ?'),
  getLocalPlaylistItemsCursorFirst: db.prepare('SELECT playlist_id, video_id, title, channel_title, channel_id, position, created_at FROM local_playlist_items WHERE user_id = ? AND playlist_id = ? ORDER BY position ASC, created_at ASC, video_id ASC LIMIT ?'),
  getLocalPlaylistItemsCursorNext: db.prepare(`SELECT playlist_id, video_id, title, channel_title, channel_id, position, created_at FROM local_playlist_items
    WHERE user_id = ? AND playlist_id = ? AND (position > ? OR (position = ? AND created_at > ?) OR (position = ? AND created_at = ? AND video_id > ?))
    ORDER BY position ASC, created_at ASC, video_id ASC LIMIT ?`),
  getLocalPlaylistItemsCursorPrevious: db.prepare(`SELECT playlist_id, video_id, title, channel_title, channel_id, position, created_at FROM local_playlist_items
    WHERE user_id = ? AND playlist_id = ? AND (position < ? OR (position = ? AND created_at < ?) OR (position = ? AND created_at = ? AND video_id < ?))
    ORDER BY position DESC, created_at DESC, video_id DESC LIMIT ?`),
  getLocalPlaylistSummary: db.prepare(`SELECT COUNT(*) AS total,
    COALESCE((SELECT video_id FROM local_playlist_items WHERE user_id = ? AND playlist_id = ? ORDER BY position ASC, created_at ASC LIMIT 1), '') AS thumbnail_video_id
    FROM local_playlist_items WHERE user_id = ? AND playlist_id = ?`),
  getLocalPlaylistItem: db.prepare('SELECT video_id, position FROM local_playlist_items WHERE user_id = ? AND playlist_id = ? AND video_id = ?'),
  getAdjacentLocalPlaylistItemUp: db.prepare('SELECT video_id, position FROM local_playlist_items WHERE user_id = ? AND playlist_id = ? AND position < ? ORDER BY position DESC LIMIT 1'),
  getAdjacentLocalPlaylistItemDown: db.prepare('SELECT video_id, position FROM local_playlist_items WHERE user_id = ? AND playlist_id = ? AND position > ? ORDER BY position ASC LIMIT 1'),
  setLocalPlaylistItemPosition: db.prepare('UPDATE local_playlist_items SET position = ? WHERE user_id = ? AND playlist_id = ? AND video_id = ?'),
  muteChannel: db.prepare('INSERT OR IGNORE INTO channel_mutes (user_id, channel_id) VALUES (?, ?)'),
  unmuteChannel: db.prepare('DELETE FROM channel_mutes WHERE user_id = ? AND channel_id = ?'),
  getMutedChannelIds: db.prepare('SELECT channel_id FROM channel_mutes WHERE user_id = ?'),
  logExploreImpression: db.prepare(`INSERT INTO explore_events (user_id, video_id, channel_id, event_type, impression_count, position, created_at)
    VALUES (?, ?, ?, 'impression', 1, ?, datetime('now'))
    ON CONFLICT(user_id, video_id, event_type) DO UPDATE SET impression_count = impression_count + 1, position = excluded.position, created_at = datetime('now')`),
  incrementExploreChannelImpressions: db.prepare(`INSERT INTO explore_channel_rollups(
      channel_id, total_impressions, updated_at
    ) VALUES (?, ?, datetime('now'))
    ON CONFLICT(channel_id) DO UPDATE SET
      total_impressions = total_impressions + excluded.total_impressions,
      updated_at = datetime('now')`),
  incrementExploreUserChannelImpressions: db.prepare(`INSERT INTO explore_user_channel_rollups(
      user_id, channel_id, impressions, updated_at
    ) VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(user_id, channel_id) DO UPDATE SET
      impressions = impressions + excluded.impressions,
      updated_at = datetime('now')`),
  logExploreClick: db.prepare(`INSERT INTO explore_events (user_id, video_id, channel_id, event_type, impression_count, created_at)
    VALUES (?, ?, ?, 'click', 1, datetime('now'))
    ON CONFLICT(user_id, video_id, event_type) DO UPDATE SET created_at = datetime('now')`),
  getExploreEventsForUser: db.prepare('SELECT video_id, channel_id, event_type, impression_count, position, created_at FROM explore_events WHERE user_id = ?'),
  pruneExploreEvents: db.prepare(`DELETE FROM explore_events WHERE rowid IN (
    SELECT rowid FROM explore_events
    WHERE created_at < datetime('now', '-' || ? || ' days')
    ORDER BY created_at LIMIT ?
  )`),
  rateVideo: db.prepare(`INSERT INTO video_ratings (user_id, video_id, rating)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id, video_id) DO UPDATE SET rating=excluded.rating, created_at=datetime('now')`),
  unrateVideo: db.prepare('DELETE FROM video_ratings WHERE user_id = ? AND video_id = ?'),
  getVideoRatings: db.prepare('SELECT video_id, rating FROM video_ratings WHERE user_id = ?'),
  startExploreSession: db.prepare(`INSERT OR IGNORE INTO explore_sessions (user_id, session_id) VALUES (?, ?)`),
  updateExploreSession: db.prepare(`UPDATE explore_sessions SET clicks = ?, total_watch_seconds = ?, best_completion = ? WHERE user_id = ? AND session_id = ?`),
  getRecentExploreSessions: db.prepare(`SELECT session_id, clicks, total_watch_seconds, best_completion, started_at FROM explore_sessions WHERE user_id = ? ORDER BY started_at DESC LIMIT ?`),
  pruneExploreSessions: db.prepare(`DELETE FROM explore_sessions WHERE rowid IN (
    SELECT rowid FROM explore_sessions
    WHERE started_at < datetime('now', '-' || ? || ' days')
    ORDER BY started_at LIMIT ?
  )`),
  claimMaintenanceLease: db.prepare(`INSERT INTO maintenance_leases (name, expires_at)
    VALUES (?, datetime('now', '+' || ? || ' seconds'))
    ON CONFLICT(name) DO UPDATE SET expires_at=excluded.expires_at
    WHERE maintenance_leases.expires_at <= datetime('now')`),
  logExploreBounce: db.prepare(`INSERT INTO explore_events (user_id, video_id, channel_id, event_type, bounce_seconds, created_at)
    VALUES (?, ?, ?, 'bounce', ?, datetime('now'))
    ON CONFLICT(user_id, video_id, event_type) DO UPDATE SET bounce_seconds = excluded.bounce_seconds, created_at = datetime('now')`),
  getExploreBounces: db.prepare("SELECT video_id, channel_id, bounce_seconds FROM explore_events WHERE user_id = ? AND event_type = 'bounce'"),
  logExploreReturn: db.prepare(`INSERT INTO explore_events (user_id, video_id, channel_id, event_type, impression_count, created_at)
    VALUES (?, ?, ?, 'return', 1, datetime('now'))
    ON CONFLICT(user_id, video_id, event_type) DO UPDATE SET impression_count = impression_count + 1, created_at = datetime('now')`),
  getExploreReturnChannels: db.prepare(`SELECT channel_id, SUM(impression_count) AS cnt FROM explore_events
    WHERE user_id = ? AND event_type = 'return' AND created_at > datetime('now', '-1 day')
    GROUP BY channel_id`),
  setTopicFilter: db.prepare(`INSERT INTO topic_filters (user_id, topic, filter) VALUES (?, ?, ?)
    ON CONFLICT(user_id, topic) DO UPDATE SET filter = excluded.filter`),
  removeTopicFilter: db.prepare('DELETE FROM topic_filters WHERE user_id = ? AND topic = ?'),
  getTopicFilters: db.prepare('SELECT topic, filter FROM topic_filters WHERE user_id = ?'),
};

function writeNormalizedRssRows(channelId: string, data: import('./types.js').RSSData) {
  const items = rankedRssItems(data);
  for (const [index, item] of items.entries()) {
    stmts.upsertRssVideo.run(
      channelId,
      item.videoId,
      item.title || '',
      item.publishedAt || '',
      index + 1,
    );
  }
  stmts.deleteStaleRssVideos.run(channelId, JSON.stringify(items.map(item => item.videoId)));
  const stats = calculateRssChannelStats(channelId, data);
  stmts.upsertRssChannelStats.run(
    stats.channel_id, stats.video_count, stats.newest_published_at, stats.median_interval_ms,
  );
}

const replaceRssCache = db.transaction((
  channelId: string,
  data: import('./types.js').RSSData,
  validators: import('./types.js').RSSCacheValidators = {},
) => {
  stmts.upsertRssCache.run(
    channelId,
    JSON.stringify(data),
    validators.etag || '',
    validators.lastModified || '',
  );
  writeNormalizedRssRows(channelId, data);
});

const sqliteReadWorker = createSqliteReadWorker(databasePath);
const allowSynchronousHeavyReads = sqliteReadWorker === null && process.env.NODE_ENV !== 'production';

function normalizeTag(raw) {
  const t = raw.replace(/^#/, '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 30);
  return t || null;
}

function subscriptionFtsQuery(raw: string) {
  const terms = String(raw || '').normalize('NFKC').match(/[\p{L}\p{N}_]+/gu) || [];
  return terms.slice(0, 12).map(term => `"${term.replace(/"/g, '""')}"*`).join(' AND ');
}

// Migrate data/subscriptions.json → DB on startup (one-time)
(function migrateSubsJson() {
  const subsFile = path.join(dataDir, 'subscriptions.json');
  try {
    if (!fs.existsSync(subsFile)) return;
    const all = JSON.parse(fs.readFileSync(subsFile, 'utf8')) as Record<string, Array<{ channelId: string; title?: string; thumbnail?: string; description?: string }>>;
    const insert = db.transaction(() => {
      for (const [userId, subs] of Object.entries(all)) {
        for (const s of subs) {
          stmts.upsertSub.run(userId, s.channelId, s.title || '', normalizeThumbnail(s.thumbnail), s.description || '');
        }
      }
    });
    insert();
    fs.renameSync(subsFile, subsFile + '.migrated');
    console.log('Migrated subscriptions.json → SQLite');
  } catch {}
})();

api = {
  addTag(userId, videoId, rawTag) {
    const tag = normalizeTag(rawTag);
    if (!tag) return { ok: false, error: 'Invalid tag' };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- better-sqlite3 returns unknown
    const existing = stmts.getForVideo.all(userId, videoId) as any[];
    if (existing.length >= 20) return { ok: false, error: 'Max 20 tags per video' };
    stmts.add.run(userId, videoId, tag);
    return { ok: true, tag };
  },
  removeTag(userId, videoId, rawTag) {
    const tag = normalizeTag(rawTag);
    if (!tag) return { ok: false, error: 'Invalid tag' };
    stmts.remove.run(userId, videoId, tag);
    return { ok: true };
  },
  getTags(userId, videoId) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- better-sqlite3 returns unknown
    return (stmts.getForVideo.all(userId, videoId) as any[]).map((r: any) => r.tag);
  },
  upsertSubscriptions(userId, subs, { fullSync = false } = {}) {
    const run = db.transaction(() => {
      for (const s of subs) {
        stmts.upsertSub.run(userId, s.channelId, s.title || '', normalizeThumbnail(s.thumbnail), s.description || '');
      }
      // When fullSync is true, remove subscriptions not in the fresh list
      if (fullSync && subs.length > 0) {
        const keep = new Set(subs.map(s => s.channelId));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- better-sqlite3 returns unknown
        const existing: any[] = stmts.getSubs.all(userId);
        for (const row of existing) {
          if (!keep.has(row.channelId)) {
            stmts.deleteSub.run(userId, row.channelId);
          }
        }
      }
    });
    run();
  },
  getSubscriptions(userId) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- better-sqlite3 returns unknown
    return stmts.getSubs.all(userId) as any[];
  },
  searchSubscriptions(userId, query, limit, offset) {
    const boundedLimit = Math.min(100, Math.max(1, Number(limit) || 20));
    const boundedOffset = Math.max(0, Number(offset) || 0);
    const totalResults = Number(
      (stmts.countSearchSubs.get(userId, query) as { total: number }).total || 0
    );
    const items = stmts.searchSubs.all(
      userId, query, boundedLimit, boundedOffset
    ) as import('./types.js').Subscription[];
    return { items, totalResults };
  },
  getSubscriptionsCursorPage(userId, query, limit, cursor, direction) {
    const boundedLimit = Math.min(100, Math.max(1, Number(limit) || 20));
    const requestedLimit = boundedLimit + 1;
    const normalizedQuery = String(query || '').trim().slice(0, 200);
    const ftsQuery = subscriptionFtsQuery(normalizedQuery);
    let rows: import('./types.js').Subscription[];
    if (normalizedQuery && !ftsQuery) return { items: [], hasMore: false };
    if (ftsQuery) {
      if (!cursor) rows = stmts.subscriptionSearchCursorFirst.all(ftsQuery, userId, requestedLimit) as import('./types.js').Subscription[];
      else if (direction === 'previous') {
        rows = stmts.subscriptionSearchCursorPrevious.all(
          ftsQuery, userId, cursor.title, cursor.title, cursor.channelId, requestedLimit,
        ) as import('./types.js').Subscription[];
      } else {
        rows = stmts.subscriptionSearchCursorNext.all(
          ftsQuery, userId, cursor.title, cursor.title, cursor.channelId, requestedLimit,
        ) as import('./types.js').Subscription[];
      }
    } else if (!cursor) {
      rows = stmts.subscriptionsCursorFirst.all(userId, requestedLimit) as import('./types.js').Subscription[];
    } else if (direction === 'previous') {
      rows = stmts.subscriptionsCursorPrevious.all(
        userId, cursor.title, cursor.title, cursor.channelId, requestedLimit,
      ) as import('./types.js').Subscription[];
    } else {
      rows = stmts.subscriptionsCursorNext.all(
        userId, cursor.title, cursor.title, cursor.channelId, requestedLimit,
      ) as import('./types.js').Subscription[];
    }
    const hasMore = rows.length > boundedLimit;
    if (hasMore) rows.pop();
    if (direction === 'previous') rows.reverse();
    return { items: rows, hasMore };
  },
  deleteSubscription(userId, channelId) {
    stmts.deleteSub.run(userId, channelId);
  },
  getRecentSubscriptionDates(userId, days) {
    const result = new Map<string, string>();
    const rows = db.prepare(`SELECT channel_id, updated_at FROM subscriptions
      WHERE user_id = ? AND updated_at > datetime('now', '-' || ? || ' days')`).all(userId, days) as Array<{
        channel_id: string;
        updated_at: string;
      }>;
    for (const row of rows) result.set(row.channel_id, row.updated_at);
    return result;
  },
  upsertChannel(channelId, title, thumbnail) {
    stmts.upsertChannel.run(channelId, title || '', normalizeThumbnail(thumbnail));
  },
  getChannel(channelId) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- better-sqlite3 returns unknown
    return (stmts.getChannel.get(channelId) as any) || null;
  },
  getSubByChannel(channelId) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- better-sqlite3 returns unknown
    return (stmts.getSubByChannel.get(channelId) as any) || null;
  },
  getRssCache(channelId) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- better-sqlite3 returns unknown
    const row: any = stmts.getRssCache.get(channelId);
    if (!row) return null;
    try {
      return {
        data: JSON.parse(row.data),
        fetchedAt: row.fetched_at,
        validators: { etag: row.etag || '', lastModified: row.last_modified || '' },
      };
    } catch { return null; }
  },
  setRssCache(channelId, data, validators = {}) {
    replaceRssCache(channelId, data, validators);
  },
  touchRssCache(channelId, validators = {}) {
    stmts.touchRssCache.run(
      validators.etag || '', validators.etag || '',
      validators.lastModified || '', validators.lastModified || '',
      channelId,
    );
  },
  backfillLegacyRssBatch(limit) {
    const boundedLimit = Math.min(1_000, Math.max(1, Math.floor(Number(limit) || 100)));
    const rows = stmts.getLegacyRssBackfillBatch.all(boundedLimit) as Array<{
      channel_id: string;
      data: string;
    }>;
    const backfill = db.transaction(() => {
      for (const row of rows) {
        try {
          writeNormalizedRssRows(row.channel_id, JSON.parse(row.data));
        } catch {
          // Mark malformed legacy rows as inspected so one bad cache entry
          // cannot stall every later migration batch.
          stmts.upsertRssChannelStats.run(row.channel_id, 0, '', 0);
        }
      }
    });
    backfill();
    return rows.length;
  },
  getAllRssCacheForUser(userId) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- better-sqlite3 returns unknown
    return stmts.getAllRssCacheForUser.all(userId) as any[];
  },
  async getRssVideosForUser(userId, publishedAfter, perChannelLimit, limit) {
    const args = { userId, publishedAfter, perChannelLimit, limit };
    if (allowSynchronousHeavyReads) return querySqliteRssVideosForUser(db, args);
    const workerResult = await sqliteReadWorker?.queryRssVideos(args);
    if (workerResult?.status === 'success') return workerResult.value;
    // Do not duplicate a timed-out worker query on Express's event loop. Today
    // catches this signal and retains its stale snapshot instead.
    throw new Error(`sqlite-rss-read-${workerResult?.status || 'disabled'}`);
  },
  async getRssVideosPageForUser(userId, publishedAfter, perChannelLimit, limit, offset) {
    const args = { userId, publishedAfter, perChannelLimit, limit, offset };
    if (allowSynchronousHeavyReads) return querySqliteRssVideosPageForUser(db, args);
    const workerResult = await sqliteReadWorker?.queryRssVideoPage(args);
    if (workerResult?.status === 'success') return workerResult.value;
    throw new Error(`sqlite-rss-page-read-${workerResult?.status || 'disabled'}`);
  },
  async getRssVideosCursorPageForUser(userId, publishedAfter, perChannelLimit, limit, cursor, direction) {
    const args = { userId, publishedAfter, perChannelLimit, limit, cursor, direction };
    if (allowSynchronousHeavyReads) return querySqliteRssVideosCursorPageForUser(db, args);
    const workerResult = await sqliteReadWorker?.queryRssVideoCursorPage(args);
    if (workerResult?.status === 'success') return workerResult.value;
    throw new Error(`sqlite-rss-cursor-page-read-${workerResult?.status || 'disabled'}`);
  },
  async getExploreRssSnapshotForUser(userId, perChannelLimit, candidateLimit, watchMaxAgeDays, deepCutBefore) {
    const args = { userId, perChannelLimit, candidateLimit, watchMaxAgeDays, deepCutBefore };
    if (allowSynchronousHeavyReads) return querySqliteExploreRssSnapshot(db, args);
    const workerResult = await sqliteReadWorker?.queryExploreRssSnapshot(args);
    if (workerResult?.status === 'success') return workerResult.value;
    // Do not replay a timed-out heavy query on the Express event loop.
    throw new Error(`sqlite-explore-rss-snapshot-read-${workerResult?.status || 'disabled'}`);
  },
  getStaleRssRefreshCandidatesForUser(userId, staleBefore, limit) {
    return stmts.getStaleRssRefreshCandidates.all(
      userId, staleBefore, limit
    ) as import('./types.js').RSSRefreshCandidate[];
  },
  upsertDownload(videoId, title, channelTitle, thumbnail) {
    stmts.upsertDownload.run(videoId, title || '', channelTitle || '', thumbnail || '');
  },
  updateDownloadProgress(videoId, downloadedBytes, totalBytes) {
    stmts.updateDownloadProgress.run(downloadedBytes, totalBytes, videoId);
  },
  completeDownload(videoId) {
    stmts.completeDownload.run(videoId);
  },
  failDownload(videoId) {
    stmts.failDownload.run(videoId);
  },
  deleteDownload(videoId) {
    stmts.deleteDownload.run(videoId);
  },
  getDownload(videoId) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- better-sqlite3 returns unknown
    return (stmts.getDownload.get(videoId) as any) || null;
  },
  getAllDownloads() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- better-sqlite3 returns unknown
    return stmts.getAllDownloads.all() as any[];
  },
  getDownloadsPage(limit, offset) {
    const boundedLimit = Math.min(100, Math.max(1, Number(limit) || 40));
    const boundedOffset = Math.max(0, Number(offset) || 0);
    const totalResults = Number((stmts.countDownloads.get() as { total: number }).total || 0);
    return { items: stmts.getDownloadsPage.all(boundedLimit, boundedOffset) as Download[], totalResults };
  },
  getDownloadsCursorPage(limit, cursor, direction) {
    const boundedLimit = Math.min(100, Math.max(1, Number(limit) || 40));
    let rows: Download[];
    if (!cursor) rows = stmts.getDownloadsCursorFirst.all(boundedLimit + 1) as Download[];
    else rows = (direction === 'previous'
      ? stmts.getDownloadsCursorPrevious.all(cursor.timestamp, cursor.timestamp, cursor.id, boundedLimit + 1)
      : stmts.getDownloadsCursorNext.all(cursor.timestamp, cursor.timestamp, cursor.id, boundedLimit + 1)) as Download[];
    const hasMore = rows.length > boundedLimit;
    const items = rows.slice(0, boundedLimit);
    if (direction === 'previous' && cursor) items.reverse();
    return { items, hasMore };
  },
  getDownloadStorageUsage() {
    const row = stmts.getDownloadStorageUsage.get() as { stored_bytes?: number; mutation_version?: number } | undefined;
    return { storedBytes: Number(row?.stored_bytes || 0), version: Number(row?.mutation_version || 0) };
  },
  adjustDownloadStorageBytes(deltaBytes) {
    const row = stmts.adjustDownloadStorageBytes.get(Math.trunc(Number(deltaBytes) || 0)) as { stored_bytes?: number } | undefined;
    return Number(row?.stored_bytes || 0);
  },
  reconcileDownloadStorageBytes(storedBytes, expectedVersion) {
    return stmts.reconcileDownloadStorageBytes.run(
      Math.max(0, Math.trunc(Number(storedBytes) || 0)),
      Math.max(0, Math.trunc(Number(expectedVersion) || 0)),
    ).changes > 0;
  },
  setDuration(videoId, duration, liveStatus) {
    stmts.upsertDuration.run(videoId, duration, liveStatus || 'not_live');
  },
  getDuration(videoId) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- better-sqlite3 returns unknown
    const row: any = stmts.getDuration.get(videoId);
    return row ? row.duration : null;
  },
  getLiveStatus(videoId) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- better-sqlite3 returns unknown
    const row: any = stmts.getDuration.get(videoId);
    return row ? row.live_status || 'not_live' : null;
  },
  getVideoDisplayMetadata(videoId) {
    return (stmts.getVideoDisplayMetadata.get(videoId) as {
      title: string; channelTitle: string; channelId: string;
    } | undefined) || null;
  },
  getPlayerBootstrapData(userId, videoId, includeWatchTime) {
    const row = stmts.getPlayerBootstrapData.get(userId, videoId, includeWatchTime ? 1 : 0) as {
      display_title: string | null;
      display_channel_id: string | null;
      display_channel_title: string | null;
      download_video_id: string | null;
      download_title: string | null;
      download_channel_title: string | null;
      download_thumbnail: string | null;
      download_status: Download['status'] | null;
      download_total_bytes: number | null;
      download_downloaded_bytes: number | null;
      download_created_at: string | null;
      tags_json: string;
      rating: number;
      last_position: number | null;
      watch_duration: number | null;
      live_status: string | null;
    };
    let tags: string[] = [];
    try {
      const parsed = JSON.parse(row.tags_json || '[]');
      if (Array.isArray(parsed)) tags = parsed.filter((tag): tag is string => typeof tag === 'string');
    } catch {
      // A malformed legacy row should not prevent the player from rendering.
    }
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
          status: row.download_status,
          total_bytes: Number(row.download_total_bytes) || 0,
          downloaded_bytes: Number(row.download_downloaded_bytes) || 0,
          created_at: row.download_created_at || '',
        }
      : null;
    return {
      display,
      download,
      tags,
      rating: Number(row.rating) || 0,
      watchTime: includeWatchTime && row.last_position !== null
        ? { last_position: Number(row.last_position) || 0, duration: Number(row.watch_duration) || 0 }
        : null,
      liveStatus: row.live_status || null,
    } satisfies PlayerBootstrapData;
  },
  getDurations(videoIds) {
    if (!videoIds.length) return {};
    const placeholders = videoIds.map(() => '?').join(',');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- better-sqlite3 returns unknown
    const rows: any[] = db.prepare(`SELECT video_id, duration, live_status FROM video_durations WHERE video_id IN (${placeholders})`).all(...videoIds);
    const result = {};
    for (const r of rows) result[r.video_id] = r.duration;
    return result;
  },
  getLiveStatuses(videoIds) {
    if (!videoIds.length) return {};
    const placeholders = videoIds.map(() => '?').join(',');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- better-sqlite3 returns unknown
    const rows: any[] = db.prepare(`SELECT video_id, live_status FROM video_durations WHERE video_id IN (${placeholders})`).all(...videoIds);
    const result = {};
    for (const r of rows) result[r.video_id] = r.live_status || 'not_live';
    return result;
  },
  getDurationsAndLiveStatuses(videoIds) {
    if (!videoIds.length) return { durations: {}, liveStatuses: {} };
    const placeholders = videoIds.map(() => '?').join(',');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- better-sqlite3 returns unknown
    const rows: any[] = db.prepare(`SELECT video_id, duration, live_status FROM video_durations WHERE video_id IN (${placeholders})`).all(...videoIds);
    const durations = {};
    const liveStatuses = {};
    for (const r of rows) {
      durations[r.video_id] = r.duration;
      liveStatuses[r.video_id] = r.live_status || 'not_live';
    }
    return { durations, liveStatuses };
  },
  setWatchTime(userId, videoId, position, duration) {
    stmts.upsertWatchTime.run(userId, videoId, position, duration);
  },
  getWatchTime(userId, videoId) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- better-sqlite3 returns unknown
    return (stmts.getWatchTime.get(userId, videoId) as any) || null;
  },
  getWatchTimes(userId, videoIds) {
    if (!videoIds.length) return {};
    const placeholders = videoIds.map(() => '?').join(',');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- better-sqlite3 returns unknown
    const rows: any[] = db.prepare(`SELECT video_id, last_position, duration FROM watch_time WHERE user_id = ? AND video_id IN (${placeholders})`).all(userId, ...videoIds);
    const result = {};
    for (const r of rows) result[r.video_id] = { last_position: r.last_position, duration: r.duration };
    return result;
  },
  getAllWatchTimesForUser(userId) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- better-sqlite3 returns unknown
    return stmts.getAllWatchTimesForUser.all(userId) as any[];
  },
  getExploreWatchTimes(userId, maxAgeDays, limit) {
    return stmts.getExploreWatchTimes.all(userId, maxAgeDays, limit) as Array<{
      video_id: string; last_position: number; duration: number; updated_at: string;
      channel_id: string | null; title: string | null; published_at: string | null;
    }>;
  },
  getAllTaggedVideoIds(userId) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- better-sqlite3 returns unknown
    return (stmts.getAllTaggedVideoIds.all(userId) as any[]).map((r: any) => r.video_id);
  },
  upsertRelatedVideos(sourceVideoId, videos) {
    const run = db.transaction(() => {
      for (const v of videos) {
        stmts.upsertRelated.run(sourceVideoId, v.videoId, v.title, v.channelTitle, v.channelId, v.publishedText);
      }
    });
    run();
  },
  getRelatedVideosForSources(sourceVideoIds) {
    if (!sourceVideoIds.length) return [];
    const placeholders = sourceVideoIds.map(() => '?').join(',');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- better-sqlite3 returns unknown
    return db.prepare(`SELECT source_video_id, video_id, title, channel_title, channel_id, published_text FROM related_videos WHERE source_video_id IN (${placeholders})`).all(...sourceVideoIds) as any[];
  },
  pruneRelatedVideos(maxAgeDays, limit = 1000) {
    return stmts.pruneRelated.run(maxAgeDays, Math.min(10_000, Math.max(1, Number(limit) || 1000))).changes;
  },
  dismissVideo(userId, videoId, channelId) {
    stmts.dismissVideo.run(userId, videoId, channelId || '');
  },
  undismissVideo(userId, videoId) {
    stmts.undismissVideo.run(userId, videoId);
  },
  getDismissedVideoIds(userId) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- better-sqlite3 returns unknown
    return (stmts.getDismissedVideoIds.all(userId) as any[]).map((r: any) => r.video_id);
  },
  getDismissalCountByChannel(userId, channelId) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- better-sqlite3 returns unknown
    return (stmts.getDismissalCountByChannel.get(userId, channelId) as any).cnt;
  },
  boostChannel(userId, channelId) {
    stmts.boostChannel.run(userId, channelId);
  },
  unboostChannel(userId, channelId) {
    stmts.unboostChannel.run(userId, channelId);
  },
  getBoostedChannelIds(userId) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- better-sqlite3 returns unknown
    return (stmts.getBoostedChannelIds.all(userId) as any[]).map((r: any) => r.channel_id);
  },
  queueVideo(userId, videoId, title, channelTitle, channelId) {
    stmts.queueVideo.run(userId, videoId, title, channelTitle, channelId);
  },
  unqueueVideo(userId, videoId) {
    stmts.unqueueVideo.run(userId, videoId);
  },
  getQueuedVideos(userId) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- better-sqlite3 returns unknown
    return stmts.getQueuedVideos.all(userId) as any[];
  },
  getQueuedVideosPage(userId, limit, offset) {
    const boundedLimit = Math.min(100, Math.max(1, Number(limit) || 40));
    const boundedOffset = Math.max(0, Number(offset) || 0);
    const totalResults = Number((stmts.countQueuedVideos.get(userId) as { total: number }).total || 0);
    return {
      items: stmts.getQueuedVideosPage.all(userId, boundedLimit, boundedOffset) as Array<{
        video_id: string; title: string; channel_title: string; channel_id: string; created_at: string;
      }>,
      totalResults,
    };
  },
  getQueuedVideosCursorPage(userId, limit, cursor, direction) {
    const boundedLimit = Math.min(100, Math.max(1, Number(limit) || 40));
    type QueueRow = { video_id: string; title: string; channel_title: string; channel_id: string; created_at: string };
    let rows: QueueRow[];
    if (!cursor) rows = stmts.getQueuedVideosCursorFirst.all(userId, boundedLimit + 1) as QueueRow[];
    else rows = (direction === 'previous'
      ? stmts.getQueuedVideosCursorPrevious.all(userId, cursor.timestamp, cursor.timestamp, cursor.id, boundedLimit + 1)
      : stmts.getQueuedVideosCursorNext.all(userId, cursor.timestamp, cursor.timestamp, cursor.id, boundedLimit + 1)) as QueueRow[];
    const hasMore = rows.length > boundedLimit;
    const items = rows.slice(0, boundedLimit);
    if (direction === 'previous' && cursor) items.reverse();
    return { items, hasMore };
  },
  getQueuedVideoIds(userId) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- better-sqlite3 returns unknown
    return (stmts.getQueuedVideoIds.all(userId) as any[]).map((r: any) => r.video_id);
  },
  savePlaylist(userId, playlistId, title, channelTitle, channelId, thumbnailVideoId, itemCountText, playlistType) {
    stmts.savePlaylist.run(userId, playlistId, playlistType || 'youtube', title || '', channelTitle || '', channelId || '', thumbnailVideoId || '', itemCountText || '');
  },
  unsavePlaylist(userId, playlistId) {
    const run = db.transaction(() => {
      stmts.unsavePlaylist.run(userId, playlistId);
      stmts.deleteLocalPlaylistItems.run(userId, playlistId);
    });
    run();
  },
  getSavedPlaylists(userId) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- better-sqlite3 returns unknown
    return stmts.getSavedPlaylists.all(userId) as any[];
  },
  getSavedYoutubePlaylistIds(userId, limit) {
    const boundedLimit = Math.min(100, Math.max(1, Number(limit) || 20));
    return (stmts.getSavedYoutubePlaylistIds.all(userId, boundedLimit) as Array<{ playlist_id: string }>)
      .map(row => row.playlist_id);
  },
  getSavedPlaylistsPage(userId, limit, offset) {
    const boundedLimit = Math.min(100, Math.max(1, Number(limit) || 40));
    const boundedOffset = Math.max(0, Number(offset) || 0);
    const totalResults = Number((stmts.countSavedPlaylists.get(userId) as { total: number }).total || 0);
    return { items: stmts.getSavedPlaylistsPage.all(userId, boundedLimit, boundedOffset) as SavedPlaylist[], totalResults };
  },
  getSavedPlaylistsCursorPage(userId, limit, cursor, direction) {
    const boundedLimit = Math.min(100, Math.max(1, Number(limit) || 40));
    let rows: SavedPlaylist[];
    if (!cursor) rows = stmts.getSavedPlaylistsCursorFirst.all(userId, boundedLimit + 1) as SavedPlaylist[];
    else rows = (direction === 'previous'
      ? stmts.getSavedPlaylistsCursorPrevious.all(userId, cursor.timestamp, cursor.timestamp, cursor.id, boundedLimit + 1)
      : stmts.getSavedPlaylistsCursorNext.all(userId, cursor.timestamp, cursor.timestamp, cursor.id, boundedLimit + 1)) as SavedPlaylist[];
    const hasMore = rows.length > boundedLimit;
    const items = rows.slice(0, boundedLimit);
    if (direction === 'previous' && cursor) items.reverse();
    return { items, hasMore };
  },
  getSavedPlaylist(userId, playlistId) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- better-sqlite3 returns unknown
    return (stmts.getSavedPlaylist.get(userId, playlistId) as any) || null;
  },
  isPlaylistSaved(userId, playlistId) {
    return Boolean(stmts.getSavedPlaylist.get(userId, playlistId));
  },
  addLocalPlaylistItem(userId, playlistId, videoId, title, channelTitle, channelId) {
    const row = stmts.getLocalPlaylistNextPosition.get(userId, playlistId) as { pos?: number } | undefined;
    stmts.addLocalPlaylistItem.run(userId, playlistId, videoId, title || '', channelTitle || '', channelId || '', row?.pos || 1);
  },
  removeLocalPlaylistItem(userId, playlistId, videoId) {
    stmts.removeLocalPlaylistItem.run(userId, playlistId, videoId);
  },
  moveLocalPlaylistItem(userId, playlistId, videoId, direction) {
    const run = db.transaction(() => {
      const current = stmts.getLocalPlaylistItem.get(userId, playlistId, videoId) as { video_id: string; position: number } | undefined;
      if (!current) return;
      const adjacent = (direction === 'up'
        ? stmts.getAdjacentLocalPlaylistItemUp.get(userId, playlistId, current.position)
        : stmts.getAdjacentLocalPlaylistItemDown.get(userId, playlistId, current.position)) as { video_id: string; position: number } | undefined;
      if (!adjacent) return;
      stmts.setLocalPlaylistItemPosition.run(adjacent.position, userId, playlistId, current.video_id);
      stmts.setLocalPlaylistItemPosition.run(current.position, userId, playlistId, adjacent.video_id);
    });
    run();
  },
  getLocalPlaylistItems(userId, playlistId) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- better-sqlite3 returns unknown
    return stmts.getLocalPlaylistItems.all(userId, playlistId) as any[];
  },
  getLocalPlaylistItemsPage(userId, playlistId, limit, offset) {
    const boundedLimit = Math.min(100, Math.max(1, Number(limit) || 50));
    const boundedOffset = Math.max(0, Number(offset) || 0);
    const summary = stmts.getLocalPlaylistSummary.get(userId, playlistId, userId, playlistId) as { total: number };
    return {
      items: stmts.getLocalPlaylistItemsPage.all(userId, playlistId, boundedLimit, boundedOffset) as LocalPlaylistItem[],
      totalResults: Number(summary?.total || 0),
    };
  },
  getLocalPlaylistItemsCursorPage(userId, playlistId, limit, cursor, direction) {
    const boundedLimit = Math.min(100, Math.max(1, Number(limit) || 50));
    let rows: LocalPlaylistItem[];
    if (!cursor) rows = stmts.getLocalPlaylistItemsCursorFirst.all(userId, playlistId, boundedLimit + 1) as LocalPlaylistItem[];
    else {
      const args = [
        userId, playlistId,
        cursor.position, cursor.position, cursor.createdAt,
        cursor.position, cursor.createdAt, cursor.videoId,
        boundedLimit + 1,
      ];
      rows = (direction === 'previous'
        ? stmts.getLocalPlaylistItemsCursorPrevious.all(...args)
        : stmts.getLocalPlaylistItemsCursorNext.all(...args)) as LocalPlaylistItem[];
    }
    const hasMore = rows.length > boundedLimit;
    const items = rows.slice(0, boundedLimit);
    if (direction === 'previous' && cursor) items.reverse();
    return { items, hasMore };
  },
  getLocalPlaylistSummary(userId, playlistId) {
    const row = stmts.getLocalPlaylistSummary.get(userId, playlistId, userId, playlistId) as { total: number; thumbnail_video_id: string };
    return { totalResults: Number(row?.total || 0), thumbnailVideoId: row?.thumbnail_video_id || '' };
  },
  muteChannel(userId, channelId) {
    stmts.muteChannel.run(userId, channelId);
  },
  unmuteChannel(userId, channelId) {
    stmts.unmuteChannel.run(userId, channelId);
  },
  getMutedChannelIds(userId) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- better-sqlite3 returns unknown
    return (stmts.getMutedChannelIds.all(userId) as any[]).map((r: any) => r.channel_id);
  },
  rateVideo(userId, videoId, rating) {
    stmts.rateVideo.run(userId, videoId, rating);
  },
  unrateVideo(userId, videoId) {
    stmts.unrateVideo.run(userId, videoId);
  },
  getVideoRatings(userId) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- better-sqlite3 returns unknown
    return stmts.getVideoRatings.all(userId) as any[];
  },
  getVideoRating(userId, videoId) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- better-sqlite3 returns unknown
    const row = db.prepare('SELECT rating FROM video_ratings WHERE user_id = ? AND video_id = ?').get(userId, videoId) as any;
    return row ? row.rating : 0;
  },
  getCommunityRatings(videoIds, excludeUserId) {
    if (!videoIds.length) return {};
    const placeholders = videoIds.map(() => '?').join(',');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- better-sqlite3 returns unknown
    const rows: any[] = db.prepare(
      `SELECT video_id,
         SUM(CASE WHEN rating = 1 THEN 1 ELSE 0 END) AS up,
         SUM(CASE WHEN rating = -1 THEN 1 ELSE 0 END) AS down
       FROM video_ratings
       WHERE video_id IN (${placeholders}) AND user_id != ?
       GROUP BY video_id`
    ).all(...videoIds, excludeUserId);
    const result = {};
    for (const r of rows) result[r.video_id] = { up: r.up, down: r.down };
    return result;
  },
  setTopicFilter(userId, topic, filter) { stmts.setTopicFilter.run(userId, topic, filter); },
  removeTopicFilter(userId, topic) { stmts.removeTopicFilter.run(userId, topic); },
  getTopicFilters(userId) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- better-sqlite3 returns unknown
    return stmts.getTopicFilters.all(userId) as any[];
  },
  startExploreSession(userId, sessionId) {
    stmts.startExploreSession.run(userId, sessionId);
  },
  updateExploreSession(userId, sessionId, clicks, totalWatchSeconds, bestCompletion) {
    stmts.updateExploreSession.run(clicks, totalWatchSeconds, bestCompletion, userId, sessionId);
  },
  getRecentExploreSessions(userId, limit) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- better-sqlite3 returns unknown
    return stmts.getRecentExploreSessions.all(userId, limit) as any[];
  },
  getExploreSessionsForBackfill(userId) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- better-sqlite3 returns unknown
    const rows: any[] = db.prepare(
      `WITH recent_sessions AS (
         SELECT session_id, clicks, total_watch_seconds, best_completion, started_at
         FROM explore_sessions
         WHERE user_id = ? AND clicks > 0 AND started_at > datetime('now', '-1 day')
         ORDER BY started_at DESC LIMIT 50
       )
       SELECT sessions.session_id, sessions.clicks, sessions.total_watch_seconds,
         sessions.best_completion, sessions.started_at,
         MAX(CASE WHEN wt.duration > 0 THEN
           CASE WHEN wt.last_position = 0 THEN 1.0
                ELSE MIN(1.0, CAST(wt.last_position AS REAL) / wt.duration) END
           ELSE sessions.best_completion END) AS observed_best_completion
       FROM recent_sessions sessions
       LEFT JOIN watch_time wt ON wt.user_id = ? AND wt.updated_at >= sessions.started_at
       GROUP BY sessions.session_id, sessions.clicks, sessions.total_watch_seconds,
         sessions.best_completion, sessions.started_at
       ORDER BY sessions.started_at DESC`
    ).all(userId, userId);
    return rows;
  },
  pruneExploreSessions(maxAgeDays, limit = 1000) {
    return stmts.pruneExploreSessions.run(maxAgeDays, Math.min(10_000, Math.max(1, Number(limit) || 1000))).changes;
  },
  logExploreBounce(userId, videoId, channelId, bounceSeconds) {
    stmts.logExploreBounce.run(userId, videoId, channelId, bounceSeconds);
  },
  getExploreBounces(userId, maxAgeDays = 90) {
    return db.prepare(`SELECT video_id, channel_id, bounce_seconds FROM explore_events
      WHERE user_id = ? AND event_type = 'bounce'
        AND created_at > datetime('now', '-' || ? || ' days')`).all(userId, maxAgeDays) as Array<{
          video_id: string; channel_id: string; bounce_seconds: number;
        }>;
  },
  logExploreReturn(userId, videoId, channelId) {
    stmts.logExploreReturn.run(userId, videoId, channelId);
  },
  getExploreReturnChannels(userId) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- better-sqlite3 returns unknown
    const rows: any[] = stmts.getExploreReturnChannels.all(userId);
    const result: Record<string, number> = {};
    for (const r of rows) result[r.channel_id] = r.cnt;
    return result;
  },
  logExploreImpressions(userId, videos) {
    const run = db.transaction(() => {
      const channelDeltas = new Map<string, number>();
      for (const v of videos) {
        stmts.logExploreImpression.run(userId, v.videoId, v.channelId, v.position);
        channelDeltas.set(v.channelId, (channelDeltas.get(v.channelId) || 0) + 1);
      }
      for (const [channelId, delta] of channelDeltas) {
        stmts.incrementExploreChannelImpressions.run(channelId, delta);
        stmts.incrementExploreUserChannelImpressions.run(userId, channelId, delta);
      }
    });
    run();
  },
  logExploreClick(userId, videoId, channelId) {
    stmts.logExploreClick.run(userId, videoId, channelId);
  },
  getExploreEventsForUser(userId, maxAgeDays = 90) {
    return db.prepare(`SELECT video_id, channel_id, event_type, impression_count, position, created_at
      FROM explore_events
      WHERE user_id = ? AND created_at > datetime('now', '-' || ? || ' days')`).all(userId, maxAgeDays) as Array<{
        video_id: string; channel_id: string; event_type: string; impression_count: number;
        position: number; created_at: string;
      }>;
  },
  pruneExploreEvents(maxAgeDays, limit = 1000) {
    return stmts.pruneExploreEvents.run(maxAgeDays, Math.min(10_000, Math.max(1, Number(limit) || 1000))).changes;
  },
  getVideoPopularity(videoIds) {
    if (!videoIds.length) return {};
    const placeholders = videoIds.map(() => '?').join(',');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- better-sqlite3 returns unknown
    const rows: any[] = db.prepare(
      `SELECT video_id, COUNT(DISTINCT user_id) AS user_count FROM watch_time
       WHERE video_id IN (${placeholders}) AND duration > 0
         AND (last_position = 0 OR CAST(last_position AS REAL) / duration > 0.3)
       GROUP BY video_id`
    ).all(...videoIds);
    const result = {};
    for (const r of rows) result[r.video_id] = r.user_count;
    return result;
  },
  getRecentVideoPopularity(videoIds, withinHours) {
    if (!videoIds.length) return {};
    const placeholders = videoIds.map(() => '?').join(',');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- better-sqlite3 returns unknown
    const rows: any[] = db.prepare(
      `SELECT video_id, COUNT(DISTINCT user_id) AS user_count FROM watch_time
       WHERE video_id IN (${placeholders}) AND duration > 0
         AND (last_position = 0 OR CAST(last_position AS REAL) / duration > 0.3)
         AND updated_at > datetime('now', '-' || ? || ' hours')
       GROUP BY video_id`
    ).all(...videoIds, withinHours);
    const result = {};
    for (const r of rows) result[r.video_id] = r.user_count;
    return result;
  },
  getChannelSubscriberCounts(channelIds, excludeUserId) {
    if (!channelIds.length) return {};
    const placeholders = channelIds.map(() => '?').join(',');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- better-sqlite3 returns unknown
    const rows: any[] = db.prepare(
      `SELECT channel_id, COUNT(DISTINCT user_id) AS sub_count FROM subscriptions
       WHERE channel_id IN (${placeholders}) AND user_id != ?
       GROUP BY channel_id`
    ).all(...channelIds, excludeUserId);
    const result = {};
    for (const r of rows) result[r.channel_id] = r.sub_count;
    return result;
  },
  getChannelImpressionCounts(channelIds) {
    if (!channelIds.length) return {};
    const placeholders = channelIds.map(() => '?').join(',');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- better-sqlite3 returns unknown
    const rows: any[] = db.prepare(
      `SELECT channel_id, SUM(impression_count) AS total_impressions FROM explore_events
       WHERE channel_id IN (${placeholders}) AND event_type = 'impression'
       GROUP BY channel_id`
    ).all(...channelIds);
    const result = {};
    for (const r of rows) result[r.channel_id] = r.total_impressions;
    return result;
  },
  rebuildExploreSignalRollups(maxAgeDays = 90, perUserLimit = 50) {
    const boundedDays = Math.min(365, Math.max(7, Number(maxAgeDays) || 90));
    const boundedPerUser = Math.min(200, Math.max(5, Number(perUserLimit) || 50));
    const rebuild = db.transaction(() => {
      db.prepare('DELETE FROM explore_video_rollups').run();
      db.prepare(`INSERT INTO explore_video_rollups
          (video_id, engaged_users, rating_up, rating_down, updated_at)
        SELECT ids.video_id,
          COALESCE(w.engaged_users, 0), COALESCE(r.rating_up, 0), COALESCE(r.rating_down, 0), datetime('now')
        FROM (
          SELECT video_id FROM watch_time
          UNION SELECT video_id FROM video_ratings
        ) ids
        LEFT JOIN (
          SELECT video_id, COUNT(DISTINCT user_id) AS engaged_users
          FROM watch_time WHERE duration > 0
            AND (last_position = 0 OR CAST(last_position AS REAL) / duration > 0.3)
          GROUP BY video_id
        ) w ON w.video_id = ids.video_id
        LEFT JOIN (
          SELECT video_id,
            SUM(CASE WHEN rating = 1 THEN 1 ELSE 0 END) AS rating_up,
            SUM(CASE WHEN rating = -1 THEN 1 ELSE 0 END) AS rating_down
          FROM video_ratings GROUP BY video_id
        ) r ON r.video_id = ids.video_id`).run();

      db.prepare('DELETE FROM explore_channel_rollups').run();
      db.prepare(`INSERT INTO explore_channel_rollups
          (channel_id, subscriber_users, total_impressions, updated_at)
        SELECT ids.channel_id, COALESCE(s.subscriber_users, 0), COALESCE(e.total_impressions, 0), datetime('now')
        FROM (
          SELECT channel_id FROM subscriptions
          UNION SELECT channel_id FROM explore_events WHERE event_type = 'impression'
        ) ids
        LEFT JOIN (
          SELECT channel_id, COUNT(DISTINCT user_id) AS subscriber_users
          FROM subscriptions GROUP BY channel_id
        ) s ON s.channel_id = ids.channel_id
        LEFT JOIN (
          SELECT channel_id, SUM(impression_count) AS total_impressions
          FROM explore_events WHERE event_type = 'impression' GROUP BY channel_id
        ) e ON e.channel_id = ids.channel_id`).run();

      db.prepare('DELETE FROM explore_user_channel_rollups').run();
      db.prepare(`INSERT INTO explore_user_channel_rollups(
          user_id, channel_id, impressions, clicks, bounces, returns, last_return_at, updated_at
        )
        SELECT user_id, channel_id,
          SUM(CASE WHEN event_type = 'impression' THEN impression_count ELSE 0 END),
          SUM(CASE WHEN event_type = 'click' THEN 1 ELSE 0 END),
          SUM(CASE WHEN event_type = 'bounce' THEN 1 ELSE 0 END),
          SUM(CASE WHEN event_type = 'return' THEN impression_count ELSE 0 END),
          MAX(CASE WHEN event_type = 'return' THEN created_at ELSE NULL END),
          datetime('now')
        FROM explore_events
        GROUP BY user_id, channel_id`).run();

      db.prepare('DELETE FROM explore_cowatch_edges').run();
      db.prepare(`WITH recent AS (
          SELECT user_id, video_id, updated_at,
            ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY updated_at DESC, video_id) AS recent_rank
          FROM watch_time
          WHERE updated_at > datetime('now', '-' || ? || ' days')
            AND duration > 0
            AND (last_position = 0 OR CAST(last_position AS REAL) / duration > 0.3)
        )
        INSERT INTO explore_cowatch_edges(user_id, source_video_id, video_id, updated_at)
        SELECT source.user_id, source.video_id, related.video_id,
          MIN(source.updated_at, related.updated_at)
        FROM recent source
        JOIN recent related ON related.user_id = source.user_id AND related.video_id != source.video_id
        WHERE source.recent_rank <= ? AND related.recent_rank <= ?`).run(
          boundedDays, boundedPerUser, boundedPerUser,
        );
      const videos = Number((db.prepare('SELECT COUNT(*) AS count FROM explore_video_rollups').get() as { count: number }).count || 0);
      const channels = Number((db.prepare('SELECT COUNT(*) AS count FROM explore_channel_rollups').get() as { count: number }).count || 0);
      const cowatchEdges = Number((db.prepare('SELECT COUNT(*) AS count FROM explore_cowatch_edges').get() as { count: number }).count || 0);
      return { videos, channels, cowatchEdges };
    });
    return rebuild();
  },
  pruneExploreCowatchEdges(maxAgeDays, limit = 1000) {
    const boundedDays = Math.min(365, Math.max(7, Number(maxAgeDays) || 90));
    const boundedLimit = Math.min(10_000, Math.max(1, Number(limit) || 1000));
    return db.prepare(`DELETE FROM explore_cowatch_edges WHERE rowid IN (
      SELECT rowid FROM explore_cowatch_edges
      WHERE updated_at < datetime('now', '-' || ? || ' days')
      ORDER BY updated_at LIMIT ?
    )`).run(boundedDays, boundedLimit).changes;
  },
  setVideoTags(videoId, tags) {
    stmts.setVideoTags.run(JSON.stringify(tags), videoId);
  },
  getVideoTags(videoIds) {
    if (!videoIds.length) return {};
    const placeholders = videoIds.map(() => '?').join(',');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- better-sqlite3 returns unknown
    const rows: any[] = db.prepare(
      `SELECT video_id, tags FROM video_durations WHERE video_id IN (${placeholders}) AND tags != ''`
    ).all(...videoIds);
    const result: Record<string, string[]> = {};
    for (const r of rows) {
      try { result[r.video_id] = JSON.parse(r.tags); } catch { /* skip malformed */ }
    }
    return result;
  },
  setVideoDescription(videoId, description) {
    stmts.setVideoDescription.run(description, videoId);
  },
  getVideoDescriptions(videoIds) {
    if (!videoIds.length) return {};
    const placeholders = videoIds.map(() => '?').join(',');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- better-sqlite3 returns unknown
    const rows: any[] = db.prepare(
      `SELECT video_id, description FROM video_durations WHERE video_id IN (${placeholders}) AND description != ''`
    ).all(...videoIds);
    const result: Record<string, string> = {};
    for (const r of rows) result[r.video_id] = r.description;
    return result;
  },
  getVideoMetadata(videoIds) {
    if (!videoIds.length) return { durations: {}, liveStatuses: {}, tags: {}, descriptions: {} };
    const placeholders = videoIds.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT video_id, duration, live_status, tags, description
       FROM video_durations WHERE video_id IN (${placeholders})`
    ).all(...videoIds) as Array<{ video_id: string; duration: number; live_status: string; tags: string; description: string }>;
    const durations: Record<string, number> = {};
    const liveStatuses: Record<string, string> = {};
    const tags: Record<string, string[]> = {};
    const descriptions: Record<string, string> = {};
    for (const row of rows) {
      durations[row.video_id] = row.duration;
      liveStatuses[row.video_id] = row.live_status || 'not_live';
      if (row.tags) {
        try { tags[row.video_id] = JSON.parse(row.tags); } catch { /* skip malformed metadata */ }
      }
      if (row.description) descriptions[row.video_id] = row.description;
    }
    return { durations, liveStatuses, tags, descriptions };
  },
  async getExploreCandidateSignals(metadataVideoIds, richMetadataVideoIds, candidateVideoIds, candidateChannelIds, excludeUserId, recentWithinHours) {
    const args = {
      metadataVideoIds, richMetadataVideoIds, candidateVideoIds,
      candidateChannelIds, excludeUserId, recentWithinHours,
    };
    if (allowSynchronousHeavyReads) return querySqliteExploreCandidateSignals(db, args);
    const workerResult = await sqliteReadWorker?.queryCandidateSignals(args);
    return workerResult?.status === 'success' ? workerResult.value : emptyExploreCandidateSignals();
  },
  async getExploreUserSignals(userId, relevantVideoIds, relevantChannelIds, maxAgeDays = 90) {
    const args = {
      userId,
      relevantVideoIds: [...new Set(relevantVideoIds)].slice(0, 3_500),
      relevantChannelIds: [...new Set(relevantChannelIds)].slice(0, 2_500),
      maxAgeDays,
    };
    if (allowSynchronousHeavyReads) {
      return querySqliteExploreUserSignals(
        db,
        args.userId,
        args.relevantVideoIds,
        args.relevantChannelIds,
        args.maxAgeDays,
      );
    }
    const workerResult = await sqliteReadWorker?.queryUserSignals(args);
    return workerResult?.status === 'success' ? workerResult.value : emptyExploreUserSignals();
  },
  resetRecommendations(userId) {
    db.prepare('DELETE FROM watch_time WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM explore_events WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM explore_sessions WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM dismissals WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM channel_boosts WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM channel_mutes WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM video_ratings WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM topic_filters WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM watch_queue WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM tags WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM explore_user_channel_rollups WHERE user_id = ?').run(userId);
  },
  optimizeDatabase() {
    // 0x10000 asks the first maintenance run to consider every table even when
    // this connection has not queried it yet; later runs use SQLite's bounded
    // incremental recommendation. Unlike VACUUM, this does not rewrite the DB.
    db.pragma(sqliteOptimizeInitialized ? 'optimize' : 'optimize = 0x10002');
    sqliteOptimizeInitialized = true;
    return true;
  },
  claimMaintenanceLease(name, leaseSeconds) {
    const boundedLease = Math.min(7 * 24 * 60 * 60, Math.max(60, Number(leaseSeconds) || 3600));
    return stmts.claimMaintenanceLease.run(name, boundedLease).changes > 0;
  },
  hasSchemaMigration(name) {
    if (!/^[A-Za-z0-9_.:-]{1,160}$/.test(name)) throw new Error('Invalid schema migration name');
    return Boolean(db.prepare('SELECT 1 FROM schema_migrations WHERE name = ?').get(name));
  },
  recordSchemaMigration(name) {
    if (!/^[A-Za-z0-9_.:-]{1,160}$/.test(name)) throw new Error('Invalid schema migration name');
    db.prepare("INSERT OR IGNORE INTO schema_migrations(name, applied_at) VALUES (?, datetime('now'))").run(name);
  },
  async runInSavepoint(fn) {
    db.exec('SAVEPOINT eval_holdout');
    try {
      const result = await fn();
      db.exec('RELEASE eval_holdout');
      return result;
    } catch (e) {
      db.exec('ROLLBACK TO eval_holdout');
      throw e;
    }
  },
  getCoWatchedVideos(videoIds, excludeUserId, limit, maxAgeDays = 90, maxUsers = 500) {
    if (!videoIds.length) return [];
    const boundedDays = Math.min(365, Math.max(7, Number(maxAgeDays) || 90));
    const boundedUsers = Math.min(5000, Math.max(10, Number(maxUsers) || 500));
    const placeholders = videoIds.map(() => '?').join(',');
    const sourcePlaceholders = placeholders;
    const excludePlaceholders = placeholders;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- better-sqlite3 returns unknown
    const rows: any[] = db.prepare(
      `WITH co_users AS (
         SELECT user_id, MAX(updated_at) AS recent_match FROM explore_cowatch_edges
         WHERE source_video_id IN (${placeholders}) AND user_id != ?
           AND updated_at > datetime('now', '-' || ? || ' days')
         GROUP BY user_id
         ORDER BY recent_match DESC
         LIMIT ?
       )
       SELECT edge.video_id, COUNT(DISTINCT edge.user_id) AS score
       FROM explore_cowatch_edges edge
       INNER JOIN co_users cu ON cu.user_id = edge.user_id
       WHERE edge.source_video_id IN (${sourcePlaceholders})
         AND edge.video_id NOT IN (${excludePlaceholders})
         AND edge.updated_at > datetime('now', '-' || ? || ' days')
       GROUP BY edge.video_id
       ORDER BY score DESC
       LIMIT ?`
    ).all(
      ...videoIds, excludeUserId, boundedDays, boundedUsers,
      ...videoIds, ...videoIds, boundedDays, limit,
    );
    return rows;
  },
};

} // end else (SQLite path)

// Consumers must treat every database operation as asynchronous. SQLite still
// resolves immediately, while PostgreSQL returns real promises; exposing the
// shared DatabaseAPI here keeps production code honest about both backends.
export default api as DatabaseAPI;
