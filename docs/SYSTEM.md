# SYSTEM — where things live

The canonical map of the Goobi extension. Update this when code moves.

> **Two products in one tree.** Goobi began as **Tab Butler** (a local-first tab
> manager) and pivoted to an **X/Twitter reply copilot** with a pet mascot. Both
> ship in the same MV3 extension. The X copilot is the central pillar today; the
> tab-manager code (grouping, idle-archive) is still wired in and runs. Internal
> identifiers, the `cli/`, and the package names still say "tab-butler" — see
> [CHANGELOG.md](../CHANGELOG.md) "Rename relics".

## Build · run · test

```bash
cd extension
npm install
npm run build        # node build.mjs (esbuild) → dist/   (load dist/ as an unpacked extension)
npm run typecheck    # tsc --noEmit   ← the type gate
for t in twttr policy hygiene pacing community momentum learn-stats supporters targets suggest-targets; do node scripts/test-$t.mjs; done   # pure-lib unit tests
node scripts/eval-post-ideas.mjs   # Post-ideas exemplar-quality + virality-band eval (Layer A; $0, no key)
# ANTHROPIC_API_KEY=sk-... node scripts/eval-post-ideas-live.mjs --live   # Layer B: live generate→Haiku-judge quality eval (opt-in, ~$0.20/run; no-op without --live)
```

- **Sources** are `.ts`/`.html` under `extension/src/{background,content,popup,lib}`.
  esbuild bundles them to `dist/{service-worker,x-copilot,popup}.js` + copies
  `popup.html`/`manifest.json`. The manifest references the **compiled** names — don't
  hunt for `x-copilot.js` in `src/`.
- `tsconfig` is `strict: true` but **not** `noUnusedLocals` — dead code compiles clean,
  so it must be found by reference search, not the type-checker.
- New host/extension permissions (e.g. `favicon`, `sidePanel`) require a full
  **remove + re-add** of the unpacked extension; a reload won't grant them.

## Surfaces

| Surface | Entry | Runs where |
|---|---|---|
| **X reply copilot** (the product) | `src/content/x-copilot.ts` → `dist/x-copilot.js` | content script on `x.com` / `twitter.com`, top frame only |
| **Service worker** (Claude + Twttr broker, tab features) | `src/background/service-worker.ts` | MV3 background, ES module |
| **Side panel** (settings, voice, products, account-safety, Goobi playground) | `src/popup/popup.ts` + `popup.html` | `chrome.sidePanel`, opens on the toolbar icon |
| **CLI** (separate product) | `cli/tab-butler.mjs` | terminal — `ls`/`kill`/`clean` for localhost dev servers. Not part of the extension. |

## The X-copilot data flow

```
scroll → MutationObserver → requestScan (rAF-coalesced) → scan()
  → collect article[data-testid="tweet"] (skip ads / own / no-text / dedup via seen + inFlight + dataset.tbx)
  → flush() batches ≤12 → SW {type: SCORE_POSTS} → Claude (Haiku) → {score, reason, category}
  → score ≥ 0.6 (THRESHOLD) → Opp (opps map + seen cache)
       → badge() the post in-feed ("NN% · Category", green "✓ Commented" once replied)
       → dock card, ranked live by effectiveScore = model × freshness × reach × pileup × community-tier
  → Draft → SW {type: DRAFT_REPLY} → Claude (Sonnet) → reply text
       → doInsert(): one-shot type into X's reply DraftJS box + like the post + log the reply
```

Everything that touches Claude or the Twttr (RapidAPI) provider crosses the
content-script → service-worker boundary via the `send()` wrapper — x.com's CSP
forbids fetching them from the page. **The copilot only ever drafts/inserts. It
never submits a reply, never posts.**

## File map

