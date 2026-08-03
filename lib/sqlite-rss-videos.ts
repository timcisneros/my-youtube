import type {
  CursorDirection,
  CursorPageResult,
  PageResult,
  RSSVideoRow,
  TodayPageCursor,
  TodayVideoRow,
} from '../types.js';

interface SQLiteQueryDatabase {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
  };
}

interface SQLiteRssVideoQueryArgs {
  userId: string;
  publishedAfter: string | null;
  perChannelLimit: number;
  limit: number;
}

interface SQLiteRssVideoPageQueryArgs extends SQLiteRssVideoQueryArgs {
  offset: number;
}

interface SQLiteRssVideoCursorPageQueryArgs extends SQLiteRssVideoQueryArgs {
  cursor: TodayPageCursor | null;
  direction: CursorDirection;
}

const sqliteStatementCache = new WeakMap<object, { all(...params: unknown[]): unknown[] }>();
const sqlitePageStatementCache = new WeakMap<object, { all(...params: unknown[]): unknown[] }>();
const sqliteCountStatementCache = new WeakMap<object, { get(...params: unknown[]): unknown }>();
const sqliteOlderCursorStatementCache = new WeakMap<object, { all(...params: unknown[]): unknown[] }>();
const sqliteNewerCursorStatementCache = new WeakMap<object, { all(...params: unknown[]): unknown[] }>();

const SQLITE_RSS_VIDEOS_FOR_USER_SQL = `
  SELECT rv.channel_id, rv.video_id, rv.title, rv.published_at, s.title AS sub_title
  FROM rss_videos rv
  JOIN subscriptions s ON s.channel_id = rv.channel_id
  WHERE s.user_id = ? AND (? = '' OR rv.published_at >= ?)
    AND rv.channel_rank <= ?
  ORDER BY rv.published_at DESC
  LIMIT ?
`;

const SQLITE_RSS_VIDEOS_PAGE_FOR_USER_SQL = `
  SELECT rv.channel_id, rv.video_id, rv.title, rv.published_at, s.title AS sub_title,
    vd.duration, vd.live_status, COUNT(*) OVER() AS _total
  FROM rss_videos rv
  JOIN subscriptions s ON s.channel_id = rv.channel_id
  LEFT JOIN video_durations vd ON vd.video_id = rv.video_id
  WHERE s.user_id = ? AND (? = '' OR rv.published_at >= ?)
    AND rv.channel_rank <= ?
  ORDER BY rv.published_at DESC, rv.video_id
  LIMIT ? OFFSET ?
`;

const SQLITE_RSS_VIDEOS_COUNT_FOR_USER_SQL = `
  SELECT COUNT(*) AS total
  FROM rss_videos rv
  JOIN subscriptions s ON s.channel_id = rv.channel_id
  WHERE s.user_id = ? AND (? = '' OR rv.published_at >= ?)
    AND rv.channel_rank <= ?
`;

const SQLITE_RSS_VIDEOS_OLDER_CURSOR_SQL = `
  SELECT rv.channel_id, rv.video_id, rv.title, rv.published_at, s.title AS sub_title,
    vd.duration, vd.live_status
  FROM rss_videos rv
  JOIN subscriptions s ON s.channel_id = rv.channel_id
  LEFT JOIN video_durations vd ON vd.video_id = rv.video_id
  WHERE s.user_id = ? AND (? = '' OR rv.published_at >= ?)
    AND rv.channel_rank <= ?
    AND (? = '' OR rv.published_at < ? OR (rv.published_at = ? AND rv.video_id > ?))
  ORDER BY rv.published_at DESC, rv.video_id ASC
  LIMIT ?
`;

const SQLITE_RSS_VIDEOS_NEWER_CURSOR_SQL = `
  SELECT rv.channel_id, rv.video_id, rv.title, rv.published_at, s.title AS sub_title,
    vd.duration, vd.live_status
  FROM rss_videos rv
  JOIN subscriptions s ON s.channel_id = rv.channel_id
  LEFT JOIN video_durations vd ON vd.video_id = rv.video_id
  WHERE s.user_id = ? AND (? = '' OR rv.published_at >= ?)
    AND rv.channel_rank <= ?
    AND (? = '' OR rv.published_at > ? OR (rv.published_at = ? AND rv.video_id < ?))
  ORDER BY rv.published_at ASC, rv.video_id DESC
  LIMIT ?
`;

