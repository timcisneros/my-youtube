/**
 * Channel info and video listing — Innertube browse API with RSS fallback.
 */
import db from '../db.js';
import { cache, withYtSlot, CHANNEL_TTL } from './shared.js';
import { fetchChannelRSS } from './rss.js';
import { getClientVersion } from '../extractors.js';

// Fetch channel avatar via Innertube browse API (lightweight JSON, ~15KB)
// Falls back to page scrape if the API fails.
async function fetchChannelThumbnail(channelId) {
  return withYtSlot(() => _fetchChannelThumbnailInner(channelId));
}
async function _fetchChannelThumbnailInner(channelId) {
  // Strategy 1: Innertube browse API — fast, reliable, returns structured JSON
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    const resp = await fetch('https://www.youtube.com/youtubei/v1/browse', {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0', 'Accept-Language': '*', Referer: '', Cookie: '' },
      body: JSON.stringify({
        browseId: channelId,
        context: { client: { clientName: 'WEB', clientVersion: getClientVersion(), hl: 'en' } },
      }),
    });
    if (resp.ok) {
      const data = await resp.json();
      clearTimeout(timer);
      const url = data?.metadata?.channelMetadataRenderer?.avatar?.thumbnails?.[0]?.url
        || data?.header?.pageHeaderRenderer?.content?.pageHeaderViewModel?.image?.decoratedAvatarViewModel?.avatar?.avatarViewModel?.image?.sources?.[0]?.url;
      if (url) return url;
    } else {
      clearTimeout(timer);
    }
  } catch {}

  // Strategy 2: Page scrape fallback — matches both yt3.googleusercontent.com and yt3.ggpht.com
  try {
    const res = await fetch(`https://www.youtube.com/channel/${channelId}`, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': '*', Referer: '', Cookie: '' }
    });
    if (!res.ok) return '';
    const html = await res.text();
    const match = html.match(/https:\/\/yt[0-9]*\.(googleusercontent|ggpht)\.com\/[^"\\]+/);
    return match ? match[0] : '';
  } catch {
    return '';
  }
}

// Get channel info — memory cache -> DB channels -> DB subscriptions -> RSS -> scrape
async function getChannelInfo(channelId) {
  const cached = cache.channelInfo.get(channelId);
  if (cached && Date.now() < cached.expires && cached.data.thumbnail) return cached.data;

  // Try DB channels table
  let ch = db.getChannel(channelId);
  if (ch && ch.title && ch.thumbnail) {
    cache.channelInfo.set(channelId, { data: ch, expires: Date.now() + CHANNEL_TTL });
    return ch;
  }

  // Try DB subscriptions table
  const sub = db.getSubByChannel(channelId);
  if (sub && sub.title && sub.thumbnail) {
    const data = { channelId, title: sub.title, thumbnail: sub.thumbnail };
    db.upsertChannel(channelId, data.title, data.thumbnail);
    cache.channelInfo.set(channelId, { data, expires: Date.now() + CHANNEL_TTL });
    return data;
  }

  // Fetch title and thumbnail in parallel
  const needsTitle = !(ch && ch.title) && !(sub && sub.title);
  const needsThumb = !(ch && ch.thumbnail) && !(sub && sub.thumbnail);
  const [fetchedTitle, fetchedThumb] = await Promise.all([
    needsTitle ? fetchChannelRSS(channelId).then(r => r.channelTitle).catch(() => '') : '',
    needsThumb ? fetchChannelThumbnail(channelId) : '',
  ]);
  const title = (ch && ch.title) || (sub && sub.title) || fetchedTitle || 'Unknown Channel';
  const thumbnail = (ch && ch.thumbnail) || (sub && sub.thumbnail) || fetchedThumb;
  const data = { channelId, title, thumbnail };
  db.upsertChannel(channelId, title, thumbnail);
  cache.channelInfo.set(channelId, { data, expires: Date.now() + CHANNEL_TTL });
  return data;
}

// Innertube browse params for each channel tab
const CHANNEL_TAB_PARAMS = {
  videos: 'EgZ2aWRlb3PyBgQKAjoA',
  shorts: 'EgZzaG9ydHPyBgUKA5oBAA%3D%3D',
  live: 'EgdzdHJlYW1z8gYECgJ6AA%3D%3D',
  playlists: 'EglwbGF5bGlzdHPyBgQKAkIA',
};

