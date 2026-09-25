# Goobi — Architecture

## What this is

**Goobi** is a Chrome/Edge (MV3) extension with two surfaces that share one tree:

1. **Social conversation copilots** *(the product today)* — the full X/Twitter
   surface scans your timeline, scores posts for reply-worthiness, and drafts replies.
   A focused LinkedIn surface separately scans feed posts visible to the user and drafts professional
   comments with LinkedIn-specific criteria. **Both are draft-only: they never post.**
   A pixel pet, **Goobi**, mirrors real activity.
2. **Tab manager** *(the origin, still shipped)* — auto-groups tabs by domain, safely
   archives idle ones (archive-not-delete + undo), and is made smart by Claude
   (semantic group names, ranked cleanup). A separate zero-dep **CLI** (`cli/`)
   does localhost dev-server hygiene in the terminal.

Claude is the brain via plain Messages-API calls — no agent framework, no embedded
Claude Code. See [SYSTEM.md](SYSTEM.md) for the file-level map and
[goobi.md](goobi.md) for the mascot.

> History: this started as **Tab Butler** and pivoted to the X copilot. Many internal
> names still say "tab-butler" (see [CHANGELOG.md](../CHANGELOG.md)). The Swift
> menubar app + native-messaging host were removed in favor of the CLI (2026-06-19);
> they live in git history if an always-on RAM widget is ever wanted.

## Components

| Component | Tech | Role | Ships |
|---|---|---|---|
| X content script | MV3, TS, esbuild | Full X copilot: scan → score → badge → draft, dock, Goobi + workspaces | v1 |
| LinkedIn content script | MV3, TS, esbuild | Focused comment copilot: feed scan → LinkedIn-specific score → draft → copy/Commented receipt | v1 |
| Service worker | MV3 background, ES module | Broker for Claude + the Twttr (RapidAPI) provider; tab-manager features (idle-archive alarm, grouping) | v1 |
| Side panel | `chrome.sidePanel` | Settings: BYO key, voice capture, SOUL.md, daily goals, products, niche, account-safety, the side-panel playground | v1 |
| CLI | Zero-dep Node | **Dev servers**: `ls` / `kill <port>` / `clean` (Claude picks stale ones) | v1 |
| Proxy | Next.js route | **Parked.** Optional hosted Claude tier for a future paid plan; not on the live path | later |

## The X copilot, end to end

A `MutationObserver` on the timeline drives an rAF-coalesced `scan()` that collects
tweet articles (skipping ads, your own posts, and already-seen ones). Batches go to
the service worker, which calls Claude (**Haiku**) to score each post 0–1 with a
reason + category. Posts ≥ `0.6` become **opportunities**: badged on the post and
surfaced in the dock, ranked live by `effectiveScore` = model-score × freshness ×
reach × reply-pileup × community-tier (freshness dominates — the first ~15 min is the
window). Reach comes from best-effort, budgeted **Twttr** (`twitter241` on RapidAPI)
`/user` lookups for follower/following/bio.

Drafting calls Claude (**Sonnet**) with the user's saved *voice* and user-authored
*SOUL.md*, the post, an optional angle/product, an optional **Community Spark** delivery
style (short, exact, conversation-opening), and a free-text *steer*. When the matching
owner imported an analytics CSV, Community Spark can also receive one aggregate,
correlation-labeled response-length prior. The reply action copies the draft and leaves X's
controls and composer untouched. If the post is off-page, the service worker only opens or
focuses its exact X status tab. The user clicks Reply, pastes, reviews, and posts manually,
then explicitly confirms it in Goobi. There is no auto-like or composer-insertion mode.
The reply log drives today's count, the rate/reputation guards, the "✓ commented"
badge, and the playground treats.

**Hardening:** id-dedup + a `seen` cache + per-session call caps for X's
virtualization; a clean `teardown()` on extension-context invalidation; `trapKeys`
so X's single-key shortcuts don't steal focus from our shadow-DOM inputs.

## The LinkedIn copilot, end to end

