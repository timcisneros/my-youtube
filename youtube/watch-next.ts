import { getClientVersion } from '../extractors.js';
import { fetchWithBodyTimeout, readJsonBounded } from '../lib/bounded-fetch.js';
import { runBoundedSingleFlight } from '../lib/bounded-singleflight.js';
import { acquireLock, hasCacheRedis, hasRedis, releaseLock, renewLock } from '../lib/cache.js';
import { incrementMetric, observeMetric } from '../lib/performance-metrics.js';
import { cache, withYtSlot } from './shared.js';

type DescriptionLink = { text: string; channelId: string };
type RelatedVideo = {
  videoId: string;
  title: string;
  channelTitle: string;
  channelId: string;
  publishedText: string;
};

interface WatchNextSnapshot {
  detailsFound: boolean;
  title: string;
  likeCount: string | null;
  viewCount: string | null;
  publishedAt: string;
  description: string;
  descriptionLinks: DescriptionLink[];
  channelId: string;
  channelTitle: string;
  subscriberCount: string | null;
  relatedVideos: RelatedVideo[];
  commentContinuation: string | null;
}

const WATCH_NEXT_URL = 'https://www.youtube.com/youtubei/v1/next';
const WATCH_NEXT_TTL_MS = Math.max(30_000, Number(process.env.WATCH_NEXT_TTL_MS) || 60_000);
const WATCH_NEXT_LOCK_LEASE_MS = 30_000;
const WATCH_NEXT_LOCK_WAIT_MS = 20_000;
const watchNextInflight = new Map<string, Promise<WatchNextSnapshot>>();
const watchNextSingleFlight = { name: 'watch_next', maxEntries: 300 } as const;

function cleanText(value: string) {
  return value.replace(/[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g, '');
}

function textFromRuns(value) {
  return (value?.runs || []).map((run) => run.text || '').join('') || value?.simpleText || '';
}

function initialCommentContinuation(data): string | null {
  const contents = data?.contents?.twoColumnWatchNextResults?.results?.results?.contents || [];
  for (const commentsOnly of [true, false]) {
    for (const item of contents) {
      const section = item.itemSectionRenderer;
      if (!section) continue;
      const id = section.sectionIdentifier || section.targetId || '';
      if (commentsOnly && !id.includes('comment')) continue;
      for (const sub of section.contents || []) {
        const token = sub.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token;
        if (token) return token;
      }
    }
  }

  for (const panel of data?.engagementPanels || []) {
    const section = panel.engagementPanelSectionListRenderer;
    if (!String(section?.panelIdentifier || '').includes('comment')) continue;
    const token = section.content?.sectionListRenderer?.contents?.[0]
      ?.itemSectionRenderer?.contents?.[0]?.continuationItemRenderer
      ?.continuationEndpoint?.continuationCommand?.token;
    if (token) return token;
  }
  return null;
}

function parseWatchNextSnapshot(data): WatchNextSnapshot {
  const snapshot: WatchNextSnapshot = {
    detailsFound: false,
    title: '',
    likeCount: null,
    viewCount: null,
    publishedAt: '',
    description: '',
    descriptionLinks: [],
    channelId: '',
    channelTitle: '',
    subscriberCount: null,
    relatedVideos: [],
    commentContinuation: initialCommentContinuation(data),
  };
  const contents = data?.contents?.twoColumnWatchNextResults?.results?.results?.contents || [];
  for (const item of contents) {
    const primary = item.videoPrimaryInfoRenderer;
    if (primary) {
      snapshot.detailsFound = true;
      snapshot.title ||= textFromRuns(primary.title);
      const buttons = primary.videoActions?.menuRenderer?.topLevelButtons || [];
      for (const button of buttons) {
        const likeTitle = button.segmentedLikeDislikeButtonViewModel?.likeButtonViewModel
          ?.likeButtonViewModel?.toggleButtonViewModel?.toggleButtonViewModel
          ?.defaultButtonViewModel?.buttonViewModel?.title;
        if (likeTitle != null) {
          snapshot.likeCount = String(likeTitle);
          break;
        }
      }
      const viewText = primary.viewCount?.videoViewCountRenderer?.viewCount?.simpleText || '';
      if (viewText) snapshot.viewCount = viewText.replace(/[^\d]/g, '');
      const dateText = primary.dateText?.simpleText || '';
      if (dateText) {
        const published = new Date(dateText);
        if (!Number.isNaN(published.getTime())) snapshot.publishedAt = published.toISOString();
      }
    }

    const secondary = item.videoSecondaryInfoRenderer;
    if (!secondary) continue;
    snapshot.detailsFound = true;
    const description = secondary.attributedDescription;
    if (description) {
      const rawDescription = description.content || '';
      snapshot.description = cleanText(rawDescription);
      for (const run of description.commandRuns || []) {
        const channelId = run.onTap?.innertubeCommand?.browseEndpoint?.browseId;
        if (!String(channelId || '').startsWith('UC')) continue;
        const text = rawDescription.slice(run.startIndex, run.startIndex + run.length);
        snapshot.descriptionLinks.push({ text: cleanText(text).trim(), channelId });
      }
    }
    const owner = secondary.owner?.videoOwnerRenderer;
    if (owner) {
      snapshot.channelId = owner.navigationEndpoint?.browseEndpoint?.browseId || '';
      snapshot.channelTitle = textFromRuns(owner.title);
      const match = String(owner.subscriberCountText?.simpleText || '').match(/([\d.]+[KMB]?)/);
      if (match) snapshot.subscriberCount = match[1];
    }
  }

  const related = data?.contents?.twoColumnWatchNextResults?.secondaryResults?.secondaryResults?.results || [];
  for (const item of related) {
    const renderer = item.compactVideoRenderer;
    if (!renderer?.videoId) continue;
    const channelId = renderer.longBylineText?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId || '';
    if (!channelId) continue;
    snapshot.relatedVideos.push({
      videoId: renderer.videoId,
      title: textFromRuns(renderer.title),
      channelTitle: textFromRuns(renderer.longBylineText),
      channelId,
      publishedText: renderer.publishedTimeText?.simpleText || '',
    });
    if (snapshot.relatedVideos.length >= 20) break;
  }
  return snapshot;
}

async function cachedWatchNext(videoId: string) {
  const entry = await cache.watchNext.getAsync(videoId);
  return entry && Date.now() < entry.expires ? entry.data as WatchNextSnapshot : null;
}

async function fetchWatchNextSnapshot(videoId: string) {
  const response = await withYtSlot(() => fetchWithBodyTimeout(WATCH_NEXT_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0',
      'Accept-Language': '*',
      'Referer': '',
      'Cookie': '',
    },
    body: JSON.stringify({
      videoId,
      context: { client: { clientName: 'WEB', clientVersion: getClientVersion(), hl: 'en', gl: 'US' } },
    }),
  }, { headerTimeoutMs: 6000, bodyIdleMs: 6000 }));
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`YouTube Watch Next returned ${response.status}`);
  }
  const data = await readJsonBounded(response, 4 * 1024 * 1024, 'watch-next-response-too-large');
  return parseWatchNextSnapshot(data);
}

