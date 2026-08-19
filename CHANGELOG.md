# Changelog

Notable changes + the phase-transition record. The day-to-day lives in git history.

## Unreleased

- **Reply handoff is now copy-only:** removed every reply-composer DOM insertion method, the
  scripted Like + insert path, its setting, and the cross-tab draft claim/fill protocol. For a
  visible feed post Goobi copies the draft, scrolls the exact matched article into view, and gives
  it a temporary accent outline; for an
  off-page result it copies and opens/focuses the exact status page. The user clicks Reply, pastes, reviews, and posts manually, then explicitly
  confirms the reply before it affects totals or pacing. A regression assertion prevents composer
  click/fill primitives from being reintroduced accidentally.

- **Fresh Reach evidence integrity + recall hardening:** public distribution, peak views, and peak
  engagements now retain their own observation timestamps and decay on a 14-day half-life; a weak
  new sighting can no longer make an old viral post look current. Direct account reads feed those
  metrics back into the radar, while cached snapshots older than six minutes can seed discovery but
  cannot claim a live opening. Successful-opening totals are independent of the bounded dedupe-ID
  list, cached rows cannot inflate yield, and weak lifetime yield no longer reserves a massive lane.
  Personalized radar and reply-ledger inputs are owner-scoped; grow-only per-tab check counters and
  opening-event unions preserve simultaneous tab increments and repair stale last-writer storage. The
  36-post content batch now excludes already-reviewed rows and preserves practical plus massive
  recall before the strict content gate. Breakout and major-early thresholds are monotonic: crossing
  a label boundary cannot make an otherwise identical open post rank worse. API quote posts now
  retain bounded embedded-post context through scoring and drafting while the outer author remains
  the reply target. Target-card cache hits also preserve their true observation timestamp, so an
  older cached response cannot regain a live Fresh Reach label merely because the card reopened.
  Reply-card avatars now show a compact ↗ cue only when the eventual review action needs to open
  the exact post on a separate X page; visible feed posts have no badge. The draft button mirrors
  that state with **Review & reply here** versus **Open post & review reply ↗**.

- **X-data governor completion:** provider quota observations survive the unrelated UTC-month local
  meter rollover, known remaining quota is pessimistically decremented at dispatch and same-window
  out-of-order headers reconcile only downward; an elapsed provider plan reset clears a stale zero
  and permits a fresh probe. Queue waits have a
  two-minute ceiling, and the 15-second abort remains armed through response-body reads. Cache
  eviction now counts decoded JSON bytes while receipts expose the original cache timestamp/age;
  failed Fresh Reach receipts retain paid-call and cache telemetry instead of hiding it. Within the
  bounded 6 MB cache, broad discovery queries survive disposable per-author reads first.

- **Local-first personal posting model:** the side panel can now import X's account-content CSV,
  parse RFC 4180 quoting/newlines locally, and persist only owner-scoped aggregate evidence. The
  model separates originals from replies, measures sample-gated content structures and character
  bands with Bayesian shrinkage, and labels every recommendation as historical correlation. Post
  Ideas uses the strongest structures for at most three of five drafts; Community Spark receives a
  reply-length prior only when that optional style is selected. The raw export is never stored or
  uploaded, an account mismatch pauses the model, and the user can replace or clear it from an
  accessible Imported → Learned → Applied receipt. A dedicated regression suite covers parsing,
  privacy, owner isolation, gates, prompt wiring, and reset controls.

- **Community Spark reply component:** added a distinct delivery-style control beside reply angles.
  It uses the existing exact post anchor, useful-move brief, author relationship, thread context,
  voice, and SOUL.md to produce a 55–170 character reply with one compressed insight or natural
  bit of wit and an optional narrow invitation to continue. The mode forbids summary, flattery,
  forced jokes, engagement bait, and invented experience; it works with any substantive angle,
  uses a smaller Sonnet output budget, renders as a responsive accessible toggle, ignores stale
  overlapping draft responses, and logs the optional style on confirmed replies for later honest
  outcome comparison. It is now active by default; toggling it off or back on persists that choice
  across tabs and browser restarts, and every feed, dock, Fresh Reach, and target-account draft uses
  the saved preference.

- **Fresh Reach now ranks actual distribution, not fame:** account selection separately scores
  log-scaled peak views and peak engagements alongside age-normalized distribution, cutting raw
  audience weight from 22% to 8% and normalized engagement-rate weight from 12% to 6%. Up to three
  new massive accounts can receive evidence-backed exploration lanes in a 24-check hunt, while
  measured reply-view winners and private pins keep their existing lanes. Fame alone still cannot
  reserve a check, every post still needs live timing/room plus the strict content-quality gate, and
  the radar now sorts and labels peak engagement evidence explicitly.

- **One smart X-data load governor:** replaced independent token waiters with one service-worker
  scheduler shared by every `TWTTR_GET` consumer and X tab. Network starts are evenly spaced at a
  9/sec ceiling under the owner's 10/sec plan, active fetches cap at eight, manual clicks jump ahead
  of ambient enrichment, and bounded fairness admits background work after eight priority starts.
  Provider remaining/reset headers dynamically lower or pause the queue; a short 429 gets one safe
  read-only retry through that same queue, while auth, outage, and plan-quota failures retain hard
  circuits. Plan-quota reset and rate-window reset are now parsed separately, missing headers no
  longer coerce to a false zero, retry attempts are counted in Fresh Reach receipts, and the popup
  exposes live rate/active/waiting telemetry. Mocked load tests prove 12 simultaneous reads complete,
  never exceed nine starts in a rolling second, never exceed eight active fetches, preserve priority
  fairness, and meter a rate retry correctly.

- **Fresh Reach deep scan + provider-aware measurement:** expanded each manual hunt to 24 due
  account checks and up to 36 pre-Claude post candidates (two per author across three bounded scorer
  batches), then keeps only the strongest strict content × opening result per author. Each click now
  uses one Latest plus three Top discovery lenses, direct checks run six-wide under a 9/sec local
  smoothing ceiling, and the fallback request envelope is 90k—leaving headroom below the owner's
  stated 10/sec and 100k/month plan while provider headers remain authoritative. The hunt receipt
  now separates live X-data calls, cache hits, accounts returned, unique originals reviewed, live-gate
  survivors, content-scored posts, and recommendations instead of labeling survivors as posts searched.
  Provider-wide failures stop later batches without incorrectly backoff-marking every saved account.
  Find people now has an owner-scoped private max-12 massive-account watchlist with four rotating direct-check
  lanes, while measured winners and evidence-backed massive exploration remain separately bounded.
  Fame alone and authors replied to in the last day cannot force a reserved slot. Public
  distribution evidence decays on a 14-day half-life, strong-opening yield counts only unique posts
  from direct successful checks, cross-tab radar updates merge monotonically, and a query-specific
  Latest failure can use saved accounts without retrying through auth/subscription/rate/provider
  failures. The visible Fresh measurement funnel shows logged → API-matched → view-bearing → settled
  → kept accounts. Manual confirmations now enter the six-minute verification path; reply fetches
  ask for 80 recent rows, missing metrics remain unknown, and late replies cannot teach the winner
  lane. The RapidAPI governor now reads plan/rate headers, applies credential-wide backoff, honors
  reset headers, aborts after 15 seconds, caches up to 6 MB, and labels its UTC-month meter as a local
  estimate rather than a universal plan limit. The live harness preflights once and stops cleanly on
  subscription/rate blockers before spending the multi-call matrix.

- **Adaptive, resettable ease-off:** replaced the rigid raw 6/10 replies-per-hour switch with
  one shared local pace-pressure model. Caution now begins at 8 pressure and ease-off at 12;
  cold discovery replies carry weight 1, warm inbound 0.7, ongoing connections 0.85, and
  community replies 0.95. Activity stays full-weight for 15 minutes, then decays smoothly to
  zero by one hour, with a 30-second local refresh so scanning resumes without a page action.
  The dock menu and popup Account safety card now expose **Reset local pace meter**. Reset writes
  only a separate baseline timestamp: reply history, daily/all-time progress, measured outcomes,
  repeat-author/duplicate protection, and X's own activity/limits remain untouched. The pace chip
  and popup show raw replies and weighted pressure together, and every gate—ambient scan, Targets,
  momentum, Goobi mood/cheer, and post-send nudges—reads the same pure `replyPaceStatus()` result.

- **Review & reply now uses the visible post in place instead of a generic Web Intent:**
  when the exact article is already rendered, Goobi stays in the current tab, clicks
  that post's Reply/comment-bubble control, and verifies the draft text in X's composer.
  Only an off-page opportunity uses the validated five-minute one-shot handoff to open
  or focus its exact status URL. X's newer
  accessible `Reply` markup is supported alongside the older `data-testid` hook.
  Occupied composers are never overwritten, clipboard remains the fallback, the source
  confirmation card receives success/failure state, and nothing submits or counts until
  the user explicitly marks the reply posted. The pure URL/TTL/matching contract lives in
  `lib/reply-handoff.ts` with a dedicated regression suite.

