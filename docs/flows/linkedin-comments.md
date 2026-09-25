# LinkedIn comment opportunities

## What it does for the user

Goobi watches posts visible in the LinkedIn feed after explicit consent, identifies the small
set of people and posts where the user can make a specific professional contribution, and keeps
those opportunities in a compact on-page radar. A user can ask for a comment draft in
their saved voice, copy it, review it in context, and post manually. Copying immediately
marks the opportunity Commented in Goobi and removes it from the queue.

## How the user uses it

1. Open Goobi's side panel and accept the separate LinkedIn disclosure.
2. Store an Anthropic key and write the **LinkedIn comment thesis**: professional arena, who matters, posts worth joining, credible contribution lanes, exclusions, and relationship spacing. The shared focus can serve as a fallback; shared voice, LinkedIn-specific voice, and SOUL.md are optional.
3. Open `www.linkedin.com/feed/` and browse normally; enabled state changes apply to open tabs.
4. Open **Comment opportunities**, choose a post, and select **Draft comment**. For a personal experience claim,
   add one **Real detail from you**; it is sent only for that draft and is not stored.
5. Select **Copy & review**. Goobi copies the draft, immediately shows **Commented**, records a
   local activity mark, removes the opportunity, scrolls to the exact post, and keeps Undo available.
6. Use LinkedIn's own Comment control, paste, review, and submit it yourself. Goobi does not verify
   submission; Commented reflects the Copy & review click. Older in-review receipts can still be marked or dismissed.
7. **Clear all ready** removes all current-session opportunities. **Clear all in review** dismisses all
   copied receipts. Neither action changes confirmed comment activity.

## How it works

See [Commenting reliability](commenting-reliability.md) for shared request controls, cancellation,
failure recovery, and the priorities spanning X and LinkedIn.

`src/content/linkedin-copilot.ts` extracts a bounded visible-post record from resilient
feed selectors, skips promoted content, deduplicates by activity/permalink identity,
and batches candidates through `{type: "LI_SCORE_POSTS"}`. The
service worker uses `LINKEDIN_SCORE_SYSTEM`, not the X ranking prompt. The scorer must return complete post-fit, person-fit, contribution-fit, evidence, risk, anchor, and contribution-lane fields. A pure fail-closed policy blocks missing/unsafe results, while local relationship history suppresses very recent repeat authors, caps repetition, and keeps one best active post per author. Eligible posts
are surfaced in an isolated Shadow DOM dock and with a subtle in-feed rail.

Draft actions cross the same service-worker boundary through
`{type: "LI_DRAFT_COMMENT"}`. The service worker uses `LINKEDIN_DRAFT_SYSTEM` with the
shared focus, LinkedIn comment thesis, bounded visible author context, LinkedIn-first voice plus shared fallback voice, SOUL.md, fit guidance, and the user's optional
transient Real detail and steer. A redraft also sends the edited current draft. A deterministic comment-quality
check triggers at most one targeted model repair for high-confidence generic or performative output; it never
regex-rewrites the user's prose. The content script copies the result and can scroll/highlight
the matching visible post. It never clicks LinkedIn controls or writes into the page's
composer. Copy & review writes a local Commented activity mark and removes the opportunity immediately;
the UI explicitly labels this as unverified by LinkedIn and offers exact Undo. Activity states live under
`LI_COMMENT_LOG_KEY`, separate from the X reply ledger. Author image URLs remain
ephemeral UI data and are never included in model messages or activity storage.

## What's honest / limits

- Feed extraction is best effort because LinkedIn controls its DOM and can change it.
- Scores represent separate person, post, and truthful-contribution guidance, not LinkedIn ranking weights or
  a prediction of impressions, profile views, connections, or business outcomes.
- The v1 has no LinkedIn API/provider enrichment, notifications harvest, message read,
  analytics import, auto-reaction, connection/follow action, or outcome measurement.
- The DOM overlay is for controlled private use pending a platform-policy review for
  any public distribution.

## Key files

- `extension/src/content/linkedin-copilot.ts`
- `extension/src/lib/prompts.ts`
- `extension/src/lib/claude-client.ts`
- `extension/src/lib/linkedin-strategy.ts`
- `extension/src/lib/linkedin-opportunity-ranking.ts`
- `extension/src/background/service-worker.ts`
- `extension/src/popup/popup.ts`
- `extension/manifest.json`

## Before you change it

Preserve separate consent and activity storage. Keep every contribution draft-only
and copy-only. Never add a LinkedIn control click, composer write, submit, reaction,
connect, follow, or private-message read path. Keep LinkedIn prompts independent from
X ranking claims, and manually smoke-test selectors after every DOM-facing change.
