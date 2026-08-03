import 'dotenv/config';

import express from 'express';
import compression from 'compression';
import session from 'express-session';
import path from 'path';
import fs from 'fs';
import { projectPath } from './lib/project-paths.js';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import {
  initRedis,
  getRedisClient,
  hasRedis,
  getCacheRedisClient,
  hasCacheRedis,
  collectRedisMetrics,
} from './lib/cache.js';
import LRUMap from './lib/lru-map.js';
import { collectPerformanceMetrics, incrementMetric, observeMetric, performanceMetricsMiddleware, setMetricGauge } from './lib/performance-metrics.js';
import { isMetricsRequestAuthorized } from './lib/metrics-access.js';
import { trustedProxyHops } from './lib/client-ip.js';
import { insertPriorityItem } from './lib/ordered-priority-queue.js';
import { startDatabaseMaintenance } from './lib/database-maintenance.js';
import {
  scheduleStaleDownloadPartCleanup,
  scheduleDownloadStorageReconciliation,
} from './lib/download-storage.js';
import { runtimeAssetUrl } from './lib/runtime-assets.js';

const app = express();
const proxyHops = trustedProxyHops();
if (proxyHops > 0) app.set('trust proxy', proxyHops);
const fixtureMode = process.env.PLAYER_FIXTURES === '1';
app.use(performanceMetricsMiddleware);

// --- Rate limiting (token bucket per IP) ---
const rateBuckets = new LRUMap(20_000);
const RATE_BURST = 60;
const RATE_PER_SEC = 8;
const EXTRACT_BURST = 5;
const EXTRACT_WINDOW = 60 * 1000; // 1 minute
const extractBuckets = new LRUMap(10_000);

// Stream responses carrying media bytes bypass the ordinary request bucket;
// manifests, status channels, metadata, and other control-plane routes do not.
// This keeps segment throughput independent from API abuse protection without
// leaving every /api/stream endpoint unmetered.
function isStreamDataPlanePath(requestPath: string) {
  return /^\/api\/stream\/[A-Za-z0-9_-]{11}\/(?:fmt\/|proxy\/|progressive(?:\.mp4)?$|hls-proxy(?:$|\/)|hls-ts(?:-raw)?\/|hls-key\/|hls-aes\/|tmpl\/|poster$|thumb$|storyboard\/)/.test(requestPath);
}

function getRateBucket(ip) {
  let b = rateBuckets.get(ip);
  if (!b) { b = { tokens: RATE_BURST, last: Date.now() }; rateBuckets.set(ip, b); }
  const now = Date.now();
  b.tokens = Math.min(RATE_BURST, b.tokens + ((now - b.last) / 1000) * RATE_PER_SEC);
  b.last = now;
  return b;
}

function getExtractBucket(ip) {
  let b = extractBuckets.get(ip);
  const now = Date.now();
  if (!b || now - b.start > EXTRACT_WINDOW) { b = { count: 0, start: now }; extractBuckets.set(ip, b); }
  return b;
}

// Sweep stale buckets every 5 minutes
setInterval(() => {
  const cutoff = Date.now() - 5 * 60 * 1000;
  for (const [ip, b] of rateBuckets) { if (b.last < cutoff) rateBuckets.delete(ip); }
  for (const [ip, b] of extractBuckets) { if (b.start < cutoff) extractBuckets.delete(ip); }
}, 5 * 60 * 1000);

app.use((req, res, next) => {
  // Skip static assets and high-volume media bodies. Stream control-plane
  // requests continue through the ordinary bounded token bucket.
  if (req.path.startsWith('/public/') || req.path.startsWith('/vendor/')) return next();
  if (isStreamDataPlanePath(req.path)) return next();
  if (req.path === '/health' || req.path.startsWith('/health/')) return next();
  if (fixtureMode && (
    req.path.startsWith('/__player-benchmark')
    || req.path === '/native-player-engine.js'
    || req.path === '/native-player-engine.min.js'
  )) return next();
  const ip = req.ip;
  const bucket = getRateBucket(ip);
  if (bucket.tokens < 1) {
    res.set('Retry-After', '1');
    return res.status(429).end('Too Many Requests');
  }
  bucket.tokens--;
  next();
});

// Extraction-specific rate limit — applied within stream routes via middleware export
// Tracks videoIds with in-flight extractions to avoid double-counting when
// prefetch + dash.mpd fire for the same video
const extractionInProgress = new LRUMap<string, true>(10_000);
app.extractionRateCheck = function(ip, videoId) {
  if (videoId && extractionInProgress.has(videoId)) return true; // already extracting, don't count
  const b = getExtractBucket(ip);
  if (b.count >= EXTRACT_BURST) return false;
  b.count++;
  if (videoId) {
    extractionInProgress.set(videoId, true);
    setTimeout(() => extractionInProgress.delete(videoId), 120000);
  }
  return true;
};

// Request logging (structured in production)
import logger from './lib/logger.js';
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    // Skip noisy health checks and static assets in logs
    if (req.path === '/favicon.ico' || req.path === '/health/live') return;
    if (req.path.startsWith('/public/') || req.path.startsWith('/vendor/') || req.path.startsWith('/fonts/')) return;
    const meta = {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration: duration + 'ms',
      ip: req.ip,
    };
    if (res.statusCode >= 500) {
      logger.error('request failed', meta);
    } else if (res.statusCode >= 400) {
      logger.warn('client error', meta);
    } else if (duration > 5000) {
      logger.warn('slow request', meta);
    }
    // Don't log normal 200s in production (too noisy) — only in dev
    else if (process.env.NODE_ENV !== 'production') {
      logger.debug('request', meta);
    }
  });
  next();
});

