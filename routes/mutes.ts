import { Router } from 'express';
import { ensureAuth } from '../auth.js';
import db from '../db.js';
import { cache } from '../youtube/shared.js';

const router = Router();

router.post('/', ensureAuth, (req, res) => {
  const { channelId } = req.body;
  if (!channelId) return res.status(400).json({ error: 'channelId required' });
  db.muteChannel(req.session.userId, channelId);
  // Muting and boosting are mutually exclusive — remove boost if present
  db.unboostChannel(req.session.userId, channelId);
  cache.exploreVideos.delete(req.session.userId);
  res.json({ ok: true });
});

router.delete('/', ensureAuth, (req, res) => {
  const { channelId } = req.body;
  if (!channelId) return res.status(400).json({ error: 'channelId required' });
  db.unmuteChannel(req.session.userId, channelId);
  cache.exploreVideos.delete(req.session.userId);
  res.json({ ok: true });
});

export default router;
