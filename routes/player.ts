import { Router, Request, Response } from 'express';
import { ensureAuth, createStreamToken } from '../auth.js';
import { getCachedVideoDetails, getVideoDetails, enrichFromNext, getPlaylistDetails, sanitizePlaylistId } from '../youtube/index.js';
import { buildMPD } from './stream/index.js';
import { mpdCache } from './stream/shared.js';
import db from '../db.js';
import { listDownloadedFormats } from '../lib/download-files.js';
import { runtimeAssetUrl } from '../lib/runtime-assets.js';

const router = Router();

function playerDrmServers(): Record<string, string> {
  const servers: Record<string, string> = {};
  if (process.env.WIDEVINE_LICENSE_URL) {
    servers['com.widevine.alpha'] = process.env.WIDEVINE_LICENSE_URL;
  }
  return servers;
}

function isLocalPlaylistId(playlistId: string) {
  return /^local_[A-Za-z0-9_-]{8,64}$/.test(playlistId);
}

async function getLocalPlaylistDetails(userId: string, playlistId: string, requestedIndex = 1) {
  const saved = await Promise.resolve(db.getSavedPlaylist(userId, playlistId));
  if (!saved || saved.playlist_type !== 'local') return null;
  const limit = 50;
  const startPosition = Math.max(0, requestedIndex - Math.floor(limit / 2) - 1);
  const page = await Promise.resolve(db.getLocalPlaylistItemsCursorPage(
    userId,
    playlistId,
    limit,
    { position: startPosition, createdAt: '9999-12-31T23:59:59.999Z', videoId: 'zzzzzzzzzzzzzzzz' },
    'next',
  ));
  const rows = page.items;
  const items = rows.map(row => ({
    videoId: row.video_id,
    title: row.title || row.video_id,
    channelTitle: row.channel_title || '',
    channelId: row.channel_id || '',
    lengthText: '',
    index: row.position,
    available: true,
    unavailableReason: '',
  }));
  return {
    playlistId,
    title: saved.title,
    channelTitle: '',
    channelId: '',
    itemCountText: saved.item_count_text || '0 videos',
    thumbnailVideoId: items[0]?.videoId || '',
    items,
    nextPageToken: null,
  };
}

type PlaylistSource =
  | Awaited<ReturnType<typeof getPlaylistDetails>>
  | NonNullable<Awaited<ReturnType<typeof getLocalPlaylistDetails>>>;

function buildPlaylistContext(fetchedPlaylist: PlaylistSource | null, videoId: string, requestedPlaylistIndex: number) {
  if (!fetchedPlaylist || fetchedPlaylist.items.length === 0) return null;
  const foundArrayIndex = fetchedPlaylist.items.findIndex((item) => item.videoId === videoId);
  const currentIndex = foundArrayIndex >= 0 ? fetchedPlaylist.items[foundArrayIndex].index : requestedPlaylistIndex;
  const prev = currentIndex > 1
    ? fetchedPlaylist.items.slice(0, foundArrayIndex >= 0 ? foundArrayIndex : 0).reverse().find((item) => item.available && item.videoId) || null
    : null;
  const next = currentIndex > 0 && foundArrayIndex >= 0
    ? fetchedPlaylist.items.slice(foundArrayIndex + 1).find((item) => item.available && item.videoId) || null
    : null;
  const buildPlaylistWatchUrl = (item: { videoId: string; index: number } | null) => item
    ? `/watch?v=${item.videoId}&list=${encodeURIComponent(fetchedPlaylist.playlistId)}&index=${item.index}`
    : '';
  return {
    ...fetchedPlaylist,
    currentIndex,
    prevUrl: buildPlaylistWatchUrl(prev),
    nextUrl: buildPlaylistWatchUrl(next),
  };
}

// Preserve data that is already cached/synchronous without allowing optional
// remote metadata to hold the player document open.
function resolveThisTurn<T>(promise: Promise<T>): Promise<T | null> {
  return Promise.race([
    promise,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 0)),
  ]);
}

