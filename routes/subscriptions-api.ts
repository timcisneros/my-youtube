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
import { availableBrowsers } from '../ytdlp.js';
import { invalidateSubCaches } from '../youtube/index.js';
import type { Subscription } from '../types.js';

const router = Router();
const dataDir = path.join(import.meta.dirname, '..', 'data');

// Export browser cookies to a temp file via yt-dlp, return path
function exportCookies(browser: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const cookiePath = path.join(dataDir, 'cookies-' + Date.now() + '.txt');
    const child = spawn('yt-dlp', [
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

// Fetch youtube.com/feed/channels via curl with cookie jar, parse channels from ytInitialData
function fetchChannelList(cookiePath: string): Promise<Subscription[]> {
  return new Promise((resolve, reject) => {
    execFile('curl', [
      '-s', '-L', '-b', cookiePath,
      '-H', 'User-Agent: Mozilla/5.0',
      '-H', 'Accept-Language: *',
      'https://www.youtube.com/feed/channels'
    ], { timeout: 15000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(new Error('Failed to fetch YouTube: ' + err.message));
      try {
        const m = stdout.match(/var ytInitialData = ({.*?});<\/script>/);
        if (!m) return reject(new Error('Could not find subscription data. Are you logged into YouTube in this browser?'));
        const yt = JSON.parse(m[1]);
        const subs: Subscription[] = [];
        const tabs = yt.contents?.twoColumnBrowseResultsRenderer?.tabs || [];
        for (const tab of tabs) {
          const sections = tab.tabRenderer?.content?.sectionListRenderer?.contents || [];
          for (const section of sections) {
            const items = section.itemSectionRenderer?.contents || [];
            for (const item of items) {
              const entries = item.shelfRenderer?.content?.expandedShelfContentsRenderer?.items || [];
              for (const entry of entries) {
                const ch = entry.channelRenderer;
                if (!ch?.channelId) continue;
                const thumbs = ch.thumbnail?.thumbnails || [];
                subs.push({
                  channelId: ch.channelId,
                  title: ch.title?.simpleText || '',
                  thumbnail: thumbs.length ? thumbs[thumbs.length - 1].url : '',
                  description: ch.descriptionSnippet?.runs?.map(r => r.text).join('') || ''
                });
              }
            }
          }
        }
        resolve(subs);
      } catch (e) {
        reject(new Error('Failed to parse YouTube response'));
      }
    });
  });
}

const ALLOWED_BROWSERS = ['firefox','chrome','chromium','brave','edge','opera','vivaldi'];

// Fetch subscriptions from browser cookies
router.post('/fetch', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not logged in' });
  const browser = (req.body.browser || '').toLowerCase();
  if (!ALLOWED_BROWSERS.includes(browser)) {
    return res.status(400).json({ error: 'Invalid browser. Allowed: ' + ALLOWED_BROWSERS.join(', ') });
  }
  const available = availableBrowsers();
  if (!available.includes(browser)) {
    return res.status(400).json({ error: browser + ' cookies not found. Available: ' + (available.join(', ') || 'none') });
  }
  let cookiePath: string | undefined;
  try {
    cookiePath = await exportCookies(browser);
    const subs = await fetchChannelList(cookiePath);
    if (subs.length === 0) return res.json({ imported: 0 });
    db.upsertSubscriptions(req.session.userId, subs);
    res.json({ imported: subs.length });
  } catch (e: unknown) {
    console.error('Subscription fetch error:', (e as Error).message);
    res.status(500).json({ error: (e as Error).message });
  } finally {
    if (cookiePath) try { fs.unlinkSync(cookiePath); } catch {}
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
    db.upsertSubscriptions(req.session.userId, subs);
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

  db.upsertSubscriptions(req.session.userId, subs);
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
export { exportCookies };
