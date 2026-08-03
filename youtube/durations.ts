/**
 * Duration helpers — fetch, cache, and format video durations.
 */
import db from '../db.js';
import { cache } from './shared.js';

function getCachedDuration(videoId) {
  const cached = cache.videoDetails.get(videoId);
  return (cached && cached.data && cached.data.duration) || null;
}

function formatDuration(s) {
  s = Math.floor(s);
  var h = Math.floor(s / 3600);
  var m = Math.floor((s % 3600) / 60);
  var sec = s % 60;
  if (h > 0) return h + ':' + (m < 10 ? '0' : '') + m + ':' + (sec < 10 ? '0' : '') + sec;
  return m + ':' + (sec < 10 ? '0' : '') + sec;
}

// Returns a map of videoId -> formatted duration string from DB (instant, non-blocking).
async function getDurationsForVideos(videoIds: string[]) {
  const unique = [...new Set(videoIds)];
  const dbDurations = await db.getDurations(unique);
  const result: Record<string, string> = {};
  for (const id of unique) {
    if (dbDurations[id]) result[id] = formatDuration(dbDurations[id]);
  }
  return result;
}

// Single query returning both formatted durations and live statuses.
async function getDurationsAndLiveStatuses(videoIds: string[]) {
  const unique = [...new Set(videoIds)];
  const raw = await db.getDurationsAndLiveStatuses(unique);
  const durations: Record<string, string> = {};
  for (const id of unique) {
    if (raw.durations[id]) durations[id] = formatDuration(raw.durations[id]);
  }
  return { durations, liveStatuses: raw.liveStatuses };
}

export { formatDuration, getCachedDuration, getDurationsForVideos, getDurationsAndLiveStatuses };
