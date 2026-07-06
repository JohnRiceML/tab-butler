# Changelog

Notable changes + the phase-transition record. The day-to-day lives in git history.

## Phase: X reply copilot + Goobi — through 2026-06-23

The product pivoted from **Tab Butler** (a tab manager) to **Goobi**, an X/Twitter
reply copilot with a pet mascot. The tab manager still ships. What landed:

**Copilot**
- Scan → score (Claude/Haiku) → in-feed badge → draft (Claude/Sonnet) pipeline, with
  `effectiveScore` ranking (model × freshness × reach × pileup × community-tier).
- In-feed badge shows **reply-fit % + category tag**, and flips to a green
  **"✓ Commented"** call-out on posts you've already replied to.
- **Draft steering**: a free-text "steer it" box + Regenerate; composes with the
  angle chips. Draft-only — inserts into X's reply box, never auto-posts.
- The always-on **dock**: ranked cards, sort tabs (best/recent/reach/easy), filter,
  account-safety pace chip, kebab (pause / find spots / clear), minimize-to-pill with
  an overlapping **avatar stack** of the top authors.
- **Community/peer-builder** signal (`community.ts`) — surface peers worth engaging
  even off your exact topic.
- **"+ Add" override** on posts the scorer passed on (pin + score them yourself;
  manual opps are never pruned).
- **Post ideas** tab in the dock (`POST_IDEAS` → `generatePostIdeas`): pulls the
  best-performing recent posts in your niche (Twttr `search-v3` Top → `pickBest`,
  ranked by engagement, ≤2 per author) and remixes the winning PATTERNS — never the
  content — into original posts in your voice (Sonnet, `POST_IDEAS_SYSTEM`).
  - **v2** (designer-led): each card shows the **real source post** it remixed
    (collapsible, with ❤/🔁 + open-the-tweet — the data was already fetched), a
    **virality gauge** (band+word, not a fake number), **pin** to keep ideas, and the
    fabricated reach number was removed for an honest "tuned to your ~N followers."
  - **content quality** (expert-led): the generator now pulls **your own recent
    posts** (`from:<handle>` search, cached ~24h under `X_MY_POSTS_KEY`,
    `pickOwnPosts`) and feeds them to the prompt so ideas **don't duplicate what you've
    already posted** + match your real voice — plus a dependency-free word-set Jaccard
    **de-dupe guard** drops near-repeats (vs your posts or each other). Rewrote
    `POST_IDEAS_SYSTEM` with an anti-generic bar + enforced variety (5 distinct shapes,
    ≥3 content types). `pickBest` is now follower-normalized (eng/√followers) so a small
    account's genuine breakout beats a mega-account's floor post. Own-posts pull is
    best-effort (degrades to prompt-only if no handle / budget). The surface also goes
    **wide** (≤680px, 90vh) on this tab.
  - **v3 — persist → shape → ship** (expert-panel buildout): a **persistent drafts
    queue** (`X_IDEAS_KEY`, `IdeaRecord[]`, survives reloads — edits/pins write through
    `safeSet`); **per-idea steer/rewrite** (chips + free nudge → `POST_IDEA_REWRITE` →
    `generatePostIdeaRewrite`, one scoped Sonnet call, one-level undo) so you shape a
    near-miss instead of rerolling the batch; and **mark-shipped + streak** (Open-in-
    composer flips it to posted, Goobi cheers, a "Shipped N · 🔥 K-day streak" strip,
    posted ideas collapse into a Shipped section). Draft-only intact.
  - **v4 — scannable-queue UX pass** (design-panel: 3 directions scored → synthesized):
    each idea is now a **one-line row** (virality color rail + hook + `Strong · listicle ·
    ↺ @handle` meta + one-tap ↗) that **expands in place** into the editor (borderless
    draft hero + why + steer + source + action bar) — single-open, so ~4 ideas fit where
    1 did and you triage the batch in seconds. The absolute corner gauge + the
    `margin-top:18px` hack are gone (virality → the rail + the bold meta word); the header
    condenses 5 rows → 3 (streak + Generate top-anchored, merged sub/reach line); off-
    palette purple/gold recolored so **color means one thing** (virality + the copper CTA);
    first-class gate / empty / error states. Every capability intact, one disclosure deeper.
  - **v5 — creator quality overhaul** (`idea-quality.ts`, 12-agent workflow + adversarial
    verify; net cost unchanged at 1 search + 1 Sonnet): the model can only be as good as
    what it remixes, so the candidate pool is hardened *before* generation. New pure
    `idea-quality.ts` (unit-tested, `scripts/eval-post-ideas.mjs`) + a rebuilt `pickBest`:
    server-side search operators (`lang:en -filter:replies/retweets -giveaway`) with a
    no-operator retry for thin niches, an English/RT/engagement-bait filter, a 21→60-day
    recency window, a **genuine-breakout** score (follower-normalized, not raw), a
    percentile engagement floor, near-identical-source de-dupe, and **author + shape
    diversity quotas** so it never feeds 5 of the same shape. **Prompt rewrite**
    (`POST_IDEAS_SYSTEM`): an internal draft-7-seeds → critique → ship-5 pass, a banned-
    opener hook bar, the user's **own posts as the primary voice anchor** (the VOICE blurb
    is correctly demoted to reply-tone-only), follower-tier framing, anti-generic swap-test,
    enforced variety. **Honest virality**: the fake model-graded 0-100 is gone — the model
    scores only `hookStrength` (0-3); the user-facing **band** is anchored to the *real
    measured rank* of the source post it remixed (`bandFor`), with a basis sentence and no
    fabricated multiple; no provable source caps at "Niche". Plus `callDirect` JSON-salvage
    so one bad char can't torch the batch, and cross-batch de-dupe against the live queue.
    A **copy-leak guard** (`copyLeak`) drops any idea that lifted ≥60% of its source post's
    content (plagiarism, not a pattern remix), bounded by the keep-all-if-empty net.
    - **Eval Layer B** (`scripts/eval-post-ideas-live.mjs`, opt-in): generates ideas for 5
      seed niches with the real prompt (Sonnet) then a Haiku judge scores each batch
      0-3 on anti-generic / voice / variety / hook / source-honesty + a swap-test fail
      rate + judge-stability check — so a prompt/selection change is a measurable delta.
      No-op without `--live` (default gate stays $0).
