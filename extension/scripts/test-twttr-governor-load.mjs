/** Integration-style load tests for the real governor with mocked storage/network. */
import { buildSync } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const bundled = buildSync({
  entryPoints: [join(here, "../src/lib/twttr-governor.ts")],
  bundle: true, format: "esm", platform: "browser", target: "es2022", write: false,
}).outputFiles[0].text;
const dataUrl = "data:text/javascript;base64," + Buffer.from(bundled).toString("base64");

let pass = 0, fail = 0;
const ok = (value, label) => { if (value) pass++; else { fail++; console.error("  FAIL:", label); } };
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function installStorage() {
  const values = {};
  globalThis.chrome = { storage: { local: {
    get: async (keys) => {
      if (typeof keys === "string") return { [keys]: values[keys] };
      const requested = Array.isArray(keys) ? keys : Object.keys(keys ?? {});
      return Object.fromEntries(requested.map((key) => [key, values[key]]));
    },
    set: async (next) => { Object.assign(values, next); },
  } } };
  return values;
}
const loadGovernor = (name) => import(`${dataUrl}#${name}`);
const success = () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });

// Local UTC-month counters roll independently from the provider's observed billing cycle.
{
  const values = installStorage();
  values.twttrMeter = {
    monthKey: "1999-01", requests: 999, bytes: 999,
    providerRequestLimit: 100_000, providerRequestsRemaining: 12_345,
    providerRequestResetAt: Date.now() + 60_000, providerObservedAt: Date.now(),
  };
  const { readMeter } = await loadGovernor("month-provider");
  const meter = await readMeter();
  ok(meter.requests === 0 && meter.bytes === 0 && meter.providerRequestsRemaining === 12_345, "UTC-month roll resets only local counters and preserves fresh provider quota evidence");
}

// A large simultaneous burst is absorbed: dispatch stays evenly spaced and active fetches cap at 8.
{
  installStorage();
  const starts = [];
  let active = 0, maxActive = 0;
  const held = [];
  globalThis.fetch = async () => {
    starts.push(Date.now());
    active++;
    maxActive = Math.max(maxActive, active);
    if (starts.length <= 8) await new Promise((resolve) => held.push(resolve));
    active--;
    return success();
  };
  const { governedFetch } = await loadGovernor("burst");
  const calls = Array.from({ length: 12 }, (_, i) => governedFetch("twitter241.p.rapidapi.com", "key", "user", { username: `load_${i}` }, true));
  await wait(1_050);
  ok(starts.length === 8 && maxActive === 8, "twelve simultaneous reads stop at eight active network requests");
  for (const release of held) release();
  const results = await Promise.all(calls);
  ok(results.every((result) => result.ok), "queued burst calls all complete instead of being dropped");
  const rollingMax = starts.reduce((max, start) => Math.max(max, starts.filter((value) => value >= start && value < start + 1_000).length), 0);
  ok(rollingMax <= 9, `rolling one-second starts stay within the 9/sec safety ceiling (observed ${rollingMax})`);
  ok(results.some((result) => (result.queuedMs ?? 0) >= 500), "load telemetry reports real queue backpressure");
}

// An explicit user request jumps ahead of ambient enrichment already waiting, without cancelling it.
{
  installStorage();
  const order = [];
  globalThis.fetch = async (url) => { order.push(new URL(url).searchParams.get("username")); return success(); };
  const { governedFetch } = await loadGovernor("priority");
  const first = governedFetch("twitter241.p.rapidapi.com", "key", "user", { username: "ambient_first" }, false);
  await wait(10);
  const ambientA = governedFetch("twitter241.p.rapidapi.com", "key", "user", { username: "ambient_a" }, false);
  const ambientB = governedFetch("twitter241.p.rapidapi.com", "key", "user", { username: "ambient_b" }, false);
  const click = governedFetch("twitter241.p.rapidapi.com", "key", "user", { username: "clicked" }, true);
  await Promise.all([first, ambientA, ambientB, click]);
  ok(order[0] === "ambient_first" && order[1] === "clicked", "a click jumps to the next dispatch slot ahead of ambient backlog");
  ok(order.includes("ambient_a") && order.includes("ambient_b"), "priority does not discard background callers");
}

// A short 429 window is treated as backpressure and retried once through the same scheduler.
{
  const values = installStorage();
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts++;
    if (attempts === 1) return new Response("rate limited", { status: 429, headers: { "retry-after": "0.05" } });
    return success();
  };
  const { governedFetch } = await loadGovernor("retry");
  const result = await governedFetch("twitter241.p.rapidapi.com", "key", "user", { username: "retry_me" }, true);
  ok(result.ok && attempts === 2 && result.networkAttempts === 2 && result.rateRetries === 1, "a short rate-limit response queues exactly one successful retry and reports both calls");
  ok(values.twttrMeter?.requests === 2, "both real network attempts are metered");
}

// Provider remaining/reset headers lower the live dispatch rate before the window is exhausted.
{
  installStorage();
  const starts = [];
  globalThis.fetch = async () => {
    starts.push(Date.now());
    if (starts.length === 1) return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json", "x-ratelimit-limit": "10", "x-ratelimit-remaining": "1", "x-ratelimit-reset": "1.5" },
    });
    return success();
  };
  const { governedFetch } = await loadGovernor("adaptive");
  await Promise.all([
    governedFetch("twitter241.p.rapidapi.com", "key", "user", { username: "window_a" }, true),
    governedFetch("twitter241.p.rapidapi.com", "key", "user", { username: "window_b" }, true),
  ]);
  ok(starts[1] - starts[0] >= 1_300, `provider window backpressure slows the next call (observed ${starts[1] - starts[0]}ms)`);
}

