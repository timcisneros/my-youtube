import { Router } from 'express';
import { ensureAuth } from '../auth.js';
import { getTodayVideosPage } from '../youtube/index.js';

const router = Router();

router.get('/', ensureAuth, async (req, res) => {
  const dataP = getTodayVideosPage(req.session.userId, req.query.cursor);
  await res.flushShell({ activeTab: 'today', showTodayLoading: true });
  try {
    const page = await dataP;
    await res.streamContent('today', page);
  } catch (err) {
    console.error('Today error:', err.message);
    await res.streamContent('today', {
      videos: [],
      durations: {},
      liveStatuses: {},
      prevCursor: null,
      nextCursor: null,
      error: 'Could not load your subscriptions. Please try again.',
    });
  }
});

export default router;
