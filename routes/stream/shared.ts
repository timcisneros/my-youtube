import fs from 'fs';
import path from 'path';
import { Agent as UndiciAgent, setGlobalDispatcher } from 'undici';
import LRUMap from '../../lib/lru-map.js';
import { SharedLRUMap, hasRedis, getRedisClient } from '../../lib/cache.js';

// Persistent connection pool for YouTube CDN — reuses TCP+TLS across segment requests
setGlobalDispatcher(new UndiciAgent({
  keepAliveTimeout: 60_000,
  keepAliveMaxTimeout: 120_000,
  connections: 128,
  pipelining: 1
}));

// Persistent download directory
const DOWNLOADS_DIR = path.join(import.meta.dirname, '..', '..', 'data', 'downloads');
fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });

// yt-dlp concurrency semaphore — caps parallel yt-dlp processes across all videos
// When Redis is available, uses distributed INCR/DECR for cross-worker coordination
const MAX_CONCURRENT_YTDLP = parseInt(process.env.MAX_CONCURRENT_YTDLP, 10) || 4;
let activeYtdlp = 0;
const ytdlpQueue = [];

async function withYtdlpSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (hasRedis()) {
    return _withYtdlpSlotRedis(fn);
  }
  // In-process semaphore (single-process mode)
  if (activeYtdlp >= MAX_CONCURRENT_YTDLP) {
    await new Promise(resolve => ytdlpQueue.push(resolve));
  }
  activeYtdlp++;
  try {
    return await fn();
  } finally {
    activeYtdlp--;
    if (ytdlpQueue.length) ytdlpQueue.shift()();
  }
}

async function _withYtdlpSlotRedis(fn) {
  const redis = getRedisClient();
  const key = 'ytdlp:semaphore';
  // Poll until a slot opens
  while (true) {
    const count = await redis.incr(key);
    // Set safety TTL on first use
    if (count === 1) await redis.expire(key, 60);
    if (count <= MAX_CONCURRENT_YTDLP) break;
    await redis.decr(key);
    await new Promise(r => setTimeout(r, 200 + Math.random() * 300));
  }
  try {
    return await fn();
  } finally {
    await redis.decr(key).catch(() => {});
  }
}

// Privacy-safe headers for outbound proxy requests — no Referer, no Cookie, minimal UA
const PROXY_HEADERS = { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': '*', Referer: '', Cookie: '' };

// Fetch with connection timeout (doesn't kill active streams, just prevents hanging on connect)
function fetchWithConnTimeout(url, opts, ms?) {
  ms = ms || 15000;
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  const merged = { ...opts, signal: c.signal };
  return fetch(url, merged).then(resp => { clearTimeout(t); return resp; }, err => { clearTimeout(t); throw err; });
}

// Strip yt-dlp http_headers down to privacy-safe defaults.
// yt-dlp returns headers like Accept-Language (leaks locale), Sec-Fetch-Mode (fingerprints
// extraction), and User-Agent. CDN URLs are pre-signed so no auth headers are needed.
function sanitizeHeaders(_headers?) {
  return { ...PROXY_HEADERS };
}

// Errors expected when the client disconnects mid-stream (e.g. page refresh)
function isClientGone(err) {
  return err.code === 'ERR_STREAM_PREMATURE_CLOSE'
    || err.code === 'ERR_STREAM_DESTROYED'
    || err.code === 'ECONNRESET'
    || err.code === 'ERR_STREAM_WRITE_AFTER_END'
    || (err.message && err.message.includes('closed or destroyed'));
}

// Cache yt-dlp output per videoId (TTL 4 hours)
const formatCache = new SharedLRUMap(200, 'fmt');
// Cache generated MPD per videoId
const mpdCache = new SharedLRUMap(500, 'mpd');
// Fast lookup: "videoId:itag" -> direct YouTube CDN URL
const urlLookup = new SharedLRUMap(2000, 'url');
// Cache MP4 probe results to avoid redundant Range requests for same format
const mp4ProbeCache = new LRUMap(500);
// HLS manifest URL cache
const hlsCache = new SharedLRUMap(300, 'hls');
// In-memory VTT cache: "videoId:lang" -> { vtt: string, expires: number }
const vttCache = new SharedLRUMap(100, 'vtt');
// Storyboard sheet cache: videoId -> array of YouTube URLs
const storyboardUrlCache = new LRUMap(500);
// Live storyboard spec cache: videoId -> { urlTemplate, thumbW, thumbH, cols, rows, createdAt }
const liveStoryboardCache = new LRUMap(100);
// Extraction status visible to the client via /status endpoint
const extractionStatus = new LRUMap(100);

// Deduplicates concurrent async calls for the same key.
// While a call for key K is in-flight, subsequent calls return the same promise.
function dedup(map, key, fn) {
  if (map.has(key)) return map.get(key);
  const promise = fn();
  map.set(key, promise);
  promise.finally(() => map.delete(key));
  return promise;
}
const extractionInflight = new Map();

const CACHE_TTL = 4 * 60 * 60 * 1000;
const PROACTIVE_REFRESH_AGE = 3 * 60 * 60 * 1000; // refresh in background when cache older than 3h
const VTT_CACHE_TTL = 4 * 60 * 60 * 1000;
const MAX_BG_DOWNLOADS = 4;
const BG_MAX_AGE = 60 * 60 * 1000; // 1 hour

// Select the best HLS variant: prefer original-language, then highest resolution
function selectBestHlsFormat(formats, language) {
  const candidates = formats
    .filter(f => f.protocol && f.protocol.startsWith('m3u8') && f.url && f.vcodec && f.vcodec !== 'none')
    .sort((a, b) => (b.height || 0) - (a.height || 0));
  const origLang = language || '';
  const isOrig = f => (f.format_note && /original/i.test(f.format_note))
    || (origLang && f.language && f.language.split('-')[0] === origLang.split('-')[0]);
  return candidates.find(f => isOrig(f)) || candidates[0] || null;
}

export {
  DOWNLOADS_DIR,
  withYtdlpSlot,
  PROXY_HEADERS,
  fetchWithConnTimeout,
  sanitizeHeaders,
  isClientGone,
  formatCache,
  mpdCache,
  urlLookup,
  mp4ProbeCache,
  hlsCache,
  vttCache,
  storyboardUrlCache,
  liveStoryboardCache,
  extractionStatus,
  dedup,
  extractionInflight,
  CACHE_TTL,
  PROACTIVE_REFRESH_AGE,
  VTT_CACHE_TTL,
  MAX_BG_DOWNLOADS,
  BG_MAX_AGE,
  selectBestHlsFormat,
};
