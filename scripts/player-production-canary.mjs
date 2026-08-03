import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const HELP = `Usage:
  PLAYER_CANARY_BASE_URL=https://staging.example.com \\
  PLAYER_CANARY_VIDEO_IDS=vod:BaW_jenozKc,live:VIDEO_ID,restricted:VIDEO_ID \\
  npm run canary:player

The canary creates a fresh browser context for every sample, signs in through
/auth/free unless PLAYER_CANARY_COOKIE or PLAYER_CANARY_STORAGE_STATE is set,
and fails when configured latency or reliability budgets are exceeded.

Optional environment:
  PLAYER_CANARY_SAMPLES=2
  PLAYER_CANARY_TIMEOUT_MS=90000
  PLAYER_CANARY_DOCUMENT_P95_MS=2500
  PLAYER_CANARY_MANIFEST_P95_MS=15000
  PLAYER_CANARY_MEDIA_FIRST_BYTE_P95_MS=20000
  PLAYER_CANARY_FIRST_FRAME_P95_MS=25000
  PLAYER_CANARY_EXTRACTION_QUEUE_P95_MS=5000
  PLAYER_CANARY_MAX_FAILURE_RATE=0
  PLAYER_CANARY_MAX_FALLBACK_RATE=0.05
  PLAYER_CANARY_REQUIRE_CATEGORIES=1
  PLAYER_CANARY_REQUIRE_METRICS=1
  PLAYER_CANARY_METRICS_TOKEN=...
  PLAYER_CANARY_COOKIE='connect.sid=...'
  PLAYER_CANARY_STORAGE_STATE=/secure/path/storage-state.json
  PLAYER_CANARY_OUTPUT=tmp/player-canary/latest.json
`;

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  process.stdout.write(HELP);
  process.exit(0);
}

function finiteNumber(name, fallback, minimum = 0, maximum = Number.POSITIVE_INFINITY) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function parseVideoSpecs(raw) {
  const allowedCategories = new Set(['vod', 'live', 'restricted']);
  return String(raw || '').split(',').map(value => value.trim()).filter(Boolean).map((entry) => {
    const separator = entry.indexOf(':');
    const category = separator === -1 ? 'vod' : entry.slice(0, separator).trim().toLowerCase();
    const videoId = separator === -1 ? entry : entry.slice(separator + 1).trim();
    if (!allowedCategories.has(category)) {
      throw new Error(`Unknown player canary category "${category}"; use vod, live, or restricted`);
    }
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
      throw new Error(`Invalid player canary video ID: ${videoId}`);
    }
    return { category, videoId };
  });
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return Number(sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)].toFixed(2));
}

function summarize(values) {
  const finite = values.filter(Number.isFinite);
  return {
    count: finite.length,
    p50Ms: percentile(finite, 0.5),
    p95Ms: percentile(finite, 0.95),
    maxMs: finite.length ? Number(Math.max(...finite).toFixed(2)) : null,
  };
}

