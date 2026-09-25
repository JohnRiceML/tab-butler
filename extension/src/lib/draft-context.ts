/**
 * Context assembly for the social contribution DRAFTER — the paid action. The X path's 2026 open-sourced ranker grades
 * replies on big-author threads with a Grok LLM (0-3) and models an explicit slop score, so
 * SPECIFICITY is a ranked variable — and specificity is a function of the context the drafter
 * gets. This block hands Sonnet what the system already knows (the user's niche, why the scorer
 * flagged the post, who the author is, what measurably works for THIS user) as USER-message
 * context, separate from the reusable drafting rules.
 *
 * Import-free + pure so the live eval (scripts/eval-draft-reply-live.mjs) imports the REAL
 * assembler and measures bare-vs-enriched drafts with the same code the extension ships.
 */

export interface DraftContextIn {
  action?: "reply" | "comment"; // defaults to reply so the existing X contract stays byte-for-byte stable
  niche?: string;       // the user's full niche text (intent clause included — it helps here)
  reason?: string;      // the scorer's ≤6-word "why this post is worth a reply"
  category?: string;    // the scorer's angle read (value/ask/connect/…)
  anchor?: string;      // the exact post claim/detail the scorer selected
  contributionMove?: string; // model-suggested move family; guidance only, never evidence
  replyBrief?: string;  // the useful move the scorer recommends, never fabricated experience
  authorLine?: string;  // one honest line about the author from cached data ("@x · ~4.2K followers · a two-way niche peer")
  threadLine?: string;  // direct-thread context (for example: this is a comment on the user's own post)
  opportunityLine?: string; // observed discovery context (fresh/reachable/uncrowded), never a reach promise
  measuredLine?: string; // stage 2 (gated on the live eval): the user's measured-best angle line
}

/** The assembled block, or "" when nothing is known. Each line is labeled so the model treats it
 *  as grounding, not instructions to parrot. */
export function buildDraftContext(c: DraftContextIn): string {
  const lines: string[] = [];
  const action = c.action === "comment" ? "comment" : "reply";
  if (c.niche?.trim()) lines.push(`The user's niche / what they care about: ${c.niche.trim()}`);
  if (c.authorLine?.trim()) lines.push(`About the post's author: ${c.authorLine.trim()}`);
  if (c.threadLine?.trim()) lines.push(`Conversation relationship: ${c.threadLine.trim()}`);
  if (c.opportunityLine?.trim()) lines.push(`Observed opportunity context: ${c.opportunityLine.trim()}`);
  if (c.anchor?.trim()) lines.push(`Exact post detail to engage: ${c.anchor.trim()} (scorer-selected excerpt; verify against the actual post)`);
  if (c.contributionMove?.trim()) lines.push(`Model-suggested ${action} move (guidance, not evidence): ${c.contributionMove.trim()}`);
  if (c.replyBrief?.trim()) lines.push(`Useful ${action} move: ${c.replyBrief.trim()} (planning guidance, not factual evidence)`);
  if (c.reason?.trim() || c.category?.trim()) {
    const why = [c.reason?.trim(), c.category?.trim() ? `angle: ${c.category.trim()}` : ""].filter(Boolean).join(" — ");
    lines.push(`Why this post was flagged as ${action}-worthy: ${why}`);
  }
  if (c.measuredLine?.trim()) lines.push(`Measured on this user's own past replies: ${c.measuredLine.trim()}`);
  if (!lines.length) return "";
  return `\n\nContext (grounding only — write the ${action} to the post, not about this context):\nScorer suggestions never establish the user's experience or add facts to the source. Discard a mismatched anchor or an already-answered question.\n${lines.map((l) => `- ${l}`).join("\n")}`;
}
