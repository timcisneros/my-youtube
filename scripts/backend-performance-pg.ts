import 'dotenv/config';

import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import {
  POSTGRES_EXPLORE_CANDIDATE_SIGNALS_SQL,
  POSTGRES_EXPLORE_USER_SIGNALS_SQL,
  POSTGRES_TODAY_OLDER_CURSOR_SQL,
} from '../lib/postgres-performance-queries.js';

const { Client } = pg;
const connectionString = process.env.PERFORMANCE_DATABASE_URL || process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('Set PERFORMANCE_DATABASE_URL or DATABASE_URL to run the PostgreSQL benchmark');
}

const subscriptionCount = Math.max(10, Number(process.env.PG_PERF_SUBSCRIPTIONS) || 1_000);
const videoCount = Math.max(subscriptionCount, Number(process.env.PG_PERF_RSS_VIDEOS) || 12_000);
const historyCount = Math.min(videoCount, Math.max(10, Number(process.env.PG_PERF_HISTORY_ROWS) || 10_000));
const downloadCount = Math.max(100, Number(process.env.PG_PERF_DOWNLOADS) || 5_000);
const iterations = Math.max(5, Number(process.env.PG_PERF_ITERATIONS) || 15);
const budgets = {
  todayP95Ms: Math.max(1, Number(process.env.PG_PERF_TODAY_P95_MS) || 100),
  exploreUserSignalsP95Ms: Math.max(1, Number(process.env.PG_PERF_EXPLORE_USER_P95_MS) || 200),
  exploreCandidateSignalsP95Ms: Math.max(1, Number(process.env.PG_PERF_EXPLORE_CANDIDATE_P95_MS) || 300),
  deepDownloadsP95Ms: Math.max(1, Number(process.env.PG_PERF_DOWNLOADS_P95_MS) || 75),
};

function percentile(values: number[], fraction: number) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

async function benchmark(query: () => Promise<unknown>) {
  for (let index = 0; index < 3; index++) await query();
  const samples: number[] = [];
  for (let index = 0; index < iterations; index++) {
    const startedAt = performance.now();
    await query();
    samples.push(performance.now() - startedAt);
  }
  return {
    p50Ms: Number(percentile(samples, 0.50).toFixed(2)),
    p95Ms: Number(percentile(samples, 0.95).toFixed(2)),
    maxMs: Number(Math.max(...samples).toFixed(2)),
  };
}

type PlanNode = {
  'Node Type'?: string;
  Plans?: PlanNode[];
};

function planNodeCounts(root: PlanNode) {
  const counts: Record<string, number> = {};
  const visit = (node: PlanNode) => {
    const type = node['Node Type'] || 'Unknown';
    counts[type] = (counts[type] || 0) + 1;
    for (const child of node.Plans || []) visit(child);
  };
  visit(root);
  return counts;
}

async function explain(client: InstanceType<typeof Client>, sql: string, params: unknown[]) {
  const { rows } = await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, params);
  const raw = rows[0]?.['QUERY PLAN'];
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const report = Array.isArray(parsed) ? parsed[0] : parsed;
  return {
    planningMs: Number(Number(report?.['Planning Time'] || 0).toFixed(2)),
    executionMs: Number(Number(report?.['Execution Time'] || 0).toFixed(2)),
    nodeTypes: planNodeCounts(report?.Plan || {}),
  };
}

const schema = `perf_backend_${randomUUID().replace(/-/g, '')}`;
const client = new Client({
  connectionString,
  application_name: 'my-youtube-backend-performance',
  statement_timeout: Math.max(5_000, Number(process.env.PG_PERF_STATEMENT_TIMEOUT_MS) || 60_000),
});
let connected = false;

const userId = 'performance-user';
const channelIds = Array.from({ length: subscriptionCount }, (_value, index) =>
  `channel-${String(index).padStart(6, '0')}`
);
const videoIds = Array.from({ length: videoCount }, (_value, index) =>
  `video-${String(index).padStart(7, '0')}`
);
const relevantVideoIds = videoIds.slice(0, Math.min(3_500, videoIds.length));
const deepDownloadsSql = 'SELECT video_id, title, created_at FROM downloads ORDER BY created_at DESC LIMIT $1 OFFSET $2';

