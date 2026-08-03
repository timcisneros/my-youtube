/**
 * Subscription management — fetching and caching user subscriptions.
 */
import db from '../db.js';
import {
  buildCursorNavigation,
  decodeSubscriptionCursor,
  encodeSubscriptionCursor,
} from '../lib/cursor-pagination.js';
import { cache } from './shared.js';
import { invalidateTodayCache } from './today.js';

const SUBSCRIPTIONS_PAGE_SIZE = 20;

async function getSubscriptionCursorPage(userId: string, query: string, rawCursor: unknown) {
  const cursor = decodeSubscriptionCursor(rawCursor);
  const direction = cursor?.direction || 'next';
  const page = await db.getSubscriptionsCursorPage(
    userId,
    query,
    SUBSCRIPTIONS_PAGE_SIZE,
    cursor,
    direction,
  );
  const navigation = buildCursorNavigation(
    page.items,
    page.hasMore,
    cursor !== null,
    direction,
    (item, nextDirection) => encodeSubscriptionCursor(item.title, item.channelId, nextDirection),
  );
  return { items: page.items, ...navigation };
}

async function getSubscriptionsPage(userId: string, cursor: unknown) {
  return getSubscriptionCursorPage(userId, '', cursor);
}

async function getSubscriptionSearchPage(userId: string, query: string, cursor: unknown) {
  const normalizedQuery = String(query || '').trim().slice(0, 200);
  return {
    ...await getSubscriptionCursorPage(userId, normalizedQuery, cursor),
    searchQuery: normalizedQuery,
  };
}

async function invalidateSubCaches(userId: string) {
  await Promise.all([
    cache.subscriptions.deleteAsync(userId),
    invalidateTodayCache(userId),
    cache.exploreVideos.deleteAsync(userId),
  ]);
}

export {
  getSubscriptionsPage,
  getSubscriptionSearchPage,
  invalidateSubCaches,
};
