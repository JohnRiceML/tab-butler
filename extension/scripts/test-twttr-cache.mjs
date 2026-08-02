/**
 * Pure guard for the governor's response-cache decisions in src/lib/twttr-policy.ts —
 * freshness (class TTL), expiry-pruning, and byte-bounded oldest-first eviction. The IO
 * (chrome.storage) lives in twttr-governor.ts and isn't unit-testable in node; these are
 * the pure decisions the cache correctness rests on. esbuild → data-URL import (policy.ts
 * is import-free). Run: node scripts/test-twttr-cache.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as esbuild from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "../src/lib/twttr-policy.ts"), "utf8");
const governorSrc = readFileSync(join(here, "../src/lib/twttr-governor.ts"), "utf8");
const js = esbuild.transformSync(src, { loader: "ts", format: "esm" }).code;
const m = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));
const { cacheExpiry, cacheFresh, pruneCache, TWTTR_CLASS, TWTTR_CACHE_MAX_BYTES } = m;

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) pass++; else { fail++; console.error("  FAIL:", l); } };
const NOW = 1_700_000_000_000;
const entry = (at, exp, bytes) => ({ at, exp, bytes, data: { n: bytes } });
ok(governorSrc.includes("cached: true, network: false") && governorSrc.includes("data, network: true"), "governor results distinguish zero-cost cache hits from live provider calls");

// ---- cacheExpiry stamps the class TTL onto the entry ----
ok(cacheExpiry("search", NOW) === NOW + TWTTR_CLASS.search.ttl, "cacheExpiry uses the search-class TTL");
ok(cacheExpiry("timeline", NOW) === NOW + TWTTR_CLASS.timeline.ttl, "cacheExpiry uses the timeline-class TTL");

// ---- cacheFresh: within exp fresh, at/after exp stale, undefined never fresh ----
ok(cacheFresh(entry(NOW, NOW + 1000, 100), NOW) === true, "fresh inside the window");
ok(cacheFresh(entry(NOW, NOW + 1000, 100), NOW + 1000) === false, "stale exactly at expiry (now < exp is strict)");
ok(cacheFresh(entry(NOW, NOW + 1000, 100), NOW + 2000) === false, "stale past expiry");
ok(cacheFresh(undefined, NOW) === false, "a missing entry is never fresh");

// ---- pruneCache drops expired, keeps live, and never mutates the input ----
{
  const cache = { a: entry(NOW - 5000, NOW - 1, 100), b: entry(NOW, NOW + 10_000, 100) }; // a expired, b live
  const out = pruneCache(cache, NOW);
  ok(!("a" in out) && "b" in out, "pruneCache drops the expired entry, keeps the live one");
  ok("a" in cache && "b" in cache, "pruneCache does not mutate the input object");
}

// ---- byte-bounded eviction: over the cap → drop OLDEST-by-write until under ----
{
  const big = 1_000_000; // ~1MB each
  const cache = {
    oldest: entry(NOW - 3000, NOW + 60_000, big),
    mid:    entry(NOW - 2000, NOW + 60_000, big),
    newest: entry(NOW - 1000, NOW + 60_000, big),
  };
  const out = pruneCache(cache, NOW, 2_200_000); // room for ~2 of the 3
  ok(!("oldest" in out), "eviction drops the oldest entry first");
  ok("mid" in out && "newest" in out, "eviction keeps the two newest");
  const total = Object.values(out).reduce((a, e) => a + e.bytes, 0);
  ok(total <= 2_200_000, "post-eviction total is under the byte cap");
}

// ---- under the cap → nothing evicted ----
{
  const cache = { a: entry(NOW, NOW + 60_000, 100), b: entry(NOW, NOW + 60_000, 100) };
  const out = pruneCache(cache, NOW, TWTTR_CACHE_MAX_BYTES);
  ok(Object.keys(out).length === 2, "nothing evicted when comfortably under the cap");
}

// ---- expired-then-evict: expiry pruning happens BEFORE byte eviction ----
{
  const big = 1_000_000;
  const cache = {
    expired: entry(NOW - 9000, NOW - 1, big),        // expired — should go regardless of size
    live1:   entry(NOW - 2000, NOW + 60_000, big),
    live2:   entry(NOW - 1000, NOW + 60_000, big),
  };
  const out = pruneCache(cache, NOW, 2_500_000);
  ok(!("expired" in out), "expired entry removed by the freshness pass");
  ok("live1" in out && "live2" in out, "both live entries survive once the expired one freed room");
}

console.log(fail === 0 ? `\n✓ twttr-cache: ${pass} assertions passed` : `\n✗ twttr-cache: ${fail} failed, ${pass} passed`);
process.exit(fail === 0 ? 0 : 1);
