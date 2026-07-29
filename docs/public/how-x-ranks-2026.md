# How X's "For You" Feed Actually Ranks Posts — the May 2026 Open-Source Picture

X open-sourced its production For You pipeline on **January 20, 2026** at
[github.com/xai-org/x-algorithm](https://github.com/xai-org/x-algorithm) (Apache-2.0), and has
shipped one major update since — the **May 15, 2026** release, which is the state this document
describes. Every claim below was checked against that tree directly (last verified read:
2026-07-29), not against the blog posts that still recycle the 2023 drop.

## How to read this document

Every claim carries a provenance tag. The tags are the point: most of what circulates about
"the X algorithm" is folklore, and the honest way to write about a partially-open system is to
say exactly how each claim is known.

- **[confirmed: source]** — read directly from the open-source tree; the cited file is the evidence.
- **[partial]** — the mechanism is in the code, but the practitioner implication drawn from it is inference.
- **[unverified writeup claim]** — circulating in secondary write-ups; **not** in the repo. Treat as rumor.
- **[correlational: Buffer]** — observational engagement data (Buffer's State of Social Media
  Engagement 2026, ~52M posts); never causal.

When in doubt, a claim is downgraded, not up.

## The big architectural shift: a learned transformer, not a stack of tuned signals

The repo README states X "eliminated every single hand-engineered feature and most heuristics
from the system" — ranking is a learned transformer over user context, not a pile of
hand-weighted signals **[confirmed: repo README]**.

Content understanding lives in a separate service the repo spells **Grox**: classifiers at
`grox/classifiers/content/` (`reply_ranking.py`, `spam.py`, `post_safety_screen_deluxe.py`,
`safety_ptos.py`, `banger_initial_screen.py`, `classifier.py`), orchestrated by a
`grox/tasks/task_*.py` layer and `grox/plans/plan_*.py` pipelines (e.g. `plan_reply_ranking.py`
= filter → rate-limit → media-hydrate → rank) **[confirmed: repo tree]**.

Naming discipline, because secondary write-ups conflate them: **Grox** = the VLM/classifier
content-understanding service; **Grok** = the ranking-transformer lineage.

## Retrieval: Thunder (in-network) + Phoenix (out-of-network)

Two candidate sources feed the ranker:

- **Thunder** — "posts from accounts you follow," an in-memory store with "sub-millisecond
  lookups" **[confirmed: repo README]**.
- **Phoenix** — ML similarity search across the global corpus via a two-tower model
  (User Tower / Candidate Tower), returning "top-K posts via dot product similarity"
  **[confirmed: repo README]**. A non-followed post reaches you on interest-embedding match.

**Follower count is not the ceiling.** That is now directly supported by the code: the User
Tower encodes the viewer's engagement history, and **author follower count is not a User-Tower
feature** — its only sightings anywhere in the tree are as an input to the private
`vm_ranker.rs` re-ranker (direction unknown) and in the reply blast-radius gate, which keys on
the account being *replied to*, not on the reply's author **[confirmed: phoenix/README + repo
tree]**.

Phoenix ships three retrieval variants (base / MoE / topics), and
`new_user_topic_ids_filter.rs` requires out-of-network candidates for **new viewers** to match
expanded topic IDs (in-network bypasses the filter) — topic explicitness is literally the door
into new-user feeds **[confirmed: repo tree]**. The May release also added new candidate
sources and hydrators: `followed_grok_topics_query_hydrator.rs`,
`followed_starter_packs_query_hydrator.rs`, `mutual_follow_query_hydrator.rs`
(+ `mutual_follow_jaccard_hydrator.rs`), `served_history_query_hydrator.rs`,
`language_code_hydrator.rs`, `has_media_hydrator.rs`, `quote_hydrator.rs`, and topic candidate
sources **[confirmed: commit e414c171]**.

**Candidate isolation.** The ranking transformer lets "candidates … only … attend to the user
context," not to each other, making scores "consistent and cacheable" **[confirmed: repo
README]**. A post's score does **not** depend on the batch it lands in — which kills most naive
"game the feed by what else is showing" reasoning.