// Privacy & security headers — block all external resource loading
app.use((_req, res, next) => {
  res.set({
    'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; font-src 'self'; frame-src 'none'; object-src 'none'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-DNS-Prefetch-Control': 'off',
    'X-Frame-Options': 'DENY'
  });
  next();
});

app.set('view engine', 'ejs');
app.set('views', projectPath('views'));
app.locals.runtimeAssetUrl = runtimeAssetUrl;

// Avoid 404 noise from browser favicon requests
app.get('/favicon.ico', (_req, res) => res.status(204).end());
app.get('/metrics', async (req, res) => {
  if (!isMetricsRequestAuthorized(req)) return res.status(404).end();
  res.set('Cache-Control', 'no-store');
  await collectRedisMetrics();
  res.type('text/plain; version=0.0.4; charset=utf-8').send(await collectPerformanceMetrics());
});

// Stream routes mounted early — skip compression, session, JSON parsing for max throughput
if (fixtureMode) {
  app.use('/api/stream', await createFixtureStreamRouter());
} else {
  const { default: streamRouter } = await import('./routes/stream/index.js');
  app.use('/api/stream', streamRouter);
}

const publicDirectory = projectPath('public');
const precompressedPublicAssets = new Set([
  'app.js',
  'idb-helpers.js',
  'native-player-engine.js',
  'native-player-engine.min.js',
  'player-telemetry.js',
  'player-telemetry.min.js',
  'player-page.js',
  'player-page.min.js',
  'style.css',
]);
const availablePrecompressedAssets = new Map<string, Map<string, string>>();
for (const runtimeAsset of precompressedPublicAssets) {
  const variants = new Map<string, string>();
  const sourcePath = path.join(publicDirectory, runtimeAsset);
  const sourceContents = fs.existsSync(sourcePath) ? fs.readFileSync(sourcePath) : null;
  const brotliPath = path.join(publicDirectory, runtimeAsset + '.br');
  const gzipPath = path.join(publicDirectory, runtimeAsset + '.gz');
  const registerVariant = (encoding: 'br' | 'gzip', variantPath: string) => {
    if (!sourceContents || !fs.existsSync(variantPath)) return;
    try {
      const compressed = fs.readFileSync(variantPath);
      const decompressed = encoding === 'br' ? brotliDecompressSync(compressed) : gunzipSync(compressed);
      if (decompressed.equals(sourceContents)) {
        variants.set(encoding, variantPath);
      } else {
        console.warn(`[assets] ignoring stale ${path.basename(variantPath)}; rebuild runtime assets`);
      }
    } catch (error) {
      console.warn(`[assets] ignoring unreadable ${path.basename(variantPath)}:`, (error as Error).message);
    }
  };
  registerVariant('br', brotliPath);
  registerVariant('gzip', gzipPath);
  if (variants.size > 0) availablePrecompressedAssets.set(runtimeAsset, variants);
}

function setPublicAssetCacheHeaders(res: express.Response, runtimeAsset: string, requestUrl: string) {
  if (/[?&]v=[A-Za-z0-9_-]+(?:&|$)/.test(requestUrl)) {
    // Versioned runtime URLs are deployment-atomic and safe to reuse across
    // full watch navigations without an extra validation round trip.
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  } else if (runtimeAsset === 'style.css') {
    res.setHeader('Cache-Control', 'public, max-age=86400');
  } else {
    res.setHeader('Cache-Control', 'no-cache');
  }
}

// Serve build-time Brotli/gzip files without spending event-loop time
// recompressing large player bundles on each worker.
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  const runtimeAsset = path.posix.basename(req.path);
  if (req.path !== `/${runtimeAsset}` || !precompressedPublicAssets.has(runtimeAsset)) return next();
  const acceptedEncoding = String(req.headers['accept-encoding'] || '');
  const variants = availablePrecompressedAssets.get(runtimeAsset);
  const encoding = acceptedEncoding.includes('br') && variants?.has('br')
    ? 'br'
    : acceptedEncoding.includes('gzip') && variants?.has('gzip') ? 'gzip' : '';
  if (!encoding) return next();
  const selectedPath = variants!.get(encoding)!;
  res.type(runtimeAsset);
  res.setHeader('Content-Encoding', encoding);
  res.vary('Accept-Encoding');
  setPublicAssetCacheHeaders(res, runtimeAsset, req.originalUrl);
  return res.sendFile(selectedPath, (err) => {
    if (err && !res.headersSent) next(err);
  });
});

app.use(compression({
  level: 6,
  threshold: 1024,
  filter: (req, res) => {
    if (req.path.includes('/api/stream/')) return false;
    return compression.filter(req, res);
  }
}));
app.use(express.json());

app.post('/api/player-events', (req, res) => {
  const rawEvents = Array.isArray(req.body?.events) ? req.body.events : [];
  const events = rawEvents.slice(0, 20).map((event) => sanitizePlayerEvent(event)).filter(Boolean);
  if (!events.length) return res.status(400).json({ error: 'events required' });
  const diagnosticEvents = events.filter((event) => PLAYER_DIAGNOSTIC_EVENT_TYPES.has(event!.type));
  for (const event of events) {
    const provider = PLAYER_METRIC_PROVIDERS.has(event!.provider) ? event!.provider : 'other';
    incrementMetric('player_events_total', { type: event!.type, provider });
    if (event!.type === 'first-frame' && event!.videoStartupMs > 0) {
      observeMetric('player_video_startup_ms', event!.videoStartupMs, { provider });
    }
  }
  incrementMetric('player_telemetry_batches_total', {
    diagnostic: diagnosticEvents.length ? 'true' : 'false',
  });
  if (diagnosticEvents.length || Math.random() < PLAYER_EVENT_LOG_SAMPLE_RATE) {
    logger.info('player event batch', {
      count: events.length,
      eventTypes: events.map((event) => event!.type),
      diagnostics: diagnosticEvents.slice(0, 3),
      ip: req.ip,
    });
  }
  res.json({ ok: true });
});

