import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import LRUMap from '../../lib/lru-map.js';
import { isYouTubeCdnUrl } from '../../extractors.js';
import {
  fetchWithConnTimeout,
  sanitizeHeaders,
  isClientGone,
  formatCache,
  mpdCache,
  hlsCache,
  CACHE_TTL,
  selectBestHlsFormat,
} from './shared.js';
import { extractFormats } from './extraction.js';
import { buildFixtureHlsMaster, buildFixtureHlsMedia, isPlayerFixtureVideo } from './player-fixture.js';

// Cache rewritten HLS manifests to avoid re-parsing on every request
const hlsRewriteCache = new LRUMap(200);

function rewriteHLS(body, videoId, baseUrl) {
  const cacheKey = videoId + ':' + body.length;
  const cached = hlsRewriteCache.get(cacheKey);
  if (cached) return cached;
  const proxyBase = '/api/stream/' + videoId + '/hls-proxy?u=';
  const lines = body.split('\n');

  // First pass: parse #EXT-X-STREAM-INF + URL pairs, extract resolution & bandwidth
  const variants = [];  // { infoLine, urlLine, height, bandwidth }
  const otherLines = []; // non-variant lines (headers, comments, media playlists, etc.)
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('#EXT-X-STREAM-INF')) {
      // Skip dubbed-auto variants
      if (/EgtkdWJiZWQtYXV0bw/.test(trimmed)) {
        i++; // skip the URL line too
        continue;
      }
      const urlLine = (i + 1 < lines.length) ? lines[i + 1] : '';
      i++; // consume the URL line

      // Extract RESOLUTION=WxH
      const resMatch = trimmed.match(/RESOLUTION=(\d+)x(\d+)/);
      const height = resMatch ? parseInt(resMatch[2], 10) : 0;
      // Extract BANDWIDTH=N
      const bwMatch = trimmed.match(/BANDWIDTH=(\d+)/);
      const bandwidth = bwMatch ? parseInt(bwMatch[1], 10) : 0;

      variants.push({ infoLine: lines[i - 1], urlLine, height, bandwidth });
    } else {
      otherLines.push(lines[i]);
    }
  }

  // Deduplicate: keep only the highest-bandwidth variant per resolution height
  const bestByHeight = new Map();
  for (const v of variants) {
    const key = v.height || v.bandwidth; // fall back to bandwidth if no resolution
    if (!bestByHeight.has(key) || v.bandwidth > bestByHeight.get(key).bandwidth) {
      bestByHeight.set(key, v);
    }
  }
  const kept = [...bestByHeight.values()];

  // Second pass: reconstruct the manifest with proxy URLs
  const filtered = [];
  for (const line of otherLines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      filtered.push(line.replace(/URI="([^"]+)"/g, function (_, uri) {
        var abs = uri.startsWith('http') ? uri : new URL(uri, baseUrl).href;
        return 'URI="' + proxyBase + encodeURIComponent(abs) + '"';
      }));
    } else {
      var abs = trimmed.startsWith('http') ? trimmed : new URL(trimmed, baseUrl).href;
      filtered.push(proxyBase + encodeURIComponent(abs));
    }
  }

  // Insert deduplicated variant lines (info + proxied URL)
  const variantLines = [];
  for (const v of kept) {
    variantLines.push(v.infoLine);
    const trimmedUrl = v.urlLine.trim();
    if (trimmedUrl) {
      const abs = trimmedUrl.startsWith('http') ? trimmedUrl : new URL(trimmedUrl, baseUrl).href;
      variantLines.push(proxyBase + encodeURIComponent(abs));
    }
  }

  // Place variant lines after header lines (before first non-header non-empty line)
  let insertIdx = filtered.length;
  for (let i = 0; i < filtered.length; i++) {
    const t = filtered[i].trim();
    if (t && !t.startsWith('#')) {
      insertIdx = i;
      break;
    }
  }
  filtered.splice(insertIdx, 0, ...variantLines);

  const result = filtered.join('\n');
  hlsRewriteCache.set(cacheKey, result);
  return result;
}

