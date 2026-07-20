import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fork } from 'node:child_process';
import crypto from 'node:crypto';
import db from '../db.js';
import LRUMap from '../lib/lru-map.js';
import { SharedLRUMap } from '../lib/cache.js';
import { createStreamToken, validateStreamToken } from '../auth.js';
import { initStorage, isS3, putBuffer, getStream, stat, del } from '../lib/storage.js';
import { getSegment, putSegment } from '../lib/segment-cache.js';
import { initQueue, enqueueExtraction, hasQueue } from '../lib/extraction-queue.js';
import { attach, notify, isAvailable } from '../lib/ws-status.js';
import { stopChild } from './helpers/child-process.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_USER = 'test-user-integration';
const TEST_VIDEO = 'dQw4w9WgXcQ';
const TEST_CHANNEL = 'UCuAXFkgsw1L7xaCfnd5JJOw'; // valid-looking channel ID

function httpRequest(port, method, urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'localhost',
      port,
      path: urlPath,
      method,
      headers: { ...headers },
    };
    if (body) {
      const data = typeof body === 'string' ? body : JSON.stringify(body);
      options.headers['Content-Type'] = typeof body === 'string' ? 'text/plain' : 'application/json';
      options.headers['Content-Length'] = Buffer.byteLength(data);
    }
    const req = http.request(options, (res) => {
      let chunks = '';
      res.on('data', (d) => (chunks += d));
      res.on('end', () =>
        resolve({ status: res.statusCode, body: chunks, headers: res.headers })
      );
    });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

// Follow redirects manually (one level)
async function httpGet(port, urlPath, headers) {
  const res = await httpRequest(port, 'GET', urlPath, undefined, headers);
  return res;
}

function httpGetUntil(port, urlPath, predicate, headers = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      req.destroy();
      reject(new Error(`Timed out waiting for streamed response marker: ${urlPath}`));
    }, 10000);
    const req = http.request({
      hostname: 'localhost',
      port,
      path: urlPath,
      method: 'GET',
      headers,
    }, (res) => {
      let chunks = '';
      res.on('data', (d) => {
        if (settled) return;
        chunks += d;
        if (predicate(chunks)) {
          settled = true;
          clearTimeout(timeout);
          resolve({ status: res.statusCode, body: chunks, headers: res.headers });
          req.destroy();
        }
      });
      res.on('end', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve({ status: res.statusCode, body: chunks, headers: res.headers });
      });
    });
    req.on('error', (err) => {
      if (err.code === 'ECONNRESET') return;
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(err);
    });
    req.end();
  });
}

// ---------------------------------------------------------------------------
// 1. Database layer (SQLite)
// ---------------------------------------------------------------------------