app.use(express.static(publicDirectory, {
  maxAge: '1d',
  setHeaders(res, filePath) {
    const runtimeAsset = path.basename(filePath);
    if (runtimeAsset === 'sw.js'
      || runtimeAsset === 'app.js'
      || runtimeAsset === 'native-player-engine.js'
      || runtimeAsset === 'native-player-engine.min.js'
      || runtimeAsset === 'player-telemetry.js'
      || runtimeAsset === 'player-telemetry.min.js'
      || runtimeAsset === 'player-page.js'
      || runtimeAsset === 'player-page.min.js'
      || runtimeAsset === 'idb-helpers.js'
      || runtimeAsset === 'style.css') {
      setPublicAssetCacheHeaders(res, runtimeAsset, res.req?.originalUrl || '');
    }
  },
}));
const dataDir = projectPath('data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);

// Session store — Redis when REDIS_URL is set, SQLite otherwise. Player fixture
// mode uses the default in-memory store so media tests do not require native DB bindings.
let sessionStore;
const sharedRedisReady = !fixtureMode && (process.env.REDIS_URL || process.env.CACHE_REDIS_URL)
  ? await initRedis()
  : false;
if (sharedRedisReady && hasRedis()) {
  try {
    const { RedisStore } = await import('connect-redis');
    const redisClient = getRedisClient();
    sessionStore = new RedisStore({ client: redisClient, prefix: 'sess:' });
    setMetricGauge('session_store_ready', 1, { backend: 'redis' });
    console.log('[session] Using Redis store');
  } catch (err: unknown) {
    incrementMetric('session_store_fallbacks_total', { from: 'redis', to: 'sqlite' });
    console.warn('[session] Redis store failed, falling back to SQLite:', (err as Error).message);
  }
}
if (!fixtureMode && !sessionStore) {
  const clusteredWorkers = Math.max(1, Number(process.env.CLUSTER_WORKER_COUNT) || 1);
  if (clusteredWorkers > 1 && process.env.ALLOW_CLUSTERED_SQLITE_SESSIONS !== '1') {
    throw new Error(
      'Redis session storage is required when CLUSTER_WORKER_COUNT > 1. ' +
      'Restore REDIS_URL or explicitly set ALLOW_CLUSTERED_SQLITE_SESSIONS=1 for a non-production override.',
    );
  }
  const [{ default: createSqliteStore }, { default: Database }] = await Promise.all([
    import('better-sqlite3-session-store'),
    import('better-sqlite3'),
  ]);
  const BetterSqlite3Store = createSqliteStore(session);
  const sessionDb = new Database(path.join(dataDir, 'sessions.db'));
  sessionStore = new BetterSqlite3Store({ client: sessionDb, expired: { clear: true, intervalMs: 60 * 60 * 1000 } });
  setMetricGauge('session_store_ready', 1, { backend: 'sqlite' });
}

app.use(session({
  ...(sessionStore ? { store: sessionStore } : {}),
  secret: process.env.SESSION_SECRET || 'dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000, httpOnly: true, sameSite: 'lax', secure: false }
}));


// Streaming HTML helpers — flush shell (head+nav) before data is ready
app.use((req, res, next) => {
  // Flush the common shell (doctype, head, nav, <main> open) immediately
  res.flushShell = function (opts = {}) {
    return new Promise<void>((resolve, reject) => {
      res.set('Content-Type', 'text/html; charset=utf-8');
      // Preserve early shell delivery through nginx; its default proxy
      // buffering would otherwise wait for most of the EJS response.
      res.set('X-Accel-Buffering', 'no');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Express render callback signature
      req.app.render('partials/shell-start', { ...res.locals, ...opts }, (err: any, html: string) => {
        if (err) return reject(err);
        res.write(html);
        // Force compression middleware to send this chunk now
        if (typeof res.flush === 'function') res.flush();
        resolve();
      });
    });
  };
  // Render a content-only template and end the response
  res.streamContent = function (template: string, data = {}) {
    return new Promise<void>((resolve, reject) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Express render callback signature
      req.app.render(template, { ...res.locals, ...data }, (err: any, html: string) => {
        if (err) return reject(err);
        res.end(html + '\n</body>\n</html>');
        resolve();
      });
    });
  };
  next();
});

// Offline fallback page — no auth needed (SW caches this for offline use)
app.get('/offline', (_req, res) => {
  void res.flushShell({ activeTab: null }).then(() => {
    res.end('<div class="offline-message"><h2>You are offline</h2><p>Connect to the internet to browse videos.</p><p><a href="/downloads">View your downloads</a></p></div></main><script src="/app.js"></script>\n</body>\n</html>');
  });
});

const db = fixtureMode ? null : (await import('./db.js')).default;
if (db?._ready !== undefined) await db._ready;
if (db) startDatabaseMaintenance(db);
if (!fixtureMode && (!process.env.CLUSTER_WORKER_COUNT || process.env.CLUSTER_WORKER_SLOT === '0')) {
  scheduleStaleDownloadPartCleanup();
  scheduleDownloadStorageReconciliation();
}

