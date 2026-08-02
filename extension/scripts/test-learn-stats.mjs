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
const copilotSrc = readFileSync(join(here, "../src/content/x-copilot.ts"), "utf8");
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
  const three = []; for (let i = 0; i < 3; i++) three.push({ at: NOW - i * DAY, author: "acct3", score: 0.7, followers: 1000, outcome: { at: NOW, likes: 10, replies: 2, frozen: true } });
  ok(m.aggregateAccounts(three, NOW).accounts.acct3.score === undefined, "tier2: 3 outcomes < N_MIN_OUT → no measured score");
  const four = []; for (let i = 0; i < 4; i++) four.push({ at: NOW - i * DAY, author: "acct4", score: 0.7, followers: 1000, outcome: { at: NOW, likes: 10, replies: 2, frozen: true } });
  ok(typeof m.aggregateAccounts(four, NOW).accounts.acct4.score === "number", "tier2: 4 settled outcomes → a measured score appears");
  const provisional = four.map((r) => ({ ...r, outcome: { ...r.outcome, frozen: false } }));
  const provisionalAgg = m.aggregateAccounts(provisional, NOW).accounts.acct4;
  ok(provisionalAgg.nOut === 0 && provisionalAgg.score === undefined, "tier2: provisional counts never unlock a settled account score");
}

// ---- cross-tab outcome merge: proof and counters can advance, never regress ----
{
  const settled = { at: NOW, likes: 10, replies: 2, views: 500, tweetId: "reply-1", authorReplied: true, frozen: true };
  const stale = { at: NOW - DAY, likes: 4, replies: 1, reposts: 3, frozen: false };
  const merged = m.mergeReplyOutcomes(settled, stale);
  ok(merged.at === NOW && merged.likes === 10 && merged.replies === 2 && merged.views === 500 && merged.reposts === 3, "outcome merge preserves newest/max counters while filling missing fields");
  ok(merged.tweetId === "reply-1" && merged.authorReplied === true && merged.frozen === true, "stale outcome cannot erase tweet proof, reply-back truth, or thaw a frozen record");
  const advanced = m.mergeReplyOutcomes(merged, { at: NOW + DAY, likes: 12, replies: 2, views: 700, reposts: 2, tweetId: "reply-1" });
  ok(advanced.at === NOW + DAY && advanced.likes === 12 && advanced.views === 700 && advanced.reposts === 3 && advanced.frozen === true, "new observations advance counters without regressing prior maxima or frozen state");
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
  const missing = m.matchOutcomes([{ text: "ship daily and measure what sticks", at: NOW, views: 20 }], sent)[0];
  ok(missing.likes === undefined && missing.replies === undefined && missing.views === 20, "match: omitted provider counts stay missing instead of becoming false zeroes");
}

// ---- RapidAPI verification: attempts stay pending until an actual reply match exists ----
{
  const HR = 3_600_000;
  const sent = [
    { at: NOW - HR, norm: "pending reply text" },
    { at: NOW - 2 * HR, norm: "api matched reply", outcome: { at: NOW, likes: 0, replies: 0, tweetId: "reply-1" } },
    { at: NOW - 3 * HR, confirmation: "manual", confirmedAt: NOW - 3 * HR },
    { at: NOW - 80 * HR, norm: "too old to keep pending" },
    { at: NOW - HR }, // no text: an old proxy record cannot be verified automatically
  ];
  const s = m.replyVerificationSummary(sent, NOW - 7 * DAY, NOW);
  ok(s.attempted === 5 && s.confirmed === 2 && s.pending === 1, "verification separates confirmed, pending, and stale/unmatchable attempts");
  ok(m.isConfirmedReply({ at: NOW, outcome: { at: NOW, likes: 0, replies: 0 } }), "legacy measured outcomes count as RapidAPI-confirmed");
  ok(!m.isConfirmedReply({ at: NOW, outcome: { at: NOW, authorReplied: true } }), "notification-only engaged-back join is not posting proof");
}

