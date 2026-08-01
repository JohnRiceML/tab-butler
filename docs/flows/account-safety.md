# Account safety (pace + reputation)

> Goobi's anti-spam guardrail: a cross-session reply-reputation log that watches your hourly pace, reply spread, and duplicate text, and refuses to celebrate when you cross its conservative internal pause line.

**Surface:** Ambient on x.com — the live **pace chip** + **momentum strip** in the dock header (Replies tab) and the **ease-off lock** on the Targets tab; mirrored as the **"Account safety"** panel in the extension popup. Goobi's face reflects the same status everywhere.

## What it does for the user
X penalizes *patterns*, not single replies, and the penalty sticks to your account's reputation (suppressing reach ongoing, not just one reply). Goobi tracks every reply it helps you send and warns when you're trending toward the three things X reads as a bot: too many replies an hour, hammering the same author, or copy-pasted text. The protection is deliberately *visible* — a colored pace chip, a momentum meter, and a popup panel — rather than silent plumbing, so you trust that it's working. The keystone is honesty: the moment you cross the line, Goobi stops cheering and tells you to ease off, the targeting tools lock for a few minutes, **and the ambient scan pauses too** — `scan()` stops queueing/scoring new posts entirely (surfacing more reply spots while you should cool down would be the opposite of the mirror). Analysis resumes when the hour cools, or via an explicit ⟳ Rescan (a 2-minute override window); Find spots stays manual-only and unaffected.

## How the user uses it
1. By default, your click stays on the current page when the exact post is visible, activates that post's Reply control, verifies the draft in X's composer, and records nothing until **Mark as posted** or **Mark replied**. Only off-page opportunities need an exact-status handoff. An occupied composer is never overwritten. The legacy **Like + insert reply** helper is explicit opt-in for on-page posts, records a successful assisted fill as pending, and never applies to Fresh reach.
2. The dock header shows a live **pace chip** using Goobi's conservative product guardrails: green `● healthy pace` (<6/hr), amber `● pace yourself` (6–9), red `● ease off` (≥10). Hovering shows the exact count and states that X publishes no guaranteed safe hourly rate.
3. Just under it, a **momentum strip** fills as you build a steady daily rhythm — but it saturates at a healthy target and turns red "Too hot — ease off" once you cross the line, never showing "max" for going too fast.
4. Before drafting, each reply spot checks the last confirmed reply to that author. A reply within 24 hours substantially lowers all three recommendation lanes; one within 72 hours lowers them less. The feed pill, queue card, expanded score, and draft panel all call this out visibly.
5. After you explicitly mark a manually handed-off reply as posted, you may get a one-line **nudge toast** (duplicate reply, hourly volume, or repeat-author).
6. On the **Targets** tab, if you're past the line, a warning banner appears and the Track / Find-post / Draft buttons are disabled for a few minutes.
7. Opening the **popup** shows the full "Account safety" panel: status pill, pace bar with Goobi's 6/hr caution line marked, accounts-spread count, clean-replies note, and the manual-reply note.
8. Goobi's face goes `worn` ("Let's ease off") at the line — in the dock and the popup header — instead of his usual reply cheer.

## How it works
The trigger is any recorded assisted reply. A successful Like + insert calls `recordReplyAndNudge` immediately with an unconfirmed record; the exact-post review handoff records nothing until **Mark as posted**, and the separate "Mark replied" queue action uses `recordSentReply("", o)` as a manual confirmation. All recorded paths update the per-author timestamp consumed by `recommendationFor` → `repeatAuthorWarning`, so the next opportunity for that author is downranked and labeled before drafting.

Data flow and persisted state — the cross-session `replyLog: ReplyLog` (`x-copilot.ts:705`, persisted to `chrome.storage.local` under `X_REPLY_LOG_KEY` = `"xReplyLog"` on every record):
- `times: number[]` — reply timestamps, trimmed to a rolling hour. `recordSentReply` (`:955`) filters to the last hour then pushes `now`. `repliesLastHour()` (`:1641`) recomputes the count on demand. This is the hourly-pace counter.
- `authors: Record<handle, lastAt>` — drives the repeat-author spread guard (`AUTHOR_REPEAT_TTL` = 3 days).
- `drafts: {norm,at}[]` — recent `normalizeReply`-ed texts for the duplicate guard (`DRAFT_TTL` = 24h, capped `DRAFT_MAX` = 50).
- `daily`, `total`, `sent[]` — per-day tally, all-time count, and the `SentRecord` feature log (capped `SENT_MAX` = 500).

