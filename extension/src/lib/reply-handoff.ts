export interface ReplyPostTarget {
  postId: string;
  author: string;
}

export function statusIdFromPath(pathname: string): string | null {
  const parts = pathname.split("/").filter(Boolean);
  const status = parts.indexOf("status");
  const id = status >= 0 ? parts[status + 1] : "";
  return /^\d+$/.test(id || "") ? id : null;
}

export function replyPostUrl(target: ReplyPostTarget): string {
  const id = /^\d+$/.test(target.postId) ? target.postId : "";
  const author = target.author.trim().replace(/^@+/, "");
  if (!id) return "https://x.com/home";
  return /^[A-Za-z0-9_]{1,15}$/.test(author)
    ? `https://x.com/${encodeURIComponent(author)}/status/${id}`
    : `https://x.com/i/status/${id}`;
}
