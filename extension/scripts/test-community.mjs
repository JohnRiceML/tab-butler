/**
 * Unit test for community-builder detection (community.ts). Transpiled with
 * esbuild + imported from a data URL. Run: node scripts/test-community.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as esbuild from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "../src/lib/community.ts"), "utf8");
const js = esbuild.transformSync(src, { loader: "ts", format: "esm" }).code;
const mod = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));
const { builderTier, nicheWords } = mod;

let pass = 0, fail = 0;
const eq = (a, b, l) => { if (JSON.stringify(a) === JSON.stringify(b)) pass++; else { fail++; console.error("  FAIL:", l, "got", JSON.stringify(a), "want", JSON.stringify(b)); } };

const NICHE = "AI builders, indie SaaS founders; posts I can add a build lesson to";

// nicheWords: drops stopwords + short words
eq(nicheWords(NICHE).includes("indie"), true, "niche keeps 'indie'");
eq(nicheWords(NICHE).includes("saas"), true, "niche keeps 'saas'");
eq(nicheWords(NICHE).includes("add"), false, "niche drops stopword 'add'");

// tier 2 — builder cue + reciprocal + niche overlap
eq(builderTier("building an indie SaaS for designers", NICHE, 0.6), 2, "builder + niche overlap = 2");
eq(builderTier("indie hacker shipping a startup", NICHE, 0.4), 2, "indie hacker in space = 2");

// tier 1 — builder cue + reciprocal, no niche overlap
eq(builderTier("founder, building cool things in fintech", NICHE, 0.5), 1, "builder, no overlap = 1");
eq(builderTier("maker · community organizer", NICHE, 0.3), 1, "maker/community = 1");

// tier 0 — gated out
eq(builderTier("building an indie SaaS", NICHE, 0.01), 0, "broadcaster ratio -> 0");
eq(builderTier("building an indie SaaS", NICHE, undefined), 0, "unknown ratio -> 0");
eq(builderTier("designer who loves coffee and dogs", NICHE, 0.6), 0, "no builder cue -> 0");
eq(builderTier("", NICHE, 0.6), 0, "empty bio -> 0");
eq(builderTier("relationship coach, building rapport", NICHE, 0.5), 1, "'relationship' doesn't false-match 'ship'; 'building' does");

console.log(fail === 0 ? `\n✓ community: ${pass} assertions passed` : `\n✗ community: ${fail} failed, ${pass} passed`);
process.exit(fail === 0 ? 0 : 1);
