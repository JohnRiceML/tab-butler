/**
 * Unit test for human-pacing (human-pacing.ts). Transpiled with esbuild +
 * imported from a data URL. Run: node scripts/test-pacing.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as esbuild from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "../src/lib/human-pacing.ts"), "utf8");
const js = esbuild.transformSync(src, { loader: "ts", format: "esm" }).code;
const mod = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));
const { humanDelayMs, typeChunks, jitterGap } = mod;

let pass = 0, fail = 0;
const eq = (a, b, l) => { if (JSON.stringify(a) === JSON.stringify(b)) pass++; else { fail++; console.error("  FAIL:", l, "got", JSON.stringify(a), "want", JSON.stringify(b)); } };
const ok = (c, l) => { if (c) pass++; else { fail++; console.error("  FAIL:", l); } };

// humanDelayMs: rnd=0 -> lo, rnd=1 -> hi, and always within [lo, hi]
eq(humanDelayMs("type", () => 0), 28, "type lo");
eq(humanDelayMs("type", () => 1), 95, "type hi");
eq(humanDelayMs("settle", () => 0), 650, "settle lo");
eq(humanDelayMs("settle", () => 1), 1500, "settle hi");
for (const k of ["type", "react", "menu", "settle"]) {
  for (const r of [0, 0.25, 0.5, 0.75, 1]) {
    const v = humanDelayMs(k, () => r);
    ok(v >= humanDelayMs(k, () => 0) && v <= humanDelayMs(k, () => 1), `${k} within bounds @${r}`);
  }
}
ok(humanDelayMs("settle", () => 0) > humanDelayMs("type", () => 1), "settle is slower than typing");

// typeChunks: words with trailing space; lossless; bounded
eq(typeChunks("ship daily and measure"), ["ship ", "daily ", "and ", "measure"], "word chunks w/ trailing space");
eq(typeChunks(""), [], "empty -> no chunks");
eq(typeChunks("solo"), ["solo"], "single word");
eq(typeChunks("a b c d e", 60).join(""), "a b c d e", "join restores input (short)");
const long = Array.from({ length: 200 }, (_, i) => `w${i}`).join(" ");
ok(typeChunks(long, 60).length <= 60, "long reply bounded to maxChunks");
eq(typeChunks(long, 60).join(""), long, "join restores input (long/merged)");

// jitterGap: stays within ±frac of base; rnd=0.5 -> base
eq(jitterGap(20000, 0.15, () => 0.5), 20000, "midpoint = base");
ok(jitterGap(20000, 0.15, () => 0) === 17000, "rnd=0 -> base*(1-frac)");
ok(jitterGap(20000, 0.15, () => 1) === 23000, "rnd=1 -> base*(1+frac)");
for (const r of [0, 0.3, 0.7, 1]) {
  const v = jitterGap(20000, 0.15, () => r);
  ok(v >= 17000 && v <= 23000, `jitter within ±15% @${r}`);
}

console.log(fail === 0 ? `\n✓ human pacing: ${pass} assertions passed` : `\n✗ human pacing: ${fail} failed, ${pass} passed`);
process.exit(fail === 0 ? 0 : 1);
