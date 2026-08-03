type QueueAdmissionClient = {
  eval(script: string, numberOfKeys: number, ...args: string[]): Promise<unknown>;
  zrem(key: string, ...members: string[]): Promise<unknown>;
};

type QueueAdmissionOptions = {
  namespace: string;
  jobId: string;
  maxJobs: number;
  leaseMs: number;
  background?: boolean;
  maxBackgroundJobs?: number;
  owner?: string;
  maxOwnerJobs?: number;
};

type QueueAdmissionStatus = 'reserved' | 'joined' | 'full' | 'background_full' | 'owner_full';
type QueueAdmissionResult = {
  status: QueueAdmissionStatus;
  total: number;
  background: number;
  owner: number;
};

function safeAdmissionPart(value: string) {
  return value.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 128) || 'default';
}

function queueAdmissionKeys(namespace: string, owner?: string) {
  const safeNamespace = safeAdmissionPart(namespace);
  const hashTag = `{${safeNamespace}}`;
  return {
    global: `queue-admission:${hashTag}:global`,
    background: `queue-admission:${hashTag}:background`,
    owner: `queue-admission:${hashTag}:owner:${safeAdmissionPart(owner || 'none')}`,
  };
}

async function reserveQueueJob(
  client: QueueAdmissionClient,
  options: QueueAdmissionOptions,
): Promise<QueueAdmissionResult> {
  const keys = queueAdmissionKeys(options.namespace, options.owner);
  const now = Date.now();
  const maxJobs = Math.max(1, Math.floor(options.maxJobs));
  const maxBackgroundJobs = Math.max(
    0,
    Math.min(maxJobs, Math.floor(options.maxBackgroundJobs ?? maxJobs)),
  );
  const maxOwnerJobs = Math.max(1, Math.floor(options.maxOwnerJobs ?? maxJobs));
  const leaseMs = Math.max(60_000, Math.floor(options.leaseMs));
  const script = `
    redis.call('zremrangebyscore', KEYS[1], '-inf', ARGV[1])
    redis.call('zremrangebyscore', KEYS[2], '-inf', ARGV[1])
    redis.call('zremrangebyscore', KEYS[3], '-inf', ARGV[1])
    local total = redis.call('zcard', KEYS[1])
    local background = redis.call('zcard', KEYS[2])
    local owner = redis.call('zcard', KEYS[3])
    if redis.call('zscore', KEYS[1], ARGV[2]) then
      redis.call('zadd', KEYS[1], ARGV[3], ARGV[2])
      if redis.call('zscore', KEYS[2], ARGV[2]) then redis.call('zadd', KEYS[2], ARGV[3], ARGV[2]) end
      if redis.call('zscore', KEYS[3], ARGV[2]) then redis.call('zadd', KEYS[3], ARGV[3], ARGV[2]) end
      redis.call('pexpire', KEYS[1], ARGV[9])
      redis.call('pexpire', KEYS[2], ARGV[9])
      redis.call('pexpire', KEYS[3], ARGV[9])
      return {2, total, background, owner}
    end
    if total >= tonumber(ARGV[4]) then return {0, total, background, owner} end
    if ARGV[5] == '1' and background >= tonumber(ARGV[6]) then
      return {-1, total, background, owner}
    end
    if ARGV[7] == '1' and owner >= tonumber(ARGV[8]) then
      return {-2, total, background, owner}
    end
    redis.call('zadd', KEYS[1], ARGV[3], ARGV[2])
    if ARGV[5] == '1' then redis.call('zadd', KEYS[2], ARGV[3], ARGV[2]) end
    if ARGV[7] == '1' then redis.call('zadd', KEYS[3], ARGV[3], ARGV[2]) end
    redis.call('pexpire', KEYS[1], ARGV[9])
    redis.call('pexpire', KEYS[2], ARGV[9])
    redis.call('pexpire', KEYS[3], ARGV[9])
    return {1, total + 1, background + tonumber(ARGV[5]), owner + tonumber(ARGV[7])}
  `;
  const raw = await client.eval(
    script,
    3,
    keys.global,
    keys.background,
    keys.owner,
    String(now),
    options.jobId,
    String(now + leaseMs),
    String(maxJobs),
    options.background ? '1' : '0',
    String(maxBackgroundJobs),
    options.owner ? '1' : '0',
    String(maxOwnerJobs),
    String(leaseMs * 2),
  );
  const values = Array.isArray(raw) ? raw.map(Number) : [Number(raw), 0, 0, 0];
  const code = values[0];
  const status: QueueAdmissionStatus = code === 1 ? 'reserved'
    : code === 2 ? 'joined'
      : code === -1 ? 'background_full'
        : code === -2 ? 'owner_full'
          : 'full';
  return {
    status,
    total: values[1] || 0,
    background: values[2] || 0,
    owner: values[3] || 0,
  };
}

async function releaseQueueJob(
  client: QueueAdmissionClient,
  namespace: string,
  jobId: string,
  owner?: string,
) {
  const keys = queueAdmissionKeys(namespace, owner);
  await Promise.all([
    client.zrem(keys.global, jobId),
    client.zrem(keys.background, jobId),
    owner ? client.zrem(keys.owner, jobId) : Promise.resolve(),
  ]);
}

export { queueAdmissionKeys, releaseQueueJob, reserveQueueJob };
export type { QueueAdmissionClient, QueueAdmissionOptions, QueueAdmissionResult, QueueAdmissionStatus };
