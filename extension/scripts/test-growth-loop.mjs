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

console.log(fail === 0 ? `\n✓ growth loop: ${pass} assertions passed` : `\n✗ growth loop: ${fail} failed, ${pass} passed`);
process.exit(fail === 0 ? 0 : 1);