## Scoring: one multi-action head; the weights are not published

`home-mixer/scorers/ranking_scorer.rs` combines **22 predicted-action terms** into one weighted
sum: favorite, reply, retweet, quote, click, profile_click, photo_expand, vqv (qualified video
view), share, **share_via_dm**, **share_via_copy_link**, dwell, quoted_click, quoted_vqv,
follow_author, cont_dwell_time, cont_click_dwell_time, plus the negative heads not_interested,
block_author, mute_author, report, and **not_dwelled** **[confirmed: ranking_scorer.rs]**.

If you have seen different head counts, three nesting levels reconcile them: the root README
names ~14-15 base P(action) heads → `phoenix/README.md` says "Action types: 19" → the scorer
combines 22 `_score` terms including derived dwell/quoted variants. Different layers, no
contradiction **[confirmed: repo README + ranking_scorer.rs]**.

Two details worth noticing:

- **Sharing is not one event.** A DM share, a copied link, and a repost each get their own
  predicted-action head **[confirmed: ranking_scorer.rs]**.
- **not_dwelled is its own tracked term.** It is negative by *name*; its weight, like every
  coefficient, is unpublished — do not assert the sign as code-fact. But a hook that isn't paid
  off plausibly costs twice: lost dwell plus a scored skip **[partial]**.

**The combining weights are not published** **[confirmed: absent from tree]**. The
"Retweets×20 / Replies×13.5 / Profile-clicks×12…" tables circulating are **[unverified writeup
claim]** — recycled 2023 folklore, not in this code.

### The score pipeline, verbatim

`ranking_scorer.rs` computes: weighted sum → `offset_score()` → `normalize_score()` →
author-diversity multiplier → out-of-network factor (`after_diversity * effective_oon`)
**[confirmed: ranking_scorer.rs]**.

The author-diversity multiplier is literally
`(1.0 - floor) * decay_factor.powf(position) + floor` — each additional same-author candidate
in one feed response decays toward a private floor **[confirmed: ranking_scorer.rs +
author_diversity_scorer.rs, which scopes it "within a single feed response"]**. The decay rate,
the floor, and the out-of-network factor values are private **[confirmed: absent from tree]**.
Note the scope: the attenuation operates **within a single feed response**; the common advice
to space your posts hours apart is **[partial]** — a plausible inference, not a repo statement.

The scoring layer is modular beyond that one file: `scorers/` also holds standalone
`weighted_scorer.rs`, `oon_scorer.rs` (applies `OON_WEIGHT_FACTOR` only when
`in_network == Some(false)`), `author_diversity_scorer.rs`, and `phoenix_scorer.rs`
**[confirmed: repo tree]**.

### Negative signals are real scored heads

"Negative actions (block, mute, report) have negative weights, pushing down content the user
would likely dislike" **[confirmed: repo README]** — and the scorer's own field list adds
`not_interested` and `not_dwelled` as scored heads **[confirmed: ranking_scorer.rs]**. The
forward-looking claim that a not-interested click also suppresses *similar future
recommendations* is **[unverified writeup claim]** — plausible, but not in the README.

### The VMRanker caveat: a private re-ranker can replace the visible score

`home-mixer/scorers/vm_ranker.rs` defines an optional value-model re-ranker that sets
`candidate.score = scored.score` from an **external, private** ranking service. It receives the
Phoenix action predictions, the current score, `in_network`, `author_followers_count`,
is_reply/is_retweet flags, and viewer context — but the value model itself is not in the repo
**[confirmed: vm_ranker.rs]**.

The strategic implication: optimizing the visible weighted equation can still miss a private
production objective. The only durable alignment is making the *viewer* genuinely better off.

## The reply pipeline: follower-gated grading, one holistic 0-3 score

Replies get their own treatment, and as of the May tree it is readable end-to-end:

1. **Reply grading is follower-gated on the *target*.** `grox/tasks/task_filters.py`
   (`TaskReplyRankingFilter`) only grades replies where an ancestor author exceeds
   `FOLLOWER_COUNT_THRESHOLD_FOR_REPLY_RANKING`; below it the reply is dropped with reason
   `low_blast_radius` — never graded, and with essentially no out-of-network placement
   **[confirmed: repo tree]**. The threshold *number* is runtime-injected and private. The gate
   keys on the size of the account being replied to, not yours — your own follower count
   neither caps out-of-network retrieval nor gates reply grading.
