# Warm-up / momentum meter

> A daily "discipline mirror" strip — a 0–100 meter that scores how steady and healthy your X activity is *today* (replies + posts shipped + day-over-day streak + how live you are right now), structurally incapable of rewarding unsafe volume.

**Surface:** Ambient on x.com, inside the Goobi copilot dock. It renders in the dock header (`renderDock`), directly under the title/pace-chip row and above the relationship panels, only when the dock is open (not the minimized launcher pill). It is a passive readout — there are no controls.

## What it does for the user
It shows a single colored progress bar with a mood label ("Cold start" → "Warming up" → "In flow" → "In the zone") and a one-line coaching cue, reflecting how consistent and sustainable your replying/posting has been today. Crucially it *peaks at a healthy daily target and then saturates* — doing more never scores higher — and if you cross Goobi's conservative pause line it flips red to "Too hot — ease off" with a *lower* score. Beneath the meter it also shows a neutral factual line of real X-reported views on posts you shipped today, kept visually separate so a vanity metric never drives the discipline score.

## How the user uses it
1. The user replies through Goobi and/or marks post ideas as "posted" over the course of a day.
2. They click the Goobi launcher pill to open the dock (this also kicks off a background stats refresh).
3. They see the **Today strip** (tiered 2026-07-08 — the old six stacked equal-weight lines buried the reply queue): **row 1** is a compact summary — mini fill bar (width = score%, color = state) + colored state label + today's posts/views + the chain, with a ▸ caret (keyboard-accessible, aria-expanded); **row 2** is a single "next best move" coach line chosen by deterministic priority — **safety always wins the slot** (ease-off callout / caution cue), then the daily-shape nudge, then the algo/measured callout. The caret expands the full detail: momentum cue, daily shape, the 14-day activity dots + full chain, and the callout — every tooltip and evidence label intact (nothing was deleted, only tiered).
4. If they idle after building momentum, the cue softens to "Cooling off." At Goobi's adaptive 8-pressure caution line the state and coach turn amber; at 12 pressure they turn red "Too hot — ease off" and the score drops. Warm conversations count less and activity decays after 15 minutes. These are product heuristics, not X limits.
5. In the summary row, when own-post data is available, they read a plain "N posts · X views" fact (or "no posts yet").

## How it works
**Trigger / render.** The strip is built inside `x-copilot.ts:renderDock` (the `mom` block, ~lines 3057–3086), re-run on every dock render. It composes a `MomentumInput` and calls `computeMomentum` from `lib/momentum.ts`, then paints `m.score` (bar width), `m.color`, `m.label`, `m.cue`; `state === "peak"` adds a box-shadow glow.

**Inputs (all local, no API for the score itself):**
- `repliesToday()` — `replyLog.daily[dayKey(now)]` (successful Like + insert attempts and explicitly confirmed copy/open replies today; resets at local midnight).
- `postedToday()` — count of `ideaQueue` items with `status === "posted"` and `postedAt` dated today.
- `replyStreak()` — consecutive days (anchored on today, or yesterday if today is still empty) with ≥1 reply, from `replyLog.daily`.
- `minsSinceLast` — minutes since the max of last reply time (`replyLog.times`) and last post (`ideaQueue[].postedAt`); `9999` if never.
- `repLevel` — `currentReplyPace().level` (`healthy` <8 / `caution` 8–11.9 / `easeoff` ≥12 pressure), the *same* adaptive snapshot already computed for the pace chip.

**Scoring math (`momentum.ts:computeMomentum`, pure):**
`raw = volume + posts + streak + live`, where `volume = 55·min(repliesToday/8, 1)` (saturates at `PACE_TARGET = 8`), `posts = min(postedToday,2)·9` (0–18), `streak = min(replyStreak·4, 20)`, `live = 7·0.5^(minsSinceLast/45)` (decays while idle). Then the safety override: `easeoff` → forces `overheating`, score capped ≤ 60, red `#d6604a`; `caution` → score capped ≤ 74, amber `#e89a3c`, "ease off the throttle" cue; otherwise score is `min(raw,100)` bucketed into `cold`(≤14)/`warming`(≤44)/`inflow`(≤74)/`peak`, and a `warming`/`inflow` state with `minsSinceLast > 25` is relabeled `cooling`.

**The "views today" fact line** is separate. On dock-open the launcher's `onclick` fires `refreshOwnStats()` *first*, then chains `maybeRunDailyLearn()`. `refreshOwnStats` (`x-copilot.ts:2127`) checks `myHandle()`, reads the cached `OwnPostsCache` (key `CONFIG.X_MY_POSTS_KEY`), and if older than `OWN_STATS_TTL` (60 min) calls `fetchOwnData(handle)`. `fetchOwnData` (`x-copilot.ts:2105`) sends ONE `TWTTR_GET` `search-v3` call (`type: Latest, count: 30, query: from:<handle>`) through the background X-data API (a third-party RapidAPI-style key under a request budget — **not** a Claude/LLM call; the momentum feature makes zero model calls), runs `pickOwnPostsWithStats` (max 15), and stores both `posts` (text, for idea de-dupe) and `stats` (`OwnPost[]` with real `views`/`postedAt`). It sets the in-memory `ownStats` so the strip renders synchronously, and calls `renderDock()` only if `ownStats` changed. `ownViewsToday()` (`x-copilot.ts:2138`) filters `ownStats` to today's posts and sums `views`. The strip renders the fact line only when `ownStats !== undefined`. On boot, `ownStats` is seeded from cache (`X_MY_POSTS_KEY`) with no fetch — the fetch is deferred to dock-open to save budget.

