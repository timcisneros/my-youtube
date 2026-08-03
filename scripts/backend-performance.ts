import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { emptyExploreCandidateSignals } from '../lib/explore-candidate-signals.js';
import { emptyExploreUserSignals, querySqliteExploreUserSignals } from '../lib/explore-user-signals.js';
import { createSqliteReadWorker } from '../lib/sqlite-explore-reader.js';
import { querySqliteRssVideosCursorPageForUser } from '../lib/sqlite-rss-videos.js';
import type { DatabaseAPI, ExploreCandidateSignals, RSSChannelStatsRow, RSSVideoRow } from '../types.js';

const subscriptionCount = Math.max(10, Number(process.env.BACKEND_PERF_SUBSCRIPTIONS) || 1_000);
const videosPerChannel = Math.max(2, Number(process.env.BACKEND_PERF_VIDEOS_PER_CHANNEL) || 12);
const historyCount = Math.max(100, Number(process.env.BACKEND_PERF_HISTORY) || 10_000);
const downloadCount = Math.max(100, Number(process.env.BACKEND_PERF_DOWNLOADS) || 5_000);
const iterations = Math.max(5, Number(process.env.BACKEND_PERF_ITERATIONS) || 30);
const budgets = {
  todayP95Ms: Math.max(1, Number(process.env.BACKEND_PERF_TODAY_P95_MS) || 75),
  exploreSignalsP95Ms: Math.max(1, Number(process.env.BACKEND_PERF_EXPLORE_SIGNALS_P95_MS) || 125),
  exploreColdBuildP95Ms: Math.max(1, Number(process.env.BACKEND_PERF_EXPLORE_BUILD_P95_MS) || 100),
  exploreColdBuildEventLoopMs: Math.max(1, Number(process.env.BACKEND_PERF_EXPLORE_BUILD_EVENT_LOOP_MS) || 50),
  deepDownloadsP95Ms: Math.max(1, Number(process.env.BACKEND_PERF_DEEP_DOWNLOADS_P95_MS) || 40),
  workerEventLoopDelayMs: Math.max(1, Number(process.env.BACKEND_PERF_WORKER_EVENT_LOOP_MS) || 50),
};

function percentile(sorted: number[], fraction: number) {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))];
}

function benchmark(run: () => unknown) {
  for (let i = 0; i < 5; i++) run();
  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const startedAt = performance.now();
    run();
    samples.push(performance.now() - startedAt);
  }
  samples.sort((a, b) => a - b);
  return {
    p50Ms: Number(percentile(samples, 0.5).toFixed(2)),
    p95Ms: Number(percentile(samples, 0.95).toFixed(2)),
    maxMs: Number(samples[samples.length - 1].toFixed(2)),
  };
}

async function benchmarkAsync(run: () => Promise<unknown>) {
  for (let i = 0; i < 3; i++) await run();
  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const startedAt = performance.now();
    await run();
    samples.push(performance.now() - startedAt);
  }
  samples.sort((a, b) => a - b);
  return {
    p50Ms: Number(percentile(samples, 0.5).toFixed(2)),
    p95Ms: Number(percentile(samples, 0.95).toFixed(2)),
    maxMs: Number(samples[samples.length - 1].toFixed(2)),
  };
}

const benchmarkDir = mkdtempSync(path.join(tmpdir(), 'my-youtube-backend-perf-'));
const databasePath = path.join(benchmarkDir, 'benchmark.db');
const db = new Database(databasePath);
let sqliteReadWorker: ReturnType<typeof createSqliteReadWorker> | null = null;

