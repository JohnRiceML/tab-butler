/**
 * Deterministic draft cleaners — the safety net UNDER the prompt rules, for the two things the
 * model reliably slips on: dashes and quote-wrapped phrases. Pure + unit-tested
 * (scripts/test-text-clean.mjs). Used by claude-client for both reply drafts and post ideas.
 *
 * Philosophy (same as the old inline stripDashes): the PROMPT tells the model not to do it, and
 * this GUARANTEES it — belt and suspenders. Both are conservative: they never touch a link, a
 * contraction, a possessive, or an apostrophe-elision, so a false rewrite can't mangle real text.
 */

// straight + curly quote glyphs
const DQUOTE = "\"“”"; // "  “  ”
const SQUOTE = "'‘’";  // '  ‘  ’
const NUL = String.fromCharCode(0); // a sentinel that cannot occur in real text (built at runtime so no literal NUL sits in source)

/** Enforce the no-dash rule: em/en dash -> comma, hyphenated compound -> two words. Digit hyphens
 *  (ranges, negatives) and bullet hyphens are left alone; URLs / emails / domains / @handles are
 *  SHIELDED so a link is never broken ("my-startup.com" survives, "long-term" -> "long term"). */
export function stripDashes(s: string): string {
  // Mask links with a NUL-delimited sentinel. NUL genuinely cannot appear in a draft, so the unmask
  // can never collide with real content (a bare number like "sent 40", or a literal token in the text).
  const shielded: string[] = [];
  const masked = s.replace(/(https?:\/\/\S+|[\w.+-]+@[\w-]+\.[a-z]{2,}|\b[\w-]+\.[a-z]{2,}\S*|@[\w-]+)/gi,
    (m) => `${NUL}${shielded.push(m) - 1}${NUL}`);
  const out = masked
    .replace(/\s*[—–]\s*/g, ", ")   // em/en dash -> comma
    .replace(/(\p{L})-+(\p{L})/gu, "$1 $2")   // hyphenated compound -> two words
    .replace(/\s+,/g, ",")
    .replace(/\s{2,}/g, " ")
    .trim();
  return out.replace(new RegExp(`${NUL}(\\d+)${NUL}`, "g"), (_, i) => shielded[Number(i)]);
}

/** Remove emphasis / scare quotes that WRAP a phrase ('close enough', "the real work") — a reliable
 *  AI tell in blunt X copy. Conservative — it spares:
 *   - apostrophes, possessives, and apostrophe-elisions: a single-quote span must be ≥2 chars, so the
 *     "rock 'n' roll" elision ('n' = 1 char) is left alone; contractions can't be spanned at all
 *     (the content class excludes the quote glyph, so 'don't ship' never matches),
 *   - genuine quotations of speech: a double-quote span preceded by a speech verb or a colon
 *     (She said "no", the memo read: "ship") is left intact,
 *   - links/numbers (untouched here; dashes handle their own shielding). */
export function stripEmphasisQuotes(s: string): string {
  // Double quotes: unwrap a wrapped span (≤80 chars, ≥2 chars), UNLESS a speech verb / colon
  // immediately precedes it (then it's a real quotation, not an emphasis tell).
  let out = s.replace(
    new RegExp(`(?<!\\b(?:said|says|say|asks?|asked|tells?|told|writes?|wrote|calls?|called|named|labell?ed|read|reads)\\s)(?<!:\\s)[${DQUOTE}]([^${DQUOTE}\\n]{2,80})[${DQUOTE}]`, "g"),
    (_m, inner) => inner,
  );
  // Single quotes: only as clear delimiters (opening preceded by start/space/bracket, closing
  // followed by space/punct/end), inner ≥2 chars so 1-char elisions like 'n' survive.
  out = out.replace(
    new RegExp(`(^|[\\s(\\[${DQUOTE}])[${SQUOTE}]([^${SQUOTE}\\n]{2,80}?)[${SQUOTE}](?=$|[\\s).,!?;:\\]${DQUOTE}])`, "g"),
    (_m, pre, inner) => pre + inner,
  );
  return out.replace(/\s{2,}/g, " ").trim();
}

/** The full clean applied to a finished draft (reply or post): trim, drop quotes wrapping the WHOLE
 *  string, unwrap inline emphasis quotes, enforce the no-dash rule. */
export function cleanDraft(s: string): string {
  let t = (s || "").trim();
  // Unwrap quotes around the WHOLE string only when it is a single quoted span (no internal quote),
  // i.e. the model wrapped the entire draft — never a lone trailing quote that closes a quotation
  // sitting inside the text (e.g. the memo read: "ship it").
  const isQ = (c: string) => DQUOTE.includes(c) || SQUOTE.includes(c);
  if (t.length >= 2 && isQ(t[0]) && isQ(t[t.length - 1])) {
    const inner = t.slice(1, -1);
    if (![...inner].some(isQ)) t = inner.trim();
  }
  return stripDashes(stripEmphasisQuotes(t));
}
