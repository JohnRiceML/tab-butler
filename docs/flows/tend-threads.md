# Comments — tend your threads

The action queue for the single highest-value move Goobi didn't used to cover: **answering the people who replied to you**, while their thread is still alive.

Companion surface to [reciprocity](reciprocity.md) (which *maps* who shows up for you); this one turns the same harvest into a *to-do list*.

## What it does for the user

Surfaces the people who replied to or @-mentioned you recently, freshest first, with a one-click **Reply →** that opens their reply on X so you can respond in-thread. The primary **Comments** tab carries the open count.

Why it matters (grounded in the open-sourced 2026 ranker): **author-engaged replies are the highest-ordered action in every evidence class**, and `dedup_conversation_filter` promotes the single liveliest branch of a conversation to For You — so answering a reply keeps the thread alive *and* is exactly the interaction the ranker rewards. Practitioner consensus is unanimous too: answer your repliers within the hour.

## How the user uses it

- It is the **Comments** workspace in the main dock navigation because warm replies should be handled before cold Target discovery.
- The workspace shows up to the freshest 20 rows in its own scroll area. Targets remains available from Replies → **Find people**.
- Each row: avatar (tap → their profile), @handle, the age (colored green while the thread is still live — freshness rides on the timestamp, no separate badge), their reply snippet, a **✓** (mark done), and **Reply →** (opens the thread; Goobi never posts for you).
- **✓ Mark done** — an explicit "handled" that removes the row from the queue and the count (persisted device-local under `X_THREADS_DONE_KEY`, synced across tabs, pruned to the live harvest so it can't grow unbounded). Distinct from the lossy auto-"tended" guess below: done is a hard user signal, "tended" only sinks a row. Marking done does NOT touch the reciprocity panel — the person still counts as having engaged you.
- Rows you've likely already answered (the auto-guess) sink to the bottom and show a soft "likely tended" tag.
- Its empty state explains that the queue comes from the X notifications page and offers **Open X notifications**. Goobi does not read the private DM inbox.

## How it works (the pipeline)

1. **Harvest (existing, $0).** On `/notifications` and `/notifications/mentions`, `scanNotifications` already captures every inbound reply/mention as an `EngagedRecord` (handle, time, follower count, avatar, name, status id). This flow added one field: the **reply text snippet** (`outerText`, ≤240 chars), captured at scan time.
2. **Exact completion + rank.** The existing RapidAPI `user-replies-v2` pass now preserves each own reply's direct parent tweet ID. If that parent equals an inbound notification status ID, the row clears automatically—an exact join with no new endpoint or request. `rankThreads` then filters to reply/mention within a 3-day window, scores by `tendPriority = freshness (6h half-life, dominant) × replier-reach (mild log lift) × kind`, keeps the older lossy handle+time "likely tended" signal only for unmatched rows, and caps one handle at 2 rows.
3. **Render (`x-copilot.ts` → `buildComments` / `renderThreadsPanel`).** Draws the top-level workspace; **Reply →** opens `x.com/{handle}/status/{postId}` in a new tab.

## What's honest / limits

- **Exact answered status, not full conversation reconstruction.** The notifications DOM still does not tell us which of your posts a reply is on, so rows are not grouped by root conversation. But when your own recent RapidAPI reply names the inbound status as its direct parent, Goobi safely clears that exact row. The provider returns only a recent window, so unmatched never means unanswered.
- **"Tended" is a lossy guess.** It's a handle+time inference (same caveat class as learn-stats' `authorReplied` join) — it can mis-flag if you replied to that person on a *different* post. It's a soft de-emphasis, never a hard "answered", and the tag says so.
- **Freshest-first is deliberate.** A live thread is where a reply still travels; a cold one (outside the 3-day window) is dropped entirely rather than shown as stale busywork.
- **Draft-only.** Reply → *opens* the thread; you write and send in your own words. No auto-post (product invariant).
- Notifications stay on the device (same as reciprocity).

## Key files

- `src/lib/threads.ts` — `rankThreads`, `tendPriority`, freshness/age labels (pure; `scripts/test-threads.mjs`).
- `src/content/x-copilot.ts` — `scanNotifications`, `buildComments`, and `renderThreadsPanel`.
- `src/lib/supporters.ts` — `EngagedRecord` gained the optional `text` field.

## Before you change it

- The harvest is shared with [reciprocity](reciprocity.md) — don't break `EngagedRecord`'s shape or the `key` dedup.
- Keep "tended" soft. If you ever get a real thread id, you can group by post *and* tighten the answered signal — until then, do not upgrade the copy to claim certainty.
- The ranking is a prior (freshness/reach weights are reasoned, not calibrated). It's unit-tested at the pure-function level; there's no live eval for it (it ranks an action list, it doesn't generate content).
## Ongoing connection memory

An exact completion also folds into `relationship-memory.ts`: notification `postId === ownReply.replyToId`. The compact, account-scoped store keeps only parent IDs and completion times (no post text), for up to 365 days. Two exact exchanges across two distinct calendar weeks establish an **↔ ongoing connection** chip when that author later appears naturally in the normal, already-qualified reply queue. This is display-only: it never creates candidates, changes fit/ranking, or recommends engagement repayment. Cross-tab stores union by exact parent ID, so reprocessing is idempotent and a stale tab cannot erase another tab's history.
