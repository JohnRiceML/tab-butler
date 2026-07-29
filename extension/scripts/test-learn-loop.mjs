/**
 * Pure guard for the closed-loop RANKING multiplier — accountRankMultipliers in
 * src/lib/learn-stats.ts. Proves the three safety properties the feature rests on:
 *   1. it stays OFF (applied=false) when the ranking isn't predictive (fitCorr null or <=0),
 *   2. a proven-strong account tilts up and a proven-weak one tilts down, both CLAMPED,
 *   3. an account without a SETTLED measured score is omitted → caller reads a neutral 1.0.
 * esbuild → data-URL import. Run: node scripts/test-learn-loop.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as esbuild from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "../src/lib/learn-stats.ts"), "utf8");
const js = esbuild.transformSync(src, { loader: "ts", format: "esm" }).code;
const m = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));
const { accountRankMultipliers, LEARN_MULT_MIN, LEARN_MULT_MAX } = m;

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) pass++; else { fail++; console.error("  FAIL:", l); } };
const NOW = 1_700_000_000_000, DAY = 86_400_000;

// reply with a settled measured outcome; `q` drives likes (the account's measured fit) and
// `scoreCorr` decides whether stage-1 score tracks (positive fitCorr) or fights (negative) it.
const rep = (i, author, q, scoreCorr = true) => ({
  at: NOW - (30 - i * 0.5) * DAY, author, angle: "reply",
  score: scoreCorr ? q : 1 - q, ageMs: 20 * 60_000, followers: 1000,
  confirmation: "rapidapi",
  outcome: { at: NOW - (28 - i * 0.5) * DAY, likes: Math.round(q * 30), replies: Math.round(q * 3), views: Math.round(q * 1000), tweetId: `tweet-${author}-${i}`, frozen: true },
});

// ---- proven dataset: alice strong, bob weak, score tracks fit (fitCorr > 0) ----
{
  const sent = [];
  for (let i = 0; i < 8; i++) sent.push(rep(i, "alice", 0.8));
  for (let i = 0; i < 8; i++) sent.push(rep(i, "bob", 0.2));
  for (let i = 0; i < 2; i++) sent.push(rep(i, "carol", 0.6)); // only 2 settled → below N_MIN_OUT
  const { applied, mult } = accountRankMultipliers(sent, NOW);
  ok(applied === true, "applied when the ranking is predictive (fitCorr > 0)");
  ok(mult.alice > 1 && mult.alice <= LEARN_MULT_MAX, `strong account tilts UP within cap (alice=${mult.alice?.toFixed(3)})`);
  ok(mult.bob < 1 && mult.bob >= LEARN_MULT_MIN, `weak account tilts DOWN within cap (bob=${mult.bob?.toFixed(3)})`);
  ok(mult.alice > mult.bob, "strong ranks above weak");
  ok(!("carol" in mult), "account below the settled-outcome gate is omitted → neutral 1.0 at the call site");
}

// ---- behavior-changing path excludes provisional/manual/unknown-context outcomes ----
{
  const good = rep(1, "@Alice", 0.8);
  ok(m.isActionGradeReply(good), "settled RapidAPI-proven row with reach + score is action-grade");
  ok(!m.isActionGradeReply({ ...good, confirmation: "manual", outcome: { ...good.outcome, tweetId: undefined } }), "manual confirmation cannot reorder opportunities");
  ok(!m.isActionGradeReply({ ...good, outcome: { ...good.outcome, frozen: false } }), "provisional outcome cannot reorder opportunities");
  ok(!m.isActionGradeReply({ ...good, followers: undefined }), "unknown reach cannot enter behavior-changing normalization");
  const mixed = [];
  for (let i = 0; i < 8; i++) mixed.push(rep(i, i % 2 ? "Alice" : "@ALICE", 0.8));
  for (let i = 0; i < 8; i++) mixed.push(rep(i, "Bob", 0.2));
  const { mult } = accountRankMultipliers(mixed, NOW);
  ok(mult.alice > 1 && !("Alice" in mult) && !("@ALICE" in mult), "account keys are canonicalized across casing and leading @");
}

// ---- anti-correlated: stage-1 score FIGHTS outcomes → fitCorr < 0 → tilt NOTHING ----
{
  const sent = [];
  for (let i = 0; i < 8; i++) sent.push(rep(i, "alice", 0.8, false));
  for (let i = 0; i < 8; i++) sent.push(rep(i, "bob", 0.2, false));
  const { applied, mult } = accountRankMultipliers(sent, NOW);
  ok(applied === false && Object.keys(mult).length === 0, "does NOT tilt when the ranking is anti-predictive (never amplify noise)");
}

// ---- thin data: fewer than FIT_CORR_MIN_N measured pairs → fitCorr undefined → OFF ----
{
  const sent = [];
  for (let i = 0; i < 5; i++) sent.push(rep(i, "alice", 0.8));
  const { applied, mult } = accountRankMultipliers(sent, NOW);
  ok(applied === false && Object.keys(mult).length === 0, "stays OFF on thin data (fitCorr can't be computed)");
}

// ---- clamp holds under an extreme ratio ----
{
  const sent = [];
  for (let i = 0; i < 10; i++) sent.push(rep(i, "whale", 0.99)); // huge fit
  for (let i = 0; i < 10; i++) sent.push(rep(i, "dud", 0.01));   // ~zero fit
  const { mult } = accountRankMultipliers(sent, NOW);
  ok(mult.whale <= LEARN_MULT_MAX + 1e-9 && mult.dud >= LEARN_MULT_MIN - 1e-9, `extremes stay clamped (whale=${mult.whale?.toFixed(3)}, dud=${mult.dud?.toFixed(3)})`);
}

console.log(fail === 0 ? `\n✓ learn-loop: ${pass} assertions passed` : `\n✗ learn-loop: ${fail} failed, ${pass} passed`);
process.exit(fail === 0 ? 0 : 1);
