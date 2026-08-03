/**
 * Cookie management routes — browser detection, refresh, upload.
 */
import { Router } from 'express';
import express from 'express';
import { promises as fs } from 'fs';
import { randomUUID } from 'node:crypto';
import { exportCookies, rankBrowserSpecsForRequest } from './subscriptions-api.js';
import { availableBrowsers, refreshCookiesFile } from '../ytdlp.js';
import { ensureAuth } from '../auth.js';
import { acquireLock, releaseLock, renewLock } from '../lib/cache.js';
import { withYtdlpSlot } from './stream/shared.js';
import { projectPath } from '../lib/project-paths.js';

const router = Router();

const ALLOWED_BROWSERS = ['firefox','chrome','chromium','brave','edge','opera','vivaldi'];

function browserBase(browserSpec: string): string {
  return browserSpec.split(':', 1)[0].split('+', 1)[0].toLowerCase();
}

// Available browsers for cookie extraction
router.get('/browsers', ensureAuth, async (_req, res) => {
  res.json(await availableBrowsers());
});

// Auto-refresh cookies from best available browser (used by player retry)
router.post('/refresh-auto', ensureAuth, async (_req, res) => {
  try {
    await refreshCookiesFile({ withSlot: withYtdlpSlot });
    res.json({ ok: true });
  } catch (e: unknown) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// Refresh yt-dlp cookies from browser
router.post('/refresh', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not logged in' });
  const browser = typeof req.body?.browser === 'string' ? req.body.browser : '';
  const available = await availableBrowsers();
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
  let atomicPath: string | undefined;
  const lockKey = 'cookie-file-refresh';
  const lockToken = await acquireLock(lockKey, 45_000);
  if (!lockToken) return res.status(409).json({ error: 'Cookie refresh already in progress' });
  const renewTimer = setInterval(() => {
    void renewLock(lockKey, lockToken, 45_000);
  }, 15_000);
  renewTimer.unref?.();
  try {
    let lastError: Error | null = null;
    for (const candidate of candidates) {
      try {
        tempPath = await withYtdlpSlot(() => exportCookies(candidate), { priority: 'background' });
        break;
      } catch (e: unknown) {
        lastError = e instanceof Error ? e : new Error(String(e));
      }
    }
    if (!tempPath) throw lastError || new Error('No browser cookies found');
    const cookiesPath = projectPath('cookies.txt');
    atomicPath = `${cookiesPath}.tmp-${process.pid}-${randomUUID()}`;
    await fs.copyFile(tempPath, atomicPath);
    await fs.rename(atomicPath, cookiesPath);
    atomicPath = undefined;
    res.json({ ok: true });
  } catch (e: unknown) {
    console.error('Cookie refresh error:', (e as Error).message);
    res.status(500).json({ error: (e as Error).message });
  } finally {
    clearInterval(renewTimer);
    if (tempPath) await fs.rm(tempPath, { force: true }).catch(() => {});
    if (atomicPath) await fs.rm(atomicPath, { force: true }).catch(() => {});
    await releaseLock(lockKey, lockToken);
  }
});

// Upload cookies.txt for yt-dlp
router.post('/upload', express.text({ type: '*/*', limit: '1mb' }), async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not logged in' });
  const text = req.body;
  if (!text || typeof text !== 'string' || !text.includes('youtube.com')) {
    return res.status(400).json({ error: 'Invalid cookies.txt — must contain youtube.com cookies' });
  }
  await fs.writeFile(projectPath('cookies.txt'), text);
  res.json({ ok: true });
});

export default router;
