/**
 * Unit test for the engagement learning loop (learn-stats.ts). esbuild → data-URL import.
 * Run: node scripts/test-learn-stats.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as esbuild from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "../src/lib/learn-stats.ts"), "utf8");
const js = esbuild.transformSync(src, { loader: "ts", format: "esm" }).code;
const m = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) pass++; else { fail++; console.error("  FAIL:", l); } };
const near = (a, b, l, eps = 1e-6) => ok(Math.abs(a - b) < eps, l + ` (got ${a})`);
const NOW = 1_700_000_000_000;
const DAY = 86_400_000;

// ---- foldOwnDelta: per-post positive delta, new posts seed only, never negative ----
{
  const prev = { p1: { views: 100, likes: 5, reposts: 0, replies: 1 } };
  const { delta, nextPrev } = m.foldOwnDelta(prev, [
    { id: "p1", views: 150, likes: 9, reposts: 0, replies: 1 },
    { id: "p2", views: 30, likes: 2, reposts: 0, replies: 0 },
  ]);
  near(delta.views, 50, "fold: p1 grew +50 views");
  near(delta.likes, 4, "fold: p1 grew +4 likes; p2 (new) adds 0");
  ok(delta.topPostId === "p1", "fold: top growth post is p1");
  ok(nextPrev.p2 && nextPrev.p2.views === 30, "fold: p2 seeded as baseline");
  ok(delta.posts === 2 && delta.hadViews, "fold: posts counted + hadViews");
}
{
  // window-sum would go negative on a quiet day; per-post delta clamps to 0
  const { delta } = m.foldOwnDelta({ p1: { views: 500, likes: 0, reposts: 0, replies: 0 } }, [{ id: "p1", views: 480 }]);
  ok(delta.views === 0, "fold: a would-be-negative day clamps to 0, never negative");
}

// ---- aggregate + rank: shrinkage, min-N gate, unattributed ----
{
  const sent = [];
  sent.push({ at: NOW, author: "staracct", score: 1.0 }); // one lucky high reply
  for (let i = 0; i < 10; i++) sent.push({ at: NOW - i * DAY, author: "steady", score: 0.5 });
  sent.push({ at: NOW }); // no author → unattributed
  const agg = m.aggregateAccounts(sent, NOW);
  ok(agg.unattributed === 1, "agg: author-less reply goes to unattributed, not a fake account");
  ok(agg.accounts.staracct.invest < 0.8, "agg: a single 1.0 reply is shrunk toward the mean (no crowning)");
  const { ranked, learning } = m.rankAccounts(agg);
  ok(ranked.some((r) => r.handle === "steady"), "rank: a well-sampled account is ranked");
  ok(learning.some((r) => r.handle === "staracct") && !ranked.some((r) => r.handle === "staracct"), "rank: a 1-reply account is gated to 'still learning'");
}

// ---- Tier-2 measured score: undefined until N_MIN_OUT settled outcomes ----
{
  const three = []; for (let i = 0; i < 3; i++) three.push({ at: NOW - i * DAY, author: "acct3", score: 0.7, followers: 1000, outcome: { at: NOW, likes: 10, replies: 2 } });
  ok(m.aggregateAccounts(three, NOW).accounts.acct3.score === undefined, "tier2: 3 outcomes < N_MIN_OUT → no measured score");
  const four = []; for (let i = 0; i < 4; i++) four.push({ at: NOW - i * DAY, author: "acct4", score: 0.7, followers: 1000, outcome: { at: NOW, likes: 10, replies: 2 } });
  ok(typeof m.aggregateAccounts(four, NOW).accounts.acct4.score === "number", "tier2: 4 settled outcomes → a measured score appears");
}

// ---- decay over an elapsed gap ----
{
  const a = { x: { handle: "x", replies: 5, nEff: 10, invest: 1.0, nOut: 0, lastAt: NOW } };
  m.decayAccounts(a, 30);
  ok(a.x.invest < 0.45 && a.x.invest > 0.35, "decay: 30-day gap roughly halves-then-some (0.97^30)");
  ok(a.x.nEff < 4.1, "decay: nEff decays with the same factor");
}

// ---- prune by lowest nEff ----
{
  const a = { lo: { handle: "lo", nEff: 1 }, mid: { handle: "mid", nEff: 2 }, hi: { handle: "hi", nEff: 3 } };
  m.pruneAccounts(a, 2);
  ok(!a.lo && a.mid && a.hi, "prune: evicts the lowest-nEff account");
}

// ---- concentration spread nudge ----
{
  const recent = []; for (let i = 0; i < 20; i++) recent.push({ at: NOW - i, author: i < 9 ? "hog" : "u" + i });
  const c = m.concentration(recent);
  ok(c && c.handle === "hog" && Math.abs(c.pct - 0.45) < 1e-6, "concentration: 9/20 to one account triggers the spread nudge");
  const spread = []; for (let i = 0; i < 20; i++) spread.push({ at: NOW - i, author: "u" + i });
  ok(m.concentration(spread) === null, "concentration: well-spread replies → no nudge");
}

// ---- cadence trend ----
{
  const up = [{ at: NOW - 1 * DAY, author: "a" }, { at: NOW - 2 * DAY, author: "a" }, { at: NOW - 3 * DAY, author: "a" }, { at: NOW - 10 * DAY, author: "a" }];
  ok(m.cadenceTrend(up, "a", NOW, false) === "up", "cadence: more this week than last → up");
  ok(m.cadenceTrend(up, "a", NOW, true) === null, "cadence: suppressed when the log is truncated");
}

// ---- Tier-2 match-back ----
{
  // the same reply round-trips: what X returns ≈ what we stored (normalized), so sim is high
  const fetched = [{ text: "ship daily and measure what sticks", at: NOW, likes: 5, replies: 1 }];
  const sent = [{ norm: "ship daily measure what sticks today", at: NOW }, { norm: "completely unrelated sentence about cats", at: NOW }];
  const matches = m.matchOutcomes(fetched, sent);
  ok(matches.length === 1 && matches[0].index === 0 && matches[0].likes === 5, "match: a fetched reply credits the right stored reply's outcome");
  ok(m.matchOutcomes([{ text: "nothing in common whatsoever", at: NOW }], sent).length === 0, "match: a non-match is dropped, never guessed");
}

console.log(fail === 0 ? `\n✓ learn-stats: ${pass} assertions passed` : `\n✗ learn-stats: ${fail} failed, ${pass} passed`);
process.exit(fail === 0 ? 0 : 1);
