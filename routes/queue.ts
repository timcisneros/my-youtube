import { Router } from 'express';
import { ensureAuth } from '../auth.js';
import db from '../db.js';
import { cache } from '../youtube/shared.js';
import { getDurationsForVideos } from '../youtube/index.js';

const router = Router();

router.get('/', ensureAuth, async (req, res) => {
  await res.flushShell({ activeTab: 'queue' });
  const videos = await Promise.resolve(db.getQueuedVideos(req.session.userId));
  const durations = getDurationsForVideos(videos.map(v => v.video_id));
  await res.streamContent('queue', { videos, durations });
});

router.post('/', ensureAuth, (req, res) => {
  const { videoId, title, channelTitle, channelId } = req.body;
  if (!videoId) return res.status(400).json({ error: 'videoId required' });
  db.queueVideo(req.session.userId, videoId, title || '', channelTitle || '', channelId || '');
  cache.exploreVideos.delete(req.session.userId);
  res.json({ ok: true });
});

router.delete('/', ensureAuth, (req, res) => {
  const { videoId } = req.body;
  if (!videoId) return res.status(400).json({ error: 'videoId required' });
  db.unqueueVideo(req.session.userId, videoId);
  cache.exploreVideos.delete(req.session.userId);
  res.json({ ok: true });
});

export default router;
