import { Router } from 'express';
import crypto from 'crypto';
import { ensureAuth } from '../auth.js';
import { extractPlaylistId, getDurationsAndLiveStatuses, getPlaylistContinuation, getPlaylistDetails } from '../youtube/index.js';
import db from '../db.js';
import {
  buildCursorNavigation,
  decodeLocalPlaylistCursor,
  decodeTimestampCursor,
  encodeLocalPlaylistCursor,
  encodeTimestampCursor,
} from '../lib/cursor-pagination.js';
import { enqueuePlaylistRefresh, enqueuePlaylistRefreshBatch } from '../lib/playlist-refresh-scheduler.js';

const router = Router();
const PLAYLIST_LIBRARY_PAGE_SIZE = 40;
const LOCAL_PLAYLIST_PAGE_SIZE = 50;

router.get('/continuation', ensureAuth, async (req, res) => {
  const playlistId = extractPlaylistId(req.query.list);
  const pageToken = typeof req.query.pageToken === 'string' ? req.query.pageToken : '';
  const startIndex = Math.min(100_000, Math.max(1,
    Math.floor(Number(req.query.start) || 1),
  ));
  if (!playlistId || !pageToken || pageToken.length > 4096) {
    return res.status(400).json({ error: 'Invalid playlist continuation' });
  }
  try {
    const page = await getPlaylistContinuation(playlistId, pageToken, startIndex);
    res.set('Cache-Control', 'private, no-store');
    res.json({
      items: page.items,
      nextPageToken: page.nextPageToken,
      nextStart: startIndex + page.items.length,
    });
  } catch (error) {
    res.status(502).json({
      error: (error as Error).message || 'Failed to load playlist page',
    });
  }
});

function isLocalPlaylistId(playlistId: string) {
  return /^local_[A-Za-z0-9_-]{8,64}$/.test(playlistId);
}

function extractVideoId(value: unknown): string {
  const input = typeof value === 'string' ? value.trim() : '';
  if (/^[A-Za-z0-9_-]{11}$/.test(input)) return input;
  try {
    const parsed = new URL(input);
    const v = parsed.searchParams.get('v');
    if (v && /^[A-Za-z0-9_-]{11}$/.test(v)) return v;
    const parts = parsed.pathname.split('/').filter(Boolean);
    const last = parts[parts.length - 1] || '';
    return /^[A-Za-z0-9_-]{11}$/.test(last) ? last : '';
  } catch {
    return '';
  }
}

async function buildLocalPlaylist(userId: string, playlistId: string, requestedCursor: unknown) {
  const saved = await Promise.resolve(db.getSavedPlaylist(userId, playlistId));
  if (!saved || saved.playlist_type !== 'local') return null;
  const token = decodeLocalPlaylistCursor(requestedCursor);
  const direction = token?.direction || 'next';
  const page = await Promise.resolve(db.getLocalPlaylistItemsCursorPage(
    userId, playlistId, LOCAL_PLAYLIST_PAGE_SIZE, token, direction,
  ));
  const rows = page.items;
  const items = rows.map(row => ({
    videoId: row.video_id,
    title: row.title || row.video_id,
    channelTitle: row.channel_title || '',
    channelId: row.channel_id || '',
    lengthText: '',
    index: row.position,
    available: true,
    unavailableReason: '',
  }));
  return {
    playlistId,
    title: saved.title,
    channelTitle: saved.channel_title || '',
    channelId: saved.channel_id || '',
    itemCountText: saved.item_count_text || '0 videos',
    thumbnailVideoId: saved.thumbnail_video_id || items.find((item) => item.videoId)?.videoId || '',
    items,
    nextPageToken: null,
    ...buildCursorNavigation(rows, page.hasMore, token !== null, direction,
      (item, nextDirection) => encodeLocalPlaylistCursor(
        item.position, item.created_at, item.video_id, nextDirection,
      )),
  };
}

function refreshStaleSavedPlaylists(userId: string, playlists: Array<{ playlist_id: string; playlist_type?: string; updated_at?: string }>) {
  const staleCutoff = Date.now() - 6 * 60 * 60 * 1000;
  const stalePlaylistIds: string[] = [];
  for (const playlist of playlists) {
    if (playlist.playlist_type === 'local') continue;
    const updated = playlist.updated_at ? new Date(playlist.updated_at).getTime() : 0;
    if (Number.isFinite(updated) && updated > staleCutoff) continue;
    stalePlaylistIds.push(playlist.playlist_id);
  }
  enqueuePlaylistRefreshBatch(userId, stalePlaylistIds);
}

