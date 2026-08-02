/**
 * Unit test for reply-reputation hygiene (reply-hygiene.ts). Transpiled with
 * esbuild + imported from a data URL. Run: node scripts/test-hygiene.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as esbuild from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "../src/lib/reply-hygiene.ts"), "utf8");
const contentSrc = readFileSync(join(here, "../src/content/x-copilot.ts"), "utf8");
const popupSrc = readFileSync(join(here, "../src/popup/popup.ts"), "utf8");
const js = esbuild.transformSync(src, { loader: "ts", format: "esm" }).code;
const mod = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));
const { normalizeReply, jaccard, isDuplicateReply, pickReplyNudge, reputationStatus, replyPaceLaneWeight, replyPaceRecencyWeight, replyPaceStatus, replyQualityWarning } = mod;

let pass = 0, fail = 0;
const eq = (a, b, l) => { if (JSON.stringify(a) === JSON.stringify(b)) pass++; else { fail++; console.error("  FAIL:", l, "got", JSON.stringify(a), "want", JSON.stringify(b)); } };
const ok = (c, l) => { if (c) pass++; else { fail++; console.error("  FAIL:", l); } };

// normalizeReply: caps/punctuation/links collapse so trivial edits compare equal
eq(normalizeReply("Great take!!!"), "great take", "strip punctuation + case");
eq(normalizeReply("Ship daily — measure weekly."), "ship daily measure weekly", "em dash + period");
eq(normalizeReply("see https://t.co/abc now"), "see now", "strip link");
eq(normalizeReply("  multiple   spaces  "), "multiple spaces", "collapse whitespace");

// jaccard
eq(jaccard("ship daily measure", "ship daily measure"), 1, "identical -> 1");
ok(jaccard("ship daily and measure what sticks", "ship daily and measure what works") >= 0.6, "one-word edit stays high");
eq(jaccard("totally different thing", "ship daily measure"), 0, "disjoint -> 0");
eq(jaccard("", "ship"), 0, "empty -> 0");

// isDuplicateReply: exact + near-duplicate (lightly reworded copy-paste) trip; distinct doesn't
const recent = ["ship daily and measure what sticks", "this is the part everyone misses about distribution"];
ok(isDuplicateReply(normalizeReply("Ship daily and measure what sticks!"), recent) === true, "exact (post-normalize) dup");
ok(isDuplicateReply(normalizeReply("ship daily and measure what works"), recent) === true, "reworded copy-paste dup (one-word swap, >=0.7)");
ok(isDuplicateReply(normalizeReply("congrats on the launch big milestone"), ["congrats on the launch looks great"]) === false, "genuinely different short reply (~0.5) not flagged");
ok(isDuplicateReply(normalizeReply("totally unrelated fresh reply here"), recent) === false, "distinct reply not flagged");
ok(isDuplicateReply("", recent) === false, "empty not flagged");

// pickReplyNudge priority: duplicate > hard volume > soft volume > repeat author > none
ok(/copy-pasted/.test(pickReplyNudge({ duplicate: true, repliesThisHour: 12, repeatAuthor: "x" })), "duplicate wins");
ok(/adaptive guard/.test(pickReplyNudge({ duplicate: false, repliesThisHour: 12, pacePressure: 12, repeatAuthor: "x" })), "hard adaptive pressure at 12");
ok(/adaptive guard/.test(pickReplyNudge({ duplicate: false, repliesThisHour: 15, pacePressure: 13.2, repeatAuthor: null })), "hard pressure above 12");
ok(/slow down/.test(pickReplyNudge({ duplicate: false, repliesThisHour: 9, pacePressure: 8.4, repeatAuthor: null })), "soft nudge while entering the adaptive caution band");
eq(pickReplyNudge({ duplicate: false, repliesThisHour: 11, pacePressure: 10.5, repeatAuthor: null }), null, "middle caution band stays quiet (no repeated nag)");
ok(/@bob/.test(pickReplyNudge({ duplicate: false, repliesThisHour: 5, repeatAuthor: "bob" })), "repeat author when calm");
eq(pickReplyNudge({ duplicate: false, repliesThisHour: 5, repeatAuthor: null }), null, "no nudge when all clear");

// reputationStatus: adaptive pressure boundaries are more lenient than the old rigid 6/10 count.
eq(reputationStatus(0).level, "healthy", "zero pressure is healthy");
eq(reputationStatus(7.9).level, "healthy", "below 8 pressure is healthy");
eq(reputationStatus(8).level, "caution", "8 pressure starts caution");
eq(reputationStatus(11.9).level, "caution", "below 12 pressure stays caution");
eq(reputationStatus(12).level, "easeoff", "12 pressure starts easeoff");
eq(reputationStatus(15).level, "easeoff", "15 pressure is easeoff");

// Dynamic pace: warm conversations weigh less, old activity fades, and reset changes only baseline.
const NOW = 2_000_000_000_000, MIN = 60_000;
eq(replyPaceLaneWeight("inbound"), 0.7, "warm inbound has the most lenient nonzero weight");
eq(replyPaceLaneWeight("continue"), 0.85, "ongoing conversations have reduced weight");
eq(replyPaceLaneWeight("community"), 0.95, "community replies are slightly reduced");
eq(replyPaceLaneWeight("discovery"), 1, "cold discovery has full weight");
eq(replyPaceLaneWeight(undefined), 1, "legacy records stay conservative");
eq(replyPaceRecencyWeight(15 * MIN), 1, "activity is full weight through 15 minutes");
eq(replyPaceRecencyWeight(37.5 * MIN), 0.5, "activity decays smoothly halfway through recovery");
eq(replyPaceRecencyWeight(60 * MIN), 0, "activity expires at one hour");
const coldBurst = Array.from({ length: 12 }, (_, i) => ({ at: NOW - i * MIN, lane: "discovery" }));
const hot = replyPaceStatus(coldBurst, NOW);
eq(hot.level, "easeoff", "12 recent cold discoveries reach adaptive easeoff");
eq(hot.pressure, 12, "new cold discovery replies carry full pressure");
const warmBurst = replyPaceStatus(coldBurst.map((event) => ({ ...event, lane: "inbound" })), NOW);
eq(warmBurst.level, "caution", "12 warm inbound replies are caution, not a hard pause");
eq(warmBurst.pressure, 8.4, "warm inbound replies retain nonzero 0.7 weight");
const aged = replyPaceStatus(coldBurst.map((event, i) => ({ ...event, at: NOW - (40 + i) * MIN })), NOW);
ok(aged.pressure < 6 && aged.level === "healthy", "activity recovers gradually before the rigid one-hour cliff");
const resetAt = NOW - 2 * MIN;
const reset = replyPaceStatus(coldBurst, NOW, resetAt);
eq(reset.repliesThisHour, 12, "manual reset preserves the visible rolling-hour history");
eq(reset.countedReplies, 2, "manual reset excludes only events at or before the new local baseline");
eq(reset.pressure, 2, "post-reset activity still builds pressure normally");
eq(replyPaceStatus(coldBurst, NOW, NOW).pressure, 0, "reset-now clears local pressure without deleting events");
const expiredReset = replyPaceStatus(coldBurst, NOW, NOW - 61 * MIN);
eq(expiredReset.pressure, 12, "a reset baseline expires after the pace window");
eq(expiredReset.resetAt, undefined, "expired reset state no longer lingers in the UI");
eq(replyPaceStatus([{ at: NOW + MIN, lane: "discovery" }], NOW).pressure, 0, "future timestamps cannot fabricate pressure");

// Integration invariant: both reset surfaces may write only the separate reset timestamp. They
// must never clear or rewrite the reply ledger, because history/dedup/outcomes remain truthful.
const contentReset = contentSrc.match(/function resetReplyPace\(\): void \{[\s\S]*?\n\}/)?.[0] || "";
ok(contentReset.includes("CONFIG.X_PACE_RESET_KEY"), "dock reset writes the separate pace-baseline key");
ok(!contentReset.includes("CONFIG.X_REPLY_LOG_KEY") && !contentReset.includes("replyLog.times"), "dock reset does not mutate the reply ledger");
const popupReset = popupSrc.match(/case "reset-pace": \{[\s\S]*?break;/)?.[0] || "";
ok(popupReset.includes("CONFIG.X_PACE_RESET_KEY"), "popup reset writes the separate pace-baseline key");
ok(!popupReset.includes("CONFIG.X_REPLY_LOG_KEY"), "popup reset does not rewrite the reply ledger");
ok((contentSrc.match(/currentReplyPace\(/g) || []).length >= 8, "content-script gates share the adaptive pace source");

// replyQualityWarning: fires on empty praise / too-short / emoji-only, clears for a real add-on
ok(replyQualityWarning("🔥🔥") !== null, "emoji-only reply is flagged");
ok(replyQualityWarning("great post!") !== null, "empty praise is flagged");
ok(replyQualityWarning("so true") !== null, "short agreement is flagged");
ok(replyQualityWarning("love this") !== null, "love-this is flagged");
eq(replyQualityWarning("the part about pricing for churn-prone plans is exactly what killed our cheap tier last year"), null, "a specific, substantive reply passes clean");
eq(replyQualityWarning("counterpoint: outbound still works if you send 40 not 4, we closed 2 deals that way"), null, "a real counterpoint passes clean");

console.log(fail === 0 ? `\n✓ reply hygiene: ${pass} assertions passed` : `\n✗ reply hygiene: ${fail} failed, ${pass} passed`);
process.exit(fail === 0 ? 0 : 1);
