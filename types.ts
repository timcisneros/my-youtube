// Shared TypeScript interfaces for my-youtube

export type MaybePromise<T> = T | Promise<T>;

export interface Subscription {
  channelId: string;
  title: string;
  thumbnail: string;
  description: string;
}

export interface SubscriptionPageCursor {
  title: string;
  channelId: string;
}

export interface SavedPlaylist {
  playlist_id: string;
  playlist_type: 'youtube' | 'local';
  title: string;
  channel_title: string;
  channel_id: string;
  thumbnail_video_id: string;
  item_count_text: string;
  updated_at: string;
}

export interface LocalPlaylistItem {
  playlist_id: string;
  video_id: string;
  title: string;
  channel_title: string;
  channel_id: string;
  position: number;
  created_at: string;
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

export interface PageResult<T> {
  items: T[];
  totalResults: number;
}

export interface RSSData {
  items: Array<{ videoId: string; title: string; publishedAt: string; channelId: string }>;
  channelTitle: string;
}

export interface RSSVideoRow {
  channel_id: string;
  video_id: string;
  title: string;
  published_at: string;
  sub_title: string;
}

export interface TodayVideoRow extends RSSVideoRow {
  duration: number | null;
  live_status: string | null;
}

export interface TodayPageCursor {
  publishedAt: string;
  videoId: string;
}

export interface TimestampPageCursor {
  timestamp: string;
  id: string;
}

export interface LocalPlaylistPageCursor {
  position: number;
  createdAt: string;
  videoId: string;
}

export type CursorDirection = 'older' | 'newer';
export type PageCursorDirection = 'next' | 'previous';

export interface CursorPageResult<T> {
  items: T[];
  hasMore: boolean;
}

export interface RSSChannelStatsRow {
  channel_id: string;
  video_count: number;
  newest_published_at: string;
  median_interval_ms: number;
}

export interface RSSRefreshCandidate {
  channelId: string;
  fetchedAt: string | Date | null;
}

export interface RSSCacheValidators {
  etag?: string;
  lastModified?: string;
}

export interface ExploreWatchTimeRow {
  video_id: string;
  last_position: number;
  duration: number;
  updated_at: string;
  channel_id: string | null;
  title: string | null;
  published_at: string | null;
}

export interface VideoMetadata {
  durations: Record<string, number>;
  liveStatuses: Record<string, string>;
  tags: Record<string, string[]>;
  descriptions: Record<string, string>;
}

export interface ExploreCandidateSignals {
  videoMetadata: VideoMetadata;
  videoPopularity: Record<string, number>;
  recentVideoPopularity: Record<string, number>;
  communityRatings: Record<string, { up: number; down: number }>;
  channelSubscriberCounts: Record<string, number>;
  channelImpressionCounts: Record<string, number>;
}

export interface ExploreUserSignals {
  exploreBounces: Array<{ video_id: string; channel_id: string; bounce_seconds: number }>;
  exploreEvents: Array<{
    video_id: string;
    channel_id: string;
    event_type: string;
    impression_count: number;
    position: number;
    created_at: string;
  }>;
  topicFilterRows: Array<{ topic: string; filter: string }>;
  taggedVideoIds: string[];
  dismissedVideoIds: string[];
  boostedChannelIdRows: string[];
  mutedChannelIdRows: string[];
  queuedVideoIdRows: string[];
  ratingRows: Array<{ video_id: string; rating: number }>;
  returnChannelCounts: Record<string, number>;
  channelBehaviors: Record<string, {
    impressions: number;
    clicks: number;
    bounces: number;
    returns: number;
  }>;
  eventDurations: Record<string, number>;
}

export interface PlayerBootstrapData {
  display: {
    title: string;
    channelTitle: string;
    channelId: string;
  } | null;
  download: Download | null;
  tags: string[];
  rating: number;
  watchTime: { last_position: number; duration: number } | null;
  liveStatus: string | null;
}

export interface DatabaseAPI {
  addTag(userId: string, videoId: string, rawTag: string): MaybePromise<{ ok: boolean; tag?: string; error?: string }>;
  removeTag(userId: string, videoId: string, rawTag: string): MaybePromise<{ ok: boolean; error?: string }>;
  getTags(userId: string, videoId: string): MaybePromise<string[]>;
  upsertSubscriptions(userId: string, subs: Subscription[], opts?: { fullSync?: boolean }): MaybePromise<void>;
  getSubscriptions(userId: string): MaybePromise<Subscription[]>;
  searchSubscriptions(userId: string, query: string, limit: number, offset: number): MaybePromise<{
    items: Subscription[];
    totalResults: number;
  }>;
  getSubscriptionsCursorPage(
    userId: string,
    query: string,
    limit: number,
    cursor: SubscriptionPageCursor | null,
    direction: PageCursorDirection,
  ): MaybePromise<CursorPageResult<Subscription>>;
  deleteSubscription(userId: string, channelId: string): MaybePromise<void>;
  getRecentSubscriptionDates(userId: string, days: number): MaybePromise<Map<string, string>>;
  upsertChannel(channelId: string, title: string, thumbnail: string): MaybePromise<void>;
  getChannel(channelId: string): MaybePromise<{ channelId: string; title: string; thumbnail: string } | null>;
  getSubByChannel(channelId: string): MaybePromise<{ channelId: string; title: string; thumbnail: string } | null>;
  getRssCache(channelId: string): MaybePromise<{
    data: RSSData;
    fetchedAt: string;
    validators: RSSCacheValidators;
  } | null>;
  setRssCache(channelId: string, data: RSSData, validators?: RSSCacheValidators): MaybePromise<void>;
  touchRssCache(channelId: string, validators?: RSSCacheValidators): MaybePromise<void>;
  backfillLegacyRssBatch(limit: number): MaybePromise<number>;
  getAllRssCacheForUser(userId: string): MaybePromise<Array<{ channel_id: string; data: string; sub_title: string }>>;
  getRssVideosForUser(userId: string, publishedAfter: string | null, perChannelLimit: number, limit: number): MaybePromise<RSSVideoRow[]>;
  getRssVideosPageForUser(
    userId: string,
    publishedAfter: string | null,
    perChannelLimit: number,
    limit: number,
    offset: number,
  ): MaybePromise<PageResult<TodayVideoRow>>;
  getRssVideosCursorPageForUser(
    userId: string,
    publishedAfter: string | null,
    perChannelLimit: number,
    limit: number,
    cursor: TodayPageCursor | null,
    direction: CursorDirection,
  ): MaybePromise<CursorPageResult<TodayVideoRow>>;
  getExploreRssSnapshotForUser(userId: string, perChannelLimit: number, candidateLimit: number, watchMaxAgeDays: number, deepCutBefore: string): MaybePromise<{
    videos: RSSVideoRow[];
    channelStats: RSSChannelStatsRow[];
  }>;
  getStaleRssRefreshCandidatesForUser(userId: string, staleBefore: string, limit: number): MaybePromise<RSSRefreshCandidate[]>;
  upsertDownload(videoId: string, title: string, channelTitle: string, thumbnail: string): MaybePromise<void>;
  updateDownloadProgress(videoId: string, downloadedBytes: number, totalBytes: number): MaybePromise<void>;
  completeDownload(videoId: string): MaybePromise<void>;
  failDownload(videoId: string): MaybePromise<void>;
  deleteDownload(videoId: string): MaybePromise<void>;
  getDownload(videoId: string): MaybePromise<Download | null>;
  getAllDownloads(): MaybePromise<Download[]>;
  getDownloadsPage(limit: number, offset: number): MaybePromise<PageResult<Download>>;
  getDownloadsCursorPage(limit: number, cursor: TimestampPageCursor | null, direction: PageCursorDirection): MaybePromise<CursorPageResult<Download>>;
  getDownloadStorageUsage(): MaybePromise<{ storedBytes: number; version: number }>;
  adjustDownloadStorageBytes(deltaBytes: number): MaybePromise<number>;
  reconcileDownloadStorageBytes(storedBytes: number, expectedVersion: number): MaybePromise<boolean>;
  setDuration(videoId: string, duration: number, liveStatus?: string): MaybePromise<void>;
  getDuration(videoId: string): MaybePromise<number | null>;
  getLiveStatus(videoId: string): MaybePromise<string | null>;
  getDurations(videoIds: string[]): MaybePromise<Record<string, number>>;
  getLiveStatuses(videoIds: string[]): MaybePromise<Record<string, string>>;
  getDurationsAndLiveStatuses(videoIds: string[]): MaybePromise<{ durations: Record<string, number>; liveStatuses: Record<string, string> }>;
  getVideoDisplayMetadata(videoId: string): MaybePromise<{
    title: string;
    channelTitle: string;
    channelId: string;
  } | null>;
  getPlayerBootstrapData(userId: string, videoId: string, includeWatchTime: boolean): MaybePromise<PlayerBootstrapData>;
  setVideoTags(videoId: string, tags: string[]): MaybePromise<void>;
  getVideoTags(videoIds: string[]): MaybePromise<Record<string, string[]>>;
  setVideoDescription(videoId: string, description: string): MaybePromise<void>;
  getVideoDescriptions(videoIds: string[]): MaybePromise<Record<string, string>>;
  getVideoMetadata(videoIds: string[]): MaybePromise<VideoMetadata>;
  getExploreCandidateSignals(
    metadataVideoIds: string[], richMetadataVideoIds: string[],
    candidateVideoIds: string[], candidateChannelIds: string[],
    excludeUserId: string, recentWithinHours: number,
  ): MaybePromise<ExploreCandidateSignals>;
  getExploreUserSignals(
    userId: string,
    relevantVideoIds: string[],
    relevantChannelIds: string[],
    maxAgeDays?: number,
  ): MaybePromise<ExploreUserSignals>;
  getCoWatchedVideos(
    videoIds: string[], excludeUserId: string, limit: number,
    maxAgeDays?: number, maxUsers?: number,
  ): MaybePromise<Array<{ video_id: string; score: number }>>;
  setWatchTime(userId: string, videoId: string, position: number, duration: number): MaybePromise<void>;
  getWatchTime(userId: string, videoId: string): MaybePromise<{ last_position: number; duration: number } | null>;
  getWatchTimes(userId: string, videoIds: string[]): MaybePromise<Record<string, { last_position: number; duration: number }>>;
  getAllWatchTimesForUser(userId: string): MaybePromise<Array<{ video_id: string; last_position: number; duration: number; updated_at: string }>>;
  getExploreWatchTimes(userId: string, maxAgeDays: number, limit: number): MaybePromise<ExploreWatchTimeRow[]>;
  getAllTaggedVideoIds(userId: string): MaybePromise<string[]>;
  upsertRelatedVideos(sourceVideoId: string, videos: Array<{
    videoId: string; title: string; channelTitle: string;
    channelId: string; publishedText: string;
  }>): MaybePromise<void>;
  getRelatedVideosForSources(sourceVideoIds: string[]): MaybePromise<Array<{
    source_video_id: string; video_id: string; title: string;
    channel_title: string; channel_id: string; published_text: string;
  }>>;
  pruneRelatedVideos(maxAgeDays: number, limit?: number): MaybePromise<number>;
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
  getQueuedVideosPage(userId: string, limit: number, offset: number): MaybePromise<PageResult<{ video_id: string; title: string; channel_title: string; channel_id: string; created_at: string }>>;
  getQueuedVideosCursorPage(userId: string, limit: number, cursor: TimestampPageCursor | null, direction: PageCursorDirection): MaybePromise<CursorPageResult<{ video_id: string; title: string; channel_title: string; channel_id: string; created_at: string }>>;
  getQueuedVideoIds(userId: string): MaybePromise<string[]>;
  savePlaylist(userId: string, playlistId: string, title: string, channelTitle: string, channelId: string, thumbnailVideoId: string, itemCountText: string, playlistType?: 'youtube' | 'local'): MaybePromise<void>;
  unsavePlaylist(userId: string, playlistId: string): MaybePromise<void>;
  getSavedPlaylists(userId: string): MaybePromise<SavedPlaylist[]>;
  getSavedYoutubePlaylistIds(userId: string, limit: number): MaybePromise<string[]>;
  getSavedPlaylistsPage(userId: string, limit: number, offset: number): MaybePromise<PageResult<SavedPlaylist>>;
  getSavedPlaylistsCursorPage(userId: string, limit: number, cursor: TimestampPageCursor | null, direction: PageCursorDirection): MaybePromise<CursorPageResult<SavedPlaylist>>;
  getSavedPlaylist(userId: string, playlistId: string): MaybePromise<SavedPlaylist | null>;
  isPlaylistSaved(userId: string, playlistId: string): MaybePromise<boolean>;
  addLocalPlaylistItem(userId: string, playlistId: string, videoId: string, title: string, channelTitle: string, channelId: string): MaybePromise<void>;
  removeLocalPlaylistItem(userId: string, playlistId: string, videoId: string): MaybePromise<void>;
  moveLocalPlaylistItem(userId: string, playlistId: string, videoId: string, direction: 'up' | 'down'): MaybePromise<void>;
  getLocalPlaylistItems(userId: string, playlistId: string): MaybePromise<LocalPlaylistItem[]>;
  getLocalPlaylistItemsPage(userId: string, playlistId: string, limit: number, offset: number): MaybePromise<PageResult<LocalPlaylistItem>>;
  getLocalPlaylistItemsCursorPage(userId: string, playlistId: string, limit: number, cursor: LocalPlaylistPageCursor | null, direction: PageCursorDirection): MaybePromise<CursorPageResult<LocalPlaylistItem>>;
  getLocalPlaylistSummary(userId: string, playlistId: string): MaybePromise<{ totalResults: number; thumbnailVideoId: string }>;
  muteChannel(userId: string, channelId: string): MaybePromise<void>;
  unmuteChannel(userId: string, channelId: string): MaybePromise<void>;
  getMutedChannelIds(userId: string): MaybePromise<string[]>;
  rateVideo(userId: string, videoId: string, rating: number): MaybePromise<void>;
  unrateVideo(userId: string, videoId: string): MaybePromise<void>;
  getVideoRatings(userId: string): MaybePromise<Array<{ video_id: string; rating: number }>>;
  getVideoRating(userId: string, videoId: string): MaybePromise<number>;
  getCommunityRatings(videoIds: string[], excludeUserId: string): MaybePromise<Record<string, { up: number; down: number }>>;
  setTopicFilter(userId: string, topic: string, filter: string): MaybePromise<void>;
  removeTopicFilter(userId: string, topic: string): MaybePromise<void>;
  getTopicFilters(userId: string): MaybePromise<Array<{ topic: string; filter: string }>>;
  logExploreImpressions(userId: string, videos: Array<{ videoId: string; channelId: string; position: number }>): MaybePromise<void>;
  logExploreClick(userId: string, videoId: string, channelId: string): MaybePromise<void>;
  getExploreEventsForUser(userId: string, maxAgeDays?: number): MaybePromise<Array<{ video_id: string; channel_id: string; event_type: string; impression_count: number; position: number; created_at: string }>>;
  pruneExploreEvents(maxAgeDays: number, limit?: number): MaybePromise<number>;
  startExploreSession(userId: string, sessionId: string): MaybePromise<void>;
  updateExploreSession(userId: string, sessionId: string, clicks: number, totalWatchSeconds: number, bestCompletion: number): MaybePromise<void>;
  getRecentExploreSessions(userId: string, limit: number): MaybePromise<Array<{ session_id: string; clicks: number; total_watch_seconds: number; best_completion: number; started_at: string }>>;
  getExploreSessionsForBackfill(userId: string): MaybePromise<Array<{ session_id: string; clicks: number; total_watch_seconds: number; best_completion: number; observed_best_completion: number; started_at: string }>>;
  pruneExploreSessions(maxAgeDays: number, limit?: number): MaybePromise<number>;
  logExploreBounce(userId: string, videoId: string, channelId: string, bounceSeconds: number): MaybePromise<void>;
  getExploreBounces(userId: string, maxAgeDays?: number): MaybePromise<Array<{ video_id: string; channel_id: string; bounce_seconds: number }>>;
  logExploreReturn(userId: string, videoId: string, channelId: string): MaybePromise<void>;
  getExploreReturnChannels(userId: string): MaybePromise<Record<string, number>>;
  getVideoPopularity(videoIds: string[]): MaybePromise<Record<string, number>>;
  getRecentVideoPopularity(videoIds: string[], withinHours: number): MaybePromise<Record<string, number>>;
  getChannelSubscriberCounts(channelIds: string[], excludeUserId: string): MaybePromise<Record<string, number>>;
  getChannelImpressionCounts(channelIds: string[]): MaybePromise<Record<string, number>>;
  rebuildExploreSignalRollups(maxAgeDays?: number, perUserLimit?: number): MaybePromise<{
    videos: number;
    channels: number;
    cowatchEdges: number;
  }>;
  pruneExploreCowatchEdges(maxAgeDays: number, limit?: number): MaybePromise<number>;
  resetRecommendations(userId: string): MaybePromise<void>;
  optimizeDatabase?: () => MaybePromise<boolean>;
  claimMaintenanceLease(name: string, leaseSeconds: number): MaybePromise<boolean>;
  hasSchemaMigration(name: string): MaybePromise<boolean>;
  recordSchemaMigration(name: string): MaybePromise<void>;
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
