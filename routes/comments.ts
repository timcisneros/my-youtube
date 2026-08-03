import { Router } from 'express';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { createHash } from 'crypto';
import { getClientVersion, isYouTubeCdnUrl } from '../extractors.js';
import { fetchWithBodyTimeout } from '../lib/bounded-fetch.js';
import { readJsonBounded } from '../lib/bounded-fetch.js';
import { runBoundedSingleFlight } from '../lib/bounded-singleflight.js';
import { cache, withYtSlot } from '../youtube/shared.js';
import { getWatchNextSnapshot } from '../youtube/watch-next.js';

const router = Router();

interface Comment {
  author: string;
  authorUrl: string;
  authorImage: string;
  text: string;
  likeCount: string;
  publishedAt: string;
  replyCount?: number;
  replyContinuation?: string;
}

interface Reply {
  author: string;
  authorUrl: string;
  authorImage: string;
  text: string;
  likeCount: string;
  publishedAt: string;
  isReply: true;
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const INNERTUBE_URL = 'https://www.youtube.com/youtubei/v1/next';
const COMMENT_CACHE_TTL_MS = 60_000;
const commentInflight = new Map<string, Promise<unknown>>();
const commentSingleFlight = { name: 'comments', maxEntries: 300 } as const;

function compactCommentCacheKey(key: string) {
  return createHash('sha256').update(key).digest('base64url');
}

function fetchWithTimeout(url: string, opts: RequestInit, ms?: number) {
  const timeoutMs = ms || 10000;
  return withYtSlot(() => fetchWithBodyTimeout(url, opts, {
    headerTimeoutMs: timeoutMs,
    bodyIdleMs: timeoutMs,
  }));
}

async function cachedCommentRequest<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const compactKey = compactCommentCacheKey(key);
  const cached = await cache.comments.getAsync(compactKey);
  if (cached && Date.now() < cached.expires) return cached.data;
  return runBoundedSingleFlight(commentInflight as Map<string, Promise<T>>, compactKey, async () => {
    const data = await fn();
    cache.comments.set(compactKey, { data, expires: Date.now() + COMMENT_CACHE_TTL_MS });
    return data;
  }, commentSingleFlight);
}
function getInnertubeContext() {
  return {
    client: {
      clientName: 'WEB',
      clientVersion: getClientVersion(),
      hl: 'en',
      gl: 'US'
    }
  };
}

async function getInitialContinuationToken(videoId) {
  return (await getWatchNextSnapshot(videoId)).commentContinuation;
}

function parseCommentItems(continuationItems, mutations) {
  const comments: Comment[] = [];
  let nextPageToken = null;
  let totalCount = null;
  const mutationMap = {};
  for (const m of mutations) {
    if (m.entityKey) mutationMap[m.entityKey] = m.payload;
  }
  for (const item of continuationItems) {
    if (item.continuationItemRenderer) {
      const cmd = item.continuationItemRenderer.continuationEndpoint?.continuationCommand
        || item.continuationItemRenderer.button?.buttonRenderer?.command?.continuationCommand;
      if (cmd) nextPageToken = cmd.token;
      continue;
    }
    const header = item.commentsHeaderRenderer;
    if (header) {
      const countText = header.countText?.runs?.map(r => r.text).join('')
        || header.commentsCount?.simpleText || '';
      if (countText) totalCount = countText;
      continue;
    }
    const thread = item.commentThreadRenderer;
    if (!thread) continue;

    let replyContinuation = null;
    let replyCount = 0;
    const replies = thread.replies?.commentRepliesRenderer;
    if (replies) {
      for (const c of replies.contents || []) {
        const token = c.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token
          || c.continuationItemRenderer?.button?.buttonRenderer?.command?.continuationCommand?.token;
        if (token) { replyContinuation = token; break; }
      }
      // Reply count from the "View N replies" button text
      const viewReplies = replies.viewReplies?.buttonRenderer?.text;
      const countText = viewReplies?.runs?.map(r => r.text).join('') || viewReplies?.simpleText || '';
      const countMatch = countText.match(/(\d+)/);
      if (countMatch) replyCount = parseInt(countMatch[1], 10);
    }

    const renderer = thread.comment?.commentRenderer;
    if (renderer) {
      if (!replyCount && renderer.replyCount) replyCount = renderer.replyCount;
      const browseId = renderer.authorEndpoint?.browseEndpoint?.browseId || '';
      comments.push({
        author: renderer.authorText?.simpleText || '',
        authorUrl: browseId ? '/channel/' + browseId : '',
        authorImage: renderer.authorThumbnail?.thumbnails?.slice(-1)[0]?.url || '',
        text: escapeHtml((renderer.contentText?.runs || []).map(r => r.text).join('')),
        likeCount: renderer.voteCount?.simpleText || '0',
        publishedAt: renderer.publishedTimeText?.runs?.[0]?.text || '',
        replyCount: replyCount || undefined,
        replyContinuation: replyContinuation || undefined
      });
      continue;
    }
    const vm = thread.commentViewModel?.commentViewModel;
    if (!vm) continue;
    const entity = mutationMap[vm.commentKey]?.commentEntityPayload;
    if (!entity) continue;
    const props = entity.properties;
    const toolbar = entity.toolbar;
    const author = entity.author;
    const channelId = author?.channelId || '';
    if (!replyContinuation) {
      const replyVm = thread.commentViewModel?.commentViewModel?.repliesViewModel;
      if (replyVm) {
        replyContinuation = replyVm.continuationToken || null;
        if (!replyCount && replyVm.replyCount) replyCount = replyVm.replyCount;
      }
    }
    if (!replyCount && toolbar?.replyCount) replyCount = parseInt(toolbar.replyCount, 10);
    comments.push({
      author: author?.displayName || '',
      authorUrl: channelId ? '/channel/' + channelId : '',
      authorImage: author?.avatarThumbnailUrl || '',
      text: escapeHtml(props?.content?.content || ''),
      likeCount: toolbar?.likeCountNotliked || toolbar?.likeCountLiked || '0',
      publishedAt: props?.publishedTime || '',
      replyCount: replyCount || undefined,
      replyContinuation: replyContinuation || undefined
    });
  }
  const result: { comments: Comment[]; nextPageToken: string | null; totalCount?: string | null } = { comments, nextPageToken };
  if (totalCount) result.totalCount = totalCount;
  return result;
}