2. **The grade is one holistic 0-3, not a rubric of sub-scores.**
   `grox/classifiers/content/reply_ranking.py` calls a VLM (primary `VLM_MINI_CRITICAL`,
   fallback `VLM_PRIMARY_CRITICAL`, temperature ≈ 1e-6 — deterministic) whose output schema is
   `ReplyScoreResult { score, reason }` with metric buckets `[0.0, 1.0, 2.0, 3.0]`
   **[confirmed: repo tree]**. The rubric *text* (the `ReplyScoringSystem` template) remains
   withheld.
3. **Composition provenance is a live input.** `grox/tasks/task_rank_replies.py` reads
   composition source, **paste status**, user agent, and app-attestation status into the reply
   pipeline today, alongside author-reputation signals (`has_risky_user_safety_label`,
   `num_legit_blocks_received_last_24hrs`) **[confirmed: repo tree]**. There is no evidence of a
   scored *penalty* for pasting — it is a tracked feature with unknown direction, so treat it as
   a caution, not a claim.

Replies are also first-class For-You candidates (Thunder in-network + Phoenix out-of-network;
no reply-exclusion filter found), and the one place they could be treated structurally
differently is `vm_ranker.rs`, which receives `is_reply` (direction unpublished)
**[confirmed: repo tree + vm_ranker.rs]**. The practical read: a reply's reach is won *in the
conversation* — the 0-3 grade plus conversation placement — not by optimizing it like a feed
post.

One related myth: the pipeline's `DedupConversationFilter` "removes duplicate conversation
branches in a viewer's feed" — it does **not** establish one universal reply slot per thread
**[confirmed: repo tree]**.

## Myth-busts (confirmed absent from the code)

- **No bookmark head.** No bookmark term exists anywhere in `ranking_scorer.rs` — do not
  optimize for a rumored bookmark multiplier **[confirmed: absent from ranking_scorer.rs]**.
- **No external-link penalty.** No link-penalty term exists in the scorer. Link costs are
  *structural*, not scored: a viewer who leaves produces no further native actions; bare links
  give Phoenix little to embed; repeated URLs can trip spam policy
  **[confirmed: absent from ranking_scorer.rs]**.
- **No velocity gates / graduation ladders.** No "N likes in M minutes unlocks the next tier"
  mechanism exists — and it is structurally implausible pipeline-wide: candidates are
  re-assembled and re-scored per viewer request (candidate isolation makes scores cacheable),
  so a global unlock tier has nowhere to live **[confirmed: absent from ranking_scorer.rs;
  structural]**. Early engagement helps only by improving the evidence available while a post
  is fresh. Related but distinct: `filters/age_filter.rs` *is* a hard max-age cutoff (drops
  candidates older than a runtime `Duration`, replies treated identically) — a freshness cliff,
  not a velocity gate **[confirmed: repo tree]**.
- **The 2023 weight tables are folklore.** Every "leaked weights" vendor table in circulation
  recycles the 2023 open-source drop. The 2026 weights are absent from the tree
  **[confirmed: absent from tree]**.
- **Premium is not a visible reach lever.** The repo README contains no mention of Premium /
  verified / subscriber status affecting reach or reply ranking **[confirmed: absent from
  tree]**. One nuance: `filters/ineligible_subscription_filter.rs` does gate paid
  subscriber-only *content* (the viewer must be in `subscribed_user_ids`) — content-gating, not
  a reach boost **[confirmed: repo tree]**. "Premium buys reply placement" is **[unverified
  writeup claim]** — widely reported, not in the open code.

## Other confirmed mechanics, briefly

- **Seen/served filtering.** The pipeline runs `DropDuplicatesFilter`,
  `PreviouslySeenPostsFilter`, `PreviouslyServedPostsFilter`, and an
  `impression_bloom_filter_query_hydrator.rs` — reshowing you the same posts is actively
  filtered **[confirmed: repo README + tree]**.
