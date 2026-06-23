# Goobi

A draft-only **X/Twitter reply copilot** with a cute pixel pet — plus the
local-first **tab manager** it grew out of. Made smart by Claude (BYO key).

- **Finds posts worth replying to** — scores your timeline with Claude, badges the
  good ones in-feed (`82% · Add value`), and ranks them in an always-on dock.
- **Drafts in *your* voice** — one click; steer it ("punchier, ask a question") and
  regenerate. **Draft-only — it inserts into X's reply box, never auto-posts.**
- **Keeps your account safe** — volume / repeat-author / duplicate guards and
  human-paced likes, so you don't trip X's automation heuristics.
- **Goobi, the pet** — a pixel blob that mirrors your real activity (hunting,
  thinking, sleeping) and a playground where you feed him the replies you sent.
- **Tab manager (the origin)** — auto-groups tabs by domain, safely archives idle
  ones (archive-not-delete + undo), with a Claude smart tier.
- **`tab-butler` CLI** — list / kill / Claude-clean localhost dev servers from the
  terminal.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design,
[docs/SYSTEM.md](docs/SYSTEM.md) for where things live, [docs/goobi.md](docs/goobi.md)
for the mascot, and [CHANGELOG.md](CHANGELOG.md) for what shipped + what's next.

> Renamed from **Tab Butler** → **Goobi** when the X copilot became the focus. Many
> internal identifiers + the `cli/` still say "tab-butler" — tracked in the changelog.

## Layout

```
extension/    MV3 Chrome/Edge extension (TypeScript, esbuild) — the X copilot + tab manager
cli/          Zero-dep Node CLI — list/kill/Claude-clean localhost dev servers
proxy/        Next.js proxy (parked) — optional hosted Claude tier; not on the live path
docs/         Architecture, system map, mascot reference
```

## Quick start

```bash
cd extension
npm install
npm run build        # node build.mjs (esbuild) → dist/
npm run typecheck    # tsc --noEmit  (the type gate)
```

Load `extension/dist/` at `chrome://extensions` (Developer mode → Load unpacked).
Open the **side panel** (toolbar icon) to add your Anthropic key and turn on the X
copilot, then visit `x.com`. The tab-manager features (group-by-site, idle-archive,
undo) work with no key.

> New host/extension permissions need a full **remove + re-add** of the unpacked
> extension — a reload won't grant them.

## Tests

```bash
cd extension
for t in twttr policy hygiene pacing community; do node scripts/test-$t.mjs; done
```

Pure-lib unit suites (esbuild-transpiled, run on Node). `npm run typecheck` is the
type gate.

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
  counts.

Claude is gated behind an explicit opt-in / a set key; keys live in `chrome.storage`
/ the service worker, never bundled or on-page. The Chrome Web Store limited-use
disclosures + a posted privacy policy must cover the X post text. See the
[architecture doc](docs/ARCHITECTURE.md) § Privacy and the
[changelog](CHANGELOG.md) § Before store submission.

## Status

v1, actively iterated. The X copilot (scan → score → badge → draft, dock, Goobi +
playground, account-safety) and the tab manager + CLI all work. Not yet wired: the
"what's working" outcome-learning loop, the managed proxy tier (parked, placeholder
auth), and a few store-prep items (the placeholder proxy host, privacy policy). See
[CHANGELOG.md](CHANGELOG.md).
