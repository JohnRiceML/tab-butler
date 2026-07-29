/** Pure local-first CRM logic for Goobi's draft-only DM workspace. */

export type DmIntent = "sponsor" | "backlink" | "connect" | "co_market" | "customer" | "partner";
export type DmStage = "research" | "warming" | "ready" | "waiting" | "active" | "won" | "closed";
export type DmSource = "manual" | "target" | "relationship" | "reply_spot" | "circle" | "thread";
export type DmEvidenceSource = "measured" | "observed" | "user";
export type DmContextKind = "public_post" | "public_reply" | "profile" | "product" | "note" | "message";
export type DmPhase = "first" | "follow_up" | "reply";

export const DM_CANDIDATE_CAP = 150;
export const DM_STORE_CAP = 250; // active cap plus bounded removal tombstones for cross-tab safety
export const DM_CONTEXT_CAP = 20;
export const DM_TOUCH_CAP = 30;
export const DM_CONTEXT_TEXT_MAX = 800;
export const DM_FOLLOW_UP_MS = 7 * 86_400_000;
export const DM_DUPLICATE_THRESHOLD = 0.7;

export interface DmReason { id: string; label: string; detail?: string; source: DmEvidenceSource; sourceRef?: string; capturedAt: number; }
export interface DmContextItem { id: string; kind: DmContextKind; capturedAt: number; text?: string; url?: string; postId?: string; source: DmEvidenceSource; removedAt?: number; }
export interface DmTouch { id: string; direction: "outbound" | "inbound" | "note"; phase: DmPhase | "note"; at: number; text?: string; source: "goobi" | "manual"; redactedAt?: number; intent?: DmIntent; productName?: string; warmth?: "warm" | "research"; candidateSource?: DmSource; }
export interface DmCandidate {
  id: string; ownerHandle: string; handle: string; name?: string; avatar?: string; userId?: string;
  followers?: number; bioSnapshot?: string; source: DmSource; intent: DmIntent; stage: DmStage;
  productName?: string; goal?: string; reasons: DmReason[]; context: DmContextItem[]; touches: DmTouch[];
  draft?: string; draftPhase?: DmPhase; dueAt?: number; snoozedUntil?: number; removedAt?: number; createdAt: number; updatedAt: number;
}
export interface DmStore { version: 1; ownerHandle: string; candidates: DmCandidate[]; }

export interface DmCandidateInput {
  handle: string; name?: string; avatar?: string; userId?: string; followers?: number; bioSnapshot?: string;
  source: DmSource; intent?: DmIntent; stage?: DmStage; goal?: string; productName?: string;
  reasons?: DmReason[]; context?: DmContextItem[];
}

export const DM_INTENT_LABEL: Record<DmIntent, string> = {
  sponsor: "Sponsor", backlink: "Backlink", connect: "Connect", co_market: "Co-market", customer: "Customer", partner: "Partner",
};
export const DM_STAGE_LABEL: Record<DmStage, string> = {
  research: "Research", warming: "Warm up", ready: "Ready", waiting: "Waiting", active: "Conversation", won: "Won", closed: "Closed",
};

export function canonicalDmHandle(value: string): string { return (value || "").trim().replace(/^@+/, "").toLocaleLowerCase(); }
export function freshDmStore(ownerHandle = ""): DmStore { return { version: 1, ownerHandle: canonicalDmHandle(ownerHandle), candidates: [] }; }
const clip = (s: string | undefined, max = DM_CONTEXT_TEXT_MAX): string | undefined => s?.trim() ? s.trim().slice(0, max) : undefined;
const eid = (prefix: string, now: number, salt = ""): string => `${prefix}:${now.toString(36)}:${salt || Math.random().toString(36).slice(2, 8)}`;

function cleanReason(r: DmReason): DmReason | undefined {
  const label = clip(r?.label, 160); if (!r?.id || !label || !Number.isFinite(r.capturedAt)) return undefined;
  return { ...r, label, detail: clip(r.detail, 500) };
}
function cleanContext(c: DmContextItem): DmContextItem | undefined {
  if (!c?.id || !Number.isFinite(c.capturedAt)) return undefined;
  if (c.removedAt) return { id: c.id, kind: c.kind, capturedAt: c.capturedAt, source: c.source, removedAt: c.removedAt };
  const text = clip(c.text); if (!text && !c.url && !c.postId) return undefined;
  return { ...c, text, url: clip(c.url, 500), postId: clip(c.postId, 80) };
}
function cleanTouch(t: DmTouch): DmTouch | undefined {
  if (!t?.id || !Number.isFinite(t.at)) return undefined;
  return { ...t, text: t.redactedAt ? undefined : clip(t.text, 2_000) };
}