router.get('/', ensureAuth, async (req, res) => {
  const videoId = req.query.v as string;
  if (!videoId) return res.redirect('/');
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) return res.status(400).end('Invalid video ID');
  const playlistId = sanitizePlaylistId(req.query.list);
  const requestedPlaylistIndex = Math.max(1, parseInt(String(req.query.index || '0'), 10) || 0);
  const tRaw = String(req.query.t || '0').replace(/s$/, '');
  const startTime = parseInt(tRaw, 10) || 0;

  // Generate stream token early so preload links can include it
  const streamToken = createStreamToken(videoId);

  // Check L1 cache for a valid DASH MPD to inline into the HTML (skip manifest fetch).
  // BaseURL paths stay fully qualified so native and fallback parsers resolve
  // them consistently when the manifest is passed as inline data.
  const cachedMpd = mpdCache.get(videoId);
  const origin = req.protocol + '://' + req.get('host');
  const inlineMPD = (cachedMpd && typeof cachedMpd.data === 'string' && Date.now() < cachedMpd.expires)
    ? cachedMpd.data.replace(/<BaseURL>\//g, `<BaseURL>${origin}/`) : '';
  const inlineVia = (inlineMPD && cachedMpd.meta?.via) ? (cachedMpd.meta.via + '/' + cachedMpd.meta.playback) : '';

  // Kick off MPD build immediately — yt-dlp starts now instead of waiting
  // for the browser to receive HTML and fire a prefetch request
  buildMPD(videoId).catch(() => {});

  const videoP = getCachedVideoDetails(videoId).catch(() => null);
  const bootstrapP = Promise.resolve(
    db.getPlayerBootstrapData(req.session.userId, videoId, startTime === 0),
  );
  const downloadedFormatsP = listDownloadedFormats(videoId);
  // Local playlists are an inexpensive DB lookup. Remote YouTube playlist
  // context starts in the browser only after the playback provider is ready,
  // so it cannot consume an extraction slot or bandwidth during startup.
  const playlistP = playlistId && isLocalPlaylistId(playlistId)
    ? getLocalPlaylistDetails(req.session.userId, playlistId, requestedPlaylistIndex).catch(() => null)
    : Promise.resolve(null);

  // Flush shell with the native player + preload in head. The browser
  // starts loading these resources immediately while cache/DB metadata resolves.
  // Shaka remains a lazy emergency fallback only.
  await res.flushShell({
    activeTab: null,
    mainClass: 'player-page',
    extraHead: `<link rel="preload" href="/api/stream/${videoId}/poster" as="image" fetchpriority="high">\n` +
      (inlineMPD ? '' : `  <link rel="preload" href="/api/stream/${videoId}/dash.mpd?token=${streamToken}" as="fetch" crossorigin fetchpriority="high">\n`) +
      `  <script src="${runtimeAssetUrl('native-player-engine.min.js')}" defer fetchpriority="high"><\/script>\n` +
      `  <script src="${runtimeAssetUrl('player-telemetry.min.js')}" defer fetchpriority="low"><\/script>\n` +
      `  <script src="${runtimeAssetUrl('player-page.min.js')}" defer fetchpriority="low"><\/script>`
  });

  try {
    const [cachedVideo, fetchedPlaylist, bootstrap, downloadedFormats] = await Promise.all([
      resolveThisTurn(videoP),
      resolveThisTurn(playlistP),
      bootstrapP,
      downloadedFormatsP,
    ]);
    let video = cachedVideo;
    if (!video || !video.title) {
      if (bootstrap.display) {
        video = {
          videoId,
          title: bootstrap.display.title,
          channelTitle: bootstrap.display.channelTitle,
          channelId: bootstrap.display.channelId,
          description: '', publishedAt: '', viewCount: null, likeCount: null,
        };
      } else if (bootstrap.download) {
        video = {
          videoId,
          title: bootstrap.download.title,
          channelTitle: bootstrap.download.channel_title,
          description: '', channelId: '', publishedAt: '', viewCount: null, likeCount: null,
        };
      }
    }
    if (!video) {
      video = {
        videoId,
        title: videoId,
        channelTitle: '',
        description: '',
        channelId: '',
        publishedAt: '',
        viewCount: null,
        likeCount: null,
        liveStatus: bootstrap.liveStatus || undefined,
      };
    } else if (!video.title) {
      video = { ...video, title: videoId };
    } else if (!video.liveStatus && bootstrap.liveStatus) {
      video = { ...video, liveStatus: bootstrap.liveStatus };
    }
    // Pass saved watch position so the player can seek before buffering starts
    const savedPosition = startTime === 0
      ? (bootstrap.watchTime?.last_position || 0)
      : 0;
    // Check if this video has a completed local download — pass the height
    // so the player can pin ABR and serve from disk instead of YouTube.
    // Map YouTube itags to known heights (avoids dependency on formatCache).
    const itagHeight: Record<string, number> = {
      '160': 144, '133': 240, '134': 360, '135': 480, '136': 720,
      '137': 1080, '298': 720, '299': 1080, '264': 1440, '271': 1440,
      '313': 2160, '304': 720, '303': 1080, '308': 1440, '315': 2160,
      '330': 144, '331': 240, '332': 360, '333': 480, '334': 720,
      '335': 1080, '336': 1440, '337': 2160,
      '394': 144, '395': 240, '396': 360, '397': 480, '398': 720,
      '399': 1080, '400': 1440, '401': 2160, '571': 4320,
    };
    let downloadedHeight = 0;
    for (const entry of downloadedFormats) {
      const h = itagHeight[entry.formatId] || 0;
      if (h > downloadedHeight) downloadedHeight = h;
    }
    const playlist = buildPlaylistContext(fetchedPlaylist, videoId, requestedPlaylistIndex);
    await res.streamContent('player-shell', {
      video,
      tags: bootstrap.tags,
      startTime,
      streamToken,
      currentRating: bootstrap.rating,
      savedPosition,
      inlineMPD,
      inlineVia,
      downloadedHeight,
      playerDrmServers: playerDrmServers(),
      playlist,
      requestedPlaylistId: playlistId,
      requestedPlaylistIndex,
    });
  } catch (err) {
    console.error('Player error:', err.message);
    res.end('<div class="player-error">Failed to load video</div></main><script src="/app.js"></script>\n</body>\n</html>');
  }
});

