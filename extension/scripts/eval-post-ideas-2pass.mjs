/**
 * Layer B (live) gate for the post-ideas SECOND PASS (reject-and-regenerate). Mirrors the product
 * path in claude-client.refinePostIdeas: generate with the real POST_IDEAS_SYSTEM (Sonnet) → a
 * Haiku POST_IDEAS_JUDGE flags swap-test failures → Sonnet POST_IDEAS_REGEN rewrites ONLY those →
 * re-judge. Reports pass-1 vs pass-2 so the lift the second pass adds is measured, not hoped.
 *
 *   ANTHROPIC_API_KEY=sk-... node scripts/eval-post-ideas-2pass.mjs --live
 *
 * First measured run (2026-07-08, 3 fixtures): swap-fails 9/15 → 6/15, antiGeneric 1.67 → 2.33,
 * slopFree 2.00 → 2.33. No --live / no key → no-op exit 0 (keeps CI free).
 */
import { readFileSync } from "node:fs";
import * as esbuild from "esbuild";

const LIVE = process.argv.includes("--live");
const KEY = process.env.ANTHROPIC_API_KEY;
if (!LIVE || !KEY) {
  console.log(`Layer B — post-ideas second-pass gate (opt-in, ~$0.30/run).
  Run:  ANTHROPIC_API_KEY=sk-... node scripts/eval-post-ideas-2pass.mjs --live
  Measures pass-1 vs pass-2 (judge-flagged swap-fails regenerated) on seed fixtures.`);
  process.exit(0);
}

const src = readFileSync(new URL("../src/lib/prompts.ts", import.meta.url), "utf8");
const js = esbuild.transformSync(src, { loader: "ts", format: "esm" }).code;
const { POST_IDEAS_SYSTEM, POST_IDEAS_JUDGE_SYSTEM, POST_IDEAS_REGEN_SYSTEM } = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));

// Representative sample: John's real niche + a terse-blunt user + a polished user (the two hardest voices).
const FIXTURES = [
  { name: "AI / build-in-public", niche: "building AI products in public, indie founder, shipping fast, growing on X", voice: "lowercase, direct, no hype, a little dry", followers: 3000,
    ownPosts: [{ text: "shipped a chrome extension that drafts X replies in your voice. 3 weeks idea to install. the hard part wasn't the AI, it was making it not feel creepy.", likes: 210, reposts: 18 }, { text: "everyone's building AI wrappers. the moat is the 200 tiny product decisions the model can't make for you.", likes: 340, reposts: 40 }],
    winners: [{ author: "levelsio", text: "I made $0 for 2 years building startups. Then one worked. Survivorship bias is the whole game and nobody admits it.", likes: 4200, reposts: 520, followers: 500000 }, { author: "buildinpublic_guy", text: "hit $10k MRR today. it took 3 failed products, 18 months, and exactly one feature people actually paid for.", likes: 2100, reposts: 260, followers: 22000 }] },
  { name: "indie founder (terse)", niche: "building a bootstrapped SaaS, indie hacking, getting first customers", voice: "lowercase, blunt, no hype, short sentences", followers: 850,
    ownPosts: [{ text: "spent 3 weeks on a feature nobody used. shipped a checkout fix in an afternoon that doubled trials. build the boring stuff.", likes: 140, reposts: 12 }, { text: "cold dms still work. sent 40, got 6 calls, closed 2.", likes: 90, reposts: 8 }],
    winners: [{ author: "tinyfounder", text: "I raised my prices 40% and lost zero customers. The cheap plan was attracting people who churned anyway.", likes: 1200, reposts: 180, followers: 4000 }, { author: "shipfast_guy", text: "5 things I'd tell myself before launching: charge from day one / talk to 10 users a week / ship ugly", likes: 900, reposts: 140, followers: 9000 }] },
  { name: "design / UX", niche: "product design, UX, design systems, working with engineers", voice: "thoughtful, wry, clean sentences, no emojis", followers: 5200,
    ownPosts: [{ text: "The best design feedback I ever got: what is the user trying to do here? Not I don't like the blue.", likes: 410, reposts: 55 }, { text: "A design system isn't components. It's the 200 decisions you made once so nobody has to make them again.", likes: 880, reposts: 120 }],
    winners: [{ author: "uxqueen", text: "Hot take: most design debt is actually decision debt. The UI is fine. Nobody agreed on what the product is.", likes: 1800, reposts: 240, followers: 22000 }, { author: "figmawizard", text: "I redesigned the onboarding 4 times. The version that worked had fewer screens, not prettier ones.", likes: 650, reposts: 70, followers: 8000 }] },
];

