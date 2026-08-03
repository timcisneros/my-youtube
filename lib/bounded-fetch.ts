/**
 * Fetch with separate response-header and renewable response-body idle
 * deadlines. Native fetch resolves as soon as headers arrive, which otherwise
 * lets a stalled JSON/image body pin a request indefinitely.
 */
import { parseJsonBuffer } from './upstream-parser.js';

interface BoundedFetchOptions {
  headerTimeoutMs?: number;
  bodyIdleMs?: number;
}

async function readBodyBounded(response: Response, maxBytes: number, label = 'upstream-body-too-large') {
  const limit = Math.max(1024, maxBytes);
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel(label).catch(() => {});
    throw new Error(label);
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > limit) {
      await reader.cancel(label).catch(() => {});
      throw new Error(label);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, bytes);
}

async function readTextBounded(response: Response, maxBytes: number, label?: string) {
  return (await readBodyBounded(response, maxBytes, label)).toString('utf8');
}

async function readJsonBounded(response: Response, maxBytes: number, label?: string) {
  return parseJsonBuffer(await readBodyBounded(response, maxBytes, label));
}

import { incrementMetric, observeMetric } from './performance-metrics.js';

function upstreamHostLabel(hostname: string) {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (host === 'googlevideo.com' || host.endsWith('.googlevideo.com')) return 'youtube_media';
  if (host === 'ytimg.com' || host.endsWith('.ytimg.com')) return 'youtube_image';
  if (host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtu.be') return 'youtube';
  if (host === 'googleapis.com' || host.endsWith('.googleapis.com')) return 'youtube_api';
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return 'local';
  // Third-party extractor instances and future upstreams intentionally share
  // one bounded label. Raw hostnames (especially Googlevideo POP names) can
  // otherwise consume the entire metric-series budget.
  return 'other';
}

async function fetchWithBodyTimeout(
  url: string | URL,
  init: RequestInit = {},
  options: BoundedFetchOptions = {},
): Promise<Response> {
  const headerTimeoutMs = options.headerTimeoutMs || 10_000;
  const bodyIdleMs = options.bodyIdleMs || 10_000;
  const externalSignal = init.signal;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const arm = (timeoutMs: number, reason: string) => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(new Error(reason)), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
  };
  const abortFromExternal = () => controller.abort(externalSignal?.reason);
  if (externalSignal) {
    if (externalSignal.aborted) abortFromExternal();
    else externalSignal.addEventListener('abort', abortFromExternal, { once: true });
  }
  const cleanup = () => {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', abortFromExternal);
  };

  arm(headerTimeoutMs, 'upstream-header-timeout');
  const startedAt = performance.now();
  const host = upstreamHostLabel(new URL(url).hostname);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    incrementMetric('upstream_fetch_total', { host, status: `${Math.floor(response.status / 100)}xx` });
    if (!response.body) {
      cleanup();
      return response;
    }
    const reader = response.body.getReader();
    arm(bodyIdleMs, 'upstream-body-idle-timeout');
    const body = new ReadableStream<Uint8Array>({
      async pull(streamController) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            cleanup();
            streamController.close();
            return;
          }
          arm(bodyIdleMs, 'upstream-body-idle-timeout');
          streamController.enqueue(value);
        } catch (err) {
          cleanup();
          streamController.error(err);
        }
      },
      async cancel(reason) {
        cleanup();
        controller.abort(reason);
        await reader.cancel(reason).catch(() => {});
      },
    });
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } catch (err) {
    cleanup();
    incrementMetric('upstream_fetch_total', { host, status: 'error' });
    throw err;
  } finally {
    observeMetric('upstream_fetch_headers_duration_seconds', (performance.now() - startedAt) / 1000, { host });
  }
}

export { fetchWithBodyTimeout, readBodyBounded, readJsonBounded, readTextBounded, upstreamHostLabel };
export type { BoundedFetchOptions };
