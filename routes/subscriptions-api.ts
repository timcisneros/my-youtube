/**
 * Subscription API routes — browser cookie fetch, cookies.txt upload,
 * Google Takeout CSV/OPML import, and unsubscribe.
 */
import { Router } from 'express';
import express from 'express';
import { spawn, execFile } from 'child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'fs';
import path from 'path';
import db from '../db.js';
import { YTDLP_BIN, availableBrowsers } from '../ytdlp.js';
import { invalidateSubCaches } from '../youtube/index.js';
import type { Subscription } from '../types.js';
import { withYtdlpSlot } from './stream/shared.js';
import { acquireLock, releaseLock, renewLock } from '../lib/cache.js';
import { parseSubscriptionHtmlOffThread, parseSubscriptionList } from '../lib/subscription-parser.js';
import { projectPath } from '../lib/project-paths.js';

const router = Router();
const dataDir = projectPath('data');
const browserFetchInflight = new Set<string>();

// Export browser cookies to a temp file via yt-dlp, return path
function exportCookies(browser: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const cookiePath = path.join(dataDir, `cookies-${randomUUID()}.txt`);
    const child = spawn(YTDLP_BIN, [
      '--cookies-from-browser', browser,
      '--cookies', cookiePath,
      '--skip-download', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      child.kill('SIGKILL');
      void fs.rm(cookiePath, { force: true }).catch(() => {});
      reject(new Error('Cookie export timed out. Browser keyring may be inaccessible.'));
    }, 15000);
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      void fs.rm(cookiePath, { force: true }).catch(() => {});
      reject(new Error('Failed to run yt-dlp: ' + err.message));
    });
    child.on('close', (_code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      void fs.access(cookiePath).then(() => {
        resolve(cookiePath);
      }, () => {
        const msg = stderr.trim().split('\n').pop() || 'Cookie export failed';
        reject(new Error(msg));
      });
    });
  });
}

// Fetch youtube.com/feed/channels via curl with cookie jar, parse channels from ytInitialData
function fetchChannelList(cookiePath: string): Promise<Subscription[]> {
  return new Promise((resolve, reject) => {
    execFile('curl', [
      '-s', '-L', '--compressed', '-b', cookiePath,
      '-H', 'User-Agent: Mozilla/5.0',
      '-H', 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      '-H', 'Accept-Language: *',
      'https://www.youtube.com/feed/channels'
    ], { timeout: 15000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(new Error('Failed to fetch YouTube: ' + err.message));
      parseSubscriptionHtmlOffThread(stdout).then(resolve, (e) => {
        reject(e instanceof Error ? e : new Error('Failed to parse YouTube response'));
      });
    });
  });
}

const ALLOWED_BROWSERS = ['firefox','chrome','chromium','brave','edge','opera','vivaldi'];

function browserBase(browserSpec: string): string {
  return browserSpec.split(':', 1)[0].split('+', 1)[0].toLowerCase();
}

function requestBrowserHints(req: express.Request): string {
  return [
    req.headers['user-agent'],
    req.headers['sec-ch-ua'],
    req.headers['sec-ch-ua-platform'],
  ].filter(Boolean).join(' ').toLowerCase();
}

function rankBrowserSpecsForRequest(req: express.Request, specs: string[] = []): string[] {
  const hints = requestBrowserHints(req);
  const desired: string[] = [];
  if (hints.includes('firefox')) desired.push('firefox');
  if (hints.includes('edg')) desired.push('edge');
  if (hints.includes('brave')) desired.push('brave');
  if (hints.includes('chrome')) desired.push('chrome');
  if (hints.includes('chromium') || hints.includes('chrome') || hints.includes('helium')) desired.push('chromium');

  return [...specs].sort((a, b) => {
    const aBase = browserBase(a);
    const bBase = browserBase(b);
    let aScore = desired.includes(aBase) ? 100 : 0;
    let bScore = desired.includes(bBase) ? 100 : 0;
    if (hints.includes('helium') && a.includes('net.imput.helium')) aScore += 50;
    if (hints.includes('helium') && b.includes('net.imput.helium')) bScore += 50;
    if (a.includes(':')) aScore += 1;
    if (b.includes(':')) bScore += 1;
    return bScore - aScore;
  });
}

async function fetchSubscriptionsFromBrowserSpecs(specs: string[]) {
  let lastError: Error | null = null;
  for (const browser of specs) {
    let cookiePath: string | undefined;
    try {
      const result = await withYtdlpSlot(async () => {
        cookiePath = await exportCookies(browser);
        return fetchChannelList(cookiePath);
      }, { priority: 'background' });
      const subs = result;
      if (subs.length > 0) return { browser, subs };
      lastError = new Error(`${browser} did not contain subscriptions`);
    } catch (e: unknown) {
      lastError = e instanceof Error ? e : new Error(String(e));
    } finally {
      if (cookiePath) await fs.rm(cookiePath, { force: true }).catch(() => {});
    }
  }
  throw lastError || new Error('No browser cookies found');
}

