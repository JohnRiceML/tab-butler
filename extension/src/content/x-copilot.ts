import { CONFIG } from "../lib/config";
import { REPLY_ANGLES } from "../lib/prompts";
import type { ProductItem } from "../lib/types";

/**
 * Tab Butler — X (Twitter) reply copilot. Runs only on x.com/twitter.com.
 * Scans timeline posts, asks the SW (Claude) to score reply-worthiness, badges
 * the worthwhile ones, and drafts a reply in the user's voice on demand.
 * DRAFT ONLY — never posts. Hardened (per adversarial review) for X's
 * virtualized timeline: dedup by status id, skip ads/own posts, re-badge from
 * cache on remount, rAF-coalesced scanning, a per-session call cap.
 */

const ACCENT = "#d69a5c";
const INK = "#1a1206";
const THRESHOLD = 0.6;
const MAX_SCORE_CALLS = 40; // per page-session cost/ToS guard
const BATCH = 12;

let scoreCalls = 0;
let enabled = true;
let selfHandle = "";
let noKeyNotified = false;

/** The user's products (relevance-tagged promotion) + legacy single-product fallback.
 *  Read from storage on boot and kept fresh via storage.onChanged. */
let xProducts: ProductItem[] = [];
let legacyProduct = "";

/** The product context string sent to the drafter: the (snapshotted) tagged
 *  product for a promote opp, else all current products (the drafter picks if a
 *  post invites it), else the legacy single-product fallback. */
function productContext(product?: ProductItem): string | undefined {
  const fmt = (p: ProductItem) => `${p.name}${p.blurb ? ` — ${p.blurb}` : ""}${p.url ? ` (${p.url})` : ""}`;
  if (product) return fmt(product);
  if (xProducts.length) return xProducts.map(fmt).join("\n");
  return legacyProduct.trim() || undefined;
}

/** status id -> last result. Authoritative dedup + instant re-badge on remount. */
const seen = new Map<string, { score: number; reason: string; category?: string; product?: ProductItem }>();

/** Collected reply-worthy posts, surfaced in the always-on dock. */
interface Opp { id: string; author: string; text: string; score: number; reason: string; context?: string; postedAt?: number; likes?: number; replies?: number; avatar?: string; category?: string; product?: ProductItem; }
const opps = new Map<string, Opp>();
let dockOpen = false;
let dockFilter = "";

interface Queued { id: string; author: string; text: string; el: HTMLElement; }
const queue: Queued[] = [];
/** Posts sent to Claude and awaiting a score — guards against re-queueing the
 *  same post during the request window (e.g. a Rescan mid-flight). */
const inFlight = new Set<string>();

function getLocal(key: string): Promise<unknown> {
  return new Promise((res) => chrome.storage.local.get(key, (o) => res(o[key])));
}
function send<T>(msg: unknown): Promise<T | undefined> {
  return new Promise((res) => {
    try {
      chrome.runtime.sendMessage(msg, (r) => res(chrome.runtime.lastError ? undefined : (r as T)));
    } catch {
      res(undefined);
    }
  });
}

/* ---------- X DOM extraction (resilient to quote-tweets / virtualization) ---------- */

function statusInfo(el: HTMLElement): { id: string; author: string } | null {
  // The article's canonical permalink is the anchor wrapping its <time>.
  const a =
    (el.querySelector('a[href*="/status/"] time')?.closest("a") as HTMLAnchorElement | null) ||
    el.querySelector<HTMLAnchorElement>('a[href*="/status/"]');
  const m = (a?.getAttribute("href") || "").match(/^\/([^/]+)\/status\/(\d+)/);
  return m ? { author: m[1], id: m[2] } : null;
}

/** Outer post text — not the nested quoted tweet (which lives in a role=link). */
function outerText(el: HTMLElement): string {
  const texts = Array.from(el.querySelectorAll('[data-testid="tweetText"]'));
  const outer = texts.find((t) => !t.closest('[role="link"]')) || texts[0];
  return outer?.textContent?.trim() || "";
}
function quotedText(el: HTMLElement): string | undefined {
  const q = Array.from(el.querySelectorAll('[data-testid="tweetText"]')).find((t) => t.closest('[role="link"]'));
  return q?.textContent?.trim() || undefined;
}
function isPromoted(el: HTMLElement): boolean {
  if (el.closest('[data-testid="placementTracking"]')) return true;
  return Array.from(el.querySelectorAll("span")).some((s) => {
    const t = s.textContent?.trim();
    return t === "Promoted" || t === "Ad";
  });
}
function getSelf(): string {
  const a = document.querySelector<HTMLAnchorElement>('[data-testid="AppTabBar_Profile_Link"]');
  return (a?.getAttribute("href") || "").replace(/^\//, "").toLowerCase();
}

/** The OUTER author's avatar URL — skip the quoted tweet's avatar (role=link). */
function avatarUrl(el: HTMLElement): string | undefined {
  const cs = Array.from(el.querySelectorAll<HTMLElement>('[data-testid="Tweet-User-Avatar"], [data-testid^="UserAvatar-Container"]'));
  const c = cs.find((n) => !n.closest('[role="link"]')) || cs[0];
  if (!c) return undefined;
  const src = c.querySelector<HTMLImageElement>("img")?.getAttribute("src");
  if (src?.startsWith("http")) return src;
  for (const n of c.querySelectorAll<HTMLElement>("[style*='background-image']")) {
    const m = n.style.backgroundImage.match(/url\("?(https?:[^")]+)"?\)/);
    if (m) return m[1];
  }
  return undefined;
}

/* ---------- post stats: freshness + engagement ---------- */

/** Exact post time (epoch ms) from the article's <time datetime>. Prefers the
 *  OUTER post's time, not a nested quoted tweet's (role=link) — mirrors
 *  outerText()/quotedText() so quote-tweets report their own age, not the quote's. */
