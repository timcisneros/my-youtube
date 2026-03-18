/**
 * Today's videos — aggregates recent videos from all subscribed channels.
 */
import db from '../db.js';
import { cache, LRUMap, TODAY_TTL } from './shared.js';
import { fetchChannelRSS } from './rss.js';
import { getAllSubscriptions } from './subscriptions.js';

// Build today's video list from SQLite-cached RSS data (instant, no network)
function _buildTodayFromSqlite(userId) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayISO = today.toISOString();

  const rows = db.getAllRssCacheForUser(userId);
  const videos = [];
  for (const row of rows) {
    try {
      const rssData = JSON.parse(row.data);
      for (const item of rssData.items || []) {
        if (item.publishedAt >= todayISO) {
          videos.push({
            videoId: item.videoId,
            title: item.title,
            thumbnail: `https://i.ytimg.com/vi/${item.videoId}/mqdefault.jpg`,
            channelTitle: row.sub_title || rssData.channelTitle || '',
            channelId: item.channelId || row.channel_id,
            publishedAt: item.publishedAt
          });
        }
      }
    } catch {}
  }
  videos.sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());
  return videos;
}

const _refreshInflight = new LRUMap(50);
async function _refreshTodayVideos(userId) {
  if (_refreshInflight.has(userId)) return _refreshInflight.get(userId);
  const promise = _refreshTodayVideosInner(userId);
  _refreshInflight.set(userId, promise);
  void promise.finally(() => _refreshInflight.delete(userId));
  return promise;
}
async function _refreshTodayVideosInner(userId) {
  const subs = await getAllSubscriptions(userId);
  if (subs.length === 0) return [];

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayISO = today.toISOString();

  // Fetch RSS concurrently — YouTube RSS feeds handle parallel requests well
  const CONCURRENCY = 15;
  const BATCH_DELAY = 50;
  const results = [];
  for (let i = 0; i < subs.length; i += CONCURRENCY) {
    if (i > 0) await new Promise(r => setTimeout(r, BATCH_DELAY));
    const batch = subs.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(batch.map(async (sub) => {
      try {
        const rss = await fetchChannelRSS(sub.channelId);
        return rss.items
          .filter(e => e.publishedAt >= todayISO)
          .map(e => ({ ...e, channelTitle: sub.title }));
      } catch (err) {
        console.warn(`[RSS] failed for ${sub.channelId} (${sub.title}):`, err.message);
        return [];
      }
    }));
    results.push(...batchResults);
  }

  const videos = [];
  for (const entries of results) {
    for (const entry of entries) {
      videos.push({
        videoId: entry.videoId,
        title: entry.title,
        thumbnail: `https://i.ytimg.com/vi/${entry.videoId}/mqdefault.jpg`,
        channelTitle: entry.channelTitle,
        channelId: entry.channelId,
        publishedAt: entry.publishedAt
      });
    }
  }

  // Merge in any SQLite-cached videos that RSS refresh missed (rate-limited channels)
  const seen = new Set(videos.map(v => v.videoId));
  const fromDb = _buildTodayFromSqlite(userId);
  for (const v of fromDb) {
    if (!seen.has(v.videoId)) { videos.push(v); seen.add(v.videoId); }
  }

  videos.sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());
  cache.todayVideos.set(userId, { data: videos, expires: Date.now() + TODAY_TTL });
  return videos;
}

// Today's videos using RSS (no API quota)
async function getTodayVideos(userId) {
  const cached = cache.todayVideos.get(userId);
  if (cached && Date.now() < cached.expires) return cached.data;
  if (cached) {
    _refreshTodayVideos(userId).catch(err =>
      console.error('Background refresh failed:', err.message)
    );
    return cached.data;
  }
  // No in-memory cache at all — try to build instantly from SQLite RSS cache
  const fromDb = _buildTodayFromSqlite(userId);
  if (fromDb.length > 0) {
    cache.todayVideos.set(userId, { data: fromDb, expires: 0 }); // stale so next request triggers refresh
    _refreshTodayVideos(userId).catch(err =>
      console.error('Background refresh failed:', err.message)
    );
    return fromDb;
  }
  return _refreshTodayVideos(userId);
}

export { getTodayVideos };
