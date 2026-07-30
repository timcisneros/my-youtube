# Native player performance parity with Mux Player

## Claim

This repository treats “universal p50/p95 parity” as one co-primary
intersection-union claim over **every cell in the declared benchmark matrix**,
not as an aggregate result that can hide a weak device, network, preload mode,
or media format. The global claim passes only if every declared
cell/metric/percentile passes.

The claim is intentionally finite:

- Comparator: `@mux/mux-player` 3.13.2, with its pinned
  `@mux/playback-core` and HLS.js versions recorded in the evidence.
- Runtime: the exact Linux Chromium build and host recorded in the evidence.
- Media: the production-preferred DASH/HLS comparison, protocol-controlled HLS
  fMP4 comparison, MPEG-TS, progressive MP4, live HLS, and seek fixtures in the
  matrix below.
- Outcomes: Page Load Time, Player Startup Time, Video Startup Time, Aggregate
  Startup Time, first-to-steady advancing-frame time, Seek Latency, and
  seek-to-advancing-frame latency.

It does **not** claim that one laboratory run proves all browsers, physical
devices, CDNs, codecs, DRM systems, ads, or real-world content. Those require
field data and additional platform-specific runs. “Universal” everywhere below
means no averaging across the finite, versioned matrix.

## Canonical result

The fresh schema-12 proof completed on July 29, 2026. It started from zero
resumed pairs and collected all **7,900 paired observations**: 200 in each of
37 startup cells and 500 in the seek cell. The pinned environment was Chromium
149.0.7827.55 on the Linux/Intel host recorded in the evidence. The run was
proof-eligible, every hard admissibility gate passed, and all **384/384**
co-primary p50/p95 non-inferiority claims passed.

This is universal parity over the declared lab matrix, with the finite scope
above. It is not a claim about untested browser engines or field populations.

| Metric | Co-primary claims | Strict native-better | Parity only |
| --- | ---: | ---: | ---: |
| Page Load Time | 76 | 75 | 1 |
| Player Startup Time | 76 | 76 | 0 |
| Video Startup Time | 76 | 70 | 6 |
| Aggregate Startup Time | 76 | 74 | 2 |
| First-to-steady advancing-frame time | 76 | 35 | 41 |
| Seek Latency | 2 | 0 | 2 |
| Seek-to-advancing-frame latency | 2 | 0 | 2 |
| **Total** | **384** | **330** | **54** |

“Strict native-better” above means the larger of the exact and paired-BCa
superiority upper bounds was below zero after Bonferroni family-wise correction
over all 384 optional findings. The other 54 claims passed parity but are not
called wins.

The tightest non-inferiority component was seek-to-frame p50. Native measured
48.5 ms versus Mux at 32.6 ms; the conservative upper bound on native minus Mux
was 16.034 ms against the predeclared 25 ms margin, leaving **8.966 ms
headroom**. The remaining seek results were:

| Seek outcome | Percentile | Native | Mux | Governing upper bound | Margin |
| --- | ---: | ---: | ---: | ---: | ---: |
| Seek event | p50 | 36.95 ms | 38.40 ms | -0.60 ms | 25 ms |
| Seek event | p95 | 52.60 ms | 56.01 ms | 3.70 ms | 25 ms |
| Advancing frame | p50 | 48.50 ms | 32.60 ms | 16.034 ms | 25 ms |
| Advancing frame | p95 | 49.40 ms | 49.40 ms | 0.10 ms | 25 ms |

All 38 quality, smoothness, network-efficiency, and collection-reliability
gates passed:

- Native was never lower resolution across 16,300 paired frame checkpoints and
  was higher at 1,787 of them.
- Native dropped 59 of 320,704 decoded frames (0.0184%); Mux dropped 13,526 of
  328,100 (4.1225%).
- Native made zero duplicate encoded-media URL/range requests; Mux made eight.
- Native transferred 3,634,789,363 encoded bytes versus Mux at 5,245,954,806,
  a native/Mux ratio of 69.287% (30.713% fewer bytes).
