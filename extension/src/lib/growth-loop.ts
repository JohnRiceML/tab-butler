/**
 * Account-level growth experiments.
 *
 * The lower-level systems optimize replies, posts, targets, and DMs. This module remembers the
 * strategic bet that connected them, compares the bet's window with the immediately preceding
 * window, and returns a directional editorial read after the full window ends. It never claims
 * profile-click attribution or causal proof: X does not expose that event here, so follower and
 * post outcomes are reported only as observed co-movement.
 */

export const GROWTH_WINDOW_DAYS = 14;
export const GROWTH_KEEP_DAYS = 90;
export const GROWTH_MIN_POSTS_PER_WINDOW = 3;
export const GROWTH_MIN_FOLLOWER_SPAN_DAYS = 7;
const DAY_MS = 86_400_000;

export type GrowthStrategyId = "proof" | "operator" | "builder" | "community" | "point-of-view";
export type GrowthDecision = "collect" | "double-down" | "tighten" | "switch";

export interface GrowthStrategy {
  id: GrowthStrategyId;
  label: string;
  promise: string;
  hypothesis: string;
  postBrief: string;
  replyBrief: string;
  profileBrief: string;
}

export const GROWTH_STRATEGIES: GrowthStrategy[] = [
  {
    id: "proof", label: "Proof-led authority", promise: "Make the reason to follow tangible.",
    hypothesis: "Specific results and artifacts will turn curiosity into trust better than broad advice.",
    postBrief: "Publish concrete results, before/after evidence, or a compact case study. Never invent a number. When a screenshot IS the proof (a dashboard, a chart, a customer message), attach it — an image worth inspecting earns the photo-expand, a scored action.",
    replyBrief: "Add one specific lesson, example, or tradeoff that demonstrates real experience.",
    profileBrief: "Make the bio promise concrete and pin the strongest proof post.",
  },
  {
    id: "operator", label: "Useful operator", promise: "Become the account people save for practical help.",
    hypothesis: "Repeatable tactics and clear breakdowns will raise saves, replies, and qualified follows.",
    postBrief: "Teach one useful method, checklist, teardown, or decision with enough detail to apply.",
    replyBrief: "Add the missing implementation detail or ask the question that improves the tactic.",
    profileBrief: "State who the practical advice is for and what problem you help them solve.",
  },
  {
    id: "builder", label: "Builder story", promise: "Give people a project and person to root for.",
    hypothesis: "Visible progress, decisions, and honest lessons will create repeat interest over time.",
    postBrief: "Share a real build decision, artifact, setback, or progress marker and the lesson behind it. When the artifact is visual (the screen you shipped, the diff, the graph), attach it — an image worth inspecting earns the photo-expand, a scored action.",
    replyBrief: "Connect through a real parallel from your own work without hijacking the conversation.",
    profileBrief: "Name what you are building now and make the banner or pin show it immediately.",
  },
  {
    id: "community", label: "Community catalyst", promise: "Be the person who makes the room smarter.",
    hypothesis: "Thoughtful questions, synthesis, and follow-through will produce more durable relationships.",
    postBrief: "Synthesize a live debate, ask a narrow expert question, or spotlight a useful peer insight.",
    replyBrief: "Prioritize relevant peers, continue real exchanges, and ask questions worth answering.",
    profileBrief: "Make your niche and the people you want to connect with obvious at a glance.",
  },
  {
    id: "point-of-view", label: "Distinct point of view", promise: "Give people a perspective they can recognize.",
    hypothesis: "A consistent, evidence-backed point of view will increase recall and profile curiosity.",
    postBrief: "Make one arguable claim, support it with a concrete observation, and keep it constructive.",
    replyBrief: "Offer a civil counterpoint or sharper framing only when you can support it.",
    profileBrief: "Align the bio and pin around the specific territory you want to be known for.",
  },
];

