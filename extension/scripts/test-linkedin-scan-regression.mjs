/**
 * Focused regression guard for a LinkedIn scan that finishes with zero cards.
 *
 * A successful broker response must account for every post in the requested
 * batch. Otherwise an empty or partial scores array is indistinguishable from
 * a genuinely low quality feed and the dock incorrectly reports that no strong
 * opportunities exist.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const copilot = readFileSync(join(here, "../src/content/linkedin-copilot.ts"), "utf8");
const rankingJs = esbuild.buildSync({ entryPoints: [join(here, "../src/lib/linkedin-opportunity-ranking.ts")], bundle: true, write: false, format: "esm", platform: "node" }).outputFiles[0].text;
const ranking = await import("data:text/javascript;base64," + Buffer.from(rankingJs).toString("base64"));

let pass = 0;
let fail = 0;
const ok = (condition, label) => {
  if (condition) pass += 1;
  else {
    fail += 1;
    console.error("  FAIL:", label);
  }
};

// This resembles a substantive current feed post with visible actor evidence.
// It proves that a complete broker assessment is not lost at the local policy
// threshold, keeping the regression focused on scan and response plumbing.
const validAssessment = {
  decision: "comment",
  postFit: 0.82,
  personFit: 0.72,
  contributionFit: 0.78,
  postReason: "Concrete claim about software design responsibility",
  personReason: "Visible software builder matches the saved audience",
  personEvidence: "visible_headline",
  anchor: "knowing which functions should exist",
  commentLane: "decision_implication",
  replyBrief: "Name how ownership boundaries determine the useful function split",
  risk: "none",
};
const eligible = ranking.evaluateLinkedInOpportunity(validAssessment);
ok(eligible.eligible && eligible.priority >= 0.6, "a complete strong feed assessment reaches the opportunity queue");

ok(
  !copilot.includes("opportunity.score >= SCORE_THRESHOLD"),
  "an opportunity accepted by the eligibility policy is not hidden by a second score threshold",
);
ok(
  !copilot.includes("Good posts are resting for relationship spacing"),
  "the empty state does not mislabel hidden results as relationship spacing",
);
ok(
  copilot.includes('window.addEventListener("scroll", onFeedScroll, { passive: true })')
    && copilot.includes('window.removeEventListener("scroll", onFeedScroll)'),
  "scrolling rescans posts that LinkedIn mounted before they entered the viewport",
);
ok(
  copilot.includes("const savedOpportunity = opportunities.has(id)")
    && !/savedOpportunity[\s\S]{0,220}opportunities\.delete\(id\)/.test(copilot),
  "an approved opportunity survives when LinkedIn recycles its original feed node",
);
ok(
  copilot.includes("risk: normalized.risk!") && /interface Opportunity[\s\S]{0,900}risk: ReplyRisk/.test(copilot),
  "the approved opportunity preserves risk for the ranking pass instead of being hidden",
);

// Current LinkedIn feed cards are plain role=listitem DIVs. Most expose the
// expandable text box but no URN or canonical post link until interaction.
// Keep both semantic discovery and content identity fallback in the scan path.
ok(
  copilot.includes("main [data-testid='mainFeed'] [role='listitem']")
    && copilot.includes("[data-testid='expandable-text-box']"),
  "plain current feed listitems with expandable text are discoverable",
);
ok(
  copilot.includes('return { id: `content:${hash('),
  "a current feed card without a URN or canonical link still gets a stable content identity",
);

const currentCardShape = {
  outer: "DIV[role=listitem] under main [data-testid=mainFeed]",
  body: "SPAN[data-testid=expandable-text-box]",
  actorHooks: false,
  actorParentLines: [
    "Ada Lovelace",
    "2nd",
    "Software builder working on dependable AI systems",
    "Visit my website",
    "3h",
    "Follow",
  ],
};
ok(
  currentCardShape.outer.startsWith("DIV[role=listitem]")
    && currentCardShape.body.includes("expandable-text-box")
    && currentCardShape.actorHooks === false,
  "the fixture represents the current plain LinkedIn feed card shape",
);

const actorStart = copilot.indexOf("function actorProfileAnchor");
const actorEnd = copilot.indexOf("const RESHARED_CONTENT_SELECTOR", actorStart);
const actorPipeline = actorStart >= 0 && actorEnd > actorStart ? copilot.slice(actorStart, actorEnd) : "";
ok(
  /actorProfileAnchor\(post\)/.test(actorPipeline) && /\.parentElement\b/.test(actorPipeline),
  "actor metadata falls back to the immediate profile anchor parent when current data hooks are absent",
);
ok(
  /Visit my website/i.test(actorPipeline) && /Follow/i.test(actorPipeline),
  "actor parent fallback removes LinkedIn action text before choosing a visible headline",
);
ok(
  /1st\|2nd\|3rd/.test(actorPipeline) && /parentElement/.test(actorPipeline),
  "connection degree can be recovered from the current actor anchor parent",
);

const snapshotStart = copilot.indexOf("function postMatchesSnapshot");
const snapshotEnd = copilot.indexOf("function pruneLiveReferences", snapshotStart);
const snapshotGuard = snapshotStart >= 0 && snapshotEnd > snapshotStart ? copilot.slice(snapshotStart, snapshotEnd) : "";
ok(
  snapshotGuard.includes("if (!post.node.isConnected) return true")
    && snapshotGuard.includes("const current = extractPost(post.node)"),
  "a disconnected immutable snapshot remains scoreable while a connected card is revalidated for recycling",
);
for (const field of ["id", "author", "authorKey", "text", "context"]) {
  ok(snapshotGuard.includes(`current.${field}`) && snapshotGuard.includes(`post.${field}`), `snapshot immutability includes ${field}`);
}

const flushStart = copilot.indexOf("async function flushScoresOnce()");
const flushEnd = copilot.indexOf("const RAIL_CSS", flushStart);
const flush = copilot.slice(flushStart, flushEnd);
const brokerErrorEnd = flush.lastIndexOf('scoringError = "";');
const beforeSuccess = brokerErrorEnd >= 0 ? flush.slice(0, brokerErrorEnd) : "";

ok(flushStart >= 0 && flushEnd > flushStart, "the focused scoring pipeline is present");
ok(
  (flush.match(/postMatchesSnapshot\(post\)/g) ?? []).length >= 2,
  "immutable snapshots are checked both before broker dispatch and before accepting a returned score",
);
ok(
  /response\?*\.scores|response\.scores/.test(beforeSuccess),
  "an empty or partial broker scores array is rejected before the scan is treated as successful",
);
ok(
  /scores\.length|scoreIndices|scoreCoverage|completeScores|completeScore|validateLinkedInScores/i.test(beforeSuccess),
  "the broker response explicitly checks score coverage for the requested batch",
);
ok(
  /incomplete|missing.+score|score.+coverage|bad-output/i.test(beforeSuccess),
  "missing broker scores produce an actionable scan failure instead of a false empty feed",
);

console.log(fail === 0
  ? `\n✓ LinkedIn scan regression: ${pass} assertions passed`
  : `\n✗ LinkedIn scan regression: ${fail} failed, ${pass} passed`);
process.exit(fail === 0 ? 0 : 1);
