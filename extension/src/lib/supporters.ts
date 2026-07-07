/**
 * The reciprocity / "who shows up for ME" engine — pure + unit-tested
 * (scripts/test-supporters.mjs). No DOM/chrome/fetch; x-copilot scrapes the notifications
 * page and owns the I/O.
 *
 * The honest core: we can only RELIABLY detect who REPLIES to or MENTIONS you (both render
 * as full tweet articles with a clean status id). Likes/reposts are lossy ("X and N others")
 * and locale-dependent, so they are captured best-effort as a "also liked" CONFIDENCE CHIP
 * and NEVER scored. Follows aren't detected at all in v1.
 *
 * Mirrors learn-stats.ts conventions (recency half-life, count-anchored shrinkage, min-N
 * gating) so the two halves — who you show up with (learn-stats) and who shows up for you
 * (here) — fuse into an honest MUTUAL score. This is relationship-mapping, not a like-for-
 * like pod: a reciprocal-ring detector exists precisely to refuse that pattern.
 */

const DAY_MS = 86_400_000;
const recencyW = (ageDays: number): number => Math.pow(0.5, Math.max(ageDays, 0) / 30); // HALF_LIFE_DAYS=30
const clamp = (x: number, lo: number, hi: number): number => Math.min(Math.max(x, lo), hi);

export const K = 5;            // shrinkage strength (pseudo-events toward the global mean)
export const N_MIN = 3;        // min scored events to rank/label an account
export const ROW_THIN = 3;
export const GLOBAL_THIN = 12; // below this many total scored events, show only "still learning"
export const FALLBACK_FOLLOWERS = 1000;
const HI = 0.5, LO = 0.2;      // mutual/fan/one-way thresholds on the squashed axes
const RING_WINDOW = 8, RING_PCT = 0.4; // closed-loop (pod) detector

export type EngagedKind = "reply" | "mention" | "repost" | "like";
const SCORED: Record<EngagedKind, boolean> = { reply: true, mention: true, repost: false, like: false };
const SUPPORT_W: Record<EngagedKind, number> = { reply: 2.0, mention: 2.0, repost: 0, like: 0 };

export interface EngagedRecord { at: number; handle: string; kind: EngagedKind; postId?: string; followers?: number; avatar?: string; name?: string; text?: string /* the reply/mention snippet — powers the "tend your threads" queue; optional so pre-existing records stay valid */; key: string; }
export interface SupporterAgg { handle: string; support: number; nSup: number; events: number; replies: number; mentions: number; likes: number; reposts: number; followers?: number; avatar?: string; name?: string; lastAt: number; }
export interface SupportResult { supporters: Record<string, SupporterAgg>; muSup: number; totalScored: number; }
export type Rel = "mutual" | "fan" | "one-way-you" | "acquaintance";

/** "Who shows up for you" — scored on reply+mention only; likes/reposts tallied for the chip. */
export function aggregateSupporters(inbound: EngagedRecord[], now: number): SupportResult {
  const by = new Map<string, EngagedRecord[]>();
  for (const e of inbound) (by.get(e.handle) ?? by.set(e.handle, []).get(e.handle)!).push(e);
  // global recency-weighted mean intensity over scored events (for shrinkage)
  let gw = 0, gwv = 0, totalScored = 0;
  for (const e of inbound) { if (!SCORED[e.kind]) continue; const w = recencyW((now - e.at) / DAY_MS); gw += w; gwv += w * SUPPORT_W[e.kind]; totalScored++; }
  const muSup = gw > 0 ? gwv / gw : 0;

  const supporters: Record<string, SupporterAgg> = {};
  for (const [handle, evs] of by) {
    let sw = 0, swv = 0, lastAt = 0, followers: number | undefined, fAt = -1, avatar: string | undefined, name: string | undefined;
    let replies = 0, mentions = 0, likes = 0, reposts = 0;
    for (const e of evs) {
      if (e.kind === "reply") replies++; else if (e.kind === "mention") mentions++; else if (e.kind === "like") likes++; else reposts++;
      if (e.at > lastAt) { lastAt = e.at; avatar = e.avatar ?? avatar; name = e.name ?? name; }
      if (e.followers != null && e.at >= fAt) { followers = e.followers; fAt = e.at; }
      if (!SCORED[e.kind]) continue;
      const w = recencyW((now - e.at) / DAY_MS); sw += w; swv += w * SUPPORT_W[e.kind];
    }
    if (sw <= 0) continue; // like/repost-only accounts can't be scored — they don't rank (honest)
    const intensity = swv / sw;
    const reachBoost = clamp(1 + 0.15 * (Math.log10((followers ?? FALLBACK_FOLLOWERS) + 10) - 3), 0.85, 1.4); // a whale can't crown
    const support = ((K * muSup + sw * intensity) / (K + sw)) * reachBoost; // count-anchored shrinkage
    supporters[handle] = { handle, support, nSup: sw, events: evs.length, replies, mentions, likes, reposts, followers, avatar, name, lastAt };
  }
  return { supporters, muSup, totalScored };
}

