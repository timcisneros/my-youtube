import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { createRequire } from 'module';
import { promisify } from 'util';
const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const { constants: ytdlpConstants } = require('youtube-dl-exec') as { constants: { YOUTUBE_DL_PATH?: string } };

const COOKIES_FILE = path.join(import.meta.dirname, 'cookies.txt');
const BROWSER = process.env.YT_COOKIES_FROM_BROWSER || '';
const YTDLP_BIN = process.env.YTDLP_BIN || ytdlpConstants.YOUTUBE_DL_PATH || 'yt-dlp';
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

function chromiumBrowserSpecs() {
  const specs: string[] = [];
  const seen = new Set<string>();
  for (const candidate of CHROMIUM_ROOTS) {
    if (!fs.existsSync(candidate.root)) continue;
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(candidate.root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const profilePath = path.join(candidate.root, entry);
      if (!fs.existsSync(path.join(profilePath, 'Cookies'))) continue;
      const spec = entry === 'Default' && !candidate.root.includes('net.imput.helium')
        ? candidate.browser
        : `${candidate.browser}:${profilePath}`;
      if (!seen.has(spec)) {
        seen.add(spec);
        specs.push(spec);
      }
    }
  }
  return specs;
}

// Which browsers/profiles have accessible cookie databases
function availableBrowsers() {
  const specs = chromiumBrowserSpecs();
  if (fs.existsSync(FIREFOX_ROOT)) specs.push('firefox');
  return specs;
}

// Args using fresh browser cookies (bypasses stale cookies.txt).
// Returns base args array or null if no browser is available.
function ytdlpBrowserArgs() {
  if (BROWSER) return ['--no-warnings', '--user-agent', 'Mozilla/5.0', '--cookies-from-browser', BROWSER];
  const available = availableBrowsers();
  if (available.length === 0) return null;
  return ['--no-warnings', '--user-agent', 'Mozilla/5.0', '--cookies-from-browser', available[0]];
}

// Refresh cookies.txt from the best available browser (fire-and-forget).
// Called automatically when bot detection triggers a successful browser-cookie retry.
let _refreshing = false;
async function refreshCookiesFile() {
  if (_refreshing) return;
  const available = availableBrowsers();
  if (available.length === 0) return;
  _refreshing = true;
  try {
    const tmpPath = COOKIES_FILE + '.tmp';
    await execFileAsync(YTDLP_BIN, [
      '--cookies-from-browser', available[0],
      '--cookies', tmpPath,
      '--skip-download', '--', 'dQw4w9WgXcQ'
    ], { timeout: 15000 });
    if (fs.existsSync(tmpPath)) {
      // Sanitize: yt-dlp sometimes concatenates multiple cookie entries on one line.
      // Keep only lines with exactly 7 tab-separated fields (valid Netscape format)
      // and comment/blank lines.
      const raw = fs.readFileSync(tmpPath, 'utf8');
      const clean = raw.split('\n').filter(line => {
        if (!line || line.startsWith('#') || line.startsWith('//')) return true;
        return line.split('\t').length === 7;
      }).join('\n');
      fs.writeFileSync(tmpPath, clean);
      fs.renameSync(tmpPath, COOKIES_FILE);
      console.log(`[ytdlp] cookies.txt refreshed from ${available[0]}`);
    }
  } catch (err) {
    console.warn('[ytdlp] cookie refresh failed:', err.message);
    try { fs.unlinkSync(COOKIES_FILE + '.tmp'); } catch {}
  } finally {
    _refreshing = false;
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
