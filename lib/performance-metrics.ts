import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

type Labels = Record<string, string | number | boolean>;
type MetricHistogram = { count: number; sum: number; limits: number[]; buckets: number[] };
type MetricsMessage = {
  type?: string;
  requestId?: string;
  bodies?: string[];
};

const counters = new Map<string, number>();
const gauges = new Map<string, number>();
const histograms = new Map<string, MetricHistogram>();
const knownSeries = new Set<string>();
const pendingClusterCollections = new Map<string, (bodies: string[]) => void>();
const HISTOGRAM_BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10_000, 30_000];
const HISTOGRAM_BUCKETS_SECONDS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];
const HISTOGRAM_BUCKETS_BYTES = [1024, 4096, 16_384, 65_536, 262_144, 524_288, 1_048_576, 2_097_152, 4_194_304];
const MAX_METRIC_SERIES = Math.max(100, Number(process.env.MAX_METRIC_SERIES) || 2_000);
const CLUSTER_METRICS_TIMEOUT_MS = Math.max(100, Number(process.env.CLUSTER_METRICS_TIMEOUT_MS) || 1_500);
const METRICS_SNAPSHOT_TTL_MS = Math.max(250, Number(process.env.METRICS_SNAPSHOT_TTL_MS) || 1_000);
const KNOWN_HTTP_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
let droppedMetricSeries = 0;
let metricsRequestSequence = 0;
let cachedClusterSnapshot: { body: string; expiresAt: number } | null = null;
let clusterSnapshotInflight: Promise<string> | null = null;
const cachedLocalSnapshots = new Map<string, { body: string; expiresAt: number }>();
eventLoopDelay.enable();

function metricName(value: string) {
  return value.replace(/[^a-zA-Z0-9_:]/g, '_');
}

function labelKey(labels: Labels = {}) {
  return Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${metricName(key)}=${String(value)}`)
    .join(',');
}

function seriesKey(name: string, labels: Labels = {}) {
  const encoded = labelKey(labels);
  return `${metricName(name)}${encoded ? `|${encoded}` : ''}`;
}

function registerSeries(key: string) {
  if (knownSeries.has(key)) return true;
  if (knownSeries.size >= MAX_METRIC_SERIES) {
    droppedMetricSeries++;
    return false;
  }
  knownSeries.add(key);
  return true;
}

function incrementMetric(name: string, labels: Labels = {}, amount = 1) {
  const key = seriesKey(name, labels);
  if (!registerSeries(key)) return;
  counters.set(key, (counters.get(key) || 0) + amount);
}

function setMetricGauge(name: string, value: number, labels: Labels = {}) {
  const key = seriesKey(name, labels);
  if (!registerSeries(key)) return;
  gauges.set(key, Number.isFinite(value) ? value : 0);
}

function observeMetric(name: string, value: number, labels: Labels = {}) {
  if (!Number.isFinite(value)) return;
  const key = seriesKey(name, labels);
  let histogram = histograms.get(key);
  if (!histogram) {
    if (!registerSeries(key)) return;
    const limits = name.endsWith('_seconds')
      ? HISTOGRAM_BUCKETS_SECONDS
      : name.endsWith('_bytes') ? HISTOGRAM_BUCKETS_BYTES : HISTOGRAM_BUCKETS_MS;
    histogram = { count: 0, sum: 0, limits, buckets: limits.map(() => 0) };
    histograms.set(key, histogram);
  }
  histogram.count++;
  histogram.sum += value;
  histogram.limits.forEach((limit, index) => {
    if (value <= limit) histogram!.buckets[index]++;
  });
}

function splitSeriesKey(key: string) {
  const [name, rawLabels = ''] = key.split('|', 2);
  const labels = rawLabels
    ? rawLabels.split(',').map((entry) => {
        const separator = entry.indexOf('=');
        return [entry.slice(0, separator), entry.slice(separator + 1)] as const;
      })
    : [];
  return { name, labels };
}

function labelsToEntries(labels: Labels = {}) {
  return Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => [metricName(key), String(value)] as const);
}

function formatLabels(
  labels: ReadonlyArray<readonly [string, string]>,
  extra: ReadonlyArray<readonly [string, string]> = [],
) {
  const all = [...labels, ...extra];
  if (!all.length) return '';
  const body = all.map(([key, value]) => `${key}="${value.replace(/["\\\n]/g, '_')}"`).join(',');
  return `{${body}}`;
}

