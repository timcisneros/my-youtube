import type { ExploreUserSignals } from '../types.js';

interface ExploreUserSignalRow {
  kind: 'event' | 'tag' | 'dismissal' | 'boost' | 'mute' | 'queue' | 'rating' | 'topic' | 'return' | 'behavior';
  video_id: string | null;
  channel_id: string | null;
  text_value: string | null;
  numeric_value: number | null;
  position: number | null;
  created_at: string | Date | null;
  bounce_seconds: number | null;
  duration: number | null;
  behavior_json: string | null;
}

interface SQLiteQueryDatabase {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
}

const sqliteStatementCache = new WeakMap<object, { all(...params: unknown[]): unknown[] }>();

const SQLITE_EXPLORE_USER_SIGNALS_SQL = `
  WITH
    relevant_video_ids(video_id) AS (SELECT value FROM json_each(?)),
    relevant_channel_ids(channel_id) AS (SELECT value FROM json_each(?))
  SELECT 'event' AS kind, events.video_id, events.channel_id,
    events.event_type AS text_value,
    CAST(events.impression_count AS REAL) AS numeric_value,
    events.position, events.created_at, events.bounce_seconds, details.duration,
    NULL AS behavior_json
  FROM explore_events events
  LEFT JOIN video_durations details ON details.video_id = events.video_id
  WHERE events.user_id = ?
    AND events.created_at > datetime('now', '-' || ? || ' days')
    AND events.video_id IN (SELECT video_id FROM relevant_video_ids)
  UNION ALL
  SELECT 'tag', tags.video_id, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
  FROM tags
  WHERE tags.user_id = ?
    AND tags.video_id IN (SELECT video_id FROM relevant_video_ids)
  GROUP BY tags.video_id
  UNION ALL
  SELECT 'dismissal', dismissals.video_id, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
  FROM dismissals
  WHERE dismissals.user_id = ?
    AND dismissals.video_id IN (SELECT video_id FROM relevant_video_ids)
  UNION ALL
  SELECT 'boost', NULL, boosts.channel_id, NULL, NULL, NULL, NULL, NULL, NULL, NULL
  FROM channel_boosts boosts
  WHERE boosts.user_id = ?
    AND boosts.channel_id IN (SELECT channel_id FROM relevant_channel_ids)
  UNION ALL
  SELECT 'mute', NULL, mutes.channel_id, NULL, NULL, NULL, NULL, NULL, NULL, NULL
  FROM channel_mutes mutes
  WHERE mutes.user_id = ?
    AND mutes.channel_id IN (SELECT channel_id FROM relevant_channel_ids)
  UNION ALL
  SELECT 'queue', queue.video_id, queue.channel_id, NULL, NULL, NULL, NULL, NULL, NULL, NULL
  FROM watch_queue queue
  WHERE queue.user_id = ?
    AND queue.video_id IN (SELECT video_id FROM relevant_video_ids)
  UNION ALL
  SELECT 'rating', ratings.video_id, NULL, NULL,
    CAST(ratings.rating AS REAL), NULL, NULL, NULL, NULL, NULL
  FROM video_ratings ratings
  WHERE ratings.user_id = ?
    AND ratings.video_id IN (SELECT video_id FROM relevant_video_ids)
  UNION ALL
  SELECT 'topic', filters.topic, NULL, filters.filter, NULL, NULL, NULL, NULL, NULL, NULL
  FROM topic_filters filters
  WHERE filters.user_id = ?
  UNION ALL
  SELECT 'behavior', NULL, behavior.channel_id, NULL, NULL, NULL, NULL, NULL, NULL,
    json_object(
      'impressions', behavior.impressions,
      'clicks', behavior.clicks,
      'bounces', behavior.bounces,
      'returns', CASE WHEN behavior.last_return_at > datetime('now', '-1 day')
        THEN behavior.returns ELSE 0 END
    )
  FROM explore_user_channel_rollups behavior
  WHERE behavior.user_id = ?
    AND behavior.channel_id IN (SELECT channel_id FROM relevant_channel_ids)
`;

