import fs from 'fs';
import { createHash, randomUUID } from 'crypto';
import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';
import express from 'express';
import db from '../../db.js';
import { incrementMetric, observeMetric, setMetricGauge } from '../../lib/performance-metrics.js';
import {
  fetchWithConnTimeout,
  sanitizeHeaders,
  formatCache,
  mpdCache,
  urlLookup,
  hlsCache,
  vttCache,
  storyboardUrlCache,
  liveStoryboardCache,
  extractionStatus,
  MAX_BG_DOWNLOADS,
  BG_MAX_AGE,
  CACHE_TTL,
} from './shared.js';
import { getCached } from './extraction.js';
import { createStreamToken } from '../../auth.js';
import { buildMPD } from './mpd.js';
import {
  cancelQueuedDownload,
  enqueueDownload,
  hasDownloadQueue,
} from '../../lib/download-queue.js';
import {
  deleteVideoDownloadFiles,
  downloadedFormatPath,
  listDownloadedFormats,
  recordDownloadedFormats,
  removeDownloadedFormatRecords,
} from '../../lib/download-files.js';
import {
  DOWNLOAD_MAX_FORMAT_BYTES,
  DOWNLOAD_MAX_VIDEO_BYTES,
  DownloadStorageError,
  assertDownloadFreeSpace,
  checkDownloadStorageCapacity,
  estimateDownloadBytes,
  reserveLocalDownloadStorage,
} from '../../lib/download-storage.js';

type BgDownloadEntry = {
  filePath: string;
  bytesDownloaded: number;
  totalSize: number;
  done: boolean;
  startedAt: number;
  abort: (() => void) | null;
  accountedBytes: number;
};

// Preserve direct "videoId:itag" access while maintaining a per-video index
// for status, manifest, deletion, and offline-bundle operations.
const bgDownloads = new Map<string, BgDownloadEntry>();
const bgDownloadsByVideo = new Map<string, Map<string, BgDownloadEntry>>();
const EMPTY_VIDEO_DOWNLOADS: ReadonlyMap<string, BgDownloadEntry> = new Map();
let activeBgDownloads = 0;
const downloadRequirements = new Map<string, Set<string>>();
const downloadStorageReleases = new Map<string, () => Promise<void>>();
const downloadExistingBytes = new Map<string, number>();
const DOWNLOAD_PROGRESS_UPDATE_MS = Math.max(250, Number(process.env.DOWNLOAD_PROGRESS_UPDATE_MS) || 1000);
const downloadProgressStates = new Map<string, {
  dirty: boolean;
  timer: NodeJS.Timeout | null;
  write: Promise<void> | null;
}>();

function activeDownloadCount() {
  return activeBgDownloads;
}

function getVideoDownloads(videoId: string): ReadonlyMap<string, BgDownloadEntry> {
  return bgDownloadsByVideo.get(videoId) || EMPTY_VIDEO_DOWNLOADS;
}

function indexBgDownload(videoId: string, formatId: string, entry: BgDownloadEntry) {
  const key = `${videoId}:${formatId}`;
  const previous = bgDownloads.get(key);
  if (previous && !previous.done) activeBgDownloads--;
  bgDownloads.set(key, entry);
  let formats = bgDownloadsByVideo.get(videoId);
  if (!formats) {
    formats = new Map();
    bgDownloadsByVideo.set(videoId, formats);
  }
  formats.set(formatId, entry);
  if (!entry.done) activeBgDownloads++;
}

function unindexBgDownload(videoId: string, formatId: string) {
  const key = `${videoId}:${formatId}`;
  const entry = bgDownloads.get(key);
  if (entry && !entry.done) activeBgDownloads--;
  bgDownloads.delete(key);
  const formats = bgDownloadsByVideo.get(videoId);
  formats?.delete(formatId);
  if (formats?.size === 0) bgDownloadsByVideo.delete(videoId);
}

function hasActiveDownload(videoId: string) {
  for (const entry of getVideoDownloads(videoId).values()) if (!entry.done) return true;
  return false;
}

