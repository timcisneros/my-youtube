import { Router } from 'express';
import { ensureAuth } from '../auth.js';
import db from '../db.js';

const router = Router();

router.post('/', ensureAuth, (req, res) => {
  const { videoId, channelId, sessionId } = req.body;
  if (!videoId) return res.status(400).json({ error: 'videoId required' });
  db.logExploreClick(req.session.userId, videoId, channelId || '');
  if (sessionId) {
    // Increment session clicks — read current, increment, update
    void Promise.resolve(db.getRecentExploreSessions(req.session.userId, 1)).then(sessions => {
      const session = (sessions as Array<{ session_id: string; clicks: number; total_watch_seconds: number; best_completion: number }>)
        .find(s => s.session_id === sessionId);
      if (session) {
        void Promise.resolve(db.updateExploreSession(
          req.session.userId, sessionId,
          session.clicks + 1, session.total_watch_seconds, session.best_completion
        ));
      }
    });
  }
  res.json({ ok: true });
});

router.post('/bounce', ensureAuth, (req, res) => {
  const { videoId, channelId, bounceSeconds } = req.body;
  if (!videoId || typeof bounceSeconds !== 'number') return res.status(400).json({ error: 'videoId and bounceSeconds required' });
  void Promise.resolve(db.logExploreBounce(req.session.userId, videoId, channelId || '', Math.round(bounceSeconds)));
  res.json({ ok: true });
});

router.post('/return', ensureAuth, (req, res) => {
  const { videoId, channelId } = req.body;
  if (!videoId) return res.status(400).json({ error: 'videoId required' });
  void Promise.resolve(db.logExploreReturn(req.session.userId, videoId, channelId || ''));
  res.json({ ok: true });
});

router.post('/impressions', ensureAuth, (req, res) => {
  const { impressions } = req.body;
  if (!Array.isArray(impressions) || impressions.length === 0) {
    return res.status(400).json({ error: 'impressions array required' });
  }
  const valid = impressions
    .filter(imp => imp && typeof imp.videoId === 'string')
    .slice(0, 100) // cap per request
    .map(imp => ({ videoId: imp.videoId, channelId: imp.channelId || '', position: Number(imp.position) || 0 }));
  if (valid.length > 0) {
    void Promise.resolve(db.logExploreImpressions(req.session.userId, valid));
  }
  res.json({ ok: true });
});

export default router;
