/** Unit coverage for the exact-post reply handoff contract. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as esbuild from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "../src/lib/reply-handoff.ts"), "utf8");
const js = esbuild.transformSync(src, { loader: "ts", format: "esm" }).code;
const m = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));

let pass = 0, fail = 0;
const ok = (condition, label) => { if (condition) pass++; else { fail++; console.error("  FAIL:", label); } };

const NOW = 1_900_000_000_000;
const valid = {
  version: 1,
  token: "handoff-1",
  postId: "1228393702244134912",
  author: "@XDevelopers",
  text: "The invariant is the interesting part here.",
  createdAt: NOW - 1_000,
  sourceTabId: 42,
};

ok(m.statusIdFromPath("/XDevelopers/status/1228393702244134912") === valid.postId, "extracts a standard status URL");
ok(m.statusIdFromPath("/i/status/1228393702244134912") === valid.postId, "extracts X's authorless status URL");
ok(m.statusIdFromPath("/XDevelopers") === null, "rejects non-status paths");
ok(m.statusIdFromPath("/XDevelopers/status/not-a-number") === null, "rejects malformed status IDs");

ok(m.replyPostUrl(valid) === "https://x.com/XDevelopers/status/1228393702244134912", "opens the exact canonical post");
ok(m.replyPostUrl({ ...valid, author: "not/a/handle" }) === "https://x.com/i/status/1228393702244134912", "falls back safely when the author handle is invalid");

const normalized = m.validReplyHandoff(valid, NOW);
ok(normalized?.author === "XDevelopers", "normalizes a leading @ from the author");
ok(normalized?.sourceTabId === 42, "keeps the source tab for status reporting");
ok(m.handoffMatchesPath(normalized, "/XDevelopers/status/1228393702244134912"), "matches only the intended status path");
ok(!m.handoffMatchesPath(normalized, "/someone/status/999"), "does not target another post");

ok(m.validReplyHandoff({ ...valid, createdAt: NOW - m.REPLY_HANDOFF_TTL_MS - 1 }, NOW) === null, "expires stale drafts");
ok(m.validReplyHandoff({ ...valid, createdAt: NOW + 30_001 }, NOW) === null, "rejects implausibly future drafts");
ok(m.validReplyHandoff({ ...valid, postId: "abc" }, NOW) === null, "rejects non-numeric post IDs");
ok(m.validReplyHandoff({ ...valid, text: "  " }, NOW) === null, "rejects empty drafts");
ok(m.validReplyHandoff({ ...valid, token: "" }, NOW) === null, "requires a one-shot token");
ok(m.isReplyBubblePath("M1.751 10c0-4.42 3.584-8 8.005-8h4.366"), "recognizes X's current comment-bubble path");
ok(!m.isReplyBubblePath("M12 2a10 10 0 1 0 0 20"), "does not confuse an unrelated icon with Reply");

console.log(fail === 0 ? `\n✓ reply-handoff: ${pass} assertions passed` : `\n✗ reply-handoff: ${fail} failed, ${pass} passed`);
process.exit(fail === 0 ? 0 : 1);
