import { Router } from 'express';
import { ensureAuth } from '../auth.js';
import { getAllSubscriptions, getSubscriptionsPage } from '../youtube/index.js';

const router = Router();

router.get('/', ensureAuth, async (req, res) => {
  const dataP = req.query.q != null
    ? getAllSubscriptions(req.session.userId)
    : getSubscriptionsPage(req.session.userId, req.query.page);
  await res.flushShell({ activeTab: 'subscriptions' });
  try {
    if (req.query.q != null) {
      const all = await dataP;
      const q = (req.query.q as string).toLowerCase();
      const filtered = q ? all.filter(s => s.title.toLowerCase().includes(q)) : all;
      return await res.streamContent('subscriptions', {
        items: filtered, nextPage: null, prevPage: null,
        totalResults: all.length, searchQuery: req.query.q
      });
    }

    const page = await dataP;
    await res.streamContent('subscriptions', { ...page, searchQuery: '' });
  } catch (err) {
    console.error('Subscriptions error:', err.message);
    res.end('<p class="error">Failed to load subscriptions</p></main><script src="/app.js"></script>\n</body>\n</html>');
  }
});

export default router;
