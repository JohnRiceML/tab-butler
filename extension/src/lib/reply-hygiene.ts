/**
 * Reply-reputation hygiene — the pure logic behind the anti-spam nudges.
 *
 * X's authenticity rules prohibit bulk/aggressive unsolicited replies and
 * duplicative or irrelevant content, but X publishes no guaranteed safe hourly
 * reply rate or account-reputation formula. So Goobi's guardrails are explicit
 * local heuristics: persistent, cross-session, and pattern-aware.
 *
 * Pure (no chrome / no DOM), unit-tested in scripts/test-hygiene.mjs.
 */

// Conservative Goobi product guardrails, not claimed X limits. These are adaptive pressure
// points—not raw reply counts. X's published daily figure is a technical ceiling and explicitly
// not a safety guarantee.
export const REPLY_PACE_CAUTION = 8;
export const REPLY_PACE_EASEOFF = 12;
export const REPLY_PACE_WINDOW_MS = 60 * 60_000;
export const REPLY_PACE_FULL_WEIGHT_MS = 15 * 60_000;

export type RepLevel = "healthy" | "caution" | "easeoff";
export type ReplyPaceLane = "inbound" | "continue" | "community" | "discovery";

export interface ReplyPaceEvent { at: number; lane?: ReplyPaceLane; }
export interface ReplyPaceStatus {
  level: RepLevel;
  label: string;
  /** Every locally recorded reply still inside the rolling hour, including pre-reset history. */
  repliesThisHour: number;
  /** Replies currently contributing pressure after the latest manual baseline reset. */
  countedReplies: number;
  /** Recency- and conversation-weighted local pressure. Never presented as an X score. */
  pressure: number;
  warmReplies: number;
  resetAt?: number;
}

/** Overall reply-pace health from the adaptive pressure value. Kept as a small standalone gate so
 * momentum and older callers can share the exact same boundaries. */
export function reputationStatus(pressure: number): { level: RepLevel; label: string } {
  if (pressure >= REPLY_PACE_EASEOFF) return { level: "easeoff", label: "ease off" };
  if (pressure >= REPLY_PACE_CAUTION) return { level: "caution", label: "pace yourself" };
  return { level: "healthy", label: "healthy pace" };
}

/** Warm/solicited conversation is lower-pressure than cold discovery, but never free. */
export function replyPaceLaneWeight(lane?: ReplyPaceLane): number {
  if (lane === "inbound") return 0.7;
  if (lane === "continue") return 0.85;
  if (lane === "community") return 0.95;
  return 1;
}

/** Full weight for the newest 15 minutes, then a smooth recovery to zero by one hour. */
export function replyPaceRecencyWeight(ageMs: number): number {
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs >= REPLY_PACE_WINDOW_MS) return 0;
  if (ageMs <= REPLY_PACE_FULL_WEIGHT_MS) return 1;
  return Math.max(0, Math.min(1, (REPLY_PACE_WINDOW_MS - ageMs) / (REPLY_PACE_WINDOW_MS - REPLY_PACE_FULL_WEIGHT_MS)));
}

/**
 * Dynamic local ease-off model. It distinguishes warm from cold conversation, decays smoothly,
 * and accepts a user-set baseline reset without deleting the underlying activity ledger. A reset
 * has no effect on X's own limits, enforcement, or activity recorded outside Goobi.
 */
export function replyPaceStatus(events: readonly ReplyPaceEvent[], now: number, resetAt?: number): ReplyPaceStatus {
  const validReset = typeof resetAt === "number" && Number.isFinite(resetAt) && resetAt <= now + 30_000 && now - resetAt < REPLY_PACE_WINDOW_MS
    ? resetAt : undefined;
  let repliesThisHour = 0, countedReplies = 0, warmReplies = 0, pressure = 0;
  for (const event of events) {
    if (!event || !Number.isFinite(event.at)) continue;
    const age = now - event.at;
    if (age < 0 || age >= REPLY_PACE_WINDOW_MS) continue;
    repliesThisHour++;
    if (validReset != null && event.at <= validReset) continue;
    countedReplies++;
    if (event.lane === "inbound" || event.lane === "continue") warmReplies++;
    pressure += replyPaceLaneWeight(event.lane) * replyPaceRecencyWeight(age);
  }
  pressure = Math.round(pressure * 10) / 10;
  return { ...reputationStatus(pressure), repliesThisHour, countedReplies, pressure, warmReplies, resetAt: validReset };
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
 *  Priority: duplicate-reply > adaptive pace > repeat-author. */
export function pickReplyNudge(opts: { duplicate: boolean; repliesThisHour: number; repeatAuthor: string | null; pacePressure?: number }): string | null {
  if (opts.duplicate) return "This reply is nearly identical to one you used recently. X flags copy-pasted replies as spam, so tweak it before posting.";
  const pressure = opts.pacePressure ?? opts.repliesThisHour;
  if (pressure >= REPLY_PACE_EASEOFF) return `${opts.repliesThisHour} replies recorded this hour · ${pressure.toFixed(1)} pace pressure. Goobi's adaptive guard is reached, so take a real break or reset the local meter if it no longer reflects your session.`;
  if (pressure >= REPLY_PACE_CAUTION && pressure < REPLY_PACE_CAUTION + 1) return `${opts.repliesThisHour} replies recorded this hour · ${pressure.toFixed(1)} pace pressure. X publishes no guaranteed safe pace; slow down and favor warm conversations.`;
  if (opts.repeatAuthor) return `You already replied to @${opts.repeatAuthor} recently. Spreading across new accounts grows faster and avoids the reply-spam pattern.`;
  return null;
}
