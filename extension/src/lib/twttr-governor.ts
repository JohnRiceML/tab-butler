/**
 * The Twttr request governor: a durable local UTC-month safety meter, one shared adaptive
 * scheduler, provider quota/rate-header awareness, graceful degradation (throttle expensive
 * classes first, never starve /user), and in-flight coalescing — all wrapping the single HTTP chokepoint in
 * the service worker. Lives in the worker (not the content script) so the budget
 * survives navigation and is shared across every x.com tab.
 *
 * The governor also owns a bounded persistent per-resource cache (policy/TTLs
 * live in twttr-policy.ts), so repeated identical reads do not spend requests.
 */
import { TWTTR_CLASS, TWTTR_BUDGET, classForPath, degradeMode, canFetch, monthKeyOf,
  PROVIDER_QUOTA_OBSERVATION_TTL_MS, providerRetryAt, providerUsedFraction,
  type TwttrCache, cacheExpiry, cacheFresh, pruneCache, TWTTR_CACHE_MAX_ENTRY } from "./twttr-policy";
import { TWTTR_SCHEDULER_MAX_CONCURRENCY, adaptiveTwttrRate, nextTwttrQueueIndex, twttrDispatchDelayMs } from "./twttr-scheduler";

const METER_KEY = "twttrMeter";
const CACHE_KEY = "twttrCache";
const TWTTR_RATE_RETRY_MAX_WAIT_MS = 65_000;
const TWTTR_QUEUE_MAX_WAIT_MS = 120_000;
const PROVIDER_QUOTA_REPROBE_MS = 6 * 3_600_000;

export interface TwttrMeter {
  /** Local safety estimate, rolled by UTC calendar month; not the provider billing cycle. */
  monthKey: string; requests: number; bytes: number;
  /** Plan-specific values observed from RapidAPI's last response. */
  providerRequestLimit?: number; providerRequestsRemaining?: number; providerRequestResetAt?: number;
  providerRateLimit?: number; providerRateRemaining?: number; providerRateResetAt?: number;
  providerObservedAt?: number;
  /** Ephemeral service-worker scheduler telemetry (not persisted). */
  schedulerQueueDepth?: number; schedulerActive?: number;
  schedulerRatePerSecond?: number; schedulerPausedUntil?: number;
}
export interface GovResult {
  ok: boolean; status?: number; data?: unknown; error?: string;
  /** Receipt metadata: cache reads spend no provider request; network means a real fetch ran. */
  cached?: boolean; network?: boolean;
  cachedAt?: number; cacheAgeMs?: number;
  networkAttempts?: number; queuedMs?: number; queueDepth?: number; ratePerSecond?: number; rateRetries?: number;
}

interface ProviderSnapshot {
  providerRequestLimit?: number; providerRequestsRemaining?: number; providerRequestResetAt?: number;
  providerRateLimit?: number; providerRateRemaining?: number; providerRateResetAt?: number;
  providerObservedAt?: number;
}

function clearExpiredProviderPlan(meter: TwttrMeter, now: number): TwttrMeter {
  if (meter.providerRequestResetAt == null || meter.providerRequestResetAt > now) return meter;
  const next = { ...meter };
  delete next.providerRequestsRemaining;
  delete next.providerRequestResetAt;
  delete next.providerObservedAt;
  return next;
}