async function releaseDownloadStorage(videoId: string) {
  const release = downloadStorageReleases.get(videoId);
  downloadExistingBytes.delete(videoId);
  if (!release) return;
  downloadStorageReleases.delete(videoId);
  await release();
}

function updateDownloadMetrics() {
  setMetricGauge('background_downloads_active', activeDownloadCount());
}

function progressState(videoId: string) {
  let state = downloadProgressStates.get(videoId);
  if (!state) {
    state = { dirty: false, timer: null, write: null };
    downloadProgressStates.set(videoId, state);
  }
  return state;
}

function scheduleDownloadProgress(videoId: string) {
  const state = progressState(videoId);
  state.dirty = true;
  if (state.timer !== null || state.write !== null) return;
  state.timer = setTimeout(() => {
    state.timer = null;
    void flushDownloadProgress(videoId).catch((err) => {
      incrementMetric('background_download_progress_writes_total', { result: 'error' });
      console.warn(`[bg-cache] progress update failed for ${videoId}:`, err.message);
    });
  }, DOWNLOAD_PROGRESS_UPDATE_MS);
  state.timer.unref?.();
}

async function flushDownloadProgress(videoId: string, force = false): Promise<void> {
  const state = progressState(videoId);
  if (force) state.dirty = true;
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  if (state.write !== null) {
    await state.write;
    return flushDownloadProgress(videoId);
  }
  if (!state.dirty) return;

  state.dirty = false;
  const aggregate = aggregateProgress(videoId);
  const write = Promise.resolve()
    .then(() => db.updateDownloadProgress(videoId, aggregate.downloadedBytes, aggregate.totalBytes))
    .then(() => {
      incrementMetric('background_download_progress_writes_total', { result: 'stored' });
    });
  state.write = write;
  try {
    await write;
  } finally {
    if (state.write === write) state.write = null;
  }
  if (state.dirty) {
    scheduleDownloadProgress(videoId);
    return;
  }
  if (!hasActiveDownload(videoId)) downloadProgressStates.delete(videoId);
}

function discardDownloadProgress(videoId: string) {
  if (hasActiveDownload(videoId)) return;
  const state = downloadProgressStates.get(videoId);
  if (!state) return;
  if (state.timer) clearTimeout(state.timer);
  state.timer = null;
  state.dirty = false;
  if (state.write === null) downloadProgressStates.delete(videoId);
}

