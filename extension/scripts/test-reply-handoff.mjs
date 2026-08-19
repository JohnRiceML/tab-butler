/** Unit coverage for the copy-only exact-post navigation contract. */
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

const valid = {
  postId: "1228393702244134912",
  author: "@XDevelopers",
};

ok(m.statusIdFromPath("/XDevelopers/status/1228393702244134912") === valid.postId, "extracts a standard status URL");
ok(m.statusIdFromPath("/i/status/1228393702244134912") === valid.postId, "extracts X's authorless status URL");
ok(m.statusIdFromPath("/XDevelopers") === null, "rejects non-status paths");
ok(m.statusIdFromPath("/XDevelopers/status/not-a-number") === null, "rejects malformed status IDs");

ok(m.replyPostUrl(valid) === "https://x.com/XDevelopers/status/1228393702244134912", "opens the exact canonical post");
ok(m.replyPostUrl({ ...valid, author: "not/a/handle" }) === "https://x.com/i/status/1228393702244134912", "falls back safely when the author handle is invalid");

ok(m.replyPostUrl({ ...valid, postId: "abc" }) === "https://x.com/home", "rejects a non-numeric post ID");
ok(m.replyPostUrl({ ...valid, author: "@XDevelopers" }) === "https://x.com/XDevelopers/status/1228393702244134912", "normalizes a leading @ from the author");

console.log(fail === 0 ? `\n✓ reply-handoff: ${pass} assertions passed` : `\n✗ reply-handoff: ${fail} failed, ${pass} passed`);
process.exit(fail === 0 ? 0 : 1);
