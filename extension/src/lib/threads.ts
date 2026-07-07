/**
 * "Tend your threads" — pure ranking of the people who replied to / mentioned YOU into a
 * prioritized to-tend queue. No DOM/chrome; unit-tested (scripts/test-threads.mjs). x-copilot
 * harvests the events from the notifications page (the same $0 scan the reciprocity panel uses)
 * and owns the render.
 *
 * WHY this is the highest-value surface we didn't cover: answering a reply on your own thread is
 * the single highest-ordered growth action in every evidence class. The 2026 ranker grades
 * author-engaged replies at the top, and keeping a conversation alive is exactly what the
 * conversation-serving path rewards — a reply you answer is far more likely to be the one branch
 * that dedup_conversation_filter promotes to For You. Practitioner consensus is unanimous too:
 * "answer your repliers within the hour."
 *
 * HONEST BY CONSTRUCTION:
 *  - The notifications DOM gives no parent-thread id, so we CANNOT group by which of your posts.
 *    Each row is "so-and-so replied to you", ranked freshest-first — a live thread is where a
 *    reply still travels; a 3-day-old one is cold, so it drops off the window entirely.
 *  - "tended" is a LOSSY handle+time inference (you sent a Goobi reply to that handle AFTER they
 *    engaged you — could be a reply on a different post). It is a soft de-emphasis, never a hard
 *    "answered" claim, and the copy says so. Same caveat class as learn-stats' authorReplied join.
 *  - Only reply + mention are tendable (a like/repost has nothing to answer); unknown signals stay
 *    neutral, never a penalty.
 */

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
export const TEND_WINDOW_MS = 3 * DAY_MS;       // older than this is cold — don't surface it
export const TEND_HALF_LIFE_MS = 6 * HOUR_MS;   // freshness weight halves every ~6h (a thread's live window)
export const TEND_RESPOND_WINDOW_MS = 48 * HOUR_MS; // a sent reply within this of their engagement counts as "tended"
export const PER_HANDLE_CAP = 2;                // one person can't flood the queue
const clamp = (x: number, lo: number, hi: number): number => Math.min(Math.max(x, lo), hi);

export type TendKind = "reply" | "mention" | "repost" | "like";
const KIND_W: Record<TendKind, number> = { reply: 1, mention: 0.85, repost: 0, like: 0 };

export interface InboundLite { at: number; handle: string; kind: TendKind; postId?: string; followers?: number; name?: string; avatar?: string; text?: string; }
export interface SentLite { author?: string; at: number; }
export type Freshness = "live" | "today" | "stale";
export interface TendRow extends InboundLite { priority: number; fresh: Freshness; ageLabel: string; tended: boolean; }

/** "23m ago" / "5h ago" / "2d ago" — the same terse style as the rest of the dock. */
export function ageLabel(ageMs: number): string {
  const m = Math.max(0, Math.round(ageMs / 60_000));
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
function freshnessOf(ageMs: number): Freshness {
  if (ageMs < 2 * HOUR_MS) return "live";
  if (ageMs < DAY_MS) return "today";
  return "stale";
}

/** Reach lift from the replier's follower count — a bigger account's thread exposes you to a
 *  bigger audience. Mild + log-scaled; unknown → neutral 1.0 (never penalize for missing data). */
function reachLift(followers?: number): number {
  if (followers == null || followers <= 0) return 1;
  return clamp(1 + 0.12 * (Math.log10(followers + 10) - 3), 0.85, 1.35);
}

/** Priority = freshness (dominant) × replier reach × kind. Higher = tend this sooner. */
export function tendPriority(r: InboundLite, now: number): number {
  const w = KIND_W[r.kind] ?? 0;
  if (w <= 0) return 0;
  const age = Math.max(0, now - r.at);
  const fresh = Math.pow(0.5, age / TEND_HALF_LIFE_MS);
  return fresh * reachLift(r.followers) * w;
}

/** Did you already engage this person back? Lossy: any Goobi-sent reply to that handle in the
 *  window AFTER they engaged you. Soft signal — the row is de-emphasized, never hidden as "done". */
function isTended(handle: string, at: number, sentByHandle: Map<string, number[]>): boolean {
  const times = sentByHandle.get(handle.toLowerCase());
  if (!times) return false;
  return times.some((t) => t > at && t - at <= TEND_RESPOND_WINDOW_MS);
}

/** Rank the inbound engagement into a to-tend queue. Freshest-first, tended rows sink, one handle
 *  can't take more than PER_HANDLE_CAP slots, cold events (outside the window) are dropped. */
export function rankThreads(inbound: InboundLite[], sent: SentLite[], now: number, max = 8): { rows: TendRow[]; total: number; untended: number } {
  const sentByHandle = new Map<string, number[]>();
  for (const s of sent) { if (!s.author) continue; const h = s.author.toLowerCase(); (sentByHandle.get(h) ?? sentByHandle.set(h, []).get(h)!).push(s.at); }

  const eligible = inbound.filter((e) => (e.kind === "reply" || e.kind === "mention") && e.handle && now - e.at <= TEND_WINDOW_MS && now - e.at >= 0);
  const rows: TendRow[] = eligible.map((e) => {
    const age = now - e.at;
    return { ...e, priority: tendPriority(e, now), fresh: freshnessOf(age), ageLabel: ageLabel(age), tended: isTended(e.handle, e.at, sentByHandle) };
  });
  const total = rows.length;
  const untended = rows.filter((r) => !r.tended).length;

  // sort: untended before tended, then by priority (freshness-dominant)
  rows.sort((a, b) => (Number(a.tended) - Number(b.tended)) || (b.priority - a.priority));

  // per-handle cap so one prolific replier can't dominate the queue
  const perHandle = new Map<string, number>();
  const capped: TendRow[] = [];
  for (const r of rows) {
    const h = r.handle.toLowerCase();
    const n = perHandle.get(h) ?? 0;
    if (n >= PER_HANDLE_CAP) continue;
    perHandle.set(h, n + 1);
    capped.push(r);
    if (capped.length >= max) break;
  }
  return { rows: capped, total, untended };
}
