# X-data API + budget governor

> Goobi's read-only enrichment pipe: a single BYO-RapidAPI chokepoint (profiles, search, timelines) wrapped in a durable monthly byte-budget meter, an 8/sec token bucket, intent-aware degradation, and in-flight coalescing.

**Surface:** Ambient on x.com — it runs entirely inside the Goobi content-script dock (`src/content/x-copilot.ts`) on x.com pages, brokered through the extension service worker. The only user-visible knobs are the BYO RapidAPI key field and the "This month: X MB / 10 GB · N / 100k requests" readout in the extension popup (`src/popup/popup.ts`). There is no dedicated screen — the data quietly feeds reply-spot ranking, the ideas tab, the momentum strip, and the daily learning pass.

## What it does for the user

Goobi enriches what it can see on the page with real X data the DOM doesn't expose: author follower/following counts (to rank reply targets by reach), fresh niche posts to remix into post ideas, the user's own recent posts and their real view counts, and the real engagement their past replies earned. Because every call costs RapidAPI bandwidth against a hard monthly cap, the governor meters usage and throttles the expensive lookups first as the budget fills — so cheap author-reach lookups keep flowing all month and the dock never silently goes dark mid-month. The user mostly never thinks about it; they just see ranked spots, idea candidates, and a "views today" stat.

## How the user uses it

1. In the extension popup, the user pastes their **BYO RapidAPI key** (subscribed to the `twitter241` provider) and optionally sets their handle/niche. The key is stored in `chrome.storage.local` under `twttrKey`; the host is fixed and not user-set.
2. They open x.com and click the Goobi launcher to open the dock. This fires `refreshOwnStats()` then the once-daily learn pass, and seeds author-reach lookups as reply spots scroll into view.
3. As they browse, reply spots get ranked by real follower reach (fetched ambiently in the background — no user action).
4. In the **Ideas** tab they hit generate; Goobi runs a niche search to gather fresh posts to remix.
5. In the **DMs** tab, adding a person may refresh their public profile; **Refresh public context** uses a deliberate `from:<handle>` search, capped at two people per session. Candidate ranking itself is local and spends zero calls.
6. If the budget is nearly spent, instead of results they see a toast like "Monthly X-data budget nearly used — Find spots is paused. It resets on the 1st." Ambient reach lookups just quietly stop; cheap ones keep working.
7. They can check usage anytime in the popup: "This month: 142 MB / 10 GB · 1,240 / 100k requests."

## How it works

The pipeline is content-script consumer → SW router → governor → one HTTP call → parser, with all budget state in the worker so it survives navigation and is shared across every x.com tab.

**Trigger / send path.** The content script never calls `fetch` directly. It posts `{ type: "TWTTR_GET", path, query, intent }` via `send()` (`x-copilot.ts:132`, a thin `chrome.runtime.sendMessage` wrapper that swallows context-invalidation). The SW's `onMessage` handler routes `TWTTR_GET` → `twttrFetch()` (`service-worker.ts:218`), which reads the BYO key from `chrome.storage.local` (`CONFIG.TWTTR_KEY_KEY`), returns `{ ok:false, error:"no-twttr-config" }` if absent, and otherwise calls `governedFetch(CONFIG.TWTTR_HOST, key, path, query, intent)`. Host is fixed: `twitter241.p.rapidapi.com`.

Before reading the key or making a request, `allowedTwttrPath()` rejects anything except the three repository-proven endpoints: `user`, `search-v3`, and `user-replies-v2`. Expanding the provider surface requires a captured fixture, parser, cost-policy test, and live verification; the service worker is not an arbitrary RapidAPI endpoint proxy.

**Governor (`twttr-governor.ts:governedFetch`).** Per call:
1. `classForPath(path)` (`twttr-policy.ts:46`) maps the path to a cost class (`user`/`tweet`/`comments`/`search`/`timeline`/`followers`/`other`); class → `tier` (cheap/med/expensive) via the `TWTTR_CLASS` table.
2. **Coalescing:** a keyed `inflight` map (`cls|url|intent`) returns the existing promise for an identical concurrent request.
3. **Budget gate:** `loadMeter()` reads the persisted `twttrMeter` from `chrome.storage.local`; `usedFrac = max(bytes/BYTES, requests/REQUESTS)`; `degradeMode(usedFrac)` → normal/conserve/frozen/lockdown at the 0.70/0.85/0.95 thresholds; `canFetch(tier, mode, intent)` decides. If blocked it returns `{ ok:false, status:0, error:"budget-<mode>" }` with **no network spent**.
4. **Token bucket:** `takeToken()` — in-memory, refills at `RATE_PER_SEC = 8` (under the 10/sec hard limit), starts at 1 so a cold-start flood can't burst.
5. **HTTP:** one `fetch` with `x-rapidapi-key` + `x-rapidapi-host` headers.
6. **Meter:** `bumpMeter()` adds `Content-Length` (or text length) bytes and +1 request through a serialized `meterChain` (try/caught so a failed write never poisons the chain). Returns parsed JSON or `{ ok:false, error:"bad-json" }`.

