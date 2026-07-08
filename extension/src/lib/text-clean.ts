/**
 * Deterministic draft cleaners — the safety net UNDER the prompt rules, for the two things the
 * model reliably slips on: dashes and quote-wrapped phrases. Pure + unit-tested
 * (scripts/test-text-clean.mjs). Used by claude-client for both reply drafts and post ideas.
 *
 * Philosophy (same as the old inline stripDashes): the PROMPT tells the model not to do it, and
 * this GUARANTEES it — belt and suspenders. Both are conservative: they never touch a link, a
 * contraction, or a possessive, so a false rewrite can't mangle real text.
 */

// straight + curly quote glyphs
const DQUOTE = "\"“”"; // "  “  ”
const SQUOTE = "'‘’";  // '  ‘  ’

/** Enforce the no-dash rule: em/en dash -> comma, hyphenated compound -> two words. Digit hyphens
 *  (ranges, negatives) and bullet hyphens are left alone; URLs / emails / domains / @handles are
 *  SHIELDED so a link is never broken ("my-startup.com" survives, "long-term" -> "long term"). */
export function stripDashes(s: string): string {
  // Mask links with a guard-token sentinel (LNK<i>KNL). The letter guards mean the unmask can't
  // collide with a bare number like "sent 40" in the draft, and it stays plain-ASCII/link-safe.
  const shielded: string[] = [];
  const masked = s.replace(/(https?:\/\/\S+|[\w.+-]+@[\w-]+\.[a-z]{2,}|\b[\w-]+\.[a-z]{2,}\S*|@[\w-]+)/gi,
    (m) => `LNK${shielded.push(m) - 1}KNL`);
  const out = masked
    .replace(/\s*[—–]\s*/g, ", ")   // em/en dash -> comma
    .replace(/(\p{L})-+(\p{L})/gu, "$1 $2")   // hyphenated compound -> two words
    .replace(/\s+,/g, ",")
    .replace(/\s{2,}/g, " ")
    .trim();
  return out.replace(/LNK(\d+)KNL/g, (_, i) => shielded[Number(i)]);
}

/** Remove emphasis / scare quotes that WRAP a short phrase ('close enough', "the real work") — a
 *  reliable AI tell in blunt X copy. Preserves:
 *   - apostrophes + possessives (it's, don't, users') — a single quote is only unwrapped when it's
 *     a clear DELIMITER (opening preceded by start/space/bracket, closing followed by space/punct/end),
 *     and a phrase containing an apostrophe simply isn't matched (safe, just left wrapped),
 *   - genuine quotation of someone's words when it runs longer than the phrase cap.
 *  Deliberately conservative: it would rather leave a quote than eat an apostrophe. */
export function stripEmphasisQuotes(s: string): string {
  // Double quotes never collide with apostrophes → unwrap any short wrapped span.
  let out = s.replace(new RegExp(`[${DQUOTE}]([^${DQUOTE}\\n]{1,80})[${DQUOTE}]`, "g"), (_m, inner) => inner);
  // Single quotes only as clear delimiters (content excludes ' so a contraction can't be spanned).
  out = out.replace(
    new RegExp(`(^|[\\s(\\[${DQUOTE}])[${SQUOTE}]([^${SQUOTE}\\n]{1,80}?)[${SQUOTE}](?=$|[\\s).,!?;:\\]${DQUOTE}])`, "g"),
    (_m, pre, inner) => pre + inner,
  );
  return out.replace(/\s{2,}/g, " ").trim();
}

/** The full clean applied to a finished draft (reply or post): trim, drop quotes wrapping the WHOLE
 *  string, unwrap inline emphasis quotes, enforce the no-dash rule. */
export function cleanDraft(s: string): string {
  const trimmed = (s || "").trim().replace(new RegExp(`^[${DQUOTE}${SQUOTE}]|[${DQUOTE}${SQUOTE}]$`, "g"), "").trim();
  return stripDashes(stripEmphasisQuotes(trimmed));
}