function mergeReasons(a: DmReason[], b: DmReason[]): DmReason[] { return [...new Map([...a, ...b].map((x) => [x.id, x])).values()].slice(-12); }
function mergeContexts(a: DmContextItem[], b: DmContextItem[]): DmContextItem[] {
  const by = new Map<string, DmContextItem>();
  for (const item of [...a, ...b]) {
    const prev = by.get(item.id);
    if (!prev) by.set(item.id, item);
    else if (prev.removedAt || item.removedAt) by.set(item.id, (item.removedAt ?? 0) >= (prev.removedAt ?? 0) ? item : prev);
    else by.set(item.id, item.capturedAt >= prev.capturedAt ? item : prev);
  }
  return [...by.values()].slice(-DM_CONTEXT_CAP);
}
function mergeTouches(a: DmTouch[], b: DmTouch[]): DmTouch[] {
  const by = new Map<string, DmTouch>();
  for (const item of [...a, ...b]) {
    const prev = by.get(item.id);
    if (!prev) by.set(item.id, item);
    else if (prev.redactedAt || item.redactedAt) {
      const winner = (item.redactedAt ?? 0) >= (prev.redactedAt ?? 0) ? item : prev;
      by.set(item.id, { ...winner, text: undefined });
    } else by.set(item.id, item.at >= prev.at ? item : prev);
  }
  return [...by.values()].slice(-DM_TOUCH_CAP);
}

export function pruneDmStore(store: DmStore | undefined, ownerHandle?: string, now = Date.now()): DmStore {
  const owner = canonicalDmHandle(ownerHandle ?? store?.ownerHandle ?? "");
  if (!store || store.version !== 1 || canonicalDmHandle(store.ownerHandle) !== owner) return freshDmStore(owner);
  const seen = new Set<string>();
  const candidates = (store.candidates ?? []).flatMap((raw) => {
    const handle = canonicalDmHandle(raw?.handle);
    if (!raw?.id || !handle || seen.has(handle) || !Number.isFinite(raw.createdAt) || raw.createdAt > now + 60_000) return [];
    seen.add(handle);
    const reasons = (raw.reasons ?? []).map(cleanReason).filter((x): x is DmReason => !!x).slice(-12);
    const context = (raw.context ?? []).map(cleanContext).filter((x): x is DmContextItem => !!x).sort((a, b) => a.capturedAt - b.capturedAt).slice(-DM_CONTEXT_CAP);
    const touches = (raw.touches ?? []).map(cleanTouch).filter((x): x is DmTouch => !!x).sort((a, b) => a.at - b.at).slice(-DM_TOUCH_CAP);
    return [{ ...raw, ownerHandle: owner, handle, bioSnapshot: clip(raw.bioSnapshot, 500), goal: clip(raw.goal, 500), draft: clip(raw.draft, 2_000), reasons, context, touches }];
  }).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, DM_STORE_CAP);
  return { version: 1, ownerHandle: owner, candidates };
}

export function mergeDmStores(a: DmStore | undefined, b: DmStore | undefined, ownerHandle: string, now = Date.now()): DmStore {
  const owner = canonicalDmHandle(ownerHandle), aa = pruneDmStore(a, owner, now), bb = pruneDmStore(b, owner, now);
  const by = new Map<string, DmCandidate>();
  for (const c of [...aa.candidates, ...bb.candidates]) {
    const ex = by.get(c.handle);
    if (!ex) { by.set(c.handle, c); continue; }
    const newer = c.updatedAt >= ex.updatedAt ? c : ex, older = newer === c ? ex : c;
    by.set(c.handle, { ...older, ...newer, reasons: mergeReasons(older.reasons, newer.reasons), context: mergeContexts(older.context, newer.context), touches: mergeTouches(older.touches, newer.touches) });
  }
  return pruneDmStore({ version: 1, ownerHandle: owner, candidates: [...by.values()] }, owner, now);
}

