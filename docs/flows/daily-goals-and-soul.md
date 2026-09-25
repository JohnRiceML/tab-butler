# Daily goals + SOUL.md

> A top-level daily scorecard keeps Replies, Posts, and DM relationships visible across every Goobi workspace. A user-owned `SOUL.md` gives reply and post generation a stable point of view beyond surface-level tone matching.

## Daily scorecard

The scorecard sits directly below the main workspace tabs and is always visible while the dock is open. Each goal is configurable in the side panel; `0` turns it off. Defaults are deliberately moderate: **10 verified replies, 1 post, and 2 unique people DM'd**. Input caps (30 / 5 / 5) and the existing reply/DM safety gates prevent a volume goal from becoming spam coaching.

- **Replies** count only replies matched through RapidAPI or explicitly marked as posted/replied. Copy/open drafts do not count until confirmed.
- **Posts** use today's X-detected originals when available, falling back to posts explicitly marked shipped in Ideas. The larger count is used, not their sum, so the same post is not double-counted.
- **DM people** counts unique handles with an outbound message the user explicitly marked sent on the local calendar day. Goobi cannot inspect or verify the X inbox.

Selecting a goal routes to its workspace; **Edit goals** opens the side panel. Goals persist locally under `X_DAILY_GOALS_KEY` and update open X tabs through `chrome.storage.onChanged`.

## SOUL.md

Voice and SOUL.md solve different problems:

- **Voice** is learned or written style: cadence, casing, length, vocabulary, and examples.
- **SOUL.md** is the user's curated digital brain: beliefs, earned experience, recurring themes, useful proof, approved language, signature concepts, open questions, desired reader feeling, and creative boundaries.

The side panel provides a markdown textarea and an explicit starter template. It is user-owned, capped at 6,000 characters, stored locally under `X_SOUL_KEY`, and never generated or silently overwritten. On explicit creative actions, the service worker sends it with the user's voice to:

- reply drafting;
- LinkedIn comment drafting and redrafting;
- post-idea generation and its quality passes;
- single-idea rewrites.

It is intentionally excluded from DM drafting and ambient scoring. `soulPrompt()` labels the file as curated identity context. Only explicit earned-experience/proof sections support personal factual claims; aspirations, placeholders, style examples, and tentative ideas do not.

## POV as the editorial foundation

The shared `POV_POLICY` applies to X replies, LinkedIn comments, post ideas, the idea judge, regeneration, and single-idea rewrites. A recognizable point of view matters more than generic information or borrowed viral packaging. This is an editorial principle, not a reach guarantee or a claim that ideas cannot be copied.

The policy distinguishes three content tiers internally, without changing the existing output schema or displaying tier labels in drafts:

- **Commodity:** familiar advice, useful as background but insufficient as the whole contribution.
- **Personality:** the user's supplied perspective or supported experience applied to a specific situation.
- **Original:** a distinct implication, distinction, or framework developed from the user's thinking. Rephrasing is not originality, and Goobi cannot establish that an idea has never been expressed before.

Recognition comes from association: recurring beliefs and signature language should remain consistent while each post adds a fresh application, implication, or supported example. The duplicate guard rejects posts that add nothing; it does not ban returning to a core belief. Borrowed ideas still require credit. Popular source posts can inform structure, but must not replace the user's substance. A named tool or metric alone does not make a generic draft strong.

The human remains the primary thinker. Capture real moments, lessons, beliefs, and useful phrasing in SOUL.md, label unresolved questions, and save only material you stand behind. Goobi uses that library for requested drafts and adaptations; it never silently adds AI output to it. Existing saved SOUL.md content is preserved; the expanded template appears only through the explicit template action. This is a bounded, manually curated library, not automatic ingestion, retrieval over an unlimited archive, or model training. Publishing remains manual; this change does not introduce scheduling or automatic distribution.

With sparse context, Goobi should offer a grounded observation or question instead of manufacturing a distinctive philosophy or personal story. The quality judge treats invented beliefs and unsupported personal claims as weak. These are prompt-level editorial instructions, not proof that every generated draft will comply; review remains necessary.

## Key files

- `extension/src/lib/daily-goals.ts` — defaults, conservative bounds, normalization, and progress.
- `extension/src/lib/soul.ts` — template, length/sanitization, and the shared prompt block.
- `extension/src/lib/prompts.ts` — shared POV policy and creative generation/review instructions.
- `extension/src/content/x-copilot.ts` — top-level tracker and measured/manual daily counts.
- `extension/src/popup/popup.ts` — goal inputs and the SOUL.md editor/template action.
- `extension/src/background/service-worker.ts` / `extension/src/lib/claude-client.ts` — explicit-action prompt wiring.
