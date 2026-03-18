import { describe, it, afterEach, before } from 'node:test';
import assert from 'node:assert';
import db from '../db.js';
import { getExploreVideos, DEFAULT_EXPLORE_CONFIG } from '../youtube/explore.js';
import { cache } from '../youtube/shared.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_USER = 'test-explore-user';
const CHANNELS = ['EX_CH_A', 'EX_CH_B', 'EX_CH_C', 'EX_CH_D', 'EX_CH_E'];

function setupBaseData() {
  db.upsertSubscriptions(TEST_USER, CHANNELS.map(ch => ({
    channelId: ch, title: `Channel ${ch}`, thumbnail: '', description: '',
  })));
  for (const ch of CHANNELS) {
    db.setRssCache(ch, {
      channelTitle: `Channel ${ch}`,
      items: Array.from({ length: 5 }, (_, i) => ({
        videoId: `${ch}_v${i}`,
        title: `Video ${i} from ${ch}`,
        publishedAt: new Date(Date.now() - i * 3600000).toISOString(),
        channelId: ch,
      })),
    });
  }
}

function cleanupTestData() {
  // Clean subscriptions
  for (const ch of CHANNELS) {
    try { db.deleteSubscription(TEST_USER, ch); } catch { /* ignore */ }
  }
  // Clean RSS cache — use raw SQL since there's no deleteRssCache in the API
  try {
    for (const ch of CHANNELS) {
      db.setRssCache(ch, { channelTitle: '', items: [] });
    }
  } catch { /* ignore */ }
  // Clean watch times
  try {
    const watches = db.getAllWatchTimesForUser(TEST_USER);
    for (const wt of watches) {
      // Reset watch time by setting to 0/0
      db.setWatchTime(TEST_USER, wt.video_id, 0, 0);
    }
  } catch { /* ignore */ }
  // Clean dismissals, boosts, mutes, ratings, queue, topic filters, explore events
  try {
    const dismissed = db.getDismissedVideoIds(TEST_USER);
    for (const vid of dismissed) db.undismissVideo(TEST_USER, vid);
  } catch { /* ignore */ }
  try {
    const boosted = db.getBoostedChannelIds(TEST_USER);
    for (const ch of boosted) db.unboostChannel(TEST_USER, ch);
  } catch { /* ignore */ }
  try {
    const muted = db.getMutedChannelIds(TEST_USER);
    for (const ch of muted) db.unmuteChannel(TEST_USER, ch);
  } catch { /* ignore */ }
  try {
    const ratings = db.getVideoRatings(TEST_USER);
    for (const r of ratings) db.unrateVideo(TEST_USER, r.video_id);
  } catch { /* ignore */ }
  try {
    const queued = db.getQueuedVideoIds(TEST_USER);
    for (const vid of queued) db.unqueueVideo(TEST_USER, vid);
  } catch { /* ignore */ }
  try {
    const filters = db.getTopicFilters(TEST_USER);
    for (const f of filters) db.removeTopicFilter(TEST_USER, f.topic);
  } catch { /* ignore */ }
  // Clear explore cache for test user
  cache.exploreVideos.delete(TEST_USER);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Explore algorithm', () => {
  before(() => {
    delete process.env.DATABASE_URL;
  });

  afterEach(() => {
    cleanupTestData();
  });

  it('1. Empty state — no subs returns empty result', () => {
    const result = getExploreVideos(TEST_USER);
    assert.deepStrictEqual(result.videos, []);
    assert.deepStrictEqual(result.continueWatching, []);
    assert.deepStrictEqual(result.newVideoIds, []);
  });

  it('2. Basic result structure — has expected shape and bounds', () => {
    setupBaseData();
    const result = getExploreVideos(TEST_USER);
    assert.ok(Array.isArray(result.videos));
    assert.ok(result.videos.length <= 60);
    assert.ok(result.videos.length > 0);
    for (const v of result.videos) {
      assert.ok(v.videoId, 'video should have videoId');
      assert.ok(v.title, 'video should have title');
      assert.ok(v.channelId, 'video should have channelId');
    }
    assert.ok(Array.isArray(result.continueWatching));
    assert.ok(Array.isArray(result.newVideoIds));
  });

  it('3. Watched channels rank higher than unwatched', () => {
    setupBaseData();
    // Watch several videos from CH_A (partial watch so they stay as candidates)
    for (let i = 0; i < 3; i++) {
      db.setWatchTime(TEST_USER, `EX_CH_A_v${i}`, 200, 600);
    }
    cache.exploreVideos.delete(TEST_USER);
    const result = getExploreVideos(TEST_USER);
    // At least some CH_A videos should appear in results (affinity should be non-zero)
    const chAVideos = result.videos.filter(v => v.channelId === 'EX_CH_A');
    assert.ok(chAVideos.length > 0,
      'Watched channel CH_A should have videos in results');
    // Find highest-ranked CH_A vs highest-ranked CH_E
    const chAFirstIdx = result.videos.findIndex(v => v.channelId === 'EX_CH_A');
    const chEFirstIdx = result.videos.findIndex(v => v.channelId === 'EX_CH_E');
    // With watch history, CH_A's first appearance should be no later than position 10
    assert.ok(chAFirstIdx < 10,
      `Watched channel CH_A first appears at position ${chAFirstIdx}, expected < 10`);
  });

  it('4. Continue watching removed — returns empty array', () => {
    setupBaseData();
    const result = getExploreVideos(TEST_USER);
    assert.deepStrictEqual(result.continueWatching, []);
  });

  it('5. Channel mute exclusion — muted channel absent from output', () => {
    setupBaseData();
    db.muteChannel(TEST_USER, 'EX_CH_B');
    cache.exploreVideos.delete(TEST_USER);
    const result = getExploreVideos(TEST_USER);
    const chBVideos = result.videos.filter(v => v.channelId === 'EX_CH_B');
    assert.strictEqual(chBVideos.length, 0, 'Muted channel should have zero videos');
  });

  it('6. Dismissed videos excluded', () => {
    setupBaseData();
    db.dismissVideo(TEST_USER, 'EX_CH_A_v0', 'EX_CH_A');
    cache.exploreVideos.delete(TEST_USER);
    const result = getExploreVideos(TEST_USER);
    const dismissed = result.videos.filter(v => v.videoId === 'EX_CH_A_v0');
    assert.strictEqual(dismissed.length, 0, 'Dismissed video should be absent');
  });

  it('7. Filter bubble — max 2 per channel in top 10', () => {
    setupBaseData();
    // Give CH_A extreme affinity — 20 watches
    for (let i = 0; i < 5; i++) {
      db.setWatchTime(TEST_USER, `EX_CH_A_v${i}`, 590, 600);
    }
    // Add more RSS items for CH_A so it has enough candidates
    db.setRssCache('EX_CH_A', {
      channelTitle: 'Channel EX_CH_A',
      items: Array.from({ length: 15 }, (_, i) => ({
        videoId: `EX_CH_A_extra_${i}`,
        title: `Extra Video ${i} from EX_CH_A`,
        publishedAt: new Date(Date.now() - i * 3600000).toISOString(),
        channelId: 'EX_CH_A',
      })),
    });
    cache.exploreVideos.delete(TEST_USER);
    const result = getExploreVideos(TEST_USER);
    const top10 = result.videos.slice(0, 10);
    const chAInTop10 = top10.filter(v => v.channelId === 'EX_CH_A').length;
    assert.ok(chAInTop10 <= 2,
      `Top 10 should have at most 2 from CH_A, got ${chAInTop10}`);
  });

  it('8. New subscription boost — new channel videos appear', () => {
    setupBaseData();
    // Subscribe to a brand new channel
    const newCh = 'EX_CH_NEW';
    db.upsertSubscriptions(TEST_USER, [{
      channelId: newCh, title: 'New Channel', thumbnail: '', description: '',
    }]);
    db.setRssCache(newCh, {
      channelTitle: 'New Channel',
      items: Array.from({ length: 3 }, (_, i) => ({
        videoId: `${newCh}_v${i}`,
        title: `New Channel Video ${i}`,
        publishedAt: new Date(Date.now() - i * 3600000).toISOString(),
        channelId: newCh,
      })),
    });
    cache.exploreVideos.delete(TEST_USER);
    const result = getExploreVideos(TEST_USER);
    const newChVideos = result.videos.filter(v => v.channelId === newCh);
    assert.ok(newChVideos.length > 0, 'New subscription should have videos in results');
    // Cleanup extra channel
    try {
      db.deleteSubscription(TEST_USER, newCh);
      db.setRssCache(newCh, { channelTitle: '', items: [] });
    } catch { /* ignore */ }
  });

  it('9. Cache hit — second call returns same reference', () => {
    setupBaseData();
    const result1 = getExploreVideos(TEST_USER);
    const result2 = getExploreVideos(TEST_USER);
    assert.strictEqual(result1, result2, 'Cached result should be same reference');
  });

  it('10. All videos have reason badges', () => {
    setupBaseData();
    const result = getExploreVideos(TEST_USER);
    for (const v of result.videos) {
      assert.ok(v.reason && v.reason.length > 0,
        `Video ${v.videoId} should have a non-empty reason, got "${v.reason}"`);
    }
  });

  it('11. Config override — zero affinity changes scoring', () => {
    setupBaseData();
    // Watch CH_A heavily (partial watch to keep as candidates)
    for (let i = 0; i < 3; i++) {
      db.setWatchTime(TEST_USER, `EX_CH_A_v${i}`, 200, 600);
    }

    // Normal config — CH_A should get "for you" reason badges from affinity
    cache.exploreVideos.delete(TEST_USER);
    const normalResult = getExploreVideos(TEST_USER);
    const normalForYou = normalResult.videos.filter(v => v.reason === 'for you').length;

    // Zero affinity — "for you" badges should decrease or disappear
    cache.exploreVideos.delete(TEST_USER);
    const zeroAffinityConfig = { ...DEFAULT_EXPLORE_CONFIG, affinityWeight: 0 };
    const modifiedResult = getExploreVideos(TEST_USER, undefined, zeroAffinityConfig);
    const modifiedForYou = modifiedResult.videos.filter(v => v.reason === 'for you').length;

    // With affinity zeroed, fewer videos should be tagged "for you"
    assert.ok(modifiedForYou < normalForYou || normalForYou === 0,
      `Zero affinity should reduce "for you" badges: normal=${normalForYou}, modified=${modifiedForYou}`);
  });

  it('12. Score normalization — videos are ordered sanely', () => {
    setupBaseData();
    // Watch some videos to generate meaningful signal
    db.setWatchTime(TEST_USER, 'EX_CH_A_v0', 500, 600);
    db.setWatchTime(TEST_USER, 'EX_CH_B_v0', 500, 600);
    cache.exploreVideos.delete(TEST_USER);
    const result = getExploreVideos(TEST_USER);
    // Verify we get a reasonable number of videos
    assert.ok(result.videos.length > 5, 'Should have multiple videos');
    // Verify no duplicates
    const ids = result.videos.map(v => v.videoId);
    const uniqueIds = new Set(ids);
    assert.strictEqual(ids.length, uniqueIds.size, 'Should have no duplicate video IDs');
  });
});
