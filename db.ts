import type { DatabaseAPI, SyncDatabaseAPI } from './types.js';
import path from 'path';
import fs from 'fs';

let api: DatabaseAPI | SyncDatabaseAPI;

// When DATABASE_URL is set, use PostgreSQL instead of SQLite
if (process.env.DATABASE_URL) {
  api = (await import('./db-pg.js')).default;
} else {

const { default: Database } = await import('better-sqlite3');

const dataDir = path.join(import.meta.dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);

const db = new Database(path.join(dataDir, 'tags.db'));
db.pragma('journal_mode = WAL');

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

  CREATE TABLE IF NOT EXISTS channels (
    channel_id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '',
    thumbnail TEXT NOT NULL DEFAULT '',
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS rss_cache (
    channel_id TEXT PRIMARY KEY,
    data TEXT NOT NULL DEFAULT '{}',
    fetched_at TEXT DEFAULT (datetime('now'))
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
    PRIMARY KEY(user_id, video_id)
  );

  CREATE TABLE IF NOT EXISTS channel_boosts (
    user_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY(user_id, channel_id)
  );

  CREATE INDEX IF NOT EXISTS idx_watch_time_video ON watch_time(video_id);

  CREATE TABLE IF NOT EXISTS watch_queue (
    user_id TEXT NOT NULL,
    video_id TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    channel_title TEXT NOT NULL DEFAULT '',
    channel_id TEXT NOT NULL DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY(user_id, video_id)
  );

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

  CREATE TABLE IF NOT EXISTS explore_events (
    user_id TEXT NOT NULL,
    video_id TEXT NOT NULL,
    channel_id TEXT NOT NULL DEFAULT '',
    event_type TEXT NOT NULL,
    impression_count INTEGER NOT NULL DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY(user_id, video_id, event_type)
  );
`);

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
`);

// Migrate: add channel_id column to dismissals if missing
try {
  db.prepare("SELECT channel_id FROM dismissals LIMIT 1").get();
} catch {
  db.exec("ALTER TABLE dismissals ADD COLUMN channel_id TEXT NOT NULL DEFAULT ''");
}

// Create topic_filters table
db.exec(`
  CREATE TABLE IF NOT EXISTS topic_filters (
    user_id TEXT NOT NULL,
    topic TEXT NOT NULL,
    filter TEXT NOT NULL,
    PRIMARY KEY(user_id, topic)
  );
`);

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
{
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
  deleteSub: db.prepare('DELETE FROM subscriptions WHERE user_id = ? AND channel_id = ?'),
  upsertChannel: db.prepare(`INSERT INTO channels (channel_id, title, thumbnail, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(channel_id) DO UPDATE SET title=excluded.title, thumbnail=excluded.thumbnail, updated_at=datetime('now')`),
  getChannel: db.prepare('SELECT channel_id AS channelId, title, thumbnail FROM channels WHERE channel_id = ?'),
  getSubByChannel: db.prepare('SELECT channel_id AS channelId, title, thumbnail FROM subscriptions WHERE channel_id = ? LIMIT 1'),
  getRssCache: db.prepare('SELECT data, fetched_at FROM rss_cache WHERE channel_id = ?'),
  upsertRssCache: db.prepare(`INSERT INTO rss_cache (channel_id, data, fetched_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(channel_id) DO UPDATE SET data=excluded.data, fetched_at=datetime('now')`),
  getAllRssCacheForUser: db.prepare(`SELECT r.channel_id, r.data, s.title AS sub_title
    FROM rss_cache r
    JOIN subscriptions s ON s.channel_id = r.channel_id
    WHERE s.user_id = ?`),
  upsertDownload: db.prepare(`INSERT INTO downloads (video_id, title, channel_title, thumbnail, status, total_bytes, downloaded_bytes)
    VALUES (?, ?, ?, ?, 'downloading', 0, 0)
    ON CONFLICT(video_id) DO UPDATE SET status='downloading', total_bytes=0, downloaded_bytes=0`),
  updateDownloadProgress: db.prepare('UPDATE downloads SET downloaded_bytes = ?, total_bytes = ? WHERE video_id = ?'),
  completeDownload: db.prepare('UPDATE downloads SET status = \'complete\', downloaded_bytes = total_bytes WHERE video_id = ?'),
  failDownload: db.prepare('UPDATE downloads SET status = \'error\' WHERE video_id = ?'),
  deleteDownload: db.prepare('DELETE FROM downloads WHERE video_id = ?'),
  getDownload: db.prepare('SELECT * FROM downloads WHERE video_id = ?'),
  getAllDownloads: db.prepare('SELECT * FROM downloads ORDER BY created_at DESC'),
  upsertDuration: db.prepare(`INSERT INTO video_durations (video_id, duration, live_status) VALUES (?, ?, ?)
    ON CONFLICT(video_id) DO UPDATE SET duration=excluded.duration, live_status=excluded.live_status`),
  getDuration: db.prepare('SELECT duration, live_status FROM video_durations WHERE video_id = ?'),
  setVideoTags: db.prepare("UPDATE video_durations SET tags = ? WHERE video_id = ?"),
  setVideoDescription: db.prepare("UPDATE video_durations SET description = ? WHERE video_id = ?"),
  upsertWatchTime: db.prepare(`INSERT INTO watch_time (user_id, video_id, last_position, duration, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(user_id, video_id) DO UPDATE SET last_position=excluded.last_position, duration=excluded.duration, updated_at=datetime('now')`),
  getWatchTime: db.prepare('SELECT last_position, duration FROM watch_time WHERE user_id = ? AND video_id = ?'),
  getAllWatchTimesForUser: db.prepare('SELECT video_id, last_position, duration, updated_at FROM watch_time WHERE user_id = ?'),
  getAllTaggedVideoIds: db.prepare('SELECT DISTINCT video_id FROM tags WHERE user_id = ?'),
  upsertRelated: db.prepare(`INSERT INTO related_videos (source_video_id, video_id, title, channel_title, channel_id, published_text, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(source_video_id, video_id) DO UPDATE SET title=excluded.title, channel_title=excluded.channel_title, channel_id=excluded.channel_id, published_text=excluded.published_text, updated_at=datetime('now')`),
  pruneRelated: db.prepare(`DELETE FROM related_videos WHERE updated_at < datetime('now', '-' || ? || ' days')`),
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
  getQueuedVideoIds: db.prepare('SELECT video_id FROM watch_queue WHERE user_id = ?'),
  muteChannel: db.prepare('INSERT OR IGNORE INTO channel_mutes (user_id, channel_id) VALUES (?, ?)'),
  unmuteChannel: db.prepare('DELETE FROM channel_mutes WHERE user_id = ? AND channel_id = ?'),
  getMutedChannelIds: db.prepare('SELECT channel_id FROM channel_mutes WHERE user_id = ?'),
  logExploreImpression: db.prepare(`INSERT INTO explore_events (user_id, video_id, channel_id, event_type, impression_count, position, created_at)
    VALUES (?, ?, ?, 'impression', 1, ?, datetime('now'))
    ON CONFLICT(user_id, video_id, event_type) DO UPDATE SET impression_count = impression_count + 1, position = excluded.position, created_at = datetime('now')`),
  logExploreClick: db.prepare(`INSERT INTO explore_events (user_id, video_id, channel_id, event_type, impression_count, created_at)
    VALUES (?, ?, ?, 'click', 1, datetime('now'))
    ON CONFLICT(user_id, video_id, event_type) DO UPDATE SET created_at = datetime('now')`),
  getExploreEventsForUser: db.prepare('SELECT video_id, channel_id, event_type, impression_count, position, created_at FROM explore_events WHERE user_id = ?'),
  pruneExploreEvents: db.prepare(`DELETE FROM explore_events WHERE created_at < datetime('now', '-' || ? || ' days')`),
  rateVideo: db.prepare(`INSERT INTO video_ratings (user_id, video_id, rating)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id, video_id) DO UPDATE SET rating=excluded.rating, created_at=datetime('now')`),
  unrateVideo: db.prepare('DELETE FROM video_ratings WHERE user_id = ? AND video_id = ?'),
  getVideoRatings: db.prepare('SELECT video_id, rating FROM video_ratings WHERE user_id = ?'),
  getRecentSubChannelIds: db.prepare(
    "SELECT channel_id FROM subscriptions WHERE user_id = ? AND updated_at > datetime('now', '-' || ? || ' days')"
  ),
  startExploreSession: db.prepare(`INSERT OR IGNORE INTO explore_sessions (user_id, session_id) VALUES (?, ?)`),
  updateExploreSession: db.prepare(`UPDATE explore_sessions SET clicks = ?, total_watch_seconds = ?, best_completion = ? WHERE user_id = ? AND session_id = ?`),
  getRecentExploreSessions: db.prepare(`SELECT session_id, clicks, total_watch_seconds, best_completion, started_at FROM explore_sessions WHERE user_id = ? ORDER BY started_at DESC LIMIT ?`),
  pruneExploreSessions: db.prepare(`DELETE FROM explore_sessions WHERE started_at < datetime('now', '-' || ? || ' days')`),
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

function normalizeTag(raw) {
  const t = raw.replace(/^#/, '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 30);
  return t || null;
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
  deleteSubscription(userId, channelId) {
    stmts.deleteSub.run(userId, channelId);
  },
  getRecentSubscriptionChannelIds(userId, days) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- better-sqlite3 returns unknown
    return (stmts.getRecentSubChannelIds.all(userId, days) as any[]).map((r: any) => r.channel_id);
  },
  getSubscriptionDates(userId, channelIds) {
    const result = new Map<string, string>();
    if (!channelIds.length) return result;
    const placeholders = channelIds.map(() => '?').join(',');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- better-sqlite3 returns unknown
    const rows: any[] = db.prepare(
      `SELECT channel_id, updated_at FROM subscriptions WHERE user_id = ? AND channel_id IN (${placeholders})`
    ).all(userId, ...channelIds);
    for (const r of rows) result.set(r.channel_id, r.updated_at);
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
      return { data: JSON.parse(row.data), fetchedAt: row.fetched_at };
    } catch { return null; }
  },
  setRssCache(channelId, data) {
    stmts.upsertRssCache.run(channelId, JSON.stringify(data));
  },
  getAllRssCacheForUser(userId) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- better-sqlite3 returns unknown
    return stmts.getAllRssCacheForUser.all(userId) as any[];
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
  pruneRelatedVideos(maxAgeDays) {
    return stmts.pruneRelated.run(maxAgeDays).changes;
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
  getQueuedVideoIds(userId) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- better-sqlite3 returns unknown
    return (stmts.getQueuedVideoIds.all(userId) as any[]).map((r: any) => r.video_id);
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
      `SELECT session_id, clicks, total_watch_seconds, best_completion, started_at
       FROM explore_sessions WHERE user_id = ? AND clicks > 0 AND started_at > datetime('now', '-1 day')
       ORDER BY started_at DESC`
    ).all(userId);
    return rows;
  },
  pruneExploreSessions(maxAgeDays) {
    return stmts.pruneExploreSessions.run(maxAgeDays).changes;
  },
  logExploreBounce(userId, videoId, channelId, bounceSeconds) {
    stmts.logExploreBounce.run(userId, videoId, channelId, bounceSeconds);
  },
  getExploreBounces(userId) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- better-sqlite3 returns unknown
    return stmts.getExploreBounces.all(userId) as any[];
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
      for (const v of videos) {
        stmts.logExploreImpression.run(userId, v.videoId, v.channelId, v.position);
      }
    });
    run();
  },
  logExploreClick(userId, videoId, channelId) {
    stmts.logExploreClick.run(userId, videoId, channelId);
  },
  getExploreEventsForUser(userId) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- better-sqlite3 returns unknown
    return stmts.getExploreEventsForUser.all(userId) as any[];
  },
  pruneExploreEvents(maxAgeDays) {
    return stmts.pruneExploreEvents.run(maxAgeDays).changes;
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
  },
  runInSavepoint(fn) {
    db.exec('SAVEPOINT eval_holdout');
    try {
      const result = fn();
      db.exec('RELEASE eval_holdout');
      return result;
    } catch (e) {
      db.exec('ROLLBACK TO eval_holdout');
      throw e;
    }
  },
  getCoWatchedVideos(videoIds, excludeUserId, limit) {
    if (!videoIds.length) return [];
    const placeholders = videoIds.map(() => '?').join(',');
    const excludePlaceholders = placeholders;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- better-sqlite3 returns unknown
    const rows: any[] = db.prepare(
      `WITH co_users AS (
         SELECT DISTINCT user_id FROM watch_time
         WHERE video_id IN (${placeholders}) AND user_id != ?
           AND duration > 0 AND (last_position = 0 OR CAST(last_position AS REAL) / duration > 0.3)
       )
       SELECT w.video_id, COUNT(DISTINCT w.user_id) AS score
       FROM watch_time w
       INNER JOIN co_users cu ON cu.user_id = w.user_id
       WHERE w.video_id NOT IN (${excludePlaceholders})
         AND w.duration > 0
         AND (w.last_position = 0 OR CAST(w.last_position AS REAL) / w.duration > 0.3)
       GROUP BY w.video_id
       ORDER BY score DESC
       LIMIT ?`
    ).all(...videoIds, excludeUserId, ...videoIds, limit);
    return rows;
  },
};

} // end else (SQLite path)

export default api as SyncDatabaseAPI;
