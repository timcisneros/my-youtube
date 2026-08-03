const POSTGRES_TODAY_ROWS_SQL = `
  SELECT rv.channel_id, rv.video_id, rv.title, rv.published_at, s.title AS sub_title
  FROM rss_videos rv
  JOIN subscriptions s ON s.channel_id = rv.channel_id
  WHERE s.user_id = $1 AND ($2::text IS NULL OR rv.published_at >= $2)
    AND rv.channel_rank <= $3
  ORDER BY rv.published_at DESC
  LIMIT $4
`;

const POSTGRES_TODAY_PAGE_SQL = `
  SELECT rv.channel_id, rv.video_id, rv.title, rv.published_at, s.title AS sub_title,
    vd.duration, vd.live_status, COUNT(*) OVER()::int AS _total
  FROM rss_videos rv
  JOIN subscriptions s ON s.channel_id = rv.channel_id
  LEFT JOIN video_durations vd ON vd.video_id = rv.video_id
  WHERE s.user_id = $1 AND ($2::text IS NULL OR rv.published_at >= $2)
    AND rv.channel_rank <= $3
  ORDER BY rv.published_at DESC, rv.video_id
  LIMIT $4 OFFSET $5
`;

const POSTGRES_TODAY_COUNT_SQL = `
  SELECT COUNT(*)::int AS total
  FROM rss_videos rv
  JOIN subscriptions s ON s.channel_id = rv.channel_id
  WHERE s.user_id = $1 AND ($2::text IS NULL OR rv.published_at >= $2)
    AND rv.channel_rank <= $3
`;

const POSTGRES_TODAY_OLDER_CURSOR_SQL = `
  SELECT rv.channel_id, rv.video_id, rv.title, rv.published_at, s.title AS sub_title,
    vd.duration, vd.live_status
  FROM rss_videos rv
  JOIN subscriptions s ON s.channel_id = rv.channel_id
  LEFT JOIN video_durations vd ON vd.video_id = rv.video_id
  WHERE s.user_id = $1 AND ($2::text IS NULL OR rv.published_at >= $2)
    AND rv.channel_rank <= $3
    AND ($4::text IS NULL OR rv.published_at < $4
      OR (rv.published_at = $4 AND rv.video_id > $5))
  ORDER BY rv.published_at DESC, rv.video_id ASC
  LIMIT $6
`;

const POSTGRES_TODAY_NEWER_CURSOR_SQL = `
  SELECT rv.channel_id, rv.video_id, rv.title, rv.published_at, s.title AS sub_title,
    vd.duration, vd.live_status
  FROM rss_videos rv
  JOIN subscriptions s ON s.channel_id = rv.channel_id
  LEFT JOIN video_durations vd ON vd.video_id = rv.video_id
  WHERE s.user_id = $1 AND ($2::text IS NULL OR rv.published_at >= $2)
    AND rv.channel_rank <= $3
    AND ($4::text IS NULL OR rv.published_at > $4
      OR (rv.published_at = $4 AND rv.video_id < $5))
  ORDER BY rv.published_at ASC, rv.video_id DESC
  LIMIT $6
`;

const POSTGRES_EXPLORE_CANDIDATE_SIGNALS_SQL = `
  WITH
    metadata_ids(video_id) AS (SELECT UNNEST($1::text[])),
    rich_metadata_ids(video_id) AS (SELECT UNNEST($2::text[])),
    candidate_video_ids(video_id) AS (SELECT UNNEST($3::text[])),
    candidate_channel_ids(channel_id) AS (SELECT UNNEST($4::text[])),
    video_popularity AS (
      SELECT candidate.video_id,
        GREATEST(0, COALESCE(rollup.engaged_users, 0) - CASE WHEN own.video_id IS NOT NULL
          AND own.duration > 0 AND (own.last_position = 0 OR own.last_position / own.duration > 0.3)
          THEN 1 ELSE 0 END)::int AS popularity
      FROM candidate_video_ids candidate
      LEFT JOIN explore_video_rollups rollup ON rollup.video_id = candidate.video_id
      LEFT JOIN watch_time own ON own.user_id = $5 AND own.video_id = candidate.video_id
    ),
    recent_popularity AS (
      SELECT wt.video_id, COUNT(DISTINCT wt.user_id)::int AS recent_popularity
      FROM watch_time wt
      INNER JOIN candidate_video_ids candidate ON candidate.video_id = wt.video_id
      WHERE wt.user_id != $5
        AND wt.updated_at > NOW() - INTERVAL '1 hour' * $6
        AND wt.duration > 0 AND (wt.last_position = 0 OR wt.last_position / wt.duration > 0.3)
      GROUP BY wt.video_id
    ),
    community_ratings AS (
      SELECT candidate.video_id,
        GREATEST(0, COALESCE(rollup.rating_up, 0) - CASE WHEN own.rating = 1 THEN 1 ELSE 0 END)::int AS rating_up,
        GREATEST(0, COALESCE(rollup.rating_down, 0) - CASE WHEN own.rating = -1 THEN 1 ELSE 0 END)::int AS rating_down
      FROM candidate_video_ids candidate
      LEFT JOIN explore_video_rollups rollup ON rollup.video_id = candidate.video_id
      LEFT JOIN video_ratings own ON own.user_id = $5 AND own.video_id = candidate.video_id
    ),
    subscriber_counts AS (
      SELECT candidate.channel_id,
        GREATEST(0, COALESCE(rollup.subscriber_users, 0) - CASE WHEN own.channel_id IS NOT NULL THEN 1 ELSE 0 END)::int
          AS subscriber_count
      FROM candidate_channel_ids candidate
      LEFT JOIN explore_channel_rollups rollup ON rollup.channel_id = candidate.channel_id
      LEFT JOIN subscriptions own ON own.user_id = $5 AND own.channel_id = candidate.channel_id
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
    NULL::int AS subscriber_count, NULL::int AS impression_count
  FROM metadata_ids metadata
  LEFT JOIN video_durations details ON details.video_id = metadata.video_id
  LEFT JOIN rich_metadata_ids rich ON rich.video_id = metadata.video_id
  LEFT JOIN video_popularity popularity ON popularity.video_id = metadata.video_id
  LEFT JOIN recent_popularity recent ON recent.video_id = metadata.video_id
  LEFT JOIN community_ratings ratings ON ratings.video_id = metadata.video_id
  UNION ALL
  SELECT 'channel', candidate.channel_id,
    NULL::double precision, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
    subscribers.subscriber_count, impressions.impression_count
  FROM candidate_channel_ids candidate
  LEFT JOIN subscriber_counts subscribers ON subscribers.channel_id = candidate.channel_id
  LEFT JOIN impression_counts impressions ON impressions.channel_id = candidate.channel_id
`;

