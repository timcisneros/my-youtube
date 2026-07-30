import { createHash } from 'node:crypto';
import {
  readFileSync,
  statSync,
} from 'node:fs';
import { gunzipSync } from 'node:zlib';

const SUMMARY_PATH = process.argv[2] || 'docs/player-performance-proof.json';
const EXPECTED_SCHEMA_VERSION = 12;
const EXPECTED_CLAIM_COUNT = 384;
const EXPECTED_CELL_COUNT = 38;
const EXPECTED_TOTAL_PAIRS = 7_900;
const EXPECTED_STARTUP_PAIRS = 200;
const EXPECTED_SEEK_PAIRS = 500;
const GLOBAL_ALPHA = 0.05;
const NONINFERIORITY_ENDPOINT_CONFIDENCE = 1 - GLOBAL_ALPHA / 2;
const SUPERIORITY_ENDPOINT_CONFIDENCE =
  1 - GLOBAL_ALPHA / (2 * EXPECTED_CLAIM_COUNT);
const NETWORK_IO_SUSPENDED_ERROR = 'net::ERR_NETWORK_IO_SUSPENDED';
const NETWORK_IO_SUSPENDED_CONSOLE_ERROR =
  'Failed to load resource: net::ERR_NETWORK_IO_SUSPENDED';

const ARTIFACT_PATHS = {
  nativeEngine: 'public/native-player-engine.js',
  muxBundle: 'node_modules/@mux/mux-player/dist/mux-player.js',
  benchmarkFixture: 'tests/fixtures/player-performance.html',
  benchmarkRunner: 'tests/performance/player-parity.spec.mjs',
  fixtureGenerator: 'routes/stream/player-fixture.ts',
  packageLock: 'package-lock.json',
};

const EXPECTED_NETWORK_PROFILES = {
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

const EXPECTED_DEVICE_PROFILES = {
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
    userAgentTemplate:
      'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 '
      + '(KHTML, like Gecko) Chrome/{MAJOR}.0.0.0 Mobile Safari/537.36',
  },
};

function canonicalCellIds() {
  const ids = [];
  for (const network of ['broadband', 'fast4g', 'median4g', 'constrained']) {
    for (const device of ['desktop', 'mobile']) {
      for (const source of ['product-av', 'vod-av']) {
        for (const mode of ['cold', 'preloaded']) {
          ids.push(`${network}/${device}/${source}/${mode}/startup`);
        }
      }
    }
  }
  ids.push(
    'fast4g/desktop/vod-video/cold/startup',
    'fast4g/desktop/vod-aes/cold/startup',
    'fast4g/desktop/vod-ts/cold/startup',
    'fast4g/desktop/progressive/cold/startup',
    'fast4g/desktop/live/cold/startup',
    'fast4g/desktop/vod-av/cold/seek'
  );
  return ids.sort();
}

function fail(message) {
  throw new Error(`Player proof audit failed: ${message}`);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function closeEnough(actual, expected, tolerance = 1e-8) {
  return Number.isFinite(actual)
    && Number.isFinite(expected)
    && Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected));
}

