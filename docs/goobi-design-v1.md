# Goobi — pet/game design v1

**Status:** design spec, ready to implement.
**Scope:** the virtual-pet layer ONLY — how Goobi's moods/care loop map to the tool's real signals. Out of scope: the reply scorer, the Claude prompts, the core tab logic.

## North star

Goobi is an **honest mirror with a face**. Every mood is driven by a signal the tool already tracks — it is the "Account safety" / "Replies sent" / system-memory panels, re-expressed as a creature. The single hardest rule: **Goobi is happiest when you do the HEALTHY thing, not the most-engaged thing.** He cheers when you *pause at ease-off*; he never cheers you toward more replies, never shames a quiet day, never dies.

Two grounding files this spec maps to, exactly as-is:
- Animation keys: the `STATES` object in `mascot-lab.html` (every key below is one of these — no new art required for v1).
- Signals: `reputationStatus` (`reply-hygiene.ts`), `replyLog`/`repliesToday()`/`recordSentReply` (`x-copilot.ts`), `getData()` mem%/idleCount (`popup.ts`).

Body color note: Goobi reddens (`bodyColor` heat lerp toward `HOT` = `rgb(210,59,46)`) only when genuinely unwell. We reuse that exactly: **the only thing that reddens Goobi is the ease-off pace** — red = "your account is near X's automation line," nothing else. This keeps red meaningful.

---

## 1. Signal → mood mapping table

Every row maps a REAL, already-computed value to a mascot-lab animation key. "NEW" flags a signal that needs instrumenting before that row can ship (deferred to v2 — see §5).

### A. X reply pace — `reputationStatus(repliesThisHour)` (`reply-hygiene.ts`)
This is the spine. Thresholds are X's, already in the code (`REPLY_SOFT_PER_HOUR=20`, `REPLY_HARD_PER_HOUR=30`).

| Real signal & threshold | Goobi mood | Animation key(s) | Why (honest-mirror) |
|---|---|---|---|
| `repliesThisHour < 20` → `healthy` | Content / calm | `idle`, `breathe`, `blink`, `float` | "You're pacing like a person." The default good state. |
| `repliesThisHour 20–29` → `caution` | Mildly woozy, slowing down | `sleepy`, `sway` | Visibly easing — eyelids drop. NOT alarmed; a gentle "let's slow down." |
| `repliesThisHour ≥ 30` → `easeoff` | Worn out, needs a rest (+ red tint) | `dizzy` (idle), `panic` only on the *crossing beat* | The "Goobi looks exhausted — give it a rest" moment. Red body via the existing heat lerp. |
| **You then PAUSE while at caution/easeoff** (`setPaused(true)`) | **Proud / relieved** | `love` → settle to `sleep` | THE anti-dark-pattern keystone: the happiest pace-related reaction is earned by *stopping*, not replying. |

### B. Replies sent today + streak — `replyLog.daily` / `repliesToday()` / `recordSentReply`
Counted on Insert, "✓ Commented", or clipboard-fallback. A reply is a *small* positive, deliberately quieter than a tidy-up or a pause, so Goobi never reads as "feed me more replies."

| Real signal & threshold | Goobi mood | Animation key(s) | Why |
|---|---|---|---|
| A reply just counted, pace still `healthy` | Quick happy blip | `happy` (one-shot ~1.4s, then back to ambient) | Earned, small, calm. Acknowledges the assist; doesn't beg for the next. |
| A reply counted while `caution`/`easeoff` | NO celebration — stays woozy | (hold `sleepy`/`dizzy`) | Critical: we refuse to celebrate volume past the safe line. The face stays tired. |
| First reply of the day (`repliesToday()` goes 0→1) | Warm wave | `wave` (one-shot) | "Hey, we're back at it." A greeting, not a streak-pressure hook. |
| **Streak: replied on each of the last N≥3 distinct days** (derived from `replyLog.daily`; read-only, no new storage) | Gentle proud idle | `tada` (one-shot, rare — at most once/session) | Wholesome acknowledgement. Missing a day NEVER triggers loss/guilt copy (see §2 anti-patterns). |

### C. Tab clutter + RAM pressure — `getData()` (`popup.ts`): `mem.pct`, `idleCount`, `archivedCount`
Reuses the existing pressure bands (`freePct` thresholds) and `archivableTabs` count.

