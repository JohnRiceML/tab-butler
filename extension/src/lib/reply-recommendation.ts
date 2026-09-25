/**
 * Explainable reply-opportunity policy for a small/growing X account.
 *
 * This does not try to reverse-engineer X's feed score. It answers the user's
 * simpler decision: "where is my next thoughtful reply most useful?" Three
 * outcomes stay separate so a warm relationship is not buried by raw audience:
 *   - continue: strengthen a proven two-way connection
 *   - community: meet a relevant, plausibly reciprocal peer
 *   - discovery: earn attention in a fresh, reachable conversation
 *
 * Every input is either observed (age, replies, follower counts, exact exchanges,
 * measured engagement-back) or explicitly treated as missing. Missing data never
 * receives the best value. The numbers are product priors, not probabilities.
 */

export type ReplyLane = "inbound" | "continue" | "community" | "discovery";
export type ReplyStrength = "best next" | "good option" | "later";
export type EvidenceConfidence = "strong evidence" | "some evidence" | "limited evidence";

export interface ConnectionInput {
  completed: number;
  activeWeeks: number;
  lastAt: number;
  established: boolean;
}

export interface AuthorHistoryInput {
  replies: number;
  backs: number;
}

export interface ReplyRecommendationInput {
  authorHandle?: string;
  modelFit: number;
  /** An explicit user pin remains available without becoming an automatic recommendation. */
  contributionEligible?: boolean;
  contributionReason?: string;
  postedAt?: number;
  replies?: number;
  authorFollowers?: number;
  authorFollowing?: number;
  myFollowers?: number;
  reachCeiling?: number;
  peerTier?: 0 | 1 | 2;
  connection?: ConnectionInput;
  history?: AuthorHistoryInput;
  recentAuthorReplies?: number;
  lastAuthorReplyAt?: number;
  /** DOM-confirmed "Replying to @me": this author commented on one of the user's posts. */
  isReplyToOwnPost?: boolean;
}

export interface AuthorRepeatWarning {
  label: string;
  lastAt?: number;
  recentReplies: number;
  severity: "high" | "medium";
}

export interface ReplyRecommendation {
  priority: number;
  lane: ReplyLane;
  laneLabel: "Comment on your post" | "Keep it going" | "Build community" | "Earn reach";
  strength: ReplyStrength;
  confidence: EvidenceConfidence;
  discovery: number;
  relationship: number;
  community: number;
  reasons: string[];
  cautions: string[];
  authorRepeat?: AuthorRepeatWarning;
}

const clamp = (n: number): number => Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0));

/** Timeliness prior. Unknown is middling, not secretly "fresh." */
export function replyFreshness(postedAt: number | undefined, now: number): number {
  if (!postedAt) return 0.55;
  const mins = Math.max(0, (now - postedAt) / 60_000);
  if (mins < 5) return 1;
  if (mins < 15) return 0.95;
  if (mins < 30) return 0.85;
  if (mins < 60) return 0.7;
  if (mins < 180) return 0.52;
  if (mins < 720) return 0.36;
  if (mins < 1440) return 0.2;
  return 0.08;
}

/** Thread competition heuristic. It is not an X ranking probability. */
export function threadRoom(replies: number | undefined): number {
  if (replies == null) return 0.65;
  if (replies <= 5) return 1;
  if (replies < 30) return 0.74;
  if (replies < 100) return 0.44;
  return 0.24;
}

/** Reach relative to the user's account. The caller supplies its size-scaled ceiling. */
export function reachableAudience(authorFollowers: number | undefined, myFollowers: number | undefined, reachCeiling = 25): number {
  if (!authorFollowers || !myFollowers) return 0.58;
  const ratio = authorFollowers / Math.max(myFollowers, 1);
  let score = ratio < 0.5 ? 0.48 : ratio < 1.5 ? 0.72 : ratio <= reachCeiling ? 1 : ratio <= reachCeiling * 2 ? 0.6 : 0.32;
  if (authorFollowers > 500_000) score = Math.min(score, 0.32);
  return score;
}