describe('Database layer (SQLite)', () => {
  before(() => {
    // Ensure no PG override
    delete process.env.DATABASE_URL;
  });

  after(() => {
    // Clean up test data
    try {
      db.removeTag(TEST_USER, TEST_VIDEO, 'testtag');
      db.removeTag(TEST_USER, TEST_VIDEO, 'anothertag');
      db.deleteSubscription(TEST_USER, TEST_CHANNEL);
      db.deleteDownload('test_dl_video');
    } catch {}
  });

  describe('addTag / getTags / removeTag', () => {
    it('should add a tag and return it in getTags', () => {
      const result = db.addTag(TEST_USER, TEST_VIDEO, 'TestTag');
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.tag, 'testtag'); // normalized

      const tags = db.getTags(TEST_USER, TEST_VIDEO);
      assert.ok(tags.includes('testtag'), 'Tag should be present');
    });

    it('should ignore duplicate tags (INSERT OR IGNORE)', () => {
      const result = db.addTag(TEST_USER, TEST_VIDEO, 'testtag');
      assert.strictEqual(result.ok, true);
      // Count should still be 1
      const tags = db.getTags(TEST_USER, TEST_VIDEO);
      const count = tags.filter((t) => t === 'testtag').length;
      assert.strictEqual(count, 1);
    });

    it('should remove a tag and verify it is gone', () => {
      db.addTag(TEST_USER, TEST_VIDEO, 'anothertag');
      let tags = db.getTags(TEST_USER, TEST_VIDEO);
      assert.ok(tags.includes('anothertag'));

      db.removeTag(TEST_USER, TEST_VIDEO, 'anothertag');
      tags = db.getTags(TEST_USER, TEST_VIDEO);
      assert.ok(!tags.includes('anothertag'), 'Tag should be removed');
    });

    it('should reject invalid tags', () => {
      const result = db.addTag(TEST_USER, TEST_VIDEO, '###');
      assert.strictEqual(result.ok, false);
    });
  });

  describe('upsertSubscriptions / getSubscriptions / deleteSubscription', () => {
    it('should upsert and retrieve subscriptions', () => {
      db.upsertSubscriptions(TEST_USER, [
        { channelId: TEST_CHANNEL, title: 'Test Channel', thumbnail: '//example.com/thumb.jpg', description: 'A test channel' },
      ]);
      const subs = db.getSubscriptions(TEST_USER);
      const found = subs.find((s) => s.channelId === TEST_CHANNEL);
      assert.ok(found, 'Subscription should exist');
      assert.strictEqual(found.title, 'Test Channel');
      // thumbnail should be normalized (protocol-relative -> https)
      assert.ok(found.thumbnail.startsWith('https:'), 'Thumbnail should be normalized to https');
    });

    it('should update existing subscription on upsert', () => {
      db.upsertSubscriptions(TEST_USER, [
        { channelId: TEST_CHANNEL, title: 'Updated Title', thumbnail: 'https://example.com/new.jpg', description: 'Updated' },
      ]);
      const subs = db.getSubscriptions(TEST_USER);
      const found = subs.find((s) => s.channelId === TEST_CHANNEL);
      assert.strictEqual(found.title, 'Updated Title');
    });

    it('should delete a subscription', () => {
      db.deleteSubscription(TEST_USER, TEST_CHANNEL);
      const subs = db.getSubscriptions(TEST_USER);
      const found = subs.find((s) => s.channelId === TEST_CHANNEL);
      assert.strictEqual(found, undefined);
    });
  });

  describe('upsertChannel / getChannel', () => {
    it('should insert and retrieve a channel', () => {
      db.upsertChannel(TEST_CHANNEL, 'My Channel', 'https://example.com/ch.jpg');
      const ch = db.getChannel(TEST_CHANNEL);
      assert.ok(ch);
      assert.strictEqual(ch.channelId, TEST_CHANNEL);
      assert.strictEqual(ch.title, 'My Channel');
    });

    it('should return null for unknown channel', () => {
      const ch = db.getChannel('UC_NONEXISTENT_CHANNEL_XXXX');
      assert.strictEqual(ch, null);
    });
  });

  describe('setDuration / getDuration / getDurations', () => {
    it('should store and retrieve a single duration', () => {
      db.setDuration('vid_dur_1', 123.45, 'not_live');
      const dur = db.getDuration('vid_dur_1');
      assert.strictEqual(dur, 123.45);
    });

    it('should return null for unknown video', () => {
      const dur = db.getDuration('vid_nonexistent');
      assert.strictEqual(dur, null);
    });

    it('should batch-retrieve durations', () => {
      db.setDuration('vid_dur_2', 200, 'not_live');
      db.setDuration('vid_dur_3', 300, 'not_live');
      const durations = db.getDurations(['vid_dur_2', 'vid_dur_3', 'vid_nonexistent']);
      assert.strictEqual(durations['vid_dur_2'], 200);
      assert.strictEqual(durations['vid_dur_3'], 300);
      assert.strictEqual(durations['vid_nonexistent'], undefined);
    });

    it('should handle empty array in getDurations', () => {
      const durations = db.getDurations([]);
      assert.deepStrictEqual(durations, {});
    });
  });

  describe('getLiveStatus / getLiveStatuses', () => {
    it('should retrieve live status for a single video', () => {
      db.setDuration('vid_live_1', 0, 'is_live');
      const status = db.getLiveStatus('vid_live_1');
      assert.strictEqual(status, 'is_live');
    });

    it('should return null for unknown video', () => {
      assert.strictEqual(db.getLiveStatus('vid_live_none'), null);
    });

    it('should batch-retrieve live statuses', () => {
      db.setDuration('vid_live_2', 0, 'is_upcoming');
      const statuses = db.getLiveStatuses(['vid_live_1', 'vid_live_2', 'vid_live_none']);
      assert.strictEqual(statuses['vid_live_1'], 'is_live');
      assert.strictEqual(statuses['vid_live_2'], 'is_upcoming');
      assert.strictEqual(statuses['vid_live_none'], undefined);
    });

    it('should handle empty array in getLiveStatuses', () => {
      assert.deepStrictEqual(db.getLiveStatuses([]), {});
    });
  });

  describe('setRssCache / getRssCache', () => {
    it('should store and retrieve JSON data', () => {
      const testData = { videos: [{ id: 'abc', title: 'Hello' }] };
      db.setRssCache(TEST_CHANNEL, testData);
      const cached = db.getRssCache(TEST_CHANNEL);
      assert.ok(cached);
      assert.deepStrictEqual(cached.data, testData);
      assert.ok(cached.fetchedAt); // should have a timestamp
    });

    it('should return null for unknown channel', () => {
      assert.strictEqual(db.getRssCache('UC_NO_CACHE_CHANNEL_XXXXXX'), null);
    });
  });

  describe('upsertDownload / getDownload / getAllDownloads / completeDownload / deleteDownload', () => {
    const DL_VIDEO = 'test_dl_video';

    it('should create a download record', () => {
      db.upsertDownload(DL_VIDEO, 'Test Download', 'Test Channel', 'https://example.com/dl.jpg');
      const dl = db.getDownload(DL_VIDEO);
      assert.ok(dl);
      assert.strictEqual(dl.video_id, DL_VIDEO);
      assert.strictEqual(dl.status, 'downloading');
      assert.strictEqual(dl.title, 'Test Download');
    });

    it('should appear in getAllDownloads', () => {
      const all = db.getAllDownloads();
      const found = all.find((d) => d.video_id === DL_VIDEO);
      assert.ok(found);
    });

    it('should complete a download', () => {
      db.completeDownload(DL_VIDEO);
      const dl = db.getDownload(DL_VIDEO);
      assert.strictEqual(dl.status, 'complete');
    });

    it('should delete a download', () => {
      db.deleteDownload(DL_VIDEO);
      const dl = db.getDownload(DL_VIDEO);
      assert.strictEqual(dl, null);
    });
  });

  describe('setWatchTime / getWatchTime', () => {
    it('should save and restore position', () => {
      db.setWatchTime(TEST_USER, TEST_VIDEO, 42.5, 300);
      const wt = db.getWatchTime(TEST_USER, TEST_VIDEO);
      assert.ok(wt);
      assert.strictEqual(wt.last_position, 42.5);
      assert.strictEqual(wt.duration, 300);
    });

    it('should return null for untracked video', () => {
      const wt = db.getWatchTime(TEST_USER, 'xxxxxxxxxxx');
      assert.strictEqual(wt, null);
    });

    it('should update position on subsequent call', () => {
      db.setWatchTime(TEST_USER, TEST_VIDEO, 100, 300);
      const wt = db.getWatchTime(TEST_USER, TEST_VIDEO);
      assert.strictEqual(wt.last_position, 100);
    });
  });

  describe('getSubByChannel', () => {
    it('should find subscription by channel ID cross-table', () => {
      db.upsertSubscriptions(TEST_USER, [
        { channelId: TEST_CHANNEL, title: 'Sub Lookup', thumbnail: '', description: '' },
      ]);
      const sub = db.getSubByChannel(TEST_CHANNEL);
      assert.ok(sub);
      assert.strictEqual(sub.channelId, TEST_CHANNEL);
      assert.strictEqual(sub.title, 'Sub Lookup');
      // cleanup
      db.deleteSubscription(TEST_USER, TEST_CHANNEL);
    });

    it('should return null for unknown channel', () => {
      assert.strictEqual(db.getSubByChannel('UC_NOPE_CHANNEL_XXXXXXXXXXX'), null);
    });
  });
});