// Coalesce high-frequency progress updates by user/video. Reads consult the
// bounded visible-value cache, so callers retain read-after-write behavior
// while the database sees at most one write per coalescing window.
const WATCH_TIME_WRITE_DELAY_MS = Math.max(1_000, Number(process.env.WATCH_TIME_WRITE_DELAY_MS) || 5_000);
const WATCH_TIME_MAX_PENDING = Math.max(100, Number(process.env.WATCH_TIME_MAX_PENDING) || 10_000);
const WATCH_TIME_WRITE_CONCURRENCY = Math.max(
  1,
  Number(process.env.WATCH_TIME_WRITE_CONCURRENCY) || (process.env.DATABASE_URL ? 4 : 1),
);
const WATCH_TIME_VISIBLE_TTL_MS = Math.max(WATCH_TIME_WRITE_DELAY_MS * 2, 60_000);
type WatchTimeWaiter = { resolve: () => void; reject: (error: unknown) => void };
type PendingWatchTime = {
  key: string;
  userId: string;
  videoId: string;
  position: number;
  duration: number;
  timer: ReturnType<typeof setTimeout> | null;
  priority: number;
  order: number;
  ready: boolean;
  waiters: WatchTimeWaiter[];
};
const pendingWatchTimes = new Map<string, PendingWatchTime>();
const visibleWatchTimes = new LRUMap(WATCH_TIME_MAX_PENDING * 2);
const readyWatchTimeWrites: PendingWatchTime[] = [];
const activeWatchTimeKeys = new Set<string>();
const activeWatchTimeWrites = new Set<Promise<void>>();
const watchTimeIdleWaiters: Array<() => void> = [];
let watchTimeWriteOrder = 0;

class WatchTimeQueueFullError extends Error {
  constructor() {
    super('Watch-time write queue is full');
    this.name = 'WatchTimeQueueFullError';
  }
}

function watchTimeKey(userId: string, videoId: string) {
  return `${userId}\u0000${videoId}`;
}

function visibleWatchTime(userId: string, videoId: string) {
  const key = watchTimeKey(userId, videoId);
  const entry = visibleWatchTimes.get(key);
  if (!entry || entry.expires <= Date.now()) {
    if (entry) visibleWatchTimes.delete(key);
    return null;
  }
  return entry;
}

function updateWatchTimeWriteMetrics() {
  setMetricGauge('watch_time_writes_pending', pendingWatchTimes.size);
  setMetricGauge('watch_time_writes_ready', readyWatchTimeWrites.length);
  setMetricGauge('watch_time_writes_active', activeWatchTimeWrites.size);
  setMetricGauge('watch_time_write_concurrency_limit', WATCH_TIME_WRITE_CONCURRENCY);
}

function notifyWatchTimeIdle() {
  if (pendingWatchTimes.size > 0 || activeWatchTimeWrites.size > 0) return;
  for (const resolve of watchTimeIdleWaiters.splice(0)) resolve();
}

function takeReadyWatchTimeWrite() {
  for (let index = 0; index < readyWatchTimeWrites.length;) {
    const entry = readyWatchTimeWrites[index];
    if (pendingWatchTimes.get(entry.key) !== entry) {
      readyWatchTimeWrites.splice(index, 1);
      continue;
    }
    if (activeWatchTimeKeys.has(entry.key)) {
      index++;
      continue;
    }
    readyWatchTimeWrites.splice(index, 1);
    entry.ready = false;
    return entry;
  }
  return null;
}

function drainWatchTimeWrites() {
  while (activeWatchTimeWrites.size < WATCH_TIME_WRITE_CONCURRENCY) {
    const entry = takeReadyWatchTimeWrite();
    if (!entry) break;
    pendingWatchTimes.delete(entry.key);
    activeWatchTimeKeys.add(entry.key);
    const startedAt = performance.now();
    let trackedWrite: Promise<void>;
    trackedWrite = Promise.resolve()
      .then(() => db ? db.setWatchTime(entry.userId, entry.videoId, entry.position, entry.duration) : undefined)
      .then(
        () => {
          incrementMetric('watch_time_writes_total', { result: 'stored' });
          observeMetric('watch_time_write_duration_ms', performance.now() - startedAt, { result: 'stored' });
          for (const waiter of entry.waiters) waiter.resolve();
        },
        (error) => {
          incrementMetric('watch_time_writes_total', { result: 'error' });
          observeMetric('watch_time_write_duration_ms', performance.now() - startedAt, { result: 'error' });
          for (const waiter of entry.waiters) waiter.reject(error);
          logger.warn('watch time write failed', { error: (error as Error).message });
        },
      )
      .finally(() => {
        activeWatchTimeKeys.delete(entry.key);
        activeWatchTimeWrites.delete(trackedWrite);
        updateWatchTimeWriteMetrics();
        drainWatchTimeWrites();
        notifyWatchTimeIdle();
      });
    activeWatchTimeWrites.add(trackedWrite);
  }
  updateWatchTimeWriteMetrics();
}

function enqueueReadyWatchTimeWrite(entry: PendingWatchTime, refreshOrder = false) {
  if (pendingWatchTimes.get(entry.key) !== entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = null;
  if (entry.ready) {
    const index = readyWatchTimeWrites.indexOf(entry);
    if (index >= 0) readyWatchTimeWrites.splice(index, 1);
  }
  if (refreshOrder || !entry.ready) entry.order = watchTimeWriteOrder++;
  entry.ready = true;
  insertPriorityItem(readyWatchTimeWrites, entry);
  drainWatchTimeWrites();
}

function scheduleWatchTimeWrite(entry: PendingWatchTime) {
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => enqueueReadyWatchTimeWrite(entry), WATCH_TIME_WRITE_DELAY_MS);
  entry.timer.unref?.();
}

