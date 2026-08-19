# Account safety (pace + reputation)

> Goobi's anti-spam guardrail: a cross-session reply log that watches adaptive pace pressure, conversation warmth, reply spread, and duplicate text, and refuses to celebrate when pressure crosses its internal pause line.

**Surface:** Ambient on x.com — the live **pace chip** + **momentum strip** in the dock header (Replies tab) and the **ease-off lock** on the Targets tab; mirrored as the **"Account safety"** panel in the extension popup. Goobi's face reflects the same status everywhere.

## What it does for the user
X prohibits bulk, duplicative, irrelevant, or unsolicited reply patterns, but it publishes neither an account-reputation formula nor a guaranteed safe hourly reply rate. Goobi therefore uses local product heuristics: recorded pace, whether a reply is warm inbound/ongoing or cold discovery, recency, repeat-author concentration, and near-duplicate text. The protection is deliberately *visible* rather than silent plumbing. At Goobi's internal ease-off line, it stops cheering, pauses the ambient scan, and disables Targets actions. These are advisory product controls, not an X limit or account-level block: existing reply actions and native X remain available, ⟳ Rescan opens a two-minute scan override, and **Reset local pace meter** starts a new Goobi baseline without deleting reply history or claiming to reset X.

## How the user uses it
1. Your click copies the draft and records nothing until **Mark as posted** or **Mark replied**. If the exact post is not visible, Goobi only opens or focuses its exact status page. It never clicks Reply, likes, or writes into X's composer.
2. The dock header shows a live **pace chip** from Goobi's adaptive pressure: green below 8, amber from 8–11.9, red at 12+. A cold discovery reply has weight 1; warm inbound is 0.7, an ongoing connection 0.85, and community 0.95. Activity has full weight for 15 minutes, then decays linearly to zero by one hour. Hovering shows raw recorded replies and weighted pressure together.
3. Just under it, a **momentum strip** fills as you build a steady daily rhythm—but still turns red "Too hot — ease off" when the shared adaptive status reaches ease-off, never showing "max" for going too fast.
4. Before drafting, each reply spot checks the last confirmed reply to that author. A reply within 24 hours substantially lowers all three recommendation lanes; one within 72 hours lowers them less. The feed pill, queue card, expanded score, and draft panel all call this out visibly.
5. After you explicitly mark a manually handed-off reply as posted, you may get a one-line **nudge toast** (duplicate reply, adaptive pace pressure, or repeat-author).
6. On the **Targets** tab, if pressure is past the line, a warning banner appears and Track / Find-post / Draft are disabled until pressure decays or the user resets the local baseline.
7. The dock's ⋮ menu and popup Account safety card both expose **↺ Reset local pace meter**. Resetting preserves `times`, daily/all-time counts, `sent[]` outcomes, author recency, and duplicate text; it only writes a new `X_PACE_RESET_KEY` baseline. The UI explicitly says X activity, limits, and enforcement are unaffected.
8. Opening the **popup** shows raw replies, counted post-reset replies, warm-reply count, adaptive pressure, its 8/12 markers, and reset state.
9. Goobi's face goes `worn` ("Let's ease off") at the line—in the dock and popup header—instead of his usual reply cheer.

## How it works
The trigger is any confirmed reply. The copy/open handoff records nothing until **Mark as posted**, and the separate "Mark replied" queue action uses `recordSentReply("", o)` as a manual confirmation. All recorded paths update the per-author timestamp consumed by `recommendationFor` → `repeatAuthorWarning`, so the next opportunity for that author is downranked and labeled before drafting.

Data flow and persisted state — the cross-session `replyLog: ReplyLog` (`x-copilot.ts:705`, persisted to `chrome.storage.local` under `X_REPLY_LOG_KEY` = `"xReplyLog"` on every record):
- `times: number[]` — raw reply timestamps, trimmed to a rolling hour. They are never deleted by a pace reset.
- `authors: Record<handle, lastAt>` — drives the repeat-author spread guard (`AUTHOR_REPEAT_TTL` = 3 days).
- `drafts: {norm,at}[]` — recent `normalizeReply`-ed texts for the duplicate guard (`DRAFT_TTL` = 24h, capped `DRAFT_MAX` = 50).
- `daily`, `total`, `sent[]` — per-day tally, all-time count, and the `SentRecord` feature log (capped `SENT_MAX` = 500). New `SentRecord.lane` values let pace distinguish warm inbound/ongoing conversation from cold discovery.
- `X_PACE_RESET_KEY` = `"xPaceResetAt"` — separate scalar baseline. Keeping it outside the reply log lets the popup reset the meter without racing a ledger rewrite.

