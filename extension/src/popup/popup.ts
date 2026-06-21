import { CONFIG } from "../lib/config";
import { archivableTabs, idleMinutes, normalizeUrl } from "../lib/heuristics";
import { recall, type RankedResult } from "../lib/claude-client";
import type { AdviceResult, Message, ProductItem } from "../lib/types";

const IS_EXT = typeof chrome !== "undefined" && !!chrome.tabs;

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
}

/** Favicon for a product URL, via Google's S2 service (works on extension pages). */
function faviconUrl(url?: string): string | undefined {
  if (!url || /^(javascript|data|blob|vbscript):/i.test(url.trim())) return undefined; // reject dangerous schemes
  try {
    const host = new URL(url.startsWith("http") ? url : `https://${url}`).hostname;
    return host ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=32` : undefined;
  } catch { return undefined; }
}
/** One editable product row: separate Name / URL / Description fields. */
function productRow(p?: ProductItem): string {
  const ist = "width:100%;box-sizing:border-box;background:var(--row);border:.5px solid var(--line-strong);border-radius:8px;color:var(--t1);padding:7px;font-family:inherit;font-size:12px;outline:none";
  const fav = faviconUrl(p?.url);
  return `<div class="prodrow" style="border:.5px solid var(--line-strong);border-radius:10px;padding:8px;margin-bottom:8px">
    <div style="display:flex;gap:6px;align-items:center">
      ${fav ? `<img src="${esc(fav)}" width="16" height="16" style="border-radius:4px;flex:0 0 auto" alt=""/>` : `<span style="flex:0 0 auto;width:16px;text-align:center;color:#c68a4e">✦</span>`}
      <input class="pname" placeholder="Product name" value="${esc(p?.name ?? "")}" style="${ist}"/>
      <button data-action="del-product" title="Remove product" style="flex:0 0 auto;background:none;border:0;color:#8c7d68;font-size:14px;cursor:pointer;padding:0 4px">✕</button>
    </div>
    <input class="purl" placeholder="https://yourproduct.com (optional)" value="${esc(p?.url ?? "")}" style="${ist};margin-top:6px"/>
    <input class="pdesc" placeholder="One-liner: what it does, who it's for" value="${esc(p?.blurb ?? "")}" style="${ist};margin-top:6px"/>
  </div>`;
}
/** Read the current product rows from the DOM (named rows only). */
function collectProducts(): ProductItem[] {
  return Array.from(document.querySelectorAll<HTMLElement>(".prodrow")).map((r) => ({
    name: (r.querySelector(".pname") as HTMLInputElement | null)?.value.trim() || "",
    url: (r.querySelector(".purl") as HTMLInputElement | null)?.value.trim() || undefined,
    blurb: (r.querySelector(".pdesc") as HTMLInputElement | null)?.value.trim() || undefined,
  })).filter((p) => p.name);
}
/** Persist the current product rows (and clear the legacy single-product key). */
async function saveProducts(): Promise<ProductItem[]> {
  const products = collectProducts();
  await chrome.storage.local.set({ [CONFIG.X_PRODUCTS_KEY]: products });
  await chrome.storage.local.remove(CONFIG.X_PRODUCT_KEY);
  return products;
}
function idleLabel(min: number | undefined): string {
  if (min == null) return "No activity data";
  return min < 60 ? `Idle ${min}m` : `Idle ${Math.round(min / 60)}h`;
}
function gib(bytes: number): number {
  return Math.round((bytes / 1073741824) * 10) / 10;
}

const GROUP_HEX: Record<string, string> = {
  grey: "#5f6671", blue: "#0a84ff", red: "#ff453a", yellow: "#ffd60a",
  green: "#30d158", pink: "#ff375f", purple: "#8b5cf6", cyan: "#40c8e0", orange: "#ff9f0a",
};

const ICON: Record<string, string> = {
  layout: `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="3" width="18" height="18" rx="2.5"/><path d="M3 9h18"/></svg>`,
  search: `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>`,
  sparkles: `<svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.6l1.9 5L19 9.4l-5.1 1.8L12 16l-1.9-4.8L5 9.4l5.1-1.8z"/></svg>`,
  undo: `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8a9 9 0 1 1-2 5.7"/><path d="M3 3v5h5"/></svg>`,
  archive: `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8"/><path d="M10 12h4"/></svg>`,
  lock: `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>`,
};

interface GroupVM { title: string; hex: string; count: number; active: boolean; idle: number | undefined; }
interface ViewData {
  smart: boolean;
  pressure: { label: string; color: string };
  mem: { pct: number; used: number; total: number; hasData: boolean };
  idleCount: number;
  groups: GroupVM[];
  archivedCount: number;
  dedupe: boolean;
  hasKey: boolean;
  xEnabled: boolean;
  xNiche: string;
  xVoice: string;
  products: ProductItem[];
}

const MOCK: ViewData = {
  smart: true,
  pressure: { label: "System pressure: Normal", color: "var(--green)" },
  mem: { pct: 79, used: 14.2, total: 18, hasData: true },
  idleCount: 14,
  groups: [
    { title: "counsel-post dev", hex: GROUP_HEX.green, count: 6, active: true, idle: 2 },
    { title: "LinkedIn research", hex: GROUP_HEX.blue, count: 9, active: false, idle: 120 },
    { title: "Stripe + billing docs", hex: GROUP_HEX.purple, count: 4, active: true, idle: 5 },
  ],
  archivedCount: 6,
  dedupe: true,
  hasKey: false,
  xEnabled: true,
  xNiche: "",
  xVoice: "",
  products: [],
};

function memInfo(): Promise<{ capacity: number; availableCapacity: number } | null> {
  return new Promise((res) => {
    try {
      if (!chrome.system?.memory) return res(null);
      chrome.system.memory.getInfo((i) => res(i));
    } catch {
      res(null);
    }
  });
}

async function getData(): Promise<ViewData> {
  if (!IS_EXT) return MOCK;
  const now = Date.now();
  const win = await chrome.windows.getCurrent();
  const tabs = await chrome.tabs.query({ windowId: win.id });
  const tabGroups = await chrome.tabGroups.query({ windowId: win.id });

  const groups: GroupVM[] = tabGroups.map((g) => {
    const inGroup = tabs.filter((t) => t.groupId === g.id);
    const idles = inGroup.map((t) => idleMinutes(t, now)).filter((x): x is number => x != null);
    const minIdle = idles.length ? Math.min(...idles) : undefined;
    const active = inGroup.some((t) => t.active) || (minIdle != null && minIdle < 30);
    return { title: g.title ?? "Group", hex: GROUP_HEX[g.color] ?? GROUP_HEX.grey, count: inGroup.length, active, idle: minIdle };
  });

  const m = await memInfo();
  const hasMem = !!m && m.capacity > 0;
  const mem = hasMem
    ? { pct: Math.round(((m!.capacity - m!.availableCapacity) / m!.capacity) * 100), used: gib(m!.capacity - m!.availableCapacity), total: gib(m!.capacity), hasData: true }
    : { pct: 0, used: 0, total: 0, hasData: false };
  const freePct = hasMem ? (m!.availableCapacity / m!.capacity) * 100 : 100;
  const pressure =
    freePct > 25 ? { label: "System pressure: Normal", color: "var(--green)" }
    : freePct > 12 ? { label: "System pressure: Warning", color: "var(--amber)" }
    : { label: "System pressure: High", color: "var(--red)" };

  const store = await chrome.storage.local.get([CONFIG.ARCHIVE_KEY, CONFIG.SMART_ENABLED_KEY, CONFIG.AUTO_DEDUPE_KEY, CONFIG.ANTHROPIC_KEY_KEY, CONFIG.X_COPILOT_KEY, CONFIG.X_NICHE_KEY, CONFIG.X_VOICE_KEY, CONFIG.X_PRODUCT_KEY, CONFIG.X_PRODUCTS_KEY]);
  const productsArr = (store[CONFIG.X_PRODUCTS_KEY] as ProductItem[]) || [];
  const archive = store[CONFIG.ARCHIVE_KEY] as unknown[] | undefined;

  return {
    smart: Boolean(store[CONFIG.SMART_ENABLED_KEY]),
    pressure,
    mem,
    idleCount: archivableTabs(tabs, now).length,
    groups,
    archivedCount: archive?.length ?? 0,
    dedupe: store[CONFIG.AUTO_DEDUPE_KEY] !== false,
    hasKey: Boolean(store[CONFIG.ANTHROPIC_KEY_KEY]),
    xEnabled: store[CONFIG.X_COPILOT_KEY] !== false,
    xNiche: (store[CONFIG.X_NICHE_KEY] as string) || "",
    xVoice: (store[CONFIG.X_VOICE_KEY] as string) || "",
    products: productsArr.length ? productsArr : (store[CONFIG.X_PRODUCT_KEY] ? [{ name: "", blurb: store[CONFIG.X_PRODUCT_KEY] as string }] : []),
  };
}

/* ---------- render ---------- */

function ring(pct: number): string {
  const C = 2 * Math.PI * 42;
  const off = C * (1 - pct / 100);
  const color = pct > 85 ? "var(--red)" : pct > 65 ? "var(--amber)" : "var(--blue)";
  return `<div class="ring"><svg width="92" height="92" viewBox="0 0 92 92" aria-hidden="true">
    <circle cx="46" cy="46" r="42" fill="none" stroke="#262b35" stroke-width="7"/>
    <circle cx="46" cy="46" r="42" fill="none" stroke="${color}" stroke-width="7" stroke-linecap="round"
      stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}" transform="rotate(-90 46 46)"/>
  </svg><div class="pct"><b>${pct}%</b><span>used</span></div></div>`;
}

function memCard(d: ViewData): string {
  const left = d.mem.hasData ? ring(d.mem.pct) : `<div class="ring"><div class="pct"><b>—</b><span>mem</span></div></div>`;
  const headRight = d.mem.hasData ? `<div class="dim">${d.mem.used} / ${d.mem.total} GB</div>` : "";
  const free = d.mem.hasData ? Math.round((d.mem.total - d.mem.used) * 10) / 10 : 0;
  const legend = d.mem.hasData
    ? `<div class="legend"><span><span class="dot" style="background:var(--blue)"></span>${d.mem.used} GB used</span><span><span class="dot" style="background:#3a3f4a"></span>${free} GB free</span></div>`
    : `<div class="legend"><span class="dim">Add the system.memory permission to show this.</span></div>`;
  return `<div class="card"><div class="mem">${left}
    <div class="grow mem-meta"><div class="row-flex between"><div class="big">System memory</div>${headRight}</div>${legend}</div>
  </div></div>`;
}

function groupRow(g: GroupVM): string {
  const active = `<span class="status" style="color:var(--green)"><span class="dot" style="background:var(--green)"></span>Active</span>`;
  const idle = g.idle == null
    ? `<span class="status muted">No activity data</span>`
    : `<span class="status" style="color:var(--amber)">${esc(idleLabel(g.idle))}</span>`;
  return `<div class="li"><div class="sq" style="background:${g.hex}">${ICON.layout}</div>
    <div class="grow"><div class="name trunc">${esc(g.title)}</div><div class="sub">${g.count} tabs</div></div>
    ${g.active ? active : idle}</div>`;
}

function keyRow(d: ViewData): string {
  if (d.hasKey) {
    return `<div class="li"><div class="grow"><div class="name">Anthropic key</div><div class="sub">✓ stored locally · Smart runs with no proxy</div></div><button class="act" data-action="clear-key">Change</button></div>`;
  }
  return `<div class="li" style="display:block"><div class="name" style="margin-bottom:6px">Anthropic key <span class="dim" style="font-weight:400">— optional, runs Smart with no proxy</span></div>
    <div style="display:flex;gap:8px"><input id="keyinput" type="password" placeholder="sk-ant-..." autocomplete="off" style="flex:1;background:var(--row);border:0.5px solid var(--line-strong);border-radius:9px;color:var(--t1);padding:7px 10px;font-family:inherit;font-size:12px;outline:none"/><button class="btn" data-action="save-key" style="padding:7px 12px">Save</button></div></div>`;
}

let expanded = false;

function render(d: ViewData): string {
  const all = d.groups;
  const shown = expanded ? all : all.slice(0, 3);
  const groupsList = shown.length
    ? `<div class="list">${shown.map(groupRow).join("")}</div>`
    : `<div class="list"><div class="empty">No groups yet — hit “Group ${d.smart ? "with Claude" : "by site"}”.</div></div>`;
  const groupCount = !expanded && all.length > 3 ? `3 of ${all.length} groups` : `${all.length} group${all.length === 1 ? "" : "s"}`;
  const expandRow = all.length > 3
    ? `<button class="btn" data-action="${expanded ? "collapse" : "expand"}" style="width:100%;margin-top:8px">${expanded ? "Collapse" : `Expand · view all ${all.length} groups`}</button>`
    : "";
  return `
  <header class="row-flex between">
    <div class="row-flex gap10"><div class="sq" style="background:var(--brand)">${ICON.layout}</div><div class="wordmark"><div class="brand">Tab Butler</div><div class="tagline">Your tabs. Smarter.</div></div></div>
    <div class="row-flex gap12">
      <span class="muted" style="font-size:11.5px">Smart</span>
      <label class="switch"><input type="checkbox" id="smart" aria-label="Smart mode — use Claude for grouping and cleanup" ${d.smart ? "checked" : ""}/><span class="track"><span class="knob"></span></span></label>
    </div>
  </header>

  <div class="search" style="margin-top:12px">${ICON.search}<input id="q" placeholder="Search tabs, archive &amp; history…" autocomplete="off"/><span class="kbd">↵ search</span></div>

  <div class="toolbar" style="margin-top:10px">
    <button class="btn primary" data-action="group">${ICON.layout} ${d.smart ? "Group with Claude" : "Group by site"}</button>
    <button class="btn" data-action="advise">${ICON.sparkles} Suggest cleanup</button>
    ${d.idleCount > 0 ? `<button class="btn" data-action="reclaim">${ICON.archive} Archive ${d.idleCount}</button>` : ""}
  </div>

  <div id="toparea"></div>

  ${memCard(d)}

  <div class="sec"><h2>Tab groups</h2><span class="dim">${groupCount}</span></div>
  ${groupsList}
  ${expandRow}

  <div class="sec"><h2>Settings</h2></div>
  <div class="list">
    <div class="li"><div class="grow"><div class="name">Auto-merge duplicate tabs</div><div class="sub">switch to the open tab instead of a copy</div></div>
      <label class="switch"><input type="checkbox" id="dedupe" aria-label="Auto-merge duplicate tabs" ${d.dedupe ? "checked" : ""}/><span class="track"><span class="knob"></span></span></label></div>
    ${d.smart ? keyRow(d) : ""}
  </div>

  <div class="sec"><h2>X reply copilot</h2><label class="switch"><input type="checkbox" id="xon" aria-label="X reply copilot" ${d.xEnabled ? "checked" : ""}/><span class="track"><span class="knob"></span></span></label></div>
  <div class="list">
    <div class="li" style="display:block">
      <div class="name" style="margin-bottom:6px">What's worth replying to <span class="dim" style="font-weight:400">— your niche/goals</span></div>
      <textarea id="xniche" rows="2" placeholder="e.g. AI builders, indie SaaS founders; posts I can add a specific build lesson to" style="width:100%;box-sizing:border-box;background:var(--row);border:.5px solid var(--line-strong);border-radius:9px;color:var(--t1);padding:8px;font-family:inherit;font-size:12px;outline:none;resize:vertical">${esc(d.xNiche)}</textarea>
    </div>
    <div class="li" style="display:block">
      <div class="name" style="margin-bottom:6px">Your products <span class="dim" style="font-weight:400">— name, link &amp; a one-liner each</span></div>
      <div id="prodrows">${(d.products.length ? d.products : [undefined]).map((p) => productRow(p)).join("")}</div>
      <button class="btn" data-action="add-product" style="padding:6px 11px;font-size:12px">+ Add product</button>
      <div class="dim" style="font-size:10.5px;margin-top:6px">On a "drop your product" post, the copilot tags the best-fit product and drafts with it.</div>
    </div>
    <div class="li" style="display:block">
      <div class="name" style="margin-bottom:6px">Your reply voice <span class="dim" style="font-weight:400">— tone or 2-3 example replies</span></div>
      <textarea id="xvoice" rows="3" placeholder="Paste a few replies you're proud of, or describe your tone…" style="width:100%;box-sizing:border-box;background:var(--row);border:.5px solid var(--line-strong);border-radius:9px;color:var(--t1);padding:8px;font-family:inherit;font-size:12px;outline:none;resize:vertical">${esc(d.xVoice)}</textarea>
      <button class="btn primary" data-action="save-x" style="margin-top:8px;padding:7px 12px">Save copilot settings</button>
    </div>
  </div>
  <div class="note" style="margin-top:6px">${ICON.lock}<div>On x.com, the text of timeline posts is sent to Claude to score &amp; draft. Draft-only — it never posts for you.</div></div>

  <div class="footer-actions">
    <button class="btn" data-action="archived">${ICON.archive} Archived (${d.archivedCount})</button>
    <button class="btn" data-action="undo">${ICON.undo} Undo</button>
  </div>
  <div class="note">${ICON.lock}<div>RAM is system-wide (per-process detail lives in the <code>tb</code> CLI). Smart features are opt-in and send page titles + URLs to Claude — search also includes recent history.</div></div>`;
}

/* ---------- actions ---------- */

const app = document.getElementById("app") as HTMLDivElement;
const toastEl = document.getElementById("toast") as HTMLDivElement;
let toastTimer: number | undefined;

function toast(msg: string) {
  toastEl.textContent = msg;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastEl.textContent = ""), 3000) as unknown as number;
}

