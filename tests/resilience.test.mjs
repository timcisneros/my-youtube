import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { fork } from 'node:child_process';
import Database from 'better-sqlite3';
import { SharedLRUMap, resolveRedisUrls } from '../lib/cache.js';
import * as extractionQueue from '../lib/extraction-queue.js';
import * as rssRefreshQueue from '../lib/rss-refresh-queue.js';
import * as storage from '../lib/storage.js';
import * as segCache from '../lib/segment-cache.js';
import * as wsStatus from '../lib/ws-status.js';
import {
  dedup,
  fetchWithConnTimeout,
  getOutboundMediaState,
  runYtdlpTaskWithAdmission,
} from '../routes/stream/shared.js';
import { compactExtractionResult } from '../lib/extraction-result.js';
import { mapExploreCandidateSignalRows } from '../lib/explore-candidate-signals.js';
import { mapExploreUserSignalRows } from '../lib/explore-user-signals.js';
import { acquireRedisSemaphore } from '../lib/distributed-semaphore.js';
import { isMetricsRequestAuthorized } from '../lib/metrics-access.js';
import { getTodayVideosPage, paginateTodayVideos } from '../youtube/today.js';
import { shouldEnrichVideoDetails } from '../youtube/video-details.js';
import { parseWatchNextSnapshot } from '../youtube/watch-next.js';
import { readBodyBounded, upstreamHostLabel } from '../lib/bounded-fetch.js';
import { parseEmbeddedJsonBuffer, parseExtractionJsonBuffer, parseJsonBuffer } from '../lib/upstream-parser.js';
import { insertPriorityItem } from '../lib/ordered-priority-queue.js';
import { runBoundedSingleFlight, SingleFlightCapacityError } from '../lib/bounded-singleflight.js';
import { createSqliteReadWorker } from '../lib/sqlite-explore-reader.js';
import { acquireStatusConnection, getStatusConnectionState } from '../lib/status-connection-limiter.js';
import { queueAdmissionKeys, releaseQueueJob, reserveQueueJob } from '../lib/queue-admission.js';
import { loadOffsetPage } from '../lib/pagination.js';
import { estimateDownloadBytes } from '../lib/download-storage.js';
import { stopChild } from './helpers/child-process.mjs';

describe('Deployment asset caching', () => {
  it('recognizes generated content hashes at every edge and serves Compose assets directly', () => {
    const nginx = readFileSync(new URL('../nginx.conf', import.meta.url), 'utf8');
    const ansibleNginx = readFileSync(new URL('../deploy/ansible/templates/nginx-site.j2', import.meta.url), 'utf8');
    const varnish = readFileSync(new URL('../deploy/varnish.vcl', import.meta.url), 'utf8');
    const composeNginx = readFileSync(new URL('../deploy/nginx-compose.conf', import.meta.url), 'utf8');
    const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
    const dockerignore = readFileSync(new URL('../.dockerignore', import.meta.url), 'utf8');
    const compose = readFileSync(new URL('../docker-compose.yml', import.meta.url), 'utf8');

    for (const config of [nginx, ansibleNginx, composeNginx]) {
      assert.ok(config.includes('~^[0-9a-f]{16}$ "public, max-age=31536000, immutable"'));
      assert.match(config, /location = \/style\.css[\s\S]*?Cache-Control \$[A-Za-z0-9_]+ always;/);
    }
    assert.ok(varnish.includes('[?&]v=[0-9a-f]{16}(?:&|$)'));
    assert.match(dockerfile, /FROM nginx:1\.27-alpine AS edge[\s\S]*COPY --from=builder \/app\/public \/srv\/my-youtube\/public/);
    assert.match(dockerignore, /^tmp$/m);
    assert.match(compose, /edge:[\s\S]*target: edge/);
    assert.match(composeNginx, /root \/srv\/my-youtube\/public;/);
  });
});

describe('Compiled production runtime', () => {
  it('starts compiled entrypoints without shipping the TypeScript toolchain or source tree', () => {
    const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
    const compose = readFileSync(new URL('../docker-compose.yml', import.meta.url), 'utf8');

    assert.strictEqual(packageJson.scripts.start, 'node dist/cluster.js');
    assert.strictEqual(packageJson.scripts.worker, 'node dist/extraction-worker.js');
    assert.strictEqual(packageJson.dependencies.tsx, undefined);
    assert.ok(packageJson.devDependencies.tsx);
    assert.match(dockerfile, /RUN npm run build/);
    assert.match(dockerfile, /COPY --from=app-builder \/app\/dist \.\/dist/);
    assert.doesNotMatch(dockerfile, /COPY --from=app-builder \/app \/app/);
    assert.match(dockerfile, /CMD \["node", "dist\/cluster\.js"\]/);
    assert.match(compose, /command: \["node", "dist\/migrate\.js"\]/);
    assert.match(compose, /command: \["node", "dist\/extraction-worker\.js"\]/);
  });
});

describe('Bounded upstream parsing', () => {
  it('moves large JSON decoding off the event loop', async () => {
    const source = Buffer.from(JSON.stringify({
      videoDetails: { videoId: 'dQw4w9WgXcQ', title: 'Worker parsed' },
      padding: 'x'.repeat(512 * 1024),
    }));
    let timerRan = false;
    const timer = setTimeout(() => { timerRan = true; }, 0);
    const parsed = await parseJsonBuffer(source);
    clearTimeout(timer);

    assert.strictEqual(parsed.videoDetails.title, 'Worker parsed');
    assert.strictEqual(timerRan, true, 'large parsing should yield to other event-loop work');
  });

  it('extracts embedded playlist JSON through the same reusable worker', async () => {
    const data = {
      metadata: { playlistMetadataRenderer: { title: 'Worker playlist' } },
      quoted: 'a } brace and an escaped " quote',
      padding: 'y'.repeat(512 * 1024),
    };
    const html = Buffer.from(`<html><script>var ytInitialData = ${JSON.stringify(data)};</script></html>`);
    const parsed = await parseEmbeddedJsonBuffer(html, 'ytInitialData');

    assert.strictEqual(parsed.metadata.playlistMetadataRenderer.title, 'Worker playlist');
    assert.strictEqual(parsed.quoted, data.quoted);
  });

  it('parses and compacts large yt-dlp output in an isolated worker lane', async () => {
    const source = Buffer.from(JSON.stringify({
      title: 'Worker extraction',
      description: 'd'.repeat(30_000),
      formats: Array.from({ length: 600 }, (_, index) => ({
        format_id: String(index),
        url: `https://example.test/${index}`,
        protocol: 'https',
        internal: 'drop-me',
      })),
      unused: 'z'.repeat(512 * 1024),
    }));
    let timerRan = false;
    const timer = setTimeout(() => { timerRan = true; }, 0);
    const parsed = await parseExtractionJsonBuffer(source, 'yt-dlp:test');
    clearTimeout(timer);

    assert.strictEqual(timerRan, true, 'large extraction parsing should yield to event-loop work');
    assert.strictEqual(parsed._extractedVia, 'yt-dlp:test');
    assert.strictEqual(parsed.description.length, 20_000);
    assert.strictEqual(parsed.formats.length, 512);
    assert.strictEqual(parsed.formats[0].internal, undefined);
    assert.strictEqual(parsed.unused, undefined);
  });
});

// ---------------------------------------------------------------------------
// These tests verify the app doesn't crash when optional services fail
// ---------------------------------------------------------------------------

describe('In-flight request deduplication', () => {
  it('shares one request and clears it after success', async () => {
    const inflight = new Map();
    let calls = 0;
    const first = dedup(inflight, 'video', async () => {
      calls++;
      await new Promise(resolve => setTimeout(resolve, 5));
      return 'ready';
    });
    const second = dedup(inflight, 'video', async () => {
      calls++;
      return 'duplicate';
    });

    assert.strictEqual(first, second);
    assert.deepStrictEqual(await Promise.all([first, second]), ['ready', 'ready']);
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(calls, 1);
    assert.strictEqual(inflight.has('video'), false);
  });

  it('cleans up rejected and synchronously failing requests without an orphan rejection', async () => {
    const inflight = new Map();
    const asyncFailure = dedup(inflight, 'async-failure', async () => {
      throw new Error('async boom');
    });
    await assert.rejects(asyncFailure, /async boom/);

    const syncFailure = dedup(inflight, 'sync-failure', () => {
      throw new Error('sync boom');
    });
    await assert.rejects(syncFailure, /sync boom/);
    await new Promise(resolve => setImmediate(resolve));

    assert.strictEqual(inflight.has('async-failure'), false);
    assert.strictEqual(inflight.has('sync-failure'), false);
  });

  it('joins existing keys but rejects new keys at bounded capacity', async () => {
    const inflight = new Map();
    let release;
    const first = runBoundedSingleFlight(inflight, 'first', () => new Promise(resolve => {
      release = resolve;
    }), { name: 'test', maxEntries: 1 });
    const follower = runBoundedSingleFlight(inflight, 'first', () => 'duplicate', {
      name: 'test', maxEntries: 1,
    });
    const overload = runBoundedSingleFlight(inflight, 'second', () => 'should-not-run', {
      name: 'test', maxEntries: 1,
    });

    assert.strictEqual(first, follower);
    await assert.rejects(overload, error => error instanceof SingleFlightCapacityError);
    release('ready');
    assert.deepStrictEqual(await Promise.all([first, follower]), ['ready', 'ready']);
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(inflight.size, 0);
    assert.strictEqual(await runBoundedSingleFlight(inflight, 'second', () => 'next', {
      name: 'test', maxEntries: 1,
    }), 'next');
  });
});

