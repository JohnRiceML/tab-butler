/** Zero-cost regressions for the real shared client and its abortable request queue. */
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import * as esbuild from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const build = async (file) => (await esbuild.build({ entryPoints: [join(here, `../src/lib/${file}.ts`)], bundle: true, platform: "node", format: "cjs", write: false })).outputFiles[0].text;
const [governorCode, clientCode] = await Promise.all([build("claude-request-governor"), build("claude-client")]);
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const pending = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

function clock() {
  let now = 1_000_000, nextId = 0;
  const timers = new Map();
  return {
    globals: {
      Date: class extends Date { static now() { return now; } },
      setTimeout: (callback, delay) => { const id = ++nextId; timers.set(id, { at: now + delay, callback }); return id; },
      clearTimeout: (id) => timers.delete(id),
      AbortController,
    },
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const entry = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!entry) break;
        now = entry[1].at; timers.delete(entry[0]); entry[1].callback(); await flush();
      }
      now = end; await flush();
    },
    get timerCount() { return timers.size; },
  };
}

function load(code, extra = {}) {
  const time = clock();
  const module = { exports: {} };
  runInNewContext(code, { module, exports: module.exports, ...time.globals, ...extra });
  return { ...module.exports, time };
}

// Concurrency, bounded FIFO waiting, overflow, and release after failure.
{
  const { createClaudeRequestGovernor, time } = load(governorCode);
  const governor = createClaudeRequestGovernor({ maxConcurrency: 2, maxQueue: 2 });
  const tasks = Array.from({ length: 4 }, pending), starts = [];
  const jobs = tasks.map((task, i) => governor.run(async () => { starts.push(i); return task.promise; }));
  const failed = assert.rejects(jobs[1], /network-failed/);
  await assert.rejects(governor.run(async () => "overflow"), /anthropic-busy/);
  await flush(); assert.deepEqual(starts, [0, 1]);
  tasks[0].resolve("one"); await flush(); assert.deepEqual(starts, [0, 1, 2]);
  tasks[1].reject(new Error("network-failed")); await failed; await flush();
  assert.deepEqual(starts, [0, 1, 2, 3]);
  tasks[2].resolve("three"); tasks[3].resolve("four");
  assert.deepEqual(await Promise.all([jobs[0], jobs[2], jobs[3]]), ["one", "three", "four"]);
  assert.equal(time.timerCount, 0);
}

// Queue expiry never invokes work. A transport timeout aborts and admits the next job.
{
  const { createClaudeRequestGovernor, time } = load(governorCode);
  const governor = createClaudeRequestGovernor({ maxConcurrency: 1, queueTimeoutMs: 10, requestTimeoutMs: 30 });
  let transport, queuedStarted = false;
  const first = governor.run(async (signal) => { transport = signal; return new Promise(() => {}); });
  const firstRejected = assert.rejects(first, /anthropic-timeout/);
  const second = governor.run(async () => { queuedStarted = true; return "expired"; });
  const secondRejected = assert.rejects(second, /anthropic-queue-timeout/);
  await flush(); await time.advance(10); await secondRejected;
  assert.equal(queuedStarted, false); assert.equal(transport.aborted, false);
  await time.advance(15);
  const third = governor.run(async () => "admitted after timeout");
  await time.advance(5); await firstRejected;
  assert.equal(transport.aborted, true); assert.equal(await third, "admitted after timeout");
  assert.equal(time.timerCount, 0);
}

// Consent/settings cancellation removes queued tasks and aborts active transports.
{
  const { createClaudeRequestGovernor, time } = load(governorCode);
  const governor = createClaudeRequestGovernor({ maxConcurrency: 1 });
  const activeController = new AbortController(), queuedController = new AbortController();
  let transport, queuedStarted = false;
  const active = governor.run(async (signal) => { transport = signal; return new Promise(() => {}); }, activeController.signal);
  const activeRejected = assert.rejects(active, /anthropic-cancelled/);
  const queued = governor.run(async () => { queuedStarted = true; }, queuedController.signal);
  const queuedRejected = assert.rejects(queued, /anthropic-cancelled/);
  await flush(); queuedController.abort(); await queuedRejected;
  activeController.abort(); await activeRejected;
  assert.equal(queuedStarted, false); assert.equal(transport.aborted, true);
  await assert.rejects(governor.run(async () => { throw new Error("must not start"); }, activeController.signal), /anthropic-cancelled/);
  assert.equal(await governor.run(async () => "released"), "released");
  assert.equal(time.timerCount, 0);
}

