/**
 * The "accounts you show up with" daily-scan learning loop — pure + unit-tested
 * (scripts/test-learn-stats.mjs). No chrome/DOM/fetch; x-copilot owns the I/O.
 *
 * Two tiers on one code path, both honest about what they measure:
 *  - TIER-1 "investment": where you put your replies, weighted by reply quality
 *    (effectiveScore) and recency. Zero API cost — from data we already log. This is
 *    EFFORT, not payoff: "who you show up with", never "who pays off".
 *  - TIER-2 "measured": once the daily measure-pass matches your replies back to
 *    user-replies-v2 and writes real likes/replies into SentRecord.outcome, an account
 *    earns a reach-normalized engagement score. This is the real "do well with" signal.
 *
 * Honesty is structural: small samples are shrunk to the global mean (no crowning an
 * account off one lucky reply), thin accounts are gated out of the ranking, and a
 * measured `score` is NEVER imputed — it stays undefined until enough settled outcomes
 * exist. Replying to someone does not CAUSE them to engage; the surface says so.
 */

// ---- tunable constants (reasoned, not yet calibrated — retunable over surviving history) ----
export const HALF_LIFE_DAYS = 30;   // recency half-life for a reply's weight
export const DECAY = 0.97;          // per-elapsed-day decay applied to surviving aggregates
export const K = 5;                 // shrinkage strength (pseudo-replies pulling toward the global mean)
export const N_MIN = 3;             // min effective replies to rank a Tier-1 account
export const N_MIN_OUT = 4;         // min settled outcomes to show a Tier-2 measured score
export const W_REPLY = 2.0;         // a reply on your reply is worth this many likes
export const BASE = 0.5;            // reach-normalization base
export const MIN_EXP = 0.5;         // floor on expected engagement (avoid divide-by-tiny)
export const NEUTRAL_SCORE = 0.5;   // reply with no known effectiveScore counts as neutral, never 0
export const FALLBACK_FOLLOWERS = 1000; // imputed when the author's follower count is unknown
export const SNAP_RETENTION_DAYS = 60;
export const ACCT_MAX = 200;        // cap the per-account table
export const GLOBAL_THIN = 12;      // below this many total replies, show only "still learning"
export const ROW_THIN = 3;          // below this many replies to an account, tag the row "(thin)"
export const CONC_WINDOW = 20;      // recent-replies window for the single-target spread nudge
export const CONC_PCT = 0.4;        // ≥40% of recent replies to one account → spread nudge
export const MATCH_SIM = 0.6;       // token-Jaccard threshold to match a fetched reply to a stored one
export const MATCH_WINDOW_MS = 72 * 3_600_000;
const DAY_MS = 86_400_000;

// ---- shapes (structural — x-copilot's SentRecord / OwnPost satisfy these) ----
export interface LearnReply {
  at: number;
  author?: string;
  score?: number;       // effectiveScore (0..1) of the opportunity
  followers?: number;
  norm?: string;        // normalized reply text (for match-back)
  snippet?: string;
  outcome?: { at: number; likes?: number; replies?: number };
}
export interface OwnStat { id: string; views?: number; likes?: number; reposts?: number; replies?: number; }
export interface PostMetrics { views: number; likes: number; reposts: number; replies: number; }
export interface DailyDelta { posts: number; views: number; likes: number; reposts: number; replies: number; hadViews: boolean; topPostId?: string; }
export interface AccountAgg {
  handle: string;
  replies: number;      // attributed reply count (display)
  nEff: number;         // recency-weighted sample size
  invest: number;       // Tier-1 shrunken mean reply-quality
  followers?: number;
  nOut: number;         // settled outcomes folded in
  score?: number;       // Tier-2 measured score — undefined until nOut >= N_MIN_OUT
  lastAt: number;
}
export interface AccountRow extends AccountAgg { tier: "measured" | "invest"; confidence: 0 | 1 | 2 | 3; share: number; thin: boolean; }

const recencyW = (ageDays: number): number => Math.pow(0.5, Math.max(ageDays, 0) / HALF_LIFE_DAYS);
const expected = (followers: number): number => BASE * Math.log10(followers + 10);

/** Per-post POSITIVE delta vs the last read — keyed by post id so the sliding newest-15
 *  window can't produce negative/spurious days. New posts seed a baseline (contribute 0). */
