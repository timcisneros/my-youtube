import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { isYouTubeCdnUrl } from '../../extractors.js';
import { appendHlsReloadParams, rewriteHlsManifest } from '../../lib/hls-manifest.js';
import { incrementMetric } from '../../lib/performance-metrics.js';
import {
  fetchWithConnTimeout,
  sanitizeHeaders,
  isClientGone,
  formatCache,
  mpdCache,
  hlsCache,
  CACHE_TTL,
  selectBestHlsFormat,
  streamRequestSignal,
} from './shared.js';
import { extractFormats } from './extraction.js';
import {
  buildFixtureHlsMaster,
  buildFixtureHlsMedia,
  isPlayerFixtureVideo,
  serveFixtureEncryptedHlsSegment,
  serveFixtureHlsKey,
  serveFixtureTsSegment,
} from './player-fixture.js';

const MAX_HLS_MANIFEST_BYTES = Math.max(64 * 1024, Number(process.env.MAX_HLS_MANIFEST_BYTES) || 2 * 1024 * 1024);

async function refreshHlsEntry(videoId) {
  const info = await extractFormats(videoId);
  const hlsFmt = selectBestHlsFormat(info.formats || [], info.language);
  if (!hlsFmt) return null;
  const entry = { url: hlsFmt.manifest_url || hlsFmt.url, headers: sanitizeHeaders(hlsFmt.http_headers), expires: Date.now() + CACHE_TTL };
  await hlsCache.setAsync(videoId, entry);
  return entry;
}

