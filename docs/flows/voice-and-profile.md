# Voice + profile (the popup)

> The X-copilot settings screen where you tell Goobi who you are — handle, niche, voice, SOUL.md, daily goals, products — and one-click "learn" your reply voice from your real X history.

**Surface:** the extension popup, the **"X copilot"** tab (the second vtab next to "Tabs"). Lives entirely in `src/popup/popup.ts` → rendered into `#view-x`. None of this is on x.com itself; it is the config that the on-page dock and background scoring read.

## What it does for the user
This is the one place you describe yourself so every draft sounds like *you* and targets the right posts. You fill in what's worth replying to (niche), a reply-voice sample, and a user-owned **SOUL.md** for your beliefs/themes/boundaries; set daily Reply/Post/DM-person goals; then optionally add products and draft defaults. **Learn my voice** reads recent replies for style only. Everything is stored locally.

## How the user uses it
1. Open the popup and click the **"X copilot"** tab.
2. See **"Replies sent"** (today / week / all-time counters + a 7-day bar trend), the **"Account safety"** card (Healthy / Caution / Ease off, with a reply-pace meter), and the **"Signal health"** card — why the honest panels are quiet, in numbers: the outcome measure pass's last run, measured outcomes vs the fit-validity gate (n/12), engaged-back credits, harvest freshness (notifications / own-posts / profile-coach), and coverage-cache sizes. Every learner stays silent below its min-N gate rather than guessing; this card is the distance to each gate — so "quiet" and "broken" stop looking identical.
3. Toggle the copilot on/off with the switch in the section header.
4. Fill **"What's worth replying to"** (niche textarea) and add **products** (name + optional URL + one-liner each; "+ Add product" appends a row, favicons hydrate from Chrome's cache). The niche does double duty, and the format matters: **search keywords first, then `;`, then intent** (e.g. `AI SaaS, indie founders, MRR; posts I can add a specific build lesson to`). Every search path (Find spots, post ideas, heavy hitters) runs the keyword clause through `twttr.ts:nicheSearchQuery`, which **ORs your topics** so a post matching ANY of them qualifies (a raw multi-keyword niche is an implicit AND that returns almost nothing — the cause of the "try a broader niche" empty-pool error); the full text — intent included — goes to the Claude scorer. Phrase the keywords as words that appear in *substance* posts, not in bait ("MRR", "shipped", a stack), or the searches pull the niche's spam slice. Live-verified behavior note: on **Latest** searches the busiest topic can flood the recency window (the OR is honored, but a topic posted every second drowns a slower one in a 40-post pull) — if one of your topics never surfaces, run it as its own niche occasionally or lean on Top-based surfaces (heavy hitters) where slower topics compete on engagement instead of recency.
5. Optionally set **Draft defaults** — a default angle and (if products exist) a default product. Also set your **X Premium tier** — an honest context flag that NEVER changes any score: external data (Buffer, 18.8M posts) shows tier is the largest reach covariate, so Goobi uses it only in coaching copy (a labeled external-study callout for free-tier users; silence when unset — unknown ≠ free).
6. **The profile coach** (renders in the dock's insights panel): visit your OWN profile once with Goobi on and it harvests the conversion surface at $0 (pinned post id + bio length, DOM-only, guarded against half-loaded pages). `profile-check.ts` then reports measured findings — "your pinned post ranks #4 of your last 15 by views — your #1 isn't pinned", empty/thin bio — because replies earn the profile CLICK but the profile converts it into the FOLLOW, and that surface was previously untouched by the product. Silent without a harvest; never guesses.
7. Paste a **RapidAPI key** (twitter241 provider) to enable reach-aware ranking + voice-learning; a monthly usage meter shows if a key is stored.
8. Type your **X handle** and click **"Learn my voice."** A toast streams progress ("Reading @handle's recent replies…"); on success the **voice** textarea is filled with your real replies and scrolled into view.
9. Edit the voice box if desired. Fill **SOUL.md** directly or use the starter template; voice controls style, while SOUL.md controls point of view and boundaries.
10. Set daily goals for verified Replies, Posts, and unique people DM'd (`0` disables one), then click **Save changes**.

## Settings survive reinstalls: the local seed file
A plain extension **reload keeps everything** (`chrome.storage.local` persists). What wipes settings is a **remove + re-add** (needed when permissions change). The fix: copy `extension/goobi.local.example.json` → `extension/goobi.local.json`, fill in your keys / handle / followers / niche / voice / products, and build. The build copies it into `dist/`, and on a fresh install the service worker (`seedFromLocalFile`) fills every **empty** setting from it — it never overwrites values you've since edited in the panel. The file holds real secrets in plaintext, so it is **gitignored** (and `dist/` is too): machine-local only, never commit or share it, rotate anything that leaks.

## How it works
**Load:** `getData()` reads all `X_*` keys from `chrome.storage.local` (niche, voice, SOUL.md, daily goals, products, default angle/product, RapidAPI key presence, handle, reply log) plus, if a key is stored, a `GET_TWTTR_METER` round-trip to the service worker. `render()` builds the `#view-x` HTML. Reply stats come from `computeReplyStats()` over the per-day `X_REPLY_LOG_KEY` buckets (pure local read, no API). Account-safety level comes from `reputationStatus(repliesThisHour)` in `reply-hygiene.ts`.

**Save** (`dispatch` → `case "save-x"`): reads the DOM fields and writes `X_NICHE_KEY`, `X_VOICE_KEY`, `X_SOUL_KEY`, normalized `X_DAILY_GOALS_KEY`, defaults, tier, and handle. SOUL.md is capped at 6,000 characters; goals are bounded by `daily-goals.ts`. The RapidAPI key is only overwritten when a new value is typed. Products persist separately through `saveProducts()`.

**Learn my voice** (`dispatch` → `case "learn-voice"`) is the marquee pipeline:
1. Reads the handle from the field (toasts and bails if empty); persists any just-typed RapidAPI key first so the SW sees it.
2. `TWTTR_GET path:"user"` (via `send` → service worker) → `parseUser(twttr.ts)` flattens the user node (tolerant of legacy `legacy.*` and new `core.*`/`relationship_counts.*` shapes) to get `id`, canonical `handle`, `followers`. Stores `X_MY_HANDLE_KEY` + `X_MY_FOLLOWERS_KEY`, and reflects the canonical handle back into the input.
3. `TWTTR_GET path:"user-replies-v2" count:"40"` → `pickVoiceSamples(rres.data, user.id, 12)` (`twttr.ts`): keeps tweets whose `authorId === userId`, prefers `isReply` ones (falls back to all own tweets if <4 replies), runs `cleanSample()` (strips leading @mentions + t.co links, collapses whitespace), and drops anything <16 chars, <3 words, or with no letters — i.e. emoji-only/one-word quips.
4. `buildVoiceProfile(handle, samples)` (`twttr.ts`) wraps them in: *"Recent replies @handle actually wrote on X. Match this voice, rhythm, vocabulary, and length. Do not copy them verbatim."* + a bulleted list. This string is written to the voice textarea and `X_VOICE_KEY`.

**API/model costs:** the only network calls here are to the third-party RapidAPI X-data provider (`twitter241.p.rapidapi.com`, host fixed in `CONFIG.TWTTR_HOST`), proxied through the service worker with budget guards (`budget-*` and `no-twttr-config` error codes are handled with specific toasts). **No Claude call happens in the popup's voice/profile flow** — there is no LLM here; `buildVoiceProfile` is pure string assembly. (Claude is only invoked elsewhere: Smart tab grouping, "Suggest cleanup", recall search, and on-page x.com drafting/scoring.) Persistence is entirely `chrome.storage.local`.

**How this feeds other flows:** `xNiche` decides what is relevant; `xVoice` controls style; `xSoulMd` supplies the user-authored point of view for explicit reply/post generation; products/defaults steer applicable drafts. SOUL.md is not used as evidence and is not sent for DM drafts. `xDailyGoals` powers the cross-workspace daily scorecard. `xMyHandle` + `xMyFollowers` size the reach sweet spot and power account-scoped data.

## What is honest about it / limits
- **Voice is MEASURED, not invented:** the profile is built only from replies the API confirms the user authored (`authorId === userId`), with a guard that drops trivial one-word/emoji samples so the drafter learns real prose. The prompt explicitly says "Do not copy them verbatim."
- **Followers/replies are a third-party PROXY:** all X data comes from twitter241 on RapidAPI, *not* X's official API — the UI states this plainly ("Programmatic X data access is outside X's API terms, so opt in knowingly. Stays off until you add a key."). `following` is left `undefined` (not 0) when absent so reciprocity logic stays neutral rather than treating the user as a broadcaster.
- **No-auto-submit keystone:** the X-tab footer states that Like + insert may fill X's reply box after the user's click, but Goobi never submits or posts. The Account-safety card reinforces that the user still reviews and controls the final action.
- **Pace honesty guard:** the safety panel surfaces the same conservative 6/hr caution and 10/hr pause lines the on-page nudges use, explicitly labels them as Goobi guardrails rather than X limits, and shows accounts-spread today.
- **What it cannot know:** local reply-attempt counts include successful composer fills before provider verification, so abandoning a filled X draft can temporarily overcount. Follower count is best-effort and can be stale/zero until a successful resolve.

## Key files
- `src/popup/popup.ts` — all render + dispatch logic for the X-copilot tab (save-x, learn-voice, product rows, safety/showcase cards).
- `src/popup/popup.html` — popup shell, theme tokens, vtab/switch/card CSS, mounts `popup.js`.
- `src/lib/config.ts` — `CONFIG` storage-key constants (`X_NICHE_KEY`, `X_VOICE_KEY`, `X_MY_HANDLE_KEY`, `X_MY_FOLLOWERS_KEY`, `TWTTR_KEY_KEY`, `TWTTR_HOST`, etc.).
- `src/lib/twttr.ts` — provider-shape-tolerant parsers: `parseUser`, `pickVoiceSamples`, `buildVoiceProfile`, `cleanSample` (+ timeline/own-post parsers shared with other flows).
- `src/lib/reply-hygiene.ts` — `reputationStatus` / `RepLevel` driving the Account-safety card (read, not edited here).
- `src/lib/prompts.ts` — `REPLY_ANGLES` populating the default-angle dropdown.

## Before you change it
- **`twttr.ts` is the unit-tested core** (header says "Zero imports on purpose, so it can be unit-tested in isolation — see `scripts/test-twttr.mjs`"). It must stay import-free and tolerant of BOTH provider shapes (new GraphQL `core.*`/`details.*`/`counts.*` and legacy `legacy.*`). `popup.ts` itself is DOM/Chrome-API glue and is not unit-tested.
- **The two API calls in `learn-voice` are ordered and dependent:** `path:"user"` must yield a `rest_id` before `path:"user-replies-v2"` can run (it queries by `user: user.id`). `parseUser` returning no `id` is a handled dead-end (logs the raw JSON, toasts to confirm the exact handle).
- **RapidAPI-key field is intentionally never pre-filled** for safety; `save-x` only writes the key when a new value is typed. Don't "fix" the blank field — that's the design. `learn-voice` separately persists a just-typed key before its calls so it works without a prior Save.
- **Handle-change resets `X_MY_FOLLOWERS_KEY` to 0** on save (stale-base guard). Changing that interacts with the dock's reach sweet-spot.
- **`pickVoiceSamples` thresholds are deliberate** (≥16 chars, ≥3 words, has a letter, ≥4 replies before preferring replies-only). Loosening them lets emoji/one-word reactions pollute the voice profile.
- **Host is fixed** (`CONFIG.TWTTR_HOST = twitter241.p.rapidapi.com`) because the parsers are written for that response shape — swapping providers means rewriting `twttr.ts`.
- **Budget + config errors are string-coded** (`no-twttr-config`, `budget-*`) by the service worker and matched by prefix in `learn-voice`; keep those codes in sync if you touch the SW's `TWTTR_GET` handler.
- **Feedback for `learn-voice` deliberately goes to toasts + the button + the voice box**, NOT `#toparea` — there's an inline comment noting `#toparea` scrolls out of view at the bottom of the X tab. Don't reroute it.