function mountHlsRoutes(router) {
  // HLS manifest proxy — rewrites segment URLs to go through our proxy
  router.get('/:videoId/hls.m3u8', async (req, res) => {
    try {
      const { videoId } = req.params;
      if (isPlayerFixtureVideo(videoId) && req.query.fixtureHls) {
        res.set('Content-Type', 'application/vnd.apple.mpegurl');
        res.set('Cache-Control', 'no-store');
        return res.send(buildFixtureHlsMaster(videoId, req.query));
      }
      let entry = hlsCache.get(videoId);
      if (!entry || Date.now() > entry.expires) return res.status(404).json({ error: 'HLS not available' });
      let upstream = await fetchWithConnTimeout(entry.url, { headers: entry.headers });

      // If the master manifest URL expired, re-extract fresh HLS URL and retry
      if (upstream.status === 403 || upstream.status === 410) {
        await upstream.body?.cancel().catch(() => {});
        hlsCache.delete(videoId);
        formatCache.delete(videoId);
        mpdCache.delete(videoId);
        const info = await extractFormats(videoId);
        const hlsFmt = selectBestHlsFormat(info.formats || [], info.language);
        if (!hlsFmt) return res.status(404).json({ error: 'HLS not available after refresh' });
        entry = { url: hlsFmt.manifest_url || hlsFmt.url, headers: sanitizeHeaders(hlsFmt.http_headers), expires: Date.now() + CACHE_TTL };
        hlsCache.set(videoId, entry);
        upstream = await fetchWithConnTimeout(entry.url, { headers: entry.headers });
      }

      if (!upstream.ok) {
        await upstream.body?.cancel().catch(() => {});
        return res.status(upstream.status).end();
      }
      let body = await upstream.text();
      body = rewriteHLS(body, videoId, entry.url);
      res.set('Content-Type', 'application/vnd.apple.mpegurl');
      res.set('Cache-Control', 'no-cache');
      res.send(body);
    } catch (err) {
      if (!res.headersSent) res.status(502).end();
    }
  });

  router.get('/:videoId/hls/:formatId.m3u8', (req, res) => {
    const { videoId, formatId } = req.params;
    if (!isPlayerFixtureVideo(videoId) || !req.query.fixtureHls) {
      return res.status(404).json({ error: 'HLS fixture not found' });
    }
    const body = buildFixtureHlsMedia(videoId, formatId);
    if (!body) return res.status(404).json({ error: 'HLS fixture format not found' });
    res.set('Content-Type', 'application/vnd.apple.mpegurl');
    res.set('Cache-Control', 'no-store');
    res.send(body);
  });

  // HLS segment/sub-manifest proxy — use query param since encoded URLs are too long for path params
  router.get('/:videoId/hls-proxy', async (req, res) => {
    try {
      const { videoId } = req.params;
      const url = req.query.u;
      if (!url || (!url.startsWith('https://') && !url.startsWith('http://'))) return res.status(400).end();
      // SSRF protection: only allow YouTube/Google video CDN domains
      if (!isYouTubeCdnUrl(url)) {
        return res.status(403).end('Forbidden: domain not allowed');
      }
      let entry = hlsCache.get(videoId);
      const headers = entry ? { ...entry.headers } : {};
      if (req.headers.range) headers.Range = req.headers.range;
      let upstream = await fetchWithConnTimeout(url, { headers });

      // If the segment URL expired, invalidate caches so the next manifest
      // request (from Shaka's HLS parser) triggers a fresh extraction via
      // the /hls.m3u8 route.  Return 410 to signal Shaka that this URL is
      // permanently gone — it will re-fetch the manifest and get new segment URLs.
      if (upstream.status === 403 || upstream.status === 410) {
        await upstream.body?.cancel().catch(() => {});
        hlsCache.delete(videoId);
        formatCache.delete(videoId);
        mpdCache.delete(videoId);
        // Pre-warm: trigger extraction so next manifest fetch is instant
        extractFormats(videoId).catch(err => console.warn(`[pre-warm ${videoId}]`, err.message));
        return res.status(410).end();
      }

      if (!upstream.ok && upstream.status !== 206) {
        await upstream.body?.cancel().catch(() => {});
        if (upstream.status >= 500) res.set('Retry-After', '2');
        return res.status(upstream.status).end();
      }
      res.status(upstream.status);
      const ct = upstream.headers.get('content-type');
      if (ct) res.set('Content-Type', ct);
      for (const h of ['content-length', 'content-range', 'accept-ranges']) {
        if (upstream.headers.get(h)) res.set(h, upstream.headers.get(h));
      }
      // If it's a sub-manifest, rewrite URLs too (check content-type only, not URL path)
      if (ct && ct.includes('mpegurl')) {
        let body = await upstream.text();
        body = rewriteHLS(body, req.params.videoId, url);
        res.set('Content-Type', 'application/vnd.apple.mpegurl');
        res.send(body);
      } else {
        const nodeStream = Readable.fromWeb(upstream.body);
        await pipeline(nodeStream, res);
      }
    } catch (err) {
      if (isClientGone(err)) return;
      console.error('[hls-proxy] error:', err.message);
      if (!res.headersSent) res.status(502).end();
    }
  });
}

export { mountHlsRoutes };
