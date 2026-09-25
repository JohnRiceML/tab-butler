/** Shared, deterministic evidence checks. These establish textual grounding, not truth. */
export interface ContributionPost { text: string; context?: string }

function normalizedWords(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
}

/** Keep a copied excerpt within the broker budget without cutting a word in half. */
export function boundedContributionAnchor(value: unknown, maxChars = 220): string | undefined {
  if (typeof value !== "string") return undefined;
  const words = value.trim().split(/\s+/).slice(0, 12);
  while (words.length && words.join(" ").length > maxChars) words.pop();
  return words.join(" ") || undefined;
}

/** A scorer anchor must be a contiguous excerpt, allowing punctuation/case differences.
 * Token boundaries prevent matching `AI` inside `retail`; context never replaces the outer post.
 */
export function findContributionAnchor(
  anchor: unknown,
  post: ContributionPost,
): { source: "post" | "context"; text: string } | null {
  if (typeof anchor !== "string") return null;
  const words = normalizedWords(anchor);
  if (!words || !/[\p{L}\p{N}]/u.test(words)) return null;
  for (const source of ["post", "context"] as const) {
    const text = post[source === "post" ? "text" : "context"];
    if (typeof text === "string" && ` ${normalizedWords(text)} `.includes(` ${words} `)) {
      return { source, text: anchor.trim() };
    }
  }
  return null;
}

/** Narrow copy detection: a substantial reply copied verbatim adds no new contribution.
 * Short acknowledgements and joke fragments are intentionally outside this check.
 */
export function isVerbatimContributionEcho(draft: string, post: ContributionPost): boolean {
  const words = normalizedWords(draft);
  if (words.split(" ").length < 8 || words.length < 45) return false;
  return [post.text, post.context].some((source) => typeof source === "string" && ` ${normalizedWords(source)} `.includes(` ${words} `));
}

const PERSONAL_FACT = /\b(?:i|we)\s+(?:(?:have|had|once|also|actually|personally|recently)\s+)*(?:built|shipped|launched|ran|managed|worked|used|tested|measured|grew|spent|saved|earned|hired|helped|seen|tried|switched|migrated|reduced|increased)\b|\b(?:i['’]ve|we['’]ve)\s+(?:built|shipped|seen|used|worked|tested|tried)\b|\b(?:my|our)\s+(?:clients|customers|employees|company|startup|team)\b/i;

function experienceDenials(value: string): string[] {
  const text = value.toLowerCase().replace(/[’]/g, "'")
    .replace(/\b(i|we)'ve\b/g, "$1 have").replace(/\bhaven't\b/g, "have not")
    .replace(/\bhasn't\b/g, "has not").replace(/\b(i|we)'m\b/g, "$1 am")
    .replace(/\bdon't\b/g, "do not").replace(/\bdidn't\b/g, "did not");
  const pattern = /\b(?:i|we)\s+(?:(?:have\s+)?(?:not|never)\s+(?:(?:actually|personally|really|yet)\s+)*(?:tried|tested|used|run|worked with)|(?:do not|did not)\s+(?:use|test|try)|have\s+(?:no|zero)\s+(?:hands[- ]on\s+)?experience|(?:have\s+yet|am\s+yet|are\s+yet)\s+to\s+(?:try|test|use))\b[^.!?;,\n]*/g;
  return [...text.matchAll(pattern)]
    .filter(match => !/\b(?:if|unless|imagine|suppose)\s*$/.test(text.slice(Math.max(0, match.index! - 20), match.index)))
    .map(match => normalizedWords(match[0].split(/\s+\b(?:but|although|because|so|and)\b/)[0]));
}

/** Missing experience is itself a personal fact. Unrelated product/proof text must
 * never unlock it. Require an explicit matching denial in current user evidence;
 * historical posts are deliberately not sufficient to assert present inexperience.
 * This conservative textual gate is not a general semantic contradiction checker.
 */
export function hasUnsupportedExperienceDenial(draft: string, currentEvidence: readonly (string | undefined)[]): boolean {
  const supported = currentEvidence.flatMap(value => value ? experienceDenials(value) : []);
  return experienceDenials(draft).some(claim => !supported.includes(claim));
}

/** Extract only explicit proof sections; beliefs, style examples, and aspirations stay out. */
export function soulContributionProof(soul: string | undefined): string {
  if (!soul) return "";
  let inProof = false;
  const proof: string[] = [];
  for (const line of soul.split(/\r?\n/)) {
    const heading = line.match(/^\s*#{1,6}\s+(.+)$/);
    if (heading) {
      inProof = /earned the right|earned experience|(?:^|\b)(?:proof|experience|stories)(?:\b|$)/i.test(heading[1]);
    } else if (inProof && normalizedWords(line)) proof.push(line.trim());
  }
  return proof.join("\n");
}

/** Fail only clear autobiographical assertions when no user proof was supplied.
 * This is an absence-of-evidence guard, not a semantic fact checker. Questions,
 * conditional reasoning, first-person opinions, and short playful replies remain valid.
 */
export function hasUnsupportedPersonalClaim(draft: string, personalEvidence: readonly (string | undefined)[]): boolean {
  if (personalEvidence.some((evidence) => typeof evidence === "string" && normalizedWords(evidence))) return false;
  return draft.split(/(?<=[.!?])\s+|\n+/).some((sentence) =>
    !/\?\s*$/.test(sentence) &&
    !/\b(?:if|unless|imagine|suppose|hypothetically|would|could)\b/i.test(sentence) &&
    PERSONAL_FACT.test(sentence));
}

/** Only clearly asserted facts in a rewrite instruction can unlock autobiography. */
export function contributionRewriteProof(steer: string | undefined): string {
  if (!steer || /\b(?:invent|pretend|imagine|hypothetically|fabricate|make up)\b|\b(?:if|suppose)\s+(?:i|we)\b|\b(?:i|we)\s+(?:would|could)\b/i.test(steer)) return "";
  // Evidence recognition is intentionally broader than the output rejection gate:
  // faithful paraphrases such as cut → reduced or led → ran must remain usable.
  const explicitRewriteFact = /\b(?:i|we)\s+(?:(?:have|had|once|also|actually|personally|recently|just)\s+)*(?:cut|led|deployed|doubled|tripled|halved|implemented|delivered|owned)\b|\b(?:i['’]ve|we['’]ve)\s+(?:cut|led|deployed|doubled|tripled|halved|implemented|delivered|owned)\b/i;
  return PERSONAL_FACT.test(steer) || explicitRewriteFact.test(steer) || experienceDenials(steer).length ? steer : "";
}
