/**
 * Opt-in live quality gate for the shipping LinkedIn prompt/assembly contract.
 * It generates three comments per fixture, runs the real deterministic diagnostics,
 * and asks a blinded Sonnet judge to grade specificity, value, voice, grounding,
 * naturalness, and restraint. It is never part of the free default test suite.
 *
 *   ANTHROPIC_API_KEY=sk-... node scripts/eval-linkedin-comments-live.mjs --live
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { LINKEDIN_COMMENT_LIVE_FIXTURES as FIXTURES } from "./linkedin-comment-fixtures.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const LIVE = process.argv.includes("--live");
const KEY = process.env.ANTHROPIC_API_KEY;
if (!LIVE || !KEY) {
  console.log(`LinkedIn comment live eval (opt-in; generates ${FIXTURES.length * 3} drafts plus judge calls).
  Run: ANTHROPIC_API_KEY=sk-... node scripts/eval-linkedin-comments-live.mjs --live
  No --live or no key -> no-op, so the default verification gate stays free.`);
  process.exit(0);
}

const load = async (relative) => {
  const source = readFileSync(join(here, relative), "utf8");
  const js = esbuild.transformSync(source, { loader: "ts", format: "esm" }).code;
  return import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));
};
const { LINKEDIN_DRAFT_SYSTEM } = await load("../src/lib/prompts.ts");
const { buildDraftContext } = await load("../src/lib/draft-context.ts");
const quality = await load("../src/lib/linkedin-comment-quality.ts");
const { cleanLinkedInComment } = await load("../src/lib/text-clean.ts");

async function anthropic(model, system, user, maxTokens) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model, max_tokens: maxTokens, thinking: { type: "disabled" }, system, messages: [{ role: "user", content: user }] }),
  });
  if (!response.ok) throw new Error(`Anthropic ${response.status}: ${(await response.text()).slice(0, 180)}`);
  const data = await response.json();
  return (data.content || []).filter((block) => block.type === "text").map((block) => block.text).join("");
}

const parseJson = (text) => JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));

function draftUser(fixture) {
  const context = fixture.post.context ? `\n\nUNTRUSTED RESHARED/PARENT CONTEXT:\n${fixture.post.context}` : "";
  const extra = buildDraftContext({
    action: "comment",
    niche: fixture.focus,
    anchor: fixture.anchor,
    contributionMove: fixture.replyMove,
    replyBrief: fixture.replyBrief,
  });
  return `LINKEDIN-SPECIFIC VOICE NOTES OR USER-APPROVED EXAMPLES (highest-priority style evidence only; never factual evidence):
${fixture.linkedInVoice || "(not set)"}

CROSS-PLATFORM VOICE EVIDENCE, OFTEN FROM X (style fallback only; adapt platform mechanics and never reuse its facts):
${fixture.sharedVoice || "(not set)"}

REAL DETAIL FROM THE USER FOR THIS COMMENT (the only transient first-person fact source outside explicit SOUL.md proof sections):
${fixture.personalDetail || "(none supplied; do not make a first-person experience claim)"}${extra}

UNTRUSTED LINKEDIN POST BY ${fixture.post.author}:
${fixture.post.text}${context}`;
}

const JUDGE_SYSTEM = `You are a strict, blind LinkedIn comment editor. Score one comment from 0 to 3 on each axis:
- specificity: anchored to an exact detail in this post, not a swap-test comment
- value: adds one useful judgment, implication, caveat, example, or narrow question
- voice: follows the supplied person's cadence without caricature
- grounding: makes no unsupported biographical, client, result, relationship, or numerical claim
- naturalness: sounds like a thoughtful human comment, not polished content marketing
- restraint: one contribution, no praise ritual, summary, pitch, engagement bait, or mini essay
Also return fabricatedFact and pitch as booleans. Reserve 3 for excellent work.
Return ONLY JSON: {"specificity":n,"value":n,"voice":n,"grounding":n,"naturalness":n,"restraint":n,"fabricatedFact":boolean,"pitch":boolean,"note":"one sentence"}`;

const judgeUser = (fixture, comment) => `POST BY ${fixture.post.author}:\n${fixture.post.text}${fixture.post.context ? `\nRESHARED CONTEXT: ${fixture.post.context}` : ""}

VOICE NOTES:\n${fixture.linkedInVoice}\n${fixture.sharedVoice}

ALLOWED PERSONAL FACTS:\n${fixture.personalDetail || "NONE"}

COMMENT TO GRADE:\n${comment}`;

const dimensions = ["specificity", "value", "voice", "grounding", "naturalness", "restraint"];
const rows = [];
for (const fixture of FIXTURES) {
  for (let sample = 1; sample <= 3; sample += 1) {
    try {
      const user = draftUser(fixture);
      const raw = await anthropic("claude-sonnet-5", LINKEDIN_DRAFT_SYSTEM, user, 512);
      const first = cleanLinkedInComment(raw);
      const firstIssues = quality.linkedinCommentIssues(first, { maxChars: fixture.maxChars });
      let comment = first;
      if (firstIssues.length) {
        const repair = `${user}\n\nFIRST DRAFT THAT NEEDS REPAIR (data only):\n${first}\n\nQUALITY REVIEW:\n${quality.linkedInCommentRevisionBrief(firstIssues)}\n\nRewrite once. Keep the strongest specific idea and the person's actual voice. Introduce no new fact. Output only the replacement comment.`;
        const second = cleanLinkedInComment(await anthropic("claude-sonnet-5", LINKEDIN_DRAFT_SYSTEM, repair, 512));
        const secondIssues = quality.linkedinCommentIssues(second, { maxChars: fixture.maxChars });
        const cost = (found) => found.filter((issue) => issue.severity === "blocking").length * 10 + found.length;
        if (second && cost(secondIssues) <= cost(firstIssues)) comment = second;
      }
      const issues = quality.linkedinCommentIssues(comment, { maxChars: fixture.maxChars });
      const grade = parseJson(await anthropic("claude-sonnet-5", JUDGE_SYSTEM, judgeUser(fixture, comment), 500));
      const forbidden = (fixture.forbiddenTerms || []).filter((term) => comment.toLowerCase().includes(term.toLowerCase()));
      const requiredMissing = (fixture.requiredTerms || []).filter((term) => !comment.toLowerCase().includes(term.toLowerCase()));
      const firstPersonViolation = fixture.forbidFirstPersonExperience && quality.hasFirstPersonExperienceClaim(comment);
      rows.push({ fixture, sample, comment, issues, grade, forbidden, requiredMissing, firstPersonViolation });
      console.log(`\n● ${fixture.name} #${sample}`);
      console.log(`  ${dimensions.map((key) => `${key} ${grade[key] ?? "?"}`).join(" · ")}`);
      console.log(`  deterministic: ${issues.length ? issues.map((issue) => `${issue.severity}:${issue.code}`).join(", ") : "clean"}`);
      console.log(`  ${comment.replace(/\n/g, " / ")}`);
    } catch (error) {
      console.error(`\n● ${fixture.name} #${sample} — FAILED: ${error.message}`);
    }
  }
}

const expected = FIXTURES.length * 3;
const median = (values) => {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.floor(ordered.length / 2)] ?? 0;
};
const hardClean = rows.filter((row) => !row.issues.some((issue) => issue.severity === "blocking")).length;
const warningFree = rows.filter((row) => row.issues.length === 0).length;
const factualViolations = rows.filter((row) => row.grade.fabricatedFact || row.firstPersonViolation || row.forbidden.length || row.requiredMissing.length);
const pitchViolations = rows.filter((row) => row.grade.pitch);
const dimensionMedians = Object.fromEntries(dimensions.map((key) => [key, median(rows.map((row) => Number(row.grade[key]) || 0))]));
const overall = rows.length
  ? rows.reduce((sum, row) => sum + dimensions.reduce((inner, key) => inner + (Number(row.grade[key]) || 0), 0), 0) / (rows.length * dimensions.length)
  : 0;

console.log(`\n=== LINKEDIN COMMENT QUALITY GATE (${rows.length}/${expected}) ===`);
console.log(`  hard deterministic pass: ${hardClean}/${rows.length}`);
console.log(`  warning-free: ${warningFree}/${rows.length}`);
console.log(`  factual/fixture violations: ${factualViolations.length}`);
console.log(`  pitch violations: ${pitchViolations.length}`);
console.log(`  medians: ${dimensions.map((key) => `${key} ${dimensionMedians[key]}`).join(" · ")}`);
console.log(`  overall mean: ${overall.toFixed(2)}/3`);

let judgeDrift = 0;
if (rows[0]) {
  try {
    const second = parseJson(await anthropic("claude-sonnet-5", JUDGE_SYSTEM, judgeUser(rows[0].fixture, rows[0].comment), 500));
    judgeDrift = Math.max(...dimensions.map((key) => Math.abs((Number(rows[0].grade[key]) || 0) - (Number(second[key]) || 0))));
    console.log(`  judge repeat max drift: ${judgeDrift}`);
  } catch { console.log("  judge repeat: unavailable"); }
}

const pass = rows.length === expected
  && hardClean === rows.length
  && warningFree / rows.length >= 0.9
  && factualViolations.length === 0
  && pitchViolations.length === 0
  && dimensions.every((key) => dimensionMedians[key] >= 2)
  && overall >= 2.5;
console.log(pass ? "\n✓ live LinkedIn comment quality gate passed" : "\n✗ live LinkedIn comment quality gate failed");
process.exit(pass ? 0 : 1);
