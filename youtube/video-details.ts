/**
 * Video details — oEmbed fast fetch, yt-dlp full fetch, Innertube enrichment.
 */
import db from '../db.js';
import { cache, withYtSlot, VIDEO_DETAILS_TTL } from './shared.js';
import { getClientVersion } from '../extractors.js';

// Get video details via oEmbed (fast, ~100ms) — enough to render page instantly
async function getVideoDetails(videoId) {
  const cached = cache.videoDetails.get(videoId);
  if (cached && Date.now() < cached.expires) return cached.data;
  // Return stale enriched data rather than re-fetching incomplete oEmbed
  if (cached && cached.data.channelId) return cached.data;

  let title = '', channelTitle = '', channelId = '';

  // oEmbed — fast, gives title + channel name
  try {
    const oembedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&format=json`;
    const oembedCtrl = new AbortController();
    const oembedTimer = setTimeout(() => oembedCtrl.abort(), 5000);
    const res = await fetch(oembedUrl, { signal: oembedCtrl.signal, headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': '*', 'Referer': '', 'Cookie': '' } });
    if (res.ok) {
      const oembed = await res.json();
      clearTimeout(oembedTimer);
      title = oembed.title || '';
      channelTitle = oembed.author_name || '';
    } else {
      clearTimeout(oembedTimer);
    }
  } catch {}

  // Check DB for live status (persisted from previous extractions)
  const liveStatus = db.getLiveStatus(videoId) || undefined;

  const data = { videoId, title, description: '', channelTitle, channelId, publishedAt: '', viewCount: null, likeCount: null, liveStatus };
  // Short TTL — full details will overwrite when fetched
  cache.videoDetails.set(videoId, { data, expires: Date.now() + 5 * 60 * 1000 });
  return data;
}

// Populate video details cache from a yt-dlp info object (avoids a second yt-dlp call)
function cacheVideoDetailsFromInfo(videoId, info) {
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
    const existing = db.getChannel(channelId);
    if (!existing || !existing.title) {
      db.upsertChannel(channelId, channelTitle, existing?.thumbnail || '');
    }
  }

  const duration = info.duration || null;
  const liveStatus = info.live_status || (info.is_live ? 'is_live' : 'not_live');
  if (duration != null) db.setDuration(videoId, duration, liveStatus);
  else if (liveStatus !== 'not_live') db.setDuration(videoId, 0, liveStatus);
  const videoTags = info.tags || info.keywords || [];
  if (Array.isArray(videoTags) && videoTags.length > 0) {
    db.setVideoTags(videoId, videoTags.slice(0, 50));
  }
  if (description) {
    db.setVideoDescription(videoId, description.slice(0, 2000));
  }
  const data = { videoId, title, description, channelTitle, channelId, publishedAt, viewCount, likeCount, subscriberCount, duration, liveStatus };
  // Live streams get a short TTL — viewer count changes constantly
  const ttl = isLive ? 2 * 60 * 1000 : VIDEO_DETAILS_TTL;
  cache.videoDetails.set(videoId, { data, expires: Date.now() + ttl });
  return data;
}

// Enrich video details from Innertube next endpoint:
// - Like count (yt-dlp returns NA for some videos)
// - Description @handle -> channel ID mappings
async function enrichFromNext(videoData) {
  // Skip if already fully enriched
  if (videoData.likeCount != null && videoData.viewCount != null && videoData.publishedAt && videoData.descriptionLinks) return;
  return withYtSlot(() => _enrichFromNextInner(videoData));
}
async function _enrichFromNextInner(videoData) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    const resp = await fetch('https://www.youtube.com/youtubei/v1/next', {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
      body: JSON.stringify({
        videoId: videoData.videoId,
        context: { client: { clientName: 'WEB', clientVersion: getClientVersion(), hl: 'en' } },
      }),
    });
    if (!resp.ok) { clearTimeout(timer); return; }
    const data = await resp.json();
    clearTimeout(timer);
    const contents = data?.contents?.twoColumnWatchNextResults?.results?.results?.contents || [];
    for (const item of contents) {
      const primary = item.videoPrimaryInfoRenderer;
      if (primary) {
        // Like count
        if (videoData.likeCount == null) {
          const buttons = primary.videoActions?.menuRenderer?.topLevelButtons || [];
          for (const btn of buttons) {
            const likeTitle = btn.segmentedLikeDislikeButtonViewModel?.likeButtonViewModel?.likeButtonViewModel?.toggleButtonViewModel?.toggleButtonViewModel?.defaultButtonViewModel?.buttonViewModel?.title;
            if (likeTitle != null) {
              videoData.likeCount = String(likeTitle);
            }
          }
        }
        // View count
        if (videoData.viewCount == null) {
          const vc = primary.viewCount?.videoViewCountRenderer;
          if (vc?.viewCount?.simpleText) {
            videoData.viewCount = vc.viewCount.simpleText.replace(/[^\d]/g, '');
          }
        }
        // Published date
        if (!videoData.publishedAt) {
          const dateStr = primary.dateText?.simpleText;
          if (dateStr) {
            try { videoData.publishedAt = new Date(dateStr).toISOString(); } catch {}
          }
        }
      }
      // Description and @handle links from structured data
      const secInfo = item.videoSecondaryInfoRenderer;
      const desc = secInfo?.attributedDescription;
      if (desc) {
        const content = desc.content || '';
        // Fill description if missing (extraction failed)
        if (!videoData.description && content) {
          videoData.description = content.replace(/[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g, '');
        }
        // @handle -> channel ID links
        if (!videoData.descriptionLinks) {
          const links = [];
          for (const run of desc.commandRuns || []) {
            const browseId = run.onTap?.innertubeCommand?.browseEndpoint?.browseId;
            if (browseId && browseId.startsWith('UC')) {
              const text = content.slice(run.startIndex, run.startIndex + run.length);
              links.push({ text: text.trim().replace(/[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g, ''), channelId: browseId });
            }
          }
          videoData.descriptionLinks = links;
        }
      }
      // Fill channel info from owner if missing
      const owner = secInfo?.owner?.videoOwnerRenderer;
      if (owner) {
        if (!videoData.channelId) {
          videoData.channelId = owner.navigationEndpoint?.browseEndpoint?.browseId || '';
        }
        if (!videoData.channelTitle) {
          videoData.channelTitle = (owner.title?.runs || []).map(r => r.text).join('') || '';
        }
        if (videoData.subscriberCount == null) {
          const subText = owner.subscriberCountText?.simpleText || '';
          const subMatch = subText.match(/([\d.]+[KMB]?)/);
          if (subMatch) videoData.subscriberCount = subMatch[1];
        }
      }
    }
    // Extract related/suggested videos from sidebar
    const secondary = data?.contents?.twoColumnWatchNextResults?.secondaryResults?.secondaryResults?.results || [];
    const relatedVideos: Array<{ videoId: string; title: string; channelTitle: string; channelId: string; publishedText: string }> = [];
    for (const sItem of secondary) {
      const r = sItem.compactVideoRenderer;
      if (!r?.videoId) continue;
      const chId = r.longBylineText?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId || '';
      if (!chId) continue;
      relatedVideos.push({
        videoId: r.videoId,
        title: (r.title?.simpleText || (r.title?.runs || []).map((x: { text: string }) => x.text).join('')) || '',
        channelTitle: (r.longBylineText?.runs || []).map((x: { text: string }) => x.text).join('') || '',
        channelId: chId,
        publishedText: r.publishedTimeText?.simpleText || '',
      });
    }
    if (relatedVideos.length > 0) {
      void Promise.resolve(db.upsertRelatedVideos(videoData.videoId, relatedVideos.slice(0, 20)));
    }

    cache.videoDetails.set(videoData.videoId, { data: videoData, expires: Date.now() + VIDEO_DETAILS_TTL });
  } catch (err) {
    console.warn('[enrichFromNext] failed for', videoData.videoId, err.message);
  }
}

export { getVideoDetails, cacheVideoDetailsFromInfo, enrichFromNext };