function postedAtMs(el: HTMLElement): number | undefined {
  const times = Array.from(el.querySelectorAll<HTMLElement>('a[href*="/status/"] time'));
  const t = times.find((n) => !n.closest('[role="link"]')) || times[0];
  const dt = t?.getAttribute("datetime");
  const ts = dt ? Date.parse(dt) : NaN;
  return Number.isNaN(ts) ? undefined : ts;
}

/** "1.2K" / "3,400" / "2 345" / "2M" -> integer. Rejects malformed (.1, 1.2.3). */
function parseCount(s: string): number | undefined {
  const m = s.replace(/[,\s]/g, "").match(/(\d+(?:\.\d+)?)\s*([KMB])?/i);
  if (!m) return undefined;
  const base = parseFloat(m[1]);
  if (!Number.isFinite(base)) return undefined;
  const mult = { k: 1e3, m: 1e6, b: 1e9 }[(m[2] || "").toLowerCase()] ?? 1;
  return Math.round(base * mult);
}

interface PostStats { postedAt?: number; likes?: number; replies?: number; reposts?: number; views?: number; }

/** Engagement counts. The action-bar's aria-label carries EXACT totals
 *  ("45 replies, 12 reposts, 678 likes, 9,001 views"); fall back to the
 *  abbreviated per-button text ("1.2K") when the label is absent. */
function engagement(el: HTMLElement): PostStats {
  // Resolve the OUTER post's action bar, not a nested quoted tweet's (role=link);
  // scope the button fallbacks to that same bar so quote-tweets don't bleed.
  const groups = Array.from(el.querySelectorAll<HTMLElement>('[role="group"][aria-label]'));
  const group = groups.find((g) => !g.closest('[role="link"]')) || groups[0] || null;
  const scope = group || el;
  const label = group?.getAttribute("aria-label") || "";
  // Letters in the label act as firewalls, so the count token captured before
  // each keyword is just that metric's number; parseCount strips any leading
  // separators and honors a K/M/B suffix if X ever abbreviates in the label.
  const fromLabel = (re: RegExp): number | undefined => {
    const m = label.match(re);
    return m ? parseCount(m[1]) : undefined;
  };
  const fromButton = (testid: string): number | undefined => {
    const txt = scope.querySelector<HTMLElement>(`[data-testid="${testid}"]`)?.textContent?.trim();
    return txt ? parseCount(txt) : undefined;
  };
  return {
    replies: fromLabel(/([\d.,\s]*\d[KMB]?)\s*(?:repl|comment)/i) ?? fromButton("reply"),
    reposts: fromLabel(/([\d.,\s]*\d[KMB]?)\s*(?:repost|retweet)/i) ?? fromButton("retweet"),
    likes: fromLabel(/([\d.,\s]*\d[KMB]?)\s*likes?\b/i) ?? fromButton("like") ?? fromButton("unlike"),
    views: fromLabel(/([\d.,\s]*\d[KMB]?)\s*views?\b/i),
  };
}

/** Snapshot a post's stats at capture time (counts can't be re-read once X
 *  recycles the node; the timestamp is absolute so age stays accurate). */
function snapStats(el: HTMLElement): PostStats {
  if (!el.isConnected) return {};
  return { postedAt: postedAtMs(el), ...engagement(el) };
}

/** "now" | "5m" | "3h" | "2d" | "4w" | "6mo" from an epoch-ms timestamp. */
function fmtAge(ms?: number): string | undefined {
  if (!ms) return undefined;
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return "now";
  const m = Math.round(s / 60); if (m < 60) return `${m}m`;
  const h = Math.round(m / 60); if (h < 24) return `${h}h`;
  const d = Math.round(h / 24); if (d < 7) return `${d}d`;
  const w = Math.round(d / 7); if (w < 5) return `${w}w`;
  return `${Math.round(d / 30)}mo`;
}

/** 1234 -> "1.2k", 1200000 -> "1.2m". */
function fmtCount(n?: number): string | undefined {
  if (n === undefined) return undefined;
  if (n < 1000) return String(n);
  if (n < 1e6) return `${(n / 1e3).toFixed(n < 1e4 ? 1 : 0)}k`.replace(".0k", "k");
  return `${(n / 1e6).toFixed(1)}m`.replace(".0m", "m");
}

/** Compact, human stats line shared by the dock display and the scorer prompt. */
function metaLine(s: PostStats): string | undefined {
  const parts: string[] = [];
  const age = fmtAge(s.postedAt); if (age) parts.push(`${age} old`);
  if (s.likes !== undefined) parts.push(`${fmtCount(s.likes)} likes`);
  if (s.replies !== undefined) parts.push(`${fmtCount(s.replies)} replies`);
  return parts.length ? parts.join(" · ") : undefined;
}

/* ---------- scan / score ---------- */

let scanPending = false;
function requestScan() {
  if (scanPending || !enabled) return;
  scanPending = true;
  requestAnimationFrame(() => { scanPending = false; scan(); });
}

function scan() {
  if (!enabled || scoreCalls >= MAX_SCORE_CALLS) return;
  if (!selfHandle) selfHandle = getSelf();
  document.querySelectorAll<HTMLElement>('article[data-testid="tweet"]').forEach((el) => {
    const info = statusInfo(el);
    if (!info) return;
    if (inFlight.has(info.id)) return; // sent to Claude, awaiting its score
    const cached = seen.get(info.id);
    if (cached) { if (cached.score >= THRESHOLD) badge(el, cached.reason, cached.category); return; }
    if (el.dataset.tbx === "q") return; // this node already queued
    if (isPromoted(el)) return;
    if (selfHandle && info.author.toLowerCase() === selfHandle) return;
    const text = outerText(el);
    if (!text) return; // media-only / not painted yet — re-evaluated next pass
    el.dataset.tbx = "q";
    queue.push({ id: info.id, author: info.author, text: text.slice(0, 400), el });
  });
  scheduleFlush();
}

