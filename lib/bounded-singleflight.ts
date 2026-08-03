import { incrementMetric, setMetricGauge } from './performance-metrics.js';

interface SingleFlightOptions {
  name: string;
  maxEntries?: number;
}

const DEFAULT_MAX_ENTRIES = Math.max(16, Number(process.env.SINGLEFLIGHT_MAX_KEYS) || 500);

class SingleFlightCapacityError extends Error {
  readonly registry: string;

  constructor(registry: string) {
    super(`single-flight-capacity-exceeded:${registry}`);
    this.name = 'SingleFlightCapacityError';
    this.registry = registry;
  }
}

/**
 * Deduplicate work by key without allowing a burst of distinct keys to retain
 * an unlimited number of promises and request payloads. Existing keys always
 * join their owner; only new keys are load-shed at capacity.
 */
function runBoundedSingleFlight<TKey, TResult>(
  registry: Map<TKey, Promise<TResult>>,
  key: TKey,
  fn: () => Promise<TResult> | TResult,
  options: SingleFlightOptions,
): Promise<TResult> {
  const existing = registry.get(key);
  if (existing !== undefined) return existing;

  const maxEntries = Math.max(1, Math.min(DEFAULT_MAX_ENTRIES, options.maxEntries || DEFAULT_MAX_ENTRIES));
  if (registry.size >= maxEntries) {
    incrementMetric('singleflight_rejections_total', { registry: options.name });
    return Promise.reject(new SingleFlightCapacityError(options.name));
  }

  const promise = Promise.resolve().then(fn);
  registry.set(key, promise);
  setMetricGauge('singleflight_active', registry.size, { registry: options.name });
  const cleanup = () => {
    if (registry.get(key) === promise) registry.delete(key);
    setMetricGauge('singleflight_active', registry.size, { registry: options.name });
  };
  // An ignored finally() would create a second rejected promise. Attach both
  // settlement handlers directly so callers retain ownership of the original.
  void promise.then(cleanup, cleanup);
  return promise;
}

export { runBoundedSingleFlight, SingleFlightCapacityError };
export type { SingleFlightOptions };
