/** Deterministic opportunity eligibility and relationship-spacing tests. */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const js = esbuild.buildSync({ entryPoints: [join(here, "../src/lib/linkedin-opportunity-ranking.ts")], bundle: true, write: false, format: "esm", platform: "node" }).outputFiles[0].text;
const m = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));

let pass = 0, fail = 0;
const ok = (condition, label) => condition ? pass += 1 : (fail += 1, console.error("  FAIL:", label));
const base = (overrides = {}) => ({
  id: "post-1",
  author: "Ada",
  authorKey: "/in/ada",
  foundAt: 100,
  decision: "comment",
  postFit: 0.8,
  personFit: 0.75,
  contributionFit: 0.8,
  postReason: "Concrete implementation lesson",
  personReason: "Visible product leader role",
  personEvidence: "visible_headline",
  anchor: "approval latency drove churn",
  commentLane: "boundary_condition",
  replyBrief: "Name the handoff boundary.",
  risk: "none",
  ...overrides,
});
const rules = { sameAuthorCooldownHours: 72, maxSameAuthor7d: 2, maxSameAuthor30d: 5, oneActivePostPerAuthor: true };

const eligible = m.evaluateLinkedInOpportunity(base());
ok(eligible.eligible && eligible.lane === "target" && eligible.priority > 0.7, "complete safe target opportunity passes");
for (const [field, value] of [["decision", "skip"], ["risk", "generic"], ["risk", undefined], ["anchor", ""], ["replyBrief", ""], ["commentLane", undefined], ["personReason", ""]]) {
  ok(!m.evaluateLinkedInOpportunity(base({ [field]: value })).eligible, `${field}=${String(value)} fails closed`);
}
ok(!m.evaluateLinkedInOpportunity(base({ decision: "publish" })).eligible, "unknown decisions cannot become ready comments");
ok(!m.evaluateLinkedInOpportunity(base({ personEvidence: "famous_name" })).eligible, "unknown author evidence fails closed");
for (const field of ["anchor", "replyBrief", "commentLane"]) {
  ok(!m.evaluateLinkedInOpportunity(base({ decision: "needs_detail", missingDetailPrompt: "Which handoff failed?", [field]: "" })).eligible,
    `needs_detail still requires ${field} to name the contribution unlocked`);
}
ok(m.evaluateLinkedInOpportunity(base({ text: "We found that approval latency drove churn after rollout." })).eligible,
  "an exact observed anchor grounds the contribution");
ok(!m.evaluateLinkedInOpportunity(base({ text: "We measured response times but did not discuss churn." })).eligible,
  "an invented anchor cannot qualify even with high model scores");
ok(m.evaluateLinkedInOpportunity(base({ text: "This changes where we put the next review step.", context: "Approval latency drove churn." })).eligible,
  "an observed reshared context can ground a contribution without fabricating the outer post");
ok(m.evaluateLinkedInOpportunity(base({ text: "APPROVAL—latency\n drove churn", personEvidence: "name_only", personFit: 0.5 })).lane === "discovery",
  "formatting normalization preserves a grounded discovery with unknown person context");
ok(!m.evaluateLinkedInOpportunity(base({ text: "Approval latency drove churn.", anchor: "approval latency doubled churn" })).eligible,
  "grounding requires the contiguous source claim, not a bag of shared words");
ok(!m.evaluateLinkedInOpportunity(base({ text: "Retail automation changed checkout", anchor: "AI" })).eligible,
  "token boundaries prevent fake anchors inside unrelated words");
