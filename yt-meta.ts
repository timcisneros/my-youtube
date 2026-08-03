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
import { YTDLP_BIN, ytdlpArgs } from './ytdlp.js';
import { createCircuitBreaker, getClientVersion, USER_AGENT } from './extractors.js';
import { withYtSlot } from './youtube/shared.js';
import { withYtdlpSlot } from './routes/stream/shared.js';
import { readBodyBounded, readJsonBounded } from './lib/bounded-fetch.js';
import { parseEmbeddedJsonBuffer } from './lib/upstream-parser.js';

const breakers = {
  api:    createCircuitBreaker('player-api'),
  scrape: createCircuitBreaker('page-scrape'),
  ytdlp:  createCircuitBreaker('yt-dlp', { threshold: 3, cooldownMs: 10 * 60 * 1000 }),
};

// ---------------------------------------------------------------------------
// Strategy 1: Internal player API
// ---------------------------------------------------------------------------
function deadlineSignal(timeoutMs, parentSignal) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return parentSignal ? AbortSignal.any([parentSignal, timeoutSignal]) : timeoutSignal;
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError');
}

async function fetchViaAPI(videoId, timeoutMs, signal) {
  return withYtSlot(async () => {
    throwIfAborted(signal);
    const resp = await fetch('https://www.youtube.com/youtubei/v1/player', {
      method: 'POST',
      signal: deadlineSignal(timeoutMs, signal),
      headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
      body: JSON.stringify({
        videoId,
        context: { client: { clientName: 'WEB', clientVersion: getClientVersion(), hl: 'en' } },
      }),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await readJsonBounded(resp, 1024 * 1024, 'video-metadata-response-too-large');
    if (!data.videoDetails) throw new Error('No videoDetails in response');
    return data.videoDetails;
  }, 'background', signal);
}

// ---------------------------------------------------------------------------
// Strategy 2: Watch page scrape
// ---------------------------------------------------------------------------
async function fetchViaScrape(videoId, timeoutMs, signal) {
  return withYtSlot(async () => {
    throwIfAborted(signal);
    const resp = await fetch(`https://www.youtube.com/watch?v=${videoId}&hl=en`, {
      signal: deadlineSignal(timeoutMs, signal),
      headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'en-US,en;q=0.9', 'Accept': 'text/html' },
      redirect: 'follow',
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const html = await readBodyBounded(resp, 4 * 1024 * 1024, 'watch-page-too-large');
    const player = await parseEmbeddedJsonBuffer(html, 'ytInitialPlayerResponse');
    if (!player.videoDetails) throw new Error('No videoDetails in scraped response');
    return player.videoDetails;
  }, 'background', signal);
}

// ---------------------------------------------------------------------------
// Strategy 3: yt-dlp (single video, subprocess)
// ---------------------------------------------------------------------------
async function fetchViaYtdlp(videoId, timeoutMs, signal) {
  throwIfAborted(signal);
  const { stdout } = await withYtdlpSlot(() => execFileAsync(YTDLP_BIN, [
      ...ytdlpArgs(),
      '--print', '%(duration)s %(live_status)s',
      '--', videoId,
    ], { timeout: timeoutMs, signal }), { priority: 'background', signal });
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
async function fetchVideoMeta(videoId, {
  timeoutMs = 6000,
  signal,
  mode = 'full',
}: {
  timeoutMs?: number;
  signal?: AbortSignal;
  mode?: 'full' | 'lightweight';
} = {}) {
  const strategies = [
    { name: 'api',    fn: fetchViaAPI,    breaker: breakers.api,    timeout: timeoutMs },
    { name: 'scrape', fn: fetchViaScrape, breaker: breakers.scrape, timeout: timeoutMs + 2000 },
    { name: 'ytdlp',  fn: fetchViaYtdlp,  breaker: breakers.ytdlp,  timeout: 15000 },
  ].slice(0, mode === 'lightweight' ? 1 : 3);

  for (const s of strategies) {
    throwIfAborted(signal);
    if (s.breaker.isOpen) continue;
    try {
      const details = await s.fn(videoId, s.timeout, signal);
      s.breaker.recordSuccess();
      return parseDetails(videoId, details);
    } catch {
      throwIfAborted(signal);
      s.breaker.recordFailure();
    }
  }
  return null;
}

export { fetchVideoMeta };
