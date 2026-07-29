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

// ---- profile v2: bio formula scan ----
ok(m.analyzeBio("Building an AI tool for founders. 12K MRR.").hasRole, "analyzeBio detects a role verb");
ok(m.analyzeBio("Building an AI tool for founders. 12K MRR.").hasAudience, "analyzeBio detects an audience");
ok(m.analyzeBio("Building an AI tool for founders. 12K MRR.").hasProof, "analyzeBio detects a numeric proof");
ok(!m.analyzeBio("just vibes and thoughts").hasProof, "analyzeBio: no number/metric → no proof");
ok(m.analyzeBio("shipped 3 apps").hasProof && m.analyzeBio("$5k ARR").hasProof, "proof fires on shipped-count and $ metrics");

// healthy bio missing proof → act (highest-leverage add), name/banner independent
{
  const f = m.profileCheck({ at: 1, pinnedId: "a", bioLen: 60, bioHasRole: true, bioHasAudience: true, bioHasProof: false }, stats);
  ok(f.some((x) => x.level === "act" && /no concrete proof/i.test(x.text)), "healthy bio without proof → act");
}
// full formula → a good affirmation
{
  const f = m.profileCheck({ at: 1, pinnedId: "a", bioLen: 60, bioHasRole: true, bioHasAudience: true, bioHasProof: true }, stats);
  ok(f.some((x) => x.level === "good" && /what you do, who it's for, and proof/i.test(x.text)), "full what/who/proof bio → good ✓");
}
// empty bio is the whole message — proof/name/banner nags suppressed
{
  const f = m.profileCheck({ at: 1, pinnedId: "a", bioLen: 0, bioHasProof: false, nameDescriptive: false, hasBanner: false }, stats);
  ok(f.filter((x) => /bio|banner|display name/i.test(x.text)).length === 1 && f.some((x) => x.text.includes("bio is empty")), "empty bio suppresses the other profile nags (one priority message)");
}
// name + banner quick wins fire only when harvested false, and only with a healthy bio
{
  const f = m.profileCheck({ at: 1, pinnedId: "a", bioLen: 60, bioHasRole: true, bioHasAudience: true, bioHasProof: true, nameDescriptive: false, hasBanner: false }, stats);
  ok(f.some((x) => /display name is just your handle/i.test(x.text)), "name-not-descriptive → act");
  ok(f.some((x) => /No banner image/i.test(x.text)), "no banner → act");
}
// unset v2 fields → no v2 findings (backward compatible, honest-mirror)
{
  const f = m.profileCheck({ at: 1, pinnedId: "a", bioLen: 90 }, stats);
  ok(!f.some((x) => /proof|banner|display name/i.test(x.text)), "v2 fields unset → silence (never nag on data we didn't harvest)");
}

// follow PROMISE — a follow subscribes to future content; the bio should say what's coming
{
  ok(m.analyzeBio("Documenting the road from $0 to $50k MRR").hasPromise === true, "analyzeBio: 'documenting' reads as a promise");
  ok(m.analyzeBio("Weekly teardowns of AI SaaS products").hasPromise === true, "analyzeBio: 'weekly' reads as a promise");
  ok(m.analyzeBio("Sharing what actually grows AI SaaS").hasPromise === true, "analyzeBio: 'sharing what' reads as a promise");
  ok(m.analyzeBio("CEO at BigCo. Opinions my own.").hasPromise === false, "analyzeBio: static credentials bio has no promise");
  // proof present but no promise → the promise nudge fires
  const f1 = m.profileCheck({ at: 1, pinnedId: "a", bioLen: 60, bioHasRole: true, bioHasAudience: true, bioHasProof: true, bioHasPromise: false }, stats);
  ok(f1.some((x) => x.level === "act" && /promise what a follower GETS/i.test(x.text)), "proof ok but no promise → promise nudge fires");
  ok(!f1.some((x) => /covers what you do/.test(x.text)), "…and the ✓ line does not also fire");
  // proof missing wins priority — promise nudge stays quiet (one message at a time)
  const f2 = m.profileCheck({ at: 1, pinnedId: "a", bioLen: 60, bioHasProof: false, bioHasPromise: false }, stats);
  ok(f2.some((x) => /no concrete proof/.test(x.text)) && !f2.some((x) => /promise what a follower/i.test(x.text)), "missing proof outranks the promise nudge");
  // full formula incl. promise → the ✓ fires, no nags
  const f3 = m.profileCheck({ at: 1, pinnedId: "a", bioLen: 60, bioHasRole: true, bioHasAudience: true, bioHasProof: true, bioHasPromise: true }, stats);
  ok(f3.some((x) => /covers what you do/.test(x.text)) && !f3.some((x) => /promise what a follower/i.test(x.text)), "role+audience+proof+promise → ✓, no promise nag");
  // promise unset (old harvest) → silence on promise, ✓ still reachable (backward compatible)
  const f4 = m.profileCheck({ at: 1, pinnedId: "a", bioLen: 60, bioHasRole: true, bioHasAudience: true, bioHasProof: true }, stats);
  ok(!f4.some((x) => /promise what a follower/i.test(x.text)) && f4.some((x) => /covers what you do/.test(x.text)), "bioHasPromise unset → no promise nag, ✓ unchanged");
}

console.log(fail === 0 ? `\n✓ profile-check: ${pass} assertions passed` : `\n✗ profile-check: ${fail} failed, ${pass} passed`);
process.exit(fail === 0 ? 0 : 1);
