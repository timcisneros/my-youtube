import { randomUUID } from 'node:crypto';

interface RedisSemaphoreClient {
  eval(script: string, numberOfKeys: number, ...args: string[]): Promise<unknown>;
  zrem(key: string, member: string): Promise<unknown>;
}

interface RedisSemaphoreOptions {
  key: string;
  limit: number;
  leaseMs: number;
  waitTimeoutMs: number;
  owner?: string;
  retryBaseMs?: number;
  onRenewError?: (error: unknown) => void;
}

function semaphoreAbortError(signal?: AbortSignal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error('distributed-semaphore-aborted');
  error.name = 'AbortError';
  return error;
}

function abortableDelay(ms: number, signal?: AbortSignal) {
  if (signal?.aborted) return Promise.reject(semaphoreAbortError(signal));
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    const onAbort = () => {
      clearTimeout(timer);
      reject(semaphoreAbortError(signal));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function acquireRedisSemaphore(
  client: RedisSemaphoreClient,
  options: RedisSemaphoreOptions,
  signal?: AbortSignal,
) {
  const limit = Math.max(1, Math.floor(options.limit));
  const leaseMs = Math.max(5_000, Math.floor(options.leaseMs));
  const waitTimeoutMs = Math.max(250, Math.floor(options.waitTimeoutMs));
  const retryBaseMs = Math.max(10, Math.floor(options.retryBaseMs || 100));
  const token = `${options.owner || process.pid}:${randomUUID()}`;
  const startedAt = Date.now();
  const deadline = startedAt + waitTimeoutMs;
  let attempt = 0;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw semaphoreAbortError(signal);
    const now = Date.now();
    const acquired = await client.eval(
      `redis.call('zremrangebyscore', KEYS[1], '-inf', ARGV[1])
       if redis.call('zcard', KEYS[1]) < tonumber(ARGV[2]) then
         redis.call('zadd', KEYS[1], ARGV[3], ARGV[4])
         redis.call('pexpire', KEYS[1], ARGV[5])
         return 1
       end
       return 0`,
      1,
      options.key,
      String(now),
      String(limit),
      String(now + leaseMs),
      token,
      String(leaseMs * 2),
    );
    if (Number(acquired) === 1) {
      let released = false;
      const renewTimer = setInterval(() => {
        void client.eval(
          `if redis.call('zscore', KEYS[1], ARGV[1]) then
             redis.call('zadd', KEYS[1], 'XX', ARGV[2], ARGV[1])
             redis.call('pexpire', KEYS[1], ARGV[3])
             return 1
           end
           return 0`,
          1,
          options.key,
          token,
          String(Date.now() + leaseMs),
          String(leaseMs * 2),
        ).catch(error => options.onRenewError?.(error));
      }, Math.max(1_000, Math.floor(leaseMs / 3)));
      renewTimer.unref?.();
      return {
        waitMs: Date.now() - startedAt,
        async release() {
          if (released) return;
          released = true;
          clearInterval(renewTimer);
          await client.zrem(options.key, token);
        },
      };
    }
    const delay = Math.min(1_000, retryBaseMs * Math.pow(1.6, attempt++));
    await abortableDelay(delay * (0.8 + Math.random() * 0.4), signal);
  }
  throw new Error('distributed-semaphore-timeout');
}

export { acquireRedisSemaphore };
export type { RedisSemaphoreClient, RedisSemaphoreOptions };
