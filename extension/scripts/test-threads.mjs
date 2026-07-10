/**
 * Unit test for the "tend your threads" pure logic (threads.ts). esbuild → data-URL import.
 * Run: node scripts/test-threads.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as esbuild from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "../src/lib/threads.ts"), "utf8");
const js = esbuild.transformSync(src, { loader: "ts", format: "esm" }).code;
const m = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) pass++; else { fail++; console.error("  FAIL:", l); } };
const NOW = 1_700_000_000_000;
const MIN = 60_000, HR = 3_600_000, DAY = 86_400_000;

// ---- age labels ----
ok(m.ageLabel(23 * MIN) === "23m ago", "minutes label");
ok(m.ageLabel(5 * HR) === "5h ago", "hours label");
ok(m.ageLabel(2 * DAY) === "2d ago", "days label");

// ---- only reply/mention are tendable; likes/reposts have nothing to answer ----
{
  const inbound = [
    { at: NOW - 10 * MIN, handle: "alice", kind: "reply", postId: "1" },
    { at: NOW - 10 * MIN, handle: "bob", kind: "like", postId: "2" },
    { at: NOW - 10 * MIN, handle: "carol", kind: "repost", postId: "3" },
    { at: NOW - 10 * MIN, handle: "dave", kind: "mention", postId: "4" },
  ];
  const { rows, total } = m.rankThreads(inbound, [], NOW);
  ok(total === 2 && rows.every((r) => r.kind === "reply" || r.kind === "mention"), "likes/reposts are excluded — only reply+mention are tendable");
}

// ---- freshest-first; a live thread outranks a stale one ----
{
  const inbound = [
    { at: NOW - 2 * DAY, handle: "old", kind: "reply", postId: "1" },
    { at: NOW - 15 * MIN, handle: "fresh", kind: "reply", postId: "2" },
  ];
  const { rows } = m.rankThreads(inbound, [], NOW);
  ok(rows[0].handle === "fresh", "the live thread ranks first (freshness dominates)");
  ok(rows[0].fresh === "live" && rows[1].fresh === "stale", "freshness tiers labeled");
}

// ---- cold events (outside the 3-day window) are dropped ----
{
  const inbound = [{ at: NOW - 5 * DAY, handle: "ancient", kind: "reply", postId: "1" }];
  ok(m.rankThreads(inbound, [], NOW).total === 0, "events older than the tend window are cold — dropped");
}

// ---- reach lift: a bigger replier's thread is a bigger opportunity, all else equal ----
{
  const inbound = [
    { at: NOW - 20 * MIN, handle: "small", kind: "reply", postId: "1", followers: 200 },
    { at: NOW - 20 * MIN, handle: "big", kind: "reply", postId: "2", followers: 500000 },
  ];
  const { rows } = m.rankThreads(inbound, [], NOW);
  ok(rows[0].handle === "big", "same freshness → the bigger replier's thread ranks first");
}

// ---- tended sinks below untended (lossy handle+time inference) ----
{
  const inbound = [
    { at: NOW - 30 * MIN, handle: "answered", kind: "reply", postId: "1" },
    { at: NOW - 90 * MIN, handle: "waiting", kind: "reply", postId: "2" },
  ];
  const sent = [{ author: "answered", at: NOW - 10 * MIN }]; // replied to them AFTER they engaged
  const { rows, untended } = m.rankThreads(inbound, sent, NOW);
  ok(rows[0].handle === "waiting", "an untended (older) thread still outranks a tended fresher one");
  ok(rows.find((r) => r.handle === "answered").tended === true, "the answered thread is flagged tended");
  ok(untended === 1, "untended count excludes the tended one");
}

// a sent reply BEFORE their engagement doesn't count as tending it
{
  const inbound = [{ at: NOW - 30 * MIN, handle: "x", kind: "reply", postId: "1" }];
  const sent = [{ author: "x", at: NOW - 2 * HR }]; // before they engaged → not a response to this
  ok(m.rankThreads(inbound, sent, NOW).rows[0].tended === false, "a reply BEFORE their engagement is not 'tended'");
}

// a sent reply outside the respond window doesn't count
{
  const inbound = [{ at: NOW - 3 * DAY + HR, handle: "y", kind: "reply", postId: "1" }];
  const sent = [{ author: "y", at: NOW - 10 * MIN }]; // >48h after → too far to attribute
  ok(m.rankThreads(inbound, sent, NOW).rows[0].tended === false, "a reply outside the 48h respond window is not attributed as tended");
}

// ---- per-handle cap: one prolific replier can't flood the queue ----
{
  const inbound = [];
  for (let i = 0; i < 5; i++) inbound.push({ at: NOW - (i + 1) * MIN, handle: "chatty", kind: "reply", postId: "c" + i });
  inbound.push({ at: NOW - 10 * MIN, handle: "other", kind: "reply", postId: "o1" });
  const { rows } = m.rankThreads(inbound, [], NOW);
  const chatty = rows.filter((r) => r.handle === "chatty").length;
  ok(chatty <= m.PER_HANDLE_CAP, "one handle is capped so it can't dominate");
  ok(rows.some((r) => r.handle === "other"), "…leaving room for other people's threads");
}

// ---- max cap respected ----
{
  const inbound = [];
  for (let i = 0; i < 20; i++) inbound.push({ at: NOW - (i + 1) * MIN, handle: "h" + i, kind: "reply", postId: "p" + i });
  ok(m.rankThreads(inbound, [], NOW, 8).rows.length === 8, "respects the max row cap");
}

// ---- explicitly MARKED DONE → drops out of the queue AND the count ----
{
  const inbound = [
    { at: NOW - 10 * MIN, handle: "alice", kind: "reply", postId: "a1" },
    { at: NOW - 20 * MIN, handle: "bob", kind: "reply", postId: "b1" },
  ];
  const done = new Set(["a1"]);
  const r = m.rankThreads(inbound, [], NOW, 8, done);
  ok(r.total === 1 && r.untended === 1, "a done event is excluded from total + untended");
  ok(!r.rows.some((x) => x.postId === "a1") && r.rows.some((x) => x.postId === "b1"), "done row is gone; the other remains");
  ok(m.rankThreads(inbound, [], NOW, 8, new Set(["a1", "b1"])).total === 0, "all done → total 0 (panel hides)");
  ok(m.rankThreads(inbound, [], NOW).total === 2, "no done set → nothing excluded (back-compat)");
}

console.log(fail === 0 ? `\n✓ threads: ${pass} assertions passed` : `\n✗ threads: ${fail} failed, ${pass} passed`);
process.exit(fail === 0 ? 0 : 1);
