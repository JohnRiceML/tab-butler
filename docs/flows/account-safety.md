# Account safety (pace + reputation)

> Goobi's anti-spam guardrail: a cross-session reply-reputation log that watches your hourly pace, reply spread, and duplicate text, and refuses to celebrate when you cross X's automation line.

**Surface:** Ambient on x.com — the live **pace chip** + **momentum strip** in the dock header (Replies tab) and the **ease-off lock** on the Targets tab; mirrored as the **"Account safety"** panel in the extension popup. Goobi's face reflects the same status everywhere.

## What it does for the user
X penalizes *patterns*, not single replies, and the penalty sticks to your account's reputation (suppressing reach ongoing, not just one reply). Goobi tracks every reply it helps you send and warns when you're trending toward the three things X reads as a bot: too many replies an hour, hammering the same author, or copy-pasted text. The protection is deliberately *visible* — a colored pace chip, a momentum meter, and a popup panel — rather than silent plumbing, so you trust that it's working. The keystone is honesty: the moment you cross the line, Goobi stops cheering and tells you to ease off, and the targeting tools lock for a few minutes.

## How the user uses it
1. You reply through Goobi (Insert, or the clipboard fallback, or "Mark commented"). Each one is silently logged.
2. The dock header shows a live **pace chip**: green `● healthy pace` (<20/hr), amber `● pace yourself` (20–29), red `● ease off` (≥30). Hovering shows the exact count and that ~30/hr reads as automated.
3. Just under it, a **momentum strip** fills as you build a steady daily rhythm — but it saturates at a healthy target and turns red "Too hot — ease off" once you cross the line, never showing "max" for going too fast.
4. After certain inserts you get a one-line **nudge toast** (duplicate reply, hourly volume, or repeat-author).
5. On the **Targets** tab, if you're past the line, a warning banner appears and the Track / Find-post / Draft buttons are disabled for a few minutes.
6. Opening the **popup** shows the full "Account safety" panel: status pill, pace bar with the 20/hr line marked, accounts-spread count, clean-replies note, and the human-paced-actions note.
7. Goobi's face goes `worn` ("Let's ease off") at the line — in the dock and the popup header — instead of his usual reply cheer.

## How it works
The trigger is any recorded reply. `doInsert` (`x-copilot.ts`) calls `recordReplyAndNudge` → `recordSentReply`, which is the single funnel for every counted reply (Insert success, clipboard fallback when X blocks the insert, and the "Mark commented" button via `recordSentReply("", o)`).

Data flow and persisted state — the cross-session `replyLog: ReplyLog` (`x-copilot.ts:705`, persisted to `chrome.storage.local` under `X_REPLY_LOG_KEY` = `"xReplyLog"` on every record):
- `times: number[]` — reply timestamps, trimmed to a rolling hour. `recordSentReply` (`:955`) filters to the last hour then pushes `now`. `repliesLastHour()` (`:1641`) recomputes the count on demand. This is the hourly-pace counter.
- `authors: Record<handle, lastAt>` — drives the repeat-author spread guard (`AUTHOR_REPEAT_TTL` = 3 days).
- `drafts: {norm,at}[]` — recent `normalizeReply`-ed texts for the duplicate guard (`DRAFT_TTL` = 24h, capped `DRAFT_MAX` = 50).
- `daily`, `total`, `sent[]` — per-day tally, all-time count, and the `SentRecord` feature log (capped `SENT_MAX` = 500).

Pure logic lives in `reply-hygiene.ts`:
- `reputationStatus(repliesThisHour)` → `{level,label}` on the `REPLY_SOFT_PER_HOUR`=20 / `REPLY_HARD_PER_HOUR`=30 lines. **Single source of truth** read by the pace chip, the momentum strip, Goobi's mood, the Targets lock, and the popup.
- `normalizeReply` → `jaccard` → `isDuplicateReply` (exact match or ≥0.7 token overlap).
- `replyQualityWarning` — empty-praise / too-short / emoji-only gate (returns a reason, never blocks).
- `pickReplyNudge` — picks ONE nudge by priority: duplicate > hourly volume > repeat-author.

`recordReplyAndNudge` (`:977`) computes `duplicate`/`repeat` against the log, updates `authors`+`drafts`, then returns `pickReplyNudge(...)` which `doInsert` surfaces as the toast.

The momentum strip (`x-copilot.ts:3057`) calls `computeMomentum` (`momentum.ts`) with `repLevel: stt.level` (the **same** `reputationStatus` the chip read). `computeMomentum` scores volume (saturates at `PACE_TARGET`=8), posts, streak, and live-recency, then applies a **safety override**: `easeoff` → forced "overheating" (red, capped ≤60); `caution` → capped ≤74, amber. Real X views ride beside it as a neutral fact (`ownViewsToday`), never feeding the score.

Goobi's mood (`goobiMood`, `:1676`) returns `"worn"` when `repliesLastHour() >= REPLY_HARD_PER_HOUR`. `recordSentReply` only fires the `goobiReactLove` cheer when `repliesLastHour() < REPLY_HARD_PER_HOUR` — past the line he stays woozy.

The Targets lock (`buildTargets`, `:2823`): `const locked = reputationStatus(repliesLastHour()).level === "easeoff"` → warning banner + every action button `disabled = locked`.