function evictOldestBackgroundWatchTimeWrite() {
  for (const [key, entry] of pendingWatchTimes) {
    if (entry.priority === 0 || entry.waiters.length > 0) continue;
    pendingWatchTimes.delete(key);
    if (entry.timer) clearTimeout(entry.timer);
    if (entry.ready) {
      const readyIndex = readyWatchTimeWrites.indexOf(entry);
      if (readyIndex >= 0) readyWatchTimeWrites.splice(readyIndex, 1);
    }
    incrementMetric('watch_time_updates_total', { result: 'dropped_capacity' });
    updateWatchTimeWriteMetrics();
    return true;
  }
  return false;
}

function queueWatchTimeWrite(userId: string, videoId: string, position: number, duration: number, immediate = false) {
  const key = watchTimeKey(userId, videoId);
  visibleWatchTimes.set(key, { last_position: position, duration, expires: Date.now() + WATCH_TIME_VISIBLE_TTL_MS });
  let entry = pendingWatchTimes.get(key);
  if (!entry && pendingWatchTimes.size >= WATCH_TIME_MAX_PENDING && !evictOldestBackgroundWatchTimeWrite()) {
    incrementMetric('watch_time_updates_total', { result: immediate ? 'rejected_capacity' : 'dropped_capacity' });
    return immediate ? Promise.reject(new WatchTimeQueueFullError()) : Promise.resolve();
  }

  if (entry) {
    entry.userId = userId;
    entry.videoId = videoId;
    entry.position = position;
    entry.duration = duration;
    pendingWatchTimes.delete(key);
    pendingWatchTimes.set(key, entry);
    incrementMetric('watch_time_updates_total', { result: 'coalesced' });
  } else {
    entry = {
      key,
      userId,
      videoId,
      position,
      duration,
      timer: null,
      priority: immediate ? 0 : 1,
      order: watchTimeWriteOrder++,
      ready: false,
      waiters: [],
    };
    pendingWatchTimes.set(key, entry);
    incrementMetric('watch_time_updates_total', { result: 'queued' });
  }

  let completion = Promise.resolve();
  if (immediate) {
    entry.priority = 0;
    completion = new Promise<void>((resolve, reject) => entry!.waiters.push({ resolve, reject }));
    enqueueReadyWatchTimeWrite(entry, true);
  } else if (entry.ready) {
    enqueueReadyWatchTimeWrite(entry, true);
  } else {
    scheduleWatchTimeWrite(entry);
    updateWatchTimeWriteMetrics();
  }
  return completion;
}

async function flushAllPendingWatchTimes() {
  for (const entry of [...pendingWatchTimes.values()]) {
    entry.priority = 0;
    enqueueReadyWatchTimeWrite(entry);
  }
  if (pendingWatchTimes.size === 0 && activeWatchTimeWrites.size === 0) return;
  await new Promise<void>(resolve => watchTimeIdleWaiters.push(resolve));
}

updateWatchTimeWriteMetrics();