function emptyExploreUserSignals(): ExploreUserSignals {
  return {
    exploreBounces: [],
    exploreEvents: [],
    topicFilterRows: [],
    taggedVideoIds: [],
    dismissedVideoIds: [],
    boostedChannelIdRows: [],
    mutedChannelIdRows: [],
    queuedVideoIdRows: [],
    ratingRows: [],
    returnChannelCounts: {},
    channelBehaviors: {},
    eventDurations: {},
  };
}

function mapExploreUserSignalRows(rows: ExploreUserSignalRow[]): ExploreUserSignals {
  const result = emptyExploreUserSignals();
  for (const row of rows) {
    if (row.kind === 'event' && row.video_id && row.channel_id && row.text_value) {
      const event = {
        video_id: row.video_id,
        channel_id: row.channel_id,
        event_type: row.text_value,
        impression_count: Number(row.numeric_value) || 0,
        position: Number(row.position) || 0,
        created_at: row.created_at instanceof Date
          ? row.created_at.toISOString()
          : String(row.created_at || ''),
      };
      result.exploreEvents.push(event);
      if (row.duration !== null && Number.isFinite(Number(row.duration))) {
        result.eventDurations[row.video_id] = Number(row.duration);
      }
      if (row.text_value === 'bounce') {
        result.exploreBounces.push({
          video_id: row.video_id,
          channel_id: row.channel_id,
          bounce_seconds: Number(row.bounce_seconds) || 0,
        });
      }
    } else if (row.kind === 'tag' && row.video_id) {
      result.taggedVideoIds.push(row.video_id);
    } else if (row.kind === 'dismissal' && row.video_id) {
      result.dismissedVideoIds.push(row.video_id);
    } else if (row.kind === 'boost' && row.channel_id) {
      result.boostedChannelIdRows.push(row.channel_id);
    } else if (row.kind === 'mute' && row.channel_id) {
      result.mutedChannelIdRows.push(row.channel_id);
    } else if (row.kind === 'queue' && row.video_id) {
      result.queuedVideoIdRows.push(row.video_id);
    } else if (row.kind === 'rating' && row.video_id) {
      result.ratingRows.push({ video_id: row.video_id, rating: Number(row.numeric_value) || 0 });
    } else if (row.kind === 'topic' && row.video_id && row.text_value) {
      result.topicFilterRows.push({ topic: row.video_id, filter: row.text_value });
    } else if (row.kind === 'return' && row.channel_id) {
      result.returnChannelCounts[row.channel_id] = Number(row.numeric_value) || 0;
    } else if (row.kind === 'behavior' && row.channel_id && row.behavior_json) {
      try {
        const behavior = JSON.parse(row.behavior_json);
        result.channelBehaviors[row.channel_id] = {
          impressions: Number(behavior.impressions) || 0,
          clicks: Number(behavior.clicks) || 0,
          bounces: Number(behavior.bounces) || 0,
          returns: Number(behavior.returns) || 0,
        };
        if (result.channelBehaviors[row.channel_id].returns > 0) {
          result.returnChannelCounts[row.channel_id] = result.channelBehaviors[row.channel_id].returns;
        }
      } catch { /* skip malformed aggregate rows */ }
    }
  }
  return result;
}

function querySqliteExploreUserSignals(
  database: SQLiteQueryDatabase,
  userId: string,
  relevantVideoIds: string[],
  relevantChannelIds: string[],
  maxAgeDays = 90,
) {
  let statement = sqliteStatementCache.get(database);
  if (!statement) {
    statement = database.prepare(SQLITE_EXPLORE_USER_SIGNALS_SQL);
    sqliteStatementCache.set(database, statement);
  }
  const rows = statement.all(
    JSON.stringify(relevantVideoIds),
    JSON.stringify(relevantChannelIds),
    userId,
    maxAgeDays,
    userId,
    userId,
    userId,
    userId,
    userId,
    userId,
    userId,
    userId,
  ) as ExploreUserSignalRow[];
  return mapExploreUserSignalRows(rows);
}

export {
  emptyExploreUserSignals,
  mapExploreUserSignalRows,
  querySqliteExploreUserSignals,
};
export type { ExploreUserSignalRow };