function startBgDownload(videoId, itag, url, headers) {
  const key = `${videoId}:${itag}`;
  if (bgDownloads.has(key)) return true;

  // Cap concurrent downloads
  if (activeDownloadCount() >= MAX_BG_DOWNLOADS) return false;

  const finalPath = downloadedFormatPath(videoId, String(itag));
  const temporaryPath = `${finalPath}.part-${process.pid}-${randomUUID()}`;
  const entry = {
    filePath: temporaryPath,
    bytesDownloaded: 0,
    totalSize: 0,
    done: false,
    startedAt: Date.now(),
    abort: null,
    accountedBytes: 0,
  };
  indexBgDownload(videoId, String(itag), entry);
  updateDownloadMetrics();

  const controller = new AbortController();
  entry.abort = () => controller.abort();

  // Auto-abort if download stalls for 2 minutes (no data received)
  let stallTimer: NodeJS.Timeout | null = null;
  const armStallTimer = () => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => controller.abort(), 120_000);
    stallTimer.unref?.();
  };
  armStallTimer();

  (async () => {
    try {
      const resp = await fetchWithConnTimeout(url, {
        headers: { ...headers },
        signal: controller.signal,
        outboundPriority: 'background',
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const cl = resp.headers.get('content-length');
      if (cl) {
        const declaredBytes = parseInt(cl, 10);
        if (Number.isFinite(declaredBytes) && declaredBytes > DOWNLOAD_MAX_FORMAT_BYTES) {
          await resp.body?.cancel().catch(() => {});
          throw new DownloadStorageError('format_too_large', 'A selected media format exceeds the configured size limit');
        }
        if (Number.isFinite(declaredBytes) && declaredBytes > 0) entry.totalSize = declaredBytes;
        if (aggregateProgress(videoId).totalBytes > DOWNLOAD_MAX_VIDEO_BYTES) {
          await resp.body?.cancel().catch(() => {});
          throw new DownloadStorageError('video_too_large', 'The selected video exceeds the configured download size limit');
        }
      }
      if (!resp.body) throw new Error('Upstream response had no body');
      let nextDiskCheck = 64 * 1024 * 1024;
      const progress = new Transform({
        transform(chunk, _encoding, callback) {
          armStallTimer();
          entry.bytesDownloaded += chunk.length;
          try {
            if (entry.bytesDownloaded > DOWNLOAD_MAX_FORMAT_BYTES) {
              throw new DownloadStorageError('format_too_large', 'Download stopped at the configured format size limit');
            }
            if (aggregateProgress(videoId).downloadedBytes > DOWNLOAD_MAX_VIDEO_BYTES) {
              throw new DownloadStorageError('video_too_large', 'Download stopped at the configured video size limit');
            }
            scheduleDownloadProgress(videoId);
          } catch (error) {
            callback(error as Error);
            return;
          }
          if (entry.bytesDownloaded >= nextDiskCheck) {
            nextDiskCheck += 64 * 1024 * 1024;
            void assertDownloadFreeSpace().then(
              () => callback(null, chunk),
              error => callback(error as Error),
            );
            return;
          }
          callback(null, chunk);
        },
      });
      // pipeline propagates writable backpressure to the upstream Web stream;
      // a slow disk can no longer grow an unbounded WriteStream buffer.
      await pipeline(
        Readable.fromWeb(resp.body, { highWaterMark: 256 * 1024 }),
        progress,
        fs.createWriteStream(temporaryPath, { highWaterMark: 256 * 1024 }),
        { signal: controller.signal },
      );
      entry.totalSize = Math.max(entry.totalSize, entry.bytesDownloaded);
      const previous = await fs.promises.stat(finalPath).catch(() => null);
      await fs.promises.rename(temporaryPath, finalPath);
      entry.filePath = finalPath;
      await db.adjustDownloadStorageBytes(entry.bytesDownloaded - (previous?.size || 0));
      entry.accountedBytes = entry.bytesDownloaded;
      await recordDownloadedFormats(videoId, [{ formatId: String(itag), size: entry.bytesDownloaded }]);
      entry.done = true;
      activeBgDownloads = Math.max(0, activeBgDownloads - 1);
      updateDownloadMetrics();
      await flushDownloadProgress(videoId, true);
      incrementMetric('background_downloads_total', { result: 'complete' });
      observeMetric('background_download_bytes', entry.bytesDownloaded);
      observeMetric('background_download_duration_seconds', (Date.now() - entry.startedAt) / 1000);
      console.log(`[bg-cache] ${key} complete (${(entry.bytesDownloaded / 1048576).toFixed(1)} MB)`);
      // Check if all formats for this video are done
      if (allFormatsDone(videoId)) {
        await db.completeDownload(videoId);
        downloadRequirements.delete(videoId);
        await releaseDownloadStorage(videoId);
        buildMPD(videoId).catch(() => {});
      } else if (!hasActiveDownload(videoId)) {
        await releaseDownloadStorage(videoId);
      }
    } catch (err) {
      if (entry.accountedBytes > 0) {
        await removeDownloadedFormatRecords(videoId, [String(itag)]).catch(() => {});
      }
      incrementMetric('background_downloads_total', { result: err.name === 'AbortError' ? 'aborted' : 'error' });
      if (err.name !== 'AbortError') {
        console.error(`[bg-cache] ${key} failed:`, err.message);
        await db.failDownload(videoId);
      }
      cleanupBgDownload(key);
    } finally {
      if (stallTimer) clearTimeout(stallTimer);
    }
  })().catch(err => {
    console.error(`[bg-cache] ${key} unhandled error:`, err.message);
    cleanupBgDownload(key);
  });
  return true;
}

function aggregateProgress(videoId) {
  let downloadedBytes = downloadExistingBytes.get(videoId) || 0;
  let totalBytes = downloadedBytes;
  for (const entry of getVideoDownloads(videoId).values()) {
    downloadedBytes += entry.bytesDownloaded;
    totalBytes += entry.totalSize;
  }
  return { downloadedBytes, totalBytes };
}

function allFormatsDone(videoId) {
  const required = downloadRequirements.get(videoId);
  if (required?.size) {
    for (const key of required) {
      const entry = bgDownloads.get(key);
      if (!entry?.done) return false;
    }
    return true;
  }
  for (const entry of getVideoDownloads(videoId).values()) if (!entry.done) return false;
  return true;
}

function cleanupBgDownload(key) {
  const entry = bgDownloads.get(key);
  if (!entry) return;
  if (entry.abort) try { entry.abort(); } catch {}
  // Only delete the file if the download was incomplete
  if (!entry.done) {
    const accountedBytes = entry.accountedBytes;
    entry.accountedBytes = 0;
    void fs.promises.unlink(entry.filePath).then(async () => {
      if (accountedBytes > 0) await db.adjustDownloadStorageBytes(-accountedBytes);
    }).catch(() => {});
  }
  const separator = key.lastIndexOf(':');
  const videoId = separator >= 0 ? key.slice(0, separator) : key;
  const formatId = separator >= 0 ? key.slice(separator + 1) : '';
  unindexBgDownload(videoId, formatId);
  updateDownloadMetrics();
  discardDownloadProgress(videoId);
  if (getVideoDownloads(videoId).size === 0) {
    downloadRequirements.delete(videoId);
    void releaseDownloadStorage(videoId).catch(error => {
      console.warn(`[bg-cache] storage reservation release failed for ${videoId}:`, error.message);
    });
  }
}

async function cleanupVideoDownloads(videoId: string) {
  await cancelQueuedDownload(videoId);
  for (const formatId of [...getVideoDownloads(videoId).keys()]) {
    cleanupBgDownload(`${videoId}:${formatId}`);
  }
  const deletedBytes = await deleteVideoDownloadFiles(videoId);
  if (deletedBytes > 0) await db.adjustDownloadStorageBytes(-deletedBytes);
}

// Periodic cleanup: evict stuck downloads + sweep ALL TTL-based caches
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of bgDownloads) {
    if (!entry.done && now - entry.startedAt > BG_MAX_AGE) {
      console.log(`[bg-cache] evicting stuck ${key}`);
      cleanupBgDownload(key);
    }
  }
  // Sweep all TTL-based caches — prevents unbounded growth from one-time videos
  for (const [key, entry] of formatCache) {
    if (now > entry.expires) formatCache.deleteLocal(key);
  }
  for (const [key, entry] of mpdCache) {
    if (now > entry.expires) mpdCache.deleteLocal(key);
  }
  for (const [key, entry] of urlLookup) {
    if (now > entry.expires) urlLookup.deleteLocal(key);
  }
  for (const [key, entry] of hlsCache) {
    if (now > entry.expires) hlsCache.deleteLocal(key);
  }
  for (const [key, entry] of vttCache) {
    if (now > entry.expires) vttCache.deleteLocal(key);
  }
  for (const [key, entry] of liveStoryboardCache) {
    if (now > entry.expires) liveStoryboardCache.deleteLocal(key);
  }
  for (const [key, entry] of storyboardUrlCache) {
    if (now - entry.createdAt > CACHE_TTL) storyboardUrlCache.delete(key);
  }
  // extractionStatus entries should clear themselves, but sweep stale ones (>5min) as safety net
  for (const [key, entry] of extractionStatus) {
    if (now - entry.ts > 5 * 60 * 1000) extractionStatus.delete(key);
  }
}, 5 * 60 * 1000);

