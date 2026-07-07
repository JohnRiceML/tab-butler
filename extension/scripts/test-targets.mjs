/**
 * Unit test for the "Target accounts" pure logic (targets.ts). esbuild → data-URL import.
 * Run: node scripts/test-targets.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as esbuild from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "../src/lib/targets.ts"), "utf8");
const js = esbuild.transformSync(src, { loader: "ts", format: "esm" }).code;
const m = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) pass++; else { fail++; console.error("  FAIL:", l); } };
const NOW = 1_700_000_000_000;
const MIN = 60_000;

// ---- membership gate: reachable sweet spot, no untouchable megas ----
ok(!m.excludeFromTargets(5000, 1000), "5× a 1k account is in-band (kept)");
ok(m.excludeFromTargets(2_000_000, 1000), "a 2M mega vs a 1k account is excluded");
ok(m.excludeFromTargets(undefined, 1000) && m.excludeFromTargets(5000, 0), "unclassifiable (no followers either side) is excluded");
ok(m.inReachBand(5000, 1000) && !m.inReachBand(1200, 1000), "in-reach needs >=2× and within the ceiling");
// the reach band SCALES with your size (sub-1K tighter, established wider) — protects small users from buried replies
ok(!m.excludeFromTargets(4000, 500) && m.excludeFromTargets(6500, 500), "sub-1k user (500): 8× kept, 13× cut (band ~10×)");
ok(!m.excludeFromTargets(75000, 5000) && m.excludeFromTargets(110000, 5000), "5k user: 15× kept, 22× cut (band ~18×)");
ok(!m.excludeFromTargets(480000, 20000) && m.excludeFromTargets(640000, 20000), "20k user: 24× kept, 32× cut (band ~25×)");
ok(m.excludeFromTargets(600000, 50000), "a 600k account is an absolute mega (MEGA_CAP) even at 12× → excluded");
ok(m.bandHiFor(500) === 10 && m.bandHiFor(5000) === 18 && m.bandHiFor(50000) === 25, "bandHiFor tiers by user size");

// ---- reach multiple label ----
ok(m.reachMultipleLabel(7000, 1000) === "7.0× your size", "labels a 7× account");
ok(m.reachMultipleLabel(1200, 1000) === null, "no label when barely bigger");

// ---- CRUD: dedupe, cap, normalize ----
{
  let s = m.freshStore("me");
  s = m.addTarget(s, "@BigAcct", 5000, "manual", NOW).store;
  ok(s.targets.length === 1 && s.targets[0].handle === "bigacct", "add normalizes the handle (no @, lowercase)");
  const dup = m.addTarget(s, "bigacct", 5000, "manual", NOW);
  ok(dup.error && dup.store.targets.length === 1, "adding a dupe is rejected");
  s = m.removeTarget(s, "@bigacct");
  ok(s.targets.length === 0, "remove works regardless of @ / case");
  // cap
  let big = m.freshStore("me");
  for (let i = 0; i < m.TARGET_CAP; i++) big = m.addTarget(big, "acct" + i, 5000, "manual", NOW).store;
  const over = m.addTarget(big, "onemore", 5000, "manual", NOW);
  ok(over.error && over.store.targets.length === m.TARGET_CAP, "the cap blocks the 21st target");
}

// ---- freshness window ----
ok(m.freshnessLabel(NOW - 4 * MIN, NOW).live === true, "a 4-min-old post is live (reply now)");
ok(m.freshnessLabel(NOW - 45 * MIN, NOW).live === false, "a 45-min-old post is past the window");
ok(m.freshnessLabel(undefined, NOW) === null, "no timestamp → no freshness label");

// ---- early/buried pile-up read (the free competition signal from the fetched post) ----
ok(m.earlyLabel(2, NOW - 4 * MIN, NOW)?.level === "early", "fresh + 2 replies → early (high-impression window)");
ok(m.earlyLabel(0, NOW - 2 * MIN, NOW)?.level === "early", "zero replies on a live post is the best slot");
ok(m.earlyLabel(2, NOW - 45 * MIN, NOW) === null, "few replies but past the live window → no early claim");
ok(m.earlyLabel(45, NOW - 4 * MIN, NOW)?.level === "crowded", "45 replies → buried even while fresh");
ok(m.earlyLabel(45, NOW - 300 * MIN, NOW)?.level === "crowded", "crowded applies at any age");
ok(m.earlyLabel(12, NOW - 4 * MIN, NOW) === null, "mid pile-up (between thresholds) says nothing");
ok(m.earlyLabel(undefined, NOW - 4 * MIN, NOW) === null, "unknown reply count → no claim (honest-mirror)");

// ---- reply-surface realism: graded (low_blast_radius) vs relationship-only ----
ok(m.gradedSurface(50000) === "graded", "a 50k root clears the reply-grader threshold → graded (OON reach possible)");
ok(m.gradedSurface(200) === "relationship", "a 200-follower root is relationship-only (reply ~invisible to For You)");
ok(m.gradedSurface(1500) === "unknown", "the borderline band is genuinely uncertain (threshold redacted) → no claim");
ok(m.gradedSurface(undefined) === "unknown", "unknown root size → unknown (honest-mirror)");
ok(m.surfaceLabel("graded")?.includes("travel past") && m.surfaceLabel("relationship")?.includes("relationship"), "surface labels are honest one-liners");
ok(m.surfaceLabel("unknown") === null, "no label for unknown/borderline — say nothing");
ok(m.surfaceMult("relationship") === 0.85 && m.surfaceMult("graded") === 1 && m.surfaceMult("unknown") === 1, "relationship spots get a mild reach demotion; never zeroed");

// ---- dedup-slot odds: one reply per conversation reaches For You ----
ok(m.slotOdds(0) === 1 && m.slotOdds(m.EARLY_MAX_REPLIES) === 1, "an empty/near-empty thread is a wide-open slot");
ok(m.slotOdds(15) === 0.7, "a contested thread (6..29 replies) — reduced odds");
ok(m.slotOdds(50) === 0.45 && m.slotOdds(500) === 0.3, "a crowded thread's slot is likely/effectively taken");
ok(m.slotOdds(undefined) === 1, "unknown reply count → neutral (never penalize for missing data)");
ok(m.slotOdds(3) >= m.slotOdds(15) && m.slotOdds(15) >= m.slotOdds(50), "odds are monotonic in crowding");

// ---- poll-batch invariant: <=N per open, oldest-polled first, TTL-skipped ----
{
  const targets = [
    { handle: "a", lastPolledAt: NOW - 20 * MIN },
    { handle: "b", lastPolledAt: NOW - 1 * MIN },   // within 12-min TTL → skipped
    { handle: "c" },                                 // never polled → eligible, oldest-priority
    { handle: "d", lastPolledAt: NOW - 30 * MIN },
  ];
  const batch = m.selectPollBatch(targets, NOW, 2);
  ok(batch.length === 2, "respects the per-open cap");
  ok(batch.every((t) => t.handle !== "b"), "skips a target polled inside the TTL");
  ok(batch[0].handle === "c", "never-polled target is highest priority");
}

console.log(fail === 0 ? `\n✓ targets: ${pass} assertions passed` : `\n✗ targets: ${fail} failed, ${pass} passed`);
process.exit(fail === 0 ? 0 : 1);
