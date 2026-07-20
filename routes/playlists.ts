import { Router } from 'express';
import crypto from 'crypto';
import { ensureAuth } from '../auth.js';
import { extractPlaylistId, getDurationsAndLiveStatuses, getExpandedPlaylistDetails, getPlaylistContinuation, getPlaylistDetails } from '../youtube/index.js';
import db from '../db.js';

const router = Router();

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

async function buildLocalPlaylist(userId: string, playlistId: string) {
  const saved = await Promise.resolve(db.getSavedPlaylist(userId, playlistId));
  if (!saved || saved.playlist_type !== 'local') return null;
  const rows = await Promise.resolve(db.getLocalPlaylistItems(userId, playlistId));
  const items = rows.map((row, idx) => ({
    videoId: row.video_id,
    title: row.title || row.video_id,
    channelTitle: row.channel_title || '',
    channelId: row.channel_id || '',
    lengthText: '',
    index: idx + 1,
    available: true,
    unavailableReason: '',
  }));
  return {
    playlistId,
    title: saved.title,
    channelTitle: saved.channel_title || '',
    channelId: saved.channel_id || '',
    itemCountText: `${items.length} ${items.length === 1 ? 'video' : 'videos'}`,
    thumbnailVideoId: items.find((item) => item.videoId)?.videoId || '',
    items,
    nextPageToken: null,
  };
}

async function refreshSavedPlaylist(userId: string, playlistId: string) {
  const playlist = await getPlaylistDetails(playlistId);
  await Promise.resolve(db.savePlaylist(
    userId,
    playlist.playlistId,
    playlist.title,
    playlist.channelTitle,
    playlist.channelId,
    playlist.thumbnailVideoId,
    playlist.itemCountText,
    'youtube',
  ));
}

function refreshStaleSavedPlaylists(userId: string, playlists: Array<{ playlist_id: string; playlist_type?: string; updated_at?: string }>) {
  const staleCutoff = Date.now() - 6 * 60 * 60 * 1000;
  for (const playlist of playlists) {
    if (playlist.playlist_type === 'local') continue;
    const updated = playlist.updated_at ? new Date(playlist.updated_at).getTime() : 0;
    if (Number.isFinite(updated) && updated > staleCutoff) continue;
    void refreshSavedPlaylist(userId, playlist.playlist_id).catch((err) => {
      console.warn('[playlists] metadata refresh failed for', playlist.playlist_id, err.message);
    });
  }
}

router.get('/', ensureAuth, async (req, res) => {
  const playlistId = extractPlaylistId(req.query.list || req.query.url);
  if (!playlistId && req.baseUrl === '/playlists') {
    await res.flushShell({ activeTab: 'playlists' });
    const playlists = await Promise.resolve(db.getSavedPlaylists(req.session.userId));
    refreshStaleSavedPlaylists(req.session.userId, playlists);
    return res.streamContent('playlists', { playlists });
  }
  if (!playlistId) return res.status(400).end('Invalid playlist ID');

  const pageToken = typeof req.query.pageToken === 'string' ? req.query.pageToken : '';
  const startIndex = Math.max(1, parseInt(String(req.query.start || '1'), 10) || 1);

  await res.flushShell({ activeTab: req.baseUrl === '/playlists' ? 'playlists' : '' });
  try {
    const localPlaylist = isLocalPlaylistId(playlistId)
      ? await buildLocalPlaylist(req.session.userId, playlistId)
      : null;
    const playlist = localPlaylist || (req.query.all === '1'
      ? await getExpandedPlaylistDetails(playlistId)
      : pageToken
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
    const { durations, liveStatuses } = getDurationsAndLiveStatuses(ids);
    const saved = await Promise.resolve(db.isPlaylistSaved(req.session.userId, playlistId));
    await res.streamContent('playlist', {
      playlist,
      durations,
      liveStatuses,
      saved,
      pageToken,
      nextStart: startIndex + playlist.items.length,
      isLocal: Boolean(localPlaylist),
      expanded: req.query.all === '1',
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
    await refreshSavedPlaylist(req.session.userId, playlistId);
    return res.json({ ok: true });
  }
  const playlists = await Promise.resolve(db.getSavedPlaylists(req.session.userId));
  const youtubePlaylists = playlists.filter((playlist) => playlist.playlist_type !== 'local').slice(0, 20);
  await Promise.allSettled(youtubePlaylists.map((playlist) => refreshSavedPlaylist(req.session.userId, playlist.playlist_id)));
  res.json({ ok: true, refreshed: youtubePlaylists.length });
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
  const items = await Promise.resolve(db.getLocalPlaylistItems(req.session.userId, playlistId));
  await Promise.resolve(db.savePlaylist(req.session.userId, playlistId, saved.title, '', '', items[0]?.video_id || '', `${items.length} ${items.length === 1 ? 'video' : 'videos'}`, 'local'));
  res.json({ ok: true });
});

router.delete('/:playlistId/items', ensureAuth, async (req, res) => {
  const playlistId = String(req.params.playlistId || '');
  const videoId = extractVideoId(req.body?.video || req.body?.videoId || req.body?.url);
  if (!isLocalPlaylistId(playlistId) || !videoId) return res.status(400).json({ error: 'Invalid playlist item' });
  const saved = await Promise.resolve(db.getSavedPlaylist(req.session.userId, playlistId));
  if (!saved || saved.playlist_type !== 'local') return res.status(404).json({ error: 'Playlist not found' });
  await Promise.resolve(db.removeLocalPlaylistItem(req.session.userId, playlistId, videoId));
  const items = await Promise.resolve(db.getLocalPlaylistItems(req.session.userId, playlistId));
  await Promise.resolve(db.savePlaylist(req.session.userId, playlistId, saved.title, '', '', items[0]?.video_id || '', `${items.length} ${items.length === 1 ? 'video' : 'videos'}`, 'local'));
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

router.delete('/', ensureAuth, (req, res) => {
  const playlistId = extractPlaylistId(req.body?.list || req.body?.url || req.query.list || req.query.url);
  if (!playlistId) return res.status(400).json({ error: 'Invalid playlist ID' });
  void Promise.resolve(db.unsavePlaylist(req.session.userId, playlistId));
  res.json({ ok: true });
});

export default router;
