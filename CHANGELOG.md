# Changelog

Notable changes + the phase-transition record. The day-to-day lives in git history.

## Phase: X reply copilot + Goobi — through 2026-06-23

The product pivoted from **Tab Butler** (a tab manager) to **Goobi**, an X/Twitter
reply copilot with a pet mascot. The tab manager still ships. What landed:

**Copilot**
- Scan → score (Claude/Haiku) → in-feed badge → draft (Claude/Sonnet) pipeline, with
  `effectiveScore` ranking (model × freshness × reach × pileup × community-tier).
- In-feed badge shows **reply-fit % + category tag**, and flips to a green
  **"✓ Commented"** call-out on posts you've already replied to.
- **Draft steering**: a free-text "steer it" box + Regenerate; composes with the
  angle chips. Draft-only — inserts into X's reply box, never auto-posts.
- The always-on **dock**: ranked cards, sort tabs (best/recent/reach/easy), filter,
  account-safety pace chip, kebab (pause / find spots / clear), minimize-to-pill with
  an overlapping **avatar stack** of the top authors.
- **Community/peer-builder** signal (`community.ts`) — surface peers worth engaging
  even off your exact topic.
- **"+ Add" override** on posts the scorer passed on (pin + score them yourself;
  manual opps are never pruned).
- **Post ideas** tab in the dock (`POST_IDEAS` → `generatePostIdeas`): pulls the
  best-performing recent posts in your niche (Twttr `search-v3` Top → `pickBest`,
  ranked by engagement, ≤2 per author) and remixes the winning PATTERNS — never the
  content — into original posts in your voice (Sonnet, `POST_IDEAS_SYSTEM`). Copy or
  open in X's composer; draft-only. (A richer per-account "above their average"
  sourcing was prototyped then pulled back to keep v1 simple — see git history.)
- Resilience: clean **context-invalidation teardown**; **`trapKeys`** fix so X's
  keyboard shortcuts stop stealing focus from our inputs.

**Goobi (mascot)** — see [docs/goobi.md](docs/goobi.md)
- Pixel-blob renderer (`goobi.ts`) with mood→animation mapping driven by real signals
  (hunting / thinking / sleeping / ease-off), livelier idle, floating hearts, cleaner
  sleep "z".
- **In-dock playground**: spring-open panel, today's replies become treats (wearing
  the author's avatar) you feed him; feeding drives an energy meter (pets barely
  count); at the bar he unlocks "go hunt" (rescan) and does a **random trick**
  (dance / spin / flip / …). Fed treats are remembered across sessions.

**Repo (2026-06-23 cleanup)**
- Removed dead code (`metaLine`, `GET_STATE` + handler, `findDuplicates`, the
  write-only `data-tbx-cat`, the unused `g-breathe` keyframe, a stray import).
- Fixed the side-panel account-safety icons (Tabler font wasn't bundled → emoji).
- Rewrote README + ARCHITECTURE; added [docs/SYSTEM.md](docs/SYSTEM.md) (where things
  live); marked `docs/goobi-design-v1.md` historical.

## Next phase

- **"What's working" learning loop.** `SentRecord.outcome` is reserved but
  **unimplemented** — no measure pass writes it. Build the paced `/user-replies`
  match → engagement read → feed it back into ranking/voice.
- **Side-panel playground parity.** The popup playground is a separate, simpler copy;
  it doesn't share the dock's persisted fed-set or the new trick variety.
- **Twttr response cache (v2).** `twttr-governor.ts` dedupes in memory only;
  `TWTTR_BUDGET.FAIL_TTL` is reserved for a storage-backed negative cache that isn't
  wired yet.
- **Decide the tab-manager's future** — keep Goobi dual-purpose, or split the tab
  manager out. It still ships + runs but is orthogonal to the copilot.

## Before store submission

- **Remove/replace the placeholder host** `https://YOUR-PROXY.vercel.app/*` in
  `manifest.json` (invalid → store warning).
- **Post a privacy policy** covering the X **post text** the copilot sends to Claude,
  and keep Claude behind the explicit opt-in (limited-use compliance).
- **Managed proxy is non-functional**: `claude-client.ts` ships a placeholder
  `Bearer dev-placeholder-token`; `proxy/src/lib/http.ts` reflects any extension
  origin (CORS) — both flagged `TODO(prod)`. The proxy is parked; the live path is
  BYO-key direct.
- **Model drift**: the parked proxy's advise-model (`opus-4-8`) differs from the
  extension's `advise()` (`haiku-4-5`) — reconcile if the proxy is ever shipped.

## Rename relics (Tab Butler → Goobi)

Renamed: the user-facing name (manifest, side panel, brand voice) and the dev console
prefixes. **Still "tab-butler"** (left intentionally — internal / out of scope):

- The **CLI** (`cli/tab-butler.mjs`, bins `tab-butler`/`tb`) — genuinely a separate
  dev-server tool; keeping its name is fine.
- Package names (`tab-butler-extension`, `tab-butler-proxy`).
- Internal DOM markers (`dataset.tbx`, `data-tbx-badge`) and `CONFIG.SCAN_ALARM`
  (`"tab-butler-scan"`) — renaming the alarm key would orphan existing alarms; not
  worth it. No user-visible strings.

## Deferred / known low-priority

- `emitHearts`/`emitSleepZ` set `position:relative` on the mascot host and don't
  restore it (harmless for those elements).
- `engagement()` parses `reposts`/`views` that nothing consumes yet (kept for future
  ranking).
- `Opp.source` union has a `"feed"` arm that's never assigned (feed opps leave it
  `undefined`).
- Two product-storage schemes coexist: `X_PRODUCTS_KEY` (array) + legacy
  `X_PRODUCT_KEY` (string, read for back-compat, cleared on save).

## Earlier — Tab Butler

The original tab-manager scaffold + the consolidation from 4 components/3 languages
to extension + CLI (the Swift menubar app + native-messaging host were removed
2026-06-19; in git history if an always-on RAM widget is ever wanted). See
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