// Parse video items from Innertube browse response
function _parseChannelVideos(contents) {
  const items = [];
  let nextPageToken = null;
  for (const item of contents) {
    // Regular videos and live streams
    const vid = item.richItemRenderer?.content?.videoRenderer;
    if (vid) {
      items.push({
        videoId: vid.videoId,
        title: (vid.title?.runs || []).map(r => r.text).join('') || '',
        thumbnail: `https://i.ytimg.com/vi/${vid.videoId}/mqdefault.jpg`,
        publishedAt: vid.publishedTimeText?.simpleText || '',
      });
    }
    // Shorts
    const short = item.richItemRenderer?.content?.shortsLockupViewModel;
    if (short) {
      const shortId = (short.entityId || '').replace('shorts-shelf-item-', '');
      if (shortId) {
        items.push({
          videoId: shortId,
          title: short.overlayMetadata?.primaryText?.content || '',
          thumbnail: `https://i.ytimg.com/vi/${shortId}/mqdefault.jpg`,
          publishedAt: '',
        });
      }
    }
    if (item.continuationItemRenderer) {
      nextPageToken = item.continuationItemRenderer.continuationEndpoint?.continuationCommand?.token || null;
    }
  }
  return { items, nextPageToken };
}

// Get channel videos — Innertube browse API with pagination, RSS fallback for first page
async function getChannelVideos(channelId, pageToken, tab) {
  try {
    const tabParams = CHANNEL_TAB_PARAMS[tab || 'videos'] || CHANNEL_TAB_PARAMS.videos;
    const body = pageToken
      ? { continuation: pageToken, context: { client: { clientName: 'WEB', clientVersion: getClientVersion(), hl: 'en' } } }
      : { browseId: channelId, params: tabParams, context: { client: { clientName: 'WEB', clientVersion: getClientVersion(), hl: 'en' } } };

    const resp = await withYtSlot(async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      try {
        return await fetch('https://www.youtube.com/youtubei/v1/browse', {
          method: 'POST',
          signal: controller.signal,
          headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0', 'Accept-Language': '*', Referer: '', Cookie: '' },
          body: JSON.stringify(body),
        });
      } finally {
        clearTimeout(timer);
      }
    });

    if (resp.ok) {
      const data = await resp.json();
      let contents = [];
      let availableTabs = [];
      if (pageToken) {
        // Continuation response
        for (const action of data?.onResponseReceivedActions || []) {
          contents.push(...(action.appendContinuationItemsAction?.continuationItems || []));
        }
      } else {
        // First page — extract available tabs and find content
        const allTabs = data?.contents?.twoColumnBrowseResultsRenderer?.tabs || [];
        availableTabs = allTabs
          .map(t => t.tabRenderer?.title?.toLowerCase())
          .filter(Boolean);
        // Only use content from the actually selected tab
        for (const t of allTabs) {
          if (!t.tabRenderer?.selected) continue;
          const selectedTitle = (t.tabRenderer.title || '').toLowerCase();
          const requestedTab = tab || 'videos';
          // YouTube falls back to Home when a tab doesn't exist — reject that
          if (selectedTitle !== requestedTab && selectedTitle === 'home') break;
          const grid = t.tabRenderer.content?.richGridRenderer;
          if (grid) { contents = grid.contents || []; }
          break;
        }
      }
      const vanity = data?.metadata?.channelMetadataRenderer?.vanityChannelUrl;
      const handle = vanity ? vanity.split('/').pop() : null;
      const result = _parseChannelVideos(contents);
      if (result.items.length > 0) return { items: result.items, nextPageToken: result.nextPageToken, prevPageToken: null, availableTabs, handle };
    }
  } catch (err) {
    console.warn(`[channel] Innertube browse failed for ${channelId}:`, err.message);
  }

  // Fallback: RSS (first page only, no pagination)
  if (!pageToken) {
    try {
      const rss = await fetchChannelRSS(channelId);
      if (rss.items.length > 0) {
        const items = rss.items.map(entry => ({
          videoId: entry.videoId,
          title: entry.title,
          thumbnail: `https://i.ytimg.com/vi/${entry.videoId}/mqdefault.jpg`,
          publishedAt: entry.publishedAt
        }));
        return { items, nextPageToken: null, prevPageToken: null, availableTabs: [] };
      }
    } catch {}
  }

  return { items: [], nextPageToken: null, prevPageToken: null, availableTabs: [] };
}

export { getChannelInfo, getChannelVideos };
