/**
 * Unit test for the profile coach (profile-check.ts). esbuild → data-URL import.
 * Run: node scripts/test-profile-check.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as esbuild from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "../src/lib/profile-check.ts"), "utf8");
const js = esbuild.transformSync(src, { loader: "ts", format: "esm" }).code;
const m = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) pass++; else { fail++; console.error("  FAIL:", l); } };

const stats = [
  { id: "a", views: 5000 }, { id: "b", views: 2400 }, { id: "c", views: 900 },
  { id: "d", views: 300 }, { id: "e", views: 120 },
];

// silence without a harvest — never guesses
ok(m.profileCheck(undefined, stats).length === 0, "no profile harvest → no findings (silence, not guesses)");

// no pinned post (label absence trusted: English UI) → act, citing the measured top
{
  const f = m.profileCheck({ at: 1, pinnedId: undefined, pinKnown: true, bioLen: 80 }, stats);
  ok(f.some((x) => x.level === "act" && x.text.includes("No pinned post") && x.text.includes("5.0K")), "no pinned (pinKnown) → act with the measured top post");
}

// locale guard: a missing pin label on a non-English UI is NOT evidence — silence on pins, bio still fires
{
  const f = m.profileCheck({ at: 1, pinnedId: undefined, pinKnown: false, bioLen: 0 }, stats);
  ok(!f.some((x) => x.text.toLowerCase().includes("pinned")), "pinKnown=false → no pin claims (Épinglé ≠ no pin)");
  ok(f.some((x) => x.text.includes("bio is empty")), "…but the bio finding still fires");
}

// one-metric discipline: any post missing views → the WHOLE ranking uses engagement, labeled
{
  const mixed = [{ id: "a", views: 5000, likes: 10 }, { id: "b", likes: 400, reposts: 20 }, { id: "c", likes: 100 }, { id: "d", likes: 30 }];
  // "a" has huge views but tiny ENG — under one-metric discipline it ranks LAST (#4), proving views never leak into a mixed ranking
  const f = m.profileCheck({ at: 1, pinnedId: "a", pinKnown: true, bioLen: 80 }, mixed);
  ok(f.some((x) => x.text.includes("by engagement")), "mixed views coverage → engagement ranking for ALL, never mixed scales");
}

// pinned is a mid performer → act with the honest rank
{
  const f = m.profileCheck({ at: 1, pinnedId: "d", bioLen: 80 }, stats);
  ok(f.some((x) => x.level === "act" && x.text.includes("#4 of your last 5")), "weak pin → act, honest rank cited");
}

// pinned is the top performer → good
{
  const f = m.profileCheck({ at: 1, pinnedId: "a", bioLen: 80 }, stats);
  ok(f.some((x) => x.level === "good" && x.text.includes("top-1")), "top pin → good ✓");
}

// pinned outside the cached window → silence on pinning (can't rank the unseen)
{
  const f = m.profileCheck({ at: 1, pinnedId: "zzz", bioLen: 80 }, stats);
  ok(!f.some((x) => x.text.toLowerCase().includes("pinned")), "unknown pinned id → no pin claim");
}

// too few rankable posts → no pin ranking at all
ok(m.profileCheck({ at: 1, bioLen: 80 }, stats.slice(0, 2)).length === 0, "under 3 rankable posts → no ranking claims");

// bio checks
ok(m.profileCheck({ at: 1, pinnedId: "a", bioLen: 0 }, stats).some((x) => x.text.includes("bio is empty")), "empty bio → act");
ok(m.profileCheck({ at: 1, pinnedId: "a", bioLen: 12 }, stats).some((x) => x.text.includes("12 characters")), "thin bio → act with the measured length");
ok(!m.profileCheck({ at: 1, pinnedId: "a", bioLen: 90 }, stats).some((x) => x.text.includes("bio")), "healthy bio → no bio nag");

// views-absent fallback ranks on engagement
{
  const engStats = [{ id: "a", likes: 50, reposts: 5 }, { id: "b", likes: 20 }, { id: "c", likes: 5 }];
  const f = m.profileCheck({ at: 1, pinKnown: true }, engStats);
  ok(f.some((x) => x.text.includes("No pinned post") && x.text.includes("eng")), "no views → falls back to engagement, labeled");
}

console.log(fail === 0 ? `\n✓ profile-check: ${pass} assertions passed` : `\n✗ profile-check: ${fail} failed, ${pass} passed`);
process.exit(fail === 0 ? 0 : 1);