export interface GrowthPostMetric { id: string; postedAt: number; views?: number; likes?: number; reposts?: number; replies?: number; }
export interface GrowthDay {
  day: string;
  /** Last time any metric in this row was refreshed. */
  at: number;
  followers?: number;
  /** Time the follower count was actually observed; post refreshes must not move it forward. */
  followerAt?: number;
  posts: Record<string, GrowthPostMetric>;
}
export interface GrowthWindow {
  startAt: number; endAt: number; observedDays: number;
  followerStart?: number; followerEnd?: number; followerDelta?: number; followerPerDay?: number; followerSpanDays?: number;
  posts: number; measuredPosts: number; views: number; engagement: number;
  viewsPerPost?: number; engagementPerPost?: number;
  /** Robust descriptive centers used by the editorial evaluator; means remain available for UI. */
  viewsMedianPerPost?: number; engagementMedianPerPost?: number;
}
export interface GrowthEvaluation {
  ready: boolean;
  executionReady: boolean;
  decision: GrowthDecision;
  headline: string;
  reasons: string[];
  current: GrowthWindow;
  baseline: GrowthWindow;
  nextStrategyId: GrowthStrategyId;
  taggedPosts: number;
  taggedReplies: number;
}
export interface GrowthExperiment {
  id: string;
  strategyId: GrowthStrategyId;
  startedAt: number;
  endsAt: number;
  status: "active" | "completed";
  endedAt?: number;
  updatedAt: number;
  outcome?: GrowthEvaluation;
}
export type ProfileChangeVariable = "bio" | "pin" | "banner" | "name";
export interface ProfileChangeExperiment {
  id: string;
  /** The ONE thing the user declared they changed. Single-subject design: one variable per read. */
  variable: ProfileChangeVariable;
  /** User-declared moment of the change — the boundary between the before and after windows. */
  changedAt: number;
  status: "active" | "completed" | "invalidated";
  /** Why the read was voided (the user changed more than one thing mid-window). */
  invalidatedNote?: string;
  updatedAt: number;
  /** Frozen at settle time so the record survives the 90-day day-row pruning. */
  outcome?: ProfileChangeRead;
}
export interface ProfileChangeRead {
  /** collecting = window still filling · read = honest before/after · unreadable = data Goobi never observed cannot be reconstructed · invalidated = confounded by a second change. */
  state: "collecting" | "read" | "unreadable" | "invalidated";
  headline: string;
  /** Each line is a ✓ measured before→after pair from the user's own logged data. Empty unless state is "read". */
  lines: string[];
  /** Method honesty: correlation-not-causation, the missing profile-visit metric, overlapping tests. */
  caveats: string[];
  before: GrowthWindow;
  after: GrowthWindow;
  /** Whole days elapsed since the change, capped at the window length. */
  elapsedDays: number;
}
export interface GrowthStore { version: 1; ownerHandle: string; days: Record<string, GrowthDay>; experiments: GrowthExperiment[]; profileChanges?: ProfileChangeExperiment[]; }
export interface TaggedGrowthAction { at: number; experimentId?: string; strategyId?: GrowthStrategyId; kind: "post" | "reply"; confirmed?: boolean; }

