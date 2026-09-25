# Jev analysis and comment review

## Fast opportunity analysis

In **Conversations → Jev analysis** (the recommended setup), enable **Use Jev only for analysis**, supply
the TypeSafe key, and save. This switches X and LinkedIn opportunity scoring to Jev;
Claude still writes comments using the existing voice, POV, and factual-grounding prompts.
Analysis is off by default. Optional comment review below is independent and can stay off.

`jev-analysis.ts` sends only source posts/context, visible author metadata, shared focus,
and LinkedIn thesis. It excludes SOUL, personal facts, voice, drafts, products, and own-post
history. Each post has an isolated request, with four concurrent calls, bounded queue,
five-second transport deadline, cancellation, and rate-limit cooldown. There is no automatic
Claude fallback or paid retry within the adapter. Existing feed retry controls still apply.

Jev selects fit/risk labels, a predefined contribution direction, and an exact source excerpt;
code maps these into the existing contribution gates. It cannot produce a bespoke rationale,
so cards show short rubric reasons. Explicit LinkedIn audience targeting still requires
visible person evidence; requests for firsthand experience require a supplied detail.
X suppresses these experience-dependent opportunities. Product-specific matching is unavailable
in this mode. Switching providers cancels pending work and clears stale feed scores/drafts.

The development evaluation's latest run matched 19/20 hand-labeled fictional decisions,
with 11 X posts processed in 946 ms and 9 LinkedIn posts in 599 ms. It missed a valid warm
inbound acknowledgement. These cases informed tuning. A subsequent untuned set matched 12/12
decisions, taking 535 ms for six X posts and 1,045 ms for six LinkedIn posts. These small
fictional benchmarks are not production accuracy or a speed comparison against Claude.
Reports are in `artifacts/jev-analysis-evaluation.json` and `artifacts/jev-analysis-holdout.json`.

```sh
node extension/scripts/eval-jev-analysis-live.mjs --live
node extension/scripts/eval-jev-analysis-live.mjs --live --holdout
```

The live runner uses fictional posts and never sends expected labels. Without `--live`,
it makes no calls. Free regression tests verify routing, source anchors, audience gates,
uncertainty, cancellation, errors without fallback, and Claude-only drafting when review is off.

## Optional comment review

Jev is an optional second reader for explicitly requested X replies and LinkedIn comments, including rewrites. Claude still produces the comment and the existing deterministic checks still run. Jev observes the final accepted draft; its output never changes selection, rewrites a draft, approves a personal claim, or posts anything.

## Why observation mode

The first live evaluation used 28 fictional, hand-authored scenarios, each on X and LinkedIn. Eighteen development cases ran once per platform; ten held-out cases ran twice per platform. Expected labels were never sent to the provider. All runs used the same rubric and pinned model `jev-1.13.0`; no thresholds or prompts were tuned on the held-out results.

| Run | Reviews completed | Expected dimension labels matched | Median / p95 latency |
| --- | --- | --- | --- |
| Development | 36 | 49 / 50 | 132 / 224 ms |
| Held-out, two repetitions | 40 | 66 / 68 | 144 / 261 ms |

Total input was 82,898 tokens. At TypeSafe's published $0.042 per million input tokens, the estimated model charge was $0.00348; this is rate-card arithmetic, not a billing receipt. The fixtures cover supplied versus invented experience, mismatched numbers, partial history, tentative beliefs, POV reversals, praise, paraphrases, answered questions, social acknowledgements, humor, and embedded instructions.

The reviewer mistook one X acknowledgement for an unsupported personal claim and twice classified a valid X autobiographical paraphrase as having no personal claim. Conservative confidence thresholds also leave some actual unsupported claims unflagged. This small fixture evaluation is not production accuracy, and repeated cases are not independent examples. These findings justify observing real use before enabling any automatic veto or rewrite.

## Runtime

- `jev-review.ts` sends one bounded request with three independent Choice questions: support for personal claims, consistency with an explicit POV, and contribution beyond the source. Each has an uncertain/non-applicable path.
- Facts are passed separately from SOUL and dated history. Learned voice samples and scorer briefs are excluded. The post and draft are explicitly untrusted data.
- Request destination and model are fixed. Responses must contain every dimension, allowed choices, finite probabilities, a plausible distribution, and the pinned model. Provider error bodies are never logged or forwarded.
- Review has a separate two-request capacity pool, no queue, a four-second deadline including body consumption, caller cancellation, and rate-limit cooldown. No automatic paid retry.
- `jev-shadow.ts` requires a key, `jevReviewMode: "shadow"`, and `jevReviewConsent: "v1"`. Missing/invalid settings mean no call. Provider, validation, context-size, or storage failures leave the original draft unchanged. Normal social-context cancellation still cancels the draft request.
- Only potential flags with confidence at least 0.90 and selected-option probability at least 0.95 enter the summary. These are conservative heuristics, not calibrated correctness guarantees. No flag is not a clean bill of health.
- The latest 50 metadata-only observations are serialized into a local bounded log. Neither review payloads nor generated text are retained there. Settings show the latest five summaries and let the user clear or disconnect.

## Setup and evaluation

Open **Jev analysis → Optional draft review** in the side panel, enter the TypeSafe key, read/check the separate comment-review data disclosure, and save Jev settings. New installs remain off by default. The added `api.typesafe.ai` host permission must be granted by the browser when updating the extension. Do not uninstall an existing extension just to update permissions; that can erase stored settings.

For development, the ignored `extension/goobi.local.json` can contain `typesafeKey`, `jevReviewMode: "shadow"`, and `jevReviewConsent: "v1"` after explicit operator authorization. Only watch builds include local seed files; normal distribution builds deliberately exclude them. Local seeding never reconnects an explicitly removed TypeSafe key or turns a saved off preference back on.

Run the bounded fictional benchmark with:

```sh
node extension/scripts/eval-jev-review-live.mjs --live --development --out=artifacts/jev-review-development.json
node extension/scripts/eval-jev-review-live.mjs --live --holdout --repeat=2 --out=artifacts/jev-review-holdout.json
```

The runner reads `TYPESAFE_API_KEY` or the ignored local seed, never prints credentials, and stops on transport/auth/service failures. Without `--live` it performs no calls. Standard regression tests are free and exercise the real reviewer and both draft paths with mocked providers.

Before promoting Jev to influence drafts, use a larger separately labeled set of real, permissioned examples and measure false positives, missed problems, added latency and fallback rates. Prioritize subtle POV disagreements, jokes, acknowledged context, negations, and paraphrased evidence. Fast opportunity analysis is independently enabled above; it uses predefined directions and observed excerpts in place of generated analysis prose.

Official references: [API](https://docs.typesafe.ai/api), [model/pricing](https://docs.typesafe.ai/models), [confidence](https://docs.typesafe.ai/confidence), [known limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13).
