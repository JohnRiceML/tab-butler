import { CONFIG } from "./config";
import { idleMinutes } from "./heuristics";
import { ADVISE_SYSTEM, CLASSIFY_SYSTEM, DM_DRAFT_SYSTEM, LINKEDIN_DRAFT_SYSTEM, LINKEDIN_SCORE_SYSTEM, POST_IDEA_REWRITE_SYSTEM, POST_IDEAS_SYSTEM, POST_IDEAS_JUDGE_SYSTEM, POST_IDEAS_REGEN_SYSTEM, RECALL_SYSTEM, REPLY_ANGLES, REPLY_STYLES, X_DRAFT_SYSTEM, X_SCORE_SYSTEM } from "./prompts";
import { linkedinCommentIssues, blockingLinkedInCommentIssues, linkedInCommentRevisionBrief } from "./linkedin-comment-quality";
import { cleanDraft, cleanLinkedInComment } from "./text-clean";
import { soulPrompt } from "./soul";
import { observeCommentWithJev } from "./jev-shadow";
import { scorePostsWithJev, JEV_ANALYSIS_CONSENT } from "./jev-analysis";
import { authorContinuityPrompt, type AuthorContinuity } from "./author-continuity";
import type { LinkedInCommentLane, LinkedInDecision, LinkedInPersonEvidence } from "./linkedin-opportunity-ranking";
import { hasCompleteLinkedInScores } from "./linkedin-score-contract";
import { hasCompleteXScores, xScoreOutputTokens } from "./x-score-contract";
import { claudeRequestGovernor } from "./claude-request-governor";
import { boundedContributionAnchor, contributionRewriteProof, hasUnsupportedExperienceDenial, hasUnsupportedPersonalClaim, isVerbatimContributionEcho, soulContributionProof } from "./contribution-evidence";
import type { AdviceResult, ClassifyResult, SocialPlatform, TabInput } from "./types";

/** Current model, plus one stable compatibility fallback for older workspaces. */
const CLAUDE_MODEL = "claude-sonnet-5";
const CLAUDE_FALLBACK_MODEL = "claude-sonnet-4-6";
let activeClaudeModel = CLAUDE_MODEL;

/**
 * Smart features are BYO-key and gated on the `smartEnabled` opt-in. The user's
 * Anthropic key stays in extension storage and calls the API directly. The parked
 * managed proxy is intentionally not part of the shipping extension.
 */

export async function isSmartEnabled(): Promise<boolean> {
  return Boolean((await chrome.storage.local.get(CONFIG.SMART_ENABLED_KEY))[CONFIG.SMART_ENABLED_KEY]);
}

export async function getKey(): Promise<string | null> {
  return ((await chrome.storage.local.get(CONFIG.ANTHROPIC_KEY_KEY))[CONFIG.ANTHROPIC_KEY_KEY] as string) || null;
}

function toTabInput(t: chrome.tabs.Tab, now: number): TabInput | null {
  if (t.id == null || !t.url) return null;
  return { id: t.id, title: t.title ?? "", url: t.url, lastAccessedMinutes: idleMinutes(t, now) };
}

export function tabsToInputs(tabs: chrome.tabs.Tab[]): TabInput[] {
  const now = Date.now();
  return tabs.map((t) => toTabInput(t, now)).filter((x): x is TabInput => x !== null);
}

function tabsToText(tabs: TabInput[]): string {
  return tabs.map((t) => `#${t.id} | idle ${t.lastAccessedMinutes ?? "?"}m | ${t.title} | ${t.url}`).join("\n");
}

interface AnthropicErrorBody {
  error?: { type?: unknown; message?: unknown };
}

/**
 * Reduce Anthropic's response body to a small diagnostic code. Never forward
 * the provider message because it is not part of our UI trust boundary.
 */
async function anthropicHttpError(res: Response): Promise<Error> {
  let type = "";
  let message = "";
  try {
    const body = await res.json() as AnthropicErrorBody;
    type = typeof body.error?.type === "string" ? body.error.type.toLowerCase() : "";
    message = typeof body.error?.message === "string" ? body.error.message.toLowerCase() : "";
  } catch { /* an empty/non-JSON provider error still keeps its HTTP status */ }

  let code = "request-rejected";
  if (/credit|billing|payment|purchase/.test(message)) code = "billing";
  else if (/spend|usage|organization|workspace/.test(message) && /limit|cap|maximum|exceed/.test(message)) code = "spend-limit";
  else if (/thinking/.test(message)) code = "thinking-parameter";
  else if (/output_config|effort/.test(message)) code = "effort-parameter";
  else if (/model/.test(message) && /access|available|found|permission|support/.test(message)) code = "model-access";
  else if (/prompt|context|input/.test(message) && /long|large|token|limit/.test(message)) code = "request-too-large";
  else if (/max[_ ]tokens/.test(message)) code = "max-tokens";
  else if (/temperature|top[_ ]p|top[_ ]k|sampling/.test(message)) code = "sampling-parameter";
  else if (/system/.test(message)) code = "system-parameter";
  else if (/messages?/.test(message)) code = "messages-parameter";
  else if (type === "authentication_error") code = "authentication";
  else if (type === "permission_error") code = "permission";
  else if (type === "rate_limit_error") code = "rate-limit";
  else if (type === "overloaded_error") code = "overloaded";
  else if (type) code = type.replace(/[^a-z0-9_-]/g, "").slice(0, 48) || code;

  return new Error(`anthropic ${res.status} ${code}`);
}

