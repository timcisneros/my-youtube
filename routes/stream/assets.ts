import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import express from 'express';
import { getCachedDuration } from '../../youtube/index.js';
import { withYtSlot } from '../../youtube/shared.js';
import { resolveVideoMetadata } from '../../lib/duration-metadata.js';
import { acquireStatusConnection } from '../../lib/status-connection-limiter.js';
import { isYouTubeCdnUrl, fetchLiveStoryboardSpec } from '../../extractors.js';
import db from '../../db.js';
import {
  PROXY_HEADERS,
  isClientGone,
  fetchWithConnTimeout,
  storyboardUrlCache,
  liveStoryboardCache,
  streamRequestSignal,
  withYtdlpSlot,
  dedup,
} from './shared.js';
import { getCached, extractFormats } from './extraction.js';

const liveStoryboardInflight = new Map<string, Promise<Record<string, unknown> | null>>();
const LIVE_STORYBOARD_TTL_MS = 30 * 60 * 1000;
const LIVE_STORYBOARD_NEGATIVE_TTL_MS = 5 * 60 * 1000;
const DURATION_STATUS_MAX_AGE_MS = Math.max(5_000, Number(process.env.DURATION_STATUS_MAX_AGE_MS) || 30_000);

// Cached wrapper around extractors.fetchLiveStoryboardSpec
async function getLiveStoryboardSpec(videoId) {
  const cached = await liveStoryboardCache.getAsync(videoId);
  if (cached && Date.now() < cached.expires) return cached.miss ? null : cached;
  return dedup(liveStoryboardInflight, videoId, async () => {
    try {
      const raw = await fetchLiveStoryboardSpec(videoId, {
        withRequestSlot: task => withYtSlot(task, 'background'),
        withProcessSlot: task => withYtdlpSlot(task, { priority: 'background' }),
      });
      const now = Date.now();
      if (!raw) {
        await liveStoryboardCache.setAsync(videoId, {
          miss: true,
          createdAt: now,
          expires: now + LIVE_STORYBOARD_NEGATIVE_TTL_MS,
        });
        return null;
      }
      const spec = { ...raw, createdAt: now, expires: now + LIVE_STORYBOARD_TTL_MS };
      await liveStoryboardCache.setAsync(videoId, spec);
      return spec;
    } catch {
      const now = Date.now();
      await liveStoryboardCache.setAsync(videoId, {
        miss: true,
        createdAt: now,
        expires: now + Math.min(60_000, LIVE_STORYBOARD_NEGATIVE_TTL_MS),
      }).catch(() => {});
      return null;
    }
  }, { name: 'stream_storyboards', maxEntries: 64 });
}

// Parse chapter timestamps from video description text
function parseDescriptionChapters(description, duration) {
  const lines = description.split('\n');
  const entries = [];
  // Match patterns like "0:00 Intro", "1:23:45 - Finale", "(0:00) Intro"
  const re = /(?:^|\()\s*(\d{1,2}:(?:\d{2}:)?\d{2})\s*\)?\s*[-\u2013\u2014]?\s*(.+)/;

  for (const line of lines) {
    const m = line.match(re);
    if (!m) continue;
    const parts = m[1].split(':').map(Number);
    let seconds;
    if (parts.length === 3) seconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
    else seconds = parts[0] * 60 + parts[1];
    const title = m[2].trim();
    if (title) entries.push({ start_time: seconds, title });
  }

  if (entries.length < 2) return [];

  // Sort by start_time and compute end_time
  entries.sort((a, b) => a.start_time - b.start_time);
  for (let i = 0; i < entries.length; i++) {
    entries[i].end_time = i + 1 < entries.length
      ? entries[i + 1].start_time
      : (duration || entries[i].start_time);
  }

  return entries;
}

