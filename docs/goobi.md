# Goobi — the mascot system

Goobi is the app's mascot: a coral pixel blob (the Claude "Clawd" body color) who
reacts to what's actually happening. He is an **honest mirror with a face** — every
mood maps to a real signal the app already tracks (see the tenets in
[goobi-game-designer](../.claude/agents/goobi-game-designer.md) and the original
spec [goobi-design-v1.md](goobi-design-v1.md)). No fake needs, no dark patterns.

## Files

- `extension/src/lib/goobi.ts` — the renderer. A 20×14 pixel sprite drawn on a
  `<canvas>`, mood-driven, with a self-stopping animation loop. Exports
  `mountGoobi(host, opts?) → GoobiHandle` and the `GoobiMood` type.
- `extension/src/content/x-copilot.ts` — drives Goobi in the on-page X dock
  (`goobiMood`, `goobiStatus`, `goobiReact`, `goobiReactLove`, `refreshGoobi`,
  `touchGoobi`, `replyStreak`).
- `extension/src/popup/popup.ts` + `popup.html` — the side-panel header Goobi and
  **Goobi's playground**.
- `mascot-lab.html` (repo root) — the canonical sprite + the full ~30-animation /
  care reference Goobi was extracted from.

`mountGoobi(host, { cell, playful })` returns `{ el, setMood(mood), destroy() }`.
`cell` = pixel size (dock 3, playground 4, header 2). `playful: true` swaps the
calm idle for the energetic playground idle. The frame loops self-guard on
`canvas.isConnected` + the current mood, so a re-render or mood change never leaks
a timer or lets one animation bleed into the next.

## Moods → animation

| Mood | Look | CSS anim | When |
|---|---|---|---|
| `idle` | bob + random fidgets (blink/look/wink/wiggle/bounce/heartbeat/float) | `g-bob` | posts waiting, nothing active |
| `sleeping` | eyes shut, slow breathe, z's | `g-breathe` | all quiet / paused / neglected |
| `searching` | eyes dart R·C·up·L over a sway-hop | `g-hunt` | Find spots / just rescanned |
| `thinking` | eyes scan up-around | `g-think` | analyzing (Claude scoring) / drafting |
| `happy` | `^‿^` | `g-bob` | follow; (legacy reply beat) |
| `cheer` | `^‿^` + shimmy | `g-tada` | streak / welcome-back / pet |
| `trick` | `^‿^` + a **random** show-off move (dance/spin/flip/jump/bounce/wiggle/tada, dance-weighted) via `GoobiHandle.trick()` | (varies) | playground: pet/feed once he's "ready" (happy) → fresh move each time |
| `love` | red heart eyes + smitten bounce | `g-love` | the reply reaction (after cheer) |
| `worn` | dizzy X-eyes, body turns red | `g-wobble` | ease-off (≥30 replies/hr) |

The playground idle (`playful`) cycles bigger moves: jump, dance, bounce, wiggle,
tada, heartbeat (g-jump / g-dance + the rest), more frequently.

## Signal → mood (the honest mirror)

Driven by `goobiMood()` in `x-copilot.ts`, in precedence order:

1. **Just reacted** (reply/follow/welcome) → the transient `goobiReactMood`.
2. **Drafting** a reply (Claude) → `thinking`.
3. **Find spots** running → `searching`.
4. **Analyzing** — `inFlight.size > 0` (Claude scoring a batch) → `thinking`.
5. **Just rescanned** (`goobiSearchUntil` window) → `searching`.
6. **Ease-off** — `repliesLastHour() ≥ REPLY_HARD_PER_HOUR` (30) → `worn`.
7. **Posts waiting** (`opps.size > 0`) → `idle`, else → `sleeping`.

Working-state flips (search/analyze/draft) update Goobi **in place** via
`refreshGoobi()` (no full dock re-render).

## Reactions

- **Reply sent** (`recordSentReply`, healthy pace only): `goobiReactLove` — a big
  `cheer` that melts into `love` after ~1.1s. Streak (first reply of a day
  extending a 2+ day streak) → same, with an "N-day streak!" line.
- **Follow** → quick `happy` ("New friend!").
- **Welcome back** → `cheer` ("Missed you!") when you open the dock after ≥2 days
  away (`goobiLastSeen` / `X_GOOBI_SEEN_KEY`, set by `touchGoobi`).
- **Honest-mirror keystone:** none of the reply celebrations fire past the
  ease-off line — Goobi stays `worn` instead. He never rewards going too fast.

## Where he lives

- **On-page X dock** (`x-copilot.ts`): top of the dock as its face (**tap → the
  in-dock playground**, see below), and as the icon on the minimized launcher pill
  (dark pill so the coral pops).
- **In-dock playground** (`x-copilot.ts`, `dockPlayOpen` + `buildPlay`): tapping
  the dock Goobi springs a playground open in place of the post list (Framer-ish —
  `springOpen`/`springClose` ease the panel height while the inner content
  overshoots in). A bigger interactive Goobi (cell 4, `playful`), today's replies
  as treats (`todaySent`, each flies into his mouth on feed), and tap-to-pet. Care
  fills an **energy meter** (`playHappiness` = fed + pets×0.1 — feeding is what makes
  him happy; petting barely counts); at `PLAY_HAPPY` (6 — a good few feeds) the
  **"↻ Let's go hunt!"** button unlocks and glows — clicking it collapses the
  playground and triggers `rescan()`. So a scan is something you *earn* by looking
  after him. Energy resets each time the playground opens.
  - **Fed treats are remembered across sessions.** `fedEver` (a Set of reply ids,
    `treatId(rec) = rec.id ?? at`) + a lifetime `fedTotal` persist under
    `X_GOOBI_FED_KEY` (loaded at boot, saved on each feed, ids capped at 2000). A
    reply he's already eaten never reappears as a treat; the "🍪 N eaten" stat shows
    the running total. (`SentRecord.id` is a unique per-reply stamp so two replies in
    the same millisecond can't collide.)
  - **Tricks when happy.** Once he's `playReady`, petting or finishing a feed sends
    him into the `trick` mood (a hop + 360° spin) before he settles — a little reward
    for getting him pumped.
- **Side-panel header** (`popup.ts`): the logo; mirrors pace (`worn` at ease-off,
  else `idle`). Click him → **the playground**.
- **Playground** (`popup.ts` `renderPlayground`): a Tamagotchi room. Treats = the
  replies you sent today (each treat's tooltip is the real reply snippet from
  `replyLog.sent`). Tap a treat → he eats it (`love`), the belly meter fills. Tap
  Goobi → pet (`cheer` + a random line). `playful: true` idle so he's lively.

## Adding a mood

1. Add it to `GoobiMood` + the `ANIM` map in `goobi.ts`, and a render branch in
   `run()` (which face + which CSS class).
2. Add the `@keyframes` + `.g-<name>` class to BOTH `DOCK_CSS` (x-copilot.ts) and
   `popup.html` (whichever surfaces use it).
3. If it's a transient reaction, fire it via `goobiReact(...)`; if a working state,
   add it to `goobiMood()` precedence + call `refreshGoobi()` at the state flip.
4. Add a `goobiStatus()` COPY entry (the status line/tooltip).
