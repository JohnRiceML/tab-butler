/**
 * Unit test for fresh-reach.ts. Run with `node scripts/test-fresh-reach.mjs`.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as esbuild from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, "../src/lib/fresh-reach.ts");
const built = await esbuild.build({ entryPoints: [entry], bundle: true, write: false, format: "esm", platform: "node" });
const m = await import("data:text/javascript;base64," + Buffer.from(built.outputFiles[0].text).toString("base64"));

let pass = 0, fail = 0;
const ok = (c, label) => { if (c) pass++; else { fail++; console.error("  FAIL:", label); } };
const NOW = Date.UTC(2026, 6, 30, 18);
const MIN = 60_000;
const MY = 1_000;
const post = (over = {}) => ({
  id: "p1", author: "alice", text: "A concrete niche claim", postedAt: NOW - 8 * MIN,
  followers: 8_000, replies: 2, isReply: false, ...over,
});

const live = m.freshReachCandidate(post(), MY, NOW);
ok(live?.state === "reply now" && live.ageMinutes === 8, "fresh, reachable, uncrowded post is ready");
ok(live?.sizeMultiple === 8, "reports observed audience multiple");
ok(live?.kind === "early-fit" && live.signals.distributionScore === 0, "thin public metrics stay a neutral early-fit claim");
ok(m.freshReachCandidate(post({ postedAt: NOW - m.FRESH_REACH_MAX_AGE_MS - 1 }), MY, NOW) === null, "hard maximum age is eligibility, not only sort order");
ok(m.freshReachCandidate(post({ postedAt: NOW - 45 * MIN }), MY, NOW)?.state === "cooling", "30–120 minute post is visibly cooling");
ok(m.freshReachCandidate(post({ replies: 30 }), MY, NOW) === null, "crowded threads are excluded");
ok(m.freshReachCandidate(post({ replies: undefined }), MY, NOW) === null, "unknown competition cannot be called uncrowded");
ok(m.freshReachCandidate(post({ followers: 1_500 }), MY, NOW) === null, "same-size account is not a large-account reach hunt");
ok(m.freshReachCandidate(post({ followers: 30_000 }), MY, NOW) != null, "Fresh Reach can inspect accounts beyond the narrower practical target band");
ok(m.freshReachCandidate(post({ followers: 600_000 }), 30_000, NOW) != null, "massive accounts remain eligible when the live post itself is unusually open");
ok(m.freshReachCandidate(post({ isReply: true }), MY, NOW) === null, "replies are not treated as original posts");
ok(m.freshReachCandidate(post({ postedAt: undefined }), MY, NOW) === null, "unknown age cannot claim to be fresh");
ok(m.freshReachCandidate(post(), 0, NOW) === null, "unknown user size cannot claim reachable audience");
ok(m.freshReachCandidate(post({ postedAt: NOW - 119 * MIN }), MY, NOW + 2 * MIN) === null, "a previously-live card ages out when rechecked");
ok(m.freshReachCandidate(post({ replies: 30 }), MY, NOW + MIN) === null, "a refreshed reply count can cool a previously-open thread");

const breakout = m.freshReachCandidate(post({ views: 18_000, likes: 620, reposts: 90, quotes: 20, replies: 40 }), MY, NOW);
ok(breakout?.kind === "breakout", "exceptional view and engagement pace can identify a breakout despite modestly higher competition");
ok((breakout?.signals.viewsPerMinute ?? 0) > 2_000 && (breakout?.signals.engagements ?? 0) === 730, "breakout evidence exposes transparent public pace and engagement totals");
ok(m.freshReachCandidate(post({ views: 400, likes: 8, reposts: 1, replies: 40 }), MY, NOW) === null, "ordinary metrics cannot widen the normal reply-room limit");
const majorEarly = m.freshReachCandidate(post({ followers: 2_000_000, postedAt: NOW - 10 * MIN, views: 90_000, likes: 2_000, reposts: 300, replies: 60 }), MY, NOW);
ok(majorEarly?.kind === "major-early", "major account with live distribution and an unusually early thread gets its own lane");
ok(m.freshReachCandidate(post({ followers: 2_000_000, postedAt: NOW - 10 * MIN, replies: 60 }), MY, NOW) === null, "fame alone cannot widen reply competition without observed distribution");
ok(m.freshReachCandidate(post({ followers: 2_000_000, postedAt: NOW - 10 * MIN, views: 90_000, likes: 2_000, replies: 80 }), MY, NOW) === null, "major-account lane still has a hard competition ceiling");
ok(m.freshReachCandidate(post({ followers: 2_000_000, postedAt: NOW - 21 * MIN, views: 90_000, likes: 2_000, replies: 60 }), MY, NOW) === null, "expanded major-account room is limited to the first twenty minutes");
const engagementOnly = m.freshReachCandidate(post({ views: undefined, likes: 420, reposts: 60, quotes: 20 }), MY, NOW);
ok(engagementOnly?.kind === "breakout", "strong public engagement can prove breakout pace when view count is unavailable");

ok(m.freshReachContentEligible({ score: 0.8, risk: "none", anchor: "the 12-minute cache", replyBrief: "add a concrete cache invalidation caveat" }), "specific, safe contribution passes the content gate");
ok(!m.freshReachContentEligible({ score: 0.67, risk: "none", anchor: "the claim", replyBrief: "add evidence" }), "weak content fit cannot ride a large account into the queue");
ok(!m.freshReachContentEligible({ score: 0.9, risk: "generic", anchor: "the claim", replyBrief: "agree" }), "generic praise is rejected even with a high numeric score");
ok(!m.freshReachContentEligible({ score: 0.9, risk: "none", anchor: "the claim" }), "missing contribution guidance is rejected");

const opening = m.freshReachOpeningScore({ contentFit: 0.8, observedOpportunity: 0.9 });
ok(Math.abs(opening - 0.72) < 0.0001, "opening index multiplies content by observed opportunity");
ok(m.freshReachOpeningScore({ contentFit: 0.3, observedOpportunity: 1, momentum: 1 }) < 0.34, "audience and momentum cannot rescue weak content");
ok(m.freshReachOpeningScore({ contentFit: 0.8, observedOpportunity: 0.9, momentum: 1 }) <= opening * 1.12 + 0.0001, "measured momentum adds at most twelve percent");
ok(m.freshReachOpeningBand(0.8) === "exceptional" && m.freshReachOpeningBand(0.65) === "strong" && m.freshReachOpeningBand(0.5) === "qualified", "opening bands communicate strength without claiming probability");

const repeated = m.freshReachCandidate(post(), MY, NOW, NOW - 2 * 60 * MIN);
ok(repeated.opportunity < live.opportunity * 0.7, "same-author reply inside 24h receives the strong diversity penalty");
const olderRepeat = m.freshReachCandidate(post(), MY, NOW, NOW - 48 * 60 * MIN);
ok(olderRepeat.opportunity > repeated.opportunity && olderRepeat.opportunity < live.opportunity, "24–72h repeat receives the softer penalty");

const ranked = m.pickFreshReachCandidates([
  post({ id: "a-old", postedAt: NOW - 25 * MIN }),
  post({ id: "a-new", postedAt: NOW - 4 * MIN }),
  post({ id: "b", author: "bob", followers: 10_000, postedAt: NOW - 10 * MIN, replies: 4 }),
  post({ id: "stale", author: "stale", postedAt: NOW - 3 * 60 * MIN }),
], MY, NOW, {}, 5);
ok(ranked.length === 2, "mixed results keep only eligible authors");
ok(ranked.filter((x) => x.post.author === "alice").length === 1 && ranked.some((x) => x.post.id === "a-new"), "one best post per author preserves account diversity");
ok(ranked[0].opportunity >= ranked[1].opportunity, "results sort by observed opportunity");
ok(m.pickFreshReachCandidates([post()], MY, NOW, {}, 0).length === 0, "max bound is honored");
const twoPerAuthor = m.pickFreshReachCandidates([
  post({ id: "same-generic", postedAt: NOW - 4 * MIN }),
  post({ id: "same-substantive", postedAt: NOW - 35 * MIN }),
  post({ id: "other", author: "bob", followers: 9_000 }),
], MY, NOW, {}, 6, 2);
ok(twoPerAuthor.filter((x) => x.post.author === "alice").length === 2, "deep pre-score mode can retain two posts per author until content fit is known");

const accounts = m.pickFreshReachAccounts([
  { handle: "small", followers: 1_500, activeInLatest: true },
  { handle: "large", followers: 10_000, engagementRate: 0.01 },
  { handle: "tracked", followers: 7_000, tracked: true, activeInLatest: true },
  { handle: "mega", followers: 600_000, engagementRate: 0.2 },
], MY, NOW, 5);
ok(accounts.length === 3, "account hunt keeps practical accounts and one massive exploration candidate");
ok(accounts.some((x) => x.account.handle === "large") && accounts.some((x) => x.account.handle === "tracked"), "heavy hitters and tracked active accounts both enter the bounded hunt");
ok(accounts.some((x) => x.account.handle === "mega" && x.massive), "massive radar accounts are explicitly labeled rather than silently excluded");
ok(accounts.every((x) => x.priority >= 0 && x.priority <= 1), "account priorities remain bounded opportunity signals");
ok(m.FRESH_REACH_ACCOUNT_CHECKS === 12, "manual Fresh Reach hunt budgets twelve diverse direct account checks");
ok(m.FRESH_REACH_WATCHLIST_MAX === 12 && m.FRESH_REACH_WATCHLIST_LANES === 4, "private massive watchlist is capped at twelve with four rotating scan lanes");
ok(m.pickFreshReachAccounts([
  { handle: "checked", followers: 10_000, lastCheckedAt: NOW - 2 * MIN },
  { handle: "due", followers: 10_000, lastCheckedAt: NOW - 2 * 60 * MIN },
], MY, NOW, 1)[0]?.account.handle === "due", "recently-paid account checks rotate toward due accounts");
ok(m.pickFreshReachAccounts([
  { handle: "repeat", followers: 10_000, engagementRate: 0.01, lastReplyAt: NOW - 60 * MIN },
  { handle: "fresh_author", followers: 8_000, engagementRate: 0.005 },
], MY, NOW, 1)[0]?.account.handle === "fresh_author", "recently-replied authors are diversified before fetching");
ok(m.pickFreshReachAccounts([{ handle: "bad OR from:other", followers: 10_000 }], MY, NOW, 1).length === 0, "invalid handles cannot become search operators");
ok(m.pickFreshReachAccounts([{ handle: "large", followers: 10_000 }], MY, NOW, 0).length === 0, "account query bound is honored");
ok(m.pickFreshReachAccounts([
  { handle: "cached", followers: 10_000, lastCheckedAt: NOW - 2 * MIN },
  ...Array.from({ length: 5 }, (_, i) => ({ handle: `due_${i}`, followers: 5_000 + i * 500 })),
], MY, NOW, 5).every((x) => x.account.handle !== "cached"), "a live cached query cannot crowd out five due account checks");
ok(m.pickFreshReachAccounts([
  { handle: "practical_1", followers: 8_000, engagementRate: 0.1 },
  { handle: "practical_2", followers: 9_000, engagementRate: 0.08 },
  { handle: "practical_3", followers: 10_000, engagementRate: 0.06 },
  { handle: "massive", followers: 2_000_000, engagementRate: 0.001 },
], MY, NOW, 4).some((x) => x.account.handle === "massive"), "a due massive account receives one exploration lane even when practical accounts rank higher");
const noFameReservation = m.pickFreshReachAccounts([
  ...Array.from({ length: 12 }, (_, i) => ({ handle: `strong_${i}`, followers: 8_000 + i * 100, distributionScore: 0.8, activeInLatest: true })),
  { handle: "flat_celebrity", followers: 100_000_000, engagementRate: 0.0001 },
], MY, NOW, 12);
ok(!noFameReservation.some((x) => x.account.handle === "flat_celebrity"), "fame-only massive account cannot displace twelve stronger evidence-backed practical checks");
const recentWinner = m.pickFreshReachAccounts([
  { handle: "recent_winner", followers: 2_000_000, shortlisted: true, replyViewScore: 4_000, lastReplyAt: NOW - 60 * MIN },
  ...Array.from({ length: 12 }, (_, i) => ({ handle: `fp_${i}`, followers: 8_000 + i * 100, distributionScore: 0.8 })),
], MY, NOW, 12);
ok(!recentWinner.some((x) => x.account.handle === "recent_winner"), "a measured winner replied to in the last day is not forced into a full higher-priority check set");
ok(m.pickFreshReachAccounts([
  { handle: "tracked", followers: 7_000, tracked: true },
  { handle: "proven", followers: 7_000, checks: 2, strongOpenings: 1 },
  { handle: "viral", followers: 8_000, distributionScore: 0.92, peakViews: 900_000 },
  { handle: "active", followers: 9_000, activeInLatest: true },
], MY, NOW, 3).some((x) => x.account.handle === "viral"), "proven public distribution receives a reserved account-check lane");
const yieldedAccounts = m.pickFreshReachAccounts([
  { handle: "proven", followers: 6_000, checks: 4, strongOpenings: 3 },
  { handle: "unknown", followers: 6_000 },
], MY, NOW, 2);
ok(yieldedAccounts.find((x) => x.account.handle === "proven").priority > yieldedAccounts.find((x) => x.account.handle === "unknown").priority, "accounts that repeatedly yield strong openings earn a learned priority lift without a hard lane reservation");
const massiveLanes = m.pickFreshReachAccounts([
  { handle: "winner", followers: 2_000_000, shortlisted: true, replyViewOutcomes: 3, replyViewScore: 4_000 },
  { handle: "explore_massive", followers: 3_000_000, distributionScore: 0.75 },
  ...Array.from({ length: 6 }, (_, i) => ({ handle: `practical_lane_${i}`, followers: 8_000 + i * 500, tracked: i === 0, activeInLatest: i === 1 })),
], MY, NOW, 8);
ok(massiveLanes.some((x) => x.account.handle === "winner"), "a measured massive-account winner receives a reserved check lane");
ok(massiveLanes.some((x) => x.account.handle === "explore_massive"), "a new massive exploration account receives a separate check lane");
ok(massiveLanes.filter((x) => x.massive).length === 2, "massive coverage stays bounded to winner plus exploration when both lanes exist");
const watchLanes = m.pickFreshReachAccounts([
  ...Array.from({ length: 6 }, (_, i) => ({ handle: `watch_${i}`, followers: 2_000_000 + i, watchlisted: true, lastCheckedAt: i < 2 ? NOW - 2 * MIN : undefined })),
  { handle: "measured_winner", followers: 3_000_000, shortlisted: true, replyViewOutcomes: 3, replyViewScore: 4_000 },
  { handle: "new_massive", followers: 4_000_000, distributionScore: 0.8 },
  ...Array.from({ length: 8 }, (_, i) => ({ handle: `regular_${i}`, followers: 8_000 + i * 500, tracked: i === 0, activeInLatest: i === 1 })),
], MY, NOW, 12);
ok(watchLanes.filter((x) => x.account.watchlisted).length === 4, "four due explicit massive-account pins receive bounded direct-check lanes");
ok(watchLanes.filter((x) => x.account.watchlisted).every((x) => !["watch_0", "watch_1"].includes(x.account.handle)), "fresh watchlist lanes rotate past accounts whose paid query is still cached");
ok(watchLanes.some((x) => x.account.handle === "measured_winner") && watchLanes.some((x) => x.account.handle === "new_massive"), "watchlist pins do not displace measured-winner and new-massive exploration lanes");

// Massive-account keep-list: actual Fresh Reach reply views, settled and API-attributed only.
const settled = (over = {}) => ({
  at: NOW - 3 * 24 * 60 * MIN,
  author: "winner",
  source: "fresh-reach",
  followers: 2_000_000,
  confirmation: "rapidapi",
  freshReach: { kind: "major-early", sizeMultiple: 2_000 },
  outcome: { views: 900, likes: 4, replies: 1, frozen: true, tweetId: "reply-1" },
  ...over,
});
const keep = m.freshReachShortlist([
  settled(),
  settled({ at: NOW - 4 * 24 * 60 * MIN, outcome: { views: 1_100, frozen: true, tweetId: "reply-2" } }),
  settled({ author: "one_spike", outcome: { views: 5_000, frozen: true, tweetId: "reply-3" } }),
  settled({ author: "flat", outcome: { views: 20, frozen: true, tweetId: "reply-4" } }),
  settled({ author: "provisional", outcome: { views: 10_000, frozen: false, tweetId: "reply-5" } }),
  settled({ author: "manual_only", confirmation: "manual", outcome: { views: 10_000, frozen: true } }),
  settled({ author: "wrong_source", source: "target", outcome: { views: 10_000, frozen: true, tweetId: "reply-6" } }),
], MY);
ok(keep.some((x) => x.handle === "winner" && x.outcomes === 2 && x.averageReplyViews === 1_000 && x.confidence === "repeat signal"), "repeat settled reply views create a measured massive-account keep-list row");
ok(keep[0]?.handle === "one_spike" && keep[0].bestReplyViews === 5_000, "the keep-list orders accounts by shrunk reply-view performance");
ok(!keep.some((x) => ["flat", "provisional", "manual_only", "wrong_source"].includes(x.handle)), "flat, provisional, unverified, and non-Fresh records cannot become winners");
ok(m.freshReachShortlist([settled({ author: "practical", followers: 8_000, freshReach: { kind: "early-fit", sizeMultiple: 8 } })], MY).length === 0, "the massive keep-list does not absorb practical accounts");
ok(m.freshReachShortlist(Array.from({ length: 12 }, (_, i) => settled({ author: `winner_${i}`, outcome: { views: 1_000, frozen: true, tweetId: `reply-${i}` } })), MY).length === 10, "the measured keep-list is capped at ten accounts");
ok(m.freshReachShortlist([settled({ at: NOW - m.FRESH_REACH_SHORTLIST_RETENTION_MS - 1 })], MY, 10, NOW).length === 0, "the keep-list forgets outcomes older than thirty days");
ok(m.isMassiveFreshReachAccount(2_000_000, MY) && !m.isMassiveFreshReachAccount(8_000, MY), "massive-account classification is shared by post selection and the keep-list");
ok((m.decayFreshReachEvidence(0.8, NOW - m.FRESH_REACH_EVIDENCE_HALF_LIFE_MS, NOW) - 0.4) < 0.0001, "public distribution evidence halves after fourteen days instead of becoming permanent");
ok(m.freshReachShortlist([settled({ at: NOW - 3 * 24 * 60 * MIN, freshReach: { kind: "major-early", sizeMultiple: 2_000, expiresAt: NOW - 3 * 24 * 60 * MIN - 1 } })], MY).length === 0, "a reply sent after its Fresh opening expired cannot teach the massive-account winner lane");

const midBand = m.freshReachCandidate(post({ followers: 8_000 }), MY, NOW);
const edgeBand = m.freshReachCandidate(post({ followers: 17_500 }), MY, NOW);
ok(midBand.opportunity > edgeBand.opportunity, "mid-band reach beats the largest eligible account when timing and room are equal");
const massivePost = m.freshReachCandidate(post({ followers: 2_000_000 }), MY, NOW);
ok(massivePost && massivePost.opportunity < midBand.opportunity, "massive-account eligibility carries a visibility-gap penalty instead of an automatic size reward");

const copilot = readFileSync(join(here, "../src/content/x-copilot.ts"), "utf8");
ok(copilot.includes("findHeavyHitters(true, [nicheSearchQuery(q), explorationQuery])"), "manual hunt pairs focused and rotating Top discovery lenses");
ok(copilot.includes("filter((query) => query !== focused)"), "the first rotating Top lens cannot duplicate the always-on focused query");
ok(copilot.includes("viewsObserved: candidate.post.views") && copilot.includes("distributionScore: candidate.signals.distributionScore"), "selection evidence persists the public distribution snapshot");
ok(copilot.includes("Best measured breakout opening now") && copilot.includes("Major account · early"), "reply UI names breakout and major-early opportunities distinctly");
ok(copilot.includes("Massive account keep-list") && copilot.includes("Scan winners"), "the measured massive-account shortlist is visible and directly scannable");
ok(copilot.includes("Massive watchlist") && copilot.includes("addFreshReachWatch") && copilot.includes("Scan pinned"), "the owner-scoped massive-account watchlist is visible, addable, and directly scannable");
ok(copilot.includes("replyLog.authors, 24, 2") && copilot.includes("posts.slice(i * 12, i * 12 + 12)") && copilot.includes("freshChosenIds"), "Fresh Reach preserves 24/two-per-author recall through bounded content scoring before final author diversity");
ok(copilot.includes("checking your saved Fresh Reach accounts directly instead") && copilot.includes("![401, 402, 403, 429].includes(s)"), "query-specific Latest failures can use saved accounts without falling through provider-auth or rate failures");
ok(copilot.includes("Fresh measurement ·") && copilot.includes("API matched") && copilot.includes("accounts kept"), "Find people exposes the Fresh Reach measurement funnel instead of hiding attribution gaps");
ok(copilot.includes('xReplyInsertOn && opp?.source !== "fresh-reach"'), "Fresh Reach remains excluded from the legacy insert helper");

console.log(fail === 0 ? `\n✓ fresh-reach: ${pass} assertions passed` : `\n✗ fresh-reach: ${fail} failed, ${pass} passed`);
process.exit(fail === 0 ? 0 : 1);
