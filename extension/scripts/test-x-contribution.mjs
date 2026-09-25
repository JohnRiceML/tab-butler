/** Selection examples are synthetic, shaped like real X conversations, and make no outcome claims. */
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
const here = dirname(fileURLToPath(import.meta.url));
async function load(path) { const built = await esbuild.build({ entryPoints: [join(here, path)], bundle: true, format: "esm", write: false }); return import("data:text/javascript;base64," + Buffer.from(built.outputFiles[0].text).toString("base64")); }
const { assessXContribution } = await load("../src/lib/x-contribution.ts");
const { recommendReply } = await load("../src/lib/reply-recommendation.ts");
const base = { score: 0.8, text: "We cut onboarding from seven screens to three. Activation stayed flat.", anchor: "Activation stayed flat", replyMove: "narrow_question", replyBrief: "Ask whether time to first successful import changed after reducing screens.", risk: "none", category: "ask" };
const positives = [
  base,
  { ...base, text: "First paying customer today. She found us through the docs.", anchor: "found us through the docs", category: "support", replyMove: "substantive_support", replyBrief: "Celebrate the docs winning trust before the sales conversation." },
  { ...base, text: "My toddler shipped a production deploy by sitting on my keyboard.", anchor: "sitting on my keyboard", category: "joke", replyMove: "add_detail", replyBrief: "Make a light joke about promoting the toddler to release manager." },
  { ...base, text: "Thanks! Did you batch the imports or stream them?", anchor: "batch the imports", isReplyToOwnPost: true, score: 0.4, replyBrief: "Explain the batching tradeoff without claiming the user's implementation." },
  { ...base, text: "That's the tradeoff I was trying to describe.", context: "Retries are safe only when writes are idempotent.", anchor: "writes are idempotent", replyMove: "add_detail", replyBrief: "Explain why a stable operation key matters when the client retries." },
  { ...base, text: "We're moving from self-serve to assisted onboarding.", anchor: "self serve", replyMove: "counterpoint", replyBrief: "Ask which activation step actually requires live help." },
];
for (const input of positives) assert(assessXContribution(input).eligible, input.text);
const negatives = [
  [{ ...base, risk: "generic", score: 0.99 }, "risk"],
  [{ ...base, risk: "promotional", score: 1 }, "risk"],
  [{ ...base, risk: "hostile", isReplyToOwnPost: true }, "risk"],
  [{ ...base, risk: "context_mismatch" }, "risk"],
  [{ ...base, risk: undefined }, "missing-risk"],
  [{ ...base, anchor: "Revenue doubled after the redesign" }, "ungrounded-anchor"],
  [{ ...base, anchor: "Activation increased" }, "ungrounded-anchor"],
  [{ ...base, anchor: "" }, "missing-anchor"],
  [{ ...base, replyMove: undefined }, "missing-move"],
  [{ ...base, replyBrief: "" }, "missing-brief"],
  [{ ...base, replyBrief: "Ask a question." }, "generic-brief"],
  [{ ...base, replyBrief: base.anchor }, "generic-brief"],
  [{ ...base, replyBrief: base.text }, "generic-brief"],
  [{ ...base, score: 0.59 }, "low-fit"],
  [{ ...base, score: 0.39, isReplyToOwnPost: true }, "low-fit"],
  [{ ...base, score: NaN }, "low-fit"],
];
for (const [input, code] of negatives) {
  const assessment = assessXContribution(input);
  assert.equal(assessment.eligible, false); assert.equal(assessment.code, code);
  const rec = recommendReply({ modelFit: input.score, isReplyToOwnPost: true, authorFollowers: 1_000_000, myFollowers: 100, postedAt: Date.now(), replies: 0, contributionEligible: assessment.eligible, contributionReason: assessment.reason }, Date.now());
  assert.equal(rec.priority, 0, "warm inbound and large audience cannot rescue missing contribution evidence");
  assert.equal(rec.strength, "later");
}
assert(assessXContribution({ ...base, score: 0.2 }).ready, "a lower-fit explicit request may retain safe grounded guidance");
assert(!assessXContribution({ ...base, risk: "context_mismatch" }).ready, "unsafe guidance must not flow into the drafter");
console.log(`✓ X contribution selection: ${positives.length} legitimate lanes, ${negatives.length} rejected assessments, manual ranking isolation passed`);