function assertClose(actual, expected, message, tolerance) {
  assert(closeEnough(actual, expected, tolerance), `${message}: ${actual} !== ${expected}`);
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function percentile(values, quantile) {
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * quantile;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  const weight = position - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function hashSeed(value) {
  return Number.parseInt(
    createHash('sha256').update(value).digest('hex').slice(0, 8),
    16
  ) >>> 0;
}

function binomialProbabilities(count, probability) {
  assert(probability > 0 && probability < 1, 'invalid binomial probability');
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
  assert(total > 0 && Number.isFinite(total), 'binomial normalization failed');
  return probabilities.map(value => value / total);
}

function distributionFreeRanks(count, quantile, endpointConfidence) {
  const probabilities = binomialProbabilities(count, quantile);
  let upperRank;
  let upperCoverage;
  let cumulative = 0;
  for (let successes = 0; successes < count; successes++) {
    cumulative += probabilities[successes];
    if (cumulative >= endpointConfidence) {
      upperRank = successes + 1;
      upperCoverage = cumulative;
      break;
    }
  }

  let lowerRank;
  let lowerCoverage;
  cumulative = 0;
  for (let rank = 1; rank <= count; rank++) {
    cumulative += probabilities[rank - 1];
    const coverage = 1 - cumulative;
    if (coverage >= endpointConfidence) {
      lowerRank = rank;
      lowerCoverage = coverage;
    }
  }
  assert(Number.isInteger(lowerRank) && Number.isInteger(upperRank),
    `non-finite exact ranks for n=${count}, q=${quantile}`);
  return {
    lowerRank,
    upperRank,
    lowerCoverage,
    upperCoverage,
  };
}

function validateAuditStatistics() {
  const expectedRanks = [
    [200, 0.5, NONINFERIORITY_ENDPOINT_CONFIDENCE, 86, 115],
    [200, 0.95, NONINFERIORITY_ENDPOINT_CONFIDENCE, 184, 197],
    [500, 0.5, NONINFERIORITY_ENDPOINT_CONFIDENCE, 228, 273],
    [500, 0.95, NONINFERIORITY_ENDPOINT_CONFIDENCE, 465, 485],
    [200, 0.5, SUPERIORITY_ENDPOINT_CONFIDENCE, 73, 128],
    [200, 0.95, SUPERIORITY_ENDPOINT_CONFIDENCE, 176, 200],
    [500, 0.5, SUPERIORITY_ENDPOINT_CONFIDENCE, 207, 294],
    [500, 0.95, SUPERIORITY_ENDPOINT_CONFIDENCE, 454, 492],
  ];
  for (const [count, quantile, confidence, lowerRank, upperRank] of expectedRanks) {
    const ranks = distributionFreeRanks(count, quantile, confidence);
    assert(ranks.lowerRank === lowerRank && ranks.upperRank === upperRank,
      `independent exact-rank self-check failed for n=${count}, q=${quantile}`);
    assert(ranks.lowerCoverage >= confidence && ranks.upperCoverage >= confidence,
      `independent exact coverage is below target for n=${count}, q=${quantile}`);
  }
}

function assertSampleTiming(sample, cellId, pairIndex, implementation, seek) {
  const label = `${cellId}/${pairIndex}/${implementation}`;
  for (const field of [
    'scriptStartMs',
    'scriptReadyMs',
    'playerInitMs',
    'playerReadyMs',
    'sourceStartMs',
    'playIntentMs',
    'firstFrameMs',
    'steadyStateFrameMs',
  ]) {
    assert(Number.isFinite(sample[field]) && sample[field] >= 0,
      `${label}: invalid ${field}`);
  }
  assert(sample.navigationStartMs === 0, `${label}: navigation origin changed`);
  assert(sample.scriptReadyMs >= sample.scriptStartMs,
    `${label}: script readiness precedes script start`);
  assert(sample.playerInitMs >= sample.scriptReadyMs,
    `${label}: player initialization precedes script readiness`);
  assert(sample.playerReadyMs >= sample.playerInitMs,
    `${label}: player readiness precedes initialization`);
  assert(sample.sourceStartMs >= sample.playerReadyMs,
    `${label}: source assignment precedes player readiness`);
  assert(sample.playIntentMs >= sample.sourceStartMs,
    `${label}: play intent precedes source assignment`);
  assert(sample.firstFrameMs >= sample.playIntentMs,
    `${label}: first frame precedes play intent`);
  assert(sample.steadyStateFrameMs >= sample.firstFrameMs,
    `${label}: steady frame precedes first frame`);

  assertClose(sample.pageLoadMs, sample.playerInitMs, `${label}: Page Load mismatch`);
  assertClose(
    sample.playerStartupMs,
    sample.playerReadyMs - sample.playerInitMs,
    `${label}: Player Startup mismatch`
  );
  assertClose(
    sample.videoStartupMs,
    sample.firstFrameMs - sample.playIntentMs,
    `${label}: Video Startup mismatch`
  );
  assertClose(
    sample.aggregateStartupMs,
    sample.pageLoadMs + sample.playerStartupMs + sample.videoStartupMs,
    `${label}: Aggregate Startup mismatch`
  );
  assertClose(
    sample.playbackAdvanceMs,
    sample.steadyStateFrameMs - sample.firstFrameMs,
    `${label}: playback-advance mismatch`
  );
  assertClose(
    sample.loadToFirstFrameMs,
    sample.firstFrameMs - sample.sourceStartMs,
    `${label}: load-to-first-frame mismatch`
  );

  if (seek) {
    for (const field of ['seekStartMs', 'seekedMs', 'seekFrameMs']) {
      assert(Number.isFinite(sample[field]) && sample[field] > 0,
        `${label}: invalid ${field}`);
    }
    assert(sample.seekStartMs >= sample.steadyStateFrameMs,
      `${label}: seek precedes steady-state checkpoint`);
    assert(sample.seekedMs >= sample.seekStartMs, `${label}: seeked precedes seek start`);
    assert(sample.seekFrameMs >= sample.seekStartMs,
      `${label}: post-seek frame precedes seek start`);
    assertClose(
      sample.seekLatencyMs,
      sample.seekedMs - sample.seekStartMs,
      `${label}: Seek Latency mismatch`
    );
    assertClose(
      sample.seekFrameLatencyMs,
      sample.seekFrameMs - sample.seekStartMs,
      `${label}: seek-to-frame mismatch`
    );
  }
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

function encodedMediaRequest(request) {
  const mimeType = String(request.mimeType || '').toLowerCase();
  if (/^(audio|video)\//.test(mimeType)) return true;
  return mimeType === 'application/octet-stream'
    && String(request.url || '').includes('/hls-aes/');
}

function duplicateEncodedMediaRequestCount(sample) {
  const counts = new Map();
  for (const request of sample.networkRequests.filter(encodedMediaRequest)) {
    const key = `${request.url}|${request.range || ''}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0);
}

function sameOrigin(url, origin) {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

function validSuspendedRequest(request, origin) {
  return request.failed === NETWORK_IO_SUSPENDED_ERROR
    && sameOrigin(request.url, origin)
    && request.encodedBytes === 0
    && !request.canceled
    && !request.blockedReason
    && !request.corsErrorStatus
    && (request.status === 0 || (request.status >= 200 && request.status < 300));
}

function validRecoveryCancellation(request, origin, lastSuspensionEndMs) {
  return request.failed === 'net::ERR_ABORTED'
    && request.canceled === true
    && sameOrigin(request.url, origin)
    && request.encodedBytes === 0
    && !request.blockedReason
    && !request.corsErrorStatus
    && (request.status === 0 || (request.status >= 200 && request.status < 300))
    && Number.isFinite(request.startMs)
    && request.startMs >= lastSuspensionEndMs;
}

function auditCollectionFailure(failureRecord, cell, benchmarkOrigin) {
  const failure = failureRecord.failure;
  assert(failureRecord.type === 'collection-failure', 'retry record type changed');
  assert(failureRecord.attemptIndex === 0, 'canonical retry was not the first attempt');
  assert(
    JSON.stringify([...failureRecord.order].sort()) === JSON.stringify(['mux', 'native']),
    'retry record does not contain exactly the two implementations'
  );
  assert(failure?.fixtureCompleted === true, 'canonical retry lacks a completed fixture');
  assert(failure?.implementation === failureRecord.failedImplementation,
    'retry implementation mismatch');
  assert(Array.isArray(failure.networkRequests), 'retry lacks its CDP waterfall');
  assert(Array.isArray(failure.consoleErrors), 'retry lacks console diagnostics');

  const failedOrderIndex = failureRecord.order.indexOf(failureRecord.failedImplementation);
  assert(failedOrderIndex >= 0, 'failed implementation is absent from pair order');
  assert(
    JSON.stringify(failureRecord.attemptedImplementations)
      === JSON.stringify(failureRecord.order.slice(0, failedOrderIndex + 1)),
    'retry attempted implementations are not the exact order prefix through failure'
  );
  const expectedDiscarded = failureRecord.order.slice(0, failedOrderIndex).sort();
  const actualDiscarded = Object.keys(failureRecord.discardedSamples || {}).sort();
  assert(JSON.stringify(actualDiscarded) === JSON.stringify(expectedDiscarded),
    'whole-pair retry did not preserve every already-collected half');
  for (const [implementation, sample] of Object.entries(
    failureRecord.discardedSamples || {}
  )) {
    assert(sample.implementation === implementation,
      'discarded clean counterpart has the wrong implementation');
    assert(!sample.error && sample.consoleErrors?.length === 0,
      'discarded counterpart was not otherwise clean');
    assert(sample.runId === (
      `${cell.id}-${failureRecord.pairIndex}-${implementation}-attempt-1`
    ), 'discarded counterpart has the wrong fixture identity');
  }

  if (failure.phase === 'implementation-script-transport') {
    const expectedPath = failureRecord.failedImplementation === 'native'
      ? '/native-player-engine.js'
      : '/__player-benchmark/mux-player.js';
    const request = failure.transportRequest;
    assert(failure.completedFixtureResult?.error === 'implementation-script-load-failed',
      'script retry did not originate from the generic script-load fixture result');
    assert(request && new URL(request.url).pathname === expectedPath,
      'script retry does not target the exact implementation asset');
    assert(validSuspendedRequest(request, benchmarkOrigin),
      'script retry is not a proven zero-byte Chromium suspension');
    const failedRequests = failure.networkRequests.filter(candidate => candidate.failed);
    assert(failedRequests.length === 1
      && failedRequests[0].failed === request.failed
      && failedRequests[0].url === request.url
      && failedRequests[0].startMs === request.startMs,
    'script retry contains an additional CDP network failure');
  } else if (failure.phase === 'benchmark-network-io-suspension') {
    assert(!failure.completedFixtureResult?.error,
      'completed suspension retry contains a player or fixture error');
    assert(failure.consoleErrors.length > 0
      && failure.consoleErrors.every(error => error === NETWORK_IO_SUSPENDED_CONSOLE_ERROR),
    'completed suspension retry contains a non-suspension console error');
    const suspended = failure.networkRequests.filter(
      request => request.failed === NETWORK_IO_SUSPENDED_ERROR
    );
    assert(suspended.length > 0, 'completed suspension retry has no suspended request');
    assert(suspended.every(request => validSuspendedRequest(request, benchmarkOrigin)),
      'completed suspension retry contains an inadmissible suspended request');
    const lastSuspensionEndMs = Math.max(...suspended.map(request => (
      request.startMs + request.durationMs
    )));
    const otherFailures = failure.networkRequests.filter(
      request => request.failed && request.failed !== NETWORK_IO_SUSPENDED_ERROR
    );
    assert(otherFailures.every(request => (
      validRecoveryCancellation(request, benchmarkOrigin, lastSuspensionEndMs)
    )), 'completed suspension retry contains an unrelated CDP network failure');
  } else {
    fail(`unexpected retry phase ${failure.phase}`);
  }

  const accepted = cell.samples.find(sample => sample.index === failureRecord.pairIndex);
  assert(accepted?.collectionAttempt === failureRecord.attemptIndex + 2,
    'retry did not produce exactly one next-attempt accepted pair');
  assert(accepted.firstImplementation === failureRecord.order[0],
    'accepted retry changed implementation order');
}

function auditCell(rawCell, summaryCell, report) {
  const expectedId = [
    rawCell.network,
    rawCell.device,
    rawCell.source,
    rawCell.mode,
    rawCell.seek ? 'seek' : 'startup',
  ].join('/');
  assert(rawCell.id === expectedId, `${rawCell.id}: cell identity fields disagree`);
  assert(
    JSON.stringify(rawCell.networkProfile)
      === JSON.stringify(EXPECTED_NETWORK_PROFILES[rawCell.network]),
    `${rawCell.id}: network profile changed`
  );
  assert(
    JSON.stringify(rawCell.deviceProfile)
      === JSON.stringify(EXPECTED_DEVICE_PROFILES[rawCell.device]),
    `${rawCell.id}: device profile changed`
  );
  const expectedSamples = report.samplesByCell[rawCell.id];
  assert(Number.isInteger(expectedSamples), `${rawCell.id}: missing declared sample target`);
  assert(rawCell.samples.length === expectedSamples, `${rawCell.id}: wrong raw sample count`);
  assert(rawCell.samplesPerCell === expectedSamples, `${rawCell.id}: cell target mismatch`);
  assert(summaryCell.samplesPerCell === expectedSamples, `${rawCell.id}: summary target mismatch`);
  assert(new Set(rawCell.samples.map(sample => sample.index)).size === expectedSamples,
    `${rawCell.id}: duplicate sample index`);
  assert(Math.min(...rawCell.samples.map(sample => sample.index)) === 0
    && Math.max(...rawCell.samples.map(sample => sample.index)) === expectedSamples - 1,
  `${rawCell.id}: sample indexes are incomplete`);

  const nativeFirst = rawCell.samples.filter(
    sample => sample.firstImplementation === 'native'
  ).length;
  const muxFirst = rawCell.samples.filter(sample => sample.firstImplementation === 'mux').length;
  assert(nativeFirst === expectedSamples / 2 && muxFirst === expectedSamples / 2,
    `${rawCell.id}: pair order is not exactly balanced`);

  const checkpoints = rawCell.seek
    ? ['firstFrame', 'steadyState', 'postSeek']
    : ['firstFrame', 'steadyState'];
  let nativeHigherResolutionCount = 0;
  let nativeDroppedVideoFrames = 0;
  let muxDroppedVideoFrames = 0;
  let nativeTotalVideoFrames = 0;
  let muxTotalVideoFrames = 0;
  let nativePostStartWaitingCount = 0;
  let muxPostStartWaitingCount = 0;
  let nativePostStartWaitingSamples = 0;
  let muxPostStartWaitingSamples = 0;
  let nativeDuplicateRequestCount = 0;
  let muxDuplicateRequestCount = 0;
  let nativeEncodedBytes = 0;
  let muxEncodedBytes = 0;

  for (const pair of rawCell.samples) {
    const expectedFirst = (
      (pair.index + (hashSeed(rawCell.id) & 1)) % 2
    ) === 0 ? 'mux' : 'native';
    assert(pair.firstImplementation === expectedFirst,
      `${rawCell.id}/${pair.index}: deterministic pair order changed`);
    assert(Number.isInteger(pair.collectionAttempt)
      && pair.collectionAttempt >= 1
      && pair.collectionAttempt <= 3,
    `${rawCell.id}/${pair.index}: invalid collection attempt`);
    assert(pair.native?.implementation === 'native' && pair.mux?.implementation === 'mux',
      `${rawCell.id}/${pair.index}: paired implementations are malformed`);
    for (const implementation of ['native', 'mux']) {
      const sample = pair[implementation];
      assert(sample.runId === (
        `${rawCell.id}-${pair.index}-${implementation}-attempt-${pair.collectionAttempt}`
      ), `${rawCell.id}/${pair.index}/${implementation}: fixture run identity drift`);
      assert(!sample.error, `${rawCell.id}/${pair.index}/${implementation}: player error`);
      assert(Array.isArray(sample.consoleErrors) && sample.consoleErrors.length === 0,
        `${rawCell.id}/${pair.index}/${implementation}: console error`);
      assert(sample.browserVersion === report.environment.browserVersion,
        `${rawCell.id}/${pair.index}/${implementation}: browser version drift`);
      assert(sample.mode === rawCell.mode && sample.source === rawCell.source,
        `${rawCell.id}/${pair.index}/${implementation}: fixture identity drift`);
      assert(sample.networkRequests.every(request => (
        !request.fromDiskCache && !request.fromServiceWorker
      )), `${rawCell.id}/${pair.index}/${implementation}: cache contamination`);
      assertSampleTiming(sample, rawCell.id, pair.index, implementation, rawCell.seek);
      assert(Number.isFinite(sample.droppedVideoFrames)
        && Number.isFinite(sample.totalVideoFrames)
        && sample.droppedVideoFrames >= 0
        && sample.totalVideoFrames > 0
        && sample.droppedVideoFrames <= sample.totalVideoFrames,
      `${rawCell.id}/${pair.index}/${implementation}: invalid frame-quality counters`);
      const waterfallBytes = sample.networkRequests.reduce(
        (sum, request) => sum + (Number(request.encodedBytes) || 0),
        0
      );
      assert(sample.encodedBytes === waterfallBytes,
        `${rawCell.id}/${pair.index}/${implementation}: encoded-byte total mismatch`);
    }

    for (const checkpoint of checkpoints) {
      const native = qualityDimensions(pair.native, checkpoint);
      const mux = qualityDimensions(pair.mux, checkpoint);
      assert(native.width > 0 && native.height > 0 && mux.width > 0 && mux.height > 0,
        `${rawCell.id}/${pair.index}/${checkpoint}: missing displayed resolution`);
      assert(native.width >= mux.width && native.height >= mux.height,
        `${rawCell.id}/${pair.index}/${checkpoint}: native resolution below Mux`);
      if (native.width > mux.width || native.height > mux.height) {
        nativeHigherResolutionCount++;
      }
    }

    nativeDroppedVideoFrames += pair.native.droppedVideoFrames;
    muxDroppedVideoFrames += pair.mux.droppedVideoFrames;
    nativeTotalVideoFrames += pair.native.totalVideoFrames;
    muxTotalVideoFrames += pair.mux.totalVideoFrames;
    nativePostStartWaitingCount += pair.native.postStartWaitingCount;
    muxPostStartWaitingCount += pair.mux.postStartWaitingCount;
    nativePostStartWaitingSamples += pair.native.postStartWaitingCount > 0 ? 1 : 0;
    muxPostStartWaitingSamples += pair.mux.postStartWaitingCount > 0 ? 1 : 0;

    const nativeDuplicates = duplicateEncodedMediaRequestCount(pair.native);
    const muxDuplicates = duplicateEncodedMediaRequestCount(pair.mux);
    assert(nativeDuplicates <= muxDuplicates,
      `${rawCell.id}/${pair.index}: native duplicated more encoded requests than Mux`);
    nativeDuplicateRequestCount += nativeDuplicates;
    muxDuplicateRequestCount += muxDuplicates;
    nativeEncodedBytes += pair.native.encodedBytes;
    muxEncodedBytes += pair.mux.encodedBytes;
  }

  const qualityGate = rawCell.qualityGate;
  assert(qualityGate.pass && qualityGate.violations.length === 0,
    `${rawCell.id}: quality gate failed`);
  assert(qualityGate.nativeHigherResolutionCount === nativeHigherResolutionCount,
    `${rawCell.id}: higher-resolution checkpoint count mismatch`);

  const smoothnessGate = rawCell.smoothnessGate;
  assert(smoothnessGate.pass && smoothnessGate.violations.length === 0,
    `${rawCell.id}: smoothness gate failed`);
  const smoothnessExpected = {
    native: {
      droppedVideoFrames: nativeDroppedVideoFrames,
      totalVideoFrames: nativeTotalVideoFrames,
      postStartWaitingCount: nativePostStartWaitingCount,
      postStartWaitingSamples: nativePostStartWaitingSamples,
    },
    mux: {
      droppedVideoFrames: muxDroppedVideoFrames,
      totalVideoFrames: muxTotalVideoFrames,
      postStartWaitingCount: muxPostStartWaitingCount,
      postStartWaitingSamples: muxPostStartWaitingSamples,
    },
  };
  for (const implementation of ['native', 'mux']) {
    for (const [key, expected] of Object.entries(smoothnessExpected[implementation])) {
      assert(smoothnessGate[implementation][key] === expected,
        `${rawCell.id}: ${implementation} ${key} mismatch`);
    }
    const totals = smoothnessExpected[implementation];
    assertClose(
      smoothnessGate[implementation].droppedFramePercentage,
      totals.droppedVideoFrames / totals.totalVideoFrames * 100,
      `${rawCell.id}: ${implementation} dropped-frame percentage mismatch`
    );
    assertClose(
      smoothnessGate[implementation].postStartWaitingSamplePercentage,
      totals.postStartWaitingSamples / expectedSamples * 100,
      `${rawCell.id}: ${implementation} waiting-incidence percentage mismatch`
    );
  }
  assert(
    smoothnessGate.native.droppedFramePercentage
      <= smoothnessGate.mux.droppedFramePercentage + 1,
    `${rawCell.id}: native dropped-frame rate exceeds the gate`
  );
  assert(
    smoothnessGate.native.postStartWaitingSamplePercentage
      <= smoothnessGate.mux.postStartWaitingSamplePercentage + 1,
    `${rawCell.id}: native waiting incidence exceeds the gate`
  );

  const networkGate = rawCell.networkEfficiencyGate;
  assert(networkGate.pass && networkGate.violations.length === 0,
    `${rawCell.id}: network-efficiency gate failed`);
  assert(networkGate.nativeDuplicateRequestCount === nativeDuplicateRequestCount,
    `${rawCell.id}: native duplicate count mismatch`);
  assert(networkGate.muxDuplicateRequestCount === muxDuplicateRequestCount,
    `${rawCell.id}: Mux duplicate count mismatch`);
  assert(networkGate.nativeEncodedBytes === nativeEncodedBytes,
    `${rawCell.id}: native encoded-byte count mismatch`);
  assert(networkGate.muxEncodedBytes === muxEncodedBytes,
    `${rawCell.id}: Mux encoded-byte count mismatch`);
  assertClose(networkGate.encodedByteRatio, nativeEncodedBytes / muxEncodedBytes,
    `${rawCell.id}: encoded-byte ratio mismatch`);

  const metrics = [
    'pageLoadMs',
    'playerStartupMs',
    'videoStartupMs',
    'aggregateStartupMs',
    'playbackAdvanceMs',
    ...(rawCell.seek ? ['seekLatencyMs', 'seekFrameLatencyMs'] : []),
  ];
  assert(rawCell.claims.length === metrics.length * 2, `${rawCell.id}: wrong claim count`);
  const expectedClaimKeys = metrics.flatMap(metric => (
    [0.5, 0.95].map(quantile => `${metric}/${quantile}`)
  )).sort();
  const actualClaimKeys = rawCell.claims.map(
    claim => `${claim.metric}/${claim.percentile}`
  ).sort();
  assert(JSON.stringify(actualClaimKeys) === JSON.stringify(expectedClaimKeys),
    `${rawCell.id}: duplicate or missing metric/percentile claim`);
  for (const claim of rawCell.claims) {
    const nativeValues = rawCell.samples.map(pair => pair.native[claim.metric]);
    const muxValues = rawCell.samples.map(pair => pair.mux[claim.metric]);
    assert(nativeValues.every(Number.isFinite) && muxValues.every(Number.isFinite),
      `${rawCell.id}/${claim.metric}: missing metric`);
    assertClose(claim.nativeMs, percentile(nativeValues, claim.percentile),
      `${rawCell.id}/${claim.metric}: native percentile mismatch`);
    assertClose(claim.muxMs, percentile(muxValues, claim.percentile),
      `${rawCell.id}/${claim.metric}: Mux percentile mismatch`);
    assertClose(claim.deltaMs, claim.nativeMs - claim.muxMs,
      `${rawCell.id}/${claim.metric}: delta mismatch`);

    const nativeSorted = [...nativeValues].sort((left, right) => left - right);
    const muxSorted = [...muxValues].sort((left, right) => left - right);
    const expectedNoninferiorityRanks = distributionFreeRanks(
      expectedSamples,
      claim.percentile,
      NONINFERIORITY_ENDPOINT_CONFIDENCE
    );
    const nativeRank = expectedNoninferiorityRanks.upperRank;
    const muxRank = expectedNoninferiorityRanks.lowerRank;
    assert(claim.distributionFreeRanks.upperNativeRank === nativeRank
      && claim.distributionFreeRanks.lowerMuxRank === muxRank,
    `${rawCell.id}/${claim.metric}: reported non-inferiority ranks are wrong`);
    assertClose(
      claim.distributionFreeRanks.upperNativeCoverage,
      expectedNoninferiorityRanks.upperCoverage,
      `${rawCell.id}/${claim.metric}: native exact coverage mismatch`
    );
    assertClose(
      claim.distributionFreeRanks.lowerMuxCoverage,
      expectedNoninferiorityRanks.lowerCoverage,
      `${rawCell.id}/${claim.metric}: Mux exact coverage mismatch`
    );
    assertClose(
      claim.distributionFreeRanks.endpointConfidence,
      NONINFERIORITY_ENDPOINT_CONFIDENCE,
      `${rawCell.id}/${claim.metric}: non-inferiority endpoint confidence mismatch`
    );
    const exactUpper = nativeSorted[nativeRank - 1] - muxSorted[muxRank - 1];
    assertClose(claim.distributionFreeUpperBoundMs, exactUpper,
      `${rawCell.id}/${claim.metric}: exact upper bound mismatch`);
    const expectedMargin = Math.max(25, muxSorted[muxRank - 1] * 0.05);
    assertClose(claim.nonInferiorityMarginMs, expectedMargin,
      `${rawCell.id}/${claim.metric}: non-inferiority margin mismatch`);
    assertClose(
      claim.sampleNonInferiorityMarginMs,
      Math.max(25, Math.abs(claim.muxMs) * 0.05),
      `${rawCell.id}/${claim.metric}: sample margin mismatch`
    );
    assert(Number.isFinite(claim.bcaUpperBoundMs),
      `${rawCell.id}/${claim.metric}: missing BCa non-inferiority bound`);
    assertClose(
      claim.simultaneousUpperBoundMs,
      Math.max(claim.distributionFreeUpperBoundMs, claim.bcaUpperBoundMs),
      `${rawCell.id}/${claim.metric}: governing non-inferiority bound mismatch`
    );
    assert(claim.pass === (claim.simultaneousUpperBoundMs <= claim.nonInferiorityMarginMs),
      `${rawCell.id}/${claim.metric}: non-inferiority verdict mismatch`);

    const expectedSuperiorityRanks = distributionFreeRanks(
      expectedSamples,
      claim.percentile,
      SUPERIORITY_ENDPOINT_CONFIDENCE
    );
    const superiorityNativeRank = expectedSuperiorityRanks.upperRank;
    const superiorityMuxRank = expectedSuperiorityRanks.lowerRank;
    assert(
      claim.superiorityDistributionFreeRanks.upperNativeRank
        === superiorityNativeRank
      && claim.superiorityDistributionFreeRanks.lowerMuxRank
        === superiorityMuxRank,
      `${rawCell.id}/${claim.metric}: reported superiority ranks are wrong`
    );
    assertClose(
      claim.superiorityDistributionFreeRanks.upperNativeCoverage,
      expectedSuperiorityRanks.upperCoverage,
      `${rawCell.id}/${claim.metric}: superiority native coverage mismatch`
    );
    assertClose(
      claim.superiorityDistributionFreeRanks.lowerMuxCoverage,
      expectedSuperiorityRanks.lowerCoverage,
      `${rawCell.id}/${claim.metric}: superiority Mux coverage mismatch`
    );
    assertClose(
      claim.superiorityDistributionFreeRanks.endpointConfidence,
      SUPERIORITY_ENDPOINT_CONFIDENCE,
      `${rawCell.id}/${claim.metric}: superiority endpoint confidence mismatch`
    );
    const exactSuperiorityUpper =
      nativeSorted[superiorityNativeRank - 1] - muxSorted[superiorityMuxRank - 1];
    assertClose(
      claim.superiorityDistributionFreeUpperBoundMs,
      exactSuperiorityUpper,
      `${rawCell.id}/${claim.metric}: exact superiority bound mismatch`
    );
    assert(Number.isFinite(claim.superiorityBcaUpperBoundMs),
      `${rawCell.id}/${claim.metric}: missing BCa superiority bound`);
    assertClose(
      claim.superiorityFamilyWiseUpperBoundMs,
      Math.max(
        claim.superiorityDistributionFreeUpperBoundMs,
        claim.superiorityBcaUpperBoundMs
      ),
      `${rawCell.id}/${claim.metric}: governing superiority bound mismatch`
    );
    const expectedVerdict = claim.superiorityFamilyWiseUpperBoundMs < 0
      ? 'native-better'
      : 'parity';
    assert(claim.verdict === expectedVerdict,
      `${rawCell.id}/${claim.metric}: superiority verdict mismatch`);
  }

  assert(rawCell.errors.length === 0
    && rawCell.consoleErrorSamples.length === 0
    && rawCell.cacheViolationSamples.length === 0,
  `${rawCell.id}: zero-tolerance error gate failed`);
  const collectionGate = rawCell.collectionReliabilityGate;
  assert(collectionGate.pass && collectionGate.violations.length === 0,
    `${rawCell.id}: collection-reliability gate failed`);
  const attempted = { native: expectedSamples, mux: expectedSamples };
  const failed = { native: 0, mux: 0 };
  const failuresPerPair = new Map();
  for (const failure of rawCell.collectionFailures) {
    assert(failure.cellId === rawCell.id, `${rawCell.id}: retry assigned to wrong cell`);
    assert(Number.isInteger(failure.pairIndex)
      && failure.pairIndex >= 0
      && failure.pairIndex < expectedSamples,
    `${rawCell.id}: retry has invalid pair index`);
    failuresPerPair.set(
      failure.pairIndex,
      (failuresPerPair.get(failure.pairIndex) || 0) + 1
    );
    for (const implementation of failure.attemptedImplementations) {
      assert(Object.hasOwn(attempted, implementation),
        `${rawCell.id}: retry names an unknown implementation`);
      attempted[implementation]++;
    }
    assert(Object.hasOwn(failed, failure.failedImplementation),
      `${rawCell.id}: retry failed implementation is unknown`);
    failed[failure.failedImplementation]++;
  }
  for (const pair of rawCell.samples) {
    assert(pair.collectionAttempt === (failuresPerPair.get(pair.index) || 0) + 1,
      `${rawCell.id}/${pair.index}: collection-attempt count does not match retries`);
  }
  assert(collectionGate.failureCount === rawCell.collectionFailures.length,
    `${rawCell.id}: collection-failure count mismatch`);
  for (const implementation of ['native', 'mux']) {
    assert(collectionGate.attempted[implementation] === attempted[implementation],
      `${rawCell.id}: ${implementation} attempted count mismatch`);
    assert(collectionGate.failed[implementation] === failed[implementation],
      `${rawCell.id}: ${implementation} failed count mismatch`);
    assertClose(
      collectionGate.rates[implementation],
      failed[implementation] / attempted[implementation],
      `${rawCell.id}: ${implementation} collection-failure rate mismatch`
    );
    assert(collectionGate.rates[implementation] <= 0.01,
      `${rawCell.id}: ${implementation} collection-failure rate exceeds 1%`);
  }
  assert(collectionGate.rates.native <= collectionGate.rates.mux + 0.01,
    `${rawCell.id}: native collection reliability exceeds its margin`);
  assert(rawCell.pass && rawCell.claims.every(claim => claim.pass),
    `${rawCell.id}: cell pass flag is inconsistent`);

  const {
    samples: _samples,
    errors,
    consoleErrorSamples,
    cacheViolationSamples,
    collectionFailures,
    ...rawSummary
  } = rawCell;
  const expectedSummary = {
    ...rawSummary,
    errorCount: errors.length,
    consoleErrorCount: consoleErrorSamples.length,
    cacheViolationCount: cacheViolationSamples.length,
    collectionFailureCount: collectionFailures.length,
  };
  assert(JSON.stringify(summaryCell) === JSON.stringify(expectedSummary),
    `${rawCell.id}: review summary differs from raw evidence`);
}

validateAuditStatistics();

const summary = readJson(SUMMARY_PATH);
const rawPath = summary.rawEvidence?.path;
const archivePath = summary.rawEvidence?.archive?.path;
assert(typeof rawPath === 'string' && typeof archivePath === 'string',
  'summary does not identify raw and archived evidence');

const rawBuffer = readFileSync(rawPath);
assert(rawBuffer.byteLength === summary.rawEvidence.bytes, 'raw byte length mismatch');
assert(sha256(rawBuffer) === summary.rawEvidence.sha256, 'raw SHA-256 mismatch');
const raw = JSON.parse(rawBuffer.toString('utf8'));

const archiveBuffer = readFileSync(archivePath);
assert(archiveBuffer.byteLength === summary.rawEvidence.archive.bytes,
  'archive byte length mismatch');
assert(sha256(archiveBuffer) === summary.rawEvidence.archive.sha256,
  'archive SHA-256 mismatch');
const expandedArchive = gunzipSync(archiveBuffer);
assert(expandedArchive.equals(rawBuffer), 'archive does not expand byte-for-byte to raw evidence');

for (const field of [
  'schemaVersion',
  'generatedAt',
  'proofMode',
  'proofScopeComplete',
  'proofEligible',
  'pass',
  'totalPairedRuns',
  'samplesPerCell',
  'samplesByCell',
  'environment',
  'globalNonInferiorityTest',
  'superiorityReportingFamily',
  'bootstrap',
  'distributionFreeInference',
]) {
  assert(JSON.stringify(summary[field]) === JSON.stringify(raw[field]),
    `summary and raw report differ at ${field}`);
}

assert(raw.schemaVersion === EXPECTED_SCHEMA_VERSION, 'unexpected proof schema');
assert(raw.proofMode && raw.proofScopeComplete && raw.proofEligible && raw.pass,
  'proof eligibility/pass flags are not all true');
assert(raw.statisticsSelfCheck === true, 'runner statistics self-check did not pass');
assert(raw.bootstrap.iterations >= 100_000, 'insufficient bootstrap iterations');
assert(raw.bootstrap.method === 'paired-bca', 'bootstrap did not preserve pairing');
assertClose(
  raw.globalNonInferiorityTest.alpha,
  GLOBAL_ALPHA,
  'wrong global non-inferiority alpha'
);
assertClose(
  raw.globalNonInferiorityTest.confidence,
  1 - GLOBAL_ALPHA,
  'wrong non-inferiority confidence'
);
assert(raw.globalNonInferiorityTest.claimCount === EXPECTED_CLAIM_COUNT,
  'wrong declared co-primary claim count');
assert(raw.superiorityReportingFamily.claimCount === EXPECTED_CLAIM_COUNT,
  'wrong declared superiority-family claim count');
assertClose(
  raw.superiorityReportingFamily.claimConfidence,
  1 - GLOBAL_ALPHA / EXPECTED_CLAIM_COUNT,
  'wrong Bonferroni superiority confidence'
);
assertClose(
  raw.distributionFreeInference.nonInferiorityEndpointConfidence,
  NONINFERIORITY_ENDPOINT_CONFIDENCE,
  'wrong non-inferiority endpoint confidence'
);
assertClose(
  raw.distributionFreeInference.superiorityEndpointConfidence,
  SUPERIORITY_ENDPOINT_CONFIDENCE,
  'wrong superiority endpoint confidence'
);
assert(raw.cells.length === EXPECTED_CELL_COUNT && raw.matrix.length === EXPECTED_CELL_COUNT,
  'wrong canonical matrix size');
assert(new Set(raw.cells.map(cell => cell.id)).size === EXPECTED_CELL_COUNT,
  'duplicate matrix cell');
const expectedCellIds = canonicalCellIds();
const rawMatrixIds = raw.matrix.map(cell => cell.id).sort();
const rawCellIds = raw.cells.map(cell => cell.id).sort();
assert(JSON.stringify(rawMatrixIds) === JSON.stringify(expectedCellIds),
  'declared matrix is not the exact canonical cell set');
assert(JSON.stringify(rawCellIds) === JSON.stringify(expectedCellIds),
  'raw observations are not the exact canonical cell set');
const rawMatrixById = new Map(raw.matrix.map(cell => [cell.id, cell]));
for (const cell of raw.cells) {
  const matrixCell = rawMatrixById.get(cell.id);
  assert(matrixCell
    && matrixCell.network === cell.network
    && matrixCell.device === cell.device
    && matrixCell.source === cell.source
    && matrixCell.mode === cell.mode
    && matrixCell.seek === cell.seek,
  `${cell.id}: observed cell differs from declared matrix`);
}
assert(raw.totalPairedRuns === EXPECTED_TOTAL_PAIRS, 'wrong declared total pair count');
assert(raw.collectionCheckpoint.resumedPairCount === 0
  && raw.collectionCheckpoint.resumedCollectionFailureCount === 0,
'canonical run did not start fresh');

const summaryCells = new Map(summary.cells.map(cell => [cell.id, cell]));
for (const cell of raw.cells) {
  const expected = cell.seek ? EXPECTED_SEEK_PAIRS : EXPECTED_STARTUP_PAIRS;
  assert(raw.samplesByCell[cell.id] === expected, `${cell.id}: noncanonical sample target`);
  assert(summaryCells.has(cell.id), `${cell.id}: missing summary cell`);
  auditCell(cell, summaryCells.get(cell.id), raw);
}

const actualTotalPairs = raw.cells.reduce((sum, cell) => sum + cell.samples.length, 0);
assert(actualTotalPairs === EXPECTED_TOTAL_PAIRS, 'raw pair total mismatch');

const failures = raw.cells.flatMap(cell => (
  cell.collectionFailures.map(failure => ({ failure, cell }))
));
assert(failures.length === 2, 'canonical collection-failure count changed');
const failuresByImplementation = { native: 0, mux: 0 };
let recoveryCancellationCount = 0;
for (const { failure, cell } of failures) {
  auditCollectionFailure(failure, cell, 'http://127.0.0.1:3012');
  failuresByImplementation[failure.failedImplementation]++;
  recoveryCancellationCount += failure.failure.networkRequests.filter(
    request => request.failed === 'net::ERR_ABORTED' && request.canceled
  ).length;
}
assert(failuresByImplementation.native === 1 && failuresByImplementation.mux === 1,
  'canonical retries are not symmetric by implementation');
assert(recoveryCancellationCount === 1,
  'unexpected count of post-suspension recovery cancellations');

const allClaims = raw.cells.flatMap(cell => (
  cell.claims.map(claim => ({ ...claim, cellId: cell.id }))
));
assert(allClaims.length === EXPECTED_CLAIM_COUNT, 'raw claim count mismatch');
assert(allClaims.every(claim => claim.pass), 'at least one co-primary claim failed');
const nativeBetterClaims = allClaims.filter(claim => claim.verdict === 'native-better');
const parityClaims = allClaims.filter(claim => claim.verdict === 'parity');
assert(nativeBetterClaims.length + parityClaims.length === EXPECTED_CLAIM_COUNT,
  'unexpected claim verdict');
const narrowestClaim = allClaims
  .map(claim => ({
    ...claim,
    headroomMs: claim.nonInferiorityMarginMs - claim.simultaneousUpperBoundMs,
  }))
  .sort((left, right) => left.headroomMs - right.headroomMs)[0];

const artifactAudit = {};
for (const [name, path] of Object.entries(ARTIFACT_PATHS)) {
  const evidence = raw.environment.artifacts[name];
  const buffer = readFileSync(path);
  assert(evidence.bytes === statSync(path).size, `${name}: artifact byte length mismatch`);
  assert(evidence.sha256 === sha256(buffer), `${name}: artifact SHA-256 mismatch`);
  artifactAudit[name] = evidence.sha256;
}

const totals = raw.cells.reduce((result, cell) => {
  result.nativeHigherResolutionCheckpoints += cell.qualityGate.nativeHigherResolutionCount;
  result.nativeDuplicateRequests += cell.networkEfficiencyGate.nativeDuplicateRequestCount;
  result.muxDuplicateRequests += cell.networkEfficiencyGate.muxDuplicateRequestCount;
  result.nativeEncodedBytes += cell.networkEfficiencyGate.nativeEncodedBytes;
  result.muxEncodedBytes += cell.networkEfficiencyGate.muxEncodedBytes;
  result.nativeDroppedFrames += cell.smoothnessGate.native.droppedVideoFrames;
  result.muxDroppedFrames += cell.smoothnessGate.mux.droppedVideoFrames;
  result.nativeTotalFrames += cell.smoothnessGate.native.totalVideoFrames;
  result.muxTotalFrames += cell.smoothnessGate.mux.totalVideoFrames;
  return result;
}, {
  nativeHigherResolutionCheckpoints: 0,
  nativeDuplicateRequests: 0,
  muxDuplicateRequests: 0,
  nativeEncodedBytes: 0,
  muxEncodedBytes: 0,
  nativeDroppedFrames: 0,
  muxDroppedFrames: 0,
  nativeTotalFrames: 0,
  muxTotalFrames: 0,
});

const verdictsByMetric = Object.fromEntries(
  [...new Set(allClaims.map(claim => claim.metric))].sort().map(metric => {
    const claims = allClaims.filter(claim => claim.metric === metric);
    return [metric, {
      total: claims.length,
      nativeBetter: claims.filter(claim => claim.verdict === 'native-better').length,
      parity: claims.filter(claim => claim.verdict === 'parity').length,
    }];
  })
);

console.log(JSON.stringify({
  auditPass: true,
  schemaVersion: raw.schemaVersion,
  proofEligible: raw.proofEligible,
  proofPass: raw.pass,
  cellCount: raw.cells.length,
  totalPairedObservations: actualTotalPairs,
  claimCount: allClaims.length,
  passingClaims: allClaims.filter(claim => claim.pass).length,
  nativeBetterClaims: nativeBetterClaims.length,
  parityClaims: parityClaims.length,
  verdictsByMetric,
  narrowestNonInferiorityClaim: {
    cellId: narrowestClaim.cellId,
    metric: narrowestClaim.metric,
    percentile: narrowestClaim.percentile,
    upperBoundMs: narrowestClaim.simultaneousUpperBoundMs,
    marginMs: narrowestClaim.nonInferiorityMarginMs,
    headroomMs: narrowestClaim.headroomMs,
  },
  collectionFailures: {
    total: failures.length,
    byImplementation: failuresByImplementation,
    admissiblePostSuspensionRecoveryCancellations: recoveryCancellationCount,
  },
  gates: {
    passingQualityCells: raw.cells.filter(cell => cell.qualityGate.pass).length,
    nativeHigherResolutionCheckpoints: totals.nativeHigherResolutionCheckpoints,
    passingSmoothnessCells: raw.cells.filter(cell => cell.smoothnessGate.pass).length,
    nativeDroppedFrames: totals.nativeDroppedFrames,
    muxDroppedFrames: totals.muxDroppedFrames,
    nativeDroppedFramePercentage:
      totals.nativeDroppedFrames / totals.nativeTotalFrames * 100,
    muxDroppedFramePercentage: totals.muxDroppedFrames / totals.muxTotalFrames * 100,
    passingNetworkEfficiencyCells:
      raw.cells.filter(cell => cell.networkEfficiencyGate.pass).length,
    nativeDuplicateRequests: totals.nativeDuplicateRequests,
    muxDuplicateRequests: totals.muxDuplicateRequests,
    nativeToMuxEncodedByteRatio: totals.nativeEncodedBytes / totals.muxEncodedBytes,
    passingCollectionReliabilityCells:
      raw.cells.filter(cell => cell.collectionReliabilityGate.pass).length,
  },
  evidence: {
    summaryPath: SUMMARY_PATH,
    rawPath,
    rawBytes: rawBuffer.byteLength,
    rawSha256: sha256(rawBuffer),
    archivePath,
    archiveBytes: archiveBuffer.byteLength,
    archiveSha256: sha256(archiveBuffer),
    archiveExpandsByteIdentically: true,
  },
  artifactAudit,
}, null, 2));
