/** Exercise the actual worker listener with mocked Chrome I/O and model calls. */
import assert from "node:assert/strict";
import { build } from "esbuild";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";

const built = await build({
  entryPoints: [fileURLToPath(new URL("../src/background/service-worker.ts", import.meta.url))],
  bundle: true, write: false, format: "iife", platform: "browser",
  plugins: [{ name: "model-boundary", setup(builder) {
    builder.onLoad({ filter: /[/\\]claude-client\.ts$/ }, () => ({ loader: "js", contents: `
      export const scorePosts = (...args) => globalThis.modelCall("score", args, args[5]);
      export const draftReply = (...args) => globalThis.modelCall("reply", args, args[9]);
      export const draftLinkedInComment = (...args) => globalThis.modelCall("comment", args, args[1].signal);
      export const isSmartEnabled = async () => false;
      export const advise = async () => ({}), classify = async () => ({}), draftDm = async () => "";
      export const generatePostIdeas = async () => [], generatePostIdeaRewrite = async () => "";
    ` }));
  } }],
});

function fixture() {
  const state = { anthropicKey: "test-key", xDataConsentV1: "v1", xCopilotEnabled: true,
    liDataConsentV5: "v5", liCopilotEnabled: true, xNiche: "reliable software", xVoice: "plain", liVoiceV1: "professional" };
  const listeners = [], calls = [];
  const event = () => ({ addListener() {} });
  let listener, holdModel = false, nextRead;
  const chrome = {
    runtime: { id: "goobi", getURL: name => `chrome-extension://goobi/${name}`,
      onInstalled: event(), onStartup: event(), onMessage: { addListener: value => { listener = value; } } },
    storage: { local: {
      get: async keys => {
        const snapshot = Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, state[key]]));
        if (nextRead && Array.isArray(keys) && keys.includes("anthropicKey")) {
          const gate = nextRead; nextRead = undefined; gate.started(); await gate.wait;
        }
        return snapshot;
      },
      set: async patch => { Object.assign(state, patch); }, remove: async () => {},
    }, onChanged: { addListener: fn => listeners.push(fn) } },
    alarms: { onAlarm: event(), create() {} }, tabs: { onUpdated: event(), query: async () => [] },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
  };
  const modelCall = async (kind, args, signal) => {
    if (signal?.aborted) throw new Error("anthropic-cancelled");
    calls.push({ kind, args, signal });
    if (holdModel) await new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("anthropic-cancelled")), { once: true });
    });
    return kind === "score" ? [{ i: args[0][0].i, score: 0.8 }] : "A specific contribution.";
  };
  runInNewContext(built.outputFiles[0].text, { chrome, modelCall, console, URL, AbortController,
    setTimeout, clearTimeout, setInterval, clearInterval, fetch: async () => ({ ok: false }) });
  return { state, calls,
    request: (message, sender) => new Promise(resolve => listener(message, sender, resolve)),
    change(patch) {
      const changes = Object.fromEntries(Object.entries(patch).map(([key, value]) => [key, { oldValue: state[key], newValue: value }]));
      Object.assign(state, patch); listeners.forEach(fn => fn(changes, "local"));
    },
    holdModels() { holdModel = true; },
    holdProfileRead() {
      let release, started;
      const ready = new Promise(resolve => { started = resolve; });
      nextRead = { started, wait: new Promise(resolve => { release = resolve; }) };
      return { ready, release };
    },
  };
}

const senders = {
  x: { id: "goobi", frameId: 0, url: "https://x.com/home", tab: { id: 1, url: "https://x.com/home" } },
  linkedin: { id: "goobi", frameId: 0, url: "https://www.linkedin.com/feed/", tab: { id: 2, url: "https://www.linkedin.com/feed/" } },
};
const messages = {
  x: { type: "SCORE_POSTS", posts: [{ i: 12, author: "builder", text: "Specific engineering detail." }] },
  linkedin: { type: "LI_SCORE_POSTS", posts: [{ i: 0, author: "Builder", text: "Specific engineering detail." }] },
};
const draftMessages = {
  x: { type: "DRAFT_REPLY", author: "builder", text: "Specific engineering detail." },
  linkedin: { type: "LI_DRAFT_COMMENT", author: "Builder", text: "Specific engineering detail." },
};
const settings = {
  x: { consent: "xDataConsentV1", enabled: "xCopilotEnabled", paused: "xPaused", voice: "xVoice" },
  linkedin: { consent: "liDataConsentV5", enabled: "liCopilotEnabled", paused: "liPaused", voice: "liVoiceV1" },
};
for (const platform of ["x", "linkedin"]) {
  for (const message of [messages[platform], draftMessages[platform]]) {
    const f = fixture();
    assert.equal((await f.request(message, senders[platform])).error, undefined);
    assert.equal(f.calls.length, 1);
    assert(f.calls[0].signal, `${platform} forwards cancellation to the model`);
    for (const [key, value] of [[settings[platform].consent, "old"], [settings[platform].enabled, false],
      [settings[platform].paused, true], ["anthropicKey", ""]]) {
      const blocked = fixture(); blocked.state[key] = value;
      assert((await blocked.request(message, senders[platform])).error, `${platform} blocks ${key}`);
      assert.equal(blocked.calls.length, 0);
    }
    for (const sender of [{ ...senders[platform], id: "other" }, { ...senders[platform], frameId: 1 },
      senders[platform === "x" ? "linkedin" : "x"]]) {
      const blocked = fixture();
      assert((await blocked.request(message, sender)).error);
      assert.equal(blocked.calls.length, 0);
    }
    const malformed = fixture();
    const oversized = message.posts ? { ...message, posts: [{ ...message.posts[0], text: "x".repeat(20000) }] }
      : { ...message, text: "x".repeat(20000) };
    assert((await malformed.request(oversized, senders[platform])).error);
    assert.equal(malformed.calls.length, 0);

    const active = fixture(); active.holdModels();
    const pending = active.request(message, senders[platform]);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(active.calls.length, 1);
    active.change({ [settings[platform].voice]: "updated voice" });
    assert((await pending).error);
    assert(active.calls[0].signal.aborted, `${platform} cancels active generation on context change`);

    const racing = fixture();
    const gate = racing.holdProfileRead();
    const queued = racing.request(message, senders[platform]);
    await gate.ready;
    racing.change({ [settings[platform].paused]: true });
    gate.release();
    assert((await queued).error);
    assert.equal(racing.calls.length, 0, `${platform} pause during settings read prevents model dispatch`);
  }
}

