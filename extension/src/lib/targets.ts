/**
 * Pure logic for the "Target accounts" mode — comment early on large, in-reach niche accounts
 * to borrow their audience. No chrome/DOM; unit-tested (scripts/test-targets.mjs). x-copilot
 * owns the persistence, the (budgeted) fetches, and the dock surface.
 *
 * Research-grounded: the win is from REACHABLE accounts (~2-10× your size, not untouchable
 * megas) replied to EARLY (first ~15-30 min earns the most visibility) with a reply that adds
 * real value. The spam version backfires hard — in the 2023 open-source ranker a mute/block/report
 * weighed roughly -74 (≈148× a +1 like) (the live 2026 Grok ranker is undisclosed, so treat this as
 * a directional prior, not a live coefficient), so annoying the big account SHRINKS your reach. Hence the membership gate
 * (no megas), the freshness window, and the empty-praise guard live alongside this.
 */

export const TARGET_CAP = 20;                  // research's "10-20 home accounts"
export const TARGET_BAND = { lo: 2, hi: 12 };  // followers/myFollowers sweet spot for the LIST (2-10× + slack)
export const ABS_CEILING_BASE = 60_000;        // small users: a "big but reachable" account is still well under this

export interface Target { handle: string; followers?: number; addedAt: number; source: "auto" | "manual"; lastPolledAt?: number; lastFreshPostId?: string; }
export interface TargetStore { handle: string; targets: Target[]; } // handle = owning user; reset on account switch

const norm = (h: string): string => (h || "").replace(/^@+/, "").trim().toLowerCase();

/** HARD membership gate: an untouchable mega-account (or one we can't classify) doesn't belong on
 *  the list at all — separate from ranking. Run at add time AND re-checked on refresh. */
export function excludeFromTargets(followers: number | undefined, myFollowers: number): boolean {
  if (!myFollowers || !followers) return true; // can't classify → don't add
  const ratio = followers / myFollowers;
  const ceiling = Math.max(ABS_CEILING_BASE, myFollowers * TARGET_BAND.hi);
  return ratio > TARGET_BAND.hi || followers > ceiling;
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

// Poll-batch primitive for a future ambient fresh-post poller — the ≤N/open + TTL invariant,
// tested now so the eventual poller can't blow the budget (one full list ≤ POLLS_PER_OPEN calls).
export const POLLS_PER_OPEN = 5;
export const TARGET_POLL_TTL_MS = 12 * 60_000;
export function selectPollBatch(targets: Target[], now: number, max = POLLS_PER_OPEN): Target[] {
  return targets
    .filter((t) => !t.lastPolledAt || now - t.lastPolledAt >= TARGET_POLL_TTL_MS)
    .sort((a, b) => (a.lastPolledAt ?? 0) - (b.lastPolledAt ?? 0))
    .slice(0, max);
}
