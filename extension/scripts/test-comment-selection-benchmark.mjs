/** Offline, hand-labeled policy benchmark. No API calls and no model-accuracy claim. */
import assert from "node:assert/strict";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { COMMENT_SELECTION_CASES } from "./comment-selection-fixtures.mjs";

const load = async (relative) => {
  const built = await build({ entryPoints: [fileURLToPath(new URL(relative, import.meta.url))], bundle: true, write: false, format: "esm" });
  return import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString("base64")}`);
};
const [{ assessXContribution }, { evaluateLinkedInOpportunity, rankLinkedInOpportunities }, { DEFAULT_LINKEDIN_RELATIONSHIP_RULES }] = await Promise.all([
  load("../src/lib/x-contribution.ts"), load("../src/lib/linkedin-opportunity-ranking.ts"), load("../src/lib/linkedin-strategy.ts"),
]);

let reviewed = 0;
for (const scenario of COMMENT_SELECTION_CASES) {
  if (scenario.x) {
    const result = assessXContribution(scenario.x);
    assert.equal(result.eligible, scenario.expectedX, `X ${scenario.id}: ${scenario.why} Actual: ${JSON.stringify(result)}`);
    reviewed++;
  }
  if (scenario.linkedin) {
    const result = evaluateLinkedInOpportunity(scenario.linkedin);
    const actual = !result.eligible ? "blocked" : result.lane === "detail" ? "detail" : "ready";
    assert.equal(actual, scenario.expectedLinkedIn, `LinkedIn ${scenario.id}: ${scenario.why} Actual: ${JSON.stringify(result)}`);
    reviewed++;
  }
}

const NOW = 1_800_000_000_000;
const readyAssessment = COMMENT_SELECTION_CASES.find(row => row.id === "specific-implementation").linkedin;
const detailAssessment = COMMENT_SELECTION_CASES.find(row => row.id === "personal-detail-needed").linkedin;
const item = (id, assessment, extra = {}) => ({ id, author: id, authorKey: `/in/${id}`, foundAt: NOW, ...assessment, ...extra });
const ready = item("ready", readyAssessment);
const needsDetail = item("detail", detailAssessment, { postFit: 0.99, personFit: 0.99, contributionFit: 0.99 });

assert.equal(rankLinkedInOpportunities([needsDetail, ready], [], DEFAULT_LINKEDIN_RELATIONSHIP_RULES, NOW)[0].item.id,
  "ready", "ready work precedes a higher numeric assessment that still requires personal evidence");
assert.deepEqual(rankLinkedInOpportunities([needsDetail, { ...ready, author: needsDetail.author, authorKey: needsDetail.authorKey }], [], DEFAULT_LINKEDIN_RELATIONSHIP_RULES, NOW).map(row => row.item.id),
  ["ready"], "one-author selection retains the draftable post instead of the incomplete one");

const diverseQueue = Array.from({ length: 8 }, (_, index) => item(`person-${index}`, readyAssessment, {
  postFit: 0.95 - index * 0.02,
  commentLane: index < 5 ? "implementation_detail" : index === 5 ? "evidence_question" : "boundary_condition",
}));
const ranked = rankLinkedInOpportunities(diverseQueue, [], DEFAULT_LINKEDIN_RELATIONSHIP_RULES, NOW);
assert.equal(ranked.length, diverseQueue.length, "lane diversity reorders useful candidates without silently dropping them");
assert.equal(new Set(ranked.map(row => row.item.id)).size, diverseQueue.length, "each candidate appears exactly once");
assert(new Set(ranked.slice(0, 5).map(row => row.item.commentLane)).size >= 2, "first choices offer more than one contribution shape");

console.log(`✓ comment selection benchmark: ${reviewed} hand-labeled platform cases and readiness/diversity ordering`);
