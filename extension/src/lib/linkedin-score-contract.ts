import type {
  LinkedInCommentLane,
  LinkedInDecision,
  LinkedInPersonEvidence,
  LinkedInRisk,
} from "./linkedin-opportunity-ranking";

const DECISIONS = new Set<LinkedInDecision>(["comment", "skip", "needs_detail"]);
const RISKS = new Set<LinkedInRisk>(["none", "generic", "promotional", "context_mismatch", "hostile"]);
const EVIDENCE = new Set<LinkedInPersonEvidence>(["visible_headline", "post_stated_context", "exact_user_target", "name_only"]);
const LANES = new Set<LinkedInCommentLane>(["mechanism", "implementation_detail", "boundary_condition", "decision_implication", "evidence_question", "supplied_example"]);

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unit(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function present(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function completeRow(value: unknown, expectedLength: number, indices: Set<number>): boolean {
  if (!record(value)) return false;
  const index = value.i;
  if (!Number.isInteger(index) || (index as number) < 0 || (index as number) >= expectedLength || indices.has(index as number)) return false;
  indices.add(index as number);

  if (typeof value.decision !== "string" || !DECISIONS.has(value.decision as LinkedInDecision)) return false;
  if (typeof value.risk !== "string" || !RISKS.has(value.risk as LinkedInRisk)) return false;
  // A skipped row only needs to be an explicit, safe classification. Requiring
  // comment guidance for it makes one terse skip invalidate the entire batch.
  if (value.decision === "skip") return true;
  if (!unit(value.postFit) || !unit(value.personFit) || !unit(value.contributionFit)) return false;
  if (!present(value.postReason) || !present(value.personReason)) return false;
  if (typeof value.personEvidence !== "string" || !EVIDENCE.has(value.personEvidence as LinkedInPersonEvidence)) return false;
  if (!present(value.anchor) || !present(value.replyBrief) ||
    typeof value.commentLane !== "string" || !LANES.has(value.commentLane as LinkedInCommentLane)) return false;

  if (value.decision === "comment") {
    return value.risk === "none";
  }
  if (value.decision === "needs_detail") {
    return present(value.missingDetailPrompt);
  }
  return false;
}

/**
 * A LinkedIn scoring response is usable only when it classifies every requested
 * post exactly once. This prevents empty or partial model JSON from becoming a
 * false successful scan with zero opportunities.
 */
export function hasCompleteLinkedInScores(value: unknown, expectedLength: number): boolean {
  if (!Number.isInteger(expectedLength) || expectedLength < 1 || !Array.isArray(value) || value.length !== expectedLength) return false;
  const indices = new Set<number>();
  return value.every((row) => completeRow(row, expectedLength, indices)) && indices.size === expectedLength;
}
