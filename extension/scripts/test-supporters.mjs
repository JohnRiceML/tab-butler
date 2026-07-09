/**
 * Unit test for the reciprocity engine (supporters.ts). esbuild → data-URL import.
 * Run: node scripts/test-supporters.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as esbuild from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "../src/lib/supporters.ts"), "utf8");
const js = esbuild.transformSync(src, { loader: "ts", format: "esm" }).code;
const m = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) pass++; else { fail++; console.error("  FAIL:", l); } };
const near = (a, b, l, eps = 1e-9) => ok(Math.abs(a - b) < eps, l + ` (got ${a} vs ${b})`);
const NOW = 1_700_000_000_000;
const DAY = 86_400_000;
const ev = (handle, kind, at, extra = {}) => ({ at, handle, kind, key: `${kind}:${handle}:${at}`, ...extra });

// ---- only reply+mention are scored; like/repost are chips, not scores ----
{
  const inbound = [];
  for (let i = 0; i < 5; i++) inbound.push(ev("alpha", "reply", NOW - i * DAY));
  inbound.push(ev("bravo", "reply", NOW));                 // one-off
  inbound.push(ev("charlie", "like", NOW));                // like ONLY
  inbound.push(ev("delta", "reply", NOW), ev("delta", "reply", NOW - DAY), ev("delta", "like", NOW));
  const sup = m.aggregateSupporters(inbound, NOW);
  ok(sup.supporters.alpha && !sup.supporters.charlie, "a like-only account is NOT a scored supporter");
  ok(sup.supporters.delta.likes === 1 && sup.supporters.delta.replies === 2, "likes are tallied as a chip on a scored supporter, not scored");
  const { ranked, learning } = m.rankSupporters(sup);
  ok(ranked.some((r) => r.handle === "alpha"), "well-sampled supporter is ranked");
  ok(learning.some((r) => r.handle === "bravo") && !ranked.some((r) => r.handle === "bravo"), "a one-off engager → still learning");
}

// ---- reply and mention weigh equally (count-anchored shrinkage) ----
{
  const reps = [], mens = [];
  for (let i = 0; i < 5; i++) { reps.push(ev("r", "reply", NOW - i * DAY)); mens.push(ev("mm", "mention", NOW - i * DAY)); }
  near(m.aggregateSupporters(reps, NOW).supporters.r.support, m.aggregateSupporters(mens, NOW).supporters.mm.support, "reply and mention weigh identically");
}

// ---- fuseMutual: relationship labels + cohort invariance ----
{
  const inbound = [];
  for (let i = 0; i < 5; i++) inbound.push(ev("alpha", "reply", NOW - i * DAY));
  const sup = m.aggregateSupporters(inbound, NOW);
  const invMutual = { accounts: { alpha: { invest: 0.9, nEff: 5 } }, muInvest: 0.5 };
  ok(m.fuseMutual(invMutual, sup).alpha.rel === "mutual", "engages me + I engage them → mutual");
  ok(m.fuseMutual({ accounts: {}, muInvest: 0.5 }, sup).alpha.rel === "fan", "they support me, I don't reciprocate → fan");
  // one-way-you: I invest in someone who never engages me
  const supEmpty = m.aggregateSupporters([], NOW);
  ok(m.fuseMutual({ accounts: { x: { invest: 0.9, nEff: 5 } }, muInvest: 0.5 }, supEmpty).x.rel === "one-way-you", "I show up for them, they don't → one-way-you");
  // cohort invariance: adding an unrelated whale doesn't change alpha's label
  const before = m.fuseMutual(invMutual, sup).alpha.rel;
  const inboundBig = [...inbound]; for (let i = 0; i < 20; i++) inboundBig.push(ev("whale", "reply", NOW, { followers: 500000 }));
  const supBig = m.aggregateSupporters(inboundBig, NOW);
  const invBig = { accounts: { alpha: { invest: 0.9, nEff: 5 }, whale: { invest: 5, nEff: 50 } }, muInvest: 0.5 };
  ok(m.fuseMutual(invBig, supBig).alpha.rel === before, "label is cohort-invariant when a whale joins the cohort");
}

// ---- VOLUME drives support, not follower count (a loyal frequent supporter outranks a rare whale) ----
{
  const inbound = [];
  for (let i = 0; i < 15; i++) inbound.push(ev("loyal", "reply", NOW - i * DAY, { followers: 400 }));
  for (let i = 0; i < 5; i++) inbound.push(ev("bigfan", "reply", NOW - i * DAY, { followers: 9000 }));
  const sup = m.aggregateSupporters(inbound, NOW);
  ok(sup.supporters.loyal.support > sup.supporters.bigfan.support, "15-reply/400-follower loyal OUTSCORES a 5-reply/9k-follower whale (volume drives, not followers)");
  ok(m.rankSupporters(sup).ranked[0].handle === "loyal", "rankSupporters puts the frequent supporter first, not the bigger account");
}

// ---- fuseMutual labels are invariant to the invest cohort MEAN (fixed ref, not the live mean) ----
{
  const inbound = [];
  for (let i = 0; i < 8; i++) inbound.push(ev("pair", "reply", NOW - i * DAY, { followers: 3000 }));
  const sup = m.aggregateSupporters(inbound, NOW);
  const inv = (mu) => ({ accounts: { pair: { invest: 0.55, nEff: 5 } }, muInvest: mu });
  const relLo = m.fuseMutual(inv(0.5), sup).pair.rel;
  const relHi = m.fuseMutual(inv(0.6), sup).pair.rel;
  ok(relLo === relHi, `label invariant to the invest cohort mean (muInvest 0.5 vs 0.6 → same: ${relLo}/${relHi})`);
}

// ---- reciprocal-ring (pod) detector ----
{
  const inb = [ev("m0", "reply", NOW), ev("m1", "reply", NOW), ev("m2", "reply", NOW)];
  const ring = m.reciprocalConcentration(inb, ["m0", "m1", "m0", "m1", "x1", "x2", "x3", "x4"], NOW);
  ok(ring && ring.count === 4 && Math.abs(ring.pct - 0.5) < 1e-9, "a closed loop (≥40% of recent replies to supporters) → ring detected");
  ok(m.reciprocalConcentration(inb, ["a", "b", "c", "d", "e", "f", "g", "h"], NOW) === null, "well-spread replies → no ring");
}

console.log(fail === 0 ? `\n✓ supporters: ${pass} assertions passed` : `\n✗ supporters: ${fail} failed, ${pass} passed`);
process.exit(fail === 0 ? 0 : 1);