Record-time hygiene logic lives in `reply-hygiene.ts`:
- `replyPaceStatus(events, now, resetAt)` → raw count, post-reset count, warm count, weighted pressure, and `{level,label}` on the `REPLY_PACE_CAUTION`=8 / `REPLY_PACE_EASEOFF`=12 pressure lines. **Single source of truth** read by the pace chip, momentum strip, Goobi's mood, Targets lock, and popup.
- `replyPaceLaneWeight` → inbound 0.7, continue 0.85, community 0.95, discovery/unknown 1.0. Warm conversation is lower-pressure because X's published policy specifically emphasizes aggressive high-volume **unsolicited** replies; it is never zero-pressure.
- `replyPaceRecencyWeight` → full weight through 15 minutes, then smooth decay to zero at 60 minutes. A 30-second local timer refreshes the dock and resumes scanning when ease-off clears.
- `normalizeReply` → `jaccard` → `isDuplicateReply` (exact match or ≥0.7 token overlap).
- `replyQualityWarning` — empty-praise / too-short / emoji-only gate (returns a reason, never blocks).
- `pickReplyNudge` — picks ONE nudge by priority: duplicate > adaptive pace > repeat-author.

`recordReplyAndNudge` computes `duplicate`/`repeat` against the log, updates `authors`+`drafts`, then returns `pickReplyNudge(...)`, which explicit posted confirmation surfaces as a toast.

Pre-draft account-spread logic lives in `reply-recommendation.ts`: `repeatAuthorWarning` derives the visible age/severity from the persisted author timestamp, and `recommendReply` applies its diversity factor to discovery, relationship, community, and therefore priority. The recent-author caution is inserted first so other evidence warnings cannot hide it.

The momentum strip calls `computeMomentum` with `repLevel: stt.level` from the **same** `replyPaceStatus` snapshot the chip read. `computeMomentum` still applies the safety override: `easeoff` → forced "overheating" (red, capped ≤60); `caution` → capped ≤74, amber. Real X views remain a neutral fact and never feed the score.

Goobi's mood returns `"worn"`, and `recordSentReply` suppresses `goobiReactLove`, when `currentReplyPace().level === "easeoff"`.

The Targets lock and ambient poller read `currentReplyPace().level === "easeoff"` → warning banner + action buttons disabled + ambient polling paused.

The popup reads `X_REPLY_LOG_KEY` plus `X_PACE_RESET_KEY`, rebuilds the same lane-tagged pace events, and calls the shared pure `replyPaceStatus`. Its Reset button writes only the reset key. The popup header Goobi sets `worn` when `safety.level === "easeoff"`.

No API or Claude calls are involved in the safety logic itself — it is pure local computation over the persisted log. (The reply *drafting* it gates is Claude-backed elsewhere; safety adds zero model cost.)