/** Bounded reply-back evidence. Actual device-local outcomes beat the profile proxy. */
export function responseLikelihood(input: ReplyRecommendationInput): number {
  const h = input.history;
  if (h && h.replies > 0) {
    // Beta(1,3) prior avoids crowning one lucky reply; three+ measured backs can become strong.
    return clamp(((h.backs + 1) / (h.replies + 4)) * 1.45);
  }
  if (input.authorFollowers && input.authorFollowing != null) {
    const ratio = input.authorFollowing / Math.max(input.authorFollowers, 1);
    if (ratio >= 0.5) return 0.72;
    if (ratio >= 0.1) return 0.56;
    if (ratio < 0.02) return 0.2;
    return 0.4;
  }
  return 0.35;
}

function relationshipEvidence(input: ReplyRecommendationInput): number {
  if (input.connection?.established) return 1;
  if ((input.connection?.completed ?? 0) > 0) return 0.68;
  const h = input.history;
  if (h && h.replies >= 3 && h.backs >= 2) return 0.78;
  if ((input.peerTier ?? 0) === 2) return 0.62;
  if ((input.peerTier ?? 0) === 1) return 0.44;
  return 0.2;
}

export function repeatAuthorWarning(input: Pick<ReplyRecommendationInput, "authorHandle" | "recentAuthorReplies" | "lastAuthorReplyAt">, now: number): AuthorRepeatWarning | undefined {
  const recentReplies = input.recentAuthorReplies ?? 0;
  const lastAt = input.lastAuthorReplyAt;
  const ageMs = lastAt ? Math.max(0, now - lastAt) : undefined;
  if (ageMs != null && ageMs < 72 * 60 * 60_000) {
    const label = ageMs < 60 * 60_000
      ? `${Math.max(1, Math.round(ageMs / 60_000))}m ago`
      : ageMs < 24 * 60 * 60_000
        ? `${Math.max(1, Math.round(ageMs / 3_600_000))}h ago`
        : `${Math.max(1, Math.round(ageMs / 86_400_000))}d ago`;
    return { label, lastAt, recentReplies: Math.max(1, recentReplies), severity: ageMs < 24 * 60 * 60_000 ? "high" : "medium" };
  }
  if (recentReplies >= 3) return { label: `${recentReplies}× this week`, recentReplies, severity: recentReplies >= 5 ? "high" : "medium" };
  return undefined;
}

function diversityFactor(repeat: AuthorRepeatWarning | undefined): number {
  if (!repeat) return 1;
  if (repeat.lastAt != null) return repeat.severity === "high" ? 0.58 : 0.76;
  if (repeat.recentReplies >= 5) return 0.7;
  if (repeat.recentReplies >= 3) return 0.84;
  return 1;
}

