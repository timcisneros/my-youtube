import { hasRedis } from '../../lib/cache.js';
import {
  fetchWithConnTimeout,
  sanitizeHeaders,
  mpdCache,
  urlLookup,
  mp4ProbeCache,
  hlsCache,
  dedup,
  CACHE_TTL,
  selectBestHlsFormat,
} from './shared.js';
import { extractFormats } from './extraction.js';
import { notifyExtractionStep, notifyExtractionDone } from './status.js';

// Probe MP4 byte ranges (init + index) by walking box headers
async function probeMP4Ranges(url, headers) {
  let offset = 0, initEnd = 0, sidxStart = -1, sidxEnd = -1;

  // Fetch a chunk starting at offset, return a Buffer
  async function fetchChunk(start, size) {
    const resp = await fetchWithConnTimeout(url, { headers: { ...headers, Range: `bytes=${start}-${start + size - 1}` } }, 8000);
    if (!resp.ok && resp.status !== 206) return null;
    return Buffer.from(await resp.arrayBuffer());
  }

  // First fetch — most YouTube MP4s have ftyp+moov+sidx within the first few KB
  let buf = await fetchChunk(0, 4096);
  if (!buf) return null;

  while (true) {
    // Need at least 8 bytes for a box header
    if (offset + 8 > buf.length) {
      // Fetch more from where we left off
      const more = await fetchChunk(offset, 4096);
      if (!more || more.length < 8) break;
      buf = Buffer.concat([buf, more]);
    }

    let size = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    if (size === 1) {
      if (offset + 16 > buf.length) {
        const more = await fetchChunk(buf.length, 4096);
        if (!more) break;
        buf = Buffer.concat([buf, more]);
        if (offset + 16 > buf.length) break;
      }
      const bigSize = buf.readBigUInt64BE(offset + 8);
      if (bigSize > BigInt(Number.MAX_SAFE_INTEGER)) break;
      size = Number(bigSize);
    }
    if (size === 0 || size < 8) break;

    if (type === 'moov') initEnd = offset + size - 1;
    else if (type === 'sidx') { sidxStart = offset; sidxEnd = offset + size - 1; }

    if (sidxStart >= 0 && initEnd > 0) break;

    // Skip to next box — don't need to download the box body
    offset += size;
  }

  return (initEnd > 0 && sidxStart >= 0) ? { initRange: '0-' + initEnd, indexRange: sidxStart + '-' + sidxEnd } : null;
}

function formatDuration(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = (sec % 60).toFixed(3);
  return 'PT' + (h ? h + 'H' : '') + (m ? m + 'M' : '') + s + 'S';
}

