import { CONFIG } from "../lib/config";

/**
 * Tab Butler — X (Twitter) reply copilot. Runs only on x.com/twitter.com.
 * Scans timeline posts, asks the SW (Claude) to score reply-worthiness, badges
 * the worthwhile ones, and drafts a reply in the user's voice on demand.
 * DRAFT ONLY — never posts. Reading the DOM is what powers the highlighting;
 * Claude calls happen in the service worker (this script just messages it).
 */

const ACCENT = "#d69a5c";
const INK = "#1a1206";
const THRESHOLD = 0.6;

function getLocal(key: string): Promise<unknown> {
  return new Promise((res) => chrome.storage.local.get(key, (o) => res(o[key])));
}
function send<T>(msg: unknown): Promise<T> {
  return new Promise((res) => chrome.runtime.sendMessage(msg, (r) => res(r as T)));
}

interface Queued { author: string; text: string; el: HTMLElement; }
const queue: Queued[] = [];
let timer: number | undefined;

function scan() {
  document.querySelectorAll<HTMLElement>('article[data-testid="tweet"]').forEach((el) => {
    if (el.dataset.tbx) return;
    const text = el.querySelector('[data-testid="tweetText"]')?.textContent?.trim();
    const href = el.querySelector('a[href*="/status/"]')?.getAttribute("href") || "";
    const m = href.match(/^\/([^/]+)\/status\/(\d+)/);
    if (!text || !m) return;
    el.dataset.tbx = "q";
    queue.push({ author: m[1], text: text.slice(0, 400), el });
  });
  schedule();
}

function schedule() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(flush, 900) as unknown as number;
}

async function flush() {
  const batch = queue.splice(0, 12).filter((q) => q.el.isConnected);
  if (!batch.length) return;
  const posts = batch.map((b, i) => ({ i, author: b.author, text: b.text }));
  const resp = await send<{ scores?: { i: number; score: number; reason: string }[]; error?: string }>({
    type: "SCORE_POSTS",
    posts,
  });
  if (resp?.error) { batch.forEach((b) => (b.el.dataset.tbx = "done")); return; }
  for (const s of resp?.scores ?? []) {
    const b = batch[s.i];
    if (!b) continue;
    b.el.dataset.tbx = "done";
    if (s.score >= THRESHOLD) highlight(b.el, b.author, b.text, s.reason);
  }
  if (queue.length) schedule();
}

function highlight(el: HTMLElement, author: string, text: string, reason: string) {
  el.style.borderLeft = `3px solid ${ACCENT}`;
  el.style.borderTopLeftRadius = "4px";
  el.style.borderBottomLeftRadius = "4px";
  if (getComputedStyle(el).position === "static") el.style.position = "relative";

  const badge = document.createElement("button");
  badge.textContent = "✦ Reply";
  badge.title = reason;
  badge.style.position = "absolute";
  badge.style.top = "10px";
  badge.style.right = "12px";
  badge.style.zIndex = "9999";
  badge.style.background = ACCENT;
  badge.style.color = INK;
  badge.style.border = "0";
  badge.style.borderRadius = "999px";
  badge.style.font = '600 11px -apple-system, system-ui, sans-serif';
  badge.style.padding = "3px 10px";
  badge.style.cursor = "pointer";
  badge.addEventListener("click", (e) => {
    e.stopPropagation();
    e.preventDefault();
    void openDraft(author, text);
  });
  el.appendChild(badge);
}

/* ---------- draft panel (closed shadow root, CSP-safe styles) ---------- */

const PANEL_CSS = `
.p { width: 340px; max-width: calc(100vw - 36px); background: #1d1812; color: #f3ead9;
     border: .5px solid rgba(214,154,92,.18); border-radius: 14px; padding: 14px;
     font: 13px/1.45 -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
     box-shadow: 0 12px 40px rgba(0,0,0,.5); }
.h { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
.t { font-weight: 600; }
.x { background: none; border: 0; color: #8c7d68; font-size: 14px; cursor: pointer; }
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
  panelHost.style.position = "fixed";
  panelHost.style.bottom = "18px";
  panelHost.style.right = "18px";
  panelHost.style.zIndex = "2147483647";
  panelRoot = panelHost.attachShadow({ mode: "closed" });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(PANEL_CSS);
  panelRoot.adoptedStyleSheets = [sheet];
  document.documentElement.appendChild(panelHost);
  return panelRoot;
}

async function openDraft(author: string, text: string) {
  const root = ensurePanel();
  paintPanel(root, author, text, { loading: true });
  const resp = await send<{ reply?: string; error?: string }>({ type: "DRAFT_REPLY", author, text });
  if (resp?.error === "no-key") {
    paintPanel(root, author, text, { note: "Add your Anthropic key in the Tab Butler popup to draft replies." });
  } else if (resp?.error) {
    paintPanel(root, author, text, { note: "Couldn't draft a reply — try again." });
  } else {
    paintPanel(root, author, text, { draft: resp?.reply ?? "" });
  }
}

function paintPanel(
  root: ShadowRoot,
  author: string,
  text: string,
  opts: { loading?: boolean; note?: string; draft?: string },
) {
  root.replaceChildren();
  const p = document.createElement("div");
  p.className = "p";

  const h = document.createElement("div");
  h.className = "h";
  const t = document.createElement("div");
  t.className = "t";
  t.textContent = `Reply to @${author}`;
  const x = document.createElement("button");
  x.className = "x";
  x.textContent = "✕";
  x.onclick = () => panelHost?.remove();
  h.append(t, x);

  const ctx = document.createElement("div");
  ctx.className = "ctx";
  ctx.textContent = text;
  p.append(h, ctx);

  if (opts.loading) {
    const l = document.createElement("div");
    l.className = "load";
    l.textContent = "Drafting in your voice…";
    p.append(l);
  } else if (opts.note) {
    const n = document.createElement("div");
    n.className = "load";
    n.textContent = opts.note;
    p.append(n);
  } else {
    const ta = document.createElement("textarea");
    ta.className = "ta";
    ta.rows = 5;
    ta.value = opts.draft ?? "";
    const row = document.createElement("div");
    row.className = "row";
    const copy = document.createElement("button");
    copy.className = "b primary";
    copy.textContent = "Copy reply";
    copy.onclick = async () => {
      try { await navigator.clipboard.writeText(ta.value); copy.textContent = "Copied ✓"; setTimeout(() => (copy.textContent = "Copy reply"), 1500); } catch { /* ignore */ }
    };
    const regen = document.createElement("button");
    regen.className = "b";
    regen.textContent = "Regenerate";
    regen.onclick = () => void openDraft(author, text);
    row.append(copy, regen);
    const foot = document.createElement("div");
    foot.className = "foot";
    foot.textContent = "Drafted by Claude in your voice — edit, then post it yourself.";
    p.append(ta, row, foot);
  }
  root.appendChild(p);
}

/* ---------- boot ---------- */

async function boot() {
  if ((await getLocal(CONFIG.X_COPILOT_KEY)) === false) return; // default on
  const mo = new MutationObserver(() => scan());
  mo.observe(document.body, { childList: true, subtree: true });
  scan();
}

const host = location.hostname;
if (window.top === window && /(^|\.)(x|twitter)\.com$/.test(host)) {
  void boot();
}
