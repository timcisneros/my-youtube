/**
 * Coordinate descent weight optimizer for the Explore recommendation algorithm.
 *
 * Systematically tunes ~20 high-leverage weights by perturbing each ±step,
 * keeping improvements, and repeating until convergence. Uses a multiplicative
 * combination (weighted geometric mean) matching YouTube's Zhao et al. 2019
 * architecture, with exponents aligned to 2025 reported priorities:
 * satisfaction^0.35 × completionRank^0.25 × qualityCtr^0.25 × session^0.15.
 * Diversity is handled by post-processing (MMR, filter bubble caps) not the
 * scoring product, matching YouTube's approach.
 *
 * Usage: npm run optimize:explore [userId1] [userId2] ...
 */
import db from '../db.js';
import { getExploreVideos, DEFAULT_EXPLORE_CONFIG } from '../youtube/explore.js';
import type { ExploreConfig } from '../youtube/explore.js';
import { cache } from '../youtube/shared.js';

const HOLDOUT_COUNT = 10;
const MIN_WATCHES = 15;
const INITIAL_STEP_FRACTION = 0.20;
const MIN_STEP_FRACTION = 0.01;
const STEP_DECAY = 0.5;
const MAX_PASSES = 50;
const HIT_WEIGHTS = { hit10: 0.5, hit30: 0.3, hit60: 0.2 };
const MAX_HIT_WEIGHT_SUM = HIT_WEIGHTS.hit10 + HIT_WEIGHTS.hit30 + HIT_WEIGHTS.hit60;

/**
 * Exponents for multiplicative objective (weighted geometric mean).
 * Aligned to 2025 YouTube priorities. Diversity excluded — handled by
 * post-processing (MMR re-ranking, filter bubble caps, diversity injection).
 */
const OBJECTIVE_EXPONENTS = {
  satisfaction: 0.35,      // p(like) proxy — satisfaction-weighted hits
  completionRank: 0.25,    // E[watch_time] proxy — completion prediction alignment
  qualityCtr: 0.25,        // (1-p(dismiss)) proxy — quality CTR / click prediction
  session: 0.15,           // Session continuation / return visit proxy
};

/** Floor to prevent any signal from zeroing the entire product. */
const SIGNAL_FLOOR = 0.01;

/** Session pair detection window (ms). */
const SESSION_GAP_MS = 2 * 60 * 60 * 1000;

/** Max rank distance for session pair bonus. */
const SESSION_RANK_PROXIMITY = 10;

/** ~20 high-leverage weights to tune */
const TUNABLE_KEYS: (keyof ExploreConfig)[] = [
  // Core weights
  'affinityWeight', 'recencyWeight', 'topicCap', 'velocityWeight',
  'cadenceWeight', 'todWeight', 'channelRecencyWeight', 'dowWeight',
  // Major boosts/penalties
  'sessionBoost', 'seriesBoost', 'seriesNextBoost', 'bingeBoost',
  'bingeExhaustPenalty', 'shortsPenalty', 'liveBoost', 'emergingBoost',
  'personalRatingUpBoost', 'personalRatingDownPenalty',
  'cowatchWeight', 'momentumWeight',
];

// Sentinel error used to force savepoint rollback without indicating a real failure
class RollbackSentinel extends Error {
  constructor() { super('__optimize_rollback__'); }
}

// Accept user IDs as CLI args, or try common patterns
let userIds: string[] = [];
const cliUsers = process.argv.slice(2);
if (cliUsers.length > 0) {
  userIds = cliUsers;
} else {
  const candidates = ['admin', 'user', 'default', 'demo', 'test'];
  for (const uid of candidates) {
    const watches = db.getAllWatchTimesForUser(uid);
    if (watches.length >= MIN_WATCHES) userIds.push(uid);
  }
}

if (userIds.length === 0) {
  console.log('Explore Weight Optimizer');
  console.log('=======================');
  console.log(`No users with ${MIN_WATCHES}+ meaningful watches found.`);
  console.log('Usage: npm run optimize:explore [userId1] [userId2] ...');
  console.log('Tip: Pass user IDs as arguments, or ensure common user IDs (admin, user, default) have watch history.');
  process.exit(0);
}

