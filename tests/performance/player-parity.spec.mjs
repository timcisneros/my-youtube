import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { brotliCompressSync, gzipSync } from 'node:zlib';

const NATIVE_ENGINE_PATH = new URL('../../public/native-player-engine.js', import.meta.url);
const MUX_BUNDLE_PATH = new URL('../../node_modules/@mux/mux-player/dist/mux-player.js', import.meta.url);
const FIXTURE_PATH = new URL('../fixtures/player-performance.html', import.meta.url);
const RUNNER_PATH = new URL('./player-parity.spec.mjs', import.meta.url);
const FIXTURE_GENERATOR_PATH = new URL('../../routes/stream/player-fixture.ts', import.meta.url);
const PACKAGE_LOCK_PATH = new URL('../../package-lock.json', import.meta.url);
const MIN_PROOF_SAMPLES = 200;
const MIN_PROOF_SEEK_SAMPLES = 500;
const MIN_PROOF_BOOTSTRAPS = 100_000;
const MIN_BOOTSTRAP_TAIL_DRAWS = 10;
const MAX_COLLECTION_ATTEMPTS = 3;
const COLLECTION_NAVIGATION_TIMEOUT_MS = 35_000;
const COLLECTION_RESULT_TIMEOUT_MS = 35_000;
const COLLECTION_DIAGNOSTIC_TIMEOUT_MS = 1_000;
const MAX_COLLECTION_FAILURE_RATE = 0.01;
const COLLECTION_FAILURE_NONINFERIORITY_MARGIN = 0.01;
const IMPLEMENTATION_SCRIPT_PATHS = {
  native: '/native-player-engine.js',
  mux: '/__player-benchmark/mux-player.js',
};
const NETWORK_IO_SUSPENDED_ERROR = 'net::ERR_NETWORK_IO_SUSPENDED';
const NETWORK_IO_SUSPENDED_CONSOLE_ERROR =
  'Failed to load resource: net::ERR_NETWORK_IO_SUSPENDED';
const RETRYABLE_IMPLEMENTATION_SCRIPT_TRANSPORT_ERRORS = new Set([
  NETWORK_IO_SUSPENDED_ERROR,
  'net::ERR_NETWORK_CHANGED',
  'net::ERR_CONNECTION_CLOSED',
  'net::ERR_CONNECTION_RESET',
  'net::ERR_CONNECTION_ABORTED',
  'net::ERR_EMPTY_RESPONSE',
  'net::ERR_TIMED_OUT',
  'net::ERR_INTERNET_DISCONNECTED',
]);

const MUX_PLAYER_VERSION = JSON.parse(
  readFileSync(new URL('../../node_modules/@mux/mux-player/package.json', import.meta.url), 'utf8')
).version;
const MUX_PLAYBACK_CORE_VERSION = JSON.parse(
  readFileSync(new URL('../../node_modules/@mux/playback-core/package.json', import.meta.url), 'utf8')
).version;
const HLS_JS_VERSION = JSON.parse(
  readFileSync(new URL('../../node_modules/hls.js/package.json', import.meta.url), 'utf8')
).version;

const NETWORKS = {
  broadband: {
    latencyMs: 20,
    downMbps: 25,
    upMbps: 10,
    connectionType: 'wifi',
  },
  fast4g: {
    latencyMs: 60,
    downMbps: 8,
    upMbps: 3,
    connectionType: 'cellular4g',
  },
  median4g: {
    latencyMs: 100,
    downMbps: 4,
    upMbps: 1,
    connectionType: 'cellular4g',
  },
  constrained: {
    latencyMs: 180,
    downMbps: 1.5,
    upMbps: 0.5,
    connectionType: 'cellular3g',
  },
};

const DEVICES = {
  desktop: {
    viewport: { width: 1365, height: 768 },
    deviceScaleFactor: 1,
    cpuRate: 1,
    isMobile: false,
    hasTouch: false,
  },
  mobile: {
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    cpuRate: 4,
    isMobile: true,
    hasTouch: true,
    userAgentTemplate: 'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{MAJOR}.0.0.0 Mobile Safari/537.36',
  },
};

const MATRIX_BUILDERS = {
  smoke: () => [
    cell('broadband', 'desktop', 'vod-av', 'cold', false),
  ],
  core: () => cross(
    ['broadband', 'fast4g', 'constrained'],
    ['desktop', 'mobile'],
    ['vod-av'],
    ['cold'],
    [false]
  ),
  universal: () => cross(
    Object.keys(NETWORKS),
    Object.keys(DEVICES),
    ['product-av', 'vod-av'],
    ['cold', 'preloaded'],
    [false]
  ),
  formats: () => [
    cell('fast4g', 'desktop', 'vod-video', 'cold', false),
    cell('fast4g', 'desktop', 'vod-aes', 'cold', false),
    cell('fast4g', 'desktop', 'vod-ts', 'cold', false),
    cell('fast4g', 'desktop', 'progressive', 'cold', false),
    cell('fast4g', 'desktop', 'live', 'cold', false),
    cell('fast4g', 'desktop', 'vod-av', 'cold', true),
  ],
};

function cell(network, device, source, mode, seek) {
  return {
    id: [network, device, source, mode, seek ? 'seek' : 'startup'].join('/'),
    network,
    device,
    source,
    mode,
    seek,
  };
}

function cross(networks, devices, sources, modes, seeks) {
  const out = [];
  for (const network of networks) {
    for (const device of devices) {
      for (const source of sources) {
        for (const mode of modes) {
          for (const seek of seeks) out.push(cell(network, device, source, mode, seek));
        }
      }
    }
  }
  return out;
}

function selectedMatrix() {
  const names = (process.env.PLAYER_PERF_MATRIX || 'smoke')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
  const cells = [];
  for (const name of names) {
    const build = MATRIX_BUILDERS[name];
    if (!build) throw new Error(`Unknown PLAYER_PERF_MATRIX entry: ${name}`);
    cells.push(...build());
  }
  const unique = [...new Map(cells.map(entry => [entry.id, entry])).values()];
  const filter = process.env.PLAYER_PERF_FILTER;
  return filter ? unique.filter(entry => entry.id.includes(filter)) : unique;
}

function canonicalProofMatrix() {
  return [...new Map(
    [...MATRIX_BUILDERS.universal(), ...MATRIX_BUILDERS.formats()]
      .map(entry => [entry.id, entry])
  ).values()];
}

function hasCanonicalProofScope(matrix) {
  const actual = matrix.map(entry => entry.id).sort();
  const expected = canonicalProofMatrix().map(entry => entry.id).sort();
  return actual.length === expected.length
    && actual.every((id, index) => id === expected[index]);
}

function metricsForCell(matrixCell) {
  const metrics = [
    'pageLoadMs',
    'playerStartupMs',
    'videoStartupMs',
    'aggregateStartupMs',
    'playbackAdvanceMs',
  ];
  if (matrixCell.seek) metrics.push('seekLatencyMs', 'seekFrameLatencyMs');
  return metrics;
}

function qualityCheckpoints(matrixCell) {
  return matrixCell.seek
    ? ['firstFrame', 'steadyState', 'postSeek']
    : ['firstFrame', 'steadyState'];
}

function qualityDimensions(sample, checkpoint) {
  const prefix = checkpoint === 'postSeek'
    ? 'postSeek'
    : (checkpoint === 'steadyState' ? 'steadyState' : 'firstFrame');
  return {
    width: Number(sample[`${prefix}VideoWidth`]) || 0,
    height: Number(sample[`${prefix}VideoHeight`]) || 0,
  };
}

function summarizeQualityGate(pairs, matrixCell) {
  const violations = [];
  let nativeHigherResolutionCount = 0;
  for (const pair of pairs) {
    for (const checkpoint of qualityCheckpoints(matrixCell)) {
      const native = qualityDimensions(pair.native, checkpoint);
      const mux = qualityDimensions(pair.mux, checkpoint);
      if (!native.width || !native.height || !mux.width || !mux.height) {
        violations.push({
          pairIndex: pair.index,
          checkpoint,
          reason: 'missing-displayed-resolution',
          native,
          mux,
        });
        continue;
      }
      if (native.width < mux.width || native.height < mux.height) {
        violations.push({
          pairIndex: pair.index,
          checkpoint,
          reason: 'native-lower-displayed-resolution',
          native,
          mux,
        });
      } else if (native.width > mux.width || native.height > mux.height) {
        nativeHigherResolutionCount++;
      }
    }
  }
  return {
    rule: 'At every measured frame checkpoint, native displayed resolution must be at least Mux displayed resolution',
    checkpoints: qualityCheckpoints(matrixCell),
    pass: violations.length === 0,
    violationCount: violations.length,
    nativeHigherResolutionCount,
    violations,
  };
}

function summarizeSmoothnessGate(pairs) {
  function aggregate(implementation) {
    let droppedVideoFrames = 0;
    let totalVideoFrames = 0;
    let postStartWaitingCount = 0;
    let postStartWaitingSamples = 0;
    for (const pair of pairs) {
      const sample = pair[implementation];
      const dropped = Math.max(0, Number(sample.droppedVideoFrames) || 0);
      const total = Math.max(0, Number(sample.totalVideoFrames) || 0);
      const waits = Math.max(0, Number(sample.postStartWaitingCount) || 0);
      droppedVideoFrames += dropped;
      totalVideoFrames += total;
      postStartWaitingCount += waits;
      if (waits > 0) postStartWaitingSamples++;
    }
    return {
      droppedVideoFrames,
      totalVideoFrames,
      droppedFramePercentage: totalVideoFrames > 0
        ? droppedVideoFrames / totalVideoFrames * 100
        : null,
      postStartWaitingCount,
      postStartWaitingSamples,
      postStartWaitingSamplePercentage: pairs.length > 0
        ? postStartWaitingSamples / pairs.length * 100
        : null,
    };
  }

  const native = aggregate('native');
  const mux = aggregate('mux');
  const violations = [];
  if (native.totalVideoFrames <= 0 || mux.totalVideoFrames <= 0) {
    violations.push({ reason: 'missing-frame-quality-counters' });
  } else if (native.droppedFramePercentage > mux.droppedFramePercentage + 1) {
    violations.push({
      reason: 'native-dropped-frame-rate-more-than-one-percentage-point-above-mux',
      nativePercentage: native.droppedFramePercentage,
      muxPercentage: mux.droppedFramePercentage,
    });
  }
  if (native.postStartWaitingSamplePercentage > mux.postStartWaitingSamplePercentage + 1) {
    violations.push({
      reason: 'native-post-start-waiting-incidence-more-than-one-percentage-point-above-mux',
      nativePercentage: native.postStartWaitingSamplePercentage,
      muxPercentage: mux.postStartWaitingSamplePercentage,
    });
  }
  return {
    rule: 'Native aggregate dropped-frame rate and post-start waiting incidence may be at most one percentage point above Mux',
    native,
    mux,
    pass: violations.length === 0,
    violations,
  };
}

