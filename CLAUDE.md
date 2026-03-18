# my-youtube

Self-hosted YouTube frontend. Proxies all video/audio/thumbnails through the server — zero direct Google contact from the browser.

## Stack

- **Runtime**: Node.js with TypeScript (tsx for dev, tsc for production builds)
- **Module system**: ESM (`import`/`export`) with `"type": "module"` in package.json
- **Web framework**: Express 4
- **Database**: SQLite (better-sqlite3) by default, PostgreSQL (pg) when `DATABASE_URL` is set
- **Views**: EJS server-rendered with streaming HTML (shell flushed before data is ready)
- **Video playback**: Shaka Player (DASH/HLS), with progressive MP4 fallback
- **Optional services**: Redis (shared cache + sessions + BullMQ extraction queue), S3 (download storage)

## Architecture

```
server.ts              → Express app setup, middleware, health checks
cluster.ts             → Multi-worker via node cluster
extraction-worker.ts   → Standalone BullMQ worker for video extraction

lib/                   → Infrastructure
  ytdlp-extract.ts     → Core yt-dlp extraction (shared by worker + web server)
  extract.ts           → Full extraction chain for the worker process
  cache.ts             → L1 (LRU) + L2 (Redis) two-tier cache
  lru-map.ts           → Generic LRU Map<K,V>
  storage.ts           → S3/local filesystem abstraction
  ws-status.ts         → WebSocket extraction progress notifications
  segment-cache.ts     → Redis hot segment cache
  extraction-queue.ts  → BullMQ queue client
  logger.ts            → Structured JSON logger

extractors.ts          → Innertube + Invidious extraction backends, circuit breakers, SSRF validator
yt-meta.ts             → Video metadata fetcher (3-strategy fallback: API → scrape → yt-dlp)
ytdlp.ts               → yt-dlp CLI arg builders, cookie management, browser detection
auth.ts                → Session auth, HMAC stream tokens
db.ts                  → SQLite database (delegates to db-pg.ts when DATABASE_URL set)
db-pg.ts               → PostgreSQL database (same API as db.ts, async)
types.ts               → Shared TypeScript interfaces (DatabaseAPI, SyncDatabaseAPI, VideoFormat, etc.)
express.d.ts           → Express augmentation (flushShell, streamContent, extractionRateCheck, SessionData)

youtube/               → YouTube data layer
  index.ts             → Barrel re-export
  shared.ts            → Cache instances, TTL constants, request semaphore, HLS format selection
  rss.ts               → Channel RSS feeds
  subscriptions.ts     → Subscription list + pagination
  today.ts             → Today's videos aggregation
  explore.ts           → Explore page — local recommendation algorithm (returns ExploreResult: videos + continueWatching + newVideoIds). Exports ExploreConfig interface + DEFAULT_EXPLORE_CONFIG for weight injection. Emits explore-perf structured log with timing checkpoints.
  explore-metrics.ts   → Explore evaluation metrics, tokenize/STOP_WORDS, topic diversity (MMR re-ranking)
  video-details.ts     → Video metadata (oEmbed fast → Innertube enrichment)
  channel.ts           → Channel info + video listing (Innertube browse API)
  durations.ts         → Duration format/cache

routes/                → Page routes + API endpoints
  today.ts             → GET / (today's videos)
  explore.ts           → GET /explore (personalized recommendations)
  subscriptions.ts     → GET /subscriptions
  channel.ts           → GET /channel/:id, avatar proxy
  player.ts            → GET /watch?v=, GET /watch/details
  tags.ts              → POST/DELETE /api/tags
  comments.ts          → GET /api/comments/:videoId, replies, avatar proxy
  downloads.ts         → GET /downloads, DELETE /downloads/:videoId
  subscriptions-api.ts → POST /api/subscriptions/* (fetch, import, unsubscribe)
  cookies.ts           → /api/cookies/* (browsers, refresh, upload)
  dismissals.ts        → POST/DELETE /api/dismissals (dismiss video from Explore)
  boosts.ts            → POST/DELETE /api/boosts (boost channel for Explore)
  mutes.ts             → POST/DELETE /api/mutes (mute channel from Explore)
  queue.ts             → GET /queue, POST/DELETE /queue (watch queue)
  explore-events.ts    → POST /api/explore-events (log Explore click for CTR tracking)
  ratings.ts           → POST/DELETE /api/ratings (per-video thumbs up/down)
  topic-filters.ts     → POST/GET/DELETE /api/topic-filters (explicit topic boost/suppress)

routes/stream/         → Video streaming pipeline (mounted at /api/stream)
  index.ts             → Router composition, stream token auth, prefetch
  shared.ts            → Caches (format, MPD, URL, HLS, VTT), yt-dlp semaphore, helpers
  extraction.ts        → Format extraction with cache, Redis dedup, notifications
  mpd.ts               → DASH MPD generation (probe MP4 boxes → generate XML)
  dash-routes.ts       → GET /:videoId/dash.mpd, GET /:videoId/fmt/:formatId
  hls.ts               → HLS manifest rewriting + segment proxy
  subtitles.ts         → VTT subtitle proxy
  proxy.ts             → Format proxy (progressive + per-itag with range support)
  assets.ts            → Poster, thumbnails, storyboards, chapters, durations
  downloads.ts         → Background download manager
  status.ts            → SSE + WebSocket extraction progress

scripts/               → Tooling & evaluation
  explore-eval.ts      → Offline holdout evaluation of explore algorithm (npm run eval:explore)
  explore-optimize.ts  → Coordinate descent weight optimizer (npm run optimize:explore)

tests/                 → Test suites
  integration.test.mjs → DB layer, auth, rate limiting, HTTP endpoints (65 tests)
  resilience.test.mjs  → Resilience under failed optional services (22 tests)
  explore.test.mjs     → Explore algorithm unit tests — scoring, config injection, filtering (12 tests)

public/                → Browser JS (plain JS, not TypeScript)
  app.js               → Main UI (navigation, search, subscription management)
  player-engine.js     → Shaka Player setup, quality switching, keyboard shortcuts
  sw.js                → Service worker

views/                 → EJS templates
  partials/shell-start.ejs → Streamed HTML shell (head + nav + <main>)
  player.ejs + player/*    → Video player page (modular sub-templates)
  today.ejs, explore.ejs, channel.ejs, subscriptions.ejs, downloads.ejs, queue.ejs, login.ejs
```

