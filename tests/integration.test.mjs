import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fork } from 'node:child_process';
import crypto from 'node:crypto';
import db from '../db.js';
import LRUMap from '../lib/lru-map.js';
import { SharedLRUMap } from '../lib/cache.js';
import { createStreamToken, validateStreamToken } from '../auth.js';
import { initStorage, isS3, putBuffer, getStream, stat, del } from '../lib/storage.js';
import { getSegment, putSegment } from '../lib/segment-cache.js';
import { initQueue, enqueueExtraction, hasQueue } from '../lib/extraction-queue.js';
import { attach, notify, isAvailable } from '../lib/ws-status.js';
import { stopChild } from './helpers/child-process.mjs';
import { appendHlsReloadParams, rewriteHlsManifest } from '../lib/hls-manifest.js';
import {
  downloadedFormatManifestPath,
  downloadedFormatPath,
  getDownloadedFormat,
  invalidateDownloadedVideo,
  listDownloadedFormats,
  recordDownloadedFormatRanges,
  recordDownloadedFormats,
} from '../lib/download-files.js';
import { parseSubscriptionHtmlOffThread } from '../lib/subscription-parser.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_USER = 'test-user-integration';
const TEST_VIDEO = 'dQw4w9WgXcQ';
const TEST_CHANNEL = 'UCuAXFkgsw1L7xaCfnd5JJOw'; // valid-looking channel ID

function httpRequest(port, method, urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'localhost',
      port,
      path: urlPath,
      method,
      headers: { ...headers },
    };
    if (body) {
      const data = typeof body === 'string' ? body : JSON.stringify(body);
      options.headers['Content-Type'] = typeof body === 'string' ? 'text/plain' : 'application/json';
      options.headers['Content-Length'] = Buffer.byteLength(data);
    }
    const req = http.request(options, (res) => {
      let chunks = '';
      res.on('data', (d) => (chunks += d));
      res.on('end', () =>
        resolve({ status: res.statusCode, body: chunks, headers: res.headers })
      );
    });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

// Follow redirects manually (one level)
async function httpGet(port, urlPath, headers) {
  const res = await httpRequest(port, 'GET', urlPath, undefined, headers);
  return res;
}

function httpGetUntil(port, urlPath, predicate, headers = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      req.destroy();
      reject(new Error(`Timed out waiting for streamed response marker: ${urlPath}`));
    }, 10000);
    const req = http.request({
      hostname: 'localhost',
      port,
      path: urlPath,
      method: 'GET',
      headers,
    }, (res) => {
      let chunks = '';
      res.on('data', (d) => {
        if (settled) return;
        chunks += d;
        if (predicate(chunks)) {
          settled = true;
          clearTimeout(timeout);
          resolve({ status: res.statusCode, body: chunks, headers: res.headers });
          req.destroy();
        }
      });
      res.on('end', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve({ status: res.statusCode, body: chunks, headers: res.headers });
      });
    });
    req.on('error', (err) => {
      if (err.code === 'ECONNRESET') return;
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(err);
    });
    req.end();
  });
}

