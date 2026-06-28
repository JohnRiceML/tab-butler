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
/** A post's "punched above its weight" score. Follower-normalized when reach is known; else
 *  measured against the median of the unknown-reach subset so it competes on its own scale. */
export function scoreWinner(t: { likes?: number; reposts?: number; followers?: number }, medianUnknownEng: number): { eng: number; score: number } {
  const eng = (t.likes ?? 0) + (t.reposts ?? 0);
  const f = t.followers ?? 0;
  const rate = f > 0 ? eng / Math.max(8, f * 0.003) : eng / (medianUnknownEng || eng || 1); // ~0.3% like-rate baseline
  return { eng, score: rate * Math.log10(eng + 10) }; // log keeps absolute pull mattering, not just rate
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
 *  continuous tiebreaker so the dock keeps a stable order under the 4-band collapse. */
export function bandFor(anchor: number, hook: number, hasSource: boolean): { band: Band; sort: number; basis: string } {
  const h = Math.max(0, Math.min(3, hook));
  const sort = (hasSource ? Math.max(0, Math.min(1, anchor)) : 0) * 4 + h;
  if (!hasSource) {
    return { band: h >= 2 ? "Niche" : "Long shot", sort, basis: h >= 2 ? "Your own theme, strong hook — no proven source to anchor it." : "Your own theme, soft hook." };
  }
  const hi = anchor >= 0.66, mid = anchor >= 0.33;
  let band: Band;
  if (hi && h >= 2) band = "Strong";
  else if ((mid && h >= 2) || (hi && h === 1)) band = "Solid";
  else if (h === 0) band = "Long shot";
  else band = "Niche";
  const where = hi ? "one of the top posts we found in your niche" : mid ? "a solid over-performer in your niche" : "a milder signal in your niche";
  const hk = h >= 2 ? "and your hook leads with a real stake" : h === 1 ? "but your hook is a notch soft" : "but your hook needs work";
  return { band, sort, basis: `Remixes ${where}, ${hk}.` };
}
