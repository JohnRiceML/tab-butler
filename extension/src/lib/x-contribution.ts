import { findContributionAnchor } from "./contribution-evidence";

export interface XContributionInput {
  score: number;
  text: string;
  context?: string;
  anchor?: string;
  replyBrief?: string;
  replyMove?: string;
  risk?: string;
  category?: string;
  isReplyToOwnPost?: boolean;
}
export type XContributionCode = "ready" | "low-fit" | "risk" | "missing-risk" | "missing-anchor" | "ungrounded-anchor" | "missing-move" | "missing-brief" | "generic-brief";
export interface XContributionAssessment {
  eligible: boolean;
  /** Safe grounding can still guide an explicitly requested lower-fit reply. */
  ready: boolean;
  grounded: boolean;
  code: XContributionCode;
  reason: string;
}
const MOVES = new Set(["add_detail", "counterpoint", "concrete_example", "narrow_question", "substantive_support"]);
const normalize = (text: string): string => text.toLocaleLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
// Exact placeholders, not topic/word filters: specific questions, jokes and support remain valid.
const PLACEHOLDER_BRIEFS = new Set(["add value", "add a useful detail", "ask a question", "ask a thoughtful question", "write a reply", "write a thoughtful reply", "offer support", "say something funny", "agree with the author", "engage with the post"]);

/** A high fit number never replaces evidence of a worthwhile contribution. */
export function assessXContribution(input: XContributionInput): XContributionAssessment {
  const blocked = (code: XContributionCode, reason: string, grounded = false): XContributionAssessment => ({ eligible: false, ready: false, grounded, code, reason });
  if (input.risk !== "none") return blocked(input.risk ? "risk" : "missing-risk", input.risk === "generic" ? "Only a generic reply was identified" : input.risk === "promotional" ? "The suggested reply risks an unsolicited pitch" : input.risk === "context_mismatch" ? "The suggested reply does not fit this post" : input.risk === "hostile" ? "The suggested reply risks a hostile exchange" : "Reply risks have not been assessed");
  if (!input.anchor?.trim()) return blocked("missing-anchor", "No specific post detail was identified");
  if (!findContributionAnchor(input.anchor, input)) return blocked("ungrounded-anchor", "The proposed detail is not in the supplied post");
  if (!input.replyMove || !MOVES.has(input.replyMove)) return blocked("missing-move", "No clear contribution was identified", true);
  if (!input.replyBrief?.trim()) return blocked("missing-brief", "No concrete reply direction was identified", true);
  const brief = normalize(input.replyBrief);
  if (!brief || PLACEHOLDER_BRIEFS.has(brief) || brief === normalize(input.anchor) || brief === normalize(input.text)) return blocked("generic-brief", "The reply direction adds no specific contribution", true);
  const threshold = input.isReplyToOwnPost ? 0.4 : 0.6;
  const eligible = Number.isFinite(input.score) && input.score >= threshold && input.score <= 1;
  return { eligible, ready: true, grounded: true, code: eligible ? "ready" : "low-fit", reason: eligible ? input.replyBrief.trim() : "Lower fit for your current focus" };
}
