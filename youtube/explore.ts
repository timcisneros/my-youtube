/**
 * Explore page — surfaces unwatched videos from subscribed channels,
 * ranked by a local algorithm using watch history, tags, and recency.
 */
import db from '../db.js';
import logger from '../lib/logger.js';
import { cache, EXPLORE_TTL } from './shared.js';
import { tokenize, computeExploreMetrics, ensureTopicDiversity } from './explore-metrics.js';
import { performance } from 'node:perf_hooks';

interface ExploreVideo {
  videoId: string;
  title: string;
  thumbnail: string;
  channelTitle: string;
  channelId: string;
  publishedAt: string;
  reason?: string;
}

interface ExploreResult {
  videos: ExploreVideo[];
  continueWatching: ExploreVideo[]; // deprecated — kept for interface compat
  newVideoIds: string[];
}

/** Typed configuration for all explore algorithm weights, thresholds, and slot counts. */
interface ExploreConfig {
  // Core weights
  affinityWeight: number;
  recencyWeight: number;
  topicCap: number;
  velocityWeight: number;
  cadenceWeight: number;
  todWeight: number;
  channelRecencyWeight: number;
  dowWeight: number;
  // Boosts/penalties
  sessionBoost: number;
  seriesBoost: number;
  seriesNextBoost: number;
  bingeBoost: number;
  bingeExhaustPenalty: number;
  shortsPenalty: number;
  liveBoost: number;
  upcomingBoost: number;
  emergingBoost: number;
  personalRatingUpBoost: number;
  personalRatingDownPenalty: number;
  communityRatingWeight: number;
  communityRatingCap: number;
  ratingChannelBoost: number;
  ratingChannelCap: number;
  popularityWeight: number;
  popularityCap: number;
  trendingWeight: number;
  trendingCap: number;
  cowatchWeight: number;
  cowatchCap: number;
  tagSimilarityWeight: number;
  descSimilarityWeight: number;
  topicFilterBoost: number;
  topicFilterSuppress: number;
  negativeKeywordPenalty: number;
  momentumWeight: number;
  urgencyMax: number;
  returnBoost: number;
  queueChannelBoost: number;
  queueChannelCap: number;
  rewatchPenalty: number;
  rewatchPenaltySlow: number;
  // Half-lives
  affinityHalfLifeDays: number;
  velocityHalfLifeMs: number;
  ctrHalfLifeDays: number;
  channelRecencyHalfLifeHours: number;
  momentumHalfLifeHours: number;
  // Thresholds
  shortsDurationThreshold: number;
  channelStalenessThresholdDays: number;
  dormancyThresholdDays: number;
  bingeThreshold: number;
  bingeExhaustThreshold: number;
  minSeriesWatches: number;
  seriesGapTolerance: number;
  // Slots
  baseDeepCutSlots: number;
  baseExplorationSlots: number;
  diversitySlots: number;
  topCount: number;
  emergingSlots: number;
  // Cold start overrides
  coldStartPopularityWeight: number;
  coldStartPopularityCap: number;
  coldStartCommunityRatingWeight: number;
  coldStartCommunityRatingCap: number;
}

const DEFAULT_EXPLORE_CONFIG: ExploreConfig = {
  // Core weights
  affinityWeight: 0.32,
  recencyWeight: 0.25,
  topicCap: 0.15,
  velocityWeight: 0.07,
  cadenceWeight: 0.05,
  todWeight: 0.05,
  channelRecencyWeight: 0.04,
  dowWeight: 0.03,
  // Boosts/penalties
  sessionBoost: 0.12,
  seriesBoost: 0.10,
  seriesNextBoost: 0.15,
  bingeBoost: 0.08,
  bingeExhaustPenalty: -0.04,
  shortsPenalty: -0.04,
  liveBoost: 0.10,
  upcomingBoost: 0.04,
  emergingBoost: 0.06,
  personalRatingUpBoost: 0.15,
  personalRatingDownPenalty: -0.10,
  communityRatingWeight: 0.04,
  communityRatingCap: 0.04,
  ratingChannelBoost: 0.05,
  ratingChannelCap: 0.20,
  popularityWeight: 0.03,
  popularityCap: 0.06,
  trendingWeight: 0.04,
  trendingCap: 0.08,
  cowatchWeight: 0.05,
  cowatchCap: 0.08,
  tagSimilarityWeight: 0.06,
  descSimilarityWeight: 0.04,
  topicFilterBoost: 0.06,
  topicFilterSuppress: -0.06,
  negativeKeywordPenalty: -0.03,
  momentumWeight: 0.05,
  urgencyMax: 0.06,
  returnBoost: 0.04,
  queueChannelBoost: 0.08,
  queueChannelCap: 0.24,
  rewatchPenalty: -0.15,
  rewatchPenaltySlow: -0.05,
  // Half-lives
  affinityHalfLifeDays: 14,
  velocityHalfLifeMs: 48 * 60 * 60 * 1000,
  ctrHalfLifeDays: 21,
  channelRecencyHalfLifeHours: 168,
  momentumHalfLifeHours: 24,
  // Thresholds
  shortsDurationThreshold: 60,
  channelStalenessThresholdDays: 60,
  dormancyThresholdDays: 45,
  bingeThreshold: 3,
  bingeExhaustThreshold: 5,
  minSeriesWatches: 2,
  seriesGapTolerance: 3,
  // Slots
  baseDeepCutSlots: 4,
  baseExplorationSlots: 6,
  diversitySlots: 6,
  topCount: 60,
  emergingSlots: 2,
  // Cold start overrides
  coldStartPopularityWeight: 0.08,
  coldStartPopularityCap: 0.12,
  coldStartCommunityRatingWeight: 0.10,
  coldStartCommunityRatingCap: 0.08,
};

const CHANNEL_STALENESS_FLOOR = 0.5;
const DORMANCY_FLOOR = 0.6;
const DOW_SLOTS = 7;
const MIN_DOW_WATCHES = 5;
const COMMUNITY_BASE_MIN = 0.1;
const COMMUNITY_BASE_MAX = 0.25;
const DEEP_CUT_MIN_AGE_DAYS = 7;
const EXPLORATION_POOL_START = 30;
const EXPLORATION_POOL_END = 100;
const REWATCH_COMPLETION_THRESHOLD = 0.8;
const REWATCH_MIN_WATCHES = 5;
const REWATCH_PENALTY_EVERGREEN = 0;
const DECAY_TIER_FAST = 0;
const DECAY_TIER_NORMAL = 1;
const DECAY_TIER_SLOW = 2;
const DECAY_TIER_EVERGREEN = 3;
const DECAY_HALF_LIVES = [24, 72, 336, 2016]; // hours: 1d, 3d, 14d, 12w
const WATCH_TIME_REFERENCE_SECONDS = 600; // 10 minutes — neutral point for duration weighting
const SESSION_DUR_PENALTY_CAP = 0.04;
const SESSION_DUR_SCALE = 0.015;
const TRENDING_WINDOW_HOURS = 24;
const EMERGING_MAX_SUBS = 2;
const EMERGING_MAX_IMPRESSIONS = 10;

const FAST_KEYWORDS = new Set([
  'news', 'breaking', 'react', 'reaction', 'reacting', 'drama', 'update',
  'leaked', 'exposed', 'controversy', 'responds', 'response', 'addressed',
  'callout', 'beef', 'recap', 'today', 'tonight', 'yesterday', 'weekly', 'daily',
]);

const SLOW_KEYWORDS = new Set([
  'tutorial', 'guide', 'howto', 'learn', 'course', 'lesson', 'explained',
  'explanation', 'fundamentals', 'basics', 'beginner', 'advanced',
  'masterclass', 'workshop', 'lecture', 'education', 'teaching',
  'documentation', 'reference', 'setup', 'install', 'installation',
  'review', 'comparison', 'versus',
]);

const EVERGREEN_KEYWORDS = new Set([
  'music', 'song', 'album', 'mix', 'playlist', 'remix',
  'ambient', 'lofi', 'chill', 'relaxing', 'meditation', 'sleep',
  'asmr', 'rain', 'nature', 'sounds',
  'podcast', 'interview', 'conversation', 'discussion',
  'documentary', 'essay', 'analysis',
]);

function expectedCTR(pos: number): number {
  return 1 / (1 + Math.log2(1 + pos));
}

function extractEpisodeNumber(title: string): number | null {
  const patterns = [
    /S\d+E(\d+)/i,                    // S2E3
    /season\s*\d+\s*episode\s*(\d+)/i, // Season 2 Episode 3
    /[Ee]pisode\s*(\d+)/,             // Episode 12
    /[Ee]p\.?\s*(\d+)/,               // Ep 4, Ep. 4
    /[Pp]art\s*(\d+)/,                // Part 3
    /[Dd]ay\s*(\d+)/,                 // Day 14
    /#(\d+)/,                          // #5
    /\|\s*(\d+)\s*$/,                  // "Title | 42"
    /(?:^|\s)(\d+)\s*$/,              // trailing standalone number
  ];
  for (const re of patterns) {
    const m = title.match(re);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > 0 && n < 10000) return n;
    }
  }
  return null;
}

/** Map hour (0-23) to one of 4 six-hour time-of-day slots. */
function getTimeSlot(hour: number): number {
  return Math.floor(hour / 6); // 0=night, 1=morning, 2=afternoon, 3=evening
}

let lastPruneTime = 0;

