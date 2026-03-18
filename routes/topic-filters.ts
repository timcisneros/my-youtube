import { Router } from 'express';
import { ensureAuth } from '../auth.js';
import db from '../db.js';
import { cache } from '../youtube/shared.js';

const router = Router();

router.post('/', ensureAuth, (req, res) => {
  const { topic, filter } = req.body;
  if (!topic || typeof topic !== 'string') return res.status(400).json({ error: 'topic required' });
  if (filter !== 'boost' && filter !== 'suppress') return res.status(400).json({ error: 'filter must be boost or suppress' });
  const normalized = topic.toLowerCase().trim();
  if (normalized.length < 2) return res.status(400).json({ error: 'topic must be at least 2 characters' });
  db.setTopicFilter(req.session.userId, normalized, filter);
  cache.exploreVideos.delete(req.session.userId);
  res.json({ ok: true });
});

router.get('/', ensureAuth, async (req, res) => {
  const filters = await Promise.resolve(db.getTopicFilters(req.session.userId));
  res.json(filters);
});

router.delete('/', ensureAuth, (req, res) => {
  const { topic } = req.body;
  if (!topic || typeof topic !== 'string') return res.status(400).json({ error: 'topic required' });
  db.removeTopicFilter(req.session.userId, topic.toLowerCase().trim());
  cache.exploreVideos.delete(req.session.userId);
  res.json({ ok: true });
});

export default router;
