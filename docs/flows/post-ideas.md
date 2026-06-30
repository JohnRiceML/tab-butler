# Post ideas (remix + write originals)
> The Goobi X extension's "Ideas" mode: it mines posts over-performing in your niche right now, then writes 5 original drafts in your own voice that remix the winning *patterns* (never the content), each banded by how far it could realistically go.

**Surface:** Ambient on x.com. It is one of three top-level modes (`DockView = "replies" | "ideas" | "targets"`) inside Goobi's injected dock on the X timeline (`x-copilot.ts`, content script). Selecting the "ideas" mode renders `buildIdeas()` (dock branch at `x-copilot.ts:3141`). Not a popup; the popup only holds keys/settings.

## What it does for the user
You tap one button and Goobi pulls the recent posts that are over-performing in *your* niche, studies what made each land, and writes five fresh posts in your real voice that extend your own themes without repeating you or sounding like everyone else in the space. Each draft shows an honest "how far could this go" band grounded in the real measured rank of the proof post it remixed, plus the actual source post you can open. You can steer any draft (punchier, shorter, add a number, more me), edit it inline, then open it in X's composer to review and post — it never auto-posts.

## How the user uses it
1. Set your niche (and ideally voice + follower count) in the Goobi side panel — without a niche, the Ideas tab shows a gate, not a Generate button (`buildIdeas`, `x-copilot.ts:2924`).
2. Switch the dock to the **Ideas** mode and tap **✨ Generate ideas** (or **+ New batch** if you already have drafts). A big Goobi dances while it works (`mountIdeasGoobi`).
3. You get up to ~5 draft cards, newest batch on top, pinned-first then newest then strongest (`workingIdeas`). Each card shows a colored virality rail + band label (Strong / Solid / Niche / Long shot), the one-line hook, the borrowed pattern, and the source handle.
4. Click a card to expand it in place into an editor: the full draft (editable textarea), a one-sentence "why this works for you," steer chips + a free-text nudge + undo, and a collapsible quote of the **actual** over-performing source post (with real ❤/🔁 counts and an "Open post ↗" link).
5. Steer a draft with a chip ("Punchier", "Shorter", "+ number", "More me") or type a nudge — Goobi rewrites that one card in place, with one-level undo (`rewriteIdea`).
6. Tap **Open in composer ↗** (opens X's intent composer prefilled, marks it shipped) or **Copy**. Pin to survive a reroll, or ✓ to mark shipped manually. Shipped posts collapse into a "Shipped (n)" section with a ship-streak counter.

## How it works
**Trigger:** `generateIdeas()` (`x-copilot.ts:2457`), gated on a non-empty niche and a not-already-loading flag.

**1. Fetch niche posts (RapidAPI, not Claude).** Sends a `TWTTR_GET` `search-v3` `Latest` query (count 40) built from the niche plus server-side operators (`lang:en -filter:replies -filter:nativeretweets -filter:retweets -giveaway`). Distinct error branches handle `no-twttr-config`, `budget-*`, and HTTP failures. If raw results are thin (<15) or yield no winners, it does one raw retry without operators (`runSearch`).

**2. Pick the exemplars to remix (`pickBest`, `x-copilot.ts:2060`).** Pure-ish selection over `idea-quality.ts` helpers:
- Filter junk: drop replies, short text (<40 chars), RT-text (`looksLikeRT`), non-English (`isEnglish`), engagement-bait (`isBait`).
- Recency is a *preference*, not a gate: prefer ≤21d, fall back to ≤60d, then all usable (avoids the empty-pool failure).
- Score breakout with `scoreWinner`: follower-normalized engagement (`eng / max(8, followers*expectedRate(followers))`) times `log10(eng+10)` so absolute pull still matters; unknown-follower posts compete against the median of the unknown subset. `expectedRate` is the **size-tiered** "normal" rate to beat (~4% sub-1k … ~0.65% megas, from published benchmarks) — so a small account's genuine breakout beats a mega's floor post AND an ordinary-for-its-size small post isn't mistaken for one. (Replaced a flat 0.3% constant that over-rewarded micro-accounts; a live RapidAPI per-niche calibration would refine the tier numbers.)
- Engagement floor (40th percentile, min 10) is also preference-only — applied only if ≥3 clear it.
- De-dupe near-identical sources via `jaccard ≥ INPUT_DEDUP (0.6)`, sort by score, then enforce diversity quotas: ≤2 per author, ≤40% per shape (`classifyShape`). Returns rank-ordered, index 0 = strongest.

**3. Pull the user's own posts (`getOwnPosts`).** A cached (`OWN_POSTS_TTL` 24h) `from:<handle>` `search-v3` call → their recent originals (with likes/reposts when available). `[]` if no handle. These are the primary voice/structure anchor + de-dupe guard.

**4. Generate (Claude — Sonnet).** Content script sends a `POST_IDEAS` message → service-worker (`service-worker.ts:273`) reads voice + niche from storage → `generatePostIdeas` (`claude-client.ts:220`). BYO-key path only (`x-api-key` direct browser call; throws `no-key` if absent). Model **`claude-sonnet-4-6`**, `max_tokens: 2200`, system `POST_IDEAS_SYSTEM`. The prompt instructs a hidden 3-pass (draft 7 seeds → critique/cut → finalize 5), variety/hook/anti-AI-tell rules, and to return JSON with `text/source/pattern/why/critique/hookStrength (0-3)`. The model scores **only** the hook (0-3); it does not output an overall score. `callDirect` parses JSON with trailing-comma repair and a per-object salvage regex so one bad char doesn't torch the batch. Output is post-processed: `stripDashes` (deterministic em/en-dash + hyphenated-compound removal, with URL/handle shielding), handle de-@, hookStrength clamped 0-3, capped at 6, empty-text filtered.

**5. Attach the real proof post + compute the honest band (`x-copilot.ts:2490`).** For each idea, match the model-cited `source` handle back to a `winners` entry by **exact + normalized-exact only** (a loose prefix match could attach the wrong proof and inflate the band). The matched post's index gives `anchor = 1 - rank/(n-1)` (#1 → 1.0). `bandFor(anchor, hookStrength, hasSource)` (`idea-quality.ts:90`) combines the source's real rank with the hook grade into a 4-band label + a hidden continuous `sort` tiebreaker + a `basis` sentence that cites the real rank. No source → capped at Niche/Long shot.

**6. De-dupe + copy-leak guard (`x-copilot.ts:2515`).** Drop a fresh idea if it `copyLeak ≥ COPY_LEAK (0.6)` against its own source (it lifted content, not pattern), or `jaccard ≥ TOO_SIMILAR (0.5)` against one of the user's own posts, an earlier sibling, or a working idea already queued (cross-batch). If de-dupe nukes everything, keep all rather than show nothing.

**Persistence:** `ideaQueue` is persisted to `chrome.storage.local` under `X_IDEAS_KEY` via `persistIdeas` (prunes to `IDEAS_MAX = 30`, keeping working over posted). Loaded on init (`x-copilot.ts:3223`). `IdeaRecord` carries `band/basis/sortScore/src/pinned/status` etc. Session-only sets (`expandedIdeas`, `ideaUndo`, `ideaBusy`) reset on reload.

**Revise path:** `rewriteIdea` → `POST_IDEA_REWRITE` → `generatePostIdeaRewrite` (`claude-client.ts:249`), Sonnet `claude-sonnet-4-6`, `max_tokens: 400`, system `POST_IDEA_REWRITE_SYSTEM`, returns plain text (not JSON), `stripDashes`'d. One-level undo via `ideaUndo`.

**Health check:** `verifyApiAlive` (`x-copilot.ts:2449`) — when no winners are found, one cheap known-good `search-v3 "the"` query tells a genuinely quiet niche (HTTP 200 + results) apart from a dead integration (wrong provider / bumped endpoint → 200 + empty). Session-cached.

## What is honest about it / limits
- **The band is grounded, not fabricated.** The user-facing band combines the model's hook grade with the **real measured rank** of the actual source post in the user's own pull (`bandFor`'s `basis` cites that rank, never an invented multiple). No matched source → capped at Niche, so a hollow claim can't reach Strong. The model is explicitly told an inflated hookStrength will be "visibly contradicted by a weak source."
- **MEASURED:** the source post's engagement and rank (real X data via RapidAPI), the user's own-post likes/reposts. **MODEL-JUDGED (a proxy):** `hookStrength` (0-3, hook only — the model owns nothing beyond line 1). **INFERRED/heuristic:** breakout score (`scoreWinner` uses a size-tiered expected like-rate — published-benchmark prior — and a median fallback for unknown follower counts), English detection, shape classification, bait detection.
- **Remix the shape, never the substance.** The whole tool is built around not lifting a source's claim/number/wording. The `copyLeak ≥ 0.6` guard deterministically drops drafts that share too many content words with their own source; the prompt repeatedly forbids it. Voice is from the user's *replies* (tone only) plus their *own posts* (structure) — the prompt warns replies don't tell you how to structure a standalone post.
- **Draft-only / review keystone.** It never auto-posts. "Open in composer" opens X's intent composer prefilled for the user to review and post; tooltips state this explicitly. Marking shipped is the user's action (or implied by opening the composer).
- **What it cannot know:** whether a draft will actually perform (the band is a grounded estimate, not a prediction); anything about non-niche reach; exact follower-normalized rates when the API omits follower counts (it falls back to the unknown-subset median).
- **Graceful degradation over false confidence:** thin niches relax recency, the engagement floor, and the shape cap rather than failing; if de-dupe removes everything it keeps the batch; a config/budget error is surfaced distinctly from a dead-API shape.

## Key files
- `src/content/x-copilot.ts` — orchestration + UI: `generateIdeas`, `pickBest`, `verifyApiAlive`, `getOwnPosts`, the source-attach/band/de-dupe block, `ideaBandView`, `ideaCard`/`buildIdeas`/`steerRow`/`sourceBlock`, `rewriteIdea`, the `IdeaRecord`/`ideaQueue`/`persistIdeas` state.
- `src/lib/idea-quality.ts` — pure helpers (no DOM/fetch): tokens/`jaccard`, `copyLeak`, exemplar filters (`isEnglish`/`looksLikeRT`/`isBait`), `classifyShape`, `scoreWinner`/`percentile`, `bandFor`, and the constants (`TOO_SIMILAR 0.5`, `INPUT_DEDUP 0.6`, `COPY_LEAK 0.6`).
- `src/lib/prompts.ts` — `POST_IDEAS_SYSTEM` (the 3-pass generate prompt + hookStrength contract + source-attribution rule) and `POST_IDEA_REWRITE_SYSTEM`.
- `src/lib/claude-client.ts` — `generatePostIdeas` / `generatePostIdeaRewrite` (model selection, prompt assembly, JSON salvage, `stripDashes`), `rawCall`/`callDirect`.
- `src/background/service-worker.ts:273` — the `POST_IDEAS` / `POST_IDEA_REWRITE` message handlers (inject voice+niche from storage).
- `src/lib/types.ts:63` — the `POST_IDEAS` / `POST_IDEA_REWRITE` message shapes.
- `scripts/eval-post-ideas.mjs` — **Layer A**: $0, no-key offline eval of the deterministic guards in `idea-quality.ts` (esbuild → data-URL import). Part of the default gate.
- `scripts/eval-post-ideas-live.mjs` — **Layer B**: opt-in (`--live` + key, ~$0.20/run), generates with the real `POST_IDEAS_SYSTEM` (Sonnet) over seed fixtures, then a Haiku judge scores each batch 0-3 on anti-generic/voice/variety/hook/source-honesty. Not in CI; no-ops to exit 0 without a key.

## Before you change it
- **Two separated concerns:** the model scores **only the hook** (0-3); the *code* owns the virality band by combining that hook score with the source's real measured rank. Don't let the model emit an overall score, and don't let the band float free of a matched source — the honesty of the whole feature rests on `bandFor` + the exact-match source attach. A loose handle match (e.g. prefix) would silently attach the wrong proof and inflate the band; the code deliberately uses exact + normalized-exact only.
- **`idea-quality.ts` is the unit-tested core** (Layer A, in the default gate). The thresholds (`TOO_SIMILAR`, `INPUT_DEDUP`, `COPY_LEAK`, the size-tiered `expectedRate` baseline, the 21d/60d windows, the 40th-pct floor, ≤2/author, ≤40%/shape) are load-bearing tuning — changing them shifts which exemplars the model ever sees ("garbage in"). Keep `idea-quality.ts` import-free/DOM-free so the esbuild data-URL eval keeps working.
- **The generation prompt's quality is NOT unit-tested for free** — only Layer B (opt-in, costs money) measures it. Treat any `POST_IDEAS_SYSTEM` edit as needing a Layer B run for a before/after delta.
- **BYO-key only** for the idea paths (`generatePostIdeas`/`generatePostIdeaRewrite` throw `no-key` with no key — unlike `classify`/`advise`, there is no proxy fallback wired here). Generate uses Sonnet `claude-sonnet-4-6` (max_tokens 2200); rewrite uses Sonnet at 400.
- **`stripDashes` is a deterministic safety net** on top of the prompt's no-dash rule and shields URLs/handles/emails/domains so it never breaks a link — preserve that masking if you touch it.
- **Degradation-over-failure is intentional** throughout `pickBest` and the de-dupe block (preferences, not hard gates; keep-all-if-empty). Don't "tighten" these into hard filters without re-checking the empty-pool / quiet-niche cases — that was the "try a broader niche" bug.
- **Gotchas:** persistence prunes to 30 (working kept over posted); `prompts.ts` is intentionally import-free so both evals can data-URL it; the niche gate is a real no-op block, not a toast; `callDirect` has a per-object JSON-salvage regex keyed on `"text"` — a field rename there would break salvage.
