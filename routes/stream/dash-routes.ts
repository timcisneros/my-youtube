import fs from 'fs';
import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';
import {
  fetchWithConnTimeout,
  isClientGone,
  formatCache,
  mpdCache,
  urlLookup,
  sanitizeHeaders,
  extractionInflight,
  CACHE_TTL,
  dedup,
} from './shared.js';
import { buildMPD } from './mpd.js';
import { extractFormats } from './extraction.js';
import { bgDownloads } from './downloads.js';
import * as segmentCache from '../../lib/segment-cache.js';

function mountDashRoutes(router) {
  // GET /api/stream/:videoId/dash.mpd
  router.get('/:videoId/dash.mpd', async (req, res) => {
    try {
      const { videoId } = req.params;
      // Extraction rate limit — only when not already cached
      if (!formatCache.has(videoId) && req.app.extractionRateCheck && !req.app.extractionRateCheck(req.ip, videoId)) {
        res.set('Retry-After', '60');
        return res.status(429).end('Extraction rate limit exceeded');
      }
      // ?refresh=1 forces fresh extraction (used by client-side recovery)
      if (req.query.refresh) {
        // Evict MPD and format caches — urlLookup is cleared atomically inside
        // buildMPD right before repopulation, so in-flight segment requests from
        // a previous Shaka load don't hit an empty lookup window.
        mpdCache.delete(videoId);
        formatCache.delete(videoId);
      }
      const result = await buildMPD(videoId);
      if (!result) return res.status(404).json({ error: 'No suitable formats found' });

      // Unavailable video (upcoming livestream, premiere, etc.)
      if (typeof result === 'object' && result.unavailable) {
        return res.status(404).json({ error: result.unavailable, scheduledStart: result.scheduledStart });
      }

      // Include stream chain metadata in a response header for the player UI
      const cached = mpdCache.get(videoId);
      if (cached && cached.meta) {
        res.set('X-Stream-Via', cached.meta.via + '/' + cached.meta.playback);
      }

      // HLS or progressive fallback
      if (typeof result === 'object' && (result.hls || result.progressive)) {
        return res.json(result);
      }

      // Tell the player the downloaded video height so it can pin ABR
      const itagHeight: Record<string, number> = {
        '160': 144, '133': 240, '134': 360, '135': 480, '136': 720,
        '137': 1080, '298': 720, '299': 1080, '264': 1440, '271': 1440,
        '313': 2160, '304': 720, '303': 1080, '308': 1440, '315': 2160,
        '330': 144, '331': 240, '332': 360, '333': 480, '334': 720,
        '335': 1080, '336': 1440, '337': 2160,
        '394': 144, '395': 240, '396': 360, '397': 480, '398': 720,
        '399': 1080, '400': 1440, '401': 2160, '571': 4320,
      };
      let dlHeight = 0;
      for (const [key, entry] of bgDownloads) {
        if (key.startsWith(videoId + ':') && entry.done) {
          const h = itagHeight[key.split(':')[1]] || 0;
          if (h > dlHeight) dlHeight = h;
        }
      }
      if (dlHeight > 0) {
        res.set('X-Downloaded-Height', String(dlHeight));
      }

      res.set('Content-Type', 'application/dash+xml');
      res.set('Cache-Control', 'private, max-age=300');
      res.send(result);
    } catch (err) {
      console.error('MPD generation failed:', err.message);
      res.status(502).json({ error: 'Failed to extract stream info' });
    }
  });

  // DASH format proxy — streams individual adaptive format by format_id
  router.get('/:videoId/fmt/:formatId', async (req, res) => {
    try {
      const { videoId, formatId } = req.params;

      // Check Redis segment cache for hot videos
      const cached = await segmentCache.getSegment(videoId, formatId, req.headers.range);
      if (cached) {
        res.status(cached.status);
        if (cached.contentType) res.set('Content-Type', cached.contentType);
        if (cached.contentRange) res.set('Content-Range', cached.contentRange);
        res.set('Content-Length', String(cached.contentLength));
        res.set('X-Segment-Cache', 'hit');
        return res.end(cached.data);
      }

      // Serve from local download if available (instant, no YouTube round-trip)
      const bg = bgDownloads.get(`${videoId}:${formatId}`);
      if (bg && bg.done && bg.bytesDownloaded > 0) {
        const audioItags = ['140', '141', '249', '250', '251'];
        const contentType = audioItags.includes(formatId) ? 'audio/mp4' : 'video/mp4';
        const rangeMatch = req.headers.range && (req.headers.range as string).match(/^bytes=(\d+)-(\d*)$/);
        if (rangeMatch) {
          const start = parseInt(rangeMatch[1], 10);
          const end = rangeMatch[2] ? parseInt(rangeMatch[2], 10) : bg.bytesDownloaded - 1;
          if (end < bg.bytesDownloaded) {
            res.status(206);
            res.set('Content-Type', contentType);
            res.set('Content-Length', String(end - start + 1));
            res.set('Content-Range', `bytes ${start}-${end}/${bg.totalSize || bg.bytesDownloaded}`);
            res.set('Accept-Ranges', 'bytes');
            res.set('X-Segment-Cache', 'local');
            const stream = fs.createReadStream(bg.filePath, { start, end });
            return pipeline(stream, res).catch(() => {});
          }
        } else {
          res.status(200);
          res.set('Content-Type', contentType);
          res.set('Content-Length', String(bg.bytesDownloaded));
          res.set('Accept-Ranges', 'bytes');
          res.set('X-Segment-Cache', 'local');
          const stream = fs.createReadStream(bg.filePath);
          return pipeline(stream, res).catch(() => {});
        }
      }

      let entry = urlLookup.get(`${videoId}:${formatId}`);
      if (!entry || Date.now() > entry.expires) {
        // URL missing or expired — rebuild MPD to repopulate urlLookup
        mpdCache.delete(videoId);
        formatCache.delete(videoId);
        await buildMPD(videoId);
        entry = urlLookup.get(`${videoId}:${formatId}`);
        if (!entry) return res.status(404).json({ error: 'Format not found' });
      }

      const headers = { ...(entry.headers || {}) };
      if (req.headers.range) headers.Range = req.headers.range;

      let upstream = await fetchWithConnTimeout(entry.url, { headers });

      // YouTube CDN URL expired — evict caches, re-extract, retry once
      if (upstream.status === 403 || upstream.status === 410) {
        await upstream.body?.cancel().catch(() => {});
        formatCache.delete(videoId);
        mpdCache.delete(videoId);
        for (const [key] of urlLookup) {
          if (key.startsWith(videoId + ':')) urlLookup.delete(key);
        }
        const info = await dedup(extractionInflight, `refresh:${videoId}`, () => extractFormats(videoId));
        const fmt = (info.formats || []).find((f: { format_id }) => String(f.format_id) === String(formatId));
        if (!fmt?.url) return res.status(404).json({ error: 'Format not found after refresh' });
        urlLookup.set(`${videoId}:${formatId}`, { url: fmt.url, headers: sanitizeHeaders(fmt.http_headers), expires: Date.now() + CACHE_TTL });
        const retryHeaders: Record<string, string> = { ...sanitizeHeaders(fmt.http_headers) };
        if (req.headers.range) retryHeaders.Range = req.headers.range as string;
        upstream = await fetchWithConnTimeout(fmt.url, { headers: retryHeaders });
      }

      if (!upstream.ok && upstream.status !== 206) {
        await upstream.body?.cancel().catch(() => {});
        if (upstream.status >= 500) res.set('Retry-After', '2');
        return res.status(upstream.status).end();
      }

      res.status(upstream.status);
      if (upstream.headers.get('content-type')) res.set('Content-Type', upstream.headers.get('content-type'));
      if (upstream.headers.get('content-length')) res.set('Content-Length', upstream.headers.get('content-length'));
      if (upstream.headers.get('content-range')) res.set('Content-Range', upstream.headers.get('content-range'));
      if (upstream.headers.get('accept-ranges')) res.set('Accept-Ranges', upstream.headers.get('accept-ranges'));
      // Forward CDN cache headers so browsers can cache segments
      for (const h of ['cache-control', 'etag', 'last-modified', 'expires']) {
        if (upstream.headers.get(h)) res.set(h, upstream.headers.get(h));
      }
      res.set('Access-Control-Allow-Origin', '*');
      res.set('X-Segment-Cache', 'miss');

      const nodeStream = Readable.fromWeb(upstream.body, { highWaterMark: 256 * 1024 });
      const cl = parseInt(upstream.headers.get('content-length') || '0', 10);
      const shouldCache = cl > 0 && cl <= 2 * 1024 * 1024;

      if (shouldCache) {
        const chunks = [];
        const collector = new Transform({
          transform(chunk, _enc, cb) { chunks.push(chunk); this.push(chunk); cb(); },
          flush(cb) {
            segmentCache.putSegment(videoId, formatId, req.headers.range, Buffer.concat(chunks), {
              contentType: upstream.headers.get('content-type'),
              contentRange: upstream.headers.get('content-range'),
              status: upstream.status,
            }).catch(() => {});
            cb();
          }
        });
        await pipeline(nodeStream, collector, res);
      } else {
        await pipeline(nodeStream, res);
      }
    } catch (err) {
      if (err.name !== 'AbortError' && !isClientGone(err)) {
        console.error(`[fmt proxy] ${req.params.videoId}/${req.params.formatId}:`, err.message);
      }
      if (!res.headersSent) res.status(502).json({ error: 'Stream proxy failed' });
    }
  });
}

export { mountDashRoutes };