function mountAssetRoutes(router) {
  // GET /api/stream/:videoId/poster
  // Uses predictable YouTube thumbnail URL — no yt-dlp needed
  router.get('/:videoId/poster', async (req, res) => {
    try {
      const { videoId } = req.params;
      // hq720.jpg is 1280x720, always available, fills widescreen — single fetch
      const upstream = await fetchWithConnTimeout(`https://i.ytimg.com/vi/${videoId}/hq720.jpg`, {
        headers: PROXY_HEADERS,
        bodyIdleMs: 8000,
        outboundPriority: 'background',
        signal: streamRequestSignal(req, res),
      }, 8000);
      if (!upstream.ok) {
        await upstream.body?.cancel().catch(() => {});
        if (!res.headersSent) res.status(upstream.status).end();
        return;
      }

      res.status(upstream.status);
      const ct = upstream.headers.get('content-type');
      if (ct) res.set('Content-Type', ct);
      res.set('Cache-Control', 'public, max-age=86400');

      const nodeStream = Readable.fromWeb(upstream.body);
      await pipeline(nodeStream, res);
    } catch (err) {
      if (isClientGone(err)) return;
      console.error('Poster proxy error:', err.message);
      if (!res.headersSent) {
        res.status(502).json({ error: 'Poster failed' });
      }
    }
  });

  router.get('/:videoId/duration', async (req, res) => {
    const { videoId } = req.params;
    // Check memory caches first
    const info = getCached(videoId, { staleOk: true });
    if (info && info.duration) {
      res.set('Cache-Control', 'public, max-age=86400');
      return res.json({ duration: info.duration });
    }
    const dur = getCachedDuration(videoId);
    if (dur) {
      res.set('Cache-Control', 'public, max-age=86400');
      return res.json({ duration: dur });
    }
    // Check DB
    const dbDur = await db.getDuration(videoId);
    if (dbDur) {
      res.set('Cache-Control', 'public, max-age=86400');
      return res.json({ duration: dbDur });
    }
    // Use the same bounded, abortable, cross-worker-deduplicated resolver as
    // the duration SSE endpoint. This compatibility route must not bypass the
    // shared YouTube and yt-dlp limits.
    try {
      const metadata = await resolveVideoMetadata([videoId], 1, {
        signal: streamRequestSignal(req, res),
      });
      const d = metadata.get(videoId)?.duration || null;
      res.set('Cache-Control', 'public, max-age=86400');
      res.json({ duration: d });
    } catch (err) {
      if (isClientGone(err)) return;
      if (!res.headersSent) res.json({ duration: null });
    }
  });

  // GET /api/stream/:videoId/thumb — lightweight thumbnail proxy for grid views (320x180)
  router.get('/:videoId/thumb', async (req, res) => {
    try {
      const { videoId } = req.params;
      const upstream = await fetchWithConnTimeout(`https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`, {
        headers: PROXY_HEADERS,
        bodyIdleMs: 8000,
        outboundPriority: 'background',
        signal: streamRequestSignal(req, res),
      }, 8000);
      if (!upstream.ok) {
        await upstream.body?.cancel().catch(() => {});
        if (!res.headersSent) res.status(upstream.status).end();
        return;
      }
      const ct = upstream.headers.get('content-type');
      if (ct) res.set('Content-Type', ct);
      res.set('Cache-Control', 'public, max-age=86400');
      const nodeStream = Readable.fromWeb(upstream.body);
      await pipeline(nodeStream, res);
    } catch (err) {
      if (isClientGone(err)) return;
      if (!res.headersSent) res.status(502).end();
    }
  });

  // GET /api/stream/:videoId/storyboard
  // Returns YouTube storyboard metadata (sprite sheet URLs + layout info)
  router.get('/:videoId/storyboard', async (req, res) => {
    try {
      const { videoId } = req.params;
      const info = getCached(videoId, { staleOk: true }) || await extractFormats(videoId);

      // yt-dlp puts storyboard data in formats with protocol "mhtml" or in storyboards field
      const sbFormats = (info.formats || []).filter(f =>
        f.protocol === 'mhtml' && f.fragments && f.fragments.length > 0
      );

      if (sbFormats.length > 0) {
        // VOD storyboard
        const sb = sbFormats.reduce((a, b) => ((a.height || 0) > (b.height || 0) ? a : b));
        const cols = sb.columns || 10;
        const rows = sb.rows || 10;
        const thumbW = sb.width || 160;
        const thumbH = sb.height || 90;
        const framesPerSheet = cols * rows;
        const sheets = sb.fragments.map(f => f.url || f.path);
        const fragDuration = sb.fragments[0] && sb.fragments[0].duration;
        let interval, totalFrames;
        if (fragDuration) {
          interval = fragDuration / framesPerSheet;
          totalFrames = Math.ceil((info.duration || 0) / interval);
        } else {
          totalFrames = sheets.length * framesPerSheet;
          interval = info.duration ? info.duration / totalFrames : 2;
        }
        return res.json({
          sheets: sheets.map((_url, i) => `/api/stream/${videoId}/storyboard/${i}`),
          cols, rows, thumbW, thumbH, interval, totalFrames
        });
      }

      // The expensive live fallback is only valid for an active livestream.
      // A VOD without storyboard frames should remain a cheap 404.
      const isCurrentLive = info.live_status === 'is_live' || info.is_live === true;
      const liveSpec = isCurrentLive ? await getLiveStoryboardSpec(videoId) : null;
      if (liveSpec) {
        return res.json({
          live: true,
          urlTemplate: `/api/stream/${videoId}/storyboard/live/`,
          cols: liveSpec.cols,
          rows: liveSpec.rows,
          thumbW: liveSpec.thumbW,
          thumbH: liveSpec.thumbH,
          interval: 2,
        });
      }

      res.status(404).json({ error: 'No storyboard available' });
    } catch (err) {
      console.error('Storyboard metadata error:', err.message);
      res.status(404).json({ error: 'No storyboard available' });
    }
  });

  // GET /api/stream/:videoId/chapters
  // Returns chapter markers from yt-dlp metadata or parsed from description
  router.get('/:videoId/chapters', async (req, res) => {
    try {
      const { videoId } = req.params;
      const info = getCached(videoId, { staleOk: true }) || await extractFormats(videoId);

      // Priority 1: yt-dlp structured chapters
      if (info.chapters && info.chapters.length > 0) {
        return res.json(info.chapters);
      }

      // Priority 2: parse timestamps from description
      if (info.description) {
        const chapters = parseDescriptionChapters(info.description, info.duration);
        if (chapters.length > 0) return res.json(chapters);
      }

      res.json([]);
    } catch (err) {
      console.error('Chapters error:', err.message);
      res.json([]);
    }
  });

  // GET /api/stream/:videoId/storyboard/live/:seq — proxy a live storyboard sheet
  router.get('/:videoId/storyboard/live/:seq', async (req, res) => {
    try {
      const { videoId, seq } = req.params;
      const seqNum = parseInt(seq, 10);
      if (isNaN(seqNum) || seqNum < 0) return res.status(400).end();
      const spec = await getLiveStoryboardSpec(videoId);
      if (!spec) return res.status(404).json({ error: 'No live storyboard' });
      const url = spec.urlTemplate.replace('M$M', 'M' + seqNum);
      // Validate domain
      if (!isYouTubeCdnUrl(url)) return res.status(403).end();
      const upstream = await fetchWithConnTimeout(url, {
        headers: PROXY_HEADERS,
        bodyIdleMs: 8000,
        outboundPriority: 'background',
        signal: streamRequestSignal(req, res),
      }, 8000);
      if (!upstream.ok) return res.status(upstream.status).end();
      const ct = upstream.headers.get('content-type');
      if (ct) res.set('Content-Type', ct);
      res.set('Cache-Control', 'public, max-age=300');
      const nodeStream = Readable.fromWeb(upstream.body);
      await pipeline(nodeStream, res);
    } catch (err) {
      if (isClientGone(err)) return;
      if (!res.headersSent) res.status(502).end();
    }
  });

  // GET /api/stream/:videoId/storyboard/:index — proxy a sprite sheet image
  router.get('/:videoId/storyboard/:index', async (req, res) => {
    try {
      const { videoId, index } = req.params;
      const idx = parseInt(index, 10);

      // Get or cache the YouTube URLs
      let urls = storyboardUrlCache.get(videoId)?.data;
      if (!urls) {
        const info = await extractFormats(videoId);
        const sbFormats = (info.formats || []).filter(f =>
          f.protocol === 'mhtml' && f.fragments && f.fragments.length > 0
        );
        if (sbFormats.length === 0) return res.status(404).json({ error: 'No storyboard' });
        const sb = sbFormats.reduce((a, b) => ((a.height || 0) > (b.height || 0) ? a : b));
        urls = sb.fragments.map(f => f.url || f.path);
        storyboardUrlCache.set(videoId, { data: urls, createdAt: Date.now() });
      }

      if (idx < 0 || idx >= urls.length) return res.status(404).json({ error: 'Sheet not found' });

      const upstream = await fetchWithConnTimeout(urls[idx], {
        headers: PROXY_HEADERS,
        bodyIdleMs: 8000,
        outboundPriority: 'background',
        signal: streamRequestSignal(req, res),
      }, 8000);
      if (!upstream.ok) {
        await upstream.body?.cancel().catch(() => {});
        return res.status(upstream.status).end();
      }

      const ct = upstream.headers.get('content-type');
      if (ct) res.set('Content-Type', ct);
      res.set('Cache-Control', 'public, max-age=86400');

      const nodeStream = Readable.fromWeb(upstream.body);
      await pipeline(nodeStream, res);
    } catch (err) {
      if (isClientGone(err)) return;
      console.error('Storyboard proxy error:', err.message);
      if (!res.headersSent) res.status(502).json({ error: 'Storyboard proxy failed' });
    }
  });
}

