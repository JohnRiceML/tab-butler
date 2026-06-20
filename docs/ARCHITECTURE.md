# Tab Butler — Architecture

## Goal & scope

Two simple pieces: a Chrome/Edge **extension** that auto-bundles tabs, safely
auto-archives idle ones, and is made *smart* by Claude (semantic naming, ranked
cleanup); and a zero-dep **CLI** for localhost dev-server hygiene (list / kill /
Claude-clean). Claude is the brain via plain Messages-API calls — no agent
framework, no embedded Claude Code.

- **In scope (v1):** trust-core auto-archive · heuristic + Claude grouping ·
  search · cleanup advisor (extension); `ls` / `kill` / `clean` (CLI).
- **Out (v1):** always-on per-process RAM widget (was a Swift menubar app —
  removed in favor of the CLI), mobile, team sync.

## Components

**Two pieces, both JavaScript, both verifiable.** (Decided 2026-06-19 — collapsed
from 4 components/3 languages after the localhost-kill logic ended up duplicated
across a Swift menubar app and a Node native-messaging host. Both removed; the
CLI does their job more simply. They live in git history if the always-on RAM
widget is ever wanted.)

| Component | Tech | Role | Ships |
|---|---|---|---|
| Extension | MV3, TS, esbuild | The product surface for **browser tabs**: groups, idle-archive, search, Claude cleanup | v1 |
| Heuristic engine | In the SW, no network | Offline base: group-by-domain/opener, dedupe, idle-detect, archive, undo | v1 |
| CLI | Zero-dep Node | **Dev servers**: `ls` / `kill <port>` / `clean` (Claude picks stale ones). Lives in the terminal — no native messaging, no Swift | v1 |
| Proxy | Next.js route | **Parked.** Optional hosted Claude tier for a future paid plan; not required to run (default is local + BYO-key) | later |

## The honest RAM caveat

Per-*tab* RAM is impossible on stable Chrome: the only API that maps a tab to a
renderer PID with memory (`chrome.processes`) is Dev-channel only, and Site
Isolation breaks the one-tab-one-process model anyway (same-site tabs share a
renderer; one tab spawns many). Chrome's own Task Manager reports
per-**process**, not per-tab — so do we. The extension popup shows a system-wide
number; the **CLI** (`tab-butler ls`) shows real per-process Chrome RAM and
per-dev-server RAM in the terminal, where it belongs.

## Privacy tiers

| Tier | Data path | Who sees tabs | MVP? |
|---|---|---|---|
| Local | Heuristics only, no network | No one | ✅ default base |
| BYO key | Extension → Claude direct (user's key in storage) | No one but Anthropic | ✅ default smart path |
| Managed | Extension → parked Vercel proxy → Claude | You (request no-training retention) | later — paid "Smart" tier |

**Hard default: send id/title/url/idle only — never page content.** Full content
goes up only for the active tab on explicit "summarize/file this" (`activeTab`).
Sending titles/URLs triggers Chrome Web Store limited-use policy → posted
privacy policy + explicit opt-in (`smartEnabled`) before any Claude call.

## Claude integration

- **Models:** `claude-haiku-4-5` ($1/$5 per MTok) is the always-on workhorse
  (classify/name/label/rank). `claude-opus-4-8` ($5/$25) is the once-a-day
  advisor. Bulk/nightly work → Batches API (−50%).
- **Always structured output:** `messages.parse` + `zodOutputFormat(schema)`;
  `response.parsed_output` is validated. See `proxy/src/lib/claude.ts`.
- **Cache the taxonomy:** the system prompt (category rules + colors + naming
  house style) is frozen → `cache_control: { type: "ephemeral" }`. Per-batch
  classify input then bills ~0.1× once the prompt exceeds the model minimum
  (~4096 tokens for Haiku).
- **Cost:** regroup 100 tabs ≈ 1¢; per-page label ≈ $0.0005; nightly Opus
  advisor ≈ 3¢ (half via Batches). Pennies/day for a heavy user.

Endpoints: `POST /api/classify` (tabs→groups, Haiku), `POST /api/advise`
(state→ranked recs, Opus). Each is one stateless Messages call.

## Extension internals

- **Permissions (minimal):** `tabs`, `tabGroups`, `alarms`, `idle`, `storage`,
  `sessions`, `bookmarks`. Add `history` only when palette-history ships (harsh
  install warning). Avoid `all_urls`; use `activeTab` for opt-in summarize.
- **Ephemeral SW (~30s):** re-hydrate from `chrome.storage.local` on wake;
  schedule scans with `chrome.alarms` (min 30s), never `setTimeout`.
- **Idle-archive:** track `tab.lastAccessed`; past threshold → persist
  `{url,title,favicon,ts,tags}` to `storage.local` **before** close; undo toast.
- **Storage:** `storage.local` (archive + group map — Chrome doesn't persist
  groups), `storage.session` (transient), `storage.sync` (small prefs only).

## Trust & safety model (the actual moat)

- Archive-not-delete → everything recoverable; never a hard delete.
- Undo toast on every auto-action (≈30s), ⌘Z bound.
- Always-exempt: pinned, active, audible tabs.
- Web-app allowlist (Figma/Notion/Slack/Docs…) never auto-suspended.
- Claude recs are propose-then-confirm — nothing reorganizes silently.

## Build order (2–4 weeks)

1. **Week 1 — trust core:** idle-archive + archive store + undo + exemptions +
   allowlist. Prove it never "eats a tab." *(scaffolded)*
2. **Week 2 — heuristic grouping + ⌘K palette** over open/archive/recently-closed.
3. **Week 3 — Smart tier:** proxy + `/classify` + `/advise`, structured outputs,
   taxonomy cache, opt-in + privacy policy. *(scaffolded)*
4. **Week 4 — auto-bookmark + `/label` + `/recall`,** polish, store submissions.

**Done since:** the `tab-butler` CLI (dev-server `ls`/`kill`/Claude `clean`) —
this replaced the planned Swift menubar app + native-messaging host (simpler,
runs anywhere). Next: BYO-key Claude direct from the extension (drops the server
from the smart path).

**v2 — "Keep safe" shelf (deferred, decided 2026-06-19).** A propose-then-confirm
surface where Claude periodically flags tabs that look worth keeping ("these N
tabs look worth keeping → Save?") with a reason and a few **editable** categories
(Tools, References, Reading). Constraints, non-negotiable:
- **No silent auto-save.** Suggested-and-confirmed only — silent background
  collection makes a "we caught your important tab" promise the model can't keep,
  over-collects, and adds privacy surface. The real safety net stays
  archive-not-delete.
- Importance from title+URL alone is weak; doing it well needs visit-frequency
  (`history` permission) or page content (privacy cost) — gate behind opt-in.
- **No affiliate-specific detection** (considered + dropped 2026-06-19).
- Build only after the v1 core (trust-archive + grouping + cleanup) is validated.

## Open decisions

- **Managed-first or BYOK-first?** Decided 2026-06-19: **BYO-key first** — the
  extension calls Claude directly with the user's key (no server to run). The
  proxy stays parked for a future hosted paid tier.
- **Bookmarks vs. own store** for auto-filing — probably both: write to
  `chrome.bookmarks` (portable, user-visible) *and* index locally (tags/search).
