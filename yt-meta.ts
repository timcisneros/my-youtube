// Resilient YouTube metadata fetcher with a 3-strategy fallback chain:
//   1. Internal player API  (~14KB, ~200ms)  — fast, lightweight
//   2. Watch page scrape    (~70KB parsed)    — heavier but reliable
//   3. yt-dlp subprocess    (slowest)         — last resort
//
// Each strategy has a circuit breaker: after consecutive failures it's
// temporarily bypassed so the next strategy handles traffic. When the
// cooldown expires the strategy is retried automatically.
//
// Fully self-hosted. No third-party APIs. No API keys.

import { execFile } from 'child_process';
import { promisify } from 'util';
const execFileAsync = promisify(execFile);
import { ytdlpArgs } from './ytdlp.js';
import { createCircuitBreaker, refreshClientVersion, getClientVersion, USER_AGENT } from './extractors.js';

const breakers = {
  api:    createCircuitBreaker('player-api'),
  scrape: createCircuitBreaker('page-scrape'),
  ytdlp:  createCircuitBreaker('yt-dlp', { threshold: 3, cooldownMs: 10 * 60 * 1000 }),
};

// ---------------------------------------------------------------------------
// Strategy 1: Internal player API
// ---------------------------------------------------------------------------
async function fetchViaAPI(videoId, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const resp = await fetch('https://www.youtube.com/youtubei/v1/player', {
    method: 'POST',
    signal: controller.signal,
    headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
    body: JSON.stringify({
      videoId,
      context: { client: { clientName: 'WEB', clientVersion: getClientVersion(), hl: 'en' } },
    }),
  });
  if (!resp.ok) { clearTimeout(timer); throw new Error(`HTTP ${resp.status}`); }
  const data = await resp.json();
  clearTimeout(timer);
  if (!data.videoDetails) throw new Error('No videoDetails in response');
  return data.videoDetails;
}

// ---------------------------------------------------------------------------
// Strategy 2: Watch page scrape
// ---------------------------------------------------------------------------
async function fetchViaScrape(videoId, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const resp = await fetch(`https://www.youtube.com/watch?v=${videoId}&hl=en`, {
    signal: controller.signal,
    headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'en-US,en;q=0.9', 'Accept': 'text/html' },
    redirect: 'follow',
  });
  if (!resp.ok) { clearTimeout(timer); throw new Error(`HTTP ${resp.status}`); }
  const html = await resp.text();
  clearTimeout(timer);

  const marker = 'var ytInitialPlayerResponse = ';
  let idx = html.indexOf(marker);
  if (idx === -1) throw new Error('No ytInitialPlayerResponse in page');
  idx += marker.length;

  let depth = 0;
  for (let i = idx; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') {
      depth--;
      if (depth === 0) {
        const player = JSON.parse(html.slice(idx, i + 1));
        if (!player.videoDetails) throw new Error('No videoDetails in scraped response');
        return player.videoDetails;
      }
    }
  }
  throw new Error('Failed to parse ytInitialPlayerResponse');
}

// ---------------------------------------------------------------------------
// Strategy 3: yt-dlp (single video, subprocess)
// ---------------------------------------------------------------------------
async function fetchViaYtdlp(videoId, timeoutMs) {
  const { stdout } = await execFileAsync('yt-dlp', [
    ...ytdlpArgs(),
    '--print', '%(duration)s %(live_status)s',
    '--', videoId,
  ], { timeout: timeoutMs });
  const parts = stdout.trim().split(/\s+/);
  const duration = parseFloat(parts[0]);
  const liveStatus = parts[1] || 'not_live';
  return {
    lengthSeconds: isNaN(duration) ? '0' : String(Math.floor(duration)),
    isLive: liveStatus === 'is_live' || undefined,
    isUpcoming: liveStatus === 'is_upcoming' || undefined,
    isLiveContent: liveStatus === 'was_live' || liveStatus === 'post_live' || undefined,
  };
}

// ---------------------------------------------------------------------------
// Parse videoDetails into our standard format
// ---------------------------------------------------------------------------
function parseDetails(videoId, details) {
  const duration = parseInt(details.lengthSeconds, 10) || 0;
  let liveStatus = 'not_live';
  if (details.isLive) liveStatus = 'is_live';
  else if (details.isUpcoming) liveStatus = 'is_upcoming';
  else if (details.isLiveContent) liveStatus = 'was_live';
  return { id: videoId, duration, liveStatus };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// Fetch metadata for a single video. Tries strategies in order,
// skipping any with an open circuit breaker.
async function fetchVideoMeta(videoId, { timeoutMs = 6000 } = {}) {
  const strategies = [
    { name: 'api',    fn: fetchViaAPI,    breaker: breakers.api,    timeout: timeoutMs },
    { name: 'scrape', fn: fetchViaScrape, breaker: breakers.scrape, timeout: timeoutMs + 2000 },
    { name: 'ytdlp',  fn: fetchViaYtdlp,  breaker: breakers.ytdlp,  timeout: 15000 },
  ];

  for (const s of strategies) {
    if (s.breaker.isOpen) continue;
    try {
      const details = await s.fn(videoId, s.timeout);
      s.breaker.recordSuccess();
      return parseDetails(videoId, details);
    } catch {
      s.breaker.recordFailure();
    }
  }
  return null;
}

// Fetch metadata for multiple videos in parallel.
// Returns a Map<videoId, { duration, liveStatus }>.
async function fetchVideoMetaBatch(videoIds, { concurrency = 6, timeoutMs = 6000 } = {}) {
  // Refresh client version periodically (non-blocking)
  refreshClientVersion().catch(() => {});

  const results = new Map();
  for (let i = 0; i < videoIds.length; i += concurrency) {
    const chunk = videoIds.slice(i, i + concurrency);
    const settled = await Promise.allSettled(
      chunk.map(id => fetchVideoMeta(id, { timeoutMs }))
    );
    for (const result of settled) {
      if (result.status === 'fulfilled' && result.value) {
        const v = result.value;
        results.set(v.id, { duration: v.duration, liveStatus: v.liveStatus });
      }
    }
  }
  return results;
}

export { fetchVideoMetaBatch };
