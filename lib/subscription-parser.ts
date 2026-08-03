import { Worker } from 'node:worker_threads';
import type { Subscription } from '../types.js';

const MAX_SUBSCRIPTION_HTML_BYTES = 10 * 1024 * 1024;
const SUBSCRIPTION_PARSE_TIMEOUT_MS = Math.max(500,
  Number(process.env.SUBSCRIPTION_PARSE_TIMEOUT_MS) || 5_000);

function textFromRuns(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const obj = value as Record<string, unknown>;
  if (typeof obj.simpleText === 'string') return obj.simpleText;
  const runs = Array.isArray(obj.runs) ? obj.runs : [];
  return runs.map((run) => {
    if (!run || typeof run !== 'object') return '';
    const text = (run as Record<string, unknown>).text;
    return typeof text === 'string' ? text : '';
  }).join('');
}

function thumbnailUrl(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const thumbnails = (value as Record<string, unknown>).thumbnails;
  if (!Array.isArray(thumbnails) || thumbnails.length === 0) return '';
  const last = thumbnails[thumbnails.length - 1];
  if (!last || typeof last !== 'object') return '';
  const url = (last as Record<string, unknown>).url;
  return typeof url === 'string' ? url : '';
}

function extractInitialData(html: string): unknown {
  const markerIndex = html.indexOf('ytInitialData');
  if (markerIndex === -1) {
    if (/ServiceLogin|accounts\.google\.com|signin/i.test(html)) {
      throw new Error('YouTube returned a sign-in page. Browser cookies were exported, but not accepted for youtube.com.');
    }
    throw new Error('Could not find subscription data in YouTube response.');
  }
  const start = html.indexOf('{', markerIndex);
  if (start === -1) throw new Error('Could not find subscription data object in YouTube response.');
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
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
      if (depth === 0) return JSON.parse(html.slice(start, i + 1));
    }
  }
  throw new Error('Subscription data object was incomplete.');
}

function subscriptionFromRenderer(renderer: Record<string, unknown>): Subscription | null {
  const channelId = renderer.channelId;
  if (typeof channelId !== 'string' || !channelId.startsWith('UC')) return null;
  return {
    channelId,
    title: textFromRuns(renderer.title) || textFromRuns(renderer.shortBylineText),
    thumbnail: thumbnailUrl(renderer.thumbnail),
    description: textFromRuns(renderer.descriptionSnippet),
  };
}

function parseSubscriptionList(data: unknown): Subscription[] {
  const byId = new Map<string, Subscription>();
  const pending: unknown[] = [data];
  while (pending.length > 0) {
    const node = pending.pop();
    if (!node || typeof node !== 'object') continue;
    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i--) pending.push(node[i]);
      continue;
    }
    const obj = node as Record<string, unknown>;
    for (const key of ['channelRenderer', 'gridChannelRenderer', 'compactChannelRenderer']) {
      const renderer = obj[key];
      if (renderer && typeof renderer === 'object') {
        const sub = subscriptionFromRenderer(renderer as Record<string, unknown>);
        if (sub && !byId.has(sub.channelId)) byId.set(sub.channelId, sub);
      }
    }
    const values = Object.values(obj);
    for (let i = values.length - 1; i >= 0; i--) pending.push(values[i]);
  }
  return [...byId.values()];
}

function parseSubscriptionHtml(html: string): Subscription[] {
  return parseSubscriptionList(extractInitialData(html));
}

function parseSubscriptionHtmlOffThread(html: string): Promise<Subscription[]> {
  if (Buffer.byteLength(html) > MAX_SUBSCRIPTION_HTML_BYTES) {
    return Promise.reject(new Error('YouTube subscription response exceeded the 10 MB limit.'));
  }
  const workerUrl = import.meta.url.endsWith('.ts')
    ? new URL('./subscription-parser-worker.ts', import.meta.url)
    : new URL('./subscription-parser-worker.js', import.meta.url);
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerUrl, { workerData: html });
    let settled = false;
    const finish = (error?: Error, subscriptions?: Subscription[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      if (error) reject(error);
      else resolve(subscriptions || []);
    };
    const timer = setTimeout(() => {
      finish(new Error('YouTube subscription response parsing timed out.'));
    }, SUBSCRIPTION_PARSE_TIMEOUT_MS);
    timer.unref?.();
    worker.once('message', (message: { subscriptions?: Subscription[]; error?: string }) => {
      if (message?.error) finish(new Error(message.error));
      else finish(undefined, message?.subscriptions || []);
    });
    worker.once('error', error => finish(error));
    worker.once('exit', code => {
      if (!settled && code !== 0) finish(new Error(`Subscription parser worker exited with code ${code}`));
    });
  });
}

export { parseSubscriptionHtml, parseSubscriptionHtmlOffThread, parseSubscriptionList };