- There were no retained player, console, cache, quality, or network-gate
  errors.

Two Chromium network-I/O suspensions caused transparent whole-pair retries:
one affected Mux and one affected native. Each implementation therefore had one
failure among 201 attempts in its affected cell (0.498%), below the 1% gate and
perfectly symmetric by implementation. Both discarded attempts, both clean
counterparts, and their full CDP waterfalls remain in raw evidence.

## Why these metrics

The metric boundaries follow Mux’s published definitions:

- [Mux Startup Time](https://www.mux.com/docs/guides/data-startup-time-metric)
  defines Video Startup Time from play intent to the first displayed,
  progressing frame; it also separates Page Load Time and Player Startup Time,
  defines Aggregate Startup Time as Page Load + Player Startup + Video Startup,
  and calls out p50 and p95.
- The same guide defines Seek Latency from the beginning of a seek until the
  player is ready to resume. The harness reports that boundary and a stricter
  seek-to-advancing-frame boundary.
- [Mux Video Quality](https://www.mux.com/docs/guides/data-video-quality-metric)
  treats delivered resolution/upscaling as a separate QoE dimension. A timing
  result is therefore inadmissible here if native obtains it at lower displayed
  resolution.
- [Mux Smoothness](https://www.mux.com/docs/guides/data-smoothness-metric)
  treats rebuffering and rendition stability separately from startup and seek.
  Each cell therefore gates post-start waiting incidence and dropped-frame
  percentage in addition to timing. This short synthetic window is still not a
  substitute for long-view field smoothness data.

Mux Player is configured with analytics and cookies disabled, optional Cast
loading suppressed, `prefer-playback="mse"`, and `preload="auto"`. The tested
media and network are otherwise identical. Mux documents that it uses HLS.js
and stream-type-specific settings in its
[core functionality guide](https://www.mux.com/docs/guides/player-core-functionality).
The pinned comparator is Mux Player 3.13.2, the current
[official GitHub release](https://github.com/muxinc/elements/releases) at the
time of collection, with playback-core 0.35.2 and HLS.js 1.6.16 recorded from
the lockfile/package graph. Newly exposed advanced preload tuning is left
unset, so both components use their normal `preload="auto"` behavior rather
than benchmark-only segment-count overrides.

The lab host is deliberately minimal. It measures the native playback runtime
against the distributable Mux Player component, not either application’s
surrounding watch page. Mux’s component UI is inseparable from its published
bundle; this application’s separate server-rendered watch-page controls are
outside Page Load and Player Startup in this lab. Full-page field telemetry is
therefore still required before making a watch-page-wide claim.

## Matrix

The canonical proof matrix contains 38 unique cells:

| Dimension | Values |
| --- | --- |
| Network | 20 ms / 25 Mbps, 60 ms / 8 Mbps, 100 ms / 4 Mbps, 180 ms / 1.5 Mbps |
| Device | 1365×768 desktop at 1× CPU; 390×844 mobile emulation at 4× CPU throttling and 3× DPR |
| Product path | Native DASH fMP4 plus alternate audio vs Mux HLS fMP4 plus alternate audio, referencing the same encoded CMAF files and rendition ladder |
| Protocol control | Native and Mux both use the same demuxed HLS fMP4 manifest, video, and alternate audio |
| Play mode | Cold play intent; play after `loadeddata` preloading |
| Format coverage | HLS fMP4 with alternate audio, AES-128 HLS, video-only HLS, muxed MPEG-TS HLS, progressive MP4, live HLS |
| Interaction | Startup in every main cell; an external-audio VOD seek cell |

Each main comparison is 4 networks × 2 devices × 2 play modes = 16 cells.
The product-path and HLS protocol-control comparisons therefore contribute 32
cells. Six format/interaction cells bring the total to 38.

LL-HLS is intentionally not a timing cell. A static playlist ending in partial
segments is not a live service: it cannot fairly exercise playlist reload,
blocking-reload, preload-hint, or live-edge behavior in either player. Native
LL-HLS remains covered by protocol and playback correctness tests. Timing parity
requires a separate continuously publishing origin and is outside this proof;
the report must not imply otherwise.

Each page runs long enough to capture:

1. the first advancing decoded frame;
2. an advancing frame 1.5 media-seconds later, away from this fixture’s
   one-second rendition boundary; and
3. for the seek cell, the first advancing frame at the seek target.

At every checkpoint, native’s decoded width and height must each be at least
Mux’s. A single lower-resolution native observation fails the cell regardless
of its timing. Higher native resolution is admissible because it makes the
timing comparison conservative.

The wall-clock interval from the first frame to the steady checkpoint also gets
p50/p95 confidence bounds. Within every cell, native’s aggregate decoded-frame
drop rate and incidence of post-start `waiting` events may each be at most one
percentage point above Mux. Within every pair, native also may not repeat more
identical encoded-media URL/range requests than Mux. This catches aborted or
duplicated segment work that a short startup percentile can otherwise hide.
These are hard admissibility gates.

## Experimental controls

- A new browser context is created for every player observation.
- Browser cache is cleared and disabled; service workers are blocked.
- The local origin is prewarmed before measured contexts, avoiding a one-sided
  fixture-generation penalty.
- Network latency/throughput and CPU rate are applied through Chromium
  emulation. Chrome describes disabled cache as a first-visit emulation in its
  [Network reference](https://developer.chrome.com/docs/devtools/network/reference/).
- Native-first and Mux-first order alternates deterministically within paired
  runs.
- Per-cell sample targets are evenly distributed across 500 global rounds,
  with a reproducible seeded shuffle of active cells each round. The 200-pair
  cells therefore span the same wall-clock run as the 500-pair seek cell
  instead of occupying an earlier phase, so warm-up and host drift are not
  confounded with one matrix cell.
- The same generated encoded media, rendition ladder, viewport, DPR, and
  play/seek intent are used in each pair. The protocol-control cells also use
  the same manifest. The explicitly labeled product-path cells use DASH for
  native and HLS for Mux, matching each player’s supported production path.
- Page Load ends immediately before player construction; Player Startup ends
  when the component can accept its source; Video Startup begins at `play()`.
  Aggregate is the sum of those three intervals. This intentionally excludes
  idle preload time before the simulated viewer clicks play.
- A frame is accepted only through `requestVideoFrameCallback` (or the explicit
  fallback) after media time advances; `playing` or `loadeddata` is not
  mislabeled as a displayed frame.
- Navigation waits for `DOMContentLoaded`, then collection waits separately for
  the fixture’s explicit completion promise. The fixture has its own 30-second
  watchdog, so a completed `benchmark-timeout`, preload/frame timeout, media
  error, or player error is a real failed observation and is never retried.
- A Playwright/browser transport failure is a collection failure, not a
  latency observation. This normally means that the fixture could not return a
  completed result. The sole completed-result exception is the fixture’s
  generic `implementation-script-load-failed`: it is retryable only when the
  CDP waterfall proves that the exact native or Mux implementation asset had a
  successful-or-unanswered HTTP status, delivered zero bytes, and ended with a
  whitelisted transient Chromium network error. HTTP 4xx/5xx responses,
  blocked assets, partially delivered scripts, syntax errors, and all
  player/media/frame/preload/benchmark failures remain hard failures. A
  collection failure is checkpointed with its waterfall and page diagnostic,
  the entire pair is discarded, and the same implementation order is retried
  up to three total attempts. Each implementation’s observed
  collection-failure rate must be at most 1%, and native may be no more than
  one percentage point above Mux. The raw evidence retains every discarded
  attempt.
- A second completed-result exception covers Chromium’s browser-wide
  `ERR_NETWORK_IO_SUSPENDED` state. The fixture must otherwise succeed, every
  console error must be the exact suspension message, and at least one
  same-origin CDP request must have delivered zero bytes, be uncanceled,
  unblocked and non-CORS, and have status 0 or 2xx. That proven suspension—not
  another request outcome—is what authorizes the whole-pair retry.
- Every console error, page error, player error, missing metric, cache hit,
  lower native displayed resolution, or excess duplicate encoded-media request
  is retained in raw evidence and fails the applicable gate. In proof mode an
  irrevocable zero-tolerance gate stops collection immediately rather than
  spending hours on a run that cannot pass.
- Each observation includes its complete CDP request waterfall and encoded
  byte count.

## Statistical decision rule

The proof run requires 200 **paired** observations in every cell and 500 in the
seek cell. Seek-event and seek-to-frame latency have the sparsest, most
quantized tails, so the larger seek target is pre-registered to tighten both
exact and paired-bootstrap bounds. No metric, margin, failed player result, or
adverse completed observation is removed.

Let each of the 384 cell/metric/percentile comparisons be a co-primary
component. The global null is that **at least one** native population quantile
is inferior beyond its margin; the global alternative is that **all** 384 are
within their margins. This is an intersection-union test (IUT): each component
is tested one-sided at 5%, and universal parity is concluded only when every
component passes. Under any global-null configuration, at least one component
null is true, so the probability that all component tests reject is at most 5%.
There is no cross-component multiplicity penalty for this all-must-pass
decision. This is the same co-primary-endpoint principle described in the
[FDA multiple-endpoints guidance](https://www.fda.gov/media/162416/download?attachment=)
and the
[EMA multiplicity guideline](https://www.ema.europa.eu/en/documents/scientific-guideline/draft-guideline-multiplicity-issues-clinical-trials_en.pdf).

For every cell and metric:

1. Compute p50 and p95 with R-7 linear interpolation.
2. Construct an exact, distribution-free upper endpoint for the native
   population quantile and lower endpoint for the Mux population quantile from
   binomial order-statistic ranks. Each endpoint is 97.5% one-sided; splitting
   the component’s 5% alpha across the two endpoints makes their difference an
   at-least-95% one-sided upper bound for native minus Mux. Pair dependence is
   allowed; no latency-distribution shape is assumed.
3. Generate a one-sided paired bias-corrected and accelerated (BCa) bootstrap
   95% upper confidence bound with at least 100,000 resamples as a second
   check. Pairing is preserved in every resample and jackknife deletion. Never
   use a BCa endpoint below the requested percentile endpoint. If an adjusted
   upper tail contains fewer than ten Monte Carlo draws, use the maximum
   bootstrap estimate.
4. Use the larger of the exact distribution-free and paired-BCa upper bounds.
5. Pass only when that bound is no greater than
   `max(25 ms, 5% of the 97.5% lower bound for the Mux population
   percentile)`. Basing the relative margin on a lower bound, rather than the
   observed Mux percentile, keeps the decision conservative.

“Native better” is a separate, disjunctive reporting family: finding any one
advantage is reportable, so multiplicity protection is required. All 384
optional superiority claims retain Bonferroni family-wise error control at 5%.
For those findings, the claim-level confidence is about 99.98698%, each exact
marginal endpoint has about 99.99349% confidence, the larger exact/BCa upper
bound governs, and `native-better` is reported only when that family-wise upper
bound is below **0 ms**. A parity margin is never relabeled as superiority.

NIST describes population percentiles and their order-statistic interpretation
in its [percentile reference](https://itl.nist.gov/div898/handbook/prc/section2/prc262.htm).
[NIST Technical Note 2119](https://doi.org/10.6028/NIST.TN.2119) describes
selecting order-statistic ranks through the binomial distribution to obtain
confidence bounds for a population quantile.
NIST also describes BCa as bias-corrected, accelerated, and second-order
accurate in its
[bootstrap reference](https://www.itl.nist.gov/div898/software/dataplot/refman1/auxillar/bootplot.htm).
Its [Bonferroni guidance](https://itl.nist.gov/div898/handbook/prc/section4/prc473.htm)
states that per-claim confidence of `1 - alpha/g` provides overall simultaneous
coverage of at least `1 - alpha`; that correction is used for the superiority
family, not misapplied to the all-must-pass IUT.

There are 384 co-primary comparisons: five metrics × two percentiles in all 38
cells, plus two additional seek metrics × two percentiles in the seek cell. At
200 pairs, the 95% component-bound p50 endpoints use native rank 115 and Mux
rank 86; p95 uses native rank 197 and Mux rank 184. At 500 seek pairs, p50 uses
native rank 273 and Mux rank 228, while p95 uses native rank 485 and Mux rank
465. The stricter family-wise superiority bounds retain ranks 128/73 and
200/176 at n=200, and 294/207 and 492/454 at n=500. Achieved binomial coverage
is recorded rather than assumed. Probabilities are generated outward from the
binomial mode and normalized, avoiding high-quantile underflow such as
`0.05^500`. One hundred thousand resamples put roughly 5,000 draws in the
non-inferiority upper tail and about 13 in each Bonferroni superiority tail
before any conservative maximum fallback.

A discarded schema-9 collection applied Bonferroni across all 384
non-inferiority components. That construction was valid but answered the wrong
multiple-testing structure and was drastically underpowered: at n=200 it made
native’s sample maximum govern p95 even though universal success requires
**every** component to pass. It also waited on the browser `load` event and
persisted one page-renderer transport timeout as a player sample. Schema 10
corrected those errors, but its classifier later treated a completed generic
script-load result as irrevocable even though the CDP waterfall proved that
Chromium suspended the native script request after HTTP 200 and delivered zero
bytes (`net::ERR_NETWORK_IO_SUSPENDED`). That 6,110-pair checkpoint is
preserved as invalid evidence. Schema 11 was defined before the next canonical
run: it retains the IUT and separate Bonferroni superiority family, and
narrowly classifies a zero-byte transient failure on the exact implementation
asset as a transparent whole-pair collection retry.

Schema 11 then stopped correctly after 5,041 pairs when the Mux half of an
otherwise-successful sample logged `net::ERR_NETWORK_IO_SUSPENDED`. The CDP
waterfall showed one same-origin v720 media-range response with HTTP 200, zero
delivered bytes, `canceled: false`, and no block or CORS reason; Mux recovered
on v360 and completed the fixture. Chromium defines that code as an operation
that cannot complete because **all network I/O is suspended** in its
[canonical network error list](https://chromium.googlesource.com/chromium/src/+/master/net/base/net_error_list.h).
Schema 11 was therefore also too narrow: it correctly recognized the same
browser-infrastructure condition for an implementation script, but incorrectly
charged it to a player when it struck a media request. Its checkpoint is
preserved as invalid evidence.

Schema 12 was defined before restarting canonical collection. It permits a
whole-pair retry for a completed fixture only when the fixture otherwise
succeeded, every console error is exactly Chromium's network-I/O-suspension
message, and CDP proves that every matching request is same-origin, zero-byte,
uncanceled, unblocked, non-CORS, and either has no response status or a 2xx
status. The rule is implementation-agnostic and self-tested for both native and
Mux. A matching suspended request is inadmissible if it was partially
delivered, canceled, blocked, CORS-failed, cross-origin, or returned 4xx/5xx;
other network codes cannot independently authorize a retry. Unrelated console
errors and any fixture/player error remain irrevocable. Every admitted retry is
recorded and still counts against the predeclared 1% absolute and
native-versus-Mux collection-reliability gates.

The native discarded attempt also records one later same-origin, zero-byte,
player-canceled `ERR_ABORTED` media request after the proven suspension. The
fixture still succeeded and the only console errors were the four suspension
messages. That cancellation is preserved as recovery fallout and is not itself
a retry reason. The independent evidence auditor admits only this narrow
post-suspension cancellation pattern; it rejects an uncanceled, partially
delivered, blocked, CORS, cross-origin, or arbitrary coexisting network
failure. This closes the ambiguity discovered during final review without
altering the hashed schema-12 runner or hiding the raw event.

## Reproduction and evidence

Run:

```sh
npm run benchmark:player:proof
```

Audit an existing canonical result independently:

```sh
npm run benchmark:player:audit
```

The proof command requires the exact canonical matrix, at least 200 pairs per
cell, at least 500 pairs in the seek cell, and at least 100,000 bootstrap
resamples. Collection is checkpointed after every completed pair and can resume
after a recorded transport failure only when the browser, matrix, retry policy,
per-cell sample targets, and hashed benchmark artifacts match exactly. It
writes:

- `tmp/player-performance/proof.raw.json` — every paired observation and
  request waterfall;
- `docs/player-performance-proof.json` — reviewable claims and artifact hashes;
- `docs/evidence/player-performance-proof.raw.json.gz` — compressed immutable
  raw evidence.

Canonical evidence identity:

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| Raw JSON | 225,823,428 | `4beb811e2cb4b316a3978db33fde003a4e36c48d1a0a1e2272a678f4a7a5dc09` |
| Gzip archive | 11,807,830 | `2c9f1725dad7435827659782f1ae7d24c0a216e8a0747759c01b9587bf5303ce` |
| Review summary | 920,048 | `d99d431f6e37960e45657a55922fbe29c74fd999b97906e503664179edd445e2` |

The archive expands byte-for-byte to the raw JSON and therefore has the same
decompressed SHA-256 (`4beb…c09`). The standalone auditor verifies that
identity, enforces the exact 38-cell matrix and deterministic pair order,
rederives every reported latency from its raw timestamps, independently
derives the binomial order-statistic ranks and achieved coverages, recomputes
the exact bounds, margins, verdicts and every hard gate, validates both retry
records under the stricter rule above, and re-hashes every pinned source
artifact. It passes without an exception.

The report records comparator/package versions, browser/host information,
matrix parameters, source sizes, and SHA-256 hashes for the native engine, Mux
bundle, fixture, runner, fixture generator, and lockfile. `pass: true` is
impossible unless the run is proof-eligible and every co-primary claim,
collection-reliability gate, quality/smoothness/network gate, and error gate
passes.

## Native implementation changes found by the audit

The comparison exposed problems that ordinary happy-path playback tests did
not:

- Bandwidth samples included time-to-first-byte, severely underestimating
  capacity for short low-rendition fragments. Native now keeps a time-weighted
  fast/slow EWMA, separately estimates TTFB, and samples transfer throughput
  with the same latency separation used by mature HLS ABR engines.
- Alternate-audio downloads incorrectly influenced the video rendition
  estimator. Only video/muxed-media samples now drive video ABR.
- A rejected upgrade incorrectly started the four-second switch cooldown.
- A fixed 14-second upgrade buffer made quality promotion impossible for short
  assets. Upgrades now require the predicted next-fragment fetch to fit inside
  the current starvation budget.
- Low buffer during a normal seek was mistaken for congestion.
- A rendition switch could schedule old-rendition fragments after the new
  rendition had been selected.
- A new rendition also re-fetched timeline intervals already buffered from the
  prior rendition. The scheduler now treats fully buffered intervals as
  satisfied and starts at the next segment boundary, avoiding wasted bytes and
  nondeterministic delayed quality changes.
- Live startup alignment was incorrectly reapplied after playback had advanced.
  The resulting synthetic backward seek aborted an almost-complete ABR request,
  fetched the same byte range twice, and produced a post-start wait. Internal
  live alignment can now move an uninitialized playhead forward but cannot
  rewind active playback; internal recovery seeks are also distinguished from
  viewer seeks.
- fMP4 switches did not reliably append the new rendition’s initialization
  segment, which could produce a decoder pipeline error after a resolution
  change.
- DASH switches could likewise schedule new-rendition media before the new
  initialization segment was ready, silently ignore an init append failure,
  and leave a failed rendition active. DASH switching is now serialized and
  rolls back to the prior rendition on failure.
- A low-buffer heuristic caused 720p→360p oscillation even when measured
  bandwidth safely sustained 720p. Upgrade and sustain thresholds now have
  explicit hysteresis.
- A viewer’s manual quality choice could arrive while an automatic rendition
  transition was still appending its initialization segment and then be
  silently overwritten. DASH and HLS now retain the latest manual choice,
  finish or roll back the in-flight transition, and apply the viewer choice
  before automatic scheduling resumes.
- Already-buffered seeks still aborted or re-marked media work and synchronously
  ran the full scheduler path before Chromium could present the target frame.
  HLS and DASH now detect a buffered target, preserve useful in-flight requests,
  skip scheduler churn, and close the provider seek lifecycle on the real
  `seeked` event. A fresh 200-pair focused validation measured seek-frame p95 at
  49.3 ms native versus 49.4 ms Mux, with zero playback errors.
- Muxed MPEG-TS exposed its first native video frame before the separately
  remuxed audio SourceBuffer was ready. That made startup look faster but moved
  roughly two frames of delay into early playback. Native now prepares both
  outputs together and appends audio before exposing video, eliminating that
  clock catch-up without a post-start wait.
- The watch route waited on optional remote video and playlist metadata before
  rendering, and the first browser-side revision merely moved those requests
  to immediately after provider attachment—still early enough to contend with
  the first frame. Cached metadata is now accepted without waiting; unresolved
  details and playlist requests start only after first playback plus an idle
  callback, with a 1.5-second no-play fallback. This improves the application
  path but is outside the component-only lab claim above.

The same audit also corrected LL-HLS trailing-part modeling, implicit byte
ranges, gaps, blocking reload directives/fallback, partial-to-parent state,
and preload-hint hold/reuse semantics against Apple’s
[LL-HLS guidance](https://developer.apple.com/documentation/http-live-streaming/enabling-low-latency-http-live-streaming-hls)
and the current
[HLS bis draft](https://datatracker.ietf.org/doc/draft-pantos-hls-rfc8216bis/22/).

## Areas where native can be better

The suite reports superiority only from Bonferroni family-wise confidence
bounds below zero, not from point estimates. It also preserves non-statistical
implementation facts:

- The native engine asset is 433,529 bytes raw, 86,803 bytes gzip, and 64,559
  bytes Brotli. The pinned Mux Player bundle is 1,070,173 bytes raw, 302,611
  bytes gzip, and 242,959 bytes Brotli. Native is therefore 59.5% smaller raw,
  71.3% smaller gzip, and 73.4% smaller Brotli in this exact comparison.
- Player Startup Time and Aggregate Startup Time include that script and custom
  element initialization cost. Native is strictly better in all 76 Player
  Startup claims and 74 of 76 Aggregate Startup claims under the corrected
  family-wise test.
- Native also proves strict advantages in 75 of 76 Page Load, 70 of 76 Video
  Startup, and 35 of 76 playback-advance claims. Seek remains parity-only and
  is not relabeled as a win.
- The quality/network gates additionally observed 30.7% fewer encoded bytes,
  59 versus 13,526 dropped frames, eight fewer duplicate encoded-media
  requests, and 1,787 higher-resolution checkpoints with none lower. These are
  descriptive hard-gate outcomes, not retroactively added superiority claims.
- The native engine supports this application’s first-party DASH, offline
  IndexedDB ranges, server-restart hold/resume, token refresh, and proxy/cache
  telemetry paths. Those application-specific capabilities are outside the Mux
  performance comparator and must not be presented as Mux benchmark wins.
