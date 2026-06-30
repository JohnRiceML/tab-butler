/**
 * Pure helpers for the "Post ideas" creator — exemplar quality (what the model is allowed
 * to remix) + honest virality banding. No chrome/DOM/fetch, so it's unit-tested via esbuild
 * data-URL import (scripts/eval-post-ideas.mjs). x-copilot.ts orchestrates pickBest over these.
 *
 * The model can only be as good as the posts it remixes: garbage exemplars (retweets,
 * engagement-bait, non-English, stale evergreen, mega-account floor posts) → generic output.
 * These guards harden the candidate pool before Sonnet ever sees it. The virality band is
 * grounded in the REAL measured rank of the source post we remixed — never a fabricated number.
 */

// ---------- text similarity (idea de-dupe) ----------
export const IDEA_STOP = new Set("a an and the to of in on for is it its i you we my our your they that this with as at be or but so".split(" "));
export function ideaTokens(s: string): Set<string> {
  return new Set((s || "").toLowerCase().replace(/https?:\/\/\S+/g, "").replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !IDEA_STOP.has(w)));
}
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0; for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}
export const TOO_SIMILAR = 0.5;  // ≥50% shared content words = the same post, reworded (output de-dupe)
export const INPUT_DEDUP = 0.6;  // source posts share niche vocab → a stricter bar for "same source post"
export const COPY_LEAK = 0.6;    // a generated idea sharing ≥60% content words with its OWN source = lifted content, not remixed pattern

/** Content overlap between a generated idea and the source post it remixed. High = the model
 *  lifted the source's substance (claim/number/wording) instead of borrowing only its shape —
 *  the core failure mode for a "remix the pattern, never the content" tool. */
export function copyLeak(ideaText: string, sourceText: string): number {
  return jaccard(ideaTokens(ideaText), ideaTokens(sourceText));
}