function top(): HTMLElement {
  return document.getElementById("toparea")!;
}
function showLoader(msg: string) {
  top().innerHTML = `<div class="loader"><span class="spin"></span>${esc(msg)}</div>`;
}

function send<T>(msg: Message): Promise<T> {
  return chrome.runtime.sendMessage(msg) as Promise<T>;
}

async function refresh() {
  app.innerHTML = render(await getData());
}

let lastRecs: AdviceResult | null = null;

function recVerb(kind: string): string {
  return kind === "archive" ? "Archive" : kind === "bookmark" ? "Save" : kind === "regroup" ? "Regroup" : "Close";
}

function renderRecs(r: AdviceResult) {
  lastRecs = r;
  if (!r.recommendations.length) {
    top().innerHTML = `<div class="empty">${esc(r.summary || "No suggestions right now.")}</div>`;
    return;
  }
  const dot = (c: string) => (c === "high" ? "var(--green)" : c === "medium" ? "var(--amber)" : "var(--t2)");
  top().innerHTML =
    `<div class="dim" style="margin:4px 4px 6px">${esc(r.summary)}</div><div class="list">` +
    r.recommendations
      .map((rec, i) => `<div class="li"><div class="sq" style="background:#1c1f26;color:${dot(rec.confidence)}">${ICON.sparkles}</div>
        <div class="grow"><div class="name">${esc(rec.title)}</div><div class="sub">${esc(rec.detail)}</div></div>
        <button class="btn" data-action="apply-rec" data-idx="${i}" style="padding:6px 12px;font-size:12px">${recVerb(rec.kind)}</button>
        <button class="act" data-action="dismiss-rec" data-idx="${i}" aria-label="Dismiss suggestion">✕</button></div>`)
      .join("") +
    `</div>`;
}