describe('Bounded stream admission', () => {
  it('never replays a failed yt-dlp task after Redis admission succeeds', async () => {
    let taskCalls = 0;
    let releases = 0;
    const redis = {
      async eval() { return 1; },
      async zrem() { releases++; return 1; },
    };
    await assert.rejects(
      runYtdlpTaskWithAdmission(async () => {
        taskCalls++;
        throw new Error('extractor failed');
      }, {}, redis),
      /extractor failed/,
    );
    assert.strictEqual(taskCalls, 1);
    assert.strictEqual(releases, 1);
  });

  it('enforces status connection capacity and releases leases idempotently', () => {
    const initial = getStatusConnectionState();
    assert.strictEqual(initial.active, 0);
    const leases = [];
    const capacity = Math.min(initial.localLimit, initial.perIpLimit);
    for (let index = 0; index < capacity; index++) {
      const release = acquireStatusConnection('203.0.113.10', 'sse');
      assert.ok(release);
      leases.push(release);
    }
    assert.strictEqual(acquireStatusConnection('203.0.113.10', 'sse'), null);
    for (const release of leases) {
      release();
      release();
    }
    assert.strictEqual(getStatusConnectionState().active, 0);
  });
});

describe('Bounded SQLite read worker', () => {
  it('returns the Explore RSS snapshot without running its query on the caller thread', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'sqlite-explore-snapshot-worker-'));
    const databasePath = path.join(directory, 'test.db');
    const database = new Database(databasePath);
    database.exec(`
      CREATE TABLE subscriptions (user_id TEXT, channel_id TEXT, title TEXT);
      CREATE TABLE rss_videos (channel_id TEXT, video_id TEXT, title TEXT, published_at TEXT, channel_rank INTEGER);
      CREATE TABLE watch_time (user_id TEXT, video_id TEXT, updated_at TEXT, duration REAL, last_position REAL);
      CREATE TABLE tags (user_id TEXT, video_id TEXT);
      CREATE TABLE dismissals (user_id TEXT, video_id TEXT);
      CREATE TABLE channel_mutes (user_id TEXT, channel_id TEXT);
      CREATE TABLE channel_boosts (user_id TEXT, channel_id TEXT);
      CREATE TABLE watch_queue (user_id TEXT, video_id TEXT, channel_id TEXT);
      CREATE TABLE rss_channel_stats (
        channel_id TEXT, video_count INTEGER, newest_published_at TEXT, median_interval_ms REAL
      );
      INSERT INTO subscriptions VALUES ('user-1', 'channel-1', 'Channel One');
      INSERT INTO rss_videos VALUES ('channel-1', 'video-1', 'Newest', '2026-08-01T12:00:00Z', 1);
      INSERT INTO rss_channel_stats VALUES ('channel-1', 1, '2026-08-01T12:00:00Z', 86400000);
    `);
    database.close();
    const worker = createSqliteReadWorker(databasePath);
    try {
      assert.ok(worker);
      let timerRan = false;
      const timer = setTimeout(() => { timerRan = true; }, 0);
      const result = await worker.queryExploreRssSnapshot({
        userId: 'user-1',
        perChannelLimit: 6,
        candidateLimit: 20,
        watchMaxAgeDays: 365,
        deepCutBefore: '2026-07-01T00:00:00Z',
      });
      clearTimeout(timer);
      assert.strictEqual(timerRan, true);
      assert.strictEqual(result.status, 'success');
      assert.deepStrictEqual(result.value.videos.map(row => row.video_id), ['video-1']);
      assert.deepStrictEqual(result.value.channelStats.map(row => row.channel_id), ['channel-1']);
    } finally {
      await worker?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('load-sheds excess distinct work before it enters the worker message queue', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'sqlite-read-worker-'));
    const databasePath = path.join(directory, 'test.db');
    new Database(databasePath).close();
    const previousMax = process.env.SQLITE_EXPLORE_WORKER_MAX_PENDING;
    const previousEnabled = process.env.SQLITE_EXPLORE_WORKER;
    process.env.SQLITE_EXPLORE_WORKER_MAX_PENDING = '4';
    delete process.env.SQLITE_EXPLORE_WORKER;
    const worker = createSqliteReadWorker(databasePath);
    try {
      assert.ok(worker);
      const args = {
        metadataVideoIds: [], richMetadataVideoIds: [], candidateVideoIds: [], candidateChannelIds: [],
        excludeUserId: 'test-user', recentWithinHours: 24,
      };
      const requests = Array.from({ length: 5 }, () => worker.queryCandidateSignals(args));
      assert.deepStrictEqual(await requests[4], { status: 'overloaded' });
      await worker.close();
      const remaining = await Promise.all(requests.slice(0, 4));
      assert.ok(remaining.every(result => result.status === 'unavailable' || result.status === 'success'));
    } finally {
      await worker?.close();
      if (previousMax === undefined) delete process.env.SQLITE_EXPLORE_WORKER_MAX_PENDING;
      else process.env.SQLITE_EXPLORE_WORKER_MAX_PENDING = previousMax;
      if (previousEnabled === undefined) delete process.env.SQLITE_EXPLORE_WORKER;
      else process.env.SQLITE_EXPLORE_WORKER = previousEnabled;
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 1. SharedLRUMap with failed Redis
// ---------------------------------------------------------------------------

describe('SharedLRUMap with failed Redis', () => {
  before(() => {
    // Ensure no Redis
    delete process.env.REDIS_URL;
  });

  it('set/get/delete should work even when Redis operations would fail', () => {
    const cache = new SharedLRUMap(10, 'resilience-test');
    cache.set('key1', { data: 'hello' });
    assert.deepStrictEqual(cache.get('key1'), { data: 'hello' });
    assert.strictEqual(cache.has('key1'), true);
    cache.delete('key1');
    assert.strictEqual(cache.get('key1'), undefined);
    assert.strictEqual(cache.has('key1'), false);
  });

  it('getAsync should resolve to undefined on miss (no Redis)', async () => {
    const cache = new SharedLRUMap(10, 'resilience-test');
    const result = await cache.getAsync('nonexistent');
    assert.strictEqual(result, undefined);
  });

  it('getAsync should return L1 value when present', async () => {
    const cache = new SharedLRUMap(10, 'resilience-test');
    cache.set('present', 42);
    const result = await cache.getAsync('present');
    assert.strictEqual(result, 42);
  });

  it('deleteAsync should remove a local value without Redis', async () => {
    const cache = new SharedLRUMap(10, 'resilience-test');
    cache.set('present', 42);
    assert.strictEqual(await cache.deleteAsync('present'), true);
    assert.strictEqual(cache.get('present'), undefined);
  });

  it('eviction should still work correctly', () => {
    const cache = new SharedLRUMap(2, 'resilience-test');
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3); // should evict 'a'
    assert.strictEqual(cache.has('a'), false);
    assert.strictEqual(cache.get('b'), 2);
    assert.strictEqual(cache.get('c'), 3);
  });

  it('bounds L1 memory by serialized bytes and drops oversized values', () => {
    const cache = new SharedLRUMap(10, 'byte-budget-test', {
      maxL1Bytes: 64 * 1024,
      maxL1ValueBytes: 64 * 1024,
    });
    cache.set('first', { payload: 'a'.repeat(40 * 1024) });
    cache.set('second', { payload: 'b'.repeat(40 * 1024) });
    assert.strictEqual(cache.has('first'), false);
    assert.strictEqual(cache.has('second'), true);

    const valueBounded = new SharedLRUMap(10, 'value-budget-test', {
      maxL1Bytes: 64 * 1024,
      maxL1ValueBytes: 16 * 1024,
    });
    valueBounded.set('oversized', { payload: 'x'.repeat(20 * 1024) });
    assert.strictEqual(valueBounded.has('oversized'), false);
  });
});

describe('Video detail enrichment retry policy', () => {
  it('does not retry valid negative fields after a completed response', () => {
    assert.strictEqual(shouldEnrichVideoDetails({
      videoId: 'dQw4w9WgXcQ', likeCount: null, viewCount: '10',
      publishedAt: '2026-08-01', descriptionLinks: [], detailsComplete: true,
    }), false);
  });

  it('backs off transient enrichment failures and retries after the window', () => {
    const now = Date.now();
    const details = { videoId: 'dQw4w9WgXcQ', enrichmentAttemptedAt: now };
    assert.strictEqual(shouldEnrichVideoDetails(details, now + 1_000), false);
    assert.strictEqual(shouldEnrichVideoDetails(details, now + 10 * 60_000), true);
  });

  it('compacts Watch Next details and the comments continuation into one snapshot', () => {
    const snapshot = parseWatchNextSnapshot({
      contents: {
        twoColumnWatchNextResults: {
          results: { results: { contents: [
            {
              videoPrimaryInfoRenderer: {
                title: { runs: [{ text: 'Shared payload' }] },
                viewCount: { videoViewCountRenderer: { viewCount: { simpleText: '1,234 views' } } },
                videoActions: { menuRenderer: { topLevelButtons: [{
                  segmentedLikeDislikeButtonViewModel: { likeButtonViewModel: { likeButtonViewModel: {
                    toggleButtonViewModel: { toggleButtonViewModel: {
                      defaultButtonViewModel: { buttonViewModel: { title: '99' } },
                    } },
                  } } },
                }] } },
              },
            },
            {
              itemSectionRenderer: {
                sectionIdentifier: 'comment-item-section',
                contents: [{ continuationItemRenderer: {
                  continuationEndpoint: { continuationCommand: { token: 'COMMENTS_TOKEN' } },
                } }],
              },
            },
          ] } },
        },
      },
    });
    assert.strictEqual(snapshot.title, 'Shared payload');
    assert.strictEqual(snapshot.viewCount, '1234');
    assert.strictEqual(snapshot.likeCount, '99');
    assert.strictEqual(snapshot.commentContinuation, 'COMMENTS_TOKEN');
  });
});

describe('Redis workload isolation', () => {
  it('keeps the single-Redis default while allowing a dedicated cache endpoint', () => {
    assert.deepStrictEqual(resolveRedisUrls({ REDIS_URL: 'redis://coord:6379' }), {
      coordinationUrl: 'redis://coord:6379',
      cacheUrl: 'redis://coord:6379',
    });
    assert.deepStrictEqual(resolveRedisUrls({
      REDIS_URL: 'redis://coord:6379',
      CACHE_REDIS_URL: 'redis://cache:6379',
    }), {
      coordinationUrl: 'redis://coord:6379',
      cacheUrl: 'redis://cache:6379',
    });
  });
});

describe('Today pagination', () => {
  it('serves an empty first page without requiring upstream work', async () => {
    const result = await getTodayVideosPage(`resilience-empty-${Date.now()}`, null);
    assert.deepStrictEqual(result.videos, []);
  });

  it('bounds cards and clamps invalid or out-of-range pages', () => {
    const videos = Array.from({ length: 125 }, (_, index) => ({ videoId: `video-${index}` }));
    const second = paginateTodayVideos(videos, 2, 60);
    assert.strictEqual(second.videos.length, 60);
    assert.strictEqual(second.videos[0].videoId, 'video-60');
    assert.strictEqual(second.prevPage, 1);
    assert.strictEqual(second.nextPage, 3);
    assert.strictEqual(second.totalPages, 3);

    const clamped = paginateTodayVideos(videos, 999, 60);
    assert.strictEqual(clamped.page, 3);
    assert.strictEqual(clamped.videos.length, 5);
    assert.strictEqual(clamped.nextPage, null);
  });
});

describe('Download storage admission', () => {
  it('uses declared format sizes when reserving a video download', () => {
    assert.strictEqual(estimateDownloadBytes([
      { expectedBytes: 10_000 },
      { expectedBytes: 20_000 },
    ]), 30_000);
  });
});

describe('Bounded page and distributed queue admission', () => {
  it('caps deep numbered-page offsets before invoking a database loader', async () => {
    const offsets = [];
    const page = await loadOffsetPage(999_999_999, 40, async (offset) => {
      offsets.push(offset);
      return { items: [{ offset }], totalResults: 1_000_000 };
    });
    assert.deepStrictEqual(offsets, [99_960]);
    assert.strictEqual(page.page, 2_500);
    assert.strictEqual(page.totalPages, 2_500);
  });

  it('uses Redis-cluster-safe keys and releases global, background, and owner leases', async () => {
    let evalCall;
    const removals = [];
    const client = {
      async eval(...args) {
        evalCall = args;
        return [1, 4, 2, 1];
      },
      async zrem(key, member) {
        removals.push([key, member]);
        return 1;
      },
    };
    const result = await reserveQueueJob(client, {
      namespace: 'downloads',
      jobId: 'download:video1234567',
      maxJobs: 100,
      leaseMs: 120_000,
      owner: 'owner-a',
      maxOwnerJobs: 5,
    });
    assert.deepStrictEqual(result, { status: 'reserved', total: 4, background: 2, owner: 1 });
    const keys = queueAdmissionKeys('downloads', 'owner-a');
    assert.ok(Object.values(keys).every(key => key.includes('{downloads}')));
    assert.deepStrictEqual(evalCall.slice(2, 5), [keys.global, keys.background, keys.owner]);

    await releaseQueueJob(client, 'downloads', 'download:video1234567', 'owner-a');
    assert.deepStrictEqual(removals, [
      [keys.global, 'download:video1234567'],
      [keys.background, 'download:video1234567'],
      [keys.owner, 'download:video1234567'],
    ]);
  });
});

describe('Production control-plane routing', () => {
  it('routes WebSocket/SSE controls before media regexes and applies extraction limits to prefetch', () => {
    for (const relativePath of ['../nginx.conf', '../deploy/ansible/templates/nginx-site.j2']) {
      const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8');
      const statusIndex = source.indexOf('location ~ ^/api/stream/[A-Za-z0-9_-]{11}/status$');
      const durationIndex = source.indexOf('location = /api/stream/durations-live');
      const prefetchIndex = source.indexOf('/prefetch$');
      const mediaIndex = source.indexOf('location ~ ^/api/stream/ {');
      assert.match(source, /location = \/ws\/status[\s\S]*proxy_set_header Upgrade \$http_upgrade/);
      assert.ok(statusIndex >= 0 && durationIndex >= 0 && prefetchIndex >= 0);
      assert.ok(statusIndex < mediaIndex && durationIndex < mediaIndex && prefetchIndex < mediaIndex);
      assert.match(source, /prefetch\$[\s\S]*limit_req zone=extraction/);
    }
  });

  it('bounds duration SSE work and keeps media bytes outside the control-plane limiter', () => {
    const assets = readFileSync(new URL('../routes/stream/assets.ts', import.meta.url), 'utf8');
    const server = readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
    assert.match(assets, /DURATION_STATUS_MAX_AGE_MS/);
    assert.match(assets, /acquireStatusConnection\(req\.ip, 'duration_sse'\)/);
    assert.match(assets, /resolveVideoMetadata\(missing, 3, \{[\s\S]*mode: 'lightweight'/);
    assert.match(assets, /skipStoredLookup: true/);
    assert.doesNotMatch(assets, /while \(extractionInflight/);
    assert.match(server, /isStreamDataPlanePath\(req\.path\)/);
    assert.doesNotMatch(server, /req\.path\.startsWith\('\/api\/stream'\)/);
  });

  it('uses one PostgreSQL window-count query on ordinary pages and installs trigram search', () => {
    const source = readFileSync(new URL('../db-pg.ts', import.meta.url), 'utf8');
    assert.ok((source.match(/COUNT\(\*\) OVER \(\)/g) || []).length >= 5);
    assert.match(source, /CREATE EXTENSION IF NOT EXISTS pg_trgm/);
    assert.match(source, /gin_trgm_ops/);
    assert.match(source, /pageFromWindowRows/);
    assert.match(source, /idx_watch_queue_user_created_video/);
  });
});

describe('Bounded performance labels and ordered wait queues', () => {
  it('collapses signed CDN hosts into bounded upstream categories', () => {
    assert.strictEqual(upstreamHostLabel('rr1---sn-a5mekn7z.googlevideo.com'), 'youtube_media');
    assert.strictEqual(upstreamHostLabel('i.ytimg.com'), 'youtube_image');
    assert.strictEqual(upstreamHostLabel('www.youtube.com'), 'youtube');
    assert.strictEqual(upstreamHostLabel('youtube.googleapis.com'), 'youtube_api');
    assert.strictEqual(upstreamHostLabel('unexpected.example'), 'other');
  });

  it('inserts priority waiters in stable FIFO order without a full sort', () => {
    const queue = [];
    for (const item of [
      { priority: 10, order: 0, value: 'background-1' },
      { priority: 1, order: 1, value: 'interactive-1' },
      { priority: 10, order: 2, value: 'background-2' },
      { priority: 1, order: 3, value: 'interactive-2' },
    ]) insertPriorityItem(queue, item);
    assert.deepStrictEqual(queue.map(item => item.value), [
      'interactive-1', 'interactive-2', 'background-1', 'background-2',
    ]);
  });

  it('rejects oversized upstream bodies with and without a declared length', async () => {
    const declared = new Response('small', { headers: { 'Content-Length': '4096' } });
    await assert.rejects(readBodyBounded(declared, 1024, 'declared-too-large'), /declared-too-large/);

    const streamed = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(768));
        controller.enqueue(new Uint8Array(768));
        controller.close();
      },
    }));
    await assert.rejects(readBodyBounded(streamed, 1024, 'stream-too-large'), /stream-too-large/);
  });
});

