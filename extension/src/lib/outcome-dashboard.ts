/**
 * Measured-outcomes dashboard (pure) — shapes what the learning loop ALREADY computes
 * (learn-stats.ts) into a scannable display model for the popup. No chrome/DOM/fetch,
 * no new math: every number here is produced by the existing learners; this module only
 * gates, ranks, and words them. Unit-tested in scripts/test-outcome-dashboard.mjs.
 *
 * Honesty is inherited, not re-derived: every row carries its n, every gate is an
 * imported learn-stats constant (GLOBAL_THIN / N_MIN_OUT / FIT_CORR_MIN_N), and below a
 * gate a row simply doesn't exist — the empty state names exactly what's missing instead.
 * Per the learn-stats contract, only frozen measured counts power settled diagnostics;
 * provisional observations remain pending and cannot unlock a result or reorder work.
 */

import {
  aggregateAccounts, rankAccounts, learnFeatures, replyVerificationSummary, accountRankMultipliers,
  GLOBAL_THIN, N_MIN_OUT, FIT_CORR_MIN_N,
  type LearnReply, type ReplyVerificationSummary,
} from "./learn-stats";

/** One angle slice that cleared its gate. relPct is signed % vs the user's OWN measured
 *  mean, post-shrinkage ((rel−1)·100) — never an external benchmark. */
export interface AngleRowVM { angle: string; n: number; relPct: number; best: boolean }

/** Discovery-source or policy-lane slice. Diagnostic only: it never changes ranking. */
export interface CohortRowVM { key: string; n: number; relPct: number }

/** One post-age bucket that cleared its gate. relPct compares the bucket to the n-weighted
 *  mean across the shown buckets (display normalization only); null when a single bucket
 *  cleared — one point has nothing honest to be relative to. */
export interface TimingRowVM { label: string; n: number; relPct: number | null }

/** One account row. tier "measured" carries a settled-outcome score (relPct vs the user's
 *  own measured mean); tier "invest" is effort-only — no payoff claim, so relPct is null. */
export interface AccountRowVM {
  handle: string;
  n: number;               // attributed replies to this account
  nOut: number;             // settled outcomes folded into the measured score
  tier: "measured" | "invest";
  relPct: number | null;
  confidence: 0 | 1 | 2 | 3;
  backs: number;            // measured engaged-back events
}

export type FitReadVM =
  | { kind: "measured"; rho: number; n: number; viewRho?: number; viewN: number; learningEnabled: boolean; tiltEligible: boolean; tilting: boolean }
  | { kind: "waiting"; n: number; need: number };

export interface OutcomeDashboardVM {
  state: "learning" | "ready";  // learning = below the global gate; show only `missing`
  attributed: number;            // replies with a known author (the global-gate counter)
  settled: number;               // frozen outcomes with real counts
  verification: ReplyVerificationSummary;
  missing: string[];             // exactly what each silent section is waiting on
  angles: AngleRowVM[];
  sources: CohortRowVM[];
  lanes: CohortRowVM[];
  timing: TimingRowVM[];
  ageGradient: { ratio: number; freshN: number; staleN: number } | null;
  accountsTop: AccountRowVM[];
  accountBottom: AccountRowVM | null; // lowest-ranked eligible account, when distinct from the top
  fit: FitReadVM;
}

const TOP_ACCOUNTS = 3; // display width, not an honesty gate — rows above it still exist

const pct = (ratio: number): number => Math.round((ratio - 1) * 100);

/** A join-only or provisional outcome is not a settled measurement. */
const hasCounts = (r: LearnReply): boolean => r.outcome?.frozen === true && (r.outcome.likes != null || r.outcome.replies != null);