- **Fresh reach hunt — timely, reachable conversations without the algorithm-hack fiction:**
  Replies now exposes **⚡ Fresh reach**, a persistent larger-account radar. Every click
  runs a focused niche Top query plus rotating operator-free Top discovery queries—interleaving
  niche topics with broad general-interest domains—alongside niche Latest, merges newly
  observed authors into a 30-day/400-account niche-stamped radar, then directly checks up to 24 ranked accounts
  for their newest original posts. Per-handle searches are concurrency-bounded, share the
  12-minute provider cache and Target data, and rotate toward due accounts. Bounded lanes cover
  the private massive watchlist, a max-10 keep-list learned from settled X-reported views on the
  user's own RapidAPI-matched Fresh Reach replies, and a separate evidence-backed new-massive
  exploration account. Tracked, productive, proven-distribution, and Latest-active signals feed
  priority without each claiming a hard reservation. The rotating Top lens is forced distinct from the
  focused lens, so even the first hunt expands account discovery.
  Radar entries retain normalized distribution plus peak observed views/engagement. Successful checks and strong content openings are
  persisted, so accounts that repeatedly produce worthwhile posts earn future scan priority.
  The post gate keeps only known-age originals ≤2h from accounts at least 2× the user's size and at most one result per author.
  It separates normal **Early + open** (<30 replies), measured **Breakout pace** (exceptional age-normalized views or
  likes/reposts/quotes, ≤90m, <50 replies), and **Major account · early** (≤20m, <80 replies, with live distribution
  required above the normal room limit). Pure `lib/fresh-reach.ts` account/post
  policies make the sourcing and opportunity ordering inspectable/tested; freshness and
  thread room dominate, repeat authors are damped, and massive audience gaps receive a penalty
  instead of an exclusion or automatic reward. Premium is deliberately not a score
  input. The scorer now has to identify an exact post anchor, a useful reply move and brief,
  and no generic/promotional/context risk at a stricter content-fit gate before a large-account
  result can enter the queue. Hunt receipts report newly captured/radar/massive account counts,
  breakout/major candidates, strong openings, and budget limits. The Find-people view exposes the
  saved radar and its peak-view/scan/opening history, with one-click **Scan + expand**. Cards revalidate the live window,
  visibly cool when age or competition crosses the boundary, and show observed views, average view pace,
  likes/reposts/quotes, replies, and opportunity class,
  and carry that discovery snapshot into confirmed reply records for later outcome analysis.
  Fresh results now share one final opening index—content fit × live timing/thread-room/
  audience opportunity, with measured momentum capped at a 12% lift. The top live result is
  pinned with a class-specific breakout/major/early headline and its live evidence. The Reach
  sort uses this index rather than blindly sorting by follower count.
  Cards explain X's documented verified-reply
  effect as a slight conversation-ranking preference, never an impressions guarantee.
  Fresh-reach drafts get explicit surrounding-reader/value guidance, target-account drafts
  now reuse the scorer/context/logging pipeline, and all cold discoveries use the exact-post
  manual reply handoff. The legacy Like + insert DOM helper is now default-off and cannot
  run for Fresh reach. Nothing auto-submits or counts until the user confirms the reply.

- **Measured-outcomes dashboard in the popup — the learning loop, made visible:** a new
  "Measured outcomes" fold surfaces the per-angle win-rates, per-account top/bottom reads
  (measured ✓ vs invest-only ✦, with confidence and settled-outcome counts), the post-age
  timing buckets, and the continuous baseline-priority↔outcome association check
  ("baseline priority aligned/did not reliably align: ρ=… over N settled replies") — all numbers the loop already computed
  in `lib/learn-stats.ts` but never showed. A new pure `lib/outcome-dashboard.ts`
  (unit-tested, `scripts/test-outcome-dashboard.mjs`) shapes the display model and inherits
  every existing min-N gate (`GLOBAL_THIN`/`N_MIN_OUT`/`FIT_CORR_MIN_N` imported, never
  re-derived): every row carries its n, sub-gate rows don't render, and the "still learning"
  state names exactly what's missing (via `replyVerificationSummary`) instead of guessing.
  Whether the measured tilt is actually reordering ranking is stated either way, and the
  footer stays honest: correlation, not causation — measured on your own replies. Popup-only;
  no new permissions, nothing auto-posts.

- **Draft-and-remind scheduling for post ideas (never auto-post):** working drafts in the
  Ideas dock can now carry a "⏰ Remind me" time — pick one of up to three suggested slots
  (a new pure `lib/schedule.ts`, unit-tested) or a custom time. Suggestions respect the
  ~3h `POST_SPACING_MINS` prior from `momentum.ts` against both your last own original and
  every other scheduled draft, and the day-part picks are labeled ✦ priors (common posting
  windows — not a measured "best time", no fabricated benchmarks). Scheduled drafts show a
  chip (due/overdue states escalate), a due reminder highlights the card and toasts once
  (with `postSpacingNudge`'s soft spacing note when your last original is recent — never a
  block), and a `chrome.alarms`-driven service-worker check mirrors the due count on the
  toolbar badge (badge-only: no `chrome.notifications`, no new permissions). Persisted on
  the existing `X_IDEAS_KEY` records with cross-tab `storage.onChanged` sync; opening the
  composer, marking Posted, or Clear serves the reminder. Shipping remains the user's
  click through the existing Open-in-X path — nothing opens or posts on its own.

- **Profile-change experiment — a method, never a number:** the Growth store now records
  single-subject profile experiments: declare the ONE thing you changed (bio, pinned post,
  banner, or display name) and the date, and Goobi compares followers/day (plus views/post and
  eng/post when both sides have ≥2 measured posts) across the 14 days before vs after, from its
  own logged snapshots. Every read is labeled ✓ measured with per-side observed-day counts and
  carries the caveats in the copy: one uncontrolled variable is correlation, not causation;
  profile visits aren't exposed to the extension so no conversion rate is ever computed (external
  "benchmark" figures aren't backed by real experiments — the account's own data is the only
  honest source); an overlapping content-strategy test is named as another moving part. Below 10
  observed days on either side the panel says it's collecting or that the window is unreadable —
  never a guessed number — and declaring a second change mid-window is refused, with a one-click
  path to log the running read as invalidated instead. Pure logic + settle/merge live in
  `growth-loop.ts` (22 new assertions in `test-growth-loop.mjs`); the declare/read UI is a new
  "Profile experiment" fold in the popup's X tab. No new permissions, nothing auto-posts.

- **Public algorithm explainer:** added `docs/public/how-x-ranks-2026.md` — a standalone,
  publishable version of INTEL.md's verified picture (Thunder/Phoenix retrieval, the 22-term
  multi-action scorer with the verbatim diversity formula, negative signals, the follower-gated
  reply pipeline with its holistic 0-3 grade, the VMRanker caveat, and the myth-busts), keeping
  every per-claim provenance tag while excluding Goobi's encoding map, tuning constants, eval
  results, and watch checklist. `docs/public/README.md` states the folder contract: nothing is
  auto-published; posting a file anywhere is a deliberate owner action. Root README links the
  explainer.

