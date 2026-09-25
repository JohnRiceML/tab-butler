/**
 * Unit test for the draft-context assembler (draft-context.ts). esbuild → data-URL import.
 * Run: node scripts/test-draft-context.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as esbuild from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "../src/lib/draft-context.ts"), "utf8");
const copilot = readFileSync(join(here, "../src/content/x-copilot.ts"), "utf8");
const config = readFileSync(join(here, "../src/lib/config.ts"), "utf8");
const worker = readFileSync(join(here, "../src/background/service-worker.ts"), "utf8");
const client = readFileSync(join(here, "../src/lib/claude-client.ts"), "utf8");
const js = esbuild.transformSync(src, { loader: "ts", format: "esm" }).code;
const m = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) pass++; else { fail++; console.error("  FAIL:", l); } };

ok(m.buildDraftContext({}) === "", "nothing known → empty string (the bare path stays bare)");
ok(m.buildDraftContext({ niche: "  " }) === "", "whitespace-only fields don't fabricate a block");

const full = m.buildDraftContext({ niche: "AI SaaS, indie founders", reason: "specific build question", category: "value", authorLine: "@dev · ~4.2K followers · a two-way peer in the user's niche" });
ok(full.includes("grounding only"), "the block tells the model it's grounding, not content to parrot");
ok(full.includes("AI SaaS, indie founders") && full.includes("~4.2K followers") && full.includes("specific build question — angle: value"), "all known fields assemble into labeled lines");
ok(full.startsWith("\n\n"), "block is append-ready for the user message");

const partial = m.buildDraftContext({ reason: "sharp take available" });
ok(partial.includes("sharp take available") && !partial.includes("niche") && !partial.includes("author"), "partial context renders only what's known");

const ownThread = m.buildDraftContext({ threadLine: "This is a direct comment on one of the user's own posts." });
ok(ownThread.includes("Conversation relationship") && ownThread.includes("direct comment"), "comments on the user's post become explicit drafter relationship context");

const freshReach = m.buildDraftContext({ opportunityLine: "The post is fresh, the larger account is still reachable, and the thread is not crowded." });
ok(freshReach.includes("Observed opportunity context") && freshReach.includes("not crowded"), "fresh-reach evidence is labeled as observed context, not a promise");

const coached = m.buildDraftContext({ anchor: "cut onboarding from eight screens", replyBrief: "Explain which commitment can safely move after activation" });
ok(coached.includes("Exact post detail to engage") && coached.includes("Useful reply move") && coached.includes("commitment can safely move"), "structured scorer coaching grounds the draft in an exact anchor and useful move");

const linkedIn = m.buildDraftContext({ action: "comment", reason: "specific operator discussion", category: "value", replyBrief: "Add the implementation caveat" });
ok(linkedIn.includes("Useful comment move") && linkedIn.includes("comment-worthy") && linkedIn.includes("write the comment to the post"), "LinkedIn context uses comment language without changing the default X reply contract");
const moved = m.buildDraftContext({ action: "comment", contributionMove: "counterpoint" });
ok(moved.includes("Model-suggested comment move") && moved.includes("guidance, not evidence"), "LinkedIn contribution move survives as guidance without becoming biographical evidence");

ok(m.buildDraftContext({ measuredLine: "your ask-angle replies earned 1.4x your average (n=9)" }).includes("Measured on this user's own past replies"), "the stage-2 measured line is labeled as measured");
ok(copilot.includes("replyStyleControl") && copilot.includes("aria-pressed") && copilot.includes("REPLY_STYLES[0]"), "the draft panel exposes one accessible Community Spark delivery-style component");
ok(config.includes('X_COMMUNITY_SPARK_KEY: "xCommunitySparkEnabled"') && copilot.includes("communitySparkOn = (await getLocal(CONFIG.X_COMMUNITY_SPARK_KEY)) !== false"), "Community Spark defaults on when no preference has been saved");
ok(copilot.includes("safeSet({ [CONFIG.X_COMMUNITY_SPARK_KEY]: communitySparkOn })") && copilot.includes("changes[CONFIG.X_COMMUNITY_SPARK_KEY].newValue !== false"), "the Community Spark toggle persists and synchronizes its explicit on/off state");
ok((copilot.match(/style: preferredReplyStyle\(\)/g) || []).length >= 3, "feed, dock, and target-account drafts all honor the saved Community Spark preference");
ok(copilot.includes("context, angle, style,") && worker.includes("payload.steer, payload.style, extra, soul") && client.includes("${angleLine}${styleLine}${steerLine}"), "the selected reply style reaches the real Sonnet draft request after angle and grounding context");
ok(client.includes("styleDef ? 120 : 400"), "Community Spark uses a smaller bounded Sonnet output budget than standard replies");
ok(copilot.includes("if (requestSeq !== draftRequestSeq) return"), "a slower prior draft request cannot repaint over a newer component choice");
ok(copilot.includes("draftStyle?: ReplyStyleId") && copilot.includes("draftStyle,"), "confirmed replies retain the optional style for future settled-outcome comparison");

console.log(fail === 0 ? `\n✓ draft-context: ${pass} assertions passed` : `\n✗ draft-context: ${fail} failed, ${pass} passed`);
process.exit(fail === 0 ? 0 : 1);
