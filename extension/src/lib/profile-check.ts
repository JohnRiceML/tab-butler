/**
 * Profile coach — the funnel step nothing else touches. Replies earn the profile CLICK; the
 * profile converts it into the FOLLOW (reply → profile visit → follow; the 2026 pipeline scores
 * follow-author as a first-class action and up-weights in-network content, so converting
 * engagers into followers moves your posts into their guaranteed feed pool). Goobi optimizes
 * the click; this checks the conversion surface with MEASURED facts only:
 *   - the pinned post's rank among your own recent posts by X-reported views (fallback: eng)
 *   - bio presence/thinness (harvested from your own profile page DOM, $0)
 * Honest by construction: no data → no findings (silence, never guesses); every line says what
 * it measured. Pure, unit-tested (scripts/test-profile-check.mjs); x-copilot owns the DOM
 * harvest + render.
 */

export interface OwnPostStat { id: string; text?: string; views?: number; likes?: number; reposts?: number }
export interface ProfileState { pinnedId?: string; bioLen?: number; at: number }
export interface ProfileFinding { level: "act" | "good"; text: string; why: string }

const fmt = (n: number): string => (n < 1000 ? String(n) : n < 1_000_000 ? `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}K` : `${(n / 1_000_000).toFixed(1)}M`);

/** Rankable outcome for a post: X-reported views when present, else likes+reposts. */
const outcome = (p: OwnPostStat): number => p.views ?? ((p.likes ?? 0) + (p.reposts ?? 0));

/** The measured profile findings. `state` comes from the own-profile DOM harvest (undefined =
 *  never visited own profile → say nothing about pinning/bio); `ownStats` from the cached
 *  from:<handle> pull. Needs ≥3 posts with a rankable outcome before it ranks anything. */
export function profileCheck(state: ProfileState | undefined, ownStats: OwnPostStat[]): ProfileFinding[] {
  const findings: ProfileFinding[] = [];
  if (!state) return findings; // no harvest yet — silence, not guesses
  const ranked = ownStats.filter((p) => p.id && outcome(p) > 0).sort((a, b) => outcome(b) - outcome(a));

  // Pinned post vs your measured best
  if (ranked.length >= 3) {
    const top = ranked[0];
    if (!state.pinnedId) {
      findings.push({
        level: "act",
        text: `No pinned post — your top recent post (${fmt(outcome(top))} ${top.views != null ? "views" : "eng"}) is going unpinned.`,
        why: "The profile is where a reply's profile-click converts into a follow; the pinned post is its headline. Measured from your own recent posts.",
      });
    } else {
      const idx = ranked.findIndex((p) => p.id === state.pinnedId);
      if (idx > 2) {
        findings.push({
          level: "act",
          text: `Your pinned post ranks #${idx + 1} of your last ${ranked.length} by ${ranked[0].views != null ? "views" : "engagement"} — your #1 (${fmt(outcome(ranked[0]))}) isn't pinned.`,
          why: "Measured: X-reported results on your own recent posts. A stranger's first read should be your proven best.",
        });
      } else if (idx >= 0) {
        findings.push({ level: "good", text: `Pinned post is a top-${idx + 1} performer of your recent posts ✓`, why: "Measured from your own recent posts." });
      }
      // pinned older than the cached window (idx === -1): say nothing — we can't rank what we can't see
    }
  }

  // Bio presence (harvested length only — content judgment is the user's)
  if (state.bioLen != null) {
    if (state.bioLen === 0) {
      findings.push({ level: "act", text: "Your bio is empty — it's the first thing a profile click reads.", why: "Harvested from your own profile page. Say who you help / what you build; the follow decision happens here." });
    } else if (state.bioLen < 20) {
      findings.push({ level: "act", text: `Your bio is ${state.bioLen} characters — likely too thin to convert a curious stranger.`, why: "Harvested from your own profile page. One concrete line about who you help / what you build beats a fragment." });
    }
  }
  return findings;
}
