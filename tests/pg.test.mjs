import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import db from '../db.js';
import { getExploreVideos } from '../youtube/explore.js';
import { cache } from '../youtube/shared.js';

const TEST_USER = 'test-user-pg-' + Date.now();
const TEST_VIDEO = 'pgTestVid001';
const TEST_CHANNEL = 'UCpgTestChannel00000000000';

if (!process.env.DATABASE_URL) {
  describe('PostgreSQL tests (skipped — no DATABASE_URL)', () => {
    it('skipped', () => { assert.ok(true, 'Set DATABASE_URL to run PG tests'); });
  });
} else {
  describe('Database layer (PostgreSQL)', () => {
    before(async () => {
      // Wait for schema init
      if (db._ready) await db._ready;
    });

    after(async () => {
      // Clean up test data
      try { await db.removeTag(TEST_USER, TEST_VIDEO, 'testtag'); } catch {}
      try { await db.removeTag(TEST_USER, TEST_VIDEO, 'anothertag'); } catch {}
      try { await db.deleteSubscription(TEST_USER, TEST_CHANNEL); } catch {}
      try {
        // Clean up durations and watch time via direct pool query
        const pg = await import('pg');
        const Pool = pg.default?.Pool || pg.Pool;
        const pool = new Pool({ connectionString: process.env.DATABASE_URL });
        await pool.query("DELETE FROM video_durations WHERE video_id LIKE 'pg_test_%'");
        await pool.query('DELETE FROM watch_time WHERE user_id = $1', [TEST_USER]);
        await pool.end();
      } catch {}
    });

    describe('addTag / getTags / removeTag', () => {
      it('should add a tag and return it in getTags', async () => {
        const result = await db.addTag(TEST_USER, TEST_VIDEO, 'TestTag');
        assert.strictEqual(result.ok, true);
        assert.strictEqual(result.tag, 'testtag'); // normalized

        const tags = await db.getTags(TEST_USER, TEST_VIDEO);
        assert.ok(tags.includes('testtag'), 'Tag should be present');
      });

      it('should ignore duplicate tags (ON CONFLICT DO NOTHING)', async () => {
        const result = await db.addTag(TEST_USER, TEST_VIDEO, 'testtag');
        assert.strictEqual(result.ok, true);
        const tags = await db.getTags(TEST_USER, TEST_VIDEO);
        const count = tags.filter((t) => t === 'testtag').length;
        assert.strictEqual(count, 1);
      });

      it('should remove a tag and verify it is gone', async () => {
        await db.addTag(TEST_USER, TEST_VIDEO, 'anothertag');
        let tags = await db.getTags(TEST_USER, TEST_VIDEO);
        assert.ok(tags.includes('anothertag'));

        await db.removeTag(TEST_USER, TEST_VIDEO, 'anothertag');
        tags = await db.getTags(TEST_USER, TEST_VIDEO);
        assert.ok(!tags.includes('anothertag'), 'Tag should be removed');
      });

      it('should reject invalid tags', async () => {
        const result = await db.addTag(TEST_USER, TEST_VIDEO, '###');
        assert.strictEqual(result.ok, false);
      });
    });

    describe('upsertSubscriptions / getSubscriptions', () => {
      it('should upsert and retrieve subscriptions', async () => {
        await db.upsertSubscriptions(TEST_USER, [
          { channelId: TEST_CHANNEL, title: 'PG Test Channel', thumbnail: '//example.com/thumb.jpg', description: 'A test channel' },
        ]);
        const subs = await db.getSubscriptions(TEST_USER);
        const found = subs.find((s) => s.channelId === TEST_CHANNEL);
        assert.ok(found, 'Subscription should exist');
        assert.strictEqual(found.title, 'PG Test Channel');
        assert.ok(found.thumbnail.startsWith('https:'), 'Thumbnail should be normalized to https');
      });

      it('should update existing subscription on upsert', async () => {
        await db.upsertSubscriptions(TEST_USER, [
          { channelId: TEST_CHANNEL, title: 'Updated PG Title', thumbnail: 'https://example.com/new.jpg', description: 'Updated' },
        ]);
        const subs = await db.getSubscriptions(TEST_USER);
        const found = subs.find((s) => s.channelId === TEST_CHANNEL);
        assert.strictEqual(found.title, 'Updated PG Title');
      });

      it('should search literal wildcard characters with window-count pagination', async () => {
        await db.upsertSubscriptions(TEST_USER, [{
          channelId: TEST_CHANNEL,
          title: 'Literal 100%_ Match',
          thumbnail: '',
          description: 'Search pagination fixture',
        }]);
        const page = await db.searchSubscriptions(TEST_USER, '%_', 20, 0);
        assert.strictEqual(page.totalResults, 1);
        assert.deepStrictEqual(page.items.map(item => item.channelId), [TEST_CHANNEL]);
        assert.ok(page.items.every(item => item._total === undefined));

        const outOfRange = await db.searchSubscriptions(TEST_USER, '%_', 20, 100);
        assert.strictEqual(outOfRange.totalResults, 1);
        assert.deepStrictEqual(outOfRange.items, []);
      });

      it('should cursor-page subscription search without exact counts', async () => {
        const channelIds = Array.from({ length: 5 }, (_, index) => `UCpgCursor${String(index).padStart(15, '0')}`);
        try {
          await db.upsertSubscriptions(TEST_USER, channelIds.map((channelId, index) => ({
            channelId,
            title: `PG Cursor ${index}`,
            thumbnail: '',
            description: '',
          })));
          const first = await db.getSubscriptionsCursorPage(TEST_USER, 'pg cursor', 2, null, 'next');
          assert.strictEqual(first.items.length, 2);
          assert.strictEqual(first.hasMore, true);
          const last = first.items.at(-1);
          const second = await db.getSubscriptionsCursorPage(TEST_USER, 'PG CURSOR', 2, {
            title: last.title,
            channelId: last.channelId,
          }, 'next');
          assert.deepStrictEqual(second.items.map(item => item.title), ['PG Cursor 2', 'PG Cursor 3']);
        } finally {
          for (const channelId of channelIds) await db.deleteSubscription(TEST_USER, channelId);
        }
      });

      it('should delete a subscription', async () => {
        await db.deleteSubscription(TEST_USER, TEST_CHANNEL);
        const subs = await db.getSubscriptions(TEST_USER);
        const found = subs.find((s) => s.channelId === TEST_CHANNEL);
        assert.strictEqual(found, undefined);
      });
    });

    describe('setDuration / getDuration / getDurations (ANY($1::text[]))', () => {
      it('should store and retrieve a single duration', async () => {
        await db.setDuration('pg_test_dur_1', 123.45, 'not_live');
        const dur = await db.getDuration('pg_test_dur_1');
        assert.strictEqual(dur, 123.45);
      });

      it('should return null for unknown video', async () => {
        const dur = await db.getDuration('pg_test_nonexistent');
        assert.strictEqual(dur, null);
      });

      it('should batch-retrieve durations via ANY($1::text[])', async () => {
        await db.setDuration('pg_test_dur_2', 200, 'not_live');
        await db.setDuration('pg_test_dur_3', 300, 'not_live');
        const durations = await db.getDurations(['pg_test_dur_2', 'pg_test_dur_3', 'pg_test_nonexistent']);
        assert.strictEqual(durations['pg_test_dur_2'], 200);
        assert.strictEqual(durations['pg_test_dur_3'], 300);
        assert.strictEqual(durations['pg_test_nonexistent'], undefined);
      });

      it('should handle empty array in getDurations', async () => {
        const durations = await db.getDurations([]);
        assert.deepStrictEqual(durations, {});
      });
    });

    describe('setWatchTime / getWatchTime', () => {
      it('should save and restore position', async () => {
        await db.setWatchTime(TEST_USER, TEST_VIDEO, 42.5, 300);
        const wt = await db.getWatchTime(TEST_USER, TEST_VIDEO);
        assert.ok(wt);
        assert.strictEqual(wt.last_position, 42.5);
        assert.strictEqual(wt.duration, 300);
      });

      it('should return null for untracked video', async () => {
        const wt = await db.getWatchTime(TEST_USER, 'xxxxxxxxxxx');
        assert.strictEqual(wt, null);
      });

      it('should update position on subsequent call', async () => {
        await db.setWatchTime(TEST_USER, TEST_VIDEO, 100, 300);
        const wt = await db.getWatchTime(TEST_USER, TEST_VIDEO);
        assert.strictEqual(wt.last_position, 100);
      });
    });

    describe('Async return verification', () => {
      it('all methods should return Promises', async () => {
        // Verify that PG methods return promises (not sync values)
        const tagResult = db.addTag(TEST_USER, 'asyncVerify1', 'checktag');
        assert.ok(tagResult instanceof Promise, 'addTag should return a Promise');
        await tagResult;

        const getTagsResult = db.getTags(TEST_USER, 'asyncVerify1');
        assert.ok(getTagsResult instanceof Promise, 'getTags should return a Promise');
        await getTagsResult;

        const removeResult = db.removeTag(TEST_USER, 'asyncVerify1', 'checktag');
        assert.ok(removeResult instanceof Promise, 'removeTag should return a Promise');
        await removeResult;

        const getDurResult = db.getDuration('__nonexistent__');
        assert.ok(getDurResult instanceof Promise, 'getDuration should return a Promise');
        await getDurResult;

        const getDursResult = db.getDurations([]);
        assert.ok(getDursResult instanceof Promise, 'getDurations should return a Promise');
        await getDursResult;

        const setWtResult = db.setWatchTime(TEST_USER, 'asyncVerify1', 0, 0);
        assert.ok(setWtResult instanceof Promise, 'setWatchTime should return a Promise');
        await setWtResult;

        const getWtResult = db.getWatchTime(TEST_USER, 'asyncVerify1');
        assert.ok(getWtResult instanceof Promise, 'getWatchTime should return a Promise');
        await getWtResult;

        const getSubsResult = db.getSubscriptions(TEST_USER);
        assert.ok(getSubsResult instanceof Promise, 'getSubscriptions should return a Promise');
        await getSubsResult;
      });
    });

    describe('Async application consumers', () => {
      it('builds Explore through the PostgreSQL API without sync assumptions', async () => {
        // Earlier tag API tests intentionally leave this tag in place; Explore
        // excludes tagged videos, so isolate this application-level scenario.
        await db.removeTag(TEST_USER, TEST_VIDEO, 'testtag');
        await db.upsertSubscriptions(TEST_USER, [{
          channelId: TEST_CHANNEL,
          title: 'PG Explore Channel',
          thumbnail: '',
          description: '',
        }]);
        await db.setRssCache(TEST_CHANNEL, {
          channelTitle: 'PG Explore Channel',
          items: [{
            videoId: TEST_VIDEO,
            title: 'PG Explore Video',
            publishedAt: new Date().toISOString(),
            channelId: TEST_CHANNEL,
          }],
        }, { etag: '"pg-feed-v1"', lastModified: 'Sun, 02 Aug 2026 00:00:00 GMT' });
        const cachedFeed = await db.getRssCache(TEST_CHANNEL);
        assert.deepStrictEqual(cachedFeed.validators, {
          etag: '"pg-feed-v1"',
          lastModified: 'Sun, 02 Aug 2026 00:00:00 GMT',
        });
        await db.touchRssCache(TEST_CHANNEL, { etag: '"pg-feed-v1"' });
        const rssRows = await db.getRssVideosForUser(TEST_USER, null, 6, 20);
        assert.ok(rssRows.some(row => row.video_id === TEST_VIDEO));
        await db.setDuration(TEST_VIDEO, 654, 'not_live');
        const todayPage = await db.getRssVideosPageForUser(TEST_USER, null, 6, 20, 0);
        assert.ok(todayPage.totalResults >= 1);
        const todayVideo = todayPage.items.find(row => row.video_id === TEST_VIDEO);
        assert.ok(todayVideo);
        assert.strictEqual(Number(todayVideo.duration), 654);
        const bootstrap = await db.getPlayerBootstrapData(TEST_USER, TEST_VIDEO, true);
        assert.deepStrictEqual(bootstrap.display, {
          title: 'PG Explore Video',
          channelTitle: 'PG Explore Channel',
          channelId: TEST_CHANNEL,
        });
        assert.deepStrictEqual(bootstrap.tags, []);
        assert.strictEqual(bootstrap.rating, 0);
        assert.strictEqual(bootstrap.liveStatus, 'not_live');
        const todayCursorPage = await db.getRssVideosCursorPageForUser(
          TEST_USER, null, 6, 20, null, 'older',
        );
        assert.ok(todayCursorPage.items.some(row => row.video_id === TEST_VIDEO));
        const storageBefore = await db.getDownloadStorageUsage();
        const storageBytes = await db.adjustDownloadStorageBytes(17);
        assert.strictEqual(storageBytes, storageBefore.storedBytes + 17);
        const storageAdjusted = await db.getDownloadStorageUsage();
        assert.strictEqual(
          await db.reconcileDownloadStorageBytes(storageBefore.storedBytes, storageAdjusted.version),
          true,
        );
        cache.exploreVideos.delete(TEST_USER);
        const result = await getExploreVideos(TEST_USER);
        assert.ok(result.videos.some(video => video.videoId === TEST_VIDEO));
        const lease = `pg-maintenance-${Date.now()}`;
        assert.strictEqual(await db.claimMaintenanceLease(lease, 60), true);
        assert.strictEqual(await db.claimMaintenanceLease(lease, 60), false);
        const migration = 'pg-integration-test-marker-v1';
        await db.recordSchemaMigration(migration);
        assert.strictEqual(await db.hasSchemaMigration(migration), true);
        await db.recordSchemaMigration(migration);
        assert.strictEqual(await db.hasSchemaMigration(migration), true);
      });
    });
  });
}
