/** Unit and counterfactual tests for the reply recommendation policy. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as esbuild from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "../src/lib/reply-recommendation.ts"), "utf8");
const js = esbuild.transformSync(src, { loader: "ts", format: "esm" }).code;
const m = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));

let pass = 0, fail = 0;
const ok = (condition, label) => { if (condition) pass++; else { fail++; console.error("  FAIL:", label); } };
const NOW = 1_700_000_000_000;
const base = { modelFit: 0.82, postedAt: NOW - 8 * 60_000, replies: 3, myFollowers: 500, reachCeiling: 10 };

const reachable = m.recommendReply({ ...base, authorFollowers: 4_000 }, NOW);
const mega = m.recommendReply({ ...base, authorFollowers: 500_000 }, NOW);
ok(reachable.priority > mega.priority, "reachable 8× author outranks a 1000× mega for a small account");
ok(reachable.lane === "discovery" && reachable.reasons.some((r) => r.includes("reachable")), "cold reachable post is explained as discovery");

const knownOpen = m.recommendReply({ ...base, replies: 2, authorFollowers: 4_000 }, NOW);
const unknownReplies = m.recommendReply({ ...base, replies: undefined, authorFollowers: 4_000 }, NOW);
ok(knownOpen.priority > unknownReplies.priority, "missing reply count does not receive the best competition value");
ok(unknownReplies.cautions.includes("Reply count unavailable"), "missing reply count is disclosed");

const crowded = m.recommendReply({ ...base, replies: 80, authorFollowers: 4_000 }, NOW);
ok(knownOpen.priority > crowded.priority, "an open thread outranks a crowded one, all else equal");
ok(crowded.cautions.some((c) => c.includes("Crowded")), "crowding is explained as a heuristic caution");

const warm = m.recommendReply({ ...base, authorFollowers: 450, connection: { completed: 3, activeWeeks: 3, lastAt: NOW - 2 * 86_400_000, established: true }, history: { replies: 5, backs: 3 } }, NOW);
const coldSameSize = m.recommendReply({ ...base, authorFollowers: 450 }, NOW);
ok(warm.priority > coldSameSize.priority && warm.lane === "continue", "proven two-way connection becomes a first-class lane");
ok(warm.reasons[0].includes("Proven two-way"), "exact connection evidence is visible in the explanation");

const irrelevantWarm = m.recommendReply({ ...base, modelFit: 0.2, authorFollowers: 450, connection: { completed: 5, activeWeeks: 4, lastAt: NOW, established: true }, history: { replies: 6, backs: 4 } }, NOW);
ok(irrelevantWarm.priority < warm.priority && irrelevantWarm.priority < 0.5, "relationship evidence cannot rescue a poor-fit post");

const peer = m.recommendReply({ ...base, authorFollowers: 1_500, peerTier: 2, authorFollowing: 900 }, NOW);
ok(peer.lane === "community" && peer.reasons.some((r) => r.includes("peer")), "relevant reciprocal peer is a community opportunity");

const oneLuckyBack = m.responseLikelihood({ ...base, history: { replies: 1, backs: 1 } });
const provenBacks = m.responseLikelihood({ ...base, history: { replies: 6, backs: 4 } });
ok(provenBacks > oneLuckyBack && oneLuckyBack < 0.65, "one reply-back cannot crown an author; repeated evidence can strengthen them");

const fresh = m.recommendReply({ ...base, authorFollowers: 4_000 }, NOW);
const stale = m.recommendReply({ ...base, postedAt: NOW - 26 * 60 * 60_000, authorFollowers: 4_000 }, NOW);
ok(fresh.priority > stale.priority, "freshness remains a decisive controllable lever");

const varied = m.recommendReply({ ...base, authorFollowers: 4_000, recentAuthorReplies: 0 }, NOW);
const repeated = m.recommendReply({ ...base, authorFollowers: 4_000, recentAuthorReplies: 5 }, NOW);
ok(varied.priority > repeated.priority && repeated.cautions.some((c) => c.includes("this week")), "repeated-author concentration is gently diversified and explained");

const repliedTwoHoursAgo = m.recommendReply({ ...base, authorHandle: "alice", authorFollowers: 4_000, recentAuthorReplies: 1, lastAuthorReplyAt: NOW - 2 * 60 * 60_000 }, NOW);
ok(varied.priority > repliedTwoHoursAgo.priority && repliedTwoHoursAgo.discovery < varied.discovery, "one recent same-author reply lowers the priority and every lane before drafting");
ok(repliedTwoHoursAgo.authorRepeat?.label === "2h ago" && repliedTwoHoursAgo.authorRepeat?.severity === "high", "same-author recency is structured for prominent UI callouts");
ok(repliedTwoHoursAgo.cautions[0].includes("@alice") && repliedTwoHoursAgo.cautions[0].includes("lowers every score"), "repeat-author caution is first and explains its score effect");

const repliedFourDaysAgo = m.recommendReply({ ...base, authorHandle: "alice", authorFollowers: 4_000, recentAuthorReplies: 1, lastAuthorReplyAt: NOW - 4 * 24 * 60 * 60_000 }, NOW);
ok(!repliedFourDaysAgo.authorRepeat && repliedFourDaysAgo.priority === varied.priority, "one older reply does not permanently suppress an author");

const ownPostComment = m.recommendReply({ ...base, modelFit: 0.62, authorHandle: "alice", authorFollowers: 450, isReplyToOwnPost: true }, NOW);
ok(ownPostComment.lane === "inbound" && ownPostComment.laneLabel === "Comment on your post", "a direct comment on the user's post gets a dedicated warm-inbound lane");
ok(ownPostComment.priority > coldSameSize.priority && ownPostComment.reasons[0] === "They commented on your post", "warm inbound outranks an otherwise cold same-size opportunity and explains why");

const repeatOwnPostComment = m.recommendReply({ ...base, modelFit: 0.62, authorHandle: "alice", authorFollowers: 450, isReplyToOwnPost: true, recentAuthorReplies: 1, lastAuthorReplyAt: NOW - 2 * 60 * 60_000 }, NOW);
ok(repeatOwnPostComment.authorRepeat && repeatOwnPostComment.priority > repliedTwoHoursAgo.priority, "a recent same-author reply stays visible but does not bury a direct inbound comment");
ok(repeatOwnPostComment.cautions[0].includes("direct comments stay important"), "repeat-author caution accurately explains the warm-conversation exception");

ok(m.threadRoom(undefined) < m.threadRoom(2), "unknown competition is neutral-ish rather than best");
ok(m.reachableAudience(undefined, 500, 10) > 0 && m.reachableAudience(undefined, 500, 10) < 1, "unknown audience stays usable but cannot look ideal");

console.log(fail === 0 ? `\n✓ reply recommendation: ${pass} assertions passed` : `\n✗ reply recommendation: ${fail} failed, ${pass} passed`);
process.exit(fail === 0 ? 0 : 1);
