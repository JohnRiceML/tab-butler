/**
 * Pure, deterministic state transitions for LinkedIn's manually confirmed comment log.
 *
 * Version 2 added bounded confirmed-entry removal markers. Version 3 adds a persistent
 * metadata-only review queue and dismissal markers. These markers make explicit undo/dismiss
 * actions converge when a stale LinkedIn tab later writes its older copy of the log. `total`
 * counts confirmed comments only: retention and review transitions never lower it, while an
 * explicit `removeLatestCommentEntry` may correct it downward.
 */

export const COMMENT_LOG_VERSION = 3 as const;
export const DEFAULT_COMMENT_LOG_LIMIT = 1_000;

export interface CommentLogEntry {
  postId: string;
  author: string;
  authorKey?: string;
  permalink?: string;
  postedAt: number;
}

export interface CommentLogRemoval {
  postId: string;
  removedAt: number;
}

export interface PendingCommentReview {
  postId: string;
  author: string;
  permalink?: string;
  copiedAt: number;
  lastCopiedAt: number;
  copyCount: number;
}

export type CommentReviewStart = Pick<PendingCommentReview, "postId" | "author" | "copiedAt"> & {
  permalink?: string;
};

export type CommentReviewRef = string | Pick<PendingCommentReview, "postId">;

export interface CommentReviewDismissal {
  postId: string;
  dismissedAt: number;
}

export interface CommentLog {
  version: typeof COMMENT_LOG_VERSION;
  total: number;
  entries: CommentLogEntry[];
  removed: CommentLogRemoval[];
  pending: PendingCommentReview[];
  dismissed: CommentReviewDismissal[];
}

export type CommentLogEventRef = Pick<CommentLogEntry, "postId" | "postedAt"> & {
  author?: string;
  permalink?: string;
  copiedAt?: number;
  lastCopiedAt?: number;
  copyCount?: number;
};

function retentionLimit(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : DEFAULT_COMMENT_LOG_LIMIT;
}

function cleanText(value: unknown, max: number): string {
  if (typeof value !== "string" && typeof value !== "number") return "";
  return String(value).replace(/\s+/g, " ").trim().slice(0, max);
}

function nonNegativeInteger(value: unknown, fallback = 0): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
}