export function foldOwnDelta(prevById: Record<string, PostMetrics>, today: OwnStat[]): { delta: DailyDelta; nextPrev: Record<string, PostMetrics> } {
  const nextPrev: Record<string, PostMetrics> = {};
  const delta: DailyDelta = { posts: today.length, views: 0, likes: 0, reposts: 0, replies: 0, hadViews: false };
  let topGrowth = -1;
  for (const p of today) {
    const cur: PostMetrics = { views: p.views ?? 0, likes: p.likes ?? 0, reposts: p.reposts ?? 0, replies: p.replies ?? 0 };
    nextPrev[p.id] = cur;
    if (p.views != null) delta.hadViews = true;
    const prev = prevById[p.id];
    if (!prev) continue; // first-seen → baseline only
    const dv = Math.max(0, cur.views - prev.views);
    delta.views += dv;
    delta.likes += Math.max(0, cur.likes - prev.likes);
    delta.reposts += Math.max(0, cur.reposts - prev.reposts);
    delta.replies += Math.max(0, cur.replies - prev.replies);
    if (dv > topGrowth) { topGrowth = dv; delta.topPostId = p.id; }
  }
  return { delta, nextPrev };
}

export interface AggResult { accounts: Record<string, AccountAgg>; muInvest: number; muObs: number; attributed: number; unattributed: number; }

/** Recompute every account's aggregates from the immutable reply log (idempotent — no
 *  accumulator to corrupt). Recency-weighted, shrunk to the global mean, min-N gated. */
export function aggregateAccounts(sent: LearnReply[], now: number): AggResult {
  const byAuthor = new Map<string, LearnReply[]>();
  let unattributed = 0, attributed = 0;
  for (const r of sent) {
    if (!r.author) { unattributed++; continue; }
    attributed++;
    (byAuthor.get(r.author) ?? byAuthor.set(r.author, []).get(r.author)!).push(r);
  }
  // global means (within each tier) for shrinkage
  let gw = 0, gwv = 0, gwo = 0, gwf = 0;
  for (const r of sent) {
    if (!r.author) continue;
    const w = recencyW((now - r.at) / DAY_MS);
    gw += w; gwv += w * (r.score ?? NEUTRAL_SCORE);
    if (r.outcome) { const fit = ((r.outcome.likes ?? 0) + W_REPLY * (r.outcome.replies ?? 0)) / Math.max(expected(r.followers ?? FALLBACK_FOLLOWERS), MIN_EXP); gwo += w * fit; gwf += w; }
  }
  const muInvest = gw > 0 ? gwv / gw : NEUTRAL_SCORE;
  const muObs = gwf > 0 ? gwo / gwf : 0;

  const accounts: Record<string, AccountAgg> = {};
  for (const [handle, reps] of byAuthor) {
    let sw = 0, swv = 0, swfit = 0, swo = 0, nOut = 0, lastAt = 0, followers: number | undefined, fAt = -1;
    for (const r of reps) {
      const w = recencyW((now - r.at) / DAY_MS);
      sw += w; swv += w * (r.score ?? NEUTRAL_SCORE);
      if (r.at > lastAt) lastAt = r.at;
      if (r.followers != null && r.at >= fAt) { followers = r.followers; fAt = r.at; }
      if (r.outcome) { const fit = ((r.outcome.likes ?? 0) + W_REPLY * (r.outcome.replies ?? 0)) / Math.max(expected(r.followers ?? FALLBACK_FOLLOWERS), MIN_EXP); swfit += w * fit; swo += w; nOut++; }
    }
    const invest = (K * muInvest + sw * (swv / sw)) / (K + sw);
    const obs = swo > 0 ? (K * muObs + swo * (swfit / swo)) / (K + swo) : undefined;
    accounts[handle] = { handle, replies: reps.length, nEff: sw, invest, followers, nOut, score: nOut >= N_MIN_OUT ? obs : undefined, lastAt };
  }
  return { accounts, muInvest, muObs, attributed, unattributed };
}

const conf = (n: number): 0 | 1 | 2 | 3 => (n >= 8 ? 3 : n >= 3 ? 2 : n >= 1 ? 1 : 0);

/** Rank accounts: measured score first (when present), else investment; thin accounts
 *  (below the min-N gate) drop to a separate "still learning" bucket — never ranked. */
