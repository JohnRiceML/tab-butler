# Voice + profile (the popup)

> The X-copilot settings screen where you tell Goobi who you are — handle, niche, voice, products — and one-click "learn" your reply voice from your real X history.

**Surface:** the extension popup, the **"X copilot"** tab (the second vtab next to "Tabs"). Lives entirely in `src/popup/popup.ts` → rendered into `#view-x`. None of this is on x.com itself; it is the config that the on-page dock and background scoring read.

## What it does for the user
This is the one place you describe yourself so every draft sounds like *you* and targets the right posts. You fill in what's worth replying to (niche), your products, draft defaults, your X handle, and a reply-voice sample — or you hit **"Learn my voice"** and Goobi reads your last ~40 replies off X and writes the voice profile for you. A safety panel sits at the top so you can see your reply pace and reputation status at a glance. Everything is stored locally and feeds the reply copilot's scoring and drafting.

## How the user uses it
1. Open the popup and click the **"X copilot"** tab.
2. See **"Replies sent"** (today / week / all-time counters + a 7-day bar trend) and the **"Account safety"** card (Healthy / Caution / Ease off, with a reply-pace meter) — both read-only.
3. Toggle the copilot on/off with the switch in the section header.
4. Fill **"What's worth replying to"** (niche textarea) and add **products** (name + optional URL + one-liner each; "+ Add product" appends a row, favicons hydrate from Chrome's cache). The niche does double duty, and the format matters: **search keywords first, then `;`, then intent** (e.g. `AI SaaS, indie founders, MRR; posts I can add a specific build lesson to`). Every search path (Find spots, post ideas, heavy hitters) uses only the keyword clause (`twttr.ts:nicheQuery`); the full text — intent included — goes to the Claude scorer. Phrase the keywords as words that appear in *substance* posts, not in bait ("MRR", "shipped", a stack), or the searches pull the niche's spam slice.
5. Optionally set **Draft defaults** — a default angle and (if products exist) a default product.
6. Paste a **RapidAPI key** (twitter241 provider) to enable reach-aware ranking + voice-learning; a monthly usage meter shows if a key is stored.
7. Type your **X handle** and click **"Learn my voice."** A toast streams progress ("Reading @handle's recent replies…"); on success the **voice** textarea is filled with your real replies and scrolled into view.
8. Edit the voice box if desired, then click **"Save copilot settings."** A toast confirms (and counts saved products).

## How it works
**Load:** `getData()` reads all `X_*` keys from `chrome.storage.local` (niche, voice, products, default angle/product, RapidAPI key presence, handle, reply log) plus, if a key is stored, a `GET_TWTTR_METER` round-trip to the service worker. `render()` builds the `#view-x` HTML. Reply stats come from `computeReplyStats()` over the per-day `X_REPLY_LOG_KEY` buckets (pure local read, no API). Account-safety level comes from `reputationStatus(repliesThisHour)` in `reply-hygiene.ts`.

**Save** (`dispatch` → `case "save-x"`): reads the DOM fields and writes `X_NICHE_KEY`, `X_VOICE_KEY`, `X_DEFAULT_ANGLE_KEY`, `X_DEFAULT_PRODUCT_KEY`, `X_MY_HANDLE_KEY`; the RapidAPI key is only overwritten when a new value is typed (the field is never pre-filled). The handle is normalized (`replace(/^@+/, "")`); if it changed, `X_MY_FOLLOWERS_KEY` is reset to 0 to drop a stale base. Products persist via `saveProducts()` → `collectProducts()` reads `.prodrow` inputs, writes `X_PRODUCTS_KEY`, and removes the legacy `X_PRODUCT_KEY`. If a handle + key are present, `resolveMyFollowers()` fires best-effort to size the reach sweet-spot.

**Learn my voice** (`dispatch` → `case "learn-voice"`) is the marquee pipeline:
1. Reads the handle from the field (toasts and bails if empty); persists any just-typed RapidAPI key first so the SW sees it.
2. `TWTTR_GET path:"user"` (via `send` → service worker) → `parseUser(twttr.ts)` flattens the user node (tolerant of legacy `legacy.*` and new `core.*`/`relationship_counts.*` shapes) to get `id`, canonical `handle`, `followers`. Stores `X_MY_HANDLE_KEY` + `X_MY_FOLLOWERS_KEY`, and reflects the canonical handle back into the input.
3. `TWTTR_GET path:"user-replies-v2" count:"40"` → `pickVoiceSamples(rres.data, user.id, 12)` (`twttr.ts`): keeps tweets whose `authorId === userId`, prefers `isReply` ones (falls back to all own tweets if <4 replies), runs `cleanSample()` (strips leading @mentions + t.co links, collapses whitespace), and drops anything <16 chars, <3 words, or with no letters — i.e. emoji-only/one-word quips.
4. `buildVoiceProfile(handle, samples)` (`twttr.ts`) wraps them in: *"Recent replies @handle actually wrote on X. Match this voice, rhythm, vocabulary, and length. Do not copy them verbatim."* + a bulleted list. This string is written to the voice textarea and `X_VOICE_KEY`.

**API/model costs:** the only network calls here are to the third-party RapidAPI X-data provider (`twitter241.p.rapidapi.com`, host fixed in `CONFIG.TWTTR_HOST`), proxied through the service worker with budget guards (`budget-*` and `no-twttr-config` error codes are handled with specific toasts). **No Claude call happens in the popup's voice/profile flow** — there is no LLM here; `buildVoiceProfile` is pure string assembly. (Claude is only invoked elsewhere: Smart tab grouping, "Suggest cleanup", recall search, and on-page x.com drafting/scoring.) Persistence is entirely `chrome.storage.local`.

**How this feeds other flows:** `xNiche` + `xVoice` + `products` + draft defaults are read by the on-page x.com dock and background scoring to decide *what's worth replying to* and *how to draft it* in the user's voice. `xMyHandle` + `xMyFollowers` size the "in reach" sweet-spot tag on the dock and power reach-aware ranking. `parseUser` is also reused by `resolveMyFollowers()`; `pickOwnPosts`/`pickOwnPostsWithStats`/`pickDiscoveryTweets` in the same `twttr.ts` serve the post-ideas + momentum flows off the same parsers.

## What is honest about it / limits
- **Voice is MEASURED, not invented:** the profile is built only from replies the API confirms the user authored (`authorId === userId`), with a guard that drops trivial one-word/emoji samples so the drafter learns real prose. The prompt explicitly says "Do not copy them verbatim."
- **Followers/replies are a third-party PROXY:** all X data comes from twitter241 on RapidAPI, *not* X's official API — the UI states this plainly ("Programmatic X data access is outside X's API terms, so opt in knowingly. Stays off until you add a key."). `following` is left `undefined` (not 0) when absent so reciprocity logic stays neutral rather than treating the user as a broadcaster.
- **Draft-only keystone:** the X-tab footer note states *"On x.com, the text of timeline posts is sent to Claude to score & draft. Draft-only — it never posts for you."* The Account-safety card reinforces it: *"Likes & follows are spaced out with human delays, never fired in lockstep — and nothing ever auto-posts."*
- **Pace honesty guard:** the safety panel surfaces the same numbers the on-page nudges use (replies this hour vs X's ~30/hr automation read, accounts-spread today) so the anti-spam protection is visible, not silent plumbing.
- **What it cannot know:** reply counts are only what the local per-day log captured (starts at zero — "Draft a reply and hit Insert on X — your count starts here"); follower count is best-effort and can be stale/zero until a successful resolve.

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
