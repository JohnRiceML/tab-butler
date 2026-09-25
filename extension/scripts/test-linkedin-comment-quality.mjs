/** Deterministic human-comment quality regression suite. */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { LINKEDIN_COMMENT_QUALITY_CASES } from "./linkedin-comment-fixtures.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "../src/lib/linkedin-comment-quality.ts"), "utf8");
const js = esbuild.transformSync(source, { loader: "ts", format: "esm" }).code;
const m = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));

let pass = 0, fail = 0;
const ok = (condition, label) => {
  if (condition) pass += 1;
  else { fail += 1; console.error("  FAIL:", label); }
};

for (const fixture of LINKEDIN_COMMENT_QUALITY_CASES) {
  const issues = m.linkedinCommentIssues(fixture.text);
  if (fixture.good) ok(!issues.some((issue) => issue.severity === "blocking"), `known-good comment passes: ${fixture.label}`);
  else ok(issues.some((issue) => issue.code === fixture.code), `known-bad comment catches ${fixture.code}: ${fixture.label}`);
}

ok(m.linkedinCommentIssues("Draft: The handoff needs one owner.").some((issue) => issue.code === "output_wrapper"), "output labels are rejected");
ok(m.linkedinCommentIssues("One question? A second question?").some((issue) => issue.code === "too_many_questions"), "multiple questions are rejected");
ok(m.linkedinCommentIssues("A useful thought with https://example.com").some((issue) => issue.code === "unsolicited_pitch"), "unsolicited links are rejected");
ok(!m.linkedinCommentIssues("The source is https://example.com", { allowLink: true }).some((issue) => issue.code === "unsolicited_pitch"), "an explicitly invited link can pass");
ok(m.linkedinCommentIssues("Sentence one. Sentence two. Sentence three. Sentence four.").some((issue) => issue.code === "mini_essay"), "mini-essay shape is flagged for repair");
ok(m.linkedinCommentIssues("The cross-team handoff needs one owner.").some((issue) => issue.code === "dash_character"), "ordinary hyphens are rejected");
ok(m.linkedinCommentIssues("The queue — not the prompt — is the constraint.").some((issue) => issue.code === "dash_character"), "long dashes are rejected");
ok(m.linkedinCommentIssues('The phrase "move faster" hides the approval cost.').some((issue) => issue.code === "quotation_mark"), "double quotation marks are rejected");
ok(m.linkedinCommentIssues("The 'simple fix' creates another queue.").some((issue) => issue.code === "quotation_mark"), "paired single quotation marks are rejected");
ok(m.linkedinCommentIssues("Call it ‘simple and move on.").some((issue) => issue.code === "quotation_mark"), "unmatched quotation marks are rejected");
ok(!m.linkedinCommentIssues("It's specific and users' needs stay visible.").some((issue) => issue.code === "quotation_mark"), "normal apostrophes are not mistaken for quotation marks");
ok(m.blockingLinkedInCommentIssues("The implementation detail is the approval owner.").length === 0, "plain specific contribution has no blocking issue");
ok(m.linkedInCommentRevisionBrief([{ message: "Fix this.", code: "empty", severity: "blocking" }, { message: "Fix this.", code: "empty", severity: "blocking" }]) === "- Fix this.", "repair brief deduplicates feedback");
ok(m.likelyLinkedInParaphrase("Weekly planning improves team planning because weekly planning creates alignment", "Weekly planning improves team planning because weekly planning creates alignment across the team"), "high-overlap paraphrase is an eval warning");
ok(!m.likelyLinkedInParaphrase("The missing constraint is who can reverse the decision after launch.", "Weekly planning improves team alignment."), "a novel contribution is not called paraphrase");
ok(m.hasFirstPersonExperienceClaim("I've seen this cut churn with our clients."), "no-evidence eval detects first-person empirical claims");
ok(!m.hasFirstPersonExperienceClaim("The approval queue needs one owner."), "reasoned contribution is not mistaken for experience");
ok(m.linkedInOpeningSignature("The approval queue needs one owner today.") === "the approval queue needs", "opening signature is stable for batch diversity checks");

console.log(fail === 0 ? `\n✓ LinkedIn comment quality: ${pass} assertions passed` : `\n✗ LinkedIn comment quality: ${fail} failed, ${pass} passed`);
process.exit(fail === 0 ? 0 : 1);
