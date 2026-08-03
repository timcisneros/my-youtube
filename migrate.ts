import logger from './lib/logger.js';

try {
  const db = (await import('./db.js')).default;
  if (db._ready !== undefined) await db._ready;
  let legacyRssRows = 0;
  let legacyRssBatches = 0;
  let legacyRssApplied = false;
  if (!await db.hasSchemaMigration('legacy-rss-normalization-v1')) {
    const rssBatchSize = Math.min(1_000, Math.max(1, Number(process.env.RSS_LEGACY_MIGRATION_BATCH_SIZE) || 200));
    while (true) {
      const processed = await db.backfillLegacyRssBatch(rssBatchSize);
      if (processed === 0) break;
      legacyRssRows += processed;
      legacyRssBatches++;
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    await db.recordSchemaMigration('legacy-rss-normalization-v1');
    legacyRssApplied = true;
  }
  let exploreRollups: Awaited<ReturnType<typeof db.rebuildExploreSignalRollups>> | null = null;
  if (!await db.hasSchemaMigration('explore-signal-rollups-v1')) {
    exploreRollups = await db.rebuildExploreSignalRollups(
      Math.min(365, Math.max(7, Number(process.env.EXPLORE_COWATCH_MAX_AGE_DAYS) || 90)),
      Math.min(200, Math.max(5, Number(process.env.EXPLORE_COWATCH_PER_USER_LIMIT) || 50)),
    );
    await db.recordSchemaMigration('explore-signal-rollups-v1');
  }
  let downloadManifestsCreated = 0;
  let downloadManifestBackfillApplied = false;
  if (!await db.hasSchemaMigration('download-format-manifests-v1')) {
    const { backfillDownloadedFormatManifests } = await import('./lib/download-files.js');
    downloadManifestsCreated = await backfillDownloadedFormatManifests(
      Math.min(32, Math.max(1, Number(process.env.DOWNLOAD_MANIFEST_CONCURRENCY) || 8)),
      Math.min(2_000, Math.max(16, Number(process.env.DOWNLOAD_MANIFEST_BATCH_SIZE) || 256)),
    );
    await db.recordSchemaMigration('download-format-manifests-v1');
    downloadManifestBackfillApplied = true;
  }
  logger.info('database migrations complete', {
    legacyRssRows,
    legacyRssBatches,
    legacyRssApplied,
    exploreRollups,
    downloadManifestsCreated,
    downloadManifestBackfillApplied,
  });
  process.exit(0);
} catch (error) {
  logger.error('database migrations failed', {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
}
