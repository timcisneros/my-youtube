import fs from 'fs';
import path from 'path';
import express from 'express';
import db from '../../db.js';
import {
  DOWNLOADS_DIR,
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

// Background download manager: "videoId:itag" -> { filePath, bytesDownloaded, totalSize, done, startedAt, abort }
const bgDownloads = new Map();

function startBgDownload(videoId, itag, url, headers, meta) {
  const key = `${videoId}:${itag}`;
  if (bgDownloads.has(key)) return;

  // Cap concurrent downloads
  let active = 0;
  for (const v of bgDownloads.values()) { if (!v.done) active++; }
  if (active >= MAX_BG_DOWNLOADS) return;

  const filePath = path.join(DOWNLOADS_DIR, `mycache-${videoId}-${itag}.dat`);
  const entry = { filePath, bytesDownloaded: 0, totalSize: 0, done: false, startedAt: Date.now(), abort: null };
  bgDownloads.set(key, entry);

  // Persist to DB if metadata provided (first format triggers the upsert)
  if (meta) {
    db.upsertDownload(videoId, meta.title, meta.channelTitle, meta.thumbnail);
  }

  const controller = new AbortController();
  entry.abort = () => controller.abort();

  let lastDbUpdate = 0;

  // Auto-abort if download stalls for 2 minutes (no data received)
  let stallTimer = setTimeout(() => controller.abort(), 120_000);

  (async () => {
    try {
      const resp = await fetchWithConnTimeout(url, { headers: { ...headers }, signal: controller.signal });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const cl = resp.headers.get('content-length');
      if (cl) entry.totalSize = parseInt(cl, 10);
      const ws = fs.createWriteStream(filePath);
      for await (const chunk of resp.body) {
        clearTimeout(stallTimer);
        stallTimer = setTimeout(() => controller.abort(), 120_000);
        ws.write(chunk);
        entry.bytesDownloaded += chunk.length;
        // Update DB progress every ~1MB
        if (entry.bytesDownloaded - lastDbUpdate > 1048576) {
          lastDbUpdate = entry.bytesDownloaded;
          // Aggregate all format downloads for this video
          const agg = aggregateProgress(videoId);
          db.updateDownloadProgress(videoId, agg.downloadedBytes, agg.totalBytes);
        }
      }
      ws.end();
      clearTimeout(stallTimer);
      await new Promise((resolve, reject) => { ws.on('finish', resolve); ws.on('error', reject); });
      entry.done = true;
      console.log(`[bg-cache] ${key} complete (${(entry.bytesDownloaded / 1048576).toFixed(1)} MB)`);
      // Check if all formats for this video are done
      if (allFormatsDone(videoId)) {
        db.completeDownload(videoId);
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.error(`[bg-cache] ${key} failed:`, err.message);
        db.failDownload(videoId);
      }
      cleanupBgDownload(key);
    }
  })().catch(err => {
    console.error(`[bg-cache] ${key} unhandled error:`, err.message);
    cleanupBgDownload(key);
  });
}

function aggregateProgress(videoId) {
  let downloadedBytes = 0, totalBytes = 0;
  for (const [key, entry] of bgDownloads) {
    if (key.startsWith(videoId + ':')) {
      downloadedBytes += entry.bytesDownloaded;
      totalBytes += entry.totalSize;
    }
  }
  return { downloadedBytes, totalBytes };
}

function allFormatsDone(videoId) {
  for (const [key, entry] of bgDownloads) {
    if (key.startsWith(videoId + ':') && !entry.done) return false;
  }
  return true;
}

function cleanupBgDownload(key) {
  const entry = bgDownloads.get(key);
  if (!entry) return;
  if (entry.abort) try { entry.abort(); } catch {}
  // Only delete the file if the download was incomplete
  if (!entry.done) {
    try { fs.unlinkSync(entry.filePath); } catch {}
  }
  bgDownloads.delete(key);
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
    if (now > entry.expires) formatCache.delete(key);
  }
  for (const [key, entry] of mpdCache) {
    if (now > entry.expires) mpdCache.delete(key);
  }
  for (const [key, entry] of urlLookup) {
    if (now > entry.expires) urlLookup.delete(key);
  }
  for (const [key, entry] of hlsCache) {
    if (now > entry.expires) hlsCache.delete(key);
  }
  for (const [key, entry] of vttCache) {
    if (now > entry.expires) vttCache.delete(key);
  }
  for (const [key, entry] of liveStoryboardCache) {
    if (now - entry.createdAt > 30 * 60 * 1000) liveStoryboardCache.delete(key);
  }
  for (const [key, entry] of storyboardUrlCache) {
    if (now - entry.createdAt > CACHE_TTL) storyboardUrlCache.delete(key);
  }
  // extractionStatus entries should clear themselves, but sweep stale ones (>5min) as safety net
  for (const [key, entry] of extractionStatus) {
    if (now - entry.ts > 5 * 60 * 1000) extractionStatus.delete(key);
  }
}, 5 * 60 * 1000);