function normalizedPermalink(value: unknown): string | undefined {
  const raw = cleanText(value, 2_048);
  if (!raw) return undefined;
  try {
    const url = new URL(raw, "https://www.linkedin.com");
    if (!/(^|\.)linkedin\.com$/i.test(url.hostname)) return undefined;
    if (!/(\/feed\/update\/|\/posts\/)/i.test(url.pathname)) return undefined;
    url.protocol = "https:";
    url.hash = "";
    url.search = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

function normalizedAuthorKey(value: unknown): string | undefined {
  const raw = cleanText(value, 300).toLowerCase();
  const match = raw.match(/^\/(in|company)\/[a-z0-9._~-]+\/?$/i);
  return match ? raw.replace(/\/+$/, "") : undefined;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Newest first; ties use code-unit ordering so output does not depend on input or locale. */
function compareEntries(left: CommentLogEntry, right: CommentLogEntry): number {
  if (left.postedAt !== right.postedAt) return right.postedAt - left.postedAt;
  const id = compareText(left.postId, right.postId);
  if (id) return id;
  const author = compareText(left.author, right.author);
  if (author) return author;
  const authorKey = compareText(left.authorKey ?? "", right.authorKey ?? "");
  if (authorKey) return authorKey;
  return compareText(left.permalink ?? "", right.permalink ?? "");
}

function compareRemovals(left: CommentLogRemoval, right: CommentLogRemoval): number {
  return right.removedAt - left.removedAt || compareText(left.postId, right.postId);
}

/** Most recently copied first, then deterministic post ID/payload ties. */
function comparePending(left: PendingCommentReview, right: PendingCommentReview): number {
  if (left.lastCopiedAt !== right.lastCopiedAt) return right.lastCopiedAt - left.lastCopiedAt;
  const id = compareText(left.postId, right.postId);
  if (id) return id;
  if (left.copiedAt !== right.copiedAt) return left.copiedAt - right.copiedAt;
  const author = compareText(left.author, right.author);
  if (author) return author;
  return compareText(left.permalink ?? "", right.permalink ?? "");
}

function compareDismissals(left: CommentReviewDismissal, right: CommentReviewDismissal): number {
  return right.dismissedAt - left.dismissedAt || compareText(left.postId, right.postId);
}

function preferredEntry(left: CommentLogEntry, right: CommentLogEntry): CommentLogEntry {
  return compareEntries(left, right) <= 0 ? left : right;
}

function preferredPending(left: PendingCommentReview, right: PendingCommentReview): PendingCommentReview {
  const latest = comparePending(left, right) <= 0 ? left : right;
  const copiedAt = Math.min(left.copiedAt, right.copiedAt);
  const lastCopiedAt = Math.max(left.lastCopiedAt, right.lastCopiedAt);
  const copyCount = Math.max(left.copyCount, right.copyCount);
  const permalink = latest.permalink ?? left.permalink ?? right.permalink;
  return permalink
    ? { postId: latest.postId, author: latest.author, permalink, copiedAt, lastCopiedAt, copyCount }
    : { postId: latest.postId, author: latest.author, copiedAt, lastCopiedAt, copyCount };
}

function entryFrom(value: unknown): CommentLogEntry | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
  const postId = cleanText(row.postId ?? row.id, 180);
  if (!postId) return undefined;
  const author = cleanText(row.author, 120) || "LinkedIn member";
  const authorKey = normalizedAuthorKey(row.authorKey);
  const permalink = normalizedPermalink(row.permalink ?? row.url);
  const postedAt = nonNegativeInteger(row.postedAt ?? row.at ?? row.timestamp);
  return {
    postId,
    author,
    ...(authorKey ? { authorKey } : {}),
    ...(permalink ? { permalink } : {}),
    postedAt,
  };
}

function removalFrom(value: unknown): CommentLogRemoval | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
  const postId = cleanText(row.postId ?? row.id, 180);
  if (!postId) return undefined;
  return { postId, removedAt: nonNegativeInteger(row.removedAt ?? row.at ?? row.timestamp) };
}

function pendingFrom(value: unknown): PendingCommentReview | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
  const postId = cleanText(row.postId ?? row.id, 180);
  if (!postId) return undefined;
  const author = cleanText(row.author, 120) || "LinkedIn member";
  const permalink = normalizedPermalink(row.permalink ?? row.url);
  const rawCopiedAt = nonNegativeInteger(row.copiedAt ?? row.at ?? row.timestamp);
  const rawLastCopiedAt = nonNegativeInteger(row.lastCopiedAt, rawCopiedAt);
  const copiedAt = Math.min(rawCopiedAt, rawLastCopiedAt);
  const lastCopiedAt = Math.max(rawCopiedAt, rawLastCopiedAt);
  const copyCount = Math.max(1, nonNegativeInteger(row.copyCount, 1));
  return permalink
    ? { postId, author, permalink, copiedAt, lastCopiedAt, copyCount }
    : { postId, author, copiedAt, lastCopiedAt, copyCount };
}

function dismissalFrom(value: unknown): CommentReviewDismissal | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
  const postId = cleanText(row.postId ?? row.id, 180);
  if (!postId) return undefined;
  return { postId, dismissedAt: nonNegativeInteger(row.dismissedAt ?? row.at ?? row.timestamp) };
}

function removalMap(removals: readonly CommentLogRemoval[]): Map<string, CommentLogRemoval> {
  const result = new Map<string, CommentLogRemoval>();
  for (const removal of removals) {
    const current = result.get(removal.postId);
    if (!current || removal.removedAt > current.removedAt) result.set(removal.postId, removal);
  }
  return result;
}

function dismissalMap(dismissals: readonly CommentReviewDismissal[]): Map<string, CommentReviewDismissal> {
  const result = new Map<string, CommentReviewDismissal>();
  for (const dismissal of dismissals) {
    const current = result.get(dismissal.postId);
    if (!current || dismissal.dismissedAt > current.dismissedAt) result.set(dismissal.postId, dismissal);
  }
  return result;
}

function isActive(entry: CommentLogEntry, removals: ReadonlyMap<string, CommentLogRemoval>): boolean {
  return entry.postedAt > (removals.get(entry.postId)?.removedAt ?? -1);
}

/**
 * Accepts the old array and v1/v2 `{ total, entries }` shapes as well as v3. Invalid rows are
 * discarded, duplicate post IDs converge deterministically, and the canonical result is always
 * bounded and sorted. Older shapes migrate with `pending: []`. No wall clock or browser state
 * is consulted.
 */
