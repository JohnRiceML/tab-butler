# X-data API + budget governor

> Goobi's read-only enrichment pipe: a single BYO-RapidAPI chokepoint (profiles, search, timelines) wrapped in a local safety meter, observed provider quota/rate headers, an 8/sec smoothing bucket, intent-aware degradation, timeout/circuit protection, caching, and in-flight coalescing.

**Surface:** Ambient on x.com — it runs entirely inside the Goobi content-script dock (`src/content/x-copilot.ts`) on x.com pages, brokered through the extension service worker. The popup shows the local UTC-month transfer/call estimate plus the latest plan-specific request quota observed from RapidAPI response headers. RapidAPI's dashboard and billing cycle remain authoritative. There is no dedicated screen — the data quietly feeds reply-spot ranking, Fresh Reach, ideas, momentum, and learning.

## What it does for the user

Goobi enriches what it can see on the page with real X data the DOM doesn't expose: author follower/following counts, fresh niche and account-specific posts, the user's own recent posts and real view counts, and the engagement their past replies earned. RapidAPI plan quotas are subscription-specific and may allow overages; the platform also meters bandwidth by billing cycle. The governor therefore combines a conservative local fallback envelope with provider-reported remaining quota, throttles larger lookups first, caches repeat reads, and fails visibly on credential/subscription problems.

## How the user uses it

1. In the extension popup, the user pastes their **BYO RapidAPI key** (subscribed to the `twitter241` provider) and optionally sets their handle/niche. The key is stored in `chrome.storage.local` under `twttrKey`; the host is fixed and not user-set.
2. They open x.com and click the Goobi launcher to open the dock. This fires `refreshOwnStats()` then the once-daily learn pass, and seeds author-reach lookups as reply spots scroll into view.
3. As they browse, reply spots get ranked by real follower reach (fetched ambiently in the background — no user action).
4. In the **Ideas** tab they hit generate; Goobi runs a niche search to gather fresh posts to remix.
5. In the **DMs** tab, adding a person may refresh their public profile; **Refresh public context** uses a deliberate `from:<handle>` search, capped at two people per session. Candidate ranking itself is local and spends zero calls.
6. If the local safety envelope or provider-reported quota is nearly spent, the affected action pauses and tells the user to check RapidAPI for the billing-cycle reset. Authentication, subscription, and rate-limit failures open a provider-wide backoff circuit so a multi-call scan does not cascade failures.
7. They can check usage anytime in the popup: local UTC-month transfer/calls, plus provider remaining/limit when RapidAPI supplied those headers. The dashboard is explicitly labeled authoritative.

## How it works

The pipeline is content-script consumer → SW router → governor → one HTTP call → parser, with all budget state in the worker so it survives navigation and is shared across every x.com tab.

**Trigger / send path.** The content script never calls `fetch` directly. It posts `{ type: "TWTTR_GET", path, query, intent }` via `send()` (`x-copilot.ts:132`, a thin `chrome.runtime.sendMessage` wrapper that swallows context-invalidation). The SW's `onMessage` handler routes `TWTTR_GET` → `twttrFetch()` (`service-worker.ts:218`), which reads the BYO key from `chrome.storage.local` (`CONFIG.TWTTR_KEY_KEY`), returns `{ ok:false, error:"no-twttr-config" }` if absent, and otherwise calls `governedFetch(CONFIG.TWTTR_HOST, key, path, query, intent)`. Host is fixed: `twitter241.p.rapidapi.com`.

Before reading the key or making a request, `allowedTwttrPath()` rejects anything except the three repository-proven endpoints: `user`, `search-v3`, and `user-replies-v2`. Expanding the provider surface requires a captured fixture, parser, cost-policy test, and live verification; the service worker is not an arbitrary RapidAPI endpoint proxy.