// On startup: rebuild bgDownloads map from DB for completed downloads
(function rebuildFromDb() {
  const downloads = db.getAllDownloads();
  for (const dl of downloads) {
    if (dl.status !== 'complete') continue;
    // Find all cached files for this video
    try {
      const files = fs.readdirSync(DOWNLOADS_DIR).filter(f => f.startsWith('mycache-' + dl.video_id + '-'));
      for (const f of files) {
        const m = f.match(/^mycache-(.+)-(.+)\.dat$/);
        if (!m) continue;
        const key = `${m[1]}:${m[2]}`;
        const filePath = path.join(DOWNLOADS_DIR, f);
        const stat = fs.statSync(filePath);
        bgDownloads.set(key, {
          filePath,
          bytesDownloaded: stat.size,
          totalSize: stat.size,
          done: true,
          startedAt: Date.now(),
          abort: null
        });
      }
    } catch {}
  }
  if (bgDownloads.size > 0) {
    console.log(`[bg-cache] rebuilt ${bgDownloads.size} entries from DB`);
  }
})();

function mountDownloadRoutes(router) {
  // POST /api/stream/:videoId/cache — trigger background download of all formats
  router.post('/:videoId/cache', express.json(), async (req, res) => {
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
      let first = true;
      for (const fmt of all) {
        const key = `${videoId}:${fmt.format_id}`;
        if (!bgDownloads.has(key) && fmt.url) {
          startBgDownload(videoId, fmt.format_id, fmt.url, sanitizeHeaders(fmt.http_headers), first ? meta : null);
          first = false;
        }
      }
      res.status(204).end();
    } catch (err) {
      console.error('[cache trigger] error:', err.message);
      if (!res.headersSent) res.status(500).end();
    }
  });

  // GET /api/stream/:videoId/cache/status — download status
  router.get('/:videoId/cache/status', (req, res) => {
    const { videoId } = req.params;
    // Aggregate from in-memory map
    let downloadedBytes = 0, totalBytes = 0, hasEntries = false;
    for (const [key, entry] of bgDownloads) {
      if (key.startsWith(videoId + ':')) {
        hasEntries = true;
        downloadedBytes += entry.bytesDownloaded;
        totalBytes += entry.totalSize;
      }
    }
    // Also check DB for persisted status
    const dbRow = db.getDownload(videoId);
    if (dbRow && dbRow.status === 'complete') {
      return res.json({ status: 'complete', downloadedBytes: dbRow.downloaded_bytes, totalBytes: dbRow.total_bytes, percent: 100 });
    }
    if (dbRow && dbRow.status === 'error') {
      return res.json({ status: 'error', downloadedBytes: 0, totalBytes: 0, percent: 0 });
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
  mountDownloadRoutes,
};