async function rawCallOnce(key: string, model: string, system: string, userContent: string, maxTokens: number, signal?: AbortSignal): Promise<string> {
  return claudeRequestGovernor.run(async (transportSignal) => {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      signal: transportSignal,
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: "user", content: userContent }],
      }),
    });
    if (!res.ok) {
      if (res.status === 429 || res.status === 529) {
        claudeRequestGovernor.cooldown(res.status, res.headers.get("retry-after"));
      }
      throw await anthropicHttpError(res);
    }
    // Keep body consumption inside the transport deadline too: headers can arrive
    // while the body stalls. A partial/refused generation is never a ready draft.
    const data = await res.json();
    if (data?.stop_reason === "max_tokens") throw new Error("anthropic-output-truncated");
    if (data?.stop_reason === "refusal") throw new Error("anthropic-output-refused");
    if (!data || (data.stop_reason !== "end_turn" && data.stop_reason !== "stop_sequence") || !Array.isArray(data.content)) throw new Error("bad-output");
    const text = (data.content as { type: string; text?: string }[])
      .filter((b) => b?.type === "text")
      .map((b) => typeof b.text === "string" ? b.text : "")
      .join("");
    if (!text.trim()) throw new Error("bad-output");
    return text;
  }, signal);
}

function shouldUseClaudeFallback(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /^anthropic 400 (?:invalid_request_error|model-access|request-rejected)\b/.test(error.message);
}

/** Direct Anthropic call (BYO-key). Returns parsed JSON, or throws. */
async function rawCall(key: string, model: string, system: string, userContent: string, maxTokens: number, signal?: AbortSignal): Promise<string> {
  const selectedModel = model === CLAUDE_MODEL ? activeClaudeModel : model;
  try {
    return await rawCallOnce(key, selectedModel, system, userContent, maxTokens, signal);
  } catch (error) {
    if (signal?.aborted || selectedModel !== CLAUDE_MODEL || !shouldUseClaudeFallback(error)) throw error;
    activeClaudeModel = CLAUDE_FALLBACK_MODEL;
    return rawCallOnce(key, activeClaudeModel, system, userContent, maxTokens, signal);
  }
}

/** For structured (JSON) responses — scoring, grouping, recall, advice. */
async function callDirect<T>(key: string, model: string, system: string, userContent: string, maxTokens = 4096, signal?: AbortSignal): Promise<T> {
  const text = await rawCall(key, model, system, userContent, maxTokens, signal);
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("bad-output");
  const slice = text.slice(start, end + 1);
  try { return JSON.parse(slice) as T; } catch { /* salvage below */ }
  try { return JSON.parse(slice.replace(/,\s*([}\]])/g, "$1")) as T; } catch { /* trailing-comma repair failed */ }
  // Last resort: pull the individual idea objects so one bad char doesn't torch the batch.
  const objs = [...slice.matchAll(/\{[^{}]*"text"[\s\S]*?\}/g)]
    .map((mm) => { try { return JSON.parse(mm[0]); } catch { return null; } })
    .filter(Boolean);
  if (objs.length) return { ideas: objs } as unknown as T;
  throw new Error("bad-output");
}

export async function classify(tabs: chrome.tabs.Tab[]): Promise<ClassifyResult> {
  const inputs = tabsToInputs(tabs);
  const key = await getKey();
  if (key) {
    return callDirect<ClassifyResult>(key, CLAUDE_MODEL, CLASSIFY_SYSTEM, `Organize these ${inputs.length} tabs:\n\n${tabsToText(inputs)}`);
  }
  throw new Error("no-key");
}

export async function advise(tabs: chrome.tabs.Tab[]): Promise<AdviceResult> {
  const now = Date.now();
  const inputs = tabsToInputs(tabs);
  const key = await getKey();
  if (key) {
    return callDirect<AdviceResult>(key, CLAUDE_MODEL, ADVISE_SYSTEM, `Tabs:\n${tabsToText(inputs)}`);
  }
  throw new Error("no-key");
}

/* ---------- semantic recall (BYO-key) ---------- */

export interface Candidate { title: string; url: string; source: string; }
export interface RankedResult extends Candidate { why: string; }

/** Claude-ranked search over a candidate set (open tabs + archive + history). */
export async function recall(query: string, candidates: Candidate[]): Promise<RankedResult[]> {
  const key = await getKey();
  if (!key) throw new Error("no-key");
  const numbered = candidates.map((c, i) => `${i}. ${c.title} | ${c.url}`).join("\n");
  const raw = await callDirect<{ results: { i: number; why: string }[] }>(
    key,
    CLAUDE_MODEL,
    RECALL_SYSTEM,
    `Query: ${query}\n\nPages:\n${numbered}`,
  );
  return (raw.results || [])
    .map((r) => (candidates[r.i] ? { ...candidates[r.i], why: r.why } : null))
    .filter((x): x is RankedResult => x !== null);
}

