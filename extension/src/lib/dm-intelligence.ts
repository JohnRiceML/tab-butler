/** Small, deterministic intelligence layer for the DM workspace. No network or model calls. */
import { DM_INTENT_LABEL, canMarkDmSend, canMoveDmReady, type DmCandidate, type DmIntent, type DmSource, type DmStore, type DmTouch } from "./dm-workspace";

export type DmNextActionKind = "reply" | "follow_up" | "draft_first" | "mark_ready" | "add_context";
export interface DmNextAction { handle: string; kind: DmNextActionKind; label: string; why: string; priority: number; }
export interface DmIntentMetric { intent: DmIntent; sent: number; replies: number; wins: number; replyRate: number; }
export interface DmSourceMetric { source: DmSource; sent: number; replies: number; wins: number; replyRate: number; }
export interface DmMetrics {
  firstSent: number; replied: number; conversations: number; wins: number; replyRate: number;
  warmSent: number; warmReplies: number; researchSent: number; researchReplies: number;
  byIntent: DmIntentMetric[]; topIntent?: DmIntentMetric; bySource: DmSourceMetric[]; topSource?: DmSourceMetric; insight: string; peopleInsight?: string;
}

export const DM_SOURCE_LABEL: Record<DmSource, string> = {
  relationship: "Exact relationships", target: "Saved targets", reply_spot: "Reply spots", manual: "Manual research", circle: "Your circle", thread: "Completed threads",
};

function firstTouch(candidate: DmCandidate): DmTouch | undefined {
  return candidate.touches.filter((t) => t.direction === "outbound" && t.phase === "first").sort((a, b) => a.at - b.at)[0];
}
function repliedAfter(candidate: DmCandidate, at: number): boolean { return candidate.touches.some((t) => t.direction === "inbound" && t.at > at); }

export function deriveDmMetrics(store: DmStore): DmMetrics {
  const rows = store.candidates.filter((c) => !c.removedAt).flatMap((candidate) => {
    const first = firstTouch(candidate); if (!first) return [];
    return [{ candidate, first, replied: repliedAfter(candidate, first.at), won: candidate.stage === "won", intent: first.intent ?? candidate.intent, warmth: first.warmth ?? (candidate.source === "relationship" ? "warm" : "research"), source: first.candidateSource ?? candidate.source }];
  });
  const byIntent = (Object.keys(DM_INTENT_LABEL) as DmIntent[]).map((intent) => {
    const group = rows.filter((r) => r.intent === intent), replies = group.filter((r) => r.replied).length, wins = group.filter((r) => r.won).length;
    return { intent, sent: group.length, replies, wins, replyRate: group.length ? replies / group.length : 0 };
  }).filter((x) => x.sent > 0);
  const eligible = byIntent.filter((x) => x.sent >= 3).sort((a, b) => b.replyRate - a.replyRate || b.wins - a.wins || b.sent - a.sent || a.intent.localeCompare(b.intent));
  const sources = Object.keys(DM_SOURCE_LABEL) as DmSource[];
  const bySource = sources.map((source) => {
    const group = rows.filter((r) => r.source === source), replies = group.filter((r) => r.replied).length, wins = group.filter((r) => r.won).length;
    return { source, sent: group.length, replies, wins, replyRate: group.length ? replies / group.length : 0 };
  }).filter((x) => x.sent > 0);
  const topSource = bySource.filter((x) => x.sent >= 5).sort((a, b) => b.replyRate - a.replyRate || b.wins - a.wins || b.sent - a.sent || a.source.localeCompare(b.source))[0];
  const firstSent = rows.length, replied = rows.filter((r) => r.replied).length, wins = rows.filter((r) => r.won).length;
  const warm = rows.filter((r) => r.warmth === "warm"), research = rows.filter((r) => r.warmth === "research");
  const topIntent = eligible[0];
  const insight = !firstSent ? "Mark messages sent to start learning what earns conversations."
    : firstSent < 3 ? `Early signal only · ${firstSent} first ${firstSent === 1 ? "message" : "messages"} marked sent.`
    : topIntent ? `${DM_INTENT_LABEL[topIntent.intent]} is your clearest signal so far · ${topIntent.replies}/${topIntent.sent} replied.`
    : `${replied}/${firstSent} people replied · keep each angle specific while the sample grows.`;
  const peopleInsight = topSource ? `${DM_SOURCE_LABEL[topSource.source]} are your clearest people signal · ${topSource.replies}/${topSource.sent} replied.`
    : warm.length >= 3 && research.length >= 3 ? `Warm ${warm.filter((r) => r.replied).length}/${warm.length} replied · research ${research.filter((r) => r.replied).length}/${research.length}.` : undefined;
  return {
    firstSent, replied, conversations: rows.filter((r) => r.replied || r.candidate.stage === "active" || r.won).length, wins,
    replyRate: firstSent ? replied / firstSent : 0,
    warmSent: warm.length, warmReplies: warm.filter((r) => r.replied).length,
    researchSent: research.length, researchReplies: research.filter((r) => r.replied).length,
    byIntent, topIntent, bySource, topSource, insight, peopleInsight,
  };
}

/** Candidate-local, display-only evidence. Never changes eligibility or ordering. */
export function candidateDmSignal(candidate: DmCandidate, metrics: DmMetrics): string[] {
  const out: string[] = [];
  const angle = metrics.byIntent.find((x) => x.intent === candidate.intent);
  if (angle && angle.sent >= 3) out.push(`${DM_INTENT_LABEL[angle.intent]} history · ${angle.replies}/${angle.sent} marked replies`);
  const source = metrics.bySource.find((x) => x.source === candidate.source);
  if (source && source.sent >= 3) out.push(`${DM_SOURCE_LABEL[source.source]} · ${source.replies}/${source.sent} marked replies`);
  return out;
}

export function rankDmNextActions(store: DmStore, now: number): DmNextAction[] {
  const actions: DmNextAction[] = [];
  if (!canMarkDmSend(store, "reply", now).ok) return actions; // total-day pause: no outbound nudge of any kind
  for (const c of store.candidates.filter((x) => !x.removedAt && x.stage !== "won" && x.stage !== "closed")) {
    if (c.stage === "active") actions.push({ handle: c.handle, kind: "reply", label: `Reply to @${c.handle}`, why: "They replied. Keep the real conversation moving before starting new outreach.", priority: 100 });
    else if (c.stage === "waiting" && c.dueAt && (c.snoozedUntil ?? c.dueAt) <= now && canMarkDmSend(store, "follow_up", now).ok) actions.push({ handle: c.handle, kind: "follow_up", label: `Follow up with @${c.handle}`, why: "One follow-up is due. Add new value or close the loop.", priority: 90 });
    else if (c.stage === "ready" && canMarkDmSend(store, "first", now).ok) actions.push({ handle: c.handle, kind: "draft_first", label: `Draft for @${c.handle}`, why: `${DM_INTENT_LABEL[c.intent]} plan is ready and grounded in saved context.`, priority: 70 });
    else if ((c.stage === "research" || c.stage === "warming") && canMoveDmReady(c).ok) actions.push({ handle: c.handle, kind: "mark_ready", label: `Review @${c.handle}`, why: "There is enough context to decide whether this should move to Ready.", priority: 55 });
    else if (c.stage === "research" || c.stage === "warming") actions.push({ handle: c.handle, kind: "add_context", label: `Research @${c.handle}`, why: "Add one real signal or a specific reason before drafting.", priority: 35 });
  }
  return actions.sort((a, b) => b.priority - a.priority || a.handle.localeCompare(b.handle));
}
