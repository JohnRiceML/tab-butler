/**
 * Niche-peer detection — the signal for surfacing PEERS worth engaging even when
 * their post isn't on your niche topic. Replying to two-way people in your space
 * compounds your own network, so the rec engine should lift them, not bury them
 * behind a low topic-fit score. Works for ANY vertical: a peer is someone whose
 * BIO overlaps your niche words (lawyer, coach, designer, founder alike) — the
 * builder/creator regex is only the fallback cue for community-type people whose
 * bio doesn't name your space.
 *
 * Uses the author's PROFILE (bio + the following/followers ratio we already fetch
 * for reach) — not the post content. Pure (no DOM/chrome), unit-tested.
 *
 * Returns: 0 = not a peer · 1 = reciprocal builder/creator/community person
 * (off-niche) · 2 = a reciprocal peer IN YOUR SPACE (bio matches your niche words).
 */

const BUILDER_RE = /\b(?:build(?:ing|er|ers|s)?|founder|co-?founder|indie\s?hacker|maker|ship(?:ping|ped|s)?|launch(?:ed|ing)?|bootstrapp?(?:ed|ing)?|startup|saas|creator|community|solopreneur)\b|build in public/i;

const STOP = new Set(["the", "and", "for", "with", "that", "this", "about", "your", "you", "who", "are", "not", "but", "posts", "posting", "post", "reply", "replies", "from", "into", "they", "them", "where", "what", "when", "have", "has", "can", "add", "lab"]);

/** Significant words from the user's free-text niche (4+ chars, minus stopwords). */
export function nicheWords(niche: string): string[] {
  return Array.from(new Set((niche.toLowerCase().match(/[a-z][a-z0-9+]{3,}/g) || []).filter((w) => !STOP.has(w))));
}

/** `ratio` = following / followers (a reply-back / "engages with people" proxy).
 *  We require a known, reciprocal-ish ratio so this only ever flags genuine
 *  two-way peers — never mega-broadcasters who happen to name your space in a bio.
 *  Niche-bio overlap is the PRIMARY peer evidence (vertical-agnostic); the builder
 *  regex alone is the weaker, off-niche community cue. */
export function builderTier(bio: string, niche: string, ratio: number | undefined): 0 | 1 | 2 {
  if (!bio || ratio == null || ratio < 0.08) return 0; // need a bio + evidence they engage back
  const bioWords = new Set((bio.toLowerCase().match(/[a-z][a-z0-9+]{3,}/g) || [])); // whole words, so "build" doesn't match "building"
  if (nicheWords(niche).some((w) => bioWords.has(w))) return 2; // bio names YOUR space → a niche peer in any vertical
  return BUILDER_RE.test(bio) ? 1 : 0; // generic builder/creator/community language → an off-niche community peer
}
