import { Router } from 'express';
import { ensureAuth } from '../auth.js';
import { getTodayVideos, getDurationsAndLiveStatuses } from '../youtube/index.js';

const router = Router();

router.get('/', ensureAuth, async (req, res) => {
  const dataP = getTodayVideos(req.session.userId);
  await res.flushShell({ activeTab: 'today' });
  try {
    const videos = await dataP;
    const ids = videos.map(v => v.videoId);
    const { durations, liveStatuses } = getDurationsAndLiveStatuses(ids);
    await res.streamContent('today', { videos, durations, liveStatuses });
  } catch (err) {
    console.error('Today error:', err.message);
    res.end('<p class="error">Failed to load videos</p></main><script src="/app.js"></script>\n</body>\n</html>');
  }
});

export default router;