if (fixtureMode) {
  app.get('/__player-benchmark/mux-player.js', (_req, res) => {
    res.set({
      'Cache-Control': 'no-store',
      'Content-Type': 'text/javascript; charset=utf-8',
    });
    res.sendFile(projectPath('node_modules/@mux/mux-player/dist/mux-player.js'));
  });
  app.get('/__player-benchmark', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.sendFile(projectPath('tests/fixtures/player-performance.html'));
  });
  app.get('/auth/login', (_req, res) => res.status(200).send('<!doctype html><title>Fixture Login</title><form method="post" action="/auth/free"></form>'));
  app.post('/auth/free', (req, res) => {
    req.session.userId = 'fixture-user';
    res.redirect('/');
  });
  app.get('/', (_req, res) => res.status(200).send('<!doctype html><title>Fixture Home</title>'));
  app.get('/watch', (_req, res) => {
    res.status(200).send(`<!doctype html>
<html>
<head><title>Fixture Watch</title></head>
<body>
<video id="player"></video>
<script src="/native-player-engine.min.js?v=21"></script>
<script src="/player-telemetry.min.js?v=21"></script>
<script>
// Static watch-shell contract exercised by the browser guard. Keep it parsed
// but do not execute it; the functional fixture player is initialized below.
if (false) {
var playerDrmServers = {};
player.configure({ drm: { servers: playerDrmServers } });
player.beginSeek();
player.commitSeek();
player.endSeek();
if (player.seekToLiveEdge) player.seekToLiveEdge();
player.getStats ? player.getStats() : null;
typeof stats.atLiveEdge === 'boolean';
stats.liveLatency;
function playerSeekTo(target, opts) {}
window._playerSeekTo = playerSeekTo;
navigator.mediaSession.setActionHandler('seekbackward', function () { playerSeekTo(Math.max(0, (engine.recovering ? engine.lastGoodTime : video.currentTime) - 5)); });
navigator.mediaSession.setActionHandler('seekforward', function () { playerSeekTo(Math.min(video.duration || Infinity, (engine.recovering ? engine.lastGoodTime : video.currentTime) + 5)); });
navigator.mediaSession.setActionHandler('seekto', function (d) { if (d.seekTime != null) playerSeekTo(d.seekTime); });
playerSeekTo(dur * pct);
playerSeekTo(chapters[idx].start_time);
playerSeekTo(parseFloat(link.dataset.time));
if (player.setPlaybackRate) player.setPlaybackRate(rate);
if (player.setPlaybackRate) player.setPlaybackRate(savedSpeed);
player.getPlaybackRate ? player.getPlaybackRate() : video.playbackRate;
localStorage.getItem('player-speed');
var previewSource = 'none';
window._seekPreviewSource = previewSource;
tooltip.dataset.previewSource = previewSource;
function requestIFramePreview(time) {
  return fetch('/api/stream/' + videoId + '/iframe').then(function () {
    return player.getIFramePreview(time).then(function (preview) {
      setPreviewSource(lastIframePreview ? 'iframe' : 'none');
      setPreviewSource('storyboard');
      tooltip.dataset.previewUrl = preview.url || '';
    });
  });
}
function runPlayerCleanupTasks() {}
window._cleanupPlayer = function () {};
if (window._detailsTimer) clearInterval(window._detailsTimer);
runPlayerCleanupTasks();
}
var video = document.getElementById('player');
var engine = new PlayerEngine(video, { videoId: 'PLAYERTEST1', streamToken: '' });
var player = engine.getPlayer();
window._player = player;
window._playerEngine = engine;
engine.init()
  .then(function () { return engine.load('/api/stream/PLAYERTEST1/dash.mpd'); })
  .then(function () { return video.play(); })
  .catch(function (error) { console.error('[fixture-watch]', error); });
</script>
</body>
</html>`);
  });
} else {
  const [
    { default: authRouter },
    { default: todayRouter },
    { default: subscriptionsRouter },
    { default: channelRouter },
    { default: playerRouter, redirectPathVideoId },
    { default: playlistRouter },
    { default: tagsRouter },
    { default: commentsRouter },
    { default: subscriptionsApiRouter },
    { default: cookiesRouter },
    { default: downloadsRouter },
    { default: exploreRouter },
    { default: dismissalsRouter },
    { default: boostsRouter },
    { default: mutesRouter },
    { default: exploreEventsRouter },
    { default: queueRouter },
    { default: ratingsRouter },
    { default: topicFiltersRouter },
  ] = await Promise.all([
    import('./auth.js'),
    import('./routes/today.js'),
    import('./routes/subscriptions.js'),
    import('./routes/channel.js'),
    import('./routes/player.js'),
    import('./routes/playlists.js'),
    import('./routes/tags.js'),
    import('./routes/comments.js'),
    import('./routes/subscriptions-api.js'),
    import('./routes/cookies.js'),
    import('./routes/downloads.js'),
    import('./routes/explore.js'),
    import('./routes/dismissals.js'),
    import('./routes/boosts.js'),
    import('./routes/mutes.js'),
    import('./routes/explore-events.js'),
    import('./routes/queue.js'),
    import('./routes/ratings.js'),
    import('./routes/topic-filters.js'),
  ]);

  // Mount route modules
  app.use('/downloads', downloadsRouter);
  app.use('/auth', authRouter);
  app.use('/', todayRouter);
  app.use('/explore', exploreRouter);
  app.use('/subscriptions', subscriptionsRouter);
  app.use('/channel', channelRouter);
  app.use('/watch', playerRouter);
  // YouTube /live/:videoId share links → /watch?v=videoId
  app.get('/live/:videoId', redirectPathVideoId);
  app.use('/playlist', playlistRouter);
  app.use('/playlists', playlistRouter);
  app.use('/api/tags', tagsRouter);
  app.use('/api/comments', commentsRouter);
  app.use('/api/subscriptions', subscriptionsApiRouter);
  app.use('/api/cookies', cookiesRouter);
  app.use('/api/dismissals', dismissalsRouter);
  app.use('/api/boosts', boostsRouter);
  app.use('/api/mutes', mutesRouter);
  app.use('/api/explore-events', exploreEventsRouter);
  app.use('/api/ratings', ratingsRouter);
  app.use('/api/topic-filters', topicFiltersRouter);
  app.use('/queue', queueRouter);
}

// Initialize optional infrastructure before accepting traffic. Each initializer
// has a short readiness deadline and falls back locally, so cold requests never
// inherit a half-connected Redis/BullMQ client.
import { initQueue } from './lib/extraction-queue.js';
import { initRssRefreshQueue } from './lib/rss-refresh-queue.js';
import { initDownloadQueue } from './lib/download-queue.js';
await Promise.all([initQueue(), initRssRefreshQueue(), initDownloadQueue()]);

// Watch time — save/restore position for continue watching
app.post('/api/watch-time/:videoId', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not logged in' });
  if (!db) return res.json({ ok: true });
  const { videoId } = req.params;
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) return res.status(400).json({ error: 'Invalid video ID' });
  const { position, duration } = req.body;
  if (typeof position !== 'number' || typeof duration !== 'number'
    || !Number.isFinite(position) || !Number.isFinite(duration)
    || position < 0 || duration < 0) return res.status(400).json({ error: 'Invalid data' });
  // Don't save if near the end (within 10% or 30s) — treat as "watched"
  if (duration > 0 && (position / duration > 0.9 || duration - position < 30)) {
    // Completion changes recommendation eligibility, so persist it immediately.
    try {
      await queueWatchTimeWrite(req.session.userId, videoId, 0, duration, true);
    } catch (error) {
      if (error instanceof WatchTimeQueueFullError) {
        res.set('Retry-After', '1');
        return res.status(503).json({ error: 'Watch-time persistence is busy' });
      }
      throw error;
    }
  } else {
    await queueWatchTimeWrite(req.session.userId, videoId, position, duration);
  }
  res.json({ ok: true });
});

app.post('/api/watch-times', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not logged in' });
  if (!db) return res.json({});
  const { ids } = req.body;
  if (!Array.isArray(ids) || !ids.length) return res.json({});
  const videoIds = ids.slice(0, 50).filter(id => /^[A-Za-z0-9_-]{11}$/.test(id));
  if (!videoIds.length) return res.json({});
  const result = await db.getWatchTimes(req.session.userId, videoIds);
  for (const videoId of videoIds) {
    const visible = visibleWatchTime(req.session.userId, videoId);
    if (visible) result[videoId] = { last_position: visible.last_position, duration: visible.duration };
  }
  res.json(result);
});