async function loadMeter(now: number): Promise<TwttrMeter> {
  const m = (await chrome.storage.local.get(METER_KEY))[METER_KEY] as TwttrMeter | undefined;
  const mk = monthKeyOf(now);
  if (!m) return { monthKey: mk, requests: 0, bytes: 0 };
  if (m.monthKey === mk) return clearExpiredProviderPlan(m, now);
  // Local transfer/request counters roll on UTC month boundaries. Provider quota observations do
  // not: RapidAPI billing cycles may reset on a different day, so retain the still-TTL-bounded
  // provider snapshot instead of briefly forgetting a nearly exhausted real plan.
  return clearExpiredProviderPlan({
    monthKey: mk, requests: 0, bytes: 0,
    providerRequestLimit: m.providerRequestLimit,
    providerRequestsRemaining: m.providerRequestsRemaining,
    providerRequestResetAt: m.providerRequestResetAt,
    providerRateLimit: m.providerRateLimit,
    providerRateRemaining: m.providerRateRemaining,
    providerRateResetAt: m.providerRateResetAt,
    providerObservedAt: m.providerObservedAt,
  }, now);
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
      if (provider) {
        const previousObservedAt = m.providerObservedAt;
        const previousFresh = previousObservedAt != null && now - previousObservedAt < PROVIDER_QUOTA_OBSERVATION_TTL_MS;
        const sameRequestWindow = previousFresh && (
          m.providerRequestResetAt == null || provider.providerRequestResetAt == null
          || Math.abs(m.providerRequestResetAt - provider.providerRequestResetAt) <= 5_000
        );
        if (provider.providerRequestLimit != null) m.providerRequestLimit = provider.providerRequestLimit;
        if (provider.providerRequestsRemaining != null) {
          m.providerRequestsRemaining = sameRequestWindow && m.providerRequestsRemaining != null
            ? Math.min(m.providerRequestsRemaining, provider.providerRequestsRemaining)
            : provider.providerRequestsRemaining;
        }
        if (provider.providerRequestResetAt != null) m.providerRequestResetAt = provider.providerRequestResetAt;
        if (provider.providerRateLimit != null) m.providerRateLimit = provider.providerRateLimit;
        if (provider.providerRateRemaining != null) m.providerRateRemaining = provider.providerRateRemaining;
        if (provider.providerRateResetAt != null) m.providerRateResetAt = provider.providerRateResetAt;
        if (provider.providerObservedAt != null) m.providerObservedAt = provider.providerObservedAt;
      }
      await chrome.storage.local.set({ [METER_KEY]: m });
    } catch (e) {
      console.warn("[goobi] twttr meter write failed", e);
    }
  });
  return meterChain;
}
/** This month's usage plus a live scheduler snapshot, for the popup. */
export async function readMeter(): Promise<TwttrMeter> {
  return { ...(await loadMeter(Date.now())), ...schedulerSnapshot() };
}

// ---- storage-backed response cache (per-resource, keyed on the full URL) ----
async function loadCache(): Promise<TwttrCache> {
  try { return ((await chrome.storage.local.get(CACHE_KEY))[CACHE_KEY] as TwttrCache) || {}; } catch { return {}; }
}
/** Serialize cache writes (same reasoning as the meter chain: interleaved awaits must not
 *  clobber each other), and never reject the chain on a transient storage failure. */
let cacheChain: Promise<void> = Promise.resolve();
function cacheReusePriority(url: string, cls: ReturnType<typeof classForPath>): number {
  if (cls !== "search") return 0;
  try {
    const query = new URL(url).searchParams.get("query")?.trim() ?? "";
    return /^from:/i.test(query) ? 0 : 2;
  } catch { return 0; }
}
function writeCache(url: string, cls: ReturnType<typeof classForPath>, data: unknown, bytes: number, now: number): Promise<void> {
  cacheChain = cacheChain.then(async () => {
    try {
      if (bytes > TWTTR_CACHE_MAX_ENTRY) return; // don't let one oversized blob evict the whole working set
      const cache = await loadCache();
      cache[url] = { at: now, exp: cacheExpiry(cls, now), bytes, data, reuse: cacheReusePriority(url, cls) };
      await chrome.storage.local.set({ [CACHE_KEY]: pruneCache(cache, now) }); // prune expired + evict-oldest on every write → self-bounding
    } catch (e) { console.warn("[goobi] twttr cache write failed", e); }
  });
  return cacheChain;
}

// ---- one shared scheduler for EVERY network-bound TWTTR_GET ----
interface SchedulerPermit {
  queuedMs: number; queueDepth: number; ratePerSecond: number;
  release: () => void;
}
interface SchedulerWaiter {
  intent: boolean; enqueuedAt: number; queueDepth: number;
  resolve: (permit: SchedulerPermit | undefined) => void;
  timeout: ReturnType<typeof setTimeout>;
}
const schedulerQueue: SchedulerWaiter[] = [];
let schedulerActive = 0;
let schedulerIntentStreak = 0;
let schedulerLastDispatchAt = 0;
let schedulerTimer: ReturnType<typeof setTimeout> | undefined;
let schedulerPausedUntil = 0;
let observedRateRemaining: number | undefined;
let observedRateResetAt: number | undefined;

