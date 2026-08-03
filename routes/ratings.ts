import { Router } from 'express';
import { ensureAuth } from '../auth.js';
import db from '../db.js';
import { cache } from '../youtube/shared.js';

const router = Router();

router.post('/', ensureAuth, async (req, res) => {
  const { videoId, rating } = req.body;
  if (!videoId) return res.status(400).json({ error: 'videoId required' });
  if (rating !== 1 && rating !== -1) return res.status(400).json({ error: 'rating must be 1 or -1' });
  await db.rateVideo(req.session.userId, videoId, rating);
  cache.exploreVideos.delete(req.session.userId);
  res.json({ ok: true });
});

router.delete('/', ensureAuth, async (req, res) => {
  const { videoId } = req.body;
  if (!videoId) return res.status(400).json({ error: 'videoId required' });
  await db.unrateVideo(req.session.userId, videoId);
  cache.exploreVideos.delete(req.session.userId);
  res.json({ ok: true });
});

export default router;
