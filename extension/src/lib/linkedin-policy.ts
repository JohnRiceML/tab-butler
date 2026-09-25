/**
 * Pure trust-boundary policy for the LinkedIn comment copilot.
 *
 * Keep this module independent of Chrome and network APIs so the service worker
 * can apply one small, unit-tested policy before accepting page-originated
 * scoring or drafting work.
 */

/** Bump only when the LinkedIn data-use disclosure materially changes. */
export const LI_CONSENT_VERSION = "v5" as const;

/**
 * Content script to service worker compatibility contract. A mismatch means
 * Chrome refreshed one unpacked extension file without reloading the runtime.
 */
export const LI_BROKER_PROTOCOL = 3 as const;

export const LI_SCORE_MAX_BATCH = 10;

/** Maximum UTF-16 lengths accepted from the LinkedIn content-script boundary. */
export const LI_PAYLOAD_LIMITS = {
  author: 120,
  text: 1_200,
  context: 500,
  meta: 220,
  reason: 120,
  category: 40,
  anchor: 220,
  replyMove: 40,
  replyBrief: 300,
  steer: 500,
  currentDraft: 1_200,
  personalDetail: 700,
  opportunityLine: 300,
  authorHeadline: 220,
  authorKind: 20,
  connectionDegree: 20,
  personReason: 160,
  commentLane: 40,
} as const;

const FEED_ROUTE = /^\/feed\/?$/;
const FEED_UPDATE_ROUTE = /^\/feed\/update\/urn:li:activity:\d{6,}\/?$/;
// LinkedIn's canonical post URLs contain an activity id in their slug.
// Requiring it avoids treating arbitrary /posts/* paths as a supported surface.
const POSTS_DETAIL_ROUTE = /^\/posts\/(?=.{1,300}\/?$)[A-Za-z0-9][A-Za-z0-9._~-]*activity-\d{6,}(?:-[A-Za-z0-9_-]+)?\/?$/;

/**
 * Whether a URL is one of the LinkedIn feed/post surfaces supported by this
 * copilot. Query strings and fragments do not change route eligibility.
 */
export function isSupportedLinkedInUrl(value: unknown): boolean {
  if (typeof value !== "string" && !(value instanceof URL)) return false;
  if (typeof value === "string" && (!value || value !== value.trim())) return false;

  try {
    const url = value instanceof URL ? value : new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "www.linkedin.com") return false;
    if (url.username || url.password || url.port) return false;
    return FEED_ROUTE.test(url.pathname) || FEED_UPDATE_ROUTE.test(url.pathname) || POSTS_DETAIL_ROUTE.test(url.pathname);
  } catch {
    return false;
  }
}

/** Chrome may expose the page URL in sender.url, sender.tab.url, or both. */
export function hasSupportedLinkedInSenderUrl(...values: unknown[]): boolean {
  return values.some((value) => isSupportedLinkedInUrl(value));
}

/** All three conditions are required; truthy lookalikes do not pass. */
export function canUseLinkedInBroker(consent: unknown, enabled: unknown, key: unknown): boolean {
  return consent === LI_CONSENT_VERSION && enabled === true && typeof key === "string" && key.trim().length > 0;
}

export interface LinkedInScorePost {
  i: number;
  author: string;
  text: string;
  context?: string;
  meta?: string;
  authorHeadline?: string;
  authorKind?: string;
  connectionDegree?: string;
}

export interface LinkedInScorePayload {
  type: "LI_SCORE_POSTS";
  posts: LinkedInScorePost[];
}

export interface LinkedInDraftPayload {
  type: "LI_DRAFT_COMMENT";
  author: string;
  text: string;
  context?: string;
  reason?: string;
  category?: string;
  anchor?: string;
  replyMove?: string;
  replyBrief?: string;
  steer?: string;
  currentDraft?: string;
  personalDetail?: string;
  opportunityLine?: string;
  authorHeadline?: string;
  authorKind?: string;
  connectionDegree?: string;
  personReason?: string;
  commentLane?: string;
}

export type LinkedInBrokerPayload = LinkedInScorePayload | LinkedInDraftPayload;

