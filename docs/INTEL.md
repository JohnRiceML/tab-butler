# INTEL — the x-algorithm diff-watch

X open-sourced its production For You pipeline on **2026-01-20** at
[github.com/xai-org/x-algorithm](https://github.com/xai-org/x-algorithm) (Apache-2.0), with a
promised ~4-week update cadence. That repo is Goobi's highest-quality intelligence feed — every
heuristic this product encodes can be checked against actually-served code, while competitors
recycle 2023 weight tables as fact.

**The cadence promise is NOT holding** (one bulk update in the first ~6 months: Jan 20 drop →
May 15 CI-agent update). So this watch is **event-driven, not a monthly ritual** — a monthly
checklist would have fired empty ~5 times and died of boredom before the drop that matters.

## How to watch (pick one, ~zero effort)

- GitHub **Watch → Custom → Releases + Pushes** on `xai-org/x-algorithm`, or
- subscribe to the commits feed: `https://github.com/xai-org/x-algorithm/commits/main.atom`

When a real drop lands, run the checklist below (≈1 hour, usually much less). A Claude Code
session pointed at this file + the repo diff can do the read.

## The checklist — what to look for, and where each finding routes

Ordered by how much each would change Goobi. As of 2026-07-05 all four are **withheld/absent**;
any of them landing upgrades a "prior" label to code-fact somewhere in this product.

| # | Watch for | Why it matters | Route the finding to |
|---|---|---|---|
| 1 | **The `params` module** (numeric action weights for the 19-action scorer, `home-mixer/scorers/weighted_scorer.rs` imports it) | Real 2026 magnitudes would replace every "ordering > magnitude" hedge — and recalibrate W_REPLY, the freshness urgency, the coaching copy | `learn-stats.ts` constants + `docs/flows/*` "prior" labels + the activity callouts |
| 2 | **`grox/prompts`** (the withheld Grok templates — esp. `ReplyScoringSystem`, `BangerMiniVlmScreenScore`) | X's actual reply-grading rubric → mirror it into the draft eval + tone gate instead of our first-principles approximation | `scripts/eval-draft-reply-live.mjs` JUDGE_SYSTEM + `X_DRAFT_SYSTEM`/`POST_IDEAS_SYSTEM` (+ matching `test-prompts.mjs` invariant regexes) |
| 3 | **Conversation-serving code** (how persisted Grok reply scores order replies in-thread) | Validates/refutes the dedup-based "mid-tier targets over megas" doc note and the in-thread ordering priors | `docs/flows/targets.md` + `reply-spots.md` mechanism notes |
| 4 | **Un-redacted config constants** (e.g. the `low_blast_radius` follower threshold in `grox/tasks/task_filters.py`, OON_WEIGHT_FACTOR, diversity decay values) | The reply-grading threshold = exactly where LLM quality gating starts binding on the heavy-hitters surface → could sharpen the target band | `targets.ts`/`suggest-targets.ts` comments + the deferred-items ranking |

Also skim any drop for: new **negative actions** (extend the tone gate), changes to
**author-diversity/OON scoring** (pace + funnel copy), and new **composition-provenance
fields** on replies (`is_pasted` et al. — touches the insert mechanics posture).

## Discipline

- A claim from this repo is **code-fact** — cite the file path. Anything not read from the
  tree stays labeled **prior/inferred** (the honest-mirror rule applies to our docs too).
- The released model is a frozen *mini* checkpoint; production weights remain unpublished.
  Never import a blog's "leaked weights" — every vendor table in circulation is recycled 2023.
- After processing a drop, update this file's "as of" line above and the relevant
  `docs/flows/` mechanism notes in the same commit.

*Established 2026-07-05, from the algo-leverage mission (see CHANGELOG). Last repo read:
May 15, 2026 state — reply LLM-grading, slop score, conversation dedup, Thunder/Phoenix
architecture all confirmed in code.*
