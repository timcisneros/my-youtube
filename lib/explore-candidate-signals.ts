import type { ExploreCandidateSignals, VideoMetadata } from '../types.js';

interface ExploreCandidateSignalArgs {
  metadataVideoIds: string[];
  richMetadataVideoIds: string[];
  candidateVideoIds: string[];
  candidateChannelIds: string[];
  excludeUserId: string;
  recentWithinHours: number;
}

interface SQLiteQueryDatabase {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
}

const sqliteStatementCache = new WeakMap<object, { all(...params: unknown[]): unknown[] }>();

interface SignalRow {
  entity_type: 'video' | 'channel';
  entity_id: string;
  duration: number | null;
  live_status: string | null;
  tags: string | null;
  description: string | null;
  popularity: number | null;
  recent_popularity: number | null;
  rating_up: number | null;
  rating_down: number | null;
  subscriber_count: number | null;
  impression_count: number | null;
}

const SQLITE_EXPLORE_CANDIDATE_SIGNALS_SQL = `
  WITH
    metadata_ids(video_id) AS (SELECT value FROM json_each(?)),
    rich_metadata_ids(video_id) AS (SELECT value FROM json_each(?)),
    candidate_video_ids(video_id) AS (SELECT value FROM json_each(?)),
    candidate_channel_ids(channel_id) AS (SELECT value FROM json_each(?)),
    video_popularity AS (
      SELECT candidate.video_id,
        MAX(0, COALESCE(rollup.engaged_users, 0) - CASE WHEN own.video_id IS NOT NULL
          AND own.duration > 0
          AND (own.last_position = 0 OR CAST(own.last_position AS REAL) / own.duration > 0.3)
          THEN 1 ELSE 0 END) AS popularity
      FROM candidate_video_ids candidate
      LEFT JOIN explore_video_rollups rollup ON rollup.video_id = candidate.video_id
      LEFT JOIN watch_time own ON own.user_id = ? AND own.video_id = candidate.video_id
    ),
    recent_popularity AS (
      SELECT wt.video_id, COUNT(DISTINCT wt.user_id) AS recent_popularity
      FROM watch_time wt
      INNER JOIN candidate_video_ids candidate ON candidate.video_id = wt.video_id
      WHERE wt.user_id != ?
        AND wt.updated_at > datetime('now', '-' || ? || ' hours')
        AND wt.duration > 0
        AND (wt.last_position = 0 OR CAST(wt.last_position AS REAL) / wt.duration > 0.3)
      GROUP BY wt.video_id
    ),
    community_ratings AS (
      SELECT candidate.video_id,
        MAX(0, COALESCE(rollup.rating_up, 0) - CASE WHEN own.rating = 1 THEN 1 ELSE 0 END) AS rating_up,
        MAX(0, COALESCE(rollup.rating_down, 0) - CASE WHEN own.rating = -1 THEN 1 ELSE 0 END) AS rating_down
      FROM candidate_video_ids candidate
      LEFT JOIN explore_video_rollups rollup ON rollup.video_id = candidate.video_id
      LEFT JOIN video_ratings own ON own.user_id = ? AND own.video_id = candidate.video_id
    ),
    subscriber_counts AS (
      SELECT candidate.channel_id,
        MAX(0, COALESCE(rollup.subscriber_users, 0) - CASE WHEN own.channel_id IS NOT NULL THEN 1 ELSE 0 END)
          AS subscriber_count
      FROM candidate_channel_ids candidate
      LEFT JOIN explore_channel_rollups rollup ON rollup.channel_id = candidate.channel_id
      LEFT JOIN subscriptions own ON own.user_id = ? AND own.channel_id = candidate.channel_id
    ),
    impression_counts AS (
      SELECT candidate.channel_id, COALESCE(rollup.total_impressions, 0) AS impression_count
      FROM candidate_channel_ids candidate
      LEFT JOIN explore_channel_rollups rollup ON rollup.channel_id = candidate.channel_id
    )
  SELECT 'video' AS entity_type, metadata.video_id AS entity_id,
    details.duration, details.live_status,
    CASE WHEN rich.video_id IS NOT NULL THEN details.tags ELSE NULL END AS tags,
    CASE WHEN rich.video_id IS NOT NULL THEN details.description ELSE NULL END AS description,
    popularity.popularity, recent.recent_popularity,
    ratings.rating_up, ratings.rating_down,
    NULL AS subscriber_count, NULL AS impression_count
  FROM metadata_ids metadata
  LEFT JOIN video_durations details ON details.video_id = metadata.video_id
  LEFT JOIN rich_metadata_ids rich ON rich.video_id = metadata.video_id
  LEFT JOIN video_popularity popularity ON popularity.video_id = metadata.video_id
  LEFT JOIN recent_popularity recent ON recent.video_id = metadata.video_id
  LEFT JOIN community_ratings ratings ON ratings.video_id = metadata.video_id
  UNION ALL
  SELECT 'channel' AS entity_type, candidate.channel_id AS entity_id,
    NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
    subscribers.subscriber_count, impressions.impression_count
  FROM candidate_channel_ids candidate
  LEFT JOIN subscriber_counts subscribers ON subscribers.channel_id = candidate.channel_id
  LEFT JOIN impression_counts impressions ON impressions.channel_id = candidate.channel_id
`;

