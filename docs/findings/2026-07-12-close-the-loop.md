# Closing the learning loop — 2026-07-12

**Status:** mechanism shipped behind a default-OFF flag (`X_LEARN_LOOP_KEY` / `learnLoopOn`). Not yet activated — waiting on a real-data backtest.

## Why

Goobi already *measured* what works (the daily `runMeasurePass` writes real likes/replies into `SentRecord.outcome`; `learnFeatures`/`aggregateAccounts` turn that into per-angle/per-account signal), but the signal was **observational only** — `effectiveScore` (ranking) and `initialAngle` (drafting) used none of it. This work wires the measured signal into decisions behind a default-off switch and conservative same-sample gate; it does not establish held-out predictive validity.

## Theories

| ID | Claim | Gates |
|----|-------|-------|
| T3 | The current stage-1 ranking correlates with real outcomes | `learnFeatures().fitCorr` (Spearman, n≥12) |
| T1 | Per-**angle** engagement is stable (earlier → later) | drafter angle nudge |
| T2 | Per-**account** engagement is stable (earlier → later) | ranking multiplier |
| T4 | A `search-v3` response cache cuts byte spend | none — efficiency, low risk |

## What shipped (this pass)

- **T4 — governor response cache** (`twttr-governor.ts` + pure helpers in `twttr-policy.ts`). Storage-backed, keyed on the full URL, per-class TTL (the `TWTTR_CLASS.ttl` values that already existed but weren't consumed), served **before** the budget/rate gates (a hit costs 0 bytes/0 requests, even in lockdown), self-bounding (prune-expired + oldest-eviction under a 4 MB cap). Scoped to the expensive/uncached classes — `user` is skipped (cheap + already cached upstream by `authorReach`). **Shipped ON** — no gate needed. Pure decisions covered by `scripts/test-twttr-cache.mjs`.
- **T2 — ranking multiplier** (`accountRankMultipliers` in `learn-stats.ts` → `rankScore` in `x-copilot.ts`). A per-account measured multiplier, currently clamped to **[0.90, 1.10]**, precomputed once per render (never in the sort comparator), applied only to sort order in `topOpps`/`launcherAvatars`. **Gated on `fitCorr` defined AND ≥ 0.20** (T3) — if the same-sample ranking/outcome association is absent, it tilts nothing. Neutral 1.0 for any account without a settled measured score. Behind `learnLoopOn`, **default OFF**.
- **T1 — drafter angle nudge** (`learnedBestAngle` → `initialAngle`). Your measured-best angle becomes the default draft angle *when the loop is on*, still overridable by steer chips. Reads `bestAngle`, which only exists when the top angle clears +15% over ≥2 angles. Behind `learnLoopOn`, **default OFF**.

### Correctness note (deviation from the plan)

The plan said "insert the multiplier at `effectiveScore`." We did **not** — `effectiveScore` is logged into `SentRecord.score`, which is the *stage-1 axis of `fitCorr`*. Folding the learned tilt into it would make the T3 gate **circular** (the gate would be testing a score that already contains the thing it's gating). Instead the tilt lives in a separate `rankScore` wrapper used only for sort order; `effectiveScore`, the recorded score, and the displayed fit % stay pure.

## Measured

- **Synthetic self-test** (`scripts/backtest-learning.mjs`, in the gate): the replay harness correctly (a) detects planted score→fit signal, angle stability, and account stability; (b) does **not** manufacture correlation on noise; (c) reports UNDERPOWERED on thin data. `scripts/test-learn-loop.mjs`: the multiplier stays OFF when the ranking is negatively aligned or thin, tilts up/down within the clamp when the synthetic gate is met, and omits sub-threshold accounts. This validates plumbing, not real-account efficacy.
- **Real data:** not yet run — Goobi has only been in use a few days, so settled outcomes (`frozen`, ~2-day settle) are almost certainly < the n≥12 the honesty gates require. Expected first result: **SHELVE / keep OFF**.

## Next step to activate

1. In the x.com content-script console: `chrome.storage.local.set({ xDebug: true })`, then `__goobiExport()` → save the JSON.
2. `node scripts/backtest-learning.mjs <export.json>` → read the T3/T1/T2 verdicts.
3. Flip on only what passed: `chrome.storage.local.set({ xLearnLoop: true })` (live, no reload). If T1 fails but T2+T3 pass, the ranking multiplier is still safe to run (the drafter nudge is inert without a `bestAngle`).

## Deferred

- Post-idea generation biasing toward measured-best shapes/angles.
- `search-v3` cursor pagination for deeper niche discovery.
