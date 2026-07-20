/**
 * Explore evaluation metrics — pure functions for measuring
 * recommendation quality, diversity, and filter bubble detection.
 */

// ---- Shared text utilities (used by explore.ts too) ----

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had',
  'her', 'was', 'one', 'our', 'out', 'has', 'have', 'been', 'some', 'them',
  'than', 'its', 'over', 'such', 'that', 'this', 'with', 'will', 'each',
  'from', 'they', 'into', 'more', 'other', 'about', 'their', 'which', 'what',
  'there', 'when', 'how', 'who', 'why', 'where', 'just', 'also', 'very',
]);

export function tokenize(title: unknown): string[] {
  return String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length >= 3 && !STOP_WORDS.has(w));
}

// ---- Metric types ----

interface ScoredEntry {
  video: { videoId: string; channelId: string; title: string; reason?: string };
  score: number;
}

interface SignalStats {
  affinity: { sum: number; min: number; max: number; sumSq: number };
  recency: { sum: number; min: number; max: number; sumSq: number };
  topicTotal: { sum: number; min: number; max: number; sumSq: number };
  session: { sum: number; min: number; max: number; sumSq: number };
  trending: { sum: number; min: number; max: number; sumSq: number };
}

interface ExploreMetrics {
  scoreP25: number;
  scoreP50: number;
  scoreP75: number;
  scoreStdDev: number;
  channelHHI: number;
  uniqueChannelsTop10: number;
  uniqueChannelsTop30: number;
  uniqueChannelsTop60: number;
  reasonDistribution: Record<string, number>;
  affinityVariance: number;
  recencyVariance: number;
  topicVariance: number;
  sessionVariance: number;
  trendingVariance: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function variance(sum: number, sumSq: number, n: number): number {
  if (n <= 1) return 0;
  return Math.max(0, sumSq / n - (sum / n) ** 2);
}

/**
 * Compute comprehensive evaluation metrics from scored videos and final output.
 */
export function computeExploreMetrics(
  scored: ScoredEntry[],
  finalVideos: Array<{ channelId: string; reason?: string }>,
  signalStats: SignalStats,
  count: number,
): ExploreMetrics {
  // Score distribution
  const scores = scored.map(s => s.score).sort((a, b) => a - b);
  const scoreP25 = percentile(scores, 25);
  const scoreP50 = percentile(scores, 50);
  const scoreP75 = percentile(scores, 75);

  const mean = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
  const scoreVariance = scores.length > 1
    ? scores.reduce((acc, s) => acc + (s - mean) ** 2, 0) / scores.length
    : 0;
  const scoreStdDev = Math.sqrt(scoreVariance);

  // Channel concentration (HHI) on final video list
  const channelCounts = new Map<string, number>();
  for (const v of finalVideos) {
    channelCounts.set(v.channelId, (channelCounts.get(v.channelId) || 0) + 1);
  }
  const total = finalVideos.length || 1;
  let channelHHI = 0;
  for (const cnt of channelCounts.values()) {
    channelHHI += (cnt / total) ** 2;
  }

  // Unique channels at different depths
  const uniqueAt = (n: number) => new Set(finalVideos.slice(0, n).map(v => v.channelId)).size;
  const uniqueChannelsTop10 = uniqueAt(10);
  const uniqueChannelsTop30 = uniqueAt(30);
  const uniqueChannelsTop60 = uniqueAt(60);

  // Reason badge distribution
  const reasonDistribution: Record<string, number> = {};
  for (const v of finalVideos) {
    const reason = v.reason || 'for you';
    reasonDistribution[reason] = (reasonDistribution[reason] || 0) + 1;
  }

  // Per-signal variance
  const n = count || 1;
  const affinityVariance = variance(signalStats.affinity.sum, signalStats.affinity.sumSq, n);
  const recencyVariance = variance(signalStats.recency.sum, signalStats.recency.sumSq, n);
  const topicVariance = variance(signalStats.topicTotal.sum, signalStats.topicTotal.sumSq, n);
  const sessionVariance = variance(signalStats.session.sum, signalStats.session.sumSq, n);
  const trendingVariance = variance(signalStats.trending.sum, signalStats.trending.sumSq, n);

  return {
    scoreP25, scoreP50, scoreP75, scoreStdDev,
    channelHHI,
    uniqueChannelsTop10, uniqueChannelsTop30, uniqueChannelsTop60,
    reasonDistribution,
    affinityVariance, recencyVariance, topicVariance, sessionVariance, trendingVariance,
  };
}

// ---- Topic diversity (Feature 4) — MMR re-ranking of top slots ----

interface DiversityVideo {
  videoId: string;
  title: string;
  channelId: string;
  reason?: string;
}

function jaccardDistance(setA: Set<string>, setB: Set<string>): number {
  if (setA.size === 0 && setB.size === 0) return 1;
  let intersection = 0;
  for (const w of setA) {
    if (setB.has(w)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 1 : 1 - intersection / union;
}

/**
 * Greedy MMR re-ranking of top N slots to ensure topic diversity.
 * λ controls score-vs-novelty trade-off (0.7 = favor score, mild diversity).
 * Falls back to channel-based clustering when titles have <3 tokens.
 */
export function ensureTopicDiversity<T extends DiversityVideo>(
  videos: T[],
  topN: number,
  lambda: number = 0.7,
  _minClusters: number = 3,
): T[] {
  if (videos.length <= topN) return videos;

  const candidates = videos.slice(0, Math.max(topN * 2, 20)); // pool to pick from
  const rest = videos.slice(topN);

  // Tokenize each candidate; fall back to channelId for short titles
  const tokenSets: Map<number, Set<string>> = new Map();
  for (let i = 0; i < candidates.length; i++) {
    const tokens = tokenize(candidates[i].title);
    tokenSets.set(i, tokens.length >= 3
      ? new Set(tokens)
      : new Set([`__ch_${candidates[i].channelId}`]));
  }

  // Normalize scores to [0,1] within the candidate pool for MMR comparison
  const scores = candidates.map((_, i) => {
    // Use position-based score: first item = 1.0, last = 0.0
    return 1 - i / Math.max(1, candidates.length - 1);
  });

  const selected: number[] = [];
  const remaining = new Set(Array.from({ length: candidates.length }, (_, i) => i));

  // Pick the highest-scored first
  selected.push(0);
  remaining.delete(0);

  while (selected.length < topN && remaining.size > 0) {
    let bestIdx = -1;
    let bestMMR = -Infinity;

    for (const idx of remaining) {
      const scoreComponent = scores[idx];

      // Novelty = min Jaccard distance to any already-selected video
      let minDist = 1;
      for (const selIdx of selected) {
        const dist = jaccardDistance(tokenSets.get(idx)!, tokenSets.get(selIdx)!);
        if (dist < minDist) minDist = dist;
      }

      const mmr = lambda * scoreComponent + (1 - lambda) * minDist;
      if (mmr > bestMMR) {
        bestMMR = mmr;
        bestIdx = idx;
      }
    }

    if (bestIdx === -1) break;
    selected.push(bestIdx);
    remaining.delete(bestIdx);
  }

  // Build result: re-ranked top N + unchanged rest
  const reranked = selected.map(i => candidates[i]);
  // Append any remaining from the original top pool that weren't selected
  const selectedSet = new Set(selected);
  for (let i = 0; i < Math.min(topN, candidates.length); i++) {
    if (!selectedSet.has(i)) rest.unshift(candidates[i]);
  }

  return [...reranked, ...rest];
}
