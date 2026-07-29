/**
 * Pure logic for the "Target accounts" mode — comment early on large, in-reach niche accounts
 * to borrow their audience. No chrome/DOM; unit-tested (scripts/test-targets.mjs). x-copilot
 * owns the persistence, the (budgeted) fetches, and the dock surface.
 *
 * Research-grounded: the win is from REACHABLE accounts (~2-25× your size, size-scaled ceiling via
 * bandHiFor, not untouchable megas) replied to EARLY (first ~15-30 min earns the most visibility) with a reply that adds
 * real value. TWO SEPARATE failure modes, don't conflate them: (1) the membership gate excludes megas
 * because of VISIBILITY DILUTION — under a mega-thread your reply is 1-of-thousands no matter how
 * early you are, so the borrowed audience per reply collapses; this is a function of the target's
 * SIZE + reply pile-up, not of your reply. (2) The empty-praise guard handles the other risk — a
 * spammy/low-value reply that readers mute/block/report (≈ -74 in the 2023 open-source ranker, a
 * directional prior; the live 2026 Grok ranker is undisclosed). That penalty is a function of YOUR
 * reply's QUALITY, independent of how big the target is — so it does NOT justify the size gate (it's
 * why the empty-praise guard exists). The freshness window, the size gate, and the empty-praise guard
 * each address a distinct mechanism.
 */

export const TARGET_CAP = 20;                  // research's "10-20 home accounts"
export const TARGET_BAND = { lo: 2, hi: 25 };  // followers/myFollowers — the research reach sweet-spot (5-25×); 2× is the floor, 25× the "heavy hitter, still reachable if you're early" ceiling
// The band's LOWER bound is now code-justified, not just a heuristic: X's TaskReplyRankingFilter
// (grox/tasks/task_filters.py) only LLM-grades replies whose ancestor author exceeds a follower
// threshold — below it the reply is dropped `low_blast_radius` (never graded, ~no OON placement).
// The threshold NUMBER is runtime-injected (private), and it keys on the TARGET's follower count,
// not yours. Aiming at bigger-than-you accounts is literally aiming at the surface X grades.
export const MEGA_CAP = 500_000;               // an absolute "this is a mega-account, your reply is 1-of-thousands no matter how early" cut — binds for big users whose 25× would still be huge

export interface Target { handle: string; followers?: number; addedAt: number; source: "auto" | "manual"; lastPolledAt?: number; lastFreshPostId?: string; }
export interface TargetStore { handle: string; targets: Target[]; } // handle = owning user; reset on account switch

const norm = (h: string): string => (h || "").replace(/^@+/, "").trim().toLowerCase();

/** The relative-reach ceiling, scaled by user size. Smaller accounts get a tighter practical
 * opportunity band because very large audience gaps tend to come with much denser competition. */
export function bandHiFor(myFollowers: number): number {
  if (myFollowers < 1000) return 10;   // sub-1K: stay close, the reach-gap penalty bites hardest here
  if (myFollowers < 10000) return 18;
  return TARGET_BAND.hi;               // 25× — established accounts can reach the top of the sweet-spot
}
/** HARD membership gate: an untouchable mega-account (or one we can't classify) doesn't belong on
 *  the list at all — separate from ranking. Run at add time AND re-checked on refresh. */
export function excludeFromTargets(followers: number | undefined, myFollowers: number): boolean {
  if (!myFollowers || !followers) return true; // can't classify → don't add
  const ratio = followers / myFollowers;
  return ratio > bandHiFor(myFollowers) || followers > MEGA_CAP; // too big RELATIVE to you (size-scaled), or an absolute mega
}
/** Big enough to matter, small enough to reach. */
export function inReachBand(followers: number | undefined, myFollowers: number): boolean {
  if (!myFollowers || !followers) return false;
  return followers / myFollowers >= TARGET_BAND.lo && !excludeFromTargets(followers, myFollowers);
}
/** "7× your size" — only when meaningfully bigger. */
export function reachMultipleLabel(followers: number | undefined, myFollowers: number): string | null {
  if (!myFollowers || !followers) return null;
  const r = followers / myFollowers;
  if (r < 1.5) return null;
  return `${r >= 10 ? Math.round(r) : r.toFixed(1)}× your size`;
}

