/**
 * Unit test for the deterministic draft cleaners (text-clean.ts). esbuild → data-URL import.
 * Run: node scripts/test-text-clean.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as esbuild from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "../src/lib/text-clean.ts"), "utf8");
const js = esbuild.transformSync(src, { loader: "ts", format: "esm" }).code;
const m = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));

let pass = 0, fail = 0;
const eq = (a, b, l) => { if (a === b) pass++; else { fail++; console.error(`  FAIL: ${l}\n    got:  ${JSON.stringify(a)}\n    want: ${JSON.stringify(b)}`); } };
const ok = (c, l) => { if (c) pass++; else { fail++; console.error("  FAIL:", l); } };

// ---- stripDashes ----
eq(m.stripDashes("long-term thinking"), "long term thinking", "hyphenated compound -> two words");
eq(m.stripDashes("ship fast — then fix"), "ship fast, then fix", "em dash -> comma");
eq(m.stripDashes("build the boring stuff"), "build the boring stuff", "clean text untouched");
// the collision guard: a bare number must survive the link-shield unmask
eq(m.stripDashes("sent 40 dms, got 6 calls"), "sent 40 dms, got 6 calls", "bare numbers are NOT eaten by the link unmask (the sentinel-collision guard)");
eq(m.stripDashes("check my-startup.com for the fix"), "check my-startup.com for the fix", "domain hyphen is shielded (link stays intact)");
eq(m.stripDashes("email me at a@b-co.com"), "email me at a@b-co.com", "email domain shielded");
ok(m.stripDashes("raised prices 30%").includes("30%"), "percentages survive");

// ---- stripEmphasisQuotes ----
eq(m.stripEmphasisQuotes("a bad output is 'close enough' honestly"), "a bad output is close enough honestly", "single-quote emphasis phrase unwrapped");
eq(m.stripEmphasisQuotes('the "real work" nobody does'), "the real work nobody does", "double-quote emphasis phrase unwrapped");
// contractions + possessives MUST survive (a single quote is only a delimiter, never an apostrophe)
eq(m.stripEmphasisQuotes("it's the moat, don't skip it"), "it's the moat, don't skip it", "contractions preserved");
eq(m.stripEmphasisQuotes("the users' churn graph"), "the users' churn graph", "possessive apostrophe preserved");
eq(m.stripEmphasisQuotes("everyone's building wrappers"), "everyone's building wrappers", "mid-word apostrophe preserved");
// a phrase containing an apostrophe is left wrapped (safe: never eats the apostrophe)
ok(m.stripEmphasisQuotes("he said 'don't ship' loudly").includes("don't"), "phrase with a contraction keeps its apostrophe (left wrapped, never mangled)");
// curly quotes
eq(m.stripEmphasisQuotes("the ‘quiet part’ nobody says"), "the quiet part nobody says", "curly single quotes unwrapped");
eq(m.stripEmphasisQuotes("the “banger screen” gate"), "the banger screen gate", "curly double quotes unwrapped");

// ---- review-caught edge bugs (apostrophe-elisions, speech quotations, sentinel collision) ----
eq(m.cleanDraft("rock 'n' roll energy"), "rock 'n' roll energy", "rock 'n' roll: the 1-char elision is NOT unwrapped (meaning preserved)");
eq(m.stripEmphasisQuotes("fish 'n' chips"), "fish 'n' chips", "'n' elision left intact");
eq(m.cleanDraft('She said "no" today'), 'She said "no" today', "speech verb before a double-quote → genuine quotation preserved");
eq(m.cleanDraft('the memo read: "ship it"'), 'the memo read: "ship it"', "colon before a double-quote → quotation preserved");
eq(m.stripEmphasisQuotes("the 'invisible' one won"), "the invisible one won", "≥2-char single-word scare quote still unwrapped");
eq(m.stripDashes("check code LNK0KNL now"), "check code LNK0KNL now", "an ASCII 'LNK0KNL' string is NOT mangled (NUL sentinel, no collision)");

// ---- cleanDraft (the combined net both surfaces use) ----
eq(m.cleanDraft('"just ship it — then talk to users"'), "just ship it, then talk to users", "whole-string wrapping quote stripped + dash fixed");
eq(m.cleanDraft("built 4 features. 2 got used. the 'invisible' one won."), "built 4 features. 2 got used. the invisible one won.", "inline emphasis quote removed, numbers intact");
eq(m.cleanDraft("  spaced  out   draft  "), "spaced out draft", "trims + collapses whitespace");

// ---- cleanLinkedInComment (strict no dash / no quotation-mark preference) ----
eq(m.cleanLinkedInComment("A well-designed go-to-market loop — with one owner."), "A well designed go to market loop with one owner.", "LinkedIn cleanup removes every long and compound dash");
eq(m.cleanLinkedInComment("```text\nFirst thought.\n\nSecond thought.\n```"), "First thought.\n\nSecond thought.", "LinkedIn cleanup unwraps one whole output fence and preserves paragraphs");
eq(m.cleanLinkedInComment('"This is concise."'), "This is concise.", "LinkedIn cleanup unwraps whole-output quotes");
eq(m.cleanLinkedInComment('The memo said: "ship it"'), "The memo said: ship it", "LinkedIn cleanup removes genuine inline quotation marks too");
eq(m.cleanLinkedInComment("The ‘hard part’ is cross-team ownership."), "The hard part is cross team ownership.", "LinkedIn cleanup unwraps curly quotes and removes hyphens");
eq(m.cleanLinkedInComment("it's specific and users' needs stay visible"), "it's specific and users' needs stay visible", "LinkedIn cleanup preserves contraction and possessive apostrophes");
eq(m.cleanLinkedInComment("Call it ‘specific and move on."), "Call it specific and move on.", "LinkedIn cleanup removes an unmatched quotation mark");
ok(!/[-‐‑‒–—―"“”]/.test(m.cleanLinkedInComment('"A well-designed system — usually."')), "cleaned LinkedIn comments contain no dash or double quotation glyph");

console.log(fail === 0 ? `\n✓ text-clean: ${pass} assertions passed` : `\n✗ text-clean: ${fail} failed, ${pass} passed`);
process.exit(fail === 0 ? 0 : 1);
