# Tab Butler — Architecture

## Goal & scope

A Chrome/Edge extension that auto-bundles tabs, safely auto-archives idle ones
into a searchable store, and is made *smart* by Claude (semantic naming,
cleanup recommendations, auto-bookmarking, natural-language recall). The native
menubar RAM/localhost app is **v1.5** — the differentiator, but not what proves
the product.

- **In scope (v1):** trust-core auto-archive · heuristic + Claude grouping ·
  ⌘K search · cleanup advisor · auto-bookmark · localhost labeling (titles).
- **Out (v1):** per-process/per-tab RAM widget, the Swift menubar app, mobile,
  team sync.

## Components

| Component | Tech | Role | Ships |
|---|---|---|---|
| Extension | MV3, TS, esbuild | The product. Owns tabs, groups, idle-archive, storage, UI; makes the Claude calls | v1 |
| Heuristic engine | In the SW, no network | Offline base: group-by-domain/opener, dedupe, idle-detect, archive, undo | v1 |
| Vercel proxy | Next.js route | Holds the Anthropic key (managed tier), auth, rate-limit | v1 |
| Menubar app | SwiftUI `MenuBarExtra` | System + per-**process** RAM + localhost node procs; pushes to extension via Native Messaging | **v1.5** |

## The honest RAM caveat

Per-*tab* RAM is impossible on stable Chrome: the only API that maps a tab to a
renderer PID with memory (`chrome.processes`) is Dev-channel only, and Site
Isolation breaks the one-tab-one-process model anyway (same-site tabs share a
renderer; one tab spawns many). Chrome's own Task Manager reports
per-**process**, not per-tab — so do we. The v1 extension shows a system-wide
number + reclaimable estimate; the v1.5 native app adds real per-process +
localhost figures.

## Privacy tiers

| Tier | Data path | Who sees tabs | MVP? |
|---|---|---|---|
| Local | Heuristics only, no network | No one | ✅ default base |
| Managed | Extension → Vercel proxy → Claude | You (request no-training retention) | ✅ paid "Smart" tier |
| BYO key | Native app (Keychain) → Claude direct | No one but Anthropic | v1.5 |

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

Then **v1.5:** SwiftUI menubar app + Native Messaging → real per-process RAM +
localhost + BYO-key.

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

- **Managed-first or BYOK-first?** Recommended: Local + Managed in v1 (smoothest
  UX, existing Vercel infra); BYOK with the native app in v1.5.
- **Bookmarks vs. own store** for auto-filing — probably both: write to
  `chrome.bookmarks` (portable, user-visible) *and* index locally (tags/search).