let flushTimer: number | undefined;
function scheduleFlush() {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(flush, 900) as unknown as number;
}

async function flush() {
  if (!enabled || scoreCalls >= MAX_SCORE_CALLS) return;
  const batch = queue.splice(0, BATCH).filter((q) => q.el.isConnected && !seen.has(q.id));
  if (!batch.length) return;
  scoreCalls++;
  const snap = batch.map((b) => ({ ...snapStats(b.el), avatar: b.el.isConnected ? avatarUrl(b.el) : undefined }));
  const posts = batch.map((b, i) => ({ i, author: b.author, text: b.text, meta: metaLine(snap[i]) }));
  batch.forEach((b) => inFlight.add(b.id));
  const resp = await send<{ scores?: { i: number; score: number; reason: string; category?: string; product?: number }[]; error?: string }>({
    type: "SCORE_POSTS",
    posts,
  });
  batch.forEach((b) => inFlight.delete(b.id));
  if (resp?.error === "no-key") {
    if (!noKeyNotified) { noKeyNotified = true; toast("Add your Anthropic key in the Tab Butler popup to enable reply suggestions."); }
    enabled = false; // stop hammering until reload
    return;
  }
  if (!resp || resp.error) return; // transient error — back off; the cap bounds retries
  let changed = false;
  for (const s of resp.scores ?? []) {
    const b = batch[s.i];
    if (!b) continue;
    const reason = (s.reason || "").split(/\s+/).slice(0, 6).join(" ");
    const category = catId(s.category);
    // Snapshot the resolved product OBJECT (not the index) so a later product
    // edit can't make a stored index point at the wrong/missing product.
    const product = category === "promote" && typeof s.product === "number" ? xProducts[s.product] : undefined;
    const stat = snap[s.i] ?? {};
    seen.set(b.id, { score: s.score, reason, category, product });
    if (s.score >= THRESHOLD) {
      opps.set(b.id, { id: b.id, author: b.author, text: b.text, score: s.score, reason, category, product, context: b.el.isConnected ? quotedText(b.el) : undefined, postedAt: stat.postedAt, likes: stat.likes, replies: stat.replies, avatar: stat.avatar });
      changed = true;
      if (statusInfo(b.el)?.id === b.id) badge(b.el, reason, category);
    } else {
      // Re-scored below threshold (e.g. after a Rescan): prune the stale spot + badge.
      if (opps.delete(b.id)) changed = true;
      if (b.el.isConnected) b.el.querySelector("[data-tbx-badge]")?.remove();
    }
  }
  if (changed) renderDock();
  if (queue.length) scheduleFlush();
}

/** Manual rescan (dock button). Lifts the per-session cost cap and forgets prior
 *  scores so every post currently on screen is re-evaluated fresh. Keeps the
 *  opportunities already collected from scrolling — this refreshes, never wipes. */
function rescan() {
  if (!enabled) { toast("Add your Anthropic key in the Tab Butler popup to enable scanning."); return; }
  scoreCalls = 0;        // user explicitly asked for more — reset the guard
  seen.clear();          // re-evaluate the visible feed from scratch
  queue.length = 0;      // drop anything half-queued
  for (const el of document.querySelectorAll<HTMLElement>('article[data-testid="tweet"]')) delete el.dataset.tbx;
  toast("Rescanning the page for reply spots…");
  scan();
}

/* ---------- badge (idempotent; survives X re-renders via cache re-apply) ---------- */

/** Validate a model-returned category against the known angle ids. */
function catId(id?: string): string | undefined {
  return id && REPLY_ANGLES.some((a) => a.id === id) ? id : undefined;
}
/** Human label for a category id (the angle's label), or "Reply" fallback. */
function catLabel(id?: string): string {
  return REPLY_ANGLES.find((a) => a.id === id)?.label || "Reply";
}
/** "3 Value · 2 Promote · 1 Ask" — top categories across the collected opps. */
function catSummary(): string {
  const counts = new Map<string, number>();
  for (const o of opps.values()) if (o.category) counts.set(o.category, (counts.get(o.category) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([id, c]) => `${c} ${catLabel(id)}`).join(" · ");
}

function badge(el: HTMLElement, reason: string, category?: string) {
  const existing = el.querySelector<HTMLElement>("[data-tbx-badge]");
  if (existing) {
    // Already badged — refresh the label/tooltip only if the category changed
    // (e.g. a Rescan re-categorized it), so it never gets stuck on a stale value.
    if (existing.dataset.tbxCat !== (category || "")) {
      existing.dataset.tbxCat = category || "";
      existing.textContent = `✦ ${catLabel(category)}`;
      existing.title = reason;
    }
    return;
  }
  el.style.borderLeft = `3px solid ${ACCENT}`;
  el.style.borderTopLeftRadius = "4px";
  el.style.borderBottomLeftRadius = "4px";
  if (getComputedStyle(el).position === "static") el.style.position = "relative";

  const b = document.createElement("button");
  b.setAttribute("data-tbx-badge", "1");
  b.dataset.tbxCat = category || "";
  b.textContent = `✦ ${catLabel(category)}`;
  b.title = reason;
  Object.assign(b.style, {
    position: "absolute", top: "10px", right: "12px", zIndex: "9999",
    background: ACCENT, color: INK, border: "0", borderRadius: "999px",
    font: "600 11px -apple-system, system-ui, sans-serif", padding: "3px 10px", cursor: "pointer",
  } as Partial<CSSStyleDeclaration>);
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    e.preventDefault();
    void openDraftFromEl(el);
  });
  el.appendChild(b);
}

/* ---------- draft panel (closed shadow root, CSP-safe) ---------- */