// ---------------------------------------------------------------------------
// 2. Extraction queue fallback
// ---------------------------------------------------------------------------

describe('Extraction queue fallback', () => {
  before(() => {
    delete process.env.REDIS_URL;
  });

  it('hasQueue() should return false without REDIS_URL', () => {
    assert.strictEqual(extractionQueue.hasQueue(), false);
  });

  it('enqueueExtraction() should return null gracefully', async () => {
    const result = await extractionQueue.enqueueExtraction('someVideoId', 5000);
    assert.strictEqual(result, null);
  });

  it('enqueueExtraction() should not throw', async () => {
    await assert.doesNotReject(async () => {
      await extractionQueue.enqueueExtraction('anotherVideoId', 1000);
    });
  });
});

describe('RSS refresh queue fallback', () => {
  it('stays disabled unless a worker-backed queue is explicitly enabled', async () => {
    const previousEnabled = process.env.RSS_REFRESH_QUEUE_ENABLED;
    const previousQueueUrl = process.env.QUEUE_REDIS_URL;
    try {
      delete process.env.RSS_REFRESH_QUEUE_ENABLED;
      delete process.env.QUEUE_REDIS_URL;
      assert.strictEqual(await rssRefreshQueue.initRssRefreshQueue(), false);
      assert.strictEqual(rssRefreshQueue.hasRssRefreshQueue(), false);
      assert.strictEqual(await rssRefreshQueue.enqueueRssRefresh('UC_test_channel'), null);
      assert.strictEqual(await rssRefreshQueue.enqueueRssRefreshBatch([
        { channelId: 'UC_test_channel' },
      ]), null);
    } finally {
      if (previousEnabled === undefined) delete process.env.RSS_REFRESH_QUEUE_ENABLED;
      else process.env.RSS_REFRESH_QUEUE_ENABLED = previousEnabled;
      if (previousQueueUrl === undefined) delete process.env.QUEUE_REDIS_URL;
      else process.env.QUEUE_REDIS_URL = previousQueueUrl;
    }
  });
});

