# SYSTEM — where things live

The canonical map of the Goobi extension. Update this when code moves.

> **Want to know how a FEATURE works (not just where it lives)?** → the **[flow docs center](flows/README.md)**. For the standing x-algorithm intelligence watch (the open-sourced ranker repo + the drop checklist), see **[INTEL.md](INTEL.md)**. One doc per user-facing flow (reply spots, post ideas, targets, momentum, the learning + reciprocity panels, account safety, the X-data API, voice/profile, Goobi) — each is the end-to-end pipeline + the honesty limits + the gotchas. SYSTEM.md (this file) is the file map; `flows/` is the how-it-works map.

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
npm test                 # every zero-cost scripts/test-*.mjs suite
npm run verify           # typecheck + all tests + production build + dist validation
node scripts/eval-post-ideas.mjs   # Post-ideas exemplar-quality + virality-band eval (Layer A; $0, no key)
# ANTHROPIC_API_KEY=sk-... node scripts/eval-post-ideas-live.mjs --live   # Layer B: live generate→Haiku-judge quality eval (opt-in, ~$0.20/run; no-op without --live)
# ANTHROPIC_API_KEY=sk-... node scripts/eval-post-ideas-2pass.mjs --live   # Layer B: the reject-and-regenerate SECOND-PASS gate (pass-1 vs pass-2; ~$0.30/run)
# ANTHROPIC_API_KEY=sk-... node scripts/eval-draft-reply-live.mjs --live   # Layer B for the reply DRAFTER: bare-vs-enriched context delta, judge anchored to X's 0-3 reply grading (opt-in, ~$0.25/run)
# TWTTR_KEY=... node scripts/spike-poller-or.mjs --live --handles a,b,c   # one-off spike: does the provider honor batched OR-from: searches? (gates the ambient target poller; ~1.4MB)
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
  → flush() batches ≤12 → SW {type: SCORE_POSTS} → Claude (Haiku)
       → {score, reason, category, anchor, replyMove, replyBrief, risk}
  → score ≥ 0.6 (THRESHOLD) → Opp (opps map + seen cache)
       → badge() the post in-feed (growth lane pill → expandable evidence/actions; green "✓ Replied" once recorded)
       → dock card, ranked live across separate discovery / relationship / community lanes
         (reply count is a thread-room heuristic; displayed scores are not X probabilities)
  → Draft → SW {type: DRAFT_REPLY} → Claude (Sonnet) → reply text
       → runReplyDraftAction(): copy draft; never click Reply or touch X's composer
            ↳ off-page only: open/focus the exact status page, with no stored draft handoff
       → user clicks Reply, pastes, reviews, and submits in X; explicit confirmation records it