## Key patterns

- **Extraction chain**: yt-dlp (cookies → browser cookies → alt clients) → Innertube API → Invidious API. Each backend has a circuit breaker. Core yt-dlp logic lives in `lib/ytdlp-extract.ts`, used by both `lib/extract.ts` (worker) and `routes/stream/extraction.ts` (web server).
- **DatabaseAPI interface** (`types.ts`): Both `db.ts` and `db-pg.ts` implement `DatabaseAPI`. SQLite methods are sync, PostgreSQL methods are async. `db.ts` exports as `SyncDatabaseAPI` (mapped type that unwraps `MaybePromise<T>` to `T`) for the default SQLite path. Tables: `tags`, `subscriptions`, `downloads`, `channels`, `rss_cache`, `video_durations` (columns: `video_id`, `duration`, `live_status`, `tags`, `description`), `watch_time`, `related_videos`, `dismissals` (columns: `user_id`, `video_id`, `channel_id`), `channel_boosts`, `explore_events` (columns include `position`, `bounce_seconds`; event types: `impression`, `click`, `bounce`, `return`), `watch_queue`, `channel_mutes`, `video_ratings`, `topic_filters`, `explore_sessions` (columns: `user_id`, `session_id`, `started_at`, `clicks`, `total_watch_seconds`, `best_completion`).
- **Streaming HTML**: Routes call `res.flushShell()` to send head+nav immediately, then `res.streamContent()` with data once ready. Defined in `server.ts` middleware, typed in `express.d.ts`.
- **Two-tier cache**: `lib/cache.ts` provides `SharedLRUMap` — sync L1 (in-process LRU) with async L2 (Redis write-through). Used for format cache, MPD cache, URL lookup, HLS cache, VTT cache, and explore cache (shared across workers in cluster mode).
- **Stream auth**: HMAC-signed tokens created in `auth.ts`, validated in `routes/stream/index.ts`. Tokens scoped per video ID with 8-hour TTL.
- **Extraction rate limiting**: Per-IP token bucket (5 extractions/min) with per-videoId dedup — a single video page load (prefetch + dash.mpd + Shaka retries) only consumes 1 slot.
- **Lazy thumbnails**: Templates render `<img data-src="..." class="lazy-thumb">` instead of `src`. `app.js` uses IntersectionObserver to swap `data-src` → `src` when images enter the viewport (400px margin). This prevents 45+ simultaneous HTTP requests on page load. The `loadThumbnails()` function is called alongside `loadDurations()` on every page render and pjax navigation.

## Commands

```sh
npm run dev              # Start dev server (tsx watch)
npm test                 # Integration tests (65 tests)
npm run test:resilience  # Resilience tests (22 tests)
npm run test:all         # All test suites (65 + 22 + 12 = 99 tests)
npm run typecheck        # tsc --noEmit (zero errors expected)
npm run lint             # ESLint — catches floating/misused promises + any
npm run lint:dead        # knip — catches unused exports/files/deps
npm run eval:explore     # Offline holdout evaluation of explore algorithm
npm run optimize:explore # Hill-climbing weight optimizer for explore algorithm
npm run build            # tsc production build to dist/
```