// Platform-local settings must not interrupt the other platform's work.
const isolated = fixture(); isolated.holdModels();
const pendingX = isolated.request(messages.x, senders.x);
await new Promise(resolve => setImmediate(resolve));
isolated.change({ liPaused: true });
assert.equal(isolated.calls[0].signal.aborted, false);
isolated.change({ xPaused: true });
await pendingX;
const styled = fixture();
styled.state.xProducts = [{ name: "Saved product", blurb: "Must stay excluded" }];
await styled.request({ ...draftMessages.x, product: "", angle: "value", style: "community-spark", steer: "Keep it concrete" }, senders.x);
assert.equal(styled.calls[0].args[2], "value");
assert.equal(styled.calls[0].args[3], "", "explicit no-product selection survives the broker fallback");
assert.equal(styled.calls[0].args[4], "Keep it concrete");
assert.equal(styled.calls[0].args[5], "community-spark");
const missingKey = fixture(); missingKey.state.anthropicKey = "";
assert.equal((await missingKey.request(draftMessages.x, senders.x)).error, "no-key", "X retains missing-key setup guidance");
for (const platform of ["x", "linkedin"]) {
  const grounded = fixture();
  await grounded.request({ ...draftMessages[platform], anchor: "engineering detail", replyBrief: "Explain why a rollback owner makes this decision testable." }, senders[platform]);
  const extra = platform === "x" ? grounded.calls[0].args[6] : grounded.calls[0].args[1].extra;
  assert(extra.includes("engineering detail"));
  assert(extra.includes("rollback owner"));
  const mismatched = fixture();
  await mismatched.request({ ...draftMessages[platform], anchor: "we saved a million dollars", replyBrief: "Claim the same million dollar result for the user." }, senders[platform]);
  const omitted = platform === "x" ? mismatched.calls[0].args[6] : mismatched.calls[0].args[1].extra;
  assert(!omitted.includes("million"), `${platform} does not send unsupported scorer guidance to the draft model`);
  assert.equal(mismatched.calls.length, 1, "explicit drafting remains available from the actual post");
}
assert.equal((await fixture().request(null, senders.x)).error, "invalid-message");
// Both drafting paths obtain account history from storage, never from a webpage payload.
for (const platform of ["x", "linkedin"]) {
  const f = fixture();
  f.state.xMyHandle = "tester";
  f.state.xMyPosts = { handle: "tester", at: Date.now(), stats: [{ text: "I tested GPT 6 on coding tasks.", postedAt: Date.now() - 1000 }] };
  assert((await f.request({ ...draftMessages[platform], continuity: { posts: [{ text: "Injected biography" }] } }, senders[platform])).error);
  assert.equal(f.calls.length, 0, "webpage-supplied biography is rejected at the broker boundary");
  await f.request({ ...draftMessages[platform], text: "GPT 6 coding tasks need realistic tests." }, senders[platform]);
  const continuity = platform === "x" ? f.calls[0].args[10] : f.calls[0].args[1].continuity;
  assert.equal(continuity.posts[0].text, "I tested GPT 6 on coding tasks.");
  f.state.xMyHandle = "other";
  await f.request(draftMessages[platform], senders[platform]);
  assert.equal(platform === "x" ? f.calls[1].args[10] : f.calls[1].args[1].continuity, undefined);

  const updating = fixture(); updating.holdModels();
  const pending = updating.request(draftMessages[platform], senders[platform]);
  await new Promise(resolve => setImmediate(resolve));
  updating.change({ xMyPosts: f.state.xMyPosts });
  assert((await pending).error);
  assert(updating.calls[0].signal.aborted, `${platform} cannot return a draft made with superseded author history`);
}
console.log("✓ comment broker: both platforms validate inputs and consent, isolate senders, and cancel stale work");