function schedulerRate(now = Date.now()): number {
  return adaptiveTwttrRate(TWTTR_BUDGET.RATE_PER_SEC, observedRateRemaining, observedRateResetAt, now);
}
function schedulerSnapshot(): Pick<TwttrMeter, "schedulerQueueDepth" | "schedulerActive" | "schedulerRatePerSecond" | "schedulerPausedUntil"> {
  const now = Date.now();
  return {
    schedulerQueueDepth: schedulerQueue.length,
    schedulerActive,
    schedulerRatePerSecond: schedulerRate(now),
    schedulerPausedUntil: schedulerPausedUntil > now ? schedulerPausedUntil : undefined,
  };
}
function armScheduler(delayMs: number): void {
  if (schedulerTimer) clearTimeout(schedulerTimer);
  // Recheck long provider windows once a minute and stay below the platform's max timeout range.
  const boundedDelay = Math.min(60_000, Math.max(1, Math.ceil(delayMs)));
  schedulerTimer = setTimeout(() => { schedulerTimer = undefined; pumpScheduler(); }, boundedDelay);
}
function resetExpiredRateWindow(now: number): void {
  if (observedRateResetAt != null && observedRateResetAt <= now) {
    observedRateRemaining = undefined;
    observedRateResetAt = undefined;
  }
  if (schedulerPausedUntil <= now) schedulerPausedUntil = 0;
}
function pumpScheduler(): void {
  if (schedulerTimer || !schedulerQueue.length || schedulerActive >= TWTTR_SCHEDULER_MAX_CONCURRENCY) return;
  const now = Date.now();
  resetExpiredRateWindow(now);
  if (schedulerPausedUntil > now) { armScheduler(schedulerPausedUntil - now); return; }
  const rate = schedulerRate(now);
  if (rate <= 0) {
    armScheduler(Math.max(1_000, (observedRateResetAt ?? now + 60_000) - now));
    return;
  }
  const delay = twttrDispatchDelayMs(rate, schedulerLastDispatchAt, now);
  if (delay > 0) { armScheduler(delay); return; }
  const index = nextTwttrQueueIndex(schedulerQueue, schedulerIntentStreak);
  const waiter = schedulerQueue.splice(index, 1)[0];
  clearTimeout(waiter.timeout);
  schedulerIntentStreak = waiter.intent ? schedulerIntentStreak + 1 : 0;
  schedulerActive++;
  schedulerLastDispatchAt = now;
  let released = false;
  waiter.resolve({
    queuedMs: Math.max(0, now - waiter.enqueuedAt),
    queueDepth: waiter.queueDepth,
    ratePerSecond: rate,
    release: () => {
      if (released) return;
      released = true;
      schedulerActive = Math.max(0, schedulerActive - 1);
      pumpScheduler();
    },
  });
  // Even when capacity remains, spacing—not a burst of synchronous resolves—starts the next call.
  if (schedulerQueue.length) armScheduler(1000 / rate);
}
function acquireSchedulerSlot(intent: boolean): Promise<SchedulerPermit | undefined> {
  return new Promise((resolve) => {
    const waiter: SchedulerWaiter = {
      intent, enqueuedAt: Date.now(), queueDepth: schedulerQueue.length + 1, resolve,
      timeout: setTimeout(() => {
        const index = schedulerQueue.indexOf(waiter);
        if (index >= 0) schedulerQueue.splice(index, 1);
        resolve(undefined);
        pumpScheduler();
      }, TWTTR_QUEUE_MAX_WAIT_MS),
    };
    schedulerQueue.push(waiter);
    pumpScheduler();
  });
}
function pauseScheduler(until: number): void {
  schedulerPausedUntil = Math.max(schedulerPausedUntil, until);
  if (schedulerTimer) { clearTimeout(schedulerTimer); schedulerTimer = undefined; }
  pumpScheduler();
}
function observeProviderRate(provider: ProviderSnapshot, now: number): void {
  const remaining = provider.providerRateRemaining;
  const resetAt = provider.providerRateResetAt;
  if (remaining == null || resetAt == null) return;
  const newWindow = observedRateResetAt == null || observedRateResetAt <= now || resetAt > observedRateResetAt + 5_000;
  if (newWindow) {
    observedRateRemaining = remaining;
    observedRateResetAt = resetAt;
  } else {
    // Responses can complete out of order. Within one window, remaining may only move downward.
    observedRateRemaining = Math.min(observedRateRemaining ?? remaining, remaining);
    observedRateResetAt = Math.max(observedRateResetAt ?? resetAt, resetAt);
  }
  if (observedRateRemaining === 0) pauseScheduler(observedRateResetAt ?? resetAt);
  else pumpScheduler();
}

