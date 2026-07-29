/** Unit tests for the account-level growth experiment loop. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as esbuild from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "../src/lib/growth-loop.ts"), "utf8");
const js = esbuild.transformSync(src, { loader: "ts", format: "esm" }).code;
const m = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));
let pass = 0, fail = 0;
const ok = (c, l) => { if (c) pass++; else { fail++; console.error("  FAIL:", l); } };
const DAY = 86_400_000, NOW = 1_700_000_000_000;
const day = (at) => new Date(at).toISOString().slice(0, 10);

let store = m.freshGrowthStore("@Me");
ok(store.ownerHandle === "me", "store is owner-scoped and canonicalized");
for (let i = 28; i >= 0; i--) {
  const at = NOW - i * DAY;
  const inCurrent = i < 14;
  const follower = 100 + (28 - i) + (inCurrent ? (14 - i) : 0);
  store = m.captureGrowthSnapshot(store, "me", at, day(at), follower, [{ id: `p${i}`, day: day(at), postedAt: at, views: inCurrent ? 220 : 100, likes: inCurrent ? 16 : 8, reposts: 2, replies: 2 }]);
}
const recent = m.summarizeGrowthWindow(store, NOW - 13 * DAY, NOW);
ok(recent.posts === 14 && recent.viewsPerPost === 220, "window uses real post dates and measured outcomes");
ok(recent.followerDelta > 13, "window computes observed follower growth");

const started = NOW - 14 * DAY;
let start = m.startGrowthExperiment(store, "proof", started);
ok(!start.error && start.experiment?.strategyId === "proof", "starts one explicit strategy test");
ok(m.startGrowthExperiment(start.store, "builder", started + DAY).error, "cannot overlap strategy tests");
const actions = [
  { at: started + DAY, experimentId: start.experiment.id, strategyId: "proof", kind: "post", confirmed: true },
  { at: started + 3 * DAY, experimentId: start.experiment.id, strategyId: "proof", kind: "post", confirmed: true },
  { at: started + 2 * DAY, experimentId: start.experiment.id, strategyId: "proof", kind: "reply", confirmed: true },
];
const ev = m.evaluateGrowthExperiment(start.store, start.experiment, actions, NOW);
ok(ev.ready && ev.decision === "double-down", "a materially stronger comparable window recommends another run");
ok(ev.taggedPosts === 2 && ev.taggedReplies === 1, "strategy adherence uses actions stamped at ship time");
ok(ev.reasons.every((r) => r.includes("%")), "explanation exposes measured window changes");

const settled = m.settleGrowthExperiments(start.store, actions, NOW + DAY);
ok(settled.settled === 1 && settled.store.experiments[0].status === "completed", "due experiments settle automatically");
ok(m.recommendedGrowthStrategy(settled.store).id === "proof", "promising result recommends the same strategic bet");

let falling = m.freshGrowthStore("me");
for (let i = 28; i >= 0; i--) {
  const at = NOW - i * DAY, currentWindow = i < 14;
  falling = m.captureGrowthSnapshot(falling, "me", at, day(at), 200 + (28 - i) - (currentWindow ? (14 - i) : 0), [{ id: `f${i}`, day: day(at), postedAt: at, views: currentWindow ? 70 : 220, likes: currentWindow ? 3 : 15, reposts: 1, replies: 1 }]);
}
const fallingStart = m.startGrowthExperiment(falling, "operator", started);
const fallingActions = [1, 2].map((i) => ({ at: started + i * DAY, experimentId: fallingStart.experiment.id, strategyId: "operator", kind: "post", confirmed: true }));
const fallingEval = m.evaluateGrowthExperiment(fallingStart.store, fallingStart.experiment, fallingActions, NOW);
ok(fallingEval.ready && fallingEval.decision === "switch", "a materially weaker completed window recommends shaking up the strategy");
ok(fallingEval.nextStrategyId !== "operator", "switch verdict selects an untried strategic bet");

const unexecuted = m.evaluateGrowthExperiment(start.store, start.experiment, [], NOW);
ok(!unexecuted.ready && !unexecuted.executionReady && unexecuted.decision === "collect", "ambient growth cannot award an unexecuted strategy");
ok(unexecuted.reasons[0].includes("Execution recorded"), "thin execution has an actionable explanation");

let thin = m.freshGrowthStore("me");
const thinStart = m.startGrowthExperiment(thin, "operator", NOW).experiment;
const thinEval = m.evaluateGrowthExperiment(thin, thinStart, [], NOW + 3 * DAY);
ok(!thinEval.ready && thinEval.decision === "collect", "thin/young windows never manufacture a verdict");
ok(thinEval.reasons[0].includes("Open Goobi") || thinEval.headline.includes("collecting"), "thin state tells the user how data appears");

const a = m.captureGrowthSnapshot(m.freshGrowthStore("me"), "me", NOW, day(NOW), 123, [{ id: "same", day: day(NOW), postedAt: NOW, views: 10 }]);
const b = m.captureGrowthSnapshot(m.freshGrowthStore("me"), "me", NOW + 1, day(NOW), 124, [{ id: "same", day: day(NOW), postedAt: NOW, views: 25 }]);
const merged = m.mergeGrowthStores(a, b, "me", NOW + 1);
ok(merged.days[day(NOW)].followers === 124 && merged.days[day(NOW)].posts.same.views === 25, "cross-tab merge keeps newest follower and max post metrics");
const zero = m.captureGrowthSnapshot(m.freshGrowthStore("me"), "me", NOW, day(NOW), 10, [{ id: "zero", day: day(NOW), postedAt: NOW, views: 0, likes: 0, reposts: 0, replies: 0 }]);
ok(zero.days[day(NOW)].posts.zero.views === 0 && m.summarizeGrowthWindow(zero, NOW - 1, NOW + 1).measuredPosts === 1, "zero-view posts remain measured instead of disappearing from the denominator");
ok(m.mergeGrowthStores(a, b, "other", NOW).ownerHandle === "other" && Object.keys(m.mergeGrowthStores(a, b, "other", NOW).days).length === 0, "account switch never leaks growth history");

ok(m.recommendedGrowthStrategy(m.freshGrowthStore("me"), true).id === "proof", "profile proof gap makes proof-led authority the cold-start test");
ok(m.GROWTH_STRATEGIES.length === 5 && new Set(m.GROWTH_STRATEGIES.map((s) => s.id)).size === 5, "strategy catalog is small and distinct");

/* ---------- profile-change experiments: a METHOD, never a number ---------- */
const CH = NOW - 14 * DAY; // the declared change moment: 14 observed days before, 15 after
let pstore = m.freshGrowthStore("me");
for (let i = 28; i >= 0; i--) {
  const at = NOW - i * DAY, afterChange = at >= CH;
  pstore = m.captureGrowthSnapshot(pstore, "me", at, day(at), afterChange ? 114 + 2 * (14 - i) : 100 + (28 - i), [{ id: `pcp${i}`, day: day(at), postedAt: at, views: afterChange ? 300 : 150, likes: afterChange ? 9 : 4, reposts: 1, replies: 1 }]);
}
ok(m.declareProfileChange(pstore, "bio", NOW + DAY, NOW).error, "a future change date is refused");
const d1 = m.declareProfileChange(pstore, "bio", CH, NOW - 13 * DAY);
ok(!d1.error && d1.experiment?.variable === "bio", "declares the one changed variable");
const d2 = m.declareProfileChange(d1.store, "banner", NOW - 10 * DAY, NOW - 10 * DAY);
ok(!!d2.error && d2.conflictId === d1.experiment.id, "a second change during a running read is refused and names the conflict");

