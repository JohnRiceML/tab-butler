/**
 * Layer B (live LLM-judge) eval for the Post-ideas creator. OPT-IN + costs money, so it is
 * NOT part of the default test gate. It generates ideas for seed fixtures with the REAL
 * POST_IDEAS_SYSTEM (Sonnet), then scores each batch with a Haiku judge — so a prompt or
 * selection change becomes a measurable +/- delta before it ships.
 *
 *   ANTHROPIC_API_KEY=sk-... node scripts/eval-post-ideas-live.mjs --live
 *
 * Without --live / a key it prints usage and exits 0 (keeps CI at $0). Layer A
 * (scripts/eval-post-ideas.mjs) covers the deterministic selection/banding guards for free.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as esbuild from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const LIVE = process.argv.includes("--live");
const KEY = process.env.ANTHROPIC_API_KEY;
if (!LIVE || !KEY) {
  console.log(`Layer B — live LLM-judge eval (opt-in, ~$0.20/run).
  Run:  ANTHROPIC_API_KEY=sk-... node scripts/eval-post-ideas-live.mjs --live
  Generates ideas for ${5} seed niches with the real POST_IDEAS_SYSTEM (Sonnet), then a
  Haiku judge scores each batch 0-3 on anti-generic / voice / variety / hook / source-honesty.
  No --live or no key -> this no-op, so the default test gate stays free.`);
  process.exit(0);
}

// Pull the REAL system prompt under test (prompts.ts is import-free → data-URL importable).
const src = readFileSync(join(here, "../src/lib/prompts.ts"), "utf8");
const js = esbuild.transformSync(src, { loader: "ts", format: "esm" }).code;
const { POST_IDEAS_SYSTEM } = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));

// Seed fixtures: niche + voice + the user's own posts + the over-performing source posts the
// model is told to remix. Inputs are already clean (junk-rejection is Layer A's job); this
// measures GENERATION quality.
const FIXTURES = [
  {
    name: "indie founder (terse, lowercase)",
    niche: "building a bootstrapped SaaS, indie hacking, getting first customers",
    voice: "lowercase, blunt, no hype. swears occasionally. short sentences.",
    followers: 850,
    ownPosts: [
      { text: "spent 3 weeks on a feature nobody used. shipped a checkout fix in an afternoon that doubled trials. build the boring stuff.", likes: 140, reposts: 12 },
      { text: "cold dms still work. sent 40, got 6 calls, closed 2. everyone says outbound is dead because they sent 3 and gave up.", likes: 90, reposts: 8 },
      { text: "my first 10 customers all came from one subreddit. not twitter. not seo. one thread answering a real question.", likes: 60, reposts: 4 },
    ],
    winners: [
      { author: "tinyfounder", text: "I raised my prices 40% and lost zero customers. The cheap plan was attracting people who churned anyway.", likes: 1200, reposts: 180, followers: 4000 },
      { author: "shipfast_guy", text: "5 things I'd tell myself before launching:\n- charge from day one\n- talk to 10 users a week\n- ignore vanity metrics\n- ship ugly\n- pick a boring niche", likes: 900, reposts: 140, followers: 9000 },
      { author: "saas_diaries", text: "Nobody talks about how lonely bootstrapping is. No team, no funding, just you and a churn graph at 2am.", likes: 2100, reposts: 300, followers: 12000 },
    ],
  },
  {
    name: "design / UX (polished)",
    niche: "product design, UX, design systems, working with engineers",
    voice: "thoughtful, a little wry, clean sentences, no emojis.",
    followers: 5200,
    ownPosts: [
      { text: "The best design feedback I ever got: 'what is the user trying to do here?' Not 'I don't like the blue.'", likes: 410, reposts: 55 },
      { text: "A design system isn't components. It's the 200 decisions you made once so nobody has to make them again.", likes: 880, reposts: 120 },
    ],
    winners: [
      { author: "uxqueen", text: "Hot take: most 'design debt' is actually decision debt. The UI is fine. Nobody agreed on what the product is.", likes: 1800, reposts: 240, followers: 22000 },
      { author: "figmawizard", text: "I redesigned the onboarding 4 times. The version that worked had fewer screens, not prettier ones.", likes: 650, reposts: 70, followers: 8000 },
    ],
  },
  {
    name: "fitness coach",
    niche: "strength training, fat loss, coaching busy people",
    voice: "direct, encouraging but no fluff, occasional caps for emphasis.",
    followers: 3100,
    ownPosts: [
      { text: "You don't need a perfect program. You need to show up 3x a week for a year. That's it. That's the secret.", likes: 520, reposts: 80 },
    ],
    winners: [
      { author: "liftcoach", text: "Stop doing 20 sets of biceps. 2 hard sets to near-failure builds more than 8 junk sets you half-rep.", likes: 1400, reposts: 190, followers: 30000 },
      { author: "macrolady", text: "I tracked everything for 90 days. The only number that mattered was protein. Everything else was noise.", likes: 980, reposts: 110, followers: 15000 },
      { author: "fitnoise", text: "RT to win a free coaching spot!! Like + follow + tag 3 friends 🔥🔥 #fitness #giveaway", likes: 3000, reposts: 900, followers: 50000 },
    ],
  },
  {
    name: "B2B sales (no own posts — cold)",
    niche: "B2B SaaS sales, outbound, discovery calls, closing",
    voice: "(none provided)",
    followers: 600,
    ownPosts: [],
    winners: [
      { author: "quotacrusher", text: "The best discovery question isn't about pain. It's 'what happens if you do nothing?' Inertia is your real competitor.", likes: 1100, reposts: 160, followers: 18000 },
      { author: "saleslife", text: "I lost a 50k deal because I talked for 40 of the 45 minutes. Now I aim to talk 20%. Closed 3x more since.", likes: 1600, reposts: 220, followers: 24000 },
    ],
  },
  {
    name: "writing / newsletters",
    niche: "writing online, growing a newsletter, the creator economy",
    voice: "warm, story-driven, lowercase starts, uses fragments.",
    followers: 9400,
    ownPosts: [
      { text: "wrote 100 essays before one went anywhere. the 101st wasn't better. the audience was just finally big enough to catch it.", likes: 1200, reposts: 210 },
      { text: "your newsletter doesn't have a growth problem. it has a 'why would i forward this' problem.", likes: 760, reposts: 140 },
    ],
    winners: [
      { author: "wordsmith", text: "Everyone says 'write every day.' I wrote every day for a year and got worse. Then I started editing every day. Different game.", likes: 2400, reposts: 380, followers: 40000 },
      { author: "inboxhero", text: "Subject lines are 80% of email. I spent more time on 6 words than on the 600 below them. Open rate went from 22% to 41%.", likes: 1300, reposts: 170, followers: 16000 },
    ],
  },
];

async function anthropic(model, system, user, maxTokens, temperature) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: "user", content: user }], ...(temperature != null ? { temperature } : {}) }),
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const data = await res.json();
  return (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
}
const parseJson = (t) => JSON.parse(t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1));

// Mirror generatePostIdeas's user-message assembly (keep in sync with claude-client.ts).
function buildUser(f) {
  const list = f.winners.map((p, i) => {
    const eng = (p.likes ?? 0) + (p.reposts ?? 0);
    const ctx = p.followers ? `${eng} eng on ~${p.followers} followers` : `${eng} eng`;
    return `${i + 1}. @${p.author} [${ctx}]: ${p.text.replace(/\s+/g, " ").slice(0, 280)}`;
  }).join("\n");
  const own = [...(f.ownPosts || [])].sort((a, b) => ((b.likes ?? 0) + (b.reposts ?? 0)) - ((a.likes ?? 0) + (a.reposts ?? 0)));
  const ownBlock = own.length
    ? `\n\nThe user's OWN recent posts (your PRIMARY voice + structure anchor; do NOT duplicate these topics, angles, takes, or examples — extend their themes from a new angle):\n${own.slice(0, 15).map((p, i) => `${i + 1}. ${i < 3 ? "(this landed for you) " : ""}${p.text.replace(/\s+/g, " ").slice(0, 280)}`).join("\n")}`
    : "\n\n(The user's own posts were not available — the VOICE blurb is from REPLIES, so lean on it for tone only and be extra careful not to write generic niche advice.)";
  const fol = f.followers ? `\n\nUser approximate followers: ~${f.followers} (aim the post at this reach tier).` : "";
  return `User niche / what they post about:\n${f.niche}\n\nUser voice (from their REPLIES — tone + word choice only, NOT post structure):\n${f.voice || "(not set)"}${ownBlock}${fol}\n\nOver-performing posts from others in the space (remix the PATTERNS, never copy the content):\n${list}`;
}

const JUDGE_SYSTEM = `You are a harsh X/Twitter growth editor scoring a batch of 5 AI-generated post ideas a tool wrote for one user. Be skeptical; reserve 3s. Score the BATCH 0-3 on each axis:
- antiGeneric: 3 = every idea is unmistakably THIS user (swap test: put a different account's name on it; if it still fits, it's generic). 0 = mostly interchangeable niche filler ("consistency is key").
- voiceMatch: do they match the user's OWN posts' cadence, length, and register (lowercase, fragments, bluntness)? 0 if they read like a generic LinkedIn-voice bot.
- variety: 5 genuinely distinct shapes + a spread of content types, no topic clustering.
- hookCraft: does line 1 of each earn line 2 (a number, a stake, an arguable claim, or named tension; no throat-clearing or windup)?
- sourceHonesty: do they remix the PATTERN of the source posts and never lift a source's specific claim, number, or wording?
- slopFree: 3 = a strict LLM quality grader would score every idea as substantive human writing (no "it's not just X it's Y", no hollow superlatives, no listicle filler, no detectably-AI cadence — X's published pipeline computes an explicit slop score, so this is a ranked variable). 0 = mostly reads as AI slop.
Also return swapTestFails: 1-based indices of ideas that fail the swap test.
Return ONLY JSON: {"antiGeneric":n,"voiceMatch":n,"variety":n,"hookCraft":n,"sourceHonesty":n,"slopFree":n,"swapTestFails":[...],"note":"one sentence"}`;

const judgeUser = (f, ideas) =>
  `User niche: ${f.niche}\n\nThe user's own posts:\n${(f.ownPosts || []).map((p, i) => `${i + 1}. ${p.text}`).join("\n") || "(none)"}\n\nThe source posts the tool was told to remix the PATTERN of:\n${f.winners.map((p, i) => `${i + 1}. @${p.author}: ${p.text}`).join("\n")}\n\nThe 5 generated ideas to judge:\n${ideas.map((d, i) => `${i + 1}. [${d.pattern || "?"}] ${d.text}`).join("\n\n")}`;

const DIMS = ["antiGeneric", "voiceMatch", "variety", "hookCraft", "sourceHonesty", "slopFree"];
const ok = [];
for (const f of FIXTURES) {
  try {
    const gen = parseJson(await anthropic("claude-sonnet-4-6", POST_IDEAS_SYSTEM, buildUser(f), 2200)); // mirrors generatePostIdeas (temperature unset — 0.7 measured worse)
    const ideas = (gen.ideas || []).slice(0, 6).filter((d) => d.text);
    const v = parseJson(await anthropic("claude-haiku-4-5", JUDGE_SYSTEM, judgeUser(f, ideas), 600));
    ok.push({ f, ideas, v });
    console.log(`\n● ${f.name} — ${ideas.length} ideas`);
    console.log(`  ${DIMS.map((d) => `${d} ${v[d] ?? "?"}`).join(" · ")}`);
    console.log(`  swap-test fails: ${v.swapTestFails?.length ? v.swapTestFails.join(",") : "none"}  ·  ${v.note || ""}`);
  } catch (e) { console.error(`\n● ${f.name} — FAILED: ${e.message}`); }
}

if (ok.length) {
  const mean = (k) => (ok.reduce((s, r) => s + (Number(r.v[k]) || 0), 0) / ok.length).toFixed(2);
  const swapFails = ok.reduce((s, r) => s + (r.v.swapTestFails?.length || 0), 0);
  const totalIdeas = ok.reduce((s, r) => s + r.ideas.length, 0);
  console.log(`\n=== AGGREGATE (${ok.length}/${FIXTURES.length} fixtures) ===`);
  console.log(`  ${DIMS.map((d) => `${d} ${mean(d)}`).join(" · ")}  (0-3)`);
  console.log(`  swap-test fail rate: ${swapFails}/${totalIdeas} ideas`);
  // κ-stability: re-judge one fixture; deltas are only trustworthy if the judge is stable.
  try {
    const first = ok[0];
    const v2 = parseJson(await anthropic("claude-haiku-4-5", JUDGE_SYSTEM, judgeUser(first.f, first.ideas), 600));
    const drift = Math.max(...DIMS.map((d) => Math.abs((Number(first.v[d]) || 0) - (Number(v2[d]) || 0))));
    console.log(`  judge stability (re-scored "${first.f.name}"): max drift ${drift} ${drift <= 1 ? "(stable)" : "(noisy — treat small deltas with caution)"}`);
  } catch { /* stability check is best-effort */ }
}
console.log("");
