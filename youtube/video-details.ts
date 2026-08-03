/**
 * Video details — oEmbed fast fetch, yt-dlp full fetch, Innertube enrichment.
 */
import db from '../db.js';
import { cache, withYtSlot, VIDEO_DETAILS_TTL } from './shared.js';
import { readJsonBounded } from '../lib/bounded-fetch.js';
import { runBoundedSingleFlight } from '../lib/bounded-singleflight.js';
import { getWatchNextSnapshot } from './watch-next.js';

const inFlightVideoDetails = new Map<string, ReturnType<typeof fetchInitialVideoDetails>>();
const inFlightEnrichment = new Map<string, Promise<unknown>>();
const videoDetailsSingleFlight = { name: 'video_details', maxEntries: 500 } as const;
const videoEnrichmentSingleFlight = { name: 'video_enrichment', maxEntries: 300 } as const;
const VIDEO_ENRICHMENT_RETRY_MS = Math.max(60_000,
  Number(process.env.VIDEO_ENRICHMENT_RETRY_MS) || 5 * 60_000);
const LIVE_VIDEO_DETAILS_TTL_MS = Math.max(30_000,
  Number(process.env.LIVE_VIDEO_DETAILS_TTL_MS) || 2 * 60_000);

// Get video details via oEmbed (fast, ~100ms) — enough to render page instantly
async function getVideoDetails(videoId) {
  const cached = await cache.videoDetails.getAsync(videoId);
  if (cached && Date.now() < cached.expires) return cached.data;
  // Return stale enriched data rather than re-fetching incomplete oEmbed
  if (cached && cached.data.channelId) return cached.data;
  return runBoundedSingleFlight(
    inFlightVideoDetails,
    videoId,
    () => fetchInitialVideoDetails(videoId),
    videoDetailsSingleFlight,
  );
}

// Cache-only lookup for the critical player document. A cold miss must not
// start optional oEmbed traffic alongside the playback extraction.
async function getCachedVideoDetails(videoId) {
  const cached = await cache.videoDetails.getAsync(videoId);
  return cached?.data || null;
}

