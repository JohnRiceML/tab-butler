/**
 * The Twttr request governor: a durable local UTC-month safety meter, a 9/sec token
 * bucket, provider quota/rate-header awareness, graceful degradation (throttle expensive classes first, never starve
 * /user), and in-flight coalescing — all wrapping the single HTTP chokepoint in
 * the service worker. Lives in the worker (not the content script) so the budget
 * survives navigation and is shared across every x.com tab.
 *
 * The governor also owns a bounded persistent per-resource cache (policy/TTLs
 * live in twttr-policy.ts), so repeated identical reads do not spend requests.
 */
import { TWTTR_CLASS, TWTTR_BUDGET, classForPath, degradeMode, canFetch, monthKeyOf,
  providerRetryAt, providerUsedFraction,
  type TwttrCache, cacheExpiry, cacheFresh, pruneCache, TWTTR_CACHE_MAX_ENTRY } from "./twttr-policy";

const METER_KEY = "twttrMeter";
const CACHE_KEY = "twttrCache";

export interface TwttrMeter {
  /** Local safety estimate, rolled by UTC calendar month; not the provider billing cycle. */
  monthKey: string; requests: number; bytes: number;
  /** Plan-specific values observed from RapidAPI's last response. */
  providerRequestLimit?: number; providerRequestsRemaining?: number;
  providerRateLimit?: number; providerRateRemaining?: number; providerRateResetAt?: number;
  providerObservedAt?: number;
}
export interface GovResult {
  ok: boolean; status?: number; data?: unknown; error?: string;
  /** Receipt metadata: cache reads spend no provider request; network means a real fetch ran. */
  cached?: boolean; network?: boolean;
}

