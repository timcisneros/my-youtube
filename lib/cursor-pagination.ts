import type {
  LocalPlaylistPageCursor,
  PageCursorDirection,
  SubscriptionPageCursor,
  TimestampPageCursor,
} from '../types.js';

type TimestampCursorToken = TimestampPageCursor & { direction: PageCursorDirection };
type LocalPlaylistCursorToken = LocalPlaylistPageCursor & { direction: PageCursorDirection };
type SubscriptionCursorToken = SubscriptionPageCursor & { direction: PageCursorDirection };

function validDirection(value: unknown): value is PageCursorDirection {
  return value === 'next' || value === 'previous';
}

function validTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 64
    && Number.isFinite(new Date(value).getTime());
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function normalizeTimestamp(value: unknown) {
  if (value instanceof Date) return value.toISOString();
  const timestamp = String(value || '');
  if (!validTimestamp(timestamp)) throw new Error('Invalid cursor timestamp');
  return timestamp;
}

function decodeToken(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) return null;
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    return decoded && typeof decoded === 'object' && decoded.version === 1 ? decoded : null;
  } catch {
    return null;
  }
}

function decodeTimestampCursor(value: unknown): TimestampCursorToken | null {
  const token = decodeToken(value);
  if (!token || !validDirection(token.direction) || !validTimestamp(token.timestamp) || !validId(token.id)) return null;
  return { direction: token.direction, timestamp: token.timestamp, id: token.id };
}

function encodeTimestampCursor(timestamp: unknown, id: string, direction: PageCursorDirection) {
  if (!validId(id)) throw new Error('Invalid cursor identifier');
  return Buffer.from(JSON.stringify({
    version: 1,
    direction,
    timestamp: normalizeTimestamp(timestamp),
    id,
  })).toString('base64url');
}

function decodeLocalPlaylistCursor(value: unknown): LocalPlaylistCursorToken | null {
  const token = decodeToken(value);
  const position = Number(token?.position);
  if (!token || !validDirection(token.direction) || !Number.isSafeInteger(position) || position < 0
    || !validTimestamp(token.createdAt) || !validId(token.videoId)) return null;
  return { direction: token.direction, position, createdAt: token.createdAt, videoId: token.videoId };
}

function encodeLocalPlaylistCursor(
  position: number,
  createdAt: unknown,
  videoId: string,
  direction: PageCursorDirection,
) {
  if (!Number.isSafeInteger(position) || position < 0 || !validId(videoId)) throw new Error('Invalid playlist cursor');
  return Buffer.from(JSON.stringify({
    version: 1,
    direction,
    position,
    createdAt: normalizeTimestamp(createdAt),
    videoId,
  })).toString('base64url');
}

function decodeSubscriptionCursor(value: unknown): SubscriptionCursorToken | null {
  const token = decodeToken(value);
  if (!token || !validDirection(token.direction)
    || typeof token.title !== 'string' || token.title.length > 500
    || !validId(token.channelId)) return null;
  return { direction: token.direction, title: token.title, channelId: token.channelId };
}

function encodeSubscriptionCursor(
  title: string,
  channelId: string,
  direction: PageCursorDirection,
) {
  if (typeof title !== 'string' || title.length > 500 || !validId(channelId)) {
    throw new Error('Invalid subscription cursor');
  }
  return Buffer.from(JSON.stringify({
    version: 1,
    direction,
    title,
    channelId,
  })).toString('base64url');
}

function buildCursorNavigation<T>(
  items: T[],
  hasMore: boolean,
  requested: boolean,
  direction: PageCursorDirection,
  encode: (item: T, direction: PageCursorDirection) => string,
) {
  const first = items[0];
  const last = items[items.length - 1];
  return {
    prevCursor: first && (direction === 'previous' ? hasMore : requested)
      ? encode(first, 'previous') : null,
    nextCursor: last && (direction === 'next' ? hasMore : requested)
      ? encode(last, 'next') : null,
  };
}

export {
  buildCursorNavigation,
  decodeLocalPlaylistCursor,
  decodeSubscriptionCursor,
  decodeTimestampCursor,
  encodeLocalPlaylistCursor,
  encodeSubscriptionCursor,
  encodeTimestampCursor,
};