function mountDownloadRoutes(router: import('express').Router) {
  // GET /api/stream/:videoId/offline-bundle — returns everything the SW needs for offline playback
  router.get('/:videoId/offline-bundle', async (req, res) => {
    const { videoId } = req.params;
    const dl = await db.getDownload(videoId);
    if (!dl || dl.status !== 'complete') return res.status(404).json({ error: 'Not downloaded' });

    const downloadedFormats = await listDownloadedFormats(videoId);
    const formats: string[] = [];
    const formatSizes: Record<string, number> = {};
    for (const entry of downloadedFormats) {
      formats.push(entry.formatId);
      formatSizes[entry.formatId] = entry.size;
    }
    if (!formats.length) return res.status(409).json({ error: 'Downloaded files are not available yet' });

    // The worker that completed the download cannot invalidate every web
    // worker's L1. Force this request to rebuild from the shared files.
    mpdCache.deleteLocal(videoId);
    const streamToken = createStreamToken(videoId);
    let mpd = '';
    try {
      const result = await buildMPD(videoId, { preferLocal: true });
      if (typeof result === 'string') mpd = result;
    } catch { /* ignore */ }

    res.json({
      videoId,
      streamToken,
      mpd,
      title: dl.title,
      channelTitle: dl.channel_title,
      formats,
      formatSizes
    });
  });


  // POST /api/stream/:videoId/cache — trigger background download of all formats
  router.post('/:videoId/cache', express.json(), async (req, res) => {
    let pendingStorageRelease: (() => Promise<void>) | null = null;
    try {
      const { videoId } = req.params;
      const info = getCached(videoId, { staleOk: true });
      if (!info) return res.status(404).end();
      // Pick formats with direct HTTP URLs (not HLS manifests) for background download
      const formats = info.formats || [];
      const isDirect = f => f.url && (!f.protocol || f.protocol === 'https' || f.protocol === 'http');
      const videoFmts = formats
        .filter(f => f.vcodec && f.vcodec !== 'none' && isDirect(f))
        .sort((a, b) => (b.height || 0) - (a.height || 0));
      const audioFmt = formats
        .filter(f => f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none') && isDirect(f))
        .sort((a, b) => (b.abr || 0) - (a.abr || 0))[0] || null;
      const all = audioFmt ? [videoFmts[0], audioFmt].filter(Boolean) : videoFmts.slice(0, 1);
      const meta = req.body && req.body.title ? { title: req.body.title, channelTitle: req.body.channelTitle, thumbnail: req.body.thumbnail } : null;
      const requiredFormats = all.filter(fmt => fmt?.url);
      if (!requiredFormats.length) return res.status(404).json({ error: 'No downloadable formats found' });
      const persistedEntries = await listDownloadedFormats(videoId);
      const persistedFormats = new Set(persistedEntries.map(entry => entry.formatId));
      const existingBytes = persistedEntries
        .filter(entry => requiredFormats.some(fmt => String(fmt.format_id) === entry.formatId)
          && !bgDownloads.has(`${videoId}:${entry.formatId}`))
        .reduce((sum, entry) => sum + entry.size, 0);
      const pendingFormats = requiredFormats.filter(fmt => !persistedFormats.has(String(fmt.format_id))
        && !bgDownloads.has(`${videoId}:${fmt.format_id}`));
      if (!pendingFormats.length) return res.status(204).end();
      const queuedFormats = pendingFormats.map(fmt => ({
        formatId: String(fmt.format_id),
        url: fmt.url,
        headers: sanitizeHeaders(fmt.http_headers),
        expectedBytes: Math.max(0, Number(fmt.filesize) || Number(fmt.filesize_approx) || 0),
      }));
      const expectedBytes = estimateDownloadBytes(queuedFormats);
      if (existingBytes + expectedBytes > DOWNLOAD_MAX_VIDEO_BYTES) {
        throw new DownloadStorageError('video_too_large', 'The selected video exceeds the configured download size limit');
      }
      await checkDownloadStorageCapacity(expectedBytes);
      const queueAvailable = hasDownloadQueue();
      if (!queueAvailable) {
        if (Math.max(1, Number(process.env.CLUSTER_WORKER_COUNT) || 1) > 1) {
          return res.status(503).json({ error: 'A download worker is required in clustered mode' });
        }
        const availableSlots = Math.max(0, MAX_BG_DOWNLOADS - activeDownloadCount());
        if (pendingFormats.length > availableSlots) {
          res.set('Retry-After', '2');
          return res.status(429).json({ error: 'Download capacity is currently full' });
        }
        pendingStorageRelease = await reserveLocalDownloadStorage(
          `local:${videoId}:${randomUUID()}`,
          expectedBytes,
        );
      }
      // Create/reset the row once before any format can emit progress. This
      // prevents the audio and video pipelines from racing the initial upsert.
      await db.upsertDownload(
        videoId,
        meta?.title || videoId,
        meta?.channelTitle || '',
        meta?.thumbnail || '',
      );
      if (queueAvailable) {
        const queued = await enqueueDownload({
          videoId,
          existingBytes,
          // Keep the quota key opaque and fixed-size; Express has already
          // applied the configured trust-proxy policy to req.ip.
          ownerId: createHash('sha256').update(String(req.ip || 'unknown')).digest('hex').slice(0, 24),
          formats: queuedFormats,
        });
        if (!queued) {
          await db.failDownload(videoId);
          res.set('Retry-After', '2');
          return res.status(503).json({ error: 'Download queue capacity is full or unavailable' });
        }
      } else {
        // Single-process development fallback.
        await releaseDownloadStorage(videoId);
        downloadExistingBytes.set(videoId, existingBytes);
        downloadStorageReleases.set(videoId, pendingStorageRelease!);
        pendingStorageRelease = null;
        downloadRequirements.set(videoId, new Set(
          pendingFormats.map(fmt => `${videoId}:${fmt.format_id}`),
        ));
        const startedFormats: string[] = [];
        for (const fmt of pendingFormats) {
          const formatId = String(fmt.format_id);
          if (startBgDownload(videoId, formatId, fmt.url, sanitizeHeaders(fmt.http_headers))) {
            startedFormats.push(formatId);
            continue;
          }
          for (const startedFormat of startedFormats) cleanupBgDownload(`${videoId}:${startedFormat}`);
          await db.failDownload(videoId);
          res.set('Retry-After', '2');
          return res.status(429).json({ error: 'Download capacity is currently full' });
        }
      }
      res.status(202).end();
    } catch (err) {
      if (pendingStorageRelease) await pendingStorageRelease().catch(() => {});
      console.error('[cache trigger] error:', err.message);
      if (!res.headersSent && err instanceof DownloadStorageError) {
        incrementMetric('download_storage_rejections_total', { reason: err.code });
        return res.status(507).json({ error: err.message });
      }
      if (!res.headersSent) res.status(500).end();
    }
  });

  // GET /api/stream/:videoId/cache/status — download status
  router.get('/:videoId/cache/status', async (req, res) => {
    const { videoId } = req.params;
    // Aggregate from in-memory map
    const videoDownloads = getVideoDownloads(videoId);
    const hasEntries = videoDownloads.size > 0;
    const { downloadedBytes, totalBytes } = aggregateProgress(videoId);
    // Also check DB for persisted status
    const dbRow = await db.getDownload(videoId);
    if (dbRow && dbRow.status === 'complete') {
      return res.json({ status: 'complete', downloadedBytes: dbRow.downloaded_bytes, totalBytes: dbRow.total_bytes, percent: 100 });
    }
    if (dbRow && dbRow.status === 'error') {
      return res.json({ status: 'error', downloadedBytes: 0, totalBytes: 0, percent: 0 });
    }
    if (dbRow && dbRow.status === 'downloading') {
      const downloadedBytes = Number(dbRow.downloaded_bytes) || 0;
      const totalBytes = Number(dbRow.total_bytes) || 0;
      const percent = totalBytes > 0 ? Math.round(downloadedBytes / totalBytes * 100) : 0;
      return res.json({ status: 'downloading', downloadedBytes, totalBytes, percent });
    }
    if (hasEntries) {
      const allDone = allFormatsDone(videoId);
      const percent = totalBytes > 0 ? Math.round(downloadedBytes / totalBytes * 100) : 0;
      return res.json({ status: allDone ? 'complete' : 'downloading', downloadedBytes, totalBytes, percent });
    }
    res.json({ status: 'none', downloadedBytes: 0, totalBytes: 0, percent: 0 });
  });
}

export {
  bgDownloads,
  cleanupBgDownload,
  cleanupVideoDownloads,
  getVideoDownloads,
  mountDownloadRoutes,
};