export function addDmCandidate(store: DmStore, ownerHandle: string, input: DmCandidateInput, now: number): { store: DmStore; candidate?: DmCandidate; error?: string } {
  const owner = canonicalDmHandle(ownerHandle), handle = canonicalDmHandle(input.handle);
  if (!owner) return { store, error: "Set your X handle before tracking DMs." };
  if (!handle) return { store, error: "Enter an X handle." };
  if (handle === owner) return { store, error: "You can't add your own account." };
  const base = pruneDmStore(store, owner, now);
  const existing = base.candidates.find((c) => c.handle === handle);
  if (existing?.removedAt) {
    // Use 0 instead of undefined so chrome.storage serialization cannot omit the explicit revive
    // marker and let an older removal tombstone win when another tab merges.
    const revived: DmCandidate = {
      id: existing.id, ownerHandle: owner, handle, name: clip(input.name, 100), avatar: input.avatar, userId: input.userId,
      followers: input.followers, bioSnapshot: clip(input.bioSnapshot, 500), source: input.source, intent: input.intent ?? "connect",
      stage: input.stage ?? "research", productName: input.productName, goal: clip(input.goal, 500),
      reasons: (input.reasons ?? []).map(cleanReason).filter((x): x is DmReason => !!x), context: (input.context ?? []).map(cleanContext).filter((x): x is DmContextItem => !!x),
      touches: [], removedAt: 0, createdAt: existing.createdAt, updatedAt: now,
    };
    return { store: { ...base, candidates: base.candidates.map((c) => c.handle === handle ? revived : c) }, candidate: revived };
  }
  if (existing) {
    const merged: DmCandidate = { ...existing,
      name: existing.name || clip(input.name, 100), avatar: existing.avatar || input.avatar, userId: existing.userId || input.userId,
      followers: existing.followers ?? input.followers, bioSnapshot: existing.bioSnapshot || clip(input.bioSnapshot, 500),
      reasons: mergeReasons(existing.reasons, (input.reasons ?? []).map(cleanReason).filter((x): x is DmReason => !!x)),
      context: mergeContexts(existing.context, (input.context ?? []).map(cleanContext).filter((x): x is DmContextItem => !!x)), updatedAt: now,
    };
    return { store: { ...base, candidates: base.candidates.map((c) => c.handle === handle ? merged : c) }, candidate: merged, error: "Already in your DM workspace; new evidence was added." };
  }
  if (base.candidates.filter((c) => !c.removedAt).length >= DM_CANDIDATE_CAP) return { store: base, error: `DM workspace is full (${DM_CANDIDATE_CAP}). Close or remove someone first.` };
  const candidate: DmCandidate = {
    id: eid("dm", now, handle), ownerHandle: owner, handle, name: clip(input.name, 100), avatar: input.avatar, userId: input.userId,
    followers: input.followers, bioSnapshot: clip(input.bioSnapshot, 500), source: input.source, intent: input.intent ?? "connect",
    stage: input.stage ?? (input.source === "relationship" ? "ready" : input.source === "manual" ? "research" : "warming"),
    productName: input.productName, goal: clip(input.goal, 500), reasons: (input.reasons ?? []).map(cleanReason).filter((x): x is DmReason => !!x),
    context: (input.context ?? []).map(cleanContext).filter((x): x is DmContextItem => !!x), touches: [], createdAt: now, updatedAt: now,
  };
  return { store: { ...base, candidates: [candidate, ...base.candidates] }, candidate };
}

export function updateDmCandidate(store: DmStore, handle: string, patch: Partial<Pick<DmCandidate, "intent" | "stage" | "goal" | "productName" | "draft" | "draftPhase" | "dueAt" | "snoozedUntil" | "name" | "avatar" | "userId" | "followers" | "bioSnapshot">>, now: number): DmStore {
  const h = canonicalDmHandle(handle);
  const has = (key: string) => Object.prototype.hasOwnProperty.call(patch, key);
  return { ...store, candidates: store.candidates.map((c) => c.handle === h ? { ...c, ...patch, goal: has("goal") ? clip(patch.goal, 500) : c.goal, draft: has("draft") ? clip(patch.draft, 2_000) : c.draft, updatedAt: now } : c) };
}

