import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';

function fail(message) {
  console.error(`[player-parity-guard] ${message}`);
  process.exitCode = 1;
}

function readText(path) {
  return readFileSync(path, 'utf8');
}

function extractParityTerms(script) {
  const match = script.match(/--grep "([^"]+)"/);
  if (!match) return [];
  return match[1].split('|').filter(Boolean);
}

function extractTestNames(source) {
  return [...source.matchAll(/(?:^|\n)test\((['"])(.*?)\1/g)].map((match) => match[2]);
}

function assertNoAssetReference(path, source, needle, message) {
  if (source.includes(needle)) fail(`${path}: ${message}`);
}

function assertIncludes(path, source, needle, message) {
  if (!source.includes(needle)) fail(`${path}: ${message}`);
}

function listSourceFiles(dir) {
  const ignoredDirs = new Set([
    '.git',
    'node_modules',
    'playwright-report',
    'test-results',
    'tmp',
  ]);
  const extensions = new Set(['.ejs', '.js', '.json', '.md', '.mjs', '.ts']);
  const files = [];
  for (const entry of readdirSync(dir)) {
    const path = dir === '.' ? entry : `${dir}/${entry}`;
    const stat = statSync(path);
    if (stat.isDirectory()) {
      if (!ignoredDirs.has(entry)) files.push(...listSourceFiles(path));
      continue;
    }
    const dot = path.lastIndexOf('.');
    const ext = dot === -1 ? '' : path.slice(dot);
    if (extensions.has(ext)) files.push(path);
  }
  return files;
}

function isAllowedLegacyEngineReference(path) {
  return path === 'CLAUDE.md'
    || path.startsWith('tests/')
    || path === 'scripts/player-parity-guard.mjs';
}

const packageJson = JSON.parse(readText('package.json'));
if (existsSync('public/player-engine.js')) {
  fail('public/player-engine.js has been retired');
}
if ((packageJson.dependencies && Object.hasOwn(packageJson.dependencies, 'shaka-player'))
  || (packageJson.devDependencies && Object.hasOwn(packageJson.devDependencies, 'shaka-player'))) {
  fail('shaka-player dependency has been retired');
}

const parityScript = packageJson.scripts && packageJson.scripts['test:player:parity'];
if (!parityScript) {
  fail('Missing package.json script: test:player:parity');
} else {
  const terms = extractParityTerms(parityScript);
  const testNames = extractTestNames(readText('tests/browser/native-player.spec.mjs'));
  const outside = testNames.filter((name) => !terms.some((term) => name.includes(term)));
  const matched = testNames.length - outside.length;

  if (outside.length) {
    fail(`Parity grep misses ${outside.length} native-player spec(s):\n${outside.join('\n')}`);
  }

  console.log(`[player-parity-guard] parity terms=${terms.length} tests=${testNames.length} matched=${matched} outside=${outside.length}`);
}

const playerRoute = readText('routes/player.ts');
const extraHeadStart = playerRoute.indexOf('extraHead:');
const extraHeadEnd = extraHeadStart === -1 ? -1 : playerRoute.indexOf('\n  });', extraHeadStart);
if (extraHeadStart === -1 || extraHeadEnd === -1) {
  fail('Could not locate routes/player.ts flushShell extraHead block');
} else {
  const extraHead = playerRoute.slice(extraHeadStart, extraHeadEnd);
  if (!extraHead.includes("runtimeAssetUrl('native-player-engine.min.js')")) {
    fail('Watch shell extraHead must load the minified native player runtime');
  }
  if (!extraHead.includes("runtimeAssetUrl('player-telemetry.min.js')")) {
    fail('Watch shell extraHead must load telemetry as a separate feature chunk');
  }
  if (!extraHead.includes("runtimeAssetUrl('player-page.min.js')")) {
    fail('Watch shell extraHead must load the minified cacheable player-page runtime');
  }
  if (extraHead.includes('/vendor/shaka/shaka-player.compiled.js')) {
    fail('Watch shell extraHead must not eager-load Shaka');
  }
  if (extraHead.includes('/player-engine.js')) {
    fail('Watch shell extraHead must not load the legacy Shaka-primary engine');
  }
}

const sharedHead = readText('views/partials/head.ejs');
if (sharedHead.includes('/native-player-engine.js')) {
  fail('Shared head must not download the player engine before the user opens a video');
}
if (sharedHead.includes('/vendor/shaka/shaka-player.compiled.js')) {
  fail('Shared head must not prefetch or load Shaka');
}
if (sharedHead.includes('/player-engine.js')) {
  fail('Shared head must not prefetch or load the legacy Shaka-primary engine');
}

[
  'public/app.js',
  'public/sw.js',
  'routes/player.ts',
  'views/player.ejs',
  'views/partials/head.ejs',
  'views/partials/shell-start.ejs',
].forEach((path) => {
  const source = readText(path);
  assertNoAssetReference(path, source, '/vendor/shaka/shaka-player.compiled.js', 'primary runtime path must not reference the Shaka bundle');
  assertNoAssetReference(path, source, '/player-engine.js', 'primary runtime path must not reference the legacy Shaka-primary engine asset');
});

listSourceFiles('.').forEach((path) => {
  const source = readText(path);
  if (!isAllowedLegacyEngineReference(path)) {
    assertNoAssetReference(path, source, '/player-engine.js', 'runtime source must not reference the legacy Shaka-primary engine asset');
  }
  if (!path.startsWith('tests/') && path !== 'scripts/player-parity-guard.mjs') {
    assertNoAssetReference(path, source, '/vendor/shaka/shaka-player.compiled.js', 'runtime source must not reference the retired Shaka bundle');
    assertNoAssetReference(path, source, 'node_modules/shaka-player', 'runtime source must not serve retired Shaka assets');
  }
});

const nativeEngine = readText('public/native-player-engine.js');
[
  'PlayerEngine.prototype._fallbackToShaka',
  'ShakaFallbackProvider',
  'installShakaHttpPlugin',
  'loadShaka',
  'SHAKA_URL',
  'shaka-fallback',
  'window._shakaPlayer',
].forEach((needle) => {
  assertNoAssetReference('public/native-player-engine.js', nativeEngine, needle, 'native engine must not contain retired Shaka fallback code');
});

[
  ['var hlsUrl = manifest.json.hls ? stampUri(self, manifest.json.hls) :', 'JSON HLS fallback must stamp stream-tokened API URLs before provider selection'],
  ['var progressiveUrl = manifest.json.progressive ? stampUri(self, manifest.json.progressive) :', 'JSON progressive fallback must stamp stream-tokened API URLs before provider selection'],
  ['if (hlsUrl && shouldUseFirstPartyHls(hlsUrl))', 'internal JSON HLS fallback must prefer the first-party HLS provider'],
  ['function shouldUseFirstPartyHls(url)', 'native engine must identify internal HLS streams that need first-party refresh/retry control'],
  ['new NativeHlsProvider(self, hlsUrl)', 'MSE HLS provider must receive the stamped HLS URL'],
  ['new NativeHlsProvider(this, stampUri(this, url))', 'direct internal HLS loads must stamp tokens before first-party provider fetches'],
  ["var queryIndex = withoutHash.indexOf('?');", 'stream token stamping must preserve existing query-string separators'],
  ["return path + '?' + parts.join('&') + hash;", 'stream token restamping must not turn ?u= into &u= on HLS proxy URLs'],
  ['if (!segments.length && targetDuration > 0) timeline = (mediaSequence + skippedSegmentCount) * targetDuration;', 'HLS live and delta playlists must advance the playback timeline from the first represented media sequence'],
  ['this.startupLiveTarget = null;', 'first-party HLS must track an intended live-edge startup target'],
  ['LIVE_BUFFER_AHEAD', 'first-party HLS must maintain a larger buffer target for live streams'],
  ['LIVE_BUFFER_BEHIND', 'first-party HLS must bound retained live media behind the playhead'],
  ['LOW_LATENCY_BUFFER_AHEAD', 'LL-HLS must use a latency-preserving forward buffer'],
  ['this.liveWindowDriftRecoveryCount = 0;', 'first-party HLS must track live-window drift recovery attempts'],
  ['this.vodEndOfStreamCount = 0;', 'native MSE providers must track explicit VOD end-of-stream closure'],
  ['this.engine._assetUri = this.playlistUrl;', 'first-party HLS must expose an adaptive asset URI for quality menu detection'],
  ['self.startupLiveTarget = self._defaultLiveStartTime();', 'first-party HLS startup must begin far enough behind live edge to avoid immediate underrun'],
  ['NativeHlsProvider.prototype._defaultLiveStartTime = function ()', 'first-party HLS must compute a stable default live start time'],
  ['return this.live ? Math.max(goal, LIVE_BUFFER_AHEAD) : goal;', 'first-party HLS live streams must use the live buffer target'],
  ['Math.min(0.7, abr.bandwidthUpgradeTarget || 0.85)', 'first-party HLS live upgrades must retain a conservative bandwidth reserve'],
  ['function bandwidthSampleDuration(provider, elapsedMs, timeToFirstByteMs)', 'native ABR must separate request latency from transfer throughput'],
  ['function abrUpgradeIsSafe(provider, candidate, bufferAhead)', 'native ABR upgrades must fit within the current starvation budget'],
  ['this.variantSwitchInFlight = false;', 'first-party HLS must serialize rendition metadata transitions'],
  ['self._appendedVideoInitKey = videoInitKey;', 'first-party HLS must append the selected rendition initialization segment'],
  ['NativeHlsProvider.prototype._maybeRefreshLiveLowBuffer = function (ahead)', 'first-party HLS must refresh live playlists immediately when live-edge buffer is low'],
  ['NativeHlsProvider.prototype._recoverLiveWindowDrift = function (ahead)', 'first-party HLS must recover when a live playlist window moves past the buffered edge'],
  ["this.lastError = 'hls-live-window-drift';", 'first-party HLS live-window drift recovery must be observable in stats'],
  ['liveLowBufferRefreshCount: this.liveLowBufferRefreshCount || 0', 'first-party HLS stats must expose low-buffer live refreshes'],
  ['liveWindowDriftRecoveryCount: this.liveWindowDriftRecoveryCount || 0', 'first-party HLS stats must expose live-window drift recoveries'],
  ['NativeHlsProvider.prototype._schedulerTime = function ()', 'first-party HLS scheduler must use pending startup/seek targets while buffers fill'],
  ['NativeHlsProvider.prototype._alignHlsBufferedTarget = function ()', 'first-party HLS must realign the playhead once live target media is buffered'],
  ['if (!this.live && !pendingSeek) return;', 'first-party HLS must reapply pending VOD seek targets after unbuffered media arrives'],
  ['function hlsSeekTargetInsideSegment(provider, target)', 'first-party HLS live seek targets must land inside playable segment ranges'],
  ['throw self._completeNativeTerminalError(terminalError, { phase: \'load\', generation: generation });', 'terminal native load failures must reject so the watch page can execute its retry and fallback policy'],
  ["this._player.emit('error', detail);", 'terminal native runtime failures must emit one adapter-level error event'],
  ['NativeUrlProvider.prototype.quiesce = function ()', 'terminal progressive failures must detach their runtime work before entering the error state'],
  ['NativeHlsProvider.prototype.quiesce = function (reason)', 'terminal HLS failures must stop scheduling, refresh, and append work'],
  ['NativeDashProvider.prototype.quiesce = function (reason)', 'terminal DASH failures must stop scheduling, refresh, and append work'],
  ['function hlsFmp4TimestampOffset(provider, track, seg, data)', 'first-party HLS fMP4 appends must preserve the CMAF tfdt timeline'],
  ['function parseMp4InitTrackInfo(data)', 'first-party HLS must parse fMP4 track timescales before resolving reset epochs'],
  ['function parseMp4FragmentTimestamp(data, expectedTrackId)', 'first-party HLS must derive reset offsets from embedded fragment timestamps'],
  ['function hlsLiveTimestampOffset(provider, track, seg)', 'first-party HLS TS transmuxed appends must map live fragments onto the provider timeline'],
  ['function prepareHlsTsTransmuxContext(provider, track, seg, data, preparedDemux)', 'first-party HLS must establish one generation-scoped MPEG-TS timeline for muxed audio and video'],
  ['function normalizeHlsTsDemuxTimestamps(timeline, demux, manifestStart)', 'first-party HLS must unwrap 33-bit MPEG-TS timestamps within each discontinuity generation'],
  ['var TS_DECODE_TIME_GUARD_SECONDS = 60;', 'first-party HLS must keep a stable manifest-anchored MPEG-TS decode epoch for backward seeks'],
  ['function hlsTsTimestampNear(rawTimestamp, referenceTimestamp)', 'first-party HLS must map out-of-order MPEG-TS fragments onto the nearest manifest clock epoch'],
  ['var sharedTsContext = prepareHlsTsTransmuxContext(self, track, seg, data);', 'first-party HLS must demux muxed MPEG-TS segments once and share their audio/video clock'],
  ['function appendHlsMuxedTsOutputs(provider, videoTrack, seg, outputs, appendState, appendTransaction)', 'first-party HLS must track muxed audio/video append completion as one resumable transaction'],
  ['NativeHlsProvider.prototype._recoverQuota = function (track, data, seg, appendError, appendTransaction)', 'first-party HLS quota recovery must receive the failed muxed append transaction'],
  ['if (state && state.outputs) return resumeMuxedOutputs(state.outputs, state);', 'first-party HLS muxed quota recovery must reuse the original transmuxed fragments'],
  ['function invalidateHlsAppendTransactions(provider, reason)', 'first-party HLS lifecycle changes must invalidate stale append work'],
  ['function assertHlsAppendTransactionCurrent(provider, transaction)', 'first-party HLS appends must verify their epoch and SourceBuffer identities'],
  ['function hlsMuxedAppendLedgerEntry(provider, transaction)', 'first-party HLS must retain physical per-track completion across an invalidated muxed transaction'],
  ['hlsMuxedLedgerResumeCount: this.hlsMuxedLedgerResumeCount || 0', 'first-party HLS stats must expose resumed partial muxed transactions'],
  ['function createDashAppendTransaction(provider, rep, seg, sb, enforceOwnership)', 'first-party DASH appends must capture request generation, representation, segment, and SourceBuffer identity'],
  ['function assertDashAppendTransactionCurrent(provider, transaction)', 'first-party DASH appends must reject stale lifecycle work'],
  ['if (!transaction.rep || transaction.rep._appendOwner !== transaction) return false;', 'first-party DASH callbacks must not clear replacement append ownership'],
  ['function beginDashControlTransition(provider, kind, target, clearBuffer, reason)', 'first-party DASH quality, audio, and recovery work must share one serialized control transaction'],
  ['function assertDashControlTransitionCurrent(provider, transaction)', 'first-party DASH control transitions must verify request generation and SourceBuffer identity before mutation or commit'],
  ['invalidateDashControlTransition(this, reason || \'request-cancel\');', 'DASH request cancellation must invalidate any stale control transition'],
  ['dashStaleControlTransitionAbortCount: this.dashStaleControlTransitionAbortCount || 0', 'first-party DASH stats must expose rejected stale control transitions'],
  ['function markDashSourceBufferConfigurationMutation(provider, transaction, kind)', 'DASH control transitions must identify SourceBuffer configuration epochs before browser mutations'],
  ['function markDashAppendSourceBufferConfigurationMutation(provider, transaction, kind, generationKey)', 'DASH period appends must enter the SourceBuffer configuration epoch before changeType or init mutations'],
  ['queueDashAppendSourceBufferConfigurationReconciliation(this, reason || \'request-cancel\');', 'DASH cancellation must reconcile physical configuration mutations started by ordinary append transactions'],
  ['NativeDashProvider.prototype._reconcileSourceBufferConfiguration = function ()', 'cancelled DASH transitions must restore the active rendition configuration after an in-flight SourceBuffer mutation'],
  ['if (this.dashSourceBufferConfigUncertain || this.dashControlTransitionInFlight) return [];', 'DASH scheduling must stop while the active SourceBuffer configuration is uncertain'],
  ['dashSourceBufferReconcileSuccessCount: this.dashSourceBufferReconcileSuccessCount || 0', 'DASH stats must expose completed SourceBuffer configuration reconciliation'],
  ['function releaseStaleDashControlTransition(provider, transaction, reason)', 'stale DASH control transitions must release scheduler ownership after SourceBuffer topology changes'],
  ['function waitForDashAppendTopologyPeers(provider, transaction)', 'DASH SourceBuffer replacement must serialize against the sibling append lane'],
  ['function reconcileDashSegmentLedgers(provider, kind, range, primaryRep, preserveSegment, fullReset)', 'DASH destructive buffer mutations must invalidate every representation sharing the SourceBuffer'],
  ['function reconcileHlsSegmentLedgers(provider, kind, range, primaryRep, preserveSegment, fullReset)', 'HLS destructive buffer mutations must reconcile their physical and logical segment state'],
  ['var retry = seg && self._prepareSegmentGeneration', 'DASH quota recovery must replay period initialization before retrying media bytes'],
  ['NativeDashProvider.prototype._recoverQuota = function (rep, sb, data, appendTransaction)', 'first-party DASH quota eviction and retry must remain within the failed append transaction'],
  ['return waitForDashAppendTopologyPeers(this, appendTransaction).then(function ()', 'DASH SourceBuffer replacement must drain sibling append work before detaching a buffer'],
  ['dashStaleAppendAbortCount: this.dashStaleAppendAbortCount || 0', 'first-party DASH stats must expose stale append work rejected by transaction guards'],
  ["return mp4FullBox.apply(null, ['trun', hasCompositionOffsets ? 1 : 0", 'first-party HLS MPEG-TS remuxing must preserve signed video composition offsets'],
  ['track._hlsTransmuxInitSourceBuffer === sb', 'first-party HLS must not append an unchanged transmuxed initialization segment repeatedly'],
  ['hlsTsSharedDemuxCount: this.hlsTsSharedDemuxCount || 0', 'first-party HLS stats must expose shared muxed MPEG-TS demux operations'],
  ['hlsTsOutOfOrderSegmentCount: this.hlsTsOutOfOrderSegmentCount || 0', 'first-party HLS stats must expose out-of-order MPEG-TS segment mapping'],
  ['hlsTsMuxedQuotaRetryCount: this.hlsTsMuxedQuotaRetryCount || 0', 'first-party HLS stats must expose atomic muxed MPEG-TS quota retries'],
  ['hlsAppendTransactionGuard(self, appendTransaction)', 'first-party HLS SourceBuffer appends must remain generation guarded while queued'],
  ['function createHlsRecoveryTransaction(provider, epoch, reason)', 'first-party HLS recovery must capture the append epoch and exact SourceBuffer identities'],
  ['hlsStaleRecoveryAbortCount: this.hlsStaleRecoveryAbortCount || 0', 'first-party HLS stats must expose recovery work rejected after lifecycle invalidation'],
  ['offset = hlsFmp4TimestampOffset(self, track, seg, data);', 'first-party HLS fMP4 media appends must preserve embedded timestamps'],
  ['SOURCEBUFFER_WATCHDOG_MS', 'native SourceBuffer append watchdog must be centralized and short enough for live playback'],
  ['SEGMENT_BUSY_WATCHDOG_MS', 'native HLS append ordering must not remain blocked behind stale busy segments'],
  ['function mutateSourceBuffer(sb, mutation, options)', 'all native SourceBuffer mutations must share one timeout-bound queue primitive'],
  ["timeoutMessage: 'sourcebuffer-timeout'", 'native SourceBuffer appends must not leave live HLS queues permanently stuck'],
  ["timeoutMessage: 'sourcebuffer-remove-timeout'", 'native SourceBuffer removals must release their queues when updateend never arrives'],
  ["sourceBufferMutationTimeoutCount: sourceBufferMutationStat(this, '_nativeMutationTimeoutCount')", 'first-party HLS stats must expose timed-out SourceBuffer mutations'],
  ['timeoutId = setTimeout(done, SOURCEBUFFER_WATCHDOG_MS);', 'native SourceBuffer idle waits must not leave live HLS queues permanently stuck'],
  ['function hlsAppendSegmentWithWatchdog(provider, track, seg, data, appendTransaction)', 'first-party HLS must watchdog the complete segment append chain'],
  ['transaction.muxed && !sourceBufferContainsSegment(transaction.audioSourceBuffer, seg)', 'muxed HLS watchdog completion must require audio and video coverage'],
  ["reject(new Error('hls-append-timeout'))", 'first-party HLS segment append watchdog must fail unbuffered stalled appends'],
  ['function segmentsAppendedThroughEnd(segments, duration)', 'native MSE providers must detect when VOD media is fully appended'],
  ['NativeHlsProvider.prototype._maybeEndVodStream = function ()', 'first-party HLS VOD must close MediaSource after the final segment'],
  ['NativeDashProvider.prototype._maybeEndVodStream = function ()', 'first-party DASH VOD must close MediaSource after the final segment'],
  ['vodEndOfStreamCount: this.vodEndOfStreamCount || 0', 'native MSE provider stats must expose explicit VOD end-of-stream closure'],
  ['function prepareVodStreamRefill(provider)', 'native MSE providers must reopen ended VODs for unbuffered replay and seeks'],
  ['function sourceBufferCoversPlayableEnd(sb, expectedEnd)', 'native MSE providers must verify playable tail coverage before closing VOD'],
  ['this.muxedTsAudio\n        && this.audioSb\n        && !sourceBufferCoversPlayableEnd(this.audioSb, playableSegmentEnd(this.segments))', 'muxed HLS VOD must verify audio reaches the playable end before closing MSE'],
  ['function removeBufferAfter(sb, removeStart, guard)', 'HLS quota recovery must be able to evict non-critical forward buffer'],
  ['hlsQuotaDownswitchCount: this.hlsQuotaDownswitchCount || 0', 'HLS quota downswitches must be observable without permanently blacklisting a rendition'],
  ['function applyProviderPresentationState(provider, live, duration)', 'native adaptive providers must synchronize live-to-VOD state through one transition path'],
  ['function jumpDeclaredManifestGap(provider, type)', 'native adaptive providers must traverse only manifest-authorized large timeline gaps'],
  ['function allSegmentsDeclaredGap(segments)', 'first-party HLS must recognize renditions whose manifests forbid every media request'],
  ['this.suppressedAudioGapTrack = audioOnlyGaps;', 'first-party HLS must not create an empty audio SourceBuffer that blocks playable video'],
  ['NativeHlsProvider.prototype._reconcileTrackLifecycle = function (generation)', 'first-party HLS must generation-guard rendition reactivation after transient all-gap windows'],
  ['NativeHlsProvider.prototype._beginTrackTransition = function (reason)', 'first-party HLS quality and audio switches must use a shared transition transaction'],
  ['NativeHlsProvider.prototype._rollbackTrackTransition = function (transaction)', 'first-party HLS track transitions must restore the prior manifest and SourceBuffer state on failure'],
  ['function clearSourceBuffer(sb)', 'explicit rendition switches must clear the complete future SourceBuffer range'],
  ['sourceBuffer.changeType(mimeType);', 'first-party HLS must change SourceBuffer types before cross-codec rendition appends'],
  ["new Error('hls-' + kind + '-sourcebuffer-rebuild-failed')", 'first-party HLS must rebuild SourceBuffers when changeType is unavailable'],
  ['function acceptHlsPlaylistCursor(provider, url, parsed, kind)', 'first-party HLS must reject per-playlist cursor regressions'],
  ['function applyHlsPlaylistEpoch(provider, url, parsed, previousSegments, kind)', 'first-party HLS must rebase confirmed encoder restarts onto a continuous timeline'],
  ['function assignHlsTimestampGenerations(provider, url, parsed, kind)', 'first-party HLS must isolate embedded media clocks across discontinuities and init maps'],
  ['function detectHlsMediaContainer(data, seg)', 'first-party HLS must detect segment containers from bytes instead of trusting URL suffixes'],
  ["container === 'mpegts'", 'first-party HLS must route each fetched segment by its detected container'],
  ['_hlsInitSegment: map', 'HLS media objects must retain ownership of the EXT-X-MAP active when they were parsed'],
  ['NativeHlsProvider.prototype._prepareDiscontinuityAppend = function (track, seg)', 'first-party HLS must prepare the correct init segment before appending a discontinuity generation'],
  ['NativeHlsProvider.prototype._decryptHlsInitIfNeeded = function (initSegment, data)', 'first-party HLS must decrypt AES-128 initialization sections before MSE append'],
  ["unresolved.code = 'HLS_TIMESTAMP_UNRESOLVED'", 'first-party HLS must reject unresolved generation timing instead of guessing a media clock'],
  ['function pruneHlsTimestampGenerations(provider)', 'first-party HLS must bound timestamp-generation state to active playlist windows'],
  ['hlsInitMapSwitchCount: this.hlsInitMapSwitchCount || 0', 'first-party HLS stats must expose generation init-map switches'],
  ['playlistEpochResetCount: this.playlistEpochResetCount || 0', 'first-party HLS stats must expose confirmed playlist epoch resets'],
  ['playlistEpochHoldCount: this.playlistEpochHoldCount || 0', 'first-party HLS must expose atomic video/audio epoch holds'],
  ["'required-track-not-ready'", 'first-party HLS must not commit a split reset while a required sibling track is stale'],
  ['this._fetchPlaylistText(rendition.url, { signal: transaction.controller.signal })', 'first-party HLS alternate-audio playlist requests must abort with their track transaction'],
  ['if (this.playlistRefreshPromise && this.playlistRefreshKey === refreshKey)', 'first-party HLS must coalesce concurrent refreshes for the same active renditions'],
  ["this.playlistRefreshReasonInFlight !== 'media-error'", 'HLS media recovery must not reuse a refresh that began before the failed media request'],
  ['function settleHlsPlaylistFetch(fetchPromise, kind, timeoutMs)', 'HLS rendition refreshes must isolate slow or failed sibling playlist fetches'],
  ['function createHlsPlaylistRefreshDraft(provider, selectedVariant, selectedAudio)', 'HLS split-rendition refreshes must validate detached manifest state before publishing'],
  ['if (this.playlistManifestCommitInProgress) return false;', 'HLS media appends must stop while a staged manifest transaction is committing'],
  ['playlistManifestCommitCount: this.playlistManifestCommitCount || 0', 'HLS stats must expose staged manifest commits'],
  ['this.videoEndList && !parsed.endList', 'first-party HLS terminal state must ignore stale live Playlist responses'],
  ["self.presentationEnded && parsed.type === 'dynamic'", 'first-party DASH terminal state must ignore stale dynamic MPD responses'],
  ['if (this.manifestRefreshPromise)', 'first-party DASH must coalesce concurrent manifest refreshes'],
  ["this.manifestRefreshReasonInFlight !== 'media-error'", 'DASH media recovery must wait for a causally newer manifest refresh'],
  ["manifestRefreshReason: stalePublishTime ? 'stale-publish-time' : 'stale-live-window'", 'first-party DASH must reject freshness and window regressions'],
  ['PlayerEngine.prototype._startInternalStallWatch = function ()', 'native startup stalls must recover before the first playing event'],
  ['var waitingStarted = !self._stallWatchWaiting;', 'repeated waiting events must not postpone the native stall watchdog indefinitely'],
  ['if (providerPlayableEnd(provider) <= 0)', 'all-gap VOD replay must not enter an impossible MediaSource refill state'],
  ['function recoverStuckSourceBuffer(provider, track)', 'first-party HLS must recover SourceBuffers stuck in updating before append drain starts'],
  ['sourceBufferAbortCount: this.sourceBufferAbortCount || 0', 'first-party HLS stats must expose SourceBuffer abort recovery count'],
  ['if (!ownsSegment) return;', 'stale HLS append callbacks must not overwrite a newer segment owner'],
  ['if (this._videoTrack) resetActiveSegmentRequests(this._videoTrack);', 'HLS cancellation must release the actual video append owner'],
  ['now - startedAt > SEGMENT_BUSY_WATCHDOG_MS', 'first-party HLS must reset stale fetching/appending segments that block ordered appends'],
  ["if (old.state === 'fetched' && old._data)", 'HLS playlist refresh must only preserve fetched segment state when fetched bytes are preserved'],
  ["old.state === 'fetching' || old.state === 'fetched' || old.state === 'appending'", 'HLS playlist refresh must preserve in-flight segment objects so fetch completions keep their data'],
  ['NativeHlsProvider.prototype._loadStartupMediaPlaylists = function ()', 'first-party HLS startup must retry alternate variants when a live rendition playlist fails'],
  ['NativeHlsProvider.prototype._reloadMasterPlaylist = function ()', 'first-party HLS startup must refresh stale live master playlists after rendition exhaustion'],
  ["self.lastSwitchReason = 'startup-master-refresh';", 'first-party HLS master refresh must be observable in stats'],
  ["self.lastSwitchReason = 'startup-playlist-fallback';", 'first-party HLS startup variant fallback must be observable in stats'],
  ['/(range|manifest)-http-(403|404|410|416|5\\d\\d)|Failed to fetch|Load failed|network/i', 'refreshable HLS request classification must include media playlist HTTP failures'],
  ['new NativeUrlProvider(self, progressiveUrl, \'progressive\')', 'progressive URL provider must receive the stamped progressive URL'],
].forEach(([needle, message]) => assertIncludes('public/native-player-engine.js', nativeEngine, needle, message));

assertNoAssetReference(
  'public/native-player-engine.js',
  nativeEngine,
  'hlsFmp4TimestampOffset(self, track, seg)',
  'first-party HLS fMP4 must not add playlist time on top of embedded tfdt timestamps'
);

const hlsRoutes = readText('routes/stream/hls.ts');
const hlsManifest = readText('lib/hls-manifest.ts');
[
  ['async function refreshHlsEntry(videoId)', 'HLS routes must be able to rebuild missing or stale HLS cache entries'],
  ['entry = await refreshHlsEntry(videoId);', 'top-level HLS manifest route must re-extract when the HLS cache is missing or expired'],
  ['body = rewriteHlsManifest(body, videoId, entry.url, token)', 'top-level HLS manifest rewrite must pass the stream token'],
  ['body = rewriteHlsManifest(body, req.params.videoId, url, token)', 'nested HLS manifest rewrite must pass the stream token'],
  ['appendHlsReloadParams(url, req.query)', 'HLS proxy must forward allowlisted LL-HLS delivery directives'],
].forEach(([needle, message]) => assertIncludes('routes/stream/hls.ts', hlsRoutes, needle, message));
[
  ["function rewriteHlsManifest(body: string, videoId: string, baseUrl: string, token = '')", 'HLS manifest rewriting must accept the stream token'],
  ["if (token) params.set('token', token);", 'HLS proxy URLs must preserve stream token auth'],
  ["params.set('kind', 'playlist');", 'HLS playlist proxy URLs must be distinguishable from cacheable media'],
  ['function appendHlsReloadParams', 'HLS reload directive handling must remain centralized and allowlisted'],
].forEach(([needle, message]) => assertIncludes('lib/hls-manifest.ts', hlsManifest, needle, message));
if ((hlsRoutes.match(/upstream\.status === 403 \|\| upstream\.status === 404 \|\| upstream\.status === 410/g) || []).length < 2) {
  fail('routes/stream/hls.ts: stale HLS master and media playlist 404s must invalidate cached YouTube HLS URLs');
}

const qualityMenu = readText('views/player/quality-menu.ejs');
[
  ['qualityRow.button.addEventListener(\'click\', function ()', 'quality menu must rebuild from current variant tracks when opened'],
  ['rebuildQualityMenu();', 'quality menu open path must rebuild visible quality options'],
  ['var isProgressive = !tracks.length && !assetUri;', 'quality menu must not classify adaptive HLS as progressive when variant tracks exist'],
  ['isProgressive = !tracks.length && !player.getAssetUri();', 'quality state must not classify adaptive HLS as progressive when variant tracks exist'],
].forEach(([needle, message]) => assertIncludes('views/player/quality-menu.ejs', qualityMenu, needle, message));

const tsAdapterStart = nativeEngine.indexOf('function createTsTransmuxerAdapter');
const tsAdapterEnd = tsAdapterStart === -1 ? -1 : nativeEngine.indexOf('function FirstPartyTsTransmuxer', tsAdapterStart);
if (tsAdapterStart === -1 || tsAdapterEnd === -1) {
  fail('Could not locate first-party TS transmuxer adapter boundary');
} else {
  const tsAdapterBlock = nativeEngine.slice(tsAdapterStart, tsAdapterEnd);
  if (/\bshaka\b/i.test(tsAdapterBlock) || tsAdapterBlock.includes('loadShaka')) {
    fail('First-party TS transmuxer adapter must not depend on Shaka');
  }
}

const appJs = readText('public/app.js');
[
  ['function clearBarTimers()', 'loading bar must clear prior intervals and finish timeout before reuse'],
  ['window._startLoadBar = startBar', 'must expose a global loading-bar starter'],
  ['window._finishLoadingBar = finishBar', 'must expose a global loading-bar finisher'],
  ['window._resetLoadingBar = function ()', 'must expose a global loading-bar resetter'],
  ['window._setLoadBarProgress = function (pct)', 'must expose extraction progress updates for the loading bar'],
  ['function finishShellLoad()', 'shell fallback paths must finish the loading bar and timer'],
  ['function resetShellLoadState()', 'shell fallback paths must reset stale timer and stream state'],
  ['if (!main) {\n    resetShellLoadState();\n    if (window._finishLoadingBar) window._finishLoadingBar();', 'fallback without a main element must not leave shell loading state running'],
  ['if (!res.ok) {\n        finishShellLoad();\n        window.location.href = href;', 'hard navigation fallback must finish shell loading state before leaving'],
  ['if (!result) {\n          finishShellLoad();\n          window.location.reload();', 'popstate reload fallback must finish shell loading state before leaving'],
  ["setNavStreamVia('offline');", 'offline watch fallback must publish a current stream notification'],
  ["function isWatchDocumentUrl(url)", 'watch destinations must have an explicit full-document navigation boundary'],
  ["if (isWatchDocumentUrl(url)) {\n        startBar();\n        if (window._startLoadTimer) window._startLoadTimer();\n        return;", 'watch links must retain immediate loading feedback without being intercepted by PJAX'],
  ["if (isWatchDocumentUrl(new URL(window.location.href))) {\n      window.location.reload();", 'watch popstate destinations must reload as streamed documents'],
  ['window._startLoadTimer = function ()', 'must expose a global load-timer starter'],
  ['window._stopLoadTimer = function ()', 'must expose a global load-timer stopper'],
  ['if (!el) { startTime = 0; return; }', 'load timer stop must cancel internal state even when the nav timer element is missing'],
  ['window._resetLoadTimer = function ()', 'must expose a global load-timer resetter'],
  ["if (isWatchDocumentUrl(targetUrl)) {\n      window.location.assign(targetUrl.href);", 'programmatic watch navigation must also bypass buffered PJAX'],
  ['if (window._resetLoadTimer) window._resetLoadTimer();', 'non-watch navigation must reset the load timer'],
  ["document.getElementById('stream-via')", 'non-watch navigation must clear the stream notification badge'],
].forEach(([needle, message]) => assertIncludes('public/app.js', appJs, needle, message));

const playerView = readText('views/player.ejs');
[
  ['var statusSource = null;', 'player must track SSE status source'],
  ['var statusWs = null;', 'player must track WebSocket status source'],
  ['var statusStopped = true;', 'player must distinguish intentional status shutdown from transport failure'],
  ['var statusTimeout = 0;', 'player must track status inactivity timeout'],
  ['function armStatusTimeout()', 'player status polling must have an inactivity timeout'],
  ['statusWs.onerror = function ()', 'player must fall back when WebSocket errors'],
  ['statusWs.onclose = function ()', 'player must handle early WebSocket close'],
  ['if (!statusStopped && !_extractionDone && !statusSource && !statusFallbackStarted)', 'intentional WebSocket close must not restart SSE polling'],
  ["statusSource.addEventListener('error', function () {\n          stopStatusPoll();\n          _fireExtractionDone();", 'SSE transport failure must unblock load retry listeners'],
  ['startStatusSSE();', 'player must retain an SSE status fallback'],
  ['_fireExtractionDone();', 'status completion must unblock load retries'],
  ["stepLabels[d.step] || d.step", 'stream notification badge must render extraction status text'],
  ['if (finalVia) setStreamVia(finalVia);', 'stream notification badge must show final stream source on readiness'],
  ['if (window._stopLoadTimer) window._stopLoadTimer();', 'player readiness/error must stop the load timer'],
  ['if (window._finishLoadingBar) window._finishLoadingBar();', 'player readiness/error must finish the loading bar'],
  ['function requestAutoplay(reason)', 'player must centralize autoplay startup and retry handling'],
  ['if (blocked && !autoplayAttemptedMuted)', 'autoplay must retry muted when browser policy blocks unmuted playback after async navigation'],
  ["video.addEventListener('loadedmetadata', retry, { once: true });", 'autoplay must retry when metadata becomes available after async SPA navigation'],
  ["video.addEventListener('canplay', retry, { once: true });", 'autoplay must retry when media becomes playable'],
  ['if (!video.paused) autoplaySettled = true;', 'autoplay must not settle until playback actually starts'],
  ['if (!isLivePlayback()) {', 'player reveal must use the live helper instead of an undefined isLive flag'],
  ["requestAutoplay('reveal');", 'player readiness must request autoplay through the retry helper'],
  ['if (engine._internalStallWatch) return;', 'watch page must not duplicate the native engine startup stall watchdog'],
  ['var providerFinalDuration = Number(stats.vodFinalDuration) || 0;', 'player ended handling must honor the native provider terminal contract'],
  ['if (video.currentTime < realDur - 5) {\n          if (!engine.isRecovering()) engine.reportStall();\n          return;', 'player ended handling must treat unverified premature ended as a stall before playlist advance'],
  ['if (wantsAutoplay && playlistNextUrl && !isLivePlayback()) window.location.href = playlistNextUrl;', 'playlist autoplay must only advance after a validated non-live end'],
].forEach(([needle, message]) => assertIncludes('views/player.ejs', playerView, needle, message));

const wsStatus = readText('lib/ws-status.ts');
[
  ['let getCurrentStatus:', 'WebSocket status server must support a current-status provider'],
  ['const current = getCurrentStatus ? getCurrentStatus(videoId) : null;', 'WebSocket clients must receive current in-flight status on connect'],
  ['ws.send(JSON.stringify({ step: current.step }))', 'WebSocket current-status delivery must send the active step'],
  ['function setStatusProvider', 'WebSocket current-status provider must be configurable for routes/tests'],
  ['listeners.clear();', 'WebSocket shutdown must clear listener state'],
].forEach(([needle, message]) => assertIncludes('lib/ws-status.ts', wsStatus, needle, message));

const streamStatus = readText('routes/stream/status.ts');
[
  ['wsStatus.setStatusProvider((videoId) => extractionStatus.get(videoId));', 'stream status route must expose current extraction state to WebSocket connections'],
  ['wsStatus.notify(videoId, { step })', 'stream status route must notify WebSocket step changes'],
  ['wsStatus.notify(videoId, { done: true })', 'stream status route must notify WebSocket completion'],
  ['res.write(`data: ${JSON.stringify({ step: current.step })}\\n\\n`);', 'SSE route must send current in-flight step on connect'],
  ["res.write('event: done\\ndata: {}\\n\\n');", 'SSE route must emit done on timeout/completion'],
].forEach(([needle, message]) => assertIncludes('routes/stream/status.ts', streamStatus, needle, message));

const resilienceTests = readText('tests/resilience.test.mjs');
assertIncludes(
  'tests/resilience.test.mjs',
  resilienceTests,
  "sends the current extraction step immediately on connect",
  'must test immediate current-status delivery for WebSocket clients'
);

const browserTests = readText('tests/browser/native-player.spec.mjs');
assertIncludes(
  'tests/browser/native-player.spec.mjs',
  browserTests,
  'watch navigation loading bar timer and stream status badge complete in browser',
  'must exercise loading bar, timer, and stream status badge in a real browser'
);
assertIncludes(
  'tests/browser/native-player.spec.mjs',
  browserTests,
  'native HLS discontinuity fixture appends the generation init and remaps reset fMP4 timestamps through MSE',
  'must exercise per-discontinuity init and tfdt generation mapping through real MediaSource'
);

const performanceRunner = readText('tests/performance/player-parity.spec.mjs');
[
  ["method: 'intersection-union test over co-primary cell/metric/percentile claims'", 'performance proof must use the all-claims co-primary intersection-union decision'],
  ["multiplicityAdjustment: 'none required: every co-primary component must pass'", 'performance proof must not apply disjunctive multiplicity logic to universal non-inferiority'],
  ["superiorityMultiplicityCorrection: 'Bonferroni'", 'native-better findings must retain family-wise multiplicity protection'],
  ['superiorityFamilyWiseUpperBound < 0', 'native-better findings must clear zero on the family-wise upper bound'],
  ["waitUntil: 'domcontentloaded'", 'performance collection must not confuse the unrelated page load event with fixture completion'],
  ['page.evaluate(() => window.__playerBenchmarkDone)', 'performance collection must wait for the explicit fixture result'],
  ["type: 'collection-failure'", 'collector transport retries must be preserved in the durable checkpoint'],
  ["retryUnit: 'entire pair in the original implementation order'", 'collector failures must retry the whole paired observation symmetrically'],
  ['classifyImplementationScriptTransportFailure', 'zero-byte implementation-script transport failures must be classified from CDP evidence'],
  ['classifyCompletedBenchmarkNetworkIoSuspension', 'completed browser-wide network-I/O suspension must be classified from console and CDP evidence'],
  ['consoleErrors.every(error => error === NETWORK_IO_SUSPENDED_CONSOLE_ERROR)', 'network-I/O suspension retry must reject unrelated console errors'],
  ['requestOrigin !== normalizedBenchmarkOrigin', 'network-I/O suspension retry must be restricted to the benchmark origin'],
  ["'net::ERR_NETWORK_IO_SUSPENDED'", 'Chromium network-service suspension must be a transparent collection failure'],
  ["request.encodedBytes !== 0", 'partially delivered implementation scripts must remain hard failures'],
  ['request.canceled', 'canceled requests must remain hard failures'],
  ['request.blockedReason', 'blocked requests must remain hard failures'],
  ['request.corsErrorStatus', 'CORS failures must remain hard failures'],
  ["request.status !== 0 && (request.status < 200 || request.status >= 300)", 'HTTP implementation-asset failures must remain hard failures'],
  ["'net::ERR_BLOCKED_BY_CLIENT'", 'blocked implementation scripts must remain hard failures in the collector self-check'],
  ["fixtureResult: { error: 'media-error' }", 'completed player errors must remain hard in the network-suspension self-check'],
  ["failed: 'net::ERR_CONNECTION_RESET'", 'general media transport failures must remain hard in the network-suspension self-check'],
  ['validateCollectionFailureClassification();', 'performance proof must self-check transport classification before collection'],
  ['Irrevocable proof gate failed', 'proof collection must fail fast after an unrecoverable hard-gate violation'],
].forEach(([needle, message]) => (
  assertIncludes('tests/performance/player-parity.spec.mjs', performanceRunner, needle, message)
));

const performanceFixture = readText('tests/fixtures/player-performance.html');
[
  ['window.__playerBenchmarkComplete = false;', 'performance fixture must expose explicit completion state'],
  ['function completeBenchmark()', 'performance fixture must resolve through one idempotent completion path'],
  ["result.error = result.error || 'benchmark-timeout';", 'performance fixture must surface its own watchdog as a player observation'],
].forEach(([needle, message]) => (
  assertIncludes('tests/fixtures/player-performance.html', performanceFixture, needle, message)
));

if (!process.exitCode) {
  console.log('[player-parity-guard] native watch-shell contract ok');
  console.log('[player-parity-guard] loading/timer/status contract ok');
  console.log('[player-parity-guard] Shaka fallback retirement ok');
  console.log('[player-parity-guard] legacy engine retirement ok');
  console.log('[player-parity-guard] universal performance-proof contract ok');
}
