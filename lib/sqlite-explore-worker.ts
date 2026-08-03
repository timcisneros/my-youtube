import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { querySqliteExploreCandidateSignals, type ExploreCandidateSignalArgs } from './explore-candidate-signals.js';
import { querySqliteExploreUserSignals } from './explore-user-signals.js';
import { querySqliteExploreRssSnapshot, type SQLiteExploreRssSnapshotArgs } from './explore-rss-snapshot.js';
import {
  querySqliteRssVideosCursorPageForUser,
  querySqliteRssVideosForUser,
  querySqliteRssVideosPageForUser,
  type SQLiteRssVideoCursorPageQueryArgs,
  type SQLiteRssVideoPageQueryArgs,
  type SQLiteRssVideoQueryArgs,
} from './sqlite-rss-videos.js';

type WorkerRequest = {
  id: number;
  deadline: number;
} & (
  | { operation: 'candidate-signals'; args: ExploreCandidateSignalArgs }
  | {
      operation: 'user-signals';
      args: {
        userId: string;
        relevantVideoIds: string[];
        relevantChannelIds: string[];
        maxAgeDays: number;
      };
    }
  | { operation: 'rss-videos'; args: SQLiteRssVideoQueryArgs }
  | { operation: 'explore-rss-snapshot'; args: SQLiteExploreRssSnapshotArgs }
  | { operation: 'rss-video-page'; args: SQLiteRssVideoPageQueryArgs }
  | { operation: 'rss-video-cursor-page'; args: SQLiteRssVideoCursorPageQueryArgs }
);

const database = new Database(workerData.databasePath, { readonly: true, fileMustExist: true });
database.pragma('query_only = ON');

parentPort?.on('message', (request: WorkerRequest) => {
  // The parent dispatches at most one query at a time and supplies the caller's
  // deadline. This guard prevents work that expired while crossing the worker
  // boundary from starting at all.
  if (Date.now() >= request.deadline) {
    parentPort?.postMessage({ id: request.id, expired: true });
    return;
  }
  try {
    const result = request.operation === 'candidate-signals'
      ? querySqliteExploreCandidateSignals(database, request.args)
      : request.operation === 'user-signals'
        ? querySqliteExploreUserSignals(
            database,
            request.args.userId,
            request.args.relevantVideoIds,
            request.args.relevantChannelIds,
            request.args.maxAgeDays,
          )
        : request.operation === 'explore-rss-snapshot'
          ? querySqliteExploreRssSnapshot(database, request.args)
        : request.operation === 'rss-video-page'
          ? querySqliteRssVideosPageForUser(database, request.args)
          : request.operation === 'rss-video-cursor-page'
            ? querySqliteRssVideosCursorPageForUser(database, request.args)
          : querySqliteRssVideosForUser(database, request.args);
    parentPort?.postMessage({ id: request.id, result });
  } catch (error) {
    parentPort?.postMessage({ id: request.id, error: (error as Error).message });
  }
});
