# DM workspace

> A local, per-account relationship workspace for planning one thoughtful X DM at a time. It is a drafting and manual-record tool, not an automated outreach sender.

## What it does for the user

The DM workspace connects Goobi's public growth work to a private-conversation pipeline. It suggests people only from account-safe evidence already in Goobi: exact completed public exchanges and saved Targets. Exact repeated exchanges are labeled warm; a Target is labeled research and is never presented as consent or buying intent.

Each person can carry one of six explicit angles: Sponsor, Backlink, Connect, Co-market, Customer, or Partner. The user records the goal, selected product/resource, public evidence, private notes, messages marked sent, replies pasted manually, follow-up state, and the outcome.

## How the user uses it

1. Open Goobi and choose **DMs**.
2. Plan a suggested person, add an `@handle` plus a concrete "why now?" note, or choose **Plan a DM** on a Target.
3. Pick the angle and optional product/resource. Add or refresh public context when needed.
4. Move the person to Ready, then click **Draft first DM**. Goobi sends only the displayed evidence and context to Claude for that explicit action.
5. Edit and copy the draft, open the person's X profile, and send manually in X.
6. Click **Mark sent** to create a local record. This schedules one suggested follow-up after seven days.
7. Paste a response and click **They replied**, add conversation notes, or mark the relationship Won/Closed.

## Pipeline

`Research → Warm up → Ready → Waiting → Conversation → Won / Closed`

Drafting does not advance the pipeline. Copying and opening a profile do not count as sending. Only **Mark sent**, **They replied**, **Mark won**, and explicit stage controls change recorded state.

## KISS intelligence layer

The workspace computes one deterministic **Next** move from local state; it does not call Claude or RapidAPI:

1. Reply to a real inbound conversation.
2. Handle one due follow-up.
3. Draft a grounded Ready plan.
4. Review a researched person who now has enough evidence for Ready.
5. Add context to a thin plan.

This is deliberately not a lead score. The UI states the person, action, and inspectable reason. The total-day DM pause removes outbound recommendations entirely.

The compact outcome line uses only first messages, replies, and wins the user marked. It reports marked reply rate and conversation/win counts. Angle results are display-only: an angle needs at least three first touches before it can be named the clearest current signal. People-source learning separately compares exact relationships, saved Targets, reply spots, manual research, Circle, and completed Threads; a source needs five first touches before it can be named the clearest people signal. Candidate cards show their own angle/source sample once each has three sends. Every signal includes the exact numerator/denominator.

The send event snapshots intent, product, warm-versus-research status, and candidate source so later CRM edits do not rewrite history. These observational results never change candidate ranking or automatically select an angle: they help the user make a better decision without allowing thin or confounded data to steer outreach invisibly.

## API and model flow

- Candidate ranking itself makes zero RapidAPI calls.
- Manual add may explicitly call the proven `user` endpoint for public name, bio, follower count, and stable user ID.
- **Refresh public context** explicitly calls the proven `search-v3` endpoint with `from:<handle>`, capped at two people per session.
- Goobi does not use an unproven DM endpoint. The configured `twitter241` RapidAPI provider is treated as read-only public enrichment.
- `DRAFT_DM` is a separate Claude route and prompt. It receives bounded reasons, saved context, product data, and the manually recorded conversation history only after the user clicks Draft.

## Safety and honesty

- No automatic sending, bulk drafting, multi-select, inbox scraping, or automatic follow-ups.
- No claims about DM availability, mutual follows, delivery, reads, or replies.
- Commercial first messages need real supplied context or a meaningful user note.
- Connect first messages have no commercial ask.
- One unanswered follow-up maximum, due after seven days and required to add new value.
- Conservative product pacing, based only on manually marked sends: at most two first DMs/hour, five first DMs/day, and ten total marked sends/day.
- Near-duplicate drafts cannot be copied until edited. If the user already sent one directly on X, **Mark sent** can still record that truthful fact after an explicit warning.
- Private excerpts remain in `chrome.storage.local`, which is device-local but not encrypted. Every saved context item is removable; message text can be redacted while retaining the user's manual sent/replied event marker.

These are product guardrails, not claims about X's technical limit. The workspace footer always states that Goobi never sends automatically and cannot verify native DM state.

## Persistence and cross-tab behavior

Storage keys are account-specific: `goobi_x_dm_workspace_v1:<owner-handle>`. Candidates, context, and touches are bounded. Writes merge stable candidate/context/touch IDs so a second tab does not discard newer records. Removal writes a tombstone, preventing a stale tab from resurrecting a deleted candidate; manually adding that handle again explicitly revives it.

## Key files

- `extension/src/lib/dm-workspace.ts` — pure model, evidence gates, transitions, merge, due queue, pacing, and duplicate policy.
- `extension/src/lib/dm-intelligence.ts` — pure next-action ordering and self-reported outcome summaries; no I/O and no learned ranking.
- `extension/src/content/x-copilot.ts` — DM dock mode, candidate suggestions, profile/context enrichment, drafting UI, and manual pipeline controls.
- `extension/src/lib/prompts.ts` — `DM_DRAFT_SYSTEM`.
- `extension/src/lib/claude-client.ts` — bounded `draftDm()` call.
- `extension/src/background/service-worker.ts` and `extension/src/lib/types.ts` — `DRAFT_DM` routing.
- `extension/scripts/test-dm-workspace.mjs`, `extension/scripts/test-dm-intelligence.mjs`, and `extension/scripts/test-prompts.mjs` — pure transition, decision, metric, and prompt-invariant gates.

## Before you change it

- Keep owner isolation. Unowned Supporter/reply-log data must not be silently assigned to the active account.
- Keep public evidence visibly distinct from user-supplied private context.
- Do not infer consent or intent from follower count, a saved Target, or public engagement.
- A provider endpoint must have a captured fixture, parser, policy classification, and live verification before it enters this flow.
- Never make Copy/Open advance the pipeline, and never add code that submits X's native DM form.
- Automatic outcome learning stays off until there is a stable, independently observed DM event source and enough settled evidence.
