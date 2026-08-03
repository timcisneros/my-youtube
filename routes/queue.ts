import { Router } from 'express';
import { ensureAuth } from '../auth.js';
import db from '../db.js';
import { cache } from '../youtube/shared.js';
import { getDurationsForVideos } from '../youtube/index.js';
import { buildCursorNavigation, decodeTimestampCursor, encodeTimestampCursor } from '../lib/cursor-pagination.js';

const router = Router();
const QUEUE_PAGE_SIZE = 40;

router.get('/', ensureAuth, async (req, res) => {
  await res.flushShell({ activeTab: 'queue' });
  const token = decodeTimestampCursor(req.query.cursor);
  const direction = token?.direction || 'next';
  const page = await db.getQueuedVideosCursorPage(req.session.userId, QUEUE_PAGE_SIZE, token, direction);
  const videos = page.items;
  const durations = await getDurationsForVideos(videos.map(v => v.video_id));
  const navigation = buildCursorNavigation(videos, page.hasMore, token !== null, direction,
    (item, nextDirection) => encodeTimestampCursor(item.created_at, item.video_id, nextDirection));
  await res.streamContent('queue', { videos, durations, ...navigation });
});

router.post('/', ensureAuth, async (req, res) => {
  const { videoId, title, channelTitle, channelId } = req.body;
  if (!videoId) return res.status(400).json({ error: 'videoId required' });
  await db.queueVideo(req.session.userId, videoId, title || '', channelTitle || '', channelId || '');
  cache.exploreVideos.delete(req.session.userId);
  res.json({ ok: true });
});

router.delete('/', ensureAuth, async (req, res) => {
  const { videoId } = req.body;
  if (!videoId) return res.status(400).json({ error: 'videoId required' });
  await db.unqueueVideo(req.session.userId, videoId);
  cache.exploreVideos.delete(req.session.userId);
  res.json({ ok: true });
});

export default router;
