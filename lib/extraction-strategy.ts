/**
 * Bounded extraction strategy shared by web and worker processes.
 *
 * The primary yt-dlp path gets an exclusive head start. If it fails, the
 * independent fallbacks are hedged with a small stagger and the first usable
 * result wins; losing work is aborted. This caps the previous multi-minute
 * serial failure path without launching every backend for healthy videos.
 */
import { extractViaInnertube, extractViaInvidious } from '../extractors.js';
import { extractViaYtdlp, extractViaYtdlpAlt } from './ytdlp-extract.js';
import type { SlotRunner } from './ytdlp-extract.js';

const configuredDeadline = parseInt(process.env.EXTRACTION_DEADLINE_MS || '', 10);
const EXTRACTION_DEADLINE_MS = Number.isFinite(configuredDeadline)
  ? Math.max(30_000, Math.min(180_000, configuredDeadline))
  : 75_000;
const FALLBACK_STAGGER_MS = 300;

interface ExtractionStrategyOptions {
  deadlineMs?: number;
  priority?: 'playback' | 'background' | 'prefetch';
  signal?: AbortSignal;
  onStep?: (step: string) => void;
  logTag?: string;
}

function abortableDelay(ms: number, signal: AbortSignal) {
  if (ms <= 0 || signal.aborted) return Promise.resolve(!signal.aborted);
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      resolve(false);
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function makeChildController(parent: AbortSignal) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (parent.aborted) controller.abort();
  else parent.addEventListener('abort', abort, { once: true });
  return {
    controller,
    cleanup: () => parent.removeEventListener('abort', abort),
  };
}

function usable(info) {
  return !!(info && (info._permanent || (Array.isArray(info.formats) && info.formats.length > 0)));
}

async function firstUsable<T>(
  strategies: Array<{ delayMs: number; run: (signal: AbortSignal) => Promise<T> }>,
  signal: AbortSignal,
): Promise<T | null> {
  if (!strategies.length || signal.aborted) return null;
  return new Promise((resolve) => {
    let remaining = strategies.length;
    let settled = false;
    const children = strategies.map(() => makeChildController(signal));
    const onParentAbort = () => finish(null);

    function finish(value: T | null, winner = -1) {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onParentAbort);
      children.forEach((child, index) => {
        if (index !== winner) child.controller.abort();
        child.cleanup();
      });
      resolve(value);
    }

    strategies.forEach((strategy, index) => {
      const child = children[index];
      void (async () => {
        const ready = await abortableDelay(strategy.delayMs, child.controller.signal);
        if (!ready) return null;
        return strategy.run(child.controller.signal);
      })().then((result) => {
        if (usable(result)) finish(result, index);
      }).catch(() => null).finally(() => {
        remaining--;
        if (remaining === 0) finish(null);
      });
    });

    signal.addEventListener('abort', onParentAbort, { once: true });
  });
}

async function extractWithStrategy(videoId: string, withSlot: SlotRunner, options: ExtractionStrategyOptions = {}) {
  const startedAt = Date.now();
  const deadlineMs = Math.max(1, options.deadlineMs || EXTRACTION_DEADLINE_MS);
  const deadlineAt = startedAt + deadlineMs;
  const controller = new AbortController();
  const abortFromParent = () => controller.abort();
  if (options.signal) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener('abort', abortFromParent, { once: true });
  }
  const deadlineTimer = setTimeout(() => controller.abort(), deadlineMs);
  if (typeof deadlineTimer.unref === 'function') deadlineTimer.unref();
  const attemptOptions = {
    signal: controller.signal,
    deadlineAt,
    priority: options.priority || 'playback',
  } as const;
  const logTag = options.logTag || 'extract';

  try {
    options.onStep?.('yt-dlp');
    const primaryStartedAt = Date.now();
    const primary = await extractViaYtdlp(videoId, withSlot, logTag, attemptOptions);
    const primaryMs = Date.now() - primaryStartedAt;
    if (usable(primary)) {
      primary._extractionTimings = { totalMs: Date.now() - startedAt, primaryMs, fallbackMs: 0, deadlineMs };
      return primary;
    }
    if (controller.signal.aborted) return null;

    const fallbackStartedAt = Date.now();
    const fallback = await firstUsable([
      {
        delayMs: 0,
        run: (signal) => {
          options.onStep?.('yt-dlp-alt');
          return extractViaYtdlpAlt(videoId, withSlot, `${logTag}-alt`, { ...attemptOptions, signal });
        },
      },
      {
        delayMs: FALLBACK_STAGGER_MS,
        run: (signal) => {
          options.onStep?.('innertube');
          return extractViaInnertube(videoId, { ...attemptOptions, signal });
        },
      },
      {
        delayMs: FALLBACK_STAGGER_MS * 2,
        run: (signal) => {
          options.onStep?.('invidious');
          return extractViaInvidious(videoId, { ...attemptOptions, signal });
        },
      },
    ], controller.signal);
    if (fallback) {
      fallback._extractionTimings = {
        totalMs: Date.now() - startedAt,
        primaryMs,
        fallbackMs: Date.now() - fallbackStartedAt,
        deadlineMs,
      };
    }
    return fallback;
  } finally {
    clearTimeout(deadlineTimer);
    if (options.signal) options.signal.removeEventListener('abort', abortFromParent);
  }
}

export { EXTRACTION_DEADLINE_MS, extractWithStrategy };
export type { ExtractionStrategyOptions };
