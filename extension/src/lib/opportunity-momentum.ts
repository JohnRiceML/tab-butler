/**
 * Measured momentum for public X posts. Two RapidAPI observations of the SAME tweet
 * become a short-lived velocity signal used only as a mild ranking lift. Reply growth
 * is deliberately excluded: it is competition and is already handled by the thread-room heuristic.
 * Pure + storage-shape-safe; x-copilot owns persistence and provider I/O.
 */

const MIN_INTERVAL_MS = 5 * 60_000;
const MAX_INTERVAL_MS = 2 * 3_600_000;
const SIGNAL_TTL_MS = 20 * 60_000;
const TRACK_TTL_MS = 48 * 3_600_000;
export const TRACK_CAP = 300;
export const MOMENTUM_MAX_LIFT = 0.12;
export const TARGET_TIME_BONUS_MS = 5 * 60_000;

export interface MetricPoint {
  at: number;
  likes?: number;
  replies?: number;
  reposts?: number;
  views?: number;
}
export interface MetricTrack { id: string; postedAt?: number; previous?: MetricPoint; latest: MetricPoint; }
export interface OpportunityMetricStore { version: 1; tracks: Record<string, MetricTrack>; }
export interface ObservedPost { id: string; postedAt?: number; likes?: number; replies?: number; reposts?: number; views?: number; }
export interface MomentumSignal { score: number; viewsPerHour?: number; engagementsPerHour?: number; intervalMs: number; }

export function freshOpportunityMetricStore(): OpportunityMetricStore { return { version: 1, tracks: {} }; }
const clean = (n: unknown): number | undefined => typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
const sameMetrics = (a: MetricPoint, b: MetricPoint): boolean => a.likes === b.likes && a.replies === b.replies && a.reposts === b.reposts && a.views === b.views;

/** Observe a provider result without letting identical cached payloads fabricate a new interval. */
export function observeMany(store: OpportunityMetricStore | undefined, posts: ObservedPost[], observedAt: number): { store: OpportunityMetricStore; changed: boolean } {
  const tracks = { ...(store?.version === 1 ? store.tracks : {}) };
  let changed = false;
  for (const p of posts) {
    const id = String(p.id || "");
    if (!id) continue;
    const ex = tracks[id];
    const incoming: MetricPoint = { at: observedAt, likes: clean(p.likes), replies: clean(p.replies), reposts: clean(p.reposts), views: clean(p.views) };
    if (!ex) { tracks[id] = { id, postedAt: clean(p.postedAt), latest: incoming }; changed = true; continue; }
    if (!Number.isFinite(observedAt) || observedAt <= ex.latest.at) continue;
    const merged: MetricPoint = {
      at: observedAt,
      likes: incoming.likes ?? ex.latest.likes,
      replies: incoming.replies ?? ex.latest.replies,
      reposts: incoming.reposts ?? ex.latest.reposts,
      views: incoming.views ?? ex.latest.views,
    };
    const postedAt = ex.postedAt ?? clean(p.postedAt);
    if (sameMetrics(merged, ex.latest)) {
      if (postedAt !== ex.postedAt) { tracks[id] = { ...ex, postedAt }; changed = true; }
      continue;
    }
    tracks[id] = { id, postedAt, previous: ex.latest, latest: merged };
    changed = true;
  }
  const pruneNow = Math.max(observedAt, ...Object.values(tracks).map((t) => t.latest.at)); // an out-of-order observer cannot prune newer tracks
  const pruned = pruneStore({ version: 1, tracks }, pruneNow);
  if (Object.keys(pruned.tracks).length !== Object.keys(tracks).length) changed = true;
  return { store: pruned, changed };
}

/** Current measured velocity. Missing/stale/invalid comparisons are neutral. */
export function momentumFor(track: MetricTrack | undefined, now: number): MomentumSignal | undefined {
  if (!track?.previous) return undefined;
  const dt = track.latest.at - track.previous.at;
  if (dt < MIN_INTERVAL_MS || dt > MAX_INTERVAL_MS || now - track.latest.at > SIGNAL_TTL_MS || now < track.latest.at) return undefined;
  const hours = dt / 3_600_000;
  let viewsPerHour: number | undefined;
  if (track.latest.views != null && track.previous.views != null) viewsPerHour = Math.max(0, track.latest.views - track.previous.views) / hours;
  let engagementsPerHour: number | undefined;
  const comparableLikes = track.latest.likes != null && track.previous.likes != null;
  const comparableReposts = track.latest.reposts != null && track.previous.reposts != null;
  if (comparableLikes || comparableReposts) {
    const likes = comparableLikes ? Math.max(0, track.latest.likes! - track.previous.likes!) : 0;
    const reposts = comparableReposts ? Math.max(0, track.latest.reposts! - track.previous.reposts!) : 0;
    engagementsPerHour = (likes + 2 * reposts) / hours;
  }
  if (viewsPerHour == null && engagementsPerHour == null) return undefined; // reply-count changes alone never boost momentum
  const viewPace = viewsPerHour == null ? undefined : viewsPerHour / (viewsPerHour + 1000);
  const engPace = engagementsPerHour == null ? undefined : engagementsPerHour / (engagementsPerHour + 20);
  const pace = viewPace != null && engPace != null ? 0.7 * viewPace + 0.3 * engPace : (viewPace ?? engPace ?? 0);
  const confidence = Math.min(1, dt / (12 * 60_000));
  return { score: Math.max(0, Math.min(1, pace * confidence)), viewsPerHour, engagementsPerHour, intervalMs: dt };
}

/** Best-sort only: never changes displayed/recorded fit, eligibility, or other sorts. */
export function applyMomentum(baseScore: number, signal: MomentumSignal | undefined): number {
  return baseScore * (1 + MOMENTUM_MAX_LIFT * (signal?.score ?? 0));
}
/** Target cards remain freshness-first; momentum can make one look at most five minutes fresher. */
export function adjustedTargetTime(postedAt: number | undefined, signal: MomentumSignal | undefined): number {
  return (postedAt ?? 0) + TARGET_TIME_BONUS_MS * (signal?.score ?? 0);
}

export function pruneStore(store: OpportunityMetricStore | undefined, now: number, max = TRACK_CAP): OpportunityMetricStore {
  const live = Object.values(store?.tracks ?? {}).filter((t) => t?.id && t.latest && now - t.latest.at <= TRACK_TTL_MS && now >= t.latest.at);
  live.sort((a, b) => b.latest.at - a.latest.at);
  const tracks: Record<string, MetricTrack> = {};
  for (const t of live.slice(0, max)) tracks[t.id] = t;
  return { version: 1, tracks };
}

/** Cross-tab union. A stale tab may add coverage, but can never replace a newer observation pair. */
export function mergeOpportunityMetricStores(a: OpportunityMetricStore | undefined, b: OpportunityMetricStore | undefined, now: number): OpportunityMetricStore {
  const tracks: Record<string, MetricTrack> = { ...(a?.version === 1 ? a.tracks : {}) };
  for (const [id, incoming] of Object.entries(b?.version === 1 ? b.tracks : {})) {
    if (!incoming?.latest || !Number.isFinite(incoming.latest.at)) continue;
    const current = tracks[id];
    if (!current || incoming.latest.at > current.latest.at || (incoming.latest.at === current.latest.at && !current.previous && !!incoming.previous)) tracks[id] = incoming;
  }
  return pruneStore({ version: 1, tracks }, now);
}
