/**
 * Unit test for the warm-up/momentum model (momentum.ts). Transpiled with esbuild +
 * imported from a data URL. Run: node scripts/test-momentum.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as esbuild from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "../src/lib/momentum.ts"), "utf8");
const js = esbuild.transformSync(src, { loader: "ts", format: "esm" }).code;
const mod = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));
const { computeMomentum } = mod;

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) pass++; else { fail++; console.error("  FAIL:", l); } };
const eq = (a, b, l) => { if (a === b) pass++; else { fail++; console.error("  FAIL:", l, "got", a, "want", b); } };

const idle = { repliesToday: 0, postedToday: 0, replyStreak: 0, minsSinceLast: 9999, repLevel: "healthy" };
ok(computeMomentum(idle).state === "cold", "no activity -> cold");
ok(computeMomentum(idle).score <= 14, "cold score is low");

// Safety keystone: past the ease-off line it is ALWAYS overheating + low, never max.
const hot = computeMomentum({ repliesToday: 8, postedToday: 2, replyStreak: 7, minsSinceLast: 1, repLevel: "easeoff" });
ok(hot.state === "overheating", "easeoff -> overheating regardless of activity");
ok(hot.score <= 60, "overheating score is capped low, not 100");
ok(hot.color === "#d6604a", "overheating is red");

// Peak is reachable ONLY at a healthy pace.
const peak = computeMomentum({ repliesToday: 8, postedToday: 2, replyStreak: 7, minsSinceLast: 1, repLevel: "healthy" });
ok(peak.state === "peak", "full healthy day -> peak");
ok(peak.score >= 75, "peak score is high");
ok(peak.color === "#6fcf7f", "peak is the healthy green");

// Caution can never reach Peak, and must AGREE with the amber pace chip (not green "sweet spot").
const caution = computeMomentum({ repliesToday: 8, postedToday: 2, replyStreak: 7, minsSinceLast: 1, repLevel: "caution" });
ok(caution.state !== "peak" && caution.state !== "overheating", "caution sits below peak (inflow)");
ok(caution.score <= 74, "caution capped below the peak band");
ok(caution.color === "#e89a3c", "caution is the chip's amber, not the healthy green");
ok(/ease off/i.test(caution.cue), "caution cue nudges the pace down");

// Volume saturates — more replies past the target does NOT raise the score.
const at8 = computeMomentum({ ...idle, repliesToday: 8, minsSinceLast: 1 }).score;
const at25 = computeMomentum({ ...idle, repliesToday: 25, minsSinceLast: 1 }).score;
eq(at8, at25, "volume saturates past the daily target (more != higher)");

// States across the curve.
ok(computeMomentum({ ...idle, repliesToday: 2, replyStreak: 1, minsSinceLast: 5 }).state === "warming", "light + live -> warming");
ok(computeMomentum({ repliesToday: 5, postedToday: 1, replyStreak: 2, minsSinceLast: 40, repLevel: "healthy" }).state === "cooling", "had momentum but idle -> cooling");

console.log(fail === 0 ? `\n✓ momentum: ${pass} assertions passed` : `\n✗ momentum: ${fail} failed, ${pass} passed`);
process.exit(fail === 0 ? 0 : 1);
