/** Grounding regressions run real draft entry points with local provider fixtures. */
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import * as esbuild from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const bundle = async (name) => (await esbuild.build({ entryPoints: [join(here, `../src/lib/${name}.ts`)], bundle: true, platform: "node", format: "cjs", write: false })).outputFiles[0].text;
const [evidenceCode, clientCode, promptCode] = await Promise.all([bundle("contribution-evidence"), bundle("claude-client"), bundle("prompts")]);
function load(code, extra = {}) {
  const module = { exports: {} };
  runInNewContext(code, { module, exports: module.exports, setTimeout, clearTimeout, AbortController, ...extra });
  return module.exports;
}
const evidence = load(evidenceCode), prompts = load(promptCode);
const { findContributionAnchor, boundedContributionAnchor, isVerbatimContributionEcho, hasUnsupportedPersonalClaim, soulContributionProof, contributionRewriteProof } = evidence;

// Literal matching accepts harmless rendering differences, not topical resemblance.
const source = { text: "We cut onboarding from eight screens to three. Retail apps saw no lift.", context: "Parent: The first decision—not screen count—changed completion." };
assert.equal(findContributionAnchor("CUT ONBOARDING from eight screens", source)?.source, "post");
assert.equal(findContributionAnchor("first decision not screen count", source)?.source, "context");
assert.equal(findContributionAnchor("ＡＢ testing", { text: "AB testing is useful." })?.source, "post");
assert.equal(findContributionAnchor("AI", source), null, "matching cannot find AI inside retail");
assert.equal(findContributionAnchor("onboarding improved conversion", source), null, "a plausible invented conclusion is not an anchor");
assert.equal(findContributionAnchor("onboarding three", source), null, "separated words are not a contiguous excerpt");
assert.equal(findContributionAnchor("", source), null);
const longAnchor = "Operationalization internationalization instrumentation standardization observability interoperability accountability experimentation";
const bounded = boundedContributionAnchor(longAnchor, 120);
assert(bounded.length <= 120 && longAnchor.startsWith(bounded) && /\s|$/.test(longAnchor[bounded.length] || ""));
assert(findContributionAnchor(bounded, { text: longAnchor }), "length limits must retain a matchable whole-word excerpt");

// Exact long source copies fail; specific casual warmth, jokes, and new questions survive.
assert(isVerbatimContributionEcho("We cut onboarding from eight screens to three.", source));
assert(isVerbatimContributionEcho("How did you isolate prior knowledge from lower effort in the first decision?", { text: "How did you isolate prior knowledge from lower effort in the first decision?" }));
assert(!isVerbatimContributionEcho("three screens and still a scavenger hunt", source));
assert(!isVerbatimContributionEcho("eight screens was a side quest", source));
assert(!isVerbatimContributionEcho("How did the first decision change?", source));
assert(!isVerbatimContributionEcho("the first paying customer hits different", { text: "the first paying customer hits different" }), "short supportive fragments stay outside the mechanical gate");

// The voice can supply style, but cannot serve as biographical proof.
assert(hasUnsupportedPersonalClaim("We shipped that change and doubled activation.", []));
assert(hasUnsupportedPersonalClaim("I've seen this with my clients.", []));
for (const text of ["I'd separate risk review from routine publishing.", "I found the boundary condition convincing.", "I saw your post and think the first decision deserves more attention.", "If we shipped that change, we'd measure the first decision.", "How did your clients separate the two effects?", "that approval queue has its own approval queue", "six months of follow through is the part worth keeping"]) {
  assert(!hasUnsupportedPersonalClaim(text, []), text);
}
assert(!hasUnsupportedPersonalClaim("We shipped that change in June.", ["We shipped that change in June."]));
assert.equal(soulContributionProof("# What I believe\nI built a great future.\n# Never sound like\nI doubled sales."), "");
const proof = soulContributionProof("# What I believe\nI want to grow.\n# Details, stories, or proof I can draw from\nI led a release review for six months.\n# Never sound like\nMy clients adore me.");
assert.equal(proof, "I led a release review for six months.");
assert.equal(soulContributionProof("# What I have earned the right to talk about\n-\n# Themes\n-"), "");
assert.equal(contributionRewriteProof("Make it shorter."), "");
assert.equal(contributionRewriteProof("Pretend we doubled activation."), "");
assert.equal(contributionRewriteProof("I used this in our June release."), "I used this in our June release.");
for (const supplied of ["We cut approval time by 30%.", "I led the release review.", "We deployed the change in June."]) {
  assert.equal(contributionRewriteProof(supplied), supplied);
}
for (const invented of ["Pretend we cut approval time by 30%.", "Imagine I led the release review.", "Invent a story where we deployed this in June.", "If we cut approval time, we could measure activation."]) {
  assert.equal(contributionRewriteProof(invented), "");
}