**Governor (`twttr-governor.ts:governedFetch`).** Per call:
1. `classForPath(path)` (`twttr-policy.ts:46`) maps the path to a cost class (`user`/`tweet`/`comments`/`search`/`timeline`/`followers`/`other`); class → `tier` (cheap/med/expensive) via the `TWTTR_CLASS` table.
2. **Coalescing:** a keyed `inflight` map (`cls|url|intent`) returns the existing promise for an identical concurrent request.
3. **Budget gate:** `loadMeter()` reads the persisted `twttrMeter`; `usedFrac` is the maximum of the local transfer fraction, local fallback request fraction, and a fresh provider plan fraction derived from `x-ratelimit-requests-limit/remaining`. Because plan quotas may be daily or monthly and the headers expose no universal billing reset, that observation expires after six hours so one later request can re-probe rather than leaving Goobi permanently locked. `degradeMode` → normal/conserve/frozen/lockdown at 0.70/0.85/0.95. A block spends no network.
4. **Provider circuit:** a recent 401/402/403 blocks that credential for 10 minutes, a 429 honors `Retry-After`/`x-ratelimit-reset`, a 5xx backs off for 30 seconds, and a successful response reporting zero rate-window remaining waits for its reset. Changing the key clears the circuit.
5. **Token bucket:** `takeToken()` is an in-memory local smoothing ceiling at `RATE_PER_SEC = 9`, one below the owner's stated 10/sec plan and starting at 1 so a cold-start flood cannot burst. Provider response headers can impose a tighter window.
6. **HTTP:** one `fetch` with the fixed host and a 15-second abort timeout. The manifest permission is narrowed to `https://twitter241.p.rapidapi.com/*`.
7. **Meter + headers:** `bumpMeter()` adds transfer/call estimates and persists provider request/rate limit, remaining, reset, and observation time from every response. Returns parsed JSON or an explicit failure.

**Budget policy constants (`TWTTR_BUDGET`):** `BYTES = 8 GB` and `REQUESTS = 90_000` are conservative local UTC-month fallbacks, leaving headroom below the owner's stated 100k plan rather than claiming a universal RapidAPI tier. Provider quota headers join the gate whenever available. Thresholds remain CONSERVE 0.70 / FROZEN 0.85 / LOCKDOWN 0.95. Ambient expensive work stops first; explicit user actions survive through frozen and stop at lockdown. RapidAPI's dashboard/billing cycle is the source of truth; the platform includes 10 GB per billing cycle before bandwidth fees rather than presenting 10 GB as a hard cap.

**Response size still matters locally.** Repository estimates put `/user` far below search/timeline payloads, so expensive classes remain the first rationed lever. Those estimates are scheduling priors, not provider billing guarantees.