**Persistence.** `replyLog` (key `X_REPLY_LOG_KEY`) and `ideaQueue` hold the score inputs; `ownStats` is in-memory, backed by the `X_MY_POSTS_KEY` cache (60-min stats TTL / 24-hr de-dupe-text TTL). The momentum score itself is recomputed live on every render and never stored.

## What is honest about it / limits
- **Measured vs proxy.** The "◷ N posts · X views" line is a *measured* X-reported fact, surfaced neutrally — never colored, never celebrated, and (the keystone) it **never feeds the score**. The momentum score is a *behavioral discipline proxy*: it measures your replying/posting cadence and consistency, not reach or outcome. (The OUTCOME half lives in the insights panel: `accountTrend`'s week-over-week "Picking up / Steady / Cooling" read over measured per-post results — see learning-loop.md.)
- **The "show up" chain row (`activity.ts`, unit-tested)** sits under the meter: 14 measured heat dots (Goobi replies + shipped posts per day), a 🔥 N-day chain (today gets grace; the flame flips to ⏸ at easeoff — it NEVER cheers past the safety line), and ONE contextual callout picked by deterministic priority (easeoff → measured trend → show-up/mix nudges → the timing lever). Every callout names its evidence class in the tooltip (measured vs algo-prior), and none claims a literal streak bonus — the honest mechanism is repeat-engagement affinity + account reputation. The reply count is a proxy too — it counts replies you sent *through Goobi*; native replies aren't seen (the chip tooltip says "pace your native ones too").
- **Saturation + anti-volume keystone.** `volume` saturates at `PACE_TARGET = 8`, so more replies past target cannot raise the score (unit-tested: at8 === at25). The meter is *structurally incapable* of rewarding unsafe volume.
- **Pace keystone / single source of truth.** The score reads its safety verdict from the same `replyPaceStatus()` the pace chip and Goobi mood use, so they cannot contradict. Past ease-off the meter is forced to red, lower-capped "overheating"; caution is capped amber. A local reset changes the baseline, not X activity or the daily momentum inputs.
- **What it cannot know / does not do:** it doesn't know native (non-Goobi) replies, can't show views without a configured `@handle` + a successful budgeted API fetch (degrades silently to no fact line or stale data — `fetchOwnData` is best-effort and never throws), and views are stale-by-design (~hourly on dock-open, not live, per the tooltip). It makes no LLM call and writes nothing to score it.

## Key files
- `src/lib/momentum.ts` — pure `computeMomentum` + the `COPY` table, `PACE_TARGET`/bonus/streak/recency constants, and the safety override. The single source of the score math, copy, and colors.
- `src/content/x-copilot.ts` — the strip in `renderDock` (~3057), the input helpers `repliesToday` (716), `replyStreak` (1644), `postedToday` (2145), `ownViewsToday` (2138); the stats pipeline `refreshOwnStats`/`fetchOwnData`/`ownStats` (2102–2135); dock-open trigger in the launcher `onclick` (3002).
- `src/lib/reply-hygiene.ts` — `replyPaceStatus`, lane/recency weights, and shared 8/12 adaptive pressure thresholds.
- `src/lib/twttr.ts` — `OwnPost` shape + `pickOwnPostsWithStats` (parses real views/postedAt from the X-data response).
- `scripts/test-momentum.mjs` — unit tests for `computeMomentum`.

## Before you change it
- **The safety override is load-bearing, not cosmetic.** `easeoff → overheating, capped low` and `caution → capped ≤74, amber` are asserted in `scripts/test-momentum.mjs`, along with cold/peak banding, volume saturation, and the cooling state. `computeMomentum` is pure and fully covered there; the `renderDock` wiring and the API stats path are **not** unit-tested.
- **Keep `repLevel` sourced from shared `replyPaceStatus`.** The meter uses adaptive recent pressure for safety but `repliesToday()` for the bar; do not conflate them or clear the daily tally on a pace reset.
- **Never let views (or any X-reported metric) into the score.** They are deliberately a separate, uncolored fact line gated on `ownStats !== undefined`. Feeding reach into the score breaks the "discipline mirror, not reach promise" contract.
- **Budget discipline.** `refreshOwnStats`/`fetchOwnData` make exactly one `from:<handle>` `search-v3` call per dock-open *only when the 60-min stats cache is cold*, and `refreshOwnStats` is intentionally fired before `maybeRunDailyLearn` so the learn pass consumes the warm cache instead of double-billing the API. Preserve that ordering. The fetch is skipped on boot by design.
- **Gotchas:** `ownStats` is in-memory and only triggers a re-render when it actually changes (object identity `before !== after`); `postedToday()` reads `ideaQueue` status `"posted"`, distinct from replies. Note `postedStreak()` is a *different* signal — it powers the "🔥 N-day" badge on the Post-ideas tab (`renderDock` ~2939), **not** the momentum strip, which uses `replyStreak()`. All day boundaries use local-midnight `dayKey()`.