function requestRouteLabel(req) {
  const pathname = String(req.originalUrl || req.path || req.url || '/').split('?', 1)[0];
  const parts = pathname.split('/').filter(Boolean);
  if (parts[0] === 'api' && parts[1] === 'stream') {
    const operation = parts[3] || 'root';
    const safeOperation = ['dash.mpd', 'hls.m3u8', 'formats', 'segment', 'proxy', 'download'].includes(operation)
      ? operation
      : ':operation';
    return `/api/stream/:videoId/${safeOperation}${parts.length > 4 ? '/:part' : ''}`;
  }

  const routePath = req.route?.path;
  if (typeof routePath === 'string') {
    if (routePath === '/') return pathname === '/' ? '/' : pathname.replace(/\/$/, '');
    // Express exposes a router-relative pattern (for example `/:videoId`).
    // Reconstruct the mounted pattern from originalUrl so unrelated routers
    // do not collapse into the same metric series.
    const routeParts = routePath.split('/').filter(Boolean);
    if (parts.length >= routeParts.length) {
      return `/${[...parts.slice(0, parts.length - routeParts.length), ...routeParts].join('/')}`;
    }
    return routePath;
  }

  if (/\.(?:avif|br|css|gif|gz|ico|jpe?g|js|json|map|png|svg|webmanifest|webp|woff2?)$/i.test(pathname)) {
    return '/static/:asset';
  }
  return '/:unmatched';
}

function streamOperationLabel(req) {
  const pathname = String(req.path || req.url || '/').split('?', 1)[0];
  const parts = pathname.split('/').filter(Boolean);
  if (parts[0] !== 'api' || parts[1] !== 'stream' || parts.length < 4) return null;
  const suffix = parts[3];
  if (suffix === 'dash.mpd' || suffix === 'hls.m3u8') return 'manifest';
  if (suffix === 'fmt') return 'dash_segment';
  if (suffix === 'hls-proxy') return 'hls_segment';
  if (suffix === 'proxy' || suffix === 'progressive' || suffix === 'progressive.mp4') return 'progressive';
  if (suffix === 'poster' || suffix === 'thumb' || suffix === 'storyboard' || suffix === 'iframe') return 'image';
  if (suffix === 'subtitles') return 'subtitle';
  if (suffix === 'download' || suffix === 'offline-bundle' || suffix === 'cache') return 'offline';
  if (suffix === 'prefetch' || suffix === 'status' || suffix === 'formats') return 'control';
  return 'other';
}

function responseChunkBytes(chunk, encoding?: unknown) {
  if (chunk === undefined || chunk === null || typeof chunk === 'function') return 0;
  if (typeof chunk === 'string') {
    return Buffer.byteLength(chunk, typeof encoding === 'string' ? encoding as BufferEncoding : undefined);
  }
  if (ArrayBuffer.isView(chunk)) return chunk.byteLength;
  if (chunk instanceof ArrayBuffer) return chunk.byteLength;
  return 0;
}

function instrumentStreamResponse(req, res, startedAt: number) {
  const operation = streamOperationLabel(req);
  if (!operation) return;
  let responseBytes = 0;
  let firstByteRecorded = false;
  let finalized = false;

  const recordFirstByte = () => {
    if (firstByteRecorded) return;
    firstByteRecorded = true;
    observeMetric('stream_response_first_byte_seconds', (performance.now() - startedAt) / 1000, { operation });
  };

  const originalWrite = res.write;
  res.write = function (chunk, ...args) {
    recordFirstByte();
    responseBytes += responseChunkBytes(chunk, args[0]);
    return originalWrite.call(this, chunk, ...args);
  };
  const originalEnd = res.end;
  res.end = function (chunk, ...args) {
    recordFirstByte();
    responseBytes += responseChunkBytes(chunk, args[0]);
    return originalEnd.call(this, chunk, ...args);
  };

  const finalize = (result: 'complete' | 'aborted') => {
    if (finalized) return;
    finalized = true;
    const labels = {
      operation,
      result,
      status: `${Math.floor(res.statusCode / 100)}xx`,
    };
    incrementMetric('stream_responses_total', labels);
    incrementMetric('stream_response_bytes_total', { operation, result }, responseBytes);
    observeMetric('stream_response_duration_seconds', (performance.now() - startedAt) / 1000, labels);
  };
  res.once('finish', () => finalize('complete'));
  res.once('close', () => {
    if (!res.writableFinished) finalize('aborted');
  });
}

function performanceMetricsMiddleware(req, res, next) {
  const startedAt = performance.now();
  instrumentStreamResponse(req, res, startedAt);
  res.once('finish', () => {
    const method = String(req.method || '').toUpperCase();
    const labels = {
      method: KNOWN_HTTP_METHODS.has(method) ? method : 'OTHER',
      route: requestRouteLabel(req),
      status: `${Math.floor(res.statusCode / 100)}xx`,
    };
    incrementMetric('http_requests_total', labels);
    observeMetric('http_request_duration_ms', performance.now() - startedAt, labels);
  });
  next();
}