function querySqliteRssVideosForUser(
  database: SQLiteQueryDatabase,
  args: SQLiteRssVideoQueryArgs,
): RSSVideoRow[] {
  let statement = sqliteStatementCache.get(database);
  if (!statement) {
    statement = database.prepare(SQLITE_RSS_VIDEOS_FOR_USER_SQL);
    sqliteStatementCache.set(database, statement);
  }
  const after = args.publishedAfter || '';
  return statement.all(
    args.userId,
    after,
    after,
    Math.max(1, Math.floor(args.perChannelLimit)),
    Math.max(1, Math.floor(args.limit)),
  ) as RSSVideoRow[];
}

function querySqliteRssVideosPageForUser(
  database: SQLiteQueryDatabase,
  args: SQLiteRssVideoPageQueryArgs,
): PageResult<TodayVideoRow> {
  let pageStatement = sqlitePageStatementCache.get(database);
  if (!pageStatement) {
    pageStatement = database.prepare(SQLITE_RSS_VIDEOS_PAGE_FOR_USER_SQL);
    sqlitePageStatementCache.set(database, pageStatement);
  }
  const after = args.publishedAfter || '';
  const queryParams = [
    args.userId,
    after,
    after,
    Math.max(1, Math.floor(args.perChannelLimit)),
  ];
  const rows = pageStatement.all(
    ...queryParams,
    Math.max(1, Math.floor(args.limit)),
    Math.max(0, Math.floor(args.offset)),
  ) as Array<TodayVideoRow & { _total?: number }>;
  let totalResults = Number(rows[0]?._total || 0);
  if (rows.length === 0 && args.offset > 0) {
    let countStatement = sqliteCountStatementCache.get(database);
    if (!countStatement) {
      countStatement = database.prepare(SQLITE_RSS_VIDEOS_COUNT_FOR_USER_SQL);
      sqliteCountStatementCache.set(database, countStatement);
    }
    const count = countStatement.get(...queryParams) as { total?: number } | undefined;
    totalResults = Number(count?.total || 0);
  }
  return {
    items: rows.map(({ _total: _ignored, ...row }) => row),
    totalResults,
  };
}

function querySqliteRssVideosCursorPageForUser(
  database: SQLiteQueryDatabase,
  args: SQLiteRssVideoCursorPageQueryArgs,
): CursorPageResult<TodayVideoRow> {
  const isNewer = args.direction === 'newer';
  const cache = isNewer ? sqliteNewerCursorStatementCache : sqliteOlderCursorStatementCache;
  let statement = cache.get(database);
  if (!statement) {
    statement = database.prepare(
      isNewer ? SQLITE_RSS_VIDEOS_NEWER_CURSOR_SQL : SQLITE_RSS_VIDEOS_OLDER_CURSOR_SQL,
    );
    cache.set(database, statement);
  }
  const after = args.publishedAfter || '';
  const cursorPublished = args.cursor?.publishedAt || '';
  const cursorVideoId = args.cursor?.videoId || '';
  const boundedLimit = Math.min(200, Math.max(1, Math.floor(args.limit)));
  const rows = statement.all(
    args.userId,
    after,
    after,
    Math.max(1, Math.floor(args.perChannelLimit)),
    cursorPublished,
    cursorPublished,
    cursorPublished,
    cursorVideoId,
    boundedLimit + 1,
  ) as TodayVideoRow[];
  const hasMore = rows.length > boundedLimit;
  const items = rows.slice(0, boundedLimit);
  if (isNewer) items.reverse();
  return { items, hasMore };
}

export {
  querySqliteRssVideosCursorPageForUser,
  querySqliteRssVideosForUser,
  querySqliteRssVideosPageForUser,
};
export type {
  SQLiteRssVideoCursorPageQueryArgs,
  SQLiteRssVideoPageQueryArgs,
  SQLiteRssVideoQueryArgs,
};