type UnknownRecord = Record<string, unknown>;
type CleanResult = { ok: true; value?: string } | { ok: false };

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: UnknownRecord, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

/**
 * Page text arrives as inline prompt data. Normalize whitespace, reject control
 * characters and reject (rather than truncate) over-limit input so the sender
 * cannot smuggle an unexpectedly large model request across the boundary.
 */
function cleanString(value: unknown, max: number, required: boolean): CleanResult {
  if (value === undefined && !required) return { ok: true };
  if (typeof value !== "string" || value.length > max || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value)) return { ok: false };
  const cleaned = value.replace(/\s+/g, " ").trim();
  if (!cleaned) return required ? { ok: false } : { ok: true };
  return { ok: true, value: cleaned };
}

function cleanMultilineString(value: unknown, max: number): CleanResult {
  if (value === undefined) return { ok: true };
  if (typeof value !== "string" || value.length > max || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value)) return { ok: false };
  const cleaned = value
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return cleaned ? { ok: true, value: cleaned } : { ok: true };
}

function setOptional(target: Record<string, unknown>, key: string, result: CleanResult): boolean {
  if (!result.ok) return false;
  if (result.value !== undefined) target[key] = result.value;
  return true;
}

const SCORE_ROOT_KEYS = new Set(["type", "posts"]);
const SCORE_POST_KEYS = new Set(["i", "author", "text", "context", "meta", "authorHeadline", "authorKind", "connectionDegree"]);
const DRAFT_KEYS = new Set([
  "type", "author", "text", "context", "reason", "category",
  "anchor", "replyMove", "replyBrief", "steer", "currentDraft", "personalDetail", "opportunityLine",
  "authorHeadline", "authorKind", "connectionDegree", "personReason", "commentLane",
]);
const AUTHOR_KINDS = new Set(["person", "company", "unknown"]);
const CONNECTION_DEGREES = new Set(["1st", "2nd", "3rd", "following", "unknown"]);
const COMMENT_LANES = new Set(["mechanism", "implementation_detail", "boundary_condition", "decision_implication", "evidence_question", "supplied_example"]);

/** Return a bounded, prototype-free scoring payload, or null when invalid. */
export function sanitizeLinkedInScorePayload(value: unknown): LinkedInScorePayload | null {
  if (!isRecord(value) || !hasOnlyKeys(value, SCORE_ROOT_KEYS)) return null;
  if (value.type !== "LI_SCORE_POSTS") return null;
  if (!Array.isArray(value.posts) || value.posts.length < 1 || value.posts.length > LI_SCORE_MAX_BATCH) return null;

  const posts: LinkedInScorePost[] = [];
  for (let index = 0; index < value.posts.length; index += 1) {
    const raw = value.posts[index];
    if (!isRecord(raw) || !hasOnlyKeys(raw, SCORE_POST_KEYS) || raw.i !== index || !Number.isInteger(raw.i)) return null;

    const author = cleanString(raw.author, LI_PAYLOAD_LIMITS.author, true);
    const text = cleanString(raw.text, LI_PAYLOAD_LIMITS.text, true);
    const context = cleanString(raw.context, LI_PAYLOAD_LIMITS.context, false);
    const meta = cleanString(raw.meta, LI_PAYLOAD_LIMITS.meta, false);
    const authorHeadline = cleanString(raw.authorHeadline, LI_PAYLOAD_LIMITS.authorHeadline, false);
    const authorKind = cleanString(raw.authorKind, LI_PAYLOAD_LIMITS.authorKind, false);
    const connectionDegree = cleanString(raw.connectionDegree, LI_PAYLOAD_LIMITS.connectionDegree, false);
    if (!author.ok || author.value === undefined || !text.ok || text.value === undefined || !context.ok || !meta.ok || !authorHeadline.ok || !authorKind.ok || !connectionDegree.ok) return null;
    if (authorKind.value !== undefined && !AUTHOR_KINDS.has(authorKind.value)) return null;
    if (connectionDegree.value !== undefined && !CONNECTION_DEGREES.has(connectionDegree.value)) return null;

    const post: LinkedInScorePost = { i: index, author: author.value, text: text.value };
    if (context.value !== undefined) post.context = context.value;
    if (meta.value !== undefined) post.meta = meta.value;
    if (authorHeadline.value !== undefined) post.authorHeadline = authorHeadline.value;
    if (authorKind.value !== undefined) post.authorKind = authorKind.value;
    if (connectionDegree.value !== undefined) post.connectionDegree = connectionDegree.value;
    posts.push(post);
  }

  return { type: "LI_SCORE_POSTS", posts };
}

