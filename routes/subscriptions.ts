import { Router } from 'express';
import { ensureAuth } from '../auth.js';
import { getSubscriptionSearchPage, getSubscriptionsPage } from '../youtube/index.js';

const router = Router();

router.get('/', ensureAuth, async (req, res) => {
  const searchQuery = String(req.query.q || '').trim().slice(0, 200);
  const dataP = req.query.q != null
    ? getSubscriptionSearchPage(req.session.userId, searchQuery, req.query.cursor)
    : getSubscriptionsPage(req.session.userId, req.query.cursor);
  await res.flushShell({ activeTab: 'subscriptions' });
  try {
    const page = await dataP;
    await res.streamContent('subscriptions', {
      ...page,
      searchQuery: req.query.q != null ? searchQuery : '',
    });
  } catch (err) {
    console.error('Subscriptions error:', err.message);
    res.end('<p class="error">Failed to load subscriptions</p></main><script src="/app.js"></script>\n</body>\n</html>');
  }
});

export default router;
