import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import path from 'node:path';
import { fork } from 'node:child_process';
import { SharedLRUMap } from '../lib/cache.js';
import * as extractionQueue from '../lib/extraction-queue.js';
import * as storage from '../lib/storage.js';
import * as segCache from '../lib/segment-cache.js';
import * as wsStatus from '../lib/ws-status.js';
import { stopChild } from './helpers/child-process.mjs';

// ---------------------------------------------------------------------------
// These tests verify the app doesn't crash when optional services fail
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 1. SharedLRUMap with failed Redis
// ---------------------------------------------------------------------------

describe('SharedLRUMap with failed Redis', () => {
  before(() => {
    // Ensure no Redis
    delete process.env.REDIS_URL;
  });

  it('set/get/delete should work even when Redis operations would fail', () => {
    const cache = new SharedLRUMap(10, 'resilience-test');
    cache.set('key1', { data: 'hello' });
    assert.deepStrictEqual(cache.get('key1'), { data: 'hello' });
    assert.strictEqual(cache.has('key1'), true);
    cache.delete('key1');
    assert.strictEqual(cache.get('key1'), undefined);
    assert.strictEqual(cache.has('key1'), false);
  });

  it('getAsync should resolve to undefined on miss (no Redis)', async () => {
    const cache = new SharedLRUMap(10, 'resilience-test');
    const result = await cache.getAsync('nonexistent');
    assert.strictEqual(result, undefined);
  });

  it('getAsync should return L1 value when present', async () => {
    const cache = new SharedLRUMap(10, 'resilience-test');
    cache.set('present', 42);
    const result = await cache.getAsync('present');
    assert.strictEqual(result, 42);
  });

  it('eviction should still work correctly', () => {
    const cache = new SharedLRUMap(2, 'resilience-test');
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3); // should evict 'a'
    assert.strictEqual(cache.has('a'), false);
    assert.strictEqual(cache.get('b'), 2);
    assert.strictEqual(cache.get('c'), 3);
  });
});

// ---------------------------------------------------------------------------
// 2. Extraction queue fallback
// ---------------------------------------------------------------------------

describe('Extraction queue fallback', () => {
  before(() => {
    delete process.env.REDIS_URL;
  });

  it('hasQueue() should return false without REDIS_URL', () => {
    assert.strictEqual(extractionQueue.hasQueue(), false);
  });

  it('enqueueExtraction() should return null gracefully', async () => {
    const result = await extractionQueue.enqueueExtraction('someVideoId', 5000);
    assert.strictEqual(result, null);
  });

  it('enqueueExtraction() should not throw', async () => {
    await assert.doesNotReject(async () => {
      await extractionQueue.enqueueExtraction('anotherVideoId', 1000);
    });
  });
});

// ---------------------------------------------------------------------------
// 3. Storage fallback — local filesystem
// ---------------------------------------------------------------------------

describe('Storage fallback (local filesystem)', () => {
  const testKey = '__resilience_test_file.bin';
  const testData = Buffer.from('Resilience test data');

  before(() => {
    // Ensure no S3
    delete process.env.STORAGE_URL;
  });

  after(async () => {
    await storage.del(testKey);
  });

  it('should not be in S3 mode', () => {
    assert.strictEqual(storage.isS3(), false);
  });

  it('putBuffer and stat should work on local filesystem', async () => {
    await storage.putBuffer(testKey, testData);
    const info = await storage.stat(testKey);
    assert.strictEqual(info.exists, true);
    assert.strictEqual(info.size, testData.length);
  });

  it('getStream should return readable stream for existing file', async () => {
    const stream = await storage.getStream(testKey);
    assert.ok(stream, 'Should return a stream');
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    assert.deepStrictEqual(Buffer.concat(chunks), testData);
  });

  it('getStream should return null for missing file', async () => {
    const stream = await storage.getStream('__nonexistent_resilience_key.bin');
    assert.strictEqual(stream, null);
  });

  it('stat should return { exists: false } for missing file', async () => {
    const info = await storage.stat('__nonexistent_resilience_key.bin');
    assert.strictEqual(info.exists, false);
    assert.strictEqual(info.size, 0);
  });

  it('del should not throw for missing file', async () => {
    await assert.doesNotReject(async () => {
      await storage.del('__nonexistent_resilience_key.bin');
    });
  });
});

// ---------------------------------------------------------------------------
// 4. Segment cache miss
// ---------------------------------------------------------------------------

describe('Segment cache miss (no Redis)', () => {
  before(() => {
    delete process.env.REDIS_URL;
  });

  it('getSegment should return null', async () => {
    const result = await segCache.getSegment('vid123', '140', 'bytes=0-1000');
    assert.strictEqual(result, null);
  });

  it('putSegment should not throw', async () => {
    await assert.doesNotReject(async () => {
      await segCache.putSegment('vid123', '140', 'bytes=0-1000', Buffer.alloc(100), {
        contentType: 'video/mp4',
        contentRange: 'bytes 0-99/1000',
        status: 200,
      });
    });
  });

  it('getSegment should still return null after putSegment (no Redis to store)', async () => {
    const result = await segCache.getSegment('vid123', '140', 'bytes=0-1000');
    assert.strictEqual(result, null);
  });
});

// ---------------------------------------------------------------------------
// 5. Health endpoint with no Redis
// ---------------------------------------------------------------------------

describe('Health endpoint with no Redis', () => {
  const TEST_PORT = 13591;
  let child;

  before(async () => {
    child = fork(path.join(import.meta.dirname, '..', 'server.js'), [], {
      env: {
        ...process.env,
        PORT: String(TEST_PORT),
        SESSION_SECRET: 'test-secret-resilience',
        NODE_ENV: 'test',
        REDIS_URL: '', // explicitly no Redis
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Server start timeout')), 15000);
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

  it('GET /health should return 200 with redis.status not_configured', async () => {
    const res = await httpGet(TEST_PORT, '/health');
    assert.strictEqual(res.status, 200, `Expected 200, got ${res.status}`);
    const data = JSON.parse(res.body);
    assert.ok(data.redis, 'Health should include redis check');
    assert.strictEqual(data.redis.status, 'not_configured');
  });

  it('GET /health should return database.status ok', async () => {
    const res = await httpGet(TEST_PORT, '/health');
    assert.strictEqual(res.status, 200);
    const data = JSON.parse(res.body);
    assert.ok(data.database, 'Health should include database check');
    assert.strictEqual(data.database.status, 'ok');
  });
});

// ---------------------------------------------------------------------------
// 6. WebSocket fallback
// ---------------------------------------------------------------------------

describe('WebSocket fallback (no server)', () => {
  it('isAvailable() should return false before attach', () => {
    assert.strictEqual(wsStatus.isAvailable(), false);
  });

  it('notify() should not throw when no listeners', () => {
    assert.doesNotThrow(() => {
      wsStatus.notify('someVideoId', { type: 'progress', percent: 50 });
    });
  });

  it('notify() should not throw with non-subscribed videoId', () => {
    assert.doesNotThrow(() => {
      wsStatus.notify('nonexistent', { type: 'done' });
    });
  });

  it('notify() should not throw with various data types', () => {
    assert.doesNotThrow(() => {
      wsStatus.notify('vid1', { type: 'error', message: 'test error' });
      wsStatus.notify('vid2', { type: 'progress', percent: 0 });
      wsStatus.notify('vid3', null);
    });
  });
});

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function httpGet(port, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: 'localhost',
      port,
      path: urlPath,
      method: 'GET',
    }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}
