import type { DatabaseAPI } from './types.js';

/**
 * PostgreSQL database backend — used when DATABASE_URL is set.
 * Same API as db.js (SQLite) but async with pg Pool.
 *
 * All exported functions are async (return Promises).
 * Fire-and-forget writes work because the Promise is simply ignored.
 * Read calls in async route handlers can be awaited.
 */

import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Heroku / cloud providers may need SSL
  ssl: process.env.DATABASE_SSL === 'false'
    ? false
    : process.env.DATABASE_URL && process.env.DATABASE_URL.includes('sslmode=')
      ? undefined
      : process.env.DATABASE_URL && (process.env.DATABASE_URL.includes('amazonaws.com') || process.env.DATABASE_URL.includes('neon.tech') || process.env.DATABASE_URL.includes('supabase'))
        ? { rejectUnauthorized: false }
        : undefined,
});

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

  CREATE TABLE IF NOT EXISTS channels (
    channel_id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '',
    thumbnail TEXT NOT NULL DEFAULT '',
    updated_at TIMESTAMPTZ DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS rss_cache (
    channel_id TEXT PRIMARY KEY,
    data TEXT NOT NULL DEFAULT '{}',
    fetched_at TIMESTAMPTZ DEFAULT NOW()
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

  CREATE TABLE IF NOT EXISTS dismissals (
    user_id TEXT NOT NULL,
    video_id TEXT NOT NULL,
    PRIMARY KEY(user_id, video_id)
  );

  CREATE TABLE IF NOT EXISTS channel_boosts (
    user_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY(user_id, channel_id)
  );

  CREATE INDEX IF NOT EXISTS idx_watch_time_video ON watch_time(video_id);

  CREATE TABLE IF NOT EXISTS watch_queue (
    user_id TEXT NOT NULL,
    video_id TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    channel_title TEXT NOT NULL DEFAULT '',
    channel_id TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY(user_id, video_id)
  );

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
  CREATE INDEX IF NOT EXISTS idx_saved_playlists_user ON saved_playlists(user_id, updated_at DESC);

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

  CREATE TABLE IF NOT EXISTS explore_events (
    user_id TEXT NOT NULL,
    video_id TEXT NOT NULL,
    channel_id TEXT NOT NULL DEFAULT '',
    event_type TEXT NOT NULL,
    impression_count INTEGER NOT NULL DEFAULT 1,
    position INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY(user_id, video_id, event_type)
  );

  CREATE TABLE IF NOT EXISTS topic_filters (
    user_id TEXT NOT NULL,
    topic TEXT NOT NULL,
    filter TEXT NOT NULL,
    PRIMARY KEY(user_id, topic)
  );
`;

// Run init synchronously-ish: we store the promise so callers can await if needed
const _ready = pool.query(initSQL).then(async () => {
  // Migrate: add position column to explore_events if missing
  await pool.query('ALTER TABLE explore_events ADD COLUMN IF NOT EXISTS position INTEGER NOT NULL DEFAULT 0').catch(() => {});
  await pool.query("ALTER TABLE saved_playlists ADD COLUMN IF NOT EXISTS playlist_type TEXT NOT NULL DEFAULT 'youtube'").catch(() => {});
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
  `).catch(() => {});
  // Migrate: add channel_id column to dismissals if missing
  await pool.query("ALTER TABLE dismissals ADD COLUMN IF NOT EXISTS channel_id TEXT NOT NULL DEFAULT ''").catch(() => {});
  // Migrate: add bounce_seconds column to explore_events if missing
  await pool.query("ALTER TABLE explore_events ADD COLUMN IF NOT EXISTS bounce_seconds INTEGER NOT NULL DEFAULT 0").catch(() => {});
  // Migrate: fix double-protocol thumbnail URLs
  return Promise.all([
    pool.query(`UPDATE subscriptions SET thumbnail = SUBSTRING(thumbnail FROM 7) WHERE thumbnail LIKE 'https:https:%'`),
    pool.query(`UPDATE channels SET thumbnail = SUBSTRING(thumbnail FROM 7) WHERE thumbnail LIKE 'https:https:%'`),
  ]);
}).then(([r1, r2]) => {
  if (r1.rowCount || r2.rowCount) {
    console.log(`[db-pg] fixed double-protocol thumbnails: ${r1.rowCount} subscriptions, ${r2.rowCount} channels`);
  }
}).catch(err => {
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

/** Ensure schema is ready before any query */
async function q(text: string, params?: (string | number | boolean | null | undefined | string[])[]) {
  await _ready;
  return pool.query(text, params);
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
    const client = await pool.connect();
    try {
      await _ready;
      await client.query('BEGIN');
      for (const s of subs) {
        await client.query(
          `INSERT INTO subscriptions (user_id, channel_id, title, thumbnail, description, updated_at)
           VALUES ($1, $2, $3, $4, $5, NOW())
           ON CONFLICT (user_id, channel_id) DO UPDATE SET
             title = EXCLUDED.title, thumbnail = EXCLUDED.thumbnail,
             description = EXCLUDED.description, updated_at = NOW()`,
          [userId, s.channelId, s.title || '', normalizeThumbnail(s.thumbnail), s.description || '']
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

  async deleteSubscription(userId, channelId) {
    await q('DELETE FROM subscriptions WHERE user_id = $1 AND channel_id = $2', [userId, channelId]);
  },

  async getRecentSubscriptionChannelIds(userId, days) {
    const { rows } = await q(
      "SELECT channel_id FROM subscriptions WHERE user_id = $1 AND updated_at > NOW() - INTERVAL '1 day' * $2",
      [userId, days]
    );
    return rows.map(r => r.channel_id);
  },

  async getSubscriptionDates(userId, channelIds) {
    const result = new Map<string, string>();
    if (!channelIds.length) return result;
    const { rows } = await q(
      'SELECT channel_id, updated_at FROM subscriptions WHERE user_id = $1 AND channel_id = ANY($2::text[])',
      [userId, channelIds]
    );
    for (const r of rows) result.set(r.channel_id, r.updated_at);
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
      'SELECT data, fetched_at FROM rss_cache WHERE channel_id = $1',
      [channelId]
    );
    if (!rows[0]) return null;
    try {
      return { data: JSON.parse(rows[0].data), fetchedAt: rows[0].fetched_at };
    } catch { return null; }
  },

  async setRssCache(channelId, data) {
    await q(
      `INSERT INTO rss_cache (channel_id, data, fetched_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (channel_id) DO UPDATE SET data = EXCLUDED.data, fetched_at = NOW()`,
      [channelId, JSON.stringify(data)]
    );
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

  async getAllTaggedVideoIds(userId) {
    const { rows } = await q(
      'SELECT DISTINCT video_id FROM tags WHERE user_id = $1',
      [userId]
    );
    return rows.map(r => r.video_id);
  },

  async upsertRelatedVideos(sourceVideoId, videos) {
    const client = await pool.connect();
    try {
      await _ready;
      await client.query('BEGIN');
      for (const v of videos) {
        await client.query(
          `INSERT INTO related_videos (source_video_id, video_id, title, channel_title, channel_id, published_text, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, NOW())
           ON CONFLICT (source_video_id, video_id) DO UPDATE SET
             title = EXCLUDED.title, channel_title = EXCLUDED.channel_title,
             channel_id = EXCLUDED.channel_id, published_text = EXCLUDED.published_text, updated_at = NOW()`,
          [sourceVideoId, v.videoId, v.title, v.channelTitle, v.channelId, v.publishedText]
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  async getRelatedVideosForSources(sourceVideoIds) {
    if (!sourceVideoIds.length) return [];
    const { rows } = await q(
      'SELECT source_video_id, video_id, title, channel_title, channel_id, published_text FROM related_videos WHERE source_video_id = ANY($1::text[])',
      [sourceVideoIds]
    );
    return rows;
  },

  async pruneRelatedVideos(maxAgeDays) {
    const { rowCount } = await q(
      `DELETE FROM related_videos WHERE updated_at < NOW() - INTERVAL '1 day' * $1`,
      [maxAgeDays]
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
      `SELECT session_id, clicks, total_watch_seconds, best_completion, started_at
       FROM explore_sessions WHERE user_id = $1 AND clicks > 0 AND started_at > NOW() - INTERVAL '1 day'
       ORDER BY started_at DESC`,
      [userId]
    );
    return rows;
  },

  async pruneExploreSessions(maxAgeDays) {
    const { rowCount } = await q(
      `DELETE FROM explore_sessions WHERE started_at < NOW() - INTERVAL '1 day' * $1`,
      [maxAgeDays]
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

  async getExploreBounces(userId) {
    const { rows } = await q(
      "SELECT video_id, channel_id, bounce_seconds FROM explore_events WHERE user_id = $1 AND event_type = 'bounce'",
      [userId]
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
    const client = await pool.connect();
    try {
      await _ready;
      await client.query('BEGIN');
      for (const v of videos) {
        await client.query(
          `INSERT INTO explore_events (user_id, video_id, channel_id, event_type, impression_count, position, created_at)
           VALUES ($1, $2, $3, 'impression', 1, $4, NOW())
           ON CONFLICT (user_id, video_id, event_type) DO UPDATE SET
             impression_count = explore_events.impression_count + 1, position = EXCLUDED.position, created_at = NOW()`,
          [userId, v.videoId, v.channelId, v.position]
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
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

  async getExploreEventsForUser(userId) {
    const { rows } = await q(
      'SELECT video_id, channel_id, event_type, impression_count, position, created_at FROM explore_events WHERE user_id = $1',
      [userId]
    );
    return rows;
  },

  async pruneExploreEvents(maxAgeDays) {
    const { rowCount } = await q(
      `DELETE FROM explore_events WHERE created_at < NOW() - INTERVAL '1 day' * $1`,
      [maxAgeDays]
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
  },
  async runInSavepoint(fn) {
    await q('SAVEPOINT eval_holdout', []);
    try {
      const result = await fn();
      await q('RELEASE SAVEPOINT eval_holdout', []);
      return result;
    } catch (e) {
      await q('ROLLBACK TO SAVEPOINT eval_holdout', []);
      throw e;
    }
  },
  async getCoWatchedVideos(videoIds, excludeUserId, limit) {
    if (!videoIds.length) return [];
    const { rows } = await q(
      `WITH co_users AS (
         SELECT DISTINCT user_id FROM watch_time
         WHERE video_id = ANY($1::text[]) AND user_id != $2
           AND duration > 0 AND (last_position = 0 OR last_position / duration > 0.3)
       )
       SELECT w.video_id, COUNT(DISTINCT w.user_id)::int AS score
       FROM watch_time w
       INNER JOIN co_users cu ON cu.user_id = w.user_id
       WHERE w.video_id != ALL($1::text[])
         AND w.duration > 0
         AND (w.last_position = 0 OR w.last_position / w.duration > 0.3)
       GROUP BY w.video_id
       ORDER BY score DESC
       LIMIT $3`,
      [videoIds, excludeUserId, limit]
    );
    return rows.map(r => ({ video_id: r.video_id, score: Number(r.score) }));
  },
};

export default api;
