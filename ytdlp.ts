import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { createRequire } from 'node:module';
import { promisify } from 'util';
import { randomUUID } from 'node:crypto';
import { acquireLock, releaseLock, renewLock } from './lib/cache.js';
import { projectPath } from './lib/project-paths.js';
const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
let developmentYtdlpBin = '';
try {
  developmentYtdlpBin = require('youtube-dl-exec').constants?.YOUTUBE_DL_PATH || '';
} catch {
  // Production installs use the operator/container-managed yt-dlp binary.
}

const COOKIES_FILE = projectPath('cookies.txt');
const BROWSER = process.env.YT_COOKIES_FROM_BROWSER || '';
const YTDLP_BIN = process.env.YTDLP_BIN || developmentYtdlpBin || 'yt-dlp';
const home = os.homedir();

// Known browser cookie DB locations. Chromium-compatible apps can use an
// absolute profile path with yt-dlp's chromium browser backend.
const CHROMIUM_ROOTS = [
  { browser: 'brave', root: path.join(home, '.config/BraveSoftware/Brave-Browser') },
  { browser: 'chrome', root: path.join(home, '.config/google-chrome') },
  { browser: 'chromium', root: path.join(home, '.config/chromium') },
  { browser: 'edge', root: path.join(home, '.config/microsoft-edge') },
  { browser: 'chromium', root: path.join(home, '.config/net.imput.helium') },
];

const FIREFOX_ROOT = path.join(home, '.mozilla/firefox');

// Sanitize existing cookies.txt on startup
if (fs.existsSync(COOKIES_FILE)) {
  try {
    const raw = fs.readFileSync(COOKIES_FILE, 'utf8');
    const clean = raw.split('\n').filter(line => {
      if (!line || line.startsWith('#') || line.startsWith('//')) return true;
      return line.split('\t').length === 7;
    }).join('\n');
    if (clean !== raw) {
      fs.writeFileSync(COOKIES_FILE, clean);
      console.log('[ytdlp] sanitized cookies.txt (removed malformed entries)');
    }
  } catch {}
}

function ytdlpArgs() {
  const args = ['--no-warnings', '--user-agent', 'Mozilla/5.0'];
  if (fs.existsSync(COOKIES_FILE)) {
    args.push('--cookies', COOKIES_FILE);
  } else if (BROWSER) {
    args.push('--cookies-from-browser', BROWSER);
  }
  return args;
}

const BROWSER_DISCOVERY_TTL_MS = Math.max(5_000,
  Number(process.env.BROWSER_DISCOVERY_TTL_MS) || 60_000);
let browserDiscoveryCache: { specs: string[]; expiresAt: number } | null = null;
let browserDiscoveryInflight: Promise<string[]> | null = null;

