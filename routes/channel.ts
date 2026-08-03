import { Router } from 'express';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { ensureAuth } from '../auth.js';
import { getChannelInfo, getChannelVideos, getDurationsAndLiveStatuses, resolveChannelHandle } from '../youtube/index.js';
import { isYouTubeCdnUrl } from '../extractors.js';
import { fetchWithBodyTimeout } from '../lib/bounded-fetch.js';

const router = Router();

// Proxy channel avatar to avoid browser-side blocking of yt3.googleusercontent.com
router.get('/:channelId/avatar', async (req, res) => {
  try {
    const { channelId } = req.params;
    const info = await getChannelInfo(channelId);
    if (!info || !info.thumbnail) return res.status(404).end();
    if (!isYouTubeCdnUrl(info.thumbnail)) {
      return res.status(403).end();
    }
    const upstream = await fetchWithBodyTimeout(
      info.thumbnail,
      { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': '*', Referer: '', Cookie: '' } },
      { headerTimeoutMs: 8000, bodyIdleMs: 8000 },
    );
    if (!upstream.ok) return res.status(upstream.status).end();
    const ct = upstream.headers.get('content-type');
    if (ct) res.set('Content-Type', ct);
    res.set('Cache-Control', 'public, max-age=86400');
    const nodeStream = Readable.fromWeb(upstream.body);
    await pipeline(nodeStream, res);
  } catch {
    if (!res.headersSent) res.status(502).end();
  }
});

router.get('/:channelId', ensureAuth, async (req, res) => {
  const originalId = req.params.channelId;
  const resolutionP = originalId.startsWith('@')
    ? resolveChannelHandle(originalId)
    : Promise.resolve(originalId);
  const rawPageToken = String(req.query.pageToken || '');
  if (rawPageToken.length > 4096) return res.status(400).end('Invalid page token');
  const pageToken = rawPageToken || null;
  const tab = (req.query.tab as string) || 'videos';
  const validTabs = ['videos', 'shorts', 'live', 'playlists'];
  const activeTab = validTabs.includes(tab) ? tab : 'videos';
  // Handle resolution starts before the shell is sent; cold upstream latency
  // therefore no longer delays the browser from painting the page frame.
  await res.flushShell({ activeTab: '' });
  try {
    const channelId = await resolutionP;
    if (!channelId) {
      return res.end('<p class="error">Channel not found</p></main><script src="/app.js"></script>\n</body>\n</html>');
    }
    let channelInfo;
    let result;
    if (pageToken) {
      [channelInfo, result] = await Promise.all([
        getChannelInfo(channelId),
        getChannelVideos(channelId, pageToken, activeTab),
      ]);
    } else {
      // The first browse response already contains the title and avatar. Use
      // it directly so a cold channel page does not launch a second browse
      // request plus an RSS title lookup for metadata it already downloaded.
      result = await getChannelVideos(channelId, null, activeTab);
      const browseInfo = result.channelInfo;
      channelInfo = browseInfo?.title && browseInfo?.thumbnail
        ? browseInfo
        : await getChannelInfo(channelId);
    }
    const displayId = result.handle || originalId;
    const ids = result.items.map(v => v.videoId);
    const { durations, liveStatuses } = await getDurationsAndLiveStatuses(ids);
    await res.streamContent('channel', {
      channelInfo: { ...channelInfo, displayId }, tab: activeTab,
      items: result.items,
      durations, liveStatuses,
      nextPageToken: result.nextPageToken,
      prevPageToken: null,
      availableTabs: result.availableTabs
    });
  } catch (err) {
    console.error('Channel error:', err.message);
    res.end('<p class="error">Failed to load channel</p></main><script src="/app.js"></script>\n</body>\n</html>');
  }
});

export default router;
