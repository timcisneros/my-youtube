import { Router } from 'express';
import { ensureAuth, createStreamToken } from '../auth.js';
import { getVideoDetails, enrichFromNext } from '../youtube/index.js';
import { buildMPD, bgDownloads } from './stream/index.js';
import { mpdCache } from './stream/shared.js';
import db from '../db.js';

const router = Router();

router.get('/', ensureAuth, async (req, res) => {
  const videoId = req.query.v as string;
  if (!videoId) return res.redirect('/');
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) return res.status(400).end('Invalid video ID');
  const tRaw = String(req.query.t || '0').replace(/s$/, '');
  const startTime = parseInt(tRaw, 10) || 0;

  // Generate stream token early so preload links can include it
  const streamToken = createStreamToken(videoId);

  // Check L1 cache for a valid DASH MPD to inline into the HTML (skip manifest fetch).
  // BaseURL paths must be fully qualified because Shaka can't resolve paths
  // against data: URIs — rewrite them with the request origin server-side.
  const cachedMpd = mpdCache.get(videoId);
  const origin = req.protocol + '://' + req.get('host');
  const inlineMPD = (cachedMpd && typeof cachedMpd.data === 'string' && Date.now() < cachedMpd.expires)
    ? cachedMpd.data.replace(/<BaseURL>\//g, `<BaseURL>${origin}/`) : '';
  const inlineVia = (inlineMPD && cachedMpd.meta?.via) ? (cachedMpd.meta.via + '/' + cachedMpd.meta.playback) : '';

  // Kick off MPD build immediately — yt-dlp starts now instead of waiting
  // for the browser to receive HTML and fire a prefetch request
  buildMPD(videoId).catch(() => {});

  const videoP = getVideoDetails(videoId);

  // Flush shell with Shaka + preload/prefetch in head — browser starts loading
  // these resources immediately while getVideoDetails runs
  await res.flushShell({
    activeTab: null,
    mainClass: 'player-page',
    extraHead: `<link rel="preload" href="/api/stream/${videoId}/poster" as="image" fetchpriority="high">\n` +
      (inlineMPD ? '' : `  <link rel="preload" href="/api/stream/${videoId}/dash.mpd?token=${streamToken}" as="fetch" crossorigin fetchpriority="high">\n`) +
      `  <script src="/vendor/shaka/shaka-player.compiled.js" defer><\/script>\n` +
      `  <script src="/player-engine.js" defer><\/script>\n` +
      `  <script>fetch('/api/stream/${videoId}/prefetch')<\/script>`
  });

  try {
    let video;
    try {
      video = await videoP;
    } catch {
      video = null;
    }
    if (!video || !video.title) {
      const dl = db.getDownload(videoId);
      if (dl) {
        video = { videoId, title: dl.title, channelTitle: dl.channel_title, description: '', channelId: '', publishedAt: '', viewCount: null, likeCount: null };
      }
    }
    if (!video) {
      return res.end('<div class="player-error">Video not found</div></main><script src="/app.js"></script>\n</body>\n</html>');
    }
    const tags = db.getTags(req.session.userId, videoId);
    const currentRating = db.getVideoRating(req.session.userId, videoId);
    // Pass saved watch position so the player can seek before buffering starts
    const savedPosition = startTime === 0
      ? (db.getWatchTime(req.session.userId, videoId)?.last_position || 0)
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
    for (const [key, entry] of bgDownloads) {
      if (key.startsWith(videoId + ':') && entry.done) {
        const itag = key.split(':')[1];
        const h = itagHeight[itag] || 0;
        if (h > downloadedHeight) downloadedHeight = h;
      }
    }
    await res.streamContent('player', { video, tags, startTime, streamToken, currentRating, savedPosition, inlineMPD, inlineVia, downloadedHeight });
  } catch (err) {
    console.error('Player error:', err.message);
    res.end('<div class="player-error">Failed to load video</div></main><script src="/app.js"></script>\n</body>\n</html>');
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

// Legacy path-based URLs: /watch/:videoId → /watch?v=videoId
router.get('/:videoId', (req, res) => {
  const videoId = req.params.videoId;
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) return res.status(400).end();
  const t = parseInt(req.query.t as string, 10) || 0;
  res.redirect('/watch?v=' + videoId + (t ? '&t=' + t : ''));
});

export default router;
