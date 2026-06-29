# Reciprocity — "Who shows up for you"

> A device-local relationship map of the accounts that reply to or mention you, ranked by support, labeled mutual/fan, and guarded against becoming a like-for-like pod.

**Surface:** Ambient on x.com — a collapsible "Who shows up for you" section inside the content-script dock (`renderSupportersPanel`, rendered right after the sibling "Who you show up with" panel in `renderDock`). The underlying data is harvested only while you browse `x.com/notifications` (and `/notifications/mentions`). No popup surface.

## What it does for the user
It answers "who actually engages back with me?" by quietly reading your notifications page and tallying who replies to or mentions you. It ranks those accounts by a recency-weighted "support" score, tags each as mutual (you both show up) or a fan (they show up but you don't reply much), and shows how often and how recently they engaged. Crucially, it refuses to turn this into a reciprocity-pod: if too many of your recent replies go to accounts who engage you back, it warns you that X reads closed loops as coordination and throttles everyone in them.

## How the user uses it
1. Browse your X notifications normally (`x.com/notifications`, and/or the Mentions tab). Goobi silently harvests reply/mention events from the DOM as you scroll.
2. Open the Goobi dock on any x.com page and click the "Who shows up for you" header to expand it. The collapsed header shows either "learning" or an account count (e.g. "7 accts").
3. Until enough events are seen, you get a "Still learning who shows up for you — N/12 replies & mentions seen…" message prompting you to open notifications a few more times.
4. Once warmed up, you see ranked rows: avatar (tap → opens their profile in a new tab), @handle (link), a cadence arrow (↑/→/↓), a relationship badge ("↔ mutual" or "shows up for you"), an optional "thin" tag, a meta line ("replied 3× · mentioned 1× · last 2d · 4.2K followers"), and confidence pips (●●○).
5. If your replies cluster onto accounts who reply back, a nudge appears warning about the pod/closed-loop pattern. A footer reminds you it's a sample (not a ledger), likes aren't counted, and liking back to repay is exactly what X penalizes.

## How it works
**Trigger / harvest.** `scan()` (x-copilot.ts) route-guards on `location.pathname.startsWith("/notifications")` → delegates to `scanNotifications()` instead of the normal reply-scoring path. `scanNotifications` picks `kind = "mention"` on `/notifications/mentions` else `"reply"`, walks every `article[data-testid="tweet"]`, skips your own posts (via `selfHandle`), and dedups on the globally-unique status id (`key = info.id`) against `inboundKeys` — so a reply that also @-mentions you, rendering on both tabs, is counted once. Each new event is `pushInbound({ at: postedAtMs(el) ?? Date.now(), handle, kind, postId, avatar, name, key })`. Zero API/Claude calls — it only reads DOM the content script already sees.

**State / persistence.** Events live in the module-level `inbound: EngagedRecord[]` (+ `inboundKeys` index), capped at `SUPPORTERS_MAX = 1000`. `persistInbound()` drops anything older than ~60 days and writes the array to `chrome.storage.local` under `CONFIG.X_SUPPORTERS_KEY` (`"xSupporters"`, config.ts:39). Writes are debounced via `schedulePersistInbound()` (1.5s coalesce, so scrolling notifications doesn't thrash storage). On boot, `hydrateInbound(await getLocal(X_SUPPORTERS_KEY))` validates shape, drops >60d, caps to last 1000, rebuilds the key set. A `chrome.storage.onChanged` listener re-hydrates + re-renders when another tab's harvest updates the key (cross-tab sync, validated not trusted raw).

**Compute (pure, in supporters.ts).** When the panel is open, `renderSupportersPanel` calls:
- `aggregateSupporters(inbound, now)` — groups by handle; scores **reply + mention only** (`SCORED`/`SUPPORT_W`: reply 2.0, mention 2.0; **like/repost = 0, never scored**). Per account: recency-weighted (30-day half-life) intensity, count-anchored shrinkage toward the global mean (`K=5`), and a `reachBoost` clamped to [0.85, 1.4] so "a whale can't crown." Like/repost-only accounts can't be scored and don't rank.
- `rankSupporters(sup)` — splits into `ranked` (nSup ≥ `N_MIN`=3, sorted by support) capped at 5, and `learning` (below the gate); attaches confidence (0–3) and a `thin` flag (nSup < 3).
- `fuseMutual(aggregateAccounts(replyLog.sent, now), sup)` — fuses "who you show up with" (your outbound reply-investment from `replyLog.sent`) with "who shows up for you" (support). Both axes squashed with a **fixed** reference (the global mean), so a pair's label can't shift when an unrelated account joins. Labels: **mutual** (both high + both ≥ N_MIN), **fan** (they high, you low), **one-way-you** (you high, they low), else **acquaintance**. Only mutual/fan get a visible badge (`relBadge`).
- `supCadence(inbound, handle, now, truncated)` — this-week-vs-last reply cadence per account, suppressed (`null`) when the log is truncated.
- `reciprocalConcentration(inbound, replyLog.sent…author, now)` — the anti-pod guard: of your last `RING_WINDOW`=8 outbound reply targets, what fraction are accounts who engaged you in the last 30 days; fires a nudge at ≥ `RING_PCT`=0.4.

The collapsed header count uses a cheap inline pass (`scored` / distinct `seenHandles`) without running the full aggregation; the gate is `SUP_GLOBAL_THIN` (= supporters.ts `GLOBAL_THIN` = 12 total scored events).

## What is honest about it / limits
- **Measured:** replies and mentions — both render as full tweet articles with a clean status id, so they're captured reliably and are the only thing scored.
- **Not counted / can't know:** likes and reposts are lossy ("X and N others") and locale-fragile, so they're deliberately **not harvested and never scored** (the code comments call this out; v1 doesn't even capture the "also liked" chip in this path). Follows aren't detected at all. The footer states it plainly: "A sample from your notifications, not a complete list — likes aren't counted."
- **Proxy, not causation:** support is a recency-weighted intensity, shrunk for small samples; `reachBoost` deliberately caps high-follower accounts so a whale can't dominate the ranking. Follower counts are "their follower count when seen — not a reach estimate."
- **Honesty guards:** min-N gating (`N_MIN`=3) before any account is ranked/labeled; a global "still learning" floor (12 events); per-row `thin` tags and confidence pips described as "how much they've shown up — not a prediction"; cadence suppressed when the log is truncated; fixed-reference squash so labels are cohort-invariant.
- **Draft-only / pace keystone:** the panel takes **no engagement action** — every interaction is a link that opens the account's profile in a new tab; you decide whether to engage. The footer's keystone line: "Not a favor to repay: liking back to earn a like is exactly what X penalizes." The `reciprocalConcentration` nudge is the pace/anti-pod enforcement — it actively discourages the closed reciprocal loop X throttles.
- **Privacy:** "Your notifications stay on your device." All state is `chrome.storage.local`, never leaves the browser, capped to ~60 days / 1000 events.

## Key files
- `extension/src/lib/supporters.ts` — the pure reciprocity engine: `aggregateSupporters`, `rankSupporters`, `fuseMutual`, `cadence`, `reciprocalConcentration`, plus all constants (`K`, `N_MIN`, `GLOBAL_THIN`, ring thresholds, `SCORED`/`SUPPORT_W`). No DOM/chrome/fetch.
- `extension/src/content/x-copilot.ts` — the I/O half: `scan()` route guard + `scanNotifications()` (DOM harvest), the `inbound` store with `hydrateInbound`/`pushInbound`/`persistInbound`/`schedulePersistInbound`, `renderSupportersPanel()` + `relBadge()`, and boot/`onChanged` wiring.
- `extension/src/lib/config.ts` — `X_SUPPORTERS_KEY: "xSupporters"` (line 39), the storage key.
- `extension/scripts/test-supporters.mjs` — unit tests for the pure engine.

## Before you change it
- **The pure/I-O split is load-bearing.** `supporters.ts` is pure and **unit-tested** (`extension/scripts/test-supporters.mjs`); x-copilot.ts owns all DOM/storage I/O and is **not** unit-tested. Keep scoring/labeling logic in the pure module so tests cover it.
- **Dedup key = status id.** `scanNotifications` dedups on `info.id` precisely so a reply-that-also-mentions you (which appears on both `/notifications` and `/notifications/mentions`) is counted once. Don't switch to a `${kind}:${id}` key here or you'll double-count cross-tab.
- **Likes/reposts are intentionally unscored** (`SCORED.repost = SCORED.like = false`, weights 0). This is an honesty decision, not an oversight — `EngagedKind` includes them for forward-compat, but scoring/ranking ignores them. Re-enabling scoring would break the "we don't guess" honesty contract and the footer copy.
- **Fixed-reference squash is deliberate.** `fuseMutual` uses `inv.muInvest`/`sup.muSup` as fixed refs so labels don't churn when the cohort changes. Don't make `ref` cohort-relative.
- **Storage caps & TTL.** `SUPPORTERS_MAX = 1000` is enforced in three places (`hydrateInbound`, `pushInbound`, `persistInbound`); the ~60-day cut appears in both hydrate and persist. Keep them in sync. Note `inbound.length >= SUPPORTERS_MAX` is what sets `truncated`, which suppresses cadence — silently raising the cap changes cadence behavior.
- **Cross-tab sync re-hydrates, never trusts raw** — the `onChanged` handler runs foreign writes back through `hydrateInbound` (shape-validate, TTL, cap). Preserve that on any storage-write change.
- **`fuseMutual` depends on `aggregateAccounts(replyLog.sent, …)`** from the learn-stats/insight side. Changes to the outbound reply log shape ripple into the mutual/fan labels and the anti-pod ring.
- **The anti-pod nudge is a feature, not a warning to suppress** — `reciprocalConcentration` (window 8, 40% threshold) exists to refuse the like-for-like pod pattern. Don't weaken it to make the panel "look more reciprocal."