router.get('/', ensureAuth, async (req, res) => {
  const playlistId = extractPlaylistId(req.query.list || req.query.url);
  if (!playlistId && req.baseUrl === '/playlists') {
    await res.flushShell({ activeTab: 'playlists' });
    const token = decodeTimestampCursor(req.query.cursor);
    const direction = token?.direction || 'next';
    const page = await Promise.resolve(db.getSavedPlaylistsCursorPage(
      req.session.userId, PLAYLIST_LIBRARY_PAGE_SIZE, token, direction,
    ));
    const playlists = page.items;
    refreshStaleSavedPlaylists(req.session.userId, playlists);
    const navigation = buildCursorNavigation(playlists, page.hasMore, token !== null, direction,
      (item, nextDirection) => encodeTimestampCursor(item.updated_at, item.playlist_id, nextDirection));
    return res.streamContent('playlists', { playlists, ...navigation });
  }
  if (!playlistId) return res.status(400).end('Invalid playlist ID');

  const pageToken = typeof req.query.pageToken === 'string' ? req.query.pageToken : '';
  if (pageToken.length > 4096) return res.status(400).end('Invalid playlist continuation');
  const startIndex = Math.max(1, parseInt(String(req.query.start || '1'), 10) || 1);

  await res.flushShell({ activeTab: req.baseUrl === '/playlists' ? 'playlists' : '' });
  try {
    const localPlaylist = isLocalPlaylistId(playlistId)
      ? await buildLocalPlaylist(req.session.userId, playlistId, req.query.cursor)
      : null;
    const playlist = localPlaylist || (pageToken
      ? await Promise.all([
        getPlaylistDetails(playlistId).catch(() => null),
        getPlaylistContinuation(playlistId, pageToken, startIndex),
      ]).then(([base, page]) => base ? ({
        ...page,
        title: base.title,
        channelTitle: base.channelTitle,
        channelId: base.channelId,
        itemCountText: base.itemCountText,
        thumbnailVideoId: base.thumbnailVideoId,
      }) : page)
      : await getPlaylistDetails(playlistId));
    const ids = playlist.items.map((item) => item.videoId).filter(Boolean);
    const { durations, liveStatuses } = await getDurationsAndLiveStatuses(ids);
    const saved = await Promise.resolve(db.isPlaylistSaved(req.session.userId, playlistId));
    await res.streamContent('playlist', {
      playlist,
      durations,
      liveStatuses,
      saved,
      pageToken,
      nextStart: startIndex + playlist.items.length,
      isLocal: Boolean(localPlaylist),
      localNextCursor: localPlaylist?.nextCursor || null,
      localPrevCursor: localPlaylist?.prevCursor || null,
    });
  } catch (err) {
    console.error('Playlist error:', err.message);
    res.end('<p class="error">Failed to load playlist</p></main><script src="/app.js"></script>\n</body>\n</html>');
  }
});

router.post('/', ensureAuth, async (req, res) => {
  const playlistId = extractPlaylistId(req.body?.list || req.body?.url || req.query.list || req.query.url);
  if (!playlistId) return res.status(400).json({ error: 'Invalid playlist ID' });
  try {
    const playlist = await getPlaylistDetails(playlistId);
    await Promise.resolve(db.savePlaylist(
      req.session.userId,
      playlist.playlistId,
      playlist.title,
      playlist.channelTitle,
      playlist.channelId,
      playlist.thumbnailVideoId,
      playlist.itemCountText,
    ));
    res.json({ ok: true, playlist });
  } catch (err) {
    res.status(502).json({ error: err.message || 'Failed to save playlist' });
  }
});

router.post('/local', ensureAuth, async (req, res) => {
  const title = String(req.body?.title || '').trim().slice(0, 120);
  if (!title) return res.status(400).json({ error: 'Title required' });
  const playlistId = 'local_' + crypto.randomBytes(9).toString('base64url');
  await Promise.resolve(db.savePlaylist(req.session.userId, playlistId, title, '', '', '', '0 videos', 'local'));
  res.json({ ok: true, playlistId });
});