export function rankAccounts(agg: AggResult, max = 5): { ranked: AccountRow[]; learning: AccountRow[]; totalReplies: number } {
  const rows = Object.values(agg.accounts);
  const totalReplies = rows.reduce((a, r) => a + r.replies, 0) || 1;
  const toRow = (a: AccountAgg): AccountRow => ({ ...a, tier: a.score != null ? "measured" : "invest", confidence: conf(a.nEff), share: a.replies / totalReplies, thin: a.replies < ROW_THIN });
  const eligible = rows.filter((a) => a.score != null || a.nEff >= N_MIN).map(toRow);
  const learning = rows.filter((a) => a.score == null && a.nEff < N_MIN).map(toRow);
  eligible.sort((x, y) => (y.score ?? y.invest) - (x.score ?? x.invest) || y.nEff - x.nEff);
  learning.sort((x, y) => y.nEff - x.nEff);
  return { ranked: eligible.slice(0, max), learning, totalReplies: rows.reduce((a, r) => a + r.replies, 0) };
}

/** If one account hogs your recent replies, surface a SPREAD nudge (anti single-target-bot).
 *  Never a "double down" — the only safe direction is more variety. */
export function concentration(sent: LearnReply[], window = CONC_WINDOW): { handle: string; pct: number } | null {
  const recent = sent.filter((r) => r.author).slice(-window);
  if (recent.length < window) return null;
  const counts: Record<string, number> = {};
  for (const r of recent) counts[r.author!] = (counts[r.author!] || 0) + 1;
  let top = "", n = 0;
  for (const [h, c] of Object.entries(counts)) if (c > n) { top = h; n = c; }
  const pct = n / recent.length;
  return pct >= CONC_PCT ? { handle: top, pct } : null;
}

/** Reply-cadence trend with this account: last 7d vs the prior 7d. Returns null when the
 *  window isn't reliably covered (e.g. the log FIFO may have evicted older days). */
export function cadenceTrend(sent: LearnReply[], handle: string, now: number, logTruncated: boolean): "up" | "flat" | "down" | null {
  if (logTruncated) return null;
  let last = 0, prev = 0;
  for (const r of sent) {
    if (r.author !== handle) continue;
    const ageD = (now - r.at) / DAY_MS;
    if (ageD < 7) last++; else if (ageD < 14) prev++;
  }
  if (prev === 0 && last === 0) return null;
  if (prev === 0) return "up";
  const ratio = last / prev;
  return ratio >= 1.2 ? "up" : ratio <= 0.8 ? "down" : "flat";
}

// ---- Tier-2 match-back (pure): map fetched user-replies-v2 tweets to stored replies ----
const tokens = (s: string): Set<string> => new Set((s || "").toLowerCase().replace(/https?:\/\/\S+/g, "").replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2));
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0; for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}
export interface FetchedReply { text: string; at?: number; likes?: number; replies?: number; }
export interface OutcomeMatch { index: number; likes: number; replies: number; }
/** For each fetched reply, find the single best-matching stored reply (by text Jaccard,
 *  within a time window, with a unique winner). Returns outcomes to write, keyed by index
 *  into `sent`. Ambiguous matches are dropped, never guessed. */
export function matchOutcomes(fetched: FetchedReply[], sent: LearnReply[]): OutcomeMatch[] {
  const out: OutcomeMatch[] = [];
  const used = new Set<number>();
  const sentTok = sent.map((s) => tokens(s.norm || s.snippet || ""));
  for (const f of fetched) {
    const ft = tokens(f.text);
    let best = -1, bestSim = 0, second = 0;
    for (let i = 0; i < sent.length; i++) {
      if (used.has(i)) continue;
      if (f.at != null && sent[i].at != null && Math.abs(f.at - sent[i].at) > MATCH_WINDOW_MS) continue;
      const sim = jaccard(ft, sentTok[i]);
      if (sim > bestSim) { second = bestSim; bestSim = sim; best = i; }
      else if (sim > second) second = sim;
    }
    if (best >= 0 && bestSim >= MATCH_SIM && bestSim - second >= 0.15) { // unique-winner margin — wide enough that two similar replies to DIFFERENT accounts don't cross-attribute
      used.add(best);
      out.push({ index: best, likes: f.likes ?? 0, replies: f.replies ?? 0 });
    }
  }
  return out;
}

/* RESERVED — intentionally uncalled by the live wiring. The dock recomputes aggregates from
 * the immutable reply log on every render (idempotent), so there is no persisted accumulator
 * to decay or prune. These (+ the DECAY / ACCT_MAX constants) exist for a future persisted-
 * aggregate path; don't wire them in without switching to a stored, mutated table. */

/** Apply elapsed-day decay to surviving aggregates (gap-correct: away-then-return cools). */
export function decayAccounts(accounts: Record<string, AccountAgg>, gapDays: number): void {
  if (gapDays <= 0) return;
  const f = Math.pow(DECAY, gapDays);
  for (const a of Object.values(accounts)) { a.invest *= f; a.nEff *= f; }
}

