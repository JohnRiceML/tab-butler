/**
 * Account-level growth experiments.
 *
 * The lower-level systems optimize replies, posts, targets, and DMs. This module remembers the
 * strategic bet that connected them, compares the bet's window with the immediately preceding
 * window, and recommends keep / tighten / switch. It never claims profile-click attribution:
 * X does not expose that event here, so follower and post outcomes are reported as co-movement.
 */

export const GROWTH_WINDOW_DAYS = 14;
export const GROWTH_KEEP_DAYS = 90;
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
  followerStart?: number; followerEnd?: number; followerDelta?: number; followerPerDay?: number;
  posts: number; measuredPosts: number; views: number; engagement: number; viewsPerPost?: number; engagementPerPost?: number;
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
export interface GrowthStore { version: 1; ownerHandle: string; days: Record<string, GrowthDay>; experiments: GrowthExperiment[]; }
export interface TaggedGrowthAction { at: number; experimentId?: string; strategyId?: GrowthStrategyId; kind: "post" | "reply"; confirmed?: boolean; }

const norm = (s: string): string => (s || "").trim().replace(/^@+/, "").toLowerCase();
const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const maxMetric = (a: number | undefined, b: number | undefined): number | undefined => {
  if (!finite(a) && !finite(b)) return undefined;
  return Math.max(finite(a) ? a : 0, finite(b) ? b : 0);
};
const clone = (s: GrowthStore): GrowthStore => ({ version: 1, ownerHandle: s.ownerHandle, days: Object.fromEntries(Object.entries(s.days).map(([k, d]) => [k, { ...d, posts: { ...d.posts } }])), experiments: s.experiments.map((e) => ({ ...e, outcome: e.outcome ? { ...e.outcome, reasons: [...e.outcome.reasons], current: { ...e.outcome.current }, baseline: { ...e.outcome.baseline } } : undefined })) });

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
  }
  const cut = now - GROWTH_KEEP_DAYS * DAY_MS;
  for (const key of Object.keys(out.days)) if (out.days[key].at < cut) delete out.days[key];
  out.experiments.sort((x, y) => y.startedAt - x.startedAt);
  out.experiments = out.experiments.slice(0, 12);
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
  return {
    startAt, endAt, observedDays: followers.length, followerStart, followerEnd, followerDelta,
    followerPerDay: followerDelta != null && spanDays ? followerDelta / spanDays : undefined,
    posts: posts.length, measuredPosts: measured.length, views, engagement,
    viewsPerPost: measured.length ? views / measured.length : undefined,
    engagementPerPost: posts.length ? engagement / posts.length : undefined,
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
  if (prev === 0) return cur === 0 ? 0 : cur > 0 ? 1 : -1;
  return (cur - prev) / Math.abs(prev);
};

export function evaluateGrowthExperiment(store: GrowthStore, experiment: GrowthExperiment, actions: TaggedGrowthAction[], now: number): GrowthEvaluation {
  const endAt = Math.min(now, experiment.endedAt ?? experiment.endsAt);
  const duration = Math.max(DAY_MS, endAt - experiment.startedAt);
  const current = summarizeGrowthWindow(store, experiment.startedAt, endAt);
  const baseline = summarizeGrowthWindow(store, experiment.startedAt - duration, experiment.startedAt - 1);
  const tagged = actions.filter((a) => a.experimentId === experiment.id && a.at >= experiment.startedAt && a.at <= endAt);
  const taggedPosts = tagged.filter((a) => a.kind === "post").length;
  const taggedReplies = tagged.filter((a) => a.kind === "reply" && a.confirmed !== false).length;
  const elapsedDays = duration / DAY_MS;
  const followerChange = current.observedDays >= 2 && baseline.observedDays >= 2 ? ratioChange(current.followerPerDay, baseline.followerPerDay) : undefined;
  const viewsChange = current.measuredPosts >= 2 && baseline.measuredPosts >= 2 ? ratioChange(current.viewsPerPost, baseline.viewsPerPost) : undefined;
  const engagementChange = current.posts >= 2 && baseline.posts >= 2 ? ratioChange(current.engagementPerPost, baseline.engagementPerPost) : undefined;
  const comparable = [followerChange, viewsChange, engagementChange].filter((v): v is number => v != null);
  // A strategy cannot "win" from ambient account movement alone. We need enough work that Goobi
  // can prove was created during this bet before issuing a directional verdict.
  const executionReady = taggedPosts >= 2 || taggedReplies >= 8 || (taggedPosts >= 1 && taggedReplies >= 3);
  const ready = elapsedDays >= 7 && comparable.length > 0 && executionReady;
  const reasons: string[] = [];
  if (followerChange != null) reasons.push(`${followerChange >= 0 ? "+" : ""}${Math.round(followerChange * 100)}% follower pace vs the prior window`);
  if (viewsChange != null) reasons.push(`${viewsChange >= 0 ? "+" : ""}${Math.round(viewsChange * 100)}% views per measured post`);
  if (engagementChange != null) reasons.push(`${engagementChange >= 0 ? "+" : ""}${Math.round(engagementChange * 100)}% engagement per post`);
  if (!ready) {
    if (!executionReady) reasons.unshift(`Execution recorded: ${taggedPosts} on-strategy post${taggedPosts === 1 ? "" : "s"} · ${taggedReplies} confirmed repl${taggedReplies === 1 ? "y" : "ies"}. Need 2 posts, 8 replies, or 1 post + 3 replies.`);
    const headline = elapsedDays < 7
      ? "Keep collecting — the window is still young"
      : !executionReady
        ? "Do enough on-strategy work before judging the bet"
        : "Not enough comparable data yet";
    return { ready: false, executionReady, decision: "collect", headline, reasons: reasons.length ? reasons : ["Open Goobi across several days so follower and post snapshots can settle."], current, baseline, nextStrategyId: experiment.strategyId, taggedPosts, taggedReplies };
  }
  let votes = 0;
  for (const v of comparable) { if (v >= 0.2) votes++; else if (v <= -0.2) votes--; }
  let decision: GrowthDecision;
  if (votes >= 2 || (votes >= 1 && (followerChange ?? 0) > 0)) decision = "double-down";
  else if (votes <= -1 || (comparable.every((v) => Math.abs(v) < 0.1) && endAt >= experiment.endsAt)) decision = "switch";
  else decision = "tighten";
  const nextStrategyId = decision === "switch" ? nextUntried(store, experiment.strategyId) : experiment.strategyId;
  const headline = decision === "double-down" ? "This bet is promising — run it again" : decision === "switch" ? "Shake it up — test a different reason to follow" : "Mixed signal — keep the strategy, change one execution lever";
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