try {
  db.pragma('journal_mode = MEMORY');
  db.pragma('synchronous = OFF');
  db.exec(`
    CREATE TABLE subscriptions (user_id TEXT, channel_id TEXT, title TEXT, PRIMARY KEY(user_id, channel_id));
    CREATE INDEX idx_subs_user_title ON subscriptions(user_id, title COLLATE NOCASE);
    CREATE TABLE rss_videos (
      channel_id TEXT, video_id TEXT, title TEXT, published_at TEXT, channel_rank INTEGER,
      PRIMARY KEY(channel_id, video_id)
    );
    CREATE INDEX idx_rss_videos_channel_published ON rss_videos(channel_id, published_at DESC);
    CREATE INDEX idx_rss_videos_published_video ON rss_videos(published_at DESC, video_id ASC);
    CREATE TABLE rss_channel_stats (
      channel_id TEXT PRIMARY KEY, video_count INTEGER, newest_published_at TEXT, median_interval_ms REAL
    );
    CREATE TABLE video_durations (video_id TEXT PRIMARY KEY, duration REAL NOT NULL, live_status TEXT NOT NULL DEFAULT 'not_live');
    CREATE TABLE watch_time (
      user_id TEXT, video_id TEXT, last_position REAL, duration REAL, updated_at TEXT,
      PRIMARY KEY(user_id, video_id)
    );
    CREATE INDEX idx_watch_time_user_updated ON watch_time(user_id, updated_at DESC);
    CREATE TABLE tags (user_id TEXT, video_id TEXT, tag TEXT, PRIMARY KEY(user_id, video_id, tag));
    CREATE INDEX idx_tags_user_video ON tags(user_id, video_id);
    CREATE TABLE dismissals (user_id TEXT, video_id TEXT, channel_id TEXT, PRIMARY KEY(user_id, video_id));
    CREATE TABLE channel_boosts (user_id TEXT, channel_id TEXT, PRIMARY KEY(user_id, channel_id));
    CREATE TABLE channel_mutes (user_id TEXT, channel_id TEXT, PRIMARY KEY(user_id, channel_id));
    CREATE TABLE watch_queue (user_id TEXT, video_id TEXT, channel_id TEXT, PRIMARY KEY(user_id, video_id));
    CREATE TABLE video_ratings (user_id TEXT, video_id TEXT, rating INTEGER, PRIMARY KEY(user_id, video_id));
    CREATE TABLE topic_filters (user_id TEXT, topic TEXT, filter TEXT, PRIMARY KEY(user_id, topic));
    CREATE TABLE explore_events (
      user_id TEXT, video_id TEXT, channel_id TEXT, event_type TEXT,
      impression_count INTEGER, position INTEGER, created_at TEXT, bounce_seconds INTEGER,
      PRIMARY KEY(user_id, video_id, event_type)
    );
    CREATE INDEX idx_explore_events_user_created ON explore_events(user_id, created_at DESC);
    CREATE TABLE explore_user_channel_rollups (
      user_id TEXT NOT NULL, channel_id TEXT NOT NULL,
      impressions INTEGER NOT NULL DEFAULT 0, clicks INTEGER NOT NULL DEFAULT 0,
      bounces INTEGER NOT NULL DEFAULT 0, returns INTEGER NOT NULL DEFAULT 0,
      last_return_at TEXT, updated_at TEXT,
      PRIMARY KEY(user_id, channel_id)
    );
    CREATE TABLE downloads (video_id TEXT PRIMARY KEY, title TEXT, created_at TEXT);
    CREATE INDEX idx_downloads_created ON downloads(created_at DESC);
  `);

  const userId = 'performance-user';
  const insertSub = db.prepare('INSERT INTO subscriptions VALUES (?, ?, ?)');
  const insertVideo = db.prepare('INSERT INTO rss_videos VALUES (?, ?, ?, ?, ?)');
  const insertChannelStats = db.prepare('INSERT INTO rss_channel_stats VALUES (?, ?, ?, ?)');
  const insertWatchTime = db.prepare('INSERT OR REPLACE INTO watch_time VALUES (?, ?, ?, ?, ?)');
  const insertEvent = db.prepare('INSERT INTO explore_events VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const insertTag = db.prepare('INSERT INTO tags VALUES (?, ?, ?)');
  const insertDismissal = db.prepare('INSERT INTO dismissals VALUES (?, ?, ?)');
  const insertQueue = db.prepare('INSERT INTO watch_queue VALUES (?, ?, ?)');
  const insertRating = db.prepare('INSERT INTO video_ratings VALUES (?, ?, ?)');
  const insertBoost = db.prepare('INSERT INTO channel_boosts VALUES (?, ?)');
  const insertMute = db.prepare('INSERT INTO channel_mutes VALUES (?, ?)');
  const insertDownload = db.prepare('INSERT INTO downloads VALUES (?, ?, ?)');
  const now = Date.now();
  const videoIds: string[] = [];
  const channelIds: string[] = [];
  db.transaction(() => {
    for (let channelIndex = 0; channelIndex < subscriptionCount; channelIndex++) {
      const channelId = `channel-${String(channelIndex).padStart(5, '0')}`;
      channelIds.push(channelId);
      insertSub.run(userId, channelId, `Channel ${channelIndex}`);
      if (channelIndex % 40 === 0) insertBoost.run(userId, channelId);
      if (channelIndex % 250 === 0) insertMute.run(userId, channelId);
      insertChannelStats.run(
        channelId,
        videosPerChannel,
        new Date(now - 60_000).toISOString(),
        60_000,
      );
      for (let rank = 1; rank <= videosPerChannel; rank++) {
        const videoId = `video-${String(channelIndex * videosPerChannel + rank).padStart(7, '0')}`;
        videoIds.push(videoId);
        insertVideo.run(
          channelId,
          videoId,
          `Synthetic video ${channelIndex}-${rank}`,
          new Date(now - rank * 60_000).toISOString(),
          rank,
        );
      }
    }
    const eventTypes = ['impression', 'click', 'bounce', 'return'];
    for (let index = 0; index < historyCount; index++) {
      const videoId = videoIds[index % videoIds.length];
      const channelId = channelIds[Math.floor((index % videoIds.length) / videosPerChannel)];
      const eventType = eventTypes[Math.floor(index / videoIds.length) % eventTypes.length];
      insertEvent.run(
        userId,
        videoId,
        channelId,
        eventType,
        1 + (index % 10),
        index % 60,
        new Date(now - (index % 60) * 86_400_000).toISOString(),
        eventType === 'bounce' ? 15 : 0,
      );
      if (index % 17 === 0) insertTag.run(userId, videoId, 'saved');
      if (index % 31 === 0) insertDismissal.run(userId, videoId, channelId);
      if (index % 23 === 0) insertQueue.run(userId, videoId, channelId);
      if (index % 19 === 0) insertRating.run(userId, videoId, index % 38 === 0 ? -1 : 1);
      if (index % 97 === 0) {
        insertWatchTime.run(userId, videoId, 290, 300, new Date(now - index * 1_000).toISOString());
      }
    }
    for (let index = 0; index < downloadCount; index++) {
      insertDownload.run(
        `download-${String(index).padStart(7, '0')}`,
        `Download ${index}`,
        new Date(now - index * 1_000).toISOString(),
      );
    }
  })();
  db.prepare("INSERT INTO topic_filters VALUES (?, 'technology', 'boost')").run(userId);
  db.exec("INSERT INTO video_durations SELECT video_id, 300, 'not_live' FROM rss_videos");
  const todayArgs = {
    userId,
    publishedAfter: new Date(now - 24 * 60 * 60 * 1_000).toISOString(),
    perChannelLimit: 30,
    limit: 60,
    cursor: null,
    direction: 'older' as const,
  };
  const runTodayPage = () => {
    const page = querySqliteRssVideosCursorPageForUser(db, todayArgs);
    return {
      hasMore: page.hasMore,
      videos: page.items.map(row => ({
        videoId: row.video_id,
        title: row.title,
        duration: row.duration,
        liveStatus: row.live_status,
      })),
    };
  };
  const deepDownloadsQuery = db.prepare(
    'SELECT video_id, title, created_at FROM downloads ORDER BY created_at DESC LIMIT 40 OFFSET ?',
  );
  const relevantVideoIds = videoIds.slice(0, Math.min(3_500, videoIds.length));

  sqliteReadWorker = createSqliteReadWorker(databasePath);
  if (!sqliteReadWorker) throw new Error('SQLite read worker is disabled during its performance check');
  const workerArgs = {
    userId,
    relevantVideoIds,
    relevantChannelIds: channelIds,
    maxAgeDays: 90,
  };
  const warmWorkerRead = await sqliteReadWorker.queryUserSignals(workerArgs);
  if (warmWorkerRead.status !== 'success') {
    throw new Error(`SQLite read worker warmup failed: ${warmWorkerRead.status}`);
  }
  const timerStartedAt = performance.now();
  let workerEventLoopDelayMs = 0;
  const eventLoopProbe = new Promise<void>(resolve => {
    setTimeout(() => {
      workerEventLoopDelayMs = performance.now() - timerStartedAt;
      resolve();
    }, 0);
  });
  const [, measuredWorkerRead] = await Promise.all([
    eventLoopProbe,
    sqliteReadWorker.queryUserSignals(workerArgs),
  ]);
  if (measuredWorkerRead.status !== 'success') {
    throw new Error(`SQLite read worker measurement failed: ${measuredWorkerRead.status}`);
  }
  const snapshotWorkerArgs = {
    userId,
    perChannelLimit: 6,
    candidateLimit: 2_000,
    watchMaxAgeDays: 365,
    deepCutBefore: new Date(now - 180 * 86_400_000).toISOString(),
  };
  const warmSnapshotRead = await sqliteReadWorker.queryExploreRssSnapshot(snapshotWorkerArgs);
  if (warmSnapshotRead.status !== 'success') {
    throw new Error(`SQLite Explore snapshot worker warmup failed: ${warmSnapshotRead.status}`);
  }
  const snapshotTimerStartedAt = performance.now();
  let snapshotWorkerEventLoopDelayMs = 0;
  const snapshotEventLoopProbe = new Promise<void>(resolve => {
    setTimeout(() => {
      snapshotWorkerEventLoopDelayMs = performance.now() - snapshotTimerStartedAt;
      resolve();
    }, 0);
  });
  const [, measuredSnapshotRead] = await Promise.all([
    snapshotEventLoopProbe,
    sqliteReadWorker.queryExploreRssSnapshot(snapshotWorkerArgs),
  ]);
  if (measuredSnapshotRead.status !== 'success') {
    throw new Error(`SQLite Explore snapshot worker measurement failed: ${measuredSnapshotRead.status}`);
  }

  // Exercise the complete uncached Explore ranker with production-sized,
  // already-materialized query results. SQL input costs are measured above;
  // this measurement catches synchronous scoring/post-processing regressions
  // and explicitly checks whether they block the event loop enough to justify
  // the complexity and serialization cost of a worker thread.
  const { buildExploreVideosForBenchmark } = await import('../youtube/explore.js');
  const syntheticRssVideos: RSSVideoRow[] = [];
  const exploreCandidateLimit = Math.min(2_000, subscriptionCount * Math.min(6, videosPerChannel));
  for (let channelIndex = 0; channelIndex < subscriptionCount && syntheticRssVideos.length < exploreCandidateLimit; channelIndex++) {
    const channelId = channelIds[channelIndex];
    for (let rank = 1; rank <= Math.min(6, videosPerChannel) && syntheticRssVideos.length < exploreCandidateLimit; rank++) {
      const videoId = videoIds[channelIndex * videosPerChannel + rank - 1];
      syntheticRssVideos.push({
        channel_id: channelId,
        video_id: videoId,
        title: `Synthetic technology review episode ${channelIndex}-${rank}`,
        published_at: new Date(now - rank * 3_600_000 - channelIndex * 1_000).toISOString(),
        sub_title: `Channel ${channelIndex}`,
      });
    }
  }
  const syntheticChannelStats: RSSChannelStatsRow[] = channelIds.map((channelId, channelIndex) => ({
    channel_id: channelId,
    video_count: videosPerChannel,
    newest_published_at: new Date(now - (channelIndex + 1) * 60_000).toISOString(),
    median_interval_ms: 86_400_000,
  }));
  const syntheticWatchTimes = syntheticRssVideos.slice(0, Math.min(500, syntheticRssVideos.length)).map((video, index) => ({
    video_id: video.video_id,
    last_position: index % 5 === 0 ? 0 : 180 + (index % 100),
    duration: 600,
    updated_at: new Date(now - index * 60_000).toISOString(),
    channel_id: video.channel_id,
    title: video.title,
    published_at: video.published_at,
  }));
  const recentSubscriptionDates = new Map(
    channelIds.slice(0, Math.min(250, channelIds.length)).map((channelId, index) => [
      channelId,
      new Date(now - (index % 14) * 86_400_000).toISOString(),
    ]),
  );
  const candidateSignals: ExploreCandidateSignals = emptyExploreCandidateSignals();
  for (let index = 0; index < syntheticRssVideos.length; index++) {
    const video = syntheticRssVideos[index];
    candidateSignals.videoMetadata.durations[video.video_id] = 240 + (index % 1_200);
    candidateSignals.videoMetadata.liveStatuses[video.video_id] = 'not_live';
    candidateSignals.videoPopularity[video.video_id] = index % 80;
    candidateSignals.recentVideoPopularity[video.video_id] = index % 20;
    candidateSignals.communityRatings[video.video_id] = { up: index % 17, down: index % 5 };
    if (index < 800) {
      candidateSignals.videoMetadata.tags[video.video_id] = ['technology', `topic-${index % 40}`];
      candidateSignals.videoMetadata.descriptions[video.video_id]
        = `A detailed technology review and practical guide for topic ${index % 40}.`;
    }
  }
  for (let index = 0; index < channelIds.length; index++) {
    candidateSignals.channelSubscriberCounts[channelIds[index]] = index % 500;
    candidateSignals.channelImpressionCounts[channelIds[index]] = index % 120;
  }
  const userSignals = emptyExploreUserSignals();
  const exploreDatabase = {
    getRecentExploreSessions: async () => [],
    getExploreRssSnapshotForUser: async () => ({
      videos: syntheticRssVideos,
      channelStats: syntheticChannelStats,
    }),
    getExploreWatchTimes: async () => syntheticWatchTimes,
    getExploreSessionsForBackfill: async () => [],
    getRecentSubscriptionDates: async () => recentSubscriptionDates,
    getExploreUserSignals: async () => userSignals,
    updateExploreSession: async () => {},
    getRelatedVideosForSources: async () => [],
    getExploreCandidateSignals: async () => candidateSignals,
    getCoWatchedVideos: async () => [],
  } as unknown as DatabaseAPI;
  const runColdExploreBuild = () => buildExploreVideosForBenchmark(userId, exploreDatabase);
  const exploreColdBuild = await benchmarkAsync(runColdExploreBuild);
  const exploreTimerStartedAt = performance.now();
  let exploreBuildEventLoopDelayMs = 0;
  const exploreEventLoopProbe = new Promise<void>(resolve => {
    setTimeout(() => {
      exploreBuildEventLoopDelayMs = performance.now() - exploreTimerStartedAt;
      resolve();
    }, 0);
  });
  const [, measuredExploreResult] = await Promise.all([
    exploreEventLoopProbe,
    runColdExploreBuild(),
  ]);
  if (!measuredExploreResult.videos.length) {
    throw new Error('Cold Explore build benchmark produced no videos');
  }

  const results = {
    dataset: {
      subscriptions: subscriptionCount,
      rssVideos: videoIds.length,
      historyRows: historyCount,
      downloads: downloadCount,
    },
    today: benchmark(runTodayPage),
    exploreSignals: benchmark(() => querySqliteExploreUserSignals(
      db,
      userId,
      relevantVideoIds,
      channelIds,
      90,
    )),
    exploreColdBuild: {
      ...exploreColdBuild,
      eventLoopDelayMs: Number(exploreBuildEventLoopDelayMs.toFixed(2)),
      candidates: syntheticRssVideos.length,
      finalVideos: measuredExploreResult.videos.length,
    },
    deepDownloads: benchmark(() => deepDownloadsQuery.all(Math.max(0, downloadCount - 80))),
    sqliteReadWorker: {
      userSignalsEventLoopDelayMs: Number(workerEventLoopDelayMs.toFixed(2)),
      exploreSnapshotEventLoopDelayMs: Number(snapshotWorkerEventLoopDelayMs.toFixed(2)),
    },
    budgets,
  };
  console.log(JSON.stringify(results, null, 2));

  const failures: string[] = [];
  if (results.today.p95Ms > budgets.todayP95Ms) failures.push('today');
  if (results.exploreSignals.p95Ms > budgets.exploreSignalsP95Ms) failures.push('exploreSignals');
  if (results.exploreColdBuild.p95Ms > budgets.exploreColdBuildP95Ms) failures.push('exploreColdBuild');
  if (results.exploreColdBuild.eventLoopDelayMs > budgets.exploreColdBuildEventLoopMs) failures.push('exploreColdBuildEventLoop');
  if (results.deepDownloads.p95Ms > budgets.deepDownloadsP95Ms) failures.push('deepDownloads');
  if (
    Math.max(
      results.sqliteReadWorker.userSignalsEventLoopDelayMs,
      results.sqliteReadWorker.exploreSnapshotEventLoopDelayMs,
    ) > budgets.workerEventLoopDelayMs
  ) failures.push('sqliteReadWorker');
  if (failures.length) throw new Error(`Backend performance budget exceeded: ${failures.join(', ')}`);
} finally {
  await sqliteReadWorker?.close();
  db.close();
  rmSync(benchmarkDir, { recursive: true, force: true });
}