| Real signal & threshold | Goobi mood | Animation key(s) | Why |
|---|---|---|---|
| `mem.pct ≤ 65` AND `idleCount < 10` | Comfy / tidy | `idle`, `float` | A clean desk. Baseline-good. |
| `mem.pct 66–85` OR `idleCount 10–24` | A little buried | `squash`, `look` (glancing at the pile) | "Getting cluttered." Mild, not alarmist. |
| `mem.pct > 85` OR `idleCount ≥ 25` | Overwhelmed | `shake` (brief), then `dizzy` | RAM redlining / 25+ idle tabs. Honest "this is a lot." |
| **A tidy-up just happened** — `archivedCount` rose / Undo not pending (popup `reclaim`/`apply-rec`) | Relieved cheer | `cheer` (one-shot), shadow `dance` | The reward lands on the HEALTHY action (archiving), matching tenet 1. |

### D. Neglect / time-since-last-open — the Tamagotchi beat
This is the one signal class that needs a tiny bit of NEW instrumenting (a single timestamp), called out honestly.

| Real signal & threshold | Goobi mood | Animation key(s) | Why |
|---|---|---|---|
| Opened within last ~24h | Normal (defers to A/C) | (ambient set) | Presence is the default; no neglect modifier. |
| `now − lastOpenedAt` ≥ ~2 days | Sleepy, missing you | `sleepy` → `sleep` | "Dozed off waiting." Soft, never a notification, never a guilt ping. |
| ≥ ~5 days | Deeper sleep | `sleep` | Still just sleeping. **Never** dies, never decays to "sick," never nags. |
| You return after neglect | Happy to see you | `wave` then `happy` | Reunion warmth. The reward is for *coming back*, with zero penalty for having been away. |

> **NEW signal to instrument (small):** write `goobiLastOpenedAt: number` to `chrome.storage.local` whenever the popup opens (`refresh()` in `popup.ts`) and/or the dock first renders on x.com. One number. Read it to compute the neglect tier. Until it exists, the neglect row degrades gracefully to "no modifier" (Goobi just shows the A/C mood). Everything else in v1 ships with zero new signals.

---

## 2. Mood state machine

Goobi resolves ONE mood per render from the live signals, using a fixed **precedence ladder** (highest wins). This mirrors the lab's `moodOf()` "most-critical-need-wins" pattern, re-pointed at real signals.

### Precedence (top wins)

1. **Paused-and-proud** (transient, ~6s after `setPaused(true)` while pace was caution/easeoff) → `love`→`sleep`.
   *Outranks everything*: pausing when hot is the single best thing the user can do, so it must beat a happy streak, a fresh reply, everything.
2. **Ease-off** (`repliesThisHour ≥ 30`) → `dizzy` + red. The safety signal outranks all positive states — you can't be "happy" while your account is at risk. (A happy streak does NOT override this; that's the key anti-dark-pattern guard.)
3. **Caution** (`repliesThisHour 20–29`) → `sleepy`.
4. **Overwhelmed** (`mem.pct > 85` OR `idleCount ≥ 25`) → `shake`→`dizzy`.
5. **Neglect-asleep** (`lastOpenedAt` ≥ 2d) → `sleep`. (Below tool-state so a freshly-opened cluttered/hot session still reads correctly; neglect only surfaces once nothing more urgent is true.)
6. **Transient reaction beats** (one-shots from §3: reply-counted `happy`, tidy-up `cheer`, first-reply `wave`, return-from-neglect `wave`→`happy`). These play for their duration, then fall back to the ambient mood.
7. **Ambient good states** (default): pick from `content` set `[idle, breathe, blink, look, float, sway]` when pace healthy + tabs tidy; from `happy`-lite set `[happy, float, wiggle]` only on a genuine streak day.

