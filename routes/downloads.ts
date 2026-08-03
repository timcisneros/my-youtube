import { Router } from 'express';
import db from '../db.js';
import { cleanupVideoDownloads } from './stream/index.js';
import { getDurationsForVideos } from '../youtube/index.js';
import { buildCursorNavigation, decodeTimestampCursor, encodeTimestampCursor } from '../lib/cursor-pagination.js';

const router = Router();
const DOWNLOADS_PAGE_SIZE = 40;

// GET /downloads — render page
router.get('/', async (req, res) => {
  await res.flushShell({ activeTab: 'downloads' });
  const token = decodeTimestampCursor(req.query.cursor);
  const direction = token?.direction || 'next';
  const page = await db.getDownloadsCursorPage(DOWNLOADS_PAGE_SIZE, token, direction);
  const downloads = page.items;
  const durations = await getDurationsForVideos(downloads.map(d => d.video_id));
  const navigation = buildCursorNavigation(downloads, page.hasMore, token !== null, direction,
    (item, nextDirection) => encodeTimestampCursor(item.created_at, item.video_id, nextDirection));
  await res.streamContent('downloads', { downloads, durations, ...navigation });
});

// DELETE /downloads/:videoId — delete files + DB row
router.delete('/:videoId', async (req, res) => {
  const { videoId } = req.params;
  // Abort if in progress + remove from map
  await cleanupVideoDownloads(videoId);
  await db.deleteDownload(videoId);
  res.status(204).end();
});

export default router;