Record-time hygiene logic lives in `reply-hygiene.ts`:
- `reputationStatus(repliesThisHour)` → `{level,label}` on the conservative `REPLY_SOFT_PER_HOUR`=6 / `REPLY_HARD_PER_HOUR`=10 lines. **Single source of truth** read by the pace chip, the momentum strip, Goobi's mood, the Targets lock, and the popup.
- `normalizeReply` → `jaccard` → `isDuplicateReply` (exact match or ≥0.7 token overlap).
- `replyQualityWarning` — empty-praise / too-short / emoji-only gate (returns a reason, never blocks).
- `pickReplyNudge` — picks ONE nudge by priority: duplicate > hourly volume > repeat-author.

`recordReplyAndNudge` computes `duplicate`/`repeat` against the log, updates `authors`+`drafts`, then returns `pickReplyNudge(...)`, which the successful insert or explicit fallback confirmation surfaces as a toast.

Pre-draft account-spread logic lives in `reply-recommendation.ts`: `repeatAuthorWarning` derives the visible age/severity from the persisted author timestamp, and `recommendReply` applies its diversity factor to discovery, relationship, community, and therefore priority. The recent-author caution is inserted first so other evidence warnings cannot hide it.

The momentum strip (`x-copilot.ts:3057`) calls `computeMomentum` (`momentum.ts`) with `repLevel: stt.level` (the **same** `reputationStatus` the chip read). `computeMomentum` scores volume (saturates at `PACE_TARGET`=8), posts, streak, and live-recency, then applies a **safety override**: `easeoff` → forced "overheating" (red, capped ≤60); `caution` → capped ≤74, amber. Real X views ride beside it as a neutral fact (`ownViewsToday`), never feeding the score.

Goobi's mood (`goobiMood`, `:1676`) returns `"worn"` when `repliesLastHour() >= REPLY_HARD_PER_HOUR`. `recordSentReply` only fires the `goobiReactLove` cheer when `repliesLastHour() < REPLY_HARD_PER_HOUR` — past the line he stays woozy.

The Targets lock (`buildTargets`, `:2823`): `const locked = reputationStatus(repliesLastHour()).level === "easeoff"` → warning banner + every action button `disabled = locked`.

The popup (`popup.ts`) reads `X_REPLY_LOG_KEY` directly, recomputes `repliesThisHour` from `log.times`, derives `accountsToday` from distinct `sent[].author`, and renders `accountSafetyHTML` from the same `reputationStatus`. The popup header Goobi sets `worn` when `safety.level === "easeoff"`.

No API or Claude calls are involved in the safety logic itself — it is pure local computation over the persisted log. (The reply *drafting* it gates is Claude-backed elsewhere; safety adds zero model cost.)