const PANEL_CSS = `
.p { width: 340px; max-width: calc(100vw - 36px); background: #1d1812; color: #f3ead9;
     border: .5px solid rgba(214,154,92,.18); border-radius: 14px; padding: 14px;
     font: 13px/1.45 -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
     box-shadow: 0 12px 40px rgba(0,0,0,.5); }
.h { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
.th { display: flex; align-items: center; gap: 8px; min-width: 0; }
.pav { width: 22px; height: 22px; border-radius: 50%; object-fit: cover; flex: 0 0 auto; }
.t { font-weight: 600; } .x { background: none; border: 0; color: #8c7d68; font-size: 14px; cursor: pointer; }
.ctx { font-size: 12px; color: #b6a892; max-height: 60px; overflow: auto; margin-bottom: 10px;
       border-left: 2px solid rgba(214,154,92,.25); padding-left: 8px; }
.angles { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
.ang { font: inherit; font-size: 11px; font-weight: 500; border-radius: 999px; padding: 4px 10px; cursor: pointer;
       border: .5px solid rgba(214,154,92,.28); background: #221c15; color: #cbb89c; }
.ang:hover { background: rgba(214,154,92,.10); }
.ang.on { background: ${ACCENT}; color: ${INK}; border-color: transparent; font-weight: 600; }
.load { color: #b6a892; font-size: 12.5px; padding: 6px 0; }
.ta { width: 100%; box-sizing: border-box; background: #221c15; color: #f3ead9;
      border: .5px solid rgba(214,154,92,.18); border-radius: 9px; padding: 9px; font: inherit; resize: vertical; }
.row { display: flex; gap: 8px; margin-top: 10px; }
.b { flex: 1; font: inherit; font-weight: 500; border-radius: 9px; padding: 8px;
     border: .5px solid rgba(214,154,92,.18); background: #221c15; color: #f3ead9; cursor: pointer; }
.b.primary { background: ${ACCENT}; color: ${INK}; border-color: transparent; font-weight: 600; }
.foot { margin-top: 9px; font-size: 10.5px; color: #8c7d68; }
`;

let panelHost: HTMLElement | null = null;
let panelRoot: ShadowRoot | null = null;
function ensurePanel(): ShadowRoot {
  if (panelHost?.isConnected && panelRoot) return panelRoot;
  panelHost = document.createElement("div");
  Object.assign(panelHost.style, { position: "fixed", bottom: "18px", right: "18px", zIndex: "2147483647" } as Partial<CSSStyleDeclaration>);
  panelRoot = panelHost.attachShadow({ mode: "closed" });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(PANEL_CSS);
  panelRoot.adoptedStyleSheets = [sheet];
  document.documentElement.appendChild(panelHost);
  return panelRoot;
}
function dismissPanel() { panelHost?.remove(); panelHost = null; panelRoot = null; }

let draftGetEl: (() => HTMLElement | null) | null = null;
let draftOppId: string | null = null;

/** The current draft request, so the angle chips and Regenerate can re-draft
 *  with the SAME post/context/oppId (and switch only the angle). */
interface DraftReq { author: string; text: string; context?: string; getEl?: () => HTMLElement | null; oppId?: string; angle?: string; avatar?: string; product?: string; }
let lastDraft: DraftReq | null = null;

/** Posts already liked this session, so re-drafts / angle switches don't re-toggle. */
const liked = new Set<string>();

/** Heart the OUTER post (skip the quoted tweet's bar). X's button is testid
 *  "like" only while UNliked — once liked it becomes "unlike", so a click here
 *  can only ever like, never un-like. No-op if the post is already liked. */
function likePost(el: HTMLElement | null): void {
  if (!el?.isConnected) return;
  const btns = Array.from(el.querySelectorAll<HTMLElement>('[data-testid="like"]'));
  (btns.find((b) => !b.closest('[role="link"]')) || btns[0])?.click();
}

/** Authors we've followed (or confirmed already-followed) this session. */
const followed = new Set<string>();

function closeMenu(): void {
  document.querySelector<HTMLElement>('[data-testid="mask"]')?.click();
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
}

/** Follow the OUTER post's author via its "•••" menu (the only reliable in-DOM
 *  path on a timeline post). The menu shows "Follow @x" ONLY when not already
 *  following — so this can only follow, never unfollow. Best-effort. */
async function followAuthor(el: HTMLElement | null): Promise<"followed" | "already" | "failed"> {
  if (!el?.isConnected) return "failed";
  const caret = Array.from(el.querySelectorAll<HTMLElement>('[data-testid="caret"]')).find((c) => !c.closest('[role="link"]'));
  if (!caret) return "failed";
  caret.click();
  const menu = await waitFor('[role="menu"]', 1500);
  if (!menu) return "failed";
  const items = Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]'));
  const follow = items.find((it) => /^follow\b/i.test(it.textContent?.trim() || ""));
  if (follow) { follow.click(); return "followed"; }
  const already = items.some((it) => /^unfollow\b/i.test(it.textContent?.trim() || ""));
  closeMenu();
  return already ? "already" : "failed";
}

/** Locate a post by status id, falling back to matching its text (for the dock,
 *  where the original element may have been recycled by virtualization). */
function findPost(id: string, text?: string): HTMLElement | null {
  let byText: HTMLElement | null = null;
  const needle = text?.slice(0, 60);
  for (const a of document.querySelectorAll<HTMLElement>('article[data-testid="tweet"]')) {
    if (statusInfo(a)?.id === id) return a; // id match wins
    if (needle && !byText && outerText(a).startsWith(needle)) byText = a;
  }
  return byText;
}