export function freshStore(handle: string): TargetStore { return { handle, targets: [] }; }
/** Add a target: dedupe by handle, cap, newest first. Returns a NEW store, or an error reason. */
export function addTarget(store: TargetStore, handle: string, followers: number | undefined, source: "auto" | "manual", now: number): { store: TargetStore; error?: string } {
  const h = norm(handle);
  if (!h) return { store, error: "Enter a handle." };
  if (store.targets.some((t) => norm(t.handle) === h)) return { store, error: "Already tracking that account." };
  if (store.targets.length >= TARGET_CAP) return { store, error: `Tracking the max ${TARGET_CAP} accounts — remove one first.` };
  return { store: { ...store, targets: [{ handle: h, followers, addedAt: now, source }, ...store.targets] } };
}
export function removeTarget(store: TargetStore, handle: string): TargetStore {
  const h = norm(handle);
  return { ...store, targets: store.targets.filter((t) => norm(t.handle) !== h) };
}

/** The early-comment window (mirrors the on-page freshnessFactor curve). `live` = still inside it. */
export function freshnessLabel(postedAt: number | undefined, now: number): { live: boolean; text: string } | null {
  if (!postedAt) return null;
  const mins = Math.max(0, Math.round((now - postedAt) / 60_000));
  if (mins <= 30) return { live: true, text: `${mins}m old · reply while it's live` };
  if (mins < 60) return { live: false, text: `${mins}m old` };
  const h = Math.round(mins / 60);
  return { live: false, text: h < 24 ? `${h}h old` : `${Math.round(h / 24)}d old` };
}

// "Jump on it EARLY": only the first handful of replies under a post get meaningful visibility
// (research prior: roughly the first 5-10; later ones collapse under "Show more replies"). The
// fetched target post already carries its reply count, so this competition read is FREE and
// MEASURED — no extra API call. Thresholds are conservative priors, not live platform math.
export const EARLY_MAX_REPLIES = 5;    // ≤5 replies and still live → you'd be near the top
export const CROWDED_MIN_REPLIES = 30; // ≥30 → you'd be buried regardless of freshness
/** The pile-up read for a fetched target post. Unknown count → null (say nothing, honest-mirror).
 *  "crowded" applies at any age; "early" only while the post is still in the live window. */
export function earlyLabel(replies: number | undefined, postedAt: number | undefined, now: number): { level: "early" | "crowded"; text: string } | null {
  if (replies == null) return null;
  if (replies >= CROWDED_MIN_REPLIES) return { level: "crowded", text: `${replies} replies already — you'd be buried. Quote it with your own take instead (a quote-post is your authored candidate in your followers' feeds, not reply #${replies + 1}), or wait for their next post` };
  if (freshnessLabel(postedAt, now)?.live === true && replies <= EARLY_MAX_REPLIES) {
    return { level: "early", text: `only ${replies} ${replies === 1 ? "reply" : "replies"} so far — you'd be near the top` };
  }
  return null;
}

/** Thread-room heuristic keyed to the same early/crowded thresholds as earlyLabel.
 * It is an opportunity-cost prior, not a probability from X. The current open-source
 * DedupConversationFilter removes duplicate conversation branches in a viewer's feed; it does
 * not establish one universal reply slot. Unknown count is usable but never gets the best value. */
export function slotOdds(replies: number | undefined): number {
  if (replies == null) return 0.65;
  if (replies <= EARLY_MAX_REPLIES) return 1;
  if (replies < CROWDED_MIN_REPLIES) return 0.7; // 6..29 — contested
  if (replies < 100) return 0.45;
  return 0.3;
}

// Poll-batch invariant for the ambient fresh-post poller (LIVE as of 2026-07, per-handle path —
// a spike proved the provider ignores batched "OR from:" queries): ≤N polls per kick, 12-min
// per-target TTL persisted on the target itself, so remounts/second tabs never re-pay.
export const POLLS_PER_OPEN = 5;
export const TARGET_POLL_TTL_MS = 12 * 60_000;
export function selectPollBatch(targets: Target[], now: number, max = POLLS_PER_OPEN): Target[] {
  return targets
    .filter((t) => !t.lastPolledAt || now - t.lastPolledAt >= TARGET_POLL_TTL_MS)
    .sort((a, b) => (a.lastPolledAt ?? 0) - (b.lastPolledAt ?? 0))
    .slice(0, max);
}
