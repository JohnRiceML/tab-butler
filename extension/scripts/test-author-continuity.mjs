import assert from "node:assert/strict";
import { build } from "esbuild";
import { runInNewContext } from "node:vm";

async function bundle(name) {
  return (await build({ entryPoints: [new URL(`../src/lib/${name}.ts`, import.meta.url).pathname], bundle: true, platform: "node", format: "cjs", write: false })).outputFiles[0].text;
}
function load(code, globals = {}) {
  const module = { exports: {} };
  runInNewContext(code, { module, exports: module.exports, setTimeout, clearTimeout, AbortController, ...globals });
  return module.exports;
}
const [historyCode, evidenceCode, clientCode] = await Promise.all([bundle("author-continuity"), bundle("contribution-evidence"), bundle("claude-client")]);
const { selectAuthorContinuity, authorContinuityPrompt } = load(historyCode);
const { hasUnsupportedExperienceDenial, contributionRewriteProof } = load(evidenceCode);
const now = Date.UTC(2026, 8, 7);
const cache = { handle: "tester", at: now, stats: [
  { text: "I tested GPT 6 on coding tasks. It still needs review on unfamiliar repos.", postedAt: now - 1000 },
  { text: "I haven't tried GPT 6 yet. Waiting for a useful coding comparison.", postedAt: now - 86400000 },
  { text: "My angle: repeatable tests matter more than launch day demos.", postedAt: now - 2000 },
] };
const history = selectAuthorContinuity(cache, "@Tester", "GPT 6 coding comparisons", now);
assert.equal(history.posts[0].text, cache.stats[0].text);
assert(history.posts.at(-1).text.includes("haven't tried"), "newer experience precedes older inexperience without silently losing chronology");
assert.equal(selectAuthorContinuity(cache, "anotherAccount", "GPT 6", now), undefined);
assert.equal(selectAuthorContinuity(cache, "", "GPT 6", now), undefined);
assert.equal(selectAuthorContinuity({ ...cache, at: NaN }, "tester", "GPT 6", now), undefined);
assert.equal(selectAuthorContinuity({ ...cache, at: now + 86400000 }, "tester", "GPT 6", now), undefined);
const legacy = selectAuthorContinuity({ handle: "tester", at: now - 86400000 * 90, posts: ["I tested GPT 6 on coding tasks."] }, "tester", "GPT 6", now);
assert.equal(legacy.posts[0].postedAt, undefined, "cache time is not fabricated as a publication date");
assert.match(authorContinuityPrompt(legacy), /"postedAt":"unknown"/);
assert.match(authorContinuityPrompt(), /Missing history means unknown/);
const large = selectAuthorContinuity({ handle: "tester", at: now, posts: Array.from({ length: 40 }, (_, i) => `Post ${i}. ${"useful context ".repeat(110)}`) }, "tester", "useful context", now);
assert(large.posts.length <= 10 && large.posts.reduce((sum, post) => sum + post.text.length, 0) <= 6000);
assert.equal(selectAuthorContinuity({ handle: "tester", at: now, posts: ["x".repeat(2001)] }, "tester", "x", now), undefined, "never truncate a statement into a different claim");

for (const draft of ["I haven't tried it.", "I haven’t actually tested GPT 6 yet, but reproducibility matters.", "I've never used GPT 6.", "I have no experience with it.", "We have yet to try GPT 6.", "I don't use GPT 6.", "I haven't tried it, have you?"]) {
  assert(hasUnsupportedExperienceDenial(draft, []), draft);
  assert(hasUnsupportedExperienceDenial(draft, ["We built a browser extension.", ...cache.stats.map(post => post.text)]), `unrelated details and older denials don't establish ${draft}`);
}
for (const draft of ["I would test it with a fixed prompt set.", "If I haven't tested an edge case, it belongs in the next run.", "Have you tried it on coding tasks?", "The author hasn't tested it yet."]) {
  assert(!hasUnsupportedExperienceDenial(draft, []), draft);
}
assert(!hasUnsupportedExperienceDenial("I haven't tried GPT 6 yet.", ["I have not tried GPT 6 yet."]));
assert.equal(contributionRewriteProof("I haven't tried GPT 6 yet."), "I haven't tried GPT 6 yet.");
assert.equal(contributionRewriteProof("Pretend I haven't tried GPT 6 yet."), "");