## What is honest about it / limits
- **Measured locally:** replies explicitly confirmed through **Mark as posted** or **Mark replied**, plus later provider matches. Every counted reply flows through `recordSentReply`, which pushes onto `replyLog.times` and updates the per-author timestamp.
- **Cannot know / explicitly NOT counted:** replies you type natively on X without going through Goobi. The code says so directly — the pace chip tooltip ("this counts your Goobi replies, so pace your native ones too") and the Targets footer ("Goobi can't count replies you post directly on X, so keep your own pace"). So the true pace can be *higher* than what's shown; the guard is a floor, not a ceiling.
- **Product guardrails / inferred:** the 8/12 pressure lines, lane weights, and 15–60 minute decay are Goobi choices, not X limits. X publishes technical daily/semi-hourly limits but no guaranteed safe reputation pace. The ≥0.7 Jaccard duplicate threshold and `replyQualityWarning` are also protective heuristics. `accountsToday` is a spread proxy, not a reputation read from X.
- **Reset is scoped, not magical:** reset changes only which locally recorded timestamps contribute to Goobi's pressure. It does not delete the activity ledger, alter measured outcomes, clear duplicate/repeat-author guards, undo activity on X, reset technical limits, or promise safety. Native X replies remain invisible to Goobi.
- **The honest-mirror keystone:** the system is structurally incapable of rewarding volume past its own active product line. `momentum.ts` saturates volume and the shared `easeoff` status forces a lower red "overheating" score. Momentum, pace chip, Goobi mood, Targets lock, and popup all call the same `replyPaceStatus`, so they cannot disagree about Goobi's local status.
- **Manual engagement and submit:** every reply handoff is copy-only. The user clicks Reply, pastes, reviews, submits, and then confirms in Goobi. Ambient X DOM reading and the separate scripted Follow action remain private-use platform-policy considerations tracked in `docs/RELEASE-CHECKLIST.md`.
- **Advisory, not a universal hard block:** `repeatAuthorWarning`, `pickReplyNudge`, and `replyQualityWarning` lower priority or warn. At ease-off, Goobi suppresses celebrations, pauses ambient scanning, and disables Targets actions, but it does not prevent every existing reply/open/follow action, the explicit scan override, manual Find spots, or activity performed directly in X.

## Key files
- `extension/src/lib/reply-hygiene.ts` — pure adaptive pace/reputation logic: `replyPaceStatus`, lane/recency weights, `reputationStatus`, duplicate/quality checks, and 8/12 pressure constants. Unit-tested.
- `extension/src/lib/reply-recommendation.ts` — pure pre-draft account-spread scoring and the structured recent-author warning. Unit-tested.
- `extension/src/lib/momentum.ts` — `computeMomentum` + the safety override (the honest-mirror keystone). Unit-tested.
- `extension/src/content/x-copilot.ts` — the `replyLog` store + persistence, `recordSentReply`/`recordReplyAndNudge`/`logSentReply`, `currentReplyPace`, reset action, dock pace chip + momentum strip (`renderDock`), Goobi mood (`goobiMood`/`goobiReactLove`), and Targets ease-off lock (`buildTargets`).
- `extension/src/popup/popup.ts` — `accountSafetyHTML` + the read of `X_REPLY_LOG_KEY` into the `safety` view-model.
- `extension/src/lib/config.ts` — `X_REPLY_LOG_KEY` (`"xReplyLog"`), `X_PACE_RESET_KEY` (`"xPaceResetAt"`), `X_TARGETS_KEY`.

## Before you change it
- **`replyPaceStatus` is the single source of truth.** The pace chip, momentum strip, Goobi's `worn` mood, Targets lock/poller, nudge, and popup ALL read it. The popup imports the same soft/hard constants and pure function; do not hardcode a second model.
- **`recordSentReply` is the one funnel.** Anything that should count toward pace and same-author recency must route through it. Copy/open counts only after explicit posted/replied confirmation. Adding a reply path without calling it silently under-counts.
- **The honesty guards are load-bearing, not cosmetic.** The momentum overrides and `currentReplyPace().level !== "easeoff"` cheer gate make this an honest mirror. Reset must remain a baseline change only; never clear `times`, `sent`, `daily`, `authors`, or `drafts` from the reset action.
- **Unit-tested vs not:** `reply-hygiene.ts` (`scripts/test-hygiene.mjs`) and `momentum.ts` (`scripts/test-momentum.mjs`) are pure + covered (also `test-pacing.mjs`, `test-policy.mjs`, `test-targets.mjs`). The DOM wiring in `x-copilot.ts` and the popup HTML are **not** unit-tested — verify those by hand.
- **`SentRecord.outcome` is wired, but learning remains gated.** The RapidAPI measure pass matches recent real replies, writes provisional engagement/view outcomes, and freezes them after the settle window. Only frozen rows unlock the outcome dashboard; behavior-changing account multipliers and learned default angles remain behind `X_LEARN_LOOP_KEY`, default OFF until a real-data backtest validates the signal beyond this same-sample diagnostic.
- **`times` is a rolling-hour window trimmed on write.** Dynamic pressure recomputes from timestamps and `SentRecord.lane`; old records without a lane conservatively get full discovery weight. `X_PACE_RESET_KEY` syncs independently across tabs, and a 30-second local timer lets decay release ease-off even on a static page.
