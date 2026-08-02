/**
 * Daily account "warm-up / momentum" — a discipline mirror, NOT a reach promise.
 *
 * It scores how steady + healthy your activity is TODAY (replies + posts shipped +
 * day-over-day streak + how live you are right now). It is pure (no DOM/chrome) and
 * unit-tested (scripts/test-momentum.mjs).
 *
 * The keystone: it is structurally incapable of rewarding unsafe volume. The score
 * SATURATES at a healthy daily target, and crossing Goobi's conservative ease-off line
 * via replyPaceStatus flips it to "overheating" — red, and LOWER, never "max". It reads
 * its safety verdict from the same adaptive status the dock's pace chip + Goobi's
 * "worn" mood read, so the two can never contradict.
 *
 * Real reach (X-reported views) is shown separately in the UI; it is a measured stat, not
 * a lever — it must never push the score, or this stops being honest.
 */

import { REPLY_PACE_CAUTION, REPLY_PACE_EASEOFF, type RepLevel } from "./reply-hygiene";

export type { RepLevel } from "./reply-hygiene";

export type MomentumState = "cold" | "warming" | "inflow" | "peak" | "cooling" | "overheating";

export interface MomentumInput {
  repliesToday: number;
  postedToday: number;
  replyStreak: number;     // consecutive days you've replied
  minsSinceLast: number;   // minutes since your last reply/post (big = idle)
  repLevel: RepLevel;      // replyPaceStatus(events).level — the safety source of truth
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
  overheating: { label: "Too hot — ease off", cue: `Goobi's adaptive pace pressure reached ${REPLY_PACE_EASEOFF}. It decays with time; take a break or reset the local meter if its baseline is stale. This does not reset X.`, color: "#d6604a" },
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
    return { score, state, label: COPY[state].label, cue: `Goobi's adaptive caution band starts at ${REPLY_PACE_CAUTION} pressure. Warm conversations count less and older activity fades — slow down and prioritize genuine conversations.`, color: "#e89a3c" };
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
 * or two (which convert the profile clicks into follows), the posts SPACED ~3h apart. Why spaced:
 * MEASURED (correlational) — per-post reach declines as daily original volume climbs; and same-
 * author candidates that land in one feed load may attenuate each other (the diversity scorer is
 * scoped to a single response, so wall-clock spacing only lowers the odds of co-landing — it is a
 * prior, not a mechanism guarantee). The reply band is the practitioner consensus for a
 * growth-mode day; posting is 1-3, spaced.
 *
 * SAFETY-DEFERENT by construction: at ease-off it says nothing (the safety copy owns the message),
 * and at caution it NEVER nudges more replies — only "switch to a post". It can't push unsafe volume. */
export const DAILY_REPLY_BAND = { lo: 10, hi: 30 }; // quality replies for a growth-mode day (consensus)
export const DAILY_POST_BAND = { lo: 1, hi: 3 };    // 1-3 originals, spaced — bursts self-cannibalize

export interface DailyShape { text: string; kind: "warmup" | "balance" | "spacing" }
export function dailyShape(input: { repliesToday: number; postedToday: number; repLevel: RepLevel }): DailyShape | null {
  const { repliesToday, postedToday, repLevel } = input;
  if (repLevel === "easeoff") return null; // safety copy owns the message — never cheer over it
  if (postedToday > DAILY_POST_BAND.hi) return { kind: "spacing", text: `${postedToday} posts today — space originals ~3h apart. Measured (correlational): per-post reach declines as daily volume climbs, so consistency beats volume; stacked originals may also attenuate each other when they land in the same feed load.` };
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

/* ---------- post-spacing nudge: soft, NEVER a block -----------------------------------------------
 * Why spacing: MEASURED (correlational) per-post reach declines at higher original-post frequency;
 * and same-author candidates that co-land in ONE feed response may attenuate each other (the
 * diversity scorer is response-scoped — wall-clock spacing only lowers co-landing odds, so this is
 * a prior, not a mechanism guarantee). Reads only the time since your last OWN original. It is a
 * nudge, not a gate: Goobi never blocks a post — if the user wants to ship now, they ship now.
 * Pure (unit-tested in test-momentum). */
export const POST_SPACING_MINS = 180; // ~3h between originals — a product prior, not a disclosed X threshold

export interface PostSpacingNudge { soft: true; minsToGo: number; text: string }
export function postSpacingNudge(minsSinceLastOwnPost: number | undefined): PostSpacingNudge | null {
  if (!Number.isFinite(minsSinceLastOwnPost) || (minsSinceLastOwnPost as number) < 0) return null;
  const since = Math.round(minsSinceLastOwnPost as number);
  if (since >= POST_SPACING_MINS) return null; // spaced enough — clear to post, no nudge
  const minsToGo = POST_SPACING_MINS - since;
  const ago = since < 60 ? `${since} min` : `${Math.round(since / 60)}h`;
  const wait = minsToGo < 60 ? `${minsToGo} min` : `~${Math.floor(minsToGo / 60)}h`; // floor, never round a 2.5h remainder up to "3h"
  return {
    soft: true, // never a block — posting now is still allowed
    minsToGo,
    text: `You posted an original ${ago} ago — stacked originals tend to split reach (measured: per-post reach declines at higher frequency; same-load candidates may also attenuate each other). Give it ${wait} more if you can.`,
  };
}