The popup (`popup.ts`) reads `X_REPLY_LOG_KEY` directly, recomputes `repliesThisHour` from `log.times`, derives `accountsToday` from distinct `sent[].author`, and renders `accountSafetyHTML` from the same `reputationStatus`. The popup header Goobi sets `worn` when `safety.level === "easeoff"`.

No API or Claude calls are involved in the safety logic itself — it is pure local computation over the persisted log. (The reply *drafting* it gates is Claude-backed elsewhere; safety adds zero model cost.)

## What is honest about it / limits
- **Measured:** only replies Goobi itself handled — Insert, clipboard fallback, and "Mark commented". Every counted reply flows through `recordSentReply`, which pushes onto `replyLog.times`.
- **Cannot know / explicitly NOT counted:** replies you type natively on X without going through Goobi. The code says so directly — the pace chip tooltip ("this counts your Goobi replies, so pace your native ones too") and the Targets footer ("Goobi can't count replies you post directly on X, so keep your own pace"). So the true pace can be *higher* than what's shown; the guard is a floor, not a ceiling.
- **Proxy / inferred:** the 20 and 30/hr lines, the ≥0.7 Jaccard duplicate threshold, and the `replyQualityWarning` heuristics are X-behavior approximations ("X's automation-detection *neighborhood*"), not values X publishes. `accountsToday` is "distinct authors in today's sent log", a spread proxy, not a reputation read from X.
- **The honest-mirror keystone:** the system is structurally incapable of rewarding unsafe volume. `momentum.ts` saturates the volume term at `PACE_TARGET` ("more stops paying") and the `easeoff` override forces "overheating" with a *lower* score and red — never "max". Crucially, momentum, the pace chip, Goobi's `worn` mood, the Targets lock, and the popup all read the *same* `reputationStatus`, so they can never contradict each other. Goobi refuses to fire his reply cheer past the line.
- **Draft-only / never auto-posts:** the Targets path is draft-only ("Nothing posts on its own"); likes/follows are spaced with human delays + hourly caps (`FOLLOW_MIN_GAP_MS`, `FOLLOW_HOUR_CAP`) and `likePost`/`followAuthor` can only like/follow, never un-. None of the safety surfaces nudge you to post; they only ever tell you to slow down.
- The nudge is advisory: `pickReplyNudge`/`replyQualityWarning` "never hard-block the insert."

## Key files
- `extension/src/lib/reply-hygiene.ts` — pure reputation logic: `reputationStatus`, `normalizeReply`/`jaccard`/`isDuplicateReply`, `replyQualityWarning`, `pickReplyNudge`, the 20/30 constants. Unit-tested.
- `extension/src/lib/momentum.ts` — `computeMomentum` + the safety override (the honest-mirror keystone). Unit-tested.
- `extension/src/content/x-copilot.ts` — the `replyLog` store + persistence, `recordSentReply`/`recordReplyAndNudge`/`logSentReply`, `repliesLastHour`, the dock pace chip + momentum strip (`renderDock`), Goobi mood (`goobiMood`/`goobiReactLove`), the Targets ease-off lock (`buildTargets`).
- `extension/src/popup/popup.ts` — `accountSafetyHTML` + the read of `X_REPLY_LOG_KEY` into the `safety` view-model.
- `extension/src/lib/config.ts` — `X_REPLY_LOG_KEY` (`"xReplyLog"`), `X_TARGETS_KEY`.

## Before you change it
- **`reputationStatus` is the single source of truth.** The pace chip, momentum strip, Goobi's `worn` mood, the Targets lock, and the popup panel ALL read it. The momentum strip and pace chip deliberately pass the *same* `stt`/`repLevel` value so they can never disagree — if you recompute it independently anywhere, you break that invariant. Same for the constants 20/30; they live only in `reply-hygiene.ts` (`REPLY_SOFT_PER_HOUR`/`REPLY_HARD_PER_HOUR`) — the popup's `66%` pace-bar marker and `/30` denominator are hardcoded duplicates, so a constant change needs a manual popup edit.
- **`recordSentReply` is the one funnel.** Anything that should count toward pace must route through it (it's why "Mark commented" and the clipboard fallback both call it). Adding a new reply path without calling it silently under-counts.
- **The honesty guards are load-bearing, not cosmetic.** The momentum saturation + `easeoff`/`caution` overrides and the `repliesLastHour() < REPLY_HARD_PER_HOUR` gate on Goobi's cheer are what make this an honest mirror. Don't "improve engagement" by letting the meter hit 100 or Goobi cheer past the line — that's the explicit anti-pattern called out in `momentum.ts` and `recordSentReply`'s comment.
- **Unit-tested vs not:** `reply-hygiene.ts` (`scripts/test-hygiene.mjs`) and `momentum.ts` (`scripts/test-momentum.mjs`) are pure + covered (also `test-pacing.mjs`, `test-policy.mjs`, `test-targets.mjs`). The DOM wiring in `x-copilot.ts` and the popup HTML are **not** unit-tested — verify those by hand.
- **`SentRecord.outcome` is reserved, not wired** — the "what's working" learning loop is not implemented; don't assume outcome data exists.
- **`times` is a rolling-hour window trimmed on write**, so a stale tab that hasn't recorded recently can show a slightly high count until the next render recomputes via `repliesLastHour()`. Persistence is per-write to `chrome.storage.local`; multiple x.com tabs sync via the storage `onChanged` listener.
