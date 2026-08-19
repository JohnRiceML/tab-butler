/** Pure policy + wiring guards for the shared X-data scheduler. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as esbuild from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "../src/lib/twttr-scheduler.ts"), "utf8");
const js = esbuild.transformSync(src, { loader: "ts", format: "esm" }).code;
const m = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));
const governor = readFileSync(join(here, "../src/lib/twttr-governor.ts"), "utf8");

let pass = 0, fail = 0;
const ok = (value, label) => { if (value) pass++; else { fail++; console.error("  FAIL:", label); } };
const near = (actual, expected, tolerance, label) => ok(Math.abs(actual - expected) <= tolerance, `${label} (got ${actual}, expected ${expected})`);
const NOW = 1_700_000_000_000;

near(m.adaptiveTwttrRate(9, undefined, undefined, NOW), 9, 0.0001, "missing provider headers use the local 9/sec ceiling");
near(m.adaptiveTwttrRate(9, 600, NOW + 60_000, NOW), 9, 0.0001, "a roomy provider window cannot raise the local ceiling");
near(m.adaptiveTwttrRate(9, 60, NOW + 60_000, NOW), 0.92, 0.0001, "remaining/reset headers lower dispatch to a sustainable rate with jitter margin");
near(m.adaptiveTwttrRate(9, 1, NOW + 60_000, NOW), (1 / 60) * 0.92, 0.0001, "a nearly empty window slows to its sustainable rate");
ok(m.adaptiveTwttrRate(9, 0, NOW + 60_000, NOW) === 0, "zero remaining pauses dispatch until reset");
ok(m.adaptiveTwttrRate(9, 0, NOW - 1, NOW) === 9, "an expired rate window returns to the local ceiling");
ok(m.twttrDispatchDelayMs(9, NOW, NOW) >= 112, "dispatches are evenly spaced instead of bursting nine at once");
ok(m.twttrDispatchDelayMs(9, 0, NOW) === 0, "a cold empty scheduler may start one request immediately");

const queue = [{ intent: false }, { intent: false }, { intent: true }, { intent: true }];
ok(m.nextTwttrQueueIndex(queue, 0) === 2, "an explicit click jumps ahead of queued ambient enrichment");
ok(m.nextTwttrQueueIndex(queue, m.TWTTR_SCHEDULER_MAX_INTENT_STREAK) === 0, "bounded priority admits ambient work after the intent streak");
ok(m.nextTwttrQueueIndex([{ intent: true }, { intent: true }], 99) === 0, "intent-only traffic remains FIFO when no ambient caller waits");
ok(m.TWTTR_SCHEDULER_MAX_CONCURRENCY === 8, "network concurrency stays bounded independently of requests/second");

ok(governor.includes("acquireSchedulerSlot(intent)") && governor.includes("nextTwttrQueueIndex(schedulerQueue"), "every governed network call enters the shared priority scheduler");
ok(governor.includes("observeProviderRate(provider") && governor.includes("pauseScheduler(retryAt)"), "provider remaining/reset headers and 429 resets feed adaptive backpressure");
ok(governor.includes("rateRetries < 1") && governor.includes("queued one retry"), "read-only rate failures retry once through the fair queue");
ok(governor.includes("providerRequestResetAt") && governor.includes("x-ratelimit-requests-reset"), "plan reset telemetry is captured separately from rate-window reset");
ok(governor.includes("TWTTR_QUEUE_MAX_WAIT_MS") && governor.includes('error: "provider queue timed out"'), "queue waiters have a bounded deadline under very slow provider windows");
ok(governor.indexOf("text = await res.text()") < governor.indexOf("finally { clearTimeout(timeout); }"), "the request deadline remains active through response-body consumption");
ok(governor.includes("reserveProviderPlanRequest(dispatchAt)") && governor.includes("meter.providerRequestsRemaining -= 1"), "known provider quota is persistently reserved at dispatch across concurrent calls");

console.log(fail === 0 ? `\n✓ twttr scheduler: ${pass} assertions passed` : `\n✗ twttr scheduler: ${fail} failed, ${pass} passed`);
process.exit(fail === 0 ? 0 : 1);