// ---------------------------------------------------------------------------
// 2. LRU Map
// ---------------------------------------------------------------------------

describe('LRUMap', () => {
  it('should evict oldest entry when exceeding maxSize', () => {
    const lru = new LRUMap(3);
    lru.set('a', 1);
    lru.set('b', 2);
    lru.set('c', 3);
    lru.set('d', 4); // should evict 'a'
    assert.strictEqual(lru.has('a'), false);
    assert.strictEqual(lru.get('d'), 4);
    assert.strictEqual(lru.size, 3);
  });

  it('should promote entry on get (LRU ordering)', () => {
    const lru = new LRUMap(3);
    lru.set('a', 1);
    lru.set('b', 2);
    lru.set('c', 3);
    lru.get('a'); // touch 'a', so 'b' is now oldest
    lru.set('d', 4); // should evict 'b' (oldest untouched)
    assert.strictEqual(lru.has('a'), true);
    assert.strictEqual(lru.has('b'), false);
    assert.strictEqual(lru.has('d'), true);
  });

  it('should promote entry on set (replace)', () => {
    const lru = new LRUMap(3);
    lru.set('a', 1);
    lru.set('b', 2);
    lru.set('c', 3);
    lru.set('a', 10); // update 'a', 'b' becomes oldest
    lru.set('d', 4); // evicts 'b'
    assert.strictEqual(lru.has('b'), false);
    assert.strictEqual(lru.get('a'), 10);
  });

  it('should support delete', () => {
    const lru = new LRUMap(5);
    lru.set('x', 1);
    assert.strictEqual(lru.delete('x'), true);
    assert.strictEqual(lru.has('x'), false);
    assert.strictEqual(lru.size, 0);
  });

  it('should return undefined for missing key', () => {
    const lru = new LRUMap(5);
    assert.strictEqual(lru.get('missing'), undefined);
  });

  it('should support iteration', () => {
    const lru = new LRUMap(5);
    lru.set('a', 1);
    lru.set('b', 2);
    const entries = [...lru];
    assert.strictEqual(entries.length, 2);
    assert.deepStrictEqual(entries[0], ['a', 1]);
    assert.deepStrictEqual(entries[1], ['b', 2]);
  });

  it('should support keys(), values(), forEach()', () => {
    const lru = new LRUMap(5);
    lru.set('x', 10);
    lru.set('y', 20);
    assert.deepStrictEqual([...lru.keys()], ['x', 'y']);
    assert.deepStrictEqual([...lru.values()], [10, 20]);
    const collected = [];
    lru.forEach((v, k) => collected.push([k, v]));
    assert.strictEqual(collected.length, 2);
  });

  it('should support clear()', () => {
    const lru = new LRUMap(5);
    lru.set('a', 1);
    lru.set('b', 2);
    lru.clear();
    assert.strictEqual(lru.size, 0);
    assert.strictEqual(lru.has('a'), false);
  });
});

