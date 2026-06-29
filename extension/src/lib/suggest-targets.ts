/**
 * Pure ranking for AUTO-SUGGESTED target accounts (the "Suggested for you" list in the Targets
 * mode). No DOM/chrome/fetch; unit-tested (scripts/test-suggest-targets.mjs). x-copilot gates the
 * candidates (reuses targets.ts) + computes the inputs, then passes plain data here.
 *
 * Algo-grounded, honest about its limits. Each factor is a multiplier around 1.0 tied to a real
 * X-ranker mechanism; a MISSING signal is held NEUTRAL (1.0) so a candidate is never penalized for
 * data we don't have. The product is a relative SORT KEY (never displayed) — only the honest
 * `suggestionReason` shows. Tier A (free) sees only `followers` (+ our own `learnedMult`); the
 * other factors fill in via the deferred, budgeted Tier-B enrichment.
 *
 * Honest caveats (carried into the UI copy): the live 2026 ranker is Grok-internal + undisclosed —
 * these weights are a reasoned PRIOR ordering from the 2023 open-source constants (reply » dwell »
 * profile-click » retweet » like; reply_engaged_by_author the largest +head), NOT the platform's
 * live math. `learnedMult` is the only signal measured on our own data.
 */

export interface SuggestionInput { handle: string; followers: number; following?: number; bioTier?: number; engRate?: number; learnedMult?: number; }
export interface Suggestion extends SuggestionInput { score: number; }

const PRIOR_ENG = 0.02; // ~2% engagement-rate (eng/followers) anchor — a fixed prior for cold-start normalization
const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

/** Relative sort key. Multiplicative; missing factors = 1.0 (neutral, never a penalty). */
export function suggestionScore(c: SuggestionInput, myFollowers: number): number {
  const ratio = myFollowers > 0 && c.followers > 0 ? c.followers / myFollowers : 0;
  const reachFit = ratio >= 5 ? 1.08 : 1.0;                                              // sweet-spot: big enough to bridge out-of-network, not a 1-of-thousands mega
  let openness = 1.0;                                                                    // proxy for the +75 reply_engaged_by_author head (the single biggest positive weight)
  if (c.following != null && c.followers > 0) { const ff = c.following / c.followers; openness = ff >= 0.8 ? 1.08 : ff >= 0.3 ? 1.04 : ff >= 0.08 ? 1.0 : 0.92; }
  const nicheMatch = c.bioTier === 2 ? 1.2 : c.bioTier === 1 ? 1.1 : 1.0;                // bio-keyword proxy for audience overlap (true mutual-follow jaccard isn't fetchable)
  let engNorm = 1.0;                                                                     // the heavy ranker scores predicted engagement PER POST — follower count barely matters per-tweet
  if (c.engRate != null) engNorm = clamp(1 + 0.28 * Math.log10((c.engRate + 1e-4) / PRIOR_ENG), 0.75, 1.25);
  return reachFit * openness * nicheMatch * engNorm * (c.learnedMult ?? 1.0);
}

export function rankSuggestions(candidates: SuggestionInput[], myFollowers: number, dismissed: Set<string>, max = 5): Suggestion[] {
  return candidates
    .filter((c) => !dismissed.has(c.handle.toLowerCase()))
    .map((c) => ({ ...c, score: suggestionScore(c, myFollowers) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, max);
}

/** Banded size label — cached follower counts age, so never show false precision. */
function sizeBand(followers: number, myFollowers: number): string | null {
  if (!followers || !myFollowers) return null;
  const r = followers / myFollowers;
  if (r < 2) return null;
  const b = r >= 20 ? "20×+" : r >= 10 ? `~${Math.round(r)}×` : `~${Math.round(r * 2) / 2}×`;
  return `${b} your size`;
}

/** Honest "why this account" — at most a few clauses, each gated on a value we actually hold.
 *  Openness describes the follow-graph SHAPE ("two-way account"), NEVER inferred reply behavior
 *  ("replies to people") — a high follow-back is just as often growth-farming. */
export function suggestionReason(c: SuggestionInput, myFollowers: number): string {
  const parts: string[] = [];
  const sz = sizeBand(c.followers, myFollowers); if (sz) parts.push(sz);
  if (c.bioTier === 2) parts.push("in your niche");
  if (c.engRate != null && c.engRate >= PRIOR_ENG * 1.5) parts.push("high engagement for its size");
  if (c.following != null && c.followers > 0 && c.following / c.followers >= 0.5) parts.push("a two-way account");
  if (c.learnedMult != null && c.learnedMult > 1.05) parts.push("✓ your replies here have done well");
  return parts.join(" · ") || "in reach";
}
