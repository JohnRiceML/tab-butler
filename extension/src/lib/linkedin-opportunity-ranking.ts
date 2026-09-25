/** Pure, deterministic LinkedIn eligibility and relationship-spacing policy. */

import type { LinkedInRelationshipRules } from "./linkedin-strategy";
import { findContributionAnchor } from "./contribution-evidence";

export type LinkedInDecision = "comment" | "skip" | "needs_detail";
export type LinkedInPersonEvidence = "visible_headline" | "post_stated_context" | "exact_user_target" | "name_only";
export type LinkedInCommentLane =
  | "mechanism"
  | "implementation_detail"
  | "boundary_condition"
  | "decision_implication"
  | "evidence_question"
  | "supplied_example";
export type LinkedInRisk = "none" | "generic" | "promotional" | "context_mismatch" | "hostile";

export const LINKEDIN_COMMENT_LANES = new Set<LinkedInCommentLane>([
  "mechanism",
  "implementation_detail",
  "boundary_condition",
  "decision_implication",
  "evidence_question",
  "supplied_example",
]);
const PERSON_EVIDENCE = new Set<LinkedInPersonEvidence>([
  "visible_headline", "post_stated_context", "exact_user_target", "name_only",
]);

export interface LinkedInOpportunityAssessment {
  /** Include the captured source whenever evaluating an actual feed candidate. */
  text?: string;
  context?: string;
  decision?: LinkedInDecision;
  postFit?: number;
  personFit?: number;
  contributionFit?: number;
  postReason?: string;
  personReason?: string;
  personEvidence?: LinkedInPersonEvidence;
  anchor?: string;
  commentLane?: LinkedInCommentLane;
  replyBrief?: string;
  missingDetailPrompt?: string;
  risk?: LinkedInRisk;
}

export interface LinkedInEligibility {
  eligible: boolean;
  lane: "target" | "discovery" | "detail" | "blocked";
  priority: number;
  reason?: string;
}