// ---------------------------------------------------------------------------
// 3. SharedLRUMap (without Redis)
// ---------------------------------------------------------------------------

describe('SharedLRUMap (no Redis)', () => {
  before(() => {
    // Ensure no Redis
    delete process.env.REDIS_URL;
  });

  it('should support sync get/set/delete like LRUMap', () => {
    const cache = new SharedLRUMap(10, 'test');
    cache.set('foo', { value: 42 });
    assert.deepStrictEqual(cache.get('foo'), { value: 42 });
    cache.delete('foo');
    assert.strictEqual(cache.get('foo'), undefined);
  });

  it('should return value from L1 via getAsync', async () => {
    const cache = new SharedLRUMap(10, 'test');
    cache.set('bar', { value: 99 });
    const result = await cache.getAsync('bar');
    assert.deepStrictEqual(result, { value: 99 });
  });

  it('should return undefined on getAsync miss (no Redis)', async () => {
    const cache = new SharedLRUMap(10, 'test');
    const result = await cache.getAsync('nonexistent');
    assert.strictEqual(result, undefined);
  });

  it('should evict like LRUMap', () => {
    const cache = new SharedLRUMap(2, 'test');
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    assert.strictEqual(cache.has('a'), false);
    assert.strictEqual(cache.get('c'), 3);
  });
});

// ---------------------------------------------------------------------------
// 4. Auth tokens
// ---------------------------------------------------------------------------