**Budget policy constants (`TWTTR_BUDGET`):** `BYTES = 8 GB` working budget (10 GB hard cap, 2 GB margin), `REQUESTS = 80_000` (80% of the 100k/mo wall), thresholds CONSERVE 0.70 / FROZEN 0.85 / LOCKDOWN 0.95, `RATE_PER_SEC = 8`. `canFetch`: lockdown → nothing (cache only); frozen → cheap only; conserve → block expensive **unless** `intent`; normal → all. The meter rolls on UTC month change (`monthKeyOf`).

**Bandwidth is the binding limit, not request count.** `/user` ≈10 KB (cheap) vs `search`/`timeline`/`followers` ≈300–410 KB (expensive, 30–40×). So expensive classes are the rationed lever and `/user` keeps flowing until lockdown, keeping on-page reach ranking alive.

**Consumers / data flow:**
- **Author reach (ambient):** `maybeFetchReach()` / `pumpReach()` (`x-copilot.ts:1452`) queue deduped `path:"user"` lookups (no `intent` → throttled first), cap `REACH_CAP=80`/session, `REACH_CONCURRENCY=4`, `REACH_FAIL_TTL=600_000`. `parseUser()` flattens followers/following/bio into the `authorReach` map, feeding `reachFactor`/`reciprocityFactor`/`inReachSweetSpot`/`builderTierFor` for spot ranking. On a `budget-` error it marks `failed`, frees the cap slot (`reachLookups--`), and backs off.
- **Find spots / ideas (intent):** `generateIdeas()` (`x-copilot.ts:2457`) and Find-spots run `path:"search-v3"` with `intent:true` using `from:`/`lang:en`/`-filter:replies` operators; `parseTimelineTweets` → `pickBest`. Budget errors surface the "paused, resets on the 1st" message.
- **Opportunity velocity (no added calls):** selected original Find-Spots results and target-account posts contribute compact metric observations for their tweet IDs. Ideas, API health checks, heavy-hitter discovery, and own-post searches do not feed this ledger. Changed observations form short-lived view/engagement velocity; identical governor-cache hits are ignored. The store contains counts/timestamps only, prunes after 48h, caps at 300 tracks, and cross-tab merges keep the newest observation pair.
- **Own posts/stats:** `fetchOwnData()` (`x-copilot.ts:2105`) does one `from:<handle>` `search-v3` (intent) → `pickOwnPostsWithStats`, cached in `X_MY_POSTS_KEY` (text 24 h, stats 60 min) → powers `ownViewsToday`.
- **Post Idea attribution:** that same cached own-post result feeds `idea-outcomes.ts`. Unique normalized-exact matches attach a real tweet id and metrics to the recent idea history; no fuzzy match and no additional provider call.
- **Reply verification + thread completion + learn / measure pass:** `runMeasurePass()` resolves rest_id via `path:"user"` then pulls `path:"user-replies-v2"` (intent), matches actual X replies back to manually confirmed handoff records, marks them RapidAPI-verified, and writes views/likes/replies/reposts. The same payload's direct-parent tweet IDs clear exactly answered rows from Tend your threads. The normal analytics pass is daily; a newly confirmed reply gets one check after six minutes, with a 30-minute successful-no-match backoff on later dock opens. `refreshOwnStats` still runs first so the own-post paths don't double-bill.
- **Relationship memory:** the same direct-parent IDs join against device-local notification reply IDs. Proven completed exchanges persist as text-free, account-scoped history and can show an ongoing-connection context chip after two different active weeks; zero extra calls and no ranking lift.
- **DM workspace:** candidate ranking reuses that account-scoped relationship memory plus saved Targets with zero calls. Manual add explicitly reuses `/user`; an explicit public-context refresh reuses `search-v3 from:<handle>` and is capped at two people/session. The provider is not used to read or send native DMs.
- **`verifyApiAlive()`** (`x-copilot.ts:2449`): one cheap `search-v3 query:"the"` that MUST return results — distinguishes a genuinely quiet niche from a dead integration (wrong provider / renamed param / bumped endpoint version returning 200 + empty body).

**No Claude calls in this flow.** Claude (via `claude-client.ts`) runs in adjacent flows — scoring, drafting, idea writing — fed by this flow's parsed data, but the X-data pipe itself is pure RapidAPI.

**State persisted:** `chrome.storage.local` — `twttrMeter` (monthly byte/request meter), `twttrKey` (BYO key), bounded `twttrCache` entries for non-`user` successes, `X_MY_POSTS_KEY` (own-posts cache), `X_LEARN_STATS_KEY`, and `X_REPLY_LOG_KEY`. The token bucket and in-flight map are memory-only; author reach has its own bounded public-data persistence cache.

## What is honest about it / limits