export function recommendReply(input: ReplyRecommendationInput, now: number): ReplyRecommendation {
  const fit = clamp(input.modelFit);
  const fresh = replyFreshness(input.postedAt, now);
  const freshForRelationship = Math.max(0.28, fresh);
  const room = threadRoom(input.replies);
  const reach = reachableAudience(input.authorFollowers, input.myFollowers, input.reachCeiling);
  const response = responseLikelihood(input);
  const relation = relationshipEvidence(input);
  const peer = input.peerTier === 2 ? 1 : input.peerTier === 1 ? 0.68 : 0.24;
  const authorRepeat = repeatAuthorWarning(input, now);
  const diversity = diversityFactor(authorRepeat);

  const discovery = clamp(fit * (0.42 * fresh + 0.3 * room + 0.28 * reach) * diversity);
  const relationship = clamp((fit * (0.34 * freshForRelationship + 0.36 * relation + 0.2 * response + 0.1 * room)
    + (input.connection?.established ? 0.07 : 0)) * diversity);
  const community = clamp((fit * (0.34 * fresh + 0.24 * reach + 0.24 * peer + 0.18 * response)
    + (input.peerTier === 2 ? 0.04 : 0)) * diversity);

  // A direct comment on the user's own post is warm inbound, not cold account targeting. Keep
  // content fit in the score (spam still should not crown), but give a genuine commenter a strong
  // first-class lane. Repeat-author concentration remains visible while its penalty is softened:
  // continuing a conversation someone started on your post is materially different from repeatedly
  // dropping cold replies under the same account.
  const inbound = input.isReplyToOwnPost
    ? clamp((0.56 + 0.28 * fit + 0.16 * fresh) * (authorRepeat ? 0.92 : 1))
    : 0;
  const inboundPriority = input.isReplyToOwnPost ? Math.max(inbound, relationship, community, discovery) : 0;
  const relationshipWithInbound = input.isReplyToOwnPost ? Math.max(relationship, inboundPriority) : relationship;
  const choices: Array<[ReplyLane, number]> = input.isReplyToOwnPost
    ? [["inbound", inboundPriority]]
    : [["continue", relationship], ["community", community], ["discovery", discovery]];
  choices.sort((a, b) => b[1] - a[1]);
  const [lane, priority] = choices[0];
  const laneLabel = lane === "inbound" ? "Comment on your post" : lane === "continue" ? "Keep it going" : lane === "community" ? "Build community" : "Earn reach";
  const strength: ReplyStrength = priority >= 0.7 ? "best next" : priority >= 0.5 ? "good option" : "later";

  const reasons: string[] = [];
  if (input.isReplyToOwnPost) reasons.push("They commented on your post");
  if (lane === "continue") {
    if (input.connection?.established) reasons.push(`Proven two-way connection (${input.connection.completed} exchanges)`);
    else if ((input.history?.backs ?? 0) >= 2) reasons.push(`Engaged you back ${input.history!.backs} times`);
    else reasons.push("Stronger relationship opportunity");
  }
  if (lane === "community") reasons.push(input.peerTier === 2 ? "Relevant peer in your space" : "Plausibly two-way peer");
  if (lane === "discovery") {
    if (input.authorFollowers && input.myFollowers) {
      const multiple = input.authorFollowers / Math.max(input.myFollowers, 1);
      if (multiple >= 1.5 && multiple <= (input.reachCeiling ?? 25)) reasons.push(`${multiple >= 10 ? Math.round(multiple) : multiple.toFixed(1)}× your size, still reachable`);
    }
    if (!reasons.length) reasons.push("Best fresh, reachable conversation");
  }
  if (fresh >= 0.85) reasons.push("Fresh reply window");
  if (input.replies != null && input.replies <= 5) reasons.push(`${input.replies} ${input.replies === 1 ? "reply" : "replies"} so far`);

  const cautions: string[] = [];
  if (authorRepeat) {
    const who = input.authorHandle ? `@${input.authorHandle.replace(/^@+/, "")}` : "this author";
    cautions.push(input.isReplyToOwnPost
      ? `Already replied to ${who} ${authorRepeat.label}; direct comments stay important, but answer only if it moves the conversation forward`
      : `Already replied to ${who} ${authorRepeat.label}; this lowers every score to encourage account spread`);
  }
  if (!input.postedAt) cautions.push("Post age unavailable");
  else if (fresh <= 0.2) cautions.push("The conversation is cooling off");
  if (input.replies == null) cautions.push("Reply count unavailable");
  else if (input.replies >= 30) cautions.push(`Crowded thread (${input.replies} replies)`);
  if (!input.authorFollowers || !input.myFollowers) cautions.push("Audience fit is unmeasured");
  else if (reach <= 0.32) cautions.push("Audience gap is likely too wide");

  let evidence = 0;
  if (input.postedAt) evidence++;
  if (input.replies != null) evidence++;
  if (input.authorFollowers && input.myFollowers) evidence++;
  if (input.authorFollowing != null) evidence++;
  if (input.connection || (input.history?.replies ?? 0) >= 2) evidence++;
  if (input.isReplyToOwnPost) evidence++;
  const confidence: EvidenceConfidence = evidence >= 4 ? "strong evidence" : evidence >= 2 ? "some evidence" : "limited evidence";

  if (input.contributionEligible === false) {
    return { priority: 0, lane, laneLabel, strength: "later", confidence, discovery: 0, relationship: 0, community: 0,
      reasons: [input.contributionReason || "Added by you; a useful contribution has not been established"],
      cautions: ["Your choice to reply; Goobi is not recommending this post", ...cautions].slice(0, 3), authorRepeat };
  }
  return { priority, lane, laneLabel, strength, confidence, discovery, relationship: relationshipWithInbound, community, reasons: reasons.slice(0, 3), cautions: cautions.slice(0, 3), authorRepeat };
}