describe('Auth tokens', () => {
  it('should create a token with a dot separator', () => {
    const token = createStreamToken(TEST_VIDEO);
    assert.ok(typeof token === 'string');
    assert.ok(token.includes('.'), 'Token should contain a dot separator');
    const parts = token.split('.');
    assert.strictEqual(parts.length, 2);
    // First part should be a numeric expiry timestamp
    assert.ok(!isNaN(parseInt(parts[0], 10)));
  });

  it('should validate a fresh token', () => {
    const token = createStreamToken(TEST_VIDEO);
    assert.strictEqual(validateStreamToken(TEST_VIDEO, token), true);
  });

  it('should reject token for wrong videoId', () => {
    const token = createStreamToken(TEST_VIDEO);
    assert.strictEqual(validateStreamToken('xxxxxxxxxxx', token), false);
  });

  it('should reject expired token', () => {
    // Create a token that looks valid but has an expiry in the past
    const expiry = Date.now() - 1000; // 1 second ago
    // We can't easily create a valid HMAC with the server secret,
    // but we can test that ANY token with a past expiry is rejected
    const fakeToken = expiry + '.abcdef1234567890';
    assert.strictEqual(validateStreamToken(TEST_VIDEO, fakeToken), false);
  });

  it('should reject malformed tokens', () => {
    assert.strictEqual(validateStreamToken(TEST_VIDEO, 'no-dot-here'), false);
    assert.strictEqual(validateStreamToken(TEST_VIDEO, ''), false);
    assert.strictEqual(validateStreamToken(TEST_VIDEO, '.'), false);
    assert.strictEqual(validateStreamToken(TEST_VIDEO, 'abc.'), false);
  });

  it('should use timing-safe comparison (no early return on partial match)', () => {
    // Create a valid token, then tamper with one character of the signature
    const token = createStreamToken(TEST_VIDEO);
    const [expiry, sig] = token.split('.');
    // Flip one character in the signature
    const tampered =
      sig[0] === 'a'
        ? 'b' + sig.slice(1)
        : 'a' + sig.slice(1);
    const tamperedToken = expiry + '.' + tampered;
    // Must still be 16 chars for timingSafeEqual to not throw
    assert.strictEqual(tamperedToken.split('.')[1].length, sig.length);
    assert.strictEqual(validateStreamToken(TEST_VIDEO, tamperedToken), false);
  });
});

// ---------------------------------------------------------------------------
// 5. Rate limiter (via HTTP)
// ---------------------------------------------------------------------------

describe('Rate limiter', () => {
  const TEST_PORT = 13579;
  let child;

  before(async () => {
    // Fork the server as a child process
    child = fork(path.join(import.meta.dirname, '..', 'server.js'), [], {
      env: {
        ...process.env,
        PORT: String(TEST_PORT),
        SESSION_SECRET: 'test-secret-rate',
        NODE_ENV: 'test',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });

    // Wait for server to be ready
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Server start timeout')), 10000);
      child.stdout.on('data', (data) => {
        if (data.toString().includes('my-youtube running')) {
          clearTimeout(timeout);
          resolve();
        }
      });
      child.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
      child.on('exit', (code) => {
        if (code) {
          clearTimeout(timeout);
          reject(new Error(`Server exited with code ${code}`));
        }
      });
    });
  });

  after(async () => stopChild(child));

  it('should allow initial requests and eventually return 429', async () => {
    // The rate limiter starts with 60 tokens (RATE_BURST)
    // Each request consumes 1 token. Replenishment is 8/sec.
    // Send 70 rapid requests — some should succeed, last ones should 429.
    const results = [];
    for (let i = 0; i < 70; i++) {
      const res = await httpGet(TEST_PORT, '/favicon.ico');
      results.push(res.status);
    }

    const successes = results.filter((s) => s === 204);
    const rateLimited = results.filter((s) => s === 429);

    assert.ok(successes.length > 0, 'Some requests should succeed');
    assert.ok(rateLimited.length > 0, `Should get 429s after burst exhausted (got ${successes.length} successes out of 70)`);
  });
});

