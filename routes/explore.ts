import { Router } from 'express';
import { ensureAuth } from '../auth.js';
import db from '../db.js';
import { cache } from '../youtube/shared.js';
import { getExploreVideos, getDurationsForVideos, getLiveStatusesForVideos } from '../youtube/index.js';

const router = Router();

router.get('/', ensureAuth, async (req, res) => {
  // Decode session start from sid query param (return visits) or use current time
  const sidParam = typeof req.query.sid === 'string' ? req.query.sid : '';
  const sessionStartMs = sidParam ? parseInt(sidParam, 36) : Date.now();
  const dataP = getExploreVideos(req.session.userId, sessionStartMs);
  await res.flushShell({ activeTab: 'explore' });
  try {
    const { videos, newVideoIds } = await dataP;
    const sessionId = sidParam || Date.now().toString(36);
    void Promise.resolve(db.startExploreSession(req.session.userId, sessionId));
    const allIds = videos.map(v => v.videoId);
    const durations = getDurationsForVideos(allIds);
    const liveStatuses = getLiveStatusesForVideos(allIds);
    const boostedIds = await Promise.resolve(db.getBoostedChannelIds(req.session.userId));
    const boostedSet = new Set(boostedIds);
    const queuedIds = await Promise.resolve(db.getQueuedVideoIds(req.session.userId));
    const queuedSet = new Set(queuedIds);
    const mutedIds = await Promise.resolve(db.getMutedChannelIds(req.session.userId));
    const mutedSet = new Set(mutedIds);
    const ratingRows = await Promise.resolve(db.getVideoRatings(req.session.userId));
    const ratedMap = new Map(ratingRows.map(r => [r.video_id, r.rating]));
    const newSet = new Set(newVideoIds);
    const topicFilters = await Promise.resolve(db.getTopicFilters(req.session.userId));
    await res.streamContent('explore', { videos, durations, liveStatuses, boostedSet, queuedSet, mutedSet, ratedMap, newSet, topicFilters, sessionId });
  } catch (err) {
    console.error('Explore error:', err.message);
    res.end('<p class="error">Failed to load videos</p></main><script src="/app.js"></script>\n</body>\n</html>');
  }
});

router.post('/reset', ensureAuth, async (req, res) => {
  await Promise.resolve(db.resetRecommendations(req.session.userId));
  cache.exploreVideos.delete(req.session.userId);
  res.json({ ok: true });
});

export default router;
