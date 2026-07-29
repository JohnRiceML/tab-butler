# INTEL — the x-algorithm diff-watch

X open-sourced its production For You pipeline on **2026-01-20** at
[github.com/xai-org/x-algorithm](https://github.com/xai-org/x-algorithm) (Apache-2.0), with a
promised ~4-week update cadence. That repo is Goobi's highest-quality intelligence feed — every
heuristic this product encodes can be checked against actually-served code, while competitors
recycle 2023 weight tables as fact.

**The cadence promise is NOT holding** (one bulk update in the first ~6 months: Jan 20 drop →
May 15 CI-agent update). So this watch is **event-driven, not a monthly ritual** — a monthly
checklist would have fired empty ~5 times and died of boredom before the drop that matters.

## The verified picture (May 15, 2026 release)

What the served pipeline actually is, as of the May 15 read of the tree. Every line carries a
provenance tag: **[confirmed: source]** = read from the open-source tree; **[partial]** =
mechanism in code, the practitioner implication is inference; **[unverified writeup claim]** =
circulating in secondary blogs, NOT in the repo; **[correlational: Buffer]** = observational
engagement data, never causal. When in doubt it is downgraded, not up.

**Grok-transformer relevance; hand-engineered features gone.**
The README states X "eliminated every single hand-engineered feature and most heuristics from the
system" — ranking is a learned transformer over user context, not a stack of tuned signals
**[confirmed: repo README]**. Content understanding moved to a service the repo spells **Grox**
(`grox/spam.py`, `grox/post_safety_screen_deluxe.py`, `grox/safety_ptos.py`,
`grox/reply_ranking.py`) — classifiers, embedders, and a task engine for spam detection,
post-category classification, and PTOS policy enforcement **[confirmed: repo tree]**.
*Naming discipline: keep them distinct — **Grox** = the VLM/classifier content-understanding
service; **Grok** = the ranking-transformer lineage. Secondary write-ups conflate them.*

**Thunder (in-network) + Phoenix (out-of-network) retrieval — OON reach is core; follower count
is not the ceiling.**
Thunder = "posts from accounts you follow," an in-memory store with "sub-millisecond lookups"
**[confirmed: repo README]**. Phoenix = ML similarity search across the global corpus via a
two-tower model (User Tower / Candidate Tower), returning "top-K posts via dot product
similarity" **[confirmed: repo README]** — so a non-followed post reaches you on interest-embedding
match, and reach is genuinely uncoupled from your follower count. Commit `e414c171` adds the
May sources exactly: `followed_grok_topics_query_hydrator.rs`,
`followed_starter_packs_query_hydrator.rs`, `mutual_follow_query_hydrator.rs`
(+ `mutual_follow_jaccard_hydrator.rs`), `served_history_query_hydrator.rs`,
`language_code_hydrator.rs`, `has_media_hydrator.rs`, `quote_hydrator.rs`, and topic candidate
sources **[confirmed: commit e414c171]**.
*Candidate isolation:* the ranking transformer lets "candidates … only … attend to the user
context," not to each other, making scores "consistent and cacheable" **[confirmed: repo README]**
— a post's score does **not** depend on the batch it lands in, which kills most naive
"game-the-feed-by-what-else-is-showing" reasoning.

**One multi-action scoring head; weights undisclosed.**
`home-mixer/scorers/ranking_scorer.rs` (direct read, 2026-07-29) combines **22 predicted-action
terms** into one weighted sum: favorite, reply, retweet, quote, click, profile_click, photo_expand,
vqv (qualified video view), share, **share_via_dm**, **share_via_copy_link**, dwell, quoted_click,
quoted_vqv, follow_author, cont_dwell_time, cont_click_dwell_time, plus the negative heads
not_interested, block_author, mute_author, report, **not_dwelled**
**[confirmed: ranking_scorer.rs]**. (`phoenix/README.md` says "Action types: 19" — the scorer's 22
terms include derived dwell/quoted variants, so the counts differ without contradiction
**[confirmed: repo README]**.) Notable: **sharing is not one event** — a DM share, a copied link,
and a repost each get their own head; and **not_dwelled is an explicit negative**, so a hook that
isn't paid off costs twice (lost dwell + a scored skip). The combining **weights are not published**
**[confirmed: absent from tree]**. The "Retweets×20 / Replies×13.5 / Profile-clicks×12…" tables
circulating are **[unverified writeup claim]** — recycled 2023 folklore, not in this code. Do not
encode those numbers.

**The score pipeline, verbatim.**
`ranking_scorer.rs` computes: weighted sum → `offset_score()` → `normalize_score()` → author-
diversity multiplier → out-of-network factor (`after_diversity * effective_oon`)
**[confirmed: ranking_scorer.rs]**. The diversity multiplier is literally
`(1.0 - floor) * decay_factor.powf(position) + floor` — each additional same-author candidate in
one feed response decays toward a private floor **[confirmed: ranking_scorer.rs]**; the decay rate,
floor, and OON factor values are private **[confirmed: absent from tree]**.

**VMRanker: an optional private re-ranker can REPLACE the visible score.**
`home-mixer/scorers/vm_ranker.rs` (direct read, 2026-07-29) defines a value-model reranker that
sets `candidate.score = scored.score` from an external ranking service; it receives the Phoenix
action predictions, the current score, `in_network`, `author_followers_count`, is_reply/is_retweet
flags, and viewer context — but the value model itself is **external/private**
**[confirmed: vm_ranker.rs]**. Strategic implication: optimizing the visible weighted equation may
still miss a private production objective, so the only durable alignment is making the *viewer*
better off — which is what Goobi encodes anyway.

**Myth-busts (confirmed absent, 2026-07-29 direct read).**
No **bookmark** head exists anywhere in `ranking_scorer.rs` — do not optimize for a rumored
bookmark multiplier **[confirmed: absent from ranking_scorer.rs]**. No **external-link penalty**
term exists in the scorer — link costs are *structural* (a leaving viewer produces no further
native actions; bare links give Phoenix little to embed; repeated URLs can trip spam policy), not a
scored penalty **[confirmed: absent from ranking_scorer.rs]**. And no **velocity gate / graduation
ladder** ("N likes in M minutes unlocks the next tier") exists in the pipeline — candidates are
re-assembled and re-scored per viewer request; early engagement helps only by improving the
evidence available while a post is fresh **[confirmed: structural, repo tree]**.

**Negative signals push content down.**
"Negative actions (block, mute, report) have negative weights, pushing down content the user would
likely dislike" **[confirmed: repo README]** — and the scorer's own field list adds
`not_interested` and `not_dwelled` as scored heads **[confirmed: ranking_scorer.rs]**. The
forward-looking claim that *not-interested also suppresses similar future recommendations* is
**[unverified writeup claim]** — plausible, not in the README; encode as a tip, not a mechanism.

**Author-diversity attenuation + seen/served filtering.**
An "Author Diversity Scorer" attenuates "repeated author scores for diversity" — formula now read
verbatim, see "The score pipeline" above **[confirmed: ranking_scorer.rs]** — and the pipeline
runs `DropDuplicatesFilter`, `PreviouslySeenPostsFilter`, `PreviouslyServedPostsFilter`, and an
`impression_bloom_filter_query_hydrator.rs` **[confirmed: repo README + tree]**. The practitioner
advice to *space your originals hours apart* is **[partial]** — the attenuation
operates **within a single feed response**, so the pacing implication is inference, not a repo
statement.

**Topic consistency spans retrieval AND ranking.**
Grox does post-category classification, `followed_grok_topics` feeds retrieval, and interest
embeddings drive both Phoenix retrieval and the transformer's user context — so topic signal is
load-bearing on both sides **[confirmed: structural, repo tree]**. The sharper claims ("vague posts
lose, explicit subject words win"; the term "semantic discovery") are **[unverified writeup claim]**
— directionally consistent with the architecture, but secondary framing.

**Spam / policy is more integrated (tactic list is not in code).**
Grox integrates `spam.py`, the safety screens, and PTOS enforcement, and a `VFFilter` removes
deleted/spam/violence/gore posts **[confirmed: repo tree]**. The specific tactic enumeration
circulating (mass unsolicited replies, copied posts, engagement-exchange rings, repeated bare
links, trend hijacking) is **[unverified writeup claim]** — not enumerated in the README.

**Ads now blend natively.** The May release added a `home-mixer/ads/` module with
`ads_brand_safety_hydrator.rs` (ad blending + brand-safety screening) **[confirmed: commit
e414c171]** — the feed mixes ads in-pipeline, a detail earlier writeups missed.

**Premium = conversation placement, not a reach lever — but that's NOT in the open code.**
The repo README contains **no mention** of Premium / verified / subscriber / blue affecting reach
or reply ranking **[confirmed: absent from tree]**. `grox/reply_ranking.py` exists, but there is no
primary evidence it keys on Premium status. "Premium buys reply placement, not general reach" is
**[unverified writeup claim]** — widely reported, not in the open-source code. Goobi deliberately
treats Premium as a covariate only (see the table), which stays correct either way.

**Reproducibility.** May 15 shipped a runnable end-to-end `phoenix/run_pipeline.py` plus a
pre-trained ~3GB mini checkpoint via Git LFS **[confirmed: repo tree]** — the release genuinely
runs, which raises confidence in the confirmed-mechanism claims above. It is a frozen *mini*
checkpoint; **production weights remain unpublished**.

**Engagement-rate context (never causal).** Buffer's State of Social Media Engagement 2026
(~52M posts) reports X median engagement: text **3.56%** > image **3.40%** > video **2.96%** >
link **2.25%** **[correlational: Buffer]**. Author replying to their own comments ≈ **+8%
engagement** — but Buffer flags this as the least-certain result in its set, "the data doesn't
fully rule out noise" **[correlational: Buffer]**. Reach *per post* declines at higher posting
frequency (15.7M-post analysis) even as total engagement / follower growth still rises with volume
**[correlational: Buffer]**. None of this is a weight; treat as ambient prior only.

## Encoded where

Where each concept lands in Goobi today (from the encoding map). Rows touching `prompts.ts` or the
pacing layer are **updated 2026-07-29** (prompt/pacing refresh shipping in parallel).

| Algo concept (May-2026 model) | Encoded in Goobi | Status |
|---|---|---|
| Grok/Grox relevance + content fit | `prompts.ts` `X_SCORE_SYSTEM` (reply-worthiness 0–1, hard-calibrated); `reply-recommendation.ts` `modelFit`; `community.ts` `nicheWords` | prompts **updated 2026-07-29** |
| Thunder/Phoenix OON reach (follower count ≠ ceiling) | `reply-recommendation.ts` `reachableAudience` + discovery lane; `targets.ts` `TARGET_BAND {2,25}` / `MEGA_CAP 500k` / `inReachBand`; `prompts.ts` FOLLOWER TIER | prompts **updated 2026-07-29**; bands are product priors |
| Multi-action scoring mix | `learn-stats.ts` `W_REPLY=2.0`; `momentum.ts` `POST_BONUS=18`; `prompts.ts` LEVER MAP + PROFILE CLICK | magnitudes are priors; prompts **updated 2026-07-29** |
| Negative signals (block/mute/report neg-weights) | `prompts.ts` tone-deboost + throttle; `reply-hygiene.ts` dup / ghost-ban deboost | prompts **updated 2026-07-29** |
| Author-diversity attenuation + pacing | `reply-recommendation.ts` `diversityFactor` (0.58–0.84); `reply-hygiene.ts` per-hour caps; `human-pacing.ts` jitter; `momentum.ts` `dailyShape` spacing | pacing **updated 2026-07-29** |
| Integrated spam / policy | `reply-hygiene.ts` `jaccard`/`isDuplicateReply`; `prompts.ts` BANGER SCREEN + bait ≤0.3 | prompts **updated 2026-07-29** |
| Premium as ranking input | `config.ts` `X_PREMIUM_KEY` — honest covariate, **never** a score input | unchanged — designed omission |

**Deliberately NOT encoded** (see the checklist for why each is still withheld or a judgment call):
real numeric action weights (the `params` module); X's own per-surface distribution multiplier
(`surfaceMult`/`gradedSurface` do not exist in `src/` — absent concepts, not code); un-redacted
config constants (`low_blast_radius`, `OON_WEIGHT_FACTOR`, diversity-decay values); X's real
reply-grading templates (`grox/prompts`); explicit not-interested/block/mute/report as modeled
inputs; and Premium-as-boost (a chosen omission, not a gap).

## How to watch (pick one, ~zero effort)

- GitHub **Watch → Custom → Releases + Pushes** on `xai-org/x-algorithm`, or
- subscribe to the commits feed: `https://github.com/xai-org/x-algorithm/commits/main.atom`

When a real drop lands, run the checklist below (≈1 hour, usually much less). A Claude Code
session pointed at this file + the repo diff can do the read.

## The checklist — what to look for, and where each finding routes

Ordered by how much each would change Goobi. As of the **May 15, 2026 read**, the architecture
(Grok-transformer ranking, Thunder/Phoenix retrieval, the 19-action scorer, negative weights,
author diversity, integrated Grox spam/policy) is **confirmed in code** — see the verified picture
above. The items below are the pieces that are **still withheld or still redacted**; any of them
landing upgrades a "prior" label to code-fact somewhere in this product.

| # | Watch for | Why it matters | Route the finding to |
|---|---|---|---|
| 1 | **The `params` module** (numeric action weights for the 19-action scorer, `home-mixer/scorers/weighted_scorer.rs` imports it) | Real 2026 magnitudes would replace every "ordering > magnitude" hedge — and recalibrate W_REPLY, the freshness urgency, the coaching copy | `learn-stats.ts` constants + `docs/flows/*` "prior" labels + the activity callouts |
| 2 | **`grox/prompts`** (the still-withheld Grok templates — esp. `ReplyScoringSystem`, `BangerMiniVlmScreenScore`) | X's actual reply-grading rubric → mirror it into the draft eval + tone gate instead of our first-principles approximation | `scripts/eval-draft-reply-live.mjs` JUDGE_SYSTEM + `X_DRAFT_SYSTEM`/`POST_IDEAS_SYSTEM` (+ matching `test-prompts.mjs` invariant regexes) |
| 3 | **Un-redacted config constants** (e.g. the `low_blast_radius` follower threshold in `grox/tasks/task_filters.py`, `OON_WEIGHT_FACTOR`, diversity-decay values) | The reply-grading threshold = exactly where LLM quality gating starts binding on the heavy-hitters surface → could sharpen the target band | `targets.ts`/`suggest-targets.ts` comments + the deferred-items ranking |

**Now confirmed, no longer on watch** (May 15 read): the **conversation-serving / dedup** code
is code-fact — `DedupConversationFilter` "removes duplicate conversation branches in a viewer's
feed; it does not establish one universal reply slot," already cited at
`src/lib/targets.ts:96–100` (`slotOdds`). Prior editions of this checklist listed it as
"withheld"; that framing was retired 2026-07-29. The reply-spots doc's "X LLM-grades replies 0–3
on big-author threads + models a slop score" note (`docs/flows/reply-spots.md:32`) stands —
`grox/reply_ranking.py` exists and the structural claim holds; the specific 0–3 scale is a
prior-read detail, not contradicted.

Also skim any drop for: new **negative actions** (extend the tone gate), changes to
**author-diversity/OON scoring** (pace + funnel copy), new **composition-provenance fields** on
replies (`is_pasted` et al. — touches the insert-mechanics posture), and any first appearance of a
**per-surface distribution multiplier** (would be the first real basis for a `surfaceMult` concept
Goobi currently has no encoding for).

## Discipline

- A claim from this repo is **code-fact** — cite the file path. Anything not read from the
  tree stays labeled **prior/inferred** (the honest-mirror rule applies to our docs too), and the
  provenance tags in the verified picture (**[confirmed] / [partial] / [unverified writeup claim]
  / [correlational: Buffer]**) are load-bearing — do not silently promote a tag.
- The released model is a frozen *mini* checkpoint; production weights remain unpublished.
  Never import a blog's "leaked weights" — every vendor table in circulation is recycled 2023.
- After processing a drop, update this file's "as of" line below and the relevant
  `docs/flows/` mechanism notes in the same commit.

*Established 2026-07-05, from the algo-leverage mission (see CHANGELOG). Verified-picture section +
provenance discipline added 2026-07-29 against the May 15, 2026 tree read. Same day, a second
direct read of `ranking_scorer.rs` + `vm_ranker.rs` added: the verbatim score pipeline + diversity
formula, the full 22-term head list (share_via_dm / share_via_copy_link / not_dwelled et al.), the
VMRanker private-reranker caveat, and the bookmark / link-penalty / velocity-gate myth-busts.
**As of 2026-07-29:** the architecture (Grok-transformer ranking, Thunder/Phoenix, the multi-action
scorer, negative weights, author diversity, Grox spam/policy, native ads, VMRanker hook) is
confirmed in code; still-withheld = the numeric `params` weights, the diversity decay/floor + OON
factor values, `grox/prompts` templates, the redacted config constants, and the VMRanker value
model itself. Premium-as-reach is NOT in the open code (widely-reported only). Last repo read:
May 15, 2026 state.*