**Consumers / data flow:**
- **Author reach (ambient):** `maybeFetchReach()` / `pumpReach()` (`x-copilot.ts:1452`) queue deduped `path:"user"` lookups (no `intent` → throttled first), cap `REACH_CAP=80`/session, `REACH_CONCURRENCY=4`, `REACH_FAIL_TTL=600_000`. `parseUser()` flattens followers/following/bio into the `authorReach` map, feeding `reachFactor`/`reciprocityFactor`/`inReachSweetSpot`/`builderTierFor` for spot ranking. On a `budget-` error it marks `failed`, frees the cap slot (`reachLookups--`), and backs off.
- **Find spots / ideas / Fresh Reach (intent):** explicit actions use `search-v3` with `intent:true`. Fresh Reach uses niche Latest, three Top account-discovery lenses, and up to 24 cached/direct account checks (28 X-data calls on a fully cold hunt); exact query flights coalesce without allowing an unrelated auto query to swallow a manual scan. Receipts distinguish live provider calls from cache hits and raw originals from live-gate survivors. A query-specific Latest failure may use the saved radar, while provider-wide credential/subscription/rate/timeout/outage failures stop later direct batches without poisoning individual account backoffs. Budget errors point to the provider billing-cycle dashboard.
- **Opportunity velocity (no added calls):** selected original Find-Spots results and target-account posts contribute compact metric observations for their tweet IDs. Ideas, API health checks, heavy-hitter discovery, and own-post searches do not feed this ledger. Changed observations form short-lived view/engagement velocity; identical governor-cache hits are ignored. The store contains counts/timestamps only, prunes after 48h, caps at 300 tracks, and cross-tab merges keep the newest observation pair.
- **Own posts/stats:** `fetchOwnData()` (`x-copilot.ts:2105`) does one `from:<handle>` `search-v3` (intent) → `pickOwnPostsWithStats`, cached in `X_MY_POSTS_KEY` (text 24 h, stats 60 min) → powers `ownViewsToday`.
- **Post Idea attribution:** that same cached own-post result feeds `idea-outcomes.ts`. Unique normalized-exact matches attach a real tweet id and metrics to the recent idea history; no fuzzy match and no additional provider call.
- **Reply verification + thread completion + learn / measure pass:** `runMeasurePass()` resolves rest_id via `path:"user"` then asks `user-replies-v2` for up to 80 recent replies. It matches actual X replies back to handoff/manual records, marks them RapidAPI-verified, and writes only metrics actually present—missing counts stay unknown instead of becoming zero. Every text-bearing newly recorded reply schedules a first check after six minutes; a successful no-match backs off 30 minutes, a provisional proven outcome refreshes on a 12-hour cadence until the two-day settlement point, and frozen outcomes stop. The same payload clears exact completed threads and can promote settled, view-bearing massive-account Fresh Reach replies into the max-10 keep-list without another endpoint.
- **Relationship memory:** the same direct-parent IDs join against device-local notification reply IDs. Proven completed exchanges persist as text-free, account-scoped history and can show an ongoing-connection context chip after two different active weeks; zero extra calls and no ranking lift.
- **DM workspace:** candidate ranking reuses that account-scoped relationship memory plus saved Targets with zero calls. Manual add explicitly reuses `/user`; an explicit public-context refresh reuses `search-v3 from:<handle>` and is capped at two people/session. The provider is not used to read or send native DMs.
- **`verifyApiAlive()`** (`x-copilot.ts:2449`): one cheap `search-v3 query:"the"` that MUST return results — distinguishes a genuinely quiet niche from a dead integration (wrong provider / renamed param / bumped endpoint version returning 200 + empty body).

**No Claude calls in this flow.** Claude (via `claude-client.ts`) runs in adjacent flows — scoring, drafting, idea writing — fed by this flow's parsed data, but the X-data pipe itself is pure RapidAPI.

**State persisted:** `chrome.storage.local` — `twttrMeter` (local UTC-month estimates plus latest provider headers), `twttrKey`, a 6 MB bounded cache for non-`user` successes, own-post/learning/reply state, and bounded public author/radar projections. Token buckets, provider circuits, and in-flight maps are memory-only.

## What is honest about it / limits

- **MEASURED (real X data):** follower/following counts, niche-post text + engagement, the user's own post views/likes, and past-reply engagement — all parsed from the provider response, not guessed.
- **PROXY / INFERRED:** `reciprocityFactor` infers reply-back propensity from the following/followers ratio (not actual reply behavior); `reachFactor` falls back to the on-page likes proxy when follower count is unknown; `following:` is deliberately left **undefined** when absent so reciprocity stays neutral rather than faking a broadcaster-0 (`twttr.ts:91`). `builderTierFor` returns 0 until a profile is actually fetched, so it only ever lifts authors known to be peers.
- **Deliberately does NOT:** write anything to X (read-only enrichment — no posting, liking, following, or DM actions via this API); exceed budget — a `budget-*` block spends zero network and degrades gracefully rather than erroring loudly.
- **Honesty guards:** `verifyApiAlive` prevents reporting "quiet niche" when the integration is actually dead. The popup never invents a universal request quota: it shows local estimates, provider plan headers when observed, and names the RapidAPI dashboard as authoritative.

