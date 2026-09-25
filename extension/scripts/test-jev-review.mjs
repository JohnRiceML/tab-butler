import assert from "node:assert/strict";
import { build } from "esbuild";
import { runInNewContext } from "node:vm";
const bundle = async name => (await build({ entryPoints: [new URL(`../src/lib/${name}.ts`, import.meta.url).pathname], bundle: true, platform: "node", format: "cjs", write: false })).outputFiles[0].text;
const [reviewCode, shadowCode, clientCode] = await Promise.all([bundle("jev-review"), bundle("jev-shadow"), bundle("claude-client")]);
const load = (code, extra = {}) => {
  const module = { exports: {} };
  runInNewContext(code, { module, exports: module.exports, AbortController, setTimeout, clearTimeout, ...extra });
  return module.exports;
};
const api = load(reviewCode);
const response = () => ({ model: "jev-1.13.0", usage: { input_tokens: 200 }, answers: Object.fromEntries(Object.entries(api.JEV_REVIEW_QUESTIONS).map(([name, q]) => {
  const choice = name === "evidence" ? "no_claim" : name === "stance" ? "no_stance" : "adds_value";
  return [name, { type: "choice", choice, confidence: 1, probabilities: Object.fromEntries(Object.keys(q.criteria).map(key => [key, key === choice ? 1 : 0])) }];
})) });
const input = { platform: "x", post: { text: "We removed a tutorial." }, draft: "Did referral mix change between cohorts?" };
assert.equal(api.parseJevReview(response(), 99).latencyMs, 99);
for (const mutate of [r => delete r.answers.evidence, r => r.model = "unknown", r => r.answers.evidence.choice = "invented", r => r.answers.evidence.confidence = NaN,
  r => r.answers.evidence.probabilities.no_claim = .5, r => r.usage.input_tokens = -1,
  r => r.answers.evidence.probabilities.extra = 0, r => r.answers.evidence.choice = "unsupported"]) {
  const raw = response(); mutate(raw);
  assert.throws(() => api.parseJevReview(raw, 1), /jev-invalid-response/);
}
assert.throws(() => api.jevReviewState({ ...input, soul: "x".repeat(6001) }), /jev-context-limit/);
assert.throws(() => api.jevReviewState({ ...input, draft: "" }), /jev-context-limit/);
assert.equal(api.jevReviewState({ ...input, author: "should-not-be-sent", key: "secret" }).author, undefined);
const flagged = response();
flagged.answers.evidence = { type: "choice", choice: "unsupported", confidence: 1, probabilities: { no_claim: 0, supported: 0, unsupported: 1, unclear: 0 } };
assert.deepEqual([...api.jevReviewFlags(api.parseJevReview(flagged, 1))], ["unsupported-experience"]);
flagged.answers.evidence.confidence = .89;
assert.equal(api.jevReviewFlags(api.parseJevReview(flagged, 1)).length, 0, "uncertainty never becomes a high confidence flag");

// Credentials go to exactly the fixed endpoint; response/body errors never echo secrets.
let calls = 0;
const transport = load(reviewCode, { fetch: async (url, request) => {
  calls++;
  assert.equal(url, "https://api.typesafe.ai/v1/systemone");
  assert.equal(request.headers.Authorization, "Bearer private-test-key");
  const body = JSON.parse(request.body);
  assert.equal(body.model, "jev-1.13.0");
  assert(!request.body.includes("private-test-key"));
  assert.equal(body.state.draft, input.draft);
  return { ok: true, json: async () => response() };
} });
await transport.reviewWithJev("private-test-key", input);
const aborted = new AbortController(); aborted.abort();
await assert.rejects(transport.reviewWithJev("private-test-key", input, aborted.signal), /jev-cancelled/);
assert.equal(calls, 1);
let errors = 0;
const http = load(reviewCode, { fetch: async () => {
  errors++; return { ok: false, status: 429, headers: { get: () => "30" }, json: async () => { throw new Error("must never read provider errors"); } };
} });
await assert.rejects(http.reviewWithJev("key", input), /jev-http-429/);
await assert.rejects(http.reviewWithJev("key", input), /jev-cooldown/);
assert.equal(errors, 1, "cooldown prevents paid retry storms");
const network = load(reviewCode, { fetch: async () => { throw new Error("private-test-key user text"); } });
await assert.rejects(network.reviewWithJev("key", input), { message: "jev-unavailable" });