## What is honest about it / limits
- **Measured locally:** successful Like + insert attempts plus replies explicitly confirmed through **Mark as posted** or **Mark replied**. Every counted attempt flows through `recordSentReply`, which pushes onto `replyLog.times` and updates the per-author timestamp. Verified analytics separately distinguish provider/manual confirmations from pending insert attempts.
- **Cannot know / explicitly NOT counted:** replies you type natively on X without going through Goobi. The code says so directly — the pace chip tooltip ("this counts your Goobi replies, so pace your native ones too") and the Targets footer ("Goobi can't count replies you post directly on X, so keep your own pace"). So the true pace can be *higher* than what's shown; the guard is a floor, not a ceiling.
- **Product guardrails / inferred:** the 6 and 10/hr lines are deliberately conservative Goobi choices, not X limits; X publishes no guaranteed safe hourly rate. The ≥0.7 Jaccard duplicate threshold and `replyQualityWarning` are also protective heuristics. `accountsToday` is "distinct authors in today's sent log", a spread proxy, not a reputation read from X.
- **The honest-mirror keystone:** the system is structurally incapable of rewarding unsafe volume. `momentum.ts` saturates the volume term at `PACE_TARGET` ("more stops paying") and the `easeoff` override forces "overheating" with a *lower* score and red — never "max". Crucially, momentum, the pace chip, Goobi's `worn` mood, the Targets lock, and the popup all read the *same* `reputationStatus`, so they can never contradict each other. Goobi refuses to fire his reply cheer past the line.
- **Never auto-posts:** the default uses X's official composer and requires manual confirmation. Legacy Like + insert is explicit opt-in and cannot run for Fresh reach; even there it never submits. None of the safety surfaces nudge you to post; they only ever tell you to slow down.
- The warnings are advisory: `repeatAuthorWarning`, `pickReplyNudge`, and `replyQualityWarning` lower priority or warn, but never prevent the user-clicked reply flow.

## Key files
- `extension/src/lib/reply-hygiene.ts` — pure record-time reputation logic: `reputationStatus`, `normalizeReply`/`jaccard`/`isDuplicateReply`, `replyQualityWarning`, `pickReplyNudge`, the conservative 6/10 constants. Unit-tested.
- `extension/src/lib/reply-recommendation.ts` — pure pre-draft account-spread scoring and the structured recent-author warning. Unit-tested.
- `extension/src/lib/momentum.ts` — `computeMomentum` + the safety override (the honest-mirror keystone). Unit-tested.
- `extension/src/content/x-copilot.ts` — the `replyLog` store + persistence, `recordSentReply`/`recordReplyAndNudge`/`logSentReply`, `repliesLastHour`, the dock pace chip + momentum strip (`renderDock`), Goobi mood (`goobiMood`/`goobiReactLove`), the Targets ease-off lock (`buildTargets`).
- `extension/src/popup/popup.ts` — `accountSafetyHTML` + the read of `X_REPLY_LOG_KEY` into the `safety` view-model.
- `extension/src/lib/config.ts` — `X_REPLY_LOG_KEY` (`"xReplyLog"`), `X_TARGETS_KEY`.

## Before you change it
- **`reputationStatus` is the single source of truth.** The pace chip, momentum strip, Goobi's `worn` mood, the Targets lock, and the popup panel ALL read it. The momentum strip and pace chip deliberately pass the *same* `stt`/`repLevel` value so they can never disagree. The popup imports the same soft/hard constants for its marker and denominator; do not hardcode a second threshold.
- **`recordSentReply` is the one funnel.** Anything that should count toward pace and same-author recency must route through it. Successful Like + insert counts immediately; copy/open counts only after explicit posted/replied confirmation. Adding a reply path without calling it silently under-counts.
- **The honesty guards are load-bearing, not cosmetic.** The momentum saturation + `easeoff`/`caution` overrides and the `repliesLastHour() < REPLY_HARD_PER_HOUR` gate on Goobi's cheer are what make this an honest mirror. Don't "improve engagement" by letting the meter hit 100 or Goobi cheer past the line — that's the explicit anti-pattern called out in `momentum.ts` and `recordSentReply`'s comment.
- **Unit-tested vs not:** `reply-hygiene.ts` (`scripts/test-hygiene.mjs`) and `momentum.ts` (`scripts/test-momentum.mjs`) are pure + covered (also `test-pacing.mjs`, `test-policy.mjs`, `test-targets.mjs`). The DOM wiring in `x-copilot.ts` and the popup HTML are **not** unit-tested — verify those by hand.
- **`SentRecord.outcome` is reserved, not wired** — the "what's working" learning loop is not implemented; don't assume outcome data exists.
- **`times` is a rolling-hour window trimmed on write**, so a stale tab that hasn't recorded recently can show a slightly high count until the next render recomputes via `repliesLastHour()`. Persistence is per-write to `chrome.storage.local`; multiple x.com tabs sync via the storage `onChanged` listener.