## Key files

- `src/lib/twttr.ts` — shape-tolerant parsers (`parseUser`, `parseTimelineTweets`, `pickDiscoveryTweets`, `pickVoiceSamples`, `pickOwnPosts(WithStats)`, `buildVoiceProfile`); `TwttrUser`/`TwttrTweet` shapes; handles both new GraphQL and legacy JSON. Zero imports (unit-testable in isolation).
- `src/lib/twttr-policy.ts` — pure cost/cache/provider-reset policy: class table, local fallback envelope, provider-usage math, cache pruning, and allowed paths.
- `src/lib/twttr-governor.ts` — IO orchestration: provider headers/circuit, 15-second timeout, meter, token bucket, 6 MB cache, and coalescing.
- `src/background/service-worker.ts` — `TWTTR_GET` / `GET_TWTTR_METER` routing; `twttrFetch` reads the BYO key + fixed host.
- `src/content/x-copilot.ts` — all consumers: `send()`, `authorReach`/`maybeFetchReach`/`pumpReach`, `fetchOwnData`/`refreshOwnStats`, `runMeasurePass`/`maybeRunDailyLearn`, `generateIdeas`, `verifyApiAlive`.
- `src/lib/config.ts` — `TWTTR_HOST = "twitter241.p.rapidapi.com"` (fixed), `TWTTR_KEY_KEY = "twttrKey"`.
- `src/popup/popup.ts` — local meter plus latest provider-plan quota readout and billing-cycle disclosure.
- `scripts/test-policy.mjs`, `scripts/test-twttr.mjs` — unit tests for the policy decisions and parsers.

## Before you change it

- **The parsers are coupled to the `twitter241` provider's two JSON shapes** (new GraphQL: `core.user_results.result.core` + `details.full_text` + `counts.*`; legacy: `legacy.*`). Both `parseUser` and `flattenTweet` read both with recursive node-finding fallbacks. A provider/host swap or endpoint-version bump breaks parsing silently (200 + `[]`); that's exactly what `verifyApiAlive` exists to catch. The host is intentionally non-configurable.
- **`classForPath` order is load-bearing:** the specific `user-tweets`/`user-replies`/`user-media` → timeline and `user-followers`/`user-following` → followers prefixes are checked **before** the bare `user` prefix. Adding a path that starts with `user` without ordering it correctly will misclassify it as cheap and bypass budget gating.
- **`policy` and `twttr` are unit-tested** (`scripts/test-policy.mjs`, `scripts/test-twttr.mjs`); provider response/circuit orchestration still touches `chrome.storage` + `fetch`, so the opt-in live harness is required before treating provider behavior as proven.
- **Local meter caveat:** `Content-Length` (or response text length) is a safety estimate, not a bill. Compression, billing-cycle boundaries, plan quotas, and overage behavior belong to RapidAPI; trust its dashboard.
- **`intent` is the keystone of graceful degradation.** Ambient lookups (author reach) must stay `intent:false` so they're throttled first in conserve mode; user-initiated actions (Find spots, ideas, own-posts, the learn pass) pass `intent:true` to outlive budget pressure. Flipping a call's `intent` flag changes who goes dark first under pressure.
- **Meter writes are serialized through `meterChain` and try/caught on purpose** — a thrown write would poison every later increment and make `await bumpMeter` reject on the success path. Don't "simplify" that away.
- **The token bucket, provider circuit, and in-flight maps reset on SW restart** by design. The local/provider-observation meter persists and is shared across tabs.
- **Persistent response cache.** Non-`user` successes are cached by URL under the cost class TTL and bounded to 6 MB; `/user` stays out because the content script already persists its smaller public author-reach projection. A fresh hit is served before budget/rate gates and spends zero provider usage.
- **Live status:** the harness preflights `/user` once and stops on 401/403/429 before running the expensive matrix. A 403 “not subscribed” is a subscription blocker, not evidence that the parsers or search strategy work.