/* ---- outcome upgrade: views/reposts/id ride the match; fitCorrViews tracks distribution ---- */
{
  const fetched = [{ text: "ship daily measure what sticks today", at: NOW, likes: 5, replies: 1, views: 900, reposts: 2, id: "t123" }];
  const sent = [{ norm: "ship daily measure what sticks today", at: NOW }];
  const m1 = m.matchOutcomes(fetched, sent);
  ok(m1.length === 1 && m1[0].views === 900 && m1[0].reposts === 2 && m1[0].replyId === "t123", "match threads views/reposts/replyId from the same paid response");
  const MIN = 60_000;
  const corr = Array.from({ length: 14 }, (_, i) => ({
    at: NOW - ((i % 5) + 1) * 86_400_000, author: "a", angle: "value", ageMs: 5 * MIN, followers: 1000, score: i / 14,
    outcome: { at: NOW, likes: 2, replies: 0, views: i * 400, frozen: true },
  }));
  const fl = m.learnFeatures(corr, NOW);
  ok(fl.fitCorrViews > 0.8, "fitCorrViews measures fit-vs-DISTRIBUTION when views are tracked");
  const noViews = corr.map((r) => ({ ...r, outcome: { ...r.outcome, views: undefined } }));
  ok(m.learnFeatures(noViews, NOW).fitCorrViews === undefined, "no views tracked → fitCorrViews stays silent");
}

/* ---- fillAuthorReplied: the $0 engaged-back join (handle + 72h, honest guards) ---- */
{
  const HR = 3_600_000;
  const mk = (author, at, extra = {}) => ({ at, author, ...extra });
  // basic: inbound reply from H 2h after our reply to H → credited
  let sent = [mk("alice", NOW - 2 * HR)];
  ok(m.fillAuthorReplied([{ at: NOW, handle: "Alice", kind: "reply" }], sent) === 1 && sent[0].outcome.authorReplied === true, "engaged-back credited (case-insensitive handle, inside 72h)");
  // window: 80h later → no credit
  sent = [mk("bob", NOW - 80 * HR)];
  ok(m.fillAuthorReplied([{ at: NOW, handle: "bob", kind: "reply" }], sent) === 0, "outside the 72h window → no claim");
  // direction: their reply BEFORE ours → no credit
  sent = [mk("cara", NOW + 1 * HR)];
  ok(m.fillAuthorReplied([{ at: NOW, handle: "cara", kind: "reply" }], sent) === 0, "an inbound event before our reply never counts");
  // one event consumes ONE record, most recent wins
  sent = [mk("dan", NOW - 50 * HR), mk("dan", NOW - 2 * HR)];
  ok(m.fillAuthorReplied([{ at: NOW, handle: "dan", kind: "reply" }], sent) === 1 && sent[1].outcome.authorReplied === true && !sent[0].outcome, "one event credits only the most recent eligible reply");
  // kind filter: mentions don't count as engaged-back
  sent = [mk("eve", NOW - 2 * HR)];
  ok(m.fillAuthorReplied([{ at: NOW, handle: "eve", kind: "mention" }], sent) === 0, "a mention is not an engaged-back reply");
  // idempotent: a second event doesn't double-credit the same record
  sent = [mk("fay", NOW - 3 * HR)];
  m.fillAuthorReplied([{ at: NOW - 2 * HR, handle: "fay", kind: "reply" }], sent);
  ok(m.fillAuthorReplied([{ at: NOW - 1 * HR, handle: "fay", kind: "reply" }], sent) === 0, "already-credited records aren't re-marked");
  // aggregateAccounts surfaces the measured count
  const reps = [mk("gil", NOW - 2 * HR, { outcome: { at: NOW, likes: 1, replies: 0, authorReplied: true, frozen: true } }), mk("gil", NOW - 5 * HR)];
  const agg = m.aggregateAccounts(reps, NOW);
  ok(agg.accounts["gil"].backs === 1, "aggregate carries the measured engaged-back count per account");
  // HONESTY GUARD: a join-only outcome (authorReplied, no counts) must count as a "back" but NEVER
  // enter fit as a phantom zero-engagement measured result.
  const joinOnly = [];
  for (let i = 0; i < 6; i++) joinOnly.push(mk("hank", NOW - (i + 1) * 24 * HR, { angle: "ask", ageMs: 5 * 60_000, score: 0.7, outcome: { at: NOW, authorReplied: true } }));
  const aggJ = m.aggregateAccounts(joinOnly, NOW);
  ok(aggJ.accounts["hank"].backs === 6 && aggJ.accounts["hank"].nOut === 0 && aggJ.accounts["hank"].score === undefined, "join-only outcomes count backs but never nOut / a measured score");
  const flJ = m.learnFeatures(joinOnly, NOW);
  ok(flJ.nOut === 0 && flJ.angles.length === 0 && flJ.fitCorr === undefined, "join-only outcomes never enter learnFeatures' fit slices or correlations");
}

