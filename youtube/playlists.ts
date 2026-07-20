/**
 * YouTube playlist metadata and item listing.
 */
import { cache, withYtSlot, PLAYLIST_TTL } from './shared.js';
import { getClientVersion } from '../extractors.js';

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

function extractInitialData(html: string): unknown {
  const marker = 'ytInitialData';
  const markerIndex = html.indexOf(marker);
  if (markerIndex === -1) throw new Error('ytInitialData not found');
  const start = html.indexOf('{', markerIndex);
  if (start === -1) throw new Error('ytInitialData object not found');
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) return JSON.parse(html.slice(start, i + 1));
    }
  }
  throw new Error('ytInitialData object was incomplete');
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
  if (!playlistId || !continuation) throw new Error('Invalid playlist continuation');
  return withYtSlot(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const res = await fetch('https://www.youtube.com/youtubei/v1/browse', {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0', 'Accept-Language': '*', Referer: '', Cookie: '' },
        body: JSON.stringify({
          continuation,
          context: { client: { clientName: 'WEB', clientVersion: getClientVersion(), hl: 'en' } },
        }),
      });
      if (!res.ok) throw new Error(`YouTube playlist continuation returned ${res.status}`);
      return parsePlaylistContinuationData(await res.json(), playlistId, startIndex);
    } finally {
      clearTimeout(timer);
    }
  });
}

async function getPlaylistDetails(rawPlaylistId: unknown): Promise<PlaylistDetails> {
  const playlistId = extractPlaylistId(rawPlaylistId);
  if (!playlistId) throw new Error('Invalid playlist ID');
  const cached = cache.playlists.get(playlistId);
  if (cached && Date.now() < cached.expires) return cached.data as PlaylistDetails;

  const playlist = await withYtSlot(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const res = await fetch(`https://www.youtube.com/playlist?list=${encodeURIComponent(playlistId)}&hl=en&gl=US`, {
        signal: controller.signal,
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': '*', Referer: '', Cookie: '' },
      });
      if (!res.ok) throw new Error(`YouTube playlist returned ${res.status}`);
      const html = await res.text();
      return parsePlaylistInitialData(extractInitialData(html), playlistId);
    } finally {
      clearTimeout(timer);
    }
  });

  cache.playlists.set(playlistId, { data: playlist, expires: Date.now() + PLAYLIST_TTL });
  return playlist;
}

async function getExpandedPlaylistDetails(rawPlaylistId: unknown, maxItems = 500): Promise<PlaylistDetails> {
  const first = await getPlaylistDetails(rawPlaylistId);
  let result = first;
  let token = first.nextPageToken;
  while (token && result.items.length < maxItems) {
    const page = await getPlaylistContinuation(first.playlistId, token, result.items.length + 1);
    result = {
      ...result,
      items: result.items.concat(page.items),
      nextPageToken: page.nextPageToken,
    };
    token = page.nextPageToken;
    if (page.items.length === 0) break;
  }
  return result.items.length >= maxItems ? { ...result, nextPageToken: token } : result;
}

export { extractPlaylistId, getExpandedPlaylistDetails, getPlaylistContinuation, getPlaylistDetails, parsePlaylistContinuationData, parsePlaylistInitialData, sanitizePlaylistId };
