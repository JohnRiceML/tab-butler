/** Missing or malformed model rows are scan failures, never a judgment about a post. */
export function hasCompleteXScores(value: unknown, expectedIndices: number[]): boolean {
  if (!expectedIndices.length || new Set(expectedIndices).size !== expectedIndices.length ||
      !Array.isArray(value) || value.length !== expectedIndices.length) return false;
  const remaining = new Set(expectedIndices);
  for (const row of value) {
    if (!row || typeof row !== "object" || !Number.isInteger(row.i) || !remaining.delete(row.i) ||
        typeof row.score !== "number" || !Number.isFinite(row.score) || row.score < 0 || row.score > 1 ||
        typeof row.reason !== "string" || !row.reason.trim()) return false;
  }
  return remaining.size === 0;
}

/** Each row includes the score, rationale, anchor and reply brief. Twelve rows
 * cannot reliably fit in the old fixed 1,536-token allowance. */
export function xScoreOutputTokens(postCount: number): number {
  return Math.min(8_192, Math.max(1_536, 256 + postCount * 300));
}
