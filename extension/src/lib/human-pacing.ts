/**
 * Human-pacing — randomized, bounded delays so the copilot's on-page actions
 * (typing a reply, liking, following) don't fire in robotic lockstep.
 *
 * IMPORTANT: this is the MECHANICAL layer only. What actually keeps you off X's
 * spam radar is the PATTERN layer in reply-hygiene.ts — reply volume, duplicate
 * detection, author-spread, and civil tone (X flags behavioral patterns + content,
 * not whether one click had a realistic delay). This just removes the cheap
 * "everything fired in the same 50ms / text appeared as one instant block" tells
 * on top of that. Pure (no DOM/chrome), unit-tested in scripts/test-pacing.mjs.
 */

export type PaceKind = "type" | "react" | "menu" | "settle";

/** [min, max] ms per kind. type = between words while typing; react = a quick
 *  focus/reaction; menu = reading a menu before clicking; settle = a beat before
 *  a secondary action (e.g. liking just after inserting). */
const RANGES: Record<PaceKind, readonly [number, number]> = {
  type: [28, 95],
  react: [180, 520],
  menu: [320, 780],
  settle: [650, 1500],
};

/** A human-ish delay in ms for `kind`. `rnd` is injectable for tests. */
export function humanDelayMs(kind: PaceKind, rnd: () => number = Math.random): number {
  const [lo, hi] = RANGES[kind];
  return Math.round(lo + (hi - lo) * rnd());
}

/** Split a reply into "typing" chunks — words with their trailing space, so the
 *  reply builds up word by word. Bounded by `maxChunks`: a very long reply merges
 *  words into groups so the total typing time stays sane. join('') === input. */
export function typeChunks(text: string, maxChunks = 60): string[] {
  const words = text.match(/\S+\s*/g) || (text ? [text] : []);
  if (words.length <= maxChunks) return words;
  const out: string[] = [];
  const per = Math.ceil(words.length / maxChunks);
  for (let i = 0; i < words.length; i += per) out.push(words.slice(i, i + per).join(""));
  return out;
}

/** Jitter a base gap by ±frac (e.g. a 20s follow floor becomes ~17–23s) so paced
 *  actions aren't a clockwork interval. Never returns below `base * (1 - frac)`. */
export function jitterGap(base: number, frac = 0.15, rnd: () => number = Math.random): number {
  return Math.round(base * (1 + (rnd() * 2 - 1) * frac));
}