function waitFor(sel: string, ms: number): Promise<HTMLElement | null> {
  return new Promise((res) => {
    const now = document.querySelector<HTMLElement>(sel);
    if (now) return res(now);
    const obs = new MutationObserver(() => {
      const f = document.querySelector<HTMLElement>(sel);
      if (f) { clearTimeout(t); obs.disconnect(); res(f); }
    });
    const t = setTimeout(() => { obs.disconnect(); res(document.querySelector<HTMLElement>(sel)); }, ms);
    obs.observe(document.body, { childList: true, subtree: true });
  });
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The actual contenteditable inside X's composer (the testid node may wrap it). */
function editableOf(node: HTMLElement): HTMLElement {
  if (node.getAttribute("contenteditable") === "true") return node;
  return node.querySelector<HTMLElement>('[contenteditable="true"]') || node;
}
function placeCaretEnd(ce: HTMLElement) {
  try {
    const r = document.createRange();
    r.selectNodeContents(ce);
    r.collapse(false);
    const s = window.getSelection();
    s?.removeAllRanges();
    s?.addRange(r);
  } catch { /* ignore */ }
}

/** Put text into X's DraftJS editor. Tries execCommand, then a simulated paste,
 *  then beforeinput — verifying after each, since DraftJS silently drops inputs
 *  that don't align with its internal selection. */
async function typeInto(node: HTMLElement, text: string): Promise<boolean> {
  const ce = editableOf(node);
  const filled = () => (ce.textContent || "").replace(/​/g, "").trim().length > 0;

  // Poll for success so a slow-but-successful method is detected BEFORE the next
  // one runs — otherwise two methods both land and the text doubles in the box.
  const settled = async (): Promise<boolean> => {
    for (let i = 0; i < 12; i++) { if (filled()) return true; await sleep(40); }
    return filled();
  };
  const clear = () => {
    try {
      ce.focus();
      const r = document.createRange(); r.selectNodeContents(ce);
      const sel = window.getSelection(); sel?.removeAllRanges(); sel?.addRange(r);
      document.execCommand("delete", false);
    } catch { /* ignore */ }
  };
  const exec = () => { placeCaretEnd(ce); document.execCommand("insertText", false, text); };
  const paste = () => {
    try {
      const dt = new DataTransfer(); dt.setData("text/plain", text);
      ce.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    } catch { /* ignore */ }
  };
  const beforeInput = () => {
    try {
      ce.dispatchEvent(new InputEvent("beforeinput", { inputType: "insertText", data: text, bubbles: true, cancelable: true }));
      ce.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: text, bubbles: true }));
    } catch { /* ignore */ }
  };

  await sleep(80);
  for (const method of [exec, paste, beforeInput]) {
    ce.focus();
    if (filled()) clear();      // never stack onto a prior (slow) insert
    await sleep(20);
    placeCaretEnd(ce);
    method();
    if (await settled()) return true;
  }
  return filled();
}

/** Best-effort: open the post's reply box and type the draft into it. Never submits. */
async function insertReply(text: string, postEl: HTMLElement | null): Promise<"ok" | "no-composer" | "blocked"> {
  // Target the REPLY DIALOG's composer — never the page's main "what's happening"
  // box (which is also a tweetTextarea and would post to everyone).
  let editor = document.querySelector<HTMLElement>('[role="dialog"] [data-testid^="tweetTextarea_"]');
  if (!editor) {
    if (!postEl?.isConnected) return "no-composer";
    postEl.scrollIntoView({ block: "center" });
    const btn = postEl.querySelector<HTMLElement>('[data-testid="reply"]');
    if (!btn) return "no-composer";
    btn.click();
    // The reply composer opens inside a modal dialog (feed). Fall back to an
    // inline composer only on a post page, where there is no "everyone" box.
    editor =
      (await waitFor('[role="dialog"] [data-testid^="tweetTextarea_"]', 2500)) ||
      (location.pathname.includes("/status/") ? await waitFor('[data-testid^="tweetTextarea_"]', 600) : null);
  }
  if (!editor) return "no-composer";
  return (await typeInto(editor, text)) ? "ok" : "blocked";
}

let inserting = false;
async function doInsert(text: string) {
  if (inserting) return; // ignore re-clicks while an insert is in flight (avoids doubling)
  inserting = true;
  try {
    const r = await insertReply(text, draftGetEl?.() ?? null);
    if (r === "ok") { if (draftOppId) { opps.delete(draftOppId); renderDock(); } toast("Inserted into the reply box — review, then post it."); dismissPanel(); }
    else if (r === "no-composer") toast("Couldn't find a reply box. Open the post (↗), click Reply, then Insert.");
    else { try { await navigator.clipboard.writeText(text); } catch { /* ignore */ } toast("X blocked the insert — copied it instead; paste it in."); }
  } finally {
    inserting = false;
  }
}

async function draftFor(author: string, text: string, context?: string, getEl?: () => HTMLElement | null, oppId?: string, angle?: string, avatar?: string, product?: string) {
  draftGetEl = getEl ?? null;
  draftOppId = oppId ?? null;
  lastDraft = { author, text, context, getEl, oppId, angle, avatar, product };
  // Like the post you're engaging with — once per post, on the first draft.
  if (oppId && !liked.has(oppId)) { liked.add(oppId); likePost(getEl?.() ?? null); }
  const root = ensurePanel();
  paintPanel(root, author, text, { loading: true, angle, avatar });
  const resp = await send<{ reply?: string; error?: string }>({ type: "DRAFT_REPLY", author, text, context, angle, product });
  if (resp?.error === "no-key") paintPanel(root, author, text, { note: "Add your Anthropic key in the Tab Butler popup to draft replies.", angle, avatar });
  else if (!resp || resp.error) paintPanel(root, author, text, { note: resp?.error ? `Couldn't draft: ${resp.error}` : "Couldn't draft — the background didn't respond. Try again.", angle, avatar });
  else paintPanel(root, author, text, { draft: resp.reply ?? "", angle, avatar });
}