/* ---- learnFeatures: WHAT works (angles, timing, fit-validity) — the self-tuning half ---- */
{
  const MIN = 60_000;
  const rec = (angle, ageMs, likes, score, daysAgo = 1) => ({
    at: NOW - daysAgo * 86_400_000, author: "a", angle, ageMs, followers: 1000, score,
    outcome: { at: NOW, likes, replies: 0, frozen: true },
  });
  // "ask" replies consistently outperform "value" ones
  const sent = [
    ...Array.from({ length: 6 }, (_, i) => rec("ask", 5 * MIN, 20, 0.7, i + 1)),
    ...Array.from({ length: 6 }, (_, i) => rec("value", 5 * MIN, 2, 0.6, i + 1)),
  ];
  const fl = m.learnFeatures(sent, NOW);
  ok(fl.nOut === 12 && fl.angles.length === 2, "both angles clear the min-N gate");
  ok(fl.angles[0].angle === "ask" && fl.bestAngle === "ask", "the measured-best angle wins the star");
  const provisional = sent.map((r) => ({ ...r, outcome: { ...r.outcome, frozen: false } }));
  const provisionalFl = m.learnFeatures(provisional, NOW);
  ok(provisionalFl.nOut === 0 && provisionalFl.angles.length === 0 && provisionalFl.bestAngle === undefined, "provisional outcomes cannot select the learned default angle");
  const cohorts = sent.slice(0, 8).map((r, i) => ({
    ...r,
    source: i < 4 ? "feed" : "search",
    lane: i < 4 ? "community" : "discovery",
    outcome: { ...r.outcome, likes: i < 4 ? 2 : 30 },
  }));
  const cohortFl = m.learnFeatures(cohorts, NOW);
  ok(cohortFl.sources.length === 2 && cohortFl.sources[0].key === "search" && cohortFl.sources.every((c) => c.n >= m.N_MIN_OUT), "settled discovery-source cohorts are min-N gated and ranked");
  ok(cohortFl.lanes.length === 2 && cohortFl.lanes[0].key === "discovery" && cohortFl.lanes.every((c) => c.n >= m.N_MIN_OUT), "settled recommendation-lane cohorts are min-N gated and ranked");
  // min-N gate: 3 outcomes never rank
  const thin = m.learnFeatures([...Array.from({ length: 3 }, (_, i) => rec("joke", 5 * MIN, 50, 0.5, i + 1))], NOW);
  ok(thin.angles.length === 0 && thin.bestAngle === undefined, "a 3-outcome angle stays unranked (min-N gate)");
  // a lone ranked angle can't be "best" (nothing to beat)
  const lone = m.learnFeatures([...Array.from({ length: 5 }, (_, i) => rec("ask", 5 * MIN, 30, 0.5, i + 1))], NOW);
  ok(lone.angles.length === 1 && lone.bestAngle === undefined, "one ranked angle alone earns no star");
  // timing gradient: fresh replies out-earn stale ones
  const timed = [
    ...Array.from({ length: 5 }, (_, i) => rec("value", 4 * MIN, 12, 0.5, i + 1)),
    ...Array.from({ length: 5 }, (_, i) => rec("value", 3 * 60 * MIN, 3, 0.5, i + 1)),
  ];
  const ft = m.learnFeatures(timed, NOW);
  ok(ft.ageGradient > 2 && ft.freshN === 5 && ft.staleN === 5, "fresh-vs-stale gradient is measured (fresh ~4x here)");
  ok(ft.ageBuckets.some((b) => b.label === "<15m") && ft.ageBuckets.some((b) => b.label === "1-6h"), "age buckets populate");
  // fit correlation: high fit → high outcome gives a positive Spearman (n >= 12)
  const corr = Array.from({ length: 14 }, (_, i) => rec("value", 5 * MIN, i * 3, i / 14, (i % 5) + 1));
  ok(m.learnFeatures(corr, NOW).fitCorr > 0.8, "stage-1 fit that tracks outcomes shows a strong positive rho");
  ok(m.learnFeatures(corr.slice(0, 8), NOW).fitCorr === undefined, "below n=12 the correlation stays silent (noise)");
  // no outcomes → no claims at all
  const none = m.learnFeatures([{ at: NOW, angle: "ask" }], NOW);
  ok(none.nOut === 0 && none.angles.length === 0 && none.ageGradient === undefined, "no settled outcomes → the learner says nothing");
}

