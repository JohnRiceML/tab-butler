/**
 * Offline eval (Layer A) for the Post-ideas exemplar quality + virality banding
 * (idea-quality.ts). esbuild → data-URL import. $0, no API key. Run: node scripts/eval-post-ideas.mjs
 *
 * Layer B (a live Haiku judge over real generations) is a separate, opt-in harness; this layer
 * proves the deterministic guards — which is where most "garbage in" quality loss happens.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as esbuild from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "../src/lib/idea-quality.ts"), "utf8");
const js = esbuild.transformSync(src, { loader: "ts", format: "esm" }).code;
const m = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) pass++; else { fail++; console.error("  FAIL:", l); } };

// ---- English guard ----
ok(m.isEnglish("five things I learned shipping my first product"), "english text passes");
ok(!m.isEnglish("これは日本語のツイートです、英語ではありません"), "mostly non-latin fails");
ok(m.isEnglish("anything", "en") && !m.isEnglish("anything", "ja"), "explicit lang wins");

// ---- RT + bait ----
ok(m.looksLikeRT("RT @someone: great point") && !m.looksLikeRT("rt is fine mid-sentence"), "RT-text detected, not over-eager");
ok(m.isBait("Retweet to win a free iPhone!") && m.isBait("Tag a friend who needs this"), "engagement-bait detected");
ok(m.isBait("gm #crypto #web3 #nft #airdrop #100x") && !m.isBait("shipped a new feature today, pretty happy with it"), "hashtag-spam flagged, normal post clean");

// ---- shape classification ----
ok(m.classifyShape("3 things nobody tells you about pricing") === "numberLead", "number-lead");
ok(m.classifyShape("Most people are wrong about consistency.") === "contrarian", "contrarian");
ok(m.classifyShape("Lessons:\n- ship daily\n- talk to users\n- charge money") === "list", "list");
ok(m.classifyShape("I almost quit last year. Then I changed one thing. It worked.") === "story", "story");
ok(m.classifyShape("What if your pricing page is the problem?") === "question", "question");
ok(m.classifyShape("consistency beats intensity") === "oneLiner", "one-liner");

// ---- breakout scoring: a small-account breakout beats a mega-account floor post ----
{
  const breakout = m.scoreWinner({ likes: 800, reposts: 100, followers: 2000 }, 0);   // ~0.45 like-rate
  const floor = m.scoreWinner({ likes: 1200, reposts: 50, followers: 2_000_000 }, 0);   // tiny rate
  ok(breakout.score > floor.score, "small-account breakout outranks mega-account floor post");
  const a = m.scoreWinner({ likes: 50, reposts: 0 }, 20).score; // unknown reach → median baseline
  const b = m.scoreWinner({ likes: 10, reposts: 0 }, 20).score;
  ok(a > b, "unknown-reach posts rank on their own engagement scale");
}
// ---- size-tiered engagement baseline (small accounts run hotter; not a flat 0.3%) ----
{
  ok(m.expectedRate(500) === 0.04 && m.expectedRate(5000) === 0.025 && m.expectedRate(50000) === 0.015
     && m.expectedRate(200000) === 0.01 && m.expectedRate(2_000_000) === 0.0065, "expected-rate baseline is size-tiered (sub-1k hottest, megas coldest)");
  ok(m.expectedRate(500) > m.expectedRate(2_000_000), "a small account's 'normal' rate is higher than a mega's");
  // The fix: an ordinary-for-its-size small post no longer reads as a breakout that beats a real large breakout.
  const smallNormal = m.scoreWinner({ likes: 125, followers: 5000 }, 0).score;   // 2.5% = exactly the tier norm
  const largeBreakout = m.scoreWinner({ likes: 12000, followers: 200000 }, 0).score; // 6% = 6× the 1% tier norm
  ok(largeBreakout > smallNormal, "a genuine large breakout outranks an ordinary-for-its-size small post (flat-constant bug fixed)");
}
ok(m.percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.4) === 5, "percentile floor picks the 40th-pct value");

// ---- input de-dupe ----
ok(m.jaccard(m.ideaTokens("ship daily and measure what sticks"), m.ideaTokens("ship daily measure what sticks today")) >= m.INPUT_DEDUP, "near-identical source posts flagged as dupes");

// ---- copy-leak: a remixed PATTERN shares little content; a lifted source shares a lot ----
{
  const source = "I raised prices 40% and lost zero customers. The cheap plan attracted people who churned anyway.";
  const remixed = "stop discounting to win the wrong customers. the bargain hunters are the first to leave.";
  const lifted = "I raised my prices 40% and lost zero customers. The cheap plan attracted people who churned.";
  ok(m.copyLeak(remixed, source) < m.COPY_LEAK, "a true pattern-remix stays below the copy-leak bar");
  ok(m.copyLeak(lifted, source) >= m.COPY_LEAK, "a near-verbatim lift trips the copy-leak bar");
}

// ---- honest virality band ----
{
  const strong = m.bandFor(0.9, 3, true);
  ok(strong.band === "Strong" && /top posts we found/.test(strong.basis), "top source + strong hook → Strong, honest basis");
  ok(m.bandFor(0.9, 0, true).band === "Long shot", "great source but a zero hook → Long shot");
  ok(m.bandFor(1, 3, false).band === "Niche", "no source can never exceed Niche, even with a great hook");
  ok(!/\d+×|\d+x typical|\/100/.test(strong.basis), "basis never fabricates a multiple or /100 score");
  ok(m.bandFor(0.9, 3, true).sort > m.bandFor(0.3, 1, true).sort, "sort tiebreaker orders stronger ideas first");
  // pool-size confidence haircut: weak evidence (a thin winner pool) can't mint a high band
  ok(m.bandFor(1, 3, true, 1).band === "Niche", "a single-exemplar pool can't be Strong (no 'top posts' off a sample of one)");
  ok(m.bandFor(1, 3, true, 2).band === "Solid", "a two-post pool caps a #1 + strong-hook idea at Solid");
  ok(m.bandFor(0.9, 3, true, 4).band === "Strong", "a healthy pool (>=4 winners) still reaches Strong");
  ok(/thin signal/.test(m.bandFor(1, 3, true, 1).basis) && /thin signal/.test(m.bandFor(1, 3, true, 2).basis), "a thin pool (1 OR 2 posts) is always labeled a thin signal — even a 2-post pool at its Solid cap");
}

console.log(fail === 0 ? `\n✓ post-ideas eval: ${pass} assertions passed` : `\n✗ post-ideas eval: ${fail} failed, ${pass} passed`);
process.exit(fail === 0 ? 0 : 1);
