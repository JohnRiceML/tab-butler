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

// ---- daily-shape coach: the BALANCE of the day, safety-deferent ----
const { dailyShape, postSpacingNudge, POST_SPACING_MINS } = mod;
ok(dailyShape({ repliesToday: 8, postedToday: 2, repLevel: "easeoff" }) === null, "ease-off -> daily coach stays silent (safety copy owns it)");
ok(dailyShape({ repliesToday: 0, postedToday: 0, repLevel: "healthy" }).kind === "warmup", "quiet day -> warm-up nudge");
{
  const s = dailyShape({ repliesToday: 14, postedToday: 0, repLevel: "healthy" });
  ok(s.kind === "balance" && /mix in one original/i.test(s.text), "lots of replies, no post -> nudge an original");
}
{
  const s = dailyShape({ repliesToday: 2, postedToday: 1, repLevel: "healthy" });
  ok(s.kind === "balance" && /bigger threads/i.test(s.text), "posted but few replies -> nudge bigger threads");
}
ok(dailyShape({ repliesToday: 12, postedToday: 1, repLevel: "healthy" }).text.includes("Balanced day"), "replies + a post -> balanced-day affirmation");
{
  const s = dailyShape({ repliesToday: 5, postedToday: 4, repLevel: "healthy" });
  ok(s.kind === "spacing" && /space originals ~3h apart/i.test(s.text), "4 posts -> spacing nudge names the ~3h gap (author-diversity attenuation)");
  ok(/replies between originals are fine/i.test(s.text), "spacing nudge notes replies between originals don't compete the same way");
  ok(/consistency beats volume/i.test(s.text), "spacing nudge carries the high-frequency reach tradeoff (correlational)");
}
// safety-deference: at caution it NEVER pushes more replies — only redirects to a post
ok(dailyShape({ repliesToday: 3, postedToday: 1, repLevel: "caution" }) === null, "caution + mid-warmup -> silence, never 'do more replies'");
{
  const s = dailyShape({ repliesToday: 15, postedToday: 0, repLevel: "caution" });
  ok(s && /switch to an original/i.test(s.text) && !/bigger threads/i.test(s.text), "caution + many replies -> redirect to a post, not more replies");
}
ok(dailyShape({ repliesToday: 4, postedToday: 0, repLevel: "healthy" }) === null, "mid-warmup with nothing distinctive -> silence (meter cue covers it)");

// ---- post-spacing nudge: soft, never a block, reads only own-post recency ----
ok(POST_SPACING_MINS === 180, "spacing threshold is ~3h");
ok(postSpacingNudge(undefined) === null, "no known last-post time -> no nudge");
ok(postSpacingNudge(-5) === null, "nonsense negative recency -> no nudge");
ok(postSpacingNudge(200) === null, "posted 3h+ ago -> clear to post, no nudge");
ok(postSpacingNudge(POST_SPACING_MINS) === null, "exactly at the ~3h line -> clear");
{
  const n = postSpacingNudge(30);
  ok(n && n.soft === true, "recent original -> soft nudge (never a block)");
  ok(n.minsToGo === 150, "minsToGo counts down to the ~3h line");
  ok(/replies in between are fine/i.test(n.text), "nudge reassures that replies between originals don't compete");
  ok(/compete for one feed slot/i.test(n.text), "nudge names the author-diversity attenuation mechanism");
}

console.log(fail === 0 ? `\n✓ momentum: ${pass} assertions passed` : `\n✗ momentum: ${fail} failed, ${pass} passed`);
process.exit(fail === 0 ? 0 : 1);
