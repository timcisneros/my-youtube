/**
 * Cookie management routes — browser detection, refresh, upload.
 */
import { Router } from 'express';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { exportCookies } from './subscriptions-api.js';
import { availableBrowsers, refreshCookiesFile } from '../ytdlp.js';

const router = Router();

const ALLOWED_BROWSERS = ['firefox','chrome','chromium','brave','edge','opera','vivaldi'];

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
  const browser = (req.body.browser || '').toLowerCase();
  const available = availableBrowsers();
  if (!ALLOWED_BROWSERS.includes(browser)) {
    return res.status(400).json({ error: 'Invalid browser. Allowed: ' + ALLOWED_BROWSERS.join(', ') });
  }
  if (!available.includes(browser)) {
    return res.status(400).json({ error: browser + ' cookies not found. Available: ' + (available.join(', ') || 'none') });
  }
  try {
    const tempPath = await exportCookies(browser);
    fs.copyFileSync(tempPath, path.join(import.meta.dirname, '..', 'cookies.txt'));
    fs.unlinkSync(tempPath);
    res.json({ ok: true });
  } catch (e: unknown) {
    console.error('Cookie refresh error:', (e as Error).message);
    res.status(500).json({ error: (e as Error).message });
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
