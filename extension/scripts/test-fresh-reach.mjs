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
ok(m.pickFreshReachAccounts([
  { handle: "proven", followers: 6_000, checks: 4, strongOpenings: 3 },
  { handle: "unknown", followers: 10_000, engagementRate: 0.01 },
], MY, NOW, 1)[0]?.account.handle === "proven", "accounts that repeatedly yield strong openings earn a learned scan lane");

const midBand = m.freshReachCandidate(post({ followers: 8_000 }), MY, NOW);
const edgeBand = m.freshReachCandidate(post({ followers: 17_500 }), MY, NOW);
ok(midBand.opportunity > edgeBand.opportunity, "mid-band reach beats the largest eligible account when timing and room are equal");
const massivePost = m.freshReachCandidate(post({ followers: 2_000_000 }), MY, NOW);
ok(massivePost && massivePost.opportunity < midBand.opportunity, "massive-account eligibility carries a visibility-gap penalty instead of an automatic size reward");

console.log(fail === 0 ? `\n✓ fresh-reach: ${pass} assertions passed` : `\n✗ fresh-reach: ${fail} failed, ${pass} passed`);
process.exit(fail === 0 ? 0 : 1);
