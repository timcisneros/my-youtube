import { Worker } from 'node:worker_threads';
import { compactExtractionResult } from './extraction-result.js';
import { incrementMetric, observeMetric, setMetricGauge } from './performance-metrics.js';

type ParseOperation = 'json' | 'embedded-json' | 'extraction-json';
type ParsedJson = ReturnType<typeof JSON.parse>;
type ParseTask = {
  id: number;
  operation: ParseOperation;
  bytes: Uint8Array;
  marker?: string;
  extractedVia?: string;
  enqueuedAt: number;
  startedAt: number;
  deadline: number;
  timer: NodeJS.Timeout | null;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};
type ParserLane = {
  name: 'upstream' | 'extraction';
  maxPending: number;
  timeoutMs: number;
  worker: Worker | null;
  activeTask: ParseTask | null;
  queue: ParseTask[];
};

const PARSE_OFFLOAD_THRESHOLD_BYTES = Math.max(64 * 1024,
  Number(process.env.UPSTREAM_PARSE_OFFLOAD_BYTES) || 256 * 1024);
const PARSE_WORKER_MAX_PENDING = Math.min(64, Math.max(1,
  Number(process.env.UPSTREAM_PARSE_WORKER_MAX_PENDING) || 16));
const PARSE_WORKER_TIMEOUT_MS = Math.max(500,
  Number(process.env.UPSTREAM_PARSE_WORKER_TIMEOUT_MS) || 5_000);
const EXTRACTION_PARSE_OFFLOAD_THRESHOLD_BYTES = Math.max(64 * 1024,
  Number(process.env.EXTRACTION_PARSE_OFFLOAD_BYTES) || PARSE_OFFLOAD_THRESHOLD_BYTES);
const EXTRACTION_PARSE_WORKER_MAX_PENDING = Math.min(32, Math.max(1,
  Number(process.env.EXTRACTION_PARSE_WORKER_MAX_PENDING) || 8));
const EXTRACTION_PARSE_WORKER_TIMEOUT_MS = Math.max(500,
  Number(process.env.EXTRACTION_PARSE_WORKER_TIMEOUT_MS) || 10_000);

let sequence = 0;
const upstreamLane: ParserLane = {
  name: 'upstream',
  maxPending: PARSE_WORKER_MAX_PENDING,
  timeoutMs: PARSE_WORKER_TIMEOUT_MS,
  worker: null,
  activeTask: null,
  queue: [],
};
const extractionLane: ParserLane = {
  name: 'extraction',
  maxPending: EXTRACTION_PARSE_WORKER_MAX_PENDING,
  timeoutMs: EXTRACTION_PARSE_WORKER_TIMEOUT_MS,
  worker: null,
  activeTask: null,
  queue: [],
};

function updateMetrics(lane: ParserLane) {
  const prefix = lane.name === 'upstream' ? 'upstream_parse' : 'extraction_parse';
  setMetricGauge(`${prefix}_queue_depth`, lane.queue.length);
  setMetricGauge(`${prefix}_active`, lane.activeTask ? 1 : 0);
}

function settle(task: ParseTask, error?: Error, result?: unknown) {
  if (task.timer) clearTimeout(task.timer);
  task.timer = null;
  if (error) task.reject(error);
  else task.resolve(result);
}

function failWorker(lane: ParserLane, worker: Worker, error: Error) {
  if (lane.worker !== worker) return;
  lane.worker = null;
  if (lane.activeTask) {
    incrementMetric('upstream_parse_requests_total', {
      operation: lane.activeTask.operation,
      result: 'worker_error',
    });
    settle(lane.activeTask, error);
    lane.activeTask = null;
  }
  void worker.terminate();
  updateMetrics(lane);
  dispatchNext(lane);
}

function ensureWorker(lane: ParserLane) {
  if (lane.worker) return lane.worker;
  const workerUrl = import.meta.url.endsWith('.ts')
    ? new URL('./upstream-parser-worker.ts', import.meta.url)
    : new URL('./upstream-parser-worker.js', import.meta.url);
  const worker = new Worker(workerUrl);
  lane.worker = worker;
  worker.on('message', (message: { id?: number; result?: unknown; error?: string }) => {
    if (lane.worker !== worker || !lane.activeTask || message.id !== lane.activeTask.id) return;
    const task = lane.activeTask;
    lane.activeTask = null;
    observeMetric('upstream_parse_duration_ms', Date.now() - task.startedAt, { operation: task.operation });
    incrementMetric('upstream_parse_requests_total', {
      operation: task.operation,
      result: message.error ? 'parse_error' : 'success',
    });
    settle(task, message.error ? new Error(message.error) : undefined, message.result);
    updateMetrics(lane);
    dispatchNext(lane);
  });
  worker.on('error', error => failWorker(lane, worker, error));
  worker.on('exit', code => {
    if (lane.worker === worker) {
      failWorker(lane, worker, new Error(`Upstream parser worker exited with code ${code}`));
    }
  });
  worker.unref();
  return worker;
}

