/**
 * High-precision diagnostics for LinkedIn comment drafts.
 *
 * This is intentionally a lint/retry layer, not a prose rewriter. Regex replacement can make a
 * human sentence less human or change its meaning; when a blocking issue appears, the model gets
 * one labeled repair pass with the original post and trusted voice context still available.
 */

export type LinkedInCommentIssueSeverity = "blocking" | "warning";

export interface LinkedInCommentIssue {
  code:
    | "empty"
    | "output_wrapper"
    | "generic_cliche"
    | "praise_opener"
    | "canned_contrast"
    | "performative_closer"
    | "hashtag"
    | "unsolicited_pitch"
    | "too_many_questions"
    | "too_long"
    | "mini_essay"
    | "dash_character"
    | "quotation_mark";
  severity: LinkedInCommentIssueSeverity;
  message: string;
}

export interface LinkedInCommentQualityOptions {
  allowLink?: boolean;
  maxChars?: number;
  preferredChars?: number;
  maxSentences?: number;
}

const CLICHES: Array<[RegExp, string]> = [
  [/\b(?:great|excellent|insightful|thought[ -]provoking) (?:post|insights?|perspective)\b/i, "Remove generic praise."],
  [/\bthanks?(?: you)? for sharing\b/i, "Do not thank the author for sharing."],
  [/\bthis (?:really )?resonates\b/i, "Replace resonance language with an actual contribution."],
  [/\bcouldn['’]?t agree more\b/i, "Replace agreement with a specific judgment."],
  [/\b(?:well said|spot on|game[ -]changer)\b/i, "Remove the canned appraisal."],
  [/\b(?:powerful|important) reminder\b/i, "State the useful point directly."],
  [/\bvaluable perspective\b/i, "Add a concrete perspective instead of rating the post."],
  [/\b(?:the part|what) that (?:really )?stood out\b/i, "Open on the substance, not what stood out."],
  [/\bin today['’]?s [^.!?]{0,50} world\b/i, "Remove the generic scene-setting phrase."],
];

const PRAISE_OPENER = /^(?:absolutely[.!,:]?\s+|exactly[.!,:]?\s+|love this[.!,:]?\s+|so true[.!,:]?\s+|great (?:post|point|insight)[.!,:]?\s+|well said[.!,:]?\s+|spot on[.!,:]?\s+)/i;
const CANNED_CONTRAST = /\b(?:it(?:'s| is)|this is) not just\b[^.!?]{0,120}\b(?:it(?:'s| is)|but|it is)\b/i;
const PERFORMATIVE_CLOSER = /\b(?:thoughts\??|what do you think\??|curious to hear (?:your|others['’]?) thoughts\??)\s*$/i;
const UNSOLICITED_PITCH = /\b(?:dm me|check (?:out )?my profile|book a call|let['’]?s connect|happy to help|we help (?:teams|companies|founders)|our (?:tool|platform|product|service))\b/i;

function sentenceCount(text: string): number {
  const matches = text.match(/[^.!?\n]+[.!?]+|[^.!?\n]+$/g);
  return matches?.filter((sentence) => sentence.trim()).length ?? 0;
}

function hasQuotationMark(text: string): boolean {
  if (/["“”]/.test(text)) return true;
  if (/(^|[\s(\[])['‘’][^'‘’\n]{1,120}?['‘’](?=$|[\s).,!?;:\]])/.test(text)) return true;
  return [...text].some((mark, offset) => {
    if (!(mark === "'" || mark === "‘" || mark === "’")) return false;
    const before = [...text][offset - 1] ?? "";
    const after = [...text][offset + 1] ?? "";
    const insideWord = /[\p{L}\p{N}]/u.test(before) && /[\p{L}\p{N}]/u.test(after);
    const pluralPossessive = /s/i.test(before) && (!after || /[\s,.;:!?)]/.test(after));
    return !insideWord && !pluralPossessive;
  });
}

/** Diagnose one finished comment. Blocking findings trigger one model repair pass. */
export function linkedinCommentIssues(
  value: unknown,
  options: LinkedInCommentQualityOptions = {},
): LinkedInCommentIssue[] {
  const text = typeof value === "string" ? value.trim() : "";
  const maxChars = options.maxChars ?? 700;
  const preferredChars = options.preferredChars ?? 420;
  const maxSentences = options.maxSentences ?? 3;
  const issues: LinkedInCommentIssue[] = [];
  if (!text) return [{ code: "empty", severity: "blocking", message: "Return one useful comment." }];

  if (/^```|```$|^(?:comment|linkedin comment|draft)\s*:/i.test(text)) {
    issues.push({ code: "output_wrapper", severity: "blocking", message: "Return only the comment text with no label or fence." });
  }
  if (/[-‐‑‒–—―]/.test(text)) {
    issues.push({ code: "dash_character", severity: "blocking", message: "Remove every dash and write the phrase with spaces or a new sentence." });
  }
  if (hasQuotationMark(text)) {
    issues.push({ code: "quotation_mark", severity: "blocking", message: "Remove quotation marks and state or paraphrase the point directly." });
  }
  for (const [pattern, message] of CLICHES) {
    if (pattern.test(text)) {
      issues.push({ code: "generic_cliche", severity: "blocking", message });
      break;
    }
  }
  if (PRAISE_OPENER.test(text)) {
    issues.push({ code: "praise_opener", severity: "blocking", message: "Begin with the contribution, not praise or agreement." });
  }
  if (CANNED_CONTRAST.test(text)) {
    issues.push({ code: "canned_contrast", severity: "blocking", message: "Remove the canned not-just-X contrast." });
  }
  if (PERFORMATIVE_CLOSER.test(text)) {
    issues.push({ code: "performative_closer", severity: "blocking", message: "Remove the generic engagement-seeking closer." });
  }
  if (/(^|\s)#[\p{L}\p{N}_]+/u.test(text)) {
    issues.push({ code: "hashtag", severity: "blocking", message: "Remove hashtags from the comment." });
  }
  if (UNSOLICITED_PITCH.test(text) || (!options.allowLink && /https?:\/\//i.test(text))) {
    issues.push({ code: "unsolicited_pitch", severity: "blocking", message: "Remove the unsolicited pitch, call to action, or link." });
  }
  if ((text.match(/\?/g) ?? []).length > 1) {
    issues.push({ code: "too_many_questions", severity: "blocking", message: "Ask at most one narrow question." });
  }
  if (text.length > maxChars) {
    issues.push({ code: "too_long", severity: "blocking", message: `Cut the comment below ${maxChars} characters.` });
  } else if (text.length > preferredChars) {
    issues.push({ code: "too_long", severity: "warning", message: `Tighten toward ${preferredChars} characters unless the saved voice clearly runs longer.` });
  }
  if (sentenceCount(text) > maxSentences) {
    issues.push({ code: "mini_essay", severity: "warning", message: `Use at most ${maxSentences} natural sentences.` });
  }
  return issues;
}

export function blockingLinkedInCommentIssues(
  value: unknown,
  options: LinkedInCommentQualityOptions = {},
): LinkedInCommentIssue[] {
  return linkedinCommentIssues(value, options).filter((issue) => issue.severity === "blocking");
}

export function linkedInCommentRevisionBrief(issues: readonly LinkedInCommentIssue[]): string {
  return [...new Set(issues.map((issue) => issue.message))].map((message) => `- ${message}`).join("\n");
}

/** Eval-only warning: a high lexical overlap can suggest paraphrase, but never auto-rewrite it. */
export function likelyLinkedInParaphrase(comment: string, post: string): boolean {
  const stop = new Set(["about", "after", "again", "also", "because", "been", "being", "could", "from", "have", "into", "just", "more", "most", "that", "their", "there", "these", "they", "this", "those", "through", "very", "what", "when", "where", "which", "with", "would", "your"]);
  const tokens = (text: string) => (text.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []).filter((token) => !stop.has(token));
  const draftTokens = tokens(comment);
  if (draftTokens.length < 6) return false;
  const postTokens = new Set(tokens(post));
  const overlap = draftTokens.filter((token) => postTokens.has(token)).length / draftTokens.length;
  const novel = new Set(draftTokens.filter((token) => !postTokens.has(token))).size;
  return overlap >= 0.72 && novel < 4 && !comment.includes("?");
}

/** Eval helper for no-evidence fixtures. It is intentionally not used as a live rewriter. */
export function hasFirstPersonExperienceClaim(comment: string): boolean {
  return /\b(?:i(?:'ve| have) (?:seen|found|learned|built|run|worked|helped|noticed)|in my (?:work|experience|company|team|practice)|(?:my|our) (?:clients?|customers?|users?|team) (?:saw|found|learned|grew|cut|increased|reduced))\b/i.test(comment);
}

export function linkedInOpeningSignature(comment: string): string {
  return (comment.toLowerCase().match(/[a-z0-9']+/g) ?? []).slice(0, 4).join(" ");
}
