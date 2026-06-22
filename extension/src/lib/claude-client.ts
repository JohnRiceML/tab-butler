import { CONFIG, isLocalhost } from "./config";
import { idleMinutes } from "./heuristics";
import { ADVISE_SYSTEM, CLASSIFY_SYSTEM, RECALL_SYSTEM, REPLY_ANGLES, X_DRAFT_SYSTEM, X_SCORE_SYSTEM } from "./prompts";
import type { AdviceResult, ClassifyResult, TabInput } from "./types";

/**
 * Smart features run one of two ways, gated on the `smartEnabled` opt-in:
 *  - BYO-key: the user's Anthropic key is in storage → call the API directly
 *    (no server to run). This is the default, simplest path.
 *  - Proxy: no key set → fall back to the managed-tier proxy.
 * Either way we only ever send id/title/url/idle — never page content.
 */

export async function isSmartEnabled(): Promise<boolean> {
  return Boolean((await chrome.storage.local.get(CONFIG.SMART_ENABLED_KEY))[CONFIG.SMART_ENABLED_KEY]);
}

export async function getKey(): Promise<string | null> {
  return ((await chrome.storage.local.get(CONFIG.ANTHROPIC_KEY_KEY))[CONFIG.ANTHROPIC_KEY_KEY] as string) || null;
}

async function authHeader(): Promise<Record<string, string>> {
  // TODO(prod): real auth token for the managed tier.
  return { Authorization: "Bearer dev-placeholder-token" };
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

/** Direct Anthropic call (BYO-key). Returns parsed JSON, or throws. */
async function rawCall(key: string, model: string, system: string, userContent: string, maxTokens: number): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
      "content-type": "application/json",
    },
    body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: "user", content: userContent }] }),
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}`);
  const data = await res.json();
  return ((data.content || []) as { type: string; text?: string }[])
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("");
}

/** For structured (JSON) responses — scoring, grouping, recall, advice. */
async function callDirect<T>(key: string, model: string, system: string, userContent: string, maxTokens = 4096): Promise<T> {
  const text = await rawCall(key, model, system, userContent, maxTokens);
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("bad-output");
  return JSON.parse(text.slice(start, end + 1)) as T;
}

export async function classify(tabs: chrome.tabs.Tab[]): Promise<ClassifyResult> {
  const inputs = tabsToInputs(tabs);
  const key = await getKey();
  if (key) {
    return callDirect<ClassifyResult>(key, "claude-haiku-4-5", CLASSIFY_SYSTEM, `Organize these ${inputs.length} tabs:\n\n${tabsToText(inputs)}`);
  }
  const res = await fetch(`${CONFIG.PROXY_BASE_URL}/api/classify`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeader()) },
    body: JSON.stringify({ tabs: inputs }),
  });
  if (!res.ok) throw new Error(`classify: proxy ${res.status}`);
  return (await res.json()) as ClassifyResult;
}

export async function advise(tabs: chrome.tabs.Tab[]): Promise<AdviceResult> {
  const now = Date.now();
  const inputs = tabsToInputs(tabs);
  const key = await getKey();
  if (key) {
    return callDirect<AdviceResult>(key, "claude-haiku-4-5", ADVISE_SYSTEM, `Tabs:\n${tabsToText(inputs)}`);
  }
  const localhost = tabs
    .filter((t) => t.url && isLocalhost(t.url))
    .map((t) => {
      let port = 0;
      try { port = Number(new URL(t.url!).port) || 0; } catch { /* ignore */ }
      return { port, title: t.title, idleMinutes: idleMinutes(t, now) };
    });
  const res = await fetch(`${CONFIG.PROXY_BASE_URL}/api/advise`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeader()) },
    body: JSON.stringify({ tabs: inputs, localhost }),
  });
  if (!res.ok) throw new Error(`advise: proxy ${res.status}`);
  return (await res.json()) as AdviceResult;
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
    "claude-haiku-4-5",
    RECALL_SYSTEM,
    `Query: ${query}\n\nPages:\n${numbered}`,
  );
  return (raw.results || [])
    .map((r) => (candidates[r.i] ? { ...candidates[r.i], why: r.why } : null))
    .filter((x): x is RankedResult => x !== null);
}

/* ---------- X reply copilot (BYO-key) ---------- */

export interface XPost { i: number; author: string; text: string; meta?: string; }
export interface XScore { i: number; score: number; reason: string; category?: string; product?: number; }

/** Score posts for reply-worthiness given the user's niche. Cheap (Haiku).
 *  When products are supplied, the scorer also tags each PROMOTE post with the
 *  best-fit product index. */
export async function scorePosts(posts: XPost[], niche: string, products: { name: string; blurb?: string }[] = []): Promise<XScore[]> {
  const key = await getKey();
  if (!key) throw new Error("no-key");
  const list = posts.map((p) => `${p.i}. @${p.author}${p.meta ? ` [${p.meta}]` : ""}: ${p.text}`).join("\n");
  const prods = products.length
    ? `\n\nThe user's products (for a post you categorize "promote", also set "product" to the 0-based index of the single best-fit product; omit if none clearly fits):\n${products.map((p, i) => `${i}. ${p.name}${p.blurb ? ` — ${p.blurb}` : ""}`).join("\n")}`
    : "";
  const raw = await callDirect<{ scores: XScore[] }>(
    key,
    "claude-haiku-4-5",
    X_SCORE_SYSTEM,
    `User niche / what's worth replying to:\n${niche || "(not set — only flag posts clearly answerable with specific expertise; be extra strict)"}\n\nPosts:\n${list}${prods}`,
    1024,
  );
  return raw.scores || [];
}

