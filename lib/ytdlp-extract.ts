/**
 * Core yt-dlp extraction functions — shared between the web server
 * (routes/stream/extraction.ts) and the standalone worker (lib/extract.ts).
 *
 * Callers provide their own `withYtdlpSlot` semaphore since the web server
 * uses a Redis-aware distributed semaphore while the worker uses a simple
 * in-process one.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import { YTDLP_BIN, ytdlpArgs, ytdlpBrowserArgs, refreshCookiesFile } from '../ytdlp.js';
import { fetchScheduledStart } from '../extractors.js';
import { parseExtractionJsonBuffer } from './upstream-parser.js';

const execFileAsync = promisify(execFile);

const ALT_CLIENTS = [
  'android_vr,web_safari',
  'web_creator',
  'mweb',
  'tv',
  'ios',
];

interface ExtractionAttemptOptions {
  signal?: AbortSignal;
  deadlineAt?: number;
  priority?: 'playback' | 'background' | 'prefetch';
}

interface ExtractionFormat {
  url?: string;
  protocol?: string;
  [key: string]: unknown;
}

interface ExtractionInfo {
  formats?: ExtractionFormat[];
  _needsScheduledStart?: boolean;
  _extractedVia?: string;
  _extractionTimings?: unknown;
  [key: string]: unknown;
}

type SlotRunner = <T>(
  fn: () => Promise<T>,
  options?: { signal?: AbortSignal; priority?: string },
) => Promise<T>;

function remainingTimeout(options: ExtractionAttemptOptions, capMs: number) {
  const remaining = options.deadlineAt ? options.deadlineAt - Date.now() : capMs;
  return Math.max(1, Math.min(capMs, remaining));
}

function canAttempt(options: ExtractionAttemptOptions) {
  return !options.signal?.aborted && (!options.deadlineAt || Date.now() < options.deadlineAt);
}

function diagnosticText(value: string | Buffer | undefined) {
  return value?.toString() || '';
}

/**
 * Level 1 & 2: yt-dlp with cookies -> browser cookies fallback.
 * @param videoId YouTube video ID
 * @param withSlot Semaphore function wrapping async work
 * @param logTag Log prefix for diagnostics
 */
async function extractViaYtdlp(
  videoId: string,
  withSlot: SlotRunner,
  logTag = 'extract',
  options: ExtractionAttemptOptions = {},
): Promise<ExtractionInfo | null> {
  if (!canAttempt(options)) return null;
  let shouldRefreshCookies = false;
  const rawResult = await withSlot(async () => {
    let stdout: Buffer | undefined;
    try {
      const result = await execFileAsync(YTDLP_BIN, [
        ...ytdlpArgs(), '--write-auto-subs', '-j', '--', videoId
      ], { timeout: remainingTimeout(options, 30000), signal: options.signal, maxBuffer: 50 * 1024 * 1024, encoding: 'buffer' });
      if (result.stderr.length) console.warn(`[${logTag} ${videoId}]`, result.stderr.toString().trim());
      stdout = result.stdout;
    } catch (err: unknown) {
      const e = err as Error & { stderr?: string | Buffer };
      const msg = diagnosticText(e.stderr) || e.message || '';
      // Truly unavailable videos
      if (/live event will begin|Premieres in|is not currently live/i.test(msg)) {
        // Resolve Innertube metadata after releasing the subprocess slot below.
        return { formats: [], duration: 0, _unavailable: msg, _permanent: true, _needsScheduledStart: true };
      }
      // Bot detection -> try fresh browser cookies (Level 2)
      if (/Sign in to confirm you're not a bot|page needs to be reloaded/i.test(msg)) {
        const browserArgs = await ytdlpBrowserArgs();
        if (browserArgs && canAttempt(options)) {
          console.warn(`[${logTag} ${videoId}] bot detection, retrying with browser cookies`);
          try {
            const retry = await execFileAsync(YTDLP_BIN, [
              ...browserArgs, '--write-auto-subs', '-j', '--', videoId
            ], { timeout: remainingTimeout(options, 15000), signal: options.signal, maxBuffer: 50 * 1024 * 1024, encoding: 'buffer' });
            if (retry.stderr.length) console.warn(`[${logTag} ${videoId}]`, retry.stderr.toString().trim());
            stdout = retry.stdout;
            shouldRefreshCookies = true;
          } catch (retryErr: unknown) {
            const re = retryErr as Error & { stderr?: string | Buffer };
            console.warn(`[${logTag} ${videoId}] browser cookie retry failed: ${(diagnosticText(re.stderr) || re.message || '').slice(0, 200)}`);
            return null;
          }
        } else {
          return null;
        }
      } else if (/rate.?limit|isn't available, try again/i.test(msg)) {
        return null;
      } else {
        // Cookie extraction problem -> retry without cookies
        const args = ytdlpArgs();
        const hasCookieFlag = args.includes('--cookies-from-browser') || args.includes('--cookies');
        const isCookieError = /could not extract cookies|cookie.*decrypt|keyring|secretstorage/i.test(msg);
        if (hasCookieFlag && isCookieError && canAttempt(options)) {
          console.warn(`[${logTag} ${videoId}] cookie extraction failed, retrying without cookies`);
          try {
            const retry = await execFileAsync(YTDLP_BIN, [
              '--write-auto-subs', '-j', '--', videoId
            ], { timeout: remainingTimeout(options, 15000), signal: options.signal, maxBuffer: 50 * 1024 * 1024, encoding: 'buffer' });
            if (retry.stderr.length) console.warn(`[${logTag} ${videoId}]`, retry.stderr.toString().trim());
            stdout = retry.stdout;
          } catch (retryErr: unknown) {
            const re = retryErr as Error & { stderr?: string | Buffer };
            console.warn(`[${logTag} ${videoId}] no-cookie retry failed: ${(diagnosticText(re.stderr) || re.message || '').slice(0, 200)}`);
            return null;
          }
        } else {
          return null;
        }
      }
    }
    if (!stdout) return null;
    return stdout;
  }, { signal: options.signal, priority: options.priority });
  // The extraction slot above is released before scheduling cookie export, so
  // a saturated pool cannot deadlock by trying to acquire itself recursively.
  if (shouldRefreshCookies) void refreshCookiesFile({ withSlot });
  let result: ExtractionInfo | null;
  if (Buffer.isBuffer(rawResult)) {
    try {
      result = await parseExtractionJsonBuffer(rawResult, 'yt-dlp') as ExtractionInfo;
    } catch (error) {
      console.warn(`[${logTag} ${videoId}] failed to parse yt-dlp output:`, (error as Error).message);
      return null;
    }
  } else {
    result = rawResult as ExtractionInfo | null;
  }
  if (result?._needsScheduledStart) {
    const { _needsScheduledStart: _, ...unavailable } = result;
    const scheduledStart = await fetchScheduledStart(videoId, options.signal).catch(() => undefined);
    return { ...unavailable, _scheduledStart: scheduledStart };
  }
  return result;
}