async function readBoundedHlsManifest(response: Response) {
  const declaredBytes = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredBytes) && declaredBytes > MAX_HLS_MANIFEST_BYTES) {
    await response.body?.cancel('hls-manifest-too-large').catch(() => {});
    throw new Error('hls-manifest-too-large');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_HLS_MANIFEST_BYTES) {
      await reader.cancel('hls-manifest-too-large').catch(() => {});
      throw new Error('hls-manifest-too-large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map(chunk => Buffer.from(chunk)), total).toString('utf8');
}

function mountHlsRoutes(router) {
  // HLS manifest proxy — rewrites segment URLs to go through our proxy
  router.get('/:videoId/hls.m3u8', async (req, res) => {
    try {
      const { videoId } = req.params;
      const requestSignal = streamRequestSignal(req, res);
      if (isPlayerFixtureVideo(videoId) && req.query.fixtureHls) {
        res.set('Content-Type', 'application/vnd.apple.mpegurl');
        res.set('Cache-Control', 'no-store');
        return res.send(buildFixtureHlsMaster(videoId, req.query));
      }
      let entry = await hlsCache.getAsync(videoId);
      if (!entry) {
        entry = await refreshHlsEntry(videoId);
        if (!entry) return res.status(404).json({ error: 'HLS not available' });
      }
      let upstream = await fetchWithConnTimeout(entry.url, {
        headers: entry.headers,
        outboundPriority: 'interactive',
        signal: requestSignal,
      });

      // If the master manifest URL expired, re-extract fresh HLS URL and retry
      if (upstream.status === 403 || upstream.status === 404 || upstream.status === 410) {
        await upstream.body?.cancel().catch(() => {});
        hlsCache.delete(videoId);
        formatCache.delete(videoId);
        mpdCache.delete(videoId);
        const refreshed = await refreshHlsEntry(videoId);
        const hlsFmt = refreshed ? { manifest_url: refreshed.url, url: refreshed.url, http_headers: refreshed.headers } : null;
        if (!hlsFmt) return res.status(404).json({ error: 'HLS not available after refresh' });
        entry = refreshed;
        upstream = await fetchWithConnTimeout(entry.url, {
          headers: entry.headers,
          outboundPriority: 'interactive',
          signal: requestSignal,
        });
      }

      if (!upstream.ok) {
        await upstream.body?.cancel().catch(() => {});
        return res.status(upstream.status).end();
      }
      const token = typeof req.query.token === 'string' ? req.query.token : '';
      let body = await readBoundedHlsManifest(upstream);
      body = rewriteHlsManifest(body, videoId, entry.url, token);
      incrementMetric('hls_manifests_total', { kind: 'master', live: body.includes('#EXT-X-ENDLIST') ? 'false' : 'unknown' });
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
    const body = buildFixtureHlsMedia(videoId, formatId, req.query);
    if (!body) return res.status(404).json({ error: 'HLS fixture format not found' });
    res.set('Content-Type', 'application/vnd.apple.mpegurl');
    res.set('Cache-Control', 'no-store');
    res.send(body);
  });

  router.get('/:videoId/hls-ts/:formatId.ts', (req, res) => {
    const { videoId, formatId } = req.params;
    if (!serveFixtureTsSegment(videoId, formatId, req, res)) {
      return res.status(404).json({ error: 'HLS fixture TS not found' });
    }
  });

  router.get('/:videoId/hls-ts-raw/:formatId', (req, res) => {
    const { videoId, formatId } = req.params;
    if (!serveFixtureTsSegment(videoId, formatId, req, res)) {
      return res.status(404).json({ error: 'HLS fixture TS not found' });
    }
  });

  router.get('/:videoId/hls-key/:keyId.key', (req, res) => {
    const { videoId, keyId } = req.params;
    if (!serveFixtureHlsKey(videoId, keyId, req, res)) {
      return res.status(404).json({ error: 'HLS fixture key not found' });
    }
  });

  router.get('/:videoId/hls-aes/:formatId/:segmentId.bin', (req, res) => {
    const { videoId, formatId, segmentId } = req.params;
    if (!serveFixtureEncryptedHlsSegment(videoId, formatId, segmentId, req, res)) {
      return res.status(404).json({ error: 'HLS encrypted fixture segment not found' });
    }
  });

  router.get('/:videoId/hls-aes/:formatId/:segmentId.ts', (req, res) => {
    const { videoId, formatId, segmentId } = req.params;
    if (!serveFixtureEncryptedHlsSegment(videoId, formatId, segmentId, req, res)) {
      return res.status(404).json({ error: 'HLS encrypted fixture segment not found' });
    }
  });

  // HLS segment/sub-manifest proxy — use query param since encoded URLs are too long for path params
  router.get('/:videoId/hls-proxy', async (req, res) => {
    try {
      const { videoId } = req.params;
      const requestSignal = streamRequestSignal(req, res);
      const url = req.query.u;
      if (!url || (!url.startsWith('https://') && !url.startsWith('http://'))) return res.status(400).end();
      // SSRF protection: only allow YouTube/Google video CDN domains
      if (!isYouTubeCdnUrl(url)) {
        return res.status(403).end('Forbidden: domain not allowed');
      }
      const entry = await hlsCache.getAsync(videoId);
      const headers = entry ? { ...entry.headers } : {};
      if (req.headers.range) headers.Range = req.headers.range;
      const upstreamUrl = appendHlsReloadParams(url, req.query);
      let upstream = await fetchWithConnTimeout(upstreamUrl, { headers, signal: requestSignal });

      // If the segment URL expired, invalidate caches so the next manifest
      // request (from Shaka's HLS parser) triggers a fresh extraction via
      // the /hls.m3u8 route.  Return 410 to signal Shaka that this URL is
      // permanently gone — it will re-fetch the manifest and get new segment URLs.
      if (upstream.status === 403 || upstream.status === 404 || upstream.status === 410) {
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
        const token = typeof req.query.token === 'string' ? req.query.token : '';
        let body = await readBoundedHlsManifest(upstream);
        const live = !body.includes('#EXT-X-ENDLIST');
        body = rewriteHlsManifest(body, req.params.videoId, url, token);
        incrementMetric('hls_manifests_total', { kind: 'media', live: String(live) });
        res.set('Content-Type', 'application/vnd.apple.mpegurl');
        res.set('Cache-Control', 'private, no-cache');
        res.set('X-HLS-Playlist', live ? 'live' : 'vod');
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

export { mountHlsRoutes, readBoundedHlsManifest };
