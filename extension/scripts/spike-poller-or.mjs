/**
 * SPIKE: does the twitter241 provider honor a batched `from:a OR from:b` Latest search?
 * This is the one open question gating the ambient target poller — the batched query makes it
 * ~5x cheaper (one search per dock-open instead of five). OPT-IN + spends a few governed-class
 * requests on YOUR RapidAPI key, so it is NOT part of any gate.
 *
 *   TWTTR_KEY=your-x-rapidapi-key node scripts/spike-poller-or.mjs --live --handles a,b,c
 *
 * (--handles is optional; defaults to three large, always-active accounts purely to test the
 *  SYNTAX. Use your real tracked targets for a realistic read.)
 * Without --live / a key it prints usage and exits 0. Cost: 1 batched search + up to 3
 * per-handle searches ≈ ~1.4 MB against the monthly byte budget — a one-off.
 *
 * VERDICT meanings:
 *   OR-HONORED  → wire the batched poller (selectPollBatch → one `from:a OR from:b …` query)
 *   OR-BROKEN   → the poller needs the per-handle path + the 12-min response cache instead
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as esbuild from "esbuild";

const LIVE = process.argv.includes("--live");
const KEY = process.env.TWTTR_KEY;
const HOST = "twitter241.p.rapidapi.com";
if (!LIVE || !KEY) {
  console.log(`Poller spike — does twitter241 honor "from:a OR from:b" batched searches? (opt-in)
  Run:  TWTTR_KEY=your-x-rapidapi-key node scripts/spike-poller-or.mjs --live --handles you,target1,target2
  One batched search + up to 3 per-handle control searches (~1.4 MB total, one-off).
  No --live or no key -> this no-op.`);
  process.exit(0);
}

const hArg = process.argv.find((a) => a.startsWith("--handles"));
const handles = (hArg ? (hArg.includes("=") ? hArg.split("=")[1] : process.argv[process.argv.indexOf(hArg) + 1]) : "elonmusk,naval,paulg")
  .split(",").map((h) => h.trim().replace(/^@+/, "").toLowerCase()).filter(Boolean).slice(0, 5);
if (handles.length < 2) { console.error("Need at least 2 handles to test OR batching."); process.exit(1); }

// Reuse the REAL parser so "works" means "works with our code", not just HTTP 200.
const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "../src/lib/twttr.ts"), "utf8");
const js = esbuild.transformSync(src, { loader: "ts", format: "esm" }).code;
const { parseTimelineTweets } = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));

async function search(query, count) {
  const qs = new URLSearchParams({ type: "Latest", count: String(count), query }).toString();
  const res = await fetch(`https://${HOST}/search-v3?${qs}`, { headers: { "Content-Type": "application/json", "x-rapidapi-key": KEY, "x-rapidapi-host": HOST } });
  const text = await res.text();
  if (!res.ok) return { ok: false, status: res.status, bytes: text.length, body: text.slice(0, 200) };
  let data; try { data = JSON.parse(text); } catch { return { ok: false, status: res.status, bytes: text.length, body: "unparseable JSON" }; }
  return { ok: true, status: res.status, bytes: text.length, tweets: parseTimelineTweets(data) };
}

const byAuthor = (tweets) => {
  const m = new Map();
  for (const t of tweets) { const a = (t.author || "?").toLowerCase(); m.set(a, (m.get(a) || 0) + 1); }
  return m;
};

console.log(`Testing OR batching across: ${handles.map((h) => "@" + h).join(", ")}\n`);

// 1) the batched query the poller would use
const batchedQ = handles.map((h) => `from:${h}`).join(" OR ");
const batch = await search(batchedQ, 20);
if (!batch.ok) {
  // An auth/subscription failure says NOTHING about OR syntax — never turn it into a build verdict.
  if (batch.status === 401 || batch.status === 403 || /not subscribed|invalid api key/i.test(batch.body || "")) {
    console.log(`Auth failed (HTTP ${batch.status}): ${batch.body}`);
    console.log(`\nVERDICT: KEY ERROR — that wasn't a real test. Use YOUR x-rapidapi-key (the one saved in`);
    console.log(`Goobi's settings / your goobi.local.json / rapidapi.com → My Apps), and your real tracked handles:`);
    console.log(`  TWTTR_KEY=<paste-your-actual-key> node scripts/spike-poller-or.mjs --live --handles real1,real2,real3`);
    process.exit(0);
  }
  console.log(`Batched query FAILED (HTTP ${batch.status}): ${batch.body}`);
  console.log(`\nVERDICT: OR-BROKEN (the batched form errors while auth works) — wire the poller on the per-handle path + the 12-min response cache.`);
  process.exit(0);
}
const bAuthors = byAuthor(batch.tweets);
console.log(`Batched  "${batchedQ.slice(0, 70)}${batchedQ.length > 70 ? "…" : ""}"`);
console.log(`  → ${batch.tweets.length} tweets, ${(batch.bytes / 1024).toFixed(0)} KB, authors: ${[...bAuthors.entries()].map(([a, n]) => `@${a}×${n}`).join(" ") || "(none parsed)"}`);

// 2) per-handle controls (up to 3) — proves each handle HAS recent content the batch should have found
const controls = new Map();
for (const h of handles.slice(0, 3)) {
  const r = await search(`from:${h}`, 5);
  controls.set(h, r.ok ? r.tweets.filter((t) => (t.author || "").toLowerCase() === h).length : -1);
  console.log(`Control  "from:${h}" → ${r.ok ? `${controls.get(h)} of their tweets, ${(r.bytes / 1024).toFixed(0)} KB` : `FAILED (HTTP ${r.status})`}`);
}

// 3) the verdict — the batch must return tweets from MULTIPLE requested authors, and must not
// have silently ignored the operator (which typically returns unrelated keyword-match noise).
const matched = handles.filter((h) => (bAuthors.get(h) || 0) > 0);
const strangers = [...bAuthors.keys()].filter((a) => !handles.includes(a)).length;
const activeControls = [...controls.values()].filter((n) => n > 0).length;
console.log("");
if (matched.length >= 2 && strangers <= Math.max(1, batch.tweets.length * 0.2)) {
  console.log(`VERDICT: OR-HONORED — the batch returned ${matched.length}/${handles.length} requested authors (${strangers} strangers).`);
  console.log(`→ Wire the batched poller: selectPollBatch → one "from:a OR from:b …" Latest search per dock-open (~${(batch.bytes / 1024).toFixed(0)} KB/open ≈ 1-3% of the monthly byte budget at 10-20 opens/day).`);
} else if (matched.length <= 1 && activeControls >= 2) {
  console.log(`VERDICT: OR-BROKEN — controls show ${activeControls} handles have recent tweets, but the batch surfaced only ${matched.length} (${strangers} stranger authors suggests keyword-noise fallback).`);
  console.log(`→ Wire the poller on the per-handle path (≤5 fetches/open via selectPollBatch) + the 12-min storage-backed response cache so remounts don't re-pay.`);
} else {
  console.log(`VERDICT: INCONCLUSIVE — batch matched ${matched.length} authors but only ${activeControls} controls have recent tweets (quiet accounts?). Re-run with handles you know posted in the last day or two.`);
}
console.log("");
