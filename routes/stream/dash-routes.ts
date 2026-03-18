import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';
import {
  fetchWithConnTimeout,
  isClientGone,
  formatCache,
  mpdCache,
  urlLookup,
} from './shared.js';
import { buildMPD } from './mpd.js';
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
        return res.status(404).json({ error: result.unavailable });
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
      res.set('Content-Type', 'application/dash+xml');
      res.set('Cache-Control', 'no-cache');
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

      const upstream = await fetchWithConnTimeout(entry.url, { headers });
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
