/**
 * Channel info and video listing — Innertube browse API with RSS fallback.
 */
import db from '../db.js';
import { createHash } from 'node:crypto';
import { cache, withYtSlot, CHANNEL_TTL, CHANNEL_HANDLE_TTL, CHANNEL_VIDEOS_TTL } from './shared.js';
import { fetchChannelRSS } from './rss.js';
import { getClientVersion } from '../extractors.js';
import { fetchWithBodyTimeout, readJsonBounded, readTextBounded } from '../lib/bounded-fetch.js';
import { runBoundedSingleFlight } from '../lib/bounded-singleflight.js';
import { parseChannelBrowseMetadata } from './channel-metadata.js';

const CHANNEL_NEGATIVE_TTL = 5 * 60 * 1000;
const CHANNEL_CONTINUATION_TTL = 60 * 1000;
const channelInfoInflight = new Map<string, Promise<{
  channelId: string;
  title: string;
  thumbnail: string;
}>>();
const channelInfoSingleFlight = { name: 'channel_info', maxEntries: 300 } as const;
const channelHandleInflight = new Map<string, Promise<string | null>>();
const channelHandleSingleFlight = { name: 'channel_handle', maxEntries: 300 } as const;

function publishBrowseChannelInfo(channelInfo) {
  if (!channelInfo?.title || !channelInfo?.thumbnail) return;
  cache.channelInfo.set(channelInfo.channelId, {
    data: channelInfo,
    expires: Date.now() + CHANNEL_TTL,
  });
  void Promise.resolve(db.upsertChannel(
    channelInfo.channelId,
    channelInfo.title,
    channelInfo.thumbnail,
  )).catch(() => {});
}

// Fetch channel avatar via Innertube browse API (lightweight JSON, ~15KB)
// Falls back to page scrape if the API fails.
async function fetchChannelThumbnail(channelId) {
  return withYtSlot(() => _fetchChannelThumbnailInner(channelId));
}
async function _fetchChannelThumbnailInner(channelId) {
  // Strategy 1: Innertube browse API — fast, reliable, returns structured JSON
  try {
    const resp = await fetchWithBodyTimeout('https://www.youtube.com/youtubei/v1/browse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0', 'Accept-Language': '*', Referer: '', Cookie: '' },
      body: JSON.stringify({
        browseId: channelId,
        context: { client: { clientName: 'WEB', clientVersion: getClientVersion(), hl: 'en' } },
      }),
    }, { headerTimeoutMs: 6000, bodyIdleMs: 6000 });
    if (resp.ok) {
      const data = await readJsonBounded(resp, 512 * 1024, 'channel-thumbnail-response-too-large');
      const url = data?.metadata?.channelMetadataRenderer?.avatar?.thumbnails?.[0]?.url
        || data?.header?.pageHeaderRenderer?.content?.pageHeaderViewModel?.image?.decoratedAvatarViewModel?.avatar?.avatarViewModel?.image?.sources?.[0]?.url;
      if (url) return url;
    } else await resp.body?.cancel().catch(() => {});
  } catch {}

  // Strategy 2: Page scrape fallback — matches both yt3.googleusercontent.com and yt3.ggpht.com
  try {
    const res = await fetchWithBodyTimeout(`https://www.youtube.com/channel/${channelId}`, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': '*', Referer: '', Cookie: '' }
    }, { headerTimeoutMs: 8000, bodyIdleMs: 8000 });
    if (!res.ok) return '';
    const html = await readTextBounded(res, 4 * 1024 * 1024, 'channel-page-response-too-large');
    const match = html.match(/https:\/\/yt[0-9]*\.(googleusercontent|ggpht)\.com\/[^"\\]+/);
    return match ? match[0] : '';
  } catch {
    return '';
  }
}

// Get channel info — memory cache -> DB channels -> DB subscriptions -> RSS -> scrape
async function _getChannelInfo(channelId) {
  // Try DB channels table
  const [storedChannel, sub] = await Promise.all([
    db.getChannel(channelId),
    db.getSubByChannel(channelId),
  ]);
  const ch = storedChannel;
  if (ch && ch.title && ch.thumbnail) {
    cache.channelInfo.set(channelId, { data: ch, expires: Date.now() + CHANNEL_TTL });
    return ch;
  }

  // Try DB subscriptions table
  if (sub && sub.title && sub.thumbnail) {
    const data = { channelId, title: sub.title, thumbnail: sub.thumbnail };
    await db.upsertChannel(channelId, data.title, data.thumbnail);
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
  await db.upsertChannel(channelId, title, thumbnail);
  const ttl = thumbnail && title !== 'Unknown Channel' ? CHANNEL_TTL : CHANNEL_NEGATIVE_TTL;
  cache.channelInfo.set(channelId, { data, expires: Date.now() + ttl });
  return data;
}

async function getChannelInfo(channelId) {
  const cached = await cache.channelInfo.getAsync(channelId);
  if (cached && Date.now() < cached.expires) return cached.data;
  return runBoundedSingleFlight(channelInfoInflight, channelId, () => _getChannelInfo(channelId), channelInfoSingleFlight);
}

async function resolveChannelHandle(rawHandle: string) {
  const handle = rawHandle.normalize('NFKC');
  if (!/^@[\p{L}\p{N}._-]{1,50}$/u.test(handle)) return null;
  const cacheKey = handle.toLocaleLowerCase('en-US');
  const cached = await cache.channelHandles.getAsync(cacheKey);
  if (cached && Date.now() < cached.expires) return cached.data.channelId || null;

  return runBoundedSingleFlight(channelHandleInflight, cacheKey, async () => {
    let channelId: string | null = null;
    try {
      const resp = await withYtSlot(() => fetchWithBodyTimeout(
        'https://www.youtube.com/youtubei/v1/navigation/resolve_url',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
          body: JSON.stringify({
            url: `https://www.youtube.com/${handle}`,
            context: { client: { clientName: 'WEB', clientVersion: getClientVersion(), hl: 'en' } },
          }),
        },
        { headerTimeoutMs: 8000, bodyIdleMs: 8000 },
      ));
      if (resp.ok) {
        const data = await readJsonBounded(resp, 512 * 1024, 'channel-resolve-response-too-large');
        const resolved = data?.endpoint?.browseEndpoint?.browseId;
        if (typeof resolved === 'string' && /^UC[A-Za-z0-9_-]{20,30}$/.test(resolved)) channelId = resolved;
      } else {
        await resp.body?.cancel().catch(() => {});
      }
    } catch {
      channelId = null;
    }
    cache.channelHandles.set(cacheKey, {
      data: { channelId },
      expires: Date.now() + (channelId ? CHANNEL_HANDLE_TTL : CHANNEL_NEGATIVE_TTL),
    });
    return channelId;
  }, channelHandleSingleFlight);
}

