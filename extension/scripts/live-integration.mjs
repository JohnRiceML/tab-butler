/**
 * LIVE integration test — verifies the provider-facing assumptions everything rests on, against
 * the REAL twitter241 API with the REAL parsers. OPT-IN (can spend roughly 3–6 MB per uncached run).
 *
 *   TWTTR_KEY=your-x-rapidapi-key node scripts/live-integration.mjs --live
 *
 * What it verifies (each was an untested assumption flagged by the audits):
 *   A. OR-TOPIC queries: nicheSearchQuery ships `(topic a) OR (topic b)` to ALL THREE search
 *      paths — does the provider actually honor it? (The poller spike proved `from:` ORs are
 *      broken; topic ORs were never tested.)
 *   B. Field coverage on search results: % with followers (gates follower-normalization),
 *      views, lang, postedAt (gates recency windows + freshness).
 *   C. The heavy-hitter Top query (OR-form, operator-free — Top rejects operators) returns a
 *      usable pool.
 *   D. parseUser on /user: id/handle/followers/following/bio (gates reach enrichment + voice).
 *   E. user-replies-v2: do REPLY payloads carry views/likes/id? (gates fitCorrViews + the
 *      outcome upgrade + future comments-on-your-reply ground truth.)
 *   F. Direct `from:<handle>` searches return exact-author originals with the live fields the
 *      private Massive watchlist requires.
 * Without --live / a key it prints usage and exits 0.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as esbuild from "esbuild";

const LIVE = process.argv.includes("--live");
const KEY = process.env.TWTTR_KEY;
const HOST = "twitter241.p.rapidapi.com";
if (!LIVE || !KEY) {
  console.log(`Live integration test (opt-in, roughly 3–6 MB of provider transfer per uncached run).
  Run:  TWTTR_KEY=your-x-rapidapi-key node scripts/live-integration.mjs --live
  Verifies OR-topic search handling, payload field coverage, the heavy-hitter query form,
  parseUser, and reply-payload views — the provider-facing assumptions the audits flagged.`);
  process.exit(0);
}

const here = dirname(fileURLToPath(import.meta.url));
const load = async (rel) => {
  const src = readFileSync(join(here, rel), "utf8");
  const js = esbuild.transformSync(src, { loader: "ts", format: "esm" }).code;
  return import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));
};
const { parseTimelineTweets, parseUser, nicheSearchQuery } = await load("../src/lib/twttr.ts");

let spent = 0;
async function get(path, query) {
  const qs = new URLSearchParams(query).toString();
  const res = await fetch(`https://${HOST}/${path}?${qs}`, { headers: { "Content-Type": "application/json", "x-rapidapi-key": KEY, "x-rapidapi-host": HOST } });
  const text = await res.text();
  spent += text.length;
  if (!res.ok) return { ok: false, status: res.status, body: text.slice(0, 160) };
  try { return { ok: true, data: JSON.parse(text), bytes: text.length }; } catch { return { ok: false, status: res.status, body: "unparseable" }; }
}
const pct = (n, d) => (d ? `${Math.round((100 * n) / d)}%` : "n/a");
const results = [];
const verdict = (name, pass, detail) => { results.push({ name, pass, detail }); console.log(`${pass === true ? "✅" : pass === false ? "❌" : "⚠️ "} ${name}: ${detail}`); };

// Fail fast before a multi-call test. Missing subscription is not a query/parser failure, and
// continuing only turns the first honest 403 into misleading 429 noise.
const preflight = await get("user", { username: "naval" });
if (!preflight.ok) {
  const auth = preflight.status === 401 || preflight.status === 403;
  console.log(`${auth ? "⛔" : "⚠️"} Provider preflight failed (HTTP ${preflight.status ?? "?"}): ${preflight.body || "no response detail"}`);
  console.log(auth
    ? "VERDICT: SUBSCRIPTION BLOCKED — update the stored key/subscription for twitter241 before judging search quality. No further calls made."
    : preflight.status === 429
      ? "VERDICT: PROVIDER RATE-LIMITED — wait for the plan rate window, then rerun. No search claim was tested."
      : "VERDICT: PROVIDER UNAVAILABLE — no search/parser claim was tested.");
  process.exit(0);
}

// ---------- A. OR-topic search handling ----------
{
  const qA = "indie saas", qB = "ai agents";
  const a = await get("search-v3", { type: "Latest", count: "20", query: qA });
  const b = await get("search-v3", { type: "Latest", count: "20", query: qB });
  const or = await get("search-v3", { type: "Latest", count: "20", query: nicheSearchQuery(`${qA}, ${qB}`) }); // the REAL query builder → "((indie saas) OR (ai agents))"
  if (!a.ok || !b.ok || !or.ok) {
    verdict("A. OR-topic query", null, `fetch failed (a:${a.status ?? "ok"} b:${b.status ?? "ok"} or:${or.status ?? "ok"}) — cannot judge`);
  } else {
    const tA = parseTimelineTweets(a.data), tB = parseTimelineTweets(b.data), tOr = parseTimelineTweets(or.data);
    const hasA = (t) => /saas|indie/i.test(t.text), hasB = (t) => /\bagent|\bai\b/i.test(t.text);
    const orA = tOr.filter(hasA).length, orB = tOr.filter(hasB).length;
    console.log(`   plain "${qA}": ${tA.length} tweets · plain "${qB}": ${tB.length} · OR-form: ${tOr.length} (≈${orA} match A-terms, ≈${orB} match B-terms)`);
    if (tOr.length === 0 && (tA.length > 3 || tB.length > 3)) verdict("A. OR-topic query", false, "OR-form returns NOTHING while plain topics return plenty — the parenthesized OR is rejected; niche searches are degraded");
    else if (orA > 0 && orB > 0) verdict("A. OR-topic query", true, `both topics present in the OR results — the provider honors topic ORs`);
    else if (tOr.length > 0) verdict("A. OR-topic query", null, `OR returns results but skewed to one topic (${orA}/${orB}) — could be volume imbalance; not clearly broken`);
    else verdict("A. OR-topic query", null, "all queries thin — quiet topics, rerun later");
  }
}

// ---------- B. field coverage on search results ----------
{
  const r = await get("search-v3", { type: "Latest", count: "40", query: "indie saas lang:en -filter:replies -filter:retweets" });
  if (!r.ok) verdict("B. search field coverage", null, `fetch failed (${r.status})`);
  else {
    const ts = parseTimelineTweets(r.data);
    const f = ts.filter((t) => t.followers != null && t.followers > 0).length;
    const v = ts.filter((t) => t.views != null && t.views > 0).length;
    const p = ts.filter((t) => t.postedAt != null).length;
    const l = ts.filter((t) => t.lang != null).length;
    const detail = `${ts.length} parsed · followers ${pct(f, ts.length)} · views ${pct(v, ts.length)} · postedAt ${pct(p, ts.length)} · lang ${pct(l, ts.length)}`;
    // follower-normalization needs a majority with followers (audit PI-3's pass bar)
    verdict("B. search field coverage", ts.length > 0 && f / Math.max(1, ts.length) > 0.5, detail + (f / Math.max(1, ts.length) > 0.5 ? " — follower-normalization is LIVE" : " — followers mostly missing: normalization silently degrades to the median fallback"));
  }
}

// ---------- C. the heavy-hitter Top form ----------
{
  // Top REJECTS operators (live-verified) — this mirrors the real findHeavyHitters form (OR only).
  const q = nicheSearchQuery("indie saas, build in public");
  const r = await get("search-v3", { type: "Top", count: "40", query: q });
  if (!r.ok) verdict("C. heavy-hitter Top query", r.status === 429 ? null : false, `the hardened Top form errors (${r.status})${r.status === 429 ? " — provider rate limit, query not judged" : " — findHeavyHitters would toast-fail"}`);
  else {
    const ts = parseTimelineTweets(r.data);
    const withF = ts.filter((t) => t.followers != null && t.followers > 0).length;
    verdict("C. heavy-hitter Top query", ts.length >= 5, `${ts.length} Top posts parsed, ${withF} with followers → engRate pool ${ts.length >= 5 ? "healthy" : "thin"}`);
  }
}

// ---------- D. parseUser ----------
{
  const r = preflight;
  if (!r.ok) verdict("D. /user + parseUser", false, `fetch failed (${r.status})`);
  else {
    const u = parseUser(r.data);
    const fields = [u?.id && "id", u?.handle && "handle", u?.followers != null && "followers", u?.following != null && "following", u?.bio && "bio"].filter(Boolean);
    verdict("D. /user + parseUser", !!(u?.id && u?.followers != null), `fields present: ${fields.join(", ") || "NONE"} (followers=${u?.followers ?? "?"})`);
    globalThis.__uid = u?.id;
  }
}

// ---------- F. exact-handle Fresh Reach checks ----------
{
  const argAt = process.argv.findIndex((arg) => arg === "--handles" || arg.startsWith("--handles="));
  const raw = argAt >= 0
    ? (process.argv[argAt].includes("=") ? process.argv[argAt].split("=")[1] : process.argv[argAt + 1])
    : "elonmusk,MKBHD";
  const handles = String(raw || "").split(",").map((handle) => handle.trim().replace(/^@+/, "").toLowerCase()).filter((handle) => /^[a-z0-9_]{1,15}$/.test(handle)).slice(0, 4);
  for (const handle of handles) {
    const r = await get("search-v3", { type: "Latest", count: "10", query: `from:${handle}` });
    if (!r.ok) { verdict(`F. direct @${handle}`, r.status === 429 ? null : false, `fetch failed (${r.status})`); continue; }
    const exact = parseTimelineTweets(r.data).filter((tweet) => tweet.author.toLowerCase() === handle && !tweet.isReply);
    const usable = exact.filter((tweet) => tweet.postedAt != null && tweet.replies != null && tweet.followers != null);
    verdict(`F. direct @${handle}`, exact.length ? usable.length > 0 : null,
      `${exact.length} recent originals · ${usable.length} with age + replies + followers${exact.length ? "" : " (account may simply have no recent original in the provider window)"}`);
  }
}

// ---------- E. user-replies-v2 reply payloads ----------
{
  const uid = globalThis.__uid;
  if (!uid) verdict("E. user-replies-v2", null, "skipped — no user id from D");
  else {
    const r = await get("user-replies-v2", { user: uid, count: "80" });
    if (!r.ok) verdict("E. user-replies-v2", false, `fetch failed (${r.status})`);
    else {
      const ts = parseTimelineTweets(r.data).filter((t) => t.isReply);
      const v = ts.filter((t) => t.views != null && t.views > 0).length;
      const lk = ts.filter((t) => t.likes != null).length;
      const id = ts.filter((t) => t.id).length;
      const detail = `${ts.length} replies parsed · views ${pct(v, ts.length)} · likes ${pct(lk, ts.length)} · id ${pct(id, ts.length)}`;
      verdict("E. reply views (fitCorrViews gate)", ts.length > 0 && v / Math.max(1, ts.length) > 0.5, detail + (v / Math.max(1, ts.length) > 0.5 ? " — the views-outcome upgrade is fed" : " — reply views mostly ABSENT: fitCorrViews will stay silent; likes-based outcomes remain primary"));
    }
  }
}

console.log(`\n=== ${results.filter((r) => r.pass === true).length} pass · ${results.filter((r) => r.pass === false).length} fail · ${results.filter((r) => r.pass === null).length} inconclusive · ~${(spent / 1024).toFixed(0)} KB spent ===`);