- **Topic consistency spans retrieval and ranking.** Grox does post-category classification,
  `followed_grok_topics` feeds retrieval, and interest embeddings drive both Phoenix retrieval
  and the transformer's user context **[confirmed: structural, repo tree]**. The sharper
  claims ("vague posts lose, explicit subject words win"; the term "semantic discovery") are
  **[unverified writeup claim]** — directionally consistent with the architecture, but
  secondary framing.
- **Spam / policy is integrated, but the tactic list isn't in code.** Grox integrates
  `spam.py`, the safety screens, and PTOS enforcement, and a `VFFilter` removes
  deleted/spam/violence/gore posts **[confirmed: repo tree]**. The specific tactic enumeration
  circulating (mass unsolicited replies, copied posts, engagement rings, repeated bare links,
  trend hijacking) is **[unverified writeup claim]**.
- **Ads blend natively.** The May release added a `home-mixer/ads/` module with
  `ads_brand_safety_hydrator.rs` — the feed mixes ads in-pipeline **[confirmed: commit
  e414c171]**.
- **The release genuinely runs.** May 15 shipped an end-to-end `phoenix/run_pipeline.py` plus a
  pre-trained ~3GB mini checkpoint via Git LFS **[confirmed: repo tree]** — which raises
  confidence in the confirmed-mechanism claims above. It is a frozen *mini* checkpoint;
  **production weights remain unpublished**.

## Engagement-rate context (correlational only — never causal)

Buffer's State of Social Media Engagement 2026 (~52M posts) reports X median engagement by
format: text **3.56%** > image **3.40%** > video **2.96%** > link **2.25%**
**[correlational: Buffer]**. Authors replying to their own comments correlated with ≈ **+8%
engagement** — but Buffer flags this as the least-certain result in its set ("the data doesn't
fully rule out noise") **[correlational: Buffer]**. Reach *per post* declines at higher posting
frequency (15.7M-post analysis) even as total engagement and follower growth still rise with
volume **[correlational: Buffer]**. None of this is a ranking weight; treat it as ambient
prior only.

## What this means for a small account

The honest version, staying inside what the code supports:

- **Your follower count is not your ceiling.** Author follower count is not a User-Tower
  feature; out-of-network reach runs on interest-embedding match. Write for a topic, and
  Phoenix can carry a post past your graph.
- **Be explicit about your subject.** Topic signal is load-bearing on both the retrieval and
  ranking sides, and topic-ID matching is literally the gate into new-user feeds. (How sharply
  "vague loses" is inference, not code-fact.)
- **Replies under bigger accounts are the graded surface.** X only LLM-grades replies in
  threads whose target account clears a follower threshold; below it, replies are dropped from
  grading as `low_blast_radius`. A genuinely good reply under a large account is aimed at the
  one surface where X's own grader is paying attention.
- **Write one good reply, not a checklist.** The grade is a single holistic 0-3, deterministic,
  with a withheld rubric. Quality proxies help you draft; they are not the objective.
- **Bait is scored against you.** Block, mute, report, not-interested, and not-dwelled are
  heads in the same equation as likes and replies. A hook you don't pay off plausibly costs
  twice **[partial]**.
- **Skip the folklore.** No bookmark head, no link-penalty term, no velocity gates, no 2026
  weight tables. Early engagement matters only as fresher evidence, and posts age out at a hard
  cutoff.
- **The visible equation may not be the whole objective.** A private value-model re-ranker can
  replace the score outright. The only strategy that survives every private objective is making
  the viewer actually better off.

---

*About this document: it is maintained as the public grounding reference for **Goobi**, a
draft-only X reply copilot whose scoring and coaching are checked claim-by-claim against the
picture above — it never auto-posts, and a human reviews and submits every reply. Provenance
tags are kept verbatim from the internal research doc; sources are the
[xai-org/x-algorithm](https://github.com/xai-org/x-algorithm) tree (May 15, 2026 state, last
read 2026-07-29) and Buffer's State of Social Media Engagement 2026.*