interface Cand { title: string; url: string; source: string; }
async function gatherCandidates(): Promise<Cand[]> {
  const seen = new Set<string>();
  const out: Cand[] = [];
  const add = (title: string | undefined, url: string | undefined, source: string) => {
    if (!url || !url.startsWith("http")) return;
    const k = normalizeUrl(url);
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ title: title || url, url, source });
  };
  for (const t of await chrome.tabs.query({})) add(t.title, t.url, "open");
  const arch = (await chrome.storage.local.get(CONFIG.ARCHIVE_KEY))[CONFIG.ARCHIVE_KEY] as { title: string; url: string }[] | undefined;
  for (const a of arch ?? []) add(a.title, a.url, "archive");
  if (chrome.history) {
    for (const h of await chrome.history.search({ text: "", startTime: Date.now() - 30 * 86400000, maxResults: 120 })) {
      add(h.title, h.url, "history");
    }
  }
  return out.slice(0, 120);
}

function renderRecallResults(query: string, results: RankedResult[]) {
  if (!results.length) {
    top().innerHTML = `<div class="empty">Nothing found for “${esc(query)}”.</div>`;
    return;
  }
  top().innerHTML =
    `<div class="dim" style="margin:4px 4px 6px">Results for “${esc(query)}”</div><div class="list">` +
    results
      .map((r) => `<div class="li click" role="button" tabindex="0" data-action="open-url" data-url="${esc(r.url)}">
        <div class="grow"><div class="name trunc">${esc(r.title)}</div><div class="sub trunc">${esc(r.why || r.url)}</div></div>
        <span class="status muted">${esc(r.source)}</span></div>`)
      .join("") +
    `</div>`;
}