export function buildOutcomeDashboard(sent: LearnReply[], now: number, learningEnabled = false): OutcomeDashboardVM {
  const verification = replyVerificationSummary(sent, 0, now);
  const agg = aggregateAccounts(sent, now);
  const fl = learnFeatures(sent, now);
  const settled = fl.nOut;
  const fitN = sent.filter((r) => hasCounts(r) && r.score != null).length;
  const viewFitN = sent.filter((r) => hasCounts(r) && r.score != null && r.outcome?.views != null).length;

  // ---- angles: learnFeatures already shrinks + gates each slice at N_MIN_OUT ----
  const angles: AngleRowVM[] = fl.angles.map((a) => ({ angle: a.angle, n: a.n, relPct: pct(a.rel), best: fl.bestAngle === a.angle }));
  const sources: CohortRowVM[] = fl.sources.map((c) => ({ key: c.key, n: c.n, relPct: pct(c.rel) }));
  const lanes: CohortRowVM[] = fl.lanes.map((c) => ({ key: c.key, n: c.n, relPct: pct(c.rel) }));

  // ---- timing: only buckets that clear the same settled-outcome gate as everything else ----
  const gated = fl.ageBuckets.filter((b) => b.n >= N_MIN_OUT);
  let timing: TimingRowVM[];
  if (gated.length >= 2) {
    const wSum = gated.reduce((a, b) => a + b.n, 0);
    const base = gated.reduce((a, b) => a + b.fit * b.n, 0) / wSum;
    timing = gated.map((b) => ({ label: b.label, n: b.n, relPct: base > 0 ? pct(b.fit / base) : null }));
  } else {
    timing = gated.map((b) => ({ label: b.label, n: b.n, relPct: null }));
  }
  const ageGradient = fl.ageGradient != null
    ? { ratio: fl.ageGradient, freshN: fl.freshN ?? 0, staleN: fl.staleN ?? 0 }
    : null;

  // ---- accounts: rankAccounts owns eligibility (measured score OR enough effort) ----
  const { ranked } = rankAccounts(agg, Number.MAX_SAFE_INTEGER);
  const toVM = (r: (typeof ranked)[number]): AccountRowVM => ({
    handle: r.handle,
    n: r.replies,
    nOut: r.nOut,
    tier: r.tier,
    relPct: r.tier === "measured" && r.score != null && agg.muObs > 0 ? pct(r.score / agg.muObs) : null,
    confidence: r.confidence,
    backs: r.backs,
  });
  const accountsTop = ranked.slice(0, TOP_ACCOUNTS).map(toVM);
  const accountBottom = ranked.length > TOP_ACCOUNTS ? toVM(ranked[ranked.length - 1]) : null;

  // ---- baseline recommendation priority ↔ outcome: same-sample alignment, in plain words ----
  const tiltEligible = accountRankMultipliers(sent, now).applied;
  const fit: FitReadVM = fl.fitCorr != null
    ? { kind: "measured", rho: fl.fitCorr, n: fitN, viewRho: fl.fitCorrViews, viewN: viewFitN, learningEnabled, tiltEligible, tilting: learningEnabled && tiltEligible }
    : { kind: "waiting", n: fitN, need: FIT_CORR_MIN_N };

  // ---- what's missing — the distance to each gate, named, never guessed past ----
  const missing: string[] = [];
  if (agg.attributed < GLOBAL_THIN) missing.push(`${agg.attributed} of ${GLOBAL_THIN} replies logged — keep replying and the map starts here`);
  if (verification.confirmed === 0 && verification.attempted > 0) missing.push(`0 replies confirmed on X yet (${verification.pending} still inside the match window) — post the draft and confirm it`);
  if (settled < N_MIN_OUT) missing.push(`${settled} of ${N_MIN_OUT} settled outcomes — the daily measure pass needs the RapidAPI key and a dock open on x.com`);
  else {
    if (!angles.length) missing.push(`no single angle has ${N_MIN_OUT}+ measured outcomes yet — keep varying angles`);
    if (!sources.length) missing.push(`no discovery source has ${N_MIN_OUT}+ settled outcomes yet`);
    if (!lanes.length) missing.push(`no recommendation lane has ${N_MIN_OUT}+ settled outcomes yet`);
    if (!timing.length) missing.push(`no post-age bucket has ${N_MIN_OUT}+ measured outcomes yet`);
  }
  if (fit.kind === "waiting") missing.push(`priority↔outcome check unlocks at ${FIT_CORR_MIN_N} settled, scored replies (${fitN}/${FIT_CORR_MIN_N})`);

  return {
    state: agg.attributed < GLOBAL_THIN ? "learning" : "ready",
    attributed: agg.attributed,
    settled,
    verification,
    missing,
    angles,
    sources,
    lanes,
    timing,
    ageGradient,
    accountsTop,
    accountBottom,
    fit,
  };
}