async function chromiumBrowserSpecs() {
  const specs: string[] = [];
  const seen = new Set<string>();
  await Promise.all(CHROMIUM_ROOTS.map(async candidate => {
    let entries: fs.Dirent[] = [];
    try {
      entries = await fs.promises.readdir(candidate.root, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(entries.filter(entry => entry.isDirectory()).map(async entry => {
      const profilePath = path.join(candidate.root, entry.name);
      try {
        await fs.promises.access(path.join(profilePath, 'Cookies'));
      } catch {
        return;
      }
      const spec = entry.name === 'Default' && !candidate.root.includes('net.imput.helium')
        ? candidate.browser
        : `${candidate.browser}:${profilePath}`;
      if (!seen.has(spec)) {
        seen.add(spec);
        specs.push(spec);
      }
    }));
  }));
  return specs;
}

// Which browsers/profiles have accessible cookie databases
async function availableBrowsers() {
  if (browserDiscoveryCache && browserDiscoveryCache.expiresAt > Date.now()) {
    return [...browserDiscoveryCache.specs];
  }
  if (browserDiscoveryInflight !== null) return browserDiscoveryInflight.then(specs => [...specs]);
  browserDiscoveryInflight = Promise.all([
    chromiumBrowserSpecs(),
    fs.promises.access(FIREFOX_ROOT).then(() => true, () => false),
  ]).then(([specs, hasFirefox]) => {
    if (hasFirefox) specs.push('firefox');
    specs.sort();
    browserDiscoveryCache = { specs, expiresAt: Date.now() + BROWSER_DISCOVERY_TTL_MS };
    return specs;
  }).finally(() => {
    browserDiscoveryInflight = null;
  });
  return browserDiscoveryInflight.then(specs => [...specs]);
}

// Args using fresh browser cookies (bypasses stale cookies.txt).
// Returns base args array or null if no browser is available.
async function ytdlpBrowserArgs() {
  if (BROWSER) return ['--no-warnings', '--user-agent', 'Mozilla/5.0', '--cookies-from-browser', BROWSER];
  const available = await availableBrowsers();
  if (available.length === 0) return null;
  return ['--no-warnings', '--user-agent', 'Mozilla/5.0', '--cookies-from-browser', available[0]];
}

// Refresh cookies.txt from the best available browser (fire-and-forget).
// Called automatically when bot detection triggers a successful browser-cookie retry.
let _refreshing = false;
interface CookieRefreshOptions {
  signal?: AbortSignal;
  withSlot?: <T>(task: () => Promise<T>, options?: { signal?: AbortSignal; priority?: string }) => Promise<T>;
}

async function refreshCookiesFile(options: CookieRefreshOptions = {}) {
  if (_refreshing) return false;
  const available = await availableBrowsers();
  if (available.length === 0) return false;
  const lockKey = 'cookie-file-refresh';
  const lockToken = await acquireLock(lockKey, 45_000);
  if (!lockToken) return false;
  if (_refreshing) {
    await releaseLock(lockKey, lockToken);
    return false;
  }
  _refreshing = true;
  const tmpPath = `${COOKIES_FILE}.tmp-${process.pid}-${randomUUID()}`;
  const renewTimer = setInterval(() => {
    void renewLock(lockKey, lockToken, 45_000);
  }, 15_000);
  renewTimer.unref?.();
  try {
    const task = () => execFileAsync(YTDLP_BIN, [
        '--cookies-from-browser', available[0],
        '--cookies', tmpPath,
        '--skip-download', '--', 'dQw4w9WgXcQ'
      ], { timeout: 15000, signal: options.signal });
    if (options.withSlot) await options.withSlot(task, { priority: 'background', signal: options.signal });
    else await task();
    try {
      await fs.promises.access(tmpPath);
      // Sanitize: yt-dlp sometimes concatenates multiple cookie entries on one line.
      // Keep only lines with exactly 7 tab-separated fields (valid Netscape format)
      // and comment/blank lines.
      const raw = await fs.promises.readFile(tmpPath, 'utf8');
      const clean = raw.split('\n').filter(line => {
        if (!line || line.startsWith('#') || line.startsWith('//')) return true;
        return line.split('\t').length === 7;
      }).join('\n');
      await fs.promises.writeFile(tmpPath, clean);
      await fs.promises.rename(tmpPath, COOKIES_FILE);
      console.log(`[ytdlp] cookies.txt refreshed from ${available[0]}`);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return false;
    }
  } catch (err) {
    console.warn('[ytdlp] cookie refresh failed:', (err as Error).message);
    return false;
  } finally {
    clearInterval(renewTimer);
    await fs.promises.rm(tmpPath, { force: true }).catch(() => {});
    _refreshing = false;
    await releaseLock(lockKey, lockToken);
  }
}

// Check yt-dlp version on startup
execFile(YTDLP_BIN, ['--version'], { timeout: 5000 }, (err, stdout) => {
  if (err) { console.warn('[ytdlp] Could not check yt-dlp version:', err.message); return; }
  const version = (stdout || '').trim();
  console.log(`[ytdlp] yt-dlp version: ${version}`);
  // Warn if version is more than 90 days old
  const match = version.match(/^(\d{4})\.(\d{2})\.(\d{2})/);
  if (match) {
    const versionDate = new Date(parseInt(match[1]), parseInt(match[2]) - 1, parseInt(match[3]));
    const ageMs = Date.now() - versionDate.getTime();
    if (ageMs > 90 * 24 * 60 * 60 * 1000) {
      console.warn(`[ytdlp] WARNING: yt-dlp is ${Math.floor(ageMs / 86400000)} days old. Run "yt-dlp -U" to update.`);
    }
  }
});

export { YTDLP_BIN, ytdlpArgs, ytdlpBrowserArgs, availableBrowsers, refreshCookiesFile };