### Transitions
- Re-evaluate on the same triggers the code already fires: `recordSentReply`→`renderDock`, `setPaused`, popup `refresh()`, and an ambient idle rotation timer (reuse the lab's ~6s `nextIdle` cadence so Goobi varies within a mood without re-querying).
- Reaction beats (level 6) use the lab's `perform(key, ms)` pattern: set `mode="react"`, play the one-shot, then `setTimeout` back to `mode="auto"` and re-resolve the ambient mood.
- A mood change is **debounced**: pace is read from `replyLog.times` (already a rolling hour), so it self-decays — as the hour window slides, `easeoff`→`caution`→`content` happen on their own with no special timer. This is the honest beat: Goobi recovers exactly as the account does.

### Decay / neglect timers (the Tamagotchi beat — deliberately minimal)
v1 does **NOT** run the lab's 4-stat decay engine (fullness/happiness/energy/cleanliness ticking down). That would be a fake need bolted on for retention — exactly what the charter forbids. Instead:
- The only "decay" is **real**: the reply-pace hour-window sliding (recovers Goobi) and the **neglect timer** (the single `lastOpenedAt` read). No fullness bar, no "Goobi is starving," no taps required to keep him alive.
- Neglect is a **soft slope, not a cliff**: sleepy (2d) → sleep (5d) → still just sleep forever. There is no terminal state. He always wakes happy when you return.

---

## 3. Interaction beats

Each beat names the trigger (real code hook), Goobi's reaction (animation key), and the rule it honors.

| Beat | Trigger (existing hook) | Goobi does | Rule honored |
|---|---|---|---|
| **Reply inserted** | `recordSentReply` fires (Insert/Commented/clipboard) AND pace `healthy` | `happy` one-shot (~1.4s) → ambient | Earned + calm; small so it never reads as "do it again." |
| **Reply inserted while hot** | same, but pace `caution`/`easeoff` | **No celebration** — holds `sleepy`/`dizzy` | Refuses to reward volume past the safe line. |
| **Hitting ease-off** | `repliesThisHour` crosses 30 | `panic` for ~1.5s (the crossing beat) → settle to `dizzy` + red | Honest alarm at the line, then a steady tired hold (not endless panic). |
| **Pausing** | `setPaused(true)` while caution/easeoff | `love` → `sleep` ("good, rest now") | The healthiest action gets the warmest reaction. Tenet 1 keystone. |
| **Tidy-up** | tabs archived (`reclaim`/`apply-rec`, `archivedCount` rose) | `cheer` one-shot, shadow `dance` | Reward lands on the genuinely useful action. |
| **All caught up** | dock footer state `n>0` "You're all caught up" / no pending spots | calm `float` + a single `blink` | Quiet contentment, not a "keep going" nudge. |
| **Quiet / neglected day** | `lastOpenedAt` ≥ 2d (NEW), nothing urgent | `sleepy`→`sleep` | Misses you softly; never nags, never notifies. |
| **Return after neglect** | popup/dock opens, `lastOpenedAt` was ≥2d | `wave` → `happy` | Rewards coming back; zero penalty for the gap. |
| **Click / pet Goobi** | pointerdown on `#goobi-face` (header) or the dock blob | squish micro-animation (reuse lab `poke()` keyframe) + ~1-in-5 chance of a `wink` or `wave`; surfaces a one-line status (see §4) | Delight + a tiny honest readout. No stat to grind — petting just feels nice and tells you how you're doing. |

**Petting detail:** the lab's `poke()` does a spring squish via `wrap.animate(...)` and bumps a happiness stat. v1 keeps the squish (it's pure charm) but drops the stat bump — instead, petting **reveals the current honest status line** (the mood's one-liner from §4) as a tiny tooltip/toast. Petting is reassurance, not a care chore.

---

## 4. Reaction copy (Goobi's voice)

Short, warm, lowercase-friendly, never naggy. One line per beat; rotate within a beat so it's not robotic. Goobi refers to himself as "i"/"we," talks like a calm friend who's on your side.

**Content / healthy pace**
- "nice and steady. this is the pace that keeps your reach safe."
- "all calm here. you're replying like a person, not a bot."

**Caution (20–29/hr)**
- "let's ease up a touch — you're getting close to x's pace line."
- "good momentum. maybe space the next few out a bit?"

**Ease-off (≥30/hr)**
- "okay, i'm wiped — and your account's near x's automation line. let's take a breather."
- "time to rest. nothing good happens past 30 an hour."

**Pausing (the proud beat)**
- "good call. resting now — your reach thanks you."
- "this is the smart move. i'll be here when you're back."

**Reply inserted (healthy)**
- "nice one. that one's worth posting."
- "good reply. paced just right."

**First reply of the day**
- "hey! back at it. let's make a few good ones."

**Streak (rare, wholesome)**
- "a few solid days in a row. quality, not quantity — love that."

**Tidy-up**
- "ahh, room to breathe. tidy tabs, tidy mind."
- "nice cleanup. your laptop thanks you too."

**Overwhelmed (tabs/RAM)**
- "oof, it's getting crowded in here. want to archive the idle ones?"
- "lots of tabs open — no rush, just whenever you like."

**All caught up**
- "all caught up. nothing needs you right now — enjoy it."

**Return after neglect**
- "you're back! i missed you. everything's fine here."
- "hey, stranger. good to see you."

**Pet / click**
- "hi 👋" / "boop." / (then the honest status line for the current mood)

> Tone guardrails baked in: no "you'll lose your streak," no "X people replied without you," no "come back or…," no exclamation-spam. If a line could be read as pressure or FOMO, it's wrong.

---

## 5. Smallest lovable v1 (ships from existing signals)

**Ships now — zero new backend, zero new art.** All keys exist in `STATES`; all signals are already computed.

v1 mood set (6 moods + reaction beats):
1. **Content** — pace healthy + tabs tidy → `idle`/`breathe`/`blink`/`float` (ambient rotation).
2. **Easing** (caution) — `repliesThisHour 20–29` → `sleepy`/`sway`.
3. **Worn out** (ease-off) — `repliesThisHour ≥ 30` → `dizzy` + red, `panic` on the crossing beat.
4. **Proud-to-pause** — `setPaused` while hot → `love`→`sleep`. *(highest precedence)*
5. **Buried** — `mem.pct > 85` OR `idleCount ≥ 25` → `shake`→`dizzy`.
6. **Reaction beats** — reply-counted `happy`, tidy-up `cheer`, all-caught-up `float`+`blink`, click-to-pet squish (+ status line).

Implementation shape (suggested, in scope for the engineer):
- A small pure `goobiMood(signals) → { mood, animKey, copy }` module (mirror `moodOf()`), fed by the values already assembled in `getData()` (popup) and the live `replyLog`/`reputationStatus` (dock). Pure + unit-testable like `reply-hygiene.ts`.
- Replace the minimal `mountGoobi` header renderer's fixed `idle` with `goobiMood(...).animKey`, reusing the lab's frame/anim engine (the `STATES` entry carries `anim`/`frames`/`shadow`/`dur`).
- Wire the reaction beats into the existing call sites: `recordSentReply` (reply beat), `setPaused` (pause beat), the popup tidy actions (`cheer`), dock footer (all-caught-up).

**Cut from v1 (intentionally):** the 4-stat care bars, Feed/Play/Sleep/Clean buttons, offline decay. They're a fake-need game; v1 is "status display with feelings," per the charter's restraint tenet.

### v2+ wishlist (needs new instrumentation)
- **Neglect mood** (`sleepy`/`sleep` + return-`wave`): needs the one `goobiLastOpenedAt` timestamp (trivial, but it's new state — flagged honestly). Could land in v1.1 the moment that single write is added.
- **Streak `tada`**: derivable from `replyLog.daily` today (read-only), but wants a "last streak celebrated on" marker so it fires at most once/day — small new state.
- **"What's working" pride beat**: once the paced measure-pass fills `SentRecord.outcome` (already stubbed in `x-copilot.ts`), Goobi could do a quiet `tada` when a past reply got a real reply-back. Needs that loop to land first — explicitly out of scope until then.
- **Duplicate-reply / repeat-author awareness**: `pickReplyNudge` already detects these; Goobi could give a brief `surprised`/`look` ("that one's close to one you used — tweak it?"). Needs hooking the nudge's return into the mood layer; defer to v2 to keep v1 tight.

---

## 6. Where Goobi lives + care-loop scope

**Homes (v1):**
- **Header, always** — the existing `#goobi-face` slot in `popup.ts` (mounted via `mountGoobi`). This is Goobi's primary home and where most moods render. He reflects whatever the popup just computed in `getData()` (mem/idle + replyStats + safety).
- **On-page x.com dock** — the collapsed dock blob (`"✦ Goobi"` button / the avatar-stack pill in `renderDock`). On x.com, Goobi mirrors the **live pace** specifically (this is where ease-off/caution/proud-to-pause matter most, right next to the pace chip). Reuse the dock's existing `reputationStatus(rhh)` read — no new query.
  - Keep it *quiet*: Goobi in the dock animates subtly and never blocks the reply work. The pace chip stays the precise readout; Goobi is the at-a-glance feeling next to it.

**Care-loop scope (v1):** **none of the chore loop.** No needs to feed, no bars to refill, no timers that punish absence. The "loop" is entirely passive + honest: Goobi reflects real state, reacts to real moments, and can be petted for reassurance. The only thing resembling a care timer is the (optional v1.1) neglect slope, which is soft, terminal-free, and silent. This is a deliberate KISS choice — a status-display-with-feelings, not a needy game.

**One-line summary for the implementing engineer:** build a pure `goobiMood()` resolver over the values already in `getData()` + `replyLog`/`reputationStatus`, map its output to an existing `STATES` key, render it in the header (always) and the x.com dock (pace-focused), and fire the four reaction one-shots (`happy` on reply, `cheer` on tidy, `love`→`sleep` on pause-while-hot, squish on pet) at the call sites that already exist. Ship that; defer the neglect timestamp and streak marker to the first follow-up.