/** Evaluate a config against holdout watches, returning a YouTube-aligned composite score. */
function evaluateConfig(config: ExploreConfig, evalUserIds: string[]): number {
  const userScores: number[] = [];

  for (const userId of evalUserIds) {
    const allWatches = db.getAllWatchTimesForUser(userId)
      .filter(wt => wt.duration > 0 && (wt.last_position === 0 || wt.last_position / wt.duration > 0.3))
      .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());

    if (allWatches.length < MIN_WATCHES) continue;

    const holdout = allWatches.slice(0, HOLDOUT_COUNT);
    const holdoutIds = new Set(holdout.map(wt => wt.video_id));
    const originalData = holdout.map(wt => ({
      videoId: wt.video_id,
      position: wt.last_position,
      duration: wt.duration,
    }));

    // Pre-compute holdout completions and timestamps
    const holdoutCompletion = new Map<string, number>();
    const holdoutTimestamp = new Map<string, number>();
    for (const wt of holdout) {
      const completion = wt.last_position === 0 ? 1.0 : wt.last_position / wt.duration;
      holdoutCompletion.set(wt.video_id, completion);
      holdoutTimestamp.set(wt.video_id, new Date(wt.updated_at).getTime());
    }

    // Detect session pairs: consecutive holdout watches within 2h
    const sortedByTime = [...holdout].sort(
      (a, b) => new Date(a.updated_at).getTime() - new Date(b.updated_at).getTime()
    );
    const sessionPairs: Array<[string, string]> = [];
    for (let i = 0; i < sortedByTime.length - 1; i++) {
      const tA = new Date(sortedByTime[i].updated_at).getTime();
      const tB = new Date(sortedByTime[i + 1].updated_at).getTime();
      if (tB - tA <= SESSION_GAP_MS) {
        sessionPairs.push([sortedByTime[i].video_id, sortedByTime[i + 1].video_id]);
      }
    }

    let satisfactionScore = 0;
    let qualityCtrPenalty = 0;
    let sessionScore = 0;
    let concordanceScore = 0;

    try {
      db.runInSavepoint(() => {
        for (const wt of holdout) {
          db.setWatchTime(userId, wt.video_id, 0, 0);
        }

        cache.exploreVideos.delete(userId);

        const result = getExploreVideos(userId, undefined, config);
        const recommendedIds = result.videos.map(v => v.videoId);

        // Build rank map for holdout videos that appear in recommendations
        const rankMap = new Map<string, number>();
        for (const heldId of holdoutIds) {
          const pos = recommendedIds.indexOf(heldId);
          if (pos !== -1) rankMap.set(heldId, pos);
        }

        // Signal 1: Satisfaction-weighted hits
        for (const [videoId, pos] of rankMap) {
          const completion = holdoutCompletion.get(videoId)!;
          if (pos < 10) satisfactionScore += completion * HIT_WEIGHTS.hit10;
          if (pos < 30) satisfactionScore += completion * HIT_WEIGHTS.hit30;
          if (pos < 60) satisfactionScore += completion * HIT_WEIGHTS.hit60;
        }
        satisfactionScore /= HOLDOUT_COUNT * MAX_HIT_WEIGHT_SUM;

        // Signal 2: Quality CTR penalty — penalize abandoned clickbait
        for (const [videoId, pos] of rankMap) {
          const completion = holdoutCompletion.get(videoId)!;
          const wt = holdout.find(w => w.video_id === videoId)!;
          if (completion < 0.15 && wt.duration > 60 && pos < 60) {
            qualityCtrPenalty += 1;
          }
        }
        qualityCtrPenalty /= HOLDOUT_COUNT;

        // Signal 3: Session contribution — sequential watches near each other in recs
        let sessionHits = 0;
        for (const [vidA, vidB] of sessionPairs) {
          const rankA = rankMap.get(vidA);
          const rankB = rankMap.get(vidB);
          if (rankA !== undefined && rankB !== undefined
              && Math.abs(rankA - rankB) <= SESSION_RANK_PROXIMITY) {
            sessionHits++;
          }
        }
        sessionScore = sessionPairs.length > 0 ? sessionHits / sessionPairs.length : 1.0;

        // Signal 4: Completion prediction alignment (concordance)
        const rankedHoldouts = [...rankMap.entries()];
        let concordant = 0;
        let discordant = 0;
        for (let i = 0; i < rankedHoldouts.length; i++) {
          for (let j = i + 1; j < rankedHoldouts.length; j++) {
            const [vidA, rankA] = rankedHoldouts[i];
            const [vidB, rankB] = rankedHoldouts[j];
            const compA = holdoutCompletion.get(vidA)!;
            const compB = holdoutCompletion.get(vidB)!;
            if (compA === compB) continue;
            // Higher completion should have lower (better) rank
            if ((compA > compB && rankA < rankB) || (compB > compA && rankB < rankA)) {
              concordant++;
            } else {
              discordant++;
            }
          }
        }
        const totalPairs = concordant + discordant;
        concordanceScore = totalPairs > 0 ? (concordant - discordant + totalPairs) / (2 * totalPairs) : 0.5;

        throw new RollbackSentinel();
      });
    } catch (e) {
      if (e instanceof RollbackSentinel) {
        // Expected — savepoint was rolled back, data restored
      } else {
        for (const orig of originalData) {
          db.setWatchTime(userId, orig.videoId, orig.position, orig.duration);
        }
        console.error(`Error evaluating user ${userId}:`, e);
        continue;
      }
    }

    cache.exploreVideos.delete(userId);

    const score =
      Math.max(SIGNAL_FLOOR, satisfactionScore)       ** OBJECTIVE_EXPONENTS.satisfaction
      * Math.max(SIGNAL_FLOOR, concordanceScore)       ** OBJECTIVE_EXPONENTS.completionRank
      * Math.max(SIGNAL_FLOOR, 1 - qualityCtrPenalty)  ** OBJECTIVE_EXPONENTS.qualityCtr
      * Math.max(SIGNAL_FLOOR, sessionScore)           ** OBJECTIVE_EXPONENTS.session;
    userScores.push(score);
  }

  if (userScores.length === 0) return 0;
  return userScores.reduce((a, b) => a + b, 0) / userScores.length;
}