async function doRecall(query: string) {
  showLoader("Searching everywhere…");
  try {
    const candidates = await gatherCandidates();
    renderRecallResults(query, await recall(query, candidates));
  } catch (err) {
    top().innerHTML = (err as Error).message === "no-key"
      ? `<div class="empty">Add your Anthropic key in Settings to search archive &amp; history.</div>`
      : `<div class="empty">Search failed — try again.</div>`;
  }
}

async function dispatch(el: HTMLElement) {
  const id = el.dataset.id ? Number(el.dataset.id) : undefined;
  try {
    switch (el.dataset.action) {
      case "group": {
        toast("Grouping…");
        const r = await send<{ applied: number; smart: boolean }>({ type: "GROUP_NOW" });
        await refresh();
        toast(`Created ${r.applied} group(s)${r.smart ? " with Claude" : " by site"}.`);
        break;
      }
      case "reclaim": {
        const r = await send<{ archived: number }>({ type: "ARCHIVE_IDLE_NOW" });
        await refresh();
        toast(`Archived ${r.archived} idle tab(s). Undo anytime.`);
        break;
      }
      case "advise": {
        showLoader("Asking Claude…");
        const r = await send<AdviceResult>({ type: "ADVISE_NOW" });
        renderRecs(r);
        break;
      }
      case "undo": {
        const r = await send<{ restored: number }>({ type: "UNDO_LAST" });
        await refresh();
        toast(`Restored ${r.restored} tab(s).`);
        break;
      }
      case "archived": {
        const arch = ((await chrome.storage.local.get(CONFIG.ARCHIVE_KEY))[CONFIG.ARCHIVE_KEY] as { title: string }[] | undefined) ?? [];
        top().innerHTML = arch.length
          ? `<div class="list">${arch.slice(0, 12).map((a) => `<div class="li"><div class="grow"><div class="name trunc">${esc(a.title || "(untitled)")}</div></div></div>`).join("")}</div>`
          : `<div class="empty">Nothing archived yet.</div>`;
        break;
      }
      case "focus-tab": {
        if (id == null) return;
        const t = await chrome.tabs.get(id);
        await chrome.tabs.update(id, { active: true });
        if (t.windowId != null) await chrome.windows.update(t.windowId, { focused: true });
        window.close();
        break;
      }
      case "apply-rec": {
        const i = Number(el.dataset.idx);
        const rec = lastRecs?.recommendations[i];
        if (!rec) return;
        showLoader(`Applying: ${rec.title}…`);
        const res = await send<{ done: number; label: string }>({ type: "APPLY_REC", kind: rec.kind, tabIds: rec.tabIds });
        lastRecs!.recommendations.splice(i, 1);
        await refresh();
        renderRecs(lastRecs!);
        toast(`${res.label} ${res.done} tab(s). Undo anytime.`);
        break;
      }
      case "dismiss-rec": {
        const i = Number(el.dataset.idx);
        if (!lastRecs) return;
        lastRecs.recommendations.splice(i, 1);
        renderRecs(lastRecs);
        break;
      }
      case "save-key": {
        const input = document.getElementById("keyinput") as HTMLInputElement | null;
        const val = input?.value.trim();
        if (!val) return;
        await chrome.storage.local.set({ [CONFIG.ANTHROPIC_KEY_KEY]: val });
        await refresh();
        toast("Key saved — Smart now runs with no proxy.");
        break;
      }
      case "clear-key": {
        await chrome.storage.local.remove(CONFIG.ANTHROPIC_KEY_KEY);
        await refresh();
        toast("Key removed.");
        break;
      }
      case "open-url": {
        const url = el.dataset.url;
        if (!url) return;
        const all = await chrome.tabs.query({});
        const existing = all.find((t) => t.url && normalizeUrl(t.url) === normalizeUrl(url));
        if (existing?.id != null) {
          await chrome.tabs.update(existing.id, { active: true });
          if (existing.windowId != null) await chrome.windows.update(existing.windowId, { focused: true });
        } else {
          await chrome.tabs.create({ url });
        }
        window.close();
        break;
      }
      case "expand": { expanded = true; await refresh(); break; }
      case "collapse": { expanded = false; await refresh(); break; }
      case "save-x": {
        const niche = (document.getElementById("xniche") as HTMLTextAreaElement | null)?.value ?? "";
        const voice = (document.getElementById("xvoice") as HTMLTextAreaElement | null)?.value ?? "";
        await chrome.storage.local.set({ [CONFIG.X_NICHE_KEY]: niche, [CONFIG.X_VOICE_KEY]: voice });
        const products = await saveProducts();
        toast(`Copilot settings saved${products.length ? ` (${products.length} product${products.length === 1 ? "" : "s"})` : ""}.`);
        await refresh(); // re-render so the product favicon previews update
        break;
      }
      case "add-product": {
        document.getElementById("prodrows")?.insertAdjacentHTML("beforeend", productRow());
        (document.querySelector("#prodrows .prodrow:last-child .pname") as HTMLInputElement | null)?.focus();
        break;
      }
      case "del-product": {
        el.closest(".prodrow")?.remove();
        await saveProducts(); // persist immediately so it can't reappear on reopen
        toast("Product removed.");
        break;
      }
    }
  } catch (err) {
    console.error("action failed", el.dataset.action, err);
    toast("Something went wrong — try again.");
    if (el.dataset.action === "advise") top().innerHTML = `<div class="empty">Couldn't reach the suggestion service.</div>`;
  }
}

