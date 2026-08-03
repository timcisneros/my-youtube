import { after, describe, it } from 'node:test';
import assert from 'node:assert';

process.env.REDIS_URL ||= 'redis://127.0.0.1:6399';
process.env.CACHE_REDIS_URL ||= process.env.REDIS_URL;

const {
  SharedLRUMap,
  getCacheRedisClient,
  getRedisClient,
  initRedis,
} = await import('../lib/cache.js');

assert.strictEqual(await initRedis(), true, 'Redis cache regression requires a reachable Redis instance');

const namespace = `cache-regression-${process.pid}-${Date.now()}`;

after(async () => {
  const coordination = getRedisClient();
  const cache = getCacheRedisClient();
  if (cache && cache !== coordination) await cache.quit();
  if (coordination) await coordination.quit();
});

describe('SharedLRUMap with Redis', () => {
  it('publishes entries to cold workers before setAsync resolves', async () => {
    const writer = new SharedLRUMap(10, namespace);
    const coldWorker = new SharedLRUMap(10, namespace);
    const value = { data: 'shared', expires: Date.now() + 60_000 };

    await writer.setAsync('video', value);
    assert.deepStrictEqual(await coldWorker.getAsync('video'), value);
    await writer.deleteAsync('video');
  });

  it('local expiry cleanup cannot delete a newer shared value', async () => {
    const oldWorker = new SharedLRUMap(10, namespace);
    const writer = new SharedLRUMap(10, namespace);
    const coldWorker = new SharedLRUMap(10, namespace);

    await writer.setAsync('url', { generation: 1, expires: Date.now() + 60_000 });
    await oldWorker.getAsync('url');
    await writer.setAsync('url', { generation: 2, expires: Date.now() + 60_000 });
    oldWorker.deleteLocal('url');

    assert.strictEqual((await coldWorker.getAsync('url')).generation, 2);
    await writer.deleteAsync('url');
  });

  it('orders an asynchronous delete after an earlier write', async () => {
    const writer = new SharedLRUMap(10, namespace);
    const coldWorker = new SharedLRUMap(10, namespace);

    writer.set('ordered', { data: 'temporary', expires: Date.now() + 60_000 });
    await writer.deleteAsync('ordered');
    assert.strictEqual(await coldWorker.getAsync('ordered'), undefined);
  });

  it('does not resurrect Redis data after a synchronous invalidation', async () => {
    const worker = new SharedLRUMap(10, namespace);
    await worker.setAsync('invalidated', { data: 'stale', expires: Date.now() + 60_000 });
    worker.delete('invalidated');
    assert.strictEqual(await worker.getAsync('invalidated'), undefined);
  });
});
