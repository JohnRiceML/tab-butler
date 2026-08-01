export const REPLY_HANDOFF_TTL_MS = 5 * 60 * 1000;
export const X_REPLY_BUBBLE_PATH_PREFIX = "M1.751 10c0-4.42";

export interface ReplyHandoff {
  version: 1;
  token: string;
  postId: string;
  author: string;
  text: string;
  createdAt: number;
  sourceTabId?: number;
}

export function statusIdFromPath(pathname: string): string | null {
  const parts = pathname.split("/").filter(Boolean);
  const status = parts.indexOf("status");
  const id = status >= 0 ? parts[status + 1] : "";
  return /^\d+$/.test(id || "") ? id : null;
}

export function replyPostUrl(handoff: Pick<ReplyHandoff, "postId" | "author">): string {
  const id = /^\d+$/.test(handoff.postId) ? handoff.postId : "";
  const author = handoff.author.trim().replace(/^@+/, "");
  if (!id) return "https://x.com/home";
  return /^[A-Za-z0-9_]{1,15}$/.test(author)
    ? `https://x.com/${encodeURIComponent(author)}/status/${id}`
    : `https://x.com/i/status/${id}`;
}

export function validReplyHandoff(value: unknown, now = Date.now()): ReplyHandoff | null {
  if (!value || typeof value !== "object") return null;
  const h = value as Partial<ReplyHandoff>;
  if (h.version !== 1 || typeof h.token !== "string" || !h.token.trim()) return null;
  if (typeof h.postId !== "string" || !/^\d+$/.test(h.postId)) return null;
  if (typeof h.author !== "string" || typeof h.text !== "string" || !h.text.trim() || h.text.length > 25_000) return null;
  if (typeof h.createdAt !== "number" || !Number.isFinite(h.createdAt)) return null;
  if (h.createdAt > now + 30_000 || now - h.createdAt > REPLY_HANDOFF_TTL_MS) return null;
  if (h.sourceTabId != null && (!Number.isInteger(h.sourceTabId) || h.sourceTabId < 0)) return null;
  return {
    version: 1,
    token: h.token,
    postId: h.postId,
    author: h.author.trim().replace(/^@+/, ""),
    text: h.text,
    createdAt: h.createdAt,
    sourceTabId: h.sourceTabId,
  };
}

export function handoffMatchesPath(handoff: ReplyHandoff, pathname: string): boolean {
  return statusIdFromPath(pathname) === handoff.postId;
}

export function isReplyBubblePath(pathData: string | null | undefined): boolean {
  return typeof pathData === "string" && pathData.startsWith(X_REPLY_BUBBLE_PATH_PREFIX);
}