const pcRead = m.readProfileChange(d1.store, d1.experiment, NOW);
ok(pcRead.state === "read", "a fully observed window produces a read");
ok(pcRead.lines[0] === "followers/day: 1.0 before → 2.0 after (✓ measured, n=14d / 15d observed)", "the follower read is a labeled before→after pair");
ok(pcRead.lines.length === 3 && pcRead.lines[1].startsWith("views/post: 150.0 before → 300.0 after") && pcRead.lines[2].startsWith("eng/post: 6.0 before → 11.0 after"), "post outcomes ride along only when measured on both sides");
const pcText = [pcRead.headline, ...pcRead.lines, ...pcRead.caveats].join(" ");
ok(pcText.includes("correlation, not causation"), "the read names its single-subject design limit");
ok(!pcText.includes("%") && !/\bproof\b|\bproves\b/i.test(pcText), "no percentage targets and no proof claims anywhere in the read");
ok(pcRead.caveats.some((c) => c.includes("Profile visits")), "the missing profile-visit metric is declared, never proxied");

const early = m.readProfileChange(d1.store, d1.experiment, CH + 3 * DAY);
ok(early.state === "collecting" && early.lines.length === 0, "a young window shows no numbers");
ok(early.headline.includes("day 4 of 14"), "collecting names how far the window has run");

