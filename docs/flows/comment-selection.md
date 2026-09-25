# Choosing a post and a useful contribution

Goobi's core decision is whether the user has something worth adding to this particular conversation.
Audience, timing, and relationship signals help order worthwhile opportunities; they cannot establish
that a comment is relevant or useful by themselves.

## What the user sees

- **X:** automatic suggestions need a specific post detail and a concrete reply direction. Expanded
  opportunities explain that direction and its source anchor. Explicit user selections still work;
  an unsupported selection is labeled Added by you instead of borrowing a Best next recommendation.
- **LinkedIn:** draftable comments appear before opportunities that require a real detail from the user.
  One-author selection follows that readiness ordering. Contribution diversity changes the queue order
  without silently deleting the deferred candidates. Existing author-spacing penalties remain visible.

Normal conversation remains eligible: a grounded question, supportive response, warm inbound reply,
or specific joke does not need to masquerade as a technical essay.

## Selection contract

For an automatic X recommendation, `assessXContribution` requires the existing fit threshold, risk
`none`, an anchor found in the supplied post or quote context, a recognized contribution move, and
a nonempty reply brief that is not an obvious placeholder or repetition. Warm inbound keeps its
existing lower fit threshold. Fresh Reach additionally applies its timing, audience, and content rules.
All queue sorts honor the contribution gate. Explicit manual choices retain visibility but do not gain
an automatic recommendation bonus when this evidence is absent.

LinkedIn separately evaluates post fit, person fit, and contribution fit. Both `comment` and
`needs_detail` require a source anchor, contribution lane, and reply brief. The latter also requires a
specific prompt for the missing user fact. Limited author metadata still permits discovery when the
post supports a strong contribution. Invalid source grounding removes only the affected candidate,
not a neighboring valid post or the whole scoring batch.

The shared `findContributionAnchor` matcher tolerates punctuation, whitespace, case, and Unicode
presentation differences. It requires a contiguous source excerpt with token boundaries; a reference
to AI does not match inside retail. Anchor length is bounded at word boundaries. Both prompts request
this source-excerpt contract. The service worker rechecks it before sending scorer guidance to a drafter.
If guidance is unsupported, explicit drafting can still proceed from the actual post.

## Writing the comment

The prompt asks for one useful addition: an implication, implementation detail, boundary condition,
specific support, or genuinely unanswered question. The comment should not just repeat the source or
ask for information already present. Voice examples provide style, not biography. Scorer plans and
edited draft text do not establish personal experience.

The actual drafting client rejects substantial verbatim source echoes and clear autobiographical
assertions when no explicit personal evidence was supplied. LinkedIn uses its existing single repair
attempt; X returns an actionable drafting error without adding an automatic paid retry. Short playful
replies, opinions, questions, and hypothetical reasoning remain outside the narrow factual guard.

These are limited checks. Textual grounding does not prove the source is true or the proposed comment
is insightful. Supplying personal evidence does not semantically verify every detail of a generated
claim. The model and the user's review still carry that judgment.

## Evaluation

The free `test-comment-selection-benchmark.mjs` runs 27 hand-labeled platform cases plus readiness
and diversity ordering checks. Its fictional cases include implementation detail, an evidence question,
warm support, humor, quoted context, unknown author context, invented anchors, missing guidance,
generic praise, unsolicited promotion, hostility, and required personal detail.

These are policy tests against plausible scorer responses. They do **not** measure live model accuracy,
user acceptance, account growth, or whether embedded post instructions are reliably ignored by a model.

For a live review of actual scorer output, use:

```bash
cd extension
node scripts/eval-comment-selection-live.mjs
# No-op by default. With ANTHROPIC_API_KEY in the environment:
node scripts/eval-comment-selection-live.mjs --live
# Optionally generate drafts for ready selections too:
node scripts/eval-comment-selection-live.mjs --live --draft
```

The opt-in command incurs provider usage and emits a JSON review packet containing the fictional
profile, source post, model assessment, eligibility decision, contribution anchor, and optional draft.
It calls the shipping client rather than reconstructing its prompts in a separate implementation.
Assess whether you would choose the conversation, whether the contribution adds something, whether
the claims are supported, and how much editing the draft needs. No live provider run was needed for
the implementation's deterministic checks.

## Key files

- `extension/src/lib/x-contribution.ts`
- `extension/src/lib/linkedin-opportunity-ranking.ts`
- `extension/src/lib/contribution-evidence.ts`
- `extension/src/lib/prompts.ts` and `claude-client.ts`
- `extension/scripts/comment-selection-fixtures.mjs`
- `extension/scripts/test-comment-selection-benchmark.mjs`
- `extension/scripts/eval-comment-selection-live.mjs`

See [commenting reliability](commenting-reliability.md) for request cancellation, error recovery,
manual posting semantics, and remaining persistence work.