function escapeXML(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function generateMPD(videoId, duration, formats, rangeMap) {
  const dur = formatDuration(duration);
  let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" profiles="urn:mpeg:dash:profile:isoff-on-demand:2011" type="static" mediaPresentationDuration="${dur}" minBufferTime="PT2S">\n<Period duration="${dur}">\n`;

  // Video AdaptationSet
  const videos = formats.filter(f => f.vcodec && f.vcodec !== 'none' && (!f.acodec || f.acodec === 'none'));
  if (videos.length) {
    xml += `<AdaptationSet mimeType="video/mp4" segmentAlignment="true" startWithSAP="1">\n`;
    for (const f of videos) {
      const r = rangeMap[f.format_id];
      if (!r) continue;
      xml += `<Representation id="${escapeXML(f.format_id)}" bandwidth="${f.tbr ? Math.round(f.tbr * 1000) : 0}" width="${f.width || 0}" height="${f.height || 0}" codecs="${escapeXML(f.vcodec)}">\n`;
      xml += `<BaseURL>/api/stream/${videoId}/fmt/${f.format_id}</BaseURL>\n`;
      xml += `<SegmentBase indexRange="${r.indexRange}"><Initialization range="${r.initRange}"/></SegmentBase>\n`;
      xml += `</Representation>\n`;
    }
    xml += `</AdaptationSet>\n`;
  }

  // Audio AdaptationSet
  const audios = formats.filter(f => f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none'));
  if (audios.length) {
    xml += `<AdaptationSet mimeType="audio/mp4" segmentAlignment="true" startWithSAP="1">\n`;
    for (const f of audios) {
      const r = rangeMap[f.format_id];
      if (!r) continue;
      xml += `<Representation id="${escapeXML(f.format_id)}" bandwidth="${f.tbr ? Math.round(f.tbr * 1000) : 0}" codecs="${escapeXML(f.acodec)}" audioSamplingRate="${f.asr || 44100}">\n`;
      xml += `<BaseURL>/api/stream/${videoId}/fmt/${f.format_id}</BaseURL>\n`;
      xml += `<SegmentBase indexRange="${r.indexRange}"><Initialization range="${r.initRange}"/></SegmentBase>\n`;
      xml += `</Representation>\n`;
    }
    xml += `</AdaptationSet>\n`;
  }

  xml += `</Period>\n</MPD>`;
  return xml;
}

// In-flight MPD build promises to deduplicate concurrent buildMPD calls
const mpdInflight = new Map();

// Build (or return cached) MPD for a videoId
async function buildMPD(videoId) {
  const cached = mpdCache.get(videoId);
  if (cached && Date.now() < cached.expires) return cached.data;

  // Check Redis for cross-worker cache hit before rebuilding
  if (hasRedis()) {
    const redisEntry = await mpdCache.getAsync(videoId);
    if (redisEntry && redisEntry.data && Date.now() < redisEntry.expires) return redisEntry.data;
  }

  return dedup(mpdInflight, videoId, async () => {
    const info = await extractFormats(videoId);
    if (info._unavailable) { notifyExtractionDone(videoId); return { unavailable: info._unavailable }; }
    notifyExtractionStep(videoId, 'building');

    try {
    const isDirect = f => f.url && (!f.protocol || f.protocol === 'https' || f.protocol === 'http');
    const allFmts = (info.formats || []).filter(f => isDirect(f));

    // Try DASH first — separate video-only + audio-only MP4 streams
    const videoFmts = allFmts.filter(f => f.vcodec && f.vcodec !== 'none' && (!f.acodec || f.acodec === 'none'));
    const audioFmts = allFmts.filter(f => f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none'));
    const mp4Video = videoFmts.filter(f => f.ext === 'mp4');
    const mp4Audio = audioFmts.filter(f => f.ext === 'm4a');

    if (mp4Video.length && mp4Audio.length) {
      // Overwrite URL entries — stale entries for removed formats expire via TTL
      for (const f of [...mp4Video, ...mp4Audio]) {
        urlLookup.set(`${videoId}:${f.format_id}`, { url: f.url, headers: sanitizeHeaders(f.http_headers), expires: Date.now() + CACHE_TTL });
      }

      // Probe each format for its own init/index byte ranges
      const rangeMap = {};
      // Check probe cache for already-probed formats
      await Promise.all([...mp4Video, ...mp4Audio].map(async (f) => {
        const probeKey = `${videoId}:${f.format_id}`;
        const cached = mp4ProbeCache.get(probeKey);
        if (cached) { rangeMap[f.format_id] = cached; return; }
        try {
          const ranges = await probeMP4Ranges(f.url, sanitizeHeaders(f.http_headers));
          if (ranges) {
            rangeMap[f.format_id] = ranges;
            mp4ProbeCache.set(probeKey, ranges);
          }
        } catch (e) { if (e.name !== 'AbortError') console.warn(`[stream ${videoId}] probe failed for ${f.format_id}:`, e.message); }
      }));

      const hasRanges = Object.keys(rangeMap).length > 0;
      if (hasRanges) {
        const mpd = generateMPD(videoId, info.duration || 0, [...mp4Video, ...mp4Audio], rangeMap);
        const videoCount = mp4Video.filter(f => rangeMap[f.format_id]).length;
        const audioCount = mp4Audio.filter(f => rangeMap[f.format_id]).length;
        const via = info._extractedVia || 'yt-dlp';
        console.log(`[stream ${videoId}] using DASH (${videoCount} video + ${audioCount} audio), duration=${info.duration}s via ${via}`);
        mpdCache.set(videoId, { data: mpd, meta: { playback: 'dash', via }, expires: Date.now() + CACHE_TTL });
        return mpd;
      }
    }

    // HLS fallback
    const hlsFmt = selectBestHlsFormat(info.formats || [], info.language);

    if (hlsFmt) {
      const via = info._extractedVia || 'yt-dlp';
      console.log(`[stream ${videoId}] using HLS (${hlsFmt.height || '?'}p), duration=${info.duration}s via ${via}`);
      hlsCache.set(videoId, { url: hlsFmt.manifest_url || hlsFmt.url, headers: sanitizeHeaders(hlsFmt.http_headers), expires: Date.now() + CACHE_TTL });
      const hlsResult = { hls: `/api/stream/${videoId}/hls.m3u8`, via };
      mpdCache.set(videoId, { data: hlsResult, meta: { playback: 'hls', via }, expires: Date.now() + CACHE_TTL });
      return hlsResult;
    }

    // Progressive fallback
    const muxed = allFmts
      .filter(f => f.vcodec && f.vcodec !== 'none' && f.acodec && f.acodec !== 'none')
      .sort((a, b) => (b.height || 0) - (a.height || 0))[0];
    if (muxed) {
      const via = info._extractedVia || 'yt-dlp';
      urlLookup.set(`${videoId}:${muxed.format_id}`, { url: muxed.url, headers: sanitizeHeaders(muxed.http_headers), expires: Date.now() + CACHE_TTL });
      const result = { progressive: `/api/stream/${videoId}/progressive`, via };
      mpdCache.set(videoId, { data: result, meta: { playback: 'progressive', via }, expires: Date.now() + CACHE_TTL });
      console.log(`[stream ${videoId}] using progressive (${muxed.height || '?'}p), duration=${info.duration}s via ${via}`);
      return result;
    }

    return null;
    } finally {
      notifyExtractionDone(videoId);
    }
  });
}

export {
  buildMPD,
};
