/** Durable, compact memory of exact completed reply exchanges. No text or inferred joins. */

const DAY_MS = 86_400_000;
export const RELATIONSHIP_KEEP_MS = 365 * DAY_MS;
export const RELATIONSHIP_ACCOUNT_CAP = 200;
export const RELATIONSHIP_EXCHANGE_CAP = 12;

export interface RelationshipAccountMemory { handle: string; exchanges: Record<string, number>; }
export interface RelationshipOwnerMemory { accounts: Record<string, RelationshipAccountMemory>; }
export interface RelationshipMemoryStore { version: 1; owners: Record<string, RelationshipOwnerMemory>; }
export interface ConnectionEvidence { completed: number; activeWeeks: number; lastAt: number; established: boolean; }
export interface InboundExchange { handle: string; kind: string; postId?: string; }

export function canonicalHandle(handle: string): string { return (handle || "").trim().replace(/^@+/, "").toLocaleLowerCase(); }
export function freshRelationshipMemory(): RelationshipMemoryStore { return { version: 1, owners: {} }; }

function weekKey(at: number): string {
  const d = new Date(at);
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() - day + 1);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

export function pruneRelationshipMemory(store: RelationshipMemoryStore | undefined, now: number): RelationshipMemoryStore {
  const out = freshRelationshipMemory();
  for (const [rawOwner, owner] of Object.entries(store?.version === 1 ? store.owners : {})) {
    const ownerKey = canonicalHandle(rawOwner); if (!ownerKey) continue;
    const accounts = Object.entries(owner?.accounts ?? {}).flatMap(([rawHandle, account]) => {
      const handle = canonicalHandle(rawHandle || account?.handle); if (!handle) return [];
      const exchanges = Object.entries(account?.exchanges ?? {})
        .filter(([id, at]) => !!id && Number.isFinite(at) && at <= now && now - at <= RELATIONSHIP_KEEP_MS)
        .sort((a, b) => b[1] - a[1]).slice(0, RELATIONSHIP_EXCHANGE_CAP);
      return exchanges.length ? [{ handle, exchanges: Object.fromEntries(exchanges), lastAt: exchanges[0][1] }] : [];
    }).sort((a, b) => b.lastAt - a.lastAt).slice(0, RELATIONSHIP_ACCOUNT_CAP);
    if (accounts.length) out.owners[ownerKey] = { accounts: Object.fromEntries(accounts.map((a) => [a.handle, { handle: a.handle, exchanges: a.exchanges }])) };
  }
  return out;
}

export function foldCompletedExchanges(store: RelationshipMemoryStore | undefined, owner: string, inbound: InboundExchange[], answeredThreadIds: Record<string, number> | undefined, now: number): { store: RelationshipMemoryStore; changed: boolean } {
  const ownerKey = canonicalHandle(owner); if (!ownerKey) return { store: pruneRelationshipMemory(store, now), changed: false };
  const next = pruneRelationshipMemory(store, now);
  const ownerMem = next.owners[ownerKey] ?? { accounts: {} };
  let changed = false;
  for (const event of inbound) {
    if (event.kind !== "reply" || !event.postId) continue;
    const at = answeredThreadIds?.[event.postId], handle = canonicalHandle(event.handle);
    if (!handle || !Number.isFinite(at) || at! > now || now - at! > RELATIONSHIP_KEEP_MS) continue;
    const account = ownerMem.accounts[handle] ?? { handle, exchanges: {} };
    if (account.exchanges[event.postId] === at) continue;
    account.exchanges[event.postId] = at!; ownerMem.accounts[handle] = account; changed = true;
  }
  if (Object.keys(ownerMem.accounts).length) next.owners[ownerKey] = ownerMem;
  return { store: pruneRelationshipMemory(next, now), changed };
}

export function mergeRelationshipMemory(a: RelationshipMemoryStore | undefined, b: RelationshipMemoryStore | undefined, now: number): RelationshipMemoryStore {
  const out = freshRelationshipMemory();
  for (const src of [a, b]) for (const [rawOwner, owner] of Object.entries(src?.version === 1 ? src.owners : {})) {
    const ownerKey = canonicalHandle(rawOwner); if (!ownerKey) continue;
    const target = out.owners[ownerKey] ?? { accounts: {} };
    for (const [rawHandle, account] of Object.entries(owner?.accounts ?? {})) {
      const handle = canonicalHandle(rawHandle || account?.handle); if (!handle) continue;
      const dest = target.accounts[handle] ?? { handle, exchanges: {} };
      for (const [id, at] of Object.entries(account?.exchanges ?? {})) if (!dest.exchanges[id] || at > dest.exchanges[id]) dest.exchanges[id] = at;
      target.accounts[handle] = dest;
    }
    out.owners[ownerKey] = target;
  }
  return pruneRelationshipMemory(out, now);
}

export function connectionEvidence(store: RelationshipMemoryStore | undefined, owner: string, peer: string, now: number): ConnectionEvidence | undefined {
  const account = pruneRelationshipMemory(store, now).owners[canonicalHandle(owner)]?.accounts[canonicalHandle(peer)];
  if (!account) return undefined;
  const times = Object.values(account.exchanges).sort((a, b) => b - a);
  const activeWeeks = new Set(times.map(weekKey)).size;
  return { completed: times.length, activeWeeks, lastAt: times[0], established: times.length >= 2 && activeWeeks >= 2 };
}