// Plan exhaustion is a hard quota circuit, not a once-a-minute rate retry into possible overage.
{
  installStorage();
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts++;
    return new Response("quota exhausted", {
      status: 429,
      headers: { "x-ratelimit-requests-limit": "100000", "x-ratelimit-requests-remaining": "0", "x-ratelimit-requests-reset": "120" },
    });
  };
  const { governedFetch } = await loadGovernor("quota");
  const first = await governedFetch("twitter241.p.rapidapi.com", "key", "user", { username: "quota_a" }, true);
  const second = await governedFetch("twitter241.p.rapidapi.com", "key", "user", { username: "quota_b" }, true);
  ok(!first.ok && !second.ok && attempts === 1, "plan exhaustion blocks later queued work without an overage retry");
}

// A known provider billing reset permits one fresh probe instead of retaining a zero balance for six hours.
{
  const values = installStorage();
  values.twttrMeter = {
    monthKey: new Date().toISOString().slice(0, 7), requests: 0, bytes: 0,
    providerRequestLimit: 100_000, providerRequestsRemaining: 0,
    providerRequestResetAt: Date.now() - 1, providerObservedAt: Date.now(),
  };
  let attempts = 0;
  globalThis.fetch = async () => { attempts++; return success(); };
  const { governedFetch } = await loadGovernor("quota-reset-elapsed");
  const result = await governedFetch("twitter241.p.rapidapi.com", "key", "user", { username: "reprobe_after_reset" }, true);
  ok(result.ok && attempts === 1, "elapsed provider plan reset clears stale zero remaining and allows one re-probe");
}

// Known provider quota is reserved at dispatch, so concurrent work cannot share one stale slot.
{
  const values = installStorage();
  values.twttrMeter = {
    monthKey: new Date().toISOString().slice(0, 7), requests: 0, bytes: 0,
    providerRequestLimit: 2, providerRequestsRemaining: 2, providerObservedAt: Date.now(),
  };
  let attempts = 0;
  const held = [];
  globalThis.fetch = async () => { attempts++; await new Promise((resolve) => held.push(resolve)); return success(); };
  const { governedFetch } = await loadGovernor("quota-reservation");
  const calls = ["reserve_a", "reserve_b", "reserve_c"].map((username) => governedFetch("twitter241.p.rapidapi.com", "key", "user", { username }, true));
  await wait(400);
  ok(attempts === 2, "only two network reads dispatch when the observed plan has two requests remaining");
  for (const release of held) release();
  const results = await Promise.all(calls);
  ok(results.filter((result) => result.network).length === 2 && results.some((result) => result.status === 429 && result.error?.includes("quota reserved")), "the excess queued read fails cleanly without touching the provider");
  ok(values.twttrMeter?.providerRequestsRemaining === 0, "successful responses without quota headers retain pessimistic dispatch decrements");
}

// Out-of-order same-window responses cannot overwrite a newer lower quota balance.
{
  const values = installStorage();
  const resetAt = Date.now() + 60_000;
  values.twttrMeter = {
    monthKey: new Date().toISOString().slice(0, 7), requests: 0, bytes: 0,
    providerRequestLimit: 100, providerRequestsRemaining: 10, providerRequestResetAt: resetAt, providerObservedAt: Date.now(),
  };
  globalThis.fetch = async (url) => {
    const older = new URL(url).searchParams.get("username") === "older_high";
    if (older) await wait(250);
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: {
      "content-type": "application/json",
      "x-ratelimit-requests-limit": "100",
      "x-ratelimit-requests-remaining": older ? "9" : "8",
      "x-ratelimit-requests-reset": String(Math.max(1, Math.round((resetAt - Date.now()) / 1000))),
    } });
  };
  const { governedFetch } = await loadGovernor("quota-monotonic");
  await Promise.all([
    governedFetch("twitter241.p.rapidapi.com", "key", "user", { username: "older_high" }, true),
    governedFetch("twitter241.p.rapidapi.com", "key", "user", { username: "newer_low" }, true),
  ]);
  ok(values.twttrMeter?.providerRequestsRemaining === 8, "same-window quota reconciliation keeps the lowest remaining value across out-of-order responses");
}

// Cache receipts retain the source snapshot time, and storage accounting uses decoded JSON bytes.
{
  const values = installStorage();
  globalThis.fetch = async () => new Response(JSON.stringify({ payload: "🔥".repeat(20) }), { status: 200, headers: { "content-type": "application/json", "content-length": "1" } });
  const { governedFetch } = await loadGovernor("cache-age");
  const first = await governedFetch("twitter241.p.rapidapi.com", "key", "search-v3", { type: "Latest", query: "cache-age" }, true);
  await wait(10);
  const second = await governedFetch("twitter241.p.rapidapi.com", "key", "search-v3", { type: "Latest", query: "cache-age" }, true);
  const entry = Object.values(values.twttrCache ?? {})[0];
  ok(first.ok && second.cached && second.cachedAt != null && (second.cacheAgeMs ?? 0) >= 0, "cache hits disclose the original metric snapshot time");
  ok((entry?.bytes ?? 0) > 1, "cache eviction accounts for decoded JSON size instead of compressed wire Content-Length");
}

console.log(fail === 0 ? `\n✓ twttr governor load: ${pass} assertions passed` : `\n✗ twttr governor load: ${fail} failed, ${pass} passed`);
process.exit(fail === 0 ? 0 : 1);