describe('Extraction performance coordination', () => {
  it('uses renewable owned leases, one queue path, and bounded hedged fallbacks', () => {
    const cacheSource = readFileSync(new URL('../lib/cache.ts', import.meta.url), 'utf8');
    const sharedSource = readFileSync(new URL('../routes/stream/shared.ts', import.meta.url), 'utf8');
    const extractionSource = readFileSync(new URL('../routes/stream/extraction.ts', import.meta.url), 'utf8');
    const queueSource = readFileSync(new URL('../lib/extraction-queue.ts', import.meta.url), 'utf8');
    const strategySource = readFileSync(new URL('../lib/extraction-strategy.ts', import.meta.url), 'utf8');
    const mpdSource = readFileSync(new URL('../routes/stream/mpd.ts', import.meta.url), 'utf8');
    const appSource = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

    assert.match(cacheSource, /randomUUID\(\)/);
    assert.match(cacheSource, /redis\.call\('get', KEYS\[1\]\) == ARGV\[1\]/);
    assert.match(sharedSource, /ytdlp:leases/);
    assert.match(sharedSource, /zremrangebyscore/);
    assert.match(queueSource, /changePriority\(\{ priority \}\)/);
    assert.match(extractionSource, /status === 'pending'/);
    assert.doesNotMatch(extractionSource, /falling back to in-process/);
    assert.match(strategySource, /EXTRACTION_DEADLINE_MS/);
    assert.match(strategySource, /firstUsable/);
    assert.match(mpdSource, /selectStartupProbeFormats/);
    assert.match(mpdSource, /mapWithConcurrency\(formats, 4/);
    assert.match(mpdSource, /acquireLock\(manifestLockKey/);
    assert.match(mpdSource, /manifest_lock_wait_seconds/);
    assert.doesNotMatch(appSource, /Hover prefetch: start yt-dlp extraction/);
  });
});

describe('Bounded extraction transport', () => {
  it('keeps playback fields while removing unconsumed and oversized metadata', () => {
    const formats = Array.from({ length: 600 }, (_, index) => ({
      format_id: String(index),
      url: `https://example.test/${index}`,
      ext: index === 0 ? 'm4a' : 'mp4',
      acodec: index === 0 ? 'mp4a.40.2' : 'none',
      vcodec: index === 0 ? 'none' : 'avc1.4d401f',
      http_headers: { Cookie: 'must-not-cross-processes' },
      extractor_internal_state: 'drop',
    }));
    formats.push({
      format_id: 'storyboard', protocol: 'mhtml', rows: 10, columns: 10,
      fragments: [{ url: 'https://example.test/sheet', duration: 200, internal: 'drop' }],
    });
    const compact = compactExtractionResult({
      title: 'Video',
      description: 'x'.repeat(30_000),
      formats,
      subtitles: { es: [{ ext: 'vtt', url: 'signed-caption-url' }] },
      automatic_captions: { en: [{ ext: 'vtt', url: 'signed-auto-url' }], fr: [{ ext: 'vtt' }] },
      chapters: [{ start_time: 0, end_time: 10, title: 'Intro', internal: 'drop' }],
      thumbnails: Array.from({ length: 500 }, () => ({ url: 'unused' })),
    });

    assert.ok(compact.formats.length <= 512);
    assert.ok(compact.formats.some(format => format.protocol === 'mhtml'));
    assert.strictEqual(compact.formats[0].http_headers, undefined);
    assert.strictEqual(compact.formats[0].extractor_internal_state, undefined);
    assert.strictEqual(compact.description.length, 20_000);
    assert.strictEqual(compact.subtitles.es[0].url, 'signed-caption-url');
    assert.strictEqual(compact.automatic_captions.en[0].url, 'signed-auto-url');
    assert.deepStrictEqual(Object.keys(compact.automatic_captions), ['en']);
    assert.strictEqual(compact.thumbnails, undefined);
  });
});

describe('Explore candidate signal mapping', () => {
  it('maps the consolidated video and channel rows into ranking inputs', () => {
    const signals = mapExploreCandidateSignalRows([
      {
        entity_type: 'video', entity_id: 'video-1', duration: 120, live_status: 'not_live',
        tags: '["topic"]', description: 'description', popularity: 5, recent_popularity: 2,
        rating_up: 3, rating_down: 1, subscriber_count: null, impression_count: null,
      },
      {
        entity_type: 'channel', entity_id: 'channel-1', duration: null, live_status: null,
        tags: null, description: null, popularity: null, recent_popularity: null,
        rating_up: null, rating_down: null, subscriber_count: 7, impression_count: 11,
      },
      {
        entity_type: 'video', entity_id: 'unrated-video', duration: null, live_status: null,
        tags: null, description: null, popularity: 0, recent_popularity: null,
        rating_up: 0, rating_down: 0, subscriber_count: null, impression_count: null,
      },
    ]);
    assert.strictEqual(signals.videoMetadata.durations['video-1'], 120);
    assert.deepStrictEqual(signals.videoMetadata.tags['video-1'], ['topic']);
    assert.strictEqual(signals.videoPopularity['video-1'], 5);
    assert.strictEqual(signals.recentVideoPopularity['video-1'], 2);
    assert.deepStrictEqual(signals.communityRatings['video-1'], { up: 3, down: 1 });
    assert.strictEqual(signals.communityRatings['unrated-video'], undefined);
    assert.strictEqual(signals.channelSubscriberCounts['channel-1'], 7);
    assert.strictEqual(signals.channelImpressionCounts['channel-1'], 11);
  });
});

describe('Metrics access control', () => {
  it('allows loopback or a valid token and rejects forwarded public clients by default', () => {
    const previousToken = process.env.METRICS_TOKEN;
    const previousPublic = process.env.METRICS_ALLOW_PUBLIC;
    process.env.METRICS_TOKEN = 'test-metrics-token';
    delete process.env.METRICS_ALLOW_PUBLIC;
    const request = (remoteAddress, headers = {}) => ({ socket: { remoteAddress }, headers });
    try {
      assert.strictEqual(isMetricsRequestAuthorized(request('127.0.0.1')), true);
      assert.strictEqual(isMetricsRequestAuthorized(request('203.0.113.5', { 'x-forwarded-for': '127.0.0.1' })), false);
      assert.strictEqual(isMetricsRequestAuthorized(request('127.0.0.1', { 'x-forwarded-for': '203.0.113.5' })), false);
      assert.strictEqual(isMetricsRequestAuthorized(request('203.0.113.5', { authorization: 'Bearer test-metrics-token' })), true);
      assert.strictEqual(isMetricsRequestAuthorized(request('203.0.113.5', { authorization: 'Bearer wrong' })), false);
    } finally {
      if (previousToken === undefined) delete process.env.METRICS_TOKEN;
      else process.env.METRICS_TOKEN = previousToken;
      if (previousPublic === undefined) delete process.env.METRICS_ALLOW_PUBLIC;
      else process.env.METRICS_ALLOW_PUBLIC = previousPublic;
    }
  });
});

describe('Remaining performance coordination', () => {
  it('maps one scoped Explore signal result without full-history follow-up reads', () => {
    const result = mapExploreUserSignalRows([
      { kind: 'event', video_id: 'v1', channel_id: 'c1', text_value: 'bounce', numeric_value: 2, position: 4, created_at: '2026-01-01T00:00:00Z', bounce_seconds: 12, duration: 321 },
      { kind: 'tag', video_id: 'v1', channel_id: null, text_value: null, numeric_value: null, position: null, created_at: null, bounce_seconds: null },
      { kind: 'dismissal', video_id: 'v2', channel_id: null, text_value: null, numeric_value: null, position: null, created_at: null, bounce_seconds: null },
      { kind: 'boost', video_id: null, channel_id: 'c1', text_value: null, numeric_value: null, position: null, created_at: null, bounce_seconds: null },
      { kind: 'queue', video_id: 'v3', channel_id: 'c1', text_value: null, numeric_value: null, position: null, created_at: null, bounce_seconds: null },
      { kind: 'rating', video_id: 'v1', channel_id: null, text_value: null, numeric_value: -1, position: null, created_at: null, bounce_seconds: null },
      { kind: 'topic', video_id: 'technology', channel_id: null, text_value: 'boost', numeric_value: null, position: null, created_at: null, bounce_seconds: null },
      { kind: 'return', video_id: null, channel_id: 'c1', text_value: null, numeric_value: 3, position: null, created_at: null, bounce_seconds: null },
      { kind: 'behavior', video_id: null, channel_id: 'c2', text_value: null, numeric_value: null, position: null, created_at: null, bounce_seconds: null, behavior_json: '{"impressions":12,"clicks":4,"bounces":1,"returns":2}' },
    ]);
    assert.deepStrictEqual(result.taggedVideoIds, ['v1']);
    assert.deepStrictEqual(result.dismissedVideoIds, ['v2']);
    assert.deepStrictEqual(result.boostedChannelIdRows, ['c1']);
    assert.deepStrictEqual(result.queuedVideoIdRows, ['v3']);
    assert.deepStrictEqual(result.ratingRows, [{ video_id: 'v1', rating: -1 }]);
    assert.deepStrictEqual(result.exploreBounces, [{ video_id: 'v1', channel_id: 'c1', bounce_seconds: 12 }]);
    assert.deepStrictEqual(result.returnChannelCounts, { c1: 3, c2: 2 });
    assert.deepStrictEqual(result.channelBehaviors.c2, { impressions: 12, clicks: 4, bounces: 1, returns: 2 });
    assert.deepStrictEqual(result.eventDurations, { v1: 321 });
  });

  it('acquires and idempotently releases a renewable Redis semaphore lease', async () => {
    const calls = [];
    const client = {
      async eval(...args) { calls.push(['eval', ...args]); return 1; },
      async zrem(...args) { calls.push(['zrem', ...args]); return 1; },
    };
    const lease = await acquireRedisSemaphore(client, {
      key: 'semaphore:test', limit: 2, leaseMs: 5_000, waitTimeoutMs: 1_000,
    });
    assert.ok(lease.waitMs >= 0);
    await lease.release();
    await lease.release();
    assert.strictEqual(calls.filter(call => call[0] === 'zrem').length, 1);
  });

  it('does not enter a distributed semaphore after cancellation', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancelled-before-slot'));
    const client = {
      async eval() { throw new Error('should not execute'); },
      async zrem() { return 1; },
    };
    await assert.rejects(
      acquireRedisSemaphore(client, {
        key: 'semaphore:test', limit: 1, leaseMs: 5_000, waitTimeoutMs: 1_000,
      }, controller.signal),
      /cancelled-before-slot/,
    );
  });

  it('uses async database reads, cross-worker caches, bounded Today work, and metadata deduplication', () => {
    const dbSource = readFileSync(new URL('../db.ts', import.meta.url), 'utf8');
    const pgSource = readFileSync(new URL('../db-pg.ts', import.meta.url), 'utf8');
    const cacheSource = readFileSync(new URL('../lib/cache.ts', import.meta.url), 'utf8');
    const queueSource = readFileSync(new URL('../lib/extraction-queue.ts', import.meta.url), 'utf8');
    const rssQueueSource = readFileSync(new URL('../lib/rss-refresh-queue.ts', import.meta.url), 'utf8');
    const sqliteReadWorkerSource = readFileSync(new URL('../lib/sqlite-explore-worker.ts', import.meta.url), 'utf8');
    const sqliteReadReaderSource = readFileSync(new URL('../lib/sqlite-explore-reader.ts', import.meta.url), 'utf8');
    const playlistSchedulerSource = readFileSync(new URL('../lib/playlist-refresh-scheduler.ts', import.meta.url), 'utf8');
    const playlistRouteSource = readFileSync(new URL('../routes/playlists.ts', import.meta.url), 'utf8');
    const pgBenchmarkSource = readFileSync(new URL('../scripts/backend-performance-pg.ts', import.meta.url), 'utf8');
    const pgQuerySource = readFileSync(new URL('../lib/postgres-performance-queries.ts', import.meta.url), 'utf8');
    const todaySource = readFileSync(new URL('../youtube/today.ts', import.meta.url), 'utf8');
    const rssSource = readFileSync(new URL('../youtube/rss.ts', import.meta.url), 'utf8');
    const exploreSource = readFileSync(new URL('../youtube/explore.ts', import.meta.url), 'utf8');
    const youtubeSharedSource = readFileSync(new URL('../youtube/shared.ts', import.meta.url), 'utf8');
    const streamSharedSource = readFileSync(new URL('../routes/stream/shared.ts', import.meta.url), 'utf8');
    const dashSource = readFileSync(new URL('../routes/stream/dash-routes.ts', import.meta.url), 'utf8');
    const mpdSource = readFileSync(new URL('../routes/stream/mpd.ts', import.meta.url), 'utf8');
    const proxySource = readFileSync(new URL('../routes/stream/proxy.ts', import.meta.url), 'utf8');
    const playlistSource = readFileSync(new URL('../youtube/playlists.ts', import.meta.url), 'utf8');
    const videoDetailsSource = readFileSync(new URL('../youtube/video-details.ts', import.meta.url), 'utf8');
    const durationSource = readFileSync(new URL('../lib/duration-metadata.ts', import.meta.url), 'utf8');
    const maintenanceSource = readFileSync(new URL('../lib/database-maintenance.ts', import.meta.url), 'utf8');
    const swSource = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
    const idbSource = readFileSync(new URL('../public/idb-helpers.js', import.meta.url), 'utf8');
    const playerRouteSource = readFileSync(new URL('../routes/player.ts', import.meta.url), 'utf8');
    const playerShellSource = readFileSync(new URL('../views/player-shell.ejs', import.meta.url), 'utf8');
    const sharedHeadSource = readFileSync(new URL('../views/partials/head.ejs', import.meta.url), 'utf8');
    const playerPageSource = readFileSync(new URL('../public/player-page.min.js', import.meta.url), 'utf8');
    const serverSource = readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
    const segmentCacheSource = readFileSync(new URL('../lib/segment-cache.ts', import.meta.url), 'utf8');
    const metricsSource = readFileSync(new URL('../lib/performance-metrics.ts', import.meta.url), 'utf8');
    const playerBuildSource = readFileSync(new URL('../scripts/build-player-page.mjs', import.meta.url), 'utf8');
    const downloadsSource = readFileSync(new URL('../routes/stream/downloads.ts', import.meta.url), 'utf8');
    const downloadQueueSource = readFileSync(new URL('../lib/download-queue.ts', import.meta.url), 'utf8');
    const downloadFilesSource = readFileSync(new URL('../lib/download-files.ts', import.meta.url), 'utf8');
    const downloadWorkerSource = readFileSync(new URL('../download-worker.ts', import.meta.url), 'utf8');
    const downloadStorageSource = readFileSync(new URL('../lib/download-storage.ts', import.meta.url), 'utf8');
    const appSource = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
    const subtitlesSource = readFileSync(new URL('../routes/stream/subtitles.ts', import.meta.url), 'utf8');
    const hlsSource = readFileSync(new URL('../routes/stream/hls.ts', import.meta.url), 'utf8');
    const hlsManifestSource = readFileSync(new URL('../lib/hls-manifest.ts', import.meta.url), 'utf8');
    const streamAssetsSource = readFileSync(new URL('../routes/stream/assets.ts', import.meta.url), 'utf8');
    const extractorSource = readFileSync(new URL('../extractors.ts', import.meta.url), 'utf8');
    const ytdlpExtractSource = readFileSync(new URL('../lib/ytdlp-extract.ts', import.meta.url), 'utf8');
    const upstreamParserSource = readFileSync(new URL('../lib/upstream-parser.ts', import.meta.url), 'utf8');
    const ytMetaSource = readFileSync(new URL('../yt-meta.ts', import.meta.url), 'utf8');
    const cookieRouteSource = readFileSync(new URL('../routes/cookies.ts', import.meta.url), 'utf8');
    const ytdlpSource = readFileSync(new URL('../ytdlp.ts', import.meta.url), 'utf8');
    const thumbnailPreviewSource = readFileSync(new URL('../views/player/thumbnail-preview.ejs', import.meta.url), 'utf8');
    const playerTemplateSource = readFileSync(new URL('../views/player.ejs', import.meta.url), 'utf8');
    const loggerSource = readFileSync(new URL('../lib/logger.ts', import.meta.url), 'utf8');
    const todayRouteSource = readFileSync(new URL('../routes/today.ts', import.meta.url), 'utf8');
    const subscriptionRouteSource = readFileSync(new URL('../routes/subscriptions.ts', import.meta.url), 'utf8');
    const extractWorkerSource = readFileSync(new URL('../lib/extract.ts', import.meta.url), 'utf8');
    const clusterSource = readFileSync(new URL('../cluster.ts', import.meta.url), 'utf8');
    const composeSource = readFileSync(new URL('../docker-compose.yml', import.meta.url), 'utf8');
    const nginxComposeSource = readFileSync(new URL('../deploy/nginx-compose.conf', import.meta.url), 'utf8');
    const varnishSource = readFileSync(new URL('../deploy/varnish.vcl', import.meta.url), 'utf8');
    const packageSource = readFileSync(new URL('../package.json', import.meta.url), 'utf8');

    assert.match(dbSource, /export default api as DatabaseAPI/);
    assert.match(cacheSource, /enableOfflineQueue: false/);
    assert.match(cacheSource, /redis && redis\.status === 'ready'/);
    assert.match(cacheSource, /CACHE_REDIS_URL/);
    assert.match(cacheSource, /setAsync/);
    assert.match(cacheSource, /maxL1Bytes/);
    assert.match(cacheSource, /shared_cache_l1_evictions_total/);
    assert.match(queueSource, /waitUntilReady\(\)/);
    assert.match(queueSource, /BullMQ connection/);
    assert.match(queueSource, /candidateQueue\?\.disconnect\(\)/);
    assert.match(todaySource, /TODAY_COLD_START_BUDGET_MS/);
    assert.match(todaySource, /today-refresh:/);
    assert.match(todaySource, /TODAY_PAGE_SIZE/);
    assert.match(todaySource, /getStaleRssRefreshCandidatesForUser/);
    assert.match(todaySource, /enqueueRssRefreshBatch/);
    assert.match(todaySource, /getRssVideosCursorPageForUser/);
    assert.match(todaySource, /encodeTodayCursor/);
    assert.match(todaySource, /liveStatuses/);
    assert.match(todaySource, /todayPageCacheKey/);
    assert.match(todaySource, /todayRefreshState/);
    assert.match(todaySource, /bumpTodayCacheVersion/);
    assert.doesNotMatch(todaySource, /getRssVideosForUser\(userId, todayISO, 30, 5000\)/);
    assert.match(todayRouteSource, /getTodayVideosPage/);
    assert.doesNotMatch(todayRouteSource, /getDurationsAndLiveStatuses/);
    assert.match(rssSource, /cache\.rss\.getAsync/);
    assert.match(rssSource, /db\.getRssCache/);
    assert.match(rssSource, /rss-refresh:/);
    assert.match(rssSource, /RSS_REFRESH_CONCURRENCY/);
    assert.match(rssSource, /enqueueRssRefresh/);
    assert.match(rssSource, /If-None-Match/);
    assert.match(rssSource, /rssDataEqual/);
    assert.match(rssSource, /touchRssCache/);
    assert.doesNotMatch(rssSource, /rssRefreshQueue\.sort/);
    assert.match(rssQueueSource, /freshnessJobId/);
    assert.match(rssQueueSource, /jobWaiters/);
    assert.match(rssQueueSource, /\.addBulk\(/);
    assert.match(subscriptionRouteSource, /getSubscriptionSearchPage/);
    assert.match(subscriptionRouteSource, /req\.query\.cursor/);
    assert.doesNotMatch(subscriptionRouteSource, /req\.query\.page/);
    assert.match(dbSource, /CREATE TABLE IF NOT EXISTS rss_videos/);
    assert.match(dbSource, /CREATE TABLE IF NOT EXISTS rss_channel_stats/);
    assert.match(dbSource, /idx_watch_time_user_updated/);
    assert.match(exploreSource, /getExploreRssSnapshotForUser/);
    assert.match(exploreSource, /getExploreCandidateSignals/);
    assert.match(exploreSource, /getExploreUserSignals/);
    assert.doesNotMatch(exploreSource, /db\.getDurations\(/);
    assert.match(exploreSource, /durationSeconds/);
    assert.match(dbSource, /queryUserSignals/);
    assert.match(dbSource, /queryRssVideos/);
    assert.match(dbSource, /queryRssVideoPage/);
    assert.match(dbSource, /queryRssVideoCursorPage/);
    assert.doesNotMatch(dbSource, /function backfillRssVideos/);
    assert.doesNotMatch(dbSource, /function backfillRssChannelStats/);
    assert.match(sqliteReadWorkerSource, /operation === 'user-signals'/);
    assert.match(sqliteReadWorkerSource, /operation === 'explore-rss-snapshot'/);
    assert.match(sqliteReadWorkerSource, /querySqliteRssVideosForUser/);
    assert.match(sqliteReadReaderSource, /queryExploreRssSnapshot/);
    assert.match(sqliteReadReaderSource, /SQLITE_EXPLORE_WORKER_MAX_PENDING/);
    assert.match(sqliteReadReaderSource, /sqlite_read_queue_depth/);
    assert.match(sqliteReadReaderSource, /dispatchNext/);
    assert.doesNotMatch(dbSource, /workerResult\s*\|\|\s*querySqlite/);
    assert.doesNotMatch(exploreSource, /db\.getAllTaggedVideoIds/);
    assert.doesNotMatch(exploreSource, /db\.getDismissedVideoIds/);
    assert.match(exploreSource, /cache\.exploreVideos\.getAsync/);
    assert.match(exploreSource, /const subscribedChannels = new Set/);
    assert.match(exploreSource, /getExploreWatchTimes\(userId, 365, EXPLORE_PERSONAL_HISTORY_LIMIT\)/);
    assert.match(exploreSource, /channelBehaviors/);
    assert.match(dbSource, /CREATE TABLE IF NOT EXISTS explore_user_channel_rollups/);
    assert.doesNotMatch(dbSource, /trg_explore_impression_insert AFTER INSERT/);
    assert.match(durationSource, /duration-meta:/);
    assert.match(durationSource, /metadataInflight/);
    assert.match(durationSource, /metadataNegativeCache/);
    assert.match(durationSource, /active\.consumers/);
    assert.match(durationSource, /skipStoredLookup/);
    assert.match(dashSource, /urlLookup\.getAsync/);
    assert.match(dashSource, /hasCachedPlayback/);
    assert.doesNotMatch(dashSource, /URL missing or expired — rebuild MPD/);
    assert.match(mpdSource, /urlLookup\.setAsync/);
    assert.match(mpdSource, /mpdCache\.setAsync/);
    assert.match(mpdSource, /mapWithConcurrency\(localFormats, 4/);
    assert.match(mpdSource, /recordDownloadedFormatRanges/);
    assert.match(proxySource, /urlLookup\.getAsync/);
    assert.match(hlsSource, /hlsCache\.getAsync/);
    assert.match(subtitlesSource, /vttCache\.getAsync/);
    assert.match(downloadsSource, /urlLookup\.deleteLocal/);
    assert.match(downloadsSource, /hlsCache\.deleteLocal/);
    assert.match(downloadsSource, /vttCache\.deleteLocal/);
    assert.match(playlistSource, /playlistContinuationCacheKey/);
    assert.match(playlistSource, /playlistContinuations\.getAsync/);
    assert.match(playlistSource, /PLAYLIST_CONTINUATION_MAX_TOKEN_LENGTH/);
    assert.match(videoDetailsSource, /detailsComplete/);
    assert.match(videoDetailsSource, /enrichmentAttemptedAt/);
    assert.match(maintenanceSource, /optimizeDatabase/);
    assert.match(downloadStorageSource, /DOWNLOAD_STORAGE_RECONCILE_INITIAL_DELAY_MS/);
    assert.match(swSource, /maybeTrimImageCache/);
    assert.match(swSource, /MAX_SEGMENT_CACHE_BYTES/);
    assert.match(swSource, /my-youtube-runtime-v2/);
    assert.match(swSource, /my-youtube-offline-v1/);
    assert.match(swSource, /readResponseBufferBounded/);
    assert.doesNotMatch(swSource, /response\.clone\(\)\.arrayBuffer\(\)/);
    assert.match(swSource, /storage\.estimate\(\)/);
    assert.doesNotMatch(swSource, /loadOfflineFormatKeys/);
    assert.match(swSource, /getOfflineFormatMeta/);
    assert.match(swSource, /MAX_OFFLINE_FORMAT_META_CACHE_SIZE/);
    assert.match(idbSource, /download-catalog/);
    assert.match(idbSource, /getDownloadRecords/);
    assert.match(idbSource, /getPreparedDownloadPage/);
    assert.match(idbSource, /getPreparedDownloadRecords/);
    assert.match(pgSource, /FROM UNNEST\(\$2::text\[\]/);
    assert.match(downloadsSource, /bgDownloadsByVideo/);
    assert.match(downloadsSource, /getVideoDownloads/);
    assert.match(downloadsSource, /enqueueDownload/);
    assert.match(downloadsSource, /listDownloadedFormats/);
    assert.match(downloadQueueSource, /new Queue<DownloadJobData>\('downloads'/);
    assert.match(downloadQueueSource, /jobId/);
    assert.match(downloadWorkerSource, /new Worker<DownloadJobData>\('downloads'/);
    assert.match(downloadWorkerSource, /Promise\.allSettled/);
    assert.match(downloadWorkerSource, /fs\.promises\.rename/);
    assert.match(downloadWorkerSource, /semaphore:download-formats/);
    assert.match(downloadWorkerSource, /DOWNLOAD_FORMAT_GLOBAL_CONCURRENCY/);
    assert.match(downloadWorkerSource, /reserveDownloadStorage/);
    assert.match(downloadWorkerSource, /recordDownloadedFormats/);
    assert.doesNotMatch(downloadWorkerSource, /refreshDownloadedFormatManifest/);
    assert.match(downloadStorageSource, /scheduleStaleDownloadPartCleanup/);
    assert.match(downloadStorageSource, /fs\.promises\.opendir/);
    assert.match(downloadsSource, /reserveLocalDownloadStorage/);
    assert.match(downloadsSource, /assertDownloadFreeSpace/);
    assert.match(downloadsSource, /DOWNLOAD_MAX_FORMAT_BYTES/);
    assert.match(downloadsSource, /DOWNLOAD_MAX_VIDEO_BYTES/);
    assert.match(downloadStorageSource, /DOWNLOAD_STORAGE_MAX_BYTES/);
    assert.match(downloadStorageSource, /DOWNLOAD_MIN_FREE_BYTES/);
    assert.match(downloadStorageSource, /download_storage_rejections_total/);
    assert.match(downloadStorageSource, /\{download-storage\}:leases/);
    assert.match(downloadStorageSource, /snapshot\.freeBytes - minimumFree/);
    assert.doesNotMatch(downloadWorkerSource, /deleteVideoDownloadFiles/);
    assert.match(downloadFilesSource, /mycache-\$\{videoId\}-\$\{formatId\}\.dat/);
    assert.match(downloadFilesSource, /download_manifest_misses_total/);
    assert.match(downloadFilesSource, /recordDownloadedFormats/);
    assert.match(downloadFilesSource, /recordDownloadedFormatRanges/);
    assert.match(nginxComposeSource, /channel\/\[\^\/\]\+\/avatar\|api\/comments\/avatar/);
    assert.match(varnishSource, /X-Varnish-Cache = "avatar"/);
    assert.match(appSource, /offline=1/);
    assert.match(appSource, /MessageChannel/);
    assert.match(appSource, /OFFLINE_PREPARATION_CONCURRENCY = 1/);
    assert.match(appSource, /downloadOfflineFormats/);
    assert.match(appSource, /flushFullChunks/);
    assert.match(appSource, /Make available offline/);
    assert.doesNotMatch(appSource, /localStorage\.setItem\('offline_/);
    assert.doesNotMatch(appSource, /while \(bufferBytes >= CHUNK_SIZE\)/);
    assert.match(loggerSource, /stdoutBlocked/);
    assert.match(loggerSource, /sampledInfo/);
    assert.match(pgSource, /getExploreWatchTimes/);
    assert.match(pgSource, /idx_watch_time_video_updated/);
    assert.match(pgSource, /database_pool_waiting_requests/);
    assert.match(pgSource, /database_pool_acquire_duration_ms/);
    assert.match(pgSource, /MAX\(updated_at\) AS recent_match/);
    assert.match(pgSource, /claimMaintenanceLease/);
    assert.match(dbSource, /deleteStaleRssVideos/);
    assert.match(maintenanceSource, /pruneInBatches/);
    assert.match(maintenanceSource, /claimMaintenanceLease\('database-prune-v1'/);
    assert.match(playerRouteSource, /runtimeAssetUrl\('player-page\.min\.js'\)/);
    assert.match(playerRouteSource, /const videoP = getCachedVideoDetails\(videoId\)/);
    assert.doesNotMatch(playerRouteSource, /const videoP = getVideoDetails\(videoId\)/);
    assert.match(playerRouteSource, /streamContent\('player-shell'/);
    assert.match(playerShellSource, /window\.__playerBootstrap/);
    assert.match(playerShellSource, /replace\(\/<\/g, '\\\\u003c'\)/);
    assert.doesNotMatch(sharedHeadSource, /native-player-engine\.js/);
    assert.ok(playerPageSource.length > 50_000, 'Expected generated minified player runtime');
    assert.match(playerBuildSource, /native-player-engine\.min\.js/);
    assert.match(segmentCacheSource, /shouldCheckSegment/);
    assert.match(segmentCacheSource, /SEGMENT_CACHE_WRITE_BUDGET_BYTES/);
    assert.match(segmentCacheSource, /SEGMENT_CACHE_COLLECTION_BUDGET_BYTES/);
    assert.match(segmentCacheSource, /joinSegmentFlight/);
    assert.match(segmentCacheSource, /MAX_SEGMENT_FLIGHTS/);
    assert.match(dashSource, /Buffer\.allocUnsafe\(cl\)/);
    assert.doesNotMatch(dashSource, /Buffer\.concat\(chunks\)/);
    assert.match(youtubeSharedSource, /semaphore:youtube-requests/);
    assert.match(youtubeSharedSource, /YT_REQUEST_MAX_QUEUE/);
    assert.match(streamSharedSource, /UNDICI_GLOBAL_CONNECTIONS/);
    assert.match(streamSharedSource, /OUTBOUND_MEDIA_GLOBAL_CONCURRENCY/);
    assert.match(streamSharedSource, /YTDLP_MAX_QUEUE/);
    assert.match(streamSharedSource, /YTDLP_QUEUE_TIMEOUT_MS/);
    assert.match(streamSharedSource, /releaseWithResponseBody/);
    assert.match(streamSharedSource, /outbound_media_queue_wait_seconds/);
    assert.doesNotMatch(rssQueueSource, /\.getState\(/);
    assert.match(rssQueueSource, /recentJobResults/);
    assert.match(rssQueueSource, /prepareJobWaiter/);
    assert.match(subtitlesSource, /fetchVttDirect/);
    assert.match(subtitlesSource, /vttInflight/);
    assert.doesNotMatch(subtitlesSource, /VTT_PREFETCH_LIMIT/);
    assert.match(hlsSource, /readBoundedHlsManifest/);
    assert.match(hlsSource, /appendHlsReloadParams/);
    assert.doesNotMatch(hlsSource, /hlsRewriteCache/);
    assert.match(hlsManifestSource, /kind', 'playlist/);
    assert.match(swSource, /my-youtube-segments-v7/);
    assert.match(swSource, /url\.searchParams\.get\('kind'\) === 'playlist'/);
    assert.match(swSource, /#EXT-X-ENDLIST/);
    assert.match(swSource, /cachedHlsPlaylistResponse/);
    assert.match(streamAssetsSource, /resolveVideoMetadata\(\[videoId\], 1/);
    assert.doesNotMatch(streamAssetsSource, /execFileAsync/);
    assert.match(streamAssetsSource, /isCurrentLive \? await getLiveStoryboardSpec/);
    assert.match(streamAssetsSource, /liveStoryboardInflight/);
    assert.match(extractorSource, /withProcessSlot/);
    assert.match(extractorSource, /withRequestSlot/);
    assert.match(extractorSource, /clientVersionRefreshInflight/);
    assert.match(extractorSource, /parseEmbeddedJsonBuffer/);
    assert.match(ytdlpExtractSource, /parseExtractionJsonBuffer/);
    assert.match(ytdlpExtractSource, /encoding: 'buffer'/);
    assert.match(upstreamParserSource, /const extractionLane/);
    assert.match(ytMetaSource, /parseEmbeddedJsonBuffer/);
    assert.match(thumbnailPreviewSource, /requestStoryboardOnInteraction/);
    assert.match(thumbnailPreviewSource, /storyboardLoadPromise/);
    assert.doesNotMatch(playerTemplateSource, /idleCb\(function \(\) \{ if \(window\._loadStoryboard\)/);
    assert.match(cookieRouteSource, /router\.post\('\/refresh-auto', ensureAuth/);
    assert.match(cookieRouteSource, /withYtdlpSlot/);
    assert.match(ytdlpSource, /cookie-file-refresh/);
    assert.match(ytdlpSource, /\.tmp-\$\{process\.pid\}-\$\{randomUUID\(\)\}/);
    assert.match(ytdlpSource, /browserDiscoveryInflight/);
    assert.doesNotMatch(ytdlpSource, /readdirSync/);
    assert.match(exploreSource, /const stale = cached\?\.data/);
    assert.match(exploreSource, /renewLock\(lockKey, token, leaseMs\)/);
    assert.doesNotMatch(exploreSource, /if \(!token\)[\s\S]{0,700}return _buildExploreVideos/);
    assert.match(rssSource, /Math\.pow\(1\.6, attempt\+\+\)/);
    assert.match(serverSource, /WATCH_TIME_WRITE_DELAY_MS/);
    assert.match(serverSource, /WATCH_TIME_WRITE_CONCURRENCY/);
    assert.match(serverSource, /watch_time_updates_total/);
    assert.doesNotMatch(serverSource, /watchTimeWriteChains/);
    assert.match(playerPageSource, /pagehide/);
    assert.match(metricsSource, /monitorEventLoopDelay/);
    assert.match(metricsSource, /clusterSnapshotInflight/);
    assert.match(metricsSource, /METRICS_SNAPSHOT_TTL_MS/);
    assert.match(metricsSource, /stream_response_first_byte_seconds/);
    assert.match(metricsSource, /stream_response_bytes_total/);
    assert.match(metricsSource, /finalize\('aborted'\)/);
    assert.match(downloadsSource, /await pipeline\(/);
    assert.match(downloadsSource, /DOWNLOAD_PROGRESS_UPDATE_MS/);
    assert.doesNotMatch(downloadsSource, /\.write\(chunk\)/);
    assert.match(serverSource, /app\.get\('\/metrics'/);
    assert.match(serverSource, /X-Accel-Buffering', 'no'/);
    assert.doesNotMatch(youtubeSharedSource, /_ytRequestQueue\.sort/);
    assert.doesNotMatch(streamSharedSource, /ytdlpQueue\.sort/);
    assert.doesNotMatch(extractWorkerSource, /ytdlpQueue\.sort/);
    assert.match(extractWorkerSource, /YTDLP_MAX_QUEUE/);
    assert.match(extractWorkerSource, /YTDLP_QUEUE_TIMEOUT_MS/);
    assert.match(clusterSource, /runMigrationsOnce/);
    assert.match(clusterSource, /SKIP_DATABASE_MIGRATIONS = '1'/);
    assert.match(clusterSource, /CLUSTER_WORKER_SLOT/);
    assert.match(queueSource, /ownsQueueMetrics/);
    assert.match(downloadQueueSource, /QUEUE_METRICS_INTERVAL_MS/);
    assert.match(serverSource, /Redis session storage is required when CLUSTER_WORKER_COUNT > 1/);
    assert.match(serverSource, /scheduleStaleDownloadPartCleanup/);
    assert.match(composeSource, /condition: service_completed_successfully/);
    assert.doesNotMatch(composeSource, /minio\/minio/);
    assert.match(packageSource, /benchmark:backend/);
    assert.match(packageSource, /benchmark:backend:pg/);
    assert.match(playlistSchedulerSource, /PLAYLIST_REFRESH_CONCURRENCY/);
    assert.match(playlistSchedulerSource, /semaphore:playlist-refresh/);
    assert.match(playlistSchedulerSource, /playlist-refresh:\$\{userId\}:\$\{playlistId\}/);
    assert.match(playlistSchedulerSource, /priority: 'background'/);
    assert.match(playlistRouteSource, /enqueuePlaylistRefreshBatch/);
    assert.doesNotMatch(playlistRouteSource, /Promise\.allSettled\(youtubePlaylists/);
    assert.match(pgBenchmarkSource, /CREATE SCHEMA/);
    assert.match(pgBenchmarkSource, /EXPLAIN \(ANALYZE, BUFFERS, FORMAT JSON\)/);
    assert.match(pgBenchmarkSource, /DROP SCHEMA IF EXISTS/);
    assert.match(pgBenchmarkSource, /POSTGRES_EXPLORE_CANDIDATE_SIGNALS_SQL/);
    assert.match(pgQuerySource, /POSTGRES_EXPLORE_USER_SIGNALS_SQL/);
    assert.match(pgQuerySource, /POSTGRES_TODAY_OLDER_CURSOR_SQL/);
    assert.match(pgQuerySource, /POSTGRES_TODAY_NEWER_CURSOR_SQL/);
    assert.match(pgSource, /getRssVideosCursorPageForUser/);
    assert.match(pgSource, /POSTGRES_TODAY_ROWS_SQL/);
  });

  it('releases segment collection reservations for reuse', () => {
    const release = segCache.reserveSegmentCollection(2 * 1024 * 1024);
    assert.strictEqual(typeof release, 'function');
    release();
    const releaseAgain = segCache.reserveSegmentCollection(2 * 1024 * 1024);
    assert.strictEqual(typeof releaseAgain, 'function');
    releaseAgain();
  });

  it('collapses concurrent exact small segment ranges and excludes large ranges', async () => {
    const videoId = 'collapse001';
    const formatId = '137';
    const range = 'bytes=0-1023';
    const leader = segCache.joinSegmentFlight(videoId, formatId, range);
    const follower = segCache.joinSegmentFlight(videoId, formatId, range);
    assert.strictEqual(leader?.leader, true);
    assert.strictEqual(follower?.leader, false);
    const payload = {
      data: Buffer.alloc(1024, 7),
      contentType: 'video/mp4',
      contentLength: 1024,
      contentRange: 'bytes 0-1023/4096',
      status: 206,
    };
    leader.complete(payload);
    assert.strictEqual(await follower.promise, payload);
    assert.strictEqual(segCache.joinSegmentFlight(videoId, formatId, 'bytes=0-3000000'), null);
  });

  it('holds an outbound slot until the response body is cancelled', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.write(Buffer.from([1]));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const baseline = getOutboundMediaState().active;
    try {
      const address = server.address();
      assert.ok(address && typeof address === 'object');
      const response = await fetchWithConnTimeout(`http://127.0.0.1:${address.port}/held`, {
        bodyIdleMs: 1000,
      }, 1000);
      assert.strictEqual(getOutboundMediaState().active, baseline + 1);
      await response.body.cancel();
      await new Promise(resolve => setImmediate(resolve));
      assert.strictEqual(getOutboundMediaState().active, baseline);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });

  it('aborts an upstream body that stops making progress', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.write(Buffer.from([1]));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      assert.ok(address && typeof address === 'object');
      const response = await fetchWithConnTimeout(`http://127.0.0.1:${address.port}/stall`, {
        bodyIdleMs: 50,
      }, 1000);
      await assert.rejects(response.arrayBuffer());
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Storage fallback — local filesystem
// ---------------------------------------------------------------------------

describe('Storage fallback (local filesystem)', () => {
  const testKey = '__resilience_test_file.bin';
  const testData = Buffer.from('Resilience test data');

  before(() => {
    // Ensure no S3
    delete process.env.STORAGE_URL;
  });

  after(async () => {
    await storage.del(testKey);
  });

  it('should not be in S3 mode', () => {
    assert.strictEqual(storage.isS3(), false);
  });

  it('putBuffer and stat should work on local filesystem', async () => {
    await storage.putBuffer(testKey, testData);
    const info = await storage.stat(testKey);
    assert.strictEqual(info.exists, true);
    assert.strictEqual(info.size, testData.length);
  });

  it('getStream should return readable stream for existing file', async () => {
    const stream = await storage.getStream(testKey);
    assert.ok(stream, 'Should return a stream');
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    assert.deepStrictEqual(Buffer.concat(chunks), testData);
  });

  it('getStream should return null for missing file', async () => {
    const stream = await storage.getStream('__nonexistent_resilience_key.bin');
    assert.strictEqual(stream, null);
  });

  it('stat should return { exists: false } for missing file', async () => {
    const info = await storage.stat('__nonexistent_resilience_key.bin');
    assert.strictEqual(info.exists, false);
    assert.strictEqual(info.size, 0);
  });

  it('del should not throw for missing file', async () => {
    await assert.doesNotReject(async () => {
      await storage.del('__nonexistent_resilience_key.bin');
    });
  });
});

// ---------------------------------------------------------------------------
// 4. Segment cache miss
// ---------------------------------------------------------------------------

describe('Segment cache miss (no Redis)', () => {
  before(() => {
    delete process.env.REDIS_URL;
  });

  it('getSegment should return null', async () => {
    const result = await segCache.getSegment('vid123', '140', 'bytes=0-1000');
    assert.strictEqual(result, null);
  });

  it('putSegment should not throw', async () => {
    await assert.doesNotReject(async () => {
      await segCache.putSegment('vid123', '140', 'bytes=0-1000', Buffer.alloc(100), {
        contentType: 'video/mp4',
        contentRange: 'bytes 0-99/1000',
        status: 200,
      });
    });
  });

  it('getSegment should still return null after putSegment (no Redis to store)', async () => {
    const result = await segCache.getSegment('vid123', '140', 'bytes=0-1000');
    assert.strictEqual(result, null);
  });
});

// ---------------------------------------------------------------------------
// 5. Health endpoint with no Redis
// ---------------------------------------------------------------------------

describe('Health endpoint with no Redis', () => {
  const TEST_PORT = 13591;
  let child;

  before(async () => {
    child = fork(path.join(import.meta.dirname, '..', 'server.js'), [], {
      env: {
        ...process.env,
        PORT: String(TEST_PORT),
        SESSION_SECRET: 'test-secret-resilience',
        NODE_ENV: 'test',
        REDIS_URL: '', // explicitly no Redis
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Server start timeout')), 15000);
      child.stdout.on('data', (data) => {
        if (data.toString().includes('my-youtube running')) {
          clearTimeout(timeout);
          resolve();
        }
      });
      child.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
      child.on('exit', (code) => {
        if (code) {
          clearTimeout(timeout);
          reject(new Error(`Server exited with code ${code}`));
        }
      });
    });
  });

  after(async () => stopChild(child));

  it('GET /health should return 200 with redis.status not_configured', async () => {
    const res = await httpGet(TEST_PORT, '/health');
    assert.strictEqual(res.status, 200, `Expected 200, got ${res.status}`);
    const data = JSON.parse(res.body);
    assert.ok(data.redis, 'Health should include redis check');
    assert.strictEqual(data.redis.status, 'not_configured');
  });

  it('GET /health should return database.status ok', async () => {
    const res = await httpGet(TEST_PORT, '/health');
    assert.strictEqual(res.status, 200);
    const data = JSON.parse(res.body);
    assert.ok(data.database, 'Health should include database check');
    assert.strictEqual(data.database.status, 'ok');
  });
});

// ---------------------------------------------------------------------------
// 6. WebSocket fallback
// ---------------------------------------------------------------------------

describe('WebSocket fallback (no server)', () => {
  it('isAvailable() should return false before attach', () => {
    assert.strictEqual(wsStatus.isAvailable(), false);
  });

  it('notify() should not throw when no listeners', () => {
    assert.doesNotThrow(() => {
      wsStatus.notify('someVideoId', { type: 'progress', percent: 50 });
    });
  });

  it('notify() should not throw with non-subscribed videoId', () => {
    assert.doesNotThrow(() => {
      wsStatus.notify('nonexistent', { type: 'done' });
    });
  });

  it('notify() should not throw with various data types', () => {
    assert.doesNotThrow(() => {
      wsStatus.notify('vid1', { type: 'error', message: 'test error' });
      wsStatus.notify('vid2', { type: 'progress', percent: 0 });
      wsStatus.notify('vid3', null);
    });
  });
});

describe('WebSocket status server', () => {
  after(() => {
    wsStatus.closeAll();
    wsStatus.setStatusProvider(null);
  });

  it('sends the current extraction step immediately on connect', async () => {
    const server = http.createServer((_req, res) => res.end('ok'));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      await wsStatus.attach(server);
      wsStatus.setStatusProvider((videoId) => videoId === 'dQw4w9WgXcQ' ? { step: 'building' } : null);
      const { WebSocket } = await import('ws');
      const port = server.address().port;
      const message = await new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/status?v=dQw4w9WgXcQ`);
        const timer = setTimeout(() => reject(new Error('Timed out waiting for status message')), 3000);
        ws.on('message', (data) => {
          clearTimeout(timer);
          ws.close();
          resolve(JSON.parse(data.toString()));
        });
        ws.on('error', reject);
      });
      assert.deepStrictEqual(message, { step: 'building' });
    } finally {
      wsStatus.closeAll();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function httpGet(port, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: 'localhost',
      port,
      path: urlPath,
      method: 'GET',
    }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}
