import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
const here = dirname(fileURLToPath(import.meta.url));
const built = await esbuild.build({ entryPoints: [join(here, "../src/lib/x-policy.ts")], bundle: true, format: "esm", write: false });
const policy = await import("data:text/javascript;base64," + Buffer.from(built.outputFiles[0].text).toString("base64"));
const { canUseXBroker, isSupportedXUrl, sanitizeXScorePayload, sanitizeXDraftPayload, X_PAYLOAD_LIMITS: limits } = policy;
for (const url of ["https://x.com/home", "https://twitter.com/person/status/123", "https://x.com/search?q=builders"]) assert(isSupportedXUrl(url));
for (const url of [null, "http://x.com/home", "https://x.com.evil.test/home", "https://x.com@evil.test/home", "https://www.x.com/home", "https://user@x.com/home", "https://x.com:444/home", " https://x.com/home"]) assert(!isSupportedXUrl(url));
assert(canUseXBroker("v1", undefined, "test-key"));
assert(canUseXBroker("v1", true, "test-key", false));
for (const args of [["v0", true, "key"], ["v1", false, "key"], ["v1", null, "key"], ["v1", 1, "key"], ["v1", true, " "], ["v1", true, "key", true]]) assert(!canUseXBroker(...args));
const score = { type: "SCORE_POSTS", posts: Array.from({ length: 12 }, (_, i) => ({ i: i + 12, author: "builder", text: "A concrete post", context: "Quoted detail" })) };
assert.deepEqual(sanitizeXScorePayload(score), score, "global discovery indices survive bounded chunk validation");
for (const bad of [null, { ...score, platform: "linkedin" }, { ...score, extra: true }, { ...score, posts: [] }, { ...score, posts: [...score.posts, { i: 24, author: "builder", text: "extra" }] }, { ...score, posts: [score.posts[0], score.posts[0]] }, { ...score, posts: [{ ...score.posts[0], i: -1 }] }, { ...score, posts: [{ ...score.posts[0], i: 1.5 }] }, { ...score, posts: [{ ...score.posts[0], text: "x".repeat(limits.text + 1) }] }, { ...score, posts: [{ ...score.posts[0], text: "bad\u0000text" }] }, { ...score, posts: [{ ...score.posts[0], steer: "cross-shape" }] }]) assert.equal(sanitizeXScorePayload(bad), null);
const draft = { type: "DRAFT_REPLY", author: "builder", text: "A concrete post", angle: "value", style: "community-spark", category: "value", product: "Product one\nProduct two", opportunityLine: "Current observed facts", steer: "Make this warmer" };
assert.deepEqual(sanitizeXDraftPayload(draft), draft);
for (const key of Object.keys(limits).filter((key) => key !== "meta")) {
  assert.equal(sanitizeXDraftPayload({ ...draft, [key]: "x".repeat(limits[key] + 1) }), null, `${key} is bounded`);
  assert.equal(sanitizeXDraftPayload({ ...draft, [key]: {} }), null, `${key} rejects malformed types`);
}
for (const bad of [{ ...draft, platform: "linkedin" }, { ...draft, posts: [] }, { ...draft, angle: "invented" }, { ...draft, style: "unbounded-instructions" }, { ...draft, author: " " }]) assert.equal(sanitizeXDraftPayload(bad), null);
assert.equal(sanitizeXDraftPayload({ ...draft, steer: "  " }).steer, undefined);
assert.equal(sanitizeXDraftPayload({ ...draft, product: "" }).product, "", "explicit no-product choice survives broker fallback");
assert.equal(sanitizeXDraftPayload({ ...draft, style: undefined }).style, undefined, "disabled style remains disabled");
assert.equal(sanitizeXDraftPayload({ ...draft, platform: "x" }).platform, "x");
console.log("✓ X broker policy: sender origins, consent/pause gates, real global indices, bounded score/draft inputs passed");
