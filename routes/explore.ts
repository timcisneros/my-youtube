import { Router } from 'express';
import { ensureAuth } from '../auth.js';
import db from '../db.js';
import { cache } from '../youtube/shared.js';
import { formatDuration, getExploreVideos, getDurationsAndLiveStatuses } from '../youtube/index.js';

const router = Router();

router.get('/', ensureAuth, async (req, res) => {
  // Decode session start from sid query param (return visits) or use current time
  const sidParam = typeof req.query.sid === 'string' ? req.query.sid : '';
  const sessionStartMs = sidParam ? parseInt(sidParam, 36) : Date.now();
  const dataP = getExploreVideos(req.session.userId, sessionStartMs);
  await res.flushShell({ activeTab: 'explore' });
  try {
    const {
      videos,
      newVideoIds,
      boostedChannelIds,
      queuedVideoIds,
      mutedChannelIds,
      ratings,
      topicFilters,
      durationSeconds,
      liveStatuses: rankedLiveStatuses,
    } = await dataP;
    const sessionId = sidParam || Date.now().toString(36);
    void Promise.resolve(db.startExploreSession(req.session.userId, sessionId)).catch(() => {});
    const allIds = videos.map(v => v.videoId);
    let durations: Record<string, string>;
    let liveStatuses: Record<string, string>;
    if (durationSeconds && rankedLiveStatuses) {
      durations = {};
      for (const id of allIds) {
        const duration = durationSeconds[id];
        if (duration > 0) durations[id] = formatDuration(duration);
      }
      liveStatuses = rankedLiveStatuses;
    } else {
      // Compatibility for snapshots produced by an older worker during a
      // rolling deployment. New snapshots already carry render metadata.
      ({ durations, liveStatuses } = await getDurationsAndLiveStatuses(allIds));
    }
    const boostedSet = new Set(boostedChannelIds);
    const queuedSet = new Set(queuedVideoIds);
    const mutedSet = new Set(mutedChannelIds);
    const ratedMap = new Map(ratings.map(r => [r.video_id, r.rating]));
    const newSet = new Set(newVideoIds);
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
