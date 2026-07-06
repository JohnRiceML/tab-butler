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
  // Strong requires a REAL breakout source, not just rank #1 of a weak pool
  ok(m.bandFor(0.9, 3, true, 4, true).band === "Strong", "a healthy pool whose top source genuinely over-performed → Strong");
  ok(m.bandFor(0.9, 3, true, 4, false).band === "Solid", "the #1 of a healthy pool that only weakly over-performed caps at Solid, not Strong");
  ok(/modestly out-performed/.test(m.bandFor(0.9, 3, true, 4, false).basis), "a weak-but-top source is narrated honestly, not as a top breakout");
  ok(m.bandFor(0.9, 3, true, 4).band === "Strong", "unknown source strength (omitted) keeps the rank-based Strong (back-compat)");
}
// ---- isBreakout: genuine over-performance for size, not just rank ----
{
  ok(m.isBreakout({ likes: 300, followers: 5000 }) === true, "300 likes on 5k (2.4× the ~2.5% tier norm) is a real breakout");
  ok(m.isBreakout({ likes: 100, followers: 5000 }) === false, "100 likes on 5k (below the tier norm) is not a breakout");
  ok(m.isBreakout({ likes: 50 }) === false, "unknown reach can't be called a size-relative breakout");
}
// ---- per-niche calibration of the size baseline (free, from already-fetched posts) ----
{
  const samples = [];
  for (let i = 0; i < 8; i++) samples.push({ followers: 5000, likes: 250 }); // 8 posts @ 5% in the 1k-10k tier
  samples.push({ followers: 50000, likes: 500 });                            // 1 post in the 10k-100k tier (sparse)
  const t = m.calibrateRates(samples);
  ok(Math.abs(t.lt10k - 0.05) < 1e-9, "a well-sampled tier calibrates to its median like-rate");
  ok(t.lt100k === m.DEFAULT_RATES.lt100k && t.lt1k === m.DEFAULT_RATES.lt1k, "a sparse/empty tier keeps the published default (worst case = today's behavior)");
  const viral = Array.from({ length: 8 }, () => ({ followers: 1000, likes: 5000 })); // 500% rate
  ok(m.calibrateRates(viral).lt10k === 0.12, "a degenerate tier is clamped to the sane max");
  m.setRateTable({ lt1k: 0.06, lt10k: 0.03, lt100k: 0.02, lt500k: 0.012, mega: 0.007 });
  ok(m.expectedRate(500) === 0.06, "setRateTable swaps the active baseline expectedRate reads");
  m.setRateTable(null);
  ok(m.expectedRate(500) === 0.04, "reset restores the published default");
}

// ---- shape → outcome: measured, settle-gated, one metric, min-N ----
{
  const NOW = 1_700_000_000_000, DAY = 86_400_000;
  const mk = (text, daysAgo, views) => ({ text, postedAt: NOW - daysAgo * DAY, views });
  const posts = [
    mk("I almost quit last year. Then I changed one thing. It worked out fine.", 5, 4000),
    mk("I shipped the wrong feature first. I learned the hard way. It cost me a month.", 6, 3600),
    mk("I raised prices and braced for churn. Nothing happened. I had been scared of a ghost.", 7, 3900),
    mk("consistency beats intensity", 5, 900),
    mk("shipping daily beats planning weekly", 6, 800),
    mk("small teams move faster", 8, 1000),
    mk("What if your onboarding is the problem?", 9, 700),
    mk("Why do founders fear pricing?", 10, 600),
    mk("Should you build in public?", 11, 800),
  ];
  const sp = m.shapePerformance(posts, NOW);
  ok(sp && sp.metric === "views", "majority-views pool → views metric, never mixed scales");
  ok(sp.shapes[0].shape === "story" && sp.shapes[0].rel > 2, "the measured best shape ranks first with an honest multiple");
  // settle gate: a fresh viral post never enters (selection bias — it hasn't finished earning)
  const withFresh = [...posts, mk("I went viral an hour ago with this story. It felt amazing. Numbers still climbing.", 0, 90000)];
  const sp2 = m.shapePerformance(withFresh, NOW);
  ok(sp2.shapes.find((x) => x.shape === "story").n === 3, "posts younger than the settle window are excluded");
  // min-N: a shape with 2 posts never ranks
  ok(!sp.shapes.some((x) => x.shape === "numberLead"), "unranked shapes stay silent (min-N)");
  ok(m.shapePerformance(posts.slice(0, 3), NOW) === null, "too few settled posts → null (silence, not guesses)");
}

console.log(fail === 0 ? `\n✓ post-ideas eval: ${pass} assertions passed` : `\n✗ post-ideas eval: ${fail} failed, ${pass} passed`);
process.exit(fail === 0 ? 0 : 1);