/** Produce a new config with one weight changed. */
function withWeight(cfg: ExploreConfig, key: keyof ExploreConfig, value: number): ExploreConfig {
  return { ...cfg, [key]: value } as ExploreConfig;
}

/** Clamp weight: penalty keys stay non-positive, others stay non-negative. */
function clampWeight(key: keyof ExploreConfig, value: number): number {
  if (DEFAULT_EXPLORE_CONFIG[key] < 0) return Math.min(0, value);
  return Math.max(0, value);
}

// Initialize
const bestConfig = { ...DEFAULT_EXPLORE_CONFIG };
let bestScore = evaluateConfig(bestConfig, userIds);

console.log('Explore Weight Optimizer');
console.log('=======================');
console.log(`Users: ${userIds.join(', ')}`);
console.log(`Tunable weights: ${TUNABLE_KEYS.length}`);
console.log(`Baseline score: ${bestScore.toFixed(4)}`);
console.log('');

// Per-key step sizes
const stepSizes: Partial<Record<keyof ExploreConfig, number>> = {};
for (const key of TUNABLE_KEYS) {
  stepSizes[key] = Math.max(Math.abs(DEFAULT_EXPLORE_CONFIG[key] * INITIAL_STEP_FRACTION), 0.005);
}

for (let pass = 1; pass <= MAX_PASSES; pass++) {
  let improved = false;

  for (const key of TUNABLE_KEYS) {
    const current = bestConfig[key];
    const step = stepSizes[key]!;

    const valuePlus = clampWeight(key, current + step);
    const valueMinus = clampWeight(key, current - step);

    const scorePlus = valuePlus !== current ? evaluateConfig(withWeight(bestConfig, key, valuePlus), userIds) : -1;
    const scoreMinus = valueMinus !== current ? evaluateConfig(withWeight(bestConfig, key, valueMinus), userIds) : -1;

    if (scorePlus > bestScore && scorePlus >= scoreMinus) {
      bestConfig[key] = valuePlus;
      bestScore = scorePlus;
      improved = true;
      console.log(`  Pass ${pass}: ${key} ${current.toFixed(4)} → ${valuePlus.toFixed(4)} (score ${bestScore.toFixed(4)})`);
    } else if (scoreMinus > bestScore) {
      bestConfig[key] = valueMinus;
      bestScore = scoreMinus;
      improved = true;
      console.log(`  Pass ${pass}: ${key} ${current.toFixed(4)} → ${valueMinus.toFixed(4)} (score ${bestScore.toFixed(4)})`);
    }
  }

  if (!improved) {
    let allAtMinimum = true;
    for (const key of TUNABLE_KEYS) {
      stepSizes[key] = stepSizes[key]! * STEP_DECAY;
      const minStep = Math.max(Math.abs(DEFAULT_EXPLORE_CONFIG[key] * MIN_STEP_FRACTION), 0.0001);
      if (stepSizes[key]! > minStep) allAtMinimum = false;
    }
    if (allAtMinimum) {
      console.log(`\nConverged after ${pass} passes.`);
      break;
    }
    console.log(`  Pass ${pass}: no improvement — halving step sizes`);
  }

  if (pass === MAX_PASSES) {
    console.log(`\nReached maximum ${MAX_PASSES} passes.`);
  }
}

// Output results
const baselineScore = evaluateConfig({ ...DEFAULT_EXPLORE_CONFIG }, userIds);
const improvement = bestScore - baselineScore;

console.log('');
console.log('========== OPTIMIZATION RESULTS ==========');
console.log(`Baseline score: ${baselineScore.toFixed(4)}`);
console.log(`Optimized score: ${bestScore.toFixed(4)}`);
console.log(`Improvement: ${improvement >= 0 ? '+' : ''}${(improvement * 100).toFixed(2)}%`);
console.log('');
console.log('Optimized config:');
console.log('const OPTIMIZED_CONFIG: ExploreConfig = {');

const configKeys = Object.keys(DEFAULT_EXPLORE_CONFIG) as (keyof ExploreConfig)[];
for (let i = 0; i < configKeys.length; i++) {
  const key = configKeys[i];
  const val = bestConfig[key];
  const def = DEFAULT_EXPLORE_CONFIG[key];
  const changed = val !== def;
  const comma = i < configKeys.length - 1 ? ',' : ',';
  const marker = changed ? '  // ← changed' : '';
  console.log(`  ${key}: ${val}${comma}${marker}`);
}

console.log('};');
