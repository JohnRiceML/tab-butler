/**
 * Unit tests for the measured-outcomes dashboard shaping + gating (outcome-dashboard.ts).
 * bundle:true because the lib composes learn-stats. Run: node scripts/test-outcome-dashboard.mjs
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as esbuild from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const built = esbuild.buildSync({ entryPoints: [join(here, "../src/lib/outcome-dashboard.ts")], bundle: true, write: false, format: "esm", platform: "node" });
const m = await import("data:text/javascript;base64," + Buffer.from(built.outputFiles[0].text).toString("base64"));
const ls = await (async () => {
  const b = esbuild.buildSync({ entryPoints: [join(here, "../src/lib/learn-stats.ts")], bundle: true, write: false, format: "esm", platform: "node" });
  return import("data:text/javascript;base64," + Buffer.from(b.outputFiles[0].text).toString("base64"));
})();

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) pass++; else { fail++; console.error("  FAIL:", l); } };
const NOW = 1_700_000_000_000;
const DAY = 86_400_000;

/** A settled, fit-scored reply with real counts (measured tier feedstock). */
const settled = (i, over = {}) => ({
  at: NOW - (i % 20) * DAY,
  author: `acct${i % 4}`,
  score: 0.4 + (i % 5) * 0.1,
  angle: i % 2 ? "value" : "joke",
  source: ["feed", "search", "target", "fresh-reach"][i % 4],
  lane: ["inbound", "continue", "community", "discovery"][i % 4],
  ageMs: i % 2 ? 5 * 60_000 : 2 * 3_600_000, // alternate fresh (<15m) / stale (1-6h)
  followers: 1000,
  norm: `reply number ${i} about shipping`,
  confirmedAt: NOW - (i % 20) * DAY + 60_000,
  confirmation: "rapidapi",
  outcome: { at: NOW, likes: 2 + (i % 5) * 3, replies: i % 3, views: 100 + (i % 5) * 400, tweetId: `t${i}`, frozen: true },
  ...over,
});

// ---- empty log: learning state, missing names the global gate, nothing invented ----
{
  const vm = m.buildOutcomeDashboard([], NOW);
  ok(vm.state === "learning", "empty: state is learning");
  ok(vm.angles.length === 0 && vm.sources.length === 0 && vm.lanes.length === 0 && vm.timing.length === 0 && vm.accountsTop.length === 0, "empty: no rows are invented");
  ok(vm.fit.kind === "waiting" && vm.fit.need === ls.FIT_CORR_MIN_N, "empty: fit read waits, need = imported FIT_CORR_MIN_N");
  ok(vm.missing.some((s) => s.includes(`of ${ls.GLOBAL_THIN} replies logged`)), "empty: missing names the GLOBAL_THIN gate");
  ok(vm.verification.attempted === 0, "empty: verification summary is zeroed");
}

// ---- below GLOBAL_THIN attributed replies: still learning even with some data ----
{
  const sent = Array.from({ length: ls.GLOBAL_THIN - 1 }, (_, i) => ({ at: NOW - i * DAY, author: `a${i}`, score: 0.5, norm: `text ${i}` }));
  const vm = m.buildOutcomeDashboard(sent, NOW);
  ok(vm.state === "learning", "thin: below GLOBAL_THIN attributed → learning");
  ok(vm.attributed === ls.GLOBAL_THIN - 1, "thin: attributed count is exposed");
  ok(vm.missing.some((s) => s.startsWith(`${ls.GLOBAL_THIN - 1} of ${ls.GLOBAL_THIN}`)), "thin: missing states the exact distance");
}

// ---- unattributed replies never count toward the global gate ----
{
  const sent = Array.from({ length: 30 }, (_, i) => ({ at: NOW - i * DAY, score: 0.5 })); // no author
  const vm = m.buildOutcomeDashboard(sent, NOW);
  ok(vm.state === "learning" && vm.attributed === 0, "unattributed: 30 author-less replies stay below the gate");
}

// ---- no confirmations: the empty state says so via replyVerificationSummary ----
{
  const sent = Array.from({ length: 5 }, (_, i) => ({ at: NOW - i * DAY, author: `a${i}`, norm: `text ${i}` }));
  const vm = m.buildOutcomeDashboard(sent, NOW);
  ok(vm.verification.confirmed === 0 && vm.verification.attempted === 5, "unconfirmed: summary counts attempts");
  ok(vm.missing.some((s) => s.includes("0 replies confirmed")), "unconfirmed: missing names the confirm step");
}