function parsePrometheus(text) {
  const rows = [];
  for (const line of String(text || '').split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{([^}]*)\})?\s+(-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|[+-]?Inf|NaN)$/);
    if (!match) continue;
    const labels = {};
    const rawLabels = match[2] || '';
    const labelPattern = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:\\.|[^"])*)"/g;
    let labelMatch;
    while ((labelMatch = labelPattern.exec(rawLabels))) {
      labels[labelMatch[1]] = labelMatch[2].replace(/\\([\\"n])/g, (_whole, value) => value === 'n' ? '\n' : value);
    }
    rows.push({ name: match[1], labels, value: Number(match[3]) });
  }
  return rows;
}

function sumMetric(rows, name, labelFilter = {}) {
  return rows.filter(row => row.name === name && Object.entries(labelFilter).every(
    ([key, value]) => row.labels[key] === value,
  )).reduce((sum, row) => sum + (Number.isFinite(row.value) ? row.value : 0), 0);
}

function counterDelta(before, after) {
  if (!Number.isFinite(after)) return 0;
  if (!Number.isFinite(before) || after < before) return Math.max(0, after);
  return after - before;
}

function histogramDelta(beforeRows, afterRows, name) {
  if (!beforeRows || !afterRows) return null;
  const count = counterDelta(sumMetric(beforeRows, `${name}_count`), sumMetric(afterRows, `${name}_count`));
  const sum = counterDelta(sumMetric(beforeRows, `${name}_sum`), sumMetric(afterRows, `${name}_sum`));
  const bounds = new Set(
    afterRows.filter(row => row.name === `${name}_bucket`).map(row => row.labels.le),
  );
  const buckets = [...bounds].map((bound) => ({
    bound,
    value: counterDelta(
      sumMetric(beforeRows, `${name}_bucket`, { le: bound }),
      sumMetric(afterRows, `${name}_bucket`, { le: bound }),
    ),
  })).sort((left, right) => {
    if (left.bound === '+Inf') return 1;
    if (right.bound === '+Inf') return -1;
    return Number(left.bound) - Number(right.bound);
  });
  const percentileBucket = (fraction) => {
    const target = count * fraction;
    const bound = count > 0 ? buckets.find(bucket => bucket.value >= target)?.bound || null : null;
    return bound === '+Inf' ? '+Inf' : (bound === null ? null : Number(bound));
  };
  return {
    count,
    average: count > 0 ? Number((sum / count).toFixed(4)) : null,
    p50Bucket: percentileBucket(0.5),
    p95Bucket: percentileBucket(0.95),
  };
}

async function readMetrics(baseUrl, token) {
  if (!token) return null;
  const response = await fetch(new URL('/metrics', baseUrl), {
    headers: { 'X-Metrics-Token': token },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Metrics endpoint returned HTTP ${response.status}`);
  return parsePrometheus(await response.text());
}

function parseCookieHeader(header) {
  return String(header || '').split(';').map(value => value.trim()).filter(Boolean).map((entry) => {
    const separator = entry.indexOf('=');
    if (separator < 1) throw new Error('PLAYER_CANARY_COOKIE must contain name=value pairs');
    return { name: entry.slice(0, separator), value: entry.slice(separator + 1) };
  });
}

const baseUrlValue = String(process.env.PLAYER_CANARY_BASE_URL || '').trim();
if (!baseUrlValue) throw new Error('Set PLAYER_CANARY_BASE_URL to an isolated staging deployment');
const baseUrl = new URL(baseUrlValue);
if (!/^https?:$/.test(baseUrl.protocol)) throw new Error('PLAYER_CANARY_BASE_URL must use HTTP or HTTPS');
const videoSpecs = parseVideoSpecs(process.env.PLAYER_CANARY_VIDEO_IDS);
if (!videoSpecs.length) throw new Error('Set PLAYER_CANARY_VIDEO_IDS to at least one representative video');

const samplesPerVideo = Math.floor(finiteNumber('PLAYER_CANARY_SAMPLES', 2, 1, 100));
const timeoutMs = finiteNumber('PLAYER_CANARY_TIMEOUT_MS', 90_000, 5_000, 300_000);
const budgets = {
  documentP95Ms: finiteNumber('PLAYER_CANARY_DOCUMENT_P95_MS', 2_500, 1),
  manifestP95Ms: finiteNumber('PLAYER_CANARY_MANIFEST_P95_MS', 15_000, 1),
  mediaFirstByteP95Ms: finiteNumber('PLAYER_CANARY_MEDIA_FIRST_BYTE_P95_MS', 20_000, 1),
  firstFrameP95Ms: finiteNumber('PLAYER_CANARY_FIRST_FRAME_P95_MS', 25_000, 1),
  extractionQueueP95Ms: finiteNumber('PLAYER_CANARY_EXTRACTION_QUEUE_P95_MS', 5_000, 1),
  maxFailureRate: finiteNumber('PLAYER_CANARY_MAX_FAILURE_RATE', 0, 0, 1),
  maxFallbackRate: finiteNumber('PLAYER_CANARY_MAX_FALLBACK_RATE', 0.05, 0, 1),
};
const requireCategories = process.env.PLAYER_CANARY_REQUIRE_CATEGORIES === '1';
const requireMetrics = process.env.PLAYER_CANARY_REQUIRE_METRICS === '1';
const outputPath = path.resolve(process.env.PLAYER_CANARY_OUTPUT || 'tmp/player-canary/latest.json');
const storageState = String(process.env.PLAYER_CANARY_STORAGE_STATE || '').trim() || undefined;
const cookieHeader = String(process.env.PLAYER_CANARY_COOKIE || '').trim();
const metricsToken = String(process.env.PLAYER_CANARY_METRICS_TOKEN || '').trim();
const executablePath = process.env.PLAYER_CANARY_CHROMIUM_EXECUTABLE
  || process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
  || undefined;
const presentCategories = new Set(videoSpecs.map(spec => spec.category));
const missingCategories = ['vod', 'live', 'restricted'].filter(category => !presentCategories.has(category));

async function authenticate(context) {
  if (storageState) return;
  if (cookieHeader) {
    await context.addCookies(parseCookieHeader(cookieHeader).map(cookie => ({ ...cookie, url: baseUrl.origin })));
    return;
  }
  const response = await context.request.post(new URL('/auth/free', baseUrl).href, { maxRedirects: 0 });
  if (response.status() < 300 || response.status() >= 400) {
    throw new Error(`/auth/free returned HTTP ${response.status()}; provide PLAYER_CANARY_COOKIE or PLAYER_CANARY_STORAGE_STATE`);
  }
}

function isManifestPath(pathname) {
  return /\/api\/stream\/[A-Za-z0-9_-]{11}\/(?:dash\.mpd|hls\.m3u8)$/.test(pathname);
}

function isMediaPath(pathname) {
  return /\/api\/stream\/[A-Za-z0-9_-]{11}\/(?:fmt\/|hls-proxy(?:\/|$)|hls-ts\/|progressive(?:\.mp4)?$|proxy\/)/.test(pathname);
}

async function runSample(browser, spec, sampleNumber) {
  const context = await browser.newContext({
    ...(storageState ? { storageState } : {}),
    serviceWorkers: 'block',
  });
  const result = {
    ...spec,
    sample: sampleNumber,
    success: false,
    fallback: false,
    documentResponseMs: null,
    domContentLoadedMs: null,
    manifestReadyMs: null,
    mediaFirstByteMs: null,
    firstFrameMs: null,
    inlineManifest: false,
    provider: '',
    mode: '',
    fallbackReason: '',
    lastError: '',
    fatalError: '',
    streamErrors: [],
    browserErrors: [],
  };
  try {
    await authenticate(context);
    const page = await context.newPage();
    page.setDefaultTimeout(timeoutMs);
    const startedAt = performance.now();
    page.on('pageerror', error => result.browserErrors.push(String(error.message || error).slice(0, 300)));
    page.on('requestfailed', (request) => {
      let pathname = '';
      try { pathname = new URL(request.url()).pathname; } catch {}
      if (pathname.startsWith('/api/stream/')) {
        result.streamErrors.push(`${pathname}: ${request.failure()?.errorText || 'request failed'}`.slice(0, 300));
      }
    });
    page.on('response', (response) => {
      let pathname = '';
      try { pathname = new URL(response.url()).pathname; } catch {}
      const elapsed = Number((performance.now() - startedAt).toFixed(2));
      if (result.manifestReadyMs === null && isManifestPath(pathname)) result.manifestReadyMs = elapsed;
      if (result.mediaFirstByteMs === null && isMediaPath(pathname)) result.mediaFirstByteMs = elapsed;
      if (pathname.startsWith('/api/stream/') && response.status() >= 400) {
        result.streamErrors.push(`${pathname}: HTTP ${response.status()}`);
      }
    });

    const navigationResponse = await page.goto(
      new URL(`/watch?v=${encodeURIComponent(spec.videoId)}`, baseUrl).href,
      { waitUntil: 'domcontentloaded', timeout: timeoutMs },
    );
    if (!navigationResponse?.ok()) throw new Error(`Watch document returned HTTP ${navigationResponse?.status() || 0}`);
    if (new URL(page.url()).pathname === '/auth/login') {
      throw new Error('Canary authentication did not create a watch-page session');
    }
    await page.locator('video').waitFor({ state: 'attached', timeout: timeoutMs });
    await page.evaluate(() => {
      const video = document.querySelector('video');
      if (video) video.play().catch(() => {});
    });
    await page.waitForFunction(() => {
      const engine = window._playerEngine;
      const telemetryFrame = Number(engine?._telemetry?.firstFrameAt) || 0;
      const video = document.querySelector('video');
      return telemetryFrame > 0 || Boolean(video && video.readyState >= 2 && video.currentTime > 0);
    }, undefined, { timeout: timeoutMs });

    const browserState = await page.evaluate(() => {
      const navigation = performance.getEntriesByType('navigation')[0];
      const engine = window._playerEngine;
      let stats = {};
      try {
        const player = engine?.getPlayer ? engine.getPlayer() : window._player;
        stats = player?.getStats ? player.getStats() || {} : {};
      } catch {}
      const telemetryFrame = Number(engine?._telemetry?.firstFrameAt) || 0;
      const active = stats.activeVariant || {};
      return {
        documentResponseMs: Number(navigation?.responseStart) || 0,
        domContentLoadedMs: Number(navigation?.domContentLoadedEventEnd) || 0,
        firstFrameMs: telemetryFrame || performance.now(),
        inlineManifest: Boolean(window.__inlineMPD),
        provider: String(stats.provider || engine?._providerName || window._playerProvider || ''),
        mode: String(stats.mode || ''),
        fallbackReason: String(stats.fallbackReason || engine?._fallbackReason || ''),
        lastError: String(stats.lastError || ''),
        fatalError: String(stats.fatalError || ''),
        activeHeight: Number(active.height) || 0,
        rebufferCount: Number(stats.rebufferCount) || 0,
        mediaFetchRetryCount: Number(stats.mediaFetchRetryCount) || 0,
      };
    });
    Object.assign(result, browserState);
    if (result.inlineManifest && result.manifestReadyMs === null) result.manifestReadyMs = 0;
    result.fallback = Boolean(
      result.fallbackReason
      || result.provider === 'native-terminal'
      || (result.provider && !['native-dash', 'native-hls', 'native-url'].includes(result.provider)),
    );
    if (result.fatalError) throw new Error(result.fatalError);
    result.success = true;
  } catch (error) {
    result.error = String(error?.message || error).slice(0, 500);
  } finally {
    await context.close();
  }
  return result;
}

let browser;
const results = [];
let metricsBefore = null;
let metricsAfter = null;
try {
  metricsBefore = await readMetrics(baseUrl, metricsToken);
  browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
  for (const spec of videoSpecs) {
    for (let sample = 1; sample <= samplesPerVideo; sample++) {
      const result = await runSample(browser, spec, sample);
      results.push(result);
      process.stdout.write(`${result.success ? 'PASS' : 'FAIL'} ${spec.category}:${spec.videoId} sample=${sample}`
        + ` firstFrame=${result.firstFrameMs ?? '-'}ms provider=${result.provider || '-'}\n`);
    }
  }
} finally {
  await browser?.close();
  if (metricsToken) {
    await new Promise(resolve => setTimeout(resolve, 1_100));
    metricsAfter = await readMetrics(baseUrl, metricsToken).catch((error) => {
      process.stderr.write(`Could not collect final metrics snapshot: ${error.message}\n`);
      return null;
    });
  }
}

const summary = {
  documentResponse: summarize(results.map(result => result.documentResponseMs)),
  domContentLoaded: summarize(results.map(result => result.domContentLoadedMs)),
  manifestReady: summarize(results.map(result => result.manifestReadyMs)),
  mediaFirstByte: summarize(results.map(result => result.mediaFirstByteMs)),
  firstFrame: summarize(results.map(result => result.firstFrameMs)),
  failureRate: Number((results.filter(result => !result.success).length / results.length).toFixed(4)),
  fallbackRate: Number((results.filter(result => result.fallback).length / results.length).toFixed(4)),
};
const serverMetrics = Object.fromEntries([
  'extraction_request_duration_seconds',
  'extraction_queue_wait_seconds',
  'manifest_build_duration_seconds',
  'manifest_probe_duration_seconds',
  'stream_response_first_byte_seconds',
  'player_video_startup_ms',
].map(name => [name, histogramDelta(metricsBefore, metricsAfter, name)]));
const failures = [];
if (summary.documentResponse.p95Ms === null || summary.documentResponse.p95Ms > budgets.documentP95Ms) failures.push('documentResponse');
if (summary.manifestReady.p95Ms === null || summary.manifestReady.p95Ms > budgets.manifestP95Ms) failures.push('manifestReady');
if (summary.mediaFirstByte.p95Ms === null || summary.mediaFirstByte.p95Ms > budgets.mediaFirstByteP95Ms) failures.push('mediaFirstByte');
if (summary.firstFrame.p95Ms === null || summary.firstFrame.p95Ms > budgets.firstFrameP95Ms) failures.push('firstFrame');
if (summary.failureRate > budgets.maxFailureRate) failures.push('failureRate');
if (summary.fallbackRate > budgets.maxFallbackRate) failures.push('fallbackRate');
if (requireCategories && missingCategories.length) failures.push(`coverage:${missingCategories.join(',')}`);
const extractionQueueP95 = serverMetrics.extraction_queue_wait_seconds?.p95Bucket;
if (extractionQueueP95 !== null && extractionQueueP95 !== undefined
  && (extractionQueueP95 === '+Inf' || extractionQueueP95 * 1_000 > budgets.extractionQueueP95Ms)) {
  failures.push('extractionQueueWait');
}
if (requireMetrics && !(metricsBefore && metricsAfter)) failures.push('serverMetrics');

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  baseUrl: baseUrl.origin,
  cacheScope: 'fresh-browser-context; use a fresh isolated staging deployment for server-cold measurements',
  coverage: {
    configuredCategories: [...presentCategories],
    missingCategories,
    samplesPerVideo,
  },
  budgets,
  summary,
  serverMetrics,
  serverMetricsAvailable: Boolean(metricsBefore && metricsAfter),
  failures,
  pass: failures.length === 0,
  results,
};
mkdirSync(path.dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ ...summary, failures, outputPath }, null, 2)}\n`);
if (failures.length) process.exitCode = 1;
