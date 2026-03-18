import fs from 'fs';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import {
  fetchWithConnTimeout,
  sanitizeHeaders,
  isClientGone,
  formatCache,
  mpdCache,
  urlLookup,
  dedup,
  extractionInflight,
  CACHE_TTL,
  PROACTIVE_REFRESH_AGE,
} from './shared.js';
import { extractFormats } from './extraction.js';
import { bgDownloads, cleanupBgDownload } from './downloads.js';

// Look up a cached format URL + headers (sync, returns null if missing/expired)
function resolveFormat(videoId, itag) {
  const lookup = urlLookup.get(`${videoId}:${itag}`);
  if (lookup && Date.now() < lookup.expires) return { url: lookup.url, cdnHeaders: lookup.headers || {} };
  return null;
}

// Evict all caches for a videoId so the next extractFormats call fetches fresh data
function evictVideoCache(videoId, _oldUrl) {
  formatCache.delete(videoId);
  mpdCache.delete(videoId);
  // Remove all urlLookup entries and bg downloads for this video
  for (const [key] of urlLookup) {
    if (key.startsWith(videoId + ':')) urlLookup.delete(key);
  }
  for (const [key] of bgDownloads) {
    if (key.startsWith(videoId + ':')) cleanupBgDownload(key);
  }
}

// Parse "bytes=START-END" from Range header
function parseRange(rangeHeader) {
  const m = rangeHeader && rangeHeader.match(/^bytes=(\d+)-(\d*)$/);
  if (!m) return null;
  return { start: parseInt(m[1], 10), end: m[2] ? parseInt(m[2], 10) : -1 };
}