/** The angle chips. Clicking re-drafts with that steer; clicking the active one
 *  toggles it back off (neutral). Reuses lastDraft so post/context are kept. */
function angleRow(active?: string): HTMLElement {
  const row = document.createElement("div"); row.className = "angles";
  for (const a of REPLY_ANGLES) {
    const c = document.createElement("button");
    c.className = "ang" + (active === a.id ? " on" : "");
    c.textContent = a.label;
    c.title = a.directive;
    c.onclick = () => {
      const d = lastDraft;
      if (!d) return;
      void draftFor(d.author, d.text, d.context, d.getEl, d.oppId, active === a.id ? undefined : a.id, d.avatar, d.product);
    };
    row.appendChild(c);
  }
  return row;
}

function openDraftFromEl(el: HTMLElement) {
  const info = statusInfo(el);
  const meta = info ? (opps.get(info.id) ?? seen.get(info.id)) : undefined;
  void draftFor(info?.author || "this post", outerText(el), quotedText(el), () => el, info?.id, meta?.category, avatarUrl(el), productContext(meta?.product));
}

function paintPanel(root: ShadowRoot, author: string, text: string, opts: { loading?: boolean; note?: string; draft?: string; angle?: string; avatar?: string }) {
  root.replaceChildren();
  const p = document.createElement("div"); p.className = "p";
  const h = document.createElement("div"); h.className = "h";
  const th = document.createElement("div"); th.className = "th";
  if (opts.avatar) { const av = document.createElement("img"); av.className = "pav"; av.src = opts.avatar; av.alt = ""; av.referrerPolicy = "no-referrer"; av.onerror = () => av.remove(); th.append(av); }
  const t = document.createElement("div"); t.className = "t"; t.textContent = `Reply to @${author}`;
  th.append(t);
  const x = document.createElement("button"); x.className = "x"; x.textContent = "✕"; x.onclick = dismissPanel;
  h.append(th, x);
  const ctx = document.createElement("div"); ctx.className = "ctx"; ctx.textContent = text;
  p.append(h, ctx, angleRow(opts.angle));
  if (opts.loading) {
    const l = document.createElement("div"); l.className = "load"; l.textContent = "Drafting in your voice…"; p.append(l);
  } else if (opts.note) {
    const n = document.createElement("div"); n.className = "load"; n.textContent = opts.note; p.append(n);
  } else {
    const ta = document.createElement("textarea"); ta.className = "ta"; ta.rows = 5; ta.value = opts.draft ?? "";
    const insert = document.createElement("button"); insert.className = "b primary"; insert.textContent = "Insert into reply box";
    insert.style.width = "100%"; insert.style.marginTop = "10px"; insert.style.boxSizing = "border-box";
    insert.onclick = () => void doInsert(ta.value);
    const row = document.createElement("div"); row.className = "row";
    const copy = document.createElement("button"); copy.className = "b"; copy.textContent = "Copy";
    copy.onclick = async () => { try { await navigator.clipboard.writeText(ta.value); copy.textContent = "Copied ✓"; setTimeout(() => (copy.textContent = "Copy"), 1500); } catch { /* ignore */ } };
    const regen = document.createElement("button"); regen.className = "b"; regen.textContent = "Regenerate";
    regen.onclick = () => { const d = lastDraft; if (d) void draftFor(d.author, d.text, d.context, d.getEl, d.oppId, d.angle, d.avatar, d.product); };
    row.append(copy, regen);
    const foot = document.createElement("div"); foot.className = "foot"; foot.textContent = "Inserts into X's reply box — you review and post. Never auto-posts.";
    p.append(ta, insert, row, foot);
  }
  root.appendChild(p);
}

function toast(msg: string) {
  const host = document.createElement("div");
  Object.assign(host.style, { position: "fixed", bottom: "18px", left: "18px", zIndex: "2147483647" } as Partial<CSSStyleDeclaration>);
  const root = host.attachShadow({ mode: "closed" });
  const d = document.createElement("div");
  Object.assign(d.style, { background: "#1d1812", color: "#f3ead9", border: "0.5px solid rgba(214,154,92,.18)", borderRadius: "10px", padding: "10px 14px", font: "12.5px -apple-system, system-ui, sans-serif", maxWidth: "320px", boxShadow: "0 12px 40px rgba(0,0,0,.5)" } as Partial<CSSStyleDeclaration>);
  d.textContent = msg;
  root.appendChild(d);
  document.documentElement.appendChild(host);
  setTimeout(() => host.remove(), 6000);
}

/* ---------- opportunities dock (always-on, ranked top posts) ---------- */

