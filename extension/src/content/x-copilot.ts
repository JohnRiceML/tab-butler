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

/** Collected reply-worthy posts, surfaced in the always-on dock. */
interface Opp { id: string; author: string; text: string; score: number; reason: string; context?: string; }
const opps = new Map<string, Opp>();
let dockOpen = false;
let dockFilter = "";

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
  let added = false;
  for (const s of resp.scores ?? []) {
    const b = batch[s.i];
    if (!b) continue;
    const reason = (s.reason || "").split(/\s+/).slice(0, 6).join(" ");
    seen.set(b.id, { score: s.score, reason });
    if (s.score >= THRESHOLD) {
      opps.set(b.id, { id: b.id, author: b.author, text: b.text, score: s.score, reason, context: b.el.isConnected ? quotedText(b.el) : undefined });
      added = true;
      if (statusInfo(b.el)?.id === b.id) badge(b.el, reason);
    }
  }
  if (added) renderDock();
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

let draftGetEl: (() => HTMLElement | null) | null = null;

function findPostEl(id: string): HTMLElement | null {
  for (const a of document.querySelectorAll<HTMLElement>('article[data-testid="tweet"]')) {
    if (statusInfo(a)?.id === id) return a;
  }
  return null;
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

/** Best-effort: open the post's reply box and type the draft into it. Never submits. */
async function insertReply(text: string, postEl: HTMLElement | null): Promise<"ok" | "no-composer" | "blocked"> {
  let editor = document.querySelector<HTMLElement>('[data-testid="tweetTextarea_0"]');
  if (!editor && postEl?.isConnected) {
    postEl.querySelector<HTMLElement>('[data-testid="reply"]')?.click();
    editor = await waitFor('[data-testid="tweetTextarea_0"]', 2500);
  }
  if (!editor) return "no-composer";
  editor.focus();
  try { const s = window.getSelection(); s?.selectAllChildren(editor); s?.collapseToEnd(); } catch { /* ignore */ }
  // execCommand('insertText') fires the input events X's rich-text editor listens for.
  return document.execCommand("insertText", false, text) ? "ok" : "blocked";
}

async function doInsert(text: string) {
  const r = await insertReply(text, draftGetEl?.() ?? null);
  if (r === "ok") { toast("Inserted into the reply box — review, then post it."); dismissPanel(); }
  else if (r === "no-composer") toast("Couldn't find a reply box. Open the post (↗), click Reply, then Insert.");
  else { try { await navigator.clipboard.writeText(text); } catch { /* ignore */ } toast("X blocked the insert — copied it instead; paste it in."); }
}

async function draftFor(author: string, text: string, context?: string, getEl?: () => HTMLElement | null) {
  draftGetEl = getEl ?? null;
  const root = ensurePanel();
  paintPanel(root, author, text, { loading: true });
  const resp = await send<{ reply?: string; error?: string }>({ type: "DRAFT_REPLY", author, text, context });
  if (resp?.error === "no-key") paintPanel(root, author, text, { note: "Add your Anthropic key in the Tab Butler popup to draft replies." });
  else if (!resp || resp.error) paintPanel(root, author, text, { note: "Couldn't draft a reply — try again." });
  else paintPanel(root, author, text, { draft: resp.reply ?? "" });
}

function openDraftFromEl(el: HTMLElement) {
  const info = statusInfo(el);
  void draftFor(info?.author || "this post", outerText(el), quotedText(el), () => el);
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
    const insert = document.createElement("button"); insert.className = "b primary"; insert.textContent = "Insert into reply box";
    insert.style.width = "100%"; insert.style.marginTop = "10px"; insert.style.boxSizing = "border-box";
    insert.onclick = () => void doInsert(ta.value);
    const row = document.createElement("div"); row.className = "row";
    const copy = document.createElement("button"); copy.className = "b"; copy.textContent = "Copy";
    copy.onclick = async () => { try { await navigator.clipboard.writeText(ta.value); copy.textContent = "Copied ✓"; setTimeout(() => (copy.textContent = "Copy"), 1500); } catch { /* ignore */ } };
    const regen = document.createElement("button"); regen.className = "b"; regen.textContent = "Regenerate";
    regen.onclick = () => void draftFor(author, text, undefined, draftGetEl ?? undefined);
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
.l { background:${ACCENT}; color:${INK}; border:0; border-radius:999px; cursor:pointer;
     font:600 12px -apple-system,system-ui,sans-serif; padding:8px 14px; box-shadow:0 8px 28px rgba(0,0,0,.45); }
.d { width:340px; max-width:calc(100vw - 36px); max-height:70vh; display:flex; flex-direction:column;
     background:#1d1812; color:#f3ead9; border:.5px solid rgba(214,154,92,.18); border-radius:14px;
     font:13px/1.4 -apple-system,BlinkMacSystemFont,system-ui,sans-serif; box-shadow:0 12px 40px rgba(0,0,0,.5); }
.dh { display:flex; align-items:center; justify-content:space-between; padding:12px 14px 8px; }
.dt { font-weight:600; } .dt b { color:${ACCENT}; }
.dx { background:none; border:0; color:#8c7d68; font-size:14px; cursor:pointer; }
.df { margin:0 14px 8px; background:#221c15; border:.5px solid rgba(214,154,92,.18); border-radius:9px;
      color:#f3ead9; font:inherit; font-size:12px; padding:7px 10px; outline:none; }
.dl { overflow:auto; padding:0 8px 10px; }
.it { padding:9px 8px; border-top:.5px solid rgba(214,154,92,.10); }
.ia { font-weight:600; font-size:12.5px; } .ia .sc { color:${ACCENT}; margin-left:6px; }
.ix { color:#b6a892; font-size:12px; margin:2px 0 4px; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
.ir { color:#8c7d68; font-size:11px; }
.ib { display:flex; gap:6px; margin-top:6px; }
.bt { font:inherit; font-size:11.5px; font-weight:500; border-radius:8px; padding:4px 10px; cursor:pointer;
      border:.5px solid rgba(214,154,92,.18); background:#221c15; color:#f3ead9; }
.bt.p { background:${ACCENT}; color:${INK}; border-color:transparent; font-weight:600; }
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

function topOpps(): Opp[] {
  const f = dockFilter.toLowerCase();
  return [...opps.values()]
    .filter((o) => !f || o.author.toLowerCase().includes(f) || o.text.toLowerCase().includes(f))
    .sort((a, b) => b.score - a.score)
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
    ia.append(document.createTextNode(`@${o.author}`));
    const sc = document.createElement("span"); sc.className = "sc"; sc.textContent = `${Math.round(o.score * 100)}%`; ia.append(sc);
    const ix = document.createElement("div"); ix.className = "ix"; ix.textContent = o.text;
    const ir = document.createElement("div"); ir.className = "ir"; ir.textContent = o.reason;
    const ib = document.createElement("div"); ib.className = "ib";
    const draft = document.createElement("button"); draft.className = "bt p"; draft.textContent = "Draft reply";
    draft.onclick = () => void draftFor(o.author, o.text, o.context, () => findPostEl(o.id));
    const open = document.createElement("button"); open.className = "bt"; open.textContent = "Open ↗";
    open.onclick = () => window.open(`https://x.com/${o.author}/status/${o.id}`, "_blank", "noopener");
    ib.append(draft, open);
    it.append(ia, ix, ir, ib);
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
    l.textContent = n ? `✦ ${n} reply ${n === 1 ? "spot" : "spots"}` : "✦ Tab Butler";
    l.onclick = () => { dockOpen = true; renderDock(); };
    root.appendChild(l);
    return;
  }
  const d = document.createElement("div"); d.className = "d";
  const h = document.createElement("div"); h.className = "dh";
  const t = document.createElement("div"); t.className = "dt";
  const tb = document.createElement("b"); tb.textContent = String(n);
  t.append(document.createTextNode("Reply opportunities "), tb);
  const x = document.createElement("button"); x.className = "dx"; x.textContent = "✕"; x.onclick = () => { dockOpen = false; renderDock(); };
  h.append(t, x);
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