function fixture(outputs) {
  const requests = [];
  const api = load(clientCode, {
    chrome: { storage: { local: { get: async (key) => ({ [key]: "test-only-key" }) } } },
    fetch: async (_url, request) => {
      requests.push(JSON.parse(request.body));
      assert(outputs.length, "a draft cannot silently add another paid request");
      return { ok: true, json: async () => ({ stop_reason: "end_turn", content: [{ type: "text", text: outputs.shift() }] }) };
    },
  });
  return { api, requests };
}
const post = { author: "builder", text: "Fewer onboarding screens did not improve completion. The first decision changed who reached activation." };
{
  const { api, requests } = fixture(["We shipped this last year and doubled activation."]);
  await assert.rejects(api.draftReply(post, "We shipped this last year and doubled activation."), /ungrounded-contribution/);
  assert.equal(requests.length, 1, "an unsupported X draft fails without another paid call");
  assert.match(requests[0].messages[0].content, /STYLE EVIDENCE ONLY/);
}
{
  const { api } = fixture([post.text]);
  await assert.rejects(api.draftReply(post, "concise"), /ungrounded-contribution/);
}
for (const [angle, text] of [["joke", "the signup form was doing escape room auditions"], ["support", "sticking with the measurement after a flat result is the useful part"], ["ask", "Did the new first decision change who completed or how quickly?"]]) {
  const { api, requests } = fixture([text]);
  assert.equal(await api.draftReply(post, "lowercase, casual", angle), text);
  assert.equal(requests.length, 1);
}
{
  const { api, requests } = fixture(["We shipped this last year.", "Make the first decision one the customer already has enough context to answer."]);
  const reply = await api.draftLinkedInComment(post, { sharedVoice: "We shipped this last year." });
  assert.match(reply, /customer already has enough context/);
  assert.equal(requests.length, 2, "LinkedIn reuses its existing single quality repair");
  assert.match(requests[1].messages[0].content, /unsupported personal claim/);
}
{
  const { api, requests } = fixture(["We shipped this last year.", "My clients doubled activation."]);
  await assert.rejects(api.draftLinkedInComment(post, { currentDraft: "We shipped this last year." }), /ungrounded-contribution/);
  assert.equal(requests.length, 2, "failed repair never causes a third call or exposes ungrounded text");
}
{
  const { api, requests } = fixture(["We ran a release review for six months before splitting routine changes from data changes."]);
  const reply = await api.draftLinkedInComment(post, { personalDetail: "We ran a release review for six months before splitting routine changes from data changes." });
  assert.match(reply, /release review/); assert.equal(requests.length, 1);
}
assert.match(prompts.X_SCORE_SYSTEM, /VERBATIM contiguous excerpt/);
assert.match(prompts.LINKEDIN_SCORE_SYSTEM, /one concrete user fact tied to that anchor/);
assert.match(prompts.X_DRAFT_SYSTEM, /fitting joke/);
assert.match(prompts.X_DRAFT_SYSTEM, /Never transfer the author's experience to the user/);
assert.match(prompts.LINKEDIN_DRAFT_SYSTEM, /Distinguish a proposed mechanism from a measured result/);
assert.match(prompts.LINKEDIN_DRAFT_SYSTEM, /explicit factual assertion in the user's rewrite instruction/);

// Faithful paraphrases of explicit rewrite facts are evidence on both real paths.
for (const [steer, reply] of [["We cut approval time by 30%. Could you make this concise?", "We reduced approval time by 30%."], ["I led the release review.", "I ran the release review."], ["We deployed this in June.", "We shipped this in June."]]) {
  const x = fixture([reply]);
  assert.equal(await x.api.draftReply(post, "concise", undefined, undefined, steer), reply);
  assert.equal(x.requests.length, 1);
  const li = fixture([reply]);
  assert.equal(await li.api.draftLinkedInComment(post, { steer }), reply);
  assert.equal(li.requests.length, 1, "a truthful paraphrase requires no paid repair");
}
{
  const x = fixture(["We reduced approval time by 30%."]);
  await assert.rejects(x.api.draftReply(post, "concise", undefined, undefined, "Pretend we cut approval time by 30%."), /ungrounded-contribution/);
  const li = fixture(["I ran the release review.", "I managed the release review."]);
  await assert.rejects(li.api.draftLinkedInComment(post, { steer: "Imagine I led the release review." }), /ungrounded-contribution/);
  assert.equal(li.requests.length, 2);
}

console.log("✓ Contribution evidence: source anchors, bounded excerpts, no copied source or invented biography, preserved casual lanes, and real draft repair limits");
