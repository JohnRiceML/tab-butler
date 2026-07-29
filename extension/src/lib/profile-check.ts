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
export interface ProfileState {
  /** Account that was actually inspected; prevents profile advice leaking across X accounts. */
  ownerHandle?: string;
  pinnedId?: string;
  pinKnown?: boolean /* a MISSING pin label is only trustworthy on an English UI — false → stay silent on pin claims */;
  bioLen?: number;
  // Profile-v2 conversion checks — booleans only (analyzeBio runs at harvest so the bio TEXT is
  // never stored; presence heuristics, not quality judgments). Unset → say nothing (honest-mirror).
  bioHasRole?: boolean;      // bio names what you do (founder/building/writes/…)
  bioHasAudience?: boolean;  // bio names who it's for (for founders / helps devs / …)
  bioHasProof?: boolean;     // bio carries a concrete number/metric (followers, $, shipped, →)
  bioHasPromise?: boolean;   // bio promises repeatable future content (documenting / weekly / sharing how…)
  nameDescriptive?: boolean; // display name carries a descriptor, not just the @handle
  hasBanner?: boolean;       // a profile banner image is set
  at: number;
}
export interface ProfileFinding { level: "act" | "good"; text: string; why: string }

/** Presence heuristics for the bio "what you do / who it's for / proof" formula. Pure so it's
 *  unit-tested; x-copilot runs it on the harvested bio text and stores ONLY the booleans (the text
 *  stays on the page). Deliberately generous — a false "has proof" is safer than nagging a good bio. */
export function analyzeBio(text: string): { hasRole: boolean; hasAudience: boolean; hasProof: boolean; hasPromise: boolean } {
  const t = (text || "").toLowerCase();
  const hasRole = /\b(found(?:er|ing)|co-?founder|ceo|cto|building|builder|build|maker|indie|creator|writer|writes|engineer|developer|dev|designer|coach|consultant|investor|advisor|host|author|making|teaching|i (?:help|build|write|teach|ship|make))\b/.test(t);
  const hasAudience = /\bfor [a-z]+|help(?:ing)? [a-z]+|teach(?:ing)? [a-z]+|\b(founders|developers|devs|makers|creators|marketers|designers|startups|teams|writers|coaches|engineers|solopreneurs)\b/.test(t);
  const hasProof = /\d/.test(t) || /[$€£%]|→|\b(mrr|arr|users?|customers?|subscribers?|followers?|shipped|launched|raised|acquired|exits?|bootstrapp?ed)\b/.test(t);
  // A follow is a subscription to FUTURE content — a repeatable promise ("documenting the road to
  // $50k MRR", "weekly teardowns") tells the visitor what they're subscribing to. follow_author is
  // a first-class scored action in the 2026 ranker, so this is a conversion lever, not vanity.
  const hasPromise = /\b(every (?:week|day|month|mon(?:day)?|tues?(?:day)?|wed(?:nesday)?|thurs?(?:day)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)|weekly|daily|document(?:ing)?|chronicling|building in public|shar(?:e|es|ing) (?:what|how|the|my)|i (?:share|post|write|document|break ?down|teach)|teach(?:es|ing)? [a-z]+ (?:to|how)|tips on|threads?\b|newsletter|breaking down|break(?:down)?s of|lessons? (?:from|learned)|follow (?:for|along)|post(?:s|ing)? about|writ(?:e|es|ing) about|journey (?:to|from)|behind the scenes)\b/.test(t);
  return { hasRole, hasAudience, hasProof, hasPromise };
}

const fmt = (n: number): string => (n < 1000 ? String(n) : n < 1_000_000 ? `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}K` : `${(n / 1_000_000).toFixed(1)}M`);

/** The measured profile findings. `state` comes from the own-profile DOM harvest (undefined =
 *  never visited own profile → say nothing about pinning/bio); `ownStats` from the cached
 *  from:<handle> pull. Needs ≥3 posts with a rankable outcome before it ranks anything.
 *  ONE metric per ranking (views only when every rankable post has them, else engagement) —
 *  never mixed scales in a single sort. */