export function appendDmContext(store: DmStore, handle: string, kind: DmContextKind, source: DmEvidenceSource, text: string, now: number, extra?: { url?: string; postId?: string }): DmStore {
  const h = canonicalDmHandle(handle), clean = clip(text);
  if (!clean) return store;
  const item: DmContextItem = { id: eid("ctx", now), kind, source, text: clean, capturedAt: now, url: extra?.url, postId: extra?.postId };
  return { ...store, candidates: store.candidates.map((c) => c.handle === h ? { ...c, draft: undefined, draftPhase: undefined, context: [...c.context, item].slice(-DM_CONTEXT_CAP), updatedAt: now } : c) };
}

export function removeDmContext(store: DmStore, handle: string, contextId: string, now: number): DmStore {
  const h = canonicalDmHandle(handle);
  return { ...store, candidates: store.candidates.map((c) => c.handle === h ? { ...c, draft: undefined, draftPhase: undefined, context: c.context.map((x) => x.id === contextId ? { id: x.id, kind: x.kind, capturedAt: x.capturedAt, source: x.source, removedAt: now } : x), updatedAt: now } : c) };
}

export function removeDmCandidate(store: DmStore, handle: string, now: number): DmStore {
  const h = canonicalDmHandle(handle);
  return { ...store, candidates: store.candidates.map((c) => c.handle === h ? {
    id: c.id, ownerHandle: c.ownerHandle, handle: c.handle, source: c.source, intent: "connect", stage: "closed",
    reasons: [], context: [], touches: [], removedAt: now, createdAt: c.createdAt, updatedAt: now,
  } : c) };
}

export function markDmSent(store: DmStore, handle: string, text: string, phase: "first" | "follow_up" | "reply", now: number): DmStore {
  const h = canonicalDmHandle(handle), clean = clip(text, 2_000); if (!clean) return store;
  return { ...store, candidates: store.candidates.map((c) => {
    if (c.handle !== h) return c;
    const touch: DmTouch = { id: eid("sent", now), direction: "outbound", phase, at: now, text: clean, source: "manual", intent: c.intent, productName: c.productName, warmth: c.source === "relationship" ? "warm" : "research", candidateSource: c.source };
    return { ...c, stage: "waiting", draft: undefined, draftPhase: undefined, touches: [...c.touches, touch].slice(-DM_TOUCH_CAP), dueAt: phase === "follow_up" ? undefined : now + DM_FOLLOW_UP_MS, snoozedUntil: undefined, updatedAt: now };
  }) };
}

export function markDmReplied(store: DmStore, handle: string, text: string | undefined, now: number): DmStore {
  const h = canonicalDmHandle(handle), clean = clip(text, 2_000);
  const touch: DmTouch = { id: eid("recv", now), direction: "inbound", phase: "reply", at: now, text: clean, source: "manual" };
  return { ...store, candidates: store.candidates.map((c) => c.handle === h ? { ...c, stage: "active", draft: undefined, draftPhase: undefined, touches: [...c.touches, touch].slice(-DM_TOUCH_CAP), dueAt: undefined, snoozedUntil: undefined, updatedAt: now } : c) };
}

/** Remove private message text while retaining the user's manual event marker for pacing/funnel truth. */
export function redactDmTouch(store: DmStore, handle: string, touchId: string, now: number): DmStore {
  const h = canonicalDmHandle(handle);
  return { ...store, candidates: store.candidates.map((c) => c.handle === h ? { ...c, draft: undefined, draftPhase: undefined, touches: c.touches.map((t) => t.id === touchId ? { ...t, text: undefined, redactedAt: now } : t), updatedAt: now } : c) };
}

export function outboundTouches(c: DmCandidate): DmTouch[] { return c.touches.filter((t) => t.direction === "outbound"); }
export function followUpCount(c: DmCandidate): number {
  const anchor = c.touches.reduce((at, t) => t.direction === "inbound" || (t.direction === "outbound" && t.phase !== "follow_up") ? Math.max(at, t.at) : at, 0);
  return outboundTouches(c).filter((t) => t.phase === "follow_up" && t.at > anchor).length;
}
export function dueFollowUps(store: DmStore, now: number): DmCandidate[] {
  return store.candidates.filter((c) => !c.removedAt && c.stage === "waiting" && !!c.dueAt && (c.snoozedUntil ?? c.dueAt!) <= now && followUpCount(c) < 1).sort((a, b) => (a.dueAt ?? 0) - (b.dueAt ?? 0));
}