function getExploreVideos(userId: string, sessionStartMs?: number, config: ExploreConfig = DEFAULT_EXPLORE_CONFIG): ExploreResult {
  const cached = cache.exploreVideos.get(userId);
  if (cached && Date.now() < cached.expires) return cached.data;

  // Performance instrumentation — t0: start after cache miss
  const t0 = performance.now();

  // Session quality feedback loop — adjust diversity/exploration slots if success rate is low
  let DEEP_CUT_SLOTS = config.baseDeepCutSlots;
  let EXPLORATION_SLOTS = config.baseExplorationSlots;
  const recentSessions = db.getRecentExploreSessions(userId, 10);
  if (recentSessions.length >= 3) {
    const successCount = recentSessions.filter(s => s.best_completion >= 0.3).length;
    const successRate = successCount / recentSessions.length;
    if (successRate < 0.5) {
      // Increase diversity when sessions aren't finding good content
      DEEP_CUT_SLOTS = Math.ceil(config.baseDeepCutSlots * 1.5); // 4 → 6
      EXPLORATION_SLOTS = Math.ceil(config.baseExplorationSlots * 1.5); // 6 → 9
    }
  }

  // 1. Get all RSS cache entries — build flat video list
  const rows = db.getAllRssCacheForUser(userId);
  const allVideos: ExploreVideo[] = [];
  const videoChannelMap = new Map<string, string>();
  const rssPublishMap = new Map<string, number>();
  const channelVideoCount = new Map<string, number>();
  const videoTitleMap = new Map<string, string>();
  const channelPublishTimes = new Map<string, number[]>();

  for (const row of rows) {
    try {
      const rssData = JSON.parse(row.data);
      for (const item of rssData.items || []) {
        const channelId = item.channelId || row.channel_id;
        allVideos.push({
          videoId: item.videoId,
          title: item.title,
          thumbnail: `https://i.ytimg.com/vi/${item.videoId}/mqdefault.jpg`,
          channelTitle: row.sub_title || rssData.channelTitle || '',
          channelId,
          publishedAt: item.publishedAt,
        });
        videoChannelMap.set(item.videoId, channelId);
        videoTitleMap.set(item.videoId, item.title || '');
        if (item.publishedAt) {
          const pubMs = new Date(item.publishedAt).getTime();
          if (!isNaN(pubMs)) {
            rssPublishMap.set(item.videoId, pubMs);
            let chPubs = channelPublishTimes.get(channelId);
            if (!chPubs) { chPubs = []; channelPublishTimes.set(channelId, chPubs); }
            chPubs.push(pubMs);
          }
        }
        channelVideoCount.set(channelId, (channelVideoCount.get(channelId) || 0) + 1);
      }
    } catch { /* skip malformed RSS cache entries */ }
  }

  // Compute per-channel median upload interval from RSS timestamps
  const channelMedianInterval = new Map<string, number>();
  for (const [chId, pubs] of channelPublishTimes) {
    if (pubs.length < 2) continue;
    pubs.sort((a, b) => b - a); // newest first
    const intervals: number[] = [];
    for (let i = 0; i < pubs.length - 1; i++) {
      intervals.push(pubs[i] - pubs[i + 1]);
    }
    intervals.sort((a, b) => a - b);
    channelMedianInterval.set(chId, intervals[Math.floor(intervals.length / 2)]);
  }

  // Channel upload dormancy — channels with no upload in 45+ days get decaying affinity
  const channelDormancyMultiplier = new Map<string, number>();
  for (const [chId, pubs] of channelPublishTimes) {
    const newestPub = Math.max(...pubs);
    const daysSinceLastUpload = (Date.now() - newestPub) / (1000 * 60 * 60 * 24);
    if (daysSinceLastUpload > config.dormancyThresholdDays) {
      const fraction = Math.min(1, (daysSinceLastUpload - config.dormancyThresholdDays) / 120);
      channelDormancyMultiplier.set(chId, 1 - fraction * (1 - DORMANCY_FLOOR));
    }
  }

  if (allVideos.length === 0) {
    const empty: ExploreResult = { videos: [], continueWatching: [], newVideoIds: [] };
    cache.exploreVideos.set(userId, { data: empty, expires: Date.now() + EXPLORE_TTL });
    return empty;
  }

  // 2. Get all watch times — compute time-decayed channel affinity + abandon counts
  const watchTimes = db.getAllWatchTimesForUser(userId);
  const watchMap = new Map<string, { last_position: number; duration: number }>();
  const AFFINITY_HALF_LIFE_DAYS = config.affinityHalfLifeDays;
  const now = Date.now();
  const channelWatches = new Map<string, { decayedCount: number; decayedCompletion: number }>();
  const channelRawCompletion = new Map<string, { count: number; totalCompletion: number }>();
  const channelAbandons = new Map<string, number>();
  const channelDelays = new Map<string, { totalDelay: number; count: number }>();
  let totalDecayedWatches = 0;
  const channelLastWatchMs = new Map<string, number>();

  for (const wt of watchTimes) {
    watchMap.set(wt.video_id, wt);
    const chId = videoChannelMap.get(wt.video_id);
    if (chId && wt.duration > 0) {
      const watchMs = new Date(wt.updated_at).getTime();
      if (watchMs > (channelLastWatchMs.get(chId) || 0)) channelLastWatchMs.set(chId, watchMs);
      const ageDays = (now - watchMs) / (1000 * 60 * 60 * 24);
      const decay = Math.exp(-ageDays / AFFINITY_HALF_LIFE_DAYS);
      const completion = (wt.last_position === 0)
        ? 1.0
        : Math.min(1, wt.last_position / wt.duration);
      // Absolute watch time weighting: log-scale by duration
      const watchSeconds = completion * wt.duration;
      const durationWeight = Math.log2(1 + watchSeconds / WATCH_TIME_REFERENCE_SECONDS);
      const weightedDecay = decay * durationWeight;
      const entry = channelWatches.get(chId) || { decayedCount: 0, decayedCompletion: 0 };
      entry.decayedCount += weightedDecay;
      entry.decayedCompletion += completion * weightedDecay;
      channelWatches.set(chId, entry);
      totalDecayedWatches += weightedDecay;

      const rawEntry = channelRawCompletion.get(chId) || { count: 0, totalCompletion: 0 };
      rawEntry.count++;
      rawEntry.totalCompletion += completion;
      channelRawCompletion.set(chId, rawEntry);

      // Track abandons: video > 60s and watched < 10% (skip fully-watched position-reset)
      if (wt.duration > config.shortsDurationThreshold && wt.last_position !== 0 && wt.last_position / wt.duration < 0.1) {
        channelAbandons.set(chId, (channelAbandons.get(chId) || 0) + 1);
      }

      // Track watch velocity — delay from publish to watch
      const pubMs = rssPublishMap.get(wt.video_id);
      if (pubMs) {
        const delay = Math.max(0, watchMs - pubMs);
        const d = channelDelays.get(chId) || { totalDelay: 0, count: 0 };
        d.totalDelay += delay;
        d.count++;
        channelDelays.set(chId, d);
      }
    }
  }

  // 2a1b. Per-channel median response delay — for freshness urgency
  const channelMedianDelay = new Map<string, number>();
  for (const [chId, d] of channelDelays) {
    if (d.count < 2) continue;
    // Use average as proxy (true median would need stored individual delays)
    channelMedianDelay.set(chId, d.totalDelay / d.count);
  }

  // 2a2. Session completion backfill — retroactively update best_completion from watch data
  const backfillSessions = db.getExploreSessionsForBackfill(userId);
  for (const session of backfillSessions) {
    const sessionStartMs = new Date(session.started_at).getTime();
    let maxCompletion = session.best_completion;
    for (const wt of watchTimes) {
      const wtMs = new Date(wt.updated_at).getTime();
      if (wtMs >= sessionStartMs && wt.duration > 0) {
        const completion = wt.last_position === 0
          ? 1.0
          : Math.min(1, wt.last_position / wt.duration);
        if (completion > maxCompletion) maxCompletion = completion;
      }
    }
    if (maxCompletion > session.best_completion) {
      void Promise.resolve(db.updateExploreSession(userId, session.session_id,
        session.clicks, session.total_watch_seconds, maxCompletion));
    }
  }

  // 2b. New subscription ramp — smooth exponential decay over 14 days
  const NEW_SUB_RAMP_DAYS = 14;
  const NEW_SUB_DECAY_TAU = 7;
  const recentSubChannelIds = new Set(db.getRecentSubscriptionChannelIds(userId, NEW_SUB_RAMP_DAYS));
  const subDates = recentSubChannelIds.size > 0
    ? db.getSubscriptionDates(userId, [...recentSubChannelIds])
    : new Map<string, string>();

  // 2c. Session context — find videos related to the 3 most recently watched
  const meaningfulWatches = watchTimes
    .filter(wt => wt.duration > 0 && (wt.last_position === 0 || wt.last_position / wt.duration > 0.3))
    .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());

  const SESSION_BOOST = config.sessionBoost;
  const SESSION_WINDOW_MS = 2 * 60 * 60 * 1000; // 2 hours
  const SESSION_MAX_SEEDS = 8;

  // Detect current session: meaningful watches within 2-hour window
  const sessionCutoff = now - SESSION_WINDOW_MS;
  const currentSessionWatches = meaningfulWatches.filter(
    wt => new Date(wt.updated_at).getTime() >= sessionCutoff
  );

  // Use full session as seeds (up to cap), fall back to 3 most recent if no active session
  const sessionSeeds = currentSessionWatches.length >= 2
    ? currentSessionWatches.slice(0, SESSION_MAX_SEEDS)
    : meaningfulWatches.slice(0, 3);

  const recentSessionIds = sessionSeeds.map(wt => wt.video_id);
  const sessionRelatedIds = new Set<string>();
  const sessionRelatedSourceCount = new Map<string, number>();
  if (recentSessionIds.length > 0) {
    for (const r of db.getRelatedVideosForSources(recentSessionIds)) {
      sessionRelatedIds.add(r.video_id);
      sessionRelatedSourceCount.set(
        r.video_id,
        (sessionRelatedSourceCount.get(r.video_id) || 0) + 1
      );
    }
  }

  // 2c1b. Cross-session topic momentum — 48h keyword profile with 24h half-life
  const MOMENTUM_HALF_LIFE_HOURS = config.momentumHalfLifeHours;
  const MOMENTUM_WINDOW_MS = config.momentumHalfLifeHours * 2 * 60 * 60 * 1000;
  const MOMENTUM_WEIGHT = config.momentumWeight;
  const momentumKeywordWeights = new Map<string, number>();
  for (const wt of meaningfulWatches) {
    const watchMs = new Date(wt.updated_at).getTime();
    if (now - watchMs > MOMENTUM_WINDOW_MS) break; // sorted newest-first
    const title = videoTitleMap.get(wt.video_id);
    if (!title || wt.duration <= 0) continue;
    const hoursSinceWatch = (now - watchMs) / (1000 * 60 * 60);
    const recencyWeight = Math.exp(-hoursSinceWatch / MOMENTUM_HALF_LIFE_HOURS);
    const completion = wt.last_position === 0
      ? 1.0
      : Math.min(1, wt.last_position / wt.duration);
    for (const kw of tokenize(title)) {
      momentumKeywordWeights.set(kw, Math.max(momentumKeywordWeights.get(kw) || 0, recencyWeight * completion));
    }
  }

  // 2c2. Session-type detection — prefer candidates matching session viewing mode
  const sessionSeedDurations = recentSessionIds.length > 0 ? db.getDurations(recentSessionIds) : {};
  const sessionDurValues = Object.values(sessionSeedDurations)
    .filter(d => d > config.shortsDurationThreshold)
    .sort((a, b) => a - b);
  const sessionMedianDuration = sessionDurValues.length >= 2
    ? sessionDurValues[Math.floor(sessionDurValues.length / 2)]
    : 0;

  // 2c3. Binge detection — per-channel burst in recent session
  const BINGE_THRESHOLD = config.bingeThreshold;
  const BINGE_WINDOW_MS = 2 * 60 * 60 * 1000;
  const BINGE_BOOST = config.bingeBoost;
  const BINGE_EXHAUST_THRESHOLD = config.bingeExhaustThreshold;
  const BINGE_EXHAUST_PENALTY = config.bingeExhaustPenalty;
  const bingeChannels = new Set<string>();
  const recentCutoff = now - BINGE_WINDOW_MS;
  const channelRecentWatches = new Map<string, number>();
  for (const wt of meaningfulWatches) {
    const watchTime = new Date(wt.updated_at).getTime();
    if (watchTime < recentCutoff) break; // sorted newest-first
    const chId = videoChannelMap.get(wt.video_id);
    if (!chId) continue;
    const count = (channelRecentWatches.get(chId) || 0) + 1;
    channelRecentWatches.set(chId, count);
    if (count >= BINGE_THRESHOLD) bingeChannels.add(chId);
  }

  // 2d. Duration preference — compute median from meaningful watches
  const top100Watches = meaningfulWatches.slice(0, 100).map(wt => wt.video_id);
  const watchDurations = top100Watches.length > 0 ? db.getDurations(top100Watches) : {};
  const durationValues = Object.values(watchDurations)
    .filter(d => d > config.shortsDurationThreshold)
    .sort((a, b) => a - b);
  const medianDuration = durationValues.length > 0
    ? durationValues[Math.floor(durationValues.length / 2)]
    : 0;

  // 2e. Title keyword similarity — completion-weighted keywords from last 10 meaningful watches
  const recentKeywordWeights = new Map<string, number>();
  for (const wt of meaningfulWatches.slice(0, 10)) {
    const title = videoTitleMap.get(wt.video_id);
    if (!title || wt.duration <= 0) continue;
    const completion = wt.last_position === 0
      ? 1.0
      : Math.min(1, wt.last_position / wt.duration);
    for (const kw of tokenize(title)) {
      recentKeywordWeights.set(kw, Math.max(recentKeywordWeights.get(kw) || 0, completion));
    }
  }

  // 2e2. Negative keywords from abandoned watches
  const negativeKeywords = new Set<string>();
  for (const wt of watchTimes) {
    if (wt.duration > config.shortsDurationThreshold && wt.last_position / wt.duration < 0.1) {
      const title = videoTitleMap.get(wt.video_id);
      if (title) {
        for (const kw of tokenize(title)) {
          if (!recentKeywordWeights.has(kw)) negativeKeywords.add(kw);
        }
      }
    }
  }

  // 2e3. Series detection — recurring title patterns per channel
  const channelTitleTokens = new Map<string, Map<string, number>>();
  for (const wt of meaningfulWatches.slice(0, 30)) {
    const chId = videoChannelMap.get(wt.video_id);
    const title = videoTitleMap.get(wt.video_id);
    if (!chId || !title) continue;
    let tokens = channelTitleTokens.get(chId);
    if (!tokens) {
      tokens = new Map<string, number>();
      channelTitleTokens.set(chId, tokens);
    }
    for (const kw of tokenize(title)) {
      tokens.set(kw, (tokens.get(kw) || 0) + 1);
    }
  }

  const channelSeriesTokens = new Map<string, Set<string>>();
  for (const [chId, tokens] of channelTitleTokens) {
    const seriesTokens = new Set<string>();
    for (const [token, count] of tokens) {
      if (count >= config.minSeriesWatches) seriesTokens.add(token);
    }
    if (seriesTokens.size > 0) channelSeriesTokens.set(chId, seriesTokens);
  }

  // 2e4. Series episode tracking — highest watched episode + watched episode set per channel
  const channelMaxWatchedEpisode = new Map<string, number>();
  const channelWatchedEpisodes = new Map<string, Set<number>>();
  for (const wt of meaningfulWatches.slice(0, 30)) {
    const chId = videoChannelMap.get(wt.video_id);
    const title = videoTitleMap.get(wt.video_id);
    if (!chId || !title || !channelSeriesTokens.has(chId)) continue;
    const seriesTokens = channelSeriesTokens.get(chId)!;
    const words = tokenize(title);
    let overlap = 0;
    for (const w of words) if (seriesTokens.has(w)) overlap++;
    if (seriesTokens.size > 0 && overlap / seriesTokens.size >= 0.5) {
      const epNum = extractEpisodeNumber(title);
      if (epNum !== null) {
        const current = channelMaxWatchedEpisode.get(chId) || 0;
        if (epNum > current) channelMaxWatchedEpisode.set(chId, epNum);
        let epSet = channelWatchedEpisodes.get(chId);
        if (!epSet) { epSet = new Set(); channelWatchedEpisodes.set(chId, epSet); }
        epSet.add(epNum);
      }
    }
  }

  // 2e4b. Series completion detection — suppress boost for fully-watched series
  const channelSeriesComplete = new Set<string>();
  for (const [chId, watchedEps] of channelWatchedEpisodes) {
    const maxEp = channelMaxWatchedEpisode.get(chId);
    if (maxEp !== undefined && maxEp >= config.minSeriesWatches && watchedEps.size >= maxEp * 0.8) {
      channelSeriesComplete.add(chId);
    }
  }

  // 2e5. Content-category decay tiers — classify channels by title keywords
  const channelCategoryHits = new Map<string, [number, number, number]>();
  for (const [videoId, title] of videoTitleMap) {
    const chId = videoChannelMap.get(videoId);
    if (!chId) continue;
    let hits = channelCategoryHits.get(chId);
    if (!hits) { hits = [0, 0, 0]; channelCategoryHits.set(chId, hits); }
    const words = tokenize(title);
    for (const w of words) {
      if (FAST_KEYWORDS.has(w)) hits[0]++;
      if (SLOW_KEYWORDS.has(w)) hits[1]++;
      if (EVERGREEN_KEYWORDS.has(w)) hits[2]++;
    }
  }

  const channelDecayTier = new Map<string, number>();
  for (const [chId, [fast, slow, evergreen]] of channelCategoryHits) {
    const total = fast + slow + evergreen;
    if (total === 0) continue;
    const threshold = total * 0.4;
    if (evergreen >= threshold) channelDecayTier.set(chId, DECAY_TIER_EVERGREEN);
    else if (slow >= threshold) channelDecayTier.set(chId, DECAY_TIER_SLOW);
    else if (fast >= threshold) channelDecayTier.set(chId, DECAY_TIER_FAST);
  }

  // 2f. Explore click-through data — completion-weighted, time-decayed.
  //     Each click's value = watch completion ratio (0.0–1.0).
  //     Impressions and clicks decay with a 21-day half-life.
  //     Bounced clicks use reduced weight based on bounce seconds.
  const CTR_HALF_LIFE_DAYS = config.ctrHalfLifeDays;
  const exploreBounces = db.getExploreBounces(userId);
  const bounceMap = new Map<string, number>();
  const channelBounceCount = new Map<string, number>();
  for (const b of exploreBounces) {
    bounceMap.set(b.video_id, b.bounce_seconds);
    channelBounceCount.set(b.channel_id, (channelBounceCount.get(b.channel_id) || 0) + 1);
  }
  const exploreEvents = db.getExploreEventsForUser(userId);
  const channelImpressions = new Map<string, number>();
  const channelWeightedClicks = new Map<string, number>();
  const videoImpressionCount = new Map<string, number>();
  const videoClickCompletion = new Map<string, number>();
  const DEFAULT_CLICK_WEIGHT = 0.5;
  const eventVideoIds = [...new Set(exploreEvents.map(ev => ev.video_id))];
  const eventDurations = eventVideoIds.length > 0 ? db.getDurations(eventVideoIds) : {};
  for (const ev of exploreEvents) {
    // Skip shorts from CTR data — they inflate impressions and skew channel CTR
    const evDur = eventDurations[ev.video_id];
    if (evDur !== undefined && evDur > 0 && evDur <= config.shortsDurationThreshold) continue;

    const eventAgeDays = (now - new Date(ev.created_at).getTime()) / (1000 * 60 * 60 * 24);
    const eventDecay = Math.exp(-eventAgeDays * Math.LN2 / CTR_HALF_LIFE_DAYS);
    // Position bias correction — weight by inverse expected CTR
    // Old rows have position=0 → expectedCTR(0)=1.0 → posWeight=1.0 (no distortion)
    const posWeight = 1 / expectedCTR(ev.position);
    if (ev.event_type === 'impression') {
      const decayedImpressions = ev.impression_count * eventDecay * posWeight;
      channelImpressions.set(ev.channel_id, (channelImpressions.get(ev.channel_id) || 0) + decayedImpressions);
      videoImpressionCount.set(ev.video_id, ev.impression_count); // raw count for staleness
    } else if (ev.event_type === 'click') {
      const bounceSeconds = bounceMap.get(ev.video_id);
      let clickWeight: number;
      if (bounceSeconds !== undefined) {
        // Quick-bounce: reduced click weight (10s→0.08, 30s→0.25, 60s→0.50)
        clickWeight = Math.max(0.05, bounceSeconds / 120);
      } else {
        const wt = watchMap.get(ev.video_id);
        // last_position === 0 with duration > 0 means fully watched (position resets after completion)
        clickWeight = (wt && wt.duration > 0)
          ? (wt.last_position === 0 ? 1.0 : Math.min(1, wt.last_position / wt.duration))
          : DEFAULT_CLICK_WEIGHT;
      }
      videoClickCompletion.set(ev.video_id, clickWeight);
      channelWeightedClicks.set(
        ev.channel_id,
        (channelWeightedClicks.get(ev.channel_id) || 0) + clickWeight * eventDecay * posWeight
      );
    }
  }

  // 2f1b. Channel-level impression fatigue — aggregate raw impressions and meaningful clicks per channel
  const channelTotalImpressions = new Map<string, number>();
  const channelTotalMeaningfulClicks = new Map<string, number>();
  for (const ev of exploreEvents) {
    if (ev.event_type === 'impression') {
      channelTotalImpressions.set(ev.channel_id, (channelTotalImpressions.get(ev.channel_id) || 0) + ev.impression_count);
    } else if (ev.event_type === 'click') {
      const wt = watchMap.get(ev.video_id);
      const completion = (wt && wt.duration > 0)
        ? (wt.last_position === 0 ? 1.0 : Math.min(1, wt.last_position / wt.duration))
        : DEFAULT_CLICK_WEIGHT;
      if (completion >= 0.1) {
        channelTotalMeaningfulClicks.set(ev.channel_id, (channelTotalMeaningfulClicks.get(ev.channel_id) || 0) + 1);
      }
    }
  }

  // 2f2. Topic filters — explicit user preferences for cross-channel topics
  const topicFilterRows = db.getTopicFilters(userId);
  const topicBoosts = new Set<string>();
  const topicSuppressions = new Set<string>();
  for (const tf of topicFilterRows) {
    if (tf.filter === 'boost') topicBoosts.add(tf.topic);
    else topicSuppressions.add(tf.topic);
  }

  // 2g. Time-of-day affinity — per-channel slot profile from meaningful watches
  const TIME_SLOTS = 4;
  const MIN_TOD_WATCHES = 3;
  const channelSlotCounts = new Map<string, number[]>();
  const channelTotalTod = new Map<string, number>();
  const currentSlot = getTimeSlot(new Date().getHours());

  for (const wt of meaningfulWatches) {
    const chId = videoChannelMap.get(wt.video_id);
    if (!chId) continue;
    const hour = new Date(wt.updated_at).getHours();
    const slot = getTimeSlot(hour);
    let counts = channelSlotCounts.get(chId);
    if (!counts) {
      counts = new Array(TIME_SLOTS).fill(0);
      channelSlotCounts.set(chId, counts);
    }
    counts[slot]++;
    channelTotalTod.set(chId, (channelTotalTod.get(chId) || 0) + 1);
  }

  // 2g2. Day-of-week affinity — per-channel weekday/weekend profile
  const channelDowCounts = new Map<string, number[]>();
  const channelTotalDow = new Map<string, number>();
  const currentDow = new Date().getDay();

  for (const wt of meaningfulWatches) {
    const chId = videoChannelMap.get(wt.video_id);
    if (!chId) continue;
    const dow = new Date(wt.updated_at).getDay();
    let counts = channelDowCounts.get(chId);
    if (!counts) {
      counts = new Array(DOW_SLOTS).fill(0);
      channelDowCounts.set(chId, counts);
    }
    counts[dow]++;
    channelTotalDow.set(chId, (channelTotalDow.get(chId) || 0) + 1);
  }

  // 2h. Watch completeness trend — detect rising/falling interest per channel
  const MIN_TREND_WATCHES = 6;
  const channelCompletionsByRecency = new Map<string, number[]>();

  for (const wt of meaningfulWatches) {
    const chId = videoChannelMap.get(wt.video_id);
    if (!chId || wt.duration <= 0) continue;
    const completion = Math.min(1, wt.last_position / wt.duration);
    let completions = channelCompletionsByRecency.get(chId);
    if (!completions) {
      completions = [];
      channelCompletionsByRecency.set(chId, completions);
    }
    completions.push(completion); // already sorted newest-first from meaningfulWatches
  }

  const channelTrendMultiplier = new Map<string, number>();
  for (const [chId, completions] of channelCompletionsByRecency) {
    if (completions.length < MIN_TREND_WATCHES) continue;
    const half = Math.floor(completions.length / 2);
    const recentHalf = completions.slice(0, half);
    const olderHalf = completions.slice(half);
    const recentMedian = recentHalf[Math.floor(recentHalf.length / 2)];
    const olderMedian = olderHalf[Math.floor(olderHalf.length / 2)];
    if (olderMedian <= 0) continue;
    // slope: positive = rising interest, negative = fatigue
    const slope = (recentMedian - olderMedian) / olderMedian;
    // Clamp to 0.85–1.15 multiplier range
    channelTrendMultiplier.set(chId, Math.max(0.85, Math.min(1.15, 1 + slope * 0.5)));
  }

  // 3. Get tagged video IDs — compute per-channel tag count
  const taggedVideoIds = db.getAllTaggedVideoIds(userId);
  const taggedSet = new Set(taggedVideoIds);

  // 3b. Get dismissed video IDs
  const dismissedSet = new Set(db.getDismissedVideoIds(userId));

  // 3c. Channel boosts — explicit positive signal from user
  const boostedChannelIds = new Set(db.getBoostedChannelIds(userId));

  // 3c2. Channel mutes — hard exclude
  const mutedChannelIds = new Set(db.getMutedChannelIds(userId));

  // 3c3. Queue channel affinity boost
  const queuedVideoIds = new Set(db.getQueuedVideoIds(userId));
  const queuedChannelCount = new Map<string, number>();
  for (const vid of queuedVideoIds) {
    const chId = videoChannelMap.get(vid);
    if (chId) queuedChannelCount.set(chId, (queuedChannelCount.get(chId) || 0) + 1);
  }

  // 3c5. Video ratings — explicit per-video thumbs up/down
  const ratingRows = db.getVideoRatings(userId);
  const personalRatings = new Map<string, number>();
  const ratedUpChannels = new Map<string, number>();
  for (const r of ratingRows) {
    personalRatings.set(r.video_id, r.rating);
    if (r.rating === 1) {
      const chId = videoChannelMap.get(r.video_id);
      if (chId) ratedUpChannels.set(chId, (ratedUpChannels.get(chId) || 0) + 1);
    }
  }

  // 3c4. Rewatch-eligible channels — comfort channels with high engagement + explicit intent
  const rewatchEligibleChannels = new Set<string>();
  for (const [chId, raw] of channelRawCompletion) {
    if (raw.count < REWATCH_MIN_WATCHES) continue;
    if (raw.totalCompletion / raw.count < REWATCH_COMPLETION_THRESHOLD) continue;
    if (boostedChannelIds.has(chId) || queuedChannelCount.has(chId)) {
      rewatchEligibleChannels.add(chId);
    }
  }

  const channelTagCount = new Map<string, number>();
  for (const vid of taggedVideoIds) {
    const chId = videoChannelMap.get(vid);
    if (chId) {
      channelTagCount.set(chId, (channelTagCount.get(chId) || 0) + 1);
    }
  }

  // 4. Filter out fully-watched videos (with rewatch allowance for comfort channels)
  const rewatchCandidateIds = new Set<string>();
  const candidates = allVideos.filter(v => {
    const wt = watchMap.get(v.videoId);
    if (!wt) return true; // never watched = candidate
    if (wt.duration <= 0) return true;
    const isFullyWatched = wt.last_position === 0 || wt.last_position / wt.duration > 0.9;
    if (isFullyWatched) {
      if (rewatchEligibleChannels.has(v.channelId)) {
        rewatchCandidateIds.add(v.videoId);
        return true;
      }
      return false;
    }
    // Partially watched (<50%) = candidate
    return wt.last_position / wt.duration < 0.5;
  });

  // Also exclude videos the user tagged or dismissed
  const scoredVideos = candidates.filter(v => !taggedSet.has(v.videoId) && !dismissedSet.has(v.videoId) && !mutedChannelIds.has(v.channelId));

  // 4b. Batch-fetch candidate durations for duration preference scoring
  const candidateIds = scoredVideos.map(v => v.videoId);
  const candidateDurations = candidateIds.length > 0 ? db.getDurations(candidateIds) : {};

  // 4c. Batch-fetch candidate live statuses for live boost scoring
  const candidateLiveStatuses = candidateIds.length > 0 ? db.getLiveStatuses(candidateIds) : {};

  // 4e. Cross-user video popularity — how many users meaningfully watched each candidate
  const videoPopularity = candidateIds.length > 0 ? db.getVideoPopularity(candidateIds) : {};

  // 4e1b. Trending velocity — recent watchers within last 24 hours
  const recentVideoPopularity = candidateIds.length > 0 ? db.getRecentVideoPopularity(candidateIds, TRENDING_WINDOW_HOURS) : {};

  // 4e2. Collaborative filtering — item-item co-watch from other users
  const userWatchedIds = meaningfulWatches.slice(0, 50).map(wt => wt.video_id);
  const coWatchedRaw = userWatchedIds.length > 0
    ? db.getCoWatchedVideos(userWatchedIds, userId, 100)
    : [];
  const coWatchScores = new Map<string, number>();
  for (const cw of coWatchedRaw) {
    coWatchScores.set(cw.video_id, cw.score);
  }

  // 4d. Cross-channel topic affinity — build from related video graph
  //     For each watched channel, count how many related links point to each other channel.
  //     Normalize per source channel to get a similarity score [0, 1].
  const TOPIC_AFFINITY_CAP = 0.6;
  const channelCoOccurrence = new Map<string, Map<string, number>>();
  const channelRelatedTotal = new Map<string, number>();
  const recentWatchIds = meaningfulWatches.slice(0, 50).map(wt => wt.video_id);
  const relatedRows = recentWatchIds.length > 0 ? db.getRelatedVideosForSources(recentWatchIds) : [];

  // Build co-occurrence: sourceChannel → relatedChannel → count
  for (const r of relatedRows) {
    const sourceChannel = videoChannelMap.get(r.source_video_id);
    if (!sourceChannel || !r.channel_id) continue;
    if (sourceChannel === r.channel_id) continue; // skip self-references

    let inner = channelCoOccurrence.get(sourceChannel);
    if (!inner) {
      inner = new Map<string, number>();
      channelCoOccurrence.set(sourceChannel, inner);
    }
    inner.set(r.channel_id, (inner.get(r.channel_id) || 0) + 1);
    channelRelatedTotal.set(sourceChannel, (channelRelatedTotal.get(sourceChannel) || 0) + 1);
  }

  // Compute max direct affinity for capping
  let maxDirectAffinity = 0;
  for (const [, stats] of channelWatches) {
    if (totalDecayedWatches > 0) {
      const a = (stats.decayedCount / totalDecayedWatches) * (stats.decayedCompletion / stats.decayedCount);
      if (a > maxDirectAffinity) maxDirectAffinity = a;
    }
  }
  const topicAffinityCeiling = maxDirectAffinity * TOPIC_AFFINITY_CAP;

  // Build transferred affinity map: candidateChannel → topicAffinity
  const topicAffinityMap = new Map<string, number>();
  for (const [sourceChannel, coMap] of channelCoOccurrence) {
    const sourceStats = channelWatches.get(sourceChannel);
    if (!sourceStats || totalDecayedWatches <= 0) continue;
    const sourceAffinity = (sourceStats.decayedCount / totalDecayedWatches)
      * (sourceStats.decayedCompletion / sourceStats.decayedCount);
    const total = channelRelatedTotal.get(sourceChannel) || 1;

    for (const [relatedChannel, coCount] of coMap) {
      const similarity = coCount / total;
      const transferred = sourceAffinity * similarity;
      topicAffinityMap.set(
        relatedChannel,
        Math.min(topicAffinityCeiling, (topicAffinityMap.get(relatedChannel) || 0) + transferred)
      );
    }
  }

  // 4f. Cross-user channel quality — subscriber counts for cold channels
  const coldChannelIds = [...new Set(scoredVideos.map(v => v.channelId))]
    .filter(chId => !channelWatches.has(chId) && !recentSubChannelIds.has(chId) && !topicAffinityMap.has(chId));
  const communitySubCounts = coldChannelIds.length > 0
    ? db.getChannelSubscriberCounts(coldChannelIds, userId)
    : {};

  // 4f2. Creator long-tail — identify emerging channels (low subs + low cross-user impressions)
  const allCandidateChannelIds = [...new Set(scoredVideos.map(v => v.channelId))];
  const allChannelSubCounts = allCandidateChannelIds.length > 0
    ? db.getChannelSubscriberCounts(allCandidateChannelIds, userId)
    : {};
  const channelImpressionCounts = allCandidateChannelIds.length > 0
    ? db.getChannelImpressionCounts(allCandidateChannelIds)
    : {};
  const emergingChannels = new Set<string>();
  for (const chId of allCandidateChannelIds) {
    const subs = allChannelSubCounts[chId] || 0;
    const imps = channelImpressionCounts[chId] || 0;
    if (subs <= EMERGING_MAX_SUBS && imps < EMERGING_MAX_IMPRESSIONS) {
      emergingChannels.add(chId);
    }
  }

  // 4g. Tag-based topic vectors — fetch tags for recent watches + candidates
  const recentWatchVideoIds = meaningfulWatches.slice(0, 20).map(wt => wt.video_id);
  const allTagQueryIds = [...new Set([...recentWatchVideoIds, ...candidateIds])];
  const videoTagsMap = allTagQueryIds.length > 0 ? db.getVideoTags(allTagQueryIds) : {};

  const tagWeights = new Map<string, number>();
  for (const wt of meaningfulWatches.slice(0, 20)) {
    const vtags = videoTagsMap[wt.video_id];
    if (!vtags || wt.duration <= 0) continue;
    const completion = wt.last_position === 0
      ? 1.0
      : Math.min(1, wt.last_position / wt.duration);
    for (const t of vtags) {
      const norm = t.toLowerCase();
      tagWeights.set(norm, Math.max(tagWeights.get(norm) || 0, completion));
    }
  }

  // 4h. Description-based topic similarity — tokenized description overlap
  const allDescQueryIds = [...new Set([...recentWatchVideoIds, ...candidateIds])];
  const videoDescMap = allDescQueryIds.length > 0 ? db.getVideoDescriptions(allDescQueryIds) : {};

  const descKeywordWeights = new Map<string, number>();
  for (const wt of meaningfulWatches.slice(0, 20)) {
    const desc = videoDescMap[wt.video_id];
    if (!desc || wt.duration <= 0) continue;
    const completion = wt.last_position === 0
      ? 1.0
      : Math.min(1, wt.last_position / wt.duration);
    for (const kw of tokenize(desc.slice(0, 500))) {
      descKeywordWeights.set(kw, Math.max(descKeywordWeights.get(kw) || 0, completion));
    }
  }

  // 4h2. Session duration budget — compute typical session duration from recent sessions
  let typicalSessionDuration = 0;
  if (sessionStartMs) {
    const sessionDurValues2 = recentSessions
      .filter(s => s.total_watch_seconds > 60)
      .map(s => s.total_watch_seconds)
      .sort((a, b) => a - b);
    if (sessionDurValues2.length >= 2) {
      typicalSessionDuration = sessionDurValues2[Math.floor(sessionDurValues2.length / 2)];
    }
  }

  // 4h3. Return-visit channel boost — channels user returned to Explore for
  const returnChannelCounts: Record<string, number> = db.getExploreReturnChannels(userId);

  // 4i. Community video ratings — aggregate from other users
  const communityRatings = candidateIds.length > 0 ? db.getCommunityRatings(candidateIds, userId) : {};

  // Performance instrumentation — t1: all DB queries complete
  const t1 = performance.now();

  // 5. Score each subscription video
  const isColdStart = meaningfulWatches.length === 0;
  const signalStats = {
    affinity: { sum: 0, min: Infinity, max: -Infinity, sumSq: 0 },
    recency: { sum: 0, min: Infinity, max: -Infinity, sumSq: 0 },
    topicTotal: { sum: 0, min: Infinity, max: -Infinity, sumSq: 0 },
    session: { sum: 0, min: Infinity, max: -Infinity, sumSq: 0 },
    trending: { sum: 0, min: Infinity, max: -Infinity, sumSq: 0 },
  };
  function trackSignal(stat: { sum: number; min: number; max: number; sumSq: number }, val: number) {
    stat.sum += val;
    if (val < stat.min) stat.min = val;
    if (val > stat.max) stat.max = val;
    stat.sumSq += val * val;
  }
  const scored: Array<{ video: ExploreVideo; score: number }> = scoredVideos.map(v => {
    // Channel affinity (weight 0.32) — time-decayed
    const chStats = channelWatches.get(v.channelId);
    let affinity: number;
    if (chStats && totalDecayedWatches > 0) {
      const avgCompletion = chStats.decayedCompletion / chStats.decayedCount;
      affinity = (chStats.decayedCount / totalDecayedWatches) * avgCompletion;
    } else if (recentSubChannelIds.has(v.channelId)) {
      // Smooth ramp: 0.1 + 0.4 * exp(-days/7) — Day 0→0.50, Day 7→0.25, Day 14→0.16
      const subDate = subDates.get(v.channelId);
      const daysSinceSub = subDate ? (now - new Date(subDate).getTime()) / (1000 * 60 * 60 * 24) : 0;
      affinity = 0.1 + 0.4 * Math.exp(-daysSinceSub / NEW_SUB_DECAY_TAU);
    } else {
      // Use topic-transferred affinity, community signal, or flat base
      const topicAff = topicAffinityMap.get(v.channelId) || 0;
      const communitySubs = communitySubCounts[v.channelId] || 0;
      const communityBase = Math.min(COMMUNITY_BASE_MAX,
        COMMUNITY_BASE_MIN + Math.log2(1 + communitySubs) * 0.05);
      affinity = Math.max(communityBase, topicAff);
    }

    // Abandon penalty — each abandon reduces affinity by 30%
    const abandons = channelAbandons.get(v.channelId) || 0;
    if (abandons > 0) {
      affinity *= Math.pow(0.7, abandons);
    }

    // Watch completeness trend — rising interest boosts, fatigue penalizes
    const trendMultiplier = channelTrendMultiplier.get(v.channelId) || 1.0;
    affinity *= trendMultiplier;

    // Channel boost — explicit positive signal from user
    const BOOST_MULTIPLIER = 1.5;
    if (boostedChannelIds.has(v.channelId)) {
      affinity *= BOOST_MULTIPLIER;
    }

    // Queue channel affinity — queued videos signal interest in that channel
    const queuedCount = queuedChannelCount.get(v.channelId) || 0;
    if (queuedCount > 0) {
      affinity += Math.min(config.queueChannelCap, queuedCount * config.queueChannelBoost);
    }

    // Thumbs-up channel boost — channels with upvoted videos get additive affinity
    const ratedUpCount = ratedUpChannels.get(v.channelId) || 0;
    if (ratedUpCount > 0) {
      affinity += Math.min(config.ratingChannelCap, ratedUpCount * config.ratingChannelBoost);
    }

    // CTR multiplier — completion-weighted; kicks in after 3+ channel impressions
    const chImps = channelImpressions.get(v.channelId) || 0;
    const chWClks = channelWeightedClicks.get(v.channelId) || 0;
    let ctrMultiplier = chImps >= 3 ? (0.5 + chWClks / chImps) : 1.0;
    // Channel bounce penalty — channels with 3+ bounces get CTR multiplied by 0.85^bounceCount
    const chBounces = channelBounceCount.get(v.channelId) || 0;
    if (chBounces >= 3) {
      ctrMultiplier *= Math.pow(0.85, chBounces);
    }
    affinity *= ctrMultiplier;

    // Channel staleness suppression — dampen affinity for channels abandoned 60+ days ago
    const lastWatchMs = channelLastWatchMs.get(v.channelId);
    if (chStats && lastWatchMs) {
      const daysSinceLastWatch = (now - lastWatchMs) / (1000 * 60 * 60 * 24);
      if (daysSinceLastWatch > config.channelStalenessThresholdDays) {
        const staleFraction = Math.min(1, (daysSinceLastWatch - config.channelStalenessThresholdDays) / 120);
        affinity *= 1 - staleFraction * (1 - CHANNEL_STALENESS_FLOOR);
      }
    }

    // Channel upload dormancy — channels with no recent uploads get decaying affinity
    affinity *= channelDormancyMultiplier.get(v.channelId) ?? 1.0;

    // Recency (weight 0.25) — exponential decay, content-category-aware half-life
    const ageHours = (now - new Date(v.publishedAt).getTime()) / (1000 * 60 * 60);
    const decayTier = channelDecayTier.get(v.channelId) ?? DECAY_TIER_NORMAL;
    const recency = Math.exp(-ageHours / DECAY_HALF_LIVES[decayTier]);

    // Tag affinity (weight 0.12)
    const tagCount = channelTagCount.get(v.channelId) || 0;
    const tagScore = Math.min(1, tagCount / 5);

    // Watch velocity (weight 0.07) — how quickly user watches this channel's videos
    const delays = channelDelays.get(v.channelId);
    const velocityScore = delays
      ? Math.exp(-(delays.totalDelay / delays.count) / config.velocityHalfLifeMs)
      : 0.5;

    // Publish cadence (weight 0.05) — interval-based: infrequent posters keep videos fresh longer
    const medianInt = channelMedianInterval.get(v.channelId);
    let cadenceBoost: number;
    if (medianInt !== undefined && medianInt > 0) {
      const pubMs = rssPublishMap.get(v.videoId);
      const timeSincePublish = pubMs ? now - pubMs : medianInt;
      cadenceBoost = medianInt / (timeSincePublish + medianInt);
    } else {
      // Fallback to sqrt for channels with <2 videos
      const videoCount = channelVideoCount.get(v.channelId) || 1;
      cadenceBoost = 1 / Math.sqrt(videoCount);
    }

    // Tokenize candidate title — used by keyword similarity, negative keywords, and series detection
    const candidateWords = tokenize(v.title);

    // Title keyword similarity (weight 0.07) — completion-weighted overlap with recent watches
    let titleSimilarity = 0;
    if (recentKeywordWeights.size > 0 && candidateWords.length > 0) {
      let weightedOverlap = 0;
      for (const w of candidateWords) {
        weightedOverlap += recentKeywordWeights.get(w) || 0;
      }
      titleSimilarity = weightedOverlap / candidateWords.length;
    }

    // Negative keyword penalty — abandoned video titles suggest disinterest
    let negativeKeywordPenalty = 0;
    if (negativeKeywords.size > 0 && candidateWords.length > 0) {
      let negOverlap = 0;
      for (const w of candidateWords) {
        if (negativeKeywords.has(w)) negOverlap++;
      }
      const negFraction = negOverlap / candidateWords.length;
      negativeKeywordPenalty = negFraction > 0 ? config.negativeKeywordPenalty * Math.min(1, negFraction * 3) : 0;
    }

    // Series boost — videos matching recurring title patterns, with gap-tolerant episode ordering
    let seriesBoost = 0;
    const seriesTokens = channelSeriesTokens.get(v.channelId);
    if (seriesTokens && seriesTokens.size > 0 && candidateWords.length > 0) {
      let seriesOverlap = 0;
      for (const w of candidateWords) if (seriesTokens.has(w)) seriesOverlap++;
      const seriesFraction = seriesOverlap / seriesTokens.size;
      if (seriesFraction >= 0.5) {
        // Suppress boost entirely for completed series (re-enables when new episodes appear)
        if (channelSeriesComplete.has(v.channelId)) {
          seriesBoost = 0;
        } else {
        seriesBoost = config.seriesBoost; // base +0.10
        const maxWatched = channelMaxWatchedEpisode.get(v.channelId);
        const watchedEps = channelWatchedEpisodes.get(v.channelId);
        if (maxWatched !== undefined) {
          const candidateEp = extractEpisodeNumber(v.title);
          if (candidateEp !== null) {
            if (watchedEps && watchedEps.has(candidateEp)) {
              seriesBoost = 0; // already watched: suppress
            } else {
              const gap = candidateEp - maxWatched;
              if (gap >= 1 && gap <= config.seriesGapTolerance) {
                // Graduated boost: EP+1 = +0.15, EP+2 = +0.10, EP+3 = +0.05
                seriesBoost += config.seriesNextBoost * (1 - (gap - 1) / config.seriesGapTolerance);
              } else if (gap < 1) {
                seriesBoost = 0; // earlier than max watched: suppress
              }
              // gap > SERIES_GAP_TOLERANCE: keep base +0.10 only
            }
          }
        }
        } // end else (not series-complete)
      }
    }

    // Duration preference (penalty: -0.05 to 0)
    let durationPenalty = 0;
    const candDur = candidateDurations[v.videoId];
    if (medianDuration > 0 && candDur > 0) {
      const distance = Math.abs(Math.log(candDur / medianDuration));
      durationPenalty = -Math.min(0.05, distance * 0.02);
    }

    // Session-duration affinity — bonus for matching current session's viewing mode
    let sessionDurBoost = 0;
    if (sessionMedianDuration > 0 && candDur > 0 && candDur > config.shortsDurationThreshold) {
      sessionDurBoost = -Math.min(SESSION_DUR_PENALTY_CAP, Math.abs(Math.log(candDur / sessionMedianDuration)) * SESSION_DUR_SCALE);
    }

    // Topic filter score — explicit user topic preferences
    let topicFilterScore = 0;
    if (topicBoosts.size > 0 || topicSuppressions.size > 0) {
      for (const w of candidateWords) {
        if (topicBoosts.has(w)) { topicFilterScore = config.topicFilterBoost; break; }
        if (topicSuppressions.has(w)) { topicFilterScore = config.topicFilterSuppress; break; }
      }
    }

    // Per-video staleness penalty — escalating: shown 3+ times without a meaningful click.
    // A click with <10% completion counts as abandoned (not meaningful).
    // Escalates from -0.03 to -0.09 based on impression count.
    const vidImps = videoImpressionCount.get(v.videoId) || 0;
    const clickCompletion = videoClickCompletion.get(v.videoId) ?? -1;
    const meaningfullyClicked = clickCompletion >= 0.1;
    const stalenessPenalty = (!meaningfullyClicked && vidImps >= 3)
      ? -0.03 * Math.min(3, (vidImps - 2) / 3)
      : 0;

    // Per-channel impression fatigue — channels with 10+ impressions and <5% click rate
    const chTotalImps = channelTotalImpressions.get(v.channelId) || 0;
    const chTotalClks = channelTotalMeaningfulClicks.get(v.channelId) || 0;
    const channelFatiguePenalty = (chTotalImps >= 10 && (chTotalClks / chTotalImps) < 0.05)
      ? -0.02 * Math.min(2, chTotalImps / 20)
      : 0;

    // Time-of-day affinity (weight 0.05) — boost channels watched at this time of day
    const todTotal = channelTotalTod.get(v.channelId) || 0;
    let todScore = 0;
    if (todTotal >= MIN_TOD_WATCHES) {
      const slotCounts = channelSlotCounts.get(v.channelId)!;
      const slotFraction = slotCounts[currentSlot] / todTotal;
      // Maps uniform (0.25) → 0, all-in-slot (1.0) → 1, none-in-slot (0) → -0.5
      todScore = Math.max(-0.5, Math.min(1, slotFraction * TIME_SLOTS - 1));
    }

    // Day-of-week affinity — boost channels watched on this day of the week
    const dowTotal = channelTotalDow.get(v.channelId) || 0;
    let dowScore = 0;
    if (dowTotal >= MIN_DOW_WATCHES) {
      const dowCounts = channelDowCounts.get(v.channelId)!;
      const dowFraction = dowCounts[currentDow] / dowTotal;
      dowScore = Math.max(-0.5, Math.min(1, dowFraction * DOW_SLOTS - 1));
    }

    // Live/premiere boost — time-sensitive content gets urgency bonus
    const LIVE_BOOST = config.liveBoost;
    const UPCOMING_BOOST = config.upcomingBoost;
    const liveStatus = candidateLiveStatuses[v.videoId] || 'not_live';
    const liveBoost = liveStatus === 'is_live' ? LIVE_BOOST
                    : liveStatus === 'is_upcoming' ? UPCOMING_BOOST
                    : 0;

    // Shorts penalty — short-form videos ranked lower on long-form-oriented frontend
    const shortsPenalty = (candDur !== undefined && candDur > 0 && candDur <= config.shortsDurationThreshold)
      ? config.shortsPenalty
      : 0;

    // Channel watch recency — boost channels the user watched recently
    let channelRecency = 0;
    const chLastWatch = channelLastWatchMs.get(v.channelId);
    if (chLastWatch) {
      const hoursSinceWatch = (now - chLastWatch) / (1000 * 60 * 60);
      channelRecency = Math.exp(-hoursSinceWatch / config.channelRecencyHalfLifeHours);
    }

    // Cross-user popularity — mild boost for videos other users enjoyed (amplified for cold start)
    const distinctUsers = videoPopularity[v.videoId] || 0;
    const popWeight = isColdStart ? config.coldStartPopularityWeight : config.popularityWeight;
    const popCap = isColdStart ? config.coldStartPopularityCap : config.popularityCap;
    const popularityBoost = Math.min(popCap, Math.log2(1 + distinctUsers) * popWeight);

    // Tag-based topic similarity (weight 0.06)
    let tagSimilarity = 0;
    if (tagWeights.size > 0) {
      const candidateTags = videoTagsMap[v.videoId];
      if (candidateTags && candidateTags.length > 0) {
        let weightedOverlap = 0;
        for (const t of candidateTags) {
          weightedOverlap += tagWeights.get(t.toLowerCase()) || 0;
        }
        tagSimilarity = weightedOverlap / candidateTags.length;
      }
    }

    // Collaborative filtering co-watch boost
    const coWatchRaw = coWatchScores.get(v.videoId) || 0;
    const coWatchBoost = Math.min(config.cowatchCap, Math.log2(1 + coWatchRaw) * config.cowatchWeight);

    // Session boost — graduated by how many session seeds suggested this video
    const sessionSourceCount = sessionRelatedSourceCount.get(v.videoId) || 0;
    const sessionBoost = sessionSourceCount > 0
      ? SESSION_BOOST * Math.min(1, sessionSourceCount / 2)
      : 0;

    // Description-based topic similarity (weight 0.04)
    let descSimilarity = 0;
    if (descKeywordWeights.size > 0) {
      const candidateDesc = videoDescMap[v.videoId];
      if (candidateDesc) {
        const descWords = tokenize(candidateDesc.slice(0, 500));
        if (descWords.length > 0) {
          let weightedOverlap = 0;
          for (const w of descWords) {
            weightedOverlap += descKeywordWeights.get(w) || 0;
          }
          descSimilarity = weightedOverlap / descWords.length;
        }
      }
    }

    // Personal video rating — explicit thumbs up/down
    const personalRating = personalRatings.get(v.videoId) || 0;
    const ratingBoost = personalRating === 1 ? config.personalRatingUpBoost
      : personalRating === -1 ? config.personalRatingDownPenalty : 0;

    // Community rating signal — mild boost/penalty from other users' aggregate (amplified for cold start)
    const cr = communityRatings[v.videoId];
    const crWeight = isColdStart ? config.coldStartCommunityRatingWeight : config.communityRatingWeight;
    const crCap = isColdStart ? config.coldStartCommunityRatingCap : config.communityRatingCap;
    const communityRatingScore = cr
      ? Math.max(-crCap, Math.min(crCap,
          (cr.up - cr.down) / (cr.up + cr.down) * crWeight))
      : 0;

    // Cross-session topic momentum (weight 0.05) — 48h keyword profile
    let momentumBoost = 0;
    if (momentumKeywordWeights.size > 0 && candidateWords.length > 0) {
      let momentumSum = 0;
      for (const w of candidateWords) {
        momentumSum += momentumKeywordWeights.get(w) || 0;
      }
      momentumBoost = (momentumSum / candidateWords.length) * MOMENTUM_WEIGHT;
    }

    // Content freshness urgency — per-channel typical response time
    let urgencyBoost = 0;
    const URGENCY_MAX = config.urgencyMax;
    const medianDelay = channelMedianDelay.get(v.channelId);
    if (medianDelay !== undefined && medianDelay > 0) {
      const pubMs = rssPublishMap.get(v.videoId);
      if (pubMs) {
        const timeSincePublish = now - pubMs;
        const urgencyWindow = medianDelay * 2;
        if (timeSincePublish < urgencyWindow) {
          urgencyBoost = URGENCY_MAX * (1 - timeSincePublish / urgencyWindow);
        }
      }
    }

    // Session duration budget — penalize long videos near end of typical session
    let budgetPenalty = 0;
    if (sessionStartMs && candDur && candDur > 600) {
      const typicalDuration = typicalSessionDuration;
      if (typicalDuration > 0) {
        const sessionAge = (now - sessionStartMs) / 1000;
        const fatigueThreshold = typicalDuration * 0.7;
        if (sessionAge > fatigueThreshold) {
          const fatigueFraction = Math.min(1, (sessionAge - fatigueThreshold) / (typicalDuration * 0.3));
          budgetPenalty = -0.04 * fatigueFraction * Math.min(1, candDur / 3600);
        }
      }
    }

    // Return-visit channel boost — channels user returned to Explore for
    const returnCount = returnChannelCounts[v.channelId] || 0;
    const returnBoost = returnCount >= 2 ? config.returnBoost : 0;

    // Emerging creator boost — small/new channels get discovery help
    const emergingBoost = emergingChannels.has(v.channelId) ? config.emergingBoost : 0;

    const bingeDepth = channelRecentWatches.get(v.channelId) || 0;
    const bingeBoost = bingeDepth >= BINGE_EXHAUST_THRESHOLD ? BINGE_EXHAUST_PENALTY
      : bingeChannels.has(v.channelId) ? BINGE_BOOST : 0;
    let rewatchPenalty = 0;
    if (rewatchCandidateIds.has(v.videoId)) {
      const rwTier = channelDecayTier.get(v.channelId) ?? DECAY_TIER_NORMAL;
      rewatchPenalty = rwTier === DECAY_TIER_EVERGREEN ? REWATCH_PENALTY_EVERGREEN
        : rwTier === DECAY_TIER_SLOW ? config.rewatchPenaltySlow : config.rewatchPenalty;
    }

    // Trending velocity — log-scaled recent watchers within 24h
    const recentUsers = recentVideoPopularity[v.videoId] || 0;
    const trendingBoost = recentUsers >= 2
      ? Math.min(config.trendingCap, Math.log2(recentUsers) * config.trendingWeight)
      : 0;

    // Topic signal consolidation — sum all 7 topic signals, cap positive total at 0.15
    const rawTopicTotal = tagScore * 0.12 + titleSimilarity * 0.07
      + tagSimilarity * config.tagSimilarityWeight + descSimilarity * config.descSimilarityWeight
      + momentumBoost + topicFilterScore + negativeKeywordPenalty;
    const topicTotal = rawTopicTotal > 0 ? Math.min(config.topicCap, rawTopicTotal) : rawTopicTotal;

    const score = affinity * config.affinityWeight + recency * config.recencyWeight + topicTotal + sessionBoost + bingeBoost
      + velocityScore * config.velocityWeight + cadenceBoost * config.cadenceWeight
      + todScore * config.todWeight + durationPenalty + stalenessPenalty + channelFatiguePenalty + liveBoost + shortsPenalty
      + channelRecency * config.channelRecencyWeight
      + dowScore * config.dowWeight + seriesBoost + popularityBoost + rewatchPenalty
      + coWatchBoost
      + ratingBoost + communityRatingScore
      + sessionDurBoost
      + urgencyBoost + budgetPenalty + returnBoost + trendingBoost + emergingBoost;

    // Accumulate signal stats for metrics
    const affinityVal = affinity * config.affinityWeight;
    const recencyVal = recency * config.recencyWeight;
    trackSignal(signalStats.affinity, affinityVal);
    trackSignal(signalStats.recency, recencyVal);
    trackSignal(signalStats.topicTotal, topicTotal);
    trackSignal(signalStats.session, sessionBoost);
    trackSignal(signalStats.trending, trendingBoost);

    // Determine dominant signal for explainability badge
    const signalContributions: Array<[string, number]> = [
      ['for you', Math.abs(affinity * config.affinityWeight)],
      ['trending', Math.abs(recency * config.recencyWeight + trendingBoost)],
      ['topic', Math.abs(topicTotal)],
      ['session', Math.abs(sessionBoost)],
      ['binge', Math.abs(bingeBoost)],
      ['series', Math.abs(seriesBoost)],
      ['live', Math.abs(liveBoost)],
      ['community', Math.abs(popularityBoost + communityRatingScore + coWatchBoost)],
      ['new channel', recentSubChannelIds.has(v.channelId) ? 0.1 : 0],
      ['return', returnBoost],
      ['emerging', emergingBoost],
    ];
    let bestReason = 'for you';
    let bestVal = 0;
    for (const [label, val] of signalContributions) {
      if (val > bestVal) { bestVal = val; bestReason = label; }
    }
    v.reason = bestReason;

    return { video: v, score };
  });

  // 5b. Mix in related videos from non-subscribed channels
  const rssVideoIds = new Set(allVideos.map(v => v.videoId));
  const subscribedChannels = new Set<string>();
  for (const row of rows) {
    try {
      const rssData = JSON.parse(row.data);
      for (const item of rssData.items || []) {
        subscribedChannels.add(item.channelId || row.channel_id);
      }
    } catch { /* skip */ }
  }
  // Also add channels from subscriptions table
  for (const v of allVideos) subscribedChannels.add(v.channelId);

  if (recentWatchIds.length > 0) {
    // Count how many source videos suggested each related video (reuses relatedRows from 4d)
    const relatedMap = new Map<string, { video: ExploreVideo; sourceCount: number }>();
    for (const r of relatedRows) {
      // Exclude subscribed channels, muted channels, already-in-RSS videos, and fully-watched
      if (subscribedChannels.has(r.channel_id)) continue;
      if (mutedChannelIds.has(r.channel_id)) continue;
      if (rssVideoIds.has(r.video_id)) continue;
      const wt = watchMap.get(r.video_id);
      if (wt && wt.duration > 0 && (wt.last_position === 0 || wt.last_position / wt.duration > 0.9)) continue;
      if (taggedSet.has(r.video_id)) continue;
      if (dismissedSet.has(r.video_id)) continue;
      if (personalRatings.get(r.video_id) === -1) continue;

      const existing = relatedMap.get(r.video_id);
      if (existing) {
        existing.sourceCount++;
      } else {
        relatedMap.set(r.video_id, {
          video: {
            videoId: r.video_id,
            title: r.title,
            thumbnail: `https://i.ytimg.com/vi/${r.video_id}/mqdefault.jpg`,
            channelTitle: r.channel_title,
            channelId: r.channel_id,
            publishedAt: '', // related videos don't have exact dates
          },
          sourceCount: 1,
        });
      }
    }
    // Score related videos: 0.3 + min(1, sourceCount/3) * 0.3 + session bonus → range 0.3–0.75
    for (const entry of relatedMap.values()) {
      const sessionBonus = sessionRelatedSourceCount.get(entry.video.videoId) || 0;
      const relScore = 0.3 + Math.min(1, entry.sourceCount / 3) * 0.3
        + (sessionBonus > 0 ? SESSION_BOOST * Math.min(1, sessionBonus / 2) : 0);
      scored.push({ video: entry.video, score: relScore });
    }
  }

  // 5c. Score decomposition logging — emit aggregate signal averages
  const n = scoredVideos.length || 1;
  const topScore = scored.length > 0 ? Math.max(...scored.map(s => s.score)) : 0;
  const bottomScore = scored.length > 0 ? Math.min(...scored.map(s => s.score)) : 0;
  logger.info('explore-scores', {
    userId,
    candidates: scoredVideos.length,
    meaningful: meaningfulWatches.length,
    coldStart: isColdStart,
    avgAffinity: (signalStats.affinity.sum / n).toFixed(4),
    avgRecency: (signalStats.recency.sum / n).toFixed(4),
    avgTopicTotal: (signalStats.topicTotal.sum / n).toFixed(4),
    avgSession: (signalStats.session.sum / n).toFixed(4),
    avgTrending: (signalStats.trending.sum / n).toFixed(4),
    topScore: topScore.toFixed(4),
    bottomScore: bottomScore.toFixed(4),
  });

  // 5d. Score normalization — min-max normalize all scores to [0, 1]
  if (scored.length > 1) {
    const minScore = Math.min(...scored.map(s => s.score));
    const maxScore = Math.max(...scored.map(s => s.score));
    const range = maxScore - minScore;
    if (range > 0) {
      for (const entry of scored) {
        entry.score = (entry.score - minScore) / range;
      }
    }
  }

  // Performance instrumentation — t2: scoring + normalization complete
  const t2 = performance.now();

  // 6. Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  // 7. Apply variety penalty — per-channel positional decay (steeper for cold start)
  const channelPosition = new Map<string, number>();
  const VARIETY_DECAY = isColdStart ? [1.0, 0.4, 0.2, 0.1] : [1.0, 0.7, 0.5, 0.3];

  const finalScored = scored.map(entry => {
    const pos = channelPosition.get(entry.video.channelId) || 0;
    channelPosition.set(entry.video.channelId, pos + 1);
    const varietyMultiplier = pos < VARIETY_DECAY.length ? VARIETY_DECAY[pos] : 0.3;
    const finalScore = entry.score + varietyMultiplier * 0.15;
    return { video: entry.video, finalScore };
  });

  // Re-sort with variety included
  finalScored.sort((a, b) => b.finalScore - a.finalScore);

  // 8. Diversity injection — reserve slots for underrepresented subscribed channels
  const DIVERSITY_SLOTS = config.diversitySlots;
  const TOP_COUNT = config.topCount;
  const topN = finalScored.slice(0, TOP_COUNT - DIVERSITY_SLOTS - EXPLORATION_SLOTS);

  // Find subscribed channels not represented in top 54
  const topChannels = new Set(topN.map(e => e.video.channelId));
  const underrepresented = [...subscribedChannels].filter(ch => !topChannels.has(ch));

  // Pick random unwatched videos from underrepresented channels
  const topVideoIds = new Set(topN.map(e => e.video.videoId));
  const diversityCandidates = scoredVideos.filter(
    v => !topVideoIds.has(v.videoId) && underrepresented.includes(v.channelId)
  );
  const shuffled = [...diversityCandidates].sort(() => Math.random() - 0.5);
  const pickedChannels = new Set<string>();
  const diversityPicks: typeof topN = [];
  for (const v of shuffled) {
    if (diversityPicks.length >= DIVERSITY_SLOTS) break;
    if (pickedChannels.has(v.channelId)) continue;
    pickedChannels.add(v.channelId);
    v.reason = 'discover';
    diversityPicks.push({ video: v, finalScore: 0 });
  }

  // Splice into every ~10th position
  const merged = [...topN];
  for (let i = 0; i < diversityPicks.length; i++) {
    const pos = Math.min((i + 1) * 10 - 1, merged.length);
    merged.splice(pos, 0, diversityPicks[i]);
  }

  // 8b. Deep cut resurfacing — older gems from top-affinity channels
  const deepCutMinAgeMs = DEEP_CUT_MIN_AGE_DAYS * 24 * 60 * 60 * 1000;

  const sortedAffinityChannels = [...channelWatches.entries()]
    .filter(([, _stats]) => totalDecayedWatches > 0)
    .map(([chId, stats]) => ({
      chId,
      rawAffinity: (stats.decayedCount / totalDecayedWatches) * (stats.decayedCompletion / stats.decayedCount),
    }))
    .sort((a, b) => b.rawAffinity - a.rawAffinity)
    .slice(0, 5);

  const topAffinityChannelIds = new Set(sortedAffinityChannels.map(c => c.chId));
  const mergedVideoIds = new Set(merged.map(e => e.video.videoId));

  const deepCutCandidates = scoredVideos.filter(v => {
    if (mergedVideoIds.has(v.videoId)) return false;
    if (!topAffinityChannelIds.has(v.channelId)) return false;
    const pubMs = rssPublishMap.get(v.videoId);
    return pubMs !== undefined && (now - pubMs) >= deepCutMinAgeMs;
  });

  const deepCutShuffled = [...deepCutCandidates].sort(() => Math.random() - 0.5);
  const deepCutPicked: typeof topN = [];
  const deepCutChannels = new Set<string>();
  for (const v of deepCutShuffled) {
    if (deepCutPicked.length >= DEEP_CUT_SLOTS) break;
    if (deepCutChannels.has(v.channelId)) continue;
    deepCutChannels.add(v.channelId);
    v.reason = 'deep cut';
    deepCutPicked.push({ video: v, finalScore: 0 });
  }

  for (let i = 0; i < deepCutPicked.length; i++) {
    const pos = Math.min(20 + i * 12, merged.length);
    merged.splice(pos, 0, deepCutPicked[i]);
  }

  // 8c. Epsilon-greedy exploration — random mid-tier videos for serendipity
  const explorationPool = finalScored.slice(EXPLORATION_POOL_START, EXPLORATION_POOL_END);
  const mergedIdsAfterDeepCut = new Set(merged.map(e => e.video.videoId));
  const mergedChannelCounts = new Map<string, number>();
  for (const e of merged) {
    mergedChannelCounts.set(e.video.channelId, (mergedChannelCounts.get(e.video.channelId) || 0) + 1);
  }

  const explorationCandidates = explorationPool.filter(e =>
    !mergedIdsAfterDeepCut.has(e.video.videoId) &&
    (mergedChannelCounts.get(e.video.channelId) || 0) < 2
  );
  const explorationShuffled = [...explorationCandidates].sort(() => Math.random() - 0.5);
  const explorationPicked: typeof topN = [];
  const explorationChannels = new Set<string>();
  for (const e of explorationShuffled) {
    if (explorationPicked.length >= EXPLORATION_SLOTS) break;
    if (explorationChannels.has(e.video.channelId)) continue;
    explorationChannels.add(e.video.channelId);
    e.video.reason = 'explore';
    explorationPicked.push(e);
  }

  for (let i = 0; i < explorationPicked.length; i++) {
    const pos = Math.min((i + 1) * 10 - 5, merged.length);
    merged.splice(pos, 0, explorationPicked[i]);
  }

  // 8d. Emerging creator slots — splice 2 videos from emerging channels at positions ~25 and ~45
  const mergedIdsAfterExploration = new Set(merged.map(e => e.video.videoId));
  const emergingCandidates = scored.filter(e =>
    emergingChannels.has(e.video.channelId) && !mergedIdsAfterExploration.has(e.video.videoId)
  );
  const emergingShuffled = [...emergingCandidates].sort(() => Math.random() - 0.5);
  const emergingPicked: typeof merged = [];
  const emergingPickedChannels = new Set<string>();
  for (const e of emergingShuffled) {
    if (emergingPicked.length >= config.emergingSlots) break;
    if (emergingPickedChannels.has(e.video.channelId)) continue;
    emergingPickedChannels.add(e.video.channelId);
    e.video.reason = 'emerging';
    emergingPicked.push({ video: e.video, finalScore: 0 });
  }
  const emergingPositions = [25, 45];
  for (let i = 0; i < emergingPicked.length; i++) {
    const pos = Math.min(emergingPositions[i], merged.length);
    merged.splice(pos, 0, emergingPicked[i]);
  }

  // 8e. Filter bubble prevention — top-10 channel cap (max 2 per channel)
  const TOP_SLOT_CAP = 2;
  const TOP_SLOT_COUNT = 10;
  if (merged.length > TOP_SLOT_COUNT) {
    const channelCountInTop = new Map<string, number>();
    const overflow: typeof merged = [];
    for (let i = 0; i < Math.min(TOP_SLOT_COUNT, merged.length); i++) {
      const chId = merged[i].video.channelId;
      const cnt = (channelCountInTop.get(chId) || 0) + 1;
      channelCountInTop.set(chId, cnt);
      if (cnt > TOP_SLOT_CAP) {
        overflow.push(merged[i]);
        merged.splice(i, 1);
        i--;
      }
    }
    // Re-insert overflow after position 10
    for (let i = 0; i < overflow.length; i++) {
      const insertPos = Math.min(TOP_SLOT_COUNT + i, merged.length);
      merged.splice(insertPos, 0, overflow[i]);
    }
  }

  // 8f. Topic diversity — MMR re-ranking of top 10 for topic variety
  if (merged.length > 10) {
    const topVideos = merged.slice(0, 10).map(e => e.video);
    const reranked = ensureTopicDiversity(topVideos, 10);
    for (let i = 0; i < reranked.length; i++) {
      merged[i] = { video: reranked[i], finalScore: merged[i].finalScore };
    }
  }

  // 8g. Concentration guard — warn if top-3 channels occupy >50% of feed
  {
    const feedChannelCounts = new Map<string, number>();
    const feedLen = Math.min(TOP_COUNT, merged.length);
    for (let i = 0; i < feedLen; i++) {
      const chId = merged[i].video.channelId;
      feedChannelCounts.set(chId, (feedChannelCounts.get(chId) || 0) + 1);
    }
    const sortedCounts = [...feedChannelCounts.values()].sort((a, b) => b - a);
    const top3Sum = (sortedCounts[0] || 0) + (sortedCounts[1] || 0) + (sortedCounts[2] || 0);
    if (top3Sum > feedLen * 0.5) {
      logger.info('explore-concentration-warning', {
        userId,
        top3ChannelShare: (top3Sum / feedLen).toFixed(2),
        feedSize: feedLen,
      });
    }
  }

  const finalVideoList = merged.slice(0, TOP_COUNT).map(e => e.video);

  // 8h. Explore evaluation metrics — comprehensive quality metrics
  const metrics = computeExploreMetrics(scored, finalVideoList, signalStats, n);
  logger.info('explore-eval', {
    userId,
    scoreP25: metrics.scoreP25.toFixed(4),
    scoreP50: metrics.scoreP50.toFixed(4),
    scoreP75: metrics.scoreP75.toFixed(4),
    scoreStdDev: metrics.scoreStdDev.toFixed(4),
    channelHHI: metrics.channelHHI.toFixed(4),
    uniqueChannelsTop10: metrics.uniqueChannelsTop10,
    uniqueChannelsTop30: metrics.uniqueChannelsTop30,
    reasonDistribution: metrics.reasonDistribution,
    affinityVariance: metrics.affinityVariance.toFixed(6),
    recencyVariance: metrics.recencyVariance.toFixed(6),
    topicVariance: metrics.topicVariance.toFixed(6),
  });
  const newVideoIds = finalVideoList
    .filter(v => !videoImpressionCount.has(v.videoId))
    .map(v => v.videoId);
  const result: ExploreResult = { videos: finalVideoList, continueWatching: [], newVideoIds };

  // Performance instrumentation — t3: post-processing complete
  const t3 = performance.now();
  logger.info('explore-perf', {
    userId,
    totalMs: Math.round(t3 - t0),
    dbMs: Math.round(t1 - t0),
    scoringMs: Math.round(t2 - t1),
    postMs: Math.round(t3 - t2),
    candidates: scoredVideos.length,
    finalCount: finalVideoList.length,
  });

  cache.exploreVideos.set(userId, { data: result, expires: Date.now() + EXPLORE_TTL });

  // Periodic prune — fire-and-forget, at most once per hour
  if (now - lastPruneTime > 60 * 60 * 1000) {
    lastPruneTime = now;
    void Promise.resolve(db.pruneRelatedVideos(30));
    void Promise.resolve(db.pruneExploreEvents(90));
    void Promise.resolve(db.pruneExploreSessions(90));
  }

  return result;
}

export { getExploreVideos, DEFAULT_EXPLORE_CONFIG };
export type { ExploreConfig };
