/**
 * YouTube playlist metadata and item listing.
 */
import { cache, withYtSlot, PLAYLIST_TTL } from './shared.js';
import { getClientVersion } from '../extractors.js';
import { fetchWithBodyTimeout, readBodyBounded, readJsonBounded } from '../lib/bounded-fetch.js';
import { runBoundedSingleFlight } from '../lib/bounded-singleflight.js';
import { parseEmbeddedJsonBuffer } from '../lib/upstream-parser.js';
import { createHash } from 'node:crypto';

interface PlaylistVideo {
  videoId: string;
  title: string;
  channelTitle: string;
  channelId: string;
  lengthText: string;
  index: number;
  available: boolean;
  unavailableReason: string;
}

interface PlaylistDetails {
  playlistId: string;
  title: string;
  channelTitle: string;
  channelId: string;
  itemCountText: string;
  thumbnailVideoId: string;
  items: PlaylistVideo[];
  nextPageToken: string | null;
}

interface PlaylistRequestOptions {
  priority?: 'interactive' | 'background';
}

const inFlightPlaylists = new Map<string, Promise<PlaylistDetails>>();
const playlistSingleFlight = { name: 'playlist', maxEntries: 300 } as const;
const inFlightPlaylistContinuations = new Map<string, Promise<PlaylistDetails>>();
const playlistContinuationSingleFlight = { name: 'playlist_continuation', maxEntries: 1000 } as const;
const PLAYLIST_CONTINUATION_TTL_MS = Math.min(PLAYLIST_TTL,
  Math.max(60_000, Number(process.env.PLAYLIST_CONTINUATION_TTL_MS) || 5 * 60_000));
const PLAYLIST_CONTINUATION_MAX_TOKEN_LENGTH = 4096;

function playlistContinuationCacheKey(playlistId: string, continuation: string, startIndex: number) {
  const tokenHash = createHash('sha256').update(continuation).digest('base64url').slice(0, 32);
  return `${playlistId}:${startIndex}:${tokenHash}`;
}

function sanitizePlaylistId(value: unknown): string {
  const playlistId = typeof value === 'string' ? value.trim() : '';
  if (!/^[A-Za-z0-9_-]{2,128}$/.test(playlistId)) return '';
  return playlistId;
}

function extractPlaylistId(value: unknown): string {
  const input = typeof value === 'string' ? value.trim() : '';
  if (!input) return '';
  const raw = sanitizePlaylistId(input);
  if (raw) return raw;
  try {
    const parsed = new URL(input);
    return sanitizePlaylistId(parsed.searchParams.get('list'));
  } catch {
    return '';
  }
}

function textFromRuns(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const obj = value as Record<string, unknown>;
  if (typeof obj.simpleText === 'string') return obj.simpleText;
  if (typeof obj.content === 'string') return obj.content;
  if (Array.isArray(obj.runs)) {
    return obj.runs
      .map((run) => (run && typeof run === 'object' && typeof (run as Record<string, unknown>).text === 'string') ? String((run as Record<string, unknown>).text) : '')
      .join('');
  }
  return '';
}

function walkTree(root: unknown, visit: (node: Record<string, unknown>) => void) {
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i--) stack.push(node[i]);
      continue;
    }
    const obj = node as Record<string, unknown>;
    visit(obj);
    for (const value of Object.values(obj)) {
      if (value && typeof value === 'object') stack.push(value);
    }
  }
}

function readEndpointBrowseId(run: unknown): string {
  if (!run || typeof run !== 'object') return '';
  const obj = run as Record<string, unknown>;
  const nav = obj.navigationEndpoint;
  if (!nav || typeof nav !== 'object') return '';
  const browse = (nav as Record<string, unknown>).browseEndpoint;
  if (!browse || typeof browse !== 'object') return '';
  const browseId = (browse as Record<string, unknown>).browseId;
  return typeof browseId === 'string' ? browseId : '';
}