/** Evict the lowest-nEff accounts so the table stays bounded. */
export function pruneAccounts(accounts: Record<string, AccountAgg>, max = ACCT_MAX): void {
  const keys = Object.keys(accounts);
  if (keys.length <= max) return;
  keys.sort((a, b) => accounts[a].nEff - accounts[b].nEff);
  for (const k of keys.slice(0, keys.length - max)) delete accounts[k];
}

/* ---------- account trend: is this account actually PICKING UP? ---------- */
// The momentum meter scores today's EFFORT (activity + streak). This is the OUTCOME half: over
// the daily snaps we already collect, are your posts earning more per post than they did last
// week? Honest by construction: it compares your last 7 days against the prior 7, needs real
// data in BOTH windows before it claims anything (else null — "still collecting"), prefers
// X-reported views and falls back to engagement, and reports the measured numbers, never a
// score. Consistency helps through real mechanisms (repeat engagement compounds per-user
// affinity + account reputation) — there is NO literal "streak bonus" in the ranker, so this
// deliberately measures results, not activity.

/** Same LOCAL-date key format as x-copilot's dayKey — keys must match the snaps' keys exactly. */
export function dayKeyLocal(ts: number): string {
  const d = new Date(ts); const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export interface TrendSnap extends DailyDelta { day: string; followers?: number; }
export interface AccountTrend {
  state: "picking-up" | "steady" | "cooling";
  metric: "views" | "engagement";   // what the comparison is based on
  nowPer: number;                    // per-post average, trailing 7d
  prevPer: number;                   // per-post average, the 7d before that
  nowPosts: number; prevPosts: number;
  followerDelta?: number;            // measured follower change across the 14d window (when known)
}

const TREND_MIN_POSTS = 2;   // per window — below this a per-post average is noise
const TREND_UP = 1.25, TREND_DOWN = 0.8;

export function accountTrend(snaps: Record<string, TrendSnap>, now: number): AccountTrend | null {
  const lastKeys = new Set<string>(), prevKeys = new Set<string>();
  for (let i = 0; i < 7; i++) lastKeys.add(dayKeyLocal(now - i * DAY_MS));
  for (let i = 7; i < 14; i++) prevKeys.add(dayKeyLocal(now - i * DAY_MS));
  const win = (keys: Set<string>) => {
    let posts = 0, views = 0, viewPosts = 0, eng = 0;
    for (const k of keys) {
      const sn = snaps[k]; if (!sn) continue;
      posts += sn.posts; eng += sn.likes + sn.reposts + sn.replies;
      if (sn.hadViews) { views += sn.views; viewPosts += sn.posts; }
    }
    return { posts, views, viewPosts, eng };
  };
  const a = win(lastKeys), b = win(prevKeys);
  // Prefer views-per-post (X-reported reach); fall back to engagement-per-post; else no claim.
  let metric: "views" | "engagement"; let nowPer: number; let prevPer: number;
  if (a.viewPosts >= TREND_MIN_POSTS && b.viewPosts >= TREND_MIN_POSTS) {
    metric = "views"; nowPer = a.views / a.viewPosts; prevPer = b.views / b.viewPosts;
  } else if (a.posts >= TREND_MIN_POSTS && b.posts >= TREND_MIN_POSTS) {
    metric = "engagement"; nowPer = a.eng / a.posts; prevPer = b.eng / b.posts;
  } else return null; // not enough posts in both windows — say nothing rather than guess
  const state: AccountTrend["state"] = prevPer <= 0
    ? (nowPer > 0 ? "picking-up" : "steady")
    : nowPer / prevPer >= TREND_UP ? "picking-up" : nowPer / prevPer <= TREND_DOWN ? "cooling" : "steady";
  // Follower delta: earliest vs latest follower snapshot in the 14d window, only over a real span.
  let followerDelta: number | undefined;
  const withF = Object.values(snaps)
    .filter((sn) => sn.followers != null && (lastKeys.has(sn.day) || prevKeys.has(sn.day)))
    .sort((x, y) => (x.day < y.day ? -1 : 1));
  if (withF.length >= 2 && withF[0].day !== withF[withF.length - 1].day) {
    followerDelta = (withF[withF.length - 1].followers as number) - (withF[0].followers as number);
  }
  return { state, metric, nowPer, prevPer, nowPosts: a.posts, prevPosts: b.posts, followerDelta };
}
