/**
 * Reply-reputation hygiene — the pure logic behind the anti-spam nudges.
 *
 * X penalizes PATTERNS, not single replies, and the penalty attaches to the
 * account's reputation (so it suppresses reach ongoing, not just one reply):
 *   - roughly >30 replies/hour reads as automated;
 *   - copy-pasted or near-duplicate replies across threads trigger a reply
 *     deboost / "ghost ban" (replies hidden under "show probable spam");
 *   - aggressive tone is deboosted even when it gets engagement.
 * So the guardrails must be persistent (cross-session) and pattern-aware.
 *
 * Pure (no chrome / no DOM), unit-tested in scripts/test-hygiene.mjs.
 */

export const REPLY_SOFT_PER_HOUR = 20; // gentle "pace yourself" nudge
export const REPLY_HARD_PER_HOUR = 30; // X's automation-detection neighborhood — stay under

export type RepLevel = "healthy" | "caution" | "easeoff";

/** Overall reply-pace health from replies-in-the-last-hour, on the same soft/hard
 *  lines the nudges use. Drives the dock pace chip + the popup "Account safety"
 *  panel so the protection is visible: healthy < 20, caution 20–29, easeoff >= 30. */
export function reputationStatus(repliesThisHour: number): { level: RepLevel; label: string } {
  if (repliesThisHour >= REPLY_HARD_PER_HOUR) return { level: "easeoff", label: "ease off" };
  if (repliesThisHour >= REPLY_SOFT_PER_HOUR) return { level: "caution", label: "pace yourself" };
  return { level: "healthy", label: "healthy pace" };
}

/** Lowercase, drop links + punctuation, collapse whitespace — so trivial edits
 *  (caps, a different link, an added "!") still compare as the same reply. */
export function normalizeReply(s: string): string {
  return s
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Token-set Jaccard similarity of two normalized strings (0..1). */
export function jaccard(a: string, b: string): number {
  const sa = new Set(a.split(" ").filter(Boolean));
  const sb = new Set(b.split(" ").filter(Boolean));
  if (!sa.size || !sb.size) return 0;
  let inter = 0;
  for (const w of sa) if (sb.has(w)) inter++;
  return inter / (sa.size + sb.size - inter);
}

/** Is `norm` a near-duplicate of any recent normalized reply? Exact match, or
 *  >= 0.7 token overlap — catches a lightly-reworded copy-paste (a one-word swap
 *  in a short reply) while genuinely different replies (~0.5 and below) stay clear. */
export function isDuplicateReply(norm: string, recent: string[]): boolean {
  if (!norm) return false;
  return recent.some((r) => r === norm || jaccard(norm, r) >= 0.7);
}

/** Empty-praise / low-effort reply gate. X down-weights "great post! 🔥" filler and the big
 *  account never notices you — so a reply must add something only you would say. Returns null
 *  when it's fine, or a reason to surface (the caller nudges; it never hard-blocks the insert).
 *  Tuned to fire only on the unambiguous cases — false positives on a sharp short reply annoy. */
export function replyQualityWarning(text: string): string | null {
  const t = (text || "").trim();
  if (!t) return null;
  const words = t.replace(/https?:\/\/\S+/g, "").replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
  if (words.length === 0) return "An emoji-only reply adds nothing — X buries it and the author won't notice you.";
  if (words.length < 4) return "Too short to add value. Say something only you would — a point, a question, or a quick example.";
  const PRAISE = /^(great|love( this| it)?|nice|awesome|amazing|so (good|true)|facts|exactly|well said|good (post|point|stuff|thread|take)|fire|based|agreed?|100|preach|gold|incredible|legend|king|queen|w )\b/i;
  if (words.length <= 6 && PRAISE.test(t)) return "Reads as empty praise. Add a specific point, question, or example so the reply earns a look (and a reply back).";
  return null;
}

/** The single most important reputation nudge to show after an insert, or null.
 *  Priority: duplicate-reply > hourly volume > repeat-author. */
export function pickReplyNudge(opts: { duplicate: boolean; repliesThisHour: number; repeatAuthor: string | null }): string | null {
  if (opts.duplicate) return "This reply is nearly identical to one you used recently. X flags copy-pasted replies as spam, so tweak it before posting.";
  if (opts.repliesThisHour >= REPLY_HARD_PER_HOUR) return `${opts.repliesThisHour} replies this hour. Around 30/hr is where X starts reading replies as automated, so ease off for a bit.`;
  if (opts.repliesThisHour === REPLY_SOFT_PER_HOUR + 1) return "20+ replies this hour. X rewards quality over volume, so pace yourself.";
  if (opts.repeatAuthor) return `You already replied to @${opts.repeatAuthor} recently. Spreading across new accounts grows faster and avoids the reply-spam pattern.`;
  return null;
}