// ---- coalescing: identical concurrent requests share one fetch ----
const inflight = new Map<string, Promise<GovResult>>();

// Provider-wide circuit: subscription/rate failures affect every endpoint, so retrying a dozen
// different URLs only creates noise. It is memory-only and keyed to the credential; changing the
// key immediately clears it. Successful responses clear stale transient circuits.
let providerCircuit: { key: string; until: number; status: number; error: string } | undefined;
async function reserveProviderPlanRequest(now: number): Promise<boolean> {
  let accepted = true;
  meterChain = meterChain.then(async () => {
    try {
      const meter = await loadMeter(now);
      const snapshotFresh = meter.providerObservedAt == null || now - meter.providerObservedAt < PROVIDER_QUOTA_OBSERVATION_TTL_MS;
      if (snapshotFresh && meter.providerRequestsRemaining != null) {
        if (meter.providerRequestsRemaining <= 0) { accepted = false; return; }
        // Pessimistically spend the known slot before fetch. Responses without plan headers leave
        // this decrement intact; same-window headers can only reconcile the balance downward.
        meter.providerRequestsRemaining -= 1;
        await chrome.storage.local.set({ [METER_KEY]: meter });
      }
    } catch { /* gate already admitted this call; meter persistence remains best-effort */ }
  });
  await meterChain;
  return accepted;
}
function headerNumber(headers: Headers, name: string): number | undefined {
  const raw = headers.get(name);
  if (raw == null || !raw.trim()) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}
function providerSnapshot(headers: Headers, now: number): ProviderSnapshot {
  const rateReset = headers.get("x-ratelimit-reset");
  const requestReset = headers.get("x-ratelimit-requests-reset");
  const providerRequestLimit = headerNumber(headers, "x-ratelimit-requests-limit");
  const providerRequestsRemaining = headerNumber(headers, "x-ratelimit-requests-remaining");
  return {
    providerRequestLimit,
    providerRequestsRemaining,
    providerRequestResetAt: requestReset ? providerRetryAt(requestReset, now) : undefined,
    providerRateLimit: headerNumber(headers, "x-ratelimit-limit"),
    providerRateRemaining: headerNumber(headers, "x-ratelimit-remaining"),
    providerRateResetAt: rateReset ? providerRetryAt(rateReset, now) : undefined,
    // Do not refresh an old plan-quota observation when this response omitted plan headers.
    providerObservedAt: providerRequestLimit != null || providerRequestsRemaining != null ? now : undefined,
  };
}