// Bound the entire body read, not just headers. Cancelling releases the review slot.
let timeoutCallback;
const timeout = load(reviewCode, { setTimeout: callback => { timeoutCallback = callback; return 1; }, clearTimeout: () => {},
  fetch: async () => ({ ok: true, json: () => new Promise(() => {}) }) });
const timed = timeout.reviewWithJev("key", input);
for (let i = 0; i < 10; i++) await Promise.resolve();
const timedCheck = assert.rejects(timed, /jev-timeout/); timeoutCallback(); await timedCheck;

function environment(enabled = true, providerFailure = false) {
  const store = { anthropicKey: "claude-test-key", typesafeKey: "jev-test-key", jevReviewMode: enabled ? "shadow" : "off", jevReviewConsent: "v1" };
  const requests = [];
  const globals = {
    chrome: { storage: { local: {
      get: async keys => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, store[key]])),
      set: async values => { Object.assign(store, values); },
    } } },
    fetch: async (url, request) => {
      requests.push({ url, body: JSON.parse(request.body) });
      if (url.includes("typesafe")) {
        if (providerFailure) throw new Error("opaque-network-error");
        return { ok: true, json: async () => response() };
      }
      return { ok: true, json: async () => ({ stop_reason: "end_turn", content: [{ type: "text", text: input.draft }] }) };
    },
  };
  return { store, requests, globals };
}
for (const enabled of [true, false]) for (const providerFailure of [true, false]) {
  const env = environment(enabled, providerFailure);
  const client = load(clientCode, env.globals);
  assert.equal(await client.draftReply({ author: "source", ...input.post }, "PRIVATE STYLE SAMPLE"), input.draft);
  assert.equal(await client.draftLinkedInComment({ author: "source", ...input.post }, { linkedInVoice: "PRIVATE STYLE SAMPLE" }), input.draft);
  const reviews = env.requests.filter(r => r.url.includes("typesafe"));
  assert.equal(reviews.length, enabled ? 2 : 0);
  assert(!JSON.stringify(reviews).includes("PRIVATE STYLE SAMPLE"), "style samples never sent to Jev");
  if (enabled) {
    assert.equal(env.store.jevReviewLog.length, 2);
    assert.equal(env.store.jevReviewLog[0].status, providerFailure ? "unavailable" : "reviewed");
    assert(!JSON.stringify(env.store.jevReviewLog).includes(input.draft));
    assert(!JSON.stringify(env.store.jevReviewLog).includes("test-key"));
  }
}
for (const missing of ["typesafeKey", "jevReviewConsent"]) {
  const env = environment(); delete env.store[missing];
  await load(shadowCode, env.globals).observeCommentWithJev(input);
  assert.equal(env.requests.length, 0, `${missing} is required, mode alone never opts in`);
}
const env = environment();
env.store.jevReviewLog = Array.from({ length: 50 }, (_, at) => ({ at, platform: "x", status: "reviewed" }));
const observer = load(shadowCode, env.globals);
await Promise.all([observer.observeCommentWithJev(input), observer.observeCommentWithJev({ ...input, platform: "linkedin" })]);
assert.equal(env.store.jevReviewLog.length, 50);
assert.equal(env.store.jevReviewLog[0].at, 2, "concurrent writes preserve both completions and cap retention");
assert.deepEqual([...env.store.jevReviewLog.slice(-2)].map(r => r.platform).sort(), ["linkedin", "x"]);
console.log("✓ Jev: strict response validation, fixed destination, redacted errors, timeout/cancellation/cooldown, explicit opt-in, X + LinkedIn shadow integration, unchanged drafts and text-free bounded retention");
