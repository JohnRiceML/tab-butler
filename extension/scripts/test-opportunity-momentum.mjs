/** Unit test for public-post momentum. Run: node scripts/test-opportunity-momentum.mjs */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as esbuild from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "../src/lib/opportunity-momentum.ts"), "utf8");
const js = esbuild.transformSync(src, { loader: "ts", format: "esm" }).code;
const m = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));
let pass = 0, fail = 0;
const ok = (c, l) => { if (c) pass++; else { fail++; console.error("  FAIL:", l); } };
const near = (a, b, l, eps = 1e-6) => ok(Math.abs(a - b) <= eps, `${l} (got ${a}, want ${b})`);
const NOW = 1_700_000_000_000, MIN = 60_000, HR = 3_600_000;

let store = m.freshOpportunityMetricStore();
let r = m.observeMany(store, [{ id: "p", views: 1000, likes: 10, replies: 1, reposts: 2 }], NOW - 12 * MIN);
store = r.store;
ok(r.changed && !m.momentumFor(store.tracks.p, NOW), "first observation is neutral");
r = m.observeMany(store, [{ id: "p", views: 2200, likes: 16, replies: 9, reposts: 4 }], NOW);
store = r.store;
const sig = m.momentumFor(store.tracks.p, NOW);
near(sig.viewsPerHour, 6000, "views/hour from a 12-minute delta");
near(sig.engagementsPerHour, 50, "engagement/hour weights reposts 2x");
ok(sig.score > 0 && sig.score <= 1, "momentum score is bounded");
ok(m.applyMomentum(0.5, sig) > 0.5 && m.applyMomentum(0.5, sig) <= 0.56, "Best-sort lift is positive and capped at 12%");
ok(m.adjustedTargetTime(NOW, sig) > NOW && m.adjustedTargetTime(NOW, sig) <= NOW + 5 * MIN, "target freshness bonus is capped at five minutes");

// Cached/identical payloads do not create an artificial observation interval.
const beforeAt = store.tracks.p.latest.at;
r = m.observeMany(store, [{ id: "p", views: 2200, likes: 16, replies: 9, reposts: 4 }], NOW + 12 * MIN);
ok(!r.changed && r.store.tracks.p.latest.at === beforeAt, "identical cached observations do not advance time");

// Replies are competition, never positive momentum.
let replyOnly = m.observeMany(undefined, [{ id: "r", replies: 1 }], NOW - 12 * MIN).store;
replyOnly = m.observeMany(replyOnly, [{ id: "r", replies: 30 }], NOW).store;
ok(m.momentumFor(replyOnly.tracks.r, NOW) === undefined, "reply-count growth alone is neutral");

// Missing fields inherit; corrections/decreases cannot create positive deltas.
let corrected = m.observeMany(undefined, [{ id: "c", views: 1000, likes: 20 }], NOW - 12 * MIN).store;
corrected = m.observeMany(corrected, [{ id: "c", views: 900 }], NOW).store;
const cs = m.momentumFor(corrected.tracks.c, NOW);
ok(cs && cs.viewsPerHour === 0 && cs.engagementsPerHour === 0, "counter decreases clamp to zero and missing likes are not treated as zero");

// Interval and freshness guards.
let short = m.observeMany(undefined, [{ id: "s", views: 0 }], NOW - 4 * MIN).store;
short = m.observeMany(short, [{ id: "s", views: 5000 }], NOW).store;
ok(!m.momentumFor(short.tracks.s, NOW), "under-five-minute intervals are neutral");
let long = m.observeMany(undefined, [{ id: "l", views: 0 }], NOW - 3 * HR).store;
long = m.observeMany(long, [{ id: "l", views: 5000 }], NOW).store;
ok(!m.momentumFor(long.tracks.l, NOW), "over-two-hour intervals are neutral");
ok(!m.momentumFor(store.tracks.p, NOW + 21 * MIN), "signals expire after twenty minutes");
ok(m.applyMomentum(0.42, undefined) === 0.42, "missing signal is exactly neutral");

// Out-of-order writes are ignored; pruning is TTL- and cap-bounded.
const ordered = m.observeMany(store, [{ id: "p", views: 9999 }], NOW - MIN);
ok(!ordered.changed && ordered.store.tracks.p.latest.at === NOW, "out-of-order observations are ignored");
const many = { version: 1, tracks: {} };
for (let i = 0; i < 305; i++) many.tracks[`m${i}`] = { id: `m${i}`, latest: { at: NOW - i, views: i } };
many.tracks.old = { id: "old", latest: { at: NOW - 49 * HR, views: 1 } };
const pruned = m.pruneStore(many, NOW);
ok(Object.keys(pruned.tracks).length === 300 && !pruned.tracks.old && pruned.tracks.m0, "pruning drops >48h tracks and keeps the newest 300");

// Cross-tab merges add disjoint coverage without letting stale snapshots erase a newer pair.
const tabA = m.observeMany(undefined, [{ id: "a", views: 10 }], NOW - 20 * MIN).store;
let tabB = m.observeMany(undefined, [{ id: "b", views: 20 }], NOW - 10 * MIN).store;
tabB = m.observeMany(tabB, [{ id: "b", views: 40 }], NOW).store;
let merged = m.mergeOpportunityMetricStores(tabA, tabB, NOW);
ok(merged.tracks.a && merged.tracks.b?.previous, "cross-tab merge unions disjoint ids and preserves observation pairs");
const staleB = m.observeMany(undefined, [{ id: "b", views: 5 }], NOW - 30 * MIN).store;
merged = m.mergeOpportunityMetricStores(merged, staleB, NOW);
ok(merged.tracks.b.latest.at === NOW && merged.tracks.b.previous, "stale tab cannot erase the newer same-id pair");

console.log(fail === 0 ? `\n✓ opportunity momentum: ${pass} assertions passed` : `\n✗ opportunity momentum: ${fail} failed, ${pass} passed`);
process.exit(fail === 0 ? 0 : 1);
