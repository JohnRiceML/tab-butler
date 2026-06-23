/**
 * Community-builder detection — the signal for surfacing PEERS worth engaging even
 * when their post isn't on your niche topic. Replying to builders/community people
 * in your space compounds your own network, so the rec engine should lift them, not
 * bury them behind a low topic-fit score.
 *
 * Uses the author's PROFILE (bio + the following/followers ratio we already fetch
 * for reach) — not the post content. Pure (no DOM/chrome), unit-tested.
 *
 * Returns: 0 = not a builder peer · 1 = reciprocal builder peer · 2 = and in your niche.
 */

const BUILDER_RE = /\b(?:build(?:ing|er|ers|s)?|founder|co-?founder|indie\s?hacker|maker|ship(?:ping|ped|s)?|launch(?:ed|ing)?|bootstrapp?(?:ed|ing)?|startup|saas|creator|community|solopreneur)\b|build in public/i;

const STOP = new Set(["the", "and", "for", "with", "that", "this", "about", "your", "you", "who", "are", "not", "but", "posts", "posting", "post", "reply", "replies", "from", "into", "they", "them", "where", "what", "when", "have", "has", "can", "add", "lab"]);

/** Significant words from the user's free-text niche (4+ chars, minus stopwords). */
export function nicheWords(niche: string): string[] {
  return Array.from(new Set((niche.toLowerCase().match(/[a-z][a-z0-9+]{3,}/g) || []).filter((w) => !STOP.has(w))));
}

/** `ratio` = following / followers (a reply-back / "engages with people" proxy).
 *  We require a known, reciprocal-ish ratio so this only ever flags genuine
 *  two-way peers — never mega-broadcasters who happen to say "building" in a bio. */
export function builderTier(bio: string, niche: string, ratio: number | undefined): 0 | 1 | 2 {
  if (!bio || ratio == null || ratio < 0.08) return 0; // need a bio + evidence they engage back
  if (!BUILDER_RE.test(bio)) return 0;
  const bioWords = new Set((bio.toLowerCase().match(/[a-z][a-z0-9+]{3,}/g) || [])); // whole words, so "build" doesn't match "building"
  return nicheWords(niche).some((w) => bioWords.has(w)) ? 2 : 1;
}
