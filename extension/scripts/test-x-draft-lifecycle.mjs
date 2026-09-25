/** Exercise actual production continuations with deferred broker responses. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as esbuild from "esbuild";
const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "../src/content/x-copilot.ts"), "utf8");
const parsed = ts.createSourceFile("x-copilot.ts", source, ts.ScriptTarget.Latest, true);
const names = new Set(["draftFor", "dismissPanel", "setPaused", "draftTargetReply"]);
const selected = parsed.statements.filter((node) => ts.isFunctionDeclaration(node) && names.has(node.name?.text));
assert.equal(selected.length, names.size);
// Test the actual storage listener, including captured boot gate state, without running boot.
const boot = parsed.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "boot");
let listener;
function visit(node) {
  if (ts.isCallExpression(node) && node.expression.getText(parsed) === "chrome.storage.onChanged.addListener") listener = node.arguments[0].getText(parsed);
  ts.forEachChild(node, visit);
}
visit(boot);
assert(listener);
const code = esbuild.transformSync(selected.map((node) => node.getText(parsed)).join("\n") + `\nmodule.exports = { draftFor, dismissPanel, setPaused, draftTargetReply, storageChanged: ${listener} };`, { loader: "ts", format: "cjs" }).code;
const { outputFiles } = await esbuild.build({ entryPoints: [join(here, "../src/lib/config.ts")], bundle: true, format: "esm", write: false });
const policyBuild = await esbuild.build({ entryPoints: [join(here, "../src/lib/x-policy.ts")], bundle: true, format: "esm", write: false });
const contributionBuild = await esbuild.build({ entryPoints: [join(here, "../src/lib/x-contribution.ts")], bundle: true, format: "esm", write: false });
const { assessXContribution } = await import("data:text/javascript;base64," + Buffer.from(contributionBuild.outputFiles[0].text).toString("base64"));
const { sanitizeXDraftPayload } = await import("data:text/javascript;base64," + Buffer.from(policyBuild.outputFiles[0].text).toString("base64"));
const { CONFIG } = await import("data:text/javascript;base64," + Buffer.from(outputFiles[0].text).toString("base64"));
function fixture() {
  const requests = [], paints = [], notices = [];
  const context = {
    module: { exports: {} }, CONFIG, assessXContribution,
    enabled: true, paused: false, invalidated: false, scoreGeneration: 0, draftRequestSeq: 0,
    xDataConsent: true, hasAnthropicKey: true, requestedOn: true,
    contextOK: () => true, account: "me", getSelf: () => context.account,
    pendingManualReply: null, lastDraft: null, draftOppId: null, draftOppAuthor: "", xProducts: [], goobiDrafting: false,
    panelRoot: null, panelHost: null, panelReturnFocus: null,
    opps: new Map(), targetPosts: new Map(), targetDrafts: new Map(), targetBusy: new Set(), targetStore: { targets: [] },
    seen: new Map(), dockPlayOpen: false, noKeyNotified: false,
    X_PAYLOAD_LIMITS: { text: 400, context: 320, product: 16000, steer: 500, reason: 120 },
    canUseXBroker: (consent, enabled, key) => consent === "v1" && enabled && !!key,
    renderDock: () => {}, refreshGoobi: () => {}, resetPlay: () => {}, renderPendingManualReplyCard: () => {},
    safeSet: () => {}, rescan: () => { context.scoreGeneration++; }, requestScan: () => {},
    resetFeedScores: () => { context.scoreGeneration++; },
    ensurePanel: () => { context.panelRoot ??= {}; context.panelHost ??= { remove: () => {} }; return context.panelRoot; },
    paintPanel: (root, author, text, opts) => paints.push({ root, author, text, opts }),
    productContext: () => undefined, defaultProductIndex: () => 0,
    knownFollowers: () => undefined, builderTierFor: () => 0, currentFreshReach: () => null,
    initialAngle: () => "value", preferredReplyStyle: () => "community-spark", catId: (id) => id,
    hasCompleteXScores: (scores) => scores?.length === 1 && scores[0].i === 0,
    pickFreshReachCandidates: () => [], freshReachContentEligible: () => false, myFollowers: 100,
    dmStore: { ownerHandle: "" }, growthStore: { ownerHandle: "" }, replyLog: { authors: {} }, friendlyErr: (s) => s,
    toast: (notice) => notices.push(notice),
    send: (msg) => {
      if (msg.type === "DRAFT_REPLY") assert(sanitizeXDraftPayload(msg), "real panel and target requests pass the broker policy");
      return new Promise((resolve) => requests.push({ msg, resolve }));
    },
  };
  runInNewContext(code, context);
  return { api: context.module.exports, context, requests, paints, notices };
}
const req = { author: "builder", text: "A practical concrete claim" };
{
  const f = fixture(); const old = f.api.draftFor(req); const fresh = f.api.draftFor({ ...req, steer: "Warmer" });
  f.requests[1].resolve({ reply: "Newest draft" }); await fresh;
  f.requests[0].resolve({ reply: "Stale draft" }); await old;
  assert.deepEqual(f.paints.filter((paint) => paint.opts.draft).map((paint) => paint.opts.draft), ["Newest draft"]);
}
for (const retire of [
  (f) => f.api.dismissPanel(),
  (f) => { f.api.setPaused(true); f.api.setPaused(false); },
  (f) => { f.context.account = "different"; },
  (f) => { f.context.invalidated = true; },
  (f) => f.api.storageChanged({ [CONFIG.X_PAUSED_KEY]: { newValue: true } }, "local"),
  (f) => f.api.storageChanged({ [CONFIG.X_DATA_CONSENT_KEY]: { newValue: undefined } }, "local"),
  (f) => f.api.storageChanged({ [CONFIG.X_COPILOT_KEY]: { newValue: false } }, "local"),
  (f) => f.api.storageChanged({ [CONFIG.ANTHROPIC_KEY_KEY]: { newValue: "" } }, "local"),
  (f) => f.api.storageChanged({ [CONFIG.X_VOICE_KEY]: { newValue: "New voice" } }, "local"),
]) {
  const f = fixture(); const pending = f.api.draftFor(req); retire(f);
  f.requests[0].resolve({ reply: "Obsolete draft" }); await pending;
  assert.equal(f.paints.filter((paint) => paint.opts.draft).length, 0, "retired requests cannot repaint a draft");
  assert.equal(f.context.goobiDrafting, false);
}
{
  const f = fixture(); f.context.paused = true; await f.api.draftFor(req); await f.api.draftTargetReply("builder");
  assert.equal(f.requests.length, 0, "paused entry points never dispatch");
}
{
  const f = fixture(); const pending = f.api.draftFor({ ...req, text: "x".repeat(1000), context: "y".repeat(800) });
  assert.equal(f.requests[0].msg.text.length, 400); assert.equal(f.requests[0].msg.context.length, 320);
  f.requests[0].resolve({ reply: "Specific draft" }); await pending; assert.equal(f.paints.at(-1).opts.draft, "Specific draft");
}
for (const beforeScore of [true, false]) {
  const f = fixture(); const post = { id: "123", author: "builder", text: req.text };
  f.context.targetPosts.set("builder", post);
  if (!beforeScore) f.context.opps.set(post.id, { ...post, score: 0.8, reason: "Useful" });
  const pending = f.api.draftTargetReply("builder");
  f.api.setPaused(true); f.api.setPaused(false);
  f.requests[0].resolve(beforeScore ? { scores: [{ i: 0, score: 0.8, reason: "Useful" }] } : { reply: "Obsolete target draft" });
  await pending;
  assert.equal(f.context.targetDrafts.size, 0); assert.equal(f.requests.length, 1, "retired score cannot start target drafting");
  assert.equal(f.context.targetBusy.size, 0, "target request always releases its busy state");
}
{
  const f = fixture(); const post = { id: "123", author: "builder", text: req.text };
  f.context.targetPosts.set("builder", post); f.context.opps.set(post.id, { ...post, reason: "Useful" });
  const pending = f.api.draftTargetReply("builder"); f.context.targetPosts.set("builder", { ...post, id: "456" });
  f.requests[0].resolve({ reply: "Wrong post draft" }); await pending; assert.equal(f.context.targetDrafts.size, 0);
}
// Explicit target selection remains possible, but a high-risk score is not presented as a recommendation.
{
  const f = fixture(); const post = { id: "123", author: "builder", text: req.text };
  f.context.targetPosts.set("builder", post);
  const pending = f.api.draftTargetReply("builder");
  f.requests[0].resolve({ scores: [{ i: 0, score: 0.99, reason: "High score", category: "value", anchor: "practical concrete claim", replyMove: "add_detail", replyBrief: "Invent a hostile claim about the author", risk: "hostile" }] });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert(f.context.opps.get(post.id).manual);
  assert.equal(f.requests[1].msg.anchor, undefined); assert.equal(f.requests[1].msg.replyBrief, undefined);
  f.requests[1].resolve({ reply: "A user-reviewed response" }); await pending;
  assert.equal(f.context.targetDrafts.get("builder"), "A user-reviewed response");
}
console.log("✓ X draft lifecycle: newest-request ownership, pause/resume, consent/key/voice changes, close/account changes, target post identity passed");
