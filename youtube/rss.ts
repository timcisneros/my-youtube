/**
 * RSS feed fetching for YouTube channels.
 */
import { XMLParser } from 'fast-xml-parser';
import db from '../db.js';
import { cache, withYtSlot, RSS_TTL } from './shared.js';

const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

// Fetch a channel's recent videos via RSS feed (zero API quota cost)
// Cache hierarchy: in-memory -> SQLite -> YouTube RSS fetch
async function fetchChannelRSS(channelId) {
  const cached = cache.rss.get(channelId);
  if (cached && Date.now() < cached.expires) return cached.data;

  const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
  const res = await withYtSlot(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      return await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': '*', 'Referer': '', 'Cookie': '' } });
    } finally {
      clearTimeout(timer);
    }
  });
  if (!res.ok) {
    // On rate-limit/error, serve stale in-memory cache first
    if (cached) return cached.data;
    // Fall back to SQLite persistent cache
    const dbCached = db.getRssCache(channelId);
    if (dbCached) {
      cache.rss.set(channelId, { data: dbCached.data, expires: Date.now() + 60000 });
      return dbCached.data;
    }
    return { items: [], channelTitle: '' };
  }
  const xml = await res.text();
  const parsed = xmlParser.parse(xml);
  const channelTitle = parsed?.feed?.author?.name || '';
  const entries = parsed?.feed?.entry;
  if (!entries) {
    const data = { items: [], channelTitle };
    cache.rss.set(channelId, { data, expires: Date.now() + RSS_TTL });
    db.setRssCache(channelId, data);
    return data;
  }
  const items = Array.isArray(entries) ? entries : [entries];
  const data = {
    items: items.map(entry => {
      const pub = entry.published || '';
      const upd = entry.updated || '';
      return {
        videoId: (entry['yt:videoId'] || '').toString(),
        title: entry.title || '',
        publishedAt: pub || upd,
        channelId
      };
    }),
    channelTitle
  };
  cache.rss.set(channelId, { data, expires: Date.now() + RSS_TTL });
  db.setRssCache(channelId, data);
  return data;
}

export { fetchChannelRSS };
