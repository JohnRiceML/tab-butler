/**
 * Gamified-but-HONEST activity display — the "show up" layer. Every dot and number is a
 * MEASURED fact (replies you sent through Goobi + posts shipped, per day); nothing is invented
 * to juice the streak. The flame never celebrates past the safety line (easeoff wins every
 * contest), and each callout is tied to a REAL ranker mechanism with its evidence class named
 * (prior = the 2023 open-source weights / corroborated 2026 write-ups; measured = your own
 * data) — never "streak = boost", because X has no literal streak bonus: consistency compounds
 * through repeat engagement (per-account affinity) and account reputation. Pure, unit-tested
 * (scripts/test-activity.mjs); x-copilot owns the data + render.
 */

export interface DayCell { day: string; replies: number; posts: number; active: boolean; intensity: 0 | 1 | 2 | 3 }

const DAY_MS = 86_400_000;

/** Last `span` days, oldest → newest. `dayKeyOf` is passed in so keys match the caller's format. */
export function activityCells(
  repliesByDay: Record<string, number>,
  postsByDay: Record<string, number>,
  now: number,
  dayKeyOf: (ms: number) => string,
  span = 14,
): DayCell[] {
  const cells: DayCell[] = [];
  for (let i = span - 1; i >= 0; i--) {
    const day = dayKeyOf(now - i * DAY_MS);
    const replies = repliesByDay[day] || 0;
    const posts = postsByDay[day] || 0;
    const acts = replies + posts;
    const intensity: DayCell["intensity"] = acts === 0 ? 0 : acts <= 2 ? 1 : acts <= 7 ? 2 : 3;
    cells.push({ day, replies, posts, active: acts > 0, intensity });
  }
  return cells;
}

/** Consecutive active days: `current` counts back from today (today itself gets grace — an
 *  inactive-so-far today doesn't break the chain until it's over), `best` is the longest run
 *  in the window. Same semantics as replyStreak, but over replies+posts. */
export function chain(cells: DayCell[]): { current: number; best: number } {
  let best = 0, run = 0;
  for (const c of cells) { run = c.active ? run + 1 : 0; if (run > best) best = run; }
  let current = 0;
  for (let i = cells.length - 1; i >= 0; i--) {
    const c = cells[i];
    if (i === cells.length - 1 && !c.active) continue; // today's grace
    if (c.active) current++; else break;
  }
  return { current, best };
}

export interface Callout { text: string; why: string; kind: "prior" | "measured" }

/** One contextual, algo-backed callout — deterministic priority, safety first. */
export function pickCallout(ctx: {
  easeoff: boolean;
  trend: "picking-up" | "steady" | "cooling" | null;
  chainDays: number;
  repliesToday: number;
  postsThisWeek: number;
}): Callout {
  if (ctx.easeoff) return {
    text: "Ease off — past ~30 replies/hr reads as automation, and those penalties stick to the account. Goobi paused scanning for new spots (⟳ Rescan overrides).",
    why: "Volume/burst heuristics are the corroborated spam trigger class (2026 shadowban guides); the chain is never worth tripping them.",
    kind: "prior",
  };
  if (ctx.trend === "cooling") return {
    text: "Cooling vs last week — favor FRESHER posts over more volume; the first 30-60 min decide a post's reach.",
    why: "Measured: your per-post results this week vs last. The early-window lever is a corroborated prior (early velocity gates distribution).",
    kind: "measured",
  };
  if (ctx.trend === "picking-up") return {
    text: "It's working — per-post results are up vs last week. Same mix, same pace; don't chase volume.",
    why: "Measured from X-reported results on your own posts, week over week.",
    kind: "measured",
  };
  if (ctx.repliesToday === 0) return {
    text: "Show up today — repeat engagement compounds your affinity with each account; gaps let it decay.",
    why: "Per-account affinity (real-graph) grows with repeated interaction in the open-source ranker — the honest mechanism behind \"streaks help\".",
    kind: "prior",
  };
  if (ctx.postsThisWeek === 0) return {
    text: "Mix in an original this week — replies earn the reach, your posts convert the profile clicks into follows.",
    why: "The reply → profile-visit → follow funnel: ~70/30 replies-to-posts is the standard growth mix; the profile is the conversion surface.",
    kind: "prior",
  };
  return {
    text: "Reply early — only the first handful of replies under a post get seen. Fresh beats perfect.",
    why: "Early replies ride the parent post's distribution window (corroborated prior); late ones collapse under \"show more\".",
    kind: "prior",
  };
}
