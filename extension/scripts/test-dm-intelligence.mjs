/** Pure tests for the KISS DM decision and outcome layer. */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as esbuild from "esbuild";
const here = dirname(fileURLToPath(import.meta.url));
const built = esbuild.buildSync({ entryPoints: [join(here, "../src/lib/dm-intelligence.ts")], bundle: true, write: false, format: "esm", platform: "node" });
const m = await import("data:text/javascript;base64," + Buffer.from(built.outputFiles[0].text).toString("base64"));
const dmBuilt = esbuild.buildSync({ entryPoints: [join(here, "../src/lib/dm-workspace.ts")], bundle: true, write: false, format: "esm", platform: "node" });
const dm = await import("data:text/javascript;base64," + Buffer.from(dmBuilt.outputFiles[0].text).toString("base64"));
let pass = 0, fail = 0;
const ok = (c, l) => { if (c) pass++; else { fail++; console.error("  FAIL:", l); } };
const NOW = 1_800_000_000_000, DAY = 86_400_000;

let s = dm.freshDmStore("owner");
const add = (handle, source = "manual", stage = "ready", intent = "connect", goal = "A specific useful reason to start this conversation") => { s = dm.addDmCandidate(s, "owner", { handle, source, stage, intent, goal, reasons: [{ id: `r:${handle}`, label: "Specific context supplied by the user", detail: goal, source: "user", capturedAt: NOW }] }, NOW).store; };
add("active", "relationship"); s = dm.markDmSent(s, "active", "A specific first message for active.", "first", NOW); s = dm.markDmReplied(s, "active", "Their reply", NOW + DAY);
add("due"); s = dm.markDmSent(s, "due", "A specific first message for due.", "first", NOW); 
add("ready");
add("research", "manual", "research", "connect", "short");
const actions = m.rankDmNextActions(s, NOW + 8 * DAY);
ok(actions[0].kind === "reply" && actions[0].handle === "active", "active conversation outranks every acquisition action");
ok(actions[1].kind === "follow_up" && actions[1].handle === "due", "due follow-up ranks after a real reply");
ok(actions.some((x) => x.handle === "ready" && x.kind === "draft_first"), "grounded Ready candidate becomes a draft action");
ok(actions.some((x) => x.handle === "research" && x.kind === "add_context"), "thin research becomes a context action, not outreach");

let metricsStore = dm.freshDmStore("owner");
for (let i = 0; i < 3; i++) {
  metricsStore = dm.addDmCandidate(metricsStore, "owner", { handle: `warm${i}`, source: "relationship", stage: "ready", intent: "connect", reasons: [{ id: `w${i}`, label: "Measured exact relationship evidence", source: "measured", capturedAt: NOW }] }, NOW + i).store;
  metricsStore = dm.markDmSent(metricsStore, `warm${i}`, `Specific warm first message number ${i} with enough unique wording.`, "first", NOW + i * 1000);
  if (i < 2) metricsStore = dm.markDmReplied(metricsStore, `warm${i}`, "Reply", NOW + DAY + i);
}
metricsStore = dm.addDmCandidate(metricsStore, "owner", { handle: "cold", source: "manual", stage: "ready", intent: "sponsor", goal: "A specific sponsorship campaign note", reasons: [{ id: "cold", label: "Specific sponsorship campaign note", source: "user", capturedAt: NOW }] }, NOW).store;
metricsStore = dm.markDmSent(metricsStore, "cold", "Specific sponsor first message with unique wording and context.", "first", NOW + 5000);
const metrics = m.deriveDmMetrics(metricsStore);
ok(metrics.firstSent === 4 && metrics.replied === 2 && metrics.replyRate === 0.5, "funnel uses unique first touches and later inbound replies");
ok(metrics.warmSent === 3 && metrics.warmReplies === 2 && metrics.researchSent === 1, "warm and research cohorts remain separate");
ok(metrics.topIntent?.intent === "connect" && metrics.topIntent.sent === 3, "angle signal requires at least three first touches");
ok(/Connect/.test(metrics.insight) && /2\/3/.test(metrics.insight), "display insight states the sample instead of claiming causation");
ok(metrics.byIntent.find((x) => x.intent === "sponsor")?.sent === 1 && metrics.topIntent?.intent !== "sponsor", "one sponsor message cannot crown an angle");
const candidateSignal = m.candidateDmSignal(metricsStore.candidates.find((x) => x.handle === "warm0"), metrics);
ok(candidateSignal.length === 2 && candidateSignal.some((x) => /Exact relationships/.test(x)), "candidate shows sample-gated angle and people-cohort evidence locally");
metricsStore = dm.updateDmCandidate(metricsStore, "warm0", { intent: "partner" }, NOW + 3 * DAY);
const stableMetrics = m.deriveDmMetrics(metricsStore);
ok(stableMetrics.byIntent.find((x) => x.intent === "connect")?.sent === 3 && !stableMetrics.byIntent.find((x) => x.intent === "partner"), "send-time intent snapshot keeps later CRM edits from rewriting history");

for (let i = 3; i < 5; i++) {
  metricsStore = dm.addDmCandidate(metricsStore, "owner", { handle: `warm${i}`, source: "relationship", stage: "ready", intent: "connect", reasons: [{ id: `w${i}`, label: "Measured exact relationship evidence", source: "measured", capturedAt: NOW }] }, NOW + i).store;
  metricsStore = dm.markDmSent(metricsStore, `warm${i}`, `A new exact relationship message number ${i} with distinct context.`, "first", NOW + i * 1000);
  if (i === 3) metricsStore = dm.markDmReplied(metricsStore, `warm${i}`, "Reply", NOW + DAY + i);
}
const peopleMetrics = m.deriveDmMetrics(metricsStore);
ok(peopleMetrics.topSource?.source === "relationship" && /3\/5/.test(peopleMetrics.peopleInsight || ""), "five first touches unlock a transparent people-source signal with its sample");

console.log(fail === 0 ? `\n✓ dm intelligence: ${pass} assertions passed` : `\n✗ dm intelligence: ${fail} failed, ${pass} passed`);
process.exit(fail === 0 ? 0 : 1);
