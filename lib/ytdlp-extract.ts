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

const execFileAsync = promisify(execFile);

const ALT_CLIENTS = [
  'android_vr,web_safari',
  'web_creator',
  'mweb',
  'tv',
  'ios',
];

/**
 * Level 1 & 2: yt-dlp with cookies -> browser cookies fallback.
 * @param videoId YouTube video ID
 * @param withSlot Semaphore function wrapping async work
 * @param logTag Log prefix for diagnostics
 */
async function extractViaYtdlp(videoId: string, withSlot: <T>(fn: () => Promise<T>) => Promise<T>, logTag = 'extract') {
  return withSlot(async () => {
    let stdout: string | undefined;
    try {
      const result = await execFileAsync(YTDLP_BIN, [
        ...ytdlpArgs(), '--write-auto-subs', '-j', '--', videoId
      ], { timeout: 30000, maxBuffer: 50 * 1024 * 1024 });
      if (result.stderr) console.warn(`[${logTag} ${videoId}]`, result.stderr.trim());
      stdout = result.stdout;
    } catch (err: unknown) {
      const e = err as Error & { stderr?: string };
      const msg = e.stderr || e.message || '';
      // Truly unavailable videos
      if (/live event will begin|Premieres in|is not currently live/i.test(msg)) {
        // Fetch the actual scheduled start time from Innertube (absolute, not relative)
        const scheduledStart = await fetchScheduledStart(videoId).catch(() => undefined);
        return { formats: [], duration: 0, _unavailable: msg, _permanent: true, _scheduledStart: scheduledStart };
      }
      // Bot detection -> try fresh browser cookies (Level 2)
      if (/Sign in to confirm you're not a bot|page needs to be reloaded/i.test(msg)) {
        const browserArgs = ytdlpBrowserArgs();
        if (browserArgs) {
          console.warn(`[${logTag} ${videoId}] bot detection, retrying with browser cookies`);
          try {
            const retry = await execFileAsync(YTDLP_BIN, [
              ...browserArgs, '--write-auto-subs', '-j', '--', videoId
            ], { timeout: 30000, maxBuffer: 50 * 1024 * 1024 });
            if (retry.stderr) console.warn(`[${logTag} ${videoId}]`, retry.stderr.trim());
            stdout = retry.stdout;
            void refreshCookiesFile();
          } catch (retryErr: unknown) {
            const re = retryErr as Error & { stderr?: string };
            console.warn(`[${logTag} ${videoId}] browser cookie retry failed: ${(re.stderr || re.message || '').slice(0, 200)}`);
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
        if (hasCookieFlag && isCookieError) {
          console.warn(`[${logTag} ${videoId}] cookie extraction failed, retrying without cookies`);
          try {
            const retry = await execFileAsync(YTDLP_BIN, [
              '--write-auto-subs', '-j', '--', videoId
            ], { timeout: 30000, maxBuffer: 50 * 1024 * 1024 });
            if (retry.stderr) console.warn(`[${logTag} ${videoId}]`, retry.stderr.trim());
            stdout = retry.stdout;
          } catch (retryErr: unknown) {
            const re = retryErr as Error & { stderr?: string };
            console.warn(`[${logTag} ${videoId}] no-cookie retry failed: ${(re.stderr || re.message || '').slice(0, 200)}`);
            return null;
          }
        } else {
          return null;
        }
      }
    }
    if (!stdout) return null;
    const info = JSON.parse(stdout);
    info._extractedVia = 'yt-dlp';
    return info;
  });
}

/**
 * Level 3: yt-dlp with alternative clients (no cookies).
 */
async function extractViaYtdlpAlt(videoId: string, withSlot: <T>(fn: () => Promise<T>) => Promise<T>, logTag = 'extract-alt') {
  return withSlot(async () => {
    for (const clients of ALT_CLIENTS) {
      try {
        const result = await execFileAsync(YTDLP_BIN, [
          '--no-warnings',
          '--extractor-args', 'youtube:player_client=' + clients,
          '-j', '--', videoId
        ], { timeout: 30000, maxBuffer: 50 * 1024 * 1024 });
        if (result.stderr) console.warn(`[${logTag} ${videoId}]`, result.stderr.trim());
        const info = JSON.parse(result.stdout);
        const fmts = (info.formats || []).filter(f => f.url && (!f.protocol || f.protocol === 'https' || f.protocol === 'http'));
        if (fmts.length === 0) continue;
        info._extractedVia = 'yt-dlp-alt:' + clients;
        console.log(`[${logTag} ${videoId}] ${clients} returned ${fmts.length} direct formats`);
        return info;
      } catch (err: unknown) {
        const e = err as Error & { stderr?: string };
        const msg = (e.stderr || e.message || '').toString().slice(0, 100);
        if (/Sign in to confirm|not a bot|page needs to be reloaded/i.test(msg)) {
          console.warn(`[${logTag} ${videoId}] ${clients} bot-detected, skipping remaining clients`);
          return null;
        }
        console.warn(`[${logTag} ${videoId}] ${clients} failed: ${msg}`);
      }
    }
    return null;
  });
}

export { extractViaYtdlp, extractViaYtdlpAlt };