interface ProviderSnapshot {
  providerRequestLimit?: number; providerRequestsRemaining?: number;
  providerRateLimit?: number; providerRateRemaining?: number; providerRateResetAt?: number;
  providerObservedAt?: number;
}

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
async function bumpMeter(now: number, bytes: number, provider?: ProviderSnapshot): Promise<void> {
  meterChain = meterChain.then(async () => {
    try {
      const m = await loadMeter(now);
      m.requests += 1;
      m.bytes += Math.max(0, bytes);
      if (provider) for (const [key, value] of Object.entries(provider)) if (value != null) (m as unknown as Record<string, number>)[key] = value;
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
// Start nearly empty (1) rather than full, so a cold-start flood cannot burst above
// the configured local smoothing rate in its first second.
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

// Provider-wide circuit: subscription/rate failures affect every endpoint, so retrying a dozen
// different URLs only creates noise. It is memory-only and keyed to the credential; changing the
// key immediately clears it. Successful responses clear stale transient circuits.
let providerCircuit: { key: string; until: number; status: number; error: string } | undefined;
function headerNumber(headers: Headers, name: string): number | undefined {
  const value = Number(headers.get(name));
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}
function providerSnapshot(headers: Headers, now: number): ProviderSnapshot {
  const reset = headers.get("x-ratelimit-reset");
  const providerRequestLimit = headerNumber(headers, "x-ratelimit-requests-limit");
  const providerRequestsRemaining = headerNumber(headers, "x-ratelimit-requests-remaining");
  return {
    providerRequestLimit,
    providerRequestsRemaining,
    providerRateLimit: headerNumber(headers, "x-ratelimit-limit"),
    providerRateRemaining: headerNumber(headers, "x-ratelimit-remaining"),
    providerRateResetAt: reset ? providerRetryAt(reset, now) : undefined,
    // Do not refresh an old plan-quota observation when this response omitted plan headers.
    providerObservedAt: providerRequestLimit != null || providerRequestsRemaining != null ? now : undefined,
  };
}

/** Governed Twttr fetch: budget/degradation gate -> 8/sec token bucket -> one
 *  HTTP call -> meter the real bytes. `intent` marks a user-initiated call, which
 *  outlives ambient lookups under budget pressure (conserve mode). */
export async function governedFetch(host: string, key: string, path: string, query?: Record<string, string>, intent = false): Promise<GovResult> {
  const cls = classForPath(path);
  const tier = TWTTR_CLASS[cls].tier;
  const qs = query && Object.keys(query).length ? "?" + new URLSearchParams(query).toString() : "";
  const url = `https://${host}/${path.replace(/^\//, "")}${qs}`;
  const ckey = `${cls}|${url}`;

  // Scope the persistent cache to the expensive/uncached classes. `user` is skipped: it's
  // cheap AND already cached cross-session by the content script's authorReach map, so
  // governor-caching it would only add read-modify-write churn on the highest-frequency path.
  const useCache = cls !== "user";

  // Cache hit = zero bytes, zero requests → serve it BEFORE the budget/rate gates and even
  // before coalescing (a fresh entry beats joining an in-flight fetch). Response is identical
  // regardless of `intent`, so the cache is keyed on the URL alone.
  if (useCache) {
    const hit = (await loadCache())[url];
    if (cacheFresh(hit, Date.now())) return { ok: true, data: hit!.data, cached: true, network: false };
  }

  // Apply each caller's policy BEFORE joining a URL-identical request. In conserve mode an ambient
  // caller is still denied, while an explicit user request may proceed; once both are permitted the
  // network response is identical and they safely share one flight regardless of intent.
  const gateNow = Date.now();
  const gateMeter = await loadMeter(gateNow);
  const gateUsedFrac = Math.max(
    gateMeter.bytes / TWTTR_BUDGET.BYTES,
    gateMeter.requests / TWTTR_BUDGET.REQUESTS,
    providerUsedFraction(gateMeter.providerRequestLimit, gateMeter.providerRequestsRemaining, gateMeter.providerObservedAt, gateNow),
  );
  const gateMode = degradeMode(gateUsedFrac);
  if (!canFetch(tier, gateMode, intent)) return { ok: false, status: 0, error: `budget-${gateMode}`, network: false };

  if (providerCircuit?.key !== key) providerCircuit = undefined;
  if (providerCircuit && gateNow < providerCircuit.until) {
    return { ok: false, status: providerCircuit.status, error: `provider-backoff:${providerCircuit.error}`, network: false };
  }

  const existing = inflight.get(ckey);
  if (existing) return existing; // permitted duplicate callers coalesce by actual network URL

  const run = (async (): Promise<GovResult> => {
    const now = Date.now();

    await takeToken();
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15_000);
      let res: Response;
      try {
        res = await fetch(url, { signal: controller.signal, headers: { "Content-Type": "application/json", "x-rapidapi-key": key, "x-rapidapi-host": host } });
      } finally { clearTimeout(timeout); }
      const text = await res.text();
      const bytes = Number(res.headers.get("content-length")) || text.length;
      const provider = providerSnapshot(res.headers, Date.now());
      await bumpMeter(now, bytes, provider);
      if (!res.ok) {
        const detail = text.replace(/\s+/g, " ").trim().slice(0, 160);
        const retryHeader = res.headers.get("retry-after") || res.headers.get("x-ratelimit-reset");
        if (res.status === 401 || res.status === 402 || res.status === 403) {
          providerCircuit = { key, until: Date.now() + TWTTR_BUDGET.FAIL_TTL, status: res.status, error: detail || `HTTP ${res.status}` };
        } else if (res.status === 429) {
          providerCircuit = { key, until: providerRetryAt(retryHeader, Date.now()), status: 429, error: detail || "rate limited" };
        } else if (res.status >= 500) {
          providerCircuit = { key, until: Date.now() + 30_000, status: res.status, error: detail || `HTTP ${res.status}` };
        }
        console.warn("[goobi] twttr", path, res.status, detail);
        return { ok: false, status: res.status, error: detail || `twttr ${res.status}`, network: true };
      }
      // The plan rate window can be exhausted on an otherwise successful final request.
      if (provider.providerRateRemaining === 0) {
        providerCircuit = { key, until: provider.providerRateResetAt ?? Date.now() + 60_000, status: 429, error: "provider rate window exhausted" };
      } else providerCircuit = undefined;
      try {
        const data = JSON.parse(text);
        if (useCache) await writeCache(url, cls, data, bytes, now); // make the fresh response visible before another narrow caller can miss it
        return { ok: true, data, network: true };
      } catch { return { ok: false, status: res.status, error: "bad-json", network: true }; }
    } catch (e) {
      const message = (e as Error).name === "AbortError" ? "provider request timed out" : (e as Error).message;
      providerCircuit = { key, until: Date.now() + 30_000, status: 0, error: message };
      return { ok: false, status: 0, error: message, network: true };
    }
  })();

  inflight.set(ckey, run);
  try { return await run; } finally { inflight.delete(ckey); }
}