export function normalizeCommentLog(value: unknown, limit = DEFAULT_COMMENT_LOG_LIMIT): CommentLog {
  const cap = retentionLimit(limit);
  const object = value && typeof value === "object" ? value as Record<string, unknown> : undefined;
  const rawEntries = Array.isArray(value)
    ? value
    : Array.isArray(object?.entries)
      ? object.entries
      : [];
  const rawRemoved = Array.isArray(object?.removed)
    ? object.removed
    : Array.isArray(object?.tombstones)
      ? object.tombstones
      : [];
  const rawPending = Array.isArray(object?.pending) ? object.pending : [];
  const rawDismissed = Array.isArray(object?.dismissed) ? object.dismissed : [];

  const dedupedEntries = new Map<string, CommentLogEntry>();
  for (const raw of rawEntries) {
    const entry = entryFrom(raw);
    if (!entry) continue;
    const current = dedupedEntries.get(entry.postId);
    dedupedEntries.set(entry.postId, current ? preferredEntry(current, entry) : entry);
  }

  const dedupedRemovals = removalMap(rawRemoved.flatMap((raw) => {
    const removal = removalFrom(raw);
    return removal ? [removal] : [];
  }));
  const dedupedDismissals = dismissalMap(rawDismissed.flatMap((raw) => {
    const dismissal = dismissalFrom(raw);
    return dismissal ? [dismissal] : [];
  }));
  const dedupedPending = new Map<string, PendingCommentReview>();
  for (const raw of rawPending) {
    const pending = pendingFrom(raw);
    if (!pending) continue;
    const current = dedupedPending.get(pending.postId);
    dedupedPending.set(pending.postId, current ? preferredPending(current, pending) : pending);
  }
  const allEntries = [...dedupedEntries.values()]
    .filter((entry) => isActive(entry, dedupedRemovals))
    .sort(compareEntries);
  const allRemoved = [...dedupedRemovals.values()].sort(compareRemovals);
  const confirmedIds = new Set(allEntries.map((entry) => entry.postId));
  const allPending = [...dedupedPending.values()]
    .filter((pending) => !confirmedIds.has(pending.postId))
    .filter((pending) => pending.lastCopiedAt > (dedupedDismissals.get(pending.postId)?.dismissedAt ?? -1))
    .sort(comparePending);
  const allDismissed = [...dedupedDismissals.values()].sort(compareDismissals);
  const declaredTotal = nonNegativeInteger(object?.total);

  return {
    version: COMMENT_LOG_VERSION,
    total: Math.max(declaredTotal, allEntries.length),
    entries: allEntries.slice(0, cap),
    removed: allRemoved.slice(0, cap),
    pending: allPending.slice(0, cap),
    dismissed: allDismissed.slice(0, cap),
  };
}

/** Canonical JSON suitable for stable storage comparisons and change suppression. */
export function serializeCommentLog(value: unknown, limit = DEFAULT_COMMENT_LOG_LIMIT): string {
  return JSON.stringify(normalizeCommentLog(value, limit));
}

export const stableSerializeCommentLog = serializeCommentLog;

export function commentLogsEqual(left: unknown, right: unknown, limit = DEFAULT_COMMENT_LOG_LIMIT): boolean {
  return serializeCommentLog(left, limit) === serializeCommentLog(right, limit);
}

export const equalCommentLogs = commentLogsEqual;

function mergedRemovals(left: CommentLog, right: CommentLog): CommentLogRemoval[] {
  return [...removalMap([...left.removed, ...right.removed]).values()].sort(compareRemovals);
}

function mergedDismissals(left: CommentLog, right: CommentLog): CommentReviewDismissal[] {
  return [...dismissalMap([...left.dismissed, ...right.dismissed]).values()].sort(compareDismissals);
}

function entriesSurviving(entries: readonly CommentLogEntry[], removals: readonly CommentLogRemoval[]): CommentLogEntry[] {
  const byPost = removalMap(removals);
  return entries.filter((entry) => isActive(entry, byPost));
}

/**
 * A missing entry is not novel when it falls behind a full retained window: the other writer
 * has already pruned it. This keeps a stale 1,000-row tab from inflating a 1,001-total current
 * tab, while genuinely concurrent recent additions still contribute to the merged total.
 */
function countNovelEntries(
  source: readonly CommentLogEntry[],
  targetActive: readonly CommentLogEntry[],
  targetWindow: readonly CommentLogEntry[],
  cap: number,
): number {
  const targetIds = new Set(targetActive.map((entry) => entry.postId));
  const fullWindow = targetWindow.length >= cap;
  const frontier = fullWindow ? targetWindow[targetWindow.length - 1] : undefined;
  let novel = 0;
  for (const entry of source) {
    if (targetIds.has(entry.postId)) continue;
    if (frontier && compareEntries(entry, frontier) >= 0) continue;
    novel += 1;
  }
  return novel;
}

/**
 * Commutative merge for independently read/written tabs.
 *
 * Same-post concurrent marks add one to `total`; different-post concurrent marks add both.
 * A v2 removal corrects a stale copy that still contains the removed entry. Normal pruning is
 * never inferred as an undo, so it cannot lower `total`.
 */
