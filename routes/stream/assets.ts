import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { promisify } from 'util';
import { execFile } from 'child_process';
import express from 'express';
import { ytdlpArgs } from '../../ytdlp.js';
import { getCachedDuration } from '../../youtube/index.js';
import { fetchVideoMetaBatch } from '../../yt-meta.js';
import { isYouTubeCdnUrl, fetchLiveStoryboardSpec } from '../../extractors.js';
import db from '../../db.js';
import {
  PROXY_HEADERS,
  isClientGone,
  extractionInflight,
  storyboardUrlCache,
  liveStoryboardCache,
} from './shared.js';
import { getCached, extractFormats } from './extraction.js';

const execFileAsync = promisify(execFile);

// Cached wrapper around extractors.fetchLiveStoryboardSpec
async function getLiveStoryboardSpec(videoId) {
  const cached = liveStoryboardCache.get(videoId);
  if (cached && Date.now() - cached.createdAt < 30 * 60 * 1000) return cached;
  try {
    const raw = await fetchLiveStoryboardSpec(videoId);
    if (!raw) return null;
    const spec = { ...raw, createdAt: Date.now() };
    liveStoryboardCache.set(videoId, spec);
    return spec;
  } catch {
    return null;
  }
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
      const upstream = await fetch(`https://i.ytimg.com/vi/${videoId}/hq720.jpg`, { headers: PROXY_HEADERS });
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
    const dbDur = db.getDuration(videoId);
    if (dbDur) {
      res.set('Cache-Control', 'public, max-age=86400');
      return res.json({ duration: dbDur });
    }
    // Fetch via yt-dlp (single video only, not batch)
    try {
      const { stdout } = await execFileAsync('yt-dlp', [
        ...ytdlpArgs(), '--print', 'duration', '--no-warnings', '--', videoId
      ], { timeout: 15000 });
      const d = parseFloat(stdout.trim());
      if (!isNaN(d)) db.setDuration(videoId, d);
      res.set('Cache-Control', 'public, max-age=86400');
      res.json({ duration: isNaN(d) ? null : d });
    } catch {
      res.json({ duration: null });
    }
  });

  // GET /api/stream/:videoId/thumb — lightweight thumbnail proxy for grid views (320x180)
  router.get('/:videoId/thumb', async (req, res) => {
    try {
      const { videoId } = req.params;
      const upstream = await fetch(`https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`, { headers: PROXY_HEADERS });
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

      // Live storyboard — fetch spec from Innertube
      const liveSpec = await getLiveStoryboardSpec(videoId);
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
      const upstream = await fetch(url, { headers: PROXY_HEADERS });
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

      const upstream = await fetch(urls[idx], { headers: PROXY_HEADERS });
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
  router.post('/durations', express.json(), (req, res) => {
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
      const dbDurations = db.getDurations(remaining);
      Object.assign(result, dbDurations);
    }

    res.set('Cache-Control', 'public, max-age=300');
    res.json(result);
  });

  // SSE endpoint — streams durations as yt-dlp resolves them, one by one
  router.get('/durations-live', (req, res) => {
    const raw = (req.query.ids || '').toString();
    const ids = raw.split(',').filter(id => /^[A-Za-z0-9_-]{11}$/.test(id)).slice(0, 50);
    if (!ids.length) return res.status(400).end();

    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'  // disable nginx buffering
    });
    res.flushHeaders();

    // Immediately send durations already in DB
    const dbDurations = db.getDurations(ids);
    const dbStatuses = db.getLiveStatuses(ids);
    const missing = [];
    for (const id of ids) {
      if (dbDurations[id]) {
        const msg: { id: string; duration: number; live_status?: string } = { id, duration: dbDurations[id] };
        if (dbStatuses[id] && dbStatuses[id] !== 'not_live') msg.live_status = dbStatuses[id];
        res.write(`data: ${JSON.stringify(msg)}\n\n`);
      } else {
        missing.push(id);
      }
    }
    if (typeof res.flush === 'function') res.flush();

    if (!missing.length) {
      res.write('event: done\ndata: {}\n\n');
      return res.end();
    }

    // Fetch via yt-meta (internal API -> page scrape -> yt-dlp fallback chain)
    // Yield to active video extractions — duration badges are cosmetic and should
    // never compete with playback for yt-dlp/YouTube API slots
    let closed = false;
    req.on('close', () => { closed = true; });

    void (async () => {
      try {
        // Wait for any in-flight video extractions to finish first
        while (extractionInflight.size > 0 && !closed) {
          await new Promise(r => setTimeout(r, 500));
        }
        if (closed) return;
        const results = await fetchVideoMetaBatch(missing, { concurrency: 3 });
        for (const id of missing) {
          if (closed) return;
          const meta = results.get(id);
          if (meta) {
            db.setDuration(id, meta.duration, meta.liveStatus);
            const msg: { id: string; duration: number; live_status?: string } = { id, duration: meta.duration };
            if (meta.liveStatus !== 'not_live') msg.live_status = meta.liveStatus;
            res.write(`data: ${JSON.stringify(msg)}\n\n`);
            if (typeof res.flush === 'function') res.flush();
          }
        }
      } catch (err) {
        console.error('[durations-live] error:', err.message);
      }
      if (!closed) {
        res.write('event: done\ndata: {}\n\n');
        res.end();
      }
    })();
  });
}

export { mountAssetRoutes, mountBatchRoutes };