const DOCK_CSS = `
.l { display:flex; align-items:center; gap:10px; background:${ACCENT}; color:${INK}; border:0; border-radius:14px;
     cursor:pointer; text-align:left; font:600 12px -apple-system,system-ui,sans-serif; padding:8px 14px;
     box-shadow:0 8px 28px rgba(0,0,0,.45); }
.lav { display:inline-flex; flex:0 0 auto; }
.lavi { width:22px; height:22px; border-radius:50%; object-fit:cover; border:2px solid ${ACCENT}; margin-left:-9px; background:#1d1812; }
.lav .lavi:first-child { margin-left:0; }
.ltext { display:flex; flex-direction:column; line-height:1.25; min-width:0; }
.ll1 { font-weight:700; }
.ll2 { font-size:10px; font-weight:600; letter-spacing:.3px; text-transform:uppercase; opacity:.78; margin-top:1px; }
.d { width:340px; max-width:calc(100vw - 36px); max-height:70vh; display:flex; flex-direction:column;
     background:#1d1812; color:#f3ead9; border:.5px solid rgba(214,154,92,.18); border-radius:14px;
     font:13px/1.4 -apple-system,BlinkMacSystemFont,system-ui,sans-serif; box-shadow:0 12px 40px rgba(0,0,0,.5); }
.dh { display:flex; align-items:center; justify-content:space-between; padding:12px 14px 8px; }
.dt { font-weight:600; } .dt b { color:${ACCENT}; }
.da { display:flex; align-items:center; gap:8px; }
.re { background:none; border:.5px solid rgba(214,154,92,.28); color:${ACCENT}; border-radius:999px;
      font:600 11px -apple-system,system-ui,sans-serif; padding:3px 9px; cursor:pointer; line-height:1.4; }
.re:hover { background:rgba(214,154,92,.10); }
.dx { background:none; border:0; color:#8c7d68; font-size:14px; cursor:pointer; }
.df { margin:0 14px 8px; background:#221c15; border:.5px solid rgba(214,154,92,.18); border-radius:9px;
      color:#f3ead9; font:inherit; font-size:12px; padding:7px 10px; outline:none; }
.dl { overflow:auto; padding:0 8px 10px; }
.it { padding:9px 8px; border-top:.5px solid rgba(214,154,92,.10); }
.ia { font-weight:600; font-size:12.5px; display:flex; align-items:center; } .ia .sc { color:${ACCENT}; margin-left:auto; }
.av { width:18px; height:18px; border-radius:50%; object-fit:cover; margin-right:7px; flex:0 0 auto; }
.ix { color:#b6a892; font-size:12px; margin:2px 0 4px; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
.im { color:#9b8d76; font-size:11px; margin:0 0 4px; letter-spacing:.1px; }
.ir { color:#8c7d68; font-size:11px; }
.cat { margin-left:7px; font-size:10px; font-weight:600; letter-spacing:.2px; text-transform:uppercase;
       padding:1px 7px; border-radius:999px; background:rgba(214,154,92,.16); color:${ACCENT}; }
.ib { display:flex; flex-wrap:wrap; gap:6px; margin-top:6px; }
.bt { font:inherit; font-size:11.5px; font-weight:500; border-radius:8px; padding:4px 10px; cursor:pointer;
      border:.5px solid rgba(214,154,92,.18); background:#221c15; color:#f3ead9; }
.bt.p { background:${ACCENT}; color:${INK}; border-color:transparent; font-weight:600; }
.bt:disabled { opacity:.55; cursor:default; }
.empty { color:#8c7d68; font-size:12px; padding:14px; text-align:center; }
`;

let dockHost: HTMLElement | null = null;
let dockRoot: ShadowRoot | null = null;
function ensureDock(): ShadowRoot {
  if (dockHost?.isConnected && dockRoot) return dockRoot;
  dockHost = document.createElement("div");
  Object.assign(dockHost.style, { position: "fixed", bottom: "18px", left: "18px", zIndex: "2147483646" } as Partial<CSSStyleDeclaration>);
  dockRoot = dockHost.attachShadow({ mode: "closed" });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(DOCK_CSS);
  dockRoot.adoptedStyleSheets = [sheet];
  document.documentElement.appendChild(dockHost);
  return dockRoot;
}

/** Blend the model's reply-worthiness with LIVE recency + engagement so fresh,
 *  well-engaged-but-not-buried posts rank and read higher. Recomputed on the fly
 *  (postedAt is absolute) so the score decays as a spot ages. ~±0.12 swing. */
function effectiveScore(o: Opp): number {
  let s = o.score;
  if (o.postedAt) {
    const h = (Date.now() - o.postedAt) / 3_600_000;
    s += h < 1 ? 0.06 : h < 3 ? 0.03 : h < 12 ? 0 : h < 24 ? -0.03 : h < 72 ? -0.07 : -0.12;
  }
  if (o.likes) s += Math.min(0.04, Math.log10(o.likes + 1) / 100); // audience size, capped
  if (o.replies && o.replies > 100) s -= o.replies > 300 ? 0.06 : 0.03; // saturated → a reply gets buried
  return Math.max(0, Math.min(1, s));
}

function topOpps(): Opp[] {
  const f = dockFilter.toLowerCase();
  return [...opps.values()]
    .filter((o) => !f || o.author.toLowerCase().includes(f) || o.text.toLowerCase().includes(f))
    .sort((a, b) => effectiveScore(b) - effectiveScore(a))
    .slice(0, 25);
}