function parsePlaylistItems(data: unknown, startIndex = 1): { items: PlaylistVideo[]; nextPageToken: string | null } {
  const items: PlaylistVideo[] = [];
  const seenVideoIds = new Set<string>();
  let nextPageToken: string | null = null;

  walkTree(data, (node) => {
    const continuation = node.continuationItemRenderer;
    if (continuation && typeof continuation === 'object' && !nextPageToken) {
      const token = (continuation as Record<string, unknown>).continuationEndpoint;
      const command = token && typeof token === 'object' ? (token as Record<string, unknown>).continuationCommand : null;
      const value = command && typeof command === 'object' ? (command as Record<string, unknown>).token : '';
      if (typeof value === 'string' && value) nextPageToken = value;
    }

    const renderer = node.playlistVideoRenderer;
    if (!renderer || typeof renderer !== 'object') return;
    const video = renderer as Record<string, unknown>;
    const rawVideoId = typeof video.videoId === 'string' ? video.videoId : '';
    const videoId = /^[A-Za-z0-9_-]{11}$/.test(rawVideoId) ? rawVideoId : '';
    if (videoId && seenVideoIds.has(videoId)) return;
    const shortByline = video.shortBylineText && typeof video.shortBylineText === 'object'
      ? video.shortBylineText as Record<string, unknown>
      : null;
    const bylineRuns = shortByline && Array.isArray(shortByline.runs) ? shortByline.runs as unknown[] : [];
    let itemChannelId = '';
    for (const run of bylineRuns) {
      const browseId = readEndpointBrowseId(run);
      if (browseId.startsWith('UC')) {
        itemChannelId = browseId;
        break;
      }
    }
    const unavailableReason = textFromRuns(video.unplayableText) || textFromRuns(video.upcomingEventData) || '';
    const title = textFromRuns(video.title) || (videoId ? 'Untitled video' : 'Unavailable video');
    const available = Boolean(videoId && video.isPlayable !== false && !unavailableReason);
    if (videoId) seenVideoIds.add(videoId);
    items.push({
      videoId,
      title,
      channelTitle: textFromRuns(video.shortBylineText) || textFromRuns(video.ownerText),
      channelId: itemChannelId,
      lengthText: textFromRuns(video.lengthText),
      index: startIndex + items.length,
      available,
      unavailableReason,
    });
  });

  return { items, nextPageToken };
}

function parsePlaylistInitialData(data: unknown, playlistId: string): PlaylistDetails {
  let title = '';
  let channelTitle = '';
  let channelId = '';
  let itemCountText = '';

  walkTree(data, (node) => {
    const metadata = node.playlistMetadataRenderer;
    if (metadata && typeof metadata === 'object') {
      const metadataTitle = typeof (metadata as Record<string, unknown>).title === 'string'
        ? String((metadata as Record<string, unknown>).title)
        : textFromRuns((metadata as Record<string, unknown>).title);
      if (metadataTitle) title = metadataTitle;
    }

    const header = node.playlistHeaderRenderer || node.playlistSidebarPrimaryInfoRenderer;
    if (header && typeof header === 'object') {
      const h = header as Record<string, unknown>;
      if (!title) title = textFromRuns(h.title);
      if (!itemCountText) itemCountText = textFromRuns(h.numVideosText) || textFromRuns(h.stats);
      if (!channelTitle) channelTitle = textFromRuns(h.ownerText);
      const ownerRuns = (h.ownerText && typeof h.ownerText === 'object' && Array.isArray((h.ownerText as Record<string, unknown>).runs))
        ? (h.ownerText as Record<string, unknown>).runs as unknown[]
        : [];
      if (!channelId) {
        for (const run of ownerRuns) {
          const browseId = readEndpointBrowseId(run);
          if (browseId.startsWith('UC')) {
            channelId = browseId;
            break;
          }
        }
      }
    }

    const pageHeader = node.pageHeaderViewModel;
    if (pageHeader && typeof pageHeader === 'object') {
      const h = pageHeader as Record<string, unknown>;
      if (!title) title = textFromRuns(h.title) || textFromRuns(h.pageTitle);
    }
  });

  const { items, nextPageToken } = parsePlaylistItems(data, 1);
  const firstPlayable = items.find((item) => item.available && item.videoId);
  return {
    playlistId,
    title: title || 'Playlist',
    channelTitle,
    channelId,
    itemCountText: itemCountText || (items.length ? `${items.length} videos` : ''),
    thumbnailVideoId: firstPlayable?.videoId || '',
    items,
    nextPageToken,
  };
}