function renderPerformanceMetrics(commonLabels: Labels = {}) {
  setMetricGauge('process_uptime_seconds', process.uptime());
  setMetricGauge('process_resident_memory_bytes', process.memoryUsage().rss);
  setMetricGauge('nodejs_event_loop_delay_mean_seconds', eventLoopDelay.mean / 1e9);
  setMetricGauge('nodejs_event_loop_delay_p99_seconds', eventLoopDelay.percentile(99) / 1e9);

  const commonEntries = labelsToEntries(commonLabels);
  const lines: string[] = [];
  for (const [key, value] of counters) {
    const { name, labels } = splitSeriesKey(key);
    lines.push(`${name}${formatLabels(labels, commonEntries)} ${value}`);
  }
  for (const [key, value] of gauges) {
    const { name, labels } = splitSeriesKey(key);
    lines.push(`${name}${formatLabels(labels, commonEntries)} ${value}`);
  }
  lines.push(`performance_metric_series${formatLabels([], commonEntries)} ${knownSeries.size}`);
  lines.push(`performance_metric_series_dropped_total${formatLabels([], commonEntries)} ${droppedMetricSeries}`);
  for (const [key, histogram] of histograms) {
    const { name, labels } = splitSeriesKey(key);
    histogram.limits.forEach((limit, index) => {
      lines.push(`${name}_bucket${formatLabels(labels, [...commonEntries, ['le', String(limit)]])} ${histogram!.buckets[index]}`);
    });
    lines.push(`${name}_bucket${formatLabels(labels, [...commonEntries, ['le', '+Inf']])} ${histogram.count}`);
    lines.push(`${name}_sum${formatLabels(labels, commonEntries)} ${histogram.sum}`);
    lines.push(`${name}_count${formatLabels(labels, commonEntries)} ${histogram.count}`);
  }
  return lines.join('\n') + '\n';
}

function renderCachedPerformanceMetrics(commonLabels: Labels = {}) {
  const key = labelKey(commonLabels);
  const cached = cachedLocalSnapshots.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.body;
  const body = renderPerformanceMetrics(commonLabels);
  cachedLocalSnapshots.set(key, { body, expiresAt: Date.now() + METRICS_SNAPSHOT_TTL_MS });
  return body;
}

function collectPerformanceMetricsUncached() {
  if (!process.send || !process.env.CLUSTER_WORKER_COUNT || process.env.METRICS_CLUSTER_AGGREGATION === '0') {
    return Promise.resolve(renderCachedPerformanceMetrics());
  }

  const requestId = `${process.pid}-${++metricsRequestSequence}`;
  return new Promise<string>((resolve) => {
    const timeout = setTimeout(() => {
      pendingClusterCollections.delete(requestId);
      resolve(renderCachedPerformanceMetrics({ worker: process.pid }));
    }, CLUSTER_METRICS_TIMEOUT_MS);
    timeout.unref?.();
    pendingClusterCollections.set(requestId, (bodies) => {
      clearTimeout(timeout);
      resolve(bodies.join(''));
    });
    try {
      process.send!({ type: 'performance-metrics-collect', requestId });
    } catch {
      clearTimeout(timeout);
      pendingClusterCollections.delete(requestId);
      resolve(renderCachedPerformanceMetrics({ worker: process.pid }));
    }
  });
}

function collectPerformanceMetrics() {
  if (cachedClusterSnapshot && cachedClusterSnapshot.expiresAt > Date.now()) {
    return Promise.resolve(cachedClusterSnapshot.body);
  }
  if (clusterSnapshotInflight !== null) return clusterSnapshotInflight;
  clusterSnapshotInflight = collectPerformanceMetricsUncached().then((body) => {
    cachedClusterSnapshot = { body, expiresAt: Date.now() + METRICS_SNAPSHOT_TTL_MS };
    return body;
  }).finally(() => {
    clusterSnapshotInflight = null;
  });
  return clusterSnapshotInflight;
}

process.on('message', (rawMessage: MetricsMessage) => {
  const message = rawMessage || {};
  if (message.type === 'performance-metrics-snapshot-request' && message.requestId && process.send && process.env.CLUSTER_WORKER_COUNT) {
    try {
      process.send({
        type: 'performance-metrics-snapshot',
        requestId: message.requestId,
        body: renderCachedPerformanceMetrics({ worker: process.pid }),
      });
    } catch {
      // A local snapshot remains available if cluster IPC is shutting down.
    }
    return;
  }
  if (message.type === 'performance-metrics-collection' && message.requestId) {
    const complete = pendingClusterCollections.get(message.requestId);
    if (!complete) return;
    pendingClusterCollections.delete(message.requestId);
    complete(Array.isArray(message.bodies) ? message.bodies : []);
  }
});

export {
  collectPerformanceMetrics,
  incrementMetric,
  observeMetric,
  performanceMetricsMiddleware,
  renderPerformanceMetrics,
  setMetricGauge,
};