async function getWatchNextSnapshot(videoId: string) {
  const cached = await cachedWatchNext(videoId);
  if (cached) return cached;
  return runBoundedSingleFlight(watchNextInflight, videoId, async () => {
    const doubleChecked = await cachedWatchNext(videoId);
    if (doubleChecked) return doubleChecked;

    const lockKey = `watch-next:${videoId}`;
    let lockToken: string | null = null;
    let renewTimer: NodeJS.Timeout | null = null;
    if (hasRedis() && hasCacheRedis()) {
      lockToken = await acquireLock(lockKey, WATCH_NEXT_LOCK_LEASE_MS);
      if (!lockToken) {
        const waitStartedAt = Date.now();
        const deadline = waitStartedAt + WATCH_NEXT_LOCK_WAIT_MS;
        while (Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 250 + Math.random() * 250));
          const shared = await cachedWatchNext(videoId);
          if (shared) {
            observeMetric('watch_next_lock_wait_seconds', (Date.now() - waitStartedAt) / 1000, { result: 'cache_hit' });
            return shared;
          }
        }
        incrementMetric('watch_next_coordination_fallbacks_total', { reason: 'wait_timeout' });
      } else if (lockToken !== 'local') {
        renewTimer = setInterval(() => {
          void renewLock(lockKey, lockToken!, WATCH_NEXT_LOCK_LEASE_MS);
        }, Math.floor(WATCH_NEXT_LOCK_LEASE_MS / 3));
        renewTimer.unref?.();
      }
    }

    try {
      if (lockToken) {
        const afterLock = await cachedWatchNext(videoId);
        if (afterLock) return afterLock;
      }
      const snapshot = await fetchWatchNextSnapshot(videoId);
      await cache.watchNext.setAsync(videoId, { data: snapshot, expires: Date.now() + WATCH_NEXT_TTL_MS });
      return snapshot;
    } finally {
      if (renewTimer) clearInterval(renewTimer);
      if (lockToken) await releaseLock(lockKey, lockToken);
    }
  }, watchNextSingleFlight);
}

export {
  getWatchNextSnapshot,
  parseWatchNextSnapshot,
};
export type { WatchNextSnapshot };