// ---- rich log: ready state, gated rows, every row carries n ----
{
  const sent = Array.from({ length: 24 }, (_, i) => settled(i));
  const vm = m.buildOutcomeDashboard(sent, NOW);
  ok(vm.state === "ready", "rich: past the global gate → ready");
  ok(vm.angles.length === 2, "rich: both angles cleared N_MIN_OUT");
  ok(vm.angles.every((a) => a.n >= ls.N_MIN_OUT), "rich: every angle row carries n at/above the gate");
  ok(vm.angles.every((a) => Number.isFinite(a.relPct)), "rich: angle rows carry a finite rel-vs-own-mean");
  ok(vm.sources.length === 4 && vm.sources.every((c) => c.n >= ls.N_MIN_OUT), "rich: discovery-source cohorts are visible only after the settled min-N gate");
  ok(vm.lanes.length === 4 && vm.lanes.every((c) => c.n >= ls.N_MIN_OUT), "rich: recommendation-lane cohorts are visible only after the settled min-N gate");
  ok(vm.timing.length >= 2 && vm.timing.every((t) => t.n >= ls.N_MIN_OUT), "rich: timing buckets gate at N_MIN_OUT");
  ok(vm.timing.every((t) => t.relPct === null || Number.isFinite(t.relPct)), "rich: timing rel is finite or null, never NaN");
  ok(vm.ageGradient != null && vm.ageGradient.freshN >= ls.N_MIN_OUT && vm.ageGradient.staleN >= ls.N_MIN_OUT, "rich: gradient only with both sides gated");
  ok(vm.fit.kind === "measured" && vm.fit.n >= ls.FIT_CORR_MIN_N, "rich: fit read is measured with its n");
  ok(typeof vm.fit.rho === "number" && vm.fit.rho >= -1 && vm.fit.rho <= 1, "rich: rho is a real correlation");
  ok(vm.fit.kind === "measured" && typeof vm.fit.viewRho === "number" && vm.fit.viewN >= ls.FIT_CORR_MIN_N, "rich: distribution alignment is surfaced separately when reply views clear the gate");
  ok(vm.fit.kind === "measured" && vm.fit.tiltEligible && !vm.fit.learningEnabled && !vm.fit.tilting, "rich: an eligible tilt is still reported as inactive while the learning switch is off");
  const enabled = m.buildOutcomeDashboard(sent, NOW, true);
  ok(enabled.fit.kind === "measured" && enabled.fit.learningEnabled && enabled.fit.tiltEligible && enabled.fit.tilting, "rich: the dashboard reports an actual tilt only when both the switch and evidence gate are on");
  ok(vm.accountsTop.length > 0 && vm.accountsTop.every((a) => a.n > 0), "rich: account rows carry reply counts");
  ok(vm.accountsTop.every((a) => a.tier !== "measured" || a.nOut >= ls.N_MIN_OUT), "rich: measured tier only with enough settled outcomes");
  ok(vm.missing.length === 0 || !vm.missing.some((s) => s.includes("replies logged")), "rich: global-gate line gone once passed");
}

// ---- angle below N_MIN_OUT stays invisible (no re-derived thresholds) ----
{
  const sent = Array.from({ length: 24 }, (_, i) => settled(i, { angle: i < ls.N_MIN_OUT - 1 ? "rare" : "value" }));
  const vm = m.buildOutcomeDashboard(sent, NOW);
  ok(!vm.angles.some((a) => a.angle === "rare"), "gate: an angle one short of N_MIN_OUT does not appear");
  ok(vm.angles.some((a) => a.angle === "value"), "gate: the well-sampled angle still ranks");
}

// ---- invest-only accounts: no measured claim, relPct null, tier labeled ----
{
  const sent = Array.from({ length: 15 }, (_, i) => ({ at: NOW - (i % 10) * DAY, author: `inv${i % 3}`, score: 0.6, norm: `text ${i}` }));
  const vm = m.buildOutcomeDashboard(sent, NOW);
  ok(vm.state === "ready", "invest: attributed replies pass the global gate");
  ok(vm.accountsTop.length > 0 && vm.accountsTop.every((a) => a.tier === "invest" && a.relPct === null), "invest: effort-only rows never carry a measured relPct");
  ok(vm.settled === 0 && vm.missing.some((s) => s.includes(`of ${ls.N_MIN_OUT} settled outcomes`)), "invest: missing names the settled-outcome gate");
}

// ---- bottom account only when distinct from the top rows ----
{
  const few = m.buildOutcomeDashboard(Array.from({ length: 15 }, (_, i) => ({ at: NOW - (i % 5) * DAY, author: `a${i % 2}`, score: 0.6, norm: `t${i}` })), NOW);
  ok(few.accountBottom === null, "bottom: 2 ranked accounts → no separate bottom row");
  const many = m.buildOutcomeDashboard(Array.from({ length: 40 }, (_, i) => ({ at: NOW - (i % 10) * DAY, author: `b${i % 6}`, score: 0.3 + (i % 6) * 0.1, norm: `t${i}` })), NOW);
  if (many.accountBottom) {
    ok(!many.accountsTop.some((a) => a.handle === many.accountBottom.handle), "bottom: bottom row is never also a top row");
  } else {
    ok(false, "bottom: 6 well-sampled accounts should yield a bottom row");
  }
}

// ---- single gated timing bucket: shown with n but no relative claim ----
{
  const sent = Array.from({ length: 24 }, (_, i) => settled(i, { ageMs: 5 * 60_000 })); // all fresh
  const vm = m.buildOutcomeDashboard(sent, NOW);
  ok(vm.timing.length === 1 && vm.timing[0].relPct === null, "timing: one bucket → no vs-mean percentage");
  ok(vm.ageGradient === null, "timing: no gradient without a gated stale side");
}

console.log(fail ? `\n${pass} passed, ${fail} FAILED` : `✓ outcome-dashboard: ${pass} tests passed`);
process.exit(fail ? 1 : 0);
