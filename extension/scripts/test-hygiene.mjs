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
const js = esbuild.transformSync(src, { loader: "ts", format: "esm" }).code;
const mod = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));
const { normalizeReply, jaccard, isDuplicateReply, pickReplyNudge } = mod;

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
ok(/copy-pasted/.test(pickReplyNudge({ duplicate: true, repliesThisHour: 35, repeatAuthor: "x" })), "duplicate wins");
ok(/automated/.test(pickReplyNudge({ duplicate: false, repliesThisHour: 30, repeatAuthor: "x" })), "hard volume at 30");
ok(/automated/.test(pickReplyNudge({ duplicate: false, repliesThisHour: 41, repeatAuthor: null })), "hard volume above 30");
ok(/pace yourself/.test(pickReplyNudge({ duplicate: false, repliesThisHour: 21, repeatAuthor: null })), "soft nudge at 21");
eq(pickReplyNudge({ duplicate: false, repliesThisHour: 25, repeatAuthor: null }), null, "22-29 stays quiet (no nag)");
ok(/@bob/.test(pickReplyNudge({ duplicate: false, repliesThisHour: 5, repeatAuthor: "bob" })), "repeat author when calm");
eq(pickReplyNudge({ duplicate: false, repliesThisHour: 5, repeatAuthor: null }), null, "no nudge when all clear");

console.log(fail === 0 ? `\n✓ reply hygiene: ${pass} assertions passed` : `\n✗ reply hygiene: ${fail} failed, ${pass} passed`);
process.exit(fail === 0 ? 0 : 1);