/* ---------- X reply copilot (BYO-key) ---------- */

export interface XPost {
  i: number;
  author: string;
  text: string;
  meta?: string;
  context?: string;
  authorHeadline?: string;
  authorKind?: string;
  connectionDegree?: string;
}
export type XReplyMove = "add_detail" | "counterpoint" | "concrete_example" | "narrow_question" | "substantive_support";
export type XReplyRisk = "none" | "generic" | "promotional" | "context_mismatch" | "hostile";
const X_REPLY_MOVES = new Set<XReplyMove>(["add_detail", "counterpoint", "concrete_example", "narrow_question", "substantive_support"]);
const X_REPLY_RISKS = new Set<XReplyRisk>(["none", "generic", "promotional", "context_mismatch", "hostile"]);
const validReplyMove = (value: unknown): XReplyMove | undefined => typeof value === "string" && X_REPLY_MOVES.has(value as XReplyMove) ? value as XReplyMove : undefined;
const validReplyRisk = (value: unknown): XReplyRisk | undefined => typeof value === "string" && X_REPLY_RISKS.has(value as XReplyRisk) ? value as XReplyRisk : undefined;
const LI_DECISIONS = new Set<LinkedInDecision>(["comment", "skip", "needs_detail"]);
const LI_PERSON_EVIDENCE = new Set<LinkedInPersonEvidence>(["visible_headline", "post_stated_context", "exact_user_target", "name_only"]);
const LI_COMMENT_LANES = new Set<LinkedInCommentLane>(["mechanism", "implementation_detail", "boundary_condition", "decision_implication", "evidence_question", "supplied_example"]);
const validLinkedInDecision = (value: unknown): LinkedInDecision | undefined => typeof value === "string" && LI_DECISIONS.has(value as LinkedInDecision) ? value as LinkedInDecision : undefined;
const validLinkedInPersonEvidence = (value: unknown): LinkedInPersonEvidence | undefined => typeof value === "string" && LI_PERSON_EVIDENCE.has(value as LinkedInPersonEvidence) ? value as LinkedInPersonEvidence : undefined;
const validLinkedInCommentLane = (value: unknown): LinkedInCommentLane | undefined => typeof value === "string" && LI_COMMENT_LANES.has(value as LinkedInCommentLane) ? value as LinkedInCommentLane : undefined;
const validUnitScore = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined;
export interface XScore {
  i: number;
  score: number;
  reason: string;
  category?: string;
  products?: string[];
  anchor?: string;
  replyMove?: XReplyMove;
  replyBrief?: string;
  risk?: XReplyRisk;
  decision?: LinkedInDecision;
  postFit?: number;
  personFit?: number;
  contributionFit?: number;
  postReason?: string;
  personReason?: string;
  personEvidence?: LinkedInPersonEvidence;
  commentLane?: LinkedInCommentLane;
  missingDetailPrompt?: string;
}

/** Score posts for reply-worthiness given the user's niche. Cost-efficient Sonnet.
 *  When products are supplied, the scorer also tags each PROMOTE post with the
 *  best-fit product index. */
