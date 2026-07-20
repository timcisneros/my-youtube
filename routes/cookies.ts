/**
 * Cookie management routes — browser detection, refresh, upload.
 */
import { Router } from 'express';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { exportCookies, rankBrowserSpecsForRequest } from './subscriptions-api.js';
import { availableBrowsers, refreshCookiesFile } from '../ytdlp.js';

const router = Router();

const ALLOWED_BROWSERS = ['firefox','chrome','chromium','brave','edge','opera','vivaldi'];

function browserBase(browserSpec: string): string {
  return browserSpec.split(':', 1)[0].split('+', 1)[0].toLowerCase();
}

// Available browsers for cookie extraction
router.get('/browsers', (_req, res) => {
  res.json(availableBrowsers());
});

// Auto-refresh cookies from best available browser (used by player retry)
router.post('/refresh-auto', async (_req, res) => {
  try {
    await refreshCookiesFile();
    res.json({ ok: true });
  } catch (e: unknown) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// Refresh yt-dlp cookies from browser
router.post('/refresh', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not logged in' });
  const browser = typeof req.body?.browser === 'string' ? req.body.browser : '';
  const available = availableBrowsers();
  let candidates: string[];
  if (browser) {
    if (!ALLOWED_BROWSERS.includes(browserBase(browser))) {
      return res.status(400).json({ error: 'Invalid browser. Allowed: ' + ALLOWED_BROWSERS.join(', ') });
    }
    if (!available.includes(browser)) {
      return res.status(400).json({ error: browser + ' cookies not found. Available: ' + (available.join(', ') || 'none') });
    }
    candidates = [browser];
  } else {
    candidates = rankBrowserSpecsForRequest(req, available);
    if (candidates.length === 0) return res.status(400).json({ error: 'No browser cookies found' });
  }
  let tempPath: string | undefined;
  try {
    let lastError: Error | null = null;
    for (const candidate of candidates) {
      try {
        tempPath = await exportCookies(candidate);
        break;
      } catch (e: unknown) {
        lastError = e instanceof Error ? e : new Error(String(e));
      }
    }
    if (!tempPath) throw lastError || new Error('No browser cookies found');
    fs.copyFileSync(tempPath, path.join(import.meta.dirname, '..', 'cookies.txt'));
    res.json({ ok: true });
  } catch (e: unknown) {
    console.error('Cookie refresh error:', (e as Error).message);
    res.status(500).json({ error: (e as Error).message });
  } finally {
    if (tempPath) try { fs.unlinkSync(tempPath); } catch {}
  }
});

// Upload cookies.txt for yt-dlp
router.post('/upload', express.text({ type: '*/*', limit: '1mb' }), (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not logged in' });
  const text = req.body;
  if (!text || typeof text !== 'string' || !text.includes('youtube.com')) {
    return res.status(400).json({ error: 'Invalid cookies.txt — must contain youtube.com cookies' });
  }
  fs.writeFileSync(path.join(import.meta.dirname, '..', 'cookies.txt'), text);
  res.json({ ok: true });
});

export default router;
