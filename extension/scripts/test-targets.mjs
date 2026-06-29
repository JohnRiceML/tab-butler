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
// absolute ceiling protects small users: 12× of 200 = 2400, but the 60k floor lets a genuinely big-but-reachable account in
ok(!m.excludeFromTargets(40000, 4000), "40k vs 4k (10×) stays in-band under the 60k floor");
ok(m.excludeFromTargets(80000, 4000), "80k vs 4k (20×) exceeds the band → excluded");

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