export async function scorePosts(
  posts: XPost[],
  niche: string,
  products: { name: string; blurb?: string }[] = [],
  platform: SocialPlatform = "x",
  linkedInStrategy = "",
  signal?: AbortSignal,
): Promise<XScore[]> {
  const analysisSettings = await chrome.storage.local.get([CONFIG.ANALYSIS_PROVIDER_KEY, CONFIG.TYPESAFE_KEY_KEY, CONFIG.JEV_ANALYSIS_CONSENT_KEY]);
  if (analysisSettings[CONFIG.ANALYSIS_PROVIDER_KEY] === "jev") {
    if (analysisSettings[CONFIG.JEV_ANALYSIS_CONSENT_KEY] !== JEV_ANALYSIS_CONSENT) throw new Error("jev-analysis-consent-required");
    const jevKey = analysisSettings[CONFIG.TYPESAFE_KEY_KEY];
    if (typeof jevKey !== "string" || !jevKey.trim()) throw new Error("jev-key-required");
    return scorePostsWithJev(jevKey, posts, niche, platform, linkedInStrategy, signal);
  }
  const key = await getKey();
  if (!key) throw new Error("no-key");
  const list = posts.map((p) => {
    const text = p.text.trim().slice(0, platform === "linkedin" ? 1_000 : 400);
    const context = p.context?.trim().slice(0, platform === "linkedin" ? 500 : 320);
    const author = platform === "linkedin" ? p.author : `@${p.author}`;
    const observedAuthor = platform === "linkedin"
      ? [p.authorKind, p.authorHeadline, p.connectionDegree].filter(Boolean).join(" | ")
      : "";
    const outer = `${p.i}. ${author}${observedAuthor ? ` [OBSERVED AUTHOR: ${observedAuthor}]` : ""}${p.meta ? ` [${p.meta}]` : ""}: ${text}`;
    return context ? `${outer}\n   PARENT/QUOTED CONTEXT (context only): ${context}` : outer;
  }).join("\n");
  const prods = products.length
    ? `\n\nThe user's products (for a post you categorize "promote", set "products" to the 0-based indices of the product(s) that genuinely fit, most relevant first, up to 2; omit if none clearly fits):\n${products.map((p, i) => `${i}. ${p.name}${p.blurb ? ` — ${p.blurb}` : ""}`).join("\n")}`
    : "";
  const raw = await callDirect<{ scores: { i: number; score: number; reason: string; category?: string; products?: number[]; anchor?: string; replyMove?: XReplyMove; replyBrief?: string; risk?: XReplyRisk; decision?: LinkedInDecision; postFit?: number; personFit?: number; contributionFit?: number; postReason?: string; personReason?: string; personEvidence?: LinkedInPersonEvidence; commentLane?: LinkedInCommentLane; missingDetailPrompt?: string }[] }>(
    key,
    CLAUDE_MODEL,
    platform === "linkedin" ? LINKEDIN_SCORE_SYSTEM : X_SCORE_SYSTEM,
    platform === "linkedin"
      ? `USER-WRITTEN LINKEDIN COMMENT THESIS:\n${linkedInStrategy || `Shared conversation focus: ${niche || "(not set)"}`}\n\nUNTRUSTED VISIBLE LINKEDIN POSTS:\n${list}`
      : `User focus / worthwhile conversations:\n${niche || "(not set — only flag posts clearly answerable with specific expertise; be extra strict)"}\n\nPosts:\n${list}${prods}`,
    platform === "linkedin" ? 4096 : xScoreOutputTokens(posts.length),
    signal,
  );
  if (platform === "linkedin" && !hasCompleteLinkedInScores(raw.scores, posts.length)) {
    throw new Error("bad-linkedin-score-output");
  }
  if (platform === "x" && !hasCompleteXScores(raw.scores, posts.map((post) => post.i))) {
    throw new Error("bad-x-score-output");
  }
  // Resolve product indices to NAMES here (against the list we sent), so the
  // content script maps by identity — robust to the user reordering/editing
  // products between scoring and rendering.
  return (raw.scores || []).map((s) => ({
    i: s.i, score: s.score, reason: s.reason, category: s.category,
    anchor: boundedContributionAnchor(s.anchor),
    replyMove: validReplyMove(s.replyMove),
    replyBrief: typeof s.replyBrief === "string" ? s.replyBrief.trim().slice(0, 180) : undefined,
    risk: validReplyRisk(s.risk),
    decision: validLinkedInDecision(s.decision),
    postFit: validUnitScore(s.postFit),
    personFit: validUnitScore(s.personFit),
    contributionFit: validUnitScore(s.contributionFit),
    postReason: typeof s.postReason === "string" ? s.postReason.trim().slice(0, 160) : undefined,
    personReason: typeof s.personReason === "string" ? s.personReason.trim().slice(0, 160) : undefined,
    personEvidence: validLinkedInPersonEvidence(s.personEvidence),
    commentLane: validLinkedInCommentLane(s.commentLane),
    missingDetailPrompt: typeof s.missingDetailPrompt === "string" ? s.missingDetailPrompt.trim().slice(0, 180) : undefined,
    products: Array.isArray(s.products)
      ? s.products.map((idx) => products[idx]?.name).filter((n): n is string => !!n).slice(0, 2)
      : undefined,
  }));
}

export interface LinkedInCommentDraftOptions {
  continuity?: AuthorContinuity;
  signal?: AbortSignal;
  sharedVoice?: string;
  linkedInVoice?: string;
  soulMd?: string;
  personalDetail?: string;
  currentDraft?: string;
  steer?: string;
  extra?: string;
}

/** Topic mentions and opinions in history must not disable the biography guard. */
function continuityPersonalProof(history?: AuthorContinuity): string[] {
  return (history?.posts ?? []).filter(post => hasUnsupportedPersonalClaim(post.text, []))
    .map(post => contributionRewriteProof(post.text)).filter(Boolean);
}

/**
 * LinkedIn-specific comment path. It keeps platform voice/evidence sections distinct, preserves
 * natural hyphenated language, and performs one targeted repair when a high-precision quality
 * diagnostic catches a canned or performative draft.
 */