function parsePlaylistContinuationData(data: unknown, playlistId: string, startIndex = 1): PlaylistDetails {
  const { items, nextPageToken } = parsePlaylistItems(data, startIndex);
  const firstPlayable = items.find((item) => item.available && item.videoId);
  return {
    playlistId,
    title: 'Playlist',
    channelTitle: '',
    channelId: '',
    itemCountText: items.length ? `${items.length} videos` : '',
    thumbnailVideoId: firstPlayable?.videoId || '',
    items,
    nextPageToken,
  };
}

async function getPlaylistContinuation(rawPlaylistId: unknown, pageToken: unknown, startIndex = 1): Promise<PlaylistDetails> {
  const playlistId = extractPlaylistId(rawPlaylistId);
  const continuation = typeof pageToken === 'string' ? pageToken : '';
  const boundedStartIndex = Math.min(100_000, Math.max(1, Math.floor(Number(startIndex) || 1)));
  if (!playlistId || !continuation || continuation.length > PLAYLIST_CONTINUATION_MAX_TOKEN_LENGTH) {
    throw new Error('Invalid playlist continuation');
  }
  const cacheKey = playlistContinuationCacheKey(playlistId, continuation, boundedStartIndex);
  const cached = await cache.playlistContinuations.getAsync(cacheKey);
  if (cached) return cached.data as PlaylistDetails;
  return runBoundedSingleFlight(inFlightPlaylistContinuations, cacheKey, async () => {
    const shared = await cache.playlistContinuations.getAsync(cacheKey);
    if (shared) return shared.data as PlaylistDetails;
    const page = await withYtSlot(async () => {
      const res = await fetchWithBodyTimeout('https://www.youtube.com/youtubei/v1/browse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0', 'Accept-Language': '*', Referer: '', Cookie: '' },
        body: JSON.stringify({
          continuation,
          context: { client: { clientName: 'WEB', clientVersion: getClientVersion(), hl: 'en' } },
        }),
      }, { headerTimeoutMs: 10_000, bodyIdleMs: 10_000 });
      if (!res.ok) throw new Error(`YouTube playlist continuation returned ${res.status}`);
      return parsePlaylistContinuationData(
        await readJsonBounded(res, 4 * 1024 * 1024, 'playlist-continuation-response-too-large'),
        playlistId,
        boundedStartIndex,
      );
    });
    await cache.playlistContinuations.setAsync(cacheKey, {
      data: page,
      expires: Date.now() + PLAYLIST_CONTINUATION_TTL_MS,
    });
    return page;
  }, playlistContinuationSingleFlight);
}

async function getPlaylistDetails(
  rawPlaylistId: unknown,
  options: PlaylistRequestOptions = {},
): Promise<PlaylistDetails> {
  const playlistId = extractPlaylistId(rawPlaylistId);
  if (!playlistId) throw new Error('Invalid playlist ID');
  const cached = await cache.playlists.getAsync(playlistId);
  if (cached && Date.now() < cached.expires) return cached.data as PlaylistDetails;
  return runBoundedSingleFlight(inFlightPlaylists, playlistId, async () => {
    const request = withYtSlot(async () => {
      const res = await fetchWithBodyTimeout(`https://www.youtube.com/playlist?list=${encodeURIComponent(playlistId)}&hl=en&gl=US`, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': '*', Referer: '', Cookie: '' },
      }, { headerTimeoutMs: 10_000, bodyIdleMs: 10_000 });
      if (!res.ok) throw new Error(`YouTube playlist returned ${res.status}`);
      const html = await readBodyBounded(res, 8 * 1024 * 1024, 'playlist-page-response-too-large');
      const initialData = await parseEmbeddedJsonBuffer(html, 'ytInitialData');
      return parsePlaylistInitialData(initialData, playlistId);
    }, options.priority || 'interactive');
    const playlist = await request;
    await cache.playlists.setAsync(playlistId, { data: playlist, expires: Date.now() + PLAYLIST_TTL });
    return playlist;
  }, playlistSingleFlight);
}

export { extractPlaylistId, getPlaylistContinuation, getPlaylistDetails, parsePlaylistContinuationData, parsePlaylistInitialData, playlistContinuationCacheKey, sanitizePlaylistId };