router.post('/refresh', ensureAuth, async (req, res) => {
  const playlistId = extractPlaylistId(req.body?.list || req.query.list);
  if (playlistId) {
    await enqueuePlaylistRefresh(req.session.userId, playlistId);
    return res.json({ ok: true });
  }
  const youtubePlaylistIds = await Promise.resolve(db.getSavedYoutubePlaylistIds(req.session.userId, 20));
  const queued = enqueuePlaylistRefreshBatch(
    req.session.userId,
    youtubePlaylistIds,
  );
  res.status(202).json({ ok: true, queued });
});

router.post('/:playlistId/items', ensureAuth, async (req, res) => {
  const playlistId = String(req.params.playlistId || '');
  if (!isLocalPlaylistId(playlistId)) return res.status(400).json({ error: 'Invalid local playlist ID' });
  const saved = await Promise.resolve(db.getSavedPlaylist(req.session.userId, playlistId));
  if (!saved || saved.playlist_type !== 'local') return res.status(404).json({ error: 'Playlist not found' });
  const videoId = extractVideoId(req.body?.video || req.body?.videoId || req.body?.url);
  if (!videoId) return res.status(400).json({ error: 'Invalid video ID' });
  await Promise.resolve(db.addLocalPlaylistItem(
    req.session.userId,
    playlistId,
    videoId,
    String(req.body?.title || videoId).trim().slice(0, 200),
    String(req.body?.channelTitle || '').trim().slice(0, 120),
    String(req.body?.channelId || '').trim().slice(0, 80),
  ));
  const summary = await Promise.resolve(db.getLocalPlaylistSummary(req.session.userId, playlistId));
  await Promise.resolve(db.savePlaylist(req.session.userId, playlistId, saved.title, '', '', summary.thumbnailVideoId, `${summary.totalResults} ${summary.totalResults === 1 ? 'video' : 'videos'}`, 'local'));
  res.json({ ok: true });
});

router.delete('/:playlistId/items', ensureAuth, async (req, res) => {
  const playlistId = String(req.params.playlistId || '');
  const videoId = extractVideoId(req.body?.video || req.body?.videoId || req.body?.url);
  if (!isLocalPlaylistId(playlistId) || !videoId) return res.status(400).json({ error: 'Invalid playlist item' });
  const saved = await Promise.resolve(db.getSavedPlaylist(req.session.userId, playlistId));
  if (!saved || saved.playlist_type !== 'local') return res.status(404).json({ error: 'Playlist not found' });
  await Promise.resolve(db.removeLocalPlaylistItem(req.session.userId, playlistId, videoId));
  const summary = await Promise.resolve(db.getLocalPlaylistSummary(req.session.userId, playlistId));
  await Promise.resolve(db.savePlaylist(req.session.userId, playlistId, saved.title, '', '', summary.thumbnailVideoId, `${summary.totalResults} ${summary.totalResults === 1 ? 'video' : 'videos'}`, 'local'));
  res.json({ ok: true });
});

router.patch('/:playlistId/items', ensureAuth, async (req, res) => {
  const playlistId = String(req.params.playlistId || '');
  const videoId = extractVideoId(req.body?.video || req.body?.videoId || req.body?.url);
  const direction = req.body?.direction === 'down' ? 'down' : 'up';
  if (!isLocalPlaylistId(playlistId) || !videoId) return res.status(400).json({ error: 'Invalid playlist item' });
  const saved = await Promise.resolve(db.getSavedPlaylist(req.session.userId, playlistId));
  if (!saved || saved.playlist_type !== 'local') return res.status(404).json({ error: 'Playlist not found' });
  await Promise.resolve(db.moveLocalPlaylistItem(req.session.userId, playlistId, videoId, direction));
  res.json({ ok: true });
});

router.delete('/', ensureAuth, async (req, res) => {
  const playlistId = extractPlaylistId(req.body?.list || req.body?.url || req.query.list || req.query.url);
  if (!playlistId) return res.status(400).json({ error: 'Invalid playlist ID' });
  await db.unsavePlaylist(req.session.userId, playlistId);
  res.json({ ok: true });
});

export default router;
