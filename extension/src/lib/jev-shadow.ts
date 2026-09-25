import { CONFIG } from "./config";
import { reviewWithJev, jevReviewFlags, type JevReviewInput, type JevFlag } from "./jev-review";

export const JEV_CONSENT_VERSION = "v1";
export interface JevObservation {
  at: number;
  platform: "x" | "linkedin";
  status: "reviewed" | "unavailable";
  model?: string;
  latencyMs?: number;
  inputTokens?: number;
  flags?: JevFlag[];
  error?: string;
}

let writes: Promise<void> = Promise.resolve();
async function record(observation: JevObservation, signal?: AbortSignal): Promise<void> {
  // Serialize concurrent X/LinkedIn completions so one does not erase the other.
  writes = writes.catch(() => {}).then(async () => {
    if (signal?.aborted) return;
    const stored = await chrome.storage.local.get([CONFIG.JEV_REVIEW_LOG_KEY, CONFIG.JEV_REVIEW_MODE_KEY, CONFIG.JEV_REVIEW_CONSENT_KEY]);
    if (signal?.aborted || stored[CONFIG.JEV_REVIEW_MODE_KEY] !== "shadow" || stored[CONFIG.JEV_REVIEW_CONSENT_KEY] !== JEV_CONSENT_VERSION) return;
    const log = Array.isArray(stored[CONFIG.JEV_REVIEW_LOG_KEY]) ? stored[CONFIG.JEV_REVIEW_LOG_KEY] as JevObservation[] : [];
    await chrome.storage.local.set({ [CONFIG.JEV_REVIEW_LOG_KEY]: [...log.slice(-49), observation] });
  });
  await writes;
}

/** Explicit draft actions only. A failed reviewer never suppresses or changes a draft.
 * Awaited to keep the MV3 worker alive; bounded by Jev's four-second deadline.
 */
export async function observeCommentWithJev(input: JevReviewInput, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  try {
    const stored = await chrome.storage.local.get([CONFIG.TYPESAFE_KEY_KEY, CONFIG.JEV_REVIEW_MODE_KEY, CONFIG.JEV_REVIEW_CONSENT_KEY]);
    const key = stored[CONFIG.TYPESAFE_KEY_KEY];
    if (signal?.aborted || typeof key !== "string" || !key.trim() ||
        stored[CONFIG.JEV_REVIEW_MODE_KEY] !== "shadow" || stored[CONFIG.JEV_REVIEW_CONSENT_KEY] !== JEV_CONSENT_VERSION) return;
    try {
      const review = await reviewWithJev(key, input, signal);
      if (signal?.aborted) return;
      await record({ at: Date.now(), platform: input.platform, status: "reviewed", model: review.model,
        latencyMs: review.latencyMs, inputTokens: review.inputTokens, flags: jevReviewFlags(review) }, signal);
    } catch (error) {
      if (signal?.aborted) return;
      const code = error instanceof Error && /^jev-[a-z0-9-]+$/.test(error.message) ? error.message : "jev-unavailable";
      await record({ at: Date.now(), platform: input.platform, status: "unavailable", error: code }, signal);
    }
  } catch { /* Storage failure must not turn optional review into a failed comment. */ }
}
