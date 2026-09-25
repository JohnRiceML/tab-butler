/** Execute the real feed scanner with controlled X rows, timers and broker replies. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as esbuild from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "../src/content/x-copilot.ts"), "utf8");
const contractBuild = await esbuild.build({ entryPoints: [join(here, "../src/lib/x-score-contract.ts")], bundle: true, format: "esm", write: false });
const contract = await import("data:text/javascript;base64," + Buffer.from(contractBuild.outputFiles[0].text).toString("base64"));
const contributionBuild = await esbuild.build({ entryPoints: [join(here, "../src/lib/x-contribution.ts")], bundle: true, format: "esm", write: false });
const contribution = await import("data:text/javascript;base64," + Buffer.from(contributionBuild.outputFiles[0].text).toString("base64"));
const presentationBuild = await esbuild.build({ entryPoints: [join(here, "../src/lib/opportunity-presentation.ts")], bundle: true, format: "esm", write: false });
const presentation = await import("data:text/javascript;base64," + Buffer.from(presentationBuild.outputFiles[0].text).toString("base64"));
const parsed = ts.createSourceFile("x-copilot.ts", source, ts.ScriptTarget.Latest, true);
const functionNames = new Set(["readFeedPost", "feedInputKey", "feedPostMatches", "scan", "scheduleFlush", "flush", "resetFeedScores", "rescan", "addManual", "postOverlayLabel", "shortStrength", "friendlyErr"]);
const variableNames = new Set(["THRESHOLD", "BATCH", "MAX_SCORE_CALLS", "scoreCalls", "enabled", "paused", "selfHandle", "noKeyNotified", "scanCapNotified", "xProducts", "seen", "opps", "queue", "inFlight", "scoreGeneration", "flushBusy", "scoreRetryAt", "scanErrorNotified", "scoreFailures", "manualScanUntil", "flushTimer", "dockOpen"]);
const selected = parsed.statements.filter((node) => ts.isFunctionDeclaration(node)
  ? functionNames.has(node.name?.text)
  : ts.isVariableStatement(node) && node.declarationList.declarations.some((declaration) => variableNames.has(declaration.name.getText(parsed))));
assert.equal(selected.length, functionNames.size + variableNames.size, "all tested production declarations must be present");
const harness = esbuild.transformSync(selected.map((node) => node.getText(parsed)).join("\n") + `
module.exports = { scan, flush, addManual, rescan, resetFeedScores, seen, opps, queue, inFlight, scoreFailures, readFeedPost, feedInputKey, postOverlayLabel,
  setProducts: (products) => { xProducts = products; }, get busy() { return flushBusy; } };
`, { loader: "ts", format: "cjs" }).code;

function fixture() {
  const rows = [], requests = [], timers = new Map(), notices = [], paints = [];
  let nextTimer = 0, scheduledScan = false, account = "me";
  const context = {
    module: { exports: {} }, console, Date,
    ...contract, ...contribution, ...presentation,
    location: { pathname: "/home" }, invalidated: false, commentedIds: new Set(), goobiSearchUntil: 0,
    document: { querySelectorAll: () => rows.filter((row) => row.isConnected) },
    statusInfo: (row) => ({ id: row.id, author: row.author }),
    outerText: (row) => row.text, quotedText: (row) => row.context,
    isReplyToOwnPost: (row) => !!row.ownReply, isPromoted: (row) => !!row.promoted,
    getSelf: () => account, currentReplyPace: () => ({ level: "steady" }),
    engagement: (row) => row.stats || {}, snapStats: (row) => row.stats || {},
    avatarUrl: () => undefined, displayName: () => undefined, isVerified: () => false,
    contextOK: () => true, teardown: () => {}, refreshGoobi: () => {}, touchGoobi: () => {}, renderDock: () => {},
    clearPostOverlay: (row) => { row.overlay = undefined; },
    badge: (row) => { row.overlay = "surfaced"; paints.push(row.id); },
    addButton: (row) => { row.overlay = "passed"; paints.push(row.id); },
    catId: (id) => id, catLabel: (id) => id || "Reply", effectiveScore: (opp) => opp.score,
    toast: (notice) => notices.push(notice),
    requestScan: () => { scheduledScan = true; },
    setTimeout: (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
    clearTimeout: (id) => timers.delete(id),
    send: (message) => new Promise((resolve) => requests.push({ message, resolve: (response) => {
      // Default valid assessments quote the exact dispatched input. Adversarial anchors are explicit.
      if (response?.scores) response = { ...response, scores: response.scores.map((row) => row.anchor === "one exact detail" ? { ...row, anchor: message.posts.find((post) => post.i === row.i)?.text.slice(0, 120) } : row) };
      resolve(response);
    } })),
  };
  runInNewContext(harness, context);
  const api = context.module.exports;
  return {
    ...api, rows, requests, timers, notices, paints,
    setAccount: (value) => { account = value; },
    row: (id, text = "A specific useful post") => {
      const row = { id, author: `author${id}`, text, isConnected: true, dataset: {} };
      rows.push(row); return row;
    },
    scan: () => { scheduledScan = false; api.scan(); },
    resumeScan: () => { if (scheduledScan) { scheduledScan = false; api.scan(); } },
    flush: async (scores) => {
      const pending = api.flush();
      if (scores) requests.at(-1).resolve({ scores });
      await pending;
    },
    start: api.flush,
  };
}
const score = (i, fit = 0.8, extra = {}) => ({ i, score: fit, reason: "Specific useful contribution", category: "value", anchor: "one exact detail", replyMove: "add_detail", replyBrief: "Explain the practical implication", risk: "none", ...extra });

// Complete output is required, including genuine passes, in arbitrary response order.
assert(contract.hasCompleteXScores([score(7), score(4, 0.2)], [4, 7]));
for (const bad of [[], [score(0)], [score(0), score(0)], [score(0), score(2)], [score(0), score(1, "0.8")], [score(0), score(1, NaN)], [score(0), score(1, 1.1)], [score(0), score(1, 0.7, { reason: "" })]]) {
  assert(!contract.hasCompleteXScores(bad, [0, 1]), "missing, duplicate or malformed rows must fail");
}
assert(contract.xScoreOutputTokens(12) >= 12 * 300, "a whole batch has space for every assessment");
assert(contract.xScoreOutputTokens(1) < contract.xScoreOutputTokens(12));

// Exercise the actual Claude client boundary with local mocked HTTP responses.
{
  const built = await esbuild.build({ entryPoints: [join(here, "../src/lib/claude-client.ts")], bundle: true, platform: "node", format: "cjs", write: false });
  let body, result;
  const module = { exports: {} };
  runInNewContext(built.outputFiles[0].text, {
    module, exports: module.exports, AbortController, setTimeout, clearTimeout,
    chrome: { storage: { local: { get: async (key) => ({ [key]: "test-only-key" }) } } },
    fetch: async (_url, request) => {
      body = JSON.parse(request.body);
      return { ok: true, json: async () => ({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(result) }] }) };
    },
  });
  const posts = Array.from({ length: 12 }, (_, i) => ({ i, author: `builder${i}`, text: "A grounded question about product distribution" }));
  result = { scores: posts.map((post) => score(post.i)) };
  assert.equal((await module.exports.scorePosts(posts, "Product distribution")).length, 12);
  assert.equal(body.max_tokens, contract.xScoreOutputTokens(12));
  assert.match(body.system, /every post independently/);
  result = { scores: [score(0)] };
  await assert.rejects(module.exports.scorePosts(posts, "Product distribution"), /bad-x-score-output/);
}

// A numeric high score is insufficient; these remain passes until the user explicitly pins one.
for (const guidance of [
  { risk: "generic" }, { risk: "hostile" }, { risk: "context_mismatch" },
  { anchor: "An invented detail absent from the post" }, { replyBrief: "Ask a question" },
  { anchor: "" }, { replyBrief: undefined }, { replyMove: undefined },
]) {
  const f = fixture(); const row = f.row("1"); f.scan(); await f.flush([score(0, 0.99, guidance)]);
  assert.equal(f.opps.size, 0, "unsafe/unsubstantiated high scores never enter the automatic queue");
  await f.addManual(row);
  assert(f.opps.get("1").manual, "explicit user pins remain available");
  assert.equal(f.requests.length, 1, "pinning a declined assessment does not reroll it");
  assert.equal(f.postOverlayLabel({ done: false, opp: f.opps.get("1"), kind: "surfaced" }), "＋ Your pick");
}

// Reproduce the report: a batch pass followed by manual Add used to make a second call.
{
  const f = fixture(); const row = f.row("1"); f.scan(); await f.flush([score(0, 0.3)]);
  assert.equal(row.overlay, "passed");
  await f.addManual(row);
  assert.equal(f.requests.length, 1, "unchanged manual Add must reuse the feed assessment");
  assert.equal(f.opps.get("1").score, 0.3);
  assert.equal(f.opps.get("1").manual, true);
  assert.equal(f.postOverlayLabel({ done: false, opp: f.opps.get("1"), kind: "surfaced" }), "＋ Your pick");
}

// All good posts qualify; indices, not response order, identify the corresponding article.
{
  const f = fixture(); for (let i = 0; i < 12; i++) f.row(String(i));
  f.scan(); await f.flush(Array.from({ length: 12 }, (_, i) => score(i, 0.7 + i / 100)).reverse());
  assert.equal(f.opps.size, 12);
  assert.equal(f.opps.get("11").score, 0.7 + 11 / 100);
}

// Content painted during the batching delay is captured before dispatch.
{
  const f = fixture(); const row = f.row("1", "Initial caption"); f.scan();
  row.text = "Complete claim with a concrete example"; row.context = "Quoted evidence"; row.ownReply = true;
  await f.flush([score(0, 0.5)]);
  assert.equal(f.requests[0].message.posts[0].text, row.text);
  assert.equal(f.requests[0].message.posts[0].context, row.context);
  assert.match(f.requests[0].message.posts[0].meta, /DIRECT COMMENT/);
  assert(f.opps.has("1"), "warm comments use their own threshold");
}

// Expanded text, late quote context and late warm-inbound context invalidate earlier passes.
for (const update of [{ text: "Now the actual specific point has loaded" }, { context: "Now the quoted claim has loaded" }, { ownReply: true }]) {
  const f = fixture(); const row = f.row("1"); f.scan(); await f.flush([score(0, 0.2)]);
  Object.assign(row, update); f.scan();
  assert(!f.seen.has("1"), "an earlier partial assessment is invalidated");
  assert.equal(row.overlay, undefined);
  await f.flush([score(0)]);
  assert.equal(f.opps.get("1").score, 0.8);
}

// Changed content during a request must not be painted with the old result.
{
  const f = fixture(); const row = f.row("1"); f.scan(); const pending = f.start();
  row.context = "Late context changes the meaning";
  f.requests[0].resolve({ scores: [score(0, 0.1)] }); await pending;
  assert(!f.seen.has("1")); f.resumeScan(); await f.flush([score(0)]);
  assert.equal(f.opps.get("1").context, row.context);
}

// Virtualized rows, duplicate mounts, and stale queue entries cannot cross-wire posts or stall later rows.
{
  const f = fixture(); const stale = f.row("old"); f.scan(); stale.isConnected = false;
  for (let i = 0; i < 15; i++) { const row = f.row(`gone${i}`); f.scan(); row.isConnected = false; }
  f.row("live"); f.row("live"); f.scan(); await f.flush([score(0)]);
  assert.equal(f.requests[0].message.posts.length, 1);
  assert(f.opps.has("live"));
}
{
  const f = fixture(); const row = f.row("old"); f.scan(); const pending = f.start();
  row.id = "new"; row.author = "newAuthor"; row.text = "New post in the same node";
  f.requests[0].resolve({ scores: [score(0, 0.1)] }); await pending;
  assert.equal(f.paints.length, 0, "an old pass never labels the recycled node");
  f.resumeScan(); await f.flush([score(0)]); assert(f.opps.has("new"));
}

// Incomplete/failed scans retry once, do not silently pass, and are released for explicit Rescan.
for (const response of [{ scores: [] }, { error: "temporary" }, undefined]) {
  const f = fixture(); f.row("1"); f.scan();
  for (let attempt = 0; attempt < 2; attempt++) {
    const pending = f.start(); f.requests.at(-1).resolve(response); await pending; f.resumeScan();
  }
  assert.equal(f.requests.length, 2);
  assert.equal(f.queue.length, 0);
  assert.equal(f.seen.size, 0);
  assert.equal(f.paints.length, 0);
  assert(f.notices.some((notice) => /couldn't be scored/.test(notice)));
  f.rescan(); await f.flush([score(0)]); assert(f.opps.has("1"));
}

// Jev setup and service failures expose the right action without altering retry bookkeeping.
for (const [error, message] of [
  ["jev-key-required", /set up Jev/],
  ["jev-analysis-consent-required", /set up Jev/],
  ["jev-http-401", /TypeSafe key/],
  ["jev-http-429", /rate limited/],
  ["jev-timeout", /Jev analysis is unavailable/],
]) {
  const f = fixture(); f.row("jev-failure"); f.scan();
  for (let attempt = 0; attempt < 2; attempt++) {
    const pending = f.start(); f.requests.at(-1).resolve({ error }); await pending; f.resumeScan();
  }
  assert(f.notices.some((notice) => message.test(notice)), `${error} surfaces actionable provider guidance`);
  assert.equal(f.requests.length, 2, "Jev failures keep the bounded retry lifecycle");
  assert.equal(f.queue.length, 0); assert.equal(f.seen.size, 0); assert.equal(f.paints.length, 0);
}

// Rescan/settings changes reject the prior generation, then score again without overlap.
{
  const f = fixture(); f.row("1"); f.scan(); const pending = f.start();
  await f.start(); assert.equal(f.requests.length, 1, "ambient batches are serialized");
  f.rescan(); f.requests[0].resolve({ scores: [score(0, 0.1)] }); await pending;
  assert.equal(f.seen.size, 0); f.resumeScan(); await f.flush([score(0)]); assert(f.opps.has("1"));
}

// Actual X account switches during a request cannot surface the previous account's assessment.
{
  const f = fixture(); f.row("1"); f.scan(); const pending = f.start();
  f.setAccount("other-account"); f.requests[0].resolve({ scores: [score(0)] }); await pending;
  assert.equal(f.seen.size, 0); assert.equal(f.opps.size, 0);
}

// An explicit pin survives a later high score followed by a lower rescan.
{
  const f = fixture(); const row = f.row("1"); const add = f.addManual(row);
  f.requests[0].resolve({ scores: [score(0, 0.3)] }); await add;
  f.rescan(); await f.flush([score(0)]); assert(f.opps.get("1").manual);
  f.rescan(); await f.flush([score(0, 0.2)]); assert(f.opps.get("1").manual);
}

// Auto and manual scoring share the exact payload; a manual click can share an existing request.
{
  const auto = fixture(), manual = fixture(); const a = auto.row("1"), b = manual.row("1");
  a.context = b.context = "Specific quoted context";
  auto.scan(); await auto.flush([score(0)]);
  const pending = manual.addManual(b); manual.requests[0].resolve({ scores: [score(0)] }); await pending;
  assert.equal(JSON.stringify(auto.requests[0].message), JSON.stringify(manual.requests[0].message));
}
{
  const f = fixture(); const row = f.row("1"); f.scan(); const pending = f.start();
  await f.addManual(row); assert.equal(f.requests.length, 1);
  f.requests[0].resolve({ scores: [score(0)] }); await pending; assert(f.opps.get("1").manual);
}

// Feed mutations must not starve an already scheduled flush timer.
{
  const f = fixture(); f.row("1"); f.scan(); const timer = [...f.timers.keys()][0];
  for (let i = 0; i < 20; i++) f.scan();
  assert.equal(f.timers.size, 1); assert(f.timers.has(timer));
}

console.log("✓ X feed scoring: batch/manual consistency, late content, retries, virtualization and rescan races passed");