export function profileCheck(state: ProfileState | undefined, ownStats: OwnPostStat[]): ProfileFinding[] {
  const findings: ProfileFinding[] = [];
  if (!state) return findings; // no harvest yet — silence, not guesses
  const candidates = ownStats.filter((p) => p.id);
  const useViews = candidates.length > 0 && candidates.every((p) => p.views != null && p.views > 0);
  const outcome = (p: OwnPostStat): number => (useViews ? (p.views ?? 0) : (p.likes ?? 0) + (p.reposts ?? 0));
  const ranked = candidates.filter((p) => outcome(p) > 0).sort((a, b) => outcome(b) - outcome(a));

  // Pinned post vs your measured best — the NEGATIVE claim ("no pin") additionally requires
  // pinKnown (a missing pin label is only trustworthy on an English UI; honest-mirror).
  if (ranked.length >= 3) {
    const top = ranked[0];
    if (!state.pinnedId) {
      if (!state.pinKnown) return finishBio(state, findings); // can't trust the absence → silence on pins
      findings.push({
        level: "act",
        text: `No pinned post — your top recent post (${fmt(outcome(top))} ${useViews ? "views" : "eng"}) is going unpinned.`,
        why: "The profile is where a reply's profile-click converts into a follow; the pinned post is its headline. Measured from your own recent posts.",
      });
    } else {
      const idx = ranked.findIndex((p) => p.id === state.pinnedId);
      if (idx > 2) {
        findings.push({
          level: "act",
          text: `Your pinned post ranks #${idx + 1} of your last ${ranked.length} by ${useViews ? "views" : "engagement"} — your #1 (${fmt(outcome(ranked[0]))}) isn't pinned.`,
          why: "Measured: X-reported results on your own recent posts. A stranger's first read should be your proven best.",
        });
      } else if (idx >= 0) {
        findings.push({ level: "good", text: `Pinned post is a top-${idx + 1} performer of your recent posts ✓`, why: "Measured from your own recent posts." });
      }
      // pinned older than the cached window (idx === -1): say nothing — we can't rank what we can't see
    }
  }

  return finishBio(state, findings);
}

/** Bio + name + banner — the rest of the conversion surface. Empty/thin bio is the whole message
 *  (fix that first); a healthy bio then gets the "what/who/proof" formula scan; name + banner are
 *  independent quick wins. All presence-level, each labeled as a scan, not a quality judgment. */
function finishBio(state: ProfileState, findings: ProfileFinding[]): ProfileFinding[] {
  if (state.bioLen != null) {
    if (state.bioLen === 0) {
      findings.push({ level: "act", text: "Your bio is empty — it's the first thing a profile click reads.", why: "Harvested from your own profile page. Say who you help / what you build; the follow decision happens here." });
      return findings; // empty bio is the priority — don't pile on
    }
    if (state.bioLen < 20) {
      findings.push({ level: "act", text: `Your bio is ${state.bioLen} characters — likely too thin to convert a curious stranger.`, why: "Harvested from your own profile page. One concrete line about who you help / what you build beats a fragment." });
      return findings;
    }
    // healthy length — one nudge at a time, in leverage order: PROOF (what tips the skeptic) →
    // WHO/WHAT (a bio that never says what you do or for whom can't convert) → PROMISE (a follow
    // subscribes to future content — but only nag for it once who/what/proof is complete; a
    // static-authority bio missing its basics needs those first, not a content-cadence nag).
    if (state.bioHasProof === false) {
      findings.push({ level: "act", text: "Your bio has no concrete proof — a number (followers, $, shipped X) is what tips a skeptical visitor into a follow.", why: "A quick scan of your bio, not a judgment. profile_click → follow is a first-class ranked action; proof is what converts the click." });
    } else if (state.bioHasRole === false || state.bioHasAudience === false) {
      findings.push({ level: "act", text: state.bioHasRole === false ? "Your bio doesn't say what you DO — lead with it (\"building X\", \"founder of Y\"). A visitor can't follow a mystery." : "Your bio doesn't say who it's FOR — name the audience (\"for founders\", \"helping devs ship\"). Fit is what turns a click into a follow.", why: "A quick scan of your bio for the what/who/proof formula. The role and audience lines are the frame the proof hangs on." });
    } else if (state.bioHasRole && state.bioHasAudience && state.bioHasPromise === false) {
      findings.push({ level: "act", text: "Your bio doesn't promise what a follower GETS — add the repeatable thing you share (\"documenting the road to $50k MRR\", \"weekly product teardowns\").", why: "A quick scan of your bio. A follow is a subscription to your future posts; follow-author is a scored action, and the visitor decides on what you PROMISE, not just what you've done." });
    } else if (state.bioHasRole && state.bioHasAudience && state.bioHasProof) {
      findings.push({ level: "good", text: "Bio covers what you do, who it's for, and proof ✓", why: "A quick scan of your bio for the standard convert-a-stranger formula." });
    }
  }
  // name + banner — independent of the bio, only when we actually harvested them (undefined = silent)
  if (state.nameDescriptive === false) {
    findings.push({ level: "act", text: "Your display name is just your handle — add a short descriptor (e.g. \"Jo · building X\"). It's searchable and it frames every reply.", why: "Harvested from your profile. The name shows on every reply you leave — it's free real estate at the top of the funnel." });
  }
  if (state.hasBanner === false) {
    findings.push({ level: "act", text: "No banner image — it's the biggest empty space on the profile a click lands on.", why: "Harvested from your profile. A banner with your product/result is proof-at-a-glance on the conversion surface." });
  }
  return findings;
}
