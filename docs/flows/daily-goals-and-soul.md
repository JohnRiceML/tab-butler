# Daily goals + SOUL.md

> A top-level daily scorecard keeps Replies, Posts, and DM relationships visible across every Goobi workspace. A user-owned `SOUL.md` gives reply and post generation a stable point of view beyond surface-level tone matching.

## Daily scorecard

The scorecard sits directly below the main workspace tabs and is always visible while the dock is open. Each goal is configurable in the side panel; `0` turns it off. Defaults are deliberately moderate: **10 verified replies, 1 post, and 2 unique people DM'd**. Input caps (30 / 5 / 5) and the existing reply/DM safety gates prevent a volume goal from becoming spam coaching.

- **Replies** count successful Like + insert attempts immediately (shown as pending until matched), plus replies matched through RapidAPI or explicitly marked replied. Copy/open drafts do not count until confirmed.
- **Posts** use today's X-detected originals when available, falling back to posts explicitly marked shipped in Ideas. The larger count is used, not their sum, so the same post is not double-counted.
- **DM people** counts unique handles with an outbound message the user explicitly marked sent on the local calendar day. Goobi cannot inspect or verify the X inbox.

Selecting a goal routes to its workspace; **Edit goals** opens the side panel. Goals persist locally under `X_DAILY_GOALS_KEY` and update open X tabs through `chrome.storage.onChanged`.

## SOUL.md

Voice and SOUL.md solve different problems:

- **Voice** is learned or written style: cadence, casing, length, vocabulary, and examples.
- **SOUL.md** is substance: beliefs, earned experience, recurring themes, useful proof, desired reader feeling, and creative boundaries.

The side panel provides a markdown textarea and an explicit starter template. It is user-owned, capped at 6,000 characters, stored locally under `X_SOUL_KEY`, and never generated or silently overwritten. On explicit creative actions, the service worker sends it with the user's voice to:

- reply drafting;
- post-idea generation and its quality passes;
- single-idea rewrites.

It is intentionally excluded from DM drafting. `soulPrompt()` labels the file as identity context—not evidence—and forbids turning aspirations/placeholders into factual claims or inventing personal details.

## Key files

- `extension/src/lib/daily-goals.ts` — defaults, conservative bounds, normalization, and progress.
- `extension/src/lib/soul.ts` — template, length/sanitization, and the shared prompt block.
- `extension/src/content/x-copilot.ts` — top-level tracker and measured/manual daily counts.
- `extension/src/popup/popup.ts` — goal inputs and the SOUL.md editor/template action.
- `extension/src/background/service-worker.ts` / `extension/src/lib/claude-client.ts` — explicit-action prompt wiring.