// ---------------------------------------------------------------------------
// 6. Storage abstraction (local filesystem)
// ---------------------------------------------------------------------------

describe('Storage abstraction (local filesystem)', () => {
  const testKey = '__test_integration_storage_file.bin';
  const testData = Buffer.from('Hello storage integration test');

  before(() => {
    // Ensure local filesystem mode (no S3)
    delete process.env.STORAGE_URL;
  });

  after(async () => {
    // Cleanup
    await del(testKey);
  });

  it('should write a buffer and stat it', async () => {
    await putBuffer(testKey, testData);
    const info = await stat(testKey);
    assert.strictEqual(info.exists, true);
    assert.strictEqual(info.size, testData.length);
  });

  it('should read back via getStream', async () => {
    const stream = await getStream(testKey);
    assert.ok(stream, 'getStream should return a readable stream');
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const result = Buffer.concat(chunks);
    assert.deepStrictEqual(result, testData);
  });

  it('should delete the file', async () => {
    await del(testKey);
    const info = await stat(testKey);
    assert.strictEqual(info.exists, false);
  });

  it('should return null for getStream on missing key', async () => {
    const stream = await getStream('__nonexistent_key_12345.bin');
    assert.strictEqual(stream, null);
  });

  it('should return { exists: false } for stat on missing key', async () => {
    const info = await stat('__nonexistent_key_12345.bin');
    assert.strictEqual(info.exists, false);
    assert.strictEqual(info.size, 0);
  });
});

// ---------------------------------------------------------------------------
// 7. Segment cache (without Redis)
// ---------------------------------------------------------------------------

describe('Segment cache (no Redis)', () => {
  before(() => {
    delete process.env.REDIS_URL;
  });

  it('should return null from getSegment when no Redis', async () => {
    const result = await getSegment('vid123', '140', 'bytes=0-1000');
    assert.strictEqual(result, null);
  });

  it('should not throw from putSegment when no Redis', async () => {
    // Should silently do nothing
    await assert.doesNotReject(async () => {
      await putSegment('vid123', '140', 'bytes=0-1000', Buffer.alloc(100), {
        contentType: 'video/mp4',
        contentRange: 'bytes 0-99/1000',
        status: 200,
      });
    });
  });
});

// ---------------------------------------------------------------------------
// 8. Extraction queue (without Redis)
// ---------------------------------------------------------------------------

describe('Extraction queue (no Redis)', () => {
  before(() => {
    delete process.env.REDIS_URL;
  });

  it('should report hasQueue() === false without REDIS_URL', () => {
    assert.strictEqual(hasQueue(), false);
  });

  it('should return null from enqueueExtraction without queue', async () => {
    const result = await enqueueExtraction('someVideoId', 5000);
    assert.strictEqual(result, null);
  });
});

// ---------------------------------------------------------------------------
// 9. WebSocket status (without server)
// ---------------------------------------------------------------------------

describe('WebSocket status (no server)', () => {
  it('should report isAvailable() === false before attach', () => {
    // ws-status may already be attached by server.js in the rate-limiter fork,
    // but in THIS process no server was created, so wss should be null
    // Actually server.js was required for db tests, which calls attach...
    // Use a fresh module check — since server.js was not required in this process,
    // ws-status should not have been attached.
    // Note: import('../lib/ws-status') returns the singleton. If server.js was required
    // earlier in another describe, wss could be set. But we only required db.js, not server.js.
    assert.strictEqual(isAvailable(), false);
  });

  it('should not throw from notify() when no listeners', () => {
    assert.doesNotThrow(() => {
      notify('someVideoId', { type: 'progress', percent: 50 });
    });
  });

  it('should not throw from notify() with non-subscribed videoId', () => {
    assert.doesNotThrow(() => {
      notify('nonexistent', { type: 'done' });
    });
  });
});

// ---------------------------------------------------------------------------
// 10. HTTP endpoint smoke tests
// ---------------------------------------------------------------------------