function encodedMediaRequest(request) {
  const mimeType = String(request.mimeType || '').toLowerCase();
  if (/^(audio|video)\//.test(mimeType)) return true;
  return mimeType === 'application/octet-stream'
    && String(request.url || '').includes('/hls-aes/');
}

function duplicateEncodedMediaRequests(sample) {
  const requestsByKey = new Map();
  for (const request of sample.networkRequests.filter(encodedMediaRequest)) {
    const key = `${request.url}|${request.range || ''}`;
    const requests = requestsByKey.get(key) || [];
    requests.push({
      url: request.url,
      range: request.range || '',
      status: request.status,
      failed: request.failed || '',
      startMs: request.startMs,
      durationMs: request.durationMs,
      encodedBytes: request.encodedBytes,
    });
    requestsByKey.set(key, requests);
  }
  return [...requestsByKey.entries()]
    .filter(([_key, requests]) => requests.length > 1)
    .map(([key, requests]) => ({
      key,
      duplicateCount: requests.length - 1,
      requests,
    }));
}

function summarizeNetworkEfficiencyGate(pairs) {
  const violations = [];
  let nativeDuplicateRequestCount = 0;
  let muxDuplicateRequestCount = 0;
  let nativeEncodedBytes = 0;
  let muxEncodedBytes = 0;
  for (const pair of pairs) {
    const nativeDuplicates = duplicateEncodedMediaRequests(pair.native);
    const muxDuplicates = duplicateEncodedMediaRequests(pair.mux);
    const nativeCount = nativeDuplicates.reduce((sum, group) => sum + group.duplicateCount, 0);
    const muxCount = muxDuplicates.reduce((sum, group) => sum + group.duplicateCount, 0);
    nativeDuplicateRequestCount += nativeCount;
    muxDuplicateRequestCount += muxCount;
    nativeEncodedBytes += Math.max(0, Number(pair.native.encodedBytes) || 0);
    muxEncodedBytes += Math.max(0, Number(pair.mux.encodedBytes) || 0);
    if (nativeCount > muxCount) {
      violations.push({
        pairIndex: pair.index,
        reason: 'native-duplicate-encoded-media-requests-exceed-mux',
        nativeDuplicateRequestCount: nativeCount,
        muxDuplicateRequestCount: muxCount,
        nativeDuplicates,
        muxDuplicates,
      });
    }
  }
  return {
    rule: 'Within every pair, native may not repeat more identical encoded-media URL/range requests than Mux',
    nativeDuplicateRequestCount,
    muxDuplicateRequestCount,
    nativeEncodedBytes,
    muxEncodedBytes,
    encodedByteRatio: muxEncodedBytes > 0 ? nativeEncodedBytes / muxEncodedBytes : null,
    pass: violations.length === 0,
    violations,
  };
}

function summarizeCollectionReliabilityGate(collectionFailures, sampleTarget) {
  const implementations = ['native', 'mux'];
  const attempted = Object.fromEntries(implementations.map(name => [name, sampleTarget]));
  const failed = Object.fromEntries(implementations.map(name => [name, 0]));
  for (const entry of collectionFailures) {
    for (const implementation of entry.attemptedImplementations || []) {
      if (Object.hasOwn(attempted, implementation)) attempted[implementation]++;
    }
    if (Object.hasOwn(failed, entry.failedImplementation)) {
      failed[entry.failedImplementation]++;
    }
  }
  const rates = Object.fromEntries(implementations.map(implementation => [
    implementation,
    attempted[implementation] > 0
      ? failed[implementation] / attempted[implementation]
      : null,
  ]));
  const violations = [];
  for (const implementation of implementations) {
    if (!Number.isFinite(rates[implementation])
      || rates[implementation] > MAX_COLLECTION_FAILURE_RATE) {
      violations.push({
        reason: `${implementation}-collection-failure-rate-exceeds-absolute-limit`,
        implementation,
        rate: rates[implementation],
        limit: MAX_COLLECTION_FAILURE_RATE,
      });
    }
  }
  if (rates.native > rates.mux + COLLECTION_FAILURE_NONINFERIORITY_MARGIN) {
    violations.push({
      reason: 'native-collection-failure-rate-more-than-one-percentage-point-above-mux',
      nativeRate: rates.native,
      muxRate: rates.mux,
      margin: COLLECTION_FAILURE_NONINFERIORITY_MARGIN,
    });
  }
  return {
    rule: 'Bounded transport retries are admissible only when each implementation stays at or below 1% and native is no more than one percentage point above Mux',
    maximumAttemptsPerPair: MAX_COLLECTION_ATTEMPTS,
    attempted,
    failed,
    rates,
    failureCount: collectionFailures.length,
    pass: violations.length === 0,
    violations,
  };
}

function summarizeIrrevocablePairGates(pair, matrixCell) {
  const samples = [pair.native, pair.mux];
  const errors = samples.filter(sample => sample.error);
  const consoleErrorSamples = samples.filter(sample => sample.consoleErrors.length);
  const cacheViolationSamples = samples.filter(sample => (
    sample.networkRequests.some(request => request.fromDiskCache || request.fromServiceWorker)
  ));
  const qualityGate = summarizeQualityGate([pair], matrixCell);
  const networkEfficiencyGate = summarizeNetworkEfficiencyGate([pair]);
  return {
    errors,
    consoleErrorSamples,
    cacheViolationSamples,
    qualityGate,
    networkEfficiencyGate,
    pass: errors.length === 0
      && consoleErrorSamples.length === 0
      && cacheViolationSamples.length === 0
      && qualityGate.pass
      && networkEfficiencyGate.pass,
  };
}

function fileEvidence(url) {
  const bytes = readFileSync(url);
  return {
    bytes: statSync(url).size,
    gzipBytes: gzipSync(bytes, { level: 9 }).byteLength,
    brotliBytes: brotliCompressSync(bytes).byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

function percentile(values, quantile) {
  if (!values.length) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * quantile;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function hashSeed(value) {
  return Number.parseInt(createHash('sha256').update(value).digest('hex').slice(0, 8), 16) >>> 0;
}

function mulberry32(seed) {
  return function random() {
    let value = seed += 0x6d2b79f5;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

function deterministicShuffle(values, seed) {
  const shuffled = [...values];
  const random = mulberry32(seed);
  for (let index = shuffled.length - 1; index > 0; index--) {
    const selected = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[selected]] = [shuffled[selected], shuffled[index]];
  }
  return shuffled;
}

function scheduledSampleIndex(roundIndex, sampleTarget, maximumSampleTarget) {
  if (roundIndex < 0 || sampleTarget < 1 || maximumSampleTarget < sampleTarget) return null;
  if (roundIndex === 0) return 0;
  const currentIndex = Math.floor((roundIndex * sampleTarget) / maximumSampleTarget);
  const previousIndex = Math.floor(((roundIndex - 1) * sampleTarget) / maximumSampleTarget);
  return currentIndex > previousIndex ? currentIndex : null;
}

function normalCdf(value) {
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * x);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const erf = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return 0.5 * (1 + sign * erf);
}

// Peter J. Acklam's inverse-normal approximation.
function inverseNormal(probability) {
  if (probability <= 0) return -Infinity;
  if (probability >= 1) return Infinity;
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const low = 0.02425;
  const high = 1 - low;
  let q;
  let r;
  if (probability < low) {
    q = Math.sqrt(-2 * Math.log(probability));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (probability <= high) {
    q = probability - 0.5;
    r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q
      / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  q = Math.sqrt(-2 * Math.log(1 - probability));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
    / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

function quantileDifference(nativeValues, muxValues, quantile) {
  return percentile(nativeValues, quantile) - percentile(muxValues, quantile);
}

function sortedIndexes(values) {
  return Array.from({ length: values.length }, (_value, index) => index)
    .sort((left, right) => values[left] - values[right]);
}

function weightedPercentile(values, order, counts, quantile) {
  const index = (counts.length - 1) * quantile;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  let cumulative = 0;
  let lowerValue;
  let upperValue;
  for (const sampleIndex of order) {
    cumulative += counts[sampleIndex];
    if (lowerValue === undefined && cumulative > lower) {
      lowerValue = values[sampleIndex];
    }
    if (cumulative > upper) {
      upperValue = values[sampleIndex];
      break;
    }
  }
  if (lowerValue === undefined || upperValue === undefined) return Number.NaN;
  if (lower === upper) return lowerValue;
  return lowerValue + (upperValue - lowerValue) * (index - lower);
}

function bcaUpperBounds(nativeValues, muxValues, quantile, confidences, iterations, seed) {
  const count = nativeValues.length;
  const observed = quantileDifference(nativeValues, muxValues, quantile);
  const random = mulberry32(seed);
  const nativeOrder = sortedIndexes(nativeValues);
  const muxOrder = sortedIndexes(muxValues);
  const bootstrap = new Array(iterations);
  for (let iteration = 0; iteration < iterations; iteration++) {
    // A paired resample is completely represented by the number of times each
    // pair index was drawn. Reading those counts in each implementation's
    // pre-sorted order is exactly equivalent to allocating and sorting two
    // resampled arrays, but makes the 100k × 384 proof tractable.
    const counts = new Uint16Array(count);
    for (let index = 0; index < count; index++) {
      const selected = Math.floor(random() * count);
      counts[selected]++;
    }
    bootstrap[iteration] = weightedPercentile(nativeValues, nativeOrder, counts, quantile)
      - weightedPercentile(muxValues, muxOrder, counts, quantile);
  }
  bootstrap.sort((a, b) => a - b);
  const lessThanObserved = bootstrap.filter(value => value < observed).length;
  const biasProbability = Math.min(1 - 1 / (2 * iterations), Math.max(1 / (2 * iterations), lessThanObserved / iterations));
  const biasCorrection = inverseNormal(biasProbability);

  const jackknife = new Array(count);
  for (let omitted = 0; omitted < count; omitted++) {
    jackknife[omitted] = quantileDifference(
      nativeValues.filter((_value, index) => index !== omitted),
      muxValues.filter((_value, index) => index !== omitted),
      quantile
    );
  }
  const jackknifeMean = jackknife.reduce((sum, value) => sum + value, 0) / jackknife.length;
  let numerator = 0;
  let denominatorSum = 0;
  for (const value of jackknife) {
    const delta = jackknifeMean - value;
    numerator += delta ** 3;
    denominatorSum += delta ** 2;
  }
  const acceleration = denominatorSum > 0
    ? numerator / (6 * denominatorSum ** 1.5)
    : 0;
  return Object.fromEntries(Object.entries(confidences).map(([name, confidence]) => {
    const z = inverseNormal(confidence);
    const adjusted = normalCdf(
      biasCorrection + (biasCorrection + z) / (1 - acceleration * (biasCorrection + z))
    );
    // Never let a bias adjustment produce a less conservative upper endpoint
    // than the unadjusted requested percentile interval. When an adjusted
    // tail would contain too few Monte Carlo draws to resolve, use the maximum
    // bootstrap estimate instead of pretending an unstable tail order
    // statistic is precise.
    const conservativeAdjusted = Math.max(confidence, adjusted);
    const adjustedTailDraws = iterations * (1 - conservativeAdjusted);
    const effectiveQuantile = adjustedTailDraws >= MIN_BOOTSTRAP_TAIL_DRAWS
      ? conservativeAdjusted
      : 1;
    return [name, {
      observed,
      upperBound: percentile(bootstrap, Math.max(0, Math.min(1, effectiveQuantile))),
      confidence,
      adjustedQuantile: adjusted,
      effectiveQuantile,
      effectiveTailDraws: effectiveQuantile < 1 ? iterations * (1 - effectiveQuantile) : 0,
      usedBootstrapMaximum: effectiveQuantile === 1,
      acceleration,
      biasCorrection,
    }];
  }));
}

function binomialProbabilities(count, probability) {
  if (!(probability > 0 && probability < 1)) {
    throw new Error(`Binomial probability must be strictly between zero and one: ${probability}`);
  }
  // Starting at P(X=0) underflows for proof-scale high quantiles
  // (for example, 0.05^500). Build relative probabilities outward from the
  // binomial mode and normalize; every recurrence value is then at most the
  // mode instead of depending on an unrepresentable tail.
  const probabilities = new Array(count + 1).fill(0);
  const mode = Math.min(count, Math.floor((count + 1) * probability));
  probabilities[mode] = 1;
  for (let successes = mode; successes > 0; successes--) {
    probabilities[successes - 1] = probabilities[successes]
      * (successes / (count - successes + 1))
      * ((1 - probability) / probability);
  }
  for (let successes = mode; successes < count; successes++) {
    probabilities[successes + 1] = probabilities[successes]
      * ((count - successes) / (successes + 1))
      * (probability / (1 - probability));
  }
  const total = probabilities.reduce((sum, value) => sum + value, 0);
  if (!(total > 0) || !Number.isFinite(total)) {
    throw new Error(`Could not normalize Binomial(${count}, ${probability}) probabilities`);
  }
  return probabilities.map(value => value / total);
}

function distributionFreeQuantileRanks(count, quantile, endpointConfidence) {
  const probabilities = binomialProbabilities(count, quantile);
  let upperRank = null;
  let upperCoverage = null;
  let cumulative = 0;
  for (let successes = 0; successes < count; successes++) {
    cumulative += probabilities[successes];
    if (cumulative >= endpointConfidence) {
      upperRank = successes + 1;
      upperCoverage = cumulative;
      break;
    }
  }

  let lowerRank = null;
  let lowerCoverage = null;
  cumulative = 0;
  for (let rank = 1; rank <= count; rank++) {
    cumulative += probabilities[rank - 1];
    const coverage = 1 - cumulative;
    if (coverage >= endpointConfidence) {
      lowerRank = rank;
      lowerCoverage = coverage;
    }
  }
  return {
    sampleCount: count,
    quantile,
    endpointConfidence,
    lowerRank,
    upperRank,
    lowerCoverage,
    upperCoverage,
    finite: lowerRank !== null && upperRank !== null,
  };
}

function distributionFreeQuantileDifferenceUpperBound(
  nativeValues,
  muxValues,
  quantile,
  endpointConfidence
) {
  const ranks = distributionFreeQuantileRanks(
    nativeValues.length,
    quantile,
    endpointConfidence
  );
  if (!ranks.finite) {
    return {
      ...ranks,
      nativeUpperMs: null,
      muxLowerMs: null,
      upperBound: null,
    };
  }
  const nativeSorted = [...nativeValues].sort((left, right) => left - right);
  const muxSorted = [...muxValues].sort((left, right) => left - right);
  const nativeUpperMs = nativeSorted[ranks.upperRank - 1];
  const muxLowerMs = muxSorted[ranks.lowerRank - 1];
  return {
    ...ranks,
    nativeUpperMs,
    muxLowerMs,
    upperBound: nativeUpperMs - muxLowerMs,
  };
}

function validateStatisticsImplementation() {
  const values = [11, 3, 7, 7, 19, 2];
  const counts = new Uint16Array([2, 0, 1, 2, 0, 1]);
  const expanded = [];
  for (let index = 0; index < values.length; index++) {
    for (let repetition = 0; repetition < counts[index]; repetition++) {
      expanded.push(values[index]);
    }
  }
  const order = sortedIndexes(values);
  for (const quantile of [0.5, 0.95]) {
    const weighted = weightedPercentile(values, order, counts, quantile);
    const explicitlyResampled = percentile(expanded, quantile);
    if (Math.abs(weighted - explicitlyResampled) > 1e-12) {
      throw new Error(
        `Weighted bootstrap quantile self-check failed at p${quantile * 100}: `
        + `${weighted} !== ${explicitlyResampled}`
      );
    }
  }

  const rankChecks = [
    {
      endpointConfidence: 1 - 0.05 / 2,
      expected: [
        [200, 0.5, 86, 115],
        [200, 0.95, 184, 197],
        [500, 0.5, 228, 273],
        [500, 0.95, 465, 485],
      ],
    },
    {
      endpointConfidence: 1 - 0.05 / (2 * 384),
      expected: [
        [200, 0.5, 73, 128],
        [200, 0.95, 176, 200],
        [500, 0.5, 207, 294],
        [500, 0.95, 454, 492],
      ],
    },
  ];
  for (const { endpointConfidence, expected } of rankChecks) {
    for (const [count, quantile, lowerRank, upperRank] of expected) {
      const ranks = distributionFreeQuantileRanks(count, quantile, endpointConfidence);
      if (ranks.lowerRank !== lowerRank
        || ranks.upperRank !== upperRank
        || ranks.lowerCoverage < endpointConfidence
        || ranks.upperCoverage < endpointConfidence) {
        throw new Error('Distribution-free quantile-rank self-check failed');
      }
    }
  }

  const oneNativeCollectionFailure = summarizeCollectionReliabilityGate([{
    attemptedImplementations: ['mux', 'native'],
    failedImplementation: 'native',
  }], 200);
  const threeNativeCollectionFailures = summarizeCollectionReliabilityGate(
    Array.from({ length: 3 }, () => ({
      attemptedImplementations: ['mux', 'native'],
      failedImplementation: 'native',
    })),
    200
  );
  if (!oneNativeCollectionFailure.pass
    || oneNativeCollectionFailure.failed.native !== 1
    || oneNativeCollectionFailure.attempted.native !== 201
    || threeNativeCollectionFailures.pass
    || !threeNativeCollectionFailures.violations.some(entry => (
      entry.reason === 'native-collection-failure-rate-exceeds-absolute-limit'
    ))) {
    throw new Error('Collection-reliability gate self-check failed');
  }

  for (const [sampleTarget, expectedLastRound] of [[200, 498], [500, 499]]) {
    const scheduled = Array.from({ length: 500 }, (_value, roundIndex) => (
      scheduledSampleIndex(roundIndex, sampleTarget, 500)
    )).filter(Number.isInteger);
    const actualLastRound = Array.from({ length: 500 }, (_value, index) => index)
      .findLast(roundIndex => scheduledSampleIndex(roundIndex, sampleTarget, 500) !== null);
    if (scheduled.length !== sampleTarget
      || scheduled[0] !== 0
      || scheduled.at(-1) !== sampleTarget - 1
      || scheduled.some((sampleIndex, index) => sampleIndex !== index)
      || actualLastRound !== expectedLastRound) {
      throw new Error(`Interleaved sample scheduling self-check failed for target ${sampleTarget}`);
    }
  }
}

function finiteMetric(samples, name) {
  return samples.map(sample => Number(sample[name])).filter(Number.isFinite);
}

function metricMargin(muxValue) {
  return Math.max(25, Math.abs(muxValue) * 0.05);
}

function summarizeMetric(
  pairs,
  metric,
  quantile,
  nonInferiorityConfidence,
  superiorityConfidence,
  iterations,
  cellId,
  nonInferiorityEndpointConfidence,
  superiorityEndpointConfidence,
  requireDistributionFree
) {
  const nativeValues = finiteMetric(pairs.map(pair => pair.native), metric);
  const muxValues = finiteMetric(pairs.map(pair => pair.mux), metric);
  if (nativeValues.length !== pairs.length || muxValues.length !== pairs.length) {
    return {
      metric,
      percentile: quantile,
      pass: false,
      reason: 'missing-samples',
      nativeSampleCount: nativeValues.length,
      muxSampleCount: muxValues.length,
    };
  }
  const nativeValue = percentile(nativeValues, quantile);
  const muxValue = percentile(muxValues, quantile);
  const bootstrapBounds = bcaUpperBounds(
    nativeValues,
    muxValues,
    quantile,
    {
      nonInferiority: nonInferiorityConfidence,
      superiorityFamilyWise: superiorityConfidence,
    },
    iterations,
    hashSeed(`${cellId}/${metric}/${quantile}`)
  );
  const exactNonInferiorityBound = distributionFreeQuantileDifferenceUpperBound(
    nativeValues,
    muxValues,
    quantile,
    nonInferiorityEndpointConfidence
  );
  const exactSuperiorityBound = distributionFreeQuantileDifferenceUpperBound(
    nativeValues,
    muxValues,
    quantile,
    superiorityEndpointConfidence
  );
  const marginBasis = requireDistributionFree && exactNonInferiorityBound.finite
    ? exactNonInferiorityBound.muxLowerMs
    : muxValue;
  const margin = metricMargin(marginBasis);
  const nonInferiorityUpperBound = requireDistributionFree
    ? (exactNonInferiorityBound.finite
      ? Math.max(
        bootstrapBounds.nonInferiority.upperBound,
        exactNonInferiorityBound.upperBound
      )
      : null)
    : bootstrapBounds.nonInferiority.upperBound;
  const superiorityFamilyWiseUpperBound = requireDistributionFree
    ? (exactSuperiorityBound.finite
      ? Math.max(
        bootstrapBounds.superiorityFamilyWise.upperBound,
        exactSuperiorityBound.upperBound
      )
      : null)
    : bootstrapBounds.superiorityFamilyWise.upperBound;
  const pass = Number.isFinite(nonInferiorityUpperBound)
    && nonInferiorityUpperBound <= margin;
  return {
    metric,
    percentile: quantile,
    nativeMs: nativeValue,
    muxMs: muxValue,
    deltaMs: nativeValue - muxValue,
    ratio: muxValue > 0 ? nativeValue / muxValue : null,
    sampleNonInferiorityMarginMs: metricMargin(muxValue),
    nonInferiorityMarginMs: margin,
    nonInferiorityMarginBasis: requireDistributionFree
      ? 'distribution-free 97.5% lower endpoint for the Mux population quantile'
      : 'observed Mux sample percentile',
    nonInferiorityUpperBoundMs: nonInferiorityUpperBound,
    // Retained as an explicit compatibility alias for older report readers.
    simultaneousUpperBoundMs: nonInferiorityUpperBound,
    distributionFreeUpperBoundMs: exactNonInferiorityBound.upperBound,
    distributionFreeRanks: {
      lowerMuxRank: exactNonInferiorityBound.lowerRank,
      upperNativeRank: exactNonInferiorityBound.upperRank,
      lowerMuxCoverage: exactNonInferiorityBound.lowerCoverage,
      upperNativeCoverage: exactNonInferiorityBound.upperCoverage,
      endpointConfidence: exactNonInferiorityBound.endpointConfidence,
    },
    bcaUpperBoundMs: bootstrapBounds.nonInferiority.upperBound,
    superiorityFamilyWiseUpperBoundMs: superiorityFamilyWiseUpperBound,
    superiorityDistributionFreeUpperBoundMs: exactSuperiorityBound.upperBound,
    superiorityDistributionFreeRanks: {
      lowerMuxRank: exactSuperiorityBound.lowerRank,
      upperNativeRank: exactSuperiorityBound.upperRank,
      lowerMuxCoverage: exactSuperiorityBound.lowerCoverage,
      upperNativeCoverage: exactSuperiorityBound.upperCoverage,
      endpointConfidence: exactSuperiorityBound.endpointConfidence,
    },
    superiorityBcaUpperBoundMs: bootstrapBounds.superiorityFamilyWise.upperBound,
    pass,
    verdict: pass
      && Number.isFinite(superiorityFamilyWiseUpperBound)
      && superiorityFamilyWiseUpperBound < 0
      ? 'native-better'
      : (pass ? 'parity' : 'not-proven'),
    confidence: bootstrapBounds.nonInferiority.confidence,
    adjustedBootstrapQuantile: bootstrapBounds.nonInferiority.adjustedQuantile,
    effectiveBootstrapQuantile: bootstrapBounds.nonInferiority.effectiveQuantile,
    effectiveBootstrapTailDraws: bootstrapBounds.nonInferiority.effectiveTailDraws,
    usedBootstrapMaximum: bootstrapBounds.nonInferiority.usedBootstrapMaximum,
    superiorityConfidence: bootstrapBounds.superiorityFamilyWise.confidence,
    superiorityAdjustedBootstrapQuantile:
      bootstrapBounds.superiorityFamilyWise.adjustedQuantile,
    superiorityEffectiveBootstrapQuantile:
      bootstrapBounds.superiorityFamilyWise.effectiveQuantile,
    superiorityEffectiveBootstrapTailDraws:
      bootstrapBounds.superiorityFamilyWise.effectiveTailDraws,
    superiorityUsedBootstrapMaximum:
      bootstrapBounds.superiorityFamilyWise.usedBootstrapMaximum,
  };
}

async function configureConditions(browserName, page, network, device) {
  if (browserName !== 'chromium') {
    if (network !== NETWORKS.broadband || device.cpuRate !== 1) {
      throw new Error('Network and CPU emulation currently require Chromium CDP');
    }
    return { session: null, getBytes: () => 0, getRequests: () => [] };
  }
  const session = await page.context().newCDPSession(page);
  let encodedBytes = 0;
  const requests = new Map();
  await session.send('Network.enable');
  session.on('Network.requestWillBeSent', event => {
    requests.set(event.requestId, {
      url: event.request.url,
      method: event.request.method,
      type: event.type,
      range: event.request.headers.Range || event.request.headers.range || '',
      startedAt: event.timestamp,
      status: 0,
      mimeType: '',
      fromDiskCache: false,
      fromServiceWorker: false,
      encodedBytes: 0,
      failed: '',
    });
  });
  session.on('Network.responseReceived', event => {
    const request = requests.get(event.requestId);
    if (!request) return;
    request.status = event.response.status;
    request.mimeType = event.response.mimeType || '';
    request.fromDiskCache = !!event.response.fromDiskCache;
    request.fromServiceWorker = !!event.response.fromServiceWorker;
  });
  session.on('Network.loadingFinished', event => {
    encodedBytes += Number(event.encodedDataLength) || 0;
    const request = requests.get(event.requestId);
    if (!request) return;
    request.finishedAt = event.timestamp;
    request.encodedBytes = Number(event.encodedDataLength) || 0;
  });
  session.on('Network.loadingFailed', event => {
    const request = requests.get(event.requestId);
    if (!request) return;
    request.finishedAt = event.timestamp;
    request.failed = event.errorText || 'network-failed';
    request.canceled = !!event.canceled;
    request.blockedReason = event.blockedReason || '';
    request.corsErrorStatus = event.corsErrorStatus || null;
  });
  await session.send('Network.setCacheDisabled', { cacheDisabled: true });
  await session.send('Network.clearBrowserCache');
  const conditions = {
    offline: false,
    latency: network.latencyMs,
    // CDP expects bytes/second; network Mbps are decimal SI units.
    downloadThroughput: network.downMbps * 1_000_000 / 8,
    uploadThroughput: network.upMbps * 1_000_000 / 8,
    connectionType: network.connectionType,
  };
  await session.send('Network.emulateNetworkConditions', conditions);
  await session.send('Emulation.setCPUThrottlingRate', { rate: device.cpuRate });
  return {
    session,
    getBytes: () => encodedBytes,
    getRequests: () => {
      const completed = [...requests.values()];
      const origin = completed.reduce(
        (minimum, request) => Math.min(minimum, request.startedAt),
        Number.POSITIVE_INFINITY
      );
      return completed
        .sort((left, right) => left.startedAt - right.startedAt)
        .map(request => ({
          url: request.url,
          method: request.method,
          type: request.type,
          range: request.range,
          startMs: Number.isFinite(origin) ? (request.startedAt - origin) * 1000 : 0,
          durationMs: request.finishedAt
            ? (request.finishedAt - request.startedAt) * 1000
            : null,
          status: request.status,
          mimeType: request.mimeType,
          fromDiskCache: request.fromDiskCache,
          fromServiceWorker: request.fromServiceWorker,
          encodedBytes: request.encodedBytes,
          failed: request.failed,
          canceled: request.canceled || false,
          blockedReason: request.blockedReason || '',
          corsErrorStatus: request.corsErrorStatus || null,
        }));
    },
  };
}

async function prewarmBenchmarkServer(baseURL) {
  const paths = [
    '/__player-benchmark',
    '/native-player-engine.js?v=17',
    '/__player-benchmark/mux-player.js',
    '/api/stream/PLAYERTEST1/dash.mpd',
    '/api/stream/PLAYERTEST1/hls.m3u8?fixtureHls=benchmark-groups',
    '/api/stream/PLAYERTEST1/hls.m3u8?fixtureHls=aes',
    '/api/stream/PLAYERTEST1/hls.m3u8?fixtureHls=ts-muxed',
    '/api/stream/PLAYERTEST1/hls.m3u8?fixtureHls=live&fixtureLiveKey=prewarm',
    '/api/stream/PLAYERTEST1/progressive.mp4',
  ];
  for (const path of paths) {
    const response = await fetch(new URL(path, baseURL));
    if (!response.ok) throw new Error(`Benchmark prewarm failed: ${response.status} ${path}`);
    await response.arrayBuffer();
  }
}

function errorMessage(error) {
  return error && error.message ? error.message : String(error);
}

function settleWithin(promise, timeoutMs, label) {
  let timeoutId;
  const timeout = new Promise((_resolve, reject) => {
    timeoutId = setTimeout(() => reject(new Error(label)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

function classifyImplementationScriptTransportFailure(
  implementation,
  fixtureResult,
  networkRequests
) {
  if (fixtureResult?.error !== 'implementation-script-load-failed') return null;
  const expectedPath = IMPLEMENTATION_SCRIPT_PATHS[implementation];
  if (!expectedPath) return null;
  const request = networkRequests.find(candidate => {
    if (candidate.type !== 'Script') return false;
    try {
      return new URL(candidate.url).pathname === expectedPath;
    } catch {
      return false;
    }
  });
  if (!request
    || request.encodedBytes !== 0
    || !RETRYABLE_IMPLEMENTATION_SCRIPT_TRANSPORT_ERRORS.has(request.failed)
    || request.canceled
    || request.blockedReason
    || request.corsErrorStatus
    || (request.status !== 0 && (request.status < 200 || request.status >= 300))) {
    return null;
  }
  return {
    error: request.failed,
    request,
  };
}

function classifyCompletedBenchmarkNetworkIoSuspension({
  implementation,
  fixtureResult,
  consoleErrors,
  networkRequests,
  benchmarkOrigin,
}) {
  if (!fixtureResult
    || fixtureResult.error
    || !Array.isArray(consoleErrors)
    || consoleErrors.length === 0
    || !consoleErrors.every(error => error === NETWORK_IO_SUSPENDED_CONSOLE_ERROR)
    || !Array.isArray(networkRequests)) {
    return null;
  }
  let normalizedBenchmarkOrigin;
  try {
    normalizedBenchmarkOrigin = new URL(benchmarkOrigin).origin;
  } catch {
    return null;
  }
  const suspendedRequests = networkRequests.filter(
    request => request.failed === NETWORK_IO_SUSPENDED_ERROR
  );
  if (!suspendedRequests.length || suspendedRequests.some(request => {
    let requestOrigin;
    try {
      requestOrigin = new URL(request.url).origin;
    } catch {
      return true;
    }
    return requestOrigin !== normalizedBenchmarkOrigin
      || request.encodedBytes !== 0
      || request.canceled
      || request.blockedReason
      || request.corsErrorStatus
      || (request.status !== 0 && (request.status < 200 || request.status >= 300));
  })) {
    return null;
  }
  return {
    implementation,
    error: NETWORK_IO_SUSPENDED_ERROR,
    requests: suspendedRequests,
    consoleErrors: [...consoleErrors],
  };
}

function validateCollectionFailureClassification() {
  const nativeRequest = {
    url: 'http://127.0.0.1:3012/native-player-engine.js?v=17',
    type: 'Script',
    status: 200,
    encodedBytes: 0,
    failed: 'net::ERR_NETWORK_IO_SUSPENDED',
  };
  const fixtureResult = { error: 'implementation-script-load-failed' };
  if (!classifyImplementationScriptTransportFailure('native', fixtureResult, [nativeRequest])) {
    throw new Error('Collection classifier rejected a proven zero-byte script transport failure');
  }
  const muxRequest = {
    ...nativeRequest,
    url: 'http://127.0.0.1:3012/__player-benchmark/mux-player.js',
  };
  if (!classifyImplementationScriptTransportFailure('mux', fixtureResult, [muxRequest])) {
    throw new Error('Collection classifier is not symmetric for the Mux implementation asset');
  }
  const mustRemainHardFailures = [
    { ...nativeRequest, status: 404 },
    { ...nativeRequest, encodedBytes: 1 },
    { ...nativeRequest, failed: 'net::ERR_BLOCKED_BY_CLIENT' },
    { ...nativeRequest, url: 'http://127.0.0.1:3012/unrelated.js' },
    { ...nativeRequest, canceled: true },
    { ...nativeRequest, blockedReason: 'inspector' },
    { ...nativeRequest, corsErrorStatus: { corsError: 'InvalidResponse' } },
  ];
  if (mustRemainHardFailures.some(request => (
    classifyImplementationScriptTransportFailure('native', fixtureResult, [request])
  ))) {
    throw new Error('Collection classifier made a non-transport script failure retryable');
  }
  if (classifyImplementationScriptTransportFailure(
    'native',
    { error: 'media-error' },
    [nativeRequest]
  )) {
    throw new Error('Collection classifier made a completed player failure retryable');
  }

  const successfulFixtureResult = { error: '' };
  const suspendedMediaRequest = {
    url: 'http://127.0.0.1:3012/api/stream/PLAYERTEST1/fmt/v720',
    type: 'XHR',
    status: 206,
    encodedBytes: 0,
    failed: NETWORK_IO_SUSPENDED_ERROR,
    canceled: false,
    blockedReason: '',
    corsErrorStatus: null,
  };
  for (const implementation of ['native', 'mux']) {
    if (!classifyCompletedBenchmarkNetworkIoSuspension({
      implementation,
      fixtureResult: successfulFixtureResult,
      consoleErrors: [NETWORK_IO_SUSPENDED_CONSOLE_ERROR],
      networkRequests: [suspendedMediaRequest],
      benchmarkOrigin: 'http://127.0.0.1:3012',
    })) {
      throw new Error(
        `Completed network-I/O suspension classifier is not symmetric for ${implementation}`
      );
    }
  }
  const suspensionMustRemainHardFailures = [
    {
      fixtureResult: { error: 'media-error' },
      consoleErrors: [NETWORK_IO_SUSPENDED_CONSOLE_ERROR],
      request: suspendedMediaRequest,
    },
    {
      fixtureResult: successfulFixtureResult,
      consoleErrors: [
        NETWORK_IO_SUSPENDED_CONSOLE_ERROR,
        'Unrelated player console failure',
      ],
      request: suspendedMediaRequest,
    },
    {
      fixtureResult: successfulFixtureResult,
      consoleErrors: [NETWORK_IO_SUSPENDED_CONSOLE_ERROR],
      request: { ...suspendedMediaRequest, encodedBytes: 1 },
    },
    {
      fixtureResult: successfulFixtureResult,
      consoleErrors: [NETWORK_IO_SUSPENDED_CONSOLE_ERROR],
      request: { ...suspendedMediaRequest, status: 500 },
    },
    {
      fixtureResult: successfulFixtureResult,
      consoleErrors: [NETWORK_IO_SUSPENDED_CONSOLE_ERROR],
      request: { ...suspendedMediaRequest, canceled: true },
    },
    {
      fixtureResult: successfulFixtureResult,
      consoleErrors: [NETWORK_IO_SUSPENDED_CONSOLE_ERROR],
      request: { ...suspendedMediaRequest, blockedReason: 'inspector' },
    },
    {
      fixtureResult: successfulFixtureResult,
      consoleErrors: [NETWORK_IO_SUSPENDED_CONSOLE_ERROR],
      request: {
        ...suspendedMediaRequest,
        corsErrorStatus: { corsError: 'InvalidResponse' },
      },
    },
    {
      fixtureResult: successfulFixtureResult,
      consoleErrors: [NETWORK_IO_SUSPENDED_CONSOLE_ERROR],
      request: {
        ...suspendedMediaRequest,
        url: 'http://example.invalid/api/stream/PLAYERTEST1/fmt/v720',
      },
    },
    {
      fixtureResult: successfulFixtureResult,
      consoleErrors: [NETWORK_IO_SUSPENDED_CONSOLE_ERROR],
      request: { ...suspendedMediaRequest, failed: 'net::ERR_CONNECTION_RESET' },
    },
  ];
  if (suspensionMustRemainHardFailures.some(({
    fixtureResult: completedResult,
    consoleErrors,
    request,
  }) => classifyCompletedBenchmarkNetworkIoSuspension({
    implementation: 'native',
    fixtureResult: completedResult,
    consoleErrors,
    networkRequests: [request],
    benchmarkOrigin: 'http://127.0.0.1:3012',
  }))) {
    throw new Error(
      'Completed network-I/O suspension classifier made a non-infrastructure failure retryable'
    );
  }
}

async function collectSample({
  browser,
  browserName,
  baseURL,
  implementation,
  cell: matrixCell,
  pairIndex,
  attemptIndex,
}) {
  const device = DEVICES[matrixCell.device];
  const network = NETWORKS[matrixCell.network];
  let browserVersion = '';
  let context = null;
  let page = null;
  let networkState = null;
  const consoleErrors = [];
  let result = null;
  let collectionFailure = null;
  let phase = 'browser-version';
  try {
    browserVersion = await browser.version();
    const userAgent = device.userAgentTemplate
      ? device.userAgentTemplate.replace('{MAJOR}', browserVersion.split('.')[0])
      : undefined;
    phase = 'browser-context';
    context = await browser.newContext({
      viewport: device.viewport,
      deviceScaleFactor: device.deviceScaleFactor,
      isMobile: device.isMobile,
      hasTouch: device.hasTouch,
      ...(userAgent ? { userAgent } : {}),
      serviceWorkers: 'block',
    });
    phase = 'page';
    page = await context.newPage();
    page.on('console', message => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', error => consoleErrors.push(error.message));
    phase = 'network-control';
    networkState = await configureConditions(browserName, page, network, device);
    const url = new URL('/__player-benchmark', baseURL);
    url.searchParams.set('implementation', implementation);
    url.searchParams.set('mode', matrixCell.mode);
    url.searchParams.set('source', matrixCell.source);
    url.searchParams.set('seek', matrixCell.seek ? '1' : '0');
    url.searchParams.set(
      'run',
      `${matrixCell.id}-${pairIndex}-${implementation}-attempt-${attemptIndex + 1}`
    );
    phase = 'navigation';
    await page.goto(url.toString(), {
      waitUntil: 'domcontentloaded',
      timeout: COLLECTION_NAVIGATION_TIMEOUT_MS,
    });
    phase = 'fixture-result';
    result = await settleWithin(
      page.evaluate(() => window.__playerBenchmarkDone),
      COLLECTION_RESULT_TIMEOUT_MS,
      `fixture-result-timeout-${COLLECTION_RESULT_TIMEOUT_MS}`
    );
    if (!result || typeof result !== 'object') {
      throw new Error('fixture-result-invalid');
    }
  } catch (error) {
    let pageDiagnostic = null;
    if (page) {
      try {
        pageDiagnostic = await settleWithin(
          page.evaluate(() => ({
            complete: window.__playerBenchmarkComplete === true,
            result: window.__playerBenchmarkResult || null,
          })),
          COLLECTION_DIAGNOSTIC_TIMEOUT_MS,
          `collection-diagnostic-timeout-${COLLECTION_DIAGNOSTIC_TIMEOUT_MS}`
        );
      } catch {}
    }
    if (pageDiagnostic?.complete
      && pageDiagnostic.result
      && typeof pageDiagnostic.result === 'object') {
      result = pageDiagnostic.result;
    } else {
      collectionFailure = {
        implementation,
        phase,
        error: errorMessage(error),
        pageDiagnostic,
      };
    }
  }
  const encodedBytes = networkState ? networkState.getBytes() : 0;
  const networkRequests = networkState ? networkState.getRequests() : [];
  const implementationScriptTransportFailure = result
    ? classifyImplementationScriptTransportFailure(
      implementation,
      result,
      networkRequests
    )
    : null;
  const completedBenchmarkNetworkIoSuspension = result
    ? classifyCompletedBenchmarkNetworkIoSuspension({
      implementation,
      fixtureResult: result,
      consoleErrors,
      networkRequests,
      benchmarkOrigin: baseURL,
    })
    : null;
  if (implementationScriptTransportFailure) {
    collectionFailure = {
      implementation,
      phase: 'implementation-script-transport',
      error: implementationScriptTransportFailure.error,
      fixtureCompleted: true,
      completedFixtureResult: result,
      transportRequest: implementationScriptTransportFailure.request,
    };
    result = null;
  } else if (completedBenchmarkNetworkIoSuspension) {
    collectionFailure = {
      implementation,
      phase: 'benchmark-network-io-suspension',
      error: completedBenchmarkNetworkIoSuspension.error,
      fixtureCompleted: true,
      completedFixtureResult: result,
      transportRequests: completedBenchmarkNetworkIoSuspension.requests,
      matchedConsoleErrors: completedBenchmarkNetworkIoSuspension.consoleErrors,
    };
    result = null;
  }
  if (result) {
    result.encodedBytes = encodedBytes;
    result.networkRequests = networkRequests;
    result.consoleErrors = consoleErrors;
    result.browserVersion = browserVersion;
  }
  if (collectionFailure) {
    collectionFailure.encodedBytes = encodedBytes;
    collectionFailure.networkRequests = networkRequests;
    collectionFailure.consoleErrors = consoleErrors;
    collectionFailure.browserVersion = browserVersion;
  }
  if (networkState && networkState.session) {
    try { await networkState.session.detach(); } catch {}
  }
  if (context) {
    try { await context.close(); } catch {}
  }
  return { sample: result, collectionFailure };
}

function formatMs(value) {
  return Number.isFinite(value) ? `${value.toFixed(1)}ms` : 'n/a';
}

test('native player has universal p50/p95 non-inferiority to Mux', async ({
  browser,
  browserName,
  baseURL,
}) => {
  const proofMode = process.env.PLAYER_PERF_PROOF === '1';
  const samplesPerCell = Math.floor(Math.max(
    2,
    Number(process.env.PLAYER_PERF_SAMPLES) || (proofMode ? MIN_PROOF_SAMPLES : 4)
  ));
  const bootstrapIterations = Math.floor(Math.max(
    proofMode ? MIN_PROOF_BOOTSTRAPS : 1_000,
    Number(process.env.PLAYER_PERF_BOOTSTRAPS) || (proofMode ? MIN_PROOF_BOOTSTRAPS : 2_000)
  ));
  const matrix = selectedMatrix();
  if (!matrix.length) throw new Error('The selected performance matrix is empty');
  const requestedSeekSamples = Math.floor(Math.max(
    samplesPerCell,
    Number(process.env.PLAYER_PERF_SEEK_SAMPLES)
      || (proofMode ? MIN_PROOF_SEEK_SAMPLES : samplesPerCell)
  ));
  const samplesByCell = Object.fromEntries(matrix.map(matrixCell => [
    matrixCell.id,
    matrixCell.seek ? requestedSeekSamples : samplesPerCell,
  ]));
  const sampleCounts = [...new Set(Object.values(samplesByCell))].sort((left, right) => left - right);
  const maximumSamplesPerCell = Math.max(...sampleCounts);
  const totalPairedRuns = Object.values(samplesByCell).reduce((sum, count) => sum + count, 0);
  const outputPath = process.env.PLAYER_PERF_OUTPUT || 'tmp/player-performance/latest.json';
  const checkpointPath = process.env.PLAYER_PERF_CHECKPOINT_OUTPUT || `${outputPath}.checkpoint.ndjson`;
  const resumeEnabled = process.env.PLAYER_PERF_RESUME === '1';
  const metricsPerCell = matrix
    .map(entry => metricsForCell(entry).length * 2)
    .reduce((sum, count) => sum + count, 0);
  const globalAlpha = 0.05;
  // Universal parity is a co-primary intersection-union test: the global null
  // says at least one cell/metric/percentile is inferior, and parity is
  // concluded only if every component null is rejected. Testing every
  // component at alpha controls the global Type I error at alpha without a
  // multiplicity penalty. Each distribution-free difference bound still
  // splits its component alpha across the native-upper and Mux-lower endpoints.
  const nonInferiorityConfidence = 1 - globalAlpha;
  const nonInferiorityEndpointConfidence = 1 - globalAlpha / 2;
  // “Native better” is a different, disjunctive reporting family: any
  // individual superiority finding may be reported. Keep Bonferroni family-
  // wise protection for those optional findings.
  const superiorityClaimAlpha = globalAlpha / metricsPerCell;
  const superiorityConfidence = 1 - superiorityClaimAlpha;
  const superiorityEndpointConfidence = 1 - superiorityClaimAlpha / 2;
  const nonInferiorityRankCoverageBySampleCount = Object.fromEntries(sampleCounts.map(sampleCount => [
    sampleCount,
    Object.fromEntries(
      [0.5, 0.95].map(quantile => [
        `p${quantile * 100}`,
        distributionFreeQuantileRanks(
          sampleCount,
          quantile,
          nonInferiorityEndpointConfidence
        ),
      ])
    ),
  ]));
  const superiorityRankCoverageBySampleCount = Object.fromEntries(sampleCounts.map(sampleCount => [
    sampleCount,
    Object.fromEntries(
      [0.5, 0.95].map(quantile => [
        `p${quantile * 100}`,
        distributionFreeQuantileRanks(
          sampleCount,
          quantile,
          superiorityEndpointConfidence
        ),
      ])
    ),
  ]));
  const exactBoundsFinite = Object.values(nonInferiorityRankCoverageBySampleCount)
    .flatMap(entry => Object.values(entry))
    .every(entry => entry.finite);
  const proofScopeComplete = hasCanonicalProofScope(matrix);
  const proofSampleScopeComplete = matrix.every(matrixCell => (
    samplesByCell[matrixCell.id] >= (matrixCell.seek
      ? MIN_PROOF_SEEK_SAMPLES
      : MIN_PROOF_SAMPLES)
  ));
  validateStatisticsImplementation();
  validateCollectionFailureClassification();
  await prewarmBenchmarkServer(baseURL);
  const report = {
    schemaVersion: 12,
    generatedAt: new Date().toISOString(),
    proofMode,
    proofScopeComplete,
    proofEligible: proofMode
      && proofScopeComplete
      && proofSampleScopeComplete
      && bootstrapIterations >= MIN_PROOF_BOOTSTRAPS
      && bootstrapIterations * superiorityClaimAlpha >= MIN_BOOTSTRAP_TAIL_DRAWS
      && exactBoundsFinite,
    samplesPerCell,
    samplesByCell,
    totalPairedRuns,
    targetedTailPower: {
      rule: `Every cell has at least ${MIN_PROOF_SAMPLES} pairs; the seek cell has at least ${MIN_PROOF_SEEK_SAMPLES}`,
      rationale: 'Buffered seek event and visible-frame latencies have the sparsest, most variable tails. Targeted seek oversampling tightens their exact and paired-bootstrap p95 bounds without changing the margin or metric.',
    },
    pairedRuns: true,
    statisticsSelfCheck: true,
    pairOrder: 'strictly alternating per cell with deterministic seeded first implementation',
    cellOrder: 'per-cell targets evenly distributed across global rounds with a deterministic seeded shuffle of active cells each round',
    coldCache: true,
    serverPrewarmed: true,
    globalNonInferiorityTest: {
      method: 'intersection-union test over co-primary cell/metric/percentile claims',
      confidence: nonInferiorityConfidence,
      alpha: globalAlpha,
      decisionRule: 'Pass only when every component one-sided 95% non-inferiority bound is within its margin',
      multiplicityAdjustment: 'none required: every co-primary component must pass',
      claimCount: metricsPerCell,
    },
    superiorityReportingFamily: {
      confidence: 1 - globalAlpha,
      alpha: globalAlpha,
      claimConfidence: superiorityConfidence,
      claimCount: metricsPerCell,
      multiplicityAdjustment: 'Bonferroni',
      decisionRule: 'Report native-better only when the family-wise upper bound is below 0ms',
    },
    bootstrap: {
      method: 'paired-bca',
      iterations: bootstrapIterations,
      nonInferiorityConfidence,
      nonInferiorityMultiplicityCorrection: 'none: co-primary intersection-union decision',
      superiorityConfidence,
      superiorityMultiplicityCorrection: 'Bonferroni',
      sampleQuantile: 'R-7 linear interpolation',
      conservativeUpperEndpoint: 'max(BCa, requested percentile); bootstrap maximum when adjusted tail has fewer than 10 draws',
      nominalNonInferiorityUpperTailDraws: bootstrapIterations * globalAlpha,
      nominalSuperiorityUpperTailDraws: bootstrapIterations * superiorityClaimAlpha,
    },
    distributionFreeInference: {
      method: 'exact binomial order-statistic bounds',
      target: 'population quantile difference',
      assumption: 'iid paired observations within each declared cell; no parametric distribution assumption',
      nonInferiorityEndpointConfidence,
      nonInferiorityEndpointCorrection: 'Bonferroni across the two endpoints within each component difference bound',
      nonInferiorityRankCoverageBySampleCount,
      superiorityEndpointConfidence,
      superiorityEndpointCorrection: 'Bonferroni across two endpoints and every optional superiority finding',
      superiorityRankCoverageBySampleCount,
      decisionUpperBound: 'max(exact distribution-free upper bound, paired BCa upper bound)',
    },
    nonInferiorityMargin: 'max(25ms, 5% of Mux percentile)',
    qualityFairnessRule: 'Native timing is admissible only when its displayed resolution is no lower than Mux at the corresponding frame checkpoint',
    smoothnessFairnessRule: 'Native aggregate dropped-frame rate and post-start waiting incidence may be at most one percentage point above Mux in every cell',
    networkEfficiencyFairnessRule: 'Within every pair, native may not repeat more identical encoded-media URL/range requests than Mux',
    collectionReliabilityRule: 'Only Playwright/browser transport failures are retried, including a completed generic implementation-script-load result only when CDP proves a zero-byte transient transport failure on the exact implementation asset, and an otherwise-successful completed fixture only when every console error is Chromium network-I/O suspension and CDP proves a same-origin zero-byte uncanceled, unblocked, non-CORS request with HTTP status 0/2xx; entire pairs are discarded symmetrically, every failure is checkpointed, actual asset/fixture/player failures are never retried, and observed transport failure rates must remain within the declared 1% gates',
    collectionRetryPolicy: {
      maximumAttemptsPerPair: MAX_COLLECTION_ATTEMPTS,
      retryUnit: 'entire pair in the original implementation order',
      retryable: 'collector transport failure without a completed fixture result; an exact implementation-script request with zero delivered bytes and a whitelisted transient Chromium transport error; or an otherwise-successful completed fixture whose only console error is Chromium ERR_NETWORK_IO_SUSPENDED and whose matching same-origin request is proven by CDP to be zero-byte, uncanceled, unblocked, non-CORS, and HTTP 0/2xx',
      notRetryable: 'HTTP asset failures, blocked, canceled, cross-origin, CORS, or partially delivered requests, syntax errors, unrelated console errors, other media/network failures, and completed player, media, frame, preload, or benchmark timeout errors',
      navigationReadiness: 'DOMContentLoaded',
      navigationTimeoutMs: COLLECTION_NAVIGATION_TIMEOUT_MS,
      fixtureResultTimeoutMs: COLLECTION_RESULT_TIMEOUT_MS,
      maximumFailureRate: MAX_COLLECTION_FAILURE_RATE,
      nativeNonInferiorityMargin: COLLECTION_FAILURE_NONINFERIORITY_MARGIN,
    },
    sourceSemantics: {
      'product-av': {
        native: 'DASH fMP4 with alternate audio (production-preferred path)',
        mux: 'HLS fMP4 with alternate audio (Mux adaptive path)',
        encodedMedia: 'identical CMAF files and rendition ladder; manifests and request scheduling differ',
      },
      'vod-av': {
        native: 'HLS fMP4 with alternate audio',
        mux: 'HLS fMP4 with alternate audio',
        encodedMedia: 'identical manifests, files, and rendition ladder',
      },
    },
    comparator: {
      product: '@mux/mux-player',
      analyticsDisabled: true,
      cookiesDisabled: true,
      playbackPreference: 'mse',
      preload: 'auto',
      optionalCastDisabled: true,
    },
    environment: {
      browserName,
      browserVersion: await browser.version(),
      platform: `${os.platform()} ${os.release()} ${os.arch()}`,
      cpu: os.cpus()[0]?.model || 'unknown',
      logicalCpuCount: os.cpus().length,
      totalMemoryBytes: os.totalmem(),
      node: process.version,
      muxPlayer: MUX_PLAYER_VERSION,
      muxPlaybackCore: MUX_PLAYBACK_CORE_VERSION,
      hlsJs: HLS_JS_VERSION,
      nativeCommit: process.env.GITHUB_SHA || process.env.CI_COMMIT_SHA || 'working-tree',
      artifacts: {
        nativeEngine: fileEvidence(NATIVE_ENGINE_PATH),
        muxBundle: fileEvidence(MUX_BUNDLE_PATH),
        benchmarkFixture: fileEvidence(FIXTURE_PATH),
        benchmarkRunner: fileEvidence(RUNNER_PATH),
        fixtureGenerator: fileEvidence(FIXTURE_GENERATOR_PATH),
        packageLock: fileEvidence(PACKAGE_LOCK_PATH),
      },
    },
    matrix,
    cells: [],
    pass: false,
  };

  const checkpointIdentity = {
    schemaVersion: report.schemaVersion,
    samplesPerCell,
    samplesByCell,
    matrix,
    networks: NETWORKS,
    devices: DEVICES,
    collectionRetryPolicy: report.collectionRetryPolicy,
    browserName,
    browserVersion: report.environment.browserVersion,
    platform: report.environment.platform,
    node: report.environment.node,
    artifacts: Object.fromEntries(
      Object.entries(report.environment.artifacts).map(([name, evidence]) => [name, evidence.sha256])
    ),
  };
  const checkpointFingerprint = createHash('sha256')
    .update(JSON.stringify(checkpointIdentity))
    .digest('hex');

  console.log(
    `[player-performance] matrix=${matrix.length} cells baseSamples=${samplesPerCell} `
    + `seekSamples=${requestedSeekSamples} totalPairs=${totalPairedRuns} `
    + `Mux=${MUX_PLAYER_VERSION} browser=${report.environment.browserVersion}`
  );

  // Interleave cells so host warm-up, thermal drift, and long-run browser
  // variation are distributed across the matrix instead of confounded with a
  // cell's position. The two implementations in a pair remain adjacent.
  const pairsByCell = new Map(matrix.map(matrixCell => [matrixCell.id, []]));
  const collectionFailuresByCell = new Map(matrix.map(matrixCell => [matrixCell.id, []]));
  const cellNumber = new Map(matrix.map((matrixCell, index) => [matrixCell.id, index + 1]));
  let resumedPairCount = 0;
  let resumedCollectionFailureCount = 0;
  mkdirSync(path.dirname(checkpointPath), { recursive: true });
  if (resumeEnabled && existsSync(checkpointPath)) {
    const lines = readFileSync(checkpointPath, 'utf8').split('\n').filter(Boolean);
    let headerSeen = false;
    for (const line of lines) {
      const entry = JSON.parse(line);
      if (!headerSeen) {
        if (entry.type !== 'header' || entry.fingerprint !== checkpointFingerprint) {
          throw new Error(`Performance checkpoint does not match this run: ${checkpointPath}`);
        }
        headerSeen = true;
        continue;
      }
      if (entry.type === 'collection-failure') {
        const failures = collectionFailuresByCell.get(entry.cellId);
        const sampleTarget = samplesByCell[entry.cellId];
        if (!failures
          || !sampleTarget
          || !Number.isInteger(entry.pairIndex)
          || entry.pairIndex < 0
          || entry.pairIndex >= sampleTarget
          || !Number.isInteger(entry.attemptIndex)
          || entry.attemptIndex < 0
          || entry.attemptIndex >= MAX_COLLECTION_ATTEMPTS
          || !entry.failure
          || failures.some(failure => (
            failure.pairIndex === entry.pairIndex
            && failure.attemptIndex === entry.attemptIndex
          ))) {
          throw new Error(`Invalid or duplicate collection failure checkpoint entry: ${checkpointPath}`);
        }
        failures.push(entry);
        resumedCollectionFailureCount++;
        continue;
      }
      if (entry.type !== 'pair') throw new Error(`Invalid performance checkpoint entry: ${checkpointPath}`);
      const pairs = pairsByCell.get(entry.cellId);
      const sampleTarget = samplesByCell[entry.cellId];
      if (!pairs
        || !sampleTarget
        || !Number.isInteger(entry.pair?.index)
        || entry.pair.index < 0
        || entry.pair.index >= sampleTarget
        || !entry.pair.native
        || !entry.pair.mux
        || pairs[entry.pair.index]) {
        throw new Error(`Invalid or duplicate performance checkpoint pair: ${checkpointPath}`);
      }
      pairs[entry.pair.index] = entry.pair;
      resumedPairCount++;
    }
    if (!headerSeen) throw new Error(`Performance checkpoint is empty: ${checkpointPath}`);
  } else {
    writeFileSync(
      checkpointPath,
      `${JSON.stringify({
        type: 'header',
        fingerprint: checkpointFingerprint,
        identity: checkpointIdentity,
        createdAt: new Date().toISOString(),
      })}\n`
    );
  }
  report.collectionCheckpoint = {
    resumeEnabled,
    resumedPairCount,
    resumedCollectionFailureCount,
    fingerprint: checkpointFingerprint,
  };
  if (resumedPairCount) {
    console.log(`[player-performance] resumed ${resumedPairCount} completed pairs from checkpoint`);
  }
  if (resumedCollectionFailureCount) {
    console.log(
      `[player-performance] resumed ${resumedCollectionFailureCount} collection-failure diagnostics from checkpoint`
    );
  }
  if (proofMode && resumedPairCount) {
    for (const matrixCell of matrix) {
      for (const pair of pairsByCell.get(matrixCell.id).filter(Boolean)) {
        if (!summarizeIrrevocablePairGates(pair, matrixCell).pass) {
          throw new Error(
            `Performance checkpoint contains an irrevocable proof-gate failure: `
            + `${matrixCell.id} pair ${pair.index + 1}`
          );
        }
      }
    }
  }
  for (let roundIndex = 0; roundIndex < maximumSamplesPerCell; roundIndex++) {
    const activeCells = matrix.flatMap(matrixCell => {
      const pairIndex = scheduledSampleIndex(
        roundIndex,
        samplesByCell[matrixCell.id],
        maximumSamplesPerCell
      );
      return Number.isInteger(pairIndex) ? [{ matrixCell, pairIndex }] : [];
    });
    const round = deterministicShuffle(activeCells, hashSeed(`matrix-round/${roundIndex}`));
    for (const { matrixCell, pairIndex } of round) {
      const pairs = pairsByCell.get(matrixCell.id);
      if (pairs[pairIndex]) continue;
      const muxFirst = ((pairIndex + (hashSeed(matrixCell.id) & 1)) % 2) === 0;
      const order = muxFirst ? ['mux', 'native'] : ['native', 'mux'];
      const collectionFailures = collectionFailuresByCell.get(matrixCell.id);
      const priorFailures = collectionFailures.filter(entry => entry.pairIndex === pairIndex);
      const firstAttemptIndex = priorFailures.length
        ? Math.max(...priorFailures.map(entry => entry.attemptIndex)) + 1
        : 0;
      if (firstAttemptIndex >= MAX_COLLECTION_ATTEMPTS) {
        throw new Error(
          `Collection attempts already exhausted for ${matrixCell.id} pair ${pairIndex + 1}`
        );
      }
      let pair = null;
      for (
        let attemptIndex = firstAttemptIndex;
        attemptIndex < MAX_COLLECTION_ATTEMPTS;
        attemptIndex++
      ) {
        const candidate = {
          index: pairIndex,
          collectedAt: new Date().toISOString(),
          firstImplementation: order[0],
          collectionAttempt: attemptIndex + 1,
        };
        const attemptedImplementations = [];
        let attemptFailure = null;
        for (const implementation of order) {
          attemptedImplementations.push(implementation);
          const outcome = await collectSample({
            browser,
            browserName,
            baseURL,
            implementation,
            cell: matrixCell,
            pairIndex,
            attemptIndex,
          });
          if (outcome.collectionFailure) {
            attemptFailure = outcome.collectionFailure;
            break;
          }
          candidate[implementation] = outcome.sample;
        }
        if (!attemptFailure) {
          pair = candidate;
          break;
        }
        const failureEntry = {
          type: 'collection-failure',
          cellId: matrixCell.id,
          pairIndex,
          attemptIndex,
          collectedAt: new Date().toISOString(),
          order,
          attemptedImplementations,
          failedImplementation: attemptFailure.implementation,
          failure: attemptFailure,
          discardedSamples: Object.fromEntries(
            order.filter(implementation => candidate[implementation])
              .map(implementation => [implementation, candidate[implementation]])
          ),
        };
        collectionFailures.push(failureEntry);
        appendFileSync(checkpointPath, `${JSON.stringify(failureEntry)}\n`);
        console.warn(
          `[player-performance] collection-retry ${matrixCell.id} `
          + `pair=${pairIndex + 1}/${samplesByCell[matrixCell.id]} `
          + `attempt=${attemptIndex + 1}/${MAX_COLLECTION_ATTEMPTS} `
          + `implementation=${attemptFailure.implementation} `
          + `phase=${attemptFailure.phase} error=${attemptFailure.error}`
        );
        if (attemptIndex + 1 >= MAX_COLLECTION_ATTEMPTS) {
          throw new Error(
            `Collection attempts exhausted for ${matrixCell.id} pair ${pairIndex + 1}: `
            + `${attemptFailure.implementation} ${attemptFailure.phase} ${attemptFailure.error}`
          );
        }
      }
      if (!pair) throw new Error(`Could not collect ${matrixCell.id} pair ${pairIndex + 1}`);
      pairs[pairIndex] = pair;
      appendFileSync(checkpointPath, `${JSON.stringify({
        type: 'pair',
        cellId: matrixCell.id,
        pair,
      })}\n`);
      const pairGates = summarizeIrrevocablePairGates(pair, matrixCell);
      const errors = pairGates.errors;
      if (!proofMode || errors.length || pairIndex === 0 || (pairIndex + 1) % 10 === 0) {
        console.log(
          `[player-performance] ${cellNumber.get(matrixCell.id)}/${matrix.length} ${matrixCell.id} `
          + `pair=${pairIndex + 1}/${samplesByCell[matrixCell.id]} `
          + `native=${formatMs(pair.native.videoStartupMs)} mux=${formatMs(pair.mux.videoStartupMs)}`
          + (errors.length ? ` errors=${errors.map(sample => `${sample.implementation}:${sample.error}`).join(',')}` : '')
        );
      }
      if (proofMode && !pairGates.pass) {
        throw new Error(
          `Irrevocable proof gate failed for ${matrixCell.id} pair ${pairIndex + 1}: `
          + `playerErrors=${errors.length} `
          + `consoleErrors=${pairGates.consoleErrorSamples.length} `
          + `cacheViolations=${pairGates.cacheViolationSamples.length} `
          + `qualityViolations=${pairGates.qualityGate.violations.length} `
          + `networkViolations=${pairGates.networkEfficiencyGate.violations.length}`
        );
      }
    }
  }

  for (const matrixCell of matrix) {
    const pairs = pairsByCell.get(matrixCell.id);
    const sampleTarget = samplesByCell[matrixCell.id];
    if (pairs.length !== sampleTarget
      || Array.from({ length: sampleTarget }, (_value, index) => pairs[index]).some(pair => !pair)) {
      throw new Error(`Incomplete performance collection for ${matrixCell.id}`);
    }
    const allSamples = pairs.flatMap(pair => [pair.native, pair.mux]);
    const errorSamples = allSamples.filter(sample => sample.error);
    const consoleErrorSamples = allSamples.filter(sample => sample.consoleErrors.length);
    const cacheViolationSamples = allSamples.filter(sample => sample.networkRequests.some(
      request => request.fromDiskCache || request.fromServiceWorker
    ));
    const metrics = metricsForCell(matrixCell);
    const claims = metrics.flatMap(metric => [
      summarizeMetric(
        pairs,
        metric,
        0.5,
        nonInferiorityConfidence,
        superiorityConfidence,
        bootstrapIterations,
        matrixCell.id,
        nonInferiorityEndpointConfidence,
        superiorityEndpointConfidence,
        proofMode
      ),
      summarizeMetric(
        pairs,
        metric,
        0.95,
        nonInferiorityConfidence,
        superiorityConfidence,
        bootstrapIterations,
        matrixCell.id,
        nonInferiorityEndpointConfidence,
        superiorityEndpointConfidence,
        proofMode
      ),
    ]);
    const collectionFailures = collectionFailuresByCell.get(matrixCell.id);
    const collectionReliabilityGate = summarizeCollectionReliabilityGate(
      collectionFailures,
      sampleTarget
    );
    const qualityGate = summarizeQualityGate(pairs, matrixCell);
    const smoothnessGate = summarizeSmoothnessGate(pairs);
    const networkEfficiencyGate = summarizeNetworkEfficiencyGate(pairs);
    const cellReport = {
      ...matrixCell,
      samplesPerCell: sampleTarget,
      networkProfile: NETWORKS[matrixCell.network],
      deviceProfile: DEVICES[matrixCell.device],
      errors: errorSamples,
      consoleErrorSamples,
      cacheViolationSamples,
      collectionFailures,
      collectionReliabilityGate,
      qualityGate,
      smoothnessGate,
      networkEfficiencyGate,
      claims,
      pass: errorSamples.length === 0
        && consoleErrorSamples.length === 0
        && cacheViolationSamples.length === 0
        && collectionReliabilityGate.pass
        && qualityGate.pass
        && smoothnessGate.pass
        && networkEfficiencyGate.pass
        && claims.every(claim => claim.pass),
      samples: pairs,
    };
    report.cells.push(cellReport);
    for (const claim of claims) {
      console.log(
        `[player-performance] ${matrixCell.id} ${claim.metric} p${claim.percentile * 100} `
        + `native=${formatMs(claim.nativeMs)} mux=${formatMs(claim.muxMs)} `
        + `delta=${formatMs(claim.deltaMs)} upper=${formatMs(claim.simultaneousUpperBoundMs)} `
        + `margin=${formatMs(claim.nonInferiorityMarginMs)} ${claim.verdict}`
      );
    }
    if (!cellReport.qualityGate.pass) {
      console.log(
        `[player-performance] ${matrixCell.id} quality-gate violations=`
        + `${cellReport.qualityGate.violationCount}`
      );
    }
    if (!cellReport.collectionReliabilityGate.pass) {
      console.log(
        `[player-performance] ${matrixCell.id} collection-reliability-gate violations=`
        + `${cellReport.collectionReliabilityGate.violations.length}`
      );
    }
    if (!cellReport.smoothnessGate.pass) {
      console.log(
        `[player-performance] ${matrixCell.id} smoothness-gate violations=`
        + `${cellReport.smoothnessGate.violations.length}`
      );
    }
    if (!cellReport.networkEfficiencyGate.pass) {
      console.log(
        `[player-performance] ${matrixCell.id} network-efficiency-gate violations=`
        + `${cellReport.networkEfficiencyGate.violations.length}`
      );
    }
  }

  report.pass = report.proofEligible
    && report.cells.every(entry => entry.pass);
  mkdirSync('tmp/player-performance', { recursive: true });
  mkdirSync(path.dirname(outputPath), { recursive: true });
  const rawReport = `${JSON.stringify(report, null, 2)}\n`;
  writeFileSync(outputPath, rawReport);
  const rawReportSha256 = createHash('sha256').update(rawReport).digest('hex');

  const archivePath = process.env.PLAYER_PERF_ARCHIVE_OUTPUT;
  let archiveEvidence = null;
  if (archivePath) {
    const archive = gzipSync(rawReport, { level: 9 });
    mkdirSync(path.dirname(archivePath), { recursive: true });
    writeFileSync(archivePath, archive);
    archiveEvidence = {
      path: archivePath,
      bytes: archive.byteLength,
      sha256: createHash('sha256').update(archive).digest('hex'),
      content: 'gzip-compressed full JSON report with every paired observation and request waterfall',
    };
  }

  const summaryPath = process.env.PLAYER_PERF_SUMMARY_OUTPUT;
  if (summaryPath) {
    const summary = {
      ...report,
      cells: report.cells.map(({
        samples: _samples,
        errors,
        consoleErrorSamples,
        cacheViolationSamples,
        collectionFailures,
        ...cellReport
      }) => ({
        ...cellReport,
        errorCount: errors.length,
        consoleErrorCount: consoleErrorSamples.length,
        cacheViolationCount: cacheViolationSamples.length,
        collectionFailureCount: collectionFailures.length,
      })),
      rawEvidence: {
        path: outputPath,
        bytes: Buffer.byteLength(rawReport),
        sha256: rawReportSha256,
        archive: archiveEvidence,
      },
    };
    mkdirSync(path.dirname(summaryPath), { recursive: true });
    writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  }
  if (existsSync(checkpointPath)) unlinkSync(checkpointPath);
  console.log(`[player-performance] report=${outputPath} proofEligible=${report.proofEligible} pass=${report.pass}`);

  expect(
    report.cells.flatMap(entry => entry.errors),
    'Every paired playback sample must complete without a player error'
  ).toEqual([]);
  expect(
    report.cells.flatMap(entry => entry.consoleErrorSamples),
    'Every paired playback sample must complete without a console or page error'
  ).toEqual([]);
  expect(
    report.cells.flatMap(entry => entry.cacheViolationSamples),
    'Every observation must use the controlled network rather than browser or service-worker cache'
  ).toEqual([]);
  expect(
    report.cells.flatMap(entry => entry.collectionReliabilityGate.violations),
    'Bounded collector retries must satisfy the absolute and native-vs-Mux reliability gates'
  ).toEqual([]);
  expect(
    report.cells.flatMap(entry => entry.qualityGate.violations),
    'Native timing samples are inadmissible when native displays a lower resolution than Mux'
  ).toEqual([]);
  expect(
    report.cells.flatMap(entry => entry.smoothnessGate.violations),
    'Native timing samples are inadmissible when native smoothness is materially worse than Mux'
  ).toEqual([]);
  expect(
    report.cells.flatMap(entry => entry.networkEfficiencyGate.violations),
    'Native timing samples are inadmissible when native repeats more encoded-media requests than Mux'
  ).toEqual([]);
  if (proofMode) {
    expect(proofScopeComplete, 'Proof mode requires the complete universal,formats matrix').toBe(true);
    expect(
      Math.min(...matrix.filter(matrixCell => !matrixCell.seek).map(
        matrixCell => samplesByCell[matrixCell.id]
      )),
      `p95 proof requires at least ${MIN_PROOF_SAMPLES} paired samples per cell`
    ).toBeGreaterThanOrEqual(MIN_PROOF_SAMPLES);
    expect(
      Math.min(...matrix.filter(matrixCell => matrixCell.seek).map(
        matrixCell => samplesByCell[matrixCell.id]
      )),
      `visible-frame p95 proof requires at least ${MIN_PROOF_SEEK_SAMPLES} paired seek samples`
    ).toBeGreaterThanOrEqual(MIN_PROOF_SEEK_SAMPLES);
    expect(
      exactBoundsFinite,
      'Proof sample count must support finite exact distribution-free p50/p95 upper endpoints'
    ).toBe(true);
    expect(
      report.pass,
      `Every co-primary p50/p95 confidence bound must fit the non-inferiority margin; inspect ${outputPath}`
    ).toBe(true);
  }
});