try {
  await client.connect();
  connected = true;
  await client.query(`CREATE SCHEMA "${schema}"`);
  await client.query(`SET search_path TO "${schema}"`);
  await client.query(`
    CREATE TABLE subscriptions (
      user_id TEXT NOT NULL, channel_id TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
      PRIMARY KEY(user_id, channel_id)
    );
    CREATE INDEX idx_subscriptions_channel ON subscriptions(channel_id);
    CREATE TABLE rss_videos (
      channel_id TEXT NOT NULL, video_id TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
      published_at TEXT NOT NULL DEFAULT '', channel_rank INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(channel_id, video_id)
    );
    CREATE INDEX idx_rss_videos_channel_rank ON rss_videos(channel_id, channel_rank, published_at DESC);
    CREATE INDEX idx_rss_videos_published ON rss_videos(published_at DESC);
    CREATE INDEX idx_rss_videos_published_video ON rss_videos(published_at DESC, video_id ASC);
    CREATE TABLE video_durations (
      video_id TEXT PRIMARY KEY, duration DOUBLE PRECISION NOT NULL,
      live_status TEXT NOT NULL DEFAULT 'not_live', tags TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE watch_time (
      user_id TEXT NOT NULL, video_id TEXT NOT NULL, last_position DOUBLE PRECISION NOT NULL,
      duration DOUBLE PRECISION NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY(user_id, video_id)
    );
    CREATE INDEX idx_watch_time_video ON watch_time(video_id);
    CREATE INDEX idx_watch_time_video_updated ON watch_time(video_id, updated_at DESC);
    CREATE TABLE explore_events (
      user_id TEXT NOT NULL, video_id TEXT NOT NULL, channel_id TEXT NOT NULL DEFAULT '',
      event_type TEXT NOT NULL, impression_count INTEGER NOT NULL DEFAULT 1,
      position INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      bounce_seconds INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(user_id, video_id, event_type)
    );
    CREATE INDEX idx_explore_events_user_type_created ON explore_events(user_id, event_type, created_at DESC);
    CREATE INDEX idx_explore_events_user_created ON explore_events(user_id, created_at DESC);
    CREATE INDEX idx_explore_events_channel_type ON explore_events(channel_id, event_type);
    CREATE TABLE explore_video_rollups (
      video_id TEXT PRIMARY KEY, engaged_users INTEGER NOT NULL DEFAULT 0,
      rating_up INTEGER NOT NULL DEFAULT 0, rating_down INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE explore_channel_rollups (
      channel_id TEXT PRIMARY KEY, subscriber_users INTEGER NOT NULL DEFAULT 0,
      total_impressions BIGINT NOT NULL DEFAULT 0
    );
    CREATE TABLE explore_user_channel_rollups (
      user_id TEXT NOT NULL, channel_id TEXT NOT NULL,
      impressions BIGINT NOT NULL DEFAULT 0, clicks INTEGER NOT NULL DEFAULT 0,
      bounces INTEGER NOT NULL DEFAULT 0, returns INTEGER NOT NULL DEFAULT 0,
      last_return_at TIMESTAMPTZ, updated_at TIMESTAMPTZ,
      PRIMARY KEY(user_id, channel_id)
    );
    CREATE TABLE tags (user_id TEXT NOT NULL, video_id TEXT NOT NULL, tag TEXT NOT NULL, PRIMARY KEY(user_id, video_id, tag));
    CREATE TABLE dismissals (user_id TEXT NOT NULL, video_id TEXT NOT NULL, channel_id TEXT NOT NULL DEFAULT '', PRIMARY KEY(user_id, video_id));
    CREATE TABLE channel_boosts (user_id TEXT NOT NULL, channel_id TEXT NOT NULL, PRIMARY KEY(user_id, channel_id));
    CREATE TABLE channel_mutes (user_id TEXT NOT NULL, channel_id TEXT NOT NULL, PRIMARY KEY(user_id, channel_id));
    CREATE TABLE watch_queue (user_id TEXT NOT NULL, video_id TEXT NOT NULL, channel_id TEXT NOT NULL DEFAULT '', PRIMARY KEY(user_id, video_id));
    CREATE TABLE video_ratings (user_id TEXT NOT NULL, video_id TEXT NOT NULL, rating INTEGER NOT NULL, PRIMARY KEY(user_id, video_id));
    CREATE INDEX idx_video_ratings_video_user ON video_ratings(video_id, user_id);
    CREATE TABLE topic_filters (user_id TEXT NOT NULL, topic TEXT NOT NULL, filter TEXT NOT NULL, PRIMARY KEY(user_id, topic));
    CREATE TABLE downloads (video_id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE INDEX idx_downloads_created ON downloads(created_at DESC);
  `);

  const seedStatements: Array<[string, unknown[]]> = [
    [`INSERT INTO subscriptions (user_id, channel_id, title)
      SELECT $1, 'channel-' || LPAD(value::text, 6, '0'), 'Channel ' || value
      FROM generate_series(0, $2::integer - 1) AS value`, [userId, subscriptionCount]],
    [`INSERT INTO subscriptions (user_id, channel_id, title)
      SELECT 'community-' || community, 'channel-' || LPAD(channel::text, 6, '0'), 'Channel ' || channel
      FROM generate_series(1, 4) AS community
      CROSS JOIN generate_series(0, $1::integer - 1) AS channel`, [subscriptionCount]],
    [`INSERT INTO rss_videos (channel_id, video_id, title, published_at, channel_rank)
      SELECT 'channel-' || LPAD((value % $1::integer)::text, 6, '0'),
        'video-' || LPAD(value::text, 7, '0'), 'Video ' || value,
        TO_CHAR(NOW() - value * INTERVAL '1 minute', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        FLOOR(value / $1::integer)::integer + 1
      FROM generate_series(0, $2::integer - 1) AS value`, [subscriptionCount, videoCount]],
    [`INSERT INTO video_durations (video_id, duration, tags, description)
      SELECT 'video-' || LPAD(value::text, 7, '0'), 300,
        CASE WHEN value % 17 = 0 THEN '["technology"]' ELSE '' END,
        CASE WHEN value % 11 = 0 THEN 'Synthetic benchmark video' ELSE '' END
      FROM generate_series(0, $1::integer - 1) AS value`, [videoCount]],
    [`INSERT INTO watch_time (user_id, video_id, last_position, duration, updated_at)
      SELECT 'community-' || ((value % 4) + 1), 'video-' || LPAD(value::text, 7, '0'),
        CASE WHEN value % 5 = 0 THEN 0 ELSE 180 END, 300, NOW() - (value % 1440) * INTERVAL '1 minute'
      FROM generate_series(0, $1::integer - 1) AS value`, [historyCount]],
    [`INSERT INTO explore_events (user_id, video_id, channel_id, event_type, impression_count, position, created_at, bounce_seconds)
      SELECT $1, 'video-' || LPAD(value::text, 7, '0'),
        'channel-' || LPAD((value % $2::integer)::text, 6, '0'),
        CASE WHEN value % 13 = 0 THEN 'return' WHEN value % 7 = 0 THEN 'bounce' ELSE 'impression' END,
        (value % 4) + 1, value % 60, NOW() - (value % 10080) * INTERVAL '1 minute',
        CASE WHEN value % 7 = 0 THEN 12 ELSE 0 END
      FROM generate_series(0, $3::integer - 1) AS value`, [userId, subscriptionCount, historyCount]],
    [`INSERT INTO tags SELECT $1, 'video-' || LPAD(value::text, 7, '0'), 'saved'
      FROM generate_series(0, $2::integer - 1, 17) AS value`, [userId, historyCount]],
    [`INSERT INTO dismissals SELECT $1, 'video-' || LPAD(value::text, 7, '0'),
        'channel-' || LPAD((value % $2::integer)::text, 6, '0')
      FROM generate_series(0, $3::integer - 1, 31) AS value`, [userId, subscriptionCount, historyCount]],
    [`INSERT INTO watch_queue SELECT $1, 'video-' || LPAD(value::text, 7, '0'),
        'channel-' || LPAD((value % $2::integer)::text, 6, '0')
      FROM generate_series(0, $3::integer - 1, 23) AS value`, [userId, subscriptionCount, historyCount]],
    [`INSERT INTO video_ratings SELECT $1, 'video-' || LPAD(value::text, 7, '0'),
        CASE WHEN value % 38 = 0 THEN -1 ELSE 1 END
      FROM generate_series(0, $2::integer - 1, 19) AS value`, [userId, historyCount]],
    [`INSERT INTO channel_boosts SELECT $1, 'channel-' || LPAD(value::text, 6, '0')
      FROM generate_series(0, $2::integer - 1, 20) AS value`, [userId, subscriptionCount]],
    [`INSERT INTO channel_mutes SELECT $1, 'channel-' || LPAD(value::text, 6, '0')
      FROM generate_series(0, $2::integer - 1, 37) AS value`, [userId, subscriptionCount]],
    ["INSERT INTO topic_filters VALUES ($1, 'technology', 'boost')", [userId]],
    [`INSERT INTO downloads (video_id, title, created_at)
      SELECT 'download-' || LPAD(value::text, 7, '0'), 'Download ' || value,
        NOW() - value * INTERVAL '1 second'
      FROM generate_series(0, $1::integer - 1) AS value`, [downloadCount]],
    [`INSERT INTO explore_video_rollups(video_id, engaged_users, rating_up, rating_down)
      SELECT ids.video_id, COALESCE(w.engaged_users, 0), COALESCE(r.rating_up, 0), COALESCE(r.rating_down, 0)
      FROM (SELECT video_id FROM watch_time UNION SELECT video_id FROM video_ratings) ids
      LEFT JOIN (
        SELECT video_id, COUNT(DISTINCT user_id)::int AS engaged_users
        FROM watch_time WHERE duration > 0 AND (last_position = 0 OR last_position / duration > 0.3)
        GROUP BY video_id
      ) w ON w.video_id = ids.video_id
      LEFT JOIN (
        SELECT video_id, SUM((rating = 1)::int)::int AS rating_up, SUM((rating = -1)::int)::int AS rating_down
        FROM video_ratings GROUP BY video_id
      ) r ON r.video_id = ids.video_id`, []],
    [`INSERT INTO explore_channel_rollups(channel_id, subscriber_users, total_impressions)
      SELECT ids.channel_id, COALESCE(s.subscriber_users, 0), COALESCE(e.total_impressions, 0)
      FROM (SELECT channel_id FROM subscriptions UNION SELECT channel_id FROM explore_events) ids
      LEFT JOIN (
        SELECT channel_id, COUNT(DISTINCT user_id)::int AS subscriber_users
        FROM subscriptions GROUP BY channel_id
      ) s ON s.channel_id = ids.channel_id
      LEFT JOIN (
        SELECT channel_id, SUM(impression_count)::bigint AS total_impressions
        FROM explore_events WHERE event_type = 'impression' GROUP BY channel_id
      ) e ON e.channel_id = ids.channel_id`, []],
  ];
  await client.query('BEGIN');
  try {
    for (const [sql, params] of seedStatements) await client.query(sql, params);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
  await client.query(`
    ANALYZE subscriptions;
    ANALYZE rss_videos;
    ANALYZE video_durations;
    ANALYZE watch_time;
    ANALYZE explore_events;
    ANALYZE tags;
    ANALYZE dismissals;
    ANALYZE channel_boosts;
    ANALYZE channel_mutes;
    ANALYZE watch_queue;
    ANALYZE video_ratings;
    ANALYZE topic_filters;
    ANALYZE downloads;
    ANALYZE explore_video_rollups;
    ANALYZE explore_channel_rollups;
  `);

  const todayParams = [userId, new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString(), 30, null, null, 61];
  const userSignalParams = [relevantVideoIds, channelIds, userId, 90];
  const richMetadataVideoIds = relevantVideoIds.slice(0, Math.min(800, relevantVideoIds.length));
  const candidateSignalParams = [
    relevantVideoIds, richMetadataVideoIds, relevantVideoIds, channelIds, userId, 24,
  ];
  const downloadParams = [40, Math.max(0, downloadCount - 80)];

  const results = {
    dataset: {
      subscriptions: subscriptionCount,
      rssVideos: videoCount,
      historyRows: historyCount,
      downloads: downloadCount,
    },
    timings: {
      today: await benchmark(() => client.query(POSTGRES_TODAY_OLDER_CURSOR_SQL, todayParams)),
      exploreUserSignals: await benchmark(() => client.query(POSTGRES_EXPLORE_USER_SIGNALS_SQL, userSignalParams)),
      exploreCandidateSignals: await benchmark(() => client.query(POSTGRES_EXPLORE_CANDIDATE_SIGNALS_SQL, candidateSignalParams)),
      deepDownloads: await benchmark(() => client.query(deepDownloadsSql, downloadParams)),
    },
    plans: {
      today: await explain(client, POSTGRES_TODAY_OLDER_CURSOR_SQL, todayParams),
      exploreUserSignals: await explain(client, POSTGRES_EXPLORE_USER_SIGNALS_SQL, userSignalParams),
      exploreCandidateSignals: await explain(client, POSTGRES_EXPLORE_CANDIDATE_SIGNALS_SQL, candidateSignalParams),
      deepDownloads: await explain(client, deepDownloadsSql, downloadParams),
    },
    budgets,
  };
  console.log(JSON.stringify(results, null, 2));

  const failures: string[] = [];
  if (results.timings.today.p95Ms > budgets.todayP95Ms) failures.push('today');
  if (results.timings.exploreUserSignals.p95Ms > budgets.exploreUserSignalsP95Ms) failures.push('exploreUserSignals');
  if (results.timings.exploreCandidateSignals.p95Ms > budgets.exploreCandidateSignalsP95Ms) failures.push('exploreCandidateSignals');
  if (results.timings.deepDownloads.p95Ms > budgets.deepDownloadsP95Ms) failures.push('deepDownloads');
  if (failures.length) throw new Error(`PostgreSQL performance budget exceeded: ${failures.join(', ')}`);
} finally {
  if (connected) {
    await client.query('RESET search_path').catch(() => {});
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
    await client.end().catch(() => {});
  }
}
