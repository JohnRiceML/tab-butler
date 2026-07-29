import assert from "node:assert/strict";
import { transform } from "esbuild";
import fs from "node:fs/promises";

const src = await fs.readFile(new URL("../src/lib/daily-goals.ts", import.meta.url), "utf8");
const { code } = await transform(src, { loader: "ts", format: "esm", target: "es2022" });
const mod = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);

assert.deepEqual(mod.normalizeDailyGoals(undefined), { replies: 10, posts: 1, dms: 2 });
assert.deepEqual(mod.normalizeDailyGoals({ replies: 200, posts: 3, dms: 3 }), { replies: 10, posts: 1, dms: 2 });
assert.deepEqual(mod.normalizeDailyGoals({ replies: 12.4, posts: -2, dms: 99 }), { replies: 12, posts: 0, dms: 5 });
assert.deepEqual(mod.normalizeDailyGoals({ replies: 99, posts: 9, dms: 9 }), { replies: 30, posts: 5, dms: 5 });
assert.equal(mod.dailyGoalPercent(3, 10), 30);
assert.equal(mod.dailyGoalPercent(12, 10), 100);
assert.equal(mod.dailyGoalPercent(2, 0), 0);
console.log("\n✓ daily goals: 7 assertions passed");
