# Tend your threads

The action queue for the single highest-value move Goobi didn't used to cover: **answering the people who replied to you**, while their thread is still alive.

Companion surface to [reciprocity](reciprocity.md) (which *maps* who shows up for you); this one turns the same harvest into a *to-do list*.

## What it does for the user

Surfaces the people who replied to or @-mentioned you recently, freshest first, with a one-click **Reply →** that opens their reply on X so you can respond in-thread. A header count ("3 to tend") tells you how many are still waiting.

Why it matters (grounded in the open-sourced 2026 ranker): **author-engaged replies are the highest-ordered action in every evidence class**, and `dedup_conversation_filter` promotes the single liveliest branch of a conversation to For You — so answering a reply keeps the thread alive *and* is exactly the interaction the ranker rewards. Practitioner consensus is unanimous too: answer your repliers within the hour.

## How the user uses it

- It's a panel in the dock, **open by default** (it's a to-do, not a read-only insight). Collapses like the others.
- Each row: avatar (tap → their profile), @handle, a live/fresh badge, their reply snippet, how long ago, and **Reply →** (opens the thread; Goobi never posts for you).
- Rows you've likely already answered sink to the bottom and show a soft "likely tended" tag.
- It only appears when there's something recent to tend — no empty state.

## How it works (the pipeline)

1. **Harvest (existing, $0).** On `/notifications` and `/notifications/mentions`, `scanNotifications` already captures every inbound reply/mention as an `EngagedRecord` (handle, time, follower count, avatar, name, status id). This flow added one field: the **reply text snippet** (`outerText`, ≤240 chars), captured at scan time.
2. **Rank (pure, `threads.ts` → `rankThreads`).** Filters to reply/mention within a 3-day window, scores each by `tendPriority = freshness (6h half-life, dominant) × replier-reach (mild log lift) × kind (reply > mention)`, flags "tended" via a lossy handle+time join against your sent-reply log (a Goobi reply to that handle within 48h *after* they engaged you), sinks tended below untended, caps one handle at 2 rows, returns the top 8.
3. **Render (`x-copilot.ts` → `renderThreadsPanel`).** Draws the panel; **Reply →** opens `x.com/{handle}/status/{postId}` in a new tab.

## What's honest / limits

- **No parent-thread id.** The notifications DOM doesn't tell us *which of your posts* a reply is on, so rows are "so-and-so replied to you", never grouped by post. Stated in the footer.
- **"Tended" is a lossy guess.** It's a handle+time inference (same caveat class as learn-stats' `authorReplied` join) — it can mis-flag if you replied to that person on a *different* post. It's a soft de-emphasis, never a hard "answered", and the tag says so.
- **Freshest-first is deliberate.** A live thread is where a reply still travels; a cold one (outside the 3-day window) is dropped entirely rather than shown as stale busywork.
- **Draft-only.** Reply → *opens* the thread; you write and send in your own words. No auto-post (product invariant).
- Notifications stay on the device (same as reciprocity).

## Key files

- `src/lib/threads.ts` — `rankThreads`, `tendPriority`, freshness/age labels (pure; `scripts/test-threads.mjs`).
- `src/content/x-copilot.ts` — `scanNotifications` (now captures the text snippet), `renderThreadsPanel`, `threadsOpen`.
- `src/lib/supporters.ts` — `EngagedRecord` gained the optional `text` field.

## Before you change it

- The harvest is shared with [reciprocity](reciprocity.md) — don't break `EngagedRecord`'s shape or the `key` dedup.
- Keep "tended" soft. If you ever get a real thread id, you can group by post *and* tighten the answered signal — until then, do not upgrade the copy to claim certainty.
- The ranking is a prior (freshness/reach weights are reasoned, not calibrated). It's unit-tested at the pure-function level; there's no live eval for it (it ranks an action list, it doesn't generate content).