describe('HTTP endpoint smoke tests', () => {
  const TEST_PORT = 13580;
  let child;

  before(async () => {
    child = fork(path.join(import.meta.dirname, '..', 'server.js'), [], {
      env: {
        ...process.env,
        PORT: String(TEST_PORT),
        SESSION_SECRET: 'test-secret-http',
        NODE_ENV: 'test',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Server start timeout')), 10000);
      child.stdout.on('data', (data) => {
        if (data.toString().includes('my-youtube running')) {
          clearTimeout(timeout);
          resolve();
        }
      });
      child.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
      child.on('exit', (code) => {
        if (code) {
          clearTimeout(timeout);
          reject(new Error(`Server exited with code ${code}`));
        }
      });
    });
  });

  after(async () => stopChild(child));

  it('GET /favicon.ico should return 204', async () => {
    const res = await httpGet(TEST_PORT, '/favicon.ico');
    assert.strictEqual(res.status, 204);
  });

  it('GET /auth/login should return 200', async () => {
    const res = await httpGet(TEST_PORT, '/auth/login');
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.length > 0, 'Should have response body');
  });

  it('GET / without session should redirect to /auth/login', async () => {
    const res = await httpGet(TEST_PORT, '/');
    // Express redirects typically return 302
    assert.ok(
      res.status === 302 || res.status === 301 || res.status === 303,
      `Expected redirect, got ${res.status}`
    );
    assert.ok(
      res.headers.location && res.headers.location.includes('/auth/login'),
      'Should redirect to /auth/login'
    );
  });

  it('POST /auth/free should redirect to / (creates session)', async () => {
    const res = await httpRequest(TEST_PORT, 'POST', '/auth/free');
    assert.ok(
      res.status === 302 || res.status === 301 || res.status === 303,
      `Expected redirect, got ${res.status}`
    );
    assert.ok(
      res.headers.location === '/' || res.headers.location === './',
      `Expected redirect to /, got ${res.headers.location}`
    );
  });

  it('GET /watch shell should default to native player without eager Shaka', async () => {
    const login = await httpRequest(TEST_PORT, 'POST', '/auth/free');
    const cookie = Array.isArray(login.headers['set-cookie'])
      ? login.headers['set-cookie'].map((value) => value.split(';')[0]).join('; ')
      : '';
    assert.ok(cookie, 'Expected auth cookie from /auth/free');

    const res = await httpGetUntil(
      TEST_PORT,
      `/watch?v=${TEST_VIDEO}`,
      (body) => body.includes('/native-player-engine.js'),
      { Cookie: cookie }
    );

    assert.strictEqual(res.status, 200);
    assert.match(res.body, /<main[^>]*class="[^"]*player-page/);
    assert.ok(res.body.includes('/native-player-engine.js'), 'Should load the native player engine in the shell');
    assert.ok(!res.body.includes('/vendor/shaka/shaka-player.compiled.js'), 'Should not eager-load Shaka in the watch shell');
    assert.ok(!res.body.includes('/player-engine.js'), 'Should not load the legacy Shaka-primary engine in the watch shell');
  });

  it('POST /api/watch-time/dQw4w9WgXcQ without session should return 401', async () => {
    const res = await httpRequest(TEST_PORT, 'POST', '/api/watch-time/dQw4w9WgXcQ', {
      position: 10,
      duration: 300,
    });
    assert.strictEqual(res.status, 401);
  });

  it('POST /api/player-events should accept sanitized first-party telemetry without session', async () => {
    const res = await httpRequest(TEST_PORT, 'POST', '/api/player-events', {
      events: [{
        type: 'first-frame',
        videoId: 'dQw4w9WgXcQ',
        provider: 'native-dash',
        mode: 'dash',
        transmuxerProvider: 'first-party-ts',
        transmuxedSegmentCount: 2,
        activeHeight: 720,
        bufferAhead: 12,
      }],
    });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(JSON.parse(res.body), { ok: true });
  });

  it('should include security headers', async () => {
    const res = await httpGet(TEST_PORT, '/auth/login');
    assert.ok(res.headers['content-security-policy'], 'Should have CSP header');
    assert.strictEqual(res.headers['referrer-policy'], 'no-referrer');
    assert.strictEqual(res.headers['x-content-type-options'], 'nosniff');
    assert.strictEqual(res.headers['x-frame-options'], 'DENY');
    assert.strictEqual(res.headers['x-dns-prefetch-control'], 'off');
  });
});