describe('HLS manifest rewriting', () => {
  it('marks playlist references separately from segments and does not reuse same-length content', () => {
    const master = [
      '#EXTM3U',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",URI="audio.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1280x720',
      'video-a.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720',
      'video-b.m3u8',
    ].join('\n');
    const rewrittenMaster = rewriteHlsManifest(master, TEST_VIDEO, 'https://example.googlevideo.com/master.m3u8', 'token-a');
    const masterUrls = rewrittenMaster.match(/\/api\/stream\/[^\s"]+/g) || [];
    assert.strictEqual(masterUrls.length, 2, 'audio plus the best 720p variant should remain');
    for (const value of masterUrls) {
      const url = new URL(value, 'https://local.test');
      assert.strictEqual(url.searchParams.get('kind'), 'playlist');
      assert.strictEqual(url.searchParams.get('token'), 'token-a');
    }
    assert.match(rewrittenMaster, /video-b\.m3u8/);
    assert.doesNotMatch(rewrittenMaster, /video-a\.m3u8/);

    const mediaA = '#EXTM3U\n#EXTINF:4,\na.m4s';
    const mediaB = '#EXTM3U\n#EXTINF:4,\nb.m4s';
    assert.strictEqual(mediaA.length, mediaB.length);
    const rewrittenA = rewriteHlsManifest(mediaA, TEST_VIDEO, 'https://example.googlevideo.com/a/index.m3u8', 'token-a');
    const rewrittenB = rewriteHlsManifest(mediaB, TEST_VIDEO, 'https://example.googlevideo.com/b/index.m3u8', 'token-a');
    assert.notStrictEqual(rewrittenA, rewrittenB);
    const segmentUrl = new URL(rewrittenA.split('\n').at(-1), 'https://local.test');
    assert.strictEqual(segmentUrl.searchParams.has('kind'), false);
    assert.strictEqual(segmentUrl.searchParams.get('u'), 'https://example.googlevideo.com/a/a.m4s');
  });

  it('forwards only valid LL-HLS delivery directives', () => {
    const forwarded = new URL(appendHlsReloadParams('https://example.googlevideo.com/live.m3u8?keep=1', {
      _HLS_msn: '42',
      _HLS_part: '3',
      _HLS_skip: 'v2',
      ignored: 'value',
    }));
    assert.strictEqual(forwarded.searchParams.get('keep'), '1');
    assert.strictEqual(forwarded.searchParams.get('_HLS_msn'), '42');
    assert.strictEqual(forwarded.searchParams.get('_HLS_part'), '3');
    assert.strictEqual(forwarded.searchParams.get('_HLS_skip'), 'v2');
    assert.strictEqual(forwarded.searchParams.has('ignored'), false);

    const rejected = new URL(appendHlsReloadParams('https://example.googlevideo.com/live.m3u8', {
      _HLS_msn: '42&bad=1',
      _HLS_part: '-1',
      _HLS_skip: 'anything',
    }));
    assert.strictEqual(rejected.searchParams.has('_HLS_msn'), false);
    assert.strictEqual(rejected.searchParams.has('_HLS_part'), false);
    assert.strictEqual(rejected.searchParams.has('_HLS_skip'), false);
  });
});

describe('Downloaded format manifests', () => {
  it('does not scan the download library on a request-time manifest miss', async () => {
    const videoId = `m${Date.now().toString(36).slice(-10)}`.padEnd(11, '0').slice(0, 11);
    const formatId = 'manifestTest';
    const filePath = downloadedFormatPath(videoId, formatId);
    const manifestPath = downloadedFormatManifestPath(videoId);
    try {
      await fs.promises.writeFile(filePath, Buffer.alloc(32));
      invalidateDownloadedVideo(videoId);
      assert.deepStrictEqual(await listDownloadedFormats(videoId), []);
      assert.strictEqual(await getDownloadedFormat(videoId, formatId), null);

      await recordDownloadedFormats(videoId, [{ formatId, size: 32 }]);
      await recordDownloadedFormatRanges(videoId, {
        [formatId]: { initRange: '0-15', indexRange: '16-31' },
      });
      invalidateDownloadedVideo(videoId);
      assert.deepStrictEqual((await listDownloadedFormats(videoId)).map(entry => ({
        formatId: entry.formatId,
        size: entry.size,
        ranges: entry.ranges,
      })), [{ formatId, size: 32, ranges: { initRange: '0-15', indexRange: '16-31' } }]);
      assert.deepStrictEqual(await getDownloadedFormat(videoId, formatId), {
        formatId,
        filePath,
        size: 32,
        ranges: { initRange: '0-15', indexRange: '16-31' },
      });
    } finally {
      invalidateDownloadedVideo(videoId);
      await fs.promises.unlink(filePath).catch(() => {});
      await fs.promises.unlink(manifestPath).catch(() => {});
    }
  });
});

describe('Subscription parsing worker', () => {
  it('parses YouTube subscription HTML without using the request event loop', async () => {
    const html = '<script>var ytInitialData = '
      + JSON.stringify({ contents: [{ channelRenderer: {
        channelId: 'UC1234567890123456789012',
        title: { simpleText: 'Worker Channel' },
        thumbnail: { thumbnails: [{ url: 'worker.jpg' }] },
      } }] })
      + ';</script>';
    const subscriptions = await parseSubscriptionHtmlOffThread(html);
    assert.deepStrictEqual(subscriptions, [{
      channelId: 'UC1234567890123456789012',
      title: 'Worker Channel',
      thumbnail: 'worker.jpg',
      description: '',
    }]);
  });
});

// ---------------------------------------------------------------------------
// 1. Database layer (SQLite)
// ---------------------------------------------------------------------------

describe('Database layer (SQLite)', () => {
  before(() => {
    // Ensure no PG override
    delete process.env.DATABASE_URL;
  });

  after(() => {
    // Clean up test data
    try {
      db.removeTag(TEST_USER, TEST_VIDEO, 'testtag');
      db.removeTag(TEST_USER, TEST_VIDEO, 'anothertag');
      db.deleteSubscription(TEST_USER, TEST_CHANNEL);
      db.deleteDownload('test_dl_video');
    } catch {}
  });

  describe('addTag / getTags / removeTag', () => {
    it('should add a tag and return it in getTags', () => {
      const result = db.addTag(TEST_USER, TEST_VIDEO, 'TestTag');
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.tag, 'testtag'); // normalized

      const tags = db.getTags(TEST_USER, TEST_VIDEO);
      assert.ok(tags.includes('testtag'), 'Tag should be present');
    });

    it('should ignore duplicate tags (INSERT OR IGNORE)', () => {
      const result = db.addTag(TEST_USER, TEST_VIDEO, 'testtag');
      assert.strictEqual(result.ok, true);
      // Count should still be 1
      const tags = db.getTags(TEST_USER, TEST_VIDEO);
      const count = tags.filter((t) => t === 'testtag').length;
      assert.strictEqual(count, 1);
    });

    it('should remove a tag and verify it is gone', () => {
      db.addTag(TEST_USER, TEST_VIDEO, 'anothertag');
      let tags = db.getTags(TEST_USER, TEST_VIDEO);
      assert.ok(tags.includes('anothertag'));

      db.removeTag(TEST_USER, TEST_VIDEO, 'anothertag');
      tags = db.getTags(TEST_USER, TEST_VIDEO);
      assert.ok(!tags.includes('anothertag'), 'Tag should be removed');
    });

    it('should reject invalid tags', () => {
      const result = db.addTag(TEST_USER, TEST_VIDEO, '###');
      assert.strictEqual(result.ok, false);
    });
  });

  describe('upsertSubscriptions / getSubscriptions / deleteSubscription', () => {
    it('should upsert and retrieve subscriptions', () => {
      db.upsertSubscriptions(TEST_USER, [
        { channelId: TEST_CHANNEL, title: 'Test Channel', thumbnail: '//example.com/thumb.jpg', description: 'A test channel' },
      ]);
      const subs = db.getSubscriptions(TEST_USER);
      const found = subs.find((s) => s.channelId === TEST_CHANNEL);
      assert.ok(found, 'Subscription should exist');
      assert.strictEqual(found.title, 'Test Channel');
      // thumbnail should be normalized (protocol-relative -> https)
      assert.ok(found.thumbnail.startsWith('https:'), 'Thumbnail should be normalized to https');
    });

    it('should update existing subscription on upsert', () => {
      db.upsertSubscriptions(TEST_USER, [
        { channelId: TEST_CHANNEL, title: 'Updated Title', thumbnail: 'https://example.com/new.jpg', description: 'Updated' },
      ]);
      const subs = db.getSubscriptions(TEST_USER);
      const found = subs.find((s) => s.channelId === TEST_CHANNEL);
      assert.strictEqual(found.title, 'Updated Title');
    });

    it('should search subscriptions case-insensitively with bounded database pagination', () => {
      const searchUser = `${TEST_USER}-search`;
      const channelIds = Array.from({ length: 27 }, (_, index) => `UCsearch${String(index).padStart(17, '0')}`);
      try {
        db.upsertSubscriptions(searchUser, channelIds.map((channelId, index) => ({
          channelId,
          title: `Paged Match ${String(index).padStart(2, '0')}`,
          thumbnail: '',
          description: `Description ${index}`,
        })));
        db.upsertSubscriptions(searchUser, [{
          channelId: 'UCsearchUnmatched00000000',
          title: 'Different title',
          thumbnail: '',
          description: '',
        }]);

        const page = db.searchSubscriptions(searchUser, 'pAgEd MaTcH', 10, 10);
        assert.strictEqual(page.totalResults, 27);
        assert.strictEqual(page.items.length, 10);
        assert.strictEqual(page.items[0].title, 'Paged Match 10');
        assert.strictEqual(page.items[9].title, 'Paged Match 19');
      } finally {
        for (const channelId of channelIds) db.deleteSubscription(searchUser, channelId);
        db.deleteSubscription(searchUser, 'UCsearchUnmatched00000000');
      }
    });

    it('should cursor-page indexed subscription search without exact counts', () => {
      const searchUser = `${TEST_USER}-cursor-search`;
      const channelIds = Array.from({ length: 25 }, (_, index) => `UCcursor${String(index).padStart(18, '0')}`);
      try {
        db.upsertSubscriptions(searchUser, channelIds.map((channelId, index) => ({
          channelId,
          title: `Cursor Match ${String(index).padStart(2, '0')}`,
          thumbnail: '',
          description: '',
        })));
        const first = db.getSubscriptionsCursorPage(searchUser, 'cursor mat', 10, null, 'next');
        assert.strictEqual(first.items.length, 10);
        assert.strictEqual(first.hasMore, true);
        assert.strictEqual(first.items[0].title, 'Cursor Match 00');

        const firstLast = first.items.at(-1);
        const second = db.getSubscriptionsCursorPage(searchUser, 'CURSOR MATCH', 10, {
          title: firstLast.title,
          channelId: firstLast.channelId,
        }, 'next');
        assert.strictEqual(second.items[0].title, 'Cursor Match 10');
        assert.strictEqual(second.items.at(-1).title, 'Cursor Match 19');

        const secondFirst = second.items[0];
        const previous = db.getSubscriptionsCursorPage(searchUser, 'cursor match', 10, {
          title: secondFirst.title,
          channelId: secondFirst.channelId,
        }, 'previous');
        assert.deepStrictEqual(previous.items.map(item => item.channelId), first.items.map(item => item.channelId));
      } finally {
        for (const channelId of channelIds) db.deleteSubscription(searchUser, channelId);
      }
    });

    it('should delete a subscription', () => {
      db.deleteSubscription(TEST_USER, TEST_CHANNEL);
      const subs = db.getSubscriptions(TEST_USER);
      const found = subs.find((s) => s.channelId === TEST_CHANNEL);
      assert.strictEqual(found, undefined);
    });
  });

  describe('upsertChannel / getChannel', () => {
    it('should insert and retrieve a channel', () => {
      db.upsertChannel(TEST_CHANNEL, 'My Channel', 'https://example.com/ch.jpg');
      const ch = db.getChannel(TEST_CHANNEL);
      assert.ok(ch);
      assert.strictEqual(ch.channelId, TEST_CHANNEL);
      assert.strictEqual(ch.title, 'My Channel');
    });

    it('should return null for unknown channel', () => {
      const ch = db.getChannel('UC_NONEXISTENT_CHANNEL_XXXX');
      assert.strictEqual(ch, null);
    });
  });

  describe('setDuration / getDuration / getDurations', () => {
    it('should store and retrieve a single duration', () => {
      db.setDuration('vid_dur_1', 123.45, 'not_live');
      const dur = db.getDuration('vid_dur_1');
      assert.strictEqual(dur, 123.45);
    });

    it('should return null for unknown video', () => {
      const dur = db.getDuration('vid_nonexistent');
      assert.strictEqual(dur, null);
    });

    it('should batch-retrieve durations', () => {
      db.setDuration('vid_dur_2', 200, 'not_live');
      db.setDuration('vid_dur_3', 300, 'not_live');
      const durations = db.getDurations(['vid_dur_2', 'vid_dur_3', 'vid_nonexistent']);
      assert.strictEqual(durations['vid_dur_2'], 200);
      assert.strictEqual(durations['vid_dur_3'], 300);
      assert.strictEqual(durations['vid_nonexistent'], undefined);
    });

    it('should handle empty array in getDurations', () => {
      const durations = db.getDurations([]);
      assert.deepStrictEqual(durations, {});
    });
  });

  describe('getLiveStatus / getLiveStatuses', () => {
    it('should retrieve live status for a single video', () => {
      db.setDuration('vid_live_1', 0, 'is_live');
      const status = db.getLiveStatus('vid_live_1');
      assert.strictEqual(status, 'is_live');
    });

    it('should return null for unknown video', () => {
      assert.strictEqual(db.getLiveStatus('vid_live_none'), null);
    });

    it('should batch-retrieve live statuses', () => {
      db.setDuration('vid_live_2', 0, 'is_upcoming');
      const statuses = db.getLiveStatuses(['vid_live_1', 'vid_live_2', 'vid_live_none']);
      assert.strictEqual(statuses['vid_live_1'], 'is_live');
      assert.strictEqual(statuses['vid_live_2'], 'is_upcoming');
      assert.strictEqual(statuses['vid_live_none'], undefined);
    });

    it('should handle empty array in getLiveStatuses', () => {
      assert.deepStrictEqual(db.getLiveStatuses([]), {});
    });
  });

  describe('setRssCache / getRssCache', () => {
    it('should store and retrieve JSON data', () => {
      const testData = { videos: [{ id: 'abc', title: 'Hello' }] };
      db.setRssCache(TEST_CHANNEL, testData);
      const cached = db.getRssCache(TEST_CHANNEL);
      assert.ok(cached);
      assert.deepStrictEqual(cached.data, testData);
      assert.ok(cached.fetchedAt); // should have a timestamp
    });

    it('should return null for unknown channel', () => {
      assert.strictEqual(db.getRssCache('UC_NO_CACHE_CHANNEL_XXXXXX'), null);
    });

    it('should return only stale or missing RSS refresh candidates in one query', () => {
      const refreshUser = `${TEST_USER}-rss-refresh`;
      const freshChannel = 'UCfreshRefresh00000000001';
      const missingChannel = 'UCmissingRefresh000000001';
      try {
        db.upsertSubscriptions(refreshUser, [
          { channelId: freshChannel, title: 'Fresh', thumbnail: '', description: '' },
          { channelId: missingChannel, title: 'Missing', thumbnail: '', description: '' },
        ]);
        db.setRssCache(freshChannel, { channelTitle: 'Fresh', items: [] });
        const staleBefore = new Date(Date.now() - 60 * 60 * 1000).toISOString();
        const candidates = db.getStaleRssRefreshCandidatesForUser(refreshUser, staleBefore, 10);
        assert.deepStrictEqual(candidates.map(candidate => candidate.channelId), [missingChannel]);
        assert.strictEqual(candidates[0].fetchedAt, null);
      } finally {
        db.deleteSubscription(refreshUser, freshChannel);
        db.deleteSubscription(refreshUser, missingChannel);
      }
    });

    it('should maintain queryable normalized RSS rows with SQL limits', async () => {
      await db.upsertSubscriptions(TEST_USER, [{
        channelId: TEST_CHANNEL, title: 'Normalized Feed', thumbnail: '', description: '',
      }]);
      await db.setRssCache(TEST_CHANNEL, {
        channelTitle: 'Normalized Feed',
        items: [
          { videoId: 'rssOlder001', title: 'Older', publishedAt: '2026-07-30T12:00:00.000Z', channelId: TEST_CHANNEL },
          { videoId: 'rssNewer001', title: 'Newer', publishedAt: '2026-08-01T12:00:00.000Z', channelId: TEST_CHANNEL },
        ],
      });
      const rows = await db.getRssVideosForUser(TEST_USER, '2026-08-01T00:00:00.000Z', 1, 10);
      assert.deepStrictEqual(rows.map(row => row.video_id), ['rssNewer001']);
      assert.strictEqual(rows[0].sub_title, 'Normalized Feed');
      await db.setDuration('rssNewer001', 321, 'not_live');
      const todayPage = await db.getRssVideosPageForUser(
        TEST_USER, '2026-08-01T00:00:00.000Z', 30, 1, 0,
      );
      assert.strictEqual(todayPage.totalResults, 1);
      assert.strictEqual(todayPage.items[0].video_id, 'rssNewer001');
      assert.strictEqual(Number(todayPage.items[0].duration), 321);
      assert.strictEqual(todayPage.items[0].live_status, 'not_live');
      const cursorPage = await db.getRssVideosCursorPageForUser(
        TEST_USER, null, 30, 1, null, 'older',
      );
      assert.strictEqual(cursorPage.hasMore, true);
      assert.strictEqual(cursorPage.items[0].video_id, 'rssNewer001');
      const olderCursorPage = await db.getRssVideosCursorPageForUser(
        TEST_USER, null, 30, 1, {
          publishedAt: cursorPage.items[0].published_at,
          videoId: cursorPage.items[0].video_id,
        }, 'older',
      );
      assert.strictEqual(olderCursorPage.items[0].video_id, 'rssOlder001');
      const newerCursorPage = await db.getRssVideosCursorPageForUser(
        TEST_USER, null, 30, 1, {
          publishedAt: olderCursorPage.items[0].published_at,
          videoId: olderCursorPage.items[0].video_id,
        }, 'newer',
      );
      assert.strictEqual(newerCursorPage.items[0].video_id, 'rssNewer001');
      const display = await db.getVideoDisplayMetadata('rssNewer001');
      assert.deepStrictEqual(display, {
        title: 'Newer', channelId: TEST_CHANNEL, channelTitle: 'Normalized Feed',
      });
      const beyondToday = await db.getRssVideosPageForUser(
        TEST_USER, '2026-08-01T00:00:00.000Z', 30, 1, 100,
      );
      assert.strictEqual(beyondToday.items.length, 0);
      assert.strictEqual(beyondToday.totalResults, 1);
      const snapshot = await db.getExploreRssSnapshotForUser(
        TEST_USER, 6, 10, 365, '2026-07-31T00:00:00.000Z'
      );
      assert.deepStrictEqual(snapshot.videos.map(row => row.video_id), ['rssNewer001', 'rssOlder001']);
      const stats = snapshot.channelStats.find(row => row.channel_id === TEST_CHANNEL);
      assert.ok(stats, 'Expected materialized channel cadence stats');
      assert.strictEqual(Number(stats.video_count), 2);
      assert.strictEqual(stats.newest_published_at, '2026-08-01T12:00:00.000Z');
      assert.strictEqual(Number(stats.median_interval_ms), 2 * 24 * 60 * 60 * 1000);

      await db.setRssCache(TEST_CHANNEL, {
        channelTitle: 'Normalized Feed',
        items: [
          { videoId: 'rssNewer001', title: 'Newer', publishedAt: '2026-08-01T12:00:00.000Z', channelId: TEST_CHANNEL },
        ],
      }, { etag: '"feed-v2"', lastModified: 'Sat, 01 Aug 2026 12:00:00 GMT' });
      const updatedRows = await db.getRssVideosForUser(TEST_USER, null, 30, 10);
      assert.deepStrictEqual(updatedRows.map(row => row.video_id), ['rssNewer001']);
      const updatedCache = await db.getRssCache(TEST_CHANNEL);
      assert.deepStrictEqual(updatedCache.validators, {
        etag: '"feed-v2"',
        lastModified: 'Sat, 01 Aug 2026 12:00:00 GMT',
      });
      await db.touchRssCache(TEST_CHANNEL, { etag: '"feed-v2"' });
      assert.strictEqual((await db.getRssCache(TEST_CHANNEL)).validators.etag, '"feed-v2"');
    });

    it('should elect only one database maintenance runner per lease', async () => {
      const lease = `integration-maintenance-${Date.now()}`;
      assert.strictEqual(await db.claimMaintenanceLease(lease, 60), true);
      assert.strictEqual(await db.claimMaintenanceLease(lease, 60), false);
      if (db.optimizeDatabase) assert.strictEqual(await db.optimizeDatabase(), true);
    });

    it('should persist versioned schema migration markers', async () => {
      const migration = 'integration-test-marker-v1';
      await db.recordSchemaMigration(migration);
      assert.strictEqual(await db.hasSchemaMigration(migration), true);
      await db.recordSchemaMigration(migration);
      assert.strictEqual(await db.hasSchemaMigration(migration), true);
    });

    it('should load all player bootstrap state in one database call', async () => {
      const videoId = 'bootstrap01';
      await db.setRssCache(TEST_CHANNEL, {
        channelTitle: 'Bootstrap Channel',
        items: [{
          videoId,
          title: 'Bootstrap Video',
          publishedAt: '2026-08-02T12:00:00.000Z',
          channelId: TEST_CHANNEL,
        }],
      });
      await db.addTag(TEST_USER, videoId, 'fast');
      await db.rateVideo(TEST_USER, videoId, 1);
      await db.setWatchTime(TEST_USER, videoId, 42, 300);
      await db.setDuration(videoId, 300, 'not_live');
      await db.upsertDownload(videoId, 'Downloaded Bootstrap', 'Bootstrap Channel', '');
      await db.completeDownload(videoId);

      const bootstrap = await db.getPlayerBootstrapData(TEST_USER, videoId, true);
      assert.deepStrictEqual(bootstrap.display, {
        title: 'Bootstrap Video',
        channelTitle: 'Normalized Feed',
        channelId: TEST_CHANNEL,
      });
      assert.strictEqual(bootstrap.download?.status, 'complete');
      assert.deepStrictEqual(bootstrap.tags, ['fast']);
      assert.strictEqual(bootstrap.rating, 1);
      assert.deepStrictEqual(bootstrap.watchTime, { last_position: 42, duration: 300 });
      assert.strictEqual(bootstrap.liveStatus, 'not_live');

      const withoutWatchTime = await db.getPlayerBootstrapData(TEST_USER, videoId, false);
      assert.strictEqual(withoutWatchTime.watchTime, null);
      await db.removeTag(TEST_USER, videoId, 'fast');
      await db.unrateVideo(TEST_USER, videoId);
      await db.deleteDownload(videoId);
    });
  });

  describe('upsertDownload / getDownload / getAllDownloads / completeDownload / deleteDownload', () => {
    const DL_VIDEO = 'test_dl_video';

    it('should create a download record', () => {
      db.upsertDownload(DL_VIDEO, 'Test Download', 'Test Channel', 'https://example.com/dl.jpg');
      const dl = db.getDownload(DL_VIDEO);
      assert.ok(dl);
      assert.strictEqual(dl.video_id, DL_VIDEO);
      assert.strictEqual(dl.status, 'downloading');
      assert.strictEqual(dl.title, 'Test Download');
    });

    it('should appear in getAllDownloads', () => {
      const all = db.getAllDownloads();
      const found = all.find((d) => d.video_id === DL_VIDEO);
      assert.ok(found);
    });

    it('should return a bounded downloads page and total count', () => {
      const page = db.getDownloadsPage(1, 0);
      assert.ok(page.totalResults >= 1);
      assert.strictEqual(page.items.length, 1);
      assert.strictEqual(page.items[0].video_id, DL_VIDEO);
    });

    it('should traverse downloads in both cursor directions without gaps', () => {
      const ids = ['000cursorA1', '000cursorB1', '000cursorC1'];
      try {
        for (const id of ids) db.upsertDownload(id, id, 'Cursor Channel', '');
        const first = db.getDownloadsCursorPage(2, null, 'next');
        assert.strictEqual(first.hasMore, true);
        const second = db.getDownloadsCursorPage(2, {
          timestamp: first.items[1].created_at,
          id: first.items[1].video_id,
        }, 'next');
        assert.ok(second.items.length > 0);
        assert.ok(!first.items.some(item => item.video_id === second.items[0].video_id));
        const previous = db.getDownloadsCursorPage(2, {
          timestamp: second.items[0].created_at,
          id: second.items[0].video_id,
        }, 'previous');
        assert.deepStrictEqual(
          previous.items.map(item => item.video_id),
          first.items.map(item => item.video_id),
        );
      } finally {
        for (const id of ids) db.deleteDownload(id);
      }
    });

    it('should complete a download', () => {
      db.completeDownload(DL_VIDEO);
      const dl = db.getDownload(DL_VIDEO);
      assert.strictEqual(dl.status, 'complete');
    });

    it('should delete a download', () => {
      db.deleteDownload(DL_VIDEO);
      const dl = db.getDownload(DL_VIDEO);
      assert.strictEqual(dl, null);
    });

    it('should atomically account and reconcile download storage', async () => {
      const before = await db.getDownloadStorageUsage();
      const adjustedBytes = await db.adjustDownloadStorageBytes(1234);
      assert.strictEqual(adjustedBytes, before.storedBytes + 1234);
      const adjusted = await db.getDownloadStorageUsage();
      assert.strictEqual(await db.reconcileDownloadStorageBytes(42, before.version), false);
      assert.strictEqual(await db.reconcileDownloadStorageBytes(42, adjusted.version), true);
      const reconciled = await db.getDownloadStorageUsage();
      assert.strictEqual(reconciled.storedBytes, 42);
      assert.strictEqual(
        await db.reconcileDownloadStorageBytes(before.storedBytes, reconciled.version),
        true,
      );
    });
  });

  describe('setWatchTime / getWatchTime', () => {
    it('should save and restore position', () => {
      db.setWatchTime(TEST_USER, TEST_VIDEO, 42.5, 300);
      const wt = db.getWatchTime(TEST_USER, TEST_VIDEO);
      assert.ok(wt);
      assert.strictEqual(wt.last_position, 42.5);
      assert.strictEqual(wt.duration, 300);
    });

    it('should return null for untracked video', () => {
      const wt = db.getWatchTime(TEST_USER, 'xxxxxxxxxxx');
      assert.strictEqual(wt, null);
    });

    it('should update position on subsequent call', () => {
      db.setWatchTime(TEST_USER, TEST_VIDEO, 100, 300);
      const wt = db.getWatchTime(TEST_USER, TEST_VIDEO);
      assert.strictEqual(wt.last_position, 100);
    });

    it('should increment and reverse Explore rollups and co-watch edges', async () => {
      const user = `rollup-user-${Date.now()}`;
      const source = 'rollupA0001';
      const related = 'rollupB0001';
      db.setWatchTime(user, source, 50, 100);
      db.setWatchTime(user, related, 50, 100);
      let signals = await db.getExploreCandidateSignals(
        [related], [related], [related], [], 'different-user', 24,
      );
      assert.strictEqual(signals.videoPopularity[related], 1);
      let cowatched = await db.getCoWatchedVideos([source], 'different-user', 10, 90, 100);
      assert.ok(cowatched.some(row => row.video_id === related && Number(row.score) === 1));

      db.setWatchTime(user, related, 10, 100);
      signals = await db.getExploreCandidateSignals(
        [related], [related], [related], [], 'different-user', 24,
      );
      assert.strictEqual(signals.videoPopularity[related], 0);
      cowatched = await db.getCoWatchedVideos([source], 'different-user', 10, 90, 100);
      assert.ok(!cowatched.some(row => row.video_id === related));
      db.setWatchTime(user, source, 10, 100);
    });

    it('should aggregate Explore impressions once per channel batch and expose user behavior rollups', async () => {
      const user = `behavior-rollup-${Date.now()}`;
      const channelId = 'UCbehaviorRollup00000001';
      const firstVideo = 'behavVid001';
      const secondVideo = 'behavVid002';
      try {
        db.logExploreImpressions(user, [
          { videoId: firstVideo, channelId, position: 1 },
          { videoId: secondVideo, channelId, position: 2 },
        ]);
        db.logExploreImpressions(user, [{ videoId: firstVideo, channelId, position: 3 }]);
        db.logExploreClick(user, firstVideo, channelId);
        db.logExploreClick(user, firstVideo, channelId);
        db.logExploreBounce(user, firstVideo, channelId, 12);
        db.logExploreReturn(user, firstVideo, channelId);
        db.logExploreReturn(user, firstVideo, channelId);

        const signals = await db.getExploreUserSignals(
          user,
          [firstVideo, secondVideo],
          [channelId],
          90,
        );
        assert.deepStrictEqual(signals.channelBehaviors[channelId], {
          impressions: 3,
          clicks: 1,
          bounces: 1,
          returns: 2,
        });
        assert.strictEqual(signals.returnChannelCounts[channelId], 2);
        const globalSignals = await db.getExploreCandidateSignals(
          [], [], [], [channelId], user, 24,
        );
        assert.strictEqual(globalSignals.channelImpressionCounts[channelId], 3);
      } finally {
        db.resetRecommendations(user);
      }
    });

    it('should cursor-page queue, saved playlists, and local playlist items', async () => {
      const user = `cursor-library-${Date.now()}`;
      const queueIds = ['queueCurA01', 'queueCurB01', 'queueCurC01'];
      const playlistIds = ['local_cursor_a', 'local_cursor_b', 'local_cursor_c'];
      const localId = 'local_cursor_items';
      try {
        for (const id of queueIds) db.queueVideo(user, id, id, '', '');
        const queueFirst = await db.getQueuedVideosCursorPage(user, 2, null, 'next');
        const queueNext = await db.getQueuedVideosCursorPage(user, 2, {
          timestamp: queueFirst.items[1].created_at,
          id: queueFirst.items[1].video_id,
        }, 'next');
        assert.deepStrictEqual(queueFirst.items.concat(queueNext.items).map(item => item.video_id), queueIds);

        for (const id of playlistIds) db.savePlaylist(user, id, id, '', '', '', '0 videos', 'local');
        const savedFirst = await db.getSavedPlaylistsCursorPage(user, 2, null, 'next');
        const savedNext = await db.getSavedPlaylistsCursorPage(user, 2, {
          timestamp: savedFirst.items[1].updated_at,
          id: savedFirst.items[1].playlist_id,
        }, 'next');
        assert.deepStrictEqual(savedFirst.items.concat(savedNext.items).map(item => item.playlist_id), playlistIds);

        const youtubePlaylistIds = ['PL_cursor_youtube_a', 'PL_cursor_youtube_b'];
        for (const id of youtubePlaylistIds) db.savePlaylist(user, id, id, '', '', '', '0 videos', 'youtube');
        const selectedYoutubePlaylists = await db.getSavedYoutubePlaylistIds(user, 1);
        assert.strictEqual(selectedYoutubePlaylists.length, 1);
        assert.ok(youtubePlaylistIds.includes(selectedYoutubePlaylists[0]));

        db.savePlaylist(user, localId, 'Items', '', '', '', '0 videos', 'local');
        for (const id of queueIds) db.addLocalPlaylistItem(user, localId, id, id, '', '');
        const localFirst = await db.getLocalPlaylistItemsCursorPage(user, localId, 2, null, 'next');
        const localNext = await db.getLocalPlaylistItemsCursorPage(user, localId, 2, {
          position: localFirst.items[1].position,
          createdAt: localFirst.items[1].created_at,
          videoId: localFirst.items[1].video_id,
        }, 'next');
        assert.deepStrictEqual(localFirst.items.concat(localNext.items).map(item => item.video_id), queueIds);
      } finally {
        for (const id of queueIds) db.unqueueVideo(user, id);
        for (const id of playlistIds) db.unsavePlaylist(user, id);
        for (const id of ['PL_cursor_youtube_a', 'PL_cursor_youtube_b']) db.unsavePlaylist(user, id);
        db.unsavePlaylist(user, localId);
      }
    });
  });

  describe('getSubByChannel', () => {
    it('should find subscription by channel ID cross-table', () => {
      db.upsertSubscriptions(TEST_USER, [
        { channelId: TEST_CHANNEL, title: 'Sub Lookup', thumbnail: '', description: '' },
      ]);
      const sub = db.getSubByChannel(TEST_CHANNEL);
      assert.ok(sub);
      assert.strictEqual(sub.channelId, TEST_CHANNEL);
      assert.strictEqual(sub.title, 'Sub Lookup');
      // cleanup
      db.deleteSubscription(TEST_USER, TEST_CHANNEL);
    });

    it('should return null for unknown channel', () => {
      assert.strictEqual(db.getSubByChannel('UC_NOPE_CHANNEL_XXXXXXXXXXX'), null);
    });
  });
});

// ---------------------------------------------------------------------------
// 2. LRU Map
// ---------------------------------------------------------------------------

describe('LRUMap', () => {
  it('should evict oldest entry when exceeding maxSize', () => {
    const lru = new LRUMap(3);
    lru.set('a', 1);
    lru.set('b', 2);
    lru.set('c', 3);
    lru.set('d', 4); // should evict 'a'
    assert.strictEqual(lru.has('a'), false);
    assert.strictEqual(lru.get('d'), 4);
    assert.strictEqual(lru.size, 3);
  });

  it('should promote entry on get (LRU ordering)', () => {
    const lru = new LRUMap(3);
    lru.set('a', 1);
    lru.set('b', 2);
    lru.set('c', 3);
    lru.get('a'); // touch 'a', so 'b' is now oldest
    lru.set('d', 4); // should evict 'b' (oldest untouched)
    assert.strictEqual(lru.has('a'), true);
    assert.strictEqual(lru.has('b'), false);
    assert.strictEqual(lru.has('d'), true);
  });

  it('should promote entry on set (replace)', () => {
    const lru = new LRUMap(3);
    lru.set('a', 1);
    lru.set('b', 2);
    lru.set('c', 3);
    lru.set('a', 10); // update 'a', 'b' becomes oldest
    lru.set('d', 4); // evicts 'b'
    assert.strictEqual(lru.has('b'), false);
    assert.strictEqual(lru.get('a'), 10);
  });

  it('should support delete', () => {
    const lru = new LRUMap(5);
    lru.set('x', 1);
    assert.strictEqual(lru.delete('x'), true);
    assert.strictEqual(lru.has('x'), false);
    assert.strictEqual(lru.size, 0);
  });

  it('should return undefined for missing key', () => {
    const lru = new LRUMap(5);
    assert.strictEqual(lru.get('missing'), undefined);
  });

  it('should support iteration', () => {
    const lru = new LRUMap(5);
    lru.set('a', 1);
    lru.set('b', 2);
    const entries = [...lru];
    assert.strictEqual(entries.length, 2);
    assert.deepStrictEqual(entries[0], ['a', 1]);
    assert.deepStrictEqual(entries[1], ['b', 2]);
  });

  it('should support keys(), values(), forEach()', () => {
    const lru = new LRUMap(5);
    lru.set('x', 10);
    lru.set('y', 20);
    assert.deepStrictEqual([...lru.keys()], ['x', 'y']);
    assert.deepStrictEqual([...lru.values()], [10, 20]);
    const collected = [];
    lru.forEach((v, k) => collected.push([k, v]));
    assert.strictEqual(collected.length, 2);
  });

  it('should support clear()', () => {
    const lru = new LRUMap(5);
    lru.set('a', 1);
    lru.set('b', 2);
    lru.clear();
    assert.strictEqual(lru.size, 0);
    assert.strictEqual(lru.has('a'), false);
  });
});

// ---------------------------------------------------------------------------
// 3. SharedLRUMap (without Redis)
// ---------------------------------------------------------------------------

describe('SharedLRUMap (no Redis)', () => {
  before(() => {
    // Ensure no Redis
    delete process.env.REDIS_URL;
  });

  it('should support sync get/set/delete like LRUMap', () => {
    const cache = new SharedLRUMap(10, 'test');
    cache.set('foo', { value: 42 });
    assert.deepStrictEqual(cache.get('foo'), { value: 42 });
    cache.delete('foo');
    assert.strictEqual(cache.get('foo'), undefined);
  });

  it('should return value from L1 via getAsync', async () => {
    const cache = new SharedLRUMap(10, 'test');
    cache.set('bar', { value: 99 });
    const result = await cache.getAsync('bar');
    assert.deepStrictEqual(result, { value: 99 });
  });

  it('should return undefined on getAsync miss (no Redis)', async () => {
    const cache = new SharedLRUMap(10, 'test');
    const result = await cache.getAsync('nonexistent');
    assert.strictEqual(result, undefined);
  });

  it('should evict like LRUMap', () => {
    const cache = new SharedLRUMap(2, 'test');
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    assert.strictEqual(cache.has('a'), false);
    assert.strictEqual(cache.get('c'), 3);
  });
});

// ---------------------------------------------------------------------------
// 4. Auth tokens
// ---------------------------------------------------------------------------

describe('Auth tokens', () => {
  it('should create a token with a dot separator', () => {
    const token = createStreamToken(TEST_VIDEO);
    assert.ok(typeof token === 'string');
    assert.ok(token.includes('.'), 'Token should contain a dot separator');
    const parts = token.split('.');
    assert.strictEqual(parts.length, 2);
    // First part should be a numeric expiry timestamp
    assert.ok(!isNaN(parseInt(parts[0], 10)));
  });

  it('should validate a fresh token', () => {
    const token = createStreamToken(TEST_VIDEO);
    assert.strictEqual(validateStreamToken(TEST_VIDEO, token), true);
  });

  it('should reject token for wrong videoId', () => {
    const token = createStreamToken(TEST_VIDEO);
    assert.strictEqual(validateStreamToken('xxxxxxxxxxx', token), false);
  });

  it('should reject expired token', () => {
    // Create a token that looks valid but has an expiry in the past
    const expiry = Date.now() - 1000; // 1 second ago
    // We can't easily create a valid HMAC with the server secret,
    // but we can test that ANY token with a past expiry is rejected
    const fakeToken = expiry + '.abcdef1234567890';
    assert.strictEqual(validateStreamToken(TEST_VIDEO, fakeToken), false);
  });

  it('should reject malformed tokens', () => {
    assert.strictEqual(validateStreamToken(TEST_VIDEO, 'no-dot-here'), false);
    assert.strictEqual(validateStreamToken(TEST_VIDEO, ''), false);
    assert.strictEqual(validateStreamToken(TEST_VIDEO, '.'), false);
    assert.strictEqual(validateStreamToken(TEST_VIDEO, 'abc.'), false);
  });

  it('should use timing-safe comparison (no early return on partial match)', () => {
    // Create a valid token, then tamper with one character of the signature
    const token = createStreamToken(TEST_VIDEO);
    const [expiry, sig] = token.split('.');
    // Flip one character in the signature
    const tampered =
      sig[0] === 'a'
        ? 'b' + sig.slice(1)
        : 'a' + sig.slice(1);
    const tamperedToken = expiry + '.' + tampered;
    // Must still be 16 chars for timingSafeEqual to not throw
    assert.strictEqual(tamperedToken.split('.')[1].length, sig.length);
    assert.strictEqual(validateStreamToken(TEST_VIDEO, tamperedToken), false);
  });
});

// ---------------------------------------------------------------------------
// 5. Rate limiter (via HTTP)
// ---------------------------------------------------------------------------

describe('Rate limiter', () => {
  const TEST_PORT = 13579;
  let child;

  before(async () => {
    // Fork the server as a child process
    child = fork(path.join(import.meta.dirname, '..', 'server.js'), [], {
      env: {
        ...process.env,
        PORT: String(TEST_PORT),
        SESSION_SECRET: 'test-secret-rate',
        NODE_ENV: 'test',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });

    // Wait for server to be ready
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Server start timeout')), 10000);
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

  it('should allow initial requests and eventually return 429', async () => {
    // The rate limiter starts with 60 tokens (RATE_BURST)
    // Each request consumes 1 token. Replenishment is 8/sec.
    // Send 70 rapid requests — some should succeed, last ones should 429.
    const results = [];
    for (let i = 0; i < 70; i++) {
      const res = await httpGet(TEST_PORT, '/favicon.ico');
      results.push(res.status);
    }

    const successes = results.filter((s) => s === 204);
    const rateLimited = results.filter((s) => s === 429);

    assert.ok(successes.length > 0, 'Some requests should succeed');
    assert.ok(rateLimited.length > 0, `Should get 429s after burst exhausted (got ${successes.length} successes out of 70)`);
  });
});

// ---------------------------------------------------------------------------
// 6. Storage abstraction (local filesystem)
// ---------------------------------------------------------------------------

describe('Storage abstraction (local filesystem)', () => {
  const testKey = '__test_integration_storage_file.bin';
  const testData = Buffer.from('Hello storage integration test');

  before(() => {
    // Ensure local filesystem mode (no S3)
    delete process.env.STORAGE_URL;
  });

  after(async () => {
    // Cleanup
    await del(testKey);
  });

  it('should write a buffer and stat it', async () => {
    await putBuffer(testKey, testData);
    const info = await stat(testKey);
    assert.strictEqual(info.exists, true);
    assert.strictEqual(info.size, testData.length);
  });

  it('should read back via getStream', async () => {
    const stream = await getStream(testKey);
    assert.ok(stream, 'getStream should return a readable stream');
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const result = Buffer.concat(chunks);
    assert.deepStrictEqual(result, testData);
  });

  it('should delete the file', async () => {
    await del(testKey);
    const info = await stat(testKey);
    assert.strictEqual(info.exists, false);
  });

  it('should return null for getStream on missing key', async () => {
    const stream = await getStream('__nonexistent_key_12345.bin');
    assert.strictEqual(stream, null);
  });

  it('should return { exists: false } for stat on missing key', async () => {
    const info = await stat('__nonexistent_key_12345.bin');
    assert.strictEqual(info.exists, false);
    assert.strictEqual(info.size, 0);
  });
});

// ---------------------------------------------------------------------------
// 7. Segment cache (without Redis)
// ---------------------------------------------------------------------------

describe('Segment cache (no Redis)', () => {
  before(() => {
    delete process.env.REDIS_URL;
  });

  it('should return null from getSegment when no Redis', async () => {
    const result = await getSegment('vid123', '140', 'bytes=0-1000');
    assert.strictEqual(result, null);
  });

  it('should not throw from putSegment when no Redis', async () => {
    // Should silently do nothing
    await assert.doesNotReject(async () => {
      await putSegment('vid123', '140', 'bytes=0-1000', Buffer.alloc(100), {
        contentType: 'video/mp4',
        contentRange: 'bytes 0-99/1000',
        status: 200,
      });
    });
  });
});

// ---------------------------------------------------------------------------
// 8. Extraction queue (without Redis)
// ---------------------------------------------------------------------------

describe('Extraction queue (no Redis)', () => {
  before(() => {
    delete process.env.REDIS_URL;
  });

  it('should report hasQueue() === false without REDIS_URL', () => {
    assert.strictEqual(hasQueue(), false);
  });

  it('should return null from enqueueExtraction without queue', async () => {
    const result = await enqueueExtraction('someVideoId', 5000);
    assert.strictEqual(result, null);
  });
});

// ---------------------------------------------------------------------------
// 9. WebSocket status (without server)
// ---------------------------------------------------------------------------

describe('WebSocket status (no server)', () => {
  it('should report isAvailable() === false before attach', () => {
    // ws-status may already be attached by server.js in the rate-limiter fork,
    // but in THIS process no server was created, so wss should be null
    // Actually server.js was required for db tests, which calls attach...
    // Use a fresh module check — since server.js was not required in this process,
    // ws-status should not have been attached.
    // Note: import('../lib/ws-status') returns the singleton. If server.js was required
    // earlier in another describe, wss could be set. But we only required db.js, not server.js.
    assert.strictEqual(isAvailable(), false);
  });

  it('should not throw from notify() when no listeners', () => {
    assert.doesNotThrow(() => {
      notify('someVideoId', { type: 'progress', percent: 50 });
    });
  });

  it('should not throw from notify() with non-subscribed videoId', () => {
    assert.doesNotThrow(() => {
      notify('nonexistent', { type: 'done' });
    });
  });
});

// ---------------------------------------------------------------------------
// 10. HTTP endpoint smoke tests
// ---------------------------------------------------------------------------

describe('HTTP endpoint smoke tests', () => {
  const TEST_PORT = 13580;
  let child;

  before(async () => {
    child = fork(path.join(import.meta.dirname, '..', 'server.js'), [], {
      env: {
        ...process.env,
        PORT: String(TEST_PORT),
        SESSION_SECRET: 'test-secret-http',
        NODE_ENV: 'test',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Server start timeout')), 10000);
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

  it('GET /favicon.ico should return 204', async () => {
    const res = await httpGet(TEST_PORT, '/favicon.ico');
    assert.strictEqual(res.status, 204);
  });

  it('GET /metrics should expose bounded Prometheus performance series', async () => {
    const res = await httpGet(TEST_PORT, '/metrics');
    assert.strictEqual(res.status, 200);
    assert.match(res.headers['content-type'] || '', /text\/plain/);
    assert.strictEqual(res.headers['cache-control'], 'no-store');
    assert.match(res.body, /process_uptime_seconds/);
    assert.match(res.body, /http_request_duration_ms/);
  });

  it('GET /metrics should reject a public client forwarded by the local reverse proxy', async () => {
    const res = await httpGet(TEST_PORT, '/metrics', { 'X-Forwarded-For': '203.0.113.5' });
    assert.strictEqual(res.status, 404);
  });

  it('records bounded stream completion, first-byte, byte, and duration telemetry', async () => {
    const streamRes = await httpGet(TEST_PORT, `/api/stream/${TEST_VIDEO}/progressive`);
    assert.strictEqual(streamRes.status, 401);
    // Metrics snapshots are intentionally cached to keep scrape cost bounded.
    await new Promise(resolve => setTimeout(resolve, 1100));
    const metrics = await httpGet(TEST_PORT, '/metrics');
    assert.match(metrics.body, /stream_responses_total\{operation="progressive",result="complete",status="4xx"\}/);
    assert.match(metrics.body, /stream_response_first_byte_seconds_count\{operation="progressive"\}/);
    assert.match(metrics.body, /stream_response_bytes_total\{operation="progressive",result="complete"\}/);
    assert.match(metrics.body, /stream_response_duration_seconds_count\{operation="progressive",result="complete",status="4xx"\}/);
  });

  it('GET /native-player-engine.min.js should cache the versioned player runtime immutably', async () => {
    const res = await httpGet(TEST_PORT, '/native-player-engine.min.js?v=contenthash');
    assert.strictEqual(res.status, 200);
    assert.match(res.headers['cache-control'] || '', /immutable/);
  });

  it('GET /native-player-engine.min.js should serve its precompressed Brotli build', async () => {
    const res = await httpGet(TEST_PORT, '/native-player-engine.min.js?v=contenthash', {
      'Accept-Encoding': 'br, gzip',
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers['content-encoding'], 'br');
    assert.match(res.headers.vary || '', /Accept-Encoding/i);
    assert.match(res.headers['cache-control'] || '', /immutable/);
  });

  it('GET /player-page.min.js should cache the versioned page runtime immutably', async () => {
    const res = await httpGet(TEST_PORT, '/player-page.min.js?v=contenthash');
    assert.strictEqual(res.status, 200);
    assert.match(res.headers['cache-control'] || '', /immutable/);
    assert.match(res.body, /window\.__playerBootstrap/);
  });

  it('GET /player-telemetry.min.js should serve the optional feature chunk immutably', async () => {
    const res = await httpGet(TEST_PORT, '/player-telemetry.min.js?v=contenthash');
    assert.strictEqual(res.status, 200);
    assert.match(res.headers['cache-control'] || '', /immutable/);
    assert.match(res.body, /PlayerTelemetry/);
  });

  it('GET /auth/login should return 200', async () => {
    const res = await httpGet(TEST_PORT, '/auth/login');
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.length > 0, 'Should have response body');
  });

  it('GET / without session should redirect to /auth/login', async () => {
    const res = await httpGet(TEST_PORT, '/');
    // Express redirects typically return 302
    assert.ok(
      res.status === 302 || res.status === 301 || res.status === 303,
      `Expected redirect, got ${res.status}`
    );
    assert.ok(
      res.headers.location && res.headers.location.includes('/auth/login'),
      'Should redirect to /auth/login'
    );
  });

  it('POST /auth/free should redirect to / (creates session)', async () => {
    const res = await httpRequest(TEST_PORT, 'POST', '/auth/free');
    assert.ok(
      res.status === 302 || res.status === 301 || res.status === 303,
      `Expected redirect, got ${res.status}`
    );
    assert.ok(
      res.headers.location === '/' || res.headers.location === './',
      `Expected redirect to /, got ${res.headers.location}`
    );
  });

  it('GET /watch shell should default to native player without eager Shaka', async () => {
    const login = await httpRequest(TEST_PORT, 'POST', '/auth/free');
    const cookie = Array.isArray(login.headers['set-cookie'])
      ? login.headers['set-cookie'].map((value) => value.split(';')[0]).join('; ')
      : '';
    assert.ok(cookie, 'Expected auth cookie from /auth/free');

    const res = await httpGetUntil(
      TEST_PORT,
      `/watch?v=${TEST_VIDEO}`,
      (body) => /\/player-page\.min\.js\?v=[a-f0-9]{16}/.test(body),
      { Cookie: cookie }
    );

    assert.strictEqual(res.status, 200);
    assert.match(res.body, /<main[^>]*class="[^"]*player-page/);
    assert.match(res.body, /\/native-player-engine\.min\.js\?v=[a-f0-9]{16}/, 'Should load the content-versioned native player engine in the shell');
    assert.match(res.body, /\/player-telemetry\.min\.js\?v=[a-f0-9]{16}/, 'Should load the content-versioned telemetry chunk');
    assert.match(res.body, /\/player-page\.min\.js\?v=[a-f0-9]{16}/, 'Should load the content-versioned page runtime in the shell');
    assert.ok(!res.body.includes('/vendor/shaka/shaka-player.compiled.js'), 'Should not eager-load Shaka in the watch shell');
    assert.ok(!res.body.includes('/player-engine.js'), 'Should not load the legacy Shaka-primary engine in the watch shell');
    assert.strictEqual(res.headers['x-accel-buffering'], 'no');
  });

  it('GET /live/:videoId should redirect to /watch?v= (YouTube live share links)', async () => {
    const res = await httpGet(TEST_PORT, `/live/${TEST_VIDEO}`);
    assert.ok(
      res.status === 302 || res.status === 301 || res.status === 303,
      `Expected redirect, got ${res.status}`
    );
    assert.strictEqual(res.headers.location, `/watch?v=${TEST_VIDEO}`);
  });

  it('GET /live/:videoId should preserve the t param', async () => {
    const res = await httpGet(TEST_PORT, `/live/${TEST_VIDEO}?t=123`);
    assert.strictEqual(res.headers.location, `/watch?v=${TEST_VIDEO}&t=123`);
  });

  it('GET /live/:videoId with invalid ID should return 400', async () => {
    const res = await httpGet(TEST_PORT, '/live/not-a-valid-id');
    assert.strictEqual(res.status, 400);
  });

  it('POST /api/watch-time/dQw4w9WgXcQ without session should return 401', async () => {
    const res = await httpRequest(TEST_PORT, 'POST', '/api/watch-time/dQw4w9WgXcQ', {
      position: 10,
      duration: 300,
    });
    assert.strictEqual(res.status, 401);
  });

  it('coalesces watch-time updates while preserving immediate reads and completion', async () => {
    const login = await httpRequest(TEST_PORT, 'POST', '/auth/free');
    const cookie = Array.isArray(login.headers['set-cookie'])
      ? login.headers['set-cookie'].map((value) => value.split(';')[0]).join('; ')
      : '';
    assert.ok(cookie, 'Expected auth cookie from /auth/free');
    const headers = { Cookie: cookie };

    const first = await httpRequest(TEST_PORT, 'POST', `/api/watch-time/${TEST_VIDEO}`, {
      position: 25,
      duration: 300,
    }, headers);
    const second = await httpRequest(TEST_PORT, 'POST', `/api/watch-time/${TEST_VIDEO}`, {
      position: 50,
      duration: 300,
    }, headers);
    assert.strictEqual(first.status, 200);
    assert.strictEqual(second.status, 200);
    const visible = await httpGet(TEST_PORT, `/api/watch-time/${TEST_VIDEO}`, headers);
    assert.deepStrictEqual(JSON.parse(visible.body), { position: 50, duration: 300 });

    const completed = await httpRequest(TEST_PORT, 'POST', `/api/watch-time/${TEST_VIDEO}`, {
      position: 295,
      duration: 300,
    }, headers);
    assert.strictEqual(completed.status, 200);
    const final = await httpGet(TEST_PORT, `/api/watch-time/${TEST_VIDEO}`, headers);
    assert.deepStrictEqual(JSON.parse(final.body), { position: 0, duration: 300 });
  });

  it('POST /api/player-events should accept sanitized first-party telemetry without session', async () => {
    const res = await httpRequest(TEST_PORT, 'POST', '/api/player-events', {
      events: [{
        type: 'first-frame',
        videoId: 'dQw4w9WgXcQ',
        provider: 'native-dash',
        mode: 'dash',
        transmuxerProvider: 'first-party-ts',
        transmuxedSegmentCount: 2,
        activeHeight: 720,
        bufferAhead: 12,
      }],
    });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(JSON.parse(res.body), { ok: true });
  });

  it('should include security headers', async () => {
    const res = await httpGet(TEST_PORT, '/auth/login');
    assert.ok(res.headers['content-security-policy'], 'Should have CSP header');
    assert.strictEqual(res.headers['referrer-policy'], 'no-referrer');
    assert.strictEqual(res.headers['x-content-type-options'], 'nosniff');
    assert.strictEqual(res.headers['x-frame-options'], 'DENY');
    assert.strictEqual(res.headers['x-dns-prefetch-control'], 'off');
  });
});