/** Return a bounded, prototype-free drafting payload, or null when invalid. */
export function sanitizeLinkedInDraftPayload(value: unknown): LinkedInDraftPayload | null {
  if (!isRecord(value) || !hasOnlyKeys(value, DRAFT_KEYS)) return null;
  if (value.type !== "LI_DRAFT_COMMENT") return null;

  const author = cleanString(value.author, LI_PAYLOAD_LIMITS.author, true);
  const text = cleanString(value.text, LI_PAYLOAD_LIMITS.text, true);
  if (!author.ok || author.value === undefined || !text.ok || text.value === undefined) return null;

  const draft: LinkedInDraftPayload = {
    type: "LI_DRAFT_COMMENT",
    author: author.value,
    text: text.value,
  };
  const optional: [keyof typeof LI_PAYLOAD_LIMITS, CleanResult][] = [
    ["context", cleanString(value.context, LI_PAYLOAD_LIMITS.context, false)],
    ["reason", cleanString(value.reason, LI_PAYLOAD_LIMITS.reason, false)],
    ["category", cleanString(value.category, LI_PAYLOAD_LIMITS.category, false)],
    ["anchor", cleanString(value.anchor, LI_PAYLOAD_LIMITS.anchor, false)],
    ["replyMove", cleanString(value.replyMove, LI_PAYLOAD_LIMITS.replyMove, false)],
    ["replyBrief", cleanString(value.replyBrief, LI_PAYLOAD_LIMITS.replyBrief, false)],
    ["steer", cleanString(value.steer, LI_PAYLOAD_LIMITS.steer, false)],
    ["currentDraft", cleanMultilineString(value.currentDraft, LI_PAYLOAD_LIMITS.currentDraft)],
    ["personalDetail", cleanMultilineString(value.personalDetail, LI_PAYLOAD_LIMITS.personalDetail)],
    ["opportunityLine", cleanString(value.opportunityLine, LI_PAYLOAD_LIMITS.opportunityLine, false)],
    ["authorHeadline", cleanString(value.authorHeadline, LI_PAYLOAD_LIMITS.authorHeadline, false)],
    ["authorKind", cleanString(value.authorKind, LI_PAYLOAD_LIMITS.authorKind, false)],
    ["connectionDegree", cleanString(value.connectionDegree, LI_PAYLOAD_LIMITS.connectionDegree, false)],
    ["personReason", cleanString(value.personReason, LI_PAYLOAD_LIMITS.personReason, false)],
    ["commentLane", cleanString(value.commentLane, LI_PAYLOAD_LIMITS.commentLane, false)],
  ];
  for (const [key, result] of optional) {
    if (!setOptional(draft as unknown as Record<string, unknown>, key, result)) return null;
  }
  if (draft.authorKind !== undefined && !AUTHOR_KINDS.has(draft.authorKind)) return null;
  if (draft.connectionDegree !== undefined && !CONNECTION_DEGREES.has(draft.connectionDegree)) return null;
  if (draft.commentLane !== undefined && !COMMENT_LANES.has(draft.commentLane)) return null;
  return draft;
}

/** Dispatch the two allowed broker message shapes without accepting ambiguity. */
export function sanitizeLinkedInBrokerPayload(value: unknown): LinkedInBrokerPayload | null {
  if (!isRecord(value)) return null;
  if (value.type === "LI_SCORE_POSTS") return sanitizeLinkedInScorePayload(value);
  if (value.type === "LI_DRAFT_COMMENT") return sanitizeLinkedInDraftPayload(value);
  return null;
}