function renderList(list: HTMLElement) {
  list.replaceChildren();
  const items = topOpps();
  if (!items.length) {
    const e = document.createElement("div");
    e.className = "empty";
    e.textContent = opps.size ? "No matches." : "Scroll your feed — reply-worthy posts collect here.";
    list.appendChild(e);
    return;
  }
  for (const o of items) {
    const it = document.createElement("div"); it.className = "it";
    const ia = document.createElement("div"); ia.className = "ia";
    if (o.avatar) { const av = document.createElement("img"); av.className = "av"; av.src = o.avatar; av.alt = ""; av.loading = "lazy"; av.referrerPolicy = "no-referrer"; av.onerror = () => av.remove(); ia.append(av); }
    ia.append(document.createTextNode(`@${o.author}`));
    if (o.category) {
      const cc = document.createElement("span"); cc.className = "cat";
      const pname = o.product?.name;
      cc.textContent = pname ? `${catLabel(o.category)} · ${pname}` : catLabel(o.category);
      ia.append(cc);
    }
    const sc = document.createElement("span"); sc.className = "sc"; sc.textContent = `${Math.round(effectiveScore(o) * 100)}%`; ia.append(sc);
    const ix = document.createElement("div"); ix.className = "ix"; ix.textContent = o.text;
    const meta = metaLine({ postedAt: o.postedAt, likes: o.likes, replies: o.replies });
    const ir = document.createElement("div"); ir.className = "ir"; ir.textContent = o.reason;
    const ib = document.createElement("div"); ib.className = "ib";
    const draft = document.createElement("button"); draft.className = "bt p"; draft.textContent = "Draft reply";
    draft.onclick = () => void draftFor(o.author, o.text, o.context, () => findPost(o.id, o.text), o.id, o.category, o.avatar, productContext(o.product));
    const follow = document.createElement("button"); follow.className = "bt";
    const isFollowed = followed.has(o.author);
    follow.textContent = isFollowed ? "Following ✓" : "Follow";
    follow.disabled = isFollowed;
    follow.onclick = async () => {
      follow.disabled = true; follow.textContent = "Following…";
      const r = await followAuthor(findPost(o.id, o.text));
      if (r === "followed") { followed.add(o.author); follow.textContent = "Following ✓"; toast(`Followed @${o.author}.`); }
      else if (r === "already") { followed.add(o.author); follow.textContent = "Following ✓"; toast(`Already following @${o.author}.`); }
      else { follow.disabled = false; follow.textContent = "Follow"; toast("Couldn't follow — open the post (↗), then use its ••• menu."); }
    };
    const open = document.createElement("button"); open.className = "bt"; open.textContent = "Open ↗";
    open.onclick = () => window.open(`https://x.com/${o.author}/status/${o.id}`, "_blank", "noopener");
    const dismiss = document.createElement("button"); dismiss.className = "bt"; dismiss.textContent = "✕"; dismiss.title = "Dismiss — remove from reply spots";
    dismiss.onclick = () => { opps.delete(o.id); renderDock(); };
    ib.append(draft, follow, open, dismiss);
    it.append(ia, ix);
    if (meta) { const im = document.createElement("div"); im.className = "im"; im.textContent = meta; it.append(im); }
    it.append(ir, ib);
    list.appendChild(it);
  }
}

function renderDock() {
  if (!enabled) return;
  const root = ensureDock();
  root.replaceChildren();
  const n = opps.size;
  if (!dockOpen) {
    const l = document.createElement("button");
    l.className = "l";
    l.onclick = () => { dockOpen = true; renderDock(); };
    if (!n) { l.textContent = "✦ Tab Butler"; root.appendChild(l); return; }
    // Overlapped avatars from the top few spots (pbs.twimg.com loads under x.com CSP).
    const faces = topOpps().filter((o) => o.avatar).slice(0, 3);
    if (faces.length) {
      const av = document.createElement("span"); av.className = "lav";
      for (const o of faces) { const im = document.createElement("img"); im.className = "lavi"; im.src = o.avatar!; im.alt = ""; im.referrerPolicy = "no-referrer"; im.onerror = () => im.remove(); av.append(im); }
      l.append(av);
    }
    const txt = document.createElement("span"); txt.className = "ltext";
    const l1 = document.createElement("span"); l1.className = "ll1"; l1.textContent = `✦ ${n} reply ${n === 1 ? "spot" : "spots"}`;
    txt.append(l1);
    const summary = catSummary();
    if (summary) { const l2 = document.createElement("span"); l2.className = "ll2"; l2.textContent = summary; txt.append(l2); }
    l.append(txt);
    root.appendChild(l);
    return;
  }
  const d = document.createElement("div"); d.className = "d";
  const h = document.createElement("div"); h.className = "dh";
  const t = document.createElement("div"); t.className = "dt";
  const tb = document.createElement("b"); tb.textContent = String(n);
  t.append(document.createTextNode("Reply opportunities "), tb);
  const acts = document.createElement("div"); acts.className = "da";
  const re = document.createElement("button"); re.className = "re"; re.textContent = "⟳ Rescan";
  re.title = "Rescan the page — re-check every visible post for new reply spots";
  re.onclick = () => rescan();
  acts.append(re);
  if (n) {
    const clr = document.createElement("button"); clr.className = "re"; clr.textContent = "Clear all";
    clr.title = "Clear every collected reply spot";
    clr.onclick = () => { opps.clear(); renderDock(); toast("Cleared all reply spots."); };
    acts.append(clr);
  }
  const x = document.createElement("button"); x.className = "dx"; x.textContent = "✕"; x.onclick = () => { dockOpen = false; renderDock(); };
  acts.append(x);
  h.append(t, acts);
  const f = document.createElement("input"); f.className = "df"; f.placeholder = "Filter opportunities…"; f.value = dockFilter;
  const list = document.createElement("div"); list.className = "dl";
  f.oninput = () => { dockFilter = f.value; renderList(list); };
  d.append(h, f, list);
  root.appendChild(d);
  renderList(list);
}

/* ---------- boot + SPA route handling ---------- */

async function boot() {
  enabled = (await getLocal(CONFIG.X_COPILOT_KEY)) !== false; // default on
  if (!enabled) return;
  const storedProducts = await getLocal(CONFIG.X_PRODUCTS_KEY);
  xProducts = Array.isArray(storedProducts) ? (storedProducts as ProductItem[]) : [];
  legacyProduct = ((await getLocal(CONFIG.X_PRODUCT_KEY)) as string) || "";
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[CONFIG.X_PRODUCTS_KEY]) xProducts = (changes[CONFIG.X_PRODUCTS_KEY].newValue as ProductItem[]) || [];
    if (changes[CONFIG.X_PRODUCT_KEY]) legacyProduct = (changes[CONFIG.X_PRODUCT_KEY].newValue as string) || "";
  });
  renderDock();
  new MutationObserver(() => requestScan()).observe(document.body, { childList: true, subtree: true });

  // Content scripts can't intercept the page's history.pushState, so poll the URL.
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    dismissPanel();
    if (seen.size > 600) { seen.clear(); opps.clear(); } // bound memory across long sessions
    selfHandle = "";
    requestScan();
    renderDock();
  }, 700);

  scan();
}

const host = location.hostname;
if (window.top === window && /(^|\.)(x|twitter)\.com$/.test(host)) {
  void boot();
}
