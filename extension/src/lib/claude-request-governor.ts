/** One governor in the background client shares capacity across X and LinkedIn tabs.
 * Waiting work expires without a request; running work aborts its HTTP transport.
 * Failed requests are never automatically replayed here: drafts can incur a charge.
 */
export interface ClaudeGovernorOptions {
  maxConcurrency?: number;
  maxQueue?: number;
  queueTimeoutMs?: number;
  requestTimeoutMs?: number;
}

interface QueuedRequest {
  start(): void;
  reject(error: Error): void;
}

export function claudeRetryAfterMs(value: string | null, now = Date.now()): number {
  const seconds = value?.trim() ? Number(value) : NaN;
  const delay = Number.isFinite(seconds) ? seconds * 1000 : value ? Date.parse(value) - now : NaN;
  return Number.isFinite(delay) && delay > 0 ? Math.max(1000, delay) : 30_000;
}

export function createClaudeRequestGovernor(options: ClaudeGovernorOptions = {}) {
  const positive = (value: number | undefined, fallback: number) =>
    value !== undefined && Number.isFinite(value) && value > 0 ? Math.max(1, Math.floor(value)) : fallback;
  const maxConcurrency = positive(options.maxConcurrency, 2);
  const maxQueue = options.maxQueue === 0 ? 0 : positive(options.maxQueue, 8);
  const queueTimeoutMs = positive(options.queueTimeoutMs, 15_000);
  const requestTimeoutMs = positive(options.requestTimeoutMs, 25_000);
  const queue: QueuedRequest[] = [];
  let active = 0;
  let cooldownUntil = 0;
  let cooldownMessage = "anthropic 429 rate-limit";

  function drain(): void {
    if (Date.now() < cooldownUntil) return;
    while (active < maxConcurrency && queue.length) queue.shift()!.start();
  }

  function cooldown(status: number, retryAfter: string | null): void {
    cooldownUntil = Math.max(cooldownUntil, Date.now() + claudeRetryAfterMs(retryAfter));
    cooldownMessage = status === 429 ? "anthropic 429 rate-limit" : "anthropic 529 overloaded";
    // Reject waiting work now, rather than silently charging for it much later.
    for (const item of queue.splice(0)) item.reject(new Error(cooldownMessage));
  }

  function run<T>(work: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(new Error("anthropic-cancelled"));
    if (Date.now() < cooldownUntil) return Promise.reject(new Error(cooldownMessage));
    if (active >= maxConcurrency && queue.length >= maxQueue) return Promise.reject(new Error("anthropic-busy"));

    return new Promise<T>((resolve, reject) => {
      let started = false;
      let settled = false;
      let controller: AbortController | undefined;
      let queueTimer: ReturnType<typeof setTimeout> | undefined;
      let requestTimer: ReturnType<typeof setTimeout> | undefined;

      function finish(value: T | undefined, error?: unknown): void {
        if (settled) return;
        settled = true;
        clearTimeout(queueTimer);
        clearTimeout(requestTimer);
        signal?.removeEventListener("abort", cancel);
        if (started) active -= 1;
        else {
          const index = queue.indexOf(item);
          if (index >= 0) queue.splice(index, 1);
        }
        if (error !== undefined) reject(error);
        else resolve(value as T);
        drain();
      }

      function cancel(): void {
        controller?.abort();
        finish(undefined, new Error("anthropic-cancelled"));
      }

      const item: QueuedRequest = {
        start() {
          if (settled) return;
          clearTimeout(queueTimer);
          started = true;
          active += 1;
          controller = new AbortController();
          const transportSignal = controller.signal;
          requestTimer = setTimeout(() => {
            controller!.abort();
            finish(undefined, new Error("anthropic-timeout"));
          }, requestTimeoutMs);
          // Catch synchronous setup errors, and observe late rejection after abort.
          Promise.resolve().then(() => {
            if (transportSignal.aborted) throw new Error("anthropic-cancelled");
            return work(transportSignal);
          }).then((value) => finish(value), (error) => finish(undefined, error ?? new Error("anthropic-request-failed")));
        },
        reject(error) { finish(undefined, error); },
      };
      queue.push(item);
      signal?.addEventListener("abort", cancel, { once: true });
      queueTimer = setTimeout(() => item.reject(new Error("anthropic-queue-timeout")), queueTimeoutMs);
      drain();
    });
  }

  return { run, cooldown };
}

export const claudeRequestGovernor = createClaudeRequestGovernor();
