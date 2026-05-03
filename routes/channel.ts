import { Router } from 'express';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { ensureAuth } from '../auth.js';
import { getChannelInfo, getChannelVideos, getDurationsAndLiveStatuses } from '../youtube/index.js';
import { getClientVersion, isYouTubeCdnUrl } from '../extractors.js';

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
    const upstream = await fetch(info.thumbnail, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': '*', Referer: '', Cookie: '' } });
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
  let { channelId } = req.params;

  // Resolve @handle to UC... for API calls, keep original for display
  const originalId = channelId;
  if (channelId.startsWith('@')) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const resp = await fetch('https://www.youtube.com/youtubei/v1/navigation/resolve_url', {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
        body: JSON.stringify({
          url: 'https://www.youtube.com/' + channelId,
          context: { client: { clientName: 'WEB', clientVersion: getClientVersion(), hl: 'en' } },
        }),
      });
      clearTimeout(timer);
      const data = await resp.json();
      const resolved = data?.endpoint?.browseEndpoint?.browseId;
      if (resolved) channelId = resolved;
      else return res.status(404).end('Channel not found');
    } catch {
      return res.status(404).end('Channel not found');
    }
  }

  const pageToken = (req.query.pageToken as string) || null;
  const tab = (req.query.tab as string) || 'videos';
  const validTabs = ['videos', 'shorts', 'live', 'playlists'];
  const activeTab = validTabs.includes(tab) ? tab : 'videos';
  const infoP = getChannelInfo(channelId);
  await res.flushShell({ activeTab: '' });
  try {
    const [channelInfo, result] = await Promise.all([infoP, getChannelVideos(channelId, pageToken, activeTab)]);
    const displayId = result.handle || originalId;
    const ids = result.items.map(v => v.videoId);
    const { durations, liveStatuses } = getDurationsAndLiveStatuses(ids);
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