function parseReplyItems(items, mutations) {
  const replies: Reply[] = [];
  let nextReplyToken = null;
  const mutationMap = {};
  for (const m of mutations) {
    if (m.entityKey) mutationMap[m.entityKey] = m.payload;
  }
  for (const item of items) {
    if (item.continuationItemRenderer) {
      const cmd = item.continuationItemRenderer.continuationEndpoint?.continuationCommand
        || item.continuationItemRenderer.button?.buttonRenderer?.command?.continuationCommand;
      if (cmd) nextReplyToken = cmd.token;
      continue;
    }
    const renderer = item.commentRenderer;
    if (renderer) {
      const browseId = renderer.authorEndpoint?.browseEndpoint?.browseId || '';
      replies.push({
        author: renderer.authorText?.simpleText || '',
        authorUrl: browseId ? '/channel/' + browseId : '',
        authorImage: renderer.authorThumbnail?.thumbnails?.slice(-1)[0]?.url || '',
        text: escapeHtml((renderer.contentText?.runs || []).map(r => r.text).join('')),
        likeCount: renderer.voteCount?.simpleText || '0',
        publishedAt: renderer.publishedTimeText?.runs?.[0]?.text || '',
        isReply: true
      });
      continue;
    }
    const vm = item.commentViewModel?.commentViewModel || item.commentViewModel;
    if (!vm || !vm.commentKey) continue;
    const entity = mutationMap[vm.commentKey]?.commentEntityPayload;
    if (!entity) continue;
    const props = entity.properties;
    const toolbar = entity.toolbar;
    const author = entity.author;
    const channelId = author?.channelId || '';
    replies.push({
      author: author?.displayName || '',
      authorUrl: channelId ? '/channel/' + channelId : '',
      authorImage: author?.avatarThumbnailUrl || '',
      text: escapeHtml(props?.content?.content || ''),
      likeCount: toolbar?.likeCountNotliked || toolbar?.likeCountLiked || '0',
      publishedAt: props?.publishedTime || '',
      isReply: true
    });
  }
  return { replies, nextReplyToken };
}

async function fetchReplies(token) {
  const res = await fetchWithTimeout(INNERTUBE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0', 'Accept-Language': '*', 'Referer': '', 'Cookie': '' },
    body: JSON.stringify({ context: getInnertubeContext(), continuation: token })
  });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`YouTube replies returned ${res.status}`);
  }
  const data = await readJsonBounded(res, 4 * 1024 * 1024, 'replies-response-too-large');
  const endpoints = data?.onResponseReceivedEndpoints || [];
  let allItems = [];
  for (const ep of endpoints) {
    const items = ep.reloadContinuationItemsCommand?.continuationItems
      || ep.appendContinuationItemsCommand?.continuationItems
      || ep.appendContinuationItemsAction?.continuationItems;
    if (items) allItems.push(...items);
  }
  const mutations = data?.frameworkUpdates?.entityBatchUpdate?.mutations || [];
  return parseReplyItems(allItems, mutations);
}