app.get('/api/watch-time/:videoId', async (req, res) => {
  if (!req.session.userId) return res.json({ position: 0 });
  if (!db) return res.json({ position: 0 });
  const { videoId } = req.params;
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) return res.json({ position: 0 });
  const visible = visibleWatchTime(req.session.userId, videoId);
  if (visible) return res.json({ position: visible.last_position, duration: visible.duration });
  const wt = await db.getWatchTime(req.session.userId, videoId);
  res.json({ position: wt ? wt.last_position : 0, duration: wt ? wt.duration : 0 });
});

async function createFixtureStreamRouter() {
  const router = express.Router();
  const {
    buildFixtureHlsMaster,
    buildFixtureHlsMedia,
    buildFixtureMPD,
    serveFixtureEncryptedHlsSegment,
    serveFixtureFormat,
    serveFixtureHlsKey,
    serveFixtureProgressive,
    serveFixtureTemplatePart,
    serveFixtureTsSegment,
  } = await import('./routes/stream/player-fixture.js');

  router.get('/:videoId/dash.mpd', (req, res) => {
    res.type('application/dash+xml').send(buildFixtureMPD(req.params.videoId, req.query));
  });
  router.get('/:videoId/hls.m3u8', (req, res) => {
    res.type('application/vnd.apple.mpegurl').send(buildFixtureHlsMaster(req.params.videoId, req.query));
  });
  router.get('/:videoId/hls/:formatId.m3u8', (req, res) => {
    res.type('application/vnd.apple.mpegurl').send(buildFixtureHlsMedia(req.params.videoId, req.params.formatId, req.query));
  });
  router.get('/:videoId/fmt/:formatId', (req, res) => {
    if (!serveFixtureFormat(req.params.videoId, req.params.formatId, req, res)) res.status(404).end();
  });
  const serveTemplateFixture = (req: express.Request, res: express.Response) => {
    const params = req.params as { videoId: string; formatId: string; part?: string };
    const part = params.part || 'init';
    if (part && serveFixtureTemplatePart(params.videoId, params.formatId, part, req, res)) return;
    res.status(404).json({ error: 'Template fixture part not found' });
  };
  router.get('/:videoId/tmpl/:formatId/init', serveTemplateFixture);
  router.get('/:videoId/tmpl/:formatId/:kind/:part', serveTemplateFixture);
  router.get('/:videoId/hls-ts/:formatId.ts', (req, res) => {
    if (!serveFixtureTsSegment(req.params.videoId, req.params.formatId, req, res)) res.status(404).end();
  });
  router.get('/:videoId/hls-ts-raw/:formatId', (req, res) => {
    if (!serveFixtureTsSegment(req.params.videoId, req.params.formatId, req, res)) res.status(404).end();
  });
  router.get('/:videoId/hls-key/:keyId.key', (req, res) => {
    if (!serveFixtureHlsKey(req.params.videoId, req.params.keyId, req, res)) res.status(404).end();
  });
  router.get('/:videoId/hls-aes/:formatId/:segmentId.:ext', (req, res) => {
    if (!serveFixtureEncryptedHlsSegment(req.params.videoId, req.params.formatId, req.params.segmentId, req, res)) res.status(404).end();
  });
  router.get('/:videoId/progressive.mp4', (req, res) => {
    if (!serveFixtureProgressive(req.params.videoId, req, res)) res.status(404).end();
  });
  return router;
}

const PLAYER_EVENT_TYPES = new Set([
  'audio-switch', 'capability-skip', 'caption-switch', 'drm-ready', 'fatal-error',
  'first-frame', 'gap-jump', 'load-start', 'loaded', 'manifest-refresh',
  'media-fetch-complete', 'native-unsupported', 'playback-rate-change',
  'playback-started', 'quality-switch', 'rebuffer-end', 'rebuffer-start',
  'recovery', 'request-cancel', 'scheduler-backpressure', 'scheduler-drain',
  'seek-buffer-ready', 'seek-complete', 'server-down', 'server-up',
  'stall-report', 'startup-buffer-ready', 'unload-summary', 'video-error',
]);
const PLAYER_DIAGNOSTIC_EVENT_TYPES = new Set([
  'fatal-error', 'native-unsupported', 'recovery', 'server-down', 'video-error',
]);
const PLAYER_METRIC_PROVIDERS = new Set(['', 'native-dash', 'native-hls', 'native-url']);
const PLAYER_EVENT_LOG_SAMPLE_RATE = Math.max(0, Math.min(1, Number(process.env.PLAYER_EVENT_LOG_SAMPLE_RATE) || 0.01));