// Respect provider backoff, reject waiting requests, and require a new explicit call.
{
  const { createClaudeRequestGovernor, claudeRetryAfterMs, time } = load(governorCode);
  assert.equal(claudeRetryAfterMs("2"), 2000);
  assert.equal(claudeRetryAfterMs(null), 30000);
  assert.equal(claudeRetryAfterMs("invalid"), 30000);
  assert.equal(claudeRetryAfterMs("Thu, 01 Jan 1970 00:16:42 GMT", 1000000), 2000);
  const governor = createClaudeRequestGovernor({ maxConcurrency: 1 });
  const task = pending();
  const active = governor.run(() => task.promise);
  const queued = governor.run(async () => { throw new Error("must not start"); });
  const rejected = assert.rejects(queued, /anthropic 429 rate-limit/);
  governor.cooldown(429, "2"); await rejected;
  task.resolve("in flight completes"); assert.equal(await active, "in flight completes");
  await assert.rejects(governor.run(async () => "too early"), /anthropic 429 rate-limit/);
  await time.advance(2000);
  assert.equal(await governor.run(async () => "new request"), "new request");
}

const goodText = "Count rejected rows in a migration dry run before changing the schema.";
const response = (text = goodText, stop_reason = "end_turn") => ({ ok: true, json: async () => ({ stop_reason, content: [{ type: "text", text }] }) });
function client(fetch) {
  return load(clientCode, { fetch, chrome: { storage: { local: { get: async (key) => ({ [key]: "local-test-key" }) } } } });
}
const post = { author: "builder", text: "We are migrating our database schema." };

// X and LinkedIn actually share slots, not just the queue primitive's unit tests.
{
  const requests = [];
  const api = client(async (_url, request) => { const task = pending(); requests.push({ ...task, request }); return task.promise; });
  const x = api.draftReply(post, "concise");
  const li = api.draftLinkedInComment(post);
  const waitingX = api.draftReply(post, "concise");
  await flush(); assert.equal(requests.length, 2);
  assert(requests.every(({ request }) => request.signal instanceof AbortSignal));
  requests[0].resolve(response()); await x; await flush(); assert.equal(requests.length, 3);
  requests[1].resolve(response()); requests[2].resolve(response());
  assert.equal(await li, goodText); assert.equal(await waitingX, goodText);
  assert.equal(api.time.timerCount, 0);
}

// HTTP-body stalls are canceled too, and do not cause an expensive draft retry.
{
  let transport, calls = 0;
  const api = client(async (_url, request) => { calls++; transport = request.signal; return { ok: true, json: async () => new Promise(() => {}) }; });
  const rejected = assert.rejects(api.draftReply(post, "concise"), /anthropic-timeout/);
  await flush(); await api.time.advance(25000); await rejected;
  assert.equal(transport.aborted, true); assert.equal(calls, 1); assert.equal(api.time.timerCount, 0);
}

// A valid-looking partial sentence or JSON is never accepted as a completed output.
for (const [reason, expected] of [["max_tokens", /anthropic-output-truncated/], ["refusal", /anthropic-output-refused/], ["pause_turn", /bad-output/], [null, /bad-output/]]) {
  let calls = 0;
  const api = client(async () => { calls++; return response(goodText, reason); });
  await assert.rejects(api.draftReply(post, "concise"), expected); assert.equal(calls, 1);
}
{
  const api = client(async () => response('{"scores":[{"i":0,"score":0.8,"reason":"Specific"}]}', "max_tokens"));
  await assert.rejects(api.scorePosts([{ ...post, i: 0 }], "software"), /anthropic-output-truncated/);
}

// Provider errors establish cooldown without leaking raw body text or retrying.
for (const status of [429, 529]) {
  let calls = 0;
  const api = client(async () => { calls++; return { ok: false, status, headers: { get: () => "2" }, json: async () => ({ error: { type: status === 429 ? "rate_limit_error" : "overloaded_error", message: "private provider diagnostic" } }) }; });
  await assert.rejects(api.draftReply(post, "concise"), new RegExp(`anthropic ${status}`));
  await assert.rejects(api.draftLinkedInComment(post), new RegExp(`anthropic ${status}`));
  assert.equal(calls, 1);
  await api.time.advance(2000);
  await assert.rejects(api.draftReply(post, "concise"), new RegExp(`anthropic ${status}`));
  assert.equal(calls, 2);
}

// Logical cancellation survives both model fallback and LinkedIn's quality repair.
for (const scenario of ["fallback", "repair"]) {
  const controller = new AbortController(); let calls = 0;
  const api = client(async () => {
    calls++;
    if (scenario === "fallback") return { ok: false, status: 400, json: async () => { controller.abort(); return { error: { message: "model not available" } }; } };
    return { ok: true, json: async () => { controller.abort(); return { stop_reason: "end_turn", content: [{ type: "text", text: "Great insights. Thanks for sharing!" }] }; } };
  });
  const work = scenario === "fallback"
    ? api.draftReply(post, "concise", undefined, undefined, undefined, undefined, undefined, undefined, "x", controller.signal)
    : api.draftLinkedInComment(post, { signal: controller.signal });
  await assert.rejects(work, /anthropic-cancelled/); assert.equal(calls, 1);
  assert.equal(api.time.timerCount, 0);
}

console.log("✓ Claude shared request governor: bounded concurrency, queue expiry, transport/body abort, cancellation, cooldown, and complete output");