let thinBase = m.freshGrowthStore("me");
for (let i = 18; i >= 0; i--) { const at = NOW - i * DAY; thinBase = m.captureGrowthSnapshot(thinBase, "me", at, day(at), 100 + i, []); }
const thinDecl = m.declareProfileChange(thinBase, "pin", CH, NOW - 13 * DAY);
const thinRead = m.readProfileChange(thinDecl.store, thinDecl.experiment, NOW);
ok(thinRead.state === "unreadable" && thinRead.lines.length === 0, "a thin baseline never yields numbers");
ok(thinRead.headline.includes("4 of 14"), "the thin baseline says exactly how much was observed");

let thinAfter = m.freshGrowthStore("me");
for (let i = 28; i >= 12; i--) { const at = NOW - i * DAY; thinAfter = m.captureGrowthSnapshot(thinAfter, "me", at, day(at), 100, []); }
const taDecl = m.declareProfileChange(thinAfter, "banner", CH, NOW - 13 * DAY);
ok(m.readProfileChange(taDecl.store, taDecl.experiment, NOW).state === "unreadable", "a thin after-window ends honest, not guessed");
ok(m.readProfileChange(taDecl.store, taDecl.experiment, CH + 5 * DAY).state === "collecting", "the same window merely collects while it can still fill");

const voided = m.invalidateProfileChange(d1.store, d1.experiment.id, "changed bio AND banner", NOW - 5 * DAY);
const vRead = m.readProfileChange(voided, voided.profileChanges.find((p) => p.id === d1.experiment.id), NOW);
ok(vRead.state === "invalidated" && vRead.lines.length === 0, "multi-change voids the read instead of pretending");
ok(!m.activeProfileChange(voided), "a voided read frees the single-experiment slot");
ok(!m.declareProfileChange(voided, "banner", NOW - 2 * DAY, NOW).error, "the next single change can be logged after voiding");

const settledPc = m.settleProfileChanges(d1.store, NOW + DAY);
ok(settledPc.settled === 1 && settledPc.store.profileChanges[0].status === "completed" && settledPc.store.profileChanges[0].outcome?.state === "read", "finished windows freeze their outcome");
ok(m.settleProfileChanges(d1.store, CH + 5 * DAY).settled === 0, "running windows never settle early");

const pcMergedNew = m.invalidateProfileChange(d1.store, d1.experiment.id, "note", NOW + 2);
const pcMerged = m.mergeGrowthStores(d1.store, pcMergedNew, "me", NOW + 3);
ok(pcMerged.profileChanges.length === 1 && pcMerged.profileChanges[0].status === "invalidated", "cross-tab merge keeps the newest profile-change record");
ok((m.mergeGrowthStores(d1.store, pcMergedNew, "other", NOW).profileChanges ?? []).length === 0, "account switch never leaks profile-change history");

const withBet = m.startGrowthExperiment(d1.store, "proof", CH + DAY).store;
ok(m.readProfileChange(withBet, d1.experiment, NOW).caveats.some((c) => c.includes("content-strategy test")), "an overlapping strategy bet is named as another moving part");

console.log(fail === 0 ? `\n✓ growth loop: ${pass} assertions passed` : `\n✗ growth loop: ${fail} failed, ${pass} passed`);
process.exit(fail === 0 ? 0 : 1);
