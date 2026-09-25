import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, "../src/lib/linkedin-score-contract.ts");
const built = await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
});
const contract = await import("data:text/javascript;base64," + Buffer.from(built.outputFiles[0].text).toString("base64"));

let pass = 0;
let fail = 0;
const ok = (condition, label) => {
  if (condition) pass += 1;
  else {
    fail += 1;
    console.error("  FAIL:", label);
  }
};

const comment = {
  i: 0,
  decision: "comment",
  risk: "none",
  postFit: 0.84,
  personFit: 0.5,
  contributionFit: 0.78,
  postReason: "Specific operating decision",
  personReason: "Limited author context",
  personEvidence: "name_only",
  anchor: "which functions should exist",
  commentLane: "decision_implication",
  replyBrief: "Explain how ownership boundaries shape the useful function split",
};
const skip = {
  i: 1,
  decision: "skip",
  risk: "generic",
  postFit: 0.25,
  personFit: 0.5,
  contributionFit: 0.2,
  postReason: "Generic announcement",
  personReason: "Limited author context",
  personEvidence: "name_only",
};
const needsDetail = {
  ...comment,
  i: 2,
  decision: "needs_detail",
  risk: "none",
  missingDetailPrompt: "What exact implementation choice did you make?",
};

ok(contract.hasCompleteLinkedInScores([comment], 1), "one complete comment row passes");
ok(contract.hasCompleteLinkedInScores([comment, skip], 2), "skip rows do not need draft guidance");
ok(contract.hasCompleteLinkedInScores([comment, { i: 1, decision: "skip", risk: "generic" }], 2), "a terse explicit skip cannot invalidate a useful comment row");
ok(contract.hasCompleteLinkedInScores([comment, skip, needsDetail], 3), "needs detail rows pass with an explicit prompt");
ok(!contract.hasCompleteLinkedInScores([], 1), "empty output is rejected");
ok(!contract.hasCompleteLinkedInScores([comment], 2), "partial output is rejected");
ok(!contract.hasCompleteLinkedInScores([comment, { ...skip, i: 0 }], 2), "duplicate indices are rejected");
ok(!contract.hasCompleteLinkedInScores([{ ...comment, i: 1 }], 1), "out of range indices are rejected");
ok(!contract.hasCompleteLinkedInScores([{ ...comment, anchor: "" }], 1), "a comment without an anchor is rejected");
ok(!contract.hasCompleteLinkedInScores([{ ...comment, postFit: "0.84" }], 1), "numeric strings are rejected");
ok(!contract.hasCompleteLinkedInScores([{ ...needsDetail, i: 0, missingDetailPrompt: "" }], 1), "needs detail requires a useful prompt");
for (const field of ["anchor", "replyBrief", "commentLane"]) {
  ok(!contract.hasCompleteLinkedInScores([{ ...needsDetail, i: 0, [field]: "" }], 1), `needs detail requires ${field} as well as the missing fact`);
}
ok(contract.hasCompleteLinkedInScores([{ ...needsDetail, i: 0 }], 1), "a complete detail request retains a specific contribution plan");

console.log(fail === 0
  ? `\n✓ LinkedIn score contract: ${pass} assertions passed`
  : `\n✗ LinkedIn score contract: ${fail} failed, ${pass} passed`);
process.exit(fail === 0 ? 0 : 1);
