/**
 * Extraction Worker — runs yt-dlp and extraction backends in a separate process.
 * Communicates with web workers via Redis (BullMQ).
 *
 * Start: node extraction-worker.js
 * Requires: REDIS_URL environment variable
 */
import 'dotenv/config';

import { Worker } from 'bullmq';
import { extractVideo } from './lib/extract.js';

if (!process.env.REDIS_URL) {
  console.error('[extraction-worker] REDIS_URL is required');
  process.exit(1);
}

const url = new URL(process.env.REDIS_URL);
const connection = {
  host: url.hostname,
  port: parseInt(url.port, 10) || 6379,
  password: url.password || undefined,
  username: url.username || undefined,
  db: url.pathname ? parseInt(url.pathname.slice(1), 10) || 0 : 0,
  maxRetriesPerRequest: null,
};

const concurrency = parseInt(process.env.MAX_EXTRACTION_WORKERS, 10) || 2;

const worker = new Worker('extraction', async (job) => {
  const { videoId } = job.data;
  console.log(`[extraction-worker] Starting extraction for ${videoId} (job ${job.id})`);

  const info = await extractVideo(videoId);

  if (!info) {
    console.warn(`[extraction-worker] All backends failed for ${videoId}`);
    return { formats: [], duration: 0, _unavailable: 'All extraction backends failed. Try again in a few minutes.' };
  }

  const fmts = info.formats || [];
  const hlsCount = fmts.filter(f => f.protocol && f.protocol.startsWith('m3u8') && f.vcodec && f.vcodec !== 'none').length;
  const directCount = fmts.filter(f => f.url && (!f.protocol || f.protocol === 'https' || f.protocol === 'http')).length;
  console.log(`[extraction-worker] ${videoId}: ${fmts.length} formats (${hlsCount} HLS, ${directCount} direct) via ${info._extractedVia || 'yt-dlp'}`);

  return info;
}, {
  connection,
  concurrency,
});

worker.on('completed', (job) => {
  console.log(`[extraction-worker] Job ${job.id} completed`);
});

worker.on('failed', (job, err) => {
  console.error(`[extraction-worker] Job ${job ? job.id : '?'} failed:`, err.message);
});

worker.on('error', (err) => {
  console.error('[extraction-worker] Worker error:', err.message);
});

console.log(`[extraction-worker] Listening on queue "extraction" (concurrency=${concurrency})`);

// Graceful shutdown
async function shutdown() {
  console.log('[extraction-worker] Shutting down...');
  await worker.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
