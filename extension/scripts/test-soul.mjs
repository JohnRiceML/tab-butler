import assert from "node:assert/strict";
import { transform } from "esbuild";
import fs from "node:fs/promises";

const src = await fs.readFile(new URL("../src/lib/soul.ts", import.meta.url), "utf8");
const { code } = await transform(src, { loader: "ts", format: "esm", target: "es2022" });
const mod = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);

assert.equal(mod.normalizeSoul("  # Me\n\0hello  "), "# Me\nhello");
assert.equal(mod.normalizeSoul("x".repeat(7_000)).length, 6_000);
assert.equal(mod.soulPrompt(""), "");
assert.match(mod.soulPrompt("# Belief\nSpecific beats polished"), /User-authored SOUL\.md/);
assert.match(mod.soulPrompt("# Belief\nSpecific beats polished"), /never invent a personal detail/i);
const client = await fs.readFile(new URL("../src/lib/claude-client.ts", import.meta.url), "utf8");
const worker = await fs.readFile(new URL("../src/background/service-worker.ts", import.meta.url), "utf8");
assert.ok((client.match(/soulPrompt\(soulMd\)/g) || []).length >= 3, "reply, idea generation, and rewrite all include SOUL.md");
assert.ok((worker.match(/CONFIG\.X_SOUL_KEY/g) || []).length >= 4, "service worker reads SOUL.md for explicit creative actions");
assert.doesNotMatch(worker.slice(worker.indexOf('case "DRAFT_DM"'), worker.indexOf('case "GET_FAVICONS"')), /X_SOUL_KEY/, "DM drafting intentionally does not receive SOUL.md");
console.log("\n✓ soul: 8 assertions passed");
