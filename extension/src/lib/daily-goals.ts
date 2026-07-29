export interface DailyGoals { replies: number; posts: number; dms: number; }

/** A focused daily cadence for a sub-1k account growing through conversation. */
export const DEFAULT_DAILY_GOALS: DailyGoals = { replies: 10, posts: 1, dms: 2 };
export const DAILY_GOAL_MAX: DailyGoals = { replies: 30, posts: 5, dms: 5 };
export const DAILY_GOALS_VERSION = 4;
const PREVIOUS_DEFAULTS: DailyGoals[] = [
  { replies: 10, posts: 1, dms: 2 },
  { replies: 20, posts: 2, dms: 3 },
  { replies: 200, posts: 3, dms: 3 },
];

const boundedInt = (value: unknown, fallback: number, max: number): number => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(max, Math.round(n))) : fallback;
};

/** Zero disables that goal. Conservative caps keep the tracker from coaching spam volume. */
export function normalizeDailyGoals(value: unknown): DailyGoals {
  const raw = value && typeof value === "object" ? value as Partial<DailyGoals> : {};
  // A prior build accidentally treated X's 200/day technical ceiling as a
  // recommended default. It is not a safety target. Reset that exact legacy
  // tuple instead of merely clamping it, while preserving deliberate custom goals.
  if (Number(raw.replies) === 200 && Number(raw.posts) === 3 && Number(raw.dms) === 3) return { ...DEFAULT_DAILY_GOALS };
  return {
    replies: boundedInt(raw.replies, DEFAULT_DAILY_GOALS.replies, DAILY_GOAL_MAX.replies),
    posts: boundedInt(raw.posts, DEFAULT_DAILY_GOALS.posts, DAILY_GOAL_MAX.posts),
    dms: boundedInt(raw.dms, DEFAULT_DAILY_GOALS.dms, DAILY_GOAL_MAX.dms),
  };
}

/** Upgrade old defaults while preserving goals the person deliberately changed. */
export function migrateDailyGoals(value: unknown, version: unknown): { goals: DailyGoals; changed: boolean } {
  const goals = normalizeDailyGoals(value);
  const currentVersion = Number.isFinite(Number(version)) ? Number(version) : 0;
  if (currentVersion >= DAILY_GOALS_VERSION) return { goals, changed: false };
  const missing = !value || typeof value !== "object";
  const matchesOldDefault = PREVIOUS_DEFAULTS.some((candidate) =>
    (Object.keys(candidate) as Array<keyof DailyGoals>).every((key) => goals[key] === candidate[key]),
  );
  return { goals: missing || matchesOldDefault ? { ...DEFAULT_DAILY_GOALS } : goals, changed: true };
}

export function dailyGoalPercent(done: number, target: number): number {
  if (target <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((Math.max(0, done) / target) * 100)));
}
