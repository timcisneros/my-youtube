/**
 * Subscription API routes — browser cookie fetch, cookies.txt upload,
 * Google Takeout CSV/OPML import, and unsubscribe.
 */
import { Router } from 'express';
import express from 'express';
import { spawn, execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import db from '../db.js';
import { YTDLP_BIN, availableBrowsers } from '../ytdlp.js';
import { invalidateSubCaches } from '../youtube/index.js';
import type { Subscription } from '../types.js';

const router = Router();
const dataDir = path.join(import.meta.dirname, '..', 'data');

// Export browser cookies to a temp file via yt-dlp, return path
function exportCookies(browser: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const cookiePath = path.join(dataDir, 'cookies-' + Date.now() + '.txt');
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
      reject(new Error('Cookie export timed out. Browser keyring may be inaccessible.'));
    }, 15000);
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(new Error('Failed to run yt-dlp: ' + err.message));
    });
    child.on('close', (_code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (!fs.existsSync(cookiePath)) {
        const msg = stderr.trim().split('\n').pop() || 'Cookie export failed';
        return reject(new Error(msg));
      }
      resolve(cookiePath);
    });
  });
}

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
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
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
  const visit = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const obj = node as Record<string, unknown>;
    for (const key of ['channelRenderer', 'gridChannelRenderer', 'compactChannelRenderer']) {
      const renderer = obj[key];
      if (renderer && typeof renderer === 'object') {
        const sub = subscriptionFromRenderer(renderer as Record<string, unknown>);
        if (sub && !byId.has(sub.channelId)) byId.set(sub.channelId, sub);
      }
    }
    for (const value of Object.values(obj)) visit(value);
  };
  visit(data);
  return [...byId.values()];
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
      try {
        const yt = extractInitialData(stdout);
        const subs = parseSubscriptionList(yt);
        resolve(subs);
      } catch (e) {
        reject(e instanceof Error ? e : new Error('Failed to parse YouTube response'));
      }
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

function rankBrowserSpecsForRequest(req: express.Request, specs = availableBrowsers()): string[] {
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
      cookiePath = await exportCookies(browser);
      const subs = await fetchChannelList(cookiePath);
      if (subs.length > 0) return { browser, subs };
      lastError = new Error(`${browser} did not contain subscriptions`);
    } catch (e: unknown) {
      lastError = e instanceof Error ? e : new Error(String(e));
    } finally {
      if (cookiePath) try { fs.unlinkSync(cookiePath); } catch {}
    }
  }
  throw lastError || new Error('No browser cookies found');
}

// Fetch subscriptions from browser cookies
router.post('/fetch', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not logged in' });
  const available = availableBrowsers();
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

  try {
    const { browser, subs } = await fetchSubscriptionsFromBrowserSpecs(candidates);
    if (subs.length === 0) return res.json({ imported: 0 });
    db.upsertSubscriptions(req.session.userId, subs, { fullSync: true });
    invalidateSubCaches(req.session.userId);
    res.json({ imported: subs.length, browser });
  } catch (e: unknown) {
    console.error('Subscription fetch error:', (e as Error).message);
    res.status(500).json({ error: (e as Error).message });
  }
});

// Fetch subscriptions using uploaded cookies.txt file
router.post('/fetch-cookies', express.text({ type: '*/*', limit: '1mb' }), async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not logged in' });
  const text = req.body;
  if (!text || typeof text !== 'string' || !text.includes('youtube.com')) {
    return res.status(400).json({ error: 'Invalid cookies.txt file — must contain youtube.com cookies' });
  }
  const cookiePath = path.join(dataDir, 'cookies-upload-' + Date.now() + '.txt');
  fs.writeFileSync(cookiePath, text);
  try {
    const subs = await fetchChannelList(cookiePath);
    if (subs.length === 0) return res.json({ imported: 0 });
    db.upsertSubscriptions(req.session.userId, subs, { fullSync: true });
    invalidateSubCaches(req.session.userId);
    res.json({ imported: subs.length });
  } catch (e: unknown) {
    console.error('Subscription fetch error:', (e as Error).message);
    res.status(500).json({ error: (e as Error).message });
  } finally {
    try { fs.unlinkSync(cookiePath); } catch {}
  }
});

// Import subscriptions from Google Takeout CSV or OPML
router.post('/import', express.text({ type: '*/*', limit: '2mb' }), (req, res) => {
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

  db.upsertSubscriptions(req.session.userId, subs, { fullSync: true });
  invalidateSubCaches(req.session.userId);
  res.json({ imported: subs.length });
});

// Unsubscribe from a channel
router.delete('/:channelId', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not logged in' });
  const { channelId } = req.params;
  if (!/^UC[A-Za-z0-9_-]{22}$/.test(channelId)) return res.status(400).json({ error: 'Invalid channel ID' });
  db.deleteSubscription(req.session.userId, channelId);
  invalidateSubCaches(req.session.userId);
  res.status(204).end();
});

export default router;
export { exportCookies, parseSubscriptionList, rankBrowserSpecsForRequest };
