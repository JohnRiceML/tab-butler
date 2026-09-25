/** Execute the real queue selector: automatic recommendations and explicit pins are distinct. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as esbuild from "esbuild";
const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "../src/content/x-copilot.ts"), "utf8");
const parsed = ts.createSourceFile("x.ts", source, ts.ScriptTarget.Latest, true);
const fn = parsed.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "topOpps");
assert(fn);
const built = await esbuild.build({ entryPoints: [join(here, "../src/lib/x-contribution.ts")], bundle: true, format: "esm", write: false });
const { assessXContribution } = await import("data:text/javascript;base64," + Buffer.from(built.outputFiles[0].text).toString("base64"));
const code = esbuild.transformSync(fn.getText(parsed) + "\nmodule.exports=topOpps;", { loader: "ts", format: "cjs" }).code;
const good = { id: "good", author: "builder", score: 0.7, text: "Activation fell after removing the sample project.", anchor: "removing the sample project", replyMove: "add_detail", replyBrief: "Suggest testing a guided first success before removing the example.", risk: "none" };
for (const dockSort of ["best", "reach", "recent", "easy"]) {
  const context = {
    module: { exports: {} }, Date, dockFilter: "", dockSort, assessXContribution,
    opps: new Map([["good", good], ["inflated", { ...good, id: "inflated", score: 1, risk: "hostile" }], ["pin", { ...good, id: "pin", score: 1, anchor: "invented detail", manual: true }]]),
    currentFreshOpeningScore: () => 0, bestFreshOpening: () => undefined,
    rankScore: (o) => assessXContribution(o).eligible ? o.score : 0,
    recommendationFor: (o) => ({ discovery: assessXContribution(o).eligible ? o.score : 0 }), easyScore: (o) => assessXContribution(o).eligible ? o.score : 0,
  };
  runInNewContext(code, context);
  const rows = context.module.exports();
  assert(rows.some((o) => o.id === "good")); assert(rows.some((o) => o.id === "pin"));
  assert(!rows.some((o) => o.id === "inflated"), `${dockSort} cannot resurface a rejected assessment`);
}
console.log("✓ X selection queue: every sort excludes ungrounded automatic opportunities and preserves explicit pins");
