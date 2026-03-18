import { Router } from 'express';
import db from '../db.js';
import { bgDownloads, cleanupBgDownload } from './stream/index.js';
import { getDurationsForVideos } from '../youtube/index.js';
import fs from 'fs';
import path from 'path';

const router = Router();

// GET /downloads — render page
router.get('/', async (_req, res) => {
  await res.flushShell({ activeTab: 'downloads' });
  const downloads = db.getAllDownloads();
  const durations = getDurationsForVideos(downloads.map(d => d.video_id));
  await res.streamContent('downloads', { downloads, durations });
});

// DELETE /downloads/:videoId — delete files + DB row
router.delete('/:videoId', (req, res) => {
  const { videoId } = req.params;
  // Abort if in progress + remove from map
  for (const [key] of bgDownloads) {
    if (key.startsWith(videoId + ':')) cleanupBgDownload(key);
  }
  // Delete any remaining files
  const dir = path.join(import.meta.dirname, '..', 'data', 'downloads');
  try {
    for (const f of fs.readdirSync(dir)) {
      if (f.startsWith('mycache-' + videoId + '-')) fs.unlinkSync(path.join(dir, f));
    }
  } catch {}
  db.deleteDownload(videoId);
  res.status(204).end();
});

export default router;
