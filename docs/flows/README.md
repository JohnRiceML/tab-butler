# Goobi — flow docs center

How each **flow** of the Goobi X (Twitter) extension actually works — the user-facing path and the under-the-hood pipeline, grounded in the real code. Start here when you (or an agent) need to understand or change a feature.

Companion to [../SYSTEM.md](../SYSTEM.md) (the "where things live" map) and [../../CHANGELOG.md](../../CHANGELOG.md) (the phase/feature history). SYSTEM.md tells you *which file*; these docs tell you *how the flow works end to end*.

Every doc follows the same template: **What it does for the user → How the user uses it → How it works (the pipeline) → What's honest / limits → Key files → Before you change it.**

## The flows

### Core surfaces — the five dock modes
- [Reply spots](reply-spots.md) — the core copilot: scan the feed → Claude scores reply-worthiness → badge the good ones → draft a reply in your voice → copy it and open the exact post for a manual paste/review/post.
- [Comments / Tend your threads](tend-threads.md) — the warmest queue: reply to people who already replied to or mentioned you, freshest first, with exact completion matches and manual done.
- [Post ideas](post-ideas.md) — remix the patterns over-performing in your niche into original posts in your voice, with an honest virality band anchored to the source's real rank.
- [DM workspace](dms.md) — turn evidenced relationships or researched targets into deliberate sponsor, backlink, connection, co-marketing, customer, or partner conversations; draft-only, manually tracked, and never bulk-sent.
- [Account growth loop](growth-loop.md) — run one 14-day reason-to-follow experiment across the profile, posts, and replies; compare it with the prior window; then double down, tighten, or shake it up without pretending correlation proves causation.

### Relationship context — one secondary accordion row
The two analytical surfaces below stay behind Relationships in the Replies workspace. The actionable
Threads queue graduated out of this accordion into the primary **Comments** workspace.
- [Learning loop — "Who you show up with"](learning-loop.md) ("Your circle" tab) — which accounts your replies do well with, measured via a daily reply-engagement pass and attributed to the parent account.
- [Reciprocity — "Who shows up for you"](reciprocity.md) ("Supporters" tab) — who replies to / mentions you (harvested from your notifications), fused into mutual / fan labels, with an anti-pod guard.

### Insight strip — read-only, always visible
- [Warm-up / momentum meter](momentum.md) — the "Today strip" at the top of the dock: your daily account momentum from real activity; peaks at a *healthy* pace, never rewards unsafe volume. Carries the **daily-cadence coach** (the balance of replies + a spaced original).

### Cross-cutting
- [Account safety (pace + reputation)](account-safety.md) — the hourly-volume / repeat-author / duplicate guards and the honest-mirror keystone (Goobi never celebrates a reply past the pace line).
- [X-data API + budget governor](x-data-api.md) — the BYO-key RapidAPI (twitter241) integration, the parsers, and the byte-meter + token-bucket budget governor.
- [Target accounts + suggestions](targets.md) — optional cold discovery under Replies → Find people; useful after warm comments and high-fit reply spots are handled, not a peer to them in the main navigation.
- [Voice + profile (the popup)](voice-and-profile.md) — where the handle, follower count, niche, voice, and products are set, and how they feed every other flow.
- [Daily goals + SOUL.md](daily-goals-and-soul.md) — the always-visible Replies / Posts / DM-people scorecard and the user-owned beliefs/themes/boundaries creative brief.
- [Goobi the pixel-pet + playground](goobi-pet.md) — the mascot, its moods (driven by real signals), and the in-dock feed-and-play loop.

## How to use these (for agents)
- "How does *X* work / where does *X* live?" → the flow doc above, then `file:function` references inside it.
- Before changing a flow, read its **Before you change it** section — it lists the load-bearing assumptions and what is (and isn't) unit-tested.
- The honesty keystone runs through every flow: draft-only, no fabricated metrics, measured-vs-inferred is always labeled. The 2026 assumptions audit (see CHANGELOG) is the latest validation of these claims.
