import { CONFIG } from "../lib/config";

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

/** status id -> last result. Authoritative dedup + instant re-badge on remount. */
const seen = new Map<string, { score: number; reason: string }>();

interface Queued { id: string; author: string; text: string; el: HTMLElement; }
const queue: Queued[] = [];

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
    const cached = seen.get(info.id);
    if (cached) { if (cached.score >= THRESHOLD) badge(el, cached.reason); return; }
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
  const posts = batch.map((b, i) => ({ i, author: b.author, text: b.text }));
  const resp = await send<{ scores?: { i: number; score: number; reason: string }[]; error?: string }>({
    type: "SCORE_POSTS",
    posts,
  });
  if (resp?.error === "no-key") {
    if (!noKeyNotified) { noKeyNotified = true; toast("Add your Anthropic key in the Tab Butler popup to enable reply suggestions."); }
    enabled = false; // stop hammering until reload
    return;
  }
  if (!resp || resp.error) return; // transient error — back off; the cap bounds retries
  for (const s of resp.scores ?? []) {
    const b = batch[s.i];
    if (!b) continue;
    const reason = (s.reason || "").split(/\s+/).slice(0, 6).join(" ");
    seen.set(b.id, { score: s.score, reason });
    if (s.score >= THRESHOLD && statusInfo(b.el)?.id === b.id) badge(b.el, reason);
  }
  if (queue.length) scheduleFlush();
}

/* ---------- badge (idempotent; survives X re-renders via cache re-apply) ---------- */

function badge(el: HTMLElement, reason: string) {
  if (el.querySelector("[data-tbx-badge]")) return;
  el.style.borderLeft = `3px solid ${ACCENT}`;
  el.style.borderTopLeftRadius = "4px";
  el.style.borderBottomLeftRadius = "4px";
  if (getComputedStyle(el).position === "static") el.style.position = "relative";

  const b = document.createElement("button");
  b.setAttribute("data-tbx-badge", "1");
  b.textContent = "✦ Reply";
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
.t { font-weight: 600; } .x { background: none; border: 0; color: #8c7d68; font-size: 14px; cursor: pointer; }
.ctx { font-size: 12px; color: #b6a892; max-height: 60px; overflow: auto; margin-bottom: 10px;
       border-left: 2px solid rgba(214,154,92,.25); padding-left: 8px; }
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

async function openDraftFromEl(el: HTMLElement) {
  const info = statusInfo(el);
  const author = info?.author || outerText(el).slice(0, 0) || "this post";
  const text = outerText(el);
  const context = quotedText(el);
  const root = ensurePanel();
  paintPanel(root, author, text, { loading: true });
  const resp = await send<{ reply?: string; error?: string }>({ type: "DRAFT_REPLY", author, text, context });
  if (resp?.error === "no-key") paintPanel(root, author, text, { note: "Add your Anthropic key in the Tab Butler popup to draft replies." });
  else if (!resp || resp.error) paintPanel(root, author, text, { note: "Couldn't draft a reply — try again." });
  else paintPanel(root, author, text, { draft: resp.reply ?? "" });
}

function paintPanel(root: ShadowRoot, author: string, text: string, opts: { loading?: boolean; note?: string; draft?: string }) {
  root.replaceChildren();
  const p = document.createElement("div"); p.className = "p";
  const h = document.createElement("div"); h.className = "h";
  const t = document.createElement("div"); t.className = "t"; t.textContent = `Reply to @${author}`;
  const x = document.createElement("button"); x.className = "x"; x.textContent = "✕"; x.onclick = dismissPanel;
  h.append(t, x);
  const ctx = document.createElement("div"); ctx.className = "ctx"; ctx.textContent = text;
  p.append(h, ctx);
  if (opts.loading) {
    const l = document.createElement("div"); l.className = "load"; l.textContent = "Drafting in your voice…"; p.append(l);
  } else if (opts.note) {
    const n = document.createElement("div"); n.className = "load"; n.textContent = opts.note; p.append(n);
  } else {
    const ta = document.createElement("textarea"); ta.className = "ta"; ta.rows = 5; ta.value = opts.draft ?? "";
    const row = document.createElement("div"); row.className = "row";
    const copy = document.createElement("button"); copy.className = "b primary"; copy.textContent = "Copy reply";
    copy.onclick = async () => { try { await navigator.clipboard.writeText(ta.value); copy.textContent = "Copied ✓"; setTimeout(() => (copy.textContent = "Copy reply"), 1500); } catch { /* ignore */ } };
    const regen = document.createElement("button"); regen.className = "b"; regen.textContent = "Regenerate";
    regen.onclick = () => { const root2 = ensurePanel(); paintPanel(root2, author, text, { loading: true }); void send<{ reply?: string; error?: string }>({ type: "DRAFT_REPLY", author, text, context: undefined }).then((r) => paintPanel(root2, author, text, r?.reply ? { draft: r.reply } : { note: "Couldn't draft — try again." })); };
    row.append(copy, regen);
    const foot = document.createElement("div"); foot.className = "foot"; foot.textContent = "Drafted by Claude in your voice — edit, then post it yourself.";
    p.append(ta, row, foot);
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

/* ---------- boot + SPA route handling ---------- */

async function boot() {
  enabled = (await getLocal(CONFIG.X_COPILOT_KEY)) !== false; // default on
  if (!enabled) return;
  new MutationObserver(() => requestScan()).observe(document.body, { childList: true, subtree: true });

  // Content scripts can't intercept the page's history.pushState, so poll the URL.
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    dismissPanel();
    if (seen.size > 600) seen.clear(); // bound memory across long sessions
    selfHandle = "";
    requestScan();
  }, 700);

  scan();
}

const host = location.hostname;
if (window.top === window && /(^|\.)(x|twitter)\.com$/.test(host)) {
  void boot();
}