async function fetchCommentsContinuation(token, hop = 0, seen = new Set<string>()) {
  if (hop >= 3 || seen.has(token)) return { comments: [], nextPageToken: null };
  seen.add(token);
  const res = await fetchWithTimeout(INNERTUBE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0', 'Accept-Language': '*', 'Referer': '', 'Cookie': '' },
    body: JSON.stringify({ context: getInnertubeContext(), continuation: token })
  });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`YouTube comments returned ${res.status}`);
  }
  const data = await readJsonBounded(res, 4 * 1024 * 1024, 'comments-response-too-large');
  const endpoints = data?.onResponseReceivedEndpoints || [];
  let allItems = [];
  for (const ep of endpoints) {
    const items = ep.reloadContinuationItemsCommand?.continuationItems
      || ep.appendContinuationItemsCommand?.continuationItems
      || ep.appendContinuationItemsAction?.continuationItems;
    if (items) allItems.push(...items);
  }
  if (allItems.length && allItems.every(i => i.commentsHeaderRenderer || i.continuationItemRenderer)) {
    for (const item of allItems) {
      if (item.continuationItemRenderer) {
        const nextToken = item.continuationItemRenderer.continuationEndpoint?.continuationCommand?.token
          || item.continuationItemRenderer.button?.buttonRenderer?.command?.continuationCommand?.token;
        if (nextToken) return fetchCommentsContinuation(nextToken, hop + 1, seen);
      }
    }
  }
  const mutations = data?.frameworkUpdates?.entityBatchUpdate?.mutations || [];
  if (allItems.length) {
    return parseCommentItems(allItems, mutations);
  }
  return { comments: [], nextPageToken: null };
}

async function getComments(videoId, pageToken) {
  const key = pageToken ? `page:${pageToken}` : `video:${videoId}`;
  return cachedCommentRequest(key, async () => {
    if (pageToken) return fetchCommentsContinuation(pageToken);
    const token = await getInitialContinuationToken(videoId);
    if (!token) return { comments: [], nextPageToken: null };
    return fetchCommentsContinuation(token);
  });
}

router.get('/replies', async (req, res) => {
  try {
    const token = typeof req.query.token === 'string' ? req.query.token : '';
    if (!token || token.length > 4096) return res.status(400).json({ error: 'Missing or invalid token' });
    const result = await cachedCommentRequest(`replies:${token}`, () => fetchReplies(token));
    res.json(result);
  } catch (err) {
    console.error('Replies error:', err.message);
    res.json({ replies: [], nextReplyToken: null, error: err.message });
  }
});

router.get('/:videoId', async (req, res) => {
  try {
    if (!/^[A-Za-z0-9_-]{11}$/.test(req.params.videoId)) return res.status(400).json({ error: 'Invalid video ID' });
    const pageToken = typeof req.query.pageToken === 'string' && req.query.pageToken.length <= 4096
      ? req.query.pageToken
      : '';
    const data = await getComments(req.params.videoId, pageToken);
    res.json(data);
  } catch (err) {
    console.error('Comments error:', err.code || '', err.errors?.[0]?.reason || '', err.message);
    res.json({ comments: [], nextPageToken: null, error: err.errors?.[0]?.reason || err.message });
  }
});

// Proxy avatar images to avoid broken cross-origin requests
router.get('/avatar/:encoded', async (req, res) => {
  try {
    const url = decodeURIComponent(req.params.encoded);
    if (!isYouTubeCdnUrl(url)) {
      return res.status(400).end();
    }
    const upstream = await fetchWithBodyTimeout(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': '*', Referer: '', Cookie: '' } }, { headerTimeoutMs: 8000, bodyIdleMs: 8000 });
    if (!upstream.ok) return res.status(upstream.status).end();
    const ct = upstream.headers.get('content-type');
    if (ct) res.set('Content-Type', ct);
    res.set('Cache-Control', 'public, max-age=86400');
    const nodeStream = Readable.fromWeb(upstream.body);
    await pipeline(nodeStream, res);
  } catch (err) {
    if (err.code === 'ERR_STREAM_PREMATURE_CLOSE') return;
    if (!res.headersSent) res.status(502).end();
  }
});

export default router;
