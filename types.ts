// Shared TypeScript interfaces for my-youtube

export type MaybePromise<T> = T | Promise<T>;

export interface Subscription {
  channelId: string;
  title: string;
  thumbnail: string;
  description: string;
}

export interface Download {
  video_id: string;
  title: string;
  channel_title: string;
  thumbnail: string;
  status: 'downloading' | 'complete' | 'error';
  total_bytes: number;
  downloaded_bytes: number;
  created_at: string;
}

export interface RSSData {
  items: Array<{ videoId: string; title: string; publishedAt: string; channelId: string }>;
  channelTitle: string;
}

export interface DatabaseAPI {
  addTag(userId: string, videoId: string, rawTag: string): MaybePromise<{ ok: boolean; tag?: string; error?: string }>;
  removeTag(userId: string, videoId: string, rawTag: string): MaybePromise<{ ok: boolean; error?: string }>;
  getTags(userId: string, videoId: string): MaybePromise<string[]>;
  upsertSubscriptions(userId: string, subs: Subscription[], opts?: { fullSync?: boolean }): MaybePromise<void>;
  getSubscriptions(userId: string): MaybePromise<Subscription[]>;
  deleteSubscription(userId: string, channelId: string): MaybePromise<void>;
  getRecentSubscriptionChannelIds(userId: string, days: number): MaybePromise<string[]>;
  getSubscriptionDates(userId: string, channelIds: string[]): MaybePromise<Map<string, string>>;
  upsertChannel(channelId: string, title: string, thumbnail: string): MaybePromise<void>;
  getChannel(channelId: string): MaybePromise<{ channelId: string; title: string; thumbnail: string } | null>;
  getSubByChannel(channelId: string): MaybePromise<{ channelId: string; title: string; thumbnail: string } | null>;
  getRssCache(channelId: string): MaybePromise<{ data: RSSData; fetchedAt: string } | null>;
  setRssCache(channelId: string, data: RSSData): MaybePromise<void>;
  getAllRssCacheForUser(userId: string): MaybePromise<Array<{ channel_id: string; data: string; sub_title: string }>>;
  upsertDownload(videoId: string, title: string, channelTitle: string, thumbnail: string): MaybePromise<void>;
  updateDownloadProgress(videoId: string, downloadedBytes: number, totalBytes: number): MaybePromise<void>;
  completeDownload(videoId: string): MaybePromise<void>;
  failDownload(videoId: string): MaybePromise<void>;
  deleteDownload(videoId: string): MaybePromise<void>;
  getDownload(videoId: string): MaybePromise<Download | null>;
  getAllDownloads(): MaybePromise<Download[]>;
  setDuration(videoId: string, duration: number, liveStatus?: string): MaybePromise<void>;
  getDuration(videoId: string): MaybePromise<number | null>;
  getLiveStatus(videoId: string): MaybePromise<string | null>;
  getDurations(videoIds: string[]): MaybePromise<Record<string, number>>;
  getLiveStatuses(videoIds: string[]): MaybePromise<Record<string, string>>;
  setVideoTags(videoId: string, tags: string[]): MaybePromise<void>;
  getVideoTags(videoIds: string[]): MaybePromise<Record<string, string[]>>;
  setVideoDescription(videoId: string, description: string): MaybePromise<void>;
  getVideoDescriptions(videoIds: string[]): MaybePromise<Record<string, string>>;
  getCoWatchedVideos(videoIds: string[], excludeUserId: string, limit: number): MaybePromise<Array<{ video_id: string; score: number }>>;
  setWatchTime(userId: string, videoId: string, position: number, duration: number): MaybePromise<void>;
  getWatchTime(userId: string, videoId: string): MaybePromise<{ last_position: number; duration: number } | null>;
  getWatchTimes(userId: string, videoIds: string[]): MaybePromise<Record<string, { last_position: number; duration: number }>>;
  getAllWatchTimesForUser(userId: string): MaybePromise<Array<{ video_id: string; last_position: number; duration: number; updated_at: string }>>;
  getAllTaggedVideoIds(userId: string): MaybePromise<string[]>;
  upsertRelatedVideos(sourceVideoId: string, videos: Array<{
    videoId: string; title: string; channelTitle: string;
    channelId: string; publishedText: string;
  }>): MaybePromise<void>;
  getRelatedVideosForSources(sourceVideoIds: string[]): MaybePromise<Array<{
    source_video_id: string; video_id: string; title: string;
    channel_title: string; channel_id: string; published_text: string;
  }>>;
  pruneRelatedVideos(maxAgeDays: number): MaybePromise<number>;
  dismissVideo(userId: string, videoId: string, channelId?: string): MaybePromise<void>;
  undismissVideo(userId: string, videoId: string): MaybePromise<void>;
  getDismissedVideoIds(userId: string): MaybePromise<string[]>;
  getDismissalCountByChannel(userId: string, channelId: string): MaybePromise<number>;
  boostChannel(userId: string, channelId: string): MaybePromise<void>;
  unboostChannel(userId: string, channelId: string): MaybePromise<void>;
  getBoostedChannelIds(userId: string): MaybePromise<string[]>;
  queueVideo(userId: string, videoId: string, title: string, channelTitle: string, channelId: string): MaybePromise<void>;
  unqueueVideo(userId: string, videoId: string): MaybePromise<void>;
  getQueuedVideos(userId: string): MaybePromise<Array<{ video_id: string; title: string; channel_title: string; channel_id: string; created_at: string }>>;
  getQueuedVideoIds(userId: string): MaybePromise<string[]>;
  muteChannel(userId: string, channelId: string): MaybePromise<void>;
  unmuteChannel(userId: string, channelId: string): MaybePromise<void>;
  getMutedChannelIds(userId: string): MaybePromise<string[]>;
  rateVideo(userId: string, videoId: string, rating: number): MaybePromise<void>;
  unrateVideo(userId: string, videoId: string): MaybePromise<void>;
  getVideoRatings(userId: string): MaybePromise<Array<{ video_id: string; rating: number }>>;
  getCommunityRatings(videoIds: string[], excludeUserId: string): MaybePromise<Record<string, { up: number; down: number }>>;
  setTopicFilter(userId: string, topic: string, filter: string): MaybePromise<void>;
  removeTopicFilter(userId: string, topic: string): MaybePromise<void>;
  getTopicFilters(userId: string): MaybePromise<Array<{ topic: string; filter: string }>>;
  logExploreImpressions(userId: string, videos: Array<{ videoId: string; channelId: string; position: number }>): MaybePromise<void>;
  logExploreClick(userId: string, videoId: string, channelId: string): MaybePromise<void>;
  getExploreEventsForUser(userId: string): MaybePromise<Array<{ video_id: string; channel_id: string; event_type: string; impression_count: number; position: number; created_at: string }>>;
  pruneExploreEvents(maxAgeDays: number): MaybePromise<number>;
  startExploreSession(userId: string, sessionId: string): MaybePromise<void>;
  updateExploreSession(userId: string, sessionId: string, clicks: number, totalWatchSeconds: number, bestCompletion: number): MaybePromise<void>;
  getRecentExploreSessions(userId: string, limit: number): MaybePromise<Array<{ session_id: string; clicks: number; total_watch_seconds: number; best_completion: number; started_at: string }>>;
  getExploreSessionsForBackfill(userId: string): MaybePromise<Array<{ session_id: string; clicks: number; total_watch_seconds: number; best_completion: number; started_at: string }>>;
  pruneExploreSessions(maxAgeDays: number): MaybePromise<number>;
  logExploreBounce(userId: string, videoId: string, channelId: string, bounceSeconds: number): MaybePromise<void>;
  getExploreBounces(userId: string): MaybePromise<Array<{ video_id: string; channel_id: string; bounce_seconds: number }>>;
  logExploreReturn(userId: string, videoId: string, channelId: string): MaybePromise<void>;
  getExploreReturnChannels(userId: string): MaybePromise<Record<string, number>>;
  getVideoPopularity(videoIds: string[]): MaybePromise<Record<string, number>>;
  getRecentVideoPopularity(videoIds: string[], withinHours: number): MaybePromise<Record<string, number>>;
  getChannelSubscriberCounts(channelIds: string[], excludeUserId: string): MaybePromise<Record<string, number>>;
  getChannelImpressionCounts(channelIds: string[]): MaybePromise<Record<string, number>>;
  resetRecommendations(userId: string): MaybePromise<void>;
  runInSavepoint<T>(fn: () => T): MaybePromise<T>;
  _ready?: Promise<void>;
}

/** Unwrap MaybePromise to its sync (non-Promise) branch */
type UnwrapMaybePromise<T> = T extends Promise<infer U> ? U : T;

/** DatabaseAPI with all MaybePromise return types resolved to their sync values.
 *  Used by db.ts (SQLite) where every method is synchronous. */
export type SyncDatabaseAPI = {
  [K in keyof DatabaseAPI]: DatabaseAPI[K] extends (...args: infer A) => infer R
    ? (...args: A) => UnwrapMaybePromise<R>
    : DatabaseAPI[K];
};
