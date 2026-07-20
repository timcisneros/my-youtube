/**
 * Shared cache instances, TTL constants, and YouTube request semaphore.
 * Used by all youtube/ sub-modules.
 */
import LRUMap from '../lib/lru-map.js';
import { SharedLRUMap } from '../lib/cache.js';

// In-memory cache (LRU-bounded to prevent OOM)
// Shared caches use SharedLRUMap for Redis write-through across workers
// Per-user caches stay as plain LRUMap (user-scoped, not worth sharing)
const cache = {
  subscriptions: new LRUMap(100), // userId -> { data, expires } (per-user)
  todayVideos: new LRUMap(100),   // userId -> { data, expires } (per-user)
  exploreVideos: new SharedLRUMap(100, 'explore'), // userId -> { data, expires } (shared across workers)
  channelInfo: new SharedLRUMap(500, 'ch'),   // channelId -> { data, expires }
  videoDetails: new SharedLRUMap(2000, 'vid'), // videoId -> { data, expires }
  playlists: new SharedLRUMap(300, 'pl'),      // playlistId -> { data, expires }
  rss: new SharedLRUMap(1000, 'rss'),          // channelId -> { data, expires }
};

const SUB_TTL = 6 * 60 * 60 * 1000;      // 6 hours
const TODAY_TTL = 30 * 60 * 1000;         // 30 minutes
const EXPLORE_TTL = 15 * 60 * 1000;       // 15 minutes
const CHANNEL_TTL = 60 * 60 * 1000;       // 1 hour
const VIDEO_DETAILS_TTL = 24 * 60 * 60 * 1000; // 24 hours
const PLAYLIST_TTL = 30 * 60 * 1000;      // 30 minutes
const RSS_TTL = 15 * 60 * 1000;          // 15 minutes

// Global semaphore — caps concurrent outbound YouTube HTTP requests to prevent IP bans
const MAX_CONCURRENT_YT_REQUESTS = 30;
let _activeYtRequests = 0;
const _ytRequestQueue = [];

async function withYtSlot(fn) {
  if (_activeYtRequests >= MAX_CONCURRENT_YT_REQUESTS) {
    await new Promise(resolve => _ytRequestQueue.push(resolve));
  }
  _activeYtRequests++;
  try {
    return await fn();
  } finally {
    _activeYtRequests--;
    if (_ytRequestQueue.length) _ytRequestQueue.shift()();
  }
}

// Periodic cache sweep — prevents unbounded growth from one-time entries
const cacheSweepTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of cache.subscriptions) {
    if (now > entry.expires) cache.subscriptions.delete(key);
  }
  for (const [key, entry] of cache.todayVideos) {
    if (now > entry.expires) cache.todayVideos.delete(key);
  }
  for (const [key, entry] of cache.exploreVideos) {
    if (now > entry.expires) cache.exploreVideos.delete(key);
  }
  for (const [key, entry] of cache.channelInfo) {
    if (now > entry.expires) cache.channelInfo.delete(key);
  }
  for (const [key, entry] of cache.videoDetails) {
    if (now > entry.expires) cache.videoDetails.delete(key);
  }
  for (const [key, entry] of cache.playlists) {
    if (now > entry.expires) cache.playlists.delete(key);
  }
  for (const [key, entry] of cache.rss) {
    if (now > entry.expires) cache.rss.delete(key);
  }
}, 10 * 60 * 1000);
if (typeof cacheSweepTimer.unref === 'function') cacheSweepTimer.unref();

export {
  cache, LRUMap, withYtSlot,
  SUB_TTL, TODAY_TTL, EXPLORE_TTL, CHANNEL_TTL, VIDEO_DETAILS_TTL, PLAYLIST_TTL, RSS_TTL,
};