/** Enforce the user's hard rule for replies: no em/en dashes, no hyphenated
 *  compound words. A deterministic safety net on top of the prompt instruction.
 *  Digit hyphens (ranges, negatives) and bullet hyphens are left alone — and
 *  URLs / domains / @handles / emails are SHIELDED so we never break a link
 *  (e.g. my-startup.com stays intact while "long-term" -> "long term"). */
function stripDashes(s: string): string {
  // Mask URLs/emails/domains/handles with NUL-delimited sentinels (NUL never
  // occurs in text, so no collision with bare numbers in the reply).
  const shielded: string[] = [];
  const masked = s.replace(/(https?:\/\/\S+|[\w.+-]+@[\w-]+\.[a-z]{2,}|\b[\w-]+\.[a-z]{2,}\S*|@[\w-]+)/gi,
    (m) => `\u0000${shielded.push(m) - 1}\u0000`);
  const out = masked
    .replace(/\s*[—–]\s*/g, ", ")          // em/en dash -> comma
    .replace(/(\p{L})-+(\p{L})/gu, "$1 $2") // hyphenated compound -> two words
    .replace(/\s+,/g, ",")                  // tidy any " ," produced
    .replace(/\s{2,}/g, " ")                // collapse doubled spaces
    .trim();
  return out.replace(/\u0000(\d+)\u0000/g, (_, i) => shielded[Number(i)]);
}

/** Draft a reply in the user's voice. Quality matters → Sonnet. An optional
 *  `angle` (REPLY_ANGLES id) steers the strategy without overriding the voice. */
export async function draftReply(post: { author: string; text: string; context?: string }, voice: string, angle?: string, product?: string): Promise<string> {
  const key = await getKey();
  if (!key) throw new Error("no-key");
  const ctx = post.context ? `\n\nParent/quoted post (for context):\n${post.context}` : "";
  const prod = product?.trim() ? `\n\nThe user's own product/work (mention ONLY if this post invites it or it genuinely adds value):\n${product.trim()}` : "";
  const def = angle ? REPLY_ANGLES.find((a) => a.id === angle) : undefined;
  const angleLine = def ? `\n\n${def.directive}` : "";
  // Plain text, not JSON — free-form reply prose is fragile to JSON-wrap/parse.
  const reply = await rawCall(
    key,
    "claude-sonnet-4-6",
    X_DRAFT_SYSTEM,
    `User voice:\n${voice || "(not set — write terse and specific; no marketing language, no adjectives-for-the-sake-of-it, no emojis, no hashtags)"}\n\nReply to @${post.author}'s post:\n${post.text}${ctx}${prod}${angleLine}`,
    400,
  );
  return stripDashes(reply.trim().replace(/^["']|["']$/g, ""));
}
