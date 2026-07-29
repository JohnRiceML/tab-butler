# Account growth loop

## What it does for the user

The **Growth** dock mode sits above Replies, Post ideas, Targets, and DMs. It turns those execution tools into one account-level learning cycle:

1. Choose one reason people should follow the profile.
2. Hold that strategy for a 14-day test.
3. Tag the replies and published ideas created during that test.
4. Compare follower pace and post outcomes with the immediately preceding window.
5. Record a decision: **Double down**, **Tighten one lever**, **Shake it up**, or **Keep collecting**.

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

The current test is compared with an equally long window immediately before it. The evaluator can compare:

- follower change per observed day;
- views per measured original;
- engagement per original (likes + reposts + replies).

A read does not become directional until at least seven days have elapsed and at least one metric has a real comparison sample: two follower observations in each window, two measured originals in each window for views, or two originals in each window for engagement. It also requires execution Goobi can verify: two on-strategy posts, eight confirmed replies, or one post plus three replies. Ambient growth cannot award a strategy the user did not demonstrably execute. Changes of roughly 20% cast positive or negative votes; mixed evidence produces **Tighten**, clearly positive evidence produces **Double down**, and negative or flat completed evidence produces **Shake it up**. Completed outcomes and their evidence remain visibly available with dates and execution counts.

Reply-angle and post-shape callouts reuse the existing Bayesian/sample-gated learning helpers. They only appear when enough tagged outcomes have settled.

## What is honest / limits

- Goobi does **not** receive X profile-click analytics. It reports follower and post outcomes as co-movement, not proof that a strategy caused growth.
- Zero is a real measurement: a zero-view or zero-engagement post stays in the denominator instead of disappearing as missing data.
- A marked or text-matched published idea is tagged to the strategy active at its actual publish time. Replies are tagged when handed off and only confirmed replies count in the execution total.
- The loop does not automatically send, publish, follow, or DM. Its only model-side behavior is an explicit strategy brief in a user-triggered Post ideas generation.
- It adds no new RapidAPI endpoint or polling loop. It reuses follower observations, own-post results, reply outcomes, and local profile inspection that Goobi already collects.
- Growth history and profile findings are account-bound and device-local. If the configured handle differs from the signed-in X session, capture stops instead of mixing accounts.
- Fourteen days is a practical comparison window, not a claim that seasonality, topic selection, distribution changes, or outside activity have been controlled.

## Key files

- `extension/src/lib/growth-loop.ts` — store, merging, snapshots, strategy catalog, windows, and decisions.
- `extension/src/content/x-copilot.ts` — Growth UI, lifecycle, action tagging, profile findings, and Post ideas strategy handoff.
- `extension/src/lib/claude-client.ts` — adds the active strategy brief to user-triggered idea generation.
- `extension/scripts/test-growth-loop.mjs` — pure model and edge-case tests.

## Before you change it

- Keep growth state account-scoped. Never merge one handle's experiment memory into another.
- Preserve the separate follower observation timestamp; post-stat refresh time is not account-observation time.
- Do not remove the minimum-data gates or turn observational deltas into causal copy.
- Preserve the exploratory idea quota unless a measured test shows a better exploration/exploitation balance.
- Any new external metric or recurring fetch must be budgeted and documented in the X-data flow before it affects a recommendation.
