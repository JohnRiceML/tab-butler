# Goobi

A draft-only **X/Twitter reply and LinkedIn comment copilot** with a cute pixel pet — plus the
local-first **tab manager** it grew out of. The recommended setup uses **Jev to find
conversations and Claude to draft replies**, with your own API keys.

Start with one loop: browse X, choose a reply spot, draft, then copy and post yourself.
Replies and Comments are the main views; search, post ideas, DMs, and growth tools
remain available from **More tools**. No RapidAPI key is needed for the basic feed flow.

**What makes it different:** scoring and coaching are grounded in **X's
open-sourced ranking code** (checked claim-by-claim against
[xai-org/x-algorithm](https://github.com/xai-org/x-algorithm) — see
`docs/INTEL.md`, not recycled 2023 weight tables), and a daily measure-back
loop records how **your** replies actually performed, labeling everything
`✓ measured on your data` vs `✦ algo prior`. Where it has no evidence, it
says nothing — every learning panel stays silent below its minimum sample
size rather than guessing.

A public, standalone version of that algorithm read — how X's For You ranking works as of the May 2026 open-source release, with per-claim provenance — lives at [docs/public/how-x-ranks-2026.md](docs/public/how-x-ranks-2026.md).

- **Finds posts worth replying to** — scores your timeline with Claude by default, marks the
  good ones in-feed with an explainable growth lane, and ranks them in an always-on dock.
- **Finds LinkedIn comment opportunities** — a separate, focused feed radar evaluates
  person fit, post fit, and whether you have a truthful contribution; incomplete, generic, and high-risk fits fail closed. It drafts a
  specific comment from LinkedIn-first voice notes, shared voice, and an optional non-stored real detail,
  shows the post author's local profile image, and copies it for manual review. **Copy & review**
  immediately labels the item **Commented**, records a local activity mark, and removes it from
  the queue; Undo is available. This shortcut is not platform verification. It never clicks Comment, fills a composer, reacts, connects,
  follows, or submits on your behalf.
- **Brings warm comments to the top** — a first-class Comments queue prioritizes
  recent people who replied to or mentioned you, with reply-history matching and
  a manual done control. Cold Target discovery stays available one level down.
- **Drafts in *your* voice** — one click; steer it ("punchier, ask a question") and
  regenerate. Goobi copies the draft but never clicks X's Reply control or writes into
  the composer. For off-page results it opens the exact status page; you click Reply,
  paste, review, and post manually.
- **Builds a Fresh Reach account radar** — every hunt rotates through focused and broad X-data
  searches, remembers promising accounts for 30 days, and scans a diverse bounded slice
  of practical and massive accounts for new originals. Massive accounts can enter the
  radar, but their posts still need an unusually open thread and a specific contribution.
  A second quality gate requires an exact detail and useful contribution; live cards
  show the observed age/replies/audience evidence and cool when it expires. The strongest
  live candidate is pinned as **Best observed reach opening now**, using content fit × live
  opportunity with only a bounded measured-momentum lift—not simply the biggest account.
  Premium is conversation context, never a promised For You or impressions boost.
- **Keeps today's work available** — expand today's pace details for a scorecard of verified replies,
  posts, and unique people you marked as DM'd against your own conservative goals.
- **Writes from your `SOUL.md`** — a local, user-owned creative brief supplies beliefs,
  earned experience, recurring themes, and boundaries while learned voice controls style.
- **Offers Jev-only fast analysis** — one toggle switches X and LinkedIn opportunity
  analysis to Jev while Claude continues writing comments. Jev selects source excerpts
  and predefined contribution directions, with brief rubric reasons and no automatic
  Claude fallback. Enable it in the recommended Jev setup under **Conversations**.
- **Optionally reviews comments with Jev** — a separately enabled TypeSafe reviewer checks
  requested X and LinkedIn drafts for unsupported experience, POV conflicts, and empty
  contributions. Observation mode records potential issues without altering drafts. See
  [the evaluation and setup notes](docs/flows/jev-comment-review.md).
- **Plans thoughtful DMs** — a per-account relationship workspace for sponsor,
  backlink, connection, co-marketing, customer, and partner conversations. Public
  API context helps you research; Goobi drafts and tracks only what you mark.
- **Runs account-level growth tests** — a Growth workspace holds one 14-day
  profile/post/reply strategy, compares it with the prior window, and tells you when
  to double down, tighten the execution, or try a new reason to follow.
- **Keeps your account safer** — volume / repeat-author / duplicate guards plus
  a copy-only reply handoff. There is no auto-like, auto-click, composer insertion,
  or auto-submit path.
- **Goobi, the pet** — a pixel blob that mirrors your real activity (hunting,
  thinking, sleeping) and a playground where you feed him the replies you sent.
- **Tab manager (the origin)** — auto-groups tabs by domain, safely archives idle
  ones (archive-not-delete + undo), with a Claude smart tier.
- **`tab-butler` CLI** — list / kill / Claude-clean localhost dev servers from the
  terminal.

See the [flow docs center](docs/flows/README.md) for how each feature works end to end,
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design,
[docs/SYSTEM.md](docs/SYSTEM.md) for where things live, [docs/goobi.md](docs/goobi.md)
for the mascot, [PRIVACY.md](PRIVACY.md) for the private-beta data notice,
[docs/RELEASE-CHECKLIST.md](docs/RELEASE-CHECKLIST.md) for external-release gates,
[HANDOFF.md](HANDOFF.md) for the maintainer runbook, and [CHANGELOG.md](CHANGELOG.md)
for what shipped + what's next.

> Renamed from **Tab Butler** → **Goobi** when the X copilot became the focus. Many
> internal identifiers + the `cli/` still say "tab-butler" — tracked in the changelog.

## Layout

```
extension/    MV3 Chrome/Edge extension (TypeScript, esbuild) — the X copilot + tab manager
cli/          Zero-dep Node CLI — list/kill/Claude-clean localhost dev servers
proxy/        Next.js proxy (parked) — optional hosted Claude tier; not on the live path
docs/         Architecture, system map, mascot reference
```

## Download and run

Prerequisites: Git, Chrome or Edge, and Node.js 20 or newer. For the recommended
setup, bring a TypeSafe API key for Jev analysis and an Anthropic API key for Claude
drafting. Claude-only analysis remains available. RapidAPI enrichment is optional.

```bash
git clone https://github.com/JohnRiceML/tab-butler.git
cd tab-butler
npm run setup
npm run verify
```

`npm run setup` performs a locked install from `extension/package-lock.json`.
`npm run verify` type-checks the source, runs every `test-*.mjs` suite, builds the
extension, and confirms that `extension/dist/` is a complete MV3 package.

To install the verified build:

1. Open `chrome://extensions` (or `edge://extensions`).
2. Turn on **Developer mode**.
3. Click **Load unpacked**.
4. Select the generated `extension/dist/` folder.
5. Follow the welcome guide: choose Jev + Claude (recommended) or Claude-only,
   add your own provider keys, and accept the relevant data disclosures. API usage
   is billed by your providers; a chat subscription is not an API key.
6. Set and save your focus. Voice notes are optional. Saved steps resume if you
   close setup; **Conversations → Guided X setup** reopens it any time.
7. Review the first-reply walkthrough and choose **Enable Goobi + open X**. Browse
   a few posts, open Goobi, and use **Scan this page** to refresh reply spots. Request
   a draft and copy it for manual posting. LinkedIn can be enabled separately.

See [the first-run guide](docs/flows/x-onboarding.md) for setup, resumption, and the
first-reply checklist. Keys are saved locally; setup does not make paid test calls.

The tab-manager features work without an API key. X scoring/drafting and LinkedIn
scoring/drafting each stay off until their own disclosure is accepted and an Anthropic key is stored.
Selecting Jev changes analysis for both enabled social copilots and requires its
separate consent and TypeSafe key. Existing provider choices are preserved; nothing
switches providers merely by updating. Refresh existing social tabs after every rebuild.

## Extension development

```bash
cd extension
npm ci
npm run verify
```

Useful individual commands:

```bash
npm run typecheck    # TypeScript only
npm test             # all zero-cost unit/regression suites
npm run build        # esbuild → dist/
npm run check:dist   # validate the generated unpacked package
```

> After an update, check the extension's permissions and grant any browser-requested
> additions. Avoid uninstalling an existing setup just to update it: uninstalling can
> erase its local settings and activity.

## Tests

```bash
npm test
```

The root command delegates to the extension's deterministic runner, which discovers
every `extension/scripts/test-*.mjs` suite. Live provider/model evaluation scripts
are deliberately excluded because they require credentials and incur usage costs.

## Dev servers — the CLI

A browser extension can't kill a process, and the terminal is the natural home for
dev-server hygiene anyway:

```bash
node cli/tab-butler.mjs ls          # list listening dev servers (port, RAM, uptime)
node cli/tab-butler.mjs kill 6006   # SIGTERM whatever listens on :6006
ANTHROPIC_API_KEY=sk-ant-... node cli/tab-butler.mjs clean   # Claude picks stale ones; asks first
cd cli && npm link                  # optional: global `tb ls` / `tb clean`
```

Zero dependencies. Only touches dev runtimes *listening* on a port. See
[cli/README.md](cli/README.md).

## Privacy (read before publishing)

Local-first + BYO-key, but the two surfaces differ:

- **Tab manager** sends tab **id / title / url / idle** only — never page content.
- **X copilot** sends **post text** to Claude — that's inherent to scoring + drafting
  a reply. Author handles also go to the Twttr (RapidAPI) provider for follower
  counts. Your saved SOUL.md is sent only when you explicitly request a reply draft,
  Post ideas, or an idea rewrite; it is not sent for ambient scoring or DMs.
- **LinkedIn copilot** sends feed post text visible to you, displayed author names, bounded visible headline/person-or-company/connection-label context, your user-written LinkedIn comment thesis, and shared focus when set to Claude for enabled ambient scoring. It does not fetch profiles. The selected post plus the same thesis/author context, shared focus when set, shared and
  LinkedIn-specific voice, SOUL.md, its fit guidance, steer, and any transient Real detail are sent only
  when you request a comment draft; redrafting also sends your edited draft. Real detail is not stored.
  Its activity ledger is separate from X, and it does not
  read LinkedIn messages.
- **DM workspace** stores the people, notes, drafts, and manually recorded conversation
  context you add in Chrome local storage. That person's selected context goes to Claude
  only when you explicitly click Draft. Goobi does not read the native X inbox or send DMs.
- **Personal posting model** parses an optional X account-content CSV in the side panel and
  discards its raw rows after building an owner-scoped aggregate. Only correlation-labeled
  structure/length counts and rates go to Claude when you explicitly generate Ideas or select
  Community Spark; another saved handle cannot use the model.

Claude is gated behind an explicit opt-in / a set key; keys live in `chrome.storage`
/ the service worker, never bundled or on-page. The Chrome Web Store limited-use
disclosures + a posted privacy policy must cover public post text from both social surfaces. See the
[architecture doc](docs/ARCHITECTURE.md) § Privacy and the
[changelog](CHANGELOG.md) § Before store submission.

## Status

v1, actively iterated. The full X copilot (scan → score → badge → draft, five-mode dock,
Goobi + playground, account safety, profile/reply/post/DM learning loops), focused
LinkedIn comment copilot, and tab manager + CLI all work. Not yet wired: the managed proxy tier (parked and excluded
from the shipping extension) and a few store-prep items, including the public privacy policy. See
[CHANGELOG.md](CHANGELOG.md).