```

Everything that touches Claude or the Twttr (RapidAPI) provider crosses the
content-script → service-worker boundary via the `send()` wrapper — x.com's CSP
forbids fetching them from the page. **The copilot never likes on the user's behalf,
clicks Reply, fills X's reply composer, submits a reply, or posts.**

## File map

### `src/content/x-copilot.ts` — the on-page copilot (the big one, ~2k lines)
One injected script. Sections, by responsibility:
- **scan → score → badge** — `scan` / `requestScan` / `scheduleFlush` / `flush`; per-session caps (`MAX_SCORE_CALLS`, `THRESHOLD`).
- **X DOM extraction** — `statusInfo`, `outerText`/`quotedText` (quote-tweet-resilient), `displayName`, `isVerified`, `avatarUrl`, `engagement`/`snapStats`.
- **in-feed decision overlay** — `badge` / `addButton` (`catId`/`catLabel`); a compact growth-lane pill that expands into Why now, three decision signals, evidence confidence, cautions, and Draft/Open/Mark replied/Skip controls. A recent confirmed reply to the author lowers all three lanes and turns the pill amber with `↻ Replied X ago` before drafting. Passed posts explain the pass and support an explicit override. It flips to green `✓ Replied` via `commentedIds`.
- **draft panel + steering** — `draftFor`, `paintPanel`, `angleRow`, `replyStyleControl`, `productRow`, `runReplyDraftAction`, `handoffReply`; angle selects the substantive move while the accessible Community Spark component compresses it into a short, post-specific, conversation-opening delivery. Spark is on by default, and its explicit on/off preference is saved locally and shared across X tabs for future drafts. A request sequence prevents stale overlapping drafts from repainting the newest choice. The reply action is copy-only: visible posts smoothly scroll to the exact matched article and receive a temporary motion-safe accent outline, while off-page posts open/focus their exact status page. Goobi never clicks Reply, likes, or writes into X's composer. Explicit posted confirmation remains required.
- **dock** — `renderDock`, `renderList`, `topOpps`, `ensureDock`; launcher pill ↔ expanded panel, sort tabs, pace chip, kebab.
- **Comments workspace** — `buildComments`, `renderThreadsPanel`; a primary warm-conversation queue from recent notification replies/mentions. Targets remains a secondary Replies → Find people drill-in.
- **daily goals** — `dailyGoalTracker` + `daily-goals.ts`; an always-visible verified Replies / detected-or-marked Posts / unique manually marked DM-people scorecard with locally configurable, conservatively bounded targets.
- **SOUL.md** — `soul.ts` + the side-panel editor; a user-owned beliefs/themes/earned-experience/boundaries block injected into explicit reply and post generation, separate from learned voice and excluded from DMs.
- **Personal posting model** — `posting-analytics.ts` + the side-panel CSV receipt; parses X's account-content export locally, stores owner-scoped aggregates only, and supplies correlation-labeled structure/length priors to explicit Ideas and Community Spark actions.
- **DM workspace** — `buildDms`, `planDm`, `draftDmFor`, `refreshDmContext`; an account-isolated relationship-planning mode with explicit public enrichment and manually recorded private outcomes.
- **Growth loop** — `buildGrowth`, `captureGrowthData`, `ensureGrowthOwner`; a fifth dock mode that runs one 14-day profile strategy test, compares it with the prior window, and carries the active bet into Post ideas.
- **launcher avatar stack** — `launcherAvatars`, `lavInitial`.
- **Goobi driver** — `goobiMood`, `goobiStatus`, `goobiReact`/`goobiReactLove`, `refreshGoobi`, `touchGoobi` (maps dock signals → mascot moods).
- **in-dock playground** — `buildPlay`, `feedTreat`, `petGoobi`, `syncPlay`, `openPlay`/`closePlay`/`togglePlay`, `resetPlay`; `fedEver`/`fedTotal` persisted.
- **author-reach** — `maybeFetchReach`/`pumpReach` (Twttr `/user`), `reachFactor`, `reciprocityFactor`, `inReachSweetSpot`, `builderTierFor`, `effectiveScore`, `freshnessFactor`, `scoreVerdict`, `easyScore`.
- **storage / reply log** — `boot`, `ReplyLog`/`SentRecord`, `recordSentReply`, `recordReplyAndNudge`, `logSentReply`, `replyStreak`.
- **resilience** — `contextOK`/`teardown` + `invalidated` (extension-reload shutdown); `trapKeys` (stops X's single-key shortcuts hijacking our shadow-DOM inputs).
- **discovery + routing** — `findSpots("niche"|"fresh-reach")` (recent niche search; Fresh Reach pairs a focused Top lens with up to two guaranteed-distinct rotating exploration lenses, merges decaying public distribution evidence into a persistent 30-day/400-account radar, supports a private max-12 massive watchlist, derives a max-10 massive-account keep-list from settled reply views, runs up to 24 due per-handle checks six-wide with four bounded watchlist lanes plus measured-winner/evidence-backed exploration coverage, keeps up to 36/two-per-author candidates through three content-scoring batches, then selects the best strict live/content opening per author), `urlPoll` (SPA navigation).

### `src/background/service-worker.ts` — broker
Routes messages (`SCORE_POSTS`, `DRAFT_REPLY`, `DRAFT_DM`, `POST_IDEAS`, `POST_IDEA_REWRITE`, `TWTTR_GET`, `GET_FAVICONS`, `GET_TWTTR_METER`, voice/recall, tab ops). Holds the Twttr governor and the tab-manager features (idle-archive alarm, grouping).

### `src/lib/` — pure-ish modules
| File | Role | Test |
|---|---|---|
| `claude-client.ts` | All shipping Claude calls: `scorePosts`, `draftReply` (+ angle/style/steer), `draftDm`, `generatePostIdeas`, `classify`, `advise`, `isSmartEnabled`. Models: Haiku (score/classify), Sonnet (draft/ideas/DM). BYO-key direct; the parked proxy is excluded from the extension. | — |
| `prompts.ts` | System prompts + `REPLY_ANGLES` (the 6-value category enum, by convention) + the orthogonal `REPLY_STYLES` delivery contract. | `test-prompts` (invariant guard) |
| `text-clean.ts` | Deterministic draft cleaners under the prompt rules — `stripDashes` (no em/en dash, no hyphenated compounds; links shielded) + `stripEmphasisQuotes` (unwraps scare/emphasis quotes, preserving apostrophes + possessives) + `cleanDraft` (the combined net). Applied by claude-client to BOTH reply drafts and post ideas. | `test-text-clean` |
| `posting-analytics.ts` | Pure X account-content CSV parser + aggregate owner model. Separates originals/replies, shrinks rates to the account baseline, sample-gates reusable structures/length bands, and emits raw-text-free prompt guidance. | `test-posting-analytics` |
| `types.ts` | The message union + shared types. `XScore.category` is a bare `string` — the enum lives only in the prompt + the `catId` runtime guard. | — |
| `twttr.ts` | Parse RapidAPI (`twitter241`) responses: `parseUser`, `pickDiscoveryTweets`, `pickOwnPosts` (text, idea de-dupe), `pickOwnPostsWithStats` (keeps real `views`/engagement → the momentum views readout). | `test-twttr` |
| `twttr-scheduler.ts` | Pure shared-queue policy: adaptive provider-window rate, even dispatch spacing, bounded intent priority/fairness, and concurrency constants. | `test-twttr-scheduler`, `test-twttr-governor-load` |
| `twttr-governor.ts` | The only thing that calls the provider: adaptive shared queue, provider backpressure/circuit, budget meter, timeout, coalescing, and storage-backed response cache. | `test-twttr-governor-load`, `test-twttr-cache` |
| `twttr-policy.ts` | Pure budget/cap decisions (`TWTTR_BUDGET`). | `test-policy` |
| `reply-hygiene.ts` | Adaptive local reply-pressure model plus repeat-author / duplicate-reply guards. `replyPaceStatus` weights warm conversations below cold discovery, decays activity after 15 minutes, exposes the 8/12 product pressure bands, and accepts a reset baseline without mutating history. | `test-hygiene` |
| `momentum.ts` | Pure warm-up/**momentum** model: `computeMomentum` → 0–100 score + state (cold→peak, overheating) from today's replies/posts/streak/recency. Reads `replyPaceStatus(...).level` so it can never celebrate past the ease-off line (Peak = healthy-only). Views are shown beside it, never scored. `dailyShape` = the **daily-cadence coach**: the healthy BALANCE of the day (10–30 quality replies + 1–3 spaced originals), safety-deferent (silent at ease-off; never nudges more replies at caution). | `test-momentum` |
| `learn-stats.ts` | Pure **engagement learning loop** ("who you show up with"): `aggregateAccounts` (recency-weighted, Bayesian-shrunk, min-N gated per-account scores — Tier-1 investment + Tier-2 measured outcome), `rankAccounts`, `foldOwnDelta` (per-post view-growth trend), `matchOutcomes` (Tier-2 reply→engagement match-back), `concentration`/`cadenceTrend`. Honest by construction (no crowning, no causation/reach claims). x-copilot owns the daily-scan I/O + the dock panel. | `test-learn-stats` |
| `supporters.ts` | Pure **reciprocity engine** ("who shows up for you"): `aggregateSupporters` (scores reply+mention only — likes/reposts are lossy chips), `rankSupporters`, `fuseMutual` (cohort-invariant mutual/fan/one-way labels, fused with learn-stats' invest), `reciprocalConcentration` (anti-pod ring detector), `cadence`. x-copilot harvests the events from the **notifications-page DOM** (`scanNotifications`, zero API) + owns the dock panel. | `test-supporters` |
| `suggest-targets.ts` | Pure **auto-suggest ranking** for the Targets mode: `suggestionScore` (multiplicative, each factor tied to a real X-ranker mechanism — sweet-spot reach, follow-graph openness, niche overlap, predicted engagement-rate, our own measured outcome; missing signals neutral 1.0), `rankSuggestions`, `suggestionReason` (honest, banded, "two-way account" not "replies to people"). x-copilot builds candidates from the free `authorReach` cache. | `test-suggest-targets` |
| `fresh-reach.ts` | Pure **Fresh Reach radar + massive keep-list** policy. `freshReachShortlist` admits only timely, settled, API-attributed X-reported views on actual Fresh Reach replies, applies a measured floor + two-outcome shrinkage, and caps at 10. Twenty-four due checks bound watchlist, measured-winner, and up to three evidence-backed massive exploration lanes; account ranking separately values peak views/engagements and age-normalized distribution while raw audience size stays minor. Fame-only accounts and recent repeat authors cannot force a slot. Public distribution evidence decays on a 14-day half-life. Posts become `early-fit` (<30 replies), `breakout` (strong distribution, ≤90m, <50 replies), or `major-early` (massive, ≤20m, <80 replies; live distribution required above 29), then require the strict 0.68 anchor/brief/`risk:none` content gate and final one-result-per-author selection. | `test-fresh-reach` |
| `reply-handoff.ts` | Pure copy-only exact-post URL/identity contract used to safely open the matching status page. It contains no draft payload, composer selector, or insertion logic. | `test-reply-handoff` |
| `targets.ts` | Pure **"Target accounts" logic** (look for timely posts on larger, still-practical niche accounts): `excludeFromTargets`/`inReachBand`/`reachMultipleLabel`/`bandHiFor` (the tunable size-scaled ~2–25× product band + `MEGA_CAP` exclusion), `addTarget`/`removeTarget` (cap/dedupe), `freshnessLabel`/`earlyLabel`/`slotOdds` (age and observed thread-room heuristics), and `selectPollBatch` (the ≤5/kick + persisted 12-min TTL invariant powering the ambient poller). These are prioritization priors, not published X thresholds or For You probabilities. x-copilot owns the dock mode + the user-initiated governed fetches; tracking reuses `learn-stats`. | `test-targets` |
| `dm-workspace.ts` | Pure **DM relationship workspace**: owner-scoped candidates, six growth intents, evidence gates, stable-ID merge, remove tombstones, manual pipeline transitions, one due follow-up, local duplicate checks, and conservative marked-send pacing. No inbox read/send behavior. | `test-dm-workspace` |
| `dm-intelligence.ts` | Pure **KISS DM decision layer**: one priority-ordered next move (real reply → due follow-up → grounded Ready plan → research) plus self-reported funnel, angle, and people-source summaries. Send-time snapshots prevent later CRM edits from rewriting attribution; learning is display-only and sample-gated (3 for local evidence, 5 before a source can be called clearest). | `test-dm-intelligence` |
| `growth-loop.ts` | Pure **account growth learning loop**: account-scoped daily snapshots, five explicit strategy bets, 14-day matched-window experiments, thin-data gates, action tagging, cross-tab merge, and collect/double-down/tighten/switch decisions. Reports co-movement, never profile-click attribution. | `test-growth-loop` |
| `threads.ts` | Pure **"Tend your threads"** action queue: `rankThreads` ranks the people who replied to / mentioned you (from the notifications harvest, $0) freshest-first into a to-tend list — answering your own repliers is the top-ordered growth action (author-engaged replies grade highest; keeping a convo alive is what dedup promotes). Honest: no parent-thread id (can't group by your post), "tended" is a lossy handle+time guess. x-copilot harvests the reply text + owns the dock panel. | `test-threads` |
| `idea-quality.ts` | Pure **Post-ideas exemplar quality + honest virality**: `isEnglish`/`looksLikeRT`/`isBait` (drop poison exemplars), `classifyShape` (diversity), `scoreWinner`/`percentile` (genuine-breakout ranking), `ideaTokens`/`jaccard` (de-dupe), `bandFor` (virality band anchored to the source's real measured rank — never a fabricated number). x-copilot's `pickBest` orchestrates these. | `eval-post-ideas` |
| `human-pacing.ts` | Human-like delays/jitter for likes/follows. | `test-pacing` |
| `draft-context.ts` | Pure context assembly for the reply drafter (niche + scorer rationale + author/relationship/opportunity evidence + gated measured lines) — user-message only; the live draft eval imports the REAL assembler. | `test-draft-context` |
| `profile-check.ts` | The profile coach — measured findings on the CONVERSION surface (pinned-post rank vs your own best by X-reported views; bio presence), fed by a $0 own-profile DOM harvest. Silent without data. **v2**: `analyzeBio` scans the what/who/**proof** formula (run at harvest so only booleans are stored, never the bio text) + name-descriptor + banner presence — profile_click→follow_author are first-class ranked actions. | `test-profile-check` |
| `activity.ts` | Gamified-but-honest "show up" layer: `activityCells` (14-day measured heat dots), `chain` (active-day chain w/ today's grace), `pickCallout` (one contextual algo-backed callout; easeoff always wins; evidence class named). | `test-activity` |
| `community.ts` | `builderTier` — vertical-agnostic niche-peer detection (bio ∩ niche words + two-way ratio → tier 2 for ANY vertical; builder/creator bio language alone → tier 1). Surfaces peers worth engaging even off-topic. | `test-community` |
| `heuristics.ts` | **Tab manager**: group-by-domain, idle-archivable, `normalizeUrl` dedupe. | — |
| `archive.ts` | **Tab manager**: archive-not-delete + undo. | — |
| `config.ts` | The storage-key registry (`CONFIG`). Tab keys + X keys. | — |
| `goobi.ts` | The pixel-mascot **renderer**: `mountGoobi(host, opts) → {el, setMood, trick, destroy}`. Moods/animations. CSS lives in the host surfaces, not here. See [goobi.md](goobi.md). | — |

### `src/popup/` — side panel
`popup.ts` + `popup.html`: BYO-key + smart toggle, voice capture (`/user-replies` learning), products, niche, the local aggregate-only analytics CSV importer/model receipt, account-safety panel, follower count, the tab list, and the **side-panel Goobi playground** (its own copy, distinct from the dock's).

## Storage keys (`CONFIG`)
Two domains. **Tab**: `SCAN_ALARM`, archive/group keys. **X copilot**: `X_COPILOT_KEY` (on/off), `X_DATA_CONSENT_KEY` (versioned disclosure acceptance required before boot), `X_VOICE_KEY`, `X_PRODUCTS_KEY` (+ legacy `X_PRODUCT_KEY`), `X_NICHE_KEY`, `X_DEFAULT_ANGLE_KEY`/`X_DEFAULT_PRODUCT_KEY`, `X_MY_FOLLOWERS_KEY`, `X_PAUSED_KEY`, `X_REPLY_LOG_KEY`, `X_IDEAS_KEY`, `X_MY_POSTS_KEY` (own-posts cache: idea de-dupe + momentum views), `X_LEARN_STATS_KEY` (engagement learning loop: own-post trend + scan gates), `X_POSTING_MODEL_KEY` (one aggregate-only owner-scoped import; never raw CSV rows), per-owner `X_GROWTH_LOOP_KEY:<handle>` records (account-level strategy experiments), `X_SUPPORTERS_KEY` (reciprocity: who engages with me, harvested from the notifications DOM), `X_TARGETS_KEY` ("Target accounts" list: big in-reach accounts to comment on early), per-owner `X_DM_WORKSPACE_KEY:<handle>` records, `X_GOOBI_SEEN_KEY`, `X_GOOBI_FED_KEY`, `TWTTR_KEY_KEY`. Dev `.env`/key entry is BYO — keys live in `chrome.storage`/the SW, never bundled or put on-page.

## Conventions & gotchas
- **Closed shadow roots.** The dock and draft panel mount on hosts appended to
  `documentElement` with `{mode: "closed"}`. CSS is injected per-surface
  (`DOCK_CSS` in x-copilot, `<style>` in popup.html) — a Goobi animation class must
  exist in **both** if both surfaces use it.
- **`trapKeys`** stops key events leaking to X's document-level shortcut handler —
  required for any input we add (else typing loses focus).
- **Context invalidation.** Reloading the unpacked extension orphans the old content
  script; `teardown()` + the `invalidated` flag shut it down cleanly. Gate any new
  recurring loop/observer on `contextOK()`, and re-check `invalidated`/`contextOK()`
  after any `await` before touching the DOM/chrome. A global `window` `error` +
  `unhandledrejection` catch-all (`isCtxInvalidated`) tears the script down and swallows
  the "Extension context invalidated" throw that async continuations can still leak past
  the per-call guards — so it never surfaces as an uncaught console error.
- **Draft-only, BYO-key, no auto-post** are product invariants — don't break them.