// Batch endpoints without :videoId — must be mounted before the /:videoId param
// validator in index.ts, otherwise Express matches "durations-live" as a videoId.
function mountBatchRoutes(router) {
  // POST /api/stream/durations — batch duration lookup (cache + DB only, no yt-dlp)
  router.post('/durations', express.json(), async (req, res) => {
    const { ids } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) return res.json({});
    const validIds = ids.filter(id => /^[A-Za-z0-9_-]{11}$/.test(id)).slice(0, 50);

    // Check memory caches first
    const result = {};
    const remaining = [];
    for (const videoId of validIds) {
      const info = getCached(videoId, { staleOk: true });
      if (info && info.duration) { result[videoId] = info.duration; continue; }
      const dur = getCachedDuration(videoId);
      if (dur) { result[videoId] = dur; continue; }
      remaining.push(videoId);
    }

    // Check DB for anything not in memory
    if (remaining.length > 0) {
      const dbDurations = await db.getDurations(remaining);
      Object.assign(result, dbDurations);
    }

    res.set('Cache-Control', 'public, max-age=300');
    res.json(result);
  });

  // SSE endpoint — streams durations as yt-dlp resolves them, one by one
  router.get('/durations-live', async (req, res) => {
    const raw = (req.query.ids || '').toString();
    const ids = raw.split(',').filter(id => /^[A-Za-z0-9_-]{11}$/.test(id)).slice(0, 20);
    if (!ids.length) return res.status(400).end();

    // Do the bounded database lookup before reserving a long-lived connection.
    // Fully cached batches can complete immediately without consuming SSE
    // capacity while upstream metadata work is protected by the shared lease.
    const stored = await db.getDurationsAndLiveStatuses(ids);
    const dbDurations = stored.durations;
    const dbStatuses = stored.liveStatuses;
    const missing = ids.filter(id => dbDurations[id] === undefined);
    const releaseConnection = missing.length > 0
      ? acquireStatusConnection(req.ip, 'duration_sse')
      : () => {};
    if (!releaseConnection) {
      res.set('Retry-After', '5');
      return res.status(429).end();
    }

    let closed = false;
    const controller = new AbortController();
    let maxAgeTimer: NodeJS.Timeout | null = null;
    let cleanedUp = false;
    const cleanupConnection = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      closed = true;
      if (maxAgeTimer) clearTimeout(maxAgeTimer);
      if (!controller.signal.aborted) controller.abort(new Error('duration metadata client disconnected'));
      releaseConnection();
    };
    req.once('aborted', cleanupConnection);
    res.once('close', cleanupConnection);
    res.once('finish', cleanupConnection);

    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'  // disable nginx buffering
    });
    res.flushHeaders();

    const writeEvent = (body: string) => {
      if (res.writableEnded || res.destroyed) return false;
      const accepted = res.write(body);
      if (typeof res.flush === 'function') res.flush();
      if (!accepted) res.end();
      return accepted;
    };

    // Immediately send durations already in DB.
    for (const id of ids) {
      if (dbDurations[id] !== undefined) {
        const msg: { id: string; duration: number; live_status?: string } = { id, duration: dbDurations[id] };
        if (dbStatuses[id] && dbStatuses[id] !== 'not_live') msg.live_status = dbStatuses[id];
        if (!writeEvent(`data: ${JSON.stringify(msg)}\n\n`)) return;
      }
    }

    if (!missing.length) {
      writeEvent('event: done\ndata: {}\n\n');
      return res.end();
    }

    maxAgeTimer = setTimeout(() => {
      if (!controller.signal.aborted) controller.abort(new Error('duration metadata deadline exceeded'));
      if (!res.writableEnded) {
        res.write('event: done\ndata: {}\n\n');
        res.end();
      }
    }, DURATION_STATUS_MAX_AGE_MS);
    maxAgeTimer.unref?.();

    void (async () => {
      try {
        // YouTube and yt-dlp admission queues already prioritize playback over
        // this background metadata work, so no polling loop is needed here.
        const results = await resolveVideoMetadata(missing, 3, {
          signal: controller.signal,
          mode: 'lightweight',
          // The route already performed one batch lookup for every id. Avoid
          // turning the missing subset back into one query per badge.
          skipStoredLookup: true,
        });
        for (const id of missing) {
          if (closed) return;
          const meta = results.get(id);
          if (meta) {
            const msg: { id: string; duration: number; live_status?: string } = { id, duration: meta.duration };
            if (meta.liveStatus !== 'not_live') msg.live_status = meta.liveStatus;
            if (!writeEvent(`data: ${JSON.stringify(msg)}\n\n`)) return;
          }
        }
      } catch (err) {
        if (controller.signal.aborted) return;
        console.error('[durations-live] error:', err.message);
      }
      if (!closed) {
        writeEvent('event: done\ndata: {}\n\n');
        res.end();
      }
    })();
  });
}

export { mountAssetRoutes, mountBatchRoutes };
