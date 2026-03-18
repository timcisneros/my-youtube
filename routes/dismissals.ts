import { Router } from 'express';
import { ensureAuth } from '../auth.js';
import db from '../db.js';
import { cache } from '../youtube/shared.js';

const router = Router();

const DISMISS_MUTE_THRESHOLD = 3;

router.post('/', ensureAuth, async (req, res) => {
  const { videoId, channelId } = req.body;
  if (!videoId) return res.status(400).json({ error: 'videoId required' });
  await Promise.resolve(db.dismissVideo(req.session.userId, videoId, channelId || ''));
  cache.exploreVideos.delete(req.session.userId);
  let channelMuted = false;
  if (channelId) {
    const count = await Promise.resolve(db.getDismissalCountByChannel(req.session.userId, channelId));
    if (count >= DISMISS_MUTE_THRESHOLD) {
      await Promise.resolve(db.muteChannel(req.session.userId, channelId));
      await Promise.resolve(db.unboostChannel(req.session.userId, channelId));
      channelMuted = true;
    }
  }
  res.json({ ok: true, channelMuted });
});

router.delete('/', ensureAuth, (req, res) => {
  const { videoId } = req.body;
  if (!videoId) return res.status(400).json({ error: 'videoId required' });
  db.undismissVideo(req.session.userId, videoId);
  cache.exploreVideos.delete(req.session.userId);
  res.json({ ok: true });
});

export default router;
