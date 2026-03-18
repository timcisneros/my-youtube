import { Router } from 'express';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { getClientVersion, isYouTubeCdnUrl } from '../extractors.js';

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

function fetchWithTimeout(url: string, opts: RequestInit, ms?: number) {
  ms = ms || 10000;
  var c = new AbortController();
  var t = setTimeout(function () { c.abort(); }, ms);
  return fetch(url, Object.assign({}, opts, { signal: c.signal })).finally(function () { clearTimeout(t); });
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
  const res = await fetchWithTimeout(INNERTUBE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0', 'Accept-Language': '*', 'Referer': '', 'Cookie': '' },
    body: JSON.stringify({ context: getInnertubeContext(), videoId })
  });
  const data = await res.json();

  // Path 1: twoColumnWatchNextResults → itemSectionRenderer with comment-item-section
  const contents = data?.contents?.twoColumnWatchNextResults?.results?.results?.contents || [];
  for (const item of contents) {
    const section = item.itemSectionRenderer;
    if (!section) continue;
    const id = section.sectionIdentifier || section.targetId || '';
    if (id.includes('comment')) {
      for (const sub of section.contents || []) {
        if (sub.continuationItemRenderer) {
          const token = sub.continuationItemRenderer.continuationEndpoint?.continuationCommand?.token;
          if (token) return token;
        }
      }
    }
  }

  // Path 2: any itemSectionRenderer with a continuationItemRenderer (fallback)
  for (const item of contents) {
    const section = item.itemSectionRenderer;
    if (!section) continue;
    for (const sub of section.contents || []) {
      if (sub.continuationItemRenderer) {
        const token = sub.continuationItemRenderer.continuationEndpoint?.continuationCommand?.token;
        if (token) return token;
      }
    }
  }

  // Path 3: engagementPanels (mobile/alternate layout)
  const panels = data?.engagementPanels || [];
  for (const panel of panels) {
    const ep = panel.engagementPanelSectionListRenderer;
    if (!ep) continue;
    const panelId = ep.panelIdentifier || '';
    if (!panelId.includes('comment')) continue;
    const continuation = ep.content?.sectionListRenderer?.contents?.[0]
      ?.itemSectionRenderer?.contents?.[0]?.continuationItemRenderer;
    if (continuation) {
      const token = continuation.continuationEndpoint?.continuationCommand?.token;
      if (token) return token;
    }
  }

  return null;
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
  const data = await res.json();
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

async function fetchCommentsContinuation(token) {
  const res = await fetchWithTimeout(INNERTUBE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0', 'Accept-Language': '*', 'Referer': '', 'Cookie': '' },
    body: JSON.stringify({ context: getInnertubeContext(), continuation: token })
  });
  const data = await res.json();
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
        if (nextToken) return fetchCommentsContinuation(nextToken);
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
  if (pageToken) return fetchCommentsContinuation(pageToken);
  const token = await getInitialContinuationToken(videoId);
  if (!token) return { comments: [], nextPageToken: null };
  return fetchCommentsContinuation(token);
}

router.get('/replies', async (req, res) => {
  try {
    const token = req.query.token;
    if (!token) return res.status(400).json({ error: 'Missing token' });
    const result = await fetchReplies(token);
    res.json(result);
  } catch (err) {
    console.error('Replies error:', err.message);
    res.json({ replies: [], nextReplyToken: null, error: err.message });
  }
});

router.get('/:videoId', async (req, res) => {
  try {
    const data = await getComments(req.params.videoId, req.query.pageToken);
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
    const upstream = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': '*', Referer: '', Cookie: '' } });
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
