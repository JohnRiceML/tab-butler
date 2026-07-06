/**
 * Unit test for the draft-context assembler (draft-context.ts). esbuild → data-URL import.
 * Run: node scripts/test-draft-context.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as esbuild from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "../src/lib/draft-context.ts"), "utf8");
const js = esbuild.transformSync(src, { loader: "ts", format: "esm" }).code;
const m = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) pass++; else { fail++; console.error("  FAIL:", l); } };

ok(m.buildDraftContext({}) === "", "nothing known → empty string (the bare path stays bare)");
ok(m.buildDraftContext({ niche: "  " }) === "", "whitespace-only fields don't fabricate a block");

const full = m.buildDraftContext({ niche: "AI SaaS, indie founders", reason: "specific build question", category: "value", authorLine: "@dev · ~4.2K followers · a two-way peer in the user's niche" });
ok(full.includes("grounding only"), "the block tells the model it's grounding, not content to parrot");
ok(full.includes("AI SaaS, indie founders") && full.includes("~4.2K followers") && full.includes("specific build question — angle: value"), "all known fields assemble into labeled lines");
ok(full.startsWith("\n\n"), "block is append-ready for the user message");

const partial = m.buildDraftContext({ reason: "sharp take available" });
ok(partial.includes("sharp take available") && !partial.includes("niche") && !partial.includes("author"), "partial context renders only what's known");

ok(m.buildDraftContext({ measuredLine: "your ask-angle replies earned 1.4x your average (n=9)" }).includes("Measured on this user's own past replies"), "the stage-2 measured line is labeled as measured");

console.log(fail === 0 ? `\n✓ draft-context: ${pass} assertions passed` : `\n✗ draft-context: ${fail} failed, ${pass} passed`);
process.exit(fail === 0 ? 0 : 1);