const needsDetail = m.evaluateLinkedInOpportunity(base({
  decision: "needs_detail",
  contributionFit: 0.5,
  missingDetailPrompt: "What exact handoff failed in your implementation?",
}));
ok(needsDetail.eligible && needsDetail.lane === "detail", "a strong post that needs one real fact is surfaced honestly");
ok(m.evaluateLinkedInOpportunity(base({
  decision: "needs_detail",
  risk: "generic",
  postFit: 0.55,
  contributionFit: 0.35,
  missingDetailPrompt: "What exact tradeoff did you see?",
})).eligible, "a relevant borderline post is surfaced for user detail instead of disappearing as generic");
ok(!m.evaluateLinkedInOpportunity(base({ decision: "needs_detail", missingDetailPrompt: "" })).eligible, "needs detail requires a useful user prompt");
ok(!m.evaluateLinkedInOpportunity(base({ postFit: 0.59, personFit: 1 })).eligible, "person fit cannot rescue weak content");
ok(!m.evaluateLinkedInOpportunity(base({ contributionFit: 0.59 })).eligible, "weak truthful contribution is blocked");
ok(m.evaluateLinkedInOpportunity(base({ personEvidence: "name_only", personFit: 0.95, postFit: 0.8 })).lane === "discovery", "name-only evidence is capped and cannot become target lane");
ok(m.evaluateLinkedInOpportunity(base({ personEvidence: "name_only", personFit: 0.4, postFit: 0.72 })).eligible, "a strong post is not discarded only because author evidence is limited");
ok(!m.evaluateLinkedInOpportunity(base({ personEvidence: "name_only", personFit: 0.5, postFit: 0.67 })).eligible, "discovery still requires a strong post");

const NOW = 2_000_000_000_000;
const ranked = (items, activity = [], customRules = rules) => m.rankLinkedInOpportunities(items, activity, customRules, NOW);
ok(ranked([base()]).length === 1, "qualified opportunity ranks without history");
const veryRecent = ranked([base()], [{ authorKey: "/in/ada", author: "Ada", postedAt: NOW - 23 * 3_600_000 }]);
ok(veryRecent.length === 1 && veryRecent[0].priority < eligible.priority && veryRecent[0].relationshipNote.includes("Kept visible"), "same author within 24 hours stays visible with an explicit priority penalty");
const cooled = ranked([base()], [{ authorKey: "/in/ada", author: "Ada", postedAt: NOW - 48 * 3_600_000 }]);
ok(cooled.length === 1 && cooled[0].priority < eligible.priority && cooled[0].relationshipNote.includes("48h"), "24–72 hour history lowers priority and stays explained");
const legacyRecent = ranked([base()], [{ author: "Ada", postedAt: NOW - 12 * 3_600_000 }]);
ok(legacyRecent.length === 1 && legacyRecent[0].priority < eligible.priority, "legacy name-only history still lowers repeat priority");
const capped = ranked([base()], [
  { authorKey: "/in/ada", author: "Ada", postedAt: NOW - 2 * 86_400_000 },
  { authorKey: "/in/ada", author: "Ada", postedAt: NOW - 4 * 86_400_000 },
]);
ok(capped.length === 1 && capped[0].relationshipNote.includes("often"), "rolling seven-day author cap warns and lowers priority without hiding a strong post");

const sameAuthor = ranked([
  base({ id: "best", postFit: 0.9, foundAt: 1 }),
  base({ id: "backup", postFit: 0.7, foundAt: 2 }),
]);
ok(sameAuthor.length === 1 && sameAuthor[0].item.id === "best", "one best post per author is displayed");
const readyBeforeDetail = ranked([
  base({ id: "detail", author: "Detail", authorKey: "/in/detail", decision: "needs_detail", postFit: 1, personFit: 1, contributionFit: 1, missingDetailPrompt: "What exact handoff did you change?" }),
  base({ id: "ready", author: "Ready", authorKey: "/in/ready", postFit: 0.7, personFit: 0.65, contributionFit: 0.65 }),
]);
ok(readyBeforeDetail.map((row) => row.item.id).join(",") === "ready,detail", "ready comments precede even numerically stronger detail-required candidates");
const sameAuthorReadiness = ranked([
  base({ id: "detail", decision: "needs_detail", postFit: 1, personFit: 1, contributionFit: 1, missingDetailPrompt: "Which handoff did you change?" }),
  base({ id: "ready", postFit: 0.7 }),
]);
ok(sameAuthorReadiness.length === 1 && sameAuthorReadiness[0].item.id === "ready", "a detail request cannot consume the author's slot ahead of a ready contribution");
ok(ranked([
  base({ id: "detail", decision: "needs_detail", postFit: 1, missingDetailPrompt: "Which handoff did you change?" }),
  base({ id: "ready", postFit: 0.7 }),
], [], { ...rules, oneActivePostPerAuthor: false }).map((row) => row.item.id).join(",") === "ready,detail",
"turning off author deduplication preserves both readiness tiers");

