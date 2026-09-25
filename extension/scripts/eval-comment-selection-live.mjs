/**
 * Opt-in review of the shipping scorer -> policy -> optional drafter on fictional posts.
 * No judge model or generated accuracy claim. Inspect the post, contribution and draft together.
 * --live enables paid scoring; --draft also enables paid draft/repair calls.
 * ANTHROPIC_API_KEY=... node scripts/eval-comment-selection-live.mjs --live [--draft]
 */
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { COMMENT_SELECTION_CASES, COMMENT_BENCHMARK_PROFILE } from "./comment-selection-fixtures.mjs";

const enabled = process.argv.includes("--live");
const shouldDraft = process.argv.includes("--draft");
const key = process.env.ANTHROPIC_API_KEY?.trim();
if (!enabled || !key) {
  console.log("Comment selection live review: no-op. Use ANTHROPIC_API_KEY with --live for paid scoring; add --draft for paid drafts. Default tests remain free.");
  process.exit(0);
}

// The evaluation invokes the real client and its cancellation/output checks.
// Its only Chrome dependency is key lookup; no account data is loaded.
globalThis.chrome = { storage: { local: { get: async () => ({ anthropicKey: key }) } } };
const load = async (relative) => {
  const built = await build({ entryPoints: [fileURLToPath(new URL(relative, import.meta.url))], bundle: true, write: false, format: "esm" });
  return import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString("base64")}`);
};
const [client, { assessXContribution }, { evaluateLinkedInOpportunity }, { buildDraftContext }, { findContributionAnchor }] = await Promise.all([
  load("../src/lib/claude-client.ts"), load("../src/lib/x-contribution.ts"), load("../src/lib/linkedin-opportunity-ranking.ts"),
  load("../src/lib/draft-context.ts"), load("../src/lib/contribution-evidence.ts"),
]);

// Exclude adversarial *assessment* variants: an invented scorer anchor is not a bad source post.
// These posts are reviewed afresh; offline expected labels are deliberately not reused as model gold.
const ids = new Set(["specific-implementation", "narrow-evidence-question", "warm-inbound-support",
  "quote-context", "unknown-person-good-post", "generic-praise", "hostile-bait",
  "personal-detail-needed", "post-instructions-are-data", "unicode-punctuation"]);
const selected = COMMENT_SELECTION_CASES.filter(row => ids.has(row.id));
const rows = [];
let failed = false;
for (const platform of ["x", "linkedin"]) {
  const cases = selected.filter(row => row[platform]);
  const posts = cases.map((row, i) => {
    const source = row[platform];
    return {
      i, author: platform === "x" ? `builder${i}` : `Example Operator ${i}`,
      text: source.text, context: source.context,
      ...(platform === "x" && source.isReplyToOwnPost ? { meta: "DIRECT COMMENT ON THE USER'S OWN POST" } : {}),
      ...(platform === "linkedin" ? { authorKind: "person", authorHeadline: row.id === "unknown-person-good-post" ? "" : "Software engineering and product operations", connectionDegree: "unknown" } : {}),
    };
  });
  try {
    const assessments = await client.scorePosts(posts, COMMENT_BENCHMARK_PROFILE.niche, [], platform,
      platform === "linkedin" ? COMMENT_BENCHMARK_PROFILE.linkedInThesis : undefined);
    const byIndex = new Map(assessments.map(row => [row.i, row]));
    for (const [i, scenario] of cases.entries()) {
      const post = posts[i];
      const assessment = byIndex.get(i);
      if (!assessment) throw new Error("missing-assessment");
      const policy = platform === "x"
        ? assessXContribution({ ...assessment, ...post, isReplyToOwnPost: scenario.x.isReplyToOwnPost })
        : evaluateLinkedInOpportunity({ ...assessment, ...post });
      const ready = policy.eligible && policy.lane !== "detail";
      const row = {
        platform, scenario: scenario.id, post, assessment,
        observedAnchor: findContributionAnchor(assessment.anchor, post),
        decision: ready ? "ready" : policy.eligible ? "needs your detail" : "pass", policy,
      };
      if (shouldDraft && ready) {
        try {
          const extra = buildDraftContext({ action: platform === "x" ? "reply" : "comment", niche: COMMENT_BENCHMARK_PROFILE.niche,
            anchor: assessment.anchor, replyBrief: assessment.replyBrief,
            contributionMove: platform === "x" ? assessment.replyMove : assessment.commentLane });
          row.draft = platform === "x"
            ? await client.draftReply(post, "Plain, concise technical peer. One useful point; no invented personal experience.", assessment.category, "", undefined, undefined, extra)
            : await client.draftLinkedInComment(post, { linkedInVoice: "Plain, precise, collegial. One useful contribution, then stop.", extra });
        } catch (error) {
          row.draftError = error instanceof Error ? error.message : "draft-error";
          failed = true;
        }
      }
      rows.push(row);
    }
  } catch (error) {
    rows.push({ platform, error: error instanceof Error ? error.message : "evaluation-error" });
    failed = true;
  }
}

console.log(JSON.stringify({
  kind: "live-comment-selection-review", fixtureType: "fictional", generatedAt: new Date().toISOString(),
  profile: COMMENT_BENCHMARK_PROFILE, draftsRequested: shouldDraft,
  rubric: ["Would you choose this conversation?", "Does the contribution add something beyond the post?",
    "Is every personal claim supported?", "Does it sound like the stated voice?", "Would you use it with minimal edits?"],
  note: "This is a review packet, not a measured quality or growth score. Default output does not include credentials.", rows,
}, null, 2));
process.exitCode = failed ? 1 : 0;
