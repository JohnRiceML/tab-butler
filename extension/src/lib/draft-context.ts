/**
 * Context assembly for the reply DRAFTER — the paid action. The 2026 open-sourced ranker grades
 * replies on big-author threads with a Grok LLM (0-3) and models an explicit slop score, so
 * SPECIFICITY is a ranked variable — and specificity is a function of the context the drafter
 * gets. This block hands Sonnet what the system already knows (the user's niche, why the scorer
 * flagged the post, who the author is, what measurably works for THIS user) as USER-message
 * context, keeping X_DRAFT_SYSTEM byte-stable for the prompt-invariant guard.
 *
 * Import-free + pure so the live eval (scripts/eval-draft-reply-live.mjs) imports the REAL
 * assembler and measures bare-vs-enriched drafts with the same code the extension ships.
 */

export interface DraftContextIn {
  niche?: string;       // the user's full niche text (intent clause included — it helps here)
  reason?: string;      // the scorer's ≤6-word "why this post is worth a reply"
  category?: string;    // the scorer's angle read (value/ask/connect/…)
  authorLine?: string;  // one honest line about the author from cached data ("@x · ~4.2K followers · a two-way niche peer")
  threadLine?: string;  // direct-thread context (for example: this is a comment on the user's own post)
  measuredLine?: string; // stage 2 (gated on the live eval): the user's measured-best angle line
}

/** The assembled block, or "" when nothing is known. Each line is labeled so the model treats it
 *  as grounding, not instructions to parrot. */
export function buildDraftContext(c: DraftContextIn): string {
  const lines: string[] = [];
  if (c.niche?.trim()) lines.push(`The user's niche / what they care about: ${c.niche.trim()}`);
  if (c.authorLine?.trim()) lines.push(`About the post's author: ${c.authorLine.trim()}`);
  if (c.threadLine?.trim()) lines.push(`Conversation relationship: ${c.threadLine.trim()}`);
  if (c.reason?.trim() || c.category?.trim()) {
    const why = [c.reason?.trim(), c.category?.trim() ? `angle: ${c.category.trim()}` : ""].filter(Boolean).join(" — ");
    lines.push(`Why this post was flagged as reply-worthy: ${why}`);
  }
  if (c.measuredLine?.trim()) lines.push(`Measured on this user's own past replies: ${c.measuredLine.trim()}`);
  if (!lines.length) return "";
  return `\n\nContext (grounding only — write the reply to the post, not about this context):\n${lines.map((l) => `- ${l}`).join("\n")}`;
}