const norm = (s: string): string => (s || "").trim().replace(/^@+/, "").toLowerCase();
const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const maxMetric = (a: number | undefined, b: number | undefined): number | undefined => {
  if (!finite(a) && !finite(b)) return undefined;
  return Math.max(finite(a) ? a : 0, finite(b) ? b : 0);
};
const median = (values: number[]): number | undefined => {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const clone = (s: GrowthStore): GrowthStore => ({ version: 1, ownerHandle: s.ownerHandle, days: Object.fromEntries(Object.entries(s.days).map(([k, d]) => [k, { ...d, posts: { ...d.posts } }])), experiments: s.experiments.map((e) => ({ ...e, outcome: e.outcome ? { ...e.outcome, reasons: [...e.outcome.reasons], current: { ...e.outcome.current }, baseline: { ...e.outcome.baseline } } : undefined })), profileChanges: s.profileChanges?.map((p) => ({ ...p, outcome: p.outcome ? { ...p.outcome, lines: [...p.outcome.lines], caveats: [...p.outcome.caveats], before: { ...p.outcome.before }, after: { ...p.outcome.after } } : undefined })) });

export function growthStrategy(id: GrowthStrategyId): GrowthStrategy { return GROWTH_STRATEGIES.find((s) => s.id === id) ?? GROWTH_STRATEGIES[0]; }
export function freshGrowthStore(ownerHandle: string): GrowthStore { return { version: 1, ownerHandle: norm(ownerHandle), days: {}, experiments: [] }; }

export function mergeGrowthStores(a: GrowthStore | undefined, b: GrowthStore | undefined, owner: string, now: number): GrowthStore {
  const ownerHandle = norm(owner);
  const out = freshGrowthStore(ownerHandle);
  for (const src of [a, b]) {
    if (!src || src.version !== 1 || norm(src.ownerHandle) !== ownerHandle) continue;
    for (const [key, day] of Object.entries(src.days ?? {})) {
      if (!day || typeof day !== "object" || !finite(day.at)) continue;
      const ex = out.days[key] ?? { day: key, at: 0, posts: {} };
      const incomingFollowerAt = day.followerAt ?? day.at;
      const existingFollowerAt = ex.followerAt ?? ex.at;
      const newerFollower = incomingFollowerAt >= existingFollowerAt;
      const posts = { ...ex.posts };
      for (const [id, post] of Object.entries(day.posts ?? {})) {
        if (!post || typeof post !== "object" || !post.id || !finite(post.postedAt)) continue;
        const prev = posts[id];
        posts[id] = prev ? {
          ...prev, ...post,
          views: maxMetric(prev.views, post.views),
          likes: maxMetric(prev.likes, post.likes),
          reposts: maxMetric(prev.reposts, post.reposts),
          replies: maxMetric(prev.replies, post.replies),
        } : { ...post };
      }
      out.days[key] = {
        day: key,
        at: Math.max(ex.at, day.at),
        followers: newerFollower ? (day.followers ?? ex.followers) : (ex.followers ?? day.followers),
        followerAt: newerFollower
          ? (day.followers != null ? incomingFollowerAt : ex.followerAt)
          : (ex.followers != null ? existingFollowerAt : day.followerAt),
        posts,
      };
    }
    for (const exp of Array.isArray(src.experiments) ? src.experiments : []) {
      if (!exp?.id || !finite(exp.startedAt) || !finite(exp.updatedAt)) continue;
      const i = out.experiments.findIndex((e) => e.id === exp.id);
      if (i < 0) out.experiments.push({ ...exp });
      else if (exp.updatedAt >= out.experiments[i].updatedAt) out.experiments[i] = { ...exp };
    }
    for (const pc of Array.isArray(src.profileChanges) ? src.profileChanges : []) {
      if (!pc?.id || !finite(pc.changedAt) || !finite(pc.updatedAt)) continue;
      const list = out.profileChanges ?? (out.profileChanges = []);
      const i = list.findIndex((e) => e.id === pc.id);
      if (i < 0) list.push({ ...pc });
      else if (pc.updatedAt >= list[i].updatedAt) list[i] = { ...pc };
    }
  }
  const cut = now - GROWTH_KEEP_DAYS * DAY_MS;
  for (const key of Object.keys(out.days)) if (out.days[key].at < cut) delete out.days[key];
  out.experiments.sort((x, y) => y.startedAt - x.startedAt);
  out.experiments = out.experiments.slice(0, 12);
  if (out.profileChanges) { out.profileChanges.sort((x, y) => y.changedAt - x.changedAt); out.profileChanges = out.profileChanges.slice(0, PROFILE_CHANGES_MAX); }
  return out;
}

export function captureGrowthSnapshot(store: GrowthStore, owner: string, now: number, today: string, followers: number | undefined, posts: Array<GrowthPostMetric & { day: string }>): GrowthStore {
  const base = norm(store.ownerHandle) === norm(owner) ? store : freshGrowthStore(owner);
  const out = clone(base);
  const todayRow = out.days[today] ?? { day: today, at: now, posts: {} };
  todayRow.at = Math.max(todayRow.at, now);
  if (finite(followers) && followers >= 0) {
    todayRow.followers = followers;
    todayRow.followerAt = now;
  }
  out.days[today] = todayRow;
  for (const post of posts) {
    if (!post.id || !post.day || !finite(post.postedAt)) continue;
    const row = out.days[post.day] ?? { day: post.day, at: now, posts: {} };
    row.at = Math.max(row.at, now);
    const prev = row.posts[post.id];
    row.posts[post.id] = prev ? {
      ...prev, ...post,
      views: maxMetric(prev.views, post.views),
      likes: maxMetric(prev.likes, post.likes),
      reposts: maxMetric(prev.reposts, post.reposts),
      replies: maxMetric(prev.replies, post.replies),
    } : { ...post };
    out.days[post.day] = row;
  }
  return mergeGrowthStores(out, undefined, owner, now);
}

/** Import old follower-only snapshots without pretending their legacy post deltas are post outcomes. */
export function seedFollowerSnapshot(store: GrowthStore, owner: string, day: string, at: number, followers: number | undefined, now: number): GrowthStore {
  if (!finite(followers)) return store;
  const out = norm(store.ownerHandle) === norm(owner) ? clone(store) : freshGrowthStore(owner);
  const row = out.days[day] ?? { day, at, posts: {} };
  if (row.followers == null || at >= (row.followerAt ?? row.at)) {
    row.followers = followers;
    row.followerAt = at;
  }
  row.at = Math.max(row.at, at);
  out.days[day] = row;
  return mergeGrowthStores(out, undefined, owner, now);
}

export function summarizeGrowthWindow(store: GrowthStore, startAt: number, endAt: number): GrowthWindow {
  // Only follower-bearing rows prove that Goobi observed the account on that day. Historical post
  // rows may be refreshed later as their view count settles, so their `at` is a measurement time,
  // not the day the account was visited.
  const followers = Object.values(store.days)
    .filter((d) => finite(d.followers) && (d.followerAt ?? d.at) >= startAt && (d.followerAt ?? d.at) <= endAt)
    .sort((a, b) => (a.followerAt ?? a.at) - (b.followerAt ?? b.at));
  const byPost = new Map<string, GrowthPostMetric>();
  for (const day of Object.values(store.days)) for (const post of Object.values(day.posts)) {
    if (post.postedAt >= startAt && post.postedAt <= endAt) byPost.set(post.id, post);
  }
  const posts = [...byPost.values()];
  const measured = posts.filter((p) => finite(p.views));
  const views = measured.reduce((n, p) => n + (p.views ?? 0), 0);
  const engagement = posts.reduce((n, p) => n + (p.likes ?? 0) + (p.reposts ?? 0) + (p.replies ?? 0), 0);
  const followerStart = followers[0]?.followers, followerEnd = followers.at(-1)?.followers;
  const followerDelta = followers.length >= 2 && followerStart != null && followerEnd != null ? followerEnd - followerStart : undefined;
  const spanDays = followers.length >= 2
    ? Math.max(1, ((followers.at(-1)!.followerAt ?? followers.at(-1)!.at) - (followers[0].followerAt ?? followers[0].at)) / DAY_MS)
    : undefined;
  const engagementByPost = posts.map((p) => (p.likes ?? 0) + (p.reposts ?? 0) + (p.replies ?? 0));
  return {
    startAt, endAt, observedDays: followers.length, followerStart, followerEnd, followerDelta,
    followerPerDay: followerDelta != null && spanDays ? followerDelta / spanDays : undefined, followerSpanDays: spanDays,
    posts: posts.length, measuredPosts: measured.length, views, engagement,
    viewsPerPost: measured.length ? views / measured.length : undefined,
    engagementPerPost: posts.length ? engagement / posts.length : undefined,
    viewsMedianPerPost: median(measured.map((p) => p.views as number)),
    engagementMedianPerPost: median(engagementByPost),
  };
}

export function activeGrowthExperiment(store: GrowthStore): GrowthExperiment | undefined { return store.experiments.find((e) => e.status === "active"); }

export function startGrowthExperiment(store: GrowthStore, strategyId: GrowthStrategyId, now: number, durationDays = GROWTH_WINDOW_DAYS): { store: GrowthStore; experiment?: GrowthExperiment; error?: string } {
  if (activeGrowthExperiment(store)) return { store, error: "Finish the current test before starting another." };
  const out = clone(store);
  const experiment: GrowthExperiment = { id: `gx.${now.toString(36)}.${strategyId}`, strategyId, startedAt: now, endsAt: now + durationDays * DAY_MS, status: "active", updatedAt: now };
  out.experiments.unshift(experiment);
  return { store: out, experiment };
}

function nextUntried(store: GrowthStore, after: GrowthStrategyId): GrowthStrategyId {
  const order = GROWTH_STRATEGIES.map((s) => s.id);
  const tried = new Set(store.experiments.slice(0, 3).map((e) => e.strategyId));
  const start = Math.max(0, order.indexOf(after));
  for (let step = 1; step <= order.length; step++) { const id = order[(start + step) % order.length]; if (!tried.has(id)) return id; }
  return order[(start + 1) % order.length];
}

const ratioChange = (cur?: number, prev?: number): number | undefined => {
  if (cur == null || prev == null) return undefined;
  // A zero baseline is a real observation, but it cannot support a finite relative change. Keep it
  // visible in the explanation without turning 0 -> 1 into an arbitrary "+100%" vote.
  if (prev === 0) return cur === 0 ? 0 : undefined;
  return (cur - prev) / Math.abs(prev);
};

function observedReason(label: string, cur: number | undefined, prev: number | undefined, change: number | undefined, sample: string): string | undefined {
  if (cur == null || prev == null) return undefined;
  if (prev === 0 && cur !== 0) return `Observed co-movement: ${label} ${prev.toFixed(1)} → ${cur.toFixed(1)} (${sample}); the baseline was zero, so this does not cast a percentage vote.`;
  const pct = change == null ? "" : `${change >= 0 ? "+" : ""}${Math.round(change * 100)}%`;
  return `Observed co-movement: ${pct} ${label} vs the prior window (${sample}).`;
}

const direction = (change: number | undefined): -1 | 0 | 1 | undefined => {
  if (change == null) return undefined;
  return change >= 0.2 ? 1 : change <= -0.2 ? -1 : 0;
};

/** Views and engagement come from the same posts, so they form one signal family, not two
 * independent votes. A strong keep/switch read requires that family and follower pace to agree. */
function postDirection(changes: Array<number | undefined>): -1 | 0 | 1 | undefined {
  const dirs = changes.map(direction).filter((v): v is -1 | 0 | 1 => v != null);
  if (!dirs.length) return undefined;
  if (dirs.some((v) => v > 0) && !dirs.some((v) => v < 0)) return 1;
  if (dirs.some((v) => v < 0) && !dirs.some((v) => v > 0)) return -1;
  return 0;
}

export function evaluateGrowthExperiment(store: GrowthStore, experiment: GrowthExperiment, actions: TaggedGrowthAction[], now: number): GrowthEvaluation {
  const endAt = Math.min(now, experiment.endedAt ?? experiment.endsAt);
  const duration = Math.max(DAY_MS, endAt - experiment.startedAt);
  const current = summarizeGrowthWindow(store, experiment.startedAt, endAt);
  const baseline = summarizeGrowthWindow(store, experiment.startedAt - duration, experiment.startedAt - 1);
  const tagged = actions.filter((a) => a.experimentId === experiment.id && a.at >= experiment.startedAt && a.at <= endAt);
  const taggedPosts = tagged.filter((a) => a.kind === "post").length;
  const taggedReplies = tagged.filter((a) => a.kind === "reply" && a.confirmed !== false).length;
  const plannedDays = Math.max(1, (experiment.endsAt - experiment.startedAt) / DAY_MS);
  const minFollowerSpan = Math.min(GROWTH_MIN_FOLLOWER_SPAN_DAYS, Math.max(1, plannedDays / 2));
  const windowComplete = endAt >= experiment.endsAt;
  const followerComparable = current.observedDays >= 2 && baseline.observedDays >= 2
    && (current.followerSpanDays ?? 0) >= minFollowerSpan && (baseline.followerSpanDays ?? 0) >= minFollowerSpan;
  const viewsComparable = current.measuredPosts >= GROWTH_MIN_POSTS_PER_WINDOW && baseline.measuredPosts >= GROWTH_MIN_POSTS_PER_WINDOW;
  const engagementComparable = current.posts >= GROWTH_MIN_POSTS_PER_WINDOW && baseline.posts >= GROWTH_MIN_POSTS_PER_WINDOW;
  const followerChange = followerComparable ? ratioChange(current.followerPerDay, baseline.followerPerDay) : undefined;
  const viewsChange = viewsComparable ? ratioChange(current.viewsMedianPerPost, baseline.viewsMedianPerPost) : undefined;
  const engagementChange = engagementComparable ? ratioChange(current.engagementMedianPerPost, baseline.engagementMedianPerPost) : undefined;
  const comparable = [followerChange, viewsChange, engagementChange].filter((v): v is number => v != null);
  // Ambient account movement cannot produce an editorial recommendation without recorded execution.
  // This gate proves only that work happened during the bet, never that the bet caused an outcome.
  const executionReady = taggedPosts >= 2 || taggedReplies >= 8 || (taggedPosts >= 1 && taggedReplies >= 3);
  const ready = windowComplete && comparable.length > 0 && executionReady;
  const reasons: string[] = [];
  const followerReason = followerComparable ? observedReason("followers/day", current.followerPerDay, baseline.followerPerDay, followerChange, `${current.followerSpanDays!.toFixed(0)}d vs ${baseline.followerSpanDays!.toFixed(0)}d observed`) : undefined;
  const viewsReason = viewsComparable ? observedReason("median views/measured post", current.viewsMedianPerPost, baseline.viewsMedianPerPost, viewsChange, `n=${current.measuredPosts} vs ${baseline.measuredPosts}`) : undefined;
  const engagementReason = engagementComparable ? observedReason("median engagement/post", current.engagementMedianPerPost, baseline.engagementMedianPerPost, engagementChange, `n=${current.posts} vs ${baseline.posts}`) : undefined;
  reasons.push(...[followerReason, viewsReason, engagementReason].filter((r): r is string => !!r));
  if (!ready) {
    if (!executionReady) reasons.unshift(`Execution recorded: ${taggedPosts} on-strategy post${taggedPosts === 1 ? "" : "s"} · ${taggedReplies} confirmed repl${taggedReplies === 1 ? "y" : "ies"}. Need 2 posts, 8 replies, or 1 post + 3 replies.`);
    const endedEarly = experiment.endedAt != null && experiment.endedAt < experiment.endsAt;
    const headline = !windowComplete
      ? endedEarly ? "No editorial read — this window ended early" : "Keep collecting — wait for the full editorial window"
      : !executionReady
        ? "Record enough on-strategy work before reading the window"
        : "Not enough stable comparison data for an editorial read";
    const fallback = !windowComplete
      ? `Goobi waits for the full ${Math.round(plannedDays)}-day window before offering any directional editorial read.`
      : `This observational read needs either follower snapshots spanning ${Math.round(minFollowerSpan)}+ days on both sides or ${GROWTH_MIN_POSTS_PER_WINDOW}+ posts in both windows.`;
    return { ready: false, executionReady, decision: "collect", headline, reasons: reasons.length ? reasons : [fallback], current, baseline, nextStrategyId: experiment.strategyId, taggedPosts, taggedReplies };
  }
  const followerSignal = direction(followerChange);
  const postSignal = postDirection([viewsChange, engagementChange]);
  // Decisive reads require agreement across the follower and post families. One metric, flat data,
  // or disagreement can still guide a small editorial adjustment, but cannot crown or reject a bet.
  const decision: GrowthDecision = followerSignal === 1 && postSignal === 1
    ? "double-down"
    : followerSignal === -1 && postSignal === -1
      ? "switch"
      : "tighten";
  const nextStrategyId = decision === "switch" ? nextUntried(store, experiment.strategyId) : experiment.strategyId;
  const headline = decision === "double-down"
    ? "The observed windows moved together — consider another editorial run"
    : decision === "switch"
      ? "The observed window weakened — consider a different editorial bet"
      : "The observational read is mixed or limited — adjust one editorial lever";
  return { ready, executionReady, decision, headline, reasons: reasons.slice(0, 3), current, baseline, nextStrategyId, taggedPosts, taggedReplies };
}

export function settleGrowthExperiments(store: GrowthStore, actions: TaggedGrowthAction[], now: number): { store: GrowthStore; settled: number } {
  const out = clone(store); let settled = 0;
  for (const experiment of out.experiments) {
    if (experiment.status !== "active" || now < experiment.endsAt) continue;
    experiment.status = "completed"; experiment.endedAt = experiment.endsAt; experiment.updatedAt = now;
    experiment.outcome = evaluateGrowthExperiment(out, experiment, actions, experiment.endsAt);
    settled++;
  }
  return { store: out, settled };
}

export function finishGrowthExperiment(store: GrowthStore, experimentId: string, actions: TaggedGrowthAction[], now: number): GrowthStore {
  const out = clone(store); const experiment = out.experiments.find((e) => e.id === experimentId);
  if (!experiment || experiment.status !== "active") return store;
  experiment.status = "completed"; experiment.endedAt = now; experiment.updatedAt = now;
  experiment.outcome = evaluateGrowthExperiment(out, experiment, actions, now);
  return out;
}

export function recommendedGrowthStrategy(store: GrowthStore, profileNeedsProof = false): GrowthStrategy {
  const active = activeGrowthExperiment(store); if (active) return growthStrategy(active.strategyId);
  const last = store.experiments.find((e) => e.status === "completed");
  if (last?.outcome) return growthStrategy(last.outcome.nextStrategyId);
  return growthStrategy(profileNeedsProof ? "proof" : "operator");
}

/* ---------- Profile-change experiments: a METHOD, never a number ----------
 * There is no honest external benchmark for bio→follow conversion (the circulating figures are
 * fabricated vendor copy), so the only defensible source is this account's own logged data:
 * single-subject, one declared variable, 14 days before vs 14 days after. Profile visits are NOT
 * exposed to the extension, so no conversion rate is ever computed — follower co-movement is the
 * honest stand-in, and every read says so. Below the observation gate the read stays silent. */

export const PROFILE_CHANGE_WINDOW_DAYS = 14;
/** Follower-observed days required on EACH side before the read speaks. */
export const PROFILE_CHANGE_MIN_OBSERVED_DAYS = 10;
const PROFILE_CHANGES_MAX = 8;

export const PROFILE_CHANGE_VARIABLES: { id: ProfileChangeVariable; label: string }[] = [
  { id: "bio", label: "Bio" },
  { id: "pin", label: "Pinned post" },
  { id: "banner", label: "Banner" },
  { id: "name", label: "Display name" },
];
export function profileChangeLabel(variable: ProfileChangeVariable): string {
  return PROFILE_CHANGE_VARIABLES.find((v) => v.id === variable)?.label ?? variable;
}

export function activeProfileChange(store: GrowthStore): ProfileChangeExperiment | undefined {
  return (store.profileChanges ?? []).find((p) => p.status === "active");
}

/** Log the ONE profile variable the user changed. Refuses a second change while a read is
 *  running — that confounds the running window; the caller offers invalidation instead. */
export function declareProfileChange(store: GrowthStore, variable: ProfileChangeVariable, changedAt: number, now: number): { store: GrowthStore; experiment?: ProfileChangeExperiment; error?: string; conflictId?: string } {
  if (!finite(changedAt) || changedAt > now) return { store, error: "The change date can't be in the future." };
  if (changedAt < now - GROWTH_KEEP_DAYS * DAY_MS) return { store, error: `Goobi only keeps ${GROWTH_KEEP_DAYS} days of history — log a change from inside that window.` };
  const running = activeProfileChange(store);
  if (running) return { store, error: "A profile read is already running. A second change makes both unreadable — invalidate the running one first.", conflictId: running.id };
  const out = clone(store);
  const experiment: ProfileChangeExperiment = { id: `pc.${now.toString(36)}.${variable}`, variable, changedAt, status: "active", updatedAt: now };
  out.profileChanges = [experiment, ...(out.profileChanges ?? [])].slice(0, PROFILE_CHANGES_MAX);
  return { store: out, experiment };
}

/** The user changed MORE than one thing — the single-variable design is void, and saying so is
 *  the honest outcome. The record is kept (not deleted) so history shows why there is no read. */
export function invalidateProfileChange(store: GrowthStore, id: string, note: string, now: number): GrowthStore {
  const out = clone(store);
  const pc = out.profileChanges?.find((p) => p.id === id);
  if (!pc || pc.status === "invalidated") return store;
  pc.status = "invalidated"; pc.invalidatedNote = note; pc.outcome = undefined; pc.updatedAt = now;
  return out;
}

const rate1 = (n: number): string => n.toFixed(1);
const beforeAfter = (label: string, b: number, a: number, n: string): string => `${label}: ${rate1(b)} before → ${rate1(a)} after (✓ measured, ${n})`;

/** The honest before/after read. Pure recompute from the store — no cached verdicts — so a later
 *  follower-history import upgrades a thin read automatically. Never emits a target, a benchmark,
 *  or the word "proof": one uncontrolled variable is correlation, and the copy says so. */
export function readProfileChange(store: GrowthStore, experiment: ProfileChangeExperiment, now: number): ProfileChangeRead {
  const windowMs = PROFILE_CHANGE_WINDOW_DAYS * DAY_MS;
  const before = summarizeGrowthWindow(store, experiment.changedAt - windowMs, experiment.changedAt - 1);
  const after = summarizeGrowthWindow(store, experiment.changedAt, experiment.changedAt + windowMs);
  const elapsedDays = Math.max(0, Math.min(PROFILE_CHANGE_WINDOW_DAYS, Math.floor((now - experiment.changedAt) / DAY_MS)));
  const label = profileChangeLabel(experiment.variable).toLowerCase();
  const base = { before, after, elapsedDays };
  if (experiment.status === "invalidated") {
    return { ...base, state: "invalidated", headline: "Read voided — more than one variable changed", lines: [], caveats: [experiment.invalidatedNote || "A second change landed inside the window, so no before/after can be attributed to either one. Log the next change on its own."] };
  }
  if (before.observedDays < PROFILE_CHANGE_MIN_OBSERVED_DAYS) {
    return { ...base, state: "unreadable", headline: `Baseline too thin — ${before.observedDays} of ${PROFILE_CHANGE_WINDOW_DAYS} pre-change days observed (needs ≥${PROFILE_CHANGE_MIN_OBSERVED_DAYS})`, lines: [], caveats: ["Goobi can't reconstruct days it didn't observe. Opening the dock on x.com imports any follower history already logged; otherwise, keep it open daily and log the NEXT change instead."] };
  }
  const windowOver = now >= experiment.changedAt + windowMs;
  if (!windowOver || after.observedDays < PROFILE_CHANGE_MIN_OBSERVED_DAYS) {
    if (windowOver) {
      return { ...base, state: "unreadable", headline: `After-window too thin — ${after.observedDays} of ${PROFILE_CHANGE_WINDOW_DAYS} post-change days observed (needs ≥${PROFILE_CHANGE_MIN_OBSERVED_DAYS})`, lines: [], caveats: ["The window ended before enough days were observed. No read is better than a guessed one — log the next change and keep Goobi open daily."] };
    }
    return { ...base, state: "collecting", headline: `Still collecting — day ${Math.min(PROFILE_CHANGE_WINDOW_DAYS, elapsedDays + 1)} of ${PROFILE_CHANGE_WINDOW_DAYS} · ${after.observedDays} post-change day${after.observedDays === 1 ? "" : "s"} observed (needs ≥${PROFILE_CHANGE_MIN_OBSERVED_DAYS})`, lines: [], caveats: ["No numbers until the window fills — a partial read would just be a guess with digits."] };
  }
  const lines: string[] = [];
  if (before.followerPerDay != null && after.followerPerDay != null) {
    lines.push(beforeAfter("followers/day", before.followerPerDay, after.followerPerDay, `n=${before.observedDays}d / ${after.observedDays}d observed`));
  }
  if (before.measuredPosts >= 2 && after.measuredPosts >= 2 && before.viewsPerPost != null && after.viewsPerPost != null) {
    lines.push(beforeAfter("views/post", before.viewsPerPost, after.viewsPerPost, `n=${before.measuredPosts} / ${after.measuredPosts} posts`));
  }
  if (before.posts >= 2 && after.posts >= 2 && before.engagementPerPost != null && after.engagementPerPost != null) {
    lines.push(beforeAfter("eng/post", before.engagementPerPost, after.engagementPerPost, `n=${before.posts} / ${after.posts} posts`));
  }
  const caveats = [
    `One uncontrolled variable (the ${label}) — correlation, not causation. Ambient timeline shifts land in this read too.`,
    "Profile visits aren't exposed to the extension, so there is no conversion rate here — follower co-movement is the honest stand-in.",
  ];
  const overlappingBet = store.experiments.find((e) => e.startedAt <= experiment.changedAt + windowMs && (e.endedAt ?? e.endsAt) >= experiment.changedAt - windowMs);
  if (overlappingBet) caveats.push(`A content-strategy test (${growthStrategy(overlappingBet.strategyId).label}) overlapped this window — another moving part in the same read.`);
  return { ...base, state: "read", headline: lines[0] ? `Read after the ${label} change — ${lines[0].split(" (")[0]}` : `Window complete, but no comparable metric settled on both sides`, lines, caveats };
}

/** Freeze finished windows so the record outlives the 90-day day-row pruning. Collecting stays
 *  active; a thin window completes as "unreadable" — an honest terminal state, not a guess. */
export function settleProfileChanges(store: GrowthStore, now: number): { store: GrowthStore; settled: number } {
  const out = clone(store); let settled = 0;
  for (const pc of out.profileChanges ?? []) {
    if (pc.status !== "active" || now < pc.changedAt + PROFILE_CHANGE_WINDOW_DAYS * DAY_MS) continue;
    const read = readProfileChange(out, pc, now);
    if (read.state === "collecting") continue; // never freezes: windowOver forces read or unreadable
    pc.status = "completed"; pc.outcome = read; pc.updatedAt = now;
    settled++;
  }
  return settled ? { store: out, settled } : { store, settled: 0 };
}