- **Dev hot-reload loop:** `npm run dev` watches `src/`, rebuilds on save, and bumps a
  `dist/dev-reload.json` beacon; the service worker (only when that beacon exists) polls it,
  reloads the extension on a bump, and refreshes open X tabs on the way back up — removing both
  manual dev steps (the chrome://extensions reload click and the per-tab refresh). Distributable
  `npm run build` deletes the beacon and `check:dist` fails any dist/ still carrying one, so
  watch-mode plumbing can never ship. SW-side behavior needs a one-time manual smoke test
  (build-side halves are verified: watch writes the beacon, build strips it).

- **Clone-and-run maintainer path:** added root `setup`, `test`, `build`, and
  `verify` commands; a deterministic runner for all zero-cost suites; MV3 build
  artifact validation; a Node 20 baseline; a GitHub Actions verification gate;
  and a maintainer handoff/smoke-test runbook. A dependency upgrade also clears
  the prior esbuild development-server advisory. The full path was verified from
  a clean temporary copy with no existing `node_modules` or `dist` directory.
- **Comments on your posts are first-class reply context:** Goobi now detects X's
  visible `Replying to @you` relationship, labels the feed overlay and reply card
  `Comment on your post`, gives genuine comments a dedicated warm-inbound lane, and
  passes that relationship into both Haiku scoring and Sonnet drafting. Same-author
  warnings remain visible but are softened for a real ongoing conversation. The
  Comments workspace now distinguishes direct comments from mentions on every row.
- **Historical: Like + insert reply was default-on in this release** (the current build
  defaults it OFF): restored the user-clicked workflow that likes
  the selected post and fills its empty X reply composer in one verified operation.
  A visible side-panel setting switches to copy + open. Occupied/unavailable composers
  fall back safely and nothing auto-submits. A successful fill now records the assisted
  attempt immediately, closes Goobi's panel, turns the feed green, removes the queue
  card, and live-refreshes dock/side-panel totals and pace. Only copy/open fallback keeps
  the posted-confirmation screen.
- **Top-level daily goals:** added an always-visible scorecard for verified Replies,
  Posts, and unique people manually marked as DM'd. Goals are editable, locally persisted,
  can be disabled individually, route directly to their workspace, and use conservative
  defaults/caps. Existing account-safety and DM pacing gates always override volume goals.
- **User-owned SOUL.md:** added a markdown creative brief for beliefs, earned experience,
  recurring themes, proof, desired reader feeling, and “never sound like” boundaries.
  It stays separate from learned voice (substance vs style), includes an explicit starter
  template, is capped/sanitized locally, and now guides reply drafts, post generation,
  quality passes, and idea rewrites. It is labeled as identity context rather than evidence,
  cannot justify invented personal facts, and is intentionally excluded from DM drafting.
- **Reply-card compact/expanded redesign:** replaced the dense always-expanded card and
  detached right-hand “Best move” column with a single scannable row: author, growth lane,
  strength, age, one-line post preview, Draft, and disclosure. Expanding one card in place
  reveals the full post, a readable Why-this-is-worth-your-time block, three visual decision
  signals, confidence/caution context, and Open / Follow / Plan DM / Mark replied / Skip.
  Expansion is single-open and keyboard accessible, so the queue remains easy to triage.
- **In-post recommendation UX:** replaced the opaque percentage badge and faint `+ Add`
  shortcut with a compact, expandable decision overlay on every scanned post. Surfaced
  posts now name the growth lane and strength, then disclose Why now, separate Reach /
  Relationship / Community signals, evidence confidence, cautions, and Draft / Open /
  Mark replied / Skip actions. Passed posts explain the content-fit reason and offer Add
  to queue, Draft anyway, or Open. The component numbers are labeled as decision signals,
  never reach probabilities. The overlay is single-open, keyboard dismissible, and keeps
  mutation-observer writes idempotent for X's virtualized feed. An open card temporarily
  elevates both its post and X timeline cell, then restores their styles on close, so later
  timeline rows cannot paint over or clip its actions.
- **Warm comments promoted above cold Targets:** the tested Tend-your-threads queue
  is now a first-class **Comments** workspace with its own open count, full freshest-first
  queue, reply-history completion, manual done, and an honest notifications-page empty
  state. Targets left the primary navigation and remains available under Replies →
  **Find people** as secondary discovery. The Relationships accordion now contains only
  Circle and Supporters analytics, removing the duplicate buried Threads entry.
- **Fifth dock mode — account Growth loop:** added one account-scoped 14-day
  reason-to-follow experiment across the profile, originals, and replies. Five concrete
  strategy bets provide a profile/post/reply playbook; the active bet now guides three
  of five generated post ideas while two remain exploratory. The loop compares follower
  pace, views/original, and engagement/original with the immediately preceding matched
  window, records collect/double-down/tighten/switch decisions, and keeps completed
  evidence in history. It reuses existing follower, own-post, reply-outcome, and local
  profile data, so there is no new API endpoint or polling cost. Thin-data gates and
  explicit correlation-not-causation copy prevent fake profile-click attribution.
- **External-test hardening:** zero-view posts remain in experiment denominators;
  strategy verdicts require recorded execution as well as comparable outcomes; profile
  findings are account-bound; handle/session mismatches block capture; starting without
  a persistent owner is disabled; ending a live test requires confirmation; history
  exposes dates, execution counts, and evidence without hover. Removed the parked proxy
  and localhost host permissions from the shipping manifest, and Smart mode now honestly
  requires a locally stored Anthropic key.
- **Reply recommendations rebuilt around the real decision:** Best no longer presents one
  opaque percentage as if it were a probability. A new pure, tested policy separately scores
  **Keep it going**, **Build community**, and **Earn reach**, using relevance, freshness,
  observed thread room, size-scaled reachable audience, exact completed exchanges, measured
  engagement-back, niche-peer evidence, and recent-author diversity. Missing data is middling
  and disclosed, not silently ideal; mega accounts get a meaningful opportunity-cost cut; a
  warm relationship cannot rescue a poor-fit post. The row now explains “Why now” and exposes
  the three component scores under ⓘ. Also corrected the conversation-dedup overclaim (reply
  count is a labeled heuristic, not a universal one-slot rule) and fixed RapidAPI enrichment so
  search candidates with a cached follower count still fetch missing following/bio evidence.
- **Fourth dock mode — DM workspace:** added a per-account, local relationship pipeline
  for Sponsor, Backlink, Connect, Co-market, Customer, and Partner conversations.
  It ranks exact public relationships ahead of cold Targets, uses the proven RapidAPI
  `/user` and `search-v3` endpoints only for explicit public enrichment, and adds a
  separate Sonnet DM prompt. Drafts stay editable; Copy/Open never count as sending;
  delivery, replies, follow-ups, and outcomes are recorded only when the user marks them.
  Includes one-follow-up policy, conservative marked-send pacing, near-duplicate blocking,
  cross-tab stable-ID merges, deletion tombstones/private-text redaction, and 30 pure assertions plus prompt guards.
- **KISS DM intelligence:** added one inspectable Next move that prioritizes real
  conversations over follow-ups and new outreach, plus a compact self-reported funnel.
  Intent/product/warmth are snapshotted when a send is marked, so later edits cannot
  rewrite history. Angle signals remain display-only, require at least three first
  touches, and always show the numerator/denominator. No new API or model calls.
  People-source learning now separately measures exact relationships, Targets,
  reply spots, manual research, Circle, and completed Threads. Candidate cards expose
  their relevant cohort sample; a source needs five first touches before Goobi names
  it the clearest people signal. This remains observational and never auto-ranks.

- **X first-run UX:** the side panel now opens on the product's primary X surface,
  puts the required Anthropic connection in that setup path, and gives new users a
  clear Connect Claude → Set your focus → Add your voice sequence. The legacy
  tab manager's Claude toggle moved back into its own settings so it no longer looks
  like a global copilot control. Optional products/defaults, third-party X-data
  enrichment, progress, and diagnostics are progressively disclosed. Also fixed the
  malformed RapidAPI settings container that nested the handle controls inside it.

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
  content — into original posts in your voice (Sonnet, `POST_IDEAS_SYSTEM`).
  - **v2** (designer-led): each card shows the **real source post** it remixed
    (collapsible, with ❤/🔁 + open-the-tweet — the data was already fetched), a
    **virality gauge** (band+word, not a fake number), **pin** to keep ideas, and the
    fabricated reach number was removed for an honest "tuned to your ~N followers."
  - **content quality** (expert-led): the generator now pulls **your own recent
    posts** (`from:<handle>` search, cached ~24h under `X_MY_POSTS_KEY`,
    `pickOwnPosts`) and feeds them to the prompt so ideas **don't duplicate what you've
    already posted** + match your real voice — plus a dependency-free word-set Jaccard
    **de-dupe guard** drops near-repeats (vs your posts or each other). Rewrote
    `POST_IDEAS_SYSTEM` with an anti-generic bar + enforced variety (5 distinct shapes,
    ≥3 content types). `pickBest` is now follower-normalized (eng/√followers) so a small
    account's genuine breakout beats a mega-account's floor post. Own-posts pull is
    best-effort (degrades to prompt-only if no handle / budget). The surface also goes
    **wide** (≤680px, 90vh) on this tab.
  - **v3 — persist → shape → ship** (expert-panel buildout): a **persistent drafts
    queue** (`X_IDEAS_KEY`, `IdeaRecord[]`, survives reloads — edits/pins write through
    `safeSet`); **per-idea steer/rewrite** (chips + free nudge → `POST_IDEA_REWRITE` →
    `generatePostIdeaRewrite`, one scoped Sonnet call, one-level undo) so you shape a
    near-miss instead of rerolling the batch; and **mark-shipped + streak** (Open-in-
    composer flips it to posted, Goobi cheers, a "Shipped N · 🔥 K-day streak" strip,
    posted ideas collapse into a Shipped section). Draft-only intact.
  - **v4 — scannable-queue UX pass** (design-panel: 3 directions scored → synthesized):
    each idea is now a **one-line row** (virality color rail + hook + `Strong · listicle ·
    ↺ @handle` meta + one-tap ↗) that **expands in place** into the editor (borderless
    draft hero + why + steer + source + action bar) — single-open, so ~4 ideas fit where
    1 did and you triage the batch in seconds. The absolute corner gauge + the
    `margin-top:18px` hack are gone (virality → the rail + the bold meta word); the header
    condenses 5 rows → 3 (streak + Generate top-anchored, merged sub/reach line); off-
    palette purple/gold recolored so **color means one thing** (virality + the copper CTA);
    first-class gate / empty / error states. Every capability intact, one disclosure deeper.
  - **v5 — creator quality overhaul** (`idea-quality.ts`, 12-agent workflow + adversarial
    verify; net cost unchanged at 1 search + 1 Sonnet): the model can only be as good as
    what it remixes, so the candidate pool is hardened *before* generation. New pure
    `idea-quality.ts` (unit-tested, `scripts/eval-post-ideas.mjs`) + a rebuilt `pickBest`:
    server-side search operators (`lang:en -filter:replies/retweets -giveaway`) with a
    no-operator retry for thin niches, an English/RT/engagement-bait filter, a 21→60-day
    recency window, a **genuine-breakout** score (follower-normalized, not raw), a
    percentile engagement floor, near-identical-source de-dupe, and **author + shape
    diversity quotas** so it never feeds 5 of the same shape. **Prompt rewrite**
    (`POST_IDEAS_SYSTEM`): an internal draft-7-seeds → critique → ship-5 pass, a banned-
    opener hook bar, the user's **own posts as the primary voice anchor** (the VOICE blurb
    is correctly demoted to reply-tone-only), follower-tier framing, anti-generic swap-test,
    enforced variety. **Honest virality**: the fake model-graded 0-100 is gone — the model
    scores only `hookStrength` (0-3); the user-facing **band** is anchored to the *real
    measured rank* of the source post it remixed (`bandFor`), with a basis sentence and no
    fabricated multiple; no provable source caps at "Niche". Plus `callDirect` JSON-salvage
    so one bad char can't torch the batch, and cross-batch de-dupe against the live queue.
    A **copy-leak guard** (`copyLeak`) drops any idea that lifted ≥60% of its source post's
    content (plagiarism, not a pattern remix), bounded by the keep-all-if-empty net.
    - **Eval Layer B** (`scripts/eval-post-ideas-live.mjs`, opt-in): generates ideas for 5
      seed niches with the real prompt (Sonnet) then a Haiku judge scores each batch
      0-3 on anti-generic / voice / variety / hook / source-honesty + a swap-test fail
      rate + judge-stability check — so a prompt/selection change is a measurable delta.
      No-op without `--live` (default gate stays $0).