function fixture(outputs) {
  const requests = [];
  const api = load(clientCode, {
    chrome: { storage: { local: { get: async key => ({ [key]: "fixture-key" }) } } },
    fetch: async (_url, request) => {
      requests.push(JSON.parse(request.body));
      assert(outputs.length, "only one bounded repair is allowed");
      return { ok: true, json: async () => ({ stop_reason: "end_turn", content: [{ type: "text", text: outputs.shift() }] }) };
    },
  });
  return { api, requests };
}
const target = { author: "builder", text: "GPT 6 coding benchmarks need more realistic tasks." };
// History alone can ground an actual self-report, but a topic mention cannot unlock biography.
for (const platform of ["x", "linkedin"]) {
  const call = (api, continuity) => platform === "x"
    ? api.draftReply(target, "plain", undefined, undefined, undefined, undefined, undefined, undefined, "x", undefined, continuity)
    : api.draftLinkedInComment(target, { sharedVoice: "plain", continuity });
  const actual = fixture(["I tested GPT 6 on coding tasks."]);
  assert.equal(await call(actual.api, history), "I tested GPT 6 on coding tasks.");
  const topicOnly = { capturedAt: now, posts: [{ text: "GPT 6 coding demos look interesting." }] };
  const invented = fixture(platform === "x" ? ["I tested GPT 6 on coding tasks."] : ["I tested GPT 6 on coding tasks.", "I used GPT 6 for client work."]);
  await assert.rejects(call(invented.api, topicOnly), /ungrounded-contribution/);
}
for (const platform of ["x", "linkedin"]) {
  const draft = (api, continuity, steer) => platform === "x"
    ? api.draftReply(target, "plain", undefined, "We built a browser extension.", steer, undefined, undefined, "# What I believe\nRepeatable tests beat launch demos.", "x", undefined, continuity)
    : api.draftLinkedInComment(target, { sharedVoice: "plain", personalDetail: "We built a browser extension.", soulMd: "# What I believe\nRepeatable tests beat launch demos.", continuity, steer });
  const corrected = "I tested GPT 6 on coding tasks. Unfamiliar repos still need review.";
  const f = fixture(["I haven't tried it, but the test setup matters.", corrected]);
  assert.equal(await draft(f.api, history), corrected);
  assert.equal(f.requests.length, 2);
  for (const request of f.requests) {
    assert.match(request.messages[0].content, /AUTHOR CONTINUITY/);
    assert(request.messages[0].content.includes(cache.stats[0].text), `${platform} keeps actual experience through repair`);
    assert(request.messages[0].content.includes(cache.stats[2].text), `${platform} supplies the user's posted angle`);
    assert.match(request.system, /Do not blindly agree/);
  }
  const failed = fixture(["I haven't tried it.", "I've never tested it."]);
  await assert.rejects(draft(failed.api, history), /author-continuity/);
  assert.equal(failed.requests.length, 2);
  const missing = fixture(["I haven't tried it.", "Keep the prompt set fixed when comparing coding models."]);
  assert.match(await draft(missing.api), /prompt set/);
  const explicit = fixture(["I haven't tried GPT 6 yet."]);
  assert.equal(await draft(explicit.api, undefined, "I haven't tried GPT 6 yet."), "I haven't tried GPT 6 yet.");
  assert.equal(explicit.requests.length, 1, "an explicit current user fact remains usable");
}
console.log("✓ author continuity: dated account history, bounded context, GPT 6 regression on both drafters, and unsupported inexperience repair/block");