function mountProxyRoutes(router) {
  // GET /api/stream/:videoId/progressive — serve best muxed MP4 for native playback fallback
  router.get('/:videoId/progressive', async (req, res) => {
    try {
      const { videoId } = req.params;
      const info = await extractFormats(videoId);
      const formats = info.formats || [];
      const isDirect = f => f.url && (!f.protocol || f.protocol === 'https' || f.protocol === 'http');
      // Pick best muxed MP4 (has both video + audio)
      const muxed = formats
        .filter(f => f.vcodec && f.vcodec !== 'none' && f.acodec && f.acodec !== 'none' && isDirect(f) && (f.ext === 'mp4' || f.ext === 'm4a' || (f.container && f.container.startsWith('mp4'))))
        .sort((a, b) => (b.height || 0) - (a.height || 0));
      const fmt = muxed[0] || formats.filter(f => f.vcodec && f.vcodec !== 'none' && f.acodec && f.acodec !== 'none' && isDirect(f))
        .sort((a, b) => (b.height || 0) - (a.height || 0))[0];
      if (!fmt || !fmt.url) return res.status(404).json({ error: 'No progressive format' });

      const headers = { ...sanitizeHeaders(fmt.http_headers) };
      if (req.headers.range) headers['Range'] = req.headers.range;

      const upstream = await fetch(fmt.url, { headers });
      res.status(upstream.status);
      const fwd = ['content-type', 'content-length', 'content-range', 'accept-ranges'];
      for (const h of fwd) {
        const val = upstream.headers.get(h);
        if (val) res.set(h, val);
      }
      res.set('Accept-Ranges', 'bytes');
      const nodeStream = Readable.fromWeb(upstream.body);
      await pipeline(nodeStream, res);
    } catch (err) {
      if (isClientGone(err)) return;
      console.error('[progressive] error:', err.message);
      if (!res.headersSent) res.status(502).end();
    }
  });

  // GET /api/stream/:videoId/proxy/:itag
  router.get('/:videoId/proxy/:itag', async (req, res) => {
    try {
      const { videoId, itag } = req.params;

      // Resolve format URL + CDN headers (cached or fresh)
      let fmtUrl, cdnHeaders = {};
      const resolved = resolveFormat(videoId, itag);
      if (resolved) {
        fmtUrl = resolved.url;
        cdnHeaders = resolved.cdnHeaders;

        // Proactive refresh: if cache entry is old, trigger background re-extraction
        const cacheEntry = formatCache.get(videoId);
        if (cacheEntry) {
          const age = (cacheEntry.expires - Date.now());
          // age is time remaining; if less than (TTL - PROACTIVE_REFRESH_AGE) remains, it's old
          if (age < CACHE_TTL - PROACTIVE_REFRESH_AGE && !extractionInflight.has(videoId)) {
            formatCache.delete(videoId);
            extractFormats(videoId).catch(err => console.warn(`[proactive-refresh ${videoId}]`, err.message));
          }
        }
      } else {
        const info = await extractFormats(videoId);
        const fmt = (info.formats || []).find(f => String(f.format_id) === String(itag));
        if (!fmt || !fmt.url) return res.status(404).json({ error: 'Format not found' });
        fmtUrl = fmt.url;
        cdnHeaders = sanitizeHeaders(fmt.http_headers);
      }

      // Check if requested bytes are available from background download cache
      const range = parseRange(req.headers.range);
      const bg = bgDownloads.get(`${videoId}:${itag}`);
      if (bg && range && range.start >= 0) {
        const effectiveEnd = range.end >= 0 ? range.end : bg.bytesDownloaded - 1;
        if (effectiveEnd < bg.bytesDownloaded && range.start <= effectiveEnd) {
          const slice = effectiveEnd - range.start + 1;
          res.status(206);
          res.set('Content-Type', 'application/octet-stream');
          res.set('Content-Length', String(slice));
          res.set('Content-Range', `bytes ${range.start}-${effectiveEnd}/${bg.totalSize || '*'}`);
          res.set('Accept-Ranges', 'bytes');
          res.set('Cache-Control', 'private, max-age=3600');
          res.set('Vary', 'Range');
          const stream = fs.createReadStream(bg.filePath, { start: range.start, end: effectiveEnd });
          return pipeline(stream, res);
        }
      }

      const headers = { ...cdnHeaders };
      if (req.headers.range) {
        headers['Range'] = req.headers.range;
      }

      let upstream = await fetchWithConnTimeout(fmtUrl, { headers });

      // If YouTube CDN rejected the URL (expired/throttled), evict caches and retry once
      // Circuit breaker: deduplicate re-extraction when many users hit the same expired URL
      if (upstream.status === 403 || upstream.status === 410) {
        await upstream.body?.cancel().catch(() => {});
        evictVideoCache(videoId, fmtUrl);
        const info = await dedup(extractionInflight, `refresh:${videoId}`, () => extractFormats(videoId));
        const fmt = (info.formats || []).find(f => String(f.format_id) === String(itag));
        if (!fmt || !fmt.url) return res.status(404).json({ error: 'Format not found after refresh' });
        fmtUrl = fmt.url;
        cdnHeaders = sanitizeHeaders(fmt.http_headers);
        urlLookup.set(`${videoId}:${itag}`, { url: fmtUrl, headers: cdnHeaders, expires: Date.now() + CACHE_TTL });
        upstream = await fetchWithConnTimeout(fmtUrl, { headers: { ...cdnHeaders, ...(req.headers.range ? { Range: req.headers.range } : {}) } });
      }

      res.status(upstream.status);
      const fwd = ['content-type', 'content-length', 'content-range', 'accept-ranges'];
      for (const h of fwd) {
        const val = upstream.headers.get(h);
        if (val) res.set(h, val);
      }
      res.set('Accept-Ranges', 'bytes');
      res.set('Cache-Control', 'private, max-age=3600');
      res.set('Vary', 'Range');

      const nodeStream = Readable.fromWeb(upstream.body);
      await pipeline(nodeStream, res);
    } catch (err) {
      if (isClientGone(err)) return;
      console.error('Proxy error:', err.message);
      if (!res.headersSent) {
        res.status(502).json({ error: 'Proxy failed' });
      }
    }
  });
}

export { mountProxyRoutes };