function sanitizePlayerEvent(event: unknown) {
  if (!event || typeof event !== 'object') return null;
  const src = event as Record<string, unknown>;
  const videoId = typeof src.videoId === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(src.videoId) ? src.videoId : '';
  const rawType = clampText(src.type, 40);
  if (!rawType) return null;
  const type = PLAYER_EVENT_TYPES.has(rawType) ? rawType : 'other';
  return {
    type,
    videoId,
    provider: clampText(src.provider, 40),
    mode: clampText(src.mode, 30),
    fallbackReason: clampText(src.fallbackReason, 120),
    transmuxerProvider: clampText(src.transmuxerProvider, 40),
    transmuxedSegmentCount: clampNumber(src.transmuxedSegmentCount, 0, 10_000),
    lastError: clampText(src.lastError, 120),
    lastHttpStatus: clampNumber(src.lastHttpStatus, 0, 599),
    activeHeight: clampNumber(src.activeHeight, 0, 4320),
    bandwidthEstimate: clampNumber(src.bandwidthEstimate, 0, 1_000_000_000),
    bufferAhead: clampNumber(src.bufferAhead, 0, 600),
    rebufferCount: clampNumber(src.rebufferCount, 0, 10_000),
    rebufferDuration: clampNumber(src.rebufferDuration, 0, 86_400),
    recoveryCount: clampNumber(src.recoveryCount, 0, 10_000),
    mediaFetchRetryCount: clampNumber(src.mediaFetchRetryCount, 0, 10_000),
    mediaUrlRefreshCount: clampNumber(src.mediaUrlRefreshCount, 0, 10_000),
    networkTimeoutCount: clampNumber(src.networkTimeoutCount, 0, 10_000),
    lastRecoveryReason: clampText(src.lastRecoveryReason, 120),
    manifestRefreshReason: clampText(src.manifestRefreshReason, 80),
    droppedFrames: clampNumber(src.droppedFrames, 0, 10_000_000),
    totalFrames: clampNumber(src.totalFrames, 0, 10_000_000),
    startupMs: clampNumber(src.startupMs, 0, 300_000),
    firstFrameMs: clampNumber(src.firstFrameMs, 0, 300_000),
    videoStartupMs: clampNumber(src.videoStartupMs, 0, 300_000),
    playToPlayingMs: clampNumber(src.playToPlayingMs, 0, 300_000),
    pageToFirstFrameMs: clampNumber(src.pageToFirstFrameMs, 0, 300_000),
    startupBufferMs: clampNumber(src.startupBufferMs, 0, 300_000),
    seekLatencyMs: clampNumber(src.seekLatencyMs, 0, 300_000),
    at: clampNumber(src.at, 0, 86_400),
    ts: clampNumber(src.ts, 0, Number.MAX_SAFE_INTEGER),
  };
}

function clampText(value: unknown, max: number) {
  if (typeof value !== 'string') return '';
  return value.slice(0, max);
}

function clampNumber(value: unknown, min: number, max: number) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(min, Math.min(max, n));
}

// Health check endpoints
app.get('/health', async (_req, res) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- health check aggregates heterogeneous data
  const checks: Record<string, any> = {};

  // Database
  try {
    await db.getDuration('__healthcheck__');
    checks.database = { status: 'ok', backend: process.env.DATABASE_URL ? 'postgresql' : 'sqlite' };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- health check aggregates heterogeneous data
  } catch (err: any) {
    checks.database = { status: 'error', error: err.message };
  }

  // Redis
  if (hasRedis()) {
    try {
      await getRedisClient().ping();
      checks.redis = { status: 'ok' };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- health check aggregates heterogeneous data
    } catch (err: any) {
      checks.redis = { status: 'error', error: err.message };
    }
  } else {
    checks.redis = { status: 'not_configured' };
  }

  if (hasCacheRedis()) {
    try {
      await getCacheRedisClient().ping();
      checks.cacheRedis = { status: 'ok', dedicated: getCacheRedisClient() !== getRedisClient() };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- health check aggregates heterogeneous data
    } catch (err: any) {
      checks.cacheRedis = { status: 'error', error: err.message };
    }
  } else {
    checks.cacheRedis = { status: 'not_configured' };
  }

  // Extraction queue
  const { hasQueue } = await import('./lib/extraction-queue.js');
  checks.extractionQueue = { status: hasQueue() ? 'ok' : 'not_configured' };
  const { hasRssRefreshQueue } = await import('./lib/rss-refresh-queue.js');
  checks.rssRefreshQueue = { status: hasRssRefreshQueue() ? 'ok' : 'not_configured' };
  const { hasDownloadQueue } = await import('./lib/download-queue.js');
  checks.downloadQueue = { status: hasDownloadQueue() ? 'ok' : 'not_configured' };

  // Memory
  const mem = process.memoryUsage();
  checks.memory = {
    rss: Math.round(mem.rss / 1048576) + 'MB',
    heapUsed: Math.round(mem.heapUsed / 1048576) + 'MB',
    heapTotal: Math.round(mem.heapTotal / 1048576) + 'MB',
  };

  // Uptime
  checks.uptime = Math.round(process.uptime()) + 's';

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- health check aggregates heterogeneous data
  const allOk = Object.values(checks).every((c: any) => !c.status || c.status !== 'error');
  res.status(allOk ? 200 : 503).json(checks);
});

// Liveness probe (for Kubernetes/Docker) — just confirms process is alive
app.get('/health/live', (_req, res) => res.status(200).end('ok'));

// Readiness probe — confirms DB is accessible
app.get('/health/ready', async (_req, res) => {
  try {
    await db.getDuration('__healthcheck__');
    res.status(200).end('ok');
  } catch {
    res.status(503).end('not ready');
  }
});

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => logger.info('my-youtube running', { port: PORT }));
import { attach, closeAll as closeAllWebSockets } from './lib/ws-status.js';
await attach(server);

// Graceful shutdown — finish in-flight requests before exiting
function gracefulShutdown(signal) {
  logger.info('Shutting down gracefully', { signal });
  // Close WebSocket connections so they don't hold the server open
  closeAllWebSockets();
  server.close(() => {
    void flushAllPendingWatchTimes().finally(() => {
      logger.info('All connections closed, exiting');
      process.exit(0);
    });
  });
  // Force exit after 5s safety timeout
  setTimeout(() => {
    process.exit(1);
  }, 5000).unref();
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