/**
 * Level 3: yt-dlp with alternative clients (no cookies).
 */
async function extractViaYtdlpAlt(
  videoId: string,
  withSlot: SlotRunner,
  logTag = 'extract-alt',
  options: ExtractionAttemptOptions = {},
): Promise<ExtractionInfo | null> {
  if (!canAttempt(options)) return null;
  for (const clients of ALT_CLIENTS) {
    if (!canAttempt(options)) return null;
    try {
      const stdout = await withSlot(async () => {
        const result = await execFileAsync(YTDLP_BIN, [
          '--no-warnings',
          '--extractor-args', 'youtube:player_client=' + clients,
          '-j', '--', videoId
        ], { timeout: remainingTimeout(options, 18000), signal: options.signal, maxBuffer: 50 * 1024 * 1024, encoding: 'buffer' });
        if (result.stderr.length) console.warn(`[${logTag} ${videoId}]`, result.stderr.toString().trim());
        return result.stdout;
      }, { signal: options.signal, priority: options.priority });
      const info = await parseExtractionJsonBuffer(stdout, `yt-dlp-alt:${clients}`) as ExtractionInfo;
      const fmts = (info.formats || []).filter(f => f.url && (!f.protocol || f.protocol === 'https' || f.protocol === 'http'));
      if (fmts.length === 0) continue;
      console.log(`[${logTag} ${videoId}] ${clients} returned ${fmts.length} direct formats`);
      return info;
    } catch (err: unknown) {
      const e = err as Error & { stderr?: string | Buffer };
      const msg = (diagnosticText(e.stderr) || e.message || '').slice(0, 100);
      if (/Sign in to confirm|not a bot|page needs to be reloaded/i.test(msg)) {
        console.warn(`[${logTag} ${videoId}] ${clients} bot-detected, skipping remaining clients`);
        return null;
      }
      if (options.signal?.aborted || /ytdlp-admission|request-aborted|upstream parser/i.test(msg)) return null;
      console.warn(`[${logTag} ${videoId}] ${clients} failed: ${msg}`);
    }
  }
  return null;
}

export { extractViaYtdlp, extractViaYtdlpAlt };
export type { ExtractionAttemptOptions, SlotRunner };
