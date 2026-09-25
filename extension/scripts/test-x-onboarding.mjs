/** Zero-network regression coverage for the resumable X setup state machine. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { build, transformSync } from "esbuild";

const bundled = await build({
  stdin: {
    contents: 'export * from "./src/lib/x-onboarding.ts"; export { CONFIG } from "./src/lib/config.ts"; export { renderXOnboarding, handleXOnboardingAction } from "./src/popup/x-onboarding.ts";',
    resolveDir: new URL("..", import.meta.url).pathname,
    loader: "ts",
  },
  bundle: true, write: false, format: "esm", platform: "node",
});
const api = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`);
const { CONFIG: K, onboardingProgress, onboardingStage, onboardingProvidersReady,
  isXOnboardingConfigured, shouldShowXOnboarding, transitionXOnboarding: transition } = api;
const reviewerKeys = [K.JEV_REVIEW_MODE_KEY, K.JEV_REVIEW_CONSENT_KEY, K.JEV_REVIEW_LOG_KEY];
const validInputs = { anthropicKey: " claude-test-key ", typesafeKey: " jev-test-key ", xConsent: true, jevConsent: true };

function advance(store, action, input) {
  const before = structuredClone(store);
  const result = transition(store, `x-onboarding-${action}`, input);
  assert.deepEqual(store, before, "transitions never mutate the caller's snapshot");
  assert.equal(result.error, undefined, `${action} should succeed`);
  for (const key of reviewerKeys) assert(!Object.hasOwn(result.patch ?? {}, key), `${action} must not change optional review`);
  const next = { ...store, ...result.patch };
  const metadata = next[K.X_ONBOARDING_KEY];
  assert(Object.keys(metadata).every(key => ["version", "stage", "provider", "completed"].includes(key)), "metadata contains navigation only");
  assert(!JSON.stringify(metadata).includes("test-key"), "keys never enter onboarding metadata");
  return { next, result };
}
function blocked(store, action, input) {
  const before = structuredClone(store);
  const result = transition(store, `x-onboarding-${action}`, input);
  assert(result.error, `${action} should be blocked`);
  assert.equal(result.patch, undefined, "invalid submission must not partly save consent or credentials");
  assert.equal(result.launchX, undefined);
  assert.deepEqual(store, before);
}

assert(shouldShowXOnboarding({}));
assert.equal(onboardingStage({}), "welcome");
assert.equal(onboardingProgress({}), null);
for (const action of ["providers", "focus", "finish"]) blocked({}, action, validInputs);
for (const metadata of [null, "secret", { version: 2, stage: "finish" }, { version: 1, stage: "unknown" }]) {
  assert.equal(onboardingStage({ [K.X_ONBOARDING_KEY]: metadata }), "welcome");
}

// Selecting a recommendation is navigation, never implicit consent or activation.
const selected = advance({}, "choose-jev").next;
assert.equal(onboardingStage(selected), "providers");
assert.equal(selected[K.ANALYSIS_PROVIDER_KEY], undefined);
assert.equal(selected[K.X_COPILOT_KEY], undefined);
assert.equal(selected[K.X_DATA_CONSENT_KEY], undefined);
assert.equal(selected[K.JEV_ANALYSIS_CONSENT_KEY], undefined);
for (const input of [
  {}, { ...validInputs, anthropicKey: " " }, { ...validInputs, typesafeKey: " " },
  { ...validInputs, xConsent: false }, { ...validInputs, jevConsent: false },
  { ...validInputs, xConsent: "true" }, { ...validInputs, jevConsent: 1 },
]) blocked(selected, "providers", input);

// New users remain disabled even after saving providers and explicit consents.
const connected = advance(selected, "providers", validInputs).next;
assert.equal(onboardingStage(connected), "focus");
assert.equal(connected[K.ANTHROPIC_KEY_KEY], "claude-test-key");
assert.equal(connected[K.TYPESAFE_KEY_KEY], "jev-test-key");
assert.equal(connected[K.X_DATA_CONSENT_KEY], "v1");
assert.equal(connected[K.JEV_ANALYSIS_CONSENT_KEY], "v1");
assert.equal(connected[K.X_COPILOT_KEY], false);
assert(onboardingProvidersReady(connected));
assert(!isXOnboardingConfigured(connected));
assert(shouldShowXOnboarding(JSON.parse(JSON.stringify(connected))), "saved progress resumes on another popup load");
blocked(connected, "finish");
for (const input of [{}, { focus: "  " }, { focus: "x".repeat(2001) }, { focus: "Engineering", voice: "x".repeat(6001) }]) blocked(connected, "focus", input);
const focused = advance(connected, "focus", { focus: " Reliable software ", voice: " Plain and curious " }).next;
assert.equal(focused[K.X_NICHE_KEY], "Reliable software");
assert.equal(focused[K.X_VOICE_KEY], "Plain and curious");
assert.equal(onboardingStage(JSON.parse(JSON.stringify(focused))), "finish");
assert.equal(focused[K.X_COPILOT_KEY], false);
assert(shouldShowXOnboarding(focused), "configured providers do not hide an unfinished wizard");
const finished = advance(focused, "finish");
assert.equal(finished.next[K.X_COPILOT_KEY], true);
assert.equal(finished.next[K.X_PAUSED_KEY], false);
assert.equal(finished.result.completed, true);
assert.equal(finished.result.launchX, true);
assert(!shouldShowXOnboarding(finished.next));

// Removed credentials/consent or changed providers cannot be bypassed by resumption.
for (const key of [K.ANTHROPIC_KEY_KEY, K.TYPESAFE_KEY_KEY, K.X_DATA_CONSENT_KEY, K.JEV_ANALYSIS_CONSENT_KEY]) {
  const invalid = { ...focused, [key]: "" };
  assert(!onboardingProvidersReady(invalid));
  assert.equal(onboardingStage(invalid), "providers");
  blocked(invalid, "finish");
}
assert.equal(onboardingStage({ ...focused, [K.X_NICHE_KEY]: " " }), "focus");
blocked({ ...focused, [K.X_NICHE_KEY]: " " }, "finish");
blocked({ ...focused, [K.ANALYSIS_PROVIDER_KEY]: "claude" }, "finish");
const missingConsent = { [K.ANTHROPIC_KEY_KEY]: "claude", [K.TYPESAFE_KEY_KEY]: "jev", [K.ANALYSIS_PROVIDER_KEY]: "jev", [K.X_NICHE_KEY]: "Engineering", [K.X_DATA_CONSENT_KEY]: "v1" };
assert(!isXOnboardingConfigured(missingConsent), "selected Jev without its own consent is not ready");
assert(shouldShowXOnboarding(missingConsent));

// Claude-only is a complete supported path; Jev/reviewer/LinkedIn settings survive it.
const extras = { [K.TYPESAFE_KEY_KEY]: "existing-jev", [K.JEV_ANALYSIS_CONSENT_KEY]: "v1", [K.JEV_REVIEW_MODE_KEY]: "shadow", [K.JEV_REVIEW_CONSENT_KEY]: "v1", [K.JEV_REVIEW_LOG_KEY]: [{ status: "reviewed" }], [K.LI_COPILOT_KEY]: true, [K.LI_DATA_CONSENT_KEY]: "v5", [K.X_SOUL_KEY]: "A real personal story" };
let claude = advance(extras, "choose-claude").next;
claude = advance(claude, "providers", { anthropicKey: "claude", xConsent: true, jevConsent: false }).next;
assert.equal(claude[K.ANALYSIS_PROVIDER_KEY], "claude");
claude = advance(claude, "focus", { focus: "Engineering" }).next;
claude = advance(claude, "finish").next;
for (const [key, value] of Object.entries(extras)) assert.deepEqual(claude[key], value, `${key} remains untouched`);
let cleanClaude = advance({}, "choose-claude").next;
cleanClaude = advance(cleanClaude, "providers", { anthropicKey: "claude", xConsent: true }).next;
assert(onboardingProvidersReady(cleanClaude));
assert.equal(cleanClaude[K.TYPESAFE_KEY_KEY], undefined);
assert.equal(cleanClaude[K.JEV_ANALYSIS_CONSENT_KEY], undefined);

// Existing valid installations are not migrated, enabled, or reconfigured on read/reopen.
for (const provider of [undefined, "claude", "jev"]) {
  const existing = { ...finished.next, ...extras, [K.X_COPILOT_KEY]: false, [K.X_PAUSED_KEY]: true, [K.ANALYSIS_PROVIDER_KEY]: provider };
  delete existing[K.X_ONBOARDING_KEY];
  const before = structuredClone(existing);
  assert(!shouldShowXOnboarding(existing));
  assert.deepEqual(existing, before);
  const reopened = advance(existing, "reopen").next;
  for (const [key, value] of Object.entries(existing)) assert.deepEqual(reopened[key], value, `reopen preserves ${key}`);
  assert.equal(onboardingStage(reopened), "welcome");
}
const back = advance(focused, "back").next;
assert.equal(onboardingStage(back), "focus");
const providerBack = advance(back, "back").next;
assert.equal(onboardingStage(providerBack), "providers");
const reused = advance(providerBack, "providers", { anthropicKey: " ", typesafeKey: " " }).next;
assert.equal(reused[K.ANTHROPIC_KEY_KEY], "claude-test-key", "blank provider fields retain stored keys");
assert.equal(reused[K.TYPESAFE_KEY_KEY], "jev-test-key");
assert.equal(reused[K.X_NICHE_KEY], "Reliable software", "back navigation preserves saved focus");

// Execute the production lifecycle listeners. Installation is the only auto-launch event,
// and local seed restoration must finish before deciding whether setup is necessary.
const workerSource = readFileSync(new URL("../src/background/service-worker.ts", import.meta.url), "utf8");
const parsedWorker = ts.createSourceFile("service-worker.ts", workerSource, ts.ScriptTarget.Latest, true);
const lifecycleNodes = parsedWorker.statements.filter(node => ts.isExpressionStatement(node)
  && ts.isCallExpression(node.expression)
  && ["chrome.runtime.onInstalled.addListener", "chrome.runtime.onStartup.addListener"].includes(node.expression.expression.getText(parsedWorker)));
assert.equal(lifecycleNodes.length, 2, "both production lifecycle listeners must be exercised");
const lifecycleCode = transformSync(lifecycleNodes.map(node => node.getText(parsedWorker)).join("\n"), { loader: "ts" }).code;
function lifecycleFixture(initial = {}, seedPatch = {}) {
  const state = structuredClone(initial), tabs = [], alarms = [], order = [];
  let installed, startup, releaseSeed;
  const seedGate = new Promise(resolve => { releaseSeed = resolve; });
  const chrome = {
    runtime: {
      onInstalled: { addListener: listener => { installed = listener; } },
      onStartup: { addListener: listener => { startup = listener; } },
      getURL: path => `chrome-extension://goobi/${path}`,
    },
    alarms: { create: (name, options) => { alarms.push({ name, options }); } },
    storage: { local: { get: async keys => { assert.equal(keys, null); order.push("read"); return structuredClone(state); } } },
    tabs: { create: async options => { order.push("open"); tabs.push(options); } },
  };
  runInNewContext(lifecycleCode, {
    chrome, CONFIG: K, shouldShowXOnboarding,
    seedFromLocalFile: async () => {
      order.push("seed-start");
      await seedGate;
      Object.assign(state, seedPatch);
      order.push("seed-complete");
    },
  });
  return { state, tabs, alarms, order, installed, startup, releaseSeed };
}
const settled = () => new Promise(resolve => setImmediate(resolve));
const firstInstall = lifecycleFixture();
firstInstall.installed({ reason: "install" });
assert.equal(firstInstall.alarms.length, 2, "normal scheduled alarms still initialize");
await settled();
assert.equal(firstInstall.tabs.length, 0, "welcome tab cannot race local seed restoration");
assert.deepEqual(firstInstall.order, ["seed-start"]);
firstInstall.releaseSeed(); await settled();
assert.equal(firstInstall.tabs.length, 1);
assert.equal(firstInstall.tabs[0].url, "chrome-extension://goobi/popup.html?onboarding=1");
assert.deepEqual(firstInstall.order, ["seed-start", "seed-complete", "read", "open"]);
assert.deepEqual(firstInstall.state, {}, "auto-launch never changes account settings or consent");
for (const reason of ["update", "chrome_update", "shared_module_update"]) {
  const fixture = lifecycleFixture(); fixture.installed({ reason }); fixture.releaseSeed(); await settled();
  assert.equal(fixture.tabs.length, 0, `${reason} must never launch onboarding`);
  assert.equal(fixture.alarms.length, 2);
  assert.deepEqual(fixture.order, ["seed-start", "seed-complete"]);
}
const startup = lifecycleFixture(); startup.startup(); startup.releaseSeed(); await settled();
assert.equal(startup.tabs.length, 0, "browser startup never launches onboarding");
assert.equal(startup.alarms.length, 0);
assert.deepEqual(startup.order, ["seed-start", "seed-complete"]);
for (const [initial, seedPatch] of [[finished.next, {}], [{}, finished.next]]) {
  const fixture = lifecycleFixture(initial, seedPatch);
  fixture.installed({ reason: "install" }); fixture.releaseSeed(); await settled();
  assert.equal(fixture.tabs.length, 0, "existing or restored configured users bypass the welcome tab");
  assert.deepEqual(fixture.state, { ...initial, ...seedPatch });
}

// The actual renderer and DOM adapter must keep consent independent and saved keys private.
const freshProviderMarkup = api.renderXOnboarding(selected);
for (const id of ["onboarding-x-consent", "onboarding-jev-consent"]) {
  const input = freshProviderMarkup.match(new RegExp(`<input[^>]*id="${id}"[^>]*>`))?.[0];
  assert(input, `${id} must be shown separately`);
  assert(!/\bchecked\b/.test(input), "new consent must not be prechecked");
}
const savedProviderMarkup = api.renderXOnboarding(providerBack);
assert(!savedProviderMarkup.includes("claude-test-key"));
assert(!savedProviderMarkup.includes("jev-test-key"));
assert.match(savedProviderMarkup, /Saved — leave blank to keep it/);
const escapedFocus = api.renderXOnboarding({ ...focused, [K.X_NICHE_KEY]: '<img src=x onerror="bad()">' });
assert(!escapedFocus.includes('<img src=x'));
assert(escapedFocus.includes("&lt;img"));
const cleanClaudeMarkup = api.renderXOnboarding(advance({}, "choose-claude").next);
assert(!cleanClaudeMarkup.includes('id="onboarding-typesafe-key"'));
assert(!cleanClaudeMarkup.includes('id="onboarding-jev-consent"'));

const uiState = structuredClone(selected), writes = [];
const alert = { textContent: "", hidden: true, scrollIntoView() {} };
const controls = {
  "#onboarding-anthropic-key": { value: "claude-ui-test" },
  "#onboarding-typesafe-key": { value: "jev-ui-test" },
  "#onboarding-x-consent": { checked: true },
  "#onboarding-jev-consent": { checked: false },
  "#x-onboarding-error": alert,
};
const root = { querySelector: selector => controls[selector] ?? null };
globalThis.chrome = { storage: { local: {
  get: async () => structuredClone(uiState),
  set: async patch => { writes.push(structuredClone(patch)); Object.assign(uiState, patch); },
} } };
try {
  const rejected = await api.handleXOnboardingAction("x-onboarding-providers", root);
  assert(rejected.handled && rejected.error);
  assert.equal(writes.length, 0, "DOM adapter cannot combine one checked consent into two grants");
  assert.equal(alert.hidden, false);
  assert.equal(controls["#onboarding-anthropic-key"].value, "claude-ui-test", "validation leaves unsaved input intact");
  controls["#onboarding-jev-consent"].checked = true;
  const accepted = await api.handleXOnboardingAction("x-onboarding-providers", root);
  assert(accepted.handled && !accepted.error);
  assert.equal(writes.length, 1, "provider save is one atomic storage patch");
  assert.equal(uiState[K.X_COPILOT_KEY], false);
  assert.equal(uiState[K.JEV_ANALYSIS_CONSENT_KEY], "v1");
  assert.equal(uiState[K.X_DATA_CONSENT_KEY], "v1");
  for (const key of reviewerKeys) assert(!Object.hasOwn(writes[0], key));
  const unknown = await api.handleXOnboardingAction("unrelated-action", root);
  assert.equal(unknown.handled, false);
  assert.equal(writes.length, 1);
} finally { delete globalThis.chrome; }

console.log("✓ X onboarding: resumption, independent consent, provider readiness, no midway activation, validated finish, existing users, reviewer isolation, install lifecycle and UI adapter");
