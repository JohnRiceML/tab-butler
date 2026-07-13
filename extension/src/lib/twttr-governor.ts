/**
 * The Twttr request governor: a durable monthly budget meter, an 8/sec token
 * bucket (under the 10/sec hard limit), graceful degradation (throttle expensive classes first, never starve
 * /user), and in-flight coalescing — all wrapping the single HTTP chokepoint in
 * the service worker. Lives in the worker (not the content script) so the budget
 * survives navigation and is shared across every x.com tab.
 *
 * v1 is a budget + rate governor (no persistent response cache yet — callers
 * dedupe in memory; a storage-backed per-resource cache is the planned v2).
 */
import { TWTTR_CLASS, TWTTR_BUDGET, classForPath, degradeMode, canFetch, monthKeyOf,
  type TwttrCache, cacheExpiry, cacheFresh, pruneCache, TWTTR_CACHE_MAX_ENTRY } from "./twttr-policy";

const METER_KEY = "twttrMeter";
const CACHE_KEY = "twttrCache";

export interface TwttrMeter { monthKey: string; requests: number; bytes: number; }
export interface GovResult { ok: boolean; status?: number; data?: unknown; error?: string }

async function loadMeter(now: number): Promise<TwttrMeter> {
  const m = (await chrome.storage.local.get(METER_KEY))[METER_KEY] as TwttrMeter | undefined;
  const mk = monthKeyOf(now);
  return m && m.monthKey === mk ? m : { monthKey: mk, requests: 0, bytes: 0 }; // roll on month change
}
// Serialize read-modify-write so concurrent calls can't clobber each other's
// increments (the SW is single-threaded, but the await points interleave). The
// body is try/caught so a single failed write (transient I/O, quota, teardown)
// is logged but NEVER rejects the chain — otherwise the rejection would poison
// every later link and make governedFetch's `await bumpMeter` throw on success.
let meterChain: Promise<void> = Promise.resolve();
async function bumpMeter(now: number, bytes: number): Promise<void> {
  meterChain = meterChain.then(async () => {
    try {
      const m = await loadMeter(now);
      m.requests += 1;
      m.bytes += Math.max(0, bytes);
      await chrome.storage.local.set({ [METER_KEY]: m });
    } catch (e) {
      console.warn("[goobi] twttr meter write failed", e);
    }
  });
  return meterChain;
}
/** This month's usage, for the popup. */
export async function readMeter(): Promise<TwttrMeter> { return loadMeter(Date.now()); }

// ---- storage-backed response cache (per-resource, keyed on the full URL) ----
async function loadCache(): Promise<TwttrCache> {
  try { return ((await chrome.storage.local.get(CACHE_KEY))[CACHE_KEY] as TwttrCache) || {}; } catch { return {}; }
}
/** Serialize cache writes (same reasoning as the meter chain: interleaved awaits must not
 *  clobber each other), and never reject the chain on a transient storage failure. */
let cacheChain: Promise<void> = Promise.resolve();
function writeCache(url: string, cls: ReturnType<typeof classForPath>, data: unknown, bytes: number, now: number): Promise<void> {
  cacheChain = cacheChain.then(async () => {
    try {
      if (bytes > TWTTR_CACHE_MAX_ENTRY) return; // don't let one oversized blob evict the whole working set
      const cache = await loadCache();
      cache[url] = { at: now, exp: cacheExpiry(cls, now), bytes, data };
      await chrome.storage.local.set({ [CACHE_KEY]: pruneCache(cache, now) }); // prune expired + evict-oldest on every write → self-bounding
    } catch (e) { console.warn("[goobi] twttr cache write failed", e); }
  });
  return cacheChain;
}

// ---- token bucket (in-memory; resets on SW restart, which is fine for a burst guard) ----
// Start nearly empty (1) rather than full, so a cold-start flood can't exceed the
// refill rate in the first second (~RATE/sec) and stay under the 10/sec hard limit.
let tokens: number = 1;
let lastRefill = Date.now();
function takeToken(): Promise<void> {
  return new Promise((resolve) => {
    const attempt = () => {
      const now = Date.now();
      tokens = Math.min(TWTTR_BUDGET.RATE_PER_SEC, tokens + ((now - lastRefill) / 1000) * TWTTR_BUDGET.RATE_PER_SEC);
      lastRefill = now;
      if (tokens >= 1) { tokens -= 1; resolve(); return; }
      setTimeout(attempt, Math.max(20, Math.ceil(((1 - tokens) / TWTTR_BUDGET.RATE_PER_SEC) * 1000)));
    };
    attempt();
  });
}

// ---- coalescing: identical concurrent requests share one fetch ----
const inflight = new Map<string, Promise<GovResult>>();

/** Governed Twttr fetch: budget/degradation gate -> 8/sec token bucket -> one
 *  HTTP call -> meter the real bytes. `intent` marks a user-initiated call, which
 *  outlives ambient lookups under budget pressure (conserve mode). */
export async function governedFetch(host: string, key: string, path: string, query?: Record<string, string>, intent = false): Promise<GovResult> {
  const cls = classForPath(path);
  const tier = TWTTR_CLASS[cls].tier;
  const qs = query && Object.keys(query).length ? "?" + new URLSearchParams(query).toString() : "";
  const url = `https://${host}/${path.replace(/^\//, "")}${qs}`;
  const ckey = `${cls}|${url}|${intent ? 1 : 0}`;

  // Scope the persistent cache to the expensive/uncached classes. `user` is skipped: it's
  // cheap AND already cached cross-session by the content script's authorReach map, so
  // governor-caching it would only add read-modify-write churn on the highest-frequency path.
  const useCache = cls !== "user";

  // Cache hit = zero bytes, zero requests → serve it BEFORE the budget/rate gates and even
  // before coalescing (a fresh entry beats joining an in-flight fetch). Response is identical
  // regardless of `intent`, so the cache is keyed on the URL alone.
  if (useCache) {
    const hit = (await loadCache())[url];
    if (cacheFresh(hit, Date.now())) return { ok: true, data: hit!.data };
  }

  const existing = inflight.get(ckey);
  if (existing) return existing; // coalesce a duplicate in-flight request

  const run = (async (): Promise<GovResult> => {
    const now = Date.now();
    const meter = await loadMeter(now);
    const usedFrac = Math.max(meter.bytes / TWTTR_BUDGET.BYTES, meter.requests / TWTTR_BUDGET.REQUESTS);
    const mode = degradeMode(usedFrac);
    if (!canFetch(tier, mode, intent)) return { ok: false, status: 0, error: `budget-${mode}` };

    await takeToken();
    try {
      const res = await fetch(url, { headers: { "Content-Type": "application/json", "x-rapidapi-key": key, "x-rapidapi-host": host } });
      const text = await res.text();
      const bytes = Number(res.headers.get("content-length")) || text.length;
      await bumpMeter(now, bytes);
      if (!res.ok) {
        const detail = text.replace(/\s+/g, " ").trim().slice(0, 160);
        console.warn("[goobi] twttr", path, res.status, detail);
        return { ok: false, status: res.status, error: detail || `twttr ${res.status}` };
      }
      try {
        const data = JSON.parse(text);
        if (useCache) void writeCache(url, cls, data, bytes, now); // cache the success so a re-open / another tab reuses it within the class TTL
        return { ok: true, data };
      } catch { return { ok: false, status: res.status, error: "bad-json" }; }
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  })();

  inflight.set(ckey, run);
  try { return await run; } finally { inflight.delete(ckey); }
}
