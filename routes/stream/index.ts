import express from 'express';
import { validateStreamToken } from '../../auth.js';
const router = express.Router();

// Batch endpoints (no :videoId param) must be mounted BEFORE the /:videoId
// param validator, otherwise Express matches "durations-live" as a videoId.
import { mountBatchRoutes } from './assets.js';
mountBatchRoutes(router);

// Validate :videoId params across all stream routes
router.param('videoId', (_req, res, next, value) => {
  if (!/^[A-Za-z0-9_-]{11}$/.test(value)) return res.status(400).end('Invalid video ID');
  next();
});

// Stream token auth — validates HMAC-signed token for all routes except
// prefetch, status, poster, and thumb (lightweight/public endpoints)
router.use('/:videoId', (req, res, next) => {
  const suffix = req.path.split('/').pop();
  if (suffix === 'prefetch' || suffix === 'status' || suffix === 'poster' || suffix === 'thumb' || suffix === 'offline-bundle') return next();
  const token = req.query.token;
  if (!token || !validateStreamToken(req.params.videoId, token)) {
    return res.status(401).end();
  }
  next();
});

// Import sub-modules and mount routes
import { getCached } from './extraction.js';
import { buildMPD } from './mpd.js';
import { bgDownloads, cleanupBgDownload } from './downloads.js';

// Prefetch endpoint — called early by the page to warm caches
// buildMPD deduplicates via mpdInflight, so no concurrency guard needed
router.get('/:videoId/prefetch', async (req, res) => {
  const { videoId } = req.params;
  res.status(204).end();
  if (getCached(videoId)) return;
  // Extraction rate limit
  if (req.app.extractionRateCheck && !req.app.extractionRateCheck(req.ip, videoId)) return;
  buildMPD(videoId).catch(err => console.warn(`[prefetch ${videoId}]`, err.message));
});

// Mount all route groups
import { mountStatusRoutes } from './status.js';
import { mountDashRoutes } from './dash-routes.js';
import { mountHlsRoutes } from './hls.js';
import { mountSubtitleRoutes } from './subtitles.js';
import { mountProxyRoutes } from './proxy.js';
import { mountAssetRoutes } from './assets.js';
import { mountDownloadRoutes } from './downloads.js';

mountStatusRoutes(router);
mountDashRoutes(router);
mountHlsRoutes(router);
mountSubtitleRoutes(router);
mountProxyRoutes(router);
mountAssetRoutes(router);
mountDownloadRoutes(router);

export default router;
export { bgDownloads, cleanupBgDownload, buildMPD };