/** Governed Twttr fetch: budget/degradation gate -> shared priority scheduler -> one HTTP call ->
 * meter the real bytes. `intent` marks a user-initiated call, which jumps ahead of ambient work
 * (with bounded fairness) and outlives ambient lookups under budget pressure. */
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
    const cacheNow = Date.now();
    if (cacheFresh(hit, cacheNow)) return { ok: true, data: hit!.data, cached: true, network: false, cachedAt: hit!.at, cacheAgeMs: Math.max(0, cacheNow - hit!.at) };
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
    let queuedMs = 0, queueDepth = 0, rateRetries = 0, networkAttempts = 0;
    let ratePerSecond: number = TWTTR_BUDGET.RATE_PER_SEC;
    const telemetry = () => ({ networkAttempts, queuedMs, queueDepth, ratePerSecond, rateRetries: rateRetries || undefined });
    while (true) {
      const permit = await acquireSchedulerSlot(intent);
      if (!permit) return { ok: false, status: 0, error: "provider queue timed out", network: networkAttempts > 0, ...telemetry() };
      queuedMs += permit.queuedMs;
      queueDepth = Math.max(queueDepth, permit.queueDepth);
      ratePerSecond = permit.ratePerSecond;
      const dispatchAt = Date.now();

      // A different in-flight request may have opened an auth/outage/quota circuit while this one
      // waited. Drop it without touching the network; rate-window pauses are handled by the queue.
      if (providerCircuit?.key === key && dispatchAt < providerCircuit.until) {
        permit.release();
        return { ok: false, status: providerCircuit.status, error: `provider-backoff:${providerCircuit.error}`, network: networkAttempts > 0, ...telemetry() };
      }

      const planReserved = await reserveProviderPlanRequest(dispatchAt);
      if (!planReserved) {
        permit.release();
        return { ok: false, status: 429, error: "provider-backoff:provider plan quota reserved", network: networkAttempts > 0, ...telemetry() };
      }

      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15_000);
        let res: Response;
        let text: string;
        try {
          networkAttempts++;
          res = await fetch(url, { signal: controller.signal, headers: { "Content-Type": "application/json", "x-rapidapi-key": key, "x-rapidapi-host": host } });
          // Keep the same deadline through body consumption. A server that sends headers and then
          // stalls must not hold one of the eight shared scheduler slots forever.
          text = await res.text();
        } finally { clearTimeout(timeout); }
        const decodedBytes = new TextEncoder().encode(text).byteLength;
        const bytes = Number(res.headers.get("content-length")) || decodedBytes;
        const responseAt = Date.now();
        const provider = providerSnapshot(res.headers, responseAt);
        observeProviderRate(provider, responseAt);
        const detail = res.ok ? "" : text.replace(/\s+/g, " ").trim().slice(0, 160);
        let shouldRetryRate = false;
        if (!res.ok) {
          const retryHeader = res.headers.get("retry-after") || res.headers.get("x-ratelimit-reset");
          if (res.status === 401 || res.status === 402 || res.status === 403) {
            providerCircuit = { key, until: responseAt + TWTTR_BUDGET.FAIL_TTL, status: res.status, error: detail || `HTTP ${res.status}` };
          } else if (res.status === 429 && provider.providerRequestsRemaining === 0) {
            // A plan quota is not a short traffic burst: fail queued work cleanly until its observed
            // reset instead of waking every minute and risking billable overage retries.
            providerCircuit = {
              key, until: provider.providerRequestResetAt ?? responseAt + PROVIDER_QUOTA_REPROBE_MS,
              status: 429, error: detail || "provider plan quota exhausted",
            };
          } else if (res.status === 429) {
            const retryAt = providerRetryAt(retryHeader, responseAt);
            pauseScheduler(retryAt);
            shouldRetryRate = rateRetries < 1 && retryAt - responseAt <= TWTTR_RATE_RETRY_MAX_WAIT_MS;
          } else if (res.status >= 500) {
            providerCircuit = { key, until: responseAt + 30_000, status: res.status, error: detail || `HTTP ${res.status}` };
          }
        } else if (provider.providerRequestsRemaining === 0) {
          // Rate-window exhaustion pauses the scheduler; plan exhaustion opens a quota circuit.
          providerCircuit = {
            key, until: provider.providerRequestResetAt ?? responseAt + PROVIDER_QUOTA_REPROBE_MS,
            status: 429, error: "provider plan quota exhausted",
          };
        } else if (providerCircuit?.key === key) providerCircuit = undefined;

        // Backpressure/circuits are installed before the next queued call can be released.
        permit.release(); // network/body are complete; storage and parsing must not occupy capacity
        await bumpMeter(dispatchAt, bytes, provider);

        if (!res.ok) {
          // Read-only GETs may retry once after a short rate window. The permit was released, so
          // this retry waits in the same fair queue and cannot block unrelated active requests.
          if (shouldRetryRate) {
            rateRetries++;
            console.warn("[goobi] twttr", path, res.status, detail || "rate limited", "— queued one retry");
            continue;
          }
          console.warn("[goobi] twttr", path, res.status, detail);
          return { ok: false, status: res.status, error: detail || `twttr ${res.status}`, network: true, ...telemetry() };
        }
        try {
          const data = JSON.parse(text);
          if (useCache) await writeCache(url, cls, data, decodedBytes, dispatchAt); // bound storage by decoded JSON size, not compressed wire bytes
          return { ok: true, data, network: true, ...telemetry() };
        } catch { return { ok: false, status: res.status, error: "bad-json", network: true, ...telemetry() }; }
      } catch (e) {
        const message = (e as Error).name === "AbortError" ? "provider request timed out" : (e as Error).message;
        providerCircuit = { key, until: Date.now() + 30_000, status: 0, error: message };
        return { ok: false, status: 0, error: message, network: true, ...telemetry() };
      } finally {
        permit.release();
      }
    }
  })();

  inflight.set(ckey, run);
  try { return await run; } finally { inflight.delete(ckey); }
}
