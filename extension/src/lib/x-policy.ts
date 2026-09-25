/** Pure validation for the X scoring/drafting broker; keep page data bounded. */
export const X_CONSENT_VERSION = "v1" as const;
export const X_SCORE_MAX_BATCH = 12;
export const X_PAYLOAD_LIMITS = {
  author: 120, text: 400, context: 320, meta: 220,
  angle: 40, product: 16_000, steer: 500, style: 40, reason: 120,
  category: 40, anchor: 220, replyBrief: 300, authorLine: 500,
  threadLine: 500, opportunityLine: 1_200,
} as const;

export function isSupportedXUrl(value: unknown): boolean {
  if (typeof value !== "string" || value !== value.trim()) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "x.com" || url.hostname === "twitter.com")
      && !url.username && !url.password && !url.port;
  } catch { return false; }
}
export function hasSupportedXSenderUrl(...values: unknown[]): boolean {
  return values.some(isSupportedXUrl);
}
/** Absent enablement preserves the original opt-in migration default. */
export function canUseXBroker(consent: unknown, enabled: unknown, key: unknown, paused?: unknown): boolean {
  return consent === X_CONSENT_VERSION && (enabled === undefined || enabled === true)
    && typeof key === "string" && key.trim().length > 0 && paused !== true;
}

export interface XScorePost { i: number; author: string; text: string; context?: string; meta?: string }
export interface XScorePayload { type: "SCORE_POSTS"; platform?: "x"; posts: XScorePost[] }
export interface XDraftPayload {
  type: "DRAFT_REPLY"; platform?: "x"; author: string; text: string; context?: string;
  angle?: string; product?: string; steer?: string; style?: string; reason?: string;
  category?: string; anchor?: string; replyBrief?: string; authorLine?: string;
  threadLine?: string; opportunityLine?: string;
}
type RecordValue = Record<string, unknown>;
function record(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function onlyKeys(value: RecordValue, keys: Set<string>): boolean {
  return Object.keys(value).every((key) => keys.has(key));
}
/** Reject oversized input, preserve meaningful line breaks, drop blank optional fields. */
function clean(value: unknown, max: number, required = false): string | undefined | null {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || value.length > max || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value)) return null;
  const result = value.replace(/\r\n?/g, "\n").trim();
  return result || (required ? null : undefined);
}
const SCORE_KEYS = new Set(["type", "platform", "posts"]);
const POST_KEYS = new Set(["i", "author", "text", "context", "meta"]);
const DRAFT_KEYS = new Set(["type", "platform", ...Object.keys(X_PAYLOAD_LIMITS).filter((key) => key !== "meta")]);
const ANGLES = new Set(["connect", "value", "ask", "joke", "support", "promote"]);
export function sanitizeXScorePayload(value: unknown): XScorePayload | null {
  if (!record(value) || !onlyKeys(value, SCORE_KEYS) || value.type !== "SCORE_POSTS"
    || (value.platform !== undefined && value.platform !== "x") || !Array.isArray(value.posts)
    || value.posts.length < 1 || value.posts.length > X_SCORE_MAX_BATCH) return null;
  const posts: XScorePost[] = [];
  const indices = new Set<number>();
  for (const raw of value.posts) {
    // Discovery keeps global indices across its 12-post chunks.
    if (!record(raw) || !onlyKeys(raw, POST_KEYS) || !Number.isInteger(raw.i)
      || typeof raw.i !== "number" || raw.i < 0 || raw.i > 9_999 || indices.has(raw.i)) return null;
    indices.add(raw.i);
    const author = clean(raw.author, X_PAYLOAD_LIMITS.author, true);
    const text = clean(raw.text, X_PAYLOAD_LIMITS.text, true);
    const context = clean(raw.context, X_PAYLOAD_LIMITS.context);
    const meta = clean(raw.meta, X_PAYLOAD_LIMITS.meta);
    if (author == null || text == null || context === null || meta === null) return null;
    posts.push({ i: raw.i, author, text, ...(context === undefined ? {} : { context }), ...(meta === undefined ? {} : { meta }) });
  }
  return { type: "SCORE_POSTS", ...(value.platform === "x" ? { platform: "x" as const } : {}), posts };
}
export function sanitizeXDraftPayload(value: unknown): XDraftPayload | null {
  if (!record(value) || !onlyKeys(value, DRAFT_KEYS) || value.type !== "DRAFT_REPLY"
    || (value.platform !== undefined && value.platform !== "x")) return null;
  const author = clean(value.author, X_PAYLOAD_LIMITS.author, true);
  const text = clean(value.text, X_PAYLOAD_LIMITS.text, true);
  if (author == null || text == null) return null;
  const result: XDraftPayload = { type: "DRAFT_REPLY", author, text };
  if (value.platform === "x") result.platform = "x";
  for (const [key, limit] of Object.entries(X_PAYLOAD_LIMITS)) {
    if (key === "author" || key === "text" || key === "meta") continue;
    const cleaned = clean(value[key], limit);
    if (cleaned === null) return null;
    if (key === "product" && typeof value.product === "string" && cleaned === undefined) result.product = ""; // explicit no-product override must not activate broker fallback
    else if (cleaned !== undefined) (result as unknown as RecordValue)[key] = cleaned;
  }
  if ((result.angle !== undefined && !ANGLES.has(result.angle))
    || (result.category !== undefined && !ANGLES.has(result.category))
    || (result.style !== undefined && result.style !== "community-spark")) return null;
  return result;
}