// Innertube browse params for each channel tab
const CHANNEL_TAB_PARAMS = {
  videos: 'EgZ2aWRlb3PyBgQKAjoA',
  shorts: 'EgZzaG9ydHPyBgUKA5oBAA%3D%3D',
  live: 'EgdzdHJlYW1z8gYECgJ6AA%3D%3D',
  playlists: 'EglwbGF5bGlzdHPyBgQKAkIA',
};
const channelVideosInflight = new Map<string, Promise<unknown>>();
const channelVideosSingleFlight = { name: 'channel_videos', maxEntries: 300 } as const;

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
async function _getChannelVideos(channelId, pageToken, tab) {
  let firstPageChannelInfo = null;
  try {
    const tabParams = CHANNEL_TAB_PARAMS[tab || 'videos'] || CHANNEL_TAB_PARAMS.videos;
    const body = pageToken
      ? { continuation: pageToken, context: { client: { clientName: 'WEB', clientVersion: getClientVersion(), hl: 'en' } } }
      : { browseId: channelId, params: tabParams, context: { client: { clientName: 'WEB', clientVersion: getClientVersion(), hl: 'en' } } };

    const data = await withYtSlot(async () => {
      const resp = await fetchWithBodyTimeout('https://www.youtube.com/youtubei/v1/browse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0', 'Accept-Language': '*', Referer: '', Cookie: '' },
        body: JSON.stringify(body),
      }, { headerTimeoutMs: 10_000, bodyIdleMs: 10_000 });
      if (!resp.ok) {
        await resp.body?.cancel().catch(() => {});
        throw new Error(`YouTube channel browse returned ${resp.status}`);
      }
      return readJsonBounded(resp, 4 * 1024 * 1024, 'channel-browse-response-too-large');
    });

    if (data) {
      let contents = [];
      let availableTabs = [];
      if (pageToken) {
        // Continuation response
        for (const action of data?.onResponseReceivedActions || []) {
          contents.push(...(action.appendContinuationItemsAction?.continuationItems || []));
        }
      } else {
        firstPageChannelInfo = parseChannelBrowseMetadata(data, channelId);
        publishBrowseChannelInfo(firstPageChannelInfo);
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
      if (result.items.length > 0) return {
        items: result.items,
        nextPageToken: result.nextPageToken,
        prevPageToken: null,
        availableTabs,
        handle,
        channelInfo: firstPageChannelInfo,
      };
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
        return {
          items,
          nextPageToken: null,
          prevPageToken: null,
          availableTabs: [],
          channelInfo: firstPageChannelInfo,
        };
      }
    } catch {}
  }

  return {
    items: [],
    nextPageToken: null,
    prevPageToken: null,
    availableTabs: [],
    channelInfo: firstPageChannelInfo,
  };
}

async function getChannelVideos(channelId, pageToken, tab) {
  const activeTab = tab || 'videos';
  const pageKey = pageToken
    ? createHash('sha256').update(pageToken).digest('base64url').slice(0, 22)
    : 'first';
  const cacheKey = `${channelId}:${activeTab}:${pageKey}`;
  const cached = await cache.channelVideos.getAsync(cacheKey);
  if (cached && Date.now() < cached.expires) return cached.data;

  return runBoundedSingleFlight(channelVideosInflight, cacheKey, async () => {
    const request = _getChannelVideos(channelId, pageToken, activeTab);
    const result = await request;
    cache.channelVideos.set(cacheKey, {
      data: result,
      expires: Date.now() + (pageToken ? CHANNEL_CONTINUATION_TTL : CHANNEL_VIDEOS_TTL),
    });
    return result;
  }, channelVideosSingleFlight);
}

export { getChannelInfo, getChannelVideos, parseChannelBrowseMetadata, resolveChannelHandle };
