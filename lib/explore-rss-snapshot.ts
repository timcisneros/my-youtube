import type { RSSChannelStatsRow, RSSData, RSSVideoRow } from '../types.js';

interface SQLiteQueryDatabase {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
}

interface SQLiteExploreRssSnapshotArgs {
  userId: string;
  perChannelLimit: number;
  candidateLimit: number;
  watchMaxAgeDays: number;
  deepCutBefore: string;
}

const sqliteCandidateStatementCache = new WeakMap<object, { all(...params: unknown[]): unknown[] }>();
const sqliteChannelStatsStatementCache = new WeakMap<object, { all(...params: unknown[]): unknown[] }>();

const SQLITE_EXPLORE_RSS_CANDIDATES_SQL = `
  SELECT rv.channel_id, rv.video_id, rv.title, rv.published_at, s.title AS sub_title
  FROM rss_videos rv
  JOIN subscriptions s ON s.channel_id = rv.channel_id AND s.user_id = ?
  LEFT JOIN watch_time wt
    ON wt.user_id = ? AND wt.video_id = rv.video_id
    AND wt.updated_at > datetime('now', '-' || ? || ' days')
  WHERE rv.channel_rank <= ?
    AND NOT EXISTS (SELECT 1 FROM tags t WHERE t.user_id = ? AND t.video_id = rv.video_id)
    AND NOT EXISTS (SELECT 1 FROM dismissals d WHERE d.user_id = ? AND d.video_id = rv.video_id)
    AND NOT EXISTS (SELECT 1 FROM channel_mutes m WHERE m.user_id = ? AND m.channel_id = rv.channel_id)
    AND (
      wt.video_id IS NULL OR wt.duration <= 0
      OR (wt.last_position != 0 AND wt.last_position / wt.duration < 0.5)
      OR ((wt.last_position = 0 OR wt.last_position / wt.duration > 0.9) AND (
        EXISTS (SELECT 1 FROM channel_boosts b WHERE b.user_id = ? AND b.channel_id = rv.channel_id)
        OR EXISTS (SELECT 1 FROM watch_queue q WHERE q.user_id = ? AND q.channel_id = rv.channel_id)
      ))
    )
  ORDER BY rv.published_at DESC
  LIMIT ?
`;

const SQLITE_EXPLORE_RSS_CHANNEL_STATS_SQL = `
  SELECT rcs.channel_id, rcs.video_count,
    rcs.newest_published_at, rcs.median_interval_ms
  FROM rss_channel_stats rcs
  JOIN subscriptions s ON s.channel_id = rcs.channel_id
  WHERE s.user_id = ?
`;

function selectExploreRssCandidates(rows: RSSVideoRow[], limit: number, deepCutBefore: string) {
  if (rows.length <= limit) return rows;
  const selected: RSSVideoRow[] = [];
  const selectedVideoIds = new Set<string>();
  const newestChannels = new Set<string>();
  const deepCutChannels = new Set<string>();

  function select(row: RSSVideoRow) {
    if (selected.length >= limit || selectedVideoIds.has(row.video_id)) return;
    selectedVideoIds.add(row.video_id);
    selected.push(row);
  }

  // Rows arrive in global recency order. Preserve the newest eligible upload
  // from every channel before filling globally.
  for (const row of rows) {
    if (newestChannels.has(row.channel_id)) continue;
    newestChannels.add(row.channel_id);
    select(row);
    if (selected.length >= limit) return selected;
  }

  // Preserve one old option per channel for deep-cut resurfacing.
  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index];
    if (deepCutChannels.has(row.channel_id) || row.published_at > deepCutBefore) continue;
    deepCutChannels.add(row.channel_id);
    select(row);
    if (selected.length >= limit) return selected;
  }

  for (const row of rows) {
    select(row);
    if (selected.length >= limit) break;
  }
  return selected;
}

function querySqliteExploreRssSnapshot(
  database: SQLiteQueryDatabase,
  args: SQLiteExploreRssSnapshotArgs,
) {
  let candidateStatement = sqliteCandidateStatementCache.get(database as object);
  if (!candidateStatement) {
    candidateStatement = database.prepare(SQLITE_EXPLORE_RSS_CANDIDATES_SQL);
    sqliteCandidateStatementCache.set(database as object, candidateStatement);
  }
  let channelStatsStatement = sqliteChannelStatsStatementCache.get(database as object);
  if (!channelStatsStatement) {
    channelStatsStatement = database.prepare(SQLITE_EXPLORE_RSS_CHANNEL_STATS_SQL);
    sqliteChannelStatsStatementCache.set(database as object, channelStatsStatement);
  }

  const shortlistLimit = Math.max(
    args.candidateLimit,
    Math.min(10_000, args.candidateLimit * 2),
  );
  const rows = candidateStatement.all(
    args.userId,
    args.userId,
    args.watchMaxAgeDays,
    args.perChannelLimit,
    args.userId,
    args.userId,
    args.userId,
    args.userId,
    args.userId,
    shortlistLimit,
  ) as RSSVideoRow[];
  const channelStats = channelStatsStatement.all(args.userId) as RSSChannelStatsRow[];
  return {
    videos: selectExploreRssCandidates(rows, args.candidateLimit, args.deepCutBefore),
    channelStats,
  };
}

function calculateRssChannelStats(channelId: string, data: RSSData, perChannelLimit = 6): RSSChannelStatsRow {
  const recent = rankedRssItems(data)
    .filter(item => item.publishedAt && Number.isFinite(new Date(item.publishedAt).getTime()))
    .slice(0, perChannelLimit);
  const intervals: number[] = [];
  for (let index = 0; index < recent.length - 1; index++) {
    intervals.push(new Date(recent[index].publishedAt).getTime() - new Date(recent[index + 1].publishedAt).getTime());
  }
  intervals.sort((a, b) => a - b);
  return {
    channel_id: channelId,
    video_count: recent.length,
    newest_published_at: recent[0]?.publishedAt || '',
    median_interval_ms: intervals.length ? intervals[Math.floor(intervals.length / 2)] : 0,
  };
}

function rankedRssItems(data: RSSData, limit = 30) {
  return (data.items || [])
    .filter(item => item?.videoId)
    .map((item, index) => ({ item, index, publishedMs: new Date(item.publishedAt || '').getTime() }))
    .sort((a, b) => {
      const aMs = Number.isFinite(a.publishedMs) ? a.publishedMs : -Infinity;
      const bMs = Number.isFinite(b.publishedMs) ? b.publishedMs : -Infinity;
      return bMs - aMs || a.index - b.index;
    })
    .slice(0, limit)
    .map(entry => entry.item);
}

export {
  calculateRssChannelStats,
  querySqliteExploreRssSnapshot,
  rankedRssItems,
  selectExploreRssCandidates,
};
export type { SQLiteExploreRssSnapshotArgs };