- **Warm-up / momentum meter** (`momentum.ts`, expert-led): a thin strip under the dock
  header shows your **account momentum for the day** — a 0–100 score derived from real
  activity (replies today *saturating* at a healthy target, posts shipped, day-over-day
  streak, how live you are right now). States run Cold → Warming → In flow → **Peak (at
  the *healthy* sweet spot)** → Cooling → **Overheating**. It reads the **same
  `reputationStatus` the pace chip + Goobi's "worn" mood read**, so it can never
  celebrate over a safety warning: past ~30 replies/hr the score *drops* to red
  "ease off", and at caution pace it turns amber to match the chip — Peak is reachable
  only at a healthy pace. Beside the meter, a neutral **real-views readout** — your
  X-reported views on today's posts — pulled by *extending* the existing
  `from:<handle>` search to keep `views`/engagement (`pickOwnPostsWithStats`, 60-min
  stat cache on top of the 24h de-dupe cache, ~1 extra call/active-hour, budget-gated).
  Views are **shown, never scored** (a measured fact, not a lever to push volume).
  Derived from data we already track — no new storage key, no new endpoint, no new
  Goobi moods. Pure model unit-tested (`scripts/test-momentum.mjs`, 15 assertions).
- **Engagement learning loop — "Who you show up with"** (`learn-stats.ts`,
  workflow-designed + adversarially verified): a once-a-day, dayKey-gated scan that
  compounds over time into a dock insight panel. Two honest tiers on one path:
  - **Tier-1 "investment"** (ships now, **0 new API cost**) ranks the accounts you reply
    to by a recency-weighted mean of your reply *quality* (`effectiveScore`) — labeled
    *where you invest your replies*, **never** "who pays off." Empirical-Bayes shrinkage
    to the global mean (no crowning an account off one lucky reply) + a hard min-N gate
    (thin accounts sit in a "still learning" bucket).
  - **Tier-2 "engagement-backed"** (the real ask) — a daily **measure-pass** fetches the
    likes/replies your own replies earned (`user-replies-v2`), matches each back to a
    stored reply by text (`matchOutcomes`), and writes the dormant `SentRecord.outcome`.
    Accounts that accrue ≥4 *settled* outcomes earn a ✓ measured, reach-normalized,
    **relative** read (▲ above / ▼ below your average — never a fabricated number).
  - **Own-post trend backbone:** per-post positive view-deltas (keyed by id, so the
    sliding 15-post window can't go negative) fold into bounded daily snapshots →
    "Your posts: +N views this week."
  - **Honesty by construction:** title "Who you show up with"; share bars are neutral
    (never green); footer states *replying to someone doesn't make them engage back*; a
    single-target **spread nudge** (never "double down"); cadence arrows are *your*
    cadence, not their response. No new permissions; reuses the `from:<handle>` cache +
    the budget governor (`intent:true`, self-pauses on budget pressure); ~1–2 calls/day,
    behind `LEARN_SCAN_ENABLED`. Pure model unit-tested (`scripts/test-learn-stats.mjs`,
    21 assertions). This retires the long-deferred "what's working for YOU" bet (below).
- **Reciprocity engine — "Who shows up for you"** (`supporters.ts`, workflow-designed +
  adversarially verified): the inverse of the learning loop — the accounts that engage
  with **you**, so you can build real mutuals. **Detection is zero-API**: the content
  script reads your own **notifications page** DOM — reply + mention notifications render
  as full tweet articles, captured reliably (idempotent, dedup by status id).
  - **Honest scoring:** likes/reposts are lossy ("X and N others") + locale-fragile, so
    they're **not counted** (deferred); the supporter score is **reply + mention only**,
    recency-weighted + count-anchored shrinkage + min-N gated (same conventions as
    `learn-stats.ts`).
  - **Mutual score:** fuses "who you show up with" (you→them) with "who shows up for you"
    (them→you) via a **cohort-invariant** squash into **mutual / fan / one-way** labels —
    a pair's label can't shift just because an unrelated account joins.
  - **Anti-pod by design** (this is *not* an engagement pod): a **reciprocal-ring
    detector** warns when a closed like-for-like loop forms (what X actually penalizes);
    no "like them back" verb — the only action is **open their profile** (draft-only,
    zero API); honest footer (a sample not a ledger, likes uncounted, notifications stay
    on-device). New `X_SUPPORTERS_KEY` (device-local, 1000-cap, 60-day prune). Pure model
    unit-tested (`scripts/test-supporters.mjs`, 11 assertions).
- **Target accounts — "🎯 Targets" mode** (`targets.ts`, web-researched + workflow-
  designed + adversarially verified): the growth move of **commenting early on bigger
  in-reach niche accounts to borrow their crowd**. A third dock mode where you track
  large accounts, pull their freshest original post on demand (reuses the proven
  `from:<handle>` search), and **coach a quality reply** (Sonnet `DRAFT_REPLY` → edit →
  Copy / Open-the-post). **Draft-only** — it only opens the post + copies the draft,
  never auto-replies.
  - **Reachable, not mega:** a hard membership gate (`excludeFromTargets`) keeps the list
    to ~2–12× your size with an absolute ceiling — untouchable mega-accounts are
    *structurally* excluded, not just rank-penalized (research: a reply buried under a
    mega's thousands earns nothing).
  - **Tracking comes free:** `targetStanding` reuses the shipped learning loop
    (`aggregateAccounts`) — each target shows *which of your replies actually land*
    ("✓ your replies here beat your average" / "still learning N/4"). No new tracking
    engine.
  - **Anti-spam by construction** (research found X weights a mute/block at ~−74, ≈148× a
    like — annoying the account *shrinks* your reach): the **pace keystone locks** the
    find/draft actions past 30 replies/hr; a new `replyQualityWarning` flags empty-praise
    ("great post! 🔥") before you copy; a live freshness window ("4m old · reply while
    it's live") nudges *early*, not *often*; honest framing ("a reply is a chance at their
    audience, not a promise"); **no impression number is ever shown** (X doesn't report
    reply impressions — we won't fake one). New `X_TARGETS_KEY` (device-local). Pure libs
    unit-tested (`scripts/test-targets.mjs` 18 + the quality gate in `test-hygiene.mjs`).
    Deferred: an ambient fresh-post poller (the `selectPollBatch` budget invariant is
    already tested) + folding the learned per-target signal into ranking.
  - **Suggested accounts** (`suggest-targets.ts`, deep-algo-research workflow + verified):
    a "Suggested for you" list — the in-niche authors your last "Find spots" search
    already cached (followers only, **zero extra API cost**), gated to the reach
    sweet-spot and ranked by a `suggestionScore` where **every factor traces to a real
    X-ranker mechanism** (sweet-spot out-of-network bridge; follow-graph openness as a
    proxy for the +75 `reply_engaged_by_author` head; bio-niche overlap; predicted
    engagement-rate per post; and the **only measured-on-our-data** signal — how your
    replies to them have actually done). One-tap **+ Track**, a dismiss ×, and an honest
    per-account reason. Honesty held to the bulletproof bar: the live 2026 ranker is
    Grok-internal, so the byline says **"computed from what we can see, not guaranteed,"**
    a missing signal is held neutral (never a penalty), openness is described as a
    follow-graph *shape* ("a two-way account") not inferred behavior, and only Tier-2-
    measured history earns the "✓ your replies here have done well" tag. Pure-lib
    unit-tested (`scripts/test-suggest-targets.mjs`, 15 assertions).
    - **Tier-B enrichment (cheap signals):** the strongest candidates get a budgeted
      `/user` lookup (reuses `maybeFetchReach` — capped at 80/session, governed,
      re-renders on completion) to fill `following` + `bio`, so the **openness** (two-way
      account) and **niche-match** factors light up beyond the free followers-only signal.
    - **Heavy-hitter discovery (engagement, not just size):** a "🔥 Find heavy hitters"
      action (auto-runs once per session) does one `search-v3 type:Top` call — the *most-
      engaged* posts in your niche are written by the accounts whose content **lands**, and
      the call returns their engagement for free. That **populates the engagement-rate
      factor** (a viral post's `eng / followers`), so suggestions now rank on **size AND
      engagement** — a big *broadcaster* with dead replies ranks below a slightly smaller
      account whose posts pop. The reach band widened to the research **5–25× sweet-spot**
      (with a fixed `MEGA_CAP`), and the biggest get an honest *"big — comment EARLY before
      it's buried"* cue. Engagement reads as *"lands big in your niche"* (a viral post we
      found, not "typical").
- Resilience: clean **context-invalidation teardown**; **`trapKeys`** fix so X's
  keyboard shortcuts stop stealing focus from our inputs.

**Goobi (mascot)** — see [docs/goobi.md](docs/goobi.md)
- Pixel-blob renderer (`goobi.ts`) with mood→animation mapping driven by real signals
  (hunting / thinking / sleeping / ease-off), livelier idle, floating hearts, cleaner
  sleep "z".
- **In-dock playground**: spring-open panel, today's replies become treats (wearing
  the author's avatar) you feed him; feeding drives an energy meter (pets barely
  count); at the bar he unlocks "go hunt" (rescan) and does a **random trick**
  (dance / spin / flip / …). Fed treats are remembered across sessions.

**Repo (2026-06-23 cleanup)**
- Removed dead code (`metaLine`, `GET_STATE` + handler, `findDuplicates`, the
  write-only `data-tbx-cat`, the unused `g-breathe` keyframe, a stray import).
- Fixed the side-panel account-safety icons (Tabler font wasn't bundled → emoji).
- Rewrote README + ARCHITECTURE; added [docs/SYSTEM.md](docs/SYSTEM.md) (where things
  live); marked `docs/goobi-design-v1.md` historical.

**Systems validation + fixes (2026-06-30)** — a multi-agent validation of the three X
surfaces (replies, post-ideas, targets) found all three algorithmically sound; it shipped
five verified fixes (and refuted ~11 other proposed changes as already-done, mis-grounded,
or harmful to the honest-mirror keystone):
- **Post-ideas — 2026 ranker tone gate.** `POST_IDEAS_SYSTEM` (+ the rewrite prompt) now
  teach the model that X's ranker reads tone directly — combative/dunking posts get
  throttled even at high engagement, constructive ones amplified — with a PASS-2
  "KILL IF IT DUNKS" critique. Contrarian/myth-bust shapes stay encouraged, just
  sharp-not-bitter.
- **Replies — profile-click draft directive.** `X_DRAFT_SYSTEM` now optimizes the reply
  for the funnel step that actually makes follows (a curious profile click), earned
  honestly via demonstrated competence — never self-promo, a CTA, or click-bait.
- **Post-ideas — honest thin-pool band.** `bandFor` takes a `poolSize` confidence haircut
  so a single mined exemplar can no longer mint a "Strong / one of the top posts" band; a
  thin pool (1-2 posts) always reads as "a thin signal" (`idea-quality.ts`, + eval locks).
- **Prompt-invariant guard.** New `scripts/test-prompts.mjs` (in the default gate) asserts
  the load-bearing prompt rules (no-dash, exact-handle attribution, hook-only scoring,
  PROVEN ANGLE, the tone gate, the profile-click lever) so a silent prompt edit can't
  delete one and still ship green.
- **Doc honesty.** Corrected stale `targets.md` / `SYSTEM.md`: `engRate`/`engNorm` is now
  LIVE (for heavy-hitter-search authors; coverage partial), the band is the size-scaled
  ~2–25×, and the constant is `MEGA_CAP` (not the long-gone `ABS_CEILING_BASE`).

**Assumptions audit — correctness/honesty fixes (2026-06-30)** — a deeper multi-agent audit
backed each system's load-bearing assumptions with logic + published data (the tweet
half-life paper, the 2023 open-source weights, TweepCred, engagement-rate benchmarks) and an
adversarial fabrication check. These are the zero-risk corrections it surfaced (the *ranking*
changes it flagged are deferred to data-driven validation, not shipped as more priors):
- **Fixed a baked-in non-sequitur:** `targets.ts`/`targets.md` justified the mega-account
  exclusion with the 2023 ranker's −74 mute/block penalty — but that penalty is about a
  reply's QUALITY (readers blocking spam), independent of the target's size. The size gate
  now correctly rests on visibility dilution (your reply is 1-of-thousands under a mega
  thread); the −74 belongs to the empty-praise guard. Two distinct mechanisms, un-welded.
- **Fixed a lying comment:** the post-ideas exemplar picker's header claimed "engagement per
  √followers," but `scoreWinner` divides by `followers` linearly (~0.3% baseline, floored).
  Comment now matches the code, and flags the flat-constant shape problem as measure-first.
- **Fixed a stale doc:** `reply-spots.md` said outcome learning is "not wired / dead weight" —
  it IS (`runMeasurePass` writes `SentRecord.outcome`, `aggregateAccounts` reads it). The
  doc now describes the real (best-effort, key-gated, ≥4-outcome) loop and notes the replies
  ranker doesn't yet consume it.

**Post-ideas ranking — size-tiered engagement baseline (2026-06-30)** — acted on the audit's
clearest data-backed finding. `scoreWinner` divided engagement by a flat 0.3% like-rate, but
published 2025-26 X benchmarks show small accounts run ~10× hotter than megas — so the flat
constant under-divided small accounts and mistook an *ordinary* small-account post for a
breakout (the opposite of what the picker is for). Replaced with `expectedRate(followers)`, a
size-tiered baseline (~4% sub-1k → ~0.65% megas) derived from those published benchmarks;
structured so a live RapidAPI per-niche calibration can refine the numbers without changing the
shape. The breakout-vs-floor property is preserved; +3 eval assertions (30 total).

**Post-ideas honesty — "Strong" band now requires a real breakout (2026-06-30)** — the virality
band could mint **Strong** off the #1 post of a *weak* pool, because the anchor is relative rank
only. Building on the size-tiered baseline above, `isBreakout(w)` checks whether the matched proof
post genuinely over-performed for its size (≥2× its tier norm); `bandFor`'s new `sourceStrong`
gate caps a non-breakout top source at **Solid** and narrates it honestly ("only modestly
out-performed"). The pool-*quality* sibling of the earlier pool-*size* haircut. +7 eval (37 total).

**Post-ideas — per-niche calibration of the engagement baseline (2026-06-30)** — the passive,
zero-cost version of the audit's "live X-API calibration." `calibrateRates` computes the median
like-rate per follower-tier from the niche posts each generation **already fetched** (no new API
call) and `setRateTable` swaps it into the baseline `expectedRate` reads — so the size-fairness
math is tuned to the user's *actual* niche, not just published benchmarks. Conservative by design:
a tier needs ≥6 samples to override (else it keeps the published default), rates are clamped to
sane bounds, and the worst case is exactly today's behavior. Reviewed (no leakage — the table is
consumed only inside the Ideas flow); +5 eval assertions (42 total).

**Niche-profile review fixes (2026-07-05)** — a third review pass judged all three systems
against the owner's actual profile (AI/build-in-public founder, 1K–10K, follower growth) —
the most bait-saturated niche on X — and shipped what it found:
- **Heavy hitters no longer crownable by engagement farmers.** `findHeavyHitters` folded EVERY
  non-reply Top result into `engRate` — no bait screen — and on a bait-heavy niche, Top skews
  giveaway/RT posts, so a farmer could rank as a 🔥 heavy hitter (and their audience is other
  farmers: worthless follows). Now the query is hardened like the ideas search (`lang:en
  -filter:… -giveaway`) and results pass the same `looksLikeRT`/`isEnglish`/`isBait` screen as
  `pickBest` before touching `engRate` or the candidate pool. (Also fixed the stale "best post"
  doc phrase — it's been a mean since the earlier review.)
- **The niche setting's double duty is now explicit and honored.** The full niche text (intent
  included) is right for the Claude scorer but poisons X search, which reads every word as a
  keyword. New `twttr.ts:nicheQuery` (unit-tested, +5) takes the clause before the first
  `;`/newline; ALL three search paths (Find spots, ideas, heavy hitters) now use it, while
  prompts keep the full text. The popup placeholder + label and `voice-and-profile.md` teach
  the format: `keywords; intent`.

**Generalize to ANY niche + squeeze the API harder (2026-07-05)** — the growth playbook is
universal (add value, be personal, engage the right people, jump on early posts); two places
were still builder-overfit, and one already-fetched signal was being thrown away:
- **Niche peers in any vertical.** `builderTier` hard-required builder/creator bio language, so
  a lawyer/coach/designer peer never got the community lift. Now niche-bio word overlap (+ the
  two-way ratio) makes a tier-2 peer in ANY vertical; the builder regex alone is the tier-1
  off-niche community cue. (+4 tests, community 16.)
- **Post-ideas playbook is vertical-agnostic.** The hardcoded "BUILDER / FOUNDER VERTICAL"
  block became "ANY EXPERTISE NICHE": insider specificity over-performs everywhere — with the
  builder, lawyer, coach, and designer translations spelled out. (+1 prompt invariant.)
- **The free early/buried read on targets.** `findTargetPost` fetched each post's reply count
  and discarded it. Now `targets.ts:earlyLabel` (+7 tests, targets 28) turns it into the
  "jump on early posts" signal at ZERO extra API cost: a live post with ≤5 replies reads
  "only N replies so far — you'd be near the top"; ≥30 reads "you'd be buried; wait for their
  next post"; unknown counts say nothing (honest-mirror).

**Local settings seed (2026-07-05)** — a remove+re-add of the unpacked extension wipes
`chrome.storage.local`, forcing every key/voice/product to be re-typed. Now: copy
`extension/goobi.local.example.json` → `goobi.local.json` (GITIGNORED — plaintext secrets,
machine-local only), fill it once, build. The build bundles it into `dist/` and the service
worker seeds every EMPTY setting from it on install/startup — never overwriting live panel
edits. Re-adds are now zero-retyping.

**Fix the post-ideas empty-pool "try a broader niche" error (2026-07-05)** — a multi-keyword
niche ("AI builders, indie SaaS founders") was sent to X search as an implicit AND of every
word, so almost no tweet matched and the pool came back empty. New `twttr.ts:nicheSearchQuery`
(pure, +7 tests, twttr 61) ORs the topic phrases — `((AI builders) OR (indie SaaS founders))`
— so a post matching ANY topic qualifies; used by all three search paths (Find spots, ideas,
heavy hitters). The ideas retry now broadens to the single strongest topic (also dodges any
provider quirk with OR/parens), and the error copy tells the user to use fewer/broader keywords.

**Reply ranker — live pileup on remount (2026-07-05)** — the one stale term in
`effectiveScore`: freshness recomputed live, but likes/replies were frozen at first-scan, so a
post that BLEW UP after being queued kept ranking as an easy fresh reply (contradicting the
"first ~5-10 replies get seen" premise `buried` exists to honor). Now scan()'s cached branch
refreshes the opp's counts from the live node whenever X's virtualized timeline re-renders a
seen post — zero API calls, no stored DOM refs; a post is only stale while it stays off-screen.
(The full fix for never-re-rendered posts would need a per-post API fetch — a budget decision,
deliberately not taken here.)

**Account trend — the measured "is it picking up?" meter (2026-07-05)** — the momentum strip
scores today's EFFORT (activity + streak); this adds the missing OUTCOME half. New pure
`learn-stats.ts:accountTrend` (+8 tests, learn-stats 29) compares the last 7 days vs the prior
7 on per-post results (views/post when X-reported views exist in both windows, else
engagement/post) over the daily snaps the learning loop already collects, plus a free daily
followers snapshot → the insights panel now opens with "📈 Picking up: ~2.1K views/post this
week vs 900 last week · +34 followers" (or Steady / Cooling). Honest by construction: silent
until both windows hold ≥2 posts, and the tooltip says it straight — X has no literal streak
bonus; consistency compounds through repeat engagement, so this tracks RESULTS, not activity.
Zero new API calls.

**The "show up" chain — gamified, honest (2026-07-05)** — the momentum strip now carries a
GitHub-style 14-day heat-dot row + a 🔥 N-day active chain + one contextual algo-backed callout
(new pure `activity.ts`, +17 tests). Gamified visuals, honest core: every dot/number is
measured (Goobi replies + shipped posts per day), the flame flips to ⏸ at easeoff (it never
cheers past the safety line), callouts are picked by deterministic priority (safety → measured
trend → show-up / post-mix nudges → the timing lever) and each names its evidence class in the
tooltip — none claims a literal streak bonus, because there isn't one: consistency pays through
repeat-engagement affinity + account reputation, and that's what the copy says.

**The system now LEARNS what works — and shows it (2026-07-05)** — closing the loop from
measurement to behavior. Every sent reply already logs its features (angle, post-age-at-reply,
stage-1 fit, author reach) and gets its real engagement measured daily; new pure
`learn-stats.ts:learnFeatures` (+9 tests, learn-stats 38) turns those settled outcomes into:
- **★ your measured-best angle** on the draft-panel chips — the angle whose replies earned
  ≥1.15× your reach-normalized average (min 4 outcomes per angle, ≥2 angles ranked; shrunk,
  recency-weighted). Soft steer only — the per-post category still drives the default.
- **"What's working" insight lines** — per-angle ▲/▼ and the measured timing gradient
  ("replies to <15m-old posts earn ~2.3× your 1h+ ones"), each labeled correlation-not-
  causation and silent below the min-N gates.
- **A live fit-validity check** — Spearman between the stage-1 fit score and real outcomes
  (the assumptions audit's A4 test), surfaced in the tooltip once n≥12.
Same honesty machinery as the account learner; zero new API calls. Also fixed the stale
"outcome is NOT YET IMPLEMENTED" SentRecord comment (the measure pass has written it for weeks).

**Tier 1 of the algo-leverage mission (2026-07-05)** — three moves from the open-source-algo
report, all challenge-verified first:
- **Outcome data upgrade ($0):** the daily measure pass keeps the views/reposts/tweet-id already
  in the paid response (views = distribution, the thing the 2026 ranker actually decides);
  `SentRecord.target` logs the post's engagement state at reply time; `learnFeatures` gains
  `fitCorrViews` (compare with `fitCorr` before any primary-metric flip). Old records untouched.
- **The engaged-back join ($0, the moat metric):** `fillAuthorReplied` joins the notifications
  harvest to the sent-reply log (handle + 72h, one event → one record, most-recent wins) and
  writes the never-written `authorReplied` slot; `aggregateAccounts` carries a measured `backs`
  count and the insights row shows "↩ engaged back ×N" — copy says "engaged back", never
  "replied to your reply" (no thread id available; the tooltip states the join's limits).
- **The drafter learns context + gets an eval:** new pure `draft-context.ts` assembles a
  grounding block (niche + scorer reason/category + honest author line) into the DRAFT user
  message — X_DRAFT_SYSTEM stays byte-stable. New `eval-draft-reply-live.mjs` (opt-in Layer B)
  drafts every fixture bare-vs-enriched and judges both on a 0-3 rubric anchored to the LLM
  reply-grading mechanism in X's published pipeline — so the enrichment is a measured delta,
  and stage 2 (own-reply exemplars + measured-angle line) is explicitly gated on it.
+10 learn-stats tests (48), +7 draft-context (13th suite in the gate).

**Coverage caches persist (2026-07-05)** — `heavyHitters` + `authorReach` were session-only,
so target-selection coverage reset on every navigation and the ~350KB Top-search re-ran each
session. Now both persist (implementing the governor's own stated v2): `authorReach` (public
author data) under the followers-class 24h TTL, `heavyHitters` niche-stamped under a 7d TTL —
TTL authority lives in `twttr-policy.ts` (+2 tests). Persists MERGE into the stored copy so the
long-session memory bound can't wipe compounding history; entries past TTL are pruned on
load/write, never rendered; a niche change flushes the heavy pool (niche-stamped, can't bleed
back). NEGATIVE net API cost.

## Next phase

- **"What's working" learning loop** (the post-ideas "bold bet", deferred on purpose
  until the free persist→ship loop proves retention). When a post idea ships, stamp
  its format/pattern; then ONE batched/day read of your own recent originals (via the
  stored handle) populates `SentRecord.outcome` and biases the next batch toward what
  worked for YOU. It's the only piece that adds recurring API cost — flag it off until
  people return. Same dormant `SentRecord.outcome` also covers replies.
- **Side-panel playground parity.** The popup playground is a separate, simpler copy;
  it doesn't share the dock's persisted fed-set or the new trick variety.
- **Twttr response cache (v2).** `twttr-governor.ts` dedupes in memory only;
  `TWTTR_BUDGET.FAIL_TTL` is reserved for a storage-backed negative cache that isn't
  wired yet.
- **Decide the tab-manager's future** — keep Goobi dual-purpose, or split the tab
  manager out. It still ships + runs but is orthogonal to the copilot.

## Before store submission

- **Remove/replace the placeholder host** `https://YOUR-PROXY.vercel.app/*` in
  `manifest.json` (invalid → store warning).
- **Post a privacy policy** covering the X **post text** the copilot sends to Claude,
  and keep Claude behind the explicit opt-in (limited-use compliance).
- **Managed proxy is non-functional**: `claude-client.ts` ships a placeholder
  `Bearer dev-placeholder-token`; `proxy/src/lib/http.ts` reflects any extension
  origin (CORS) — both flagged `TODO(prod)`. The proxy is parked; the live path is
  BYO-key direct.
- **Model drift**: the parked proxy's advise-model (`opus-4-8`) differs from the
  extension's `advise()` (`haiku-4-5`) — reconcile if the proxy is ever shipped.

## Rename relics (Tab Butler → Goobi)

Renamed: the user-facing name (manifest, side panel, brand voice) and the dev console
prefixes. **Still "tab-butler"** (left intentionally — internal / out of scope):

- The **CLI** (`cli/tab-butler.mjs`, bins `tab-butler`/`tb`) — genuinely a separate
  dev-server tool; keeping its name is fine.
- Package names (`tab-butler-extension`, `tab-butler-proxy`).
- Internal DOM markers (`dataset.tbx`, `data-tbx-badge`) and `CONFIG.SCAN_ALARM`
  (`"tab-butler-scan"`) — renaming the alarm key would orphan existing alarms; not
  worth it. No user-visible strings.

## Deferred / known low-priority

- `emitHearts`/`emitSleepZ` set `position:relative` on the mascot host and don't
  restore it (harmless for those elements).
- `engagement()` parses `reposts`/`views` that nothing consumes yet (kept for future
  ranking).
- `Opp.source` union has a `"feed"` arm that's never assigned (feed opps leave it
  `undefined`).
- Two product-storage schemes coexist: `X_PRODUCTS_KEY` (array) + legacy
  `X_PRODUCT_KEY` (string, read for back-compat, cleared on save).

## Earlier — Tab Butler

The original tab-manager scaffold + the consolidation from 4 components/3 languages
to extension + CLI (the Swift menubar app + native-messaging host were removed
2026-06-19; in git history if an always-on RAM widget is ever wanted). See
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
