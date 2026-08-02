/**
 * Cost + budget policy for the Twttr X-data API. Search/timeline responses are
 * materially larger than /user, so expensive classes are throttled first as the
 * local safety envelope fills. RapidAPI plan quotas are subscription-specific:
 * the governor folds its observed quota headers into the same gate instead of
 * presenting these local fallback ceilings as provider guarantees.
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
  BYTES: 8 * 1024 * 1024 * 1024, // conservative local UTC-month transfer envelope; billing-cycle dashboard remains authoritative
  REQUESTS: 80_000,              // conservative local fallback when plan quota headers are unavailable
  CONSERVE: 0.70,
  FROZEN: 0.85,
  LOCKDOWN: 0.95,
  RATE_PER_SEC: 8,               // local smoothing ceiling; provider response headers may impose a tighter window
  FAIL_TTL: 600_000,             // negative-cache a failure for 10 min
} as const;
/** Plan request quotas may be daily or monthly and RapidAPI exposes no universal billing-reset
 * timestamp in these headers. Let one later request re-probe after six hours rather than turning
 * an old near-zero snapshot into a permanent local lockout. */
export const PROVIDER_QUOTA_OBSERVATION_TTL_MS = 6 * 3_600_000;

/** Map a request path to its cost class. Order matters: the more specific
 *  timeline/followers prefixes are checked before the bare "user" prefix. */
/** Persistence TTLs for the cross-session caches (single TTL authority lives HERE, not in the
 *  content script): author reach reuses the followers-class TTL; heavy-hitter engagement
 *  character drifts slowly, so a week. Entries past TTL are pruned on load/persist, never shown. */
export const AUTHOR_REACH_TTL_MS = TWTTR_CLASS.followers.ttl; // 24h
export const HEAVY_HITTER_TTL_MS = 30 * 24 * 3_600_000; // persistent Fresh Reach radar; refreshed by discovery/checks and capped at 200

/** The content script may request only endpoints whose response shape is fixture-tested in this
 * repository. This keeps a compromised page/content-script path from turning the fixed RapidAPI
 * host into an arbitrary endpoint broker. Expand only with a parser, policy test, and live spike. */
export const TWTTR_ALLOWED_PATHS = new Set(["user", "search-v3", "user-replies-v2"]);
export function allowedTwttrPath(path: string): boolean { return TWTTR_ALLOWED_PATHS.has(path.replace(/^\/+/, "").toLowerCase()); }

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

/** Authoritative plan usage when RapidAPI supplies its per-response quota headers. */
export function providerUsedFraction(
  limit: number | undefined,
  remaining: number | undefined,
  observedAt?: number,
  now = Date.now(),
): number {
  if (observedAt != null && now - observedAt >= PROVIDER_QUOTA_OBSERVATION_TTL_MS) return 0;
  if (!Number.isFinite(limit) || !Number.isFinite(remaining) || (limit ?? 0) <= 0) return 0;
  return Math.max(0, Math.min(1, ((limit as number) - (remaining as number)) / (limit as number)));
}

/** RapidAPI documents rate reset as either seconds remaining or a timestamp; Retry-After may also
 * be an HTTP date. Clamp absurd/missing values to a short safe default instead of retrying hot. */
export function providerRetryAt(value: string | null | undefined, now: number, fallbackMs = 60_000): number {
  const raw = (value || "").trim();
  if (raw) {
    const numeric = Number(raw);
    if (Number.isFinite(numeric) && numeric >= 0) {
      if (numeric > 10_000_000_000) return numeric; // epoch milliseconds
      if (numeric > 1_000_000_000) return numeric * 1000; // epoch seconds
      return now + numeric * 1000; // documented seconds remaining
    }
    const date = Date.parse(raw);
    if (Number.isFinite(date) && date > now) return date;
  }
  return now + Math.max(1_000, fallbackMs);
}

/* ---- storage-backed per-resource response cache (the governor's "planned v2") ----
 * A cache HIT costs zero bytes and zero requests, so it is served BEFORE the budget /
 * rate gates — even in lockdown. The freshness window is the class's own TTL (how fast
 * the underlying data changes), stamped onto the entry at write time so pruning needs no
 * re-classification. Bounded by total bytes (search/timeline blobs are ~350KB) with
 * oldest-first eviction, so the cache can never grow past the local-storage quota.
 * Pure + unit-tested here (scripts/test-twttr-cache.mjs); the IO lives in the governor. */
export interface CacheEntry { at: number; exp: number; bytes: number; data: unknown; }
export type TwttrCache = Record<string, CacheEntry>;
export const TWTTR_CACHE_MAX_BYTES = 6 * 1024 * 1024; // enough for one 15-search deep hunt at observed estimates, still below Chrome's default local quota
export const TWTTR_CACHE_MAX_ENTRY = 1024 * 1024;     // never cache a single response bigger than this (defensive; no real response is)

/** Expiry stamp for a freshly-fetched response of the given class. */
export function cacheExpiry(cls: TwttrClass, now: number): number { return now + TWTTR_CLASS[cls].ttl; }

/** A still-fresh entry (within its class TTL). Undefined / expired → not fresh. */
export function cacheFresh(e: CacheEntry | undefined, now: number): boolean { return !!e && now < e.exp; }

/** Drop expired entries, then evict oldest-by-write until under the byte cap. Pure — returns a
 *  NEW object, never mutates the input. Keeps the freshest working set within `maxBytes`. */
export function pruneCache(cache: TwttrCache, now: number, maxBytes = TWTTR_CACHE_MAX_BYTES): TwttrCache {
  const live = Object.entries(cache).filter(([, e]) => e && now < e.exp);
  let total = live.reduce((a, [, e]) => a + (e.bytes || 0), 0);
  if (total > maxBytes) {
    live.sort((a, b) => a[1].at - b[1].at); // oldest first
    while (total > maxBytes && live.length) { total -= live.shift()![1].bytes || 0; }
  }
  const out: TwttrCache = {};
  for (const [k, e] of live) out[k] = e;
  return out;
}
