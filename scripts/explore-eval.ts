/**
 * Offline evaluation for the Explore recommendation algorithm.
 *
 * For each user with sufficient watch history, holds out the N most recent
 * watches, runs the algorithm on the remaining data, and checks if held-out
 * videos would have been recommended.
 *
 * Usage: npm run eval:explore
 */
import db from '../db.js';
import { getExploreVideos, DEFAULT_EXPLORE_CONFIG } from '../youtube/explore.js';
import type { ExploreConfig } from '../youtube/explore.js';

const evalConfig: ExploreConfig = DEFAULT_EXPLORE_CONFIG;
import { cache } from '../youtube/shared.js';

const HOLDOUT_COUNT = 10;
const MIN_WATCHES = 15;

// Sentinel error used to force savepoint rollback without indicating a real failure
class RollbackSentinel extends Error {
  constructor() { super('__eval_rollback__'); }
}

interface UserResult {
  userId: string;
  totalWatches: number;
  hit10: number;
  hit30: number;
  hit60: number;
}

// Accept user IDs as CLI args, or try common patterns
let userIds: string[] = [];
const cliUsers = process.argv.slice(2);
if (cliUsers.length > 0) {
  userIds = cliUsers;
} else {
  // Try to find users by checking who has watch data
  // Without raw SQL access, we check a few common patterns
  const candidates = ['admin', 'user', 'default', 'demo', 'test'];
  for (const uid of candidates) {
    const watches = db.getAllWatchTimesForUser(uid);
    if (watches.length >= MIN_WATCHES) userIds.push(uid);
  }
  // Also check the subscriptions table for any user IDs
  // Since getSubscriptions requires a userId, try to find via getAllRssCacheForUser pattern
  // For a pragmatic eval, we accept that users must be specified via CLI in multi-user setups
}

if (userIds.length === 0) {
  console.log('Explore Offline Evaluation');
  console.log('==========================');
  console.log(`No users with ${MIN_WATCHES}+ meaningful watches found.`);
  console.log('Usage: npm run eval:explore [userId1] [userId2] ...');
  console.log('Tip: Pass user IDs as arguments, or ensure common user IDs (admin, user, default) have watch history.');
  process.exit(0);
}

const results: UserResult[] = [];

for (const userId of userIds) {
  const allWatches = db.getAllWatchTimesForUser(userId)
    .filter(wt => wt.duration > 0 && (wt.last_position === 0 || wt.last_position / wt.duration > 0.3))
    .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());

  if (allWatches.length < MIN_WATCHES) continue;

  const holdout = allWatches.slice(0, HOLDOUT_COUNT);
  const holdoutIds = new Set(holdout.map(wt => wt.video_id));
  // Store original watch data for restoration
  const originalData = holdout.map(wt => ({
    videoId: wt.video_id,
    position: wt.last_position,
    duration: wt.duration,
  }));

  try {
    db.runInSavepoint(() => {
      // Temporarily zero out held-out watches
      for (const wt of holdout) {
        db.setWatchTime(userId, wt.video_id, 0, 0);
      }

      // Clear explore cache so algorithm runs fresh
      cache.exploreVideos.delete(userId);

      // Run the algorithm
      const result = getExploreVideos(userId, undefined, evalConfig);
      const recommendedIds = result.videos.map(v => v.videoId);

      // Check hits at different depths
      let hit10 = 0, hit30 = 0, hit60 = 0;
      for (const heldId of holdoutIds) {
        const pos = recommendedIds.indexOf(heldId);
        if (pos !== -1 && pos < 10) hit10++;
        if (pos !== -1 && pos < 30) hit30++;
        if (pos !== -1 && pos < 60) hit60++;
      }

      results.push({
        userId,
        totalWatches: allWatches.length,
        hit10,
        hit30,
        hit60,
      });

      // Throw to trigger rollback — restores held-out watch data
      throw new RollbackSentinel();
    });
  } catch (e) {
    if (e instanceof RollbackSentinel) {
      // Expected — savepoint was rolled back, data restored
    } else {
      // Unexpected error — restore data manually just in case
      for (const orig of originalData) {
        db.setWatchTime(userId, orig.videoId, orig.position, orig.duration);
      }
      console.error(`Error evaluating user ${userId}:`, e);
    }
  }

  // Clear cache after evaluation
  cache.exploreVideos.delete(userId);
}

// Print results
console.log('Explore Offline Evaluation');
console.log('==========================');
console.log(`Users evaluated: ${results.length}  (min ${MIN_WATCHES} meaningful watches)`);
console.log(`Holdout: ${HOLDOUT_COUNT} most recent watches per user`);
console.log('');

for (const r of results) {
  console.log(`User: ${r.userId} (${r.totalWatches} watches)`);
  console.log(`  Hit@10:  ${r.hit10}/${HOLDOUT_COUNT} (${(r.hit10 / HOLDOUT_COUNT * 100).toFixed(1)}%)`);
  console.log(`  Hit@30:  ${r.hit30}/${HOLDOUT_COUNT} (${(r.hit30 / HOLDOUT_COUNT * 100).toFixed(1)}%)`);
  console.log(`  Hit@60:  ${r.hit60}/${HOLDOUT_COUNT} (${(r.hit60 / HOLDOUT_COUNT * 100).toFixed(1)}%)`);
  console.log('');
}

if (results.length > 0) {
  const avgHit10 = results.reduce((s, r) => s + r.hit10, 0) / results.length / HOLDOUT_COUNT * 100;
  const avgHit30 = results.reduce((s, r) => s + r.hit30, 0) / results.length / HOLDOUT_COUNT * 100;
  const avgHit60 = results.reduce((s, r) => s + r.hit60, 0) / results.length / HOLDOUT_COUNT * 100;
  console.log('Aggregate:');
  console.log(`  Hit@10:  ${avgHit10.toFixed(1)}%`);
  console.log(`  Hit@30:  ${avgHit30.toFixed(1)}%`);
  console.log(`  Hit@60:  ${avgHit60.toFixed(1)}%`);
} else {
  console.log('No users met the minimum watch threshold.');
}