### `src/content/x-copilot.ts` — the on-page copilot (the big one, ~2k lines)
One injected script. Sections, by responsibility:
- **scan → score → badge** — `scan` / `requestScan` / `scheduleFlush` / `flush`; per-session caps (`MAX_SCORE_CALLS`, `THRESHOLD`).
- **X DOM extraction** — `statusInfo`, `outerText`/`quotedText` (quote-tweet-resilient), `displayName`, `isVerified`, `avatarUrl`, `engagement`/`snapStats`.
- **in-feed badge** — `badge` (`catId`/`catLabel`); the `✦ score · tag` pill that flips to green `✓ Commented` via `commentedIds`.
- **draft panel + steering** — `draftFor`, `paintPanel`, `angleRow`, `productRow`, `doInsert`, `insertReply`/`typeInto` (verified one-shot DraftJS insert).
- **dock** — `renderDock`, `renderList`, `topOpps`, `ensureDock`; launcher pill ↔ expanded panel, sort tabs, pace chip, kebab.
- **launcher avatar stack** — `launcherAvatars`, `lavInitial`.
- **Goobi driver** — `goobiMood`, `goobiStatus`, `goobiReact`/`goobiReactLove`, `refreshGoobi`, `touchGoobi` (maps dock signals → mascot moods).
- **in-dock playground** — `buildPlay`, `feedTreat`, `petGoobi`, `syncPlay`, `openPlay`/`closePlay`/`togglePlay`, `resetPlay`; `fedEver`/`fedTotal` persisted.
- **author-reach** — `maybeFetchReach`/`pumpReach` (Twttr `/user`), `reachFactor`, `reciprocityFactor`, `inReachSweetSpot`, `builderTierFor`, `effectiveScore`, `freshnessFactor`, `scoreVerdict`, `easyScore`.
- **storage / reply log** — `boot`, `ReplyLog`/`SentRecord`, `recordSentReply`, `recordReplyAndNudge`, `logSentReply`, `replyStreak`.
- **resilience** — `contextOK`/`teardown` + `invalidated` (extension-reload shutdown); `trapKeys` (stops X's single-key shortcuts hijacking our shadow-DOM inputs).
- **discovery + routing** — `findSpots` (niche search via Twttr), `urlPoll` (SPA navigation).

### `src/background/service-worker.ts` — broker
Routes messages (`SCORE_POSTS`, `DRAFT_REPLY`, `POST_IDEAS`, `POST_IDEA_REWRITE`, `TWTTR_GET`, `GET_FAVICONS`, `GET_TWTTR_METER`, voice/recall, tab ops). Holds the Twttr governor and the tab-manager features (idle-archive alarm, grouping).

### `src/lib/` — pure-ish modules
| File | Role | Test |
|---|---|---|
| `claude-client.ts` | All Claude calls: `scorePosts`, `draftReply` (+ `steer`), `generatePostIdeas`, `classify`, `advise`, `isSmartEnabled`. Models: Haiku (score/classify), Sonnet (draft/ideas). BYO-key direct; parked proxy path. | — |
| `prompts.ts` | System prompts + `REPLY_ANGLES` (the 6-value category enum, by convention). | — |
| `types.ts` | The message union + shared types. `XScore.category` is a bare `string` — the enum lives only in the prompt + the `catId` runtime guard. | — |
| `twttr.ts` | Parse RapidAPI (`twitter241`) responses: `parseUser`, `pickDiscoveryTweets`, `pickOwnPosts` (text, idea de-dupe), `pickOwnPostsWithStats` (keeps real `views`/engagement → the momentum views readout). | `test-twttr` |
| `twttr-governor.ts` | The only thing that calls the provider: budget meter + fetch wrapper. (v2: a storage-backed response cache — `FAIL_TTL` is reserved but unused.) | — |
| `twttr-policy.ts` | Pure budget/cap decisions (`TWTTR_BUDGET`). | `test-policy` |
| `reply-hygiene.ts` | Volume / repeat-author / duplicate-reply guards; `reputationStatus`. | `test-hygiene` |
| `momentum.ts` | Pure warm-up/**momentum** model: `computeMomentum` → 0–100 score + state (cold→peak, overheating) from today's replies/posts/streak/recency. Reads `reputationStatus`'s level so it can never celebrate past the ease-off line (Peak = healthy-only). Views are shown beside it, never scored. | `test-momentum` |
| `learn-stats.ts` | Pure **engagement learning loop** ("who you show up with"): `aggregateAccounts` (recency-weighted, Bayesian-shrunk, min-N gated per-account scores — Tier-1 investment + Tier-2 measured outcome), `rankAccounts`, `foldOwnDelta` (per-post view-growth trend), `matchOutcomes` (Tier-2 reply→engagement match-back), `concentration`/`cadenceTrend`. Honest by construction (no crowning, no causation/reach claims). x-copilot owns the daily-scan I/O + the dock panel. | `test-learn-stats` |
| `supporters.ts` | Pure **reciprocity engine** ("who shows up for you"): `aggregateSupporters` (scores reply+mention only — likes/reposts are lossy chips), `rankSupporters`, `fuseMutual` (cohort-invariant mutual/fan/one-way labels, fused with learn-stats' invest), `reciprocalConcentration` (anti-pod ring detector), `cadence`. x-copilot harvests the events from the **notifications-page DOM** (`scanNotifications`, zero API) + owns the dock panel. | `test-supporters` |
| `suggest-targets.ts` | Pure **auto-suggest ranking** for the Targets mode: `suggestionScore` (multiplicative, each factor tied to a real X-ranker mechanism — sweet-spot reach, follow-graph openness, niche overlap, predicted engagement-rate, our own measured outcome; missing signals neutral 1.0), `rankSuggestions`, `suggestionReason` (honest, banded, "two-way account" not "replies to people"). x-copilot builds candidates from the free `authorReach` cache. | `test-suggest-targets` |
| `targets.ts` | Pure **"Target accounts" logic** (comment early on big in-reach niche accounts): `excludeFromTargets`/`inReachBand`/`reachMultipleLabel` (the ~2–12× sweet-spot + hard mega-exclusion), `addTarget`/`removeTarget` (cap/dedupe), `freshnessLabel` (the early-comment window), `selectPollBatch` (the ≤5/open + TTL budget invariant for the deferred ambient poller). x-copilot owns the dock mode + the (user-initiated, governed) fetches; tracking reuses `learn-stats`. | `test-targets` |
| `idea-quality.ts` | Pure **Post-ideas exemplar quality + honest virality**: `isEnglish`/`looksLikeRT`/`isBait` (drop poison exemplars), `classifyShape` (diversity), `scoreWinner`/`percentile` (genuine-breakout ranking), `ideaTokens`/`jaccard` (de-dupe), `bandFor` (virality band anchored to the source's real measured rank — never a fabricated number). x-copilot's `pickBest` orchestrates these. | `eval-post-ideas` |
| `human-pacing.ts` | Human-like delays/jitter for likes/follows. | `test-pacing` |
| `community.ts` | `builderTier` — surface peer/community builders even off-topic. | `test-community` |
| `heuristics.ts` | **Tab manager**: group-by-domain, idle-archivable, `normalizeUrl` dedupe. | — |
| `archive.ts` | **Tab manager**: archive-not-delete + undo. | — |
| `config.ts` | The storage-key registry (`CONFIG`). Tab keys + X keys. | — |
| `goobi.ts` | The pixel-mascot **renderer**: `mountGoobi(host, opts) → {el, setMood, trick, destroy}`. Moods/animations. CSS lives in the host surfaces, not here. See [goobi.md](goobi.md). | — |

### `src/popup/` — side panel
`popup.ts` + `popup.html`: BYO-key + smart toggle, voice capture (`/user-replies` learning), products, niche, account-safety panel, follower count, the tab list, and the **side-panel Goobi playground** (its own copy, distinct from the dock's).

## Storage keys (`CONFIG`)
Two domains. **Tab**: `SCAN_ALARM`, archive/group keys. **X copilot**: `X_COPILOT_KEY` (on/off), `X_VOICE_KEY`, `X_PRODUCTS_KEY` (+ legacy `X_PRODUCT_KEY`), `X_NICHE_KEY`, `X_DEFAULT_ANGLE_KEY`/`X_DEFAULT_PRODUCT_KEY`, `X_MY_FOLLOWERS_KEY`, `X_PAUSED_KEY`, `X_REPLY_LOG_KEY`, `X_IDEAS_KEY`, `X_MY_POSTS_KEY` (own-posts cache: idea de-dupe + momentum views), `X_LEARN_STATS_KEY` (engagement learning loop: own-post trend + scan gates), `X_SUPPORTERS_KEY` (reciprocity: who engages with me, harvested from the notifications DOM), `X_TARGETS_KEY` ("Target accounts" list: big in-reach accounts to comment on early), `X_GOOBI_SEEN_KEY`, `X_GOOBI_FED_KEY`, `TWTTR_KEY_KEY`. Dev `.env`/key entry is BYO — keys live in `chrome.storage`/the SW, never bundled or put on-page.

## Conventions & gotchas
- **Closed shadow roots.** The dock and draft panel mount on hosts appended to
  `documentElement` with `{mode: "closed"}`. CSS is injected per-surface
  (`DOCK_CSS` in x-copilot, `<style>` in popup.html) — a Goobi animation class must
  exist in **both** if both surfaces use it.
- **`trapKeys`** stops key events leaking to X's document-level shortcut handler —
  required for any input we add (else typing loses focus).
- **Context invalidation.** Reloading the unpacked extension orphans the old content
  script; `teardown()` + the `invalidated` flag shut it down cleanly. Gate any new
  recurring loop/observer on `contextOK()`.
- **Draft-only, BYO-key, no auto-post** are product invariants — don't break them.