const POSTGRES_EXPLORE_USER_SIGNALS_SQL = `
  WITH
    relevant_video_ids(video_id) AS (SELECT UNNEST($1::text[])),
    relevant_channel_ids(channel_id) AS (SELECT UNNEST($2::text[]))
  SELECT 'event' AS kind, events.video_id, events.channel_id,
    events.event_type AS text_value,
    events.impression_count::double precision AS numeric_value,
    events.position, events.created_at, events.bounce_seconds,
    details.duration::double precision AS duration,
    NULL::text AS behavior_json
  FROM explore_events events
  INNER JOIN relevant_video_ids relevant ON relevant.video_id = events.video_id
  LEFT JOIN video_durations details ON details.video_id = events.video_id
  WHERE events.user_id = $3
    AND events.created_at > NOW() - INTERVAL '1 day' * $4
  UNION ALL
  SELECT 'tag', tags.video_id, NULL, NULL, NULL::double precision,
    NULL::integer, NULL::timestamptz, NULL::integer, NULL::double precision, NULL::text
  FROM tags
  INNER JOIN relevant_video_ids relevant ON relevant.video_id = tags.video_id
  WHERE tags.user_id = $3
  GROUP BY tags.video_id
  UNION ALL
  SELECT 'dismissal', dismissals.video_id, NULL, NULL, NULL::double precision,
    NULL::integer, NULL::timestamptz, NULL::integer, NULL::double precision, NULL::text
  FROM dismissals
  INNER JOIN relevant_video_ids relevant ON relevant.video_id = dismissals.video_id
  WHERE dismissals.user_id = $3
  UNION ALL
  SELECT 'boost', NULL, boosts.channel_id, NULL, NULL::double precision,
    NULL::integer, NULL::timestamptz, NULL::integer, NULL::double precision, NULL::text
  FROM channel_boosts boosts
  INNER JOIN relevant_channel_ids relevant ON relevant.channel_id = boosts.channel_id
  WHERE boosts.user_id = $3
  UNION ALL
  SELECT 'mute', NULL, mutes.channel_id, NULL, NULL::double precision,
    NULL::integer, NULL::timestamptz, NULL::integer, NULL::double precision, NULL::text
  FROM channel_mutes mutes
  INNER JOIN relevant_channel_ids relevant ON relevant.channel_id = mutes.channel_id
  WHERE mutes.user_id = $3
  UNION ALL
  SELECT 'queue', queue.video_id, queue.channel_id, NULL, NULL::double precision,
    NULL::integer, NULL::timestamptz, NULL::integer, NULL::double precision, NULL::text
  FROM watch_queue queue
  INNER JOIN relevant_video_ids relevant ON relevant.video_id = queue.video_id
  WHERE queue.user_id = $3
  UNION ALL
  SELECT 'rating', ratings.video_id, NULL, NULL, ratings.rating::double precision,
    NULL::integer, NULL::timestamptz, NULL::integer, NULL::double precision, NULL::text
  FROM video_ratings ratings
  INNER JOIN relevant_video_ids relevant ON relevant.video_id = ratings.video_id
  WHERE ratings.user_id = $3
  UNION ALL
  SELECT 'topic', filters.topic, NULL, filters.filter, NULL::double precision,
    NULL::integer, NULL::timestamptz, NULL::integer, NULL::double precision, NULL::text
  FROM topic_filters filters
  WHERE filters.user_id = $3
  UNION ALL
  SELECT 'behavior', NULL, behavior.channel_id, NULL, NULL::double precision,
    NULL::integer, NULL::timestamptz, NULL::integer, NULL::double precision,
    json_build_object(
      'impressions', behavior.impressions,
      'clicks', behavior.clicks,
      'bounces', behavior.bounces,
      'returns', CASE WHEN behavior.last_return_at > NOW() - INTERVAL '1 day'
        THEN behavior.returns ELSE 0 END
    )::text
  FROM explore_user_channel_rollups behavior
  INNER JOIN relevant_channel_ids relevant ON relevant.channel_id = behavior.channel_id
  WHERE behavior.user_id = $3
`;

export {
  POSTGRES_EXPLORE_CANDIDATE_SIGNALS_SQL,
  POSTGRES_EXPLORE_USER_SIGNALS_SQL,
  POSTGRES_TODAY_COUNT_SQL,
  POSTGRES_TODAY_NEWER_CURSOR_SQL,
  POSTGRES_TODAY_OLDER_CURSOR_SQL,
  POSTGRES_TODAY_PAGE_SQL,
  POSTGRES_TODAY_ROWS_SQL,
};
