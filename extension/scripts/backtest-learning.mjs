/**
 * Backtest: does Goobi's MEASURED learning signal actually PREDICT future outcomes?
 * The evidence gate for closing the loop (wiring learned data into ranking + the drafter).
 * This is a REPLAY HARNESS over the real pure exports in src/lib/learn-stats.ts —
 * `learnFeatures` (per-angle rel + fitCorr) and `aggregateAccounts` (per-account score) —
 * NOT new statistics. Same esbuild → data-URL import trick as the test-*.mjs suites.
 *
 *   Synthetic self-test (runs in the $0 gate):  node scripts/backtest-learning.mjs
 *   Real-data mode (your exported learning JSON): node scripts/backtest-learning.mjs path/to/export.json
 *
 * Three theories:
 *   T3  the CURRENT stage-1 ranking predicts real outcomes      → learnFeatures().fitCorr
 *   T1  per-ANGLE engagement is STABLE (earlier half predicts later)   → drafter angle nudge gate
 *   T2  per-ACCOUNT engagement is STABLE (earlier half predicts later) → effectiveScore multiplier gate
 * Underpowered data (too few SETTLED outcomes) → SHELVE, keep the flag OFF. That is a valid result.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as esbuild from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "../src/lib/learn-stats.ts"), "utf8");
const js = esbuild.transformSync(src, { loader: "ts", format: "esm" }).code;
const m = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));
const { learnFeatures, aggregateAccounts, FIT_CORR_MIN_N = 12, N_MIN_OUT = 4 } = m;

const DAY = 86_400_000;
const measured = (r) => r?.outcome && (r.outcome.likes != null || r.outcome.replies != null);
const settled = (r) => !!r?.outcome?.frozen;

// ---- Spearman (self-contained; the lib's copy is not exported) ----
function spearman(pairs) {
  if (pairs.length < 2) return 0;
  const rank = (vals) => {
    const idx = vals.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
    const rs = new Array(vals.length);
    for (let i = 0; i < idx.length;) {
      let j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
      const r = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) rs[idx[k][1]] = r;
      i = j + 1;
    }
    return rs;
  };
  const xs = rank(pairs.map((p) => p[0])), ys = rank(pairs.map((p) => p[1]));
  const n = pairs.length, mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { const a = xs[i] - mx, b = ys[i] - my; num += a * b; dx += a * a; dy += b * b; }
  return dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : 0;
}

// ---- the three theory replays (all over the real learn-stats exports) ----

/** T3: correlation between stage-1 score and real measured fit, straight off learnFeatures. */
function testT3(sent, now) {
  const fl = learnFeatures(sent, now);
  return { nOut: fl.nOut, fitCorr: fl.fitCorr, fitCorrViews: fl.fitCorrViews };
}

/** Split settled outcomes by time (earlier vs later half) and rank-correlate a per-key
 *  signal across the two halves. Powered only when >=2 keys clear the min-N gate in BOTH
 *  halves — otherwise the split-half test simply can't run (that's the honest answer). */
function splitHalfStability(sent, now, signalOf) {
  const s = sent.filter(measured).slice().sort((a, b) => a.at - b.at);
  if (s.length < 2 * N_MIN_OUT) return { powered: false, shared: 0, rho: null, n: s.length };
  const mid = Math.floor(s.length / 2);
  const early = signalOf(s.slice(0, mid), now);   // Map key -> value
  const late = signalOf(s.slice(mid), now);
  const pairs = [];
  for (const [k, ev] of early) { const lv = late.get(k); if (lv != null) pairs.push([ev, lv]); }
  return { powered: pairs.length >= 2, shared: pairs.length, rho: pairs.length >= 2 ? spearman(pairs) : null, n: s.length };
}

const angleSignal = (slice, now) => new Map(learnFeatures(slice, now).angles.map((a) => [a.angle, a.rel]));
const accountSignal = (slice, now) => {
  const accts = aggregateAccounts(slice, now).accounts;
  return new Map(Object.values(accts).filter((a) => a.score != null).map((a) => [a.handle, a.score]));
};

const testT1 = (sent, now) => splitHalfStability(sent, now, angleSignal);
const testT2 = (sent, now) => splitHalfStability(sent, now, accountSignal);

// ---- synthetic fixtures (deterministic; seeded LCG so the noise case is reproducible) ----
function reply(at, author, angle, q, likes, followers = 1000) {
  return { at, author, angle, score: Math.max(0, Math.min(1, q)), ageMs: 20 * 60_000, followers,
    outcome: { at: at + 2 * DAY, likes, replies: Math.round(q * 5), views: likes * 12, frozen: true } };
}
/** Planted signal: alice>bob, story>ask, and score tracks fit — all three theories should PASS. */
function syntheticPositive(now) {
  const sent = [];
  const authors = ["alice", "bob"], angles = ["story", "ask"];
  let k = 0;
  // 24 replies per (day-half), balanced across the 2x2 cells, over days 40..1 ago
  for (let half = 0; half < 2; half++) {
    for (let i = 0; i < 24; i++, k++) {
      const author = authors[k % 2], angle = angles[(k >> 1) % 2];
      const q = (author === "alice" ? 0.6 : 0.2) + (angle === "story" ? 0.3 : 0.0) + ((i % 3) - 1) * 0.02;
      const at = now - (half === 0 ? 40 - i * 0.7 : 20 - i * 0.7) * DAY;
      sent.push(reply(at, author, angle, q, Math.round(q * 30)));
    }
  }
  return sent;
}
/** Noise: likes independent of score/angle/author — fitCorr must stay near 0 (no false positive). */
function syntheticNoise(now) {
  let seed = 987654321; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const sent = [];
  const authors = ["alice", "bob"], angles = ["story", "ask"];
  for (let i = 0; i < 60; i++) {
    const q = rnd(); // score = q, but likes are an INDEPENDENT random draw
    sent.push(reply(now - (55 - i * 0.8) * DAY, authors[i % 2], angles[(i >> 1) % 2], q, Math.round(rnd() * 30)));
  }
  return sent;
}