async function fetchInitialVideoDetails(videoId) {
  let title = '', channelTitle = '', channelId = '';

  // oEmbed — fast, gives title + channel name
  try {
    const oembedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&format=json`;
    const oembed = await withYtSlot(async () => {
      const oembedCtrl = new AbortController();
      // Start the optional metadata deadline after admission; queue time is
      // bounded separately and must not consume the network response budget.
      const oembedTimer = setTimeout(() => oembedCtrl.abort(), 750);
      try {
        const response = await fetch(oembedUrl, { signal: oembedCtrl.signal, headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': '*', 'Referer': '', 'Cookie': '' } });
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          return null;
        }
        return await readJsonBounded(response, 256 * 1024, 'oembed-response-too-large');
      } finally {
        clearTimeout(oembedTimer);
      }
    });
    if (oembed) {
      title = oembed.title || '';
      channelTitle = oembed.author_name || '';
    }
  } catch {
    // Metadata is optional on the playback path.
  }

  // Check DB for live status (persisted from previous extractions)
  const liveStatus = await db.getLiveStatus(videoId) || undefined;

  const data = { videoId, title, description: '', channelTitle, channelId, publishedAt: '', viewCount: null, likeCount: null, liveStatus };
  // Short TTL — full details will overwrite when fetched
  await cache.videoDetails.setAsync(videoId, { data, expires: Date.now() + 5 * 60 * 1000 });
  return data;
}

// Populate video details cache from a yt-dlp info object (avoids a second yt-dlp call)
async function cacheVideoDetailsFromInfo(videoId, info) {
  const cached = cache.videoDetails.get(videoId);
  const title = (cached?.data?.title) || info.title || '';
  const channelTitle = (cached?.data?.channelTitle) || info.uploader || '';
  const channelId = info.channel_id || '';
  const description = info.description || '';
  const isLive = info.live_status === 'is_live' || info.is_live;
  // For live streams, use release_timestamp (stream start) over timestamp (upload)
  const ts = isLive && info.release_timestamp ? info.release_timestamp : info.timestamp;
  const publishedAt = ts
    ? new Date(ts * 1000).toISOString()
    : info.upload_date
      ? `${info.upload_date.slice(0, 4)}-${info.upload_date.slice(4, 6)}-${info.upload_date.slice(6, 8)}`
      : '';
  // For live streams, use concurrent_view_count (current viewers) over view_count (total lifetime)
  const viewCount = isLive && info.concurrent_view_count != null
    ? String(info.concurrent_view_count)
    : info.view_count != null ? String(info.view_count) : null;
  const likeCount = info.like_count != null ? String(info.like_count) : null;
  const subscriberCount = info.channel_follower_count != null ? String(info.channel_follower_count) : null;

  // Save channel info to DB so the channel page can find it later
  if (channelId && channelTitle) {
    const existing = await db.getChannel(channelId);
    if (!existing || !existing.title) {
      await db.upsertChannel(channelId, channelTitle, existing?.thumbnail || '');
    }
  }

  const duration = info.duration || null;
  const liveStatus = info.live_status || (info.is_live ? 'is_live' : 'not_live');
  if (duration != null) void Promise.resolve(db.setDuration(videoId, duration, liveStatus)).catch(() => {});
  else if (liveStatus !== 'not_live') void Promise.resolve(db.setDuration(videoId, 0, liveStatus)).catch(() => {});
  const videoTags = info.tags || info.keywords || [];
  if (Array.isArray(videoTags) && videoTags.length > 0) {
    void Promise.resolve(db.setVideoTags(videoId, videoTags.slice(0, 50))).catch(() => {});
  }
  if (description) {
    void Promise.resolve(db.setVideoDescription(videoId, description.slice(0, 2000))).catch(() => {});
  }
  const data = { videoId, title, description, channelTitle, channelId, publishedAt, viewCount, likeCount, subscriberCount, duration, liveStatus };
  // Live streams get a short TTL — viewer count changes constantly
  const ttl = isLive ? LIVE_VIDEO_DETAILS_TTL_MS : VIDEO_DETAILS_TTL;
  await cache.videoDetails.setAsync(videoId, { data, expires: Date.now() + ttl });
  return data;
}

function shouldEnrichVideoDetails(videoData, now = Date.now()) {
  if (videoData.detailsComplete === true) return false;
  if (videoData.likeCount != null && videoData.viewCount != null && videoData.publishedAt && videoData.descriptionLinks) return false;
  const attemptedAt = Number(videoData.enrichmentAttemptedAt) || 0;
  return attemptedAt === 0 || now - attemptedAt >= VIDEO_ENRICHMENT_RETRY_MS;
}

// Enrich video details from Innertube next endpoint:
// - Like count (yt-dlp returns NA for some videos)
// - Description @handle -> channel ID mappings
async function enrichFromNext(videoData) {
  if (!shouldEnrichVideoDetails(videoData)) return;
  const active = inFlightEnrichment.get(videoData.videoId);
  if (active !== undefined) {
    const enriched = await active;
    if (enriched !== undefined && enriched !== null && typeof enriched === 'object' && enriched !== videoData) {
      Object.assign(videoData, enriched);
    }
    return enriched;
  }
  return runBoundedSingleFlight(inFlightEnrichment, videoData.videoId, async () => {
    const completed = await _enrichFromNextInner(videoData);
    const now = Date.now();
    videoData.enrichmentAttemptedAt = now;
    if (completed) videoData.detailsComplete = true;
    const isLive = videoData.liveStatus === 'is_live' || videoData.liveStatus === 'is_upcoming';
    const existing = cache.videoDetails.get(videoData.videoId);
    const expires = completed
      ? now + (isLive ? LIVE_VIDEO_DETAILS_TTL_MS : VIDEO_DETAILS_TTL)
      : Math.max(Number(existing?.expires) || 0, now + VIDEO_ENRICHMENT_RETRY_MS);
    await cache.videoDetails.setAsync(videoData.videoId, { data: videoData, expires });
    return videoData;
  }, videoEnrichmentSingleFlight);
}
async function _enrichFromNextInner(videoData) {
  try {
    const snapshot = await getWatchNextSnapshot(videoData.videoId);
    if (!videoData.title) videoData.title = snapshot.title;
    if (videoData.likeCount == null) videoData.likeCount = snapshot.likeCount;
    if (videoData.viewCount == null) videoData.viewCount = snapshot.viewCount;
    if (!videoData.publishedAt) videoData.publishedAt = snapshot.publishedAt;
    if (!videoData.description && snapshot.description) videoData.description = snapshot.description;
    if (!videoData.descriptionLinks) videoData.descriptionLinks = snapshot.descriptionLinks.map(link => ({ ...link }));
    if (!videoData.channelId) videoData.channelId = snapshot.channelId;
    if (!videoData.channelTitle) videoData.channelTitle = snapshot.channelTitle;
    if (videoData.subscriberCount == null) videoData.subscriberCount = snapshot.subscriberCount;
    if (snapshot.relatedVideos.length > 0) {
      void Promise.resolve(db.upsertRelatedVideos(videoData.videoId, snapshot.relatedVideos)).catch(() => {});
    }
    return snapshot.detailsFound;
  } catch (err) {
    console.warn('[enrichFromNext] failed for', videoData.videoId, err.message);
    return false;
  }
}

export { getVideoDetails, getCachedVideoDetails, cacheVideoDetailsFromInfo, enrichFromNext, shouldEnrichVideoDetails };