/* ---- accountTrend: measured "is the account picking up?" (results, not activity) ---- */
{
  const DAY = 86_400_000;
  const snap = (daysAgo, posts, views, extra = {}) => {
    const day = m.dayKeyLocal(NOW - daysAgo * DAY);
    return [day, { day, posts, views, likes: 0, reposts: 0, replies: 0, hadViews: views > 0, ...extra }];
  };
  // picking up: this week's posts average far more views than last week's
  const up = Object.fromEntries([snap(1, 2, 2000), snap(3, 2, 1800), snap(8, 2, 600), snap(10, 2, 700)]);
  const atUp = m.accountTrend(up, NOW);
  ok(atUp?.state === "picking-up" && atUp.metric === "views", "2x views/post week-over-week reads as picking up (views metric)");
  // cooling: the reverse
  const down = Object.fromEntries([snap(1, 2, 500), snap(3, 2, 400), snap(8, 2, 1500), snap(10, 2, 1600)]);
  ok(m.accountTrend(down, NOW)?.state === "cooling", "a big week-over-week drop reads as cooling");
  // steady: within the band
  const flat = Object.fromEntries([snap(1, 2, 1000), snap(3, 2, 1000), snap(8, 2, 1000), snap(10, 2, 950)]);
  ok(m.accountTrend(flat, NOW)?.state === "steady", "roughly-equal weeks read as steady");
  // honest null: not enough posts in both windows → no claim
  ok(m.accountTrend(Object.fromEntries([snap(1, 1, 900)]), NOW) === null, "one post total → null (say nothing, never guess)");
  ok(m.accountTrend({}, NOW) === null, "no snaps → null");
  // engagement fallback when views are missing in a window
  const noViews = Object.fromEntries([
    snap(1, 2, 0, { likes: 40, hadViews: false }), snap(3, 2, 0, { likes: 44, hadViews: false }),
    snap(8, 2, 0, { likes: 10, hadViews: false }), snap(10, 2, 0, { likes: 12, hadViews: false })]);
  const atEng = m.accountTrend(noViews, NOW);
  ok(atEng?.state === "picking-up" && atEng.metric === "engagement", "no views → falls back to engagement-per-post");
  // follower delta: measured across the window, needs a real span
  const withF = Object.fromEntries([snap(1, 2, 1000, { followers: 3300 }), snap(3, 2, 1000), snap(9, 2, 900, { followers: 3200 }), snap(11, 2, 950)]);
  ok(m.accountTrend(withF, NOW)?.followerDelta === 100, "follower delta = latest minus earliest snapshot in the window");
  ok(m.accountTrend(up, NOW)?.followerDelta === undefined, "no follower snapshots → no delta claimed");
}

// ---- W_REPOST: a repost of your reply raises measured fit (was parsed+stored, then dropped) ----
{
  const NOWR = 1_700_000_000_000;
  const mk = (reposts) => [{ at: NOWR - 86_400_000, author: "a", score: 0.5, followers: 1000,
    outcome: { at: NOWR, likes: 5, replies: 1, reposts, frozen: true } }];
  const withR = m.aggregateAccounts(mk(3), NOWR).accounts.a;
  const withoutR = m.aggregateAccounts(mk(0), NOWR).accounts.a;
ok(withR.nOut === 1 && withoutR.nOut === 1, "repost fixture: both outcomes measured");
  // score is undefined below N_MIN_OUT, so compare the raw obs path via muObs instead
  ok(m.aggregateAccounts(mk(3), NOWR).muObs > m.aggregateAccounts(mk(0), NOWR).muObs, "reposts now raise measured fit (W_REPOST, was silently dropped)");
}

ok(copilotSrc.includes('path: "user-replies-v2", query: { user: restId, count: "80" }'), "reply verification requests the expanded 80-row recent window");
ok(copilotSrc.includes("if (text.trim()) scheduleReplyVerification()"), "manual text-bearing reply confirmations enter the RapidAPI verification path");
ok(copilotSrc.includes("pending.outcome?.tweetId ? 12 * HOUR_MS : VERIFY_RETRY_MS"), "proven provisional outcomes use a bounded twelve-hour settlement refresh cadence");

console.log(fail === 0 ? `\n✓ learn-stats: ${pass} assertions passed` : `\n✗ learn-stats: ${fail} failed, ${pass} passed`);
process.exit(fail === 0 ? 0 : 1);
