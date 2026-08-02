# Account growth loop

## What it does for the user

The **Growth** dock mode sits above Replies, Post ideas, Targets, and DMs. It turns those execution tools into one account-level editorial learning cycle:

1. Choose one reason people should follow the profile.
2. Hold that strategy for a full 14-day editorial run.
3. Tag the replies and published ideas created during that test.
4. Compare follower pace and post outcomes with the immediately preceding window.
5. Record an observational editorial read: **Double down**, **Tighten one lever**, **Shake it up**, or **Keep collecting**.

These labels are planning prompts, not causal findings. Goobi can show what moved during the same period; it cannot prove that the strategy produced that movement.

It also audits the profile conversion surface: the promise in the bio, believable proof, the display name/banner, and whether the pinned post is competitive with the account's stronger recent posts.

## The five strategy bets

- **Proof-led authority** — concrete results, artifacts, and case studies.
- **Useful operator** — tactics, checklists, teardowns, and decisions people can apply.
- **Builder story** — progress, decisions, setbacks, and lessons worth following over time.
- **Community catalyst** — thoughtful questions, synthesis, peer support, and follow-through.
- **Distinct point of view** — a recognizable, constructive claim supported by evidence.

Only one bet can be active at a time. Starting a test gives the profile, posts, and replies one short playbook. While it is active, Post ideas asks for three of five ideas that execute the bet and keeps two exploratory. That makes the experiment coherent without turning the strategy into a creative prison.

## How the measurement works

`growth-loop.ts` stores account-scoped daily follower observations and the latest real metrics for originals returned by the existing own-post fetch. Posts are assigned to windows by their real `postedAt`; follower observations have a separate `followerAt`, so refreshing an old post cannot make an old follower count look recent.

The current run is compared with an equally long window immediately before it. The evaluator can compare:

- follower change per observed day;
- median views per measured original;
- median engagement per original (likes + reposts + replies).

No directional read is issued before the full planned window ends. Ending a run early freezes **Keep collecting**, even when the interim numbers look strong. A completed read also requires execution Goobi can verify: two on-strategy posts, eight confirmed replies, or one post plus three replies. This gate proves only that relevant work happened during the run; it does not prove the work caused the outcome.

Follower pace is comparable only when each window has at least two observations spanning at least seven days. Post outcomes require at least three posts in each window and use per-post medians for the directional read, so one breakout or collapse cannot crown or reject a strategy by itself. The UI can still show arithmetic per-post averages as descriptive totals.

Changes of roughly 20% remain a directional product threshold, not a significance test. Views and engagement come from the same posts, so they are treated as one post-outcome family rather than two independent votes. **Double down** or **Shake it up** requires follower pace and the post family to move in the same direction. A single available family, flat results, or disagreement produces the conservative **Tighten one lever** read. Completed outcomes and their observed evidence remain visibly available with dates and execution counts.

A zero remains a real result. When both windows are zero, it stays in the comparison. When the prior value is zero and the current value is nonzero, Goobi shows the absolute `0 → value` movement but does not invent a finite percentage or let that row vote on the direction.

Reply-angle and post-shape callouts reuse the existing Bayesian/sample-gated learning helpers. They only appear when enough tagged outcomes have settled.

## What is honest / limits

- Goobi does **not** receive X profile-click analytics. Every result is described as observed co-movement, not proof that a strategy caused growth.
- Zero is a real measurement: a zero-view or zero-engagement post stays in the denominator instead of disappearing as missing data.
- A marked or text-matched published idea is tagged to the strategy active at its actual publish time. Replies are tagged when handed off and only confirmed replies count in the execution total.
- Window metrics include every captured original published during the dates, not only tagged ideas. The tags establish execution; they do not isolate the strategy from exploratory posts, topic choice, outside activity, or other concurrent changes.
- Posts published near the end of the run may have had less time to accumulate outcomes than older baseline posts. The comparison is a practical snapshot, not a fixed-age experiment.
- The loop does not automatically send, publish, follow, or DM. Its only model-side behavior is an explicit strategy brief in a user-triggered Post ideas generation.
- It adds no new RapidAPI endpoint or polling loop. It reuses follower observations, own-post results, reply outcomes, and local profile inspection that Goobi already collects.
- Growth history and profile findings are account-bound and device-local. If the configured handle differs from the signed-in X session, capture stops instead of mixing accounts.
- Fourteen days is a practical editorial window, not a claim that seasonality, topic selection, distribution changes, regression to the mean, or outside activity have been controlled.

## Key files

- `extension/src/lib/growth-loop.ts` — store, merging, snapshots, strategy catalog, windows, and decisions.
- `extension/src/content/x-copilot.ts` — Growth UI, lifecycle, action tagging, profile findings, and Post ideas strategy handoff.
- `extension/src/lib/claude-client.ts` — adds the active strategy brief to user-triggered idea generation.
- `extension/scripts/test-growth-loop.mjs` — pure model and edge-case tests.

## Before you change it

- Keep growth state account-scoped. Never merge one handle's experiment memory into another.
- Preserve the separate follower observation timestamp; post-stat refresh time is not account-observation time.
- Do not remove the full-window/minimum-data gates or turn observational deltas into causal copy.
- Preserve the exploratory idea quota unless a measured test shows a better exploration/exploitation balance.
- Any new external metric or recurring fetch must be budgeted and documented in the X-data flow before it affects a recommendation.