// ---- runners ----
function runSelfTest() {
  let pass = 0, fail = 0;
  const ok = (c, l) => { if (c) pass++; else { fail++; console.error("  FAIL:", l); } };
  const now = 1_700_000_000_000;

  // planted-signal case: all three theories detected
  const pos = syntheticPositive(now);
  const t3 = testT3(pos, now);
  ok(t3.nOut >= FIT_CORR_MIN_N, `T3 powered on synthetic (nOut=${t3.nOut})`);
  ok(t3.fitCorr != null && t3.fitCorr > 0.5, `T3 detects planted score->fit signal (fitCorr=${t3.fitCorr?.toFixed(2)})`);
  const fl = learnFeatures(pos, now);
  ok(fl.bestAngle === "story", `bestAngle picks the planted-strong angle (got ${fl.bestAngle})`);
  const t1 = testT1(pos, now);
  ok(t1.powered && t1.rho > 0.9, `T1 angle signal is stable across halves (rho=${t1.rho?.toFixed(2)}, shared=${t1.shared})`);
  const t2 = testT2(pos, now);
  ok(t2.powered && t2.rho > 0.9, `T2 account signal is stable across halves (rho=${t2.rho?.toFixed(2)}, shared=${t2.shared})`);

  // noise case: no manufactured correlation
  const noise = testT3(syntheticNoise(now), now);
  ok(noise.fitCorr != null && Math.abs(noise.fitCorr) < 0.5, `T3 does NOT manufacture signal on noise (fitCorr=${noise.fitCorr?.toFixed(2)})`);

  // underpowered case: honest "can't run", never a spurious pass
  const thin = syntheticPositive(now).slice(0, 5);
  ok(testT1(thin, now).powered === false, "T1 reports UNDERPOWERED on thin data (no spurious pass)");

  console.log(fail === 0 ? `\n✓ backtest self-test: ${pass} assertions passed` : `\n✗ backtest: ${fail} failed, ${pass} passed`);
  process.exit(fail === 0 ? 0 : 1);
}

function verdict(powered, rho, min = 0.2) {
  if (!powered) return "SHELVE (underpowered — keep flag OFF)";
  return rho >= min ? `PASS (predictive, rho=${rho.toFixed(2)})` : `SHELVE (no signal, rho=${rho.toFixed(2)})`;
}

function runRealData(path) {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const sent = raw?.replyLog?.sent ?? raw?.sent ?? [];
  const now = raw?.meta?.exportedAt || Date.now();
  const measuredN = sent.filter(measured).length, settledN = sent.filter(settled).length;

  console.log(`\n=== Goobi learning backtest — ${path} ===`);
  console.log(`replies logged: ${sent.length}   measured: ${measuredN}   SETTLED (frozen): ${settledN}`);
  if (settledN < FIT_CORR_MIN_N) {
    console.log(`\n⚠ Only ${settledN} settled outcomes (need >= ${FIT_CORR_MIN_N} for a trustworthy read).`);
    console.log(`  Keep replying + let outcomes settle (~2 days each), then re-export. Flag stays OFF.`);
  }
  const t3 = testT3(sent, now);
  console.log(`\nT3  current ranking predicts outcomes:`);
  console.log(`    fitCorr = ${t3.fitCorr == null ? "n/a (n<12)" : t3.fitCorr.toFixed(2)}   fitCorrViews = ${t3.fitCorrViews == null ? "n/a" : t3.fitCorrViews.toFixed(2)}   (nOut=${t3.nOut})`);
  const t1 = testT1(sent, now), t2 = testT2(sent, now);
  console.log(`\nT1  per-angle stability   (drafter nudge):   ${verdict(t1.powered, t1.rho)}   [shared angles=${t1.shared}]`);
  console.log(`T2  per-account stability (ranking mult):    ${verdict(t2.powered, t2.rho)}   [shared accounts=${t2.shared}]`);

  const t3pass = t3.fitCorr != null && t3.fitCorr >= 0.2;
  console.log(`\n→ Ranking multiplier (T2+T3): ${t3pass && t2.powered && t2.rho >= 0.2 ? "READY to flip ON" : "NOT YET — keep flag OFF"}`);
  console.log(`→ Drafter angle nudge (T1):   ${t1.powered && t1.rho >= 0.2 ? "READY to flip ON" : "NOT YET — keep flag OFF"}`);
}

const arg = process.argv[2];
if (arg) runRealData(arg); else runSelfTest();