// Playlist UI and previous/next actions are secondary to playback startup.
router.get('/playlist-context', ensureAuth, async (req, res) => {
  try {
    const videoId = String(req.query.v || '');
    const playlistId = sanitizePlaylistId(req.query.list);
    const requestedPlaylistIndex = Math.max(1, parseInt(String(req.query.index || '0'), 10) || 0);
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId) || !playlistId) {
      return res.status(400).json({ error: 'Invalid video or playlist ID' });
    }
    const fetchedPlaylist = isLocalPlaylistId(playlistId)
      ? await getLocalPlaylistDetails(req.session.userId, playlistId, requestedPlaylistIndex)
      : await getPlaylistDetails(playlistId);
    const playlist = buildPlaylistContext(fetchedPlaylist, videoId, requestedPlaylistIndex);
    if (!playlist) return res.status(404).json({ error: 'Playlist not found' });
    return res.json(playlist);
  } catch (err) {
    return res.status(502).json({ error: err instanceof Error ? err.message : 'Playlist unavailable' });
  }
});

// Lazy-load full video details (views, likes, description) after page render
router.get('/details', ensureAuth, async (req, res) => {
  try {
    const videoId = req.query.v;
    if (!videoId) return res.status(400).json({ error: 'Missing video ID' });

    // Start with whatever we have cached (fast path)
    let video = await getVideoDetails(videoId);

    // Enrich with Innertube next data (description, channel, likes, @handles)
    await enrichFromNext(video);

    res.json(video);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Token refresh — returns a fresh stream token without a full page reload.
// Used by the player engine when a server restart invalidates the old token.
// Session-authed (no stream token needed), lightweight JSON response.
router.get('/token', ensureAuth, (req, res) => {
  const videoId = req.query.v as string;
  if (!videoId || !/^[A-Za-z0-9_-]{11}$/.test(videoId)) return res.status(400).json({ error: 'Invalid video ID' });
  res.json({ token: createStreamToken(videoId) });
});

// Path-based video URLs → /watch?v=videoId
// Used for legacy /watch/:videoId links and YouTube /live/:videoId share links
// (the latter is mounted at /live in server.ts).
export function redirectPathVideoId(req: Request<{ videoId: string }>, res: Response) {
  const videoId = req.params.videoId;
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) return res.status(400).end();
  const t = parseInt(req.query.t as string, 10) || 0;
  res.redirect('/watch?v=' + videoId + (t ? '&t=' + t : ''));
}

// Legacy path-based URLs: /watch/:videoId → /watch?v=videoId
router.get('/:videoId', redirectPathVideoId);

export default router;
