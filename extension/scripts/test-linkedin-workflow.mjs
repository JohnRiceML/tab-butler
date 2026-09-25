/** Execute the real content workflow with controlled broker callbacks and no live DOM/API. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runInNewContext } from "node:vm";
import * as esbuild from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "../src/content/linkedin-copilot.ts"), "utf8");
const harness = `
renderDock = () => {};
showNotice = (value) => { notice = value; };
clearRails = () => {};
syncOpportunityRails = () => {};
extractPost = () => null;
let scans = 0;
scan = () => { scans += 1; scheduleFlush(); };
export const test = {
  config: CONFIG, flushScores, scheduleFlush, retryScoring, draftComment, setPaused, onStorageChanged,
  start() { active = enabled = consented = hasKey = focusReady = brokerCompatible = true; },
  enqueue(id) {
    queue.push({ id, author: "Ada", authorKind: "person", text: "A bounded post snapshot", node: { isConnected: false }, generation, scoreAttempts: 0 });
    queuedIds.add(id);
  },
  opportunity(id, decision = "comment") {
    opportunities.set(id, { id, author: "Ada", authorKind: "person", text: "The approved post", decision });
  },
  editedDraft(id) { draft = { id, state: "ready", text: "My edited comment", steer: "shorter", personalDetail: "My real example", request: ++requestSequence }; selectedId = id; },
  state() { return { active, paused, generation, requestSequence, scoringError, queue: queue.map(p => p.id), attempts: queue.map(p => p.scoreAttempts), scoredPostCount, opportunities: [...opportunities.keys()], draft, scans, flushInProgress, notice }; }
};
`;
const bundle = esbuild.buildSync({
  stdin: { contents: source + harness, resolveDir: join(here, "../src/content"), loader: "ts" },
  bundle: true, write: false, format: "cjs", platform: "browser",
}).outputFiles[0].text;

function setup() {
  const pending = [];
  const storageReads = [];
  const timers = new Map();
  let nextTimer = 1;
  const exports = {};
  const module = { exports };
  const location = { href: "https://www.linkedin.com/feed/" };
  runInNewContext(bundle, {
    exports, module, location, URL, console: { debug() {} },
    matchMedia: () => ({}),
    window: {
      top: null,
      setTimeout(fn) { const id = nextTimer++; timers.set(id, fn); return id; },
      clearTimeout(id) { timers.delete(id); },
    },
    chrome: {
      runtime: { id: "test", sendMessage(message, callback) { pending.push({ message, callback }); } },
      storage: { local: { get(keys, callback) { storageReads.push({ keys, callback }); }, set(value, callback) { callback(); } } },
    },
  });
  const api = module.exports.test;
  api.start();
  return { api, pending, storageReads, timers, location };
}

const ids = (values) => Array.from(values);

// A failed provider must stop automatic spending, retain detached snapshots,
// and retry without throwing away the user's edits or approved opportunities.
{
  const { api, pending, timers } = setup();
  api.opportunity("saved");
  api.editedDraft("saved");
  for (let i = 0; i < 7; i++) api.enqueue(`p${i}`);
  const task = api.flushScores();
  assert.equal(pending.length, 1);
  pending.shift().callback({ error: "anthropic 429" });
  await task;
  assert.match(api.state().scoringError, /rate limiting/);
  assert.equal(api.state().queue.length, 7);
  assert.equal(timers.size, 0, "no automatic queue continuation after an error");
  await api.flushScores();
  api.scheduleFlush();
  assert.equal(pending.length, 0, "a direct flush cannot bypass the failure latch");
  assert.equal(timers.size, 0);
  api.retryScoring();
  assert.equal(api.state().scoringError, "");
  assert.deepEqual(ids(api.state().opportunities), ["saved"]);
  assert.equal(api.state().draft.text, "My edited comment");
  assert.equal(api.state().draft.personalDetail, "My real example");
  assert.equal(timers.size, 1, "explicit retry resumes the retained queue");
  const retry = api.flushScores();
  assert.equal(pending[0].message.posts.length, 5);
  pending.shift().callback({ scores: Array.from({ length: 5 }, (_, i) => ({ i, decision: "skip", risk: "none" })) });
  await retry;
  assert.equal(api.state().scoredPostCount, 5);
  assert.deepEqual(ids(api.state().queue), ["p5", "p6"]);
}

// Malformed output gets exactly one automatic per-post retry, then waits for
// the user; repeated feed mutations cannot renew that retry allowance.
{
  const { api, pending, timers } = setup();
  api.enqueue("broken");
  let task = api.flushScores();
  pending.shift().callback({ scores: [] });
  await task;
  assert.deepEqual(ids(api.state().attempts), [1]);
  const [timerId, callback] = [...timers][0];
  timers.delete(timerId);
  callback();
  assert.equal(pending.length, 1);
  pending.shift().callback({ scores: [] });
  await Promise.resolve();
  await Promise.resolve();
  assert.match(api.state().scoringError, /incomplete/);
  assert.equal(timers.size, 0);
  await api.flushScores();
  assert.equal(pending.length, 0);
}

// Context changes invalidate synchronously while the new storage read remains
// unresolved, covering the race before reconcileGate can apply new settings.
for (const setting of ["LI_STRATEGY_KEY", "X_NICHE_KEY", "ANTHROPIC_KEY_KEY", "LI_VOICE_KEY", "X_VOICE_KEY", "ANALYSIS_PROVIDER_KEY", "JEV_ANALYSIS_CONSENT_KEY", "TYPESAFE_KEY_KEY"]) {
  const { api, pending, storageReads } = setup();
  api.opportunity("draft-post");
  api.enqueue("score-post");
  const scoring = api.flushScores();
  const drafting = api.draftComment("draft-post", "shorter", "My existing edit", "My real fact");
  assert.equal(pending.length, 2);
  const priorGeneration = api.state().generation;
  api.onStorageChanged({ [api.config[setting]]: { newValue: setting === "LI_STRATEGY_KEY" ? { thesis: "new focus" } : "new value" } }, "local");
  assert.equal(storageReads.length, 1);
  assert.ok(api.state().generation > priorGeneration);
  assert.equal(api.state().active, false);
  pending[0].callback({ scores: [{ i: 0, decision: "skip", risk: "none" }] });
  pending[1].callback({ reply: "An obsolete generated comment" });
  await Promise.all([scoring, drafting]);
  assert.equal(api.state().scoredPostCount, 0, `${setting}: old scores ignored`);
  assert.notEqual(api.state().draft?.text, "An obsolete generated comment", `${setting}: old draft ignored`);
  if (["LI_VOICE_KEY", "X_VOICE_KEY", "ANTHROPIC_KEY_KEY"].includes(setting)) {
    assert.equal(api.state().draft.state, "error");
    assert.equal(api.state().draft.text, "My existing edit");
  }
}

// Reject route-stale replies even in the interval before the URL watcher fires.
{
  const { api, pending, location } = setup();
  api.opportunity("post");
  api.enqueue("score");
  const scoring = api.flushScores();
  const drafting = api.draftComment("post");
  location.href = "https://www.linkedin.com/feed/update/urn:li:activity:123/";
  pending[0].callback({ scores: [{ i: 0, decision: "skip", risk: "none" }] });
  pending[1].callback({ reply: "Wrong route draft" });
  await Promise.all([scoring, drafting]);
  assert.equal(api.state().scoredPostCount, 0);
  assert.notEqual(api.state().draft.text, "Wrong route draft");
}

{
  const { api, pending } = setup();
  api.opportunity("detail", "needs_detail");
  await api.draftComment("detail", "", "", "  ");
  assert.equal(pending.length, 0, "required personal grounding is enforced at dispatch");
  const task = api.draftComment("detail", "", "", "One real implementation detail");
  assert.equal(pending.length, 1);
  api.setPaused(true);
  pending.shift().callback({ reply: "Late paused result" });
  await task;
  assert.equal(api.state().draft.state, "error");
  assert.notEqual(api.state().draft.text, "Late paused result");
}

// Source grounding is candidate-local: one invented anchor does not discard a
// valid neighboring assessment or turn the scan into an expensive retry loop.
{
  const { api, pending } = setup();
  api.enqueue("grounded");
  api.enqueue("invented");
  const task = api.flushScores();
  const assessment = {
    decision: "comment", risk: "none", score: 0.85,
    postFit: 0.85, personFit: 0.5, contributionFit: 0.85,
    postReason: "Discusses snapshot handling", personReason: "Limited author context", personEvidence: "name_only",
    anchor: "bounded post snapshot", commentLane: "boundary_condition", replyBrief: "Explain when a disconnected snapshot still describes the intended post",
  };
  pending.shift().callback({ scores: [
    { ...assessment, i: 0 },
    { ...assessment, i: 1, anchor: "revenue doubled after automation" },
  ] });
  await task;
  assert.equal(api.state().scoredPostCount, 2);
  assert.equal(api.state().scoringError, "");
  assert.deepEqual(ids(api.state().opportunities), ["grounded"]);
  assert.equal(api.state().queue.length, 0);
  assert.equal(pending.length, 0);
}

{
  const { api, pending } = setup();
  api.opportunity("post");
  const task = api.draftComment("post", "Tighter", "My edited contribution", "My exact example");
  pending.shift().callback({ error: "ungrounded-contribution" });
  await task;
  assert.equal(api.state().draft.state, "error");
  assert.equal(api.state().draft.text, "My edited contribution");
  assert.equal(api.state().draft.personalDetail, "My exact example");
  assert.match(api.state().draft.error, /Add a real detail/);
}

console.log("✓ LinkedIn workflow: provider failure, retry, context races, route changes, pause, detail grounding, and source-aware selection passed");
