/** Deterministic tests for the local LinkedIn comment thesis. */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "../src/lib/linkedin-strategy.ts"), "utf8");
const js = esbuild.transformSync(source, { loader: "ts", format: "esm" }).code;
const m = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));

let pass = 0, fail = 0;
const ok = (condition, label) => condition ? pass += 1 : (fail += 1, console.error("  FAIL:", label));

const empty = m.normalizeLinkedInStrategy(undefined);
ok(empty.version === 1 && empty.relationship.sameAuthorCooldownHours === 72, "empty input gets conservative v1 defaults");
ok(empty.relationship.maxSameAuthor7d === 2 && empty.relationship.maxSameAuthor30d === 5, "default author caps are bounded");
ok(!m.linkedInStrategyConfigured(empty), "empty default is not presented as configured");

const strategy = m.normalizeLinkedInStrategy({
  vertical: "  AI   SaaS for B2B teams  ",
  reputationThesis: "Practical builder judgment",
  targetAudiences: "AI founders\nProduct leaders\nAI FOUNDERS\n;B2B operators",
  targetContexts: ["Postmortems", "Pricing experiments"],
  contributionLanes: "Implementation detail;Boundary condition",
  avoidTopics: "Politics\nMedical advice",
  relationship: { sameAuthorCooldownHours: 1, maxSameAuthor7d: 99, maxSameAuthor30d: 0, oneActivePostPerAuthor: false },
});
ok(strategy.vertical === "AI SaaS for B2B teams", "strategy text is normalized");
ok(strategy.targetAudiences.length === 3 && strategy.targetAudiences[0] === "AI founders", "newline lists dedupe case-insensitively");
ok(strategy.relationship.sameAuthorCooldownHours === 24, "cooldown clamps to safe minimum");
ok(strategy.relationship.maxSameAuthor7d === 7 && strategy.relationship.maxSameAuthor30d === 1, "author caps clamp to supported range");
ok(strategy.relationship.oneActivePostPerAuthor === false, "explicit one-author override is preserved");
ok(m.linkedInStrategyConfigured(strategy), "meaningful strategy is configured");

const prompt = m.linkedInStrategyPrompt(strategy, "Shared focus");
ok(prompt.includes("Shared conversation focus: Shared focus"), "prompt retains shared focus as fallback context");
ok(prompt.includes("People / organizations worth meeting: AI founders; Product leaders; B2B operators"), "prompt labels target audiences explicitly");
ok(prompt.includes("Exclusions: Politics; Medical advice"), "prompt labels user exclusions explicitly");
ok(!prompt.includes("sameAuthorCooldownHours"), "local relationship mechanics are not sent to the model");

const overlong = m.normalizeLinkedInStrategy({
  vertical: "x".repeat(500),
  targetAudiences: Array.from({ length: 20 }, (_, i) => `${i}-${"a".repeat(100)}`),
});
ok(overlong.vertical.length === 120, "arena is length bounded");
ok(overlong.targetAudiences.length === 8 && overlong.targetAudiences.every((item) => item.length <= 80), "target list count and rows are bounded");

console.log(fail === 0 ? `\n✓ LinkedIn strategy: ${pass} assertions passed` : `\n✗ LinkedIn strategy: ${fail} failed, ${pass} passed`);
process.exit(fail === 0 ? 0 : 1);

