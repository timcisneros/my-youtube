import { Router } from 'express';
import { ensureAuth, createStreamToken } from '../auth.js';
import { getVideoDetails, enrichFromNext } from '../youtube/index.js';
import { buildMPD } from './stream/index.js';
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
      `  <link rel="preload" href="/api/stream/${videoId}/dash.mpd?token=${streamToken}" as="fetch" crossorigin fetchpriority="high">\n` +
      `  <script src="/vendor/shaka/shaka-player.compiled.js" defer><\/script>\n` +
      `  <script src="/player-engine.js" defer><\/script>\n` +
      `  <script>fetch('/api/stream/${videoId}/prefetch')<\/script>`
  });

  try {
    const video = await videoP;
    if (!video) {
      return res.end('<div class="player-error">Video not found</div></main><script src="/app.js"></script>\n</body>\n</html>');
    }
    const tags = db.getTags(req.session.userId, videoId);
    const ratingRows = db.getVideoRatings(req.session.userId);
    const currentRating = ratingRows.find(r => r.video_id === videoId)?.rating || 0;
    // Pass saved watch position so the player can seek before buffering starts
    const savedPosition = startTime === 0
      ? (db.getWatchTime(req.session.userId, videoId)?.last_position || 0)
      : 0;
    await res.streamContent('player', { video, tags, startTime, streamToken, currentRating, savedPosition });
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

// Legacy path-based URLs: /watch/:videoId → /watch?v=videoId
router.get('/:videoId', (req, res) => {
  const videoId = req.params.videoId;
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) return res.status(400).end();
  const t = parseInt(req.query.t as string, 10) || 0;
  res.redirect('/watch?v=' + videoId + (t ? '&t=' + t : ''));
});

export default router;