The separate `linkedin-copilot.ts` content script runs only in the top frame on
`www.linkedin.com`. After separate consent, it extracts bounded visible feed-post
records with activity/permalink identity plus bounded visible author headline/kind/connection context, skips promoted posts, and batches them to
the service-worker broker through dedicated `LI_SCORE_POSTS` and `LI_DRAFT_COMMENT`
messages. The broker independently validates the sender URL, current consent/enablement,
and bounded payload before selecting LinkedIn-specific prompts. A local LinkedIn comment thesis defines target audiences, worthwhile post situations, credible contribution lanes, exclusions, and repeat-author rules. The model must separately return person, post, and truthful-contribution fit; a deterministic fail-closed gate and relationship-diversity ranker decide what becomes ready. It reuses the user's
focus and SOUL.md, layers optional LinkedIn-specific voice over the shared voice fallback, and accepts a transient,
non-stored Real detail for grounded first-person claims; it never sends product context for LinkedIn. Sonnet drafts one
comment, a deterministic high-precision lint checks wrappers, clichés, pitches, hashtags, question count, and length,
and one targeted repair is attempted without regex-rewriting the prose. Its UI is isolated in Shadow DOM. Draft actions only
copy and scroll/highlight the exact visible post; the script never clicks Comment or
writes into a composer. **Copy & review** immediately records a local Commented mark and removes
the opportunity; this is a user-click workflow shortcut, not verification that LinkedIn accepted the comment.
The dock keeps an exact Undo action. Older metadata-only in-review receipts remain dismissible/markable.
LinkedIn activity does not feed X pace, learning, or growth claims. Post-author avatar URLs
remain ephemeral in the content script and are neither brokered nor stored.

## Privacy

Goobi is local-first and BYO-key, but **be precise about what leaves the browser** —
the two surfaces differ, and this matters for Chrome Web Store compliance:

| Surface | What goes to Claude | When |
|---|---|---|
| **X copilot — scoring** | The **post text** + author handle, saved focus, and saved product names/descriptions | Automatically as you scroll, once the copilot is enabled + a key is set |
| **X copilot — drafting** | The post text, your saved voice and SOUL.md, optional quoted-tweet context + product | On demand when you click Draft |
| **LinkedIn copilot — scoring** | Feed post text visible to the user + displayed author name + bounded visible headline/kind/connection label + saved focus + user-written LinkedIn comment thesis | Automatically as you scroll, once the LinkedIn copilot is enabled + a key is set |
| **LinkedIn copilot — drafting** | Selected feed post, bounded author context, prior person/post/contribution guidance, saved focus + comment thesis, shared + LinkedIn voice, SOUL.md, optional transient Real detail/steer, and edited draft when redrafting | On demand when you click Draft comment or Redraft |
| **Personal posting model** | Aggregate structure/length counts and rates only; **never raw CSV rows or post text from the export** | On demand when you click Ideas or select Community Spark |
| **X copilot — reach** | Author **handles** to the Twttr/RapidAPI provider | Best-effort enrichment |
| **Tab manager** | Tab **id/title/url/idle** only — **never page content** (except the active tab on an explicit "summarize/file this") | When the smart tier is opted in |

So the **tab manager's** "never page content" guarantee holds, but the social
copilots send post text visible on their supported surfaces to Claude — that's inherent to scoring/drafting. The store
limited-use disclosures + posted privacy policy must cover both platforms' post text, and
Claude tab features stay gated behind `smartEnabled` plus a key; X processing also
requires the versioned in-product data disclosure acceptance. Keys
live in `chrome.storage` / the service worker — never bundled or placed on the page.
The optional analytics CSV is parsed in popup memory; only its owner-scoped aggregate
model is persisted locally. Changing the saved handle pauses rather than cross-applying it.

## Claude integration

- **Models:** `claude-haiku-4-5` scores + classifies (the always-on workhorse);
  `claude-sonnet-4-6` drafts replies (quality matters); `claude-opus-4-8` is the
  once-a-day tab "cleanup advisor". BYO-key calls go direct to `api.anthropic.com`.
- **No SDK on the page** — the content script can't reach Anthropic (x.com CSP); all
  calls go through the service worker's `send()` broker.
- **Tab classify/advise** use structured output (`messages.parse` + a Zod schema) and
  cache the frozen taxonomy prompt (`cache_control: ephemeral`). The X scorer/drafter
  return plain text (free-form prose is fragile to JSON-wrap).
- The **parked proxy** (`proxy/`) is a future managed tier; its auth is a placeholder
  and its advise-model differs from the extension — not on the shipping path.

## Permissions (manifest)

`tabs`, `tabGroups`, `alarms`, `idle`, `storage`, `sessions`, `bookmarks`,
`system.memory`, `history`, `favicon`, `sidePanel`; host permissions
`api.anthropic.com` and `*.p.rapidapi.com` (Twttr). The parked managed proxy and
localhost are intentionally absent from the shipping manifest. Static content scripts
are scoped to X/Twitter and `www.linkedin.com`; no LinkedIn network host permission is
requested because the worker does not call LinkedIn. The
`tabs`/`tabGroups`/`history`/`system.memory`/`bookmarks` set serves
the tab-manager surface; `favicon` + `sidePanel` serve the copilot UI.

## The honest RAM caveat (tab manager)

Per-*tab* RAM is impossible on stable Chrome (`chrome.processes` is Dev-channel only,
and Site Isolation breaks one-tab-one-process). Chrome's own Task Manager reports
per-**process** — so do we: the popup shows a system number; the **CLI** shows real
per-process / per-dev-server RAM in the terminal, where it belongs.