function finiteScore(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function present(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

export function evaluateLinkedInOpportunity(value: LinkedInOpportunityAssessment): LinkedInEligibility {
  if (value.decision !== "comment" && value.decision !== "needs_detail") return { eligible: false, lane: "blocked", priority: 0, reason: "decision" };
  if (!finiteScore(value.postFit) || !finiteScore(value.personFit) || !finiteScore(value.contributionFit)) {
    return { eligible: false, lane: "blocked", priority: 0, reason: "scores" };
  }
  if (!present(value.postReason) || !present(value.personReason) || !value.personEvidence || !PERSON_EVIDENCE.has(value.personEvidence)) {
    return { eligible: false, lane: "blocked", priority: 0, reason: "evidence" };
  }
  // A missing user fact changes readiness, not the standard of guidance. Both
  // surfaced tiers need to name the exact point and the contribution it unlocks.
  if (!present(value.anchor) || !present(value.replyBrief) || !value.commentLane || !LINKEDIN_COMMENT_LANES.has(value.commentLane)) {
    return { eligible: false, lane: "blocked", priority: 0, reason: "guidance" };
  }
  if (typeof value.text === "string" && !findContributionAnchor(value.anchor, { text: value.text, context: value.context })) {
    return { eligible: false, lane: "blocked", priority: 0, reason: "ungrounded_anchor" };
  }
  const personFit = value.personEvidence === "name_only" ? Math.min(0.5, value.personFit) : value.personFit;
  if (value.decision === "needs_detail") {
    if ((value.risk !== "none" && value.risk !== "generic") || !present(value.missingDetailPrompt) || value.postFit < 0.5 || value.contributionFit < 0.3) {
      return { eligible: false, lane: "blocked", priority: 0, reason: "needs_detail" };
    }
    return {
      eligible: true,
      lane: "detail",
      priority: 0.55 * value.postFit + 0.15 * personFit + 0.3 * value.contributionFit,
    };
  }
  if (value.risk !== "none") return { eligible: false, lane: "blocked", priority: 0, reason: "risk" };
  if (value.postFit < 0.62 || value.contributionFit < 0.6) {
    return { eligible: false, lane: "blocked", priority: 0, reason: "content" };
  }
  const lane = personFit >= 0.6 && value.personEvidence !== "name_only"
    ? "target"
    : value.postFit >= 0.68
      ? "discovery"
      : "blocked";
  if (lane === "blocked") return { eligible: false, lane, priority: 0, reason: "person" };
  return {
    eligible: true,
    lane,
    priority: 0.5 * value.postFit + 0.3 * personFit + 0.2 * value.contributionFit,
  };
}

export interface LinkedInAuthorActivity {
  authorKey?: string;
  author: string;
  postedAt: number;
}

export interface RankableLinkedInOpportunity extends LinkedInOpportunityAssessment {
  id: string;
  authorKey?: string;
  author: string;
  foundAt: number;
}

export interface RankedLinkedInOpportunity<T> {
  item: T;
  priority: number;
  relationshipNote?: string;
}

function authorIdentity(value: { authorKey?: string; author: string }): string {
  const stable = value.authorKey?.trim().toLowerCase();
  return stable || `name:${value.author.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase()}`;
}

function authorNameIdentity(author: string): string {
  return `name:${author.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase()}`;
}

export function rankLinkedInOpportunities<T extends RankableLinkedInOpportunity>(
  candidates: readonly T[],
  activity: readonly LinkedInAuthorActivity[],
  rules: LinkedInRelationshipRules,
  now = Date.now(),
): RankedLinkedInOpportunity<T>[] {
  const DAY = 86_400_000;
  const history = new Map<string, number[]>();
  for (const event of activity) {
    if (!Number.isFinite(event.postedAt) || event.postedAt < 0 || event.postedAt > now + 60_000) continue;
    const key = authorIdentity(event);
    history.set(key, [...(history.get(key) ?? []), event.postedAt].sort((a, b) => b - a));
    const nameKey = authorNameIdentity(event.author);
    if (nameKey !== key) history.set(nameKey, [...(history.get(nameKey) ?? []), event.postedAt].sort((a, b) => b - a));
  }

  const scored: RankedLinkedInOpportunity<T>[] = [];
  for (const item of candidates) {
    const eligibility = evaluateLinkedInOpportunity(item);
    if (!eligibility.eligible) continue;
    const events = history.get(authorIdentity(item)) ?? history.get(authorNameIdentity(item.author)) ?? [];
    const age = events.length ? now - events[0] : Infinity;
    const marks7d = events.filter((at) => now - at < 7 * DAY).length;
    const marks30d = events.filter((at) => now - at < 30 * DAY).length;
    const cooldown = rules.sameAuthorCooldownHours * 3_600_000;
    const over7d = marks7d >= rules.maxSameAuthor7d;
    const over30d = marks30d >= rules.maxSameAuthor30d;
    const repeatFactor = over7d || over30d
      ? 0.45
      : age < DAY
        ? 0.55
        : age < cooldown
          ? 0.7
          : age < 7 * DAY ? 0.85 : 1;
    const relationshipNote = over7d || over30d
      ? `You have commented on this author often. Kept visible with lower priority.`
      : age < DAY
        ? `You commented on this author ${Math.max(1, Math.floor(age / 3_600_000))}h ago. Kept visible with lower priority.`
        : age < cooldown
          ? `Recent author activity lowers priority (${Math.max(1, Math.floor(age / 3_600_000))}h ago)`
      : age < 7 * DAY
        ? `Author activity ${Math.max(1, Math.floor(age / DAY))}d ago`
        : undefined;
    scored.push({ item, priority: eligibility.priority * repeatFactor, relationshipNote });
  }
  scored.sort((left, right) =>
    Number(left.item.decision === "needs_detail") - Number(right.item.decision === "needs_detail") ||
    right.priority - left.priority ||
    right.item.foundAt - left.item.foundAt ||
    left.item.id.localeCompare(right.item.id),
  );

  const authorEligible: RankedLinkedInOpportunity<T>[] = [];
  const authors = new Set<string>();
  for (const candidate of scored) {
    const key = authorIdentity(candidate.item);
    if (rules.oneActivePostPerAuthor && authors.has(key)) continue;
    authorEligible.push(candidate);
    authors.add(key);
  }
  // Diversity changes order, never membership. Choose alternatives from the
  // remaining author-eligible candidates, so an already-used author cannot make
  // us defer a useful post forever. Keep ready comments ahead of requests for
  // user detail, including when both compete for the same author's slot.
  const selected: RankedLinkedInOpportunity<T>[] = [];
  for (const decision of ["comment", "needs_detail"] as const) {
    const remaining = authorEligible.filter((candidate) => candidate.item.decision === decision);
    const laneCounts = new Map<LinkedInCommentLane, number>();
    let tierPosition = 0;
    while (remaining.length) {
      let index = 0;
      const firstLane = remaining[0].item.commentLane!;
      if (tierPosition < 5 && (laneCounts.get(firstLane) ?? 0) >= 2) {
        const alternative = remaining.findIndex((candidate) =>
          (laneCounts.get(candidate.item.commentLane!) ?? 0) < 2,
        );
        if (alternative >= 0) index = alternative;
      }
      const [candidate] = remaining.splice(index, 1);
      selected.push(candidate);
      const lane = candidate.item.commentLane!;
      laneCounts.set(lane, (laneCounts.get(lane) ?? 0) + 1);
      tierPosition += 1;
    }
  }
  return selected;
}
