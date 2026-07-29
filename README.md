# Goobi

A draft-only **X/Twitter reply copilot** with a cute pixel pet — plus the
local-first **tab manager** it grew out of. Made smart by Claude (BYO key).

- **Finds posts worth replying to** — scores your timeline with Claude, marks the
  good ones in-feed with an explainable growth lane, and ranks them in an always-on dock.
- **Brings warm comments to the top** — a first-class Comments queue prioritizes
  recent people who replied to or mentioned you, with reply-history matching and
  a manual done control. Cold Target discovery stays available one level down.
- **Drafts in *your* voice** — one click; steer it ("punchier, ask a question") and
  regenerate. By default your click likes the selected post and fills X's reply box for review; a setting switches back to copy + open. Goobi never submits the reply.
- **Keeps today's work visible** — a top-level scorecard tracks verified replies,
  posts, and unique people you marked as DM'd against your own conservative goals.
- **Writes from your `SOUL.md`** — a local, user-owned creative brief supplies beliefs,
  earned experience, recurring themes, and boundaries while learned voice controls style.
- **Plans thoughtful DMs** — a per-account relationship workspace for sponsor,
  backlink, connection, co-marketing, customer, and partner conversations. Public
  API context helps you research; Goobi drafts and tracks only what you mark.
- **Runs account-level growth tests** — a Growth workspace holds one 14-day
  profile/post/reply strategy, compares it with the prior window, and tells you when
  to double down, tighten the execution, or try a new reason to follow.
- **Keeps your account safer** — volume / repeat-author / duplicate guards plus
  a visible, user-clicked Like + insert setting. It never auto-submits.
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

Prerequisites: Git, Chrome or Edge, and Node.js 20 or newer. The extension uses
your own Anthropic API key for Claude features; RapidAPI enrichment is optional.

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
5. Click Goobi's toolbar icon to open the side panel, accept the X data disclosure,
   add your Anthropic key, and set your niche.
6. Open or refresh `x.com`. Existing X tabs must be refreshed after every extension rebuild.

The tab-manager features work without an API key. X scoring and drafting stay off
until the disclosure is accepted and an Anthropic key is stored.

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

> New host/extension permissions need a full **remove + re-add** of the unpacked
> extension — a reload won't grant them.

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
- **DM workspace** stores the people, notes, drafts, and manually recorded conversation
  context you add in Chrome local storage. That person's selected context goes to Claude
  only when you explicitly click Draft. Goobi does not read the native X inbox or send DMs.

Claude is gated behind an explicit opt-in / a set key; keys live in `chrome.storage`
/ the service worker, never bundled or on-page. The Chrome Web Store limited-use
disclosures + a posted privacy policy must cover the X post text. See the
[architecture doc](docs/ARCHITECTURE.md) § Privacy and the
[changelog](CHANGELOG.md) § Before store submission.

## Status

v1, actively iterated. The X copilot (scan → score → badge → draft, five-mode dock,
Goobi + playground, account safety, profile/reply/post/DM learning loops) and the tab
manager + CLI all work. Not yet wired: the managed proxy tier (parked and excluded
from the shipping extension) and a few store-prep items, including the public privacy policy. See
[CHANGELOG.md](CHANGELOG.md).
