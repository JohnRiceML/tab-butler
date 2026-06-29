/**
 * Unit test for the auto-suggest ranking (suggest-targets.ts). esbuild → data-URL import.
 * Run: node scripts/test-suggest-targets.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as esbuild from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "../src/lib/suggest-targets.ts"), "utf8");
const js = esbuild.transformSync(src, { loader: "ts", format: "esm" }).code;
const m = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) pass++; else { fail++; console.error("  FAIL:", l); } };
const ME = 1000;

// ---- missing signals are neutral (1.0), never a penalty ----
{
  const bare = { handle: "a", followers: 3000 }; // ratio 3 (<5), everything else absent
  ok(Math.abs(m.suggestionScore(bare, ME) - 1.0) < 1e-9, "a bare candidate scores exactly 1.0 (no penalty for missing data)");
  const sweet = { handle: "b", followers: 8000 }; // ratio 8 (>=5) → reachFit bump only
  ok(Math.abs(m.suggestionScore(sweet, ME) - 1.08) < 1e-9, "sweet-spot reach is the only Tier-A bump");
}

// ---- each enriched factor moves the score the right way ----
{
  const base = { handle: "x", followers: 8000 };
  ok(m.suggestionScore({ ...base, bioTier: 2 }, ME) > m.suggestionScore(base, ME), "niche-match raises the score");
  ok(m.suggestionScore({ ...base, following: 100 }, ME) < m.suggestionScore(base, ME), "a broadcaster (low follow-back) is dinged");
  ok(m.suggestionScore({ ...base, following: 9000 }, ME) > m.suggestionScore(base, ME), "a two-way account is boosted");
  ok(m.suggestionScore({ ...base, engRate: 0.08 }, ME) > m.suggestionScore({ ...base, engRate: 0.002 }, ME), "high engagement-rate outranks low");
  ok(m.suggestionScore({ ...base, learnedMult: 1.15 }, ME) > m.suggestionScore({ ...base, learnedMult: 0.9 }, ME), "a measured good history outranks a bad one");
}

// ---- ranking: sorts desc, drops dismissed, caps ----
{
  const cands = [
    { handle: "lo", followers: 2200 },                 // ratio 2.2, score 1.0
    { handle: "hi", followers: 9000, bioTier: 2 },      // sweet + niche → highest
    { handle: "mid", followers: 9000 },                 // sweet only
    { handle: "skip", followers: 9000, bioTier: 2 },    // would rank but dismissed
  ];
  const ranked = m.rankSuggestions(cands, ME, new Set(["skip"]), 5);
  ok(ranked[0].handle === "hi", "the strongest candidate ranks first");
  ok(!ranked.some((r) => r.handle === "skip"), "a dismissed handle is dropped");
  ok(m.rankSuggestions(cands, ME, new Set(), 2).length === 2, "respects the max cap");
}

// ---- honest reasons ----
{
  ok(m.suggestionReason({ handle: "a", followers: 6000 }, ME) === "~6× your size", "size reason is banded, not raw");
  const r = m.suggestionReason({ handle: "b", followers: 9000, following: 9000, bioTier: 2, engRate: 0.06, learnedMult: 1.1 }, ME);
  ok(/two-way account/.test(r) && !/replies to people/.test(r), "openness is described as a follow-graph shape, never inferred reply behavior");
  ok(/in your niche/.test(r) && /hit big/.test(r) && /your replies here have done well/.test(r), "all earned clauses appear (engagement reads as 'posts that hit big', not 'typical')");
  ok(!/two-way/.test(m.suggestionReason({ handle: "c", followers: 9000 }, ME)), "openness clause is omitted when following is absent");
  ok(/comment EARLY/.test(m.suggestionReason({ handle: "hh", followers: 18000 }, ME)), "a heavy hitter (>12× you) gets the honest 'comment early' cue");
  ok(!/comment EARLY/.test(m.suggestionReason({ handle: "mid", followers: 6000 }, ME)), "a mid-size account does not");
  ok(m.suggestionReason({ handle: "d", followers: 1200 }, ME) === "in reach", "falls back to a neutral reason when nothing specific is known");
}

console.log(fail === 0 ? `\n✓ suggest-targets: ${pass} assertions passed` : `\n✗ suggest-targets: ${fail} failed, ${pass} passed`);
process.exit(fail === 0 ? 0 : 1);
