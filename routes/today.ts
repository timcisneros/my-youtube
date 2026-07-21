import { Router } from 'express';
import { ensureAuth } from '../auth.js';
import { getTodayVideos, getDurationsAndLiveStatuses } from '../youtube/index.js';

const router = Router();

router.get('/', ensureAuth, async (req, res) => {
  const dataP = getTodayVideos(req.session.userId);
  await res.flushShell({ activeTab: 'today', showTodayLoading: true });
  try {
    const videos = await dataP;
    const ids = videos.map(v => v.videoId);
    const { durations, liveStatuses } = getDurationsAndLiveStatuses(ids);
    await res.streamContent('today', { videos, durations, liveStatuses });
  } catch (err) {
    console.error('Today error:', err.message);
    await res.streamContent('today', {
      videos: [],
      durations: {},
      liveStatuses: {},
      error: 'Could not load your subscriptions. Please try again.',
    });
  }
});

export default router;
