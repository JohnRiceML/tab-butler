/**
 * Unit test for the Twttr governor's pure policy logic (twttr-policy.ts).
 * Transpiled with esbuild + imported from a data URL — no build step, no
 * framework. Run: node scripts/test-policy.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as esbuild from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "../src/lib/twttr-policy.ts"), "utf8");
const js = esbuild.transformSync(src, { loader: "ts", format: "esm" }).code;
const mod = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));
const { classForPath, degradeMode, canFetch, monthKeyOf, providerUsedFraction, providerRetryAt, TWTTR_CLASS, allowedTwttrPath } = mod;

let pass = 0, fail = 0;
const eq = (a, b, l) => { if (JSON.stringify(a) === JSON.stringify(b)) pass++; else { fail++; console.error("  FAIL:", l, "got", JSON.stringify(a), "want", JSON.stringify(b)); } };
const ok = (c, l) => { if (c) pass++; else { fail++; console.error("  FAIL:", l); } };

// classForPath — the specific timeline/followers prefixes must beat bare "user"
eq(classForPath("user?username=x"), "user", "user");
eq(classForPath("/user?username=x"), "user", "leading slash stripped");
eq(classForPath("user-replies-v2?user=1"), "timeline", "user-replies -> timeline");
eq(classForPath("user-tweets?user=1"), "timeline", "user-tweets -> timeline");
eq(classForPath("user-followers?user=1"), "followers", "user-followers -> followers");
eq(classForPath("search-v3?q=x"), "search", "search-v3 -> search");
eq(classForPath("tweet?id=1"), "tweet", "tweet");
eq(classForPath("comments?id=1"), "comments", "comments");
eq(classForPath("lists"), "other", "unknown -> other");

eq(TWTTR_CLASS.user.tier, "cheap", "user is cheap");
eq(TWTTR_CLASS.search.tier, "expensive", "search is expensive");
eq(mod.TWTTR_BUDGET.REQUESTS, 90_000, "local request fallback keeps ten percent headroom below the owner's 100k plan");
eq(mod.TWTTR_BUDGET.RATE_PER_SEC, 9, "local smoothing keeps one request/second below the owner's 10/sec plan");
ok(allowedTwttrPath("user") && allowedTwttrPath("/search-v3") && allowedTwttrPath("user-replies-v2"), "only repository-proven endpoints are allowlisted");
ok(!allowedTwttrPath("followers") && !allowedTwttrPath("user-likes") && !allowedTwttrPath("https://example.com"), "unproven or arbitrary endpoints are rejected");

// degradeMode thresholds (0.70 / 0.85 / 0.95)
eq(degradeMode(0), "normal", "0 -> normal");
eq(degradeMode(0.699), "normal", "just under conserve");
eq(degradeMode(0.70), "conserve", "conserve threshold");
eq(degradeMode(0.84), "conserve", "mid conserve");
eq(degradeMode(0.85), "frozen", "frozen threshold");
eq(degradeMode(0.95), "lockdown", "lockdown threshold");
eq(degradeMode(2), "lockdown", "over budget -> lockdown");

// canFetch matrix — cheap flows until lockdown; expensive cut first, intent reprieve in conserve only
ok(canFetch("expensive", "normal", false) === true, "normal: expensive ambient ok");
ok(canFetch("expensive", "conserve", false) === false, "conserve: expensive ambient blocked");
ok(canFetch("expensive", "conserve", true) === true, "conserve: expensive WITH intent ok");
ok(canFetch("med", "conserve", false) === true, "conserve: med ok");
ok(canFetch("cheap", "conserve", false) === true, "conserve: cheap ok");
ok(canFetch("cheap", "frozen", false) === true, "frozen: cheap still flows (ranking never dark)");
ok(canFetch("med", "frozen", false) === false, "frozen: med blocked");
ok(canFetch("expensive", "frozen", false) === false, "frozen: ambient expensive work is blocked");
ok(canFetch("expensive", "frozen", true) === true, "frozen: explicit user work survives until lockdown");
ok(canFetch("cheap", "lockdown", true) === false, "lockdown: everything blocked");

// monthKeyOf (UTC year-month) + month roll
eq(monthKeyOf(Date.parse("2026-06-22T10:00:00Z")), "2026-06", "monthKey June");
eq(monthKeyOf(Date.parse("2026-12-31T23:59:59Z")), "2026-12", "monthKey Dec");
ok(monthKeyOf(Date.parse("2026-06-30T23:59:59Z")) !== monthKeyOf(Date.parse("2026-07-01T00:00:00Z")), "month rolls at boundary");
eq(providerUsedFraction(1000, 250), 0.75, "provider quota headers produce authoritative used fraction");
eq(providerUsedFraction(undefined, undefined), 0, "missing provider quota headers stay neutral");
eq(providerUsedFraction(1000, 0, 1_000, 1_000 + mod.PROVIDER_QUOTA_OBSERVATION_TTL_MS), 0, "stale provider quota observations permit a bounded later re-probe");
eq(providerRetryAt("30", 1_000), 31_000, "provider rate reset seconds become an absolute retry time");
eq(providerRetryAt("1700000000", 1_000), 1_700_000_000_000, "provider epoch-second reset is recognized");


/* ---- persistence TTL authority (the caches prune on these; declared HERE, single source) ---- */
ok(mod.AUTHOR_REACH_TTL_MS === TWTTR_CLASS.followers.ttl, "author-reach persistence reuses the followers-class TTL (no forked authority)");
ok(mod.HEAVY_HITTER_TTL_MS === 30 * 24 * 3_600_000, "Fresh Reach radar accounts persist for 30 days and can be refreshed by later hunts");
ok(mod.TWTTR_CACHE_MAX_BYTES >= 6 * 1024 * 1024, "response cache can retain one expanded cold Fresh Reach hunt");

console.log(fail === 0 ? `\n✓ twttr policy: ${pass} assertions passed` : `\n✗ twttr policy: ${fail} failed, ${pass} passed`);
process.exit(fail === 0 ? 0 : 1);