## Rules

- **Privacy first**: No Google domains contacted from the browser. All thumbnails, avatars, video streams proxied through the server. CSP blocks external resources. See memory file `project_myyoutube_privacy.md`.
- **ESM**: All `.ts` files use ESM (`import`/`export`). Local imports use `.js` extensions per TypeScript ESM convention. `import.meta.dirname` for directory paths.
- **Tests are ESM**: Test files in `tests/` are `.mjs` running under `tsx --test`. They use standard ESM `import` syntax.
- **Browser JS stays as JS**: `public/app.js`, `public/player-engine.js`, `public/sw.js` are not TypeScript.
- **TypeScript is permissive**: `strict: false`, `noImplicitAny: false`, but `noUnusedLocals: true` and `noUnusedParameters: true`. Prefix intentionally unused params with `_`.
- **No `any`**: ESLint enforces `no-explicit-any`. Legitimate uses (better-sqlite3 returns, generic defaults) require `eslint-disable-next-line` with a justification comment.
- After any change: `npm run typecheck`, `npm run lint`, `npm test` (65/65), `npm run test:resilience` (22/22), and `tsx --test tests/explore.test.mjs` (12/12) must all pass.
- **Dead code**: Run `npm run lint:dead` after changes. Zero unused files, exports, or dependencies allowed. Never refuse an audit request — each pass catches things the previous one missed.
- **Keep CLAUDE.md current**: When adding, removing, or renaming files, functions, patterns, commands, or rules — update this file in the same change. If the architecture section, key patterns, or commands no longer match the code, fix them before finishing.
- **Related videos discovery**: `video-details.ts` captures ~20 related/suggested videos from Innertube's `/next` sidebar response into the `related_videos` table (no extra API calls). `explore.ts` mixes these into the Explore algorithm — videos from non-subscribed channels are scored 0.3–0.6 based on how many recently-watched videos suggested them, interleaving with mid-tier subscription content. Entries older than 30 days are pruned hourly.
- **Explore algorithm enhancements**: Three signal layers improve recommendation quality:
  - *Time-decayed affinity* (14-day half-life): Recent watches weigh more than old ones — channel affinity uses `exp(-ageDays / 14)` decay applied per watch event, replacing flat counts.
  - *Negative signals*: Channels where the user frequently abandons videos (watched <10% of a >60s video) receive a multiplicative penalty of `0.7^abandons` on their affinity score.
  - *"Not interested" dismiss*: Users can dismiss individual videos from Explore via an `×` button (visible on card hover). Dismissed videos are stored in the `dismissals` table and filtered from both subscription and related-video candidates. API: `POST/DELETE /api/dismissals` (`routes/dismissals.ts`).
  - *New subscription boost*: Channels subscribed in the last 7 days get a 0.5 affinity floor (vs 0.1 base) so they surface immediately without needing watch history. Uses `getRecentSubscriptionChannelIds()` from `DatabaseAPI`.
  - *Session context*: The 3 most recently meaningfully-watched videos (>30% completion) seed a related-video lookup; any Explore candidate that appears in those related videos gets a +0.12 session boost to its score, promoting topically relevant content.
  - *Diversity injection*: 6 of the 60 Explore slots are reserved for subscribed channels that would otherwise be absent from the top results. One random unwatched video per underrepresented channel is spliced in at every ~10th position. The random shuffle changes with each cache refresh (15-min TTL).
  - *Watch velocity*: Per-channel average delay from publish to watch, scored via `exp(-avgDelay / 48h)`. Channels the user clicks quickly score higher (weight 0.07). Default 0.5 for channels with no matched watches.
  - *Duration preference*: Penalizes videos whose length diverges from the user's median watch duration. Penalty = `-min(0.05, |log(candidateDur/medianDur)| * 0.02)`. Neutral when duration data is unavailable.
  - *Publish cadence*: Channels that post rarely get a per-video boost via `1/sqrt(videoCount)` (weight 0.05). Prolific posters are dampened.
  - *Title keyword similarity*: Keyword overlap between the last 10 meaningful watch titles and each candidate title (weight 0.07). Uses tokenization with stop-word filtering.
  - *Completion-weighted keyword similarity*: Keywords from recent meaningful watches are weighted by watch completion ratio (0.0–1.0) rather than treated as a flat set. Keywords from fully-watched videos dominate over those from barely-watched ones. Uses max-completion per keyword across source watches to avoid frequency bias. Same 0.07 weight, output still normalized to [0, 1].
  - *Binge detection*: Detects per-channel viewing bursts — 3+ meaningful watches from the same channel within a 2-hour window triggers a +0.08 additive boost for that channel's unwatched videos. Uses meaningful watches only (>30% completion) so abandoned clicks don't trigger. Boost decays naturally as the 2-hour window passes and the 15-min explore cache refreshes.
  - *Live/premiere boost*: Videos currently live (`is_live`) get a +0.10 additive boost; upcoming premieres (`is_upcoming`) get +0.04. Uses the existing `live_status` column from `video_durations`. Post-live and normal uploads get no boost. Additive like session/binge boosts.
  - *Time-decayed CTR*: Explore impressions and clicks are time-decayed with a 21-day half-life (`exp(-age × ln2 / 21)`). Recent clicks/impressions weight more than old ones, so the CTR multiplier reflects current preferences rather than stale history. The staleness penalty also self-corrects as old impressions decay below the activation threshold.
  - *Cross-channel topic affinity*: Channels the user hasn't watched directly can receive transferred affinity from topically-related watched channels, based on co-occurrence in the `related_videos` graph. For each watched channel, similarity to other channels is computed as `coOccurrenceCount / totalRelatedLinks`. Transferred affinity is capped at 60% of the user's max direct affinity to prevent never-watched channels from dominating. Replaces the flat 0.1 base for unvisited channels.
  - *Shorts separation*: Videos ≤60s are identified as Shorts via `video_durations`. Shorts are excluded from the median duration calculation and from CTR/impression aggregation to prevent signal pollution. Shorts candidates receive a -0.04 additive penalty. Not completely filtered — just ranked lower on this long-form-oriented frontend.
  - *Subscription staleness suppression*: Channels with watch history but no watches in 60+ days receive a staleness multiplier on affinity, linearly decaying from 1.0× at 60 days to 0.5× at 180 days. Prevents abandoned subscriptions from occupying Explore slots indefinitely. Uses `max(updated_at)` per channel from the watch_time loop. No new DB queries.
  - *Channel watch recency*: Separate additive signal (weight 0.04) measuring how recently the user watched any video from a channel, with a 7-day half-life. Differentiates channels watched yesterday from those watched two weeks ago, even when their overall affinities are similar. Zero contribution for channels with no watch history.
  - *Negative keyword signal*: Keywords extracted from abandoned watches (>60s video, <10% watched) form a negative keyword set, excluding any keywords that also appear in the positive set from meaningful watches. Candidate videos whose titles overlap with negative keywords receive a penalty up to -0.03, scaled by overlap fraction (×3 amplification, clamped to 1). Prevents repeatedly surfacing content in topic areas the user has shown disinterest in.
  - *Day-of-week affinity*: Per-channel profile of which days of the week the user watches, derived from `watch_time.updated_at` of meaningful watches. Channels concentrated on the current day of the week get a boost; channels never watched on this day get a mild penalty. Weight 0.03, neutral for channels with <5 meaningful watches. Mirrors the time-of-day signal but captures weekly patterns (weekend binge channels vs weekday commute channels).
  - *Series awareness*: Detects recurring title patterns within the same channel from the last 30 meaningful watches. Tokens appearing in 2+ watched videos from a channel form a "series fingerprint". Candidates from the same channel whose titles share ≥50% of the fingerprint tokens receive a +0.10 additive boost. Helps surface part 4 when the user watched parts 1-3.
  - *Cross-user video popularity*: Counts distinct users who meaningfully watched (>30% completion or position-reset) each candidate video via `getVideoPopularity()`. Boost = `min(0.06, log2(1 + distinctUsers) × 0.03)` — logarithmic to prevent viral runaway. First collaborative filtering signal; degrades gracefully to noise-level constant in single-user mode. New index `idx_watch_time_video` on `watch_time(video_id)` supports the cross-user aggregation query.
  - *Cross-user channel quality*: For channels with no personal watch history, no new-sub boost, and no topic-transferred affinity, uses other users' subscription counts via `getChannelSubscriberCounts()` to compute a community-informed base affinity (0.1–0.25) instead of the flat 0.1 default. Logarithmic scaling: `0.1 + log2(1 + otherSubscribers) × 0.05`, capped at 0.25. Returns 0 in single-user mode (self excluded), preserving current behavior.
  - *Deep cut resurfacing*: Reserves 4 of 60 Explore slots for older unwatched videos (≥7 days) from the user's top-5 affinity channels. Bypasses the recency penalty that normally buries older content. One video per channel, randomly shuffled per cache refresh, spliced into positions 20+. Surfaces gems the user missed without displacing fresh high-scoring content.
  - *Channel boost*: Users can explicitly boost channels via a toggle button (↑) on Explore cards, shown on hover. Boosted channels receive a 1.5× multiplier on affinity scoring. Stored in the `channel_boosts` table. API: `POST/DELETE /api/boosts` (`routes/boosts.ts`). Clears Explore cache on toggle for immediate effect.
  - *Epsilon-greedy exploration*: 6 of 60 Explore slots are reserved for random mid-tier videos (positions 30–100 in scored list), one per channel, excluding channels with 2+ videos already in the feed. Spliced at every ~10th position (offset from diversity injection). Random shuffle per cache refresh prevents filter bubbles without degrading quality.
  - *Watch completeness trend*: Detects rising or falling interest per channel by comparing median completion of recent meaningful watches vs older ones. Channels where the user's completion rate is declining (fatigue) get an affinity penalty (down to 0.85×); channels with rising completion get a boost (up to 1.15×). Requires ≥6 meaningful watches per channel before activating. Applied as a multiplier on channel affinity (0.32 weight), no separate weight.
  - *Time-of-day affinity*: Per-channel profile of which 6-hour time slots (night/morning/afternoon/evening) the user watches in, derived from `watch_time.updated_at` of meaningful watches (>30% completion). Channels concentrated in the current time slot get a boost; channels never watched at this time get a mild penalty. Weight 0.05, neutral for channels with <3 meaningful watches.
  - *Click-through rate (CTR) tracking*: Impressions and clicks on Explore videos are logged in the `explore_events` table. Clicks are **completion-weighted**: each click's value is the watch completion ratio (0.0–1.0) from `watchMap`, with a 0.5 default when no watch data exists. After 3+ channel impressions, a CTR multiplier (`0.5 + weightedClicks/impressions`, range 0.5x–1.5x) is applied to channel affinity. Videos shown 3+ times without a meaningful click (≥10% completion) receive a staleness penalty (up to -0.03). Events pruned after 90 days.
  - *Watch queue*: Save-for-later with denormalized metadata (title, channel). Queued videos boost their channel's affinity by +0.08 per video (capped at 0.24). Queue page at `/queue` with nav link. API: `POST/DELETE /queue` (`routes/queue.ts`). Table: `watch_queue`.
  - *Channel mute*: Hard filter inverse of boost. Muted channels completely excluded from Explore (main grid, continue-watching, related videos). Muting auto-removes boost (mutually exclusive). API: `POST/DELETE /api/mutes` (`routes/mutes.ts`). Table: `channel_mutes`.
  - *Feed freshness indicator*: Videos with zero prior impressions receive a green "NEW" badge in `.video-info`. Computed from existing `explore_events` data via `videoImpressionCount` map. No new DB table.
  - *Series ordering*: Within detected series, episode numbers are extracted from titles via regex (Ep N, Part N, #N, S1E2, Day N, trailing numbers). The next unwatched episode receives +0.15 on top of the base +0.10 series boost (total +0.25). Already-watched or earlier episodes have their series boost suppressed to 0. No new DB tables.
  - *Re-watch allowance*: Fully-watched videos from "comfort channels" (≥5 watches, ≥0.8 avg completion, channel is boosted or has queued videos) are allowed back into candidates with a -0.15 penalty. Surfaces rewatchable content without polluting recommendations for casual channels. No new DB tables.
  - *Content-category decay rates*: Replaces the global 72h recency half-life with per-channel decay tiers inferred from title keywords: fast (24h — news/reactions), normal (72h — default), slow (14d — tutorials/educational), evergreen (12w — music/ambient/podcasts). Channel classification requires ≥40% keyword dominance; ambiguous channels default to normal. Single-pass O(N) over videoTitleMap. No new DB tables or API calls.
  - *Tag-based topic vectors*: Video tags/keywords from yt-dlp and Innertube are stored in a `tags` column on `video_durations` (JSON string array, captured in `cacheVideoDetailsFromInfo`). Completion-weighted tag profile from last 20 meaningful watches is compared against candidate tags. Weight 0.06, same normalization as title keyword similarity. Supplements title-only matching with richer metadata. Uses `setVideoTags()`/`getVideoTags()` from `DatabaseAPI`.
  - *Item-item co-watch collaborative filtering*: For multi-user instances, builds a co-watch matrix from `watch_time` — finds videos meaningfully watched by other users who also watched videos the current user watched. Boost = `min(0.08, log2(1 + coWatchUsers) * 0.05)`. Logarithmic to prevent viral runaway. Degrades to zero in single-user mode. Uses `getCoWatchedVideos()` from `DatabaseAPI`. No new tables — uses existing `watch_time` with `idx_watch_time_video` index.
  - *Absolute watch time weighting*: Channel affinity weighted by absolute watch seconds using `log2(1 + watchSeconds / 600)`. A fully-watched 45-min video contributes ~2.5× more affinity than a 10-min video. Also fixes a bug where fully-watched videos (position reset to 0) contributed 0 completion to affinity and were excluded from meaningful watches.
  - *Description-based topic similarity*: Video descriptions persisted to `description` column on `video_durations` (capped at 2KB). Tokenized description keywords from last 20 meaningful watches compared against candidate descriptions (weight 0.04, first 500 chars). Supplements title+tag matching. Uses `setVideoDescription()`/`getVideoDescriptions()` from `DatabaseAPI`.
  - *Watch session modeling*: Session context detects the current watch session as a cluster of meaningful watches within a 2-hour window (up to 8 seeds), replacing the fixed 3-most-recent approach. Related videos suggested by multiple session seeds receive graduated boosts (half at 1 source, full +0.12 at 2+ sources). Falls back to 3-most-recent when no active session detected.
  - *Per-video ratings*: Explicit thumbs up/down on Explore cards and player page. Thumbs-up adds +0.15 to the video's score and boosts the channel's affinity (+0.05 per upvote, capped at +0.20). Thumbs-down applies -0.10 penalty and excludes from related video candidates. Cross-user aggregate ratings provide a mild ±0.04 community signal. Stored in `video_ratings` table. API: `POST/DELETE /api/ratings` (`routes/ratings.ts`).
  - *Session-type detection*: Computes median duration of current session seeds (excluding Shorts). Candidates whose duration diverges from the session median receive a penalty up to -0.04 (scale 0.015). Helps keep short-clip sessions short and essay sessions long without new DB tables.
  - *Position bias correction*: Explore impressions now record the display position index. CTR computation weights impressions and clicks by `1/expectedCTR(pos)` where `expectedCTR(pos) = 1/(1+log2(1+pos))`. Videos at top positions no longer inflate their channel's CTR. Old rows with `position=0` produce `posWeight=1.0` (backward compatible).
  - *Explicit topic filters*: Users can boost or suppress cross-channel topics via pill-style UI on the Explore page. Matching candidates receive ±0.06 additive score. Stored in `topic_filters` table. API: `POST/GET/DELETE /api/topic-filters` (`routes/topic-filters.ts`).
  - *Viewport-aware impressions*: Impressions are logged client-side via IntersectionObserver (50% threshold) instead of server-side on page load. Batched via `POST /api/explore-events/impressions` with 2s debounce. Prevents false impressions from videos never scrolled to (positions 40-60), improving CTR data quality. Old inflated rows decay via existing 21-day half-life.
  - *Recommendation explainability badges*: Each Explore video displays a subtle reason badge (`for you`, `trending`, `topic`, `session`, `binge`, `series`, `live`, `community`, `new channel`, `discover`, `deep cut`, `explore`) based on the dominant scoring signal. Diversity picks tagged `discover`, deep cuts `deep cut`, exploration picks `explore`. Purely presentational.
  - *Recommendation reset*: "Reset recommendations" button on the Explore page clears all per-user recommendation data (watch_time, explore_events, explore_sessions, dismissals, channel_boosts, channel_mutes, video_ratings, topic_filters, watch_queue, tags) and invalidates the explore cache. API: `POST /explore/reset`. Uses `resetRecommendations(userId)` from `DatabaseAPI`. Intended for simulation runs.
  - *Dismiss-to-mute channel escalation*: Dismissing 3+ videos from the same channel auto-mutes the channel (also removes boost). `dismissals` table now has `channel_id` column. `getDismissalCountByChannel()` counts per-channel dismissals. Threshold constant `DISMISS_MUTE_THRESHOLD = 3` in `routes/dismissals.ts`. Client removes all cards from auto-muted channel.
  - *Session quality metrics*: Per-session metrics tracked in `explore_sessions` table (clicks, total_watch_seconds, best_completion). Session ID generated per Explore page load (`Date.now().toString(36)`). When success rate (best_completion >= 0.3) of last 10 sessions drops below 50%, `DEEP_CUT_SLOTS` and `EXPLORATION_SLOTS` increase by 50%. Self-correcting feedback loop. Pruned after 90 days.
  - *Series episode gap tolerance*: Series boost no longer requires exact next episode. Graduated boost for gaps 1-3: EP+1 = +0.15, EP+2 = +0.10, EP+3 = +0.05 (formula: `SERIES_NEXT_BOOST * (1 - (gap-1) / SERIES_GAP_TOLERANCE)`). Beyond EP+3: base +0.10 only. Also tracks full watched episode set per channel to suppress any watched episode, not just those <= maxWatched.
  - *Binge exhaustion detection*: Flips the +0.08 binge boost to a -0.04 penalty after 5+ watches from the same channel within the 2-hour binge window. Depths 3-4 still receive the groove boost; depth 5+ gently suggests alternatives. Uses existing `channelRecentWatches` depth counter.
  - *Content-category-aware rewatch scoring*: Replaces the flat -0.15 rewatch penalty with tier-aware penalties based on `channelDecayTier`: EVERGREEN (music/podcasts) → 0 penalty, SLOW (tutorials) → -0.05, NORMAL/FAST → -0.15. Naturally rewatchable content no longer penalized.
  - *Series completion suppression*: Detects completed series when `watchedEpisodes.size >= maxEpisode * 0.8` (80% coverage for non-contiguous numbering) and `maxEpisode >= MIN_SERIES_WATCHES`. Suppresses series boost to 0 for completed series. Re-enables automatically when new episodes appear in RSS.
  - *Smooth new-subscription ramp*: Replaces binary 0.5 affinity floor (7 days) with exponential decay over 14 days: `0.1 + 0.4 * exp(-daysSinceSub / 7)`. Day 0→0.50, Day 7→0.25, Day 14→0.16, naturally merging with base affinity. Uses `getSubscriptionDates()` from `DatabaseAPI`.
  - *Per-channel upload cadence*: Replaces global `1/sqrt(videoCount)` with interval-based formula: `medianInterval / (timeSincePublish + medianInterval)`. Computed from RSS timestamps per channel. Infrequent posters (weekly) keep videos boosted ~7 days; prolific posters (daily) decay within ~1 day. Falls back to sqrt for channels with <2 videos.
  - *Session completion backfill*: Retroactively updates `explore_sessions.best_completion` from actual watch data after session start. Scans last 24h sessions with clicks > 0, finds max completion from `watchTimes` entries updated after session start. Fixes stale session quality feedback loop. Uses `getExploreSessionsForBackfill()` from `DatabaseAPI`.
  - *Quick-bounce penalty*: Clicks where user returns to Explore within 60s are tracked as bounces. Bounce click weight is reduced (`max(0.05, bounceSeconds/120)` vs 0.5 default). Channels with 3+ bounces get CTR multiplied by `0.85^bounceCount`. Client stores click info in sessionStorage, fires `POST /api/explore-events/bounce` on return. Uses `logExploreBounce()`/`getExploreBounces()` from `DatabaseAPI`. `bounce_seconds` column on `explore_events`.
  - *Repeat-recommendation fatigue (escalating)*: Per-video staleness penalty escalates from -0.03 to -0.09 based on impression count (`-0.03 * min(3, (imps-2)/3)`). Per-channel impression fatigue: channels with 10+ impressions and <5% click rate receive `-0.02 * min(2, imps/20)` penalty.
  - *Cross-session topic momentum*: 48-hour keyword momentum profile from meaningful watches, weighted by recency (24h half-life) and completion. Additive signal (weight 0.05). Videos watched 4h ago contribute ~85%, 24h ago ~37%, 48h ago ~14%.
  - *Content freshness urgency*: Per-channel median response delay computed from watch velocity data. Videos within 2× median delay of publish get a decaying urgency boost up to +0.06. Channels with fast typical response (2h) have a tight urgency window; slow channels (2d) have a wider window.
  - *Session duration budget*: Computes typical session duration from `explore_sessions` median `total_watch_seconds`. Near end of typical session (>70% through), penalizes long videos (>600s) up to -0.04, scaled by fatigue fraction and video duration. Session start decoded from `sessionId` query param. Client preserves session context via `?sid=` param.
  - *Return-visit channel boost*: Tracks when user watches a video and returns to Explore (vs leaving app). Channels with 2+ return events in 24h get +0.04 additive boost. Client fires `POST /api/explore-events/return` on Explore page load after click. Uses `logExploreReturn()`/`getExploreReturnChannels()` from `DatabaseAPI`. 'return' badge for explainability.
  - *Topic signal consolidation*: Seven topic signals (tagScore×0.12, titleSimilarity×0.07, tagSimilarity×0.06, descSimilarity×0.04, momentum×0.05, topicFilter±0.06, negKeyword×-0.03) are summed into a single `topicTotal`. Positive total capped at `TOPIC_CAP = 0.15` to prevent topic signals from outweighing affinity. Negative totals pass through uncapped.
  - *Cold start improvement*: When `meaningfulWatches.length === 0`, amplifies community signals to surface popular, well-rated, diverse content. Popularity weight 0.08 (vs 0.03), cap 0.12 (vs 0.06). Community rating weight 0.10 (vs 0.04), cap 0.08 (vs 0.04). Variety decay steepened to `[1.0, 0.4, 0.2, 0.1]` to force more channel diversity.
  - *Trending velocity*: `getRecentVideoPopularity(videoIds, withinHours)` counts distinct users who watched within the last N hours. Videos with 2+ recent watchers get `trendingBoost = min(0.08, log2(recentUsers) × 0.04)`. Detects videos gaining watches quickly vs all-time popularity. Uses `getRecentVideoPopularity()` from `DatabaseAPI`.
  - *Channel upload dormancy*: Channels with no RSS upload in 45+ days get linearly decaying affinity multiplier (to 0.6× floor at 165 days). Uses `channelPublishTimes` from RSS data — no new DB queries. Prevents dormant channels from occupying Explore slots.
  - *Score decomposition logging*: Structured JSON log line emitted per explore computation with aggregate signal averages (avgAffinity, avgRecency, avgTopicTotal, avgSession, avgTrending, topScore, bottomScore). Uses `lib/logger.ts`. Enables evaluation of signal quality and cold-start detection.
  - *Evaluation metrics*: `computeExploreMetrics()` in `youtube/explore-metrics.ts` computes score distribution (p25/p50/p75/stdDev), channel concentration (HHI), unique channel counts at top-10/30/60, reason badge distribution, and per-signal variance. Emitted as `explore-eval` structured log line. `tokenize()` and `STOP_WORDS` moved to explore-metrics.ts as shared utilities.
  - *Score normalization*: After scoring and before sorting, all scores are min-max normalized to [0, 1]. Ensures variety decay multiplier has consistent effect regardless of raw score magnitude. Skipped when all scores are identical (range = 0).
  - *Filter bubble prevention*: Two post-processing mechanisms: (1) Top-10 channel cap — max 2 videos per channel in positions 0–9, overflow demoted to positions 11+. (2) Concentration guard — logs a warning when top-3 channels occupy >50% of the 60-slot feed (HHI-based detection).
  - *Topic diversity*: Greedy MMR (Maximal Marginal Relevance) re-ranking of top 10 positions. Uses `ensureTopicDiversity()` from `explore-metrics.ts`. Picks highest-scored first, then iterates selecting `λ × score + (1-λ) × novelty` where novelty = min Jaccard distance to already-selected videos. λ = 0.7 (favor score, mild diversity). Falls back to channel-based clustering for titles with <3 tokens. Positions 11+ unchanged.
  - *Creator long-tail boost*: Channels with ≤2 cross-user subscribers and <10 total cross-user impressions get a +0.06 discovery boost. 2 dedicated "emerging creator" slots spliced at positions ~25 and ~45. Uses `getChannelImpressionCounts()` from `DatabaseAPI`. Reason badge: `emerging`. Single-user mode uses impression count alone.
  - *Signal weight configuration*: All 60+ numeric weights, thresholds, half-lives, and slot counts are defined in `ExploreConfig` interface with `DEFAULT_EXPLORE_CONFIG` defaults. Passed as optional third parameter to `getExploreVideos()`. Enables per-test weight injection and future A/B experiments. Keyword sets (`FAST_KEYWORDS`, `SLOW_KEYWORDS`, `EVERGREEN_KEYWORDS`) stay as module-level constants.
  - *Performance instrumentation*: 4 `performance.now()` checkpoints (cache-miss start, DB queries complete, scoring+normalization complete, post-processing complete) emit `explore-perf` structured log with `totalMs`, `dbMs`, `scoringMs`, `postMs`, `candidates`, `finalCount`.
  - *Explore cache upgrade*: `exploreVideos` cache upgraded from `LRUMap` to `SharedLRUMap(100, 'explore')` for Redis write-through across workers. L1 sync `get()` still works for hot path. Degrades to plain LRU in single-worker dev mode.
  - *Explore algorithm tests*: 12 unit tests in `tests/explore.test.mjs` covering empty state, result structure, affinity ranking, continue watching, mute/dismiss filtering, filter bubble cap, new subscription boost, cache identity, reason badges, config override, and score normalization. Uses real SQLite DB.
  - *Weight optimization*: `scripts/explore-optimize.ts` runs coordinate descent over ~20 core weights. Objective uses multiplicative combination (weighted geometric mean) matching YouTube's Zhao et al. 2019 architecture with 2025-aligned exponents: satisfaction^0.35 × completionRank^0.25 × qualityCtr^0.25 × session^0.15. Diversity excluded from scoring product (handled by post-processing: MMR, filter bubble caps, diversity injection). Perturbs ±20% of default, halves step on plateau. Outputs optimized config as TypeScript literal.
  - *Offline evaluation*: `scripts/explore-eval.ts` (`npm run eval:explore`) holds out recent watches per user, runs the algorithm on remaining data, and measures hit@10/30/60. Uses `runInSavepoint()` for safe rollback. Accepts user IDs as CLI args.
  - *Database savepoints*: `runInSavepoint<T>(fn: () => T)` added to `DatabaseAPI`. SQLite uses `SAVEPOINT`/`RELEASE`/`ROLLBACK TO`. PostgreSQL uses the same with `async`. Used by offline evaluation for safe data manipulation with rollback.
- **Floating promises**: All promises must be awaited, `.catch()`-ed, or explicitly marked with `void` if intentionally fire-and-forget. ESLint enforces `no-floating-promises` and `no-misused-promises`.