export function mergeCommentLogs(
  leftValue: unknown,
  rightValue: unknown,
  limit = DEFAULT_COMMENT_LOG_LIMIT,
): CommentLog {
  const cap = retentionLimit(limit);
  const left = normalizeCommentLog(leftValue, cap);
  const right = normalizeCommentLog(rightValue, cap);
  const removed = mergedRemovals(left, right);
  const dismissed = mergedDismissals(left, right);
  const leftActive = entriesSurviving(left.entries, removed);
  const rightActive = entriesSurviving(right.entries, removed);

  // An explicit removal from the other state is the sole merge operation allowed to correct
  // a source total downward. Entries absent only because of retention are never subtracted.
  const leftSuppressed = left.entries.length - leftActive.length;
  const rightSuppressed = right.entries.length - rightActive.length;
  const leftTotal = Math.max(leftActive.length, left.total - leftSuppressed);
  const rightTotal = Math.max(rightActive.length, right.total - rightSuppressed);

  const byPost = new Map<string, CommentLogEntry>();
  for (const entry of [...leftActive, ...rightActive]) {
    const current = byPost.get(entry.postId);
    byPost.set(entry.postId, current ? preferredEntry(current, entry) : entry);
  }
  const allEntries = [...byPost.values()].sort(compareEntries);
  const confirmedIds = new Set(byPost.keys());
  const dismissalsByPost = dismissalMap(dismissed);
  const pendingByPost = new Map<string, PendingCommentReview>();
  for (const pending of [...left.pending, ...right.pending]) {
    if (confirmedIds.has(pending.postId)) continue;
    if (pending.lastCopiedAt <= (dismissalsByPost.get(pending.postId)?.dismissedAt ?? -1)) continue;
    const current = pendingByPost.get(pending.postId);
    pendingByPost.set(pending.postId, current ? preferredPending(current, pending) : pending);
  }
  const pending = [...pendingByPost.values()].sort(comparePending);
  const novelRight = countNovelEntries(rightActive, leftActive, left.entries, cap);
  const novelLeft = countNovelEntries(leftActive, rightActive, right.entries, cap);
  const total = Math.max(
    allEntries.length,
    leftTotal + novelRight,
    rightTotal + novelLeft,
  );

  return normalizeCommentLog({
    version: COMMENT_LOG_VERSION,
    total,
    entries: allEntries,
    removed,
    pending,
    dismissed,
  }, cap);
}

/**
 * Persist a copy-to-review handoff without claiming that a LinkedIn comment was posted.
 * Re-copying the same post refreshes one row and advances its count only for a newer copy event.
 */
export function startCommentReview(
  value: unknown,
  review: CommentReviewStart,
  limit = DEFAULT_COMMENT_LOG_LIMIT,
): CommentLog {
  const cap = retentionLimit(limit);
  const log = normalizeCommentLog(value, cap);
  const incoming = pendingFrom(review);
  if (!incoming || log.entries.some((entry) => entry.postId === incoming.postId)) return log;
  const dismissal = log.dismissed.find((candidate) => candidate.postId === incoming.postId);
  if (dismissal && incoming.lastCopiedAt <= dismissal.dismissedAt) return log;

  const existing = log.pending.find((candidate) => candidate.postId === incoming.postId);
  let pending: PendingCommentReview;
  if (!existing) {
    pending = incoming;
  } else if (incoming.lastCopiedAt > existing.lastCopiedAt) {
    const permalink = incoming.permalink ?? existing.permalink;
    pending = permalink
      ? {
          ...incoming,
          permalink,
          copiedAt: Math.min(existing.copiedAt, incoming.copiedAt),
          copyCount: existing.copyCount + 1,
        }
      : {
          ...incoming,
          copiedAt: Math.min(existing.copiedAt, incoming.copiedAt),
          copyCount: existing.copyCount + 1,
        };
  } else {
    pending = preferredPending(existing, incoming);
  }
  return normalizeCommentLog({
    ...log,
    pending: [...log.pending.filter((candidate) => candidate.postId !== pending.postId), pending],
  }, cap);
}