function emptyExploreCandidateSignals(): ExploreCandidateSignals {
  return {
    videoMetadata: { durations: {}, liveStatuses: {}, tags: {}, descriptions: {} },
    videoPopularity: {},
    recentVideoPopularity: {},
    communityRatings: {},
    channelSubscriberCounts: {},
    channelImpressionCounts: {},
  };
}

function mapExploreCandidateSignalRows(rows: SignalRow[]): ExploreCandidateSignals {
  const result = emptyExploreCandidateSignals();
  const metadata: VideoMetadata = result.videoMetadata;
  for (const row of rows) {
    if (row.entity_type === 'channel') {
      if (row.subscriber_count !== null) result.channelSubscriberCounts[row.entity_id] = Number(row.subscriber_count);
      if (row.impression_count !== null) result.channelImpressionCounts[row.entity_id] = Number(row.impression_count);
      continue;
    }
    if (row.duration !== null) metadata.durations[row.entity_id] = Number(row.duration);
    if (row.live_status !== null) metadata.liveStatuses[row.entity_id] = row.live_status || 'not_live';
    if (row.tags) {
      try { metadata.tags[row.entity_id] = JSON.parse(row.tags); } catch { /* skip malformed metadata */ }
    }
    if (row.description) metadata.descriptions[row.entity_id] = row.description;
    if (row.popularity !== null) result.videoPopularity[row.entity_id] = Number(row.popularity);
    if (row.recent_popularity !== null) result.recentVideoPopularity[row.entity_id] = Number(row.recent_popularity);
    const ratingUp = Number(row.rating_up) || 0;
    const ratingDown = Number(row.rating_down) || 0;
    if (ratingUp > 0 || ratingDown > 0) {
      result.communityRatings[row.entity_id] = { up: ratingUp, down: ratingDown };
    }
  }
  return result;
}

function querySqliteExploreCandidateSignals(database: SQLiteQueryDatabase, args: ExploreCandidateSignalArgs) {
  if (!args.metadataVideoIds.length && !args.candidateChannelIds.length) return emptyExploreCandidateSignals();
  let statement = sqliteStatementCache.get(database);
  if (!statement) {
    statement = database.prepare(SQLITE_EXPLORE_CANDIDATE_SIGNALS_SQL);
    sqliteStatementCache.set(database, statement);
  }
  const rows = statement.all(
    JSON.stringify(args.metadataVideoIds),
    JSON.stringify(args.richMetadataVideoIds),
    JSON.stringify(args.candidateVideoIds),
    JSON.stringify(args.candidateChannelIds),
    args.excludeUserId,
    args.excludeUserId,
    args.recentWithinHours,
    args.excludeUserId,
    args.excludeUserId,
  ) as SignalRow[];
  return mapExploreCandidateSignalRows(rows);
}

export {
  emptyExploreCandidateSignals,
  mapExploreCandidateSignalRows,
  querySqliteExploreCandidateSignals,
};
export type { ExploreCandidateSignalArgs, SignalRow };