// ---------- exemplar quality filters ----------
/** Heuristic English guard — works even when the provider omits a lang field. */
export function isEnglish(text: string, lang?: string): boolean {
  if (lang) return lang === "en";
  const nonSpace = (text || "").replace(/\s/g, "");
  if (!nonSpace) return false;
  return (nonSpace.match(/[a-zA-Z]/g) || []).length / nonSpace.length > 0.6;
}
/** A retweet rendered as text ("RT @someone …") — not an original to remix. */
export function looksLikeRT(text: string): boolean { return /^RT @\w/.test((text || "").trim()); }
export const BAIT_RE = /\b(retweet to win|rt to win|rt & follow|rt and follow|like and retweet|drop your|tag a friend|follow me|giveaway|airdrop|free \$|comment .{0,12}below|link in bio)\b/i;
/** Engagement-bait / spam — high engagement for the wrong reason; a poison exemplar. */
export function isBait(text: string): boolean {
  const t = text || "";
  if (BAIT_RE.test(t)) return true;
  const hashtags = (t.match(/#\w+/g) || []).length;
  const cashtags = (t.match(/\$[A-Za-z]{2,6}\b/g) || []).length;
  const mentions = (t.match(/@\w+/g) || []).length;
  const words = t.split(/\s+/).filter(Boolean).length || 1;
  return hashtags > 3 || cashtags > 2 || mentions / words > 0.4;
}

// ---------- shape (for diversity quotas) ----------
export type Shape = "oneLiner" | "list" | "numberLead" | "contrarian" | "story" | "question" | "other";
export function classifyShape(text: string): Shape {
  const t = (text || "").trim();
  if (/^[\s>]*[\d$]/.test(t)) return "numberLead";
  if (/\b(everyone|most people|unpopular|hot take|wrong about|nobody (tells|says))\b/i.test(t)) return "contrarian";
  const lines = t.split(/\n+/).filter(Boolean);
  if (lines.length >= 2 && lines.filter((l) => /^\s*([-*•]|\d+[.)])/.test(l)).length >= 2) return "list";
  const sentences = t.split(/[.!?]+/).filter((s) => s.trim().length > 3);
  if (sentences.length >= 3 && /\bI\b/.test(t)) return "story";
  if (t.endsWith("?")) return "question";
  if (!t.includes("\n") && sentences.length <= 1) return "oneLiner";
  return "other";
}

// ---------- breakout scoring (RANK-only; never shown as an absolute multiple) ----------
/** The "normal" engagement rate (engagement / followers) a post must BEAT, by audience size.
 *  Published 2025-26 X benchmarks: small accounts run ~10× hotter than megas, so a single flat
 *  constant (the old 0.3%) under-divided small accounts and over-credited big ones — making an
 *  ordinary small-account post look like a breakout, the exact opposite of this picker's job.
 *  The tier mid-points below are a PUBLISHED-DATA prior (sub-1k ~3-6%, 100k-500k ~0.5-1.5%, 500k+
 *  ~0.3-1%); `calibrateRates` refines them to the user's OWN niche from posts already fetched. */
export type RateTable = { lt1k: number; lt10k: number; lt100k: number; lt500k: number; mega: number };
export const DEFAULT_RATES: RateTable = { lt1k: 0.04, lt10k: 0.025, lt100k: 0.015, lt500k: 0.01, mega: 0.0065 };
const RATE_MIN = 0.002, RATE_MAX = 0.12; // sane like-rate bounds — a calibrated tier can't go degenerate

// The ACTIVE baseline. Defaults to the published benchmarks; `setRateTable` swaps in a per-niche
// calibration. Module-level so scoreWinner/isBreakout pick it up without threading a param everywhere.
let activeRates: RateTable = DEFAULT_RATES;
export function setRateTable(t: RateTable | null): void { activeRates = t ?? DEFAULT_RATES; }
function tierKey(followers: number): keyof RateTable {
  if (followers < 1_000) return "lt1k";
  if (followers < 10_000) return "lt10k";
  if (followers < 100_000) return "lt100k";
  if (followers < 500_000) return "lt500k";
  return "mega";
}
export function expectedRate(followers: number): number { return activeRates[tierKey(followers)]; }

/** Refine the size-tiered baseline to the user's OWN niche, from posts we already fetched (FREE — no
 *  new API call). Per tier: the MEDIAN like-rate of that tier's posts, but ONLY when the tier holds
 *  ≥ minPerTier samples (a sparse tier keeps the published default rather than trust a noisy median),
 *  clamped to sane bounds. Worst case = the published defaults (today's behavior); upside = a tier
 *  the niche actually populates is calibrated to its real norm. Pure — caller applies via setRateTable. */
export function calibrateRates(samples: { followers?: number; likes?: number; reposts?: number }[], minPerTier = 6): RateTable {
  const buckets: Record<keyof RateTable, number[]> = { lt1k: [], lt10k: [], lt100k: [], lt500k: [], mega: [] };
  for (const s of samples) {
    const f = s.followers ?? 0; if (f <= 0) continue;
    buckets[tierKey(f)].push(((s.likes ?? 0) + (s.reposts ?? 0)) / f);
  }
  const out: RateTable = { ...DEFAULT_RATES };
  (Object.keys(buckets) as (keyof RateTable)[]).forEach((k) => {
    const xs = buckets[k].sort((a, b) => a - b);
    if (xs.length < minPerTier) return;                                  // sparse tier → keep the published default
    const mid = xs.length >> 1;
    const med = xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;   // true median (avg the two central for even N)
    out[k] = Math.min(RATE_MAX, Math.max(RATE_MIN, med));
  });
  return out;
}
/** A post's "punched above its weight" score. Follower-normalized against the size-tiered expected
 *  rate when reach is known; else measured against the median of the unknown-reach subset so it
 *  competes on its own scale. */
export function scoreWinner(t: { likes?: number; reposts?: number; followers?: number }, medianUnknownEng: number): { eng: number; score: number } {
  const eng = (t.likes ?? 0) + (t.reposts ?? 0);
  const f = t.followers ?? 0;
  const rate = f > 0 ? eng / Math.max(8, f * expectedRate(f)) : eng / (medianUnknownEng || eng || 1);
  return { eng, score: rate * Math.log10(eng + 10) }; // log keeps absolute pull mattering, not just rate
}
export const BREAKOUT_RATE = 2; // a "real" over-performer beats its size-tier expected rate by ≥2×
/** Did this post GENUINELY over-perform for its audience size (a real breakout), vs merely ranking
 *  #1 of a weak pool? Used to gate the "Strong" virality band on absolute quality, not just relative
 *  rank. Unknown reach (no followers) → false: we can't claim a size-relative breakout we can't size. */
export function isBreakout(t: { likes?: number; reposts?: number; followers?: number }): boolean {
  const f = t.followers ?? 0;
  if (f <= 0) return false;
  const eng = (t.likes ?? 0) + (t.reposts ?? 0);
  return eng / Math.max(8, f * expectedRate(f)) >= BREAKOUT_RATE;
}
export function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

// ---------- honest virality band ----------
export type Band = "Strong" | "Solid" | "Niche" | "Long shot";
/** Grounded band: `anchor` (0..1) is the source post's measured rank in the user's real winner
 *  pool (#1 → 1.0); `hook` (0..3) is the model's hook grade. No source → capped at Niche. The
 *  `basis` sentence cites the real rank, never a fabricated multiple. `sort` is a hidden
 *  continuous tiebreaker so the dock keeps a stable order under the 4-band collapse.
 *
 *  `poolSize` is how many real winners we mined from the niche. A thin pool (1-2 posts) is weak
 *  evidence, so the anchor is scaled DOWN by a confidence factor — a sample-of-one cannot mint a
 *  "Strong" band off "one of the top posts" when there was only one post. ≥4 winners = full credit;
 *  omit poolSize for no haircut (back-compat). This keeps the honest-mirror promise on the band. */
export function bandFor(anchor: number, hook: number, hasSource: boolean, poolSize?: number, sourceStrong?: boolean): { band: Band; sort: number; basis: string } {
  const h = Math.max(0, Math.min(3, hook));
  const conf = poolSize == null ? 1 : Math.min(1, Math.max(0, (poolSize - 1) / 3)); // 1→0, 2→0.33, 3→0.67, ≥4→1
  const a = (hasSource ? Math.max(0, Math.min(1, anchor)) : 0) * conf;
  const sort = a * 4 + h;
  if (!hasSource) {
    return { band: h >= 2 ? "Niche" : "Long shot", sort, basis: h >= 2 ? "Your own theme, strong hook — no proven source to anchor it." : "Your own theme, soft hook." };
  }
  const hi = a >= 0.66, mid = a >= 0.33, thin = poolSize != null && poolSize <= 2;
  // "Strong" claims the proof post genuinely over-performed. Relative rank alone can crown the #1 of
  // a WEAK pool, so when we KNOW the source under-performed for its size (sourceStrong === false), cap
  // it at Solid — only a real breakout earns Strong. Unknown (undefined) keeps the rank-based behavior.
  const weakTop = hi && h >= 2 && sourceStrong === false;
  let band: Band;
  if (hi && h >= 2 && sourceStrong !== false) band = "Strong";
  else if ((mid && h >= 2) || (hi && h === 1) || weakTop) band = "Solid";
  else if (h === 0) band = "Long shot";
  else band = "Niche";
  // A thin pool (1-2 winners) ALWAYS reads as a thin signal, even at its Solid cap — never let a
  // sample of two narrate as "a solid over-performer" without the honesty caveat. (hi is unreachable
  // when thin, since the confidence haircut caps a ≤2 pool's anchor below 0.66.)
  const where = thin ? "one of only a couple posts we found in your niche, a thin signal"
    : weakTop ? "the best of the posts we found in your niche, though it only modestly out-performed for its size"
    : hi ? "one of the top posts we found in your niche"
    : mid ? "a solid over-performer in your niche"
    : "a milder signal in your niche";
  const hk = h >= 2 ? "and your hook leads with a real stake" : h === 1 ? "but your hook is a notch soft" : "but your hook needs work";
  return { band, sort, basis: `Remixes ${where}, ${hk}.` };
}