- **MEASURED (real X data):** follower/following counts, niche-post text + engagement, the user's own post views/likes, and past-reply engagement — all parsed from the provider response, not guessed.
- **PROXY / INFERRED:** `reciprocityFactor` infers reply-back propensity from the following/followers ratio (not actual reply behavior); `reachFactor` falls back to the on-page likes proxy when follower count is unknown; `following:` is deliberately left **undefined** when absent so reciprocity stays neutral rather than faking a broadcaster-0 (`twttr.ts:91`). `builderTierFor` returns 0 until a profile is actually fetched, so it only ever lifts authors known to be peers.
- **Deliberately does NOT:** write anything to X (read-only enrichment — no posting, liking, following, or DM actions via this API); exceed budget — a `budget-*` block spends zero network and degrades gracefully rather than erroring loudly.
- **Honesty guards:** `verifyApiAlive` prevents reporting "quiet niche" when the integration is actually dead; a config/budget error returns `true` (treated as already-surfaced, not a dead shape). The popup shows raw measured usage against the **10 GB / 100k** real provider ceilings (not the internal 8 GB / 80k soft budget), so the user sees honest headroom.

## Key files

- `src/lib/twttr.ts` — shape-tolerant parsers (`parseUser`, `parseTimelineTweets`, `pickDiscoveryTweets`, `pickVoiceSamples`, `pickOwnPosts(WithStats)`, `buildVoiceProfile`); `TwttrUser`/`TwttrTweet` shapes; handles both new GraphQL and legacy JSON. Zero imports (unit-testable in isolation).
- `src/lib/twttr-policy.ts` — pure cost policy: `TWTTR_CLASS` size/TTL/tier table, `TWTTR_BUDGET`, `classForPath`, `degradeMode`, `canFetch`, `monthKeyOf`.
- `src/lib/twttr-governor.ts` — the IO orchestration: `governedFetch`, the persisted `twttrMeter` (`bumpMeter`/`loadMeter`/`readMeter`), token bucket, coalescing.
- `src/background/service-worker.ts` — `TWTTR_GET` / `GET_TWTTR_METER` routing; `twttrFetch` reads the BYO key + fixed host.
- `src/content/x-copilot.ts` — all consumers: `send()`, `authorReach`/`maybeFetchReach`/`pumpReach`, `fetchOwnData`/`refreshOwnStats`, `runMeasurePass`/`maybeRunDailyLearn`, `generateIdeas`, `verifyApiAlive`.
- `src/lib/config.ts` — `TWTTR_HOST = "twitter241.p.rapidapi.com"` (fixed), `TWTTR_KEY_KEY = "twttrKey"`.
- `src/popup/popup.ts` — the month-to-date meter readout (`fmtData`, "X / 10 GB · N / 100k requests").
- `scripts/test-policy.mjs`, `scripts/test-twttr.mjs` — unit tests for the policy decisions and parsers.

## Before you change it

- **The parsers are coupled to the `twitter241` provider's two JSON shapes** (new GraphQL: `core.user_results.result.core` + `details.full_text` + `counts.*`; legacy: `legacy.*`). Both `parseUser` and `flattenTweet` read both with recursive node-finding fallbacks. A provider/host swap or endpoint-version bump breaks parsing silently (200 + `[]`); that's exactly what `verifyApiAlive` exists to catch. The host is intentionally non-configurable.
- **`classForPath` order is load-bearing:** the specific `user-tweets`/`user-replies`/`user-media` → timeline and `user-followers`/`user-following` → followers prefixes are checked **before** the bare `user` prefix. Adding a path that starts with `user` without ordering it correctly will misclassify it as cheap and bypass budget gating.
- **`policy` and `twttr` are unit-tested** (`scripts/test-policy.mjs`, `scripts/test-twttr.mjs`); both files are intentionally dependency-free so the decision logic and parsers test in isolation. **`twttr-governor.ts` has NO unit test** (it touches `chrome.storage` + `fetch`); the meter-chain, token-bucket, and coalescing behavior are unverified by tests — change with care.
- **Audit caveat — compressed-vs-raw billing:** the meter charges `Content-Length` (or response text length), i.e. what crosses the wire. If the provider bills on raw/uncompressed payload, the meter under-counts and the real provider wall could arrive before the 8 GB soft budget trips. The 8 GB-of-10 GB margin is the cushion, not a guarantee.
- **`intent` is the keystone of graceful degradation.** Ambient lookups (author reach) must stay `intent:false` so they're throttled first in conserve mode; user-initiated actions (Find spots, ideas, own-posts, the learn pass) pass `intent:true` to outlive budget pressure. Flipping a call's `intent` flag changes who goes dark first under pressure.
- **Meter writes are serialized through `meterChain` and try/caught on purpose** — a thrown write would poison every later increment and make `await bumpMeter` reject on the success path. Don't "simplify" that away.
- **The token bucket and `authorReach`/`inflight` maps reset on SW restart** by design (burst guard, not durable state). Only the monthly meter is persisted. Don't move durable budget state out of the worker — it must survive navigation and be shared across tabs.
- **Persistent response cache.** Non-`user` successes are cached by URL under the cost class TTL and bounded to 4 MB; `/user` stays out because the content script already persists its smaller public author-reach projection. A fresh hit is served before budget/rate gates and spends zero provider usage.
