/**
 * Layer B (live LLM-judge) eval for the reply DRAFTER — the product's paid action. OPT-IN and
 * costs money, so it is NOT part of the default gate. For each fixture it drafts a reply twice
 * with the REAL X_DRAFT_SYSTEM (Sonnet): BARE (today's minimal user message) and ENRICHED (with
 * the REAL buildDraftContext block) — then a Haiku judge scores both, so the context enrichment
 * is a measured before/after delta, not a hope.
 *
 * The judge's headline dimension is anchored to a mechanism X's published code shows it runs:
 * a Grok LLM grades replies 0-3 on big-author threads (xai-org/x-algorithm, grox reply_ranking).
 * X's actual rubric text is WITHHELD — this is anchored to the 0-3 scale and the slop concept,
 * never a claim to predict X's score.
 *
 *   ANTHROPIC_API_KEY=sk-... node scripts/eval-draft-reply-live.mjs --live
 *
 * Without --live / a key it prints usage and exits 0 (the default gate stays $0).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as esbuild from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const LIVE = process.argv.includes("--live");
const KEY = process.env.ANTHROPIC_API_KEY;
if (!LIVE || !KEY) {
  console.log(`Layer B — live draft-reply eval (opt-in, ~$0.25/run).
  Run:  ANTHROPIC_API_KEY=sk-... node scripts/eval-draft-reply-live.mjs --live
  Drafts each fixture BARE vs ENRICHED (the real buildDraftContext block) with the real
  X_DRAFT_SYSTEM (Sonnet), then a Haiku judge scores both on a 0-3 rubric anchored to the
  LLM reply-grading mechanism in X's published pipeline. No --live or no key -> no-op.`);
  process.exit(0);
}

// The REAL prompt + the REAL context assembler under test (both import-free → data-URL importable).
const load = async (rel) => {
  const src = readFileSync(join(here, rel), "utf8");
  const js = esbuild.transformSync(src, { loader: "ts", format: "esm" }).code;
  return import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));
};
const { X_DRAFT_SYSTEM, REPLY_ANGLES } = await load("../src/lib/prompts.ts");
const { buildDraftContext } = await load("../src/lib/draft-context.ts");

// Fixtures: post + voice + the context the extension would hold. Deliberately spans easy/hard.
const FIXTURES = [
  {
    name: "builder peer, technical post",
    post: { author: "shipdaily", text: "Spent the weekend moving our RAG pipeline from LangChain to raw API calls. 40% less latency, half the code. Frameworks are scaffolding, not foundations." },
    voice: "lowercase, blunt, short sentences. no hype.",
    angle: "value",
    ctx: { niche: "AI SaaS, indie founders, shipping with LLMs; posts I can add a real build lesson to", reason: "hands-on take invites peers", category: "value", authorLine: "@shipdaily · ~8.1K followers · a two-way peer in the user's niche" },
  },
  {
    name: "big-account thread (the LLM-graded surface)",
    post: { author: "bigdevrel", text: "Unpopular opinion: most AI agent demos are vaporware. Show me one running in production for 6 months with real users and I'll listen." },
    voice: "direct, a little wry, clean sentences.",
    angle: "value",
    ctx: { niche: "AI agents in production, dev tooling", reason: "credible contrarian, high engagement", category: "value", authorLine: "@bigdevrel · ~92K followers" },
  },
  {
    name: "connect angle, personal story post",
    post: { author: "quietfounder", text: "Two years in. Still no launch tweet with rocket emojis. Just 214 customers who found us through word of mouth. Slow feels wrong until you look at churn." },
    voice: "warm, story-driven, lowercase starts, fragments.",
    angle: "connect",
    ctx: { niche: "bootstrapped SaaS, indie hacking", reason: "kindred journey, invites rapport", category: "connect", authorLine: "@quietfounder · ~5.4K followers · a two-way peer in the user's niche" },
  },
  {
    name: "ask angle, data post",
    post: { author: "metricsnerd", text: "Analyzed 2,000 onboarding flows. The single biggest activation predictor wasn't time-to-value. It was whether the user did ANYTHING in the first 30 seconds." },
    voice: "curious, precise, no emojis.",
    angle: "ask",
    ctx: { niche: "product analytics, activation, SaaS growth", reason: "rich data, sharp question available", category: "ask", authorLine: "@metricsnerd · ~31K followers" },
  },
  {
    name: "no voice set (cold user)",
    post: { author: "designdebt", text: "Your design system isn't failing because of the components. It's failing because two PMs disagree about what the product is and the UI is where that fight surfaces." },
    voice: "",
    angle: "value",
    ctx: { niche: "product design, design systems", reason: "arguable systemic claim", category: "value", authorLine: "@designdebt · ~12K followers" },
  },
];

async function anthropic(model, system, user, maxTokens) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] }),
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const data = await res.json();
  return (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
}
const parseJson = (t) => JSON.parse(t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1));

// Mirror draftReply's user-message assembly (keep in sync with claude-client.ts:draftReply).
function draftUser(f, enriched) {
  const def = f.angle ? REPLY_ANGLES.find((a) => a.id === f.angle) : undefined;
  const angleLine = def ? `\n\n${def.directive}` : "";
  const extra = enriched ? buildDraftContext(f.ctx) : "";
  return `User voice:\n${f.voice || "(not set — write terse and specific; no marketing language, no adjectives-for-the-sake-of-it, no emojis, no hashtags)"}\n\nReply to @${f.post.author}'s post:\n${f.post.text}${extra}${angleLine}`;
}

const JUDGE_SYSTEM = `You are a strict reply-quality grader for X (Twitter), modeled on the idea that an LLM reads a reply in its thread and grades it 0-3 (X's published pipeline does this on big-author threads; its exact rubric is not public — judge on first principles). Score ONE reply on:
- grade: 0-3 overall. 3 = specific, situated in THIS post's particulars, adds something the thread didn't have (a datapoint, lived experience, a sharp question). 2 = solid, on-topic, non-generic. 1 = plausible but could sit under a thousand posts. 0 = generic praise, sycophancy, or engagement-bait.
- slopTells: 0-3 where 3 = NO detectable AI-writing tells (no "it's not just X it's Y", no lists of exactly three, no restating the post back, no em dashes, no hollow superlatives). 0 = reads instantly as AI.
- valueAdd: 0-3 — does it contribute a datapoint/experience/question the author would want to respond to (the author-reply-back lever)?
- voiceMatch: 0-3 — does it match the stated user voice (register, case, rhythm)? Score 2 when no voice was provided and the reply is at least terse+specific.
- profilePull: 0-3 — would a stranger reading it get curious about the AUTHOR of the reply (demonstrated competence, not self-promotion)?
Return ONLY JSON: {"grade":n,"slopTells":n,"valueAdd":n,"voiceMatch":n,"profilePull":n,"note":"one sentence"}`;

const judgeUser = (f, reply) =>
  `The post being replied to (@${f.post.author}):\n${f.post.text}\n\nThe user's stated voice: ${f.voice || "(none provided)"}\n\nThe reply to grade:\n${reply}`;

const DIMS = ["grade", "slopTells", "valueAdd", "voiceMatch", "profilePull"];
const rows = [];
for (const f of FIXTURES) {
  try {
    const bare = (await anthropic("claude-sonnet-4-6", X_DRAFT_SYSTEM, draftUser(f, false), 400)).trim();
    const rich = (await anthropic("claude-sonnet-4-6", X_DRAFT_SYSTEM, draftUser(f, true), 400)).trim();
    const vBare = parseJson(await anthropic("claude-haiku-4-5", JUDGE_SYSTEM, judgeUser(f, bare), 400));
    const vRich = parseJson(await anthropic("claude-haiku-4-5", JUDGE_SYSTEM, judgeUser(f, rich), 400));
    rows.push({ f, bare, rich, vBare, vRich });
    console.log(`\n● ${f.name}`);
    console.log(`  bare:     ${DIMS.map((d) => `${d} ${vBare[d] ?? "?"}`).join(" · ")}`);
    console.log(`  enriched: ${DIMS.map((d) => `${d} ${vRich[d] ?? "?"}`).join(" · ")}`);
    console.log(`  bare draft:     ${bare.slice(0, 110).replace(/\n/g, " ")}`);
    console.log(`  enriched draft: ${rich.slice(0, 110).replace(/\n/g, " ")}`);
  } catch (e) { console.error(`\n● ${f.name} — FAILED: ${e.message}`); }
}

if (rows.length) {
  const mean = (k, side) => (rows.reduce((s, r) => s + (Number(r[side][k]) || 0), 0) / rows.length).toFixed(2);
  console.log(`\n=== AGGREGATE (${rows.length}/${FIXTURES.length} fixtures) — bare → enriched ===`);
  for (const d of DIMS) console.log(`  ${d}: ${mean(d, "vBare")} → ${mean(d, "vRich")}  (Δ ${(mean(d, "vRich") - mean(d, "vBare")).toFixed(2)})`);
  // Judge stability: re-grade the same reply; deltas smaller than the observed drift are noise.
  try {
    const first = rows[0];
    const v2 = parseJson(await anthropic("claude-haiku-4-5", JUDGE_SYSTEM, judgeUser(first.f, first.bare), 400));
    const drift = Math.max(...DIMS.map((d) => Math.abs((Number(first.vBare[d]) || 0) - (Number(v2[d]) || 0))));
    console.log(`  judge stability (re-graded "${first.f.name}" bare): max drift ${drift} ${drift <= 1 ? "(stable)" : "(noisy — treat small deltas with caution)"}`);
  } catch { /* stability check is best-effort */ }
  console.log(`  Gate: ship stage-2 context (exemplars + measured-angle) only if grade/valueAdd move up without slopTells/voiceMatch moving down.`);
}
console.log("");