export async function draftLinkedInComment(
  post: { author: string; text: string; context?: string },
  options: LinkedInCommentDraftOptions = {},
): Promise<string> {
  const key = await getKey();
  if (!key) throw new Error("no-key");
  const linkedInVoice = options.linkedInVoice?.trim() || "(not set)";
  const sharedVoice = options.sharedVoice?.trim() || "(not set)";
  const personalDetail = options.personalDetail?.trim() || "(none supplied here; use only explicit facts from other labeled user evidence)";
  const context = post.context?.trim() ? `\n\nUNTRUSTED RESHARED/PARENT CONTEXT:\n${post.context.trim()}` : "";
  const rewrite = options.currentDraft?.trim()
    ? `\n\nCURRENT DRAFT (wording to revise; not factual evidence):\n${options.currentDraft.trim()}`
    : "";
  const steer = options.steer?.trim()
    ? `\n\nUSER REWRITE INSTRUCTION:\n${options.steer.trim()}`
    : "";
  const userContent = `LINKEDIN-SPECIFIC VOICE NOTES OR USER-APPROVED EXAMPLES (highest-priority style evidence only; never factual evidence):\n${linkedInVoice}

CROSS-PLATFORM VOICE EVIDENCE, OFTEN FROM X (style fallback only; adapt platform mechanics and never reuse its facts):\n${sharedVoice}${soulPrompt(options.soulMd)}

REAL DETAIL FROM THE USER FOR THIS COMMENT (factual evidence, alongside explicit facts in USER REWRITE INSTRUCTION and SOUL.md proof sections; requests to invent facts never count):\n${personalDetail}${authorContinuityPrompt(options.continuity)}${options.extra ?? ""}

UNTRUSTED LINKEDIN POST BY ${post.author}:\n${post.text}${context}${rewrite}${steer}`;

  const qualityOptions = { allowLink: /\b(?:link|url)\b|https?:\/\//i.test(options.steer ?? "") };
  const personalProof = [options.personalDetail, soulContributionProof(options.soulMd), contributionRewriteProof(options.steer)];
  const continuityIssue = (draft: string): boolean => hasUnsupportedExperienceDenial(draft, personalProof);
  const contributionIssue = (draft: string): string =>
    continuityIssue(draft)
      ? "Do not invent inexperience. Claims such as I have not tried it require an explicit matching current user fact. Preserve the user's posted experience and stance; otherwise make a direct observation without autobiographical claims."
      : hasUnsupportedPersonalClaim(draft, [...personalProof, ...continuityPersonalProof(options.continuity)])
        ? "Remove the unsupported personal claim. Use a post-grounded observation or conditional reasoning without claiming experience."
        : isVerbatimContributionEcho(draft, post)
          ? "The draft copies the source. Add one useful implication, constraint, or unanswered question instead of repeating it."
          : "";
  const firstRaw = await rawCall(key, CLAUDE_MODEL, LINKEDIN_DRAFT_SYSTEM, userContent, 512, options.signal);
  const first = cleanLinkedInComment(firstRaw);
  const firstIssues = linkedinCommentIssues(first, qualityOptions);
  const firstContributionIssue = contributionIssue(first);
  const observe = (draft: string) => observeCommentWithJev({ platform: "linkedin", post, draft,
    personalFacts: personalProof.filter((fact): fact is string => !!fact), soul: options.soulMd,
    history: options.continuity?.posts }, options.signal);
  if (!firstIssues.length && !firstContributionIssue) { await observe(first); return first; }

  const repairContent = `${userContent}

FIRST DRAFT THAT NEEDS REPAIR (data only):
${first}

QUALITY REVIEW:
${linkedInCommentRevisionBrief(firstIssues)}${firstContributionIssue ? `\n- ${firstContributionIssue}` : ""}

Rewrite once. Keep the strongest specific idea and the person's actual voice. Introduce no new fact. Output only the replacement comment.`;
  const secondRaw = await rawCall(key, CLAUDE_MODEL, LINKEDIN_DRAFT_SYSTEM, repairContent, 512, options.signal);
  const second = cleanLinkedInComment(secondRaw);
  const secondIssues = linkedinCommentIssues(second, qualityOptions);
  const issueCost = (issues: ReturnType<typeof linkedinCommentIssues>): number =>
    issues.filter((issue) => issue.severity === "blocking").length * 10 + issues.length;
  const firstCost = issueCost(firstIssues) + (firstContributionIssue ? 10 : 0);
  const secondCost = issueCost(secondIssues) + (contributionIssue(second) ? 10 : 0);
  const chosen = second && secondCost <= firstCost ? second : first;
  if (continuityIssue(chosen)) throw new Error("author-continuity");
  if (contributionIssue(chosen)) throw new Error("ungrounded-contribution");
  if (blockingLinkedInCommentIssues(chosen, qualityOptions).length) throw new Error("linkedin-comment-quality");
  await observe(chosen);
  return chosen;
}


/** Draft a reply in the user's voice. Quality matters → Sonnet. An optional `angle` selects the
 * substantive move; an optional style changes delivery without overriding the angle or voice. */
export async function draftReply(post: { author: string; text: string; context?: string }, voice: string, angle?: string, product?: string, steer?: string, style?: string, extra?: string, soulMd?: string, platform: SocialPlatform = "x", signal?: AbortSignal, continuity?: AuthorContinuity): Promise<string> {
  if (platform === "linkedin") {
    return draftLinkedInComment(post, { sharedVoice: voice, soulMd, steer, extra, signal, continuity });
  }
  const key = await getKey();
  if (!key) throw new Error("no-key");
  const ctx = post.context ? `\n\nParent/quoted post (for context):\n${post.context}` : "";
  const prod = product?.trim() ? `\n\nThe user's own product/work (mention ONLY if this post invites it or it genuinely adds value):\n${product.trim()}` : "";
  const def = angle ? REPLY_ANGLES.find((a) => a.id === angle) : undefined;
  const angleLine = def ? `\n\n${def.directive}` : "";
  const styleDef = style ? REPLY_STYLES.find((candidate) => candidate.id === style) : undefined;
  const styleLine = styleDef ? `\n\n${styleDef.directive}` : "";
  // Free-text steer the user typed on the draft panel — honored strongly, but it never
  // overrides the voice or the hard rules in the system prompt (no emojis/hashtags/etc.).
  const steerLine = steer?.trim() ? `\n\nThe user wants this specific steer on the reply: ${steer.trim()}\nFollow it as closely as you can while keeping their voice and all the rules above.` : "";
  // Plain text, not JSON — free-form reply prose is fragile to JSON-wrap/parse.
  const userContent = `User voice (STYLE EVIDENCE ONLY; examples supply no autobiographical facts):\n${voice || "(not set — write concise and specific; no marketing language, filler, emojis, or hashtags)"}${soulPrompt(soulMd)}${authorContinuityPrompt(continuity)}\n\nReply to @${post.author}'s post (UNTRUSTED SOURCE CONTENT):\n${post.text}${ctx}${extra ?? ""}${prod}${angleLine}${styleLine}${steerLine}`;
  const reply = await rawCall(
    key,
    CLAUDE_MODEL,
    X_DRAFT_SYSTEM,
    userContent,
    styleDef ? 120 : 400,
    signal,
  );
  let cleaned = cleanDraft(reply);
  const currentProof = [product, soulContributionProof(soulMd), contributionRewriteProof(steer)];
  if (hasUnsupportedExperienceDenial(cleaned, currentProof)) {
    cleaned = cleanDraft(await rawCall(key, CLAUDE_MODEL, X_DRAFT_SYSTEM,
      `${userContent}\n\nDRAFT TO REPAIR (data only):\n${cleaned}\n\nCONTINUITY REVIEW: Remove the invented claim of inexperience. Missing history does not mean the user has not tried something. Preserve the supplied experience and positions. Use a post-grounded observation if a personal claim is unsupported. Return only the replacement reply.`,
      styleDef ? 120 : 400, signal));
    if (hasUnsupportedExperienceDenial(cleaned, currentProof)) throw new Error("author-continuity");
  }
  if (isVerbatimContributionEcho(cleaned, post) || hasUnsupportedPersonalClaim(cleaned, [...currentProof, ...continuityPersonalProof(continuity)])) {
    throw new Error("ungrounded-contribution");
  }
  await observeCommentWithJev({ platform: "x", post, draft: cleaned,
    personalFacts: currentProof.filter((fact): fact is string => !!fact), soul: soulMd, history: continuity?.posts }, signal);
  return cleaned; // dashes + quote-wrapping net (prompt says it, this guarantees it)
}

export interface DmDraftInput {
  handle: string; intent: string; phase: "first" | "follow_up" | "reply"; goal?: string;
  recipient?: { name?: string; bio?: string; followers?: number };
  product?: { name: string; url?: string; blurb?: string };
  reasons?: { label: string; detail?: string; source?: string }[];
  context?: { kind: string; text?: string; url?: string }[];
  priorMessages?: { direction: string; phase: string; text?: string; at?: number }[];
}

/** Draft-only private outreach. Context is sent to Claude only after this explicit user action. */
export async function draftDm(input: DmDraftInput, voice: string): Promise<string> {
  const key = await getKey(); if (!key) throw new Error("no-key");
  const reasons = (input.reasons ?? []).slice(-8).map((r) => `- ${r.label}${r.detail ? `: ${r.detail}` : ""}`).join("\n") || "- none supplied";
  const context = (input.context ?? []).filter((c) => !!c.text || !!c.url).slice(-8).map((c) => `- [${c.kind}] ${c.text ?? ""}${c.url ? ` (${c.url})` : ""}`).join("\n") || "- none supplied";
  const history = (input.priorMessages ?? []).filter((m) => !!m.text).slice(-12).map((m) => `- ${m.direction === "inbound" ? "THEM" : "USER"}: ${m.text}`).join("\n") || "- no private history supplied";
  const product = input.product ? `${input.product.name}${input.product.blurb ? ` — ${input.product.blurb}` : ""}${input.product.url ? ` (${input.product.url})` : ""}` : "none selected";
  const msg = await rawCall(key, CLAUDE_MODEL, DM_DRAFT_SYSTEM,
    `User voice:\n${voice || "(not set — write plainly, warmly, and specifically)"}\n\nRecipient: @${input.handle}${input.recipient?.name ? ` (${input.recipient.name})` : ""}\nPublic bio: ${input.recipient?.bio || "not available"}\nIntent: ${input.intent}\nPhase: ${input.phase}\nUser's goal/note: ${input.goal || "not supplied"}\nSelected product/resource: ${product}\n\nWhy this person / evidence:\n${reasons}\n\nCaptured public or user context:\n${context}\n\nPrivate conversation history the user explicitly saved:\n${history}`,
    500,
  );
  return cleanDraft(msg).slice(0, 2_000);
}

/** Per-idea quality call-out from the judge — surfaced in the UI so the user can triage (ship the
 *  strong, fix the ok/weak, skip the rest). Distinct from the virality band (which is source reach). */
export interface Grade { tier: "strong" | "ok" | "weak"; lever?: string; callout?: string; fixable?: boolean; }
export interface PostIdea { text: string; source: string; pattern: string; why: string; critique: string; hookStrength: number; grade?: Grade; }
export interface OwnPostLite { text: string; likes?: number; reposts?: number; }

/** Turn over-performing posts in the user's niche into ORIGINAL post ideas in
 *  their voice. Remixes the winning PATTERNS, never the content. Quality → Sonnet.
 *  The model scores ONLY hookStrength (0-3); the honest virality band is computed in the
 *  content script from hookStrength + the real measured rank of the source it remixed. */
export async function generatePostIdeas(posts: { author: string; text: string; likes?: number; reposts?: number; followers?: number; shape?: string }[], voice: string, niche: string, ownPosts: OwnPostLite[] = [], followers?: number, shapeLine?: string, strategyLine?: string, soulMd?: string, postingModelLine?: string): Promise<PostIdea[]> {
  const key = await getKey();
  if (!key) throw new Error("no-key");
  const list = posts.map((p, i) => {
    const eng = (p.likes ?? 0) + (p.reposts ?? 0);
    const ctx = p.followers ? `${eng} eng on ~${p.followers} followers` : `${eng} eng`;
    return `${i + 1}. @${p.author} [${ctx}${p.shape ? ` \u00b7 ${p.shape}` : ""}]: ${p.text.replace(/\s+/g, " ").slice(0, 280)}`;
  }).join("\n");
  // The user's own recent posts: primary voice/structure anchor + de-dupe guard. Top engagers
  // first + flagged "(this landed for you)" so "EXTEND your themes" operates on winners.
  const sortedOwn = [...ownPosts].sort((a, b) => ((b.likes ?? 0) + (b.reposts ?? 0)) - ((a.likes ?? 0) + (a.reposts ?? 0)));
  const ownBlock = sortedOwn.length
    ? `\n\nThe user's OWN recent posts (your PRIMARY voice + structure anchor; recurring beliefs and topics are welcome with a fresh application, implication, or supported example. Do NOT produce near duplicates or invent a change of stance):\n${sortedOwn.slice(0, 15).map((p, i) => `${i + 1}. ${i < 3 ? "(this landed for you) " : ""}${p.text.replace(/\s+/g, " ").slice(0, 280)}`).join("\n")}`
    : "\n\n(The user's own posts were not available — the VOICE blurb is from REPLIES, so lean on it for tone only. COLD-START RULE: with no real person visible, contrarian / myth-bust / say-the-quiet-part shapes read as an LLM's idea of spicy — prefer plain, concrete, understated observations and questions; earn edge only from specifics you can actually ground.)";
  const fol = followers ? `\n\nUser approximate followers: ~${followers} (aim the post at this reach tier).` : "";
  const shp = shapeLine?.trim() ? `\n\nMEASURED shape signal for this user (X-reported, settled posts only): ${shapeLine.trim()} When two seeds are equally strong, prefer that shape for 1-2 of the 5 — never force it onto a weak seed.` : "";
  const strategy = strategyLine?.trim() ? `\n\nACTIVE 14-DAY STRATEGY TEST: ${strategyLine.trim()} Make 3 of the 5 ideas valid executions of this bet, while preserving source honesty and never inventing evidence. Keep 2 ideas exploratory so the batch does not become repetitive.` : "";
  const personal = postingModelLine?.trim() ? `\n\nIMPORTED PERSONAL POSTING EVIDENCE: ${postingModelLine.trim()}` : "";
  const userMsg = `User niche / what they post about:\n${niche || "(not set)"}\n\nUser voice (from their REPLIES — tone + word choice only, NOT post structure):\n${voice || "(not set — write terse and specific; no marketing language, no emojis, no hashtags)"}${soulPrompt(soulMd)}${ownBlock}${fol}${shp}${strategy}${personal}\n\nOver-performing posts from others in the space (remix the PATTERNS, never copy the content):\n${list}`;
  const raw = await callDirect<{ ideas: { text: string; source?: string; pattern: string; why: string; critique?: string; hookStrength?: number }[] }>(
    key,
    CLAUDE_MODEL,
    POST_IDEAS_SYSTEM,
    userMsg,
    2200,
    // temperature deliberately UNSET: a measured A/B (2026-07) showed 0.7 scored WORSE across the
    // board on the live judge (more conservative = more generic) — the default sampling wins.
  );
  const ideas = (raw.ideas || [])
    .slice(0, 6)
    .map((d) => ({ text: cleanDraft(d.text || ""), source: (d.source || "").replace(/^@/, "").trim(), pattern: (d.pattern || "").trim(), why: (d.why || "").trim(), critique: (d.critique || "").trim(), hookStrength: Math.max(0, Math.min(3, Math.round(Number(d.hookStrength) || 0))) }))
    .filter((d) => d.text);
  // SECOND PASS (measured 2026-07: swap-fails 60%→40%, antiGeneric +0.67): a compact judge call flags
  // the ideas that fail the swap test, then Sonnet regenerates ONLY those into user-specific posts.
  return refinePostIdeas(key, ideas, userMsg);
}

/** The reject-and-regenerate second pass. Judge (Haiku) flags swap-test failures → regen (Sonnet)
 *  rewrites just those. Best-effort: any error returns the pass-1 ideas, so it never breaks a
 *  generation. A regenerated idea is an original on a new point, so its source attribution is
 *  dropped (honest — it bands as an own-theme idea, no false proof post). */
async function refinePostIdeas(key: string, ideas: PostIdea[], userMsg: string): Promise<PostIdea[]> {
  if (ideas.length < 2) return ideas;
  const gradeBatch = async (batch: PostIdea[], indexNote = ""): Promise<Grade[]> => {
    const msg = `${userMsg}\n\nGrade these ${batch.length} generated ideas${indexNote}, in order:\n${batch.map((d, i) => `${i + 1}. ${d.text}`).join("\n\n")}`;
    const v = await callDirect<{ grades?: Grade[] }>(key, CLAUDE_MODEL, POST_IDEAS_JUDGE_SYSTEM, msg, 700);
    return (v.grades || []).map((g) => ({ tier: g?.tier === "strong" || g?.tier === "weak" ? g.tier : "ok", lever: (g?.lever || "").trim() || undefined, callout: (g?.callout || "").trim() || undefined, fixable: g?.fixable !== false }));
  };
  try {
    const out = ideas.slice();
    const grades = await gradeBatch(out);
    out.forEach((d, i) => { if (grades[i]) d.grade = grades[i]; }); // attach the call-out to every idea
    // Auto-fix the WEAK ones (the second pass): regenerate, then RE-GRADE just those so their shown
    // call-out matches the new text (never a stale grade). source dropped — a regen is an original.
    const fails = out.map((d, i) => (d.grade?.tier === "weak" ? i : -1)).filter((i) => i >= 0);
    if (fails.length) {
      const flagged = fails.map((i) => out[i].text);
      const regenMsg = `${userMsg}\n\nThe drafts that failed the swap test (rewrite each into something only this user could post, in order):\n${flagged.map((t, k) => `${k + 1}. ${t}`).join("\n\n")}`;
      const re = await callDirect<{ ideas?: { text?: string; why?: string; pattern?: string }[] }>(key, CLAUDE_MODEL, POST_IDEAS_REGEN_SYSTEM, regenMsg, 1600);
      const regenerated: { idx: number; idea: PostIdea }[] = [];
      fails.forEach((idx, k) => {
        const r = (re.ideas || [])[k];
        const txt = cleanDraft(r?.text || "");
        if (!txt) return;
        out[idx] = { ...out[idx], text: txt, source: "", why: (r?.why || "").trim() || "Rewritten to be specific to your own work, not a niche template.", pattern: (r?.pattern || "").trim(), grade: undefined };
        regenerated.push({ idx, idea: out[idx] });
      });
      if (regenerated.length) {
        try {
          const fresh = await gradeBatch(regenerated.map((r) => r.idea), " (each rewritten to be more specific)");
          regenerated.forEach((r, k) => { out[r.idx].grade = fresh[k] || { tier: "ok" }; });
        } catch { /* re-grade is best-effort — a regenerated idea just shows no badge */ }
      }
    }
    return out;
  } catch { return ideas; }
}

/** Rewrite one post idea per a steer, keeping the same topic + the user's voice. Sonnet, cheap. */
export async function generatePostIdeaRewrite(text: string, steer: string, voice: string, source?: string, pattern?: string, soulMd?: string): Promise<string> {
  const key = await getKey();
  if (!key) throw new Error("no-key");
  const src = source?.trim() ? `\n\nThe source post whose pattern it borrows (for grounding, do NOT copy it):\n${source.trim().slice(0, 280)}` : "";
  const pat = pattern?.trim() ? `\n\nPattern it uses: ${pattern.trim()}` : "";
  const out = await rawCall(
    key,
    CLAUDE_MODEL,
    POST_IDEA_REWRITE_SYSTEM,
    `User voice:\n${voice || "(not set — terse and specific; no marketing language, no emojis, no hashtags)"}${soulPrompt(soulMd)}\n\nCurrent draft:\n${text}\n\nSteer (how to change it): ${steer}${pat}${src}`,
    400,
  );
  return cleanDraft(out); // dashes + quote-wrapping net
}