// Fetch subscriptions from browser cookies
router.post('/fetch', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not logged in' });
  const available = await availableBrowsers();
  const requestedBrowser = typeof req.body?.browser === 'string' ? req.body.browser : '';
  let candidates: string[];
  if (requestedBrowser) {
    if (!ALLOWED_BROWSERS.includes(browserBase(requestedBrowser))) {
      return res.status(400).json({ error: 'Invalid browser. Allowed: ' + ALLOWED_BROWSERS.join(', ') });
    }
    if (!available.includes(requestedBrowser)) {
      return res.status(400).json({ error: requestedBrowser + ' cookies not found. Available: ' + (available.join(', ') || 'none') });
    }
    candidates = [requestedBrowser];
  } else {
    candidates = rankBrowserSpecsForRequest(req, available);
    if (candidates.length === 0) return res.status(400).json({ error: 'No browser cookies found' });
  }

  const fetchKey = String(req.session.userId);
  if (browserFetchInflight.has(fetchKey)) return res.status(409).json({ error: 'Subscription import already in progress' });
  const lockKey = `subscription-browser-fetch:${fetchKey}`;
  const lockToken = await acquireLock(lockKey, 45_000);
  if (!lockToken) return res.status(409).json({ error: 'Subscription import already in progress' });
  browserFetchInflight.add(fetchKey);
  const renewTimer = setInterval(() => { void renewLock(lockKey, lockToken, 45_000); }, 15_000);
  renewTimer.unref?.();
  try {
    const { browser, subs } = await fetchSubscriptionsFromBrowserSpecs(candidates);
    if (subs.length === 0) return res.json({ imported: 0 });
    await db.upsertSubscriptions(req.session.userId, subs, { fullSync: true });
    await invalidateSubCaches(req.session.userId);
    res.json({ imported: subs.length, browser });
  } catch (e: unknown) {
    console.error('Subscription fetch error:', (e as Error).message);
    res.status(500).json({ error: (e as Error).message });
  } finally {
    clearInterval(renewTimer);
    browserFetchInflight.delete(fetchKey);
    await releaseLock(lockKey, lockToken);
  }
});

// Fetch subscriptions using uploaded cookies.txt file
router.post('/fetch-cookies', express.text({ type: '*/*', limit: '1mb' }), async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not logged in' });
  const text = req.body;
  if (!text || typeof text !== 'string' || !text.includes('youtube.com')) {
    return res.status(400).json({ error: 'Invalid cookies.txt file — must contain youtube.com cookies' });
  }
  const cookiePath = path.join(dataDir, `cookies-upload-${randomUUID()}.txt`);
  await fs.writeFile(cookiePath, text);
  try {
    const subs = await withYtdlpSlot(() => fetchChannelList(cookiePath), { priority: 'background' });
    if (subs.length === 0) return res.json({ imported: 0 });
    await db.upsertSubscriptions(req.session.userId, subs, { fullSync: true });
    await invalidateSubCaches(req.session.userId);
    res.json({ imported: subs.length });
  } catch (e: unknown) {
    console.error('Subscription fetch error:', (e as Error).message);
    res.status(500).json({ error: (e as Error).message });
  } finally {
    await fs.rm(cookiePath, { force: true }).catch(() => {});
  }
});

// Import subscriptions from Google Takeout CSV or OPML
router.post('/import', express.text({ type: '*/*', limit: '2mb' }), async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not logged in' });
  const text = req.body;
  if (!text || typeof text !== 'string') return res.status(400).json({ error: 'No data' });

  const subs: Subscription[] = [];

  if (text.trim().startsWith('<')) {
    // OPML format: <outline xmlUrl="..." title="..." />
    const outlineRe = /<outline[^>]*>/gi;
    let match;
    while ((match = outlineRe.exec(text)) !== null) {
      const line = match[0];
      const xmlUrl = (line.match(/xmlUrl="([^"]*)"/i) || [])[1] || '';
      const title = (line.match(/title="([^"]*)"/i) || (line.match(/text="([^"]*)"/i)) || [])[1] || '';
      const channelId = (xmlUrl.match(/channel_id=([A-Za-z0-9_-]+)/) || [])[1];
      if (channelId) subs.push({ channelId, title, thumbnail: '', description: '' });
    }
  } else {
    // CSV format: Channel Id,Channel Url,Channel Title (Google Takeout)
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
      // Skip header and empty lines
      if (!line.trim() || /^channel\s*id/i.test(line)) continue;
      // Parse CSV - handle quoted fields
      const parts: string[] = [];
      let current = '', inQuote = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') { inQuote = !inQuote; }
        else if (ch === ',' && !inQuote) { parts.push(current.trim()); current = ''; }
        else { current += ch; }
      }
      parts.push(current.trim());
      const [channelId, , title] = parts;
      if (channelId && /^UC[A-Za-z0-9_-]{22}$/.test(channelId)) {
        subs.push({ channelId, title: title || '', thumbnail: '', description: '' });
      }
    }
  }

  if (subs.length === 0) return res.status(400).json({ error: 'No valid subscriptions found in file' });

  await db.upsertSubscriptions(req.session.userId, subs, { fullSync: true });
  await invalidateSubCaches(req.session.userId);
  res.json({ imported: subs.length });
});

// Unsubscribe from a channel
router.delete('/:channelId', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not logged in' });
  const { channelId } = req.params;
  if (!/^UC[A-Za-z0-9_-]{22}$/.test(channelId)) return res.status(400).json({ error: 'Invalid channel ID' });
  await db.deleteSubscription(req.session.userId, channelId);
  await invalidateSubCaches(req.session.userId);
  res.status(204).end();
});

export default router;
export { exportCookies, parseSubscriptionList, rankBrowserSpecsForRequest };