/** Dismiss one active review handoff. Confirmed totals and entries are untouched. */
export function dismissCommentReview(
  value: unknown,
  review: CommentReviewRef,
  dismissedAt: number,
  limit = DEFAULT_COMMENT_LOG_LIMIT,
): CommentLog {
  const cap = retentionLimit(limit);
  const log = normalizeCommentLog(value, cap);
  const postId = cleanText(typeof review === "string" ? review : review?.postId, 180);
  const existing = log.pending.find((pending) => pending.postId === postId);
  if (!existing) return log;
  const correctionAt = Math.max(nonNegativeInteger(dismissedAt), existing.lastCopiedAt);
  const prior = log.dismissed.find((candidate) => candidate.postId === postId);
  return normalizeCommentLog({
    ...log,
    pending: log.pending.filter((pending) => pending.postId !== postId),
    dismissed: [
      ...log.dismissed.filter((candidate) => candidate.postId !== postId),
      { postId, dismissedAt: Math.max(correctionAt, prior?.dismissedAt ?? 0) },
    ],
  }, cap);
}

/**
 * Add or refresh one confirmed post ID. Confirmation atomically clears the same-post pending
 * review; an already-confirmed post never increments the lifetime total.
 */
export function addCommentLogEntry(
  value: unknown,
  rawEntry: CommentLogEntry,
  limit = DEFAULT_COMMENT_LOG_LIMIT,
): CommentLog {
  const cap = retentionLimit(limit);
  const log = normalizeCommentLog(value, cap);
  const entry = entryFrom(rawEntry);
  if (!entry) return log;
  const removal = log.removed.find((candidate) => candidate.postId === entry.postId);
  if (removal && entry.postedAt <= removal.removedAt) return log;

  const existing = log.entries.find((candidate) => candidate.postId === entry.postId);
  const entries = existing
    ? log.entries.map((candidate) => candidate.postId === entry.postId ? preferredEntry(candidate, entry) : candidate)
    : [...log.entries, entry];
  return normalizeCommentLog({
    ...log,
    total: log.total + (existing ? 0 : 1),
    entries,
  }, cap);
}

export function markCommentPosted(
  value: unknown,
  entry: CommentLogEntry,
  limit = DEFAULT_COMMENT_LOG_LIMIT,
): CommentLog {
  return addCommentLogEntry(value, entry, limit);
}

export function confirmCommentPosted(
  value: unknown,
  entry: CommentLogEntry,
  limit = DEFAULT_COMMENT_LOG_LIMIT,
): CommentLog {
  return markCommentPosted(value, entry, limit);
}

/** The exact event reference callers can retain for a one-action undo control. */
export function latestCommentEntry(value: unknown, limit = DEFAULT_COMMENT_LOG_LIMIT): CommentLogEntry | undefined {
  return normalizeCommentLog(value, limit).entries[0];
}

/**
 * Remove only the currently retained event matching both post ID and posted timestamp. A stale
 * undo reference is a no-op, so it cannot remove a newer re-mark of the same LinkedIn post.
 * When the reference includes an author, the correction atomically restores a pending review.
 */
export function removeLatestCommentEntry(
  value: unknown,
  event: CommentLogEventRef,
  removedAt: number,
  limit = DEFAULT_COMMENT_LOG_LIMIT,
): CommentLog {
  const cap = retentionLimit(limit);
  const log = normalizeCommentLog(value, cap);
  const postId = cleanText(event?.postId, 180);
  const postedAt = nonNegativeInteger(event?.postedAt, -1);
  const existing = log.entries.find((entry) => entry.postId === postId);
  if (!existing || existing.postedAt !== postedAt) return log;

  const correctionAt = Math.max(nonNegativeInteger(removedAt), existing.postedAt);
  const priorRemoval = log.removed.find((candidate) => candidate.postId === postId);
  const removed = [
    ...log.removed.filter((candidate) => candidate.postId !== postId),
    { postId, removedAt: Math.max(correctionAt, priorRemoval?.removedAt ?? 0) },
  ];
  const author = cleanText(event.author, 120);
  const restored = author ? pendingFrom({
    postId,
    author,
    permalink: event.permalink,
    copiedAt: event.copiedAt ?? correctionAt,
    lastCopiedAt: Math.max(nonNegativeInteger(event.lastCopiedAt), correctionAt),
    copyCount: event.copyCount,
  }) : undefined;
  return normalizeCommentLog({
    ...log,
    total: Math.max(0, log.total - 1),
    entries: log.entries.filter((entry) => entry.postId !== postId),
    removed,
    pending: restored
      ? [...log.pending.filter((pending) => pending.postId !== postId), restored]
      : log.pending,
    dismissed: restored
      ? log.dismissed.filter((dismissal) => dismissal.postId !== postId)
      : log.dismissed,
  }, cap);
}

export function undoLatestComment(
  value: unknown,
  event: CommentLogEventRef,
  removedAt: number,
  limit = DEFAULT_COMMENT_LOG_LIMIT,
): CommentLog {
  return removeLatestCommentEntry(value, event, removedAt, limit);
}