const conf = (n: number): 0 | 1 | 2 | 3 => (n >= 8 ? 3 : n >= 3 ? 2 : n >= 1 ? 1 : 0);
export interface SupporterRow extends SupporterAgg { confidence: 0 | 1 | 2 | 3; thin: boolean; }
export function rankSupporters(r: SupportResult, max = 5): { ranked: SupporterRow[]; learning: SupporterRow[]; totalScored: number } {
  const rows = Object.values(r.supporters).map((s) => ({ ...s, confidence: conf(s.nSup), thin: s.nSup < ROW_THIN }));
  const ranked = rows.filter((s) => s.nSup >= N_MIN).sort((a, b) => b.support - a.support || b.nSup - a.nSup);
  const learning = rows.filter((s) => s.nSup < N_MIN).sort((a, b) => b.nSup - a.nSup);
  return { ranked: ranked.slice(0, max), learning, totalScored: r.totalScored };
}

/** Cohort-invariant squash: x/(x+ref) with a FIXED reference (the global mean), so a pair's
 *  label can't shift just because an unrelated account joins the cohort. */
const squash = (x: number, ref: number): number => (x + ref <= 0 ? 0 : Math.max(x, 0) / (Math.max(x, 0) + Math.max(ref, 1e-9)));
export interface InvestLike { accounts: Record<string, { invest: number; nEff: number }>; muInvest: number; }
export interface MutualInfo { rel: Rel; mutual: number; balance: number; }

/** Fuse "who you show up with" (learn-stats invest) with "who shows up for you" (support)
 *  into a stable relationship label per handle. Both sides gated by N_MIN before a claim. */
export function fuseMutual(inv: InvestLike, sup: SupportResult): Record<string, MutualInfo> {
  const out: Record<string, MutualInfo> = {};
  const handles = new Set([...Object.keys(inv.accounts), ...Object.keys(sup.supporters)]);
  for (const h of handles) {
    const a = inv.accounts[h]; const s = sup.supporters[h];
    const nInvest = a?.nEff ?? 0, nSup = s?.nSup ?? 0;
    const investN = squash(a?.invest ?? 0, inv.muInvest);
    const supportN = squash(s?.support ?? 0, sup.muSup);
    let rel: Rel = "acquaintance";
    if (investN >= HI && supportN >= HI && nInvest >= N_MIN && nSup >= N_MIN) rel = "mutual";
    else if (supportN >= HI && investN < LO && nSup >= N_MIN) rel = "fan";
    else if (investN >= HI && supportN < LO && nInvest >= N_MIN) rel = "one-way-you";
    out[h] = { rel, mutual: Math.sqrt(Math.max(investN, 0) * Math.max(supportN, 0)), balance: supportN - investN };
  }
  return out;
}

/** Reply cadence with one account (this week vs last), suppressed when the log is truncated. */
export function cadence(inbound: EngagedRecord[], handle: string, now: number, truncated: boolean): "up" | "flat" | "down" | null {
  if (truncated) return null;
  let last = 0, prev = 0;
  for (const e of inbound) { if (e.handle !== handle || !SCORED[e.kind]) continue; const d = (now - e.at) / DAY_MS; if (d < 7) last++; else if (d < 14) prev++; }
  if (!last && !prev) return null;
  if (!prev) return "up";
  const r = last / prev; return r >= 1.2 ? "up" : r <= 0.8 ? "down" : "flat";
}

/** The anti-pod guard: a CLOSED LOOP — a big share of your recent replies go to accounts who
 *  recently engaged you. X reads that as a coordinated pod and throttles everyone in it. */
export function reciprocalConcentration(inbound: EngagedRecord[], outboundHandles: string[], now: number, sinceDays = 30): { pct: number; count: number } | null {
  const recent = outboundHandles.slice(-RING_WINDOW);
  if (recent.length < RING_WINDOW) return null;
  const supporters = new Set(inbound.filter((e) => SCORED[e.kind] && (now - e.at) / DAY_MS <= sinceDays).map((e) => e.handle));
  const loop = recent.filter((h) => supporters.has(h)).length;
  const pct = loop / recent.length;
  return pct >= RING_PCT ? { pct, count: loop } : null;
}
