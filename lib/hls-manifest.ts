type HlsReloadQuery = Record<string, unknown>;

const PLAYLIST_URI_TAG = /^#EXT-X-(?:MEDIA|I-FRAME-STREAM-INF|IMAGE-STREAM-INF|RENDITION-REPORT)\b/i;

function proxyHlsUrl(value: string, videoId: string, baseUrl: string, token: string, playlist: boolean) {
  let absolute: URL;
  try {
    absolute = new URL(value, baseUrl);
  } catch {
    return value;
  }
  if (absolute.protocol !== 'https:' && absolute.protocol !== 'http:') return value;
  const params = new URLSearchParams();
  if (token) params.set('token', token);
  if (playlist) params.set('kind', 'playlist');
  params.set('u', absolute.href);
  return `/api/stream/${videoId}/hls-proxy?${params.toString()}`;
}

/**
 * Rewrites a YouTube HLS manifest without caching by byte length. HLS playlists
 * are intentionally marked so the service worker can keep them out of the
 * cache-first media path while still caching immutable segments and keys.
 */
function rewriteHlsManifest(body: string, videoId: string, baseUrl: string, token = '') {
  const lines = body.split('\n');
  const variants: Array<{ infoLine: string; urlLine: string; height: number; bandwidth: number }> = [];
  const otherLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('#EXT-X-STREAM-INF')) {
      if (/EgtkdWJiZWQtYXV0bw/.test(trimmed)) {
        i++;
        continue;
      }
      const urlLine = i + 1 < lines.length ? lines[i + 1] : '';
      i++;
      const resMatch = trimmed.match(/RESOLUTION=(\d+)x(\d+)/);
      const bwMatch = trimmed.match(/BANDWIDTH=(\d+)/);
      variants.push({
        infoLine: lines[i - 1],
        urlLine,
        height: resMatch ? parseInt(resMatch[2], 10) : 0,
        bandwidth: bwMatch ? parseInt(bwMatch[1], 10) : 0,
      });
    } else {
      otherLines.push(lines[i]);
    }
  }

  const bestByHeight = new Map<number, typeof variants[number]>();
  for (const variant of variants) {
    const key = variant.height || variant.bandwidth;
    const current = bestByHeight.get(key);
    if (!current || variant.bandwidth > current.bandwidth) bestByHeight.set(key, variant);
  }

  const filtered: string[] = [];
  for (const line of otherLines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      const playlistUri = PLAYLIST_URI_TAG.test(trimmed);
      filtered.push(line.replace(/URI="([^"]+)"/g, (_match, uri: string) => (
        `URI="${proxyHlsUrl(uri, videoId, baseUrl, token, playlistUri)}"`
      )));
    } else {
      // Bare URLs outside EXT-X-STREAM-INF pairs are media objects.
      filtered.push(proxyHlsUrl(trimmed, videoId, baseUrl, token, false));
    }
  }

  const variantLines: string[] = [];
  for (const variant of bestByHeight.values()) {
    variantLines.push(variant.infoLine);
    const url = variant.urlLine.trim();
    if (url) variantLines.push(proxyHlsUrl(url, videoId, baseUrl, token, true));
  }

  let insertAt = filtered.length;
  for (let i = 0; i < filtered.length; i++) {
    const value = filtered[i].trim();
    if (value && !value.startsWith('#')) {
      insertAt = i;
      break;
    }
  }
  filtered.splice(insertAt, 0, ...variantLines);
  return filtered.join('\n');
}

/** Forward only standardized LL-HLS delivery directives to the upstream URL. */
function appendHlsReloadParams(url: string, query: HlsReloadQuery) {
  const upstream = new URL(url);
  const msn = typeof query._HLS_msn === 'string' ? query._HLS_msn : '';
  const part = typeof query._HLS_part === 'string' ? query._HLS_part : '';
  const skip = typeof query._HLS_skip === 'string' ? query._HLS_skip : '';
  if (/^\d+$/.test(msn)) upstream.searchParams.set('_HLS_msn', msn);
  if (/^\d+$/.test(part)) upstream.searchParams.set('_HLS_part', part);
  if (/^(?:YES|v2)$/i.test(skip)) upstream.searchParams.set('_HLS_skip', skip);
  return upstream.href;
}

export { appendHlsReloadParams, rewriteHlsManifest };