export function canDraftDm(c: DmCandidate, phase: DmPhase, now: number): { ok: boolean; reason?: string } {
  if (c.stage === "closed" || c.stage === "won") return { ok: false, reason: "Reopen this conversation before drafting." };
  if (phase === "first" && c.stage !== "ready") return { ok: false, reason: "Move this person to Ready before drafting a first DM." };
  if (phase === "first") { const ready = canMoveDmReady(c); if (!ready.ok) return ready; }
  if (phase === "follow_up") {
    if (!c.dueAt || now < (c.snoozedUntil ?? c.dueAt)) return { ok: false, reason: "Wait until the follow-up is due." };
    if (followUpCount(c) >= 1) return { ok: false, reason: "Goobi recommends one unanswered follow-up maximum." };
  }
  if (phase === "reply" && c.stage !== "active") return { ok: false, reason: "Mark their reply first so the conversation context is accurate." };
  return { ok: true };
}

export function canMoveDmReady(c: DmCandidate): { ok: boolean; reason?: string } {
  const liveContext = c.context.filter((x) => !x.removedAt);
  const corpus = [c.goal, ...liveContext.map((x) => x.text), ...c.reasons.map((x) => x.detail)].filter(Boolean).join(" ").toLocaleLowerCase();
  const concrete = corpus.replace(/\s/g, "").length >= 20 || c.reasons.some((r) => r.source === "measured");
  if (!concrete) return { ok: false, reason: "Add a real public signal or a specific note before marking Ready." };
  if (c.intent === "sponsor" && !/sponsor|advertis|media kit|placement|campaign/.test(corpus)) return { ok: false, reason: "Add a real sponsorship cue or a specific sponsorship note first." };
  if (c.intent === "backlink" && (!c.productName || !/resource|guide|article|page|roundup|contributor|guest post|backlink/.test(corpus))) return { ok: false, reason: "Select the resource and add the exact page or audience fit first." };
  if (c.intent === "customer" && (!c.productName || !/problem|need|pain|looking for|struggl|help|friction|challenge/.test(corpus))) return { ok: false, reason: "Add the exact problem they expressed and select the relevant product first." };
  if (c.intent === "co_market" && !/thread|teardown|webinar|template|guide|case study|event|newsletter|joint/.test(corpus)) return { ok: false, reason: "Name one small co-marketing experiment first." };
  if (c.intent === "partner" && !/integrat|referral|distribution|joint|service|partner/.test(corpus)) return { ok: false, reason: "Add one concrete integration, referral, distribution, or joint-service hypothesis first." };
  return { ok: true };
}

export function canMarkDmSend(store: DmStore, phase: DmPhase, now: number): { ok: boolean; reason?: string } {
  const p = dmPacingStatus(store, now);
  if (p.totalDay >= 10) return { ok: false, reason: "Ten marked DM sends today. Pause here." };
  if (phase === "first" && p.firstHour >= 2) return { ok: false, reason: "Two first DMs this hour. Pause here." };
  if (phase === "first" && p.firstDay >= 5) return { ok: false, reason: "Five first DMs today. Pause here." };
  return { ok: true };
}

const TOK_STOP = new Set("a an and the to of in on for is it i you we my our your that this with as at be or but so".split(" "));
export function normalizeDmText(s: string): string[] { return (s || "").toLocaleLowerCase().replace(/https?:\/\/\S+/g, " ").replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !TOK_STOP.has(w)); }
export function dmTextSimilarity(a: string, b: string): number {
  const aa = new Set(normalizeDmText(a)), bb = new Set(normalizeDmText(b)); if (aa.size < 5 || bb.size < 5) return 0;
  let both = 0; for (const x of aa) if (bb.has(x)) both++;
  return both / (aa.size + bb.size - both);
}
export function findDmDuplicate(store: DmStore, text: string): { handle: string; similarity: number } | undefined {
  let best: { handle: string; similarity: number } | undefined;
  for (const c of store.candidates) for (const t of outboundTouches(c).slice(-30)) {
    const similarity = dmTextSimilarity(text, t.text ?? "");
    if (similarity >= DM_DUPLICATE_THRESHOLD && (!best || similarity > best.similarity)) best = { handle: c.handle, similarity };
  }
  return best;
}

