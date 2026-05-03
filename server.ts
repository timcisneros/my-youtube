import 'dotenv/config';

import express from 'express';
import compression from 'compression';
import session from 'express-session';
import createSqliteStore from 'better-sqlite3-session-store';
const BetterSqlite3Store = createSqliteStore(session);
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { execFile } from 'child_process';

import authRouter from './auth.js';
import todayRouter from './routes/today.js';
import subscriptionsRouter from './routes/subscriptions.js';
import channelRouter from './routes/channel.js';
import playerRouter from './routes/player.js';
import tagsRouter from './routes/tags.js';
import commentsRouter from './routes/comments.js';
import streamRouter from './routes/stream/index.js';
import subscriptionsApiRouter from './routes/subscriptions-api.js';
import cookiesRouter from './routes/cookies.js';
import downloadsRouter from './routes/downloads.js';
import exploreRouter from './routes/explore.js';
import dismissalsRouter from './routes/dismissals.js';
import boostsRouter from './routes/boosts.js';
import mutesRouter from './routes/mutes.js';
import exploreEventsRouter from './routes/explore-events.js';
import queueRouter from './routes/queue.js';
import ratingsRouter from './routes/ratings.js';
import topicFiltersRouter from './routes/topic-filters.js';

const app = express();

// --- Rate limiting (token bucket per IP) ---
const rateBuckets = new Map();
const RATE_BURST = 60;
const RATE_PER_SEC = 8;
const EXTRACT_BURST = 5;
const EXTRACT_WINDOW = 60 * 1000; // 1 minute
const extractBuckets = new Map();

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
  // Skip static assets and all stream routes (stream routes have their own extraction rate guard)
  if (req.path.startsWith('/public/') || req.path.startsWith('/vendor/')) return next();
  if (req.path.startsWith('/api/stream/')) return next();
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
const extractionInProgress = new Set<string>();
app.extractionRateCheck = function(ip, videoId) {
  if (videoId && extractionInProgress.has(videoId)) return true; // already extracting, don't count
  const b = getExtractBucket(ip);
  if (b.count >= EXTRACT_BURST) return false;
  b.count++;
  if (videoId) {
    extractionInProgress.add(videoId);
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
app.set('views', path.join(import.meta.dirname, 'views'));

// Avoid 404 noise from browser favicon requests
app.get('/favicon.ico', (_req, res) => res.status(204).end());

// Stream routes mounted early — skip compression, session, JSON parsing for max throughput
app.use('/api/stream', streamRouter);

app.use(compression({
  level: 6,
  threshold: 1024,
  filter: (req, res) => {
    if (req.path.includes('/api/stream/')) return false;
    return compression.filter(req, res);
  }
}));
app.use(express.json());
app.use(express.static(path.join(import.meta.dirname, 'public'), { maxAge: '1d' }));
app.use('/vendor/shaka', express.static(path.join(import.meta.dirname, 'node_modules/shaka-player/dist'), { maxAge: '7d', immutable: true }));
const dataDir = path.join(import.meta.dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);

// Session store — Redis when REDIS_URL is set, SQLite otherwise
let sessionStore;
if (process.env.REDIS_URL) {
  try {
    const { RedisStore } = await import('connect-redis');
    const { Redis } = await import('ioredis');
    const redisClient = new Redis(process.env.REDIS_URL);
    sessionStore = new RedisStore({ client: redisClient, prefix: 'sess:' });
    console.log('[session] Using Redis store');
  } catch (err: unknown) {
    console.warn('[session] Redis store failed, falling back to SQLite:', (err as Error).message);
  }
}
if (!sessionStore) {
  const sessionDb = new Database(path.join(dataDir, 'sessions.db'));
  sessionStore = new BetterSqlite3Store({ client: sessionDb, expired: { clear: true, intervalMs: 60 * 60 * 1000 } });
}

app.use(session({
  store: sessionStore,
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

import db from './db.js';

// Mount route modules
app.use('/downloads', downloadsRouter);
app.use('/auth', authRouter);
app.use('/', todayRouter);
app.use('/explore', exploreRouter);
app.use('/subscriptions', subscriptionsRouter);
app.use('/channel', channelRouter);
app.use('/watch', playerRouter);
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

// Clear yt-dlp cache on startup to avoid stale format data
execFile('yt-dlp', ['--rm-cache-dir'], () => {});

// Initialize Redis for shared caches (non-blocking, falls back to in-memory)
import { initRedis } from './lib/cache.js';
initRedis().catch(() => {});

// Initialize BullMQ extraction queue (non-blocking, falls back to in-process extraction)
import { initQueue } from './lib/extraction-queue.js';
await initQueue();

// Initialize S3-compatible storage (non-blocking, falls back to local filesystem)
import { initStorage } from './lib/storage.js';
await initStorage();

// Watch time — save/restore position for continue watching
app.post('/api/watch-time/:videoId', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not logged in' });
  const { videoId } = req.params;
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) return res.status(400).json({ error: 'Invalid video ID' });
  const { position, duration } = req.body;
  if (typeof position !== 'number' || typeof duration !== 'number') return res.status(400).json({ error: 'Invalid data' });
  // Don't save if near the end (within 10% or 30s) — treat as "watched"
  if (duration > 0 && (position / duration > 0.9 || duration - position < 30)) {
    db.setWatchTime(req.session.userId, videoId, 0, duration);
  } else {
    db.setWatchTime(req.session.userId, videoId, position, duration);
  }
  res.json({ ok: true });
});

app.post('/api/watch-times', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not logged in' });
  const { ids } = req.body;
  if (!Array.isArray(ids) || !ids.length) return res.json({});
  const videoIds = ids.slice(0, 50).filter(id => /^[A-Za-z0-9_-]{11}$/.test(id));
  if (!videoIds.length) return res.json({});
  const result = await db.getWatchTimes(req.session.userId, videoIds);
  res.json(result);
});

app.get('/api/watch-time/:videoId', (req, res) => {
  if (!req.session.userId) return res.json({ position: 0 });
  const { videoId } = req.params;
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) return res.json({ position: 0 });
  const wt = db.getWatchTime(req.session.userId, videoId);
  res.json({ position: wt ? wt.last_position : 0, duration: wt ? wt.duration : 0 });
});

// Health check endpoints
app.get('/health', async (_req, res) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- health check aggregates heterogeneous data
  const checks: Record<string, any> = {};

  // Database
  try {
    db.getDuration('__healthcheck__');
    checks.database = { status: 'ok', backend: process.env.DATABASE_URL ? 'postgresql' : 'sqlite' };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- health check aggregates heterogeneous data
  } catch (err: any) {
    checks.database = { status: 'error', error: err.message };
  }

  // Redis
  const { hasRedis, getRedisClient } = await import('./lib/cache.js');
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

  // Storage
  const storage = await import('./lib/storage.js');
  checks.storage = { status: 'ok', backend: storage.isS3() ? 's3' : 'local' };

  // Extraction queue
  const { hasQueue } = await import('./lib/extraction-queue.js');
  checks.extractionQueue = { status: hasQueue() ? 'ok' : 'not_configured' };

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
    db.getDuration('__healthcheck__');
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
    logger.info('All connections closed, exiting');
    process.exit(0);
  });
  // Force exit after 5s safety timeout
  setTimeout(() => {
    process.exit(1);
  }, 5000).unref();
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