let searchTabs: chrome.tabs.Tab[] = [];
async function onInput(e: Event) {
  const target = e.target as HTMLElement;
  if (target.id !== "q" || !IS_EXT) return;
  const q = (target as HTMLInputElement).value.trim().toLowerCase();
  if (!q) { top().innerHTML = ""; return; }
  if (!searchTabs.length) searchTabs = await chrome.tabs.query({ currentWindow: true });
  const hits = searchTabs
    .filter((t) => (t.title ?? "").toLowerCase().includes(q) || (t.url ?? "").toLowerCase().includes(q))
    .slice(0, 8);
  top().innerHTML = hits.length
    ? `<div class="list">${hits.map((t) => `<div class="li click" role="button" tabindex="0" data-action="focus-tab" data-id="${t.id}"><div class="grow"><div class="name trunc">${esc(t.title ?? "")}</div><div class="sub trunc">${esc(t.url ?? "")}</div></div></div>`).join("")}</div>`
    : `<div class="empty">No matches.</div>`;
}

async function onChange(e: Event) {
  if (!IS_EXT) return;
  const target = e.target as HTMLInputElement;
  if (target.id === "smart") {
    await chrome.storage.local.set({ [CONFIG.SMART_ENABLED_KEY]: target.checked });
    await refresh();
    toast(target.checked ? "Smart mode on — Claude will group & advise." : "Smart mode off — local only.");
  } else if (target.id === "dedupe") {
    await chrome.storage.local.set({ [CONFIG.AUTO_DEDUPE_KEY]: target.checked });
    toast(target.checked ? "Auto-merge duplicates on." : "Auto-merge off.");
  } else if (target.id === "xon") {
    await chrome.storage.local.set({ [CONFIG.X_COPILOT_KEY]: target.checked });
    toast(target.checked ? "X copilot on — reload x.com to apply." : "X copilot off — reload x.com.");
  }
}

function onClick(e: Event) {
  const el = (e.target as HTMLElement).closest<HTMLElement>("[data-action]");
  if (el && IS_EXT) void dispatch(el);
}

function onKeydown(e: KeyboardEvent) {
  if (!IS_EXT) return;
  const target = e.target as HTMLElement;
  if (target.id === "q" && e.key === "Enter") {
    const q = (target as HTMLInputElement).value.trim();
    if (q) { e.preventDefault(); void doRecall(q); }
    return;
  }
  const el = target.closest<HTMLElement>("[data-action]");
  if (el && el.tagName !== "BUTTON" && (e.key === "Enter" || e.key === " ")) {
    e.preventDefault();
    void dispatch(el);
  }
}

app.addEventListener("click", onClick);
app.addEventListener("input", onInput);
app.addEventListener("change", onChange);
app.addEventListener("keydown", onKeydown);

void refresh();