const collision = ranked([
  base({ id: "ada-1", authorKey: "/in/ada-one" }),
  base({ id: "ada-2", authorKey: "/in/ada-two", foundAt: 99 }),
]);
ok(collision.length === 2, "same display name with distinct profile paths remains distinct");

const diverse = ranked([
  base({ id: "a", author: "A", authorKey: "/in/a", commentLane: "mechanism", foundAt: 6 }),
  base({ id: "b", author: "B", authorKey: "/in/b", commentLane: "mechanism", foundAt: 5 }),
  base({ id: "c", author: "C", authorKey: "/in/c", commentLane: "mechanism", foundAt: 4 }),
  base({ id: "d", author: "D", authorKey: "/in/d", commentLane: "evidence_question", foundAt: 3 }),
]);
ok(diverse.slice(0, 3).some((row) => row.item.commentLane === "evidence_question"), "top queue makes room for a qualified contribution-lane alternative");
ok(diverse.length === 4 && diverse.map((row) => row.item.id).join(",") === "a,b,d,c", "diversity reorders the deferred candidate instead of silently losing it");

const unavailableAlternative = ranked([
  base({ id: "a", authorKey: "/in/a", commentLane: "mechanism", postFit: 0.95 }),
  base({ id: "b", authorKey: "/in/b", commentLane: "mechanism", postFit: 0.9 }),
  base({ id: "c", authorKey: "/in/c", commentLane: "mechanism", postFit: 0.85 }),
  base({ id: "a-backup", authorKey: "/in/a", commentLane: "evidence_question", postFit: 0.7 }),
]);
ok(unavailableAlternative.map((row) => row.item.id).join(",") === "a,b,c", "an alternative from an already represented author cannot hide a valid candidate");

const crowded = Array.from({ length: 18 }, (_, i) => base({
  id: `crowd-${i}`, author: `Author ${i}`, authorKey: `/in/author-${i}`, foundAt: 100 - i,
  commentLane: i < 14 ? "mechanism" : i < 16 ? "boundary_condition" : "evidence_question",
}));
const reordered = ranked(crowded);
ok(reordered.length === crowded.length && new Set(reordered.map((row) => row.item.id)).size === crowded.length,
  "a large skewed lane distribution preserves every author-eligible candidate exactly once");
ok(reordered.slice(0, 5).filter((row) => row.item.commentLane === "mechanism").length === 2,
  "the first five make room for existing qualified lane alternatives");
ok(ranked([...crowded].reverse()).map((row) => row.item.id).join(",") === reordered.map((row) => row.item.id).join(","),
  "diversity order is deterministic regardless of input insertion order");

const readyLanes = ranked([
  ...crowded.slice(0, 3),
  base({ id: "different-detail", authorKey: "/in/detail", decision: "needs_detail", commentLane: "evidence_question", postFit: 1, contributionFit: 1, missingDetailPrompt: "Which failure rate did you measure?" }),
]);
ok(readyLanes.slice(0, 3).every((row) => row.item.decision === "comment") && readyLanes.length === 4,
  "lane diversity cannot advance a detail request ahead of ready contributions");

const tie = ranked([
  base({ id: "z", author: "Z", authorKey: "/in/z", foundAt: 10 }),
  base({ id: "a", author: "A", authorKey: "/in/a", foundAt: 10 }),
]);
ok(tie.map((row) => row.item.id).join(",") === "a,z", "stable ID breaks exact ranking ties deterministically");

console.log(fail === 0 ? `\n✓ LinkedIn opportunity ranking: ${pass} assertions passed` : `\n✗ LinkedIn opportunity ranking: ${fail} failed, ${pass} passed`);
process.exit(fail === 0 ? 0 : 1);