function dispatchNext(lane: ParserLane) {
  if (lane.activeTask || lane.queue.length === 0) {
    if (!lane.activeTask) lane.worker?.unref();
    updateMetrics(lane);
    return;
  }
  const task = lane.queue.shift()!;
  if (Date.now() >= task.deadline) {
    incrementMetric('upstream_parse_requests_total', { operation: task.operation, result: 'queue_timeout' });
    settle(task, new Error('Upstream parser queue timed out'));
    dispatchNext(lane);
    return;
  }
  lane.activeTask = task;
  task.startedAt = Date.now();
  observeMetric('upstream_parse_queue_wait_ms', task.startedAt - task.enqueuedAt, { operation: task.operation });
  const worker = ensureWorker(lane);
  worker.ref();
  task.timer = setTimeout(() => {
    if (lane.activeTask !== task) return;
    lane.activeTask = null;
    incrementMetric('upstream_parse_requests_total', { operation: task.operation, result: 'timeout' });
    settle(task, new Error('Upstream parser timed out'));
    failWorker(lane, worker, new Error('Upstream parser worker timed out'));
  }, Math.max(1, task.deadline - Date.now()));
  task.timer.unref?.();
  try {
    worker.postMessage({
      id: task.id,
      operation: task.operation,
      bytes: task.bytes,
      marker: task.marker,
      extractedVia: task.extractedVia,
    }, [task.bytes.buffer as ArrayBuffer]);
  } catch (error) {
    failWorker(lane, worker, error as Error);
  }
  updateMetrics(lane);
}

function transferableBytes(buffer: Buffer) {
  if (buffer.byteOffset === 0 && buffer.byteLength === buffer.buffer.byteLength) {
    return new Uint8Array(buffer.buffer);
  }
  return Uint8Array.from(buffer);
}

function enqueueParse(
  lane: ParserLane,
  operation: ParseOperation,
  buffer: Buffer,
  marker?: string,
  extractedVia?: string,
): Promise<unknown> {
  if (lane.queue.length + (lane.activeTask ? 1 : 0) >= lane.maxPending) {
    incrementMetric('upstream_parse_requests_total', { operation, result: 'overloaded' });
    return Promise.reject(new Error('Upstream parser is overloaded'));
  }
  const bytes = transferableBytes(buffer);
  const enqueuedAt = Date.now();
  return new Promise((resolve, reject) => {
    lane.queue.push({
      id: ++sequence,
      operation,
      bytes,
      marker,
      extractedVia,
      enqueuedAt,
      startedAt: 0,
      deadline: enqueuedAt + lane.timeoutMs,
      timer: null,
      resolve,
      reject,
    });
    updateMetrics(lane);
    dispatchNext(lane);
  });
}

function extractEmbeddedJsonSync(buffer: Buffer, marker: string) {
  const text = buffer.toString('utf8');
  const markerIndex = text.indexOf(marker);
  if (markerIndex === -1) throw new Error(`${marker} not found`);
  const start = text.indexOf('{', markerIndex);
  if (start === -1) throw new Error(`${marker} object not found`);
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return JSON.parse(text.slice(start, i + 1));
    }
  }
  throw new Error(`${marker} object was incomplete`);
}

function parseJsonBuffer(buffer: Buffer): Promise<ParsedJson> | ParsedJson {
  if (process.env.UPSTREAM_PARSE_WORKER === '0' || buffer.byteLength < PARSE_OFFLOAD_THRESHOLD_BYTES) {
    return JSON.parse(buffer.toString('utf8'));
  }
  return enqueueParse(upstreamLane, 'json', buffer) as Promise<ParsedJson>;
}

function parseEmbeddedJsonBuffer(buffer: Buffer, marker: string): Promise<ParsedJson> | ParsedJson {
  if (process.env.UPSTREAM_PARSE_WORKER === '0' || buffer.byteLength < PARSE_OFFLOAD_THRESHOLD_BYTES) {
    return extractEmbeddedJsonSync(buffer, marker);
  }
  return enqueueParse(upstreamLane, 'embedded-json', buffer, marker) as Promise<ParsedJson>;
}

function parseExtractionJsonBuffer(
  buffer: Buffer,
  extractedVia: string,
): Promise<ParsedJson> | ParsedJson {
  if (
    process.env.UPSTREAM_PARSE_WORKER === '0'
    || process.env.EXTRACTION_PARSE_WORKER === '0'
    || buffer.byteLength < EXTRACTION_PARSE_OFFLOAD_THRESHOLD_BYTES
  ) {
    const info = JSON.parse(buffer.toString('utf8'));
    info._extractedVia = extractedVia;
    return compactExtractionResult(info);
  }
  return enqueueParse(extractionLane, 'extraction-json', buffer, undefined, extractedVia) as Promise<ParsedJson>;
}

export { parseEmbeddedJsonBuffer, parseExtractionJsonBuffer, parseJsonBuffer };
