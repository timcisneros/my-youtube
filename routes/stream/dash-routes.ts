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
  streamRequestSignal,
} from './shared.js';
import { buildMPD, hasCachedPlayback } from './mpd.js';
import { extractFormats } from './extraction.js';
import * as segmentCache from '../../lib/segment-cache.js';
import { incrementMetric } from '../../lib/performance-metrics.js';
import { getDownloadedFormat, listDownloadedFormats } from '../../lib/download-files.js';
import { buildFixtureMPD, isPlayerFixtureVideo, serveFixtureFormat, serveFixtureProgressive, serveFixtureTemplatePart } from './player-fixture.js';

function mountDashRoutes(router) {
  // GET /api/stream/:videoId/dash.mpd
  router.get('/:videoId/dash.mpd', async (req, res) => {
    try {
      const { videoId } = req.params;
      if (isPlayerFixtureVideo(videoId)) {
        res.set('X-Stream-Via', 'fixture/dash');
        res.set('Content-Type', 'application/dash+xml');
        res.set('Cache-Control', 'no-store');
        return res.send(buildFixtureMPD(videoId, req.query));
      }
      // Only charge extraction admission after both worker-local and shared
      // caches miss. Otherwise a cluster handoff can reject cached playback.
      if (!await hasCachedPlayback(videoId) && req.app.extractionRateCheck && !req.app.extractionRateCheck(req.ip, videoId)) {
        res.set('Retry-After', '60');
        return res.status(429).end('Extraction rate limit exceeded');
      }
      // ?refresh=1 forces fresh extraction (used by client-side recovery)
      if (req.query.refresh) {
        // Evict the generated result and extraction data. Existing URL entries
        // remain available to in-flight segments until the rebuilt manifest
        // publishes replacements or their short TTL expires.
        mpdCache.delete(videoId);
        formatCache.delete(videoId);
      }
      const result = await buildMPD(videoId);
      if (!result) return res.status(404).json({ error: 'No suitable formats found' });

      // Unavailable video (upcoming livestream, premiere, etc.)
      if (typeof result === 'object' && result.unavailable) {
        if (result.overloaded) {
          res.set('Retry-After', '2');
          return res.status(503).json({ error: result.unavailable });
        }
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
      for (const entry of await listDownloadedFormats(videoId)) {
        const h = itagHeight[entry.formatId] || 0;
        if (h > dlHeight) dlHeight = h;
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

  router.get('/:videoId/progressive.mp4', (req, res) => {
    if (serveFixtureProgressive(req.params.videoId, req, res)) return;
    res.status(404).json({ error: 'Progressive fixture not found' });
  });

  const serveTemplateFixture = (req, res) => {
    const part = req.params.part || 'init';
    if (part && serveFixtureTemplatePart(req.params.videoId, req.params.formatId, part, req, res)) return;
    res.status(404).json({ error: 'Template fixture part not found' });
  };
  router.get('/:videoId/tmpl/:formatId/init', serveTemplateFixture);
  router.get('/:videoId/tmpl/:formatId/:kind/:part', serveTemplateFixture);

  // DASH format proxy — streams individual adaptive format by format_id
  router.get('/:videoId/fmt/:formatId', async (req, res) => {
    let segmentFlight: import('../../lib/segment-cache.js').SegmentFlight | null = null;
    try {
      const { videoId, formatId } = req.params;
      const requestSignal = streamRequestSignal(req, res);
      if (serveFixtureFormat(videoId, formatId, req, res)) return;

      // Serve from local download if available (instant, no YouTube round-trip)
      const downloaded = await getDownloadedFormat(videoId, formatId);
      if (downloaded) {
        const audioItags = ['140', '141', '249', '250', '251'];
        const contentType = audioItags.includes(formatId) ? 'audio/mp4' : 'video/mp4';
        const rangeMatch = req.headers.range && (req.headers.range as string).match(/^bytes=(\d+)-(\d*)$/);
        if (rangeMatch) {
          const start = parseInt(rangeMatch[1], 10);
          const end = rangeMatch[2] ? parseInt(rangeMatch[2], 10) : downloaded.size - 1;
          if (start >= 0 && end >= start && end < downloaded.size) {
            res.status(206);
            res.set('Content-Type', contentType);
            res.set('Content-Length', String(end - start + 1));
            res.set('Content-Range', `bytes ${start}-${end}/${downloaded.size}`);
            res.set('Accept-Ranges', 'bytes');
            res.set('X-Segment-Cache', 'local');
            const stream = fs.createReadStream(downloaded.filePath, { start, end });
            return pipeline(stream, res).catch(() => {});
          }
        } else {
          res.status(200);
          res.set('Content-Type', contentType);
          res.set('Content-Length', String(downloaded.size));
          res.set('Accept-Ranges', 'bytes');
          res.set('X-Segment-Cache', 'local');
          const stream = fs.createReadStream(downloaded.filePath);
          return pipeline(stream, res).catch(() => {});
        }
      }

      // Only consult shared Redis after local storage and after this worker has
      // observed the same range before. This removes a remote command from the
      // common one-viewer segment path.
      if (segmentCache.shouldCheckSegment(videoId, formatId, req.headers.range)) {
        const cached = await segmentCache.getSegment(videoId, formatId, req.headers.range);
        if (cached) {
          res.status(cached.status);
          if (cached.contentType) res.set('Content-Type', cached.contentType);
          if (cached.contentRange) res.set('Content-Range', cached.contentRange);
          res.set('Content-Length', String(cached.contentLength));
          res.set('X-Segment-Cache', 'hit');
          return res.end(cached.data);
        }
      }

      const joinedFlight = segmentCache.joinSegmentFlight(videoId, formatId, req.headers.range);
      if (joinedFlight?.leader) {
        segmentFlight = joinedFlight;
      } else if (joinedFlight) {
        const shared = await joinedFlight.promise;
        if (shared) {
          res.status(shared.status);
          if (shared.contentType) res.set('Content-Type', shared.contentType);
          if (shared.contentRange) res.set('Content-Range', shared.contentRange);
          res.set('Content-Length', String(shared.contentLength));
          res.set('Accept-Ranges', 'bytes');
          res.set('Access-Control-Allow-Origin', '*');
          res.set('X-Segment-Cache', 'collapsed');
          incrementMetric('segment_singleflight_responses_total', { result: 'shared' });
          return res.end(shared.data);
        }
        incrementMetric('segment_singleflight_responses_total', { result: 'fallback' });
      }

      const lookupKey = `${videoId}:${formatId}`;
      let entry = await urlLookup.getAsync(lookupKey);
      if (!entry) {
        // A segment can land on a different worker than the manifest request.
        // Rehydrate just this URL from the shared extraction result instead of
        // deleting a valid shared manifest and forcing a complete rebuild.
        const info = await extractFormats(videoId);
        const fmt = (info.formats || []).find((f: { format_id }) => String(f.format_id) === String(formatId));
        if (!fmt?.url) return res.status(404).json({ error: 'Format not found' });
        entry = { url: fmt.url, headers: sanitizeHeaders(fmt.http_headers), expires: Date.now() + CACHE_TTL };
        await urlLookup.setAsync(lookupKey, entry);
      }

      const headers = { ...(entry.headers || {}) };
      if (req.headers.range) headers.Range = req.headers.range;

      let upstream = await fetchWithConnTimeout(entry.url, { headers, signal: requestSignal });

      // YouTube CDN URL/range expired — evict caches, re-extract, retry once
      if (upstream.status === 403 || upstream.status === 404 || upstream.status === 410 || upstream.status === 416) {
        await upstream.body?.cancel().catch(() => {});
        formatCache.delete(videoId);
        mpdCache.delete(videoId);
        for (const [key] of urlLookup) {
          if (key.startsWith(videoId + ':')) urlLookup.delete(key);
        }
        const info = await dedup(
          extractionInflight,
          `refresh:${videoId}`,
          () => extractFormats(videoId),
          { name: 'stream_extraction', maxEntries: 256 },
        );
        const fmt = (info.formats || []).find((f: { format_id }) => String(f.format_id) === String(formatId));
        if (!fmt?.url) return res.status(404).json({ error: 'Format not found after refresh' });
        await urlLookup.setAsync(`${videoId}:${formatId}`, { url: fmt.url, headers: sanitizeHeaders(fmt.http_headers), expires: Date.now() + CACHE_TTL });
        const retryHeaders: Record<string, string> = { ...sanitizeHeaders(fmt.http_headers) };
        if (req.headers.range) retryHeaders.Range = req.headers.range as string;
        upstream = await fetchWithConnTimeout(fmt.url, { headers: retryHeaders, signal: requestSignal });
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
      const isSmallSegment = cl > 0 && cl <= 2 * 1024 * 1024;
      const shouldCache = isSmallSegment && (joinedFlight
        ? segmentCache.isObservedSegmentHot(videoId, formatId, req.headers.range)
        : segmentCache.shouldStoreSegment(videoId, formatId, req.headers.range));
      const shouldCollect = isSmallSegment && (Boolean(segmentFlight) || shouldCache);
      const releaseCollection = shouldCollect ? segmentCache.reserveSegmentCollection(cl) : null;
      if (segmentFlight && !releaseCollection) segmentFlight.complete?.(null);

      if (releaseCollection) {
        const cacheBuffer = Buffer.allocUnsafe(cl);
        let cacheOffset = 0;
        let cacheValid = true;
        let collectionHandedOff = false;
        const collector = new Transform({
          transform(chunk, _enc, cb) {
            if (cacheValid && cacheOffset + chunk.length <= cacheBuffer.length) {
              chunk.copy(cacheBuffer, cacheOffset);
              cacheOffset += chunk.length;
            } else {
              cacheValid = false;
            }
            this.push(chunk);
            cb();
          },
          flush(cb) {
            if (cacheValid && cacheOffset === cacheBuffer.length) {
              const payload = {
                data: cacheBuffer,
                contentType: upstream.headers.get('content-type'),
                contentLength: cacheBuffer.length,
                contentRange: upstream.headers.get('content-range'),
                status: upstream.status,
              };
              segmentFlight?.complete?.(payload);
              if (shouldCache) {
                collectionHandedOff = true;
                void segmentCache.storeSegment(videoId, formatId, req.headers.range, cacheBuffer, payload)
                  .catch(() => {})
                  .finally(releaseCollection);
              } else {
                releaseCollection();
              }
            }
            cb();
          }
        });
        try {
          await pipeline(nodeStream, collector, res);
        } finally {
          if (!collectionHandedOff) releaseCollection();
        }
      } else {
        await pipeline(nodeStream, res);
      }
    } catch (err) {
      if (err.name !== 'AbortError' && !isClientGone(err)) {
        console.error(`[fmt proxy] ${req.params.videoId}/${req.params.formatId}:`, err.message);
      }
      if (!res.headersSent) res.status(502).json({ error: 'Stream proxy failed' });
    } finally {
      segmentFlight?.complete?.(null);
    }
  });
}

export { mountDashRoutes };