- **Warm-up / momentum meter** (`momentum.ts`, expert-led): a thin strip under the dock
  header shows your **account momentum for the day** — a 0–100 score derived from real
  activity (replies today *saturating* at a healthy target, posts shipped, day-over-day
  streak, how live you are right now). States run Cold → Warming → In flow → **Peak (at
  the *healthy* sweet spot)** → Cooling → **Overheating**. It reads the **same
  `reputationStatus` the pace chip + Goobi's "worn" mood read**, so it can never
  celebrate over a safety warning: at Goobi's product ease-off line (the then-static 10/hr model)
  the score *drops* to red
  "ease off", and at caution pace it turns amber to match the chip — Peak is reachable
  only at a healthy pace. Beside the meter, a neutral **real-views readout** — your
  X-reported views on today's posts — pulled by *extending* the existing
  `from:<handle>` search to keep `views`/engagement (`pickOwnPostsWithStats`, 60-min
  stat cache on top of the 24h de-dupe cache, ~1 extra call/active-hour, budget-gated).
  Views are **shown, never scored** (a measured fact, not a lever to push volume).
  Derived from data we already track — no new storage key, no new endpoint, no new
  Goobi moods. Pure model unit-tested (`scripts/test-momentum.mjs`, 15 assertions).
- **Engagement learning loop — "Who you show up with"** (`learn-stats.ts`,
  workflow-designed + adversarially verified): a once-a-day, dayKey-gated scan that
  compounds over time into a dock insight panel. Two honest tiers on one path:
  - **Tier-1 "investment"** (ships now, **0 new API cost**) ranks the accounts you reply
    to by a recency-weighted mean of your reply *quality* (`effectiveScore`) — labeled
    *where you invest your replies*, **never** "who pays off." Empirical-Bayes shrinkage
    to the global mean (no crowning an account off one lucky reply) + a hard min-N gate
    (thin accounts sit in a "still learning" bucket).
  - **Tier-2 "engagement-backed"** (the real ask) — a daily **measure-pass** fetches the
    likes/replies your own replies earned (`user-replies-v2`), matches each back to a
    stored reply by text (`matchOutcomes`), and writes the dormant `SentRecord.outcome`.
    Accounts that accrue ≥4 *settled* outcomes earn a ✓ measured, reach-normalized,
    **relative** read (▲ above / ▼ below your average — never a fabricated number).
  - **Own-post trend backbone:** per-post positive view-deltas (keyed by id, so the
    sliding 15-post window can't go negative) fold into bounded daily snapshots →
    "Your posts: +N views this week."
  - **Honesty by construction:** title "Who you show up with"; share bars are neutral
    (never green); footer states *replying to someone doesn't make them engage back*; a
    single-target **spread nudge** (never "double down"); cadence arrows are *your*
    cadence, not their response. No new permissions; reuses the `from:<handle>` cache +
    the budget governor (`intent:true`, self-pauses on budget pressure); ~1–2 calls/day,
    behind `LEARN_SCAN_ENABLED`. Pure model unit-tested (`scripts/test-learn-stats.mjs`,
    21 assertions). This retires the long-deferred "what's working for YOU" bet (below).
- **Reciprocity engine — "Who shows up for you"** (`supporters.ts`, workflow-designed +
  adversarially verified): the inverse of the learning loop — the accounts that engage
  with **you**, so you can build real mutuals. **Detection is zero-API**: the content
  script reads your own **notifications page** DOM — reply + mention notifications render
  as full tweet articles, captured reliably (idempotent, dedup by status id).
  - **Honest scoring:** likes/reposts are lossy ("X and N others") + locale-fragile, so
    they're **not counted** (deferred); the supporter score is **reply + mention only**,
    recency-weighted + count-anchored shrinkage + min-N gated (same conventions as
    `learn-stats.ts`).
  - **Mutual score:** fuses "who you show up with" (you→them) with "who shows up for you"
    (them→you) via a **cohort-invariant** squash into **mutual / fan / one-way** labels —
    a pair's label can't shift just because an unrelated account joins.
  - **Anti-pod by design** (this is *not* an engagement pod): a **reciprocal-ring
    detector** warns when a closed like-for-like loop forms (what X actually penalizes);
    no "like them back" verb — the only action is **open their profile** (draft-only,
    zero API); honest footer (a sample not a ledger, likes uncounted, notifications stay
    on-device). New `X_SUPPORTERS_KEY` (device-local, 1000-cap, 60-day prune). Pure model
    unit-tested (`scripts/test-supporters.mjs`, 11 assertions).
- **Target accounts — "🎯 Targets" mode** (`targets.ts`, web-researched + workflow-
  designed + adversarially verified): the growth move of **commenting early on bigger
  in-reach niche accounts to borrow their crowd**. A third dock mode where you track
  large accounts, pull their freshest original post on demand (reuses the proven
  `from:<handle>` search), and **coach a quality reply** (Sonnet `DRAFT_REPLY` → edit →
  Copy / Open-the-post). **Draft-only** — it only opens the post + copies the draft,
  never auto-replies.
  - **Reachable, not mega:** a hard membership gate (`excludeFromTargets`) keeps the list
    to ~2–12× your size with an absolute ceiling — untouchable mega-accounts are
    *structurally* excluded, not just rank-penalized (research: a reply buried under a
    mega's thousands earns nothing).
  - **Tracking comes free:** `targetStanding` reuses the shipped learning loop
    (`aggregateAccounts`) — each target shows *which of your replies actually land*
    ("✓ your replies here beat your average" / "still learning N/4"). No new tracking
    engine.
  - **Anti-spam by construction** (research found X weights a mute/block at ~−74, ≈148× a
    like — annoying the account *shrinks* your reach): the **pace keystone locks** the
    find/draft actions past 30 replies/hr; a new `replyQualityWarning` flags empty-praise
    ("great post! 🔥") before you copy; a live freshness window ("4m old · reply while
    it's live") nudges *early*, not *often*; honest framing ("a reply is a chance at their
    audience, not a promise"); **no impression number is ever shown** (X doesn't report
    reply impressions — we won't fake one). New `X_TARGETS_KEY` (device-local). Pure libs
    unit-tested (`scripts/test-targets.mjs` 18 + the quality gate in `test-hygiene.mjs`).
    Deferred: an ambient fresh-post poller (the `selectPollBatch` budget invariant is
    already tested) + folding the learned per-target signal into ranking.
  - **Suggested accounts** (`suggest-targets.ts`, deep-algo-research workflow + verified):
    a "Suggested for you" list — the in-niche authors your last "Find spots" search
    already cached (followers only, **zero extra API cost**), gated to the reach
    sweet-spot and ranked by a `suggestionScore` where **every factor traces to a real
    X-ranker mechanism** (sweet-spot out-of-network bridge; follow-graph openness as a
    proxy for the +75 `reply_engaged_by_author` head; bio-niche overlap; predicted
    engagement-rate per post; and the **only measured-on-our-data** signal — how your
    replies to them have actually done). One-tap **+ Track**, a dismiss ×, and an honest
    per-account reason. Honesty held to the bulletproof bar: the live 2026 ranker is
    Grok-internal, so the byline says **"computed from what we can see, not guaranteed,"**
    a missing signal is held neutral (never a penalty), openness is described as a
    follow-graph *shape* ("a two-way account") not inferred behavior, and only Tier-2-
    measured history earns the "✓ your replies here have done well" tag. Pure-lib
    unit-tested (`scripts/test-suggest-targets.mjs`, 15 assertions).
    - **Tier-B enrichment (cheap signals):** the strongest candidates get a budgeted
      `/user` lookup (reuses `maybeFetchReach` — capped at 80/session, governed,
      re-renders on completion) to fill `following` + `bio`, so the **openness** (two-way
      account) and **niche-match** factors light up beyond the free followers-only signal.
    - **Heavy-hitter discovery (engagement, not just size):** a "🔥 Find heavy hitters"
      action (auto-runs once per session) does one `search-v3 type:Top` call — the *most-
      engaged* posts in your niche are written by the accounts whose content **lands**, and
      the call returns their engagement for free. That **populates the engagement-rate
      factor** (a viral post's `eng / followers`), so suggestions now rank on **size AND
      engagement** — a big *broadcaster* with dead replies ranks below a slightly smaller
      account whose posts pop. The reach band widened to the research **5–25× sweet-spot**
      (with a fixed `MEGA_CAP`), and the biggest get an honest *"big — comment EARLY before
      it's buried"* cue. Engagement reads as *"lands big in your niche"* (a viral post we
      found, not "typical").
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

**Systems validation + fixes (2026-06-30)** — a multi-agent validation of the three X
surfaces (replies, post-ideas, targets) found all three algorithmically sound; it shipped
five verified fixes (and refuted ~11 other proposed changes as already-done, mis-grounded,
or harmful to the honest-mirror keystone):
- **Post-ideas — 2026 ranker tone gate.** `POST_IDEAS_SYSTEM` (+ the rewrite prompt) now
  teach the model that X's ranker reads tone directly — combative/dunking posts get
  throttled even at high engagement, constructive ones amplified — with a PASS-2
  "KILL IF IT DUNKS" critique. Contrarian/myth-bust shapes stay encouraged, just
  sharp-not-bitter.
- **Replies — profile-click draft directive.** `X_DRAFT_SYSTEM` now optimizes the reply
  for the funnel step that actually makes follows (a curious profile click), earned
  honestly via demonstrated competence — never self-promo, a CTA, or click-bait.
- **Post-ideas — honest thin-pool band.** `bandFor` takes a `poolSize` confidence haircut
  so a single mined exemplar can no longer mint a "Strong / one of the top posts" band; a
  thin pool (1-2 posts) always reads as "a thin signal" (`idea-quality.ts`, + eval locks).
- **Prompt-invariant guard.** New `scripts/test-prompts.mjs` (in the default gate) asserts
  the load-bearing prompt rules (no-dash, exact-handle attribution, hook-only scoring,
  PROVEN ANGLE, the tone gate, the profile-click lever) so a silent prompt edit can't
  delete one and still ship green.
- **Doc honesty.** Corrected stale `targets.md` / `SYSTEM.md`: `engRate`/`engNorm` is now
  LIVE (for heavy-hitter-search authors; coverage partial), the band is the size-scaled
  ~2–25×, and the constant is `MEGA_CAP` (not the long-gone `ABS_CEILING_BASE`).

**Assumptions audit — correctness/honesty fixes (2026-06-30)** — a deeper multi-agent audit
backed each system's load-bearing assumptions with logic + published data (the tweet
half-life paper, the 2023 open-source weights, TweepCred, engagement-rate benchmarks) and an
adversarial fabrication check. These are the zero-risk corrections it surfaced (the *ranking*
changes it flagged are deferred to data-driven validation, not shipped as more priors):
- **Fixed a baked-in non-sequitur:** `targets.ts`/`targets.md` justified the mega-account
  exclusion with the 2023 ranker's −74 mute/block penalty — but that penalty is about a
  reply's QUALITY (readers blocking spam), independent of the target's size. The size gate
  now correctly rests on visibility dilution (your reply is 1-of-thousands under a mega
  thread); the −74 belongs to the empty-praise guard. Two distinct mechanisms, un-welded.
- **Fixed a lying comment:** the post-ideas exemplar picker's header claimed "engagement per
  √followers," but `scoreWinner` divides by `followers` linearly (~0.3% baseline, floored).
  Comment now matches the code, and flags the flat-constant shape problem as measure-first.
- **Fixed a stale doc:** `reply-spots.md` said outcome learning is "not wired / dead weight" —
  it IS (`runMeasurePass` writes `SentRecord.outcome`, `aggregateAccounts` reads it). The
  doc now describes the real (best-effort, key-gated, ≥4-outcome) loop and notes the replies
  ranker doesn't yet consume it.

**Post-ideas ranking — size-tiered engagement baseline (2026-06-30)** — acted on the audit's
clearest data-backed finding. `scoreWinner` divided engagement by a flat 0.3% like-rate, but
published 2025-26 X benchmarks show small accounts run ~10× hotter than megas — so the flat
constant under-divided small accounts and mistook an *ordinary* small-account post for a
breakout (the opposite of what the picker is for). Replaced with `expectedRate(followers)`, a
size-tiered baseline (~4% sub-1k → ~0.65% megas) derived from those published benchmarks;
structured so a live RapidAPI per-niche calibration can refine the numbers without changing the
shape. The breakout-vs-floor property is preserved; +3 eval assertions (30 total).

**Post-ideas honesty — "Strong" band now requires a real breakout (2026-06-30)** — the virality
band could mint **Strong** off the #1 post of a *weak* pool, because the anchor is relative rank
only. Building on the size-tiered baseline above, `isBreakout(w)` checks whether the matched proof
post genuinely over-performed for its size (≥2× its tier norm); `bandFor`'s new `sourceStrong`
gate caps a non-breakout top source at **Solid** and narrates it honestly ("only modestly
out-performed"). The pool-*quality* sibling of the earlier pool-*size* haircut. +7 eval (37 total).

**Post-ideas — per-niche calibration of the engagement baseline (2026-06-30)** — the passive,
zero-cost version of the audit's "live X-API calibration." `calibrateRates` computes the median
like-rate per follower-tier from the niche posts each generation **already fetched** (no new API
call) and `setRateTable` swaps it into the baseline `expectedRate` reads — so the size-fairness
math is tuned to the user's *actual* niche, not just published benchmarks. Conservative by design:
a tier needs ≥6 samples to override (else it keeps the published default), rates are clamped to
sane bounds, and the worst case is exactly today's behavior. Reviewed (no leakage — the table is
consumed only inside the Ideas flow); +5 eval assertions (42 total).

**Niche-profile review fixes (2026-07-05)** — a third review pass judged all three systems
against the owner's actual profile (AI/build-in-public founder, 1K–10K, follower growth) —
the most bait-saturated niche on X — and shipped what it found:
- **Heavy hitters no longer crownable by engagement farmers.** `findHeavyHitters` folded EVERY
  non-reply Top result into `engRate` — no bait screen — and on a bait-heavy niche, Top skews
  giveaway/RT posts, so a farmer could rank as a 🔥 heavy hitter (and their audience is other
  farmers: worthless follows). Now the query is hardened like the ideas search (`lang:en
  -filter:… -giveaway`) and results pass the same `looksLikeRT`/`isEnglish`/`isBait` screen as
  `pickBest` before touching `engRate` or the candidate pool. (Also fixed the stale "best post"
  doc phrase — it's been a mean since the earlier review.)
- **The niche setting's double duty is now explicit and honored.** The full niche text (intent
  included) is right for the Claude scorer but poisons X search, which reads every word as a
  keyword. New `twttr.ts:nicheQuery` (unit-tested, +5) takes the clause before the first
  `;`/newline; ALL three search paths (Find spots, ideas, heavy hitters) now use it, while
  prompts keep the full text. The popup placeholder + label and `voice-and-profile.md` teach
  the format: `keywords; intent`.

**Generalize to ANY niche + squeeze the API harder (2026-07-05)** — the growth playbook is
universal (add value, be personal, engage the right people, jump on early posts); two places
were still builder-overfit, and one already-fetched signal was being thrown away:
- **Niche peers in any vertical.** `builderTier` hard-required builder/creator bio language, so
  a lawyer/coach/designer peer never got the community lift. Now niche-bio word overlap (+ the
  two-way ratio) makes a tier-2 peer in ANY vertical; the builder regex alone is the tier-1
  off-niche community cue. (+4 tests, community 16.)
- **Post-ideas playbook is vertical-agnostic.** The hardcoded "BUILDER / FOUNDER VERTICAL"
  block became "ANY EXPERTISE NICHE": insider specificity over-performs everywhere — with the
  builder, lawyer, coach, and designer translations spelled out. (+1 prompt invariant.)
- **The free early/buried read on targets.** `findTargetPost` fetched each post's reply count
  and discarded it. Now `targets.ts:earlyLabel` (+7 tests, targets 28) turns it into the
  "jump on early posts" signal at ZERO extra API cost: a live post with ≤5 replies reads
  "only N replies so far — you'd be near the top"; ≥30 reads "you'd be buried; wait for their
  next post"; unknown counts say nothing (honest-mirror).

**Local settings seed (2026-07-05)** — a remove+re-add of the unpacked extension wipes
`chrome.storage.local`, forcing every key/voice/product to be re-typed. Now: copy
`extension/goobi.local.example.json` → `goobi.local.json` (GITIGNORED — plaintext secrets,
machine-local only), fill it once, build. The build bundles it into `dist/` and the service
worker seeds every EMPTY setting from it on install/startup — never overwriting live panel
edits. Re-adds are now zero-retyping.

**Fix the post-ideas empty-pool "try a broader niche" error (2026-07-05)** — a multi-keyword
niche ("AI builders, indie SaaS founders") was sent to X search as an implicit AND of every
word, so almost no tweet matched and the pool came back empty. New `twttr.ts:nicheSearchQuery`
(pure, +7 tests, twttr 61) ORs the topic phrases — `((AI builders) OR (indie SaaS founders))`
— so a post matching ANY topic qualifies; used by all three search paths (Find spots, ideas,
heavy hitters). The ideas retry now broadens to the single strongest topic (also dodges any
provider quirk with OR/parens), and the error copy tells the user to use fewer/broader keywords.

**Reply ranker — live pileup on remount (2026-07-05)** — the one stale term in
`effectiveScore`: freshness recomputed live, but likes/replies were frozen at first-scan, so a
post that BLEW UP after being queued kept ranking as an easy fresh reply (contradicting the
"first ~5-10 replies get seen" premise `buried` exists to honor). Now scan()'s cached branch
refreshes the opp's counts from the live node whenever X's virtualized timeline re-renders a
seen post — zero API calls, no stored DOM refs; a post is only stale while it stays off-screen.
(The full fix for never-re-rendered posts would need a per-post API fetch — a budget decision,
deliberately not taken here.)

**Account trend — the measured "is it picking up?" meter (2026-07-05)** — the momentum strip
scores today's EFFORT (activity + streak); this adds the missing OUTCOME half. New pure
`learn-stats.ts:accountTrend` (+8 tests, learn-stats 29) compares the last 7 days vs the prior
7 on per-post results (views/post when X-reported views exist in both windows, else
engagement/post) over the daily snaps the learning loop already collects, plus a free daily
followers snapshot → the insights panel now opens with "📈 Picking up: ~2.1K views/post this
week vs 900 last week · +34 followers" (or Steady / Cooling). Honest by construction: silent
until both windows hold ≥2 posts, and the tooltip says it straight — X has no literal streak
bonus; consistency compounds through repeat engagement, so this tracks RESULTS, not activity.
Zero new API calls.

**The "show up" chain — gamified, honest (2026-07-05)** — the momentum strip now carries a
GitHub-style 14-day heat-dot row + a 🔥 N-day active chain + one contextual algo-backed callout
(new pure `activity.ts`, +17 tests). Gamified visuals, honest core: every dot/number is
measured (Goobi replies + shipped posts per day), the flame flips to ⏸ at easeoff (it never
cheers past the safety line), callouts are picked by deterministic priority (safety → measured
trend → show-up / post-mix nudges → the timing lever) and each names its evidence class in the
tooltip — none claims a literal streak bonus, because there isn't one: consistency pays through
repeat-engagement affinity + account reputation, and that's what the copy says.

**The system now LEARNS what works — and shows it (2026-07-05)** — closing the loop from
measurement to behavior. Every sent reply already logs its features (angle, post-age-at-reply,
stage-1 fit, author reach) and gets its real engagement measured daily; new pure
`learn-stats.ts:learnFeatures` (+9 tests, learn-stats 38) turns those settled outcomes into:
- **★ your measured-best angle** on the draft-panel chips — the angle whose replies earned
  ≥1.15× your reach-normalized average (min 4 outcomes per angle, ≥2 angles ranked; shrunk,
  recency-weighted). Soft steer only — the per-post category still drives the default.
- **"What's working" insight lines** — per-angle ▲/▼ and the measured timing gradient
  ("replies to <15m-old posts earn ~2.3× your 1h+ ones"), each labeled correlation-not-
  causation and silent below the min-N gates.
- **A live fit-validity check** — Spearman between the stage-1 fit score and real outcomes
  (the assumptions audit's A4 test), surfaced in the tooltip once n≥12.
Same honesty machinery as the account learner; zero new API calls. Also fixed the stale
"outcome is NOT YET IMPLEMENTED" SentRecord comment (the measure pass has written it for weeks).

**Tier 1 of the algo-leverage mission (2026-07-05)** — three moves from the open-source-algo
report, all challenge-verified first:
- **Outcome data upgrade ($0):** the daily measure pass keeps the views/reposts/tweet-id already
  in the paid response (views = distribution, the thing the 2026 ranker actually decides);
  `SentRecord.target` logs the post's engagement state at reply time; `learnFeatures` gains
  `fitCorrViews` (compare with `fitCorr` before any primary-metric flip). Old records untouched.
- **The engaged-back join ($0, the moat metric):** `fillAuthorReplied` joins the notifications
  harvest to the sent-reply log (handle + 72h, one event → one record, most-recent wins) and
  writes the never-written `authorReplied` slot; `aggregateAccounts` carries a measured `backs`
  count and the insights row shows "↩ engaged back ×N" — copy says "engaged back", never
  "replied to your reply" (no thread id available; the tooltip states the join's limits).
- **The drafter learns context + gets an eval:** new pure `draft-context.ts` assembles a
  grounding block (niche + scorer reason/category + honest author line) into the DRAFT user
  message — X_DRAFT_SYSTEM stays byte-stable. New `eval-draft-reply-live.mjs` (opt-in Layer B)
  drafts every fixture bare-vs-enriched and judges both on a 0-3 rubric anchored to the LLM
  reply-grading mechanism in X's published pipeline — so the enrichment is a measured delta,
  and stage 2 (own-reply exemplars + measured-angle line) is explicitly gated on it.
+10 learn-stats tests (48), +7 draft-context (13th suite in the gate).

**Coverage caches persist (2026-07-05)** — `heavyHitters` + `authorReach` were session-only,
so target-selection coverage reset on every navigation and the ~350KB Top-search re-ran each
session. Now both persist (implementing the governor's own stated v2): `authorReach` (public
author data) under the followers-class 24h TTL, `heavyHitters` niche-stamped under a 7d TTL —
TTL authority lives in `twttr-policy.ts` (+2 tests). Persists MERGE into the stored copy so the
long-session memory bound can't wipe compounding history; entries past TTL are pruned on
load/write, never rendered; a niche change flushes the heavy pool (niche-stamped, can't bleed
back). NEGATIVE net API cost.

**Ease-off now pauses analysis too (2026-07-05)** — past the ~30 replies/hr line the ambient
scan stops queueing and scoring posts entirely (no Haiku spend): surfacing MORE reply spots
while the user should cool down contradicted the honest mirror. Manual intent still works —
⟳ Rescan opens a 2-minute override window, Find spots is unaffected — and the ease-off callout
says plainly: "Goobi paused scanning for new spots (⟳ Rescan overrides)."

**Minimized-pill controls (2026-07-05)** — the collapsed launcher pill now carries ⏸/▶
pause-resume and ✦ Find-spots buttons (the pill became a div — nested buttons are invalid
HTML — with stopPropagation so the controls act without expanding the dock). Pause/search no
longer require opening the full panel; ✦ disables while paused or mid-search.

**The profile coach + Premium as an honest covariate (2026-07-05)** — the funnel's last mile:
replies earn the profile CLICK, but the PROFILE converts it into the follow, and no feature
touched that surface. Now: visiting your own profile harvests the conversion surface at $0
(pinned post id + bio length, DOM-only, guarded against half-loaded pages — it never claims
"no pinned post" off an unrendered timeline), and new pure `profile-check.ts` (+10 tests, the
14th gate suite) renders measured findings in the insights panel: "your pinned post ranks #4
of your last 15 by views — your #1 isn't pinned" / empty-or-thin bio. Silent without data.
Plus an **X Premium tier** setting (never a score input): free-tier users get one labeled
external-study callout (~10× median reach, Buffer 18.8M posts, self-selection caveat named,
priority BELOW every actionable lever); unset stays silent — unknown ≠ free.

**Post-ideas + targets: the measured-shape loop and friends (2026-07-05)** — the remaining
challenge-verified items for the other two surfaces:
- **Shape→outcome loop** (`shapePerformance`, +5 eval, 47): from the user's SETTLED own posts
  (>48h; one metric, never mixed scales; min-3 per shape), which shapes actually land — a
  measured header line in the ideas tab, a soft MEASURED preference in the generation prompt,
  `[shape]` tags on every exemplar, and `IdeaRecord.shape` stamped at creation. The old
  "Winning shapes" row is relabeled "Batch shapes (model-picked)" so measured never blurs
  with model-declared.
- **topPostId finally consumed**: "📈 Biggest one-day gainer this week" in the ideas header —
  honest per-day-delta semantics (never "top post this week"), silent on cache miss.
- **👁 views on the source proof** when X reported them (display only — the scoring blend was
  challenge-rejected pending a views baseline).
- **slopFree dimension** in the Layer-B ideas judge — X computes an explicit slop score, so the
  eval now measures it (the live pre-ship screen stays gated on this eval's evidence).
- **Targets: ↩ engaged back ×N on the standing line** — the measured reply-back count from the
  notifications join, surfaced where you pick who to invest in (display-only, visit-dependent
  caveat in the docs).

**The funnel line + signal health (2026-07-05)** — two verified items plus the robustness fix
the expert brief called for:
- **🔀 14d funnel** in the insights panel: replies → distinct engagers-back → follower delta,
  all measured, labeled correlation-never-attribution (profile clicks are invisible
  client-side; the tooltip says the causality is not claimed).
- **Supporters' dormant reachBoost activated**: inbound engagers' follower counts backfill
  from the reach cache at harvest, so the whale-vs-peer weighting finally varies instead of
  sitting at the fallback constant. *(Correction: this claim shipped without its code — a
  patch-tooling failure dropped the edit silently; the adversarial review caught the
  docs-vs-code break and the backfill actually landed in the follow-up commit.)*
- **Signal health card** (popup): the honest min-N gates make panels legitimately QUIET, which
  looked identical to broken. Now inspectable — measure-pass freshness, outcomes vs the
  fit-validity gate (n/12), engaged-back credits, harvest ages (notifications / own-posts /
  profile-coach), coverage-cache sizes — each with the action that feeds it.

**docs/INTEL.md — the x-algorithm diff-watch (2026-07-05)** — the last item from the mission's
verified map: an EVENT-driven watch on xai-org/x-algorithm (the promised 4-week cadence isn't
holding, so no monthly ritual — subscribe to the commits feed, run the checklist when a drop
lands). The checklist names the four withheld things that matter most (the params weight
module, the grox prompt templates, conversation-serving code, un-redacted thresholds) and
routes each finding to the exact file it would change. Closes the verified map: every
challenge-approved item that could ship without the owner's keys has now shipped.

**Poller spike script (2026-07-05)** — `scripts/spike-poller-or.mjs`: the one open question
gating the ambient target poller (does twitter241 honor batched `from:a OR from:b` searches —
~5× cheaper than per-handle) is now a one-command test on the owner's key. Uses the REAL
parser so "works" means works-with-our-code; per-handle controls distinguish OR-broken from
quiet accounts; prints an explicit OR-HONORED / OR-BROKEN / INCONCLUSIVE verdict with the
matching build path for each. No-ops without --live + a key.

**Review fixes for the post-Tier-1 span (2026-07-05)** — an adversarial pass over the seven
gate-only commits found 2 MAJORs + 6 minors, all fixed:
- **M1 (integrity):** the reachBoost backfill was CLAIMED in 627ffe6 but never landed (a patch
  abort dropped the edit silently). Now actually wired at the scanNotifications harvest site,
  and the original CHANGELOG entry carries a correction note.
- **M2 (honest-mirror):** on a non-English X UI the missing "Pinned" label produced a false
  "No pinned post" claim. New `pinKnown` gate — a missing label is only evidence on an English
  UI; a FOUND pin is trusted in any locale; non-English UIs stay silent on pin claims (+3
  profile-check tests, 13).
- Minors: the funnel line says "engaged with you" (all inbound) — deliberately distinct from
  the join's stricter "engaged back"; the pill regained keyboard access (tabIndex + Enter/
  Space); profileCheck now enforces one-metric-per-ranking (views only when every post has
  them); tiny accounts (<3 posts) get bio coaching even though pin detection stays gated; the
  Premium callout copy is coherent (impressions framing, rates-flat caveat); the seed file
  learns the premium field; the two-tab persist race is documented as accepted.

**The ambient target poller ships + both live gates ran (2026-07-06)** — the owner's keys
turned the two open questions into evidence:
- **Spike verdict: OR-BROKEN.** twitter241 ignores batched `from:a OR from:b` (returned one
  author; per-handle controls proved the others active). The poller therefore ships on the
  per-handle path: `pollTargets()` on the Targets view → `selectPollBatch` (≤5/kick, 12-min
  per-target TTL persisted on the target — remounts never re-pay) → ambient `findTargetPost`
  with `intent:false` (conserve mode silently pauses it; ease-off skips it entirely). Live
  posts float to the top of the tracked list. The last deferred build item is live.
- **Draft-eval verdict: stage 2 SHELVED.** Bare drafts already ceiling the judge (3.00 on
  grade/slop/value, judge drift 0); enriched context showed no gain and a −0.2 voiceMatch dip.
  Per the pre-registered gate, stage-2 context (exemplars + measured-angle) does not ship;
  stage 1 stays (no measured cost, code-anchored rationale). Eval note: the 0-3 scale
  saturates — harder fixtures / a wider scale before any re-test.

**Live integration testing — and a live-broken feature caught + fixed (2026-07-06)** — new
opt-in `scripts/live-integration.mjs` verifies the provider-facing assumptions against the
real API with the real parsers. First run's findings:
- **Heavy hitters was silently DEAD**: the "hardening" pass had added `-filter:`/`lang:`
  operators to the Top query, and the provider's Top tab rejects operators outright (0
  results, no error → empty pool). Live-verified: Top honors the OR form without operators
  (25 posts, all with followers). Fixed — the Top query is operator-free; the client-side
  bait/RT/lang screen (already in place) does the quality filtering. Docs corrected.
- **Field coverage is excellent**: followers 100% and views 100% on search results, views/
  likes/id 100% on reply payloads — follower-normalization and the views-outcome upgrade are
  genuinely fed (the audit's PI-3 "does normalization actually run?" question: YES).
- **Topic-OR is honored but recency-flooded** on Latest: the busiest topic dominates a 40-post
  window. Documented as a behavior note (not a bug — the empty-pool AND-starvation it replaced
  was far worse).
- lang fields are absent from search payloads (0%) — the heuristic isEnglish fallback carries
  it, as designed.

**Ideas generator: the first measured quality iteration (2026-07-06)** — the Layer-B live eval
ran for the first time (3 runs, judge drift ≤1 each):
- **Baseline was sobering**: antiGeneric 1.80, voiceMatch 1.60, slopFree 1.40 (0-3),
  swap-test failures 13/25 — the judge caught banned constructions appearing anyway,
  over-polished voice vs blunt users, "LLM-spice" contrarian templates on cold starts, and
  recognizable source echoes.
- **Shipped (measured +):** a source-ECHO kill (the swap test now runs against source authors
  too — sourceHonesty 1.80 → 2.20), a BLUNTNESS voice rule, a cold-start rule (no real person
  visible → no contrarian-template energy), and a FINAL SWEEP pass before output. All locked
  as prompt invariants (test-prompts 15).
- **Tried and REVERTED on evidence:** temperature 0.7 scored worse across the board (more
  conservative = more generic) — the default sampling stays; the plumbing remains for future
  measured use.
- **Honest residual:** slopFree/voiceMatch sit at a ~1.4-1.6 floor that prompt wording didn't
  move — candidate paths recorded (a stronger generation model at ~5× cost; a second-pass
  rewrite call at 2× cost; or judge harshness — Haiku's slop read isn't ground truth either).
  Next iteration should A/B those, measured, before believing any of them.

**UX/a11y expert pass (2026-07-06)** — the objectively-verifiable fixes (contrast math,
keyboard paths, screen-reader semantics), plus a hierarchy bug of our own making:
- **Green now means positive, not "any insight."** `.ins-trend` was hardcoded green and five
  different insight lines had piled into it — a COOLING trend rendered in celebratory green.
  The trend line is now colored by state (green/red/muted); the funnel, what's-working, and
  profile "act" lines moved to a neutral `.ins-fact`; only ✓ findings stay green.
- **Contrast**: the pill's muted subtitle was 4.40:1 (under AA 4.5) — bumped to #96876f
  (5.03:1). All other pairs audited and passing (primary text 15.8:1).
- **Keyboard**: one consistent `:focus-visible` ring across the dock shadow DOM AND the popup
  (several inputs had `outline:none` aesthetics that killed keyboard visibility).
- **Screen readers**: aria-labels on every icon-only control (pill ⏸/▶ + ✦, minimize, kebab);
  toasts announce via `role=status aria-live=polite`; the decorative activity dots are
  `aria-hidden` (the chain label + titles carry the data).
- **Motion**: `prefers-reduced-motion` now disables all CSS transitions/animations in both
  surfaces.

**Algo-alignment arc (2026-07-07)** — a research pass (two agents: expert-practitioner survey +
a direct grep of `xai-org/x-algorithm`) mapped what the open-source 2026 ranker *confirms in
code* against what Goobi covered, then closed the six clearest gaps. Every mechanic below cites a
real code fact; nothing rests on the recycled-2023 weight tables vendors still sell.
- **Tend your threads** (new surface, the biggest uncovered lever) — an action queue of the people
  who replied to / mentioned you, freshest-first, one-click to the thread. Answering your own
  repliers is the highest-ordered growth action (author-engaged replies grade highest;
  `dedup_conversation_filter` promotes the liveliest branch). Built on the existing notifications
  harvest (added a text snippet); pure ranking in `threads.ts` (`rankThreads`, 16 assertions).
  Honest: no parent-thread id (can't group by your post), "tended" is a lossy handle+time guess.
  See [docs/flows/tend-threads.md](docs/flows/tend-threads.md).
- **Reply-surface realism** in `effectiveScore` (`targets.ts`) — two code-confirmed mechanics fold
  in: `slotOdds` (conversation dedup → one reply per thread reaches For You, so a crowded thread's
  slot is priced as likely-taken; replaces the old likes/replies pile-on proxy) and `gradedSurface`
  (the `low_blast_radius` reply-grader gate → a relationship-only thread gets a mild GROWTH demotion
  and an honest "small thread" chip). Thresholds are conservative PRIORS (X's numbers are redacted),
  so the value is in the label, and the multiplier is gentle.
- **Daily-cadence coach** (`momentum.ts` `dailyShape`) — the healthy BALANCE of a day (10–30 quality
  replies + 1–3 *spaced* originals; bursts self-cannibalize via author-diversity decay), not raw
  volume. Safety-deferent: silent at ease-off, never nudges more replies at caution.
- **Profile coach v2** (`profile-check.ts`) — profile_click→follow_author are first-class ranked
  actions, so the coach now scans the bio's what/who/**proof** formula, the name descriptor, and
  banner presence. `analyzeBio` runs at harvest and stores ONLY booleans — the bio text never
  leaves the page.
- **Banger-screen self-check** in `POST_IDEAS_SYSTEM` — X runs every original post through a model
  that assigns a `slop_score` + `quality_score` (pass ≥0.4) before wide distribution
  (`banger_initial_screen.py`). The final pass now points at that real referee with one specificity
  question ("could only THIS user, who did the work, have written this?"), pushing toward first-
  person detail rather than more banned-phrase rules. **Eval-gated** (`eval-post-ideas-live.mjs`,
  single run vs the recorded baseline): slopFree **1.40 → 1.60**, voiceMatch 1.60 → 1.80,
  sourceHonesty 1.80 → 2.40, nothing regressed (swap-test 13→14/25 = one idea, within judge noise),
  re-score drift 0. Modest + within the known ~1.4–1.6 floor caveat, but positive-or-neutral across
  the board on a code-grounded change → shipped.
- Gate: `tsc` + `build` clean; all 15 pure-lib suites green (targets now 40, +`test-threads` 16,
  momentum 24, profile-check 24, prompts 16); Layer-A ideas eval 47. `effectiveScore`, the harvest,
  and the panels are integration code (verified by build + type; needs a reload to see live).

**Post/comment quality arc (2026-07-08)** — an adversarial multi-lens audit (5 independent
lenses + 2 measured live runs) graded the post-ideas system **C-**: strong hooks (~2.9/3), but
antiGeneric 1.8 / voiceMatch 1.9 / slopFree 1.7 and ~58% of ideas failing the swap test, with two
converged root causes — one over-used sentence mold and best-line source lifting. Fixes, each
measured, honest about what moved:
- **Mold-ban + best-line anti-lift** (`POST_IDEAS_SYSTEM`): cap the "X isn't about Y, it's about Z"
  negation-reframe at ≤1/batch, ban "unpopular:" / "Nearest analogy:" tells + second listicles, and
  a specific KILL for restating a source's single most-quotable line (the B1≈@tinyfounder price-lift
  class). **Measured:** the named tells dropped hard in a fresh dump (negation-reframe 7→2 of 20,
  "unpopular:"/"Nearest analogy:" 2→0, the price-lift became a genuinely different point), but the
  coarse Haiku aggregate stayed flat (slopFree 1.8, swap 14/25). So the prompt-side takes the cheap,
  named wins; the **durable lever is still the structural reject-and-regenerate second pass** the
  audit called for (not built — it adds a call per generation; offered as the next step).
- **Kill quote-wrapping of phrases** (both surfaces): new `text-clean.ts` (`stripEmphasisQuotes` +
  `cleanDraft`, 18 assertions) GUARANTEES emphasis/scare quotes are unwrapped from posts AND replies
  while preserving apostrophes/possessives/links, plus a prompt rule in both. `stripDashes` moved
  here from claude-client (its NUL sentinel → a plain-ASCII guard token, same collision-safety).
- **Reply drafter: measured, then REVERTED.** A first pass added a Grok-0-3 "engage the specific
  claim" push to `X_DRAFT_SYSTEM`. The before/after live eval showed **voiceMatch 2.80 → 2.60 for
  zero gain** on grade/valueAdd/slopFree (all already at the 3.0 ceiling) — the same voice-cost that
  shelved stage-2 context. Reverted the value paragraph; kept only the no-quote clause. **Finding:
  the comment drafter is already at ceiling and doesn't need "more value" — that only costs voice.**

**Post-ideas structural second pass (2026-07-08)** — the durable lever the quality audit called for,
now built and measured. `generatePostIdeas` gains a reject-and-regenerate pass (`refinePostIdeas`):
after the first Sonnet generation, a cheap Haiku judge (`POST_IDEAS_JUDGE_SYSTEM`) flags the ideas
that fail the swap test, then Sonnet (`POST_IDEAS_REGEN_SYSTEM`) rewrites ONLY those into
user-specific posts (forced concrete detail, on a different point than the sources). **Measured**
(`eval-post-ideas-2pass.mjs`, pass-1 → pass-2): swap-fails **9/15 → 6/15** (60%→40%), antiGeneric
**1.67 → 2.33**, slopFree **2.00 → 2.33** — and John's own niche (AI/build-in-public) hit swap-fails
0 / slopFree 3 / antiGeneric 3. Details: it's best-effort (any judge/regen error returns the pass-1
ideas, never breaks generation); a regenerated idea drops its source attribution (it's now an
original on a new point, so it bands as an own-theme idea, no false proof post); adds ~2 calls
(Haiku judge + Sonnet regen) per generation. Residual: not monotonic per-batch (judge noise can
wobble one fixture ±1); a re-judge-and-keep-best guard would cost a 4th call — deferred.

**Dock "Today strip" redesign (2026-07-08, UX pass)** — the expanded dock stacked SIX status lines
of identical size/weight/color (momentum label+cue, daily shape, post stat, chain, callout) between
the header and the reply queue; several restated each other ("16 sent today" twice; three separate
affirmations). Redesigned with tiering, not deletion:
- **Row 1 — summary:** mini momentum bar + colored state label + posts/views + chain, one line,
  with a ▸ caret (role=button, Enter/Space, aria-expanded).
- **Row 2 — ONE coach line** ("the next best move"), deterministic priority: **safety always wins**
  (ease-off callout red / caution cue amber — the honesty keystone stays front-and-center even
  collapsed, agreeing with the pace chip + state label from the same `stt`), then the daily-shape
  nudge, then the algo/measured callout. Bare affirmations only when nothing actionable exists.
- **Caret-expanded detail:** everything the strip used to stack (cue, shape, 14-day dots + full
  chain, callout) with every tooltip + measured/prior evidence label intact.
- The strip got a faint background tint so status reads as a band distinct from the work queue;
  light density trims on cards (`.it`/`.botacts`) and tabs. Six rows → two by default.
- **Round 2 (live feedback: "this is all I see now"): Tend-your-threads compressed.** With a full
  notifications harvest the panel rendered a 3-line explainer + 8 rows (each with a redundant
  "● live" badge) + a 3-line footer + "111 to tend" — pushing the reply queue entirely off-screen.
  Now: top **3 rows** + "▾ N more" toggle (up to the ranked 8); explainer → the panel title's
  tooltip; footer → one terse line with full disclosures on hover; freshness rides on the age label
  (green while live) instead of a per-row badge; the count caps at **"20+ to tend"** with the exact
  number in its tooltip (a queue, not a guilt ledger). Every honesty disclosure is preserved, one
  hover away.

**Insight-panel contrast bug (2026-07-08, live feedback: "really hard to read").** The three insight
panel titles ("Tend your threads", "Who you show up with", "Who shows up for you") and the @handles
in their rows were `color:#3a3027` — a dark brown on the `#14110d` dock, ~1.5:1 contrast, effectively
dark-on-dark and unreadable (that color belongs on a LIGHT background; these sit on the dark dock
body — a gap the 2026-07-06 a11y pass missed because it audited the reply-card surface). Titles →
`#f3ead9` (~15.7:1), handles → `#e6d6ba` (~12.7:1), and the small row meta / reply snippets lifted
`#8c7d68`→`#a89a85` (~6.4:1). All now clear WCAG AA on the dock.

**Tend-your-threads: mark done (2026-07-08, live request).** Each thread row gets a **✓** that
explicitly clears it from the queue (and the count) — a hard user signal, distinct from the lossy
auto-"tended" guess (which only sinks a row). Persisted device-local (`X_THREADS_DONE_KEY`), synced
across tabs, and pruned to the live harvest on every write so it can't grow unbounded as events age
out. `rankThreads` gained an optional `done` set (excludes those postIds from rows/total/untended;
back-compat when omitted; +4 test assertions). Marking done does not touch the reciprocity panel —
the person still counts as having engaged you.

**Relationship panels → one horizontal tab row (2026-07-08, live request).** "Tend your threads",
"Who you show up with", and "Who shows up for you" were three stacked collapsible panels eating
vertical space above the reply queue. Consolidated into ONE horizontal accordion tab row
(`renderRelationshipTabs`) — **Threads / Your circle / Supporters** — at most one body open at a
time, tapping the active tab collapses it. The count badges ARE the "top-level notifications":
Threads carries the actionable amber badge (untended count, capped 20+), the other two a muted
account count (or nothing while still learning). The three render functions became body-only (the
tab is their header now); `relTab` state replaces `threadsOpen`/`insightOpen`/`supportersOpen`
(defaults to Threads). The Today strip's momentum bar widened for more presence as the top status
band. Net: three panel-headers + up to three open bodies → one tab row + one body.
  - **Follow-up (live: "sections push the reply content off-screen"):** the tabs now default
    **collapsed** (`relTab = null`) so the reply-spots list is visible the instant the dock opens —
    the badges do the notifying — and an expanded tab body is **capped at `max-height:34vh` with its
    own scroll**, so opening one can never push the reply queue off-screen again. The `.dl` reply
    list is `flex:1` in the dock's flex column, so it now reliably absorbs the freed height.
  - **Follow-up 2 (live: the capped body was a cramped sliver):** replaced the `max-height:34vh`
    cap with a proper flex SPLIT — an open `.rel-body` and the `.dl` reply list are both `flex:1 1 0`,
    so opening a section gives it ~half the flexible area (roomy + scrollable) while the reply list
    keeps the other half; collapsed, the reply list takes it all. No more sliver, no more off-screen.

**Post-ideas: per-idea GRADE + call-out (2026-07-08, "a better way to manage / call things out").**
The second-pass judge already graded each idea to drive the auto-rewrite, but the user never saw it —
the only row signal was the virality band (the SOURCE post's reach, not the idea's quality). Now the
judge returns a per-idea `{tier: strong|ok|weak, lever, callout (≤10 words), fixable}`;
`refinePostIdeas` attaches it to every `PostIdea` → `IdeaRecord.grade` (and re-grades the regenerated
subset so a call-out never describes stale text). The UI surfaces it: a colored **tier chip + the
call-out** on each row, the working list sorts **strong-first**, the header shows a **batch summary**
(N strong · N ok · N weak), and ok/weak ideas get an **✎ Improve** button that reuses the rewrite
seeded with the call-out (and clears the now-stale grade). Live-verified for John's niche: a batch
graded 3 strong · 2 ok · 0 weak with sharp reasons ("true but generic survivorship-bias restatement
of @levelsio"; "echoes @ai_tinkerer's demo/eval split, lacks your angle"). `POST_IDEAS_JUDGE_SYSTEM`
now returns `grades[]` (weak = the swap-test fail that drives the regen). Turns the queue from "5 rows
to read" into "ship these 2, fix this 1." Gate: tsc + build; 16/16 suites (prompts 26); Layer-A 47.

## Next phase

- **"What's working" learning loop** (the post-ideas "bold bet", deferred on purpose
  until the free persist→ship loop proves retention). When a post idea ships, stamp
  its format/pattern; then ONE batched/day read of your own recent originals (via the
  stored handle) populates `SentRecord.outcome` and biases the next batch toward what
  worked for YOU. It's the only piece that adds recurring API cost — flag it off until
  people return. Same dormant `SentRecord.outcome` also covers replies.
- **Side-panel playground parity.** The popup playground is a separate, simpler copy;
  it doesn't share the dock's persisted fed-set or the new trick variety.
- **Twttr response cache (v2).** `twttr-governor.ts` dedupes in memory only;
  `TWTTR_BUDGET.FAIL_TTL` is reserved for a storage-backed negative cache that isn't
  wired yet.
- **Decide the tab-manager's future** — keep Goobi dual-purpose, or split the tab
  manager out. It still ships + runs but is orthogonal to the copilot.

## Before store submission

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
