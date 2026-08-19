/** Pure policy for the shared Twttr network scheduler. IO and timers stay in the service worker. */

export const TWTTR_SCHEDULER_MAX_CONCURRENCY = 8;
export const TWTTR_SCHEDULER_MAX_INTENT_STREAK = 8;
export const TWTTR_SCHEDULER_MIN_RATE = 0.000001; // numeric floor only; never overrun a nearly empty provider window

export interface TwttrQueueItem { intent: boolean }

/** Explicit clicks may jump ahead of ambient enrichment, but one ambient item is admitted after
 * every bounded high-priority streak so a long Fresh Reach hunt cannot starve background state. */
export function nextTwttrQueueIndex(
  queue: readonly TwttrQueueItem[],
  intentStreak: number,
  maxIntentStreak = TWTTR_SCHEDULER_MAX_INTENT_STREAK,
): number {
  if (!queue.length) return -1;
  const firstIntent = queue.findIndex((item) => item.intent);
  const firstAmbient = queue.findIndex((item) => !item.intent);
  if (firstIntent >= 0 && (firstAmbient < 0 || intentStreak < Math.max(1, maxIntentStreak))) return firstIntent;
  return firstAmbient >= 0 ? firstAmbient : firstIntent;
}

/** Convert the provider's remaining/reset window into a sustainable dispatch rate. The local
 * ceiling always wins. A small margin absorbs timer jitter and concurrent response reordering. */
export function adaptiveTwttrRate(
  localCeiling: number,
  providerRemaining: number | undefined,
  providerResetAt: number | undefined,
  now: number,
): number {
  const local = Math.max(TWTTR_SCHEDULER_MIN_RATE, localCeiling);
  if (!Number.isFinite(providerRemaining) || !Number.isFinite(providerResetAt)) return local;
  const secondsLeft = ((providerResetAt as number) - now) / 1000;
  if (secondsLeft <= 0) return local;
  if ((providerRemaining as number) <= 0) return 0;
  const sustainable = ((providerRemaining as number) / secondsLeft) * 0.92;
  return Math.min(local, Math.max(TWTTR_SCHEDULER_MIN_RATE, sustainable));
}

/** Delay until the next evenly-spaced dispatch. Starting empty means a cold worker never bursts. */
export function twttrDispatchDelayMs(ratePerSecond: number, lastDispatchAt: number, now: number): number {
  if (ratePerSecond <= 0) return Number.POSITIVE_INFINITY;
  if (!lastDispatchAt) return 0;
  return Math.max(0, Math.ceil(lastDispatchAt + 1000 / ratePerSecond - now));
}
