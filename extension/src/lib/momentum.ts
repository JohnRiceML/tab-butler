/**
 * Daily account "warm-up / momentum" — a discipline mirror, NOT a reach promise.
 *
 * It scores how steady + healthy your activity is TODAY (replies + posts shipped +
 * day-over-day streak + how live you are right now). It is pure (no DOM/chrome) and
 * unit-tested (scripts/test-momentum.mjs).
 *
 * The keystone: it is structurally incapable of rewarding unsafe volume. The score
 * SATURATES at a healthy daily target, and crossing Goobi's conservative ease-off line,
 * via reputationStatus) flips it to "overheating" — red, and LOWER, never "max". It reads
 * its safety verdict from the same reputationStatus() the dock's pace chip + Goobi's
 * "worn" mood read, so the two can never contradict.
 *
 * Real reach (X-reported views) is shown separately in the UI; it is a measured stat, not
 * a lever — it must never push the score, or this stops being honest.
 */

export type MomentumState = "cold" | "warming" | "inflow" | "peak" | "cooling" | "overheating";
export type RepLevel = "healthy" | "caution" | "easeoff";

export interface MomentumInput {
  repliesToday: number;
  postedToday: number;
  replyStreak: number;     // consecutive days you've replied
  minsSinceLast: number;   // minutes since your last reply/post (big = idle)
  repLevel: RepLevel;      // reputationStatus(repliesThisHour).level — the safety source of truth
}
export interface Momentum { score: number; state: MomentumState; label: string; cue: string; color: string; }

export const PACE_TARGET = 8;   // replies that count as "in flow" for the day — healthy + sustainable
const POST_BONUS = 18;          // shipping a post is worth a lot (consistency beats reply churn)
const STREAK_CAP = 20;
const RECENCY_HALF = 45;        // minutes; the live component halves every 45 min idle

const COPY: Record<MomentumState, { label: string; cue: string; color: string }> = {
  cold:        { label: "Cold start",         cue: "A reply or two warms you up.",                               color: "#6b6256" },
  warming:     { label: "Warming up",         cue: "Nice — keep a steady pace.",                                 color: "#e8b06a" },
  inflow:      { label: "In flow",            cue: "Good rhythm. This is the sweet spot.",                       color: "#6fcf7f" },
  peak:        { label: "In the zone",        cue: "Steady and healthy — exactly where you want to be.",         color: "#6fcf7f" },
  cooling:     { label: "Cooling off",        cue: "Tapering — a reply keeps the rhythm, if you've got one.",    color: "#e8b06a" },
  overheating: { label: "Too hot — ease off", cue: "30+ replies an hour reads as automated. Give it a few minutes.", color: "#d6604a" },
};

export function computeMomentum(input: MomentumInput): Momentum {
  const { repliesToday, postedToday, replyStreak, minsSinceLast, repLevel } = input;

  const volume = 55 * Math.min(repliesToday / PACE_TARGET, 1);            // 0..55, saturates — "more" stops paying
  const posts = Math.min(postedToday, 2) * (POST_BONUS / 2);             // 0..18
  const streak = Math.min(Math.max(replyStreak, 0) * 4, STREAK_CAP);    // 0..20
  const live = 7 * Math.pow(0.5, Math.max(minsSinceLast, 0) / RECENCY_HALF); // 0..7, decays while idle
  let raw = volume + posts + streak + live;

  // SAFETY OVERRIDE (the keystone): the meter must AGREE with the pace chip, never celebrate over it.
  // Past the ease-off line it's "too hot", never "max".
  if (repLevel === "easeoff") {
    return { score: Math.round(Math.min(raw, 60)), state: "overheating", ...COPY.overheating };
  }
  // At caution pace the chip is amber "pace yourself" — the meter must echo that, not show a cheery
  // green "sweet spot". So: cap below Peak, paint it the caution amber, and nudge the pace down.
  if (repLevel === "caution") {
    const score = Math.round(Math.max(0, Math.min(raw, 74)));
    const state: MomentumState = score <= 14 ? "cold" : score <= 44 ? "warming" : "inflow";
    return { score, state, label: COPY[state].label, cue: "Good pace — ease off the throttle a touch, you're nearing the line.", color: "#e89a3c" };
  }

  const score = Math.round(Math.max(0, Math.min(raw, 100)));
  let state: MomentumState =
    score <= 14 ? "cold" : score <= 44 ? "warming" : score <= 74 ? "inflow" : "peak";
  // "cooling" = you had momentum but you've gone quiet for a bit (tapering).
  if ((state === "warming" || state === "inflow") && minsSinceLast > 25) state = "cooling";

  return { score, state, ...COPY[state] };
}

/* ---------- daily-shape coach: the BALANCE of the day, not the volume ----------------------------
 * The momentum meter scores today's effort and saturates. This is the complementary read: are you
 * hitting the healthy SHAPE of a growth day — replies (which earn reach) balanced with an original
 * or two (which convert the profile clicks into follows), the posts SPACED (the ranker's author-
 * diversity decay suppresses back-to-back posts from one author in a single feed load). The reply
 * band is the practitioner consensus for a growth-mode day; posting is 1-3, spaced.
 *
 * SAFETY-DEFERENT by construction: at ease-off it says nothing (the safety copy owns the message),
 * and at caution it NEVER nudges more replies — only "switch to a post". It can't push unsafe volume. */
export const DAILY_REPLY_BAND = { lo: 10, hi: 30 }; // quality replies for a growth-mode day (consensus)
export const DAILY_POST_BAND = { lo: 1, hi: 3 };    // 1-3 originals, spaced — bursts self-cannibalize

export interface DailyShape { text: string; kind: "warmup" | "balance" | "spacing" }
export function dailyShape(input: { repliesToday: number; postedToday: number; repLevel: RepLevel }): DailyShape | null {
  const { repliesToday, postedToday, repLevel } = input;
  if (repLevel === "easeoff") return null; // safety copy owns the message — never cheer over it
  if (postedToday > DAILY_POST_BAND.hi) return { kind: "spacing", text: `${postedToday} posts today — space them a few hours apart. The ranker decays back-to-back posts from one author in a single feed load.` };
  if (repLevel === "caution") {
    // near the line — the only safe redirect is AWAY from more replies, toward a post
    return repliesToday >= DAILY_REPLY_BAND.lo && postedToday === 0
      ? { kind: "balance", text: "You've replied plenty today — switch to an original. Replies earn the reach; the post converts it into follows." }
      : null;
  }
  // healthy pace from here — safe to encourage the balanced shape
  if (repliesToday === 0 && postedToday === 0) return { kind: "warmup", text: "Quiet so far — a few replies on bigger threads is the fastest warm-up." };
  if (repliesToday >= DAILY_REPLY_BAND.lo && postedToday === 0) return { kind: "balance", text: `${repliesToday} replies today — strong. Mix in one original: replies earn the reach, your post converts the profile clicks into follows.` };
  if (postedToday >= DAILY_POST_BAND.lo && repliesToday < DAILY_REPLY_BAND.lo) return { kind: "balance", text: `Posted today ✓ — now spend time in bigger threads (${repliesToday}/${DAILY_REPLY_BAND.lo}+ replies). That's where new people meet you.` };
  if (repliesToday >= DAILY_REPLY_BAND.lo && postedToday >= DAILY_POST_BAND.lo) return { kind: "balance", text: "Balanced day — replies plus an original, spaced. This is the shape that compounds." };
  return null; // mid-warm-up with nothing distinctive to add — the meter's own cue covers it
}
