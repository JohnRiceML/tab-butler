import { CONFIG } from "../lib/config";
import { archivableTabs, idleMinutes } from "../lib/heuristics";
import type { AdviceResult, Message } from "../lib/types";

const IS_EXT = typeof chrome !== "undefined" && !!chrome.tabs;

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
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

  const store = await chrome.storage.local.get([CONFIG.ARCHIVE_KEY, CONFIG.SMART_ENABLED_KEY, CONFIG.AUTO_DEDUPE_KEY, CONFIG.ANTHROPIC_KEY_KEY]);
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

function render(d: ViewData): string {
  const groups = d.groups.length
    ? `<div class="list">${d.groups.map(groupRow).join("")}</div>`
    : `<div class="list"><div class="empty">No groups yet — hit “Group ${d.smart ? "with Claude" : "by site"}”.</div></div>`;
  return `
  <header class="row-flex between">
    <div class="row-flex gap10"><div class="sq" style="background:var(--blue)">${ICON.layout}</div><div class="brand">Tab Butler</div></div>
    <div class="row-flex gap12">
      <span class="muted" style="font-size:11.5px">Smart</span>
      <label class="switch"><input type="checkbox" id="smart" aria-label="Smart mode — use Claude for grouping and cleanup" ${d.smart ? "checked" : ""}/><span class="track"><span class="knob"></span></span></label>
    </div>
  </header>

  <div class="search" style="margin-top:12px">${ICON.search}<input id="q" placeholder="Search open tabs…" autocomplete="off"/><span class="kbd">↵ open</span></div>

  <div class="toolbar" style="margin-top:10px">
    <button class="btn" data-action="group">${ICON.layout} ${d.smart ? "Group with Claude" : "Group by site"}</button>
    <button class="btn" data-action="advise">${ICON.sparkles} Suggest cleanup</button>
    ${d.idleCount > 0 ? `<button class="btn" data-action="reclaim">${ICON.archive} Archive ${d.idleCount}</button>` : ""}
  </div>

  <div id="toparea"></div>

  ${memCard(d)}

  <div class="sec"><h2>Tab groups</h2><span class="dim">${d.groups.length} group${d.groups.length === 1 ? "" : "s"}</span></div>
  ${groups}

  <div class="sec"><h2>Settings</h2></div>
  <div class="list">
    <div class="li"><div class="grow"><div class="name">Auto-merge duplicate tabs</div><div class="sub">switch to the open tab instead of a copy</div></div>
      <label class="switch"><input type="checkbox" id="dedupe" aria-label="Auto-merge duplicate tabs" ${d.dedupe ? "checked" : ""}/><span class="track"><span class="knob"></span></span></label></div>
    ${d.smart ? keyRow(d) : ""}
  </div>

  <div class="footer-actions">
    <button class="btn" data-action="archived">${ICON.archive} Archived (${d.archivedCount})</button>
    <button class="btn" data-action="undo">${ICON.undo} Undo</button>
  </div>
  <div class="note">${ICON.lock}<div>RAM is system-wide (per-process detail lives in the <code>tb</code> CLI). Smart features are opt-in and send tab titles/URLs only.</div></div>`;
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
    const first = document.querySelector<HTMLElement>('#toparea [data-action="focus-tab"]');
    if (first) { e.preventDefault(); void dispatch(first); }
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
