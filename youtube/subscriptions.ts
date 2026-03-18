/**
 * Subscription management — fetching and caching user subscriptions.
 */
import db from '../db.js';
import { cache, SUB_TTL } from './shared.js';

// Get all subscriptions — memory cache -> SQLite -> empty
async function getAllSubscriptions(userId) {
  const cached = cache.subscriptions.get(userId);
  if (cached && Date.now() < cached.expires) return cached.data;
  if (cached) return cached.data; // serve stale

  const rows = db.getSubscriptions(userId);
  if (rows.length > 0) {
    cache.subscriptions.set(userId, { data: rows, expires: Date.now() + SUB_TTL });
  }
  return rows;
}

// Numeric pagination (20/page) from getAllSubscriptions
async function getSubscriptionsPage(userId, page) {
  const all = await getAllSubscriptions(userId);
  const perPage = 20;
  const p = Math.max(1, parseInt(page) || 1);
  const start = (p - 1) * perPage;
  const items = all.slice(start, start + perPage);
  const totalPages = Math.ceil(all.length / perPage);
  return {
    items,
    nextPage: p < totalPages ? p + 1 : null,
    prevPage: p > 1 ? p - 1 : null,
    totalResults: all.length
  };
}

function invalidateSubCaches(userId) {
  cache.subscriptions.delete(userId);
  cache.todayVideos.delete(userId);
  cache.exploreVideos.delete(userId);
}

export { getAllSubscriptions, getSubscriptionsPage, invalidateSubCaches };