export function dmPacingStatus(store: DmStore, now: number): { level: "ok" | "caution" | "pause"; firstHour: number; firstDay: number; totalDay: number; reason?: string } {
  const sent = store.candidates.flatMap(outboundTouches);
  const firstHour = sent.filter((t) => t.phase === "first" && now - t.at < 3_600_000).length;
  const firstDay = sent.filter((t) => t.phase === "first" && now - t.at < 86_400_000).length;
  const totalDay = sent.filter((t) => now - t.at < 86_400_000).length;
  if (firstHour >= 2) return { level: "pause", firstHour, firstDay, totalDay, reason: "Two first DMs this hour. Pause here." };
  if (firstDay >= 5) return { level: "pause", firstHour, firstDay, totalDay, reason: "Five first DMs today. Goobi won't encourage more cold outreach." };
  if (totalDay >= 10) return { level: "pause", firstHour, firstDay, totalDay, reason: "Ten marked DM sends today. Pause here." };
  if (firstHour === 1 || firstDay >= 3 || totalDay >= 7) return { level: "caution", firstHour, firstDay, totalDay, reason: "Keep each message specific and slow down." };
  return { level: "ok", firstHour, firstDay, totalDay };
}

export function sortDmCandidates(store: DmStore, now: number): DmCandidate[] {
  const stage: Record<DmStage, number> = { active: 7, waiting: 4, ready: 5, warming: 3, research: 2, won: 1, closed: 0 };
  return store.candidates.filter((c) => !c.removedAt).sort((a, b) => {
    const ad = a.stage === "waiting" && !!a.dueAt && (a.snoozedUntil ?? a.dueAt) <= now ? 1 : 0;
    const bd = b.stage === "waiting" && !!b.dueAt && (b.snoozedUntil ?? b.dueAt) <= now ? 1 : 0;
    return bd - ad || stage[b.stage] - stage[a.stage] || b.updatedAt - a.updatedAt || a.handle.localeCompare(b.handle);
  });
}

export interface DmSuggestionInput { handle: string; name?: string; avatar?: string; followers?: number; bio?: string; source: "relationship" | "target"; exactExchanges?: number; activeWeeks?: number; lastAt?: number; publicContext?: string; }
export interface RankedDmSuggestion extends DmSuggestionInput { intent: DmIntent; warm: boolean; reason: string; score: number; }
export function inferDmIntent(input: DmSuggestionInput): DmIntent {
  return "connect"; // public bio terms do not establish commercial intent; the user chooses the angle explicitly
}
export function rankDmSuggestions(inputs: DmSuggestionInput[], existingHandles: Set<string>, now: number, max = 5): RankedDmSuggestion[] {
  return inputs.filter((x) => {
    const h = canonicalDmHandle(x.handle); return !!h && !existingHandles.has(h);
  }).map((x) => {
    const warm = x.source === "relationship" && (x.exactExchanges ?? 0) >= 2 && (x.activeWeeks ?? 0) >= 2;
    const ageDays = x.lastAt ? Math.max(0, (now - x.lastAt) / 86_400_000) : 365;
    const recency = Math.pow(0.5, ageDays / 30);
    const score = warm ? 4 + Math.min(2, (x.exactExchanges ?? 0) / 3) + recency : 1 + (x.publicContext ? 0.5 : 0) + (x.bio ? 0.25 : 0);
    const reason = warm ? `${x.exactExchanges} exact exchanges across ${x.activeWeeks} weeks` : x.source === "relationship" ? `${x.exactExchanges ?? 1} exact public exchange · add more context before a DM` : "Saved target · research before reaching out";
    return { ...x, intent: inferDmIntent(x), warm, reason, score };
  }).sort((a, b) => b.score - a.score || (b.lastAt ?? 0) - (a.lastAt ?? 0) || a.handle.localeCompare(b.handle)).slice(0, max);
}
