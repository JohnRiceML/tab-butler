/**
 * Cost + budget policy for the Twttr X-data API. The binding limit is BANDWIDTH,
 * not request count: /user (~10KB) is effectively free (it hits the 100k/mo
 * request wall at only ~1GB), while search/timeline/followers (~300-400KB) are
 * 30-40x costlier per call. So the expensive classes get budget-gated access and
 * are the first to be throttled as the monthly budget fills — /user keeps flowing
 * so the on-page reach ranking never goes dark before the month rolls over.
 *
 * Pure functions only (no chrome / no fetch), so the decision logic is unit-tested
 * in isolation — see scripts/test-policy.mjs. The IO orchestration lives in
 * twttr-governor.ts.
 */

export type TwttrClass = "user" | "tweet" | "comments" | "search" | "timeline" | "followers" | "other";
export type Tier = "cheap" | "med" | "expensive";

export interface ClassPolicy {
  est: number;  // typical response size in bytes (pre-flight affordability estimate)
  ttl: number;  // cache TTL in ms, keyed to how fast the underlying data changes
  tier: Tier;
}

/** Single source of truth for per-class size estimates + TTLs. */
export const TWTTR_CLASS: Record<TwttrClass, ClassPolicy> = {
  user:      { est:  10_240, ttl: 6 * 3_600_000,  tier: "cheap" },     // follower counts drift slowly
  tweet:     { est:  61_440, ttl: 10 * 60_000,    tier: "cheap" },
  comments:  { est: 153_600, ttl:  8 * 60_000,    tier: "med" },
  search:    { est: 358_400, ttl: 12 * 60_000,    tier: "expensive" }, // the rationed lever
  timeline:  { est: 307_200, ttl:  5 * 60_000,    tier: "expensive" },
  followers: { est: 409_600, ttl: 24 * 3_600_000, tier: "expensive" },
  other:     { est:  61_440, ttl:  5 * 60_000,    tier: "med" },
};

export const TWTTR_BUDGET = {
  BYTES: 8 * 1024 * 1024 * 1024, // 8GB working budget (10GB hard cap, 2GB safety margin)
  REQUESTS: 80_000,              // 80% of the 100k/mo request wall
  CONSERVE: 0.70,
  FROZEN: 0.85,
  LOCKDOWN: 0.95,
  RATE_PER_SEC: 8,               // token-bucket refill, under the hard 10/sec
  FAIL_TTL: 600_000,             // negative-cache a failure for 10 min
} as const;

/** Map a request path to its cost class. Order matters: the more specific
 *  timeline/followers prefixes are checked before the bare "user" prefix. */
/** Persistence TTLs for the cross-session caches (single TTL authority lives HERE, not in the
 *  content script): author reach reuses the followers-class TTL; heavy-hitter engagement
 *  character drifts slowly, so a week. Entries past TTL are pruned on load/persist, never shown. */
export const AUTHOR_REACH_TTL_MS = TWTTR_CLASS.followers.ttl; // 24h
export const HEAVY_HITTER_TTL_MS = 7 * 24 * 3_600_000;

export function classForPath(path: string): TwttrClass {
  const p = path.replace(/^\//, "").toLowerCase();
  if (p.startsWith("user-tweets") || p.startsWith("user-replies") || p.startsWith("user-media")) return "timeline";
  if (p.startsWith("user-followers") || p.startsWith("user-following") || p.startsWith("followers") || p.startsWith("followings")) return "followers";
  if (p.startsWith("search")) return "search";
  if (p.startsWith("comments") || p.startsWith("post-comments")) return "comments";
  if (p.startsWith("tweet")) return "tweet";
  if (p.startsWith("user")) return "user";
  return "other";
}

export type DegradeMode = "normal" | "conserve" | "frozen" | "lockdown";

/** The degrade mode for a given fraction of budget consumed (the higher of the
 *  bytes-used and requests-used fractions). */
export function degradeMode(usedFrac: number): DegradeMode {
  if (usedFrac >= TWTTR_BUDGET.LOCKDOWN) return "lockdown";
  if (usedFrac >= TWTTR_BUDGET.FROZEN) return "frozen";
  if (usedFrac >= TWTTR_BUDGET.CONSERVE) return "conserve";
  return "normal";
}

/** Whether a class may make a NETWORK call in the given mode. Cheap classes
 *  (user/tweet) flow until lockdown so on-page ranking never goes dark; expensive
 *  classes are cut first — only on explicit user intent in conserve, never in
 *  frozen, never in lockdown. `intent` = a user-initiated action (Find spots,
 *  Learn my voice) vs an ambient background/scroll lookup. */
export function canFetch(tier: Tier, mode: DegradeMode, intent: boolean): boolean {
  switch (mode) {
    case "lockdown": return false;                                  // cache only
    case "frozen":   return tier === "cheap";                       // expensive + med blocked
    case "conserve": return tier !== "expensive" || intent;         // expensive needs explicit intent
    default:         return true;                                   // normal
  }
}

/** UTC year-month key ("2026-06") for the monthly meter roll, from an epoch ms. */
export function monthKeyOf(ts: number): string {
  return new Date(ts).toISOString().slice(0, 7);
}