async function anthropic(model, system, user, maxTokens) {
  const res = await fetch("https://api.anthropic.com/v1/messages", { method: "POST",
    headers: { "x-api-key": KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] }) });
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 160)}`);
  return ((await res.json()).content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
}
const parseJson = (t) => JSON.parse(t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1));

function buildUser(f) {
  const list = f.winners.map((p, i) => `${i + 1}. @${p.author} [${(p.likes + p.reposts)} eng on ~${p.followers} followers]: ${p.text}`).join("\n");
  const own = [...f.ownPosts].sort((a, b) => (b.likes + b.reposts) - (a.likes + a.reposts));
  const ownBlock = `\n\nThe user's OWN recent posts (PRIMARY voice + structure anchor; do NOT duplicate topics/angles/examples):\n${own.map((p, i) => `${i + 1}. ${i < 3 ? "(this landed for you) " : ""}${p.text}`).join("\n")}`;
  return `User niche / what they post about:\n${f.niche}\n\nUser voice (tone + word choice only):\n${f.voice}${ownBlock}\n\nUser approximate followers: ~${f.followers}.\n\nOver-performing posts from others (remix the PATTERNS, never copy the content):\n${list}`;
}

const JUDGE_SCORE = `You are a harsh X growth editor. Score a BATCH of 5 post ideas 0-3 and list swap-test failures.
- slopFree: 3 = every idea reads as substantive human writing; 0 = AI slop.
- antiGeneric: 3 = every idea is unmistakably THIS user; 0 = interchangeable niche filler.
swapTestFails = 1-based indices of ideas another account could post verbatim (generic, or a source restatement).
Return ONLY JSON: {"slopFree":n,"antiGeneric":n,"swapTestFails":[...]}`;
const scoreUser = (f, ideas) => `User niche: ${f.niche}\nOwn posts:\n${f.ownPosts.map((p) => p.text).join("\n")}\nSource posts:\n${f.winners.map((p) => `@${p.author}: ${p.text}`).join("\n")}\n\n5 ideas:\n${ideas.map((d, i) => `${i + 1}. ${d.text}`).join("\n\n")}`;

const results = [];
for (const f of FIXTURES) {
  try {
    const gen = parseJson(await anthropic("claude-sonnet-4-6", POST_IDEAS_SYSTEM, buildUser(f), 2200));
    let ideas = (gen.ideas || []).slice(0, 5).filter((d) => d.text);
    const s1 = parseJson(await anthropic("claude-haiku-4-5", JUDGE_SCORE, scoreUser(f, ideas), 400));
    // the PRODUCT's second pass: a swap-test judge flags fails, Sonnet regenerates just those
    const flags = parseJson(await anthropic("claude-haiku-4-5", POST_IDEAS_JUDGE_SYSTEM, `${buildUser(f)}\n\nThe 5 generated ideas to swap-test:\n${ideas.map((d, i) => `${i + 1}. ${d.text}`).join("\n\n")}`, 300));
    const fails = (flags.swapTestFails || []).filter((n) => n >= 1 && n <= ideas.length);
    if (fails.length) {
      const flagged = fails.map((n) => ideas[n - 1].text);
      const re = parseJson(await anthropic("claude-sonnet-4-6", POST_IDEAS_REGEN_SYSTEM, `${buildUser(f)}\n\nThe drafts that failed the swap test (rewrite each into something only this user could post, in order):\n${flagged.map((t, i) => `${i + 1}. ${t}`).join("\n\n")}`, 1600));
      const repl = (re.ideas || []).map((d) => d.text).filter(Boolean);
      fails.forEach((n, k) => { if (repl[k]) ideas[n - 1] = { text: repl[k] }; });
    }
    const s2 = parseJson(await anthropic("claude-haiku-4-5", JUDGE_SCORE, scoreUser(f, ideas), 400));
    results.push({ name: f.name, s1, s2, regenerated: fails.length });
    console.log(`\n● ${f.name}: regenerated ${fails.length}/5`);
    console.log(`  pass1: slopFree ${s1.slopFree} · antiGeneric ${s1.antiGeneric} · swapFails ${(s1.swapTestFails || []).length}`);
    console.log(`  pass2: slopFree ${s2.slopFree} · antiGeneric ${s2.antiGeneric} · swapFails ${(s2.swapTestFails || []).length}`);
  } catch (e) { console.error(`● ${f.name} FAILED: ${e.message}`); }
}
if (results.length) {
  const mean = (arr, k) => (arr.reduce((s, r) => s + (Number(r[k]) || 0), 0) / arr.length).toFixed(2);
  const s1 = results.map((r) => r.s1), s2 = results.map((r) => r.s2);
  const sf1 = s1.reduce((s, r) => s + (r.swapTestFails || []).length, 0), sf2 = s2.reduce((s, r) => s + (r.swapTestFails || []).length, 0);
  console.log(`\n=== AGGREGATE (${results.length} fixtures, 5 ideas each) — pass1 → pass2 ===`);
  console.log(`  slopFree:    ${mean(s1, "slopFree")} → ${mean(s2, "slopFree")}`);
  console.log(`  antiGeneric: ${mean(s1, "antiGeneric")} → ${mean(s2, "antiGeneric")}`);
  console.log(`  swap-fails:  ${sf1}/${results.length * 5} → ${sf2}/${results.length * 5}`);
  console.log(`  Gate: ship second-pass changes only if pass-2 stays clearly below pass-1 on swap-fails without dropping slopFree/antiGeneric.`);
}
console.log("");
