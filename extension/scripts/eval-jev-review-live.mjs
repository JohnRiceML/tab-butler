/** Explicit paid evaluation. Default invocation is a free no-op. Never logs credentials. */
import { build } from "esbuild";
import fs from "node:fs/promises";
import { JEV_REVIEW_CASES } from "./jev-review-fixtures.mjs";

if (!process.argv.includes("--live")) {
  console.log("No API calls. Use --live to evaluate fictional comments with TypeSafe (paid). Reads TYPESAFE_API_KEY or ignored goobi.local.json.");
  process.exit(0);
}
let key = process.env.TYPESAFE_API_KEY?.trim();
if (!key) {
  try { key = JSON.parse(await fs.readFile(new URL("../goobi.local.json", import.meta.url), "utf8")).typesafeKey?.trim(); } catch {}
}
if (!key) { console.error("TypeSafe key missing."); process.exit(1); }
const bundled = await build({ entryPoints: [new URL("../src/lib/jev-review.ts", import.meta.url).pathname], bundle: true, write: false, format: "esm" });
const { reviewWithJev, jevReviewFlags, JEV_MODEL } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`);
const rows = [];
const split = process.argv.includes("--development") ? "development" : process.argv.includes("--holdout") ? "holdout" : null;
const cases = JEV_REVIEW_CASES.filter(row => !split || row.split === split);
const repeatArg = process.argv.find(arg => arg.startsWith("--repeat="));
const repeats = Math.max(1, Math.min(3, Number(repeatArg?.split("=")[1]) || 1));
let stopped = false;
for (let repeat = 0; repeat < repeats && !stopped; repeat++) {
  for (const scenario of cases) {
    for (const platform of ["x", "linkedin"]) {
      try {
        const review = await reviewWithJev(key, { ...scenario.input, platform });
        const mismatches = Object.entries(scenario.expected).filter(([name, expected]) => review.answers[name].choice !== expected)
          .map(([name, expected]) => ({ dimension: name, expected, actual: review.answers[name].choice }));
        rows.push({ id: scenario.id, split: scenario.split, platform, repeat, review, flags: jevReviewFlags(review), mismatches });
      } catch (error) {
        const code = /^jev-[a-z0-9-]+$/.test(error?.message) ? error.message : "jev-evaluation-failed";
        rows.push({ id: scenario.id, split: scenario.split, platform, repeat, error: code });
        // Authentication and service failures are not model mistakes. Stop paid work, do not spin.
        stopped = true;
        break;
      }
    }
    if (stopped) break;
  }
}
const successful = rows.filter(row => row.review);
const latencies = successful.map(row => row.review.latencyMs).sort((a, b) => a - b);
const inputTokens = successful.reduce((sum, row) => sum + row.review.inputTokens, 0);
const report = {
  kind: "jev-comment-review-evaluation", generatedAt: new Date().toISOString(), model: JEV_MODEL,
  note: "Fictional hand-authored fixtures. Labels are hidden from the API. Small fixture agreement is not production accuracy or calibrated confidence. No user account content was sent.",
  summary: { requested: cases.length * 2 * repeats, completed: successful.length, errors: rows.length - successful.length,
    exactLabelMatches: successful.filter(row => !row.mismatches.length).length,
    labelChecks: successful.reduce((sum, row) => sum + Object.keys(cases.find(s => s.id === row.id).expected).length, 0),
    labelMismatches: successful.reduce((sum, row) => sum + row.mismatches.length, 0),
    inputTokens, estimatedCostUsd: inputTokens * 0.042 / 1_000_000,
    p50Ms: latencies[Math.floor(latencies.length * .5)] ?? null, p95Ms: latencies[Math.min(latencies.length - 1, Math.ceil(latencies.length * .95) - 1)] ?? null },
  rows,
};
const outArg = process.argv.find(arg => arg.startsWith("--out="));
if (outArg) await fs.writeFile(outArg.slice(6), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ ...report.summary, issues: rows.filter(row => row.error || row.mismatches?.length).map(({ id, platform, error, mismatches }) => ({ id, platform, error, mismatches })) }, null, 2));
process.exitCode = stopped ? 1 : 0;
