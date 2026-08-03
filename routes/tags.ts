import { Router } from 'express';
import { ensureAuth } from '../auth.js';
import db from '../db.js';

const router = Router();

router.post('/', ensureAuth, async (req, res) => {
  const { videoId, tag } = req.body;
  if (!videoId || !tag) return res.status(400).json({ error: 'videoId and tag required' });
  const result = await db.addTag(req.session.userId, videoId, tag);
  res.json(result);
});

router.delete('/', ensureAuth, async (req, res) => {
  const { videoId, tag } = req.body;
  if (!videoId || !tag) return res.status(400).json({ error: 'videoId and tag required' });
  const result = await db.removeTag(req.session.userId, videoId, tag);
  res.json(result);
});

export default router;
