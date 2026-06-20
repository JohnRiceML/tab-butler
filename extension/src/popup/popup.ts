import { CONFIG, isLocalhost } from "../lib/config";
import { archivableTabs, idleMinutes } from "../lib/heuristics";
import type { AdviceResult, Message } from "../lib/types";

/* ---------- tiny helpers ---------- */

const IS_EXT = typeof chrome !== "undefined" && !!chrome.tabs;

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;"
    : c === "<" ? "&lt;"
    : c === ">" ? "&gt;"
    : c === '"' ? "&quot;"
    : "&#39;",
  );
}
/** Human idle label. Returns a no-data sentinel when activity is unknown — never assert "Idle". */
function idleLabel(min: number | undefined): string {
  if (min == null) return "No activity data";
  return min < 60 ? `Idle ${min}m` : `Idle ${Math.round(min / 60)}h`;
}

const GROUP_HEX: Record<string, string> = {
  grey: "#5f6671", blue: "#0a84ff", red: "#ff453a", yellow: "#ffd60a",
  green: "#30d158", pink: "#ff375f", purple: "#8b5cf6", cyan: "#40c8e0", orange: "#ff9f0a",
};

const ICON: Record<string, string> = {
  layout: `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="3" width="18" height="18" rx="2.5"/><path d="M3 9h18"/></svg>`,
  terminal: `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 8l4 4-4 4"/><path d="M13 16h6"/></svg>`,
  search: `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>`,
  sparkles: `<svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.6l1.9 5L19 9.4l-5.1 1.8L12 16l-1.9-4.8L5 9.4l5.1-1.8z"/></svg>`,
  undo: `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8a9 9 0 1 1-2 5.7"/><path d="M3 3v5h5"/></svg>`,
  lock: `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>`,
  archive: `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8"/><path d="M10 12h4"/></svg>`,
};

/* ---------- view model ---------- */

interface GroupVM { title: string; hex: string; count: number; active: boolean; idle: number | undefined; }
interface LocalVM { id: number; port: string; title: string; idle: number | undefined; }
interface ServerVM { port: number; command: string; hasTab: boolean; }
interface ViewData {
  smart: boolean;
  pressure: { label: string; color: string };
  mem: { pct: number; used: number; total: number; hasData: boolean };
  idleCount: number;
  groups: GroupVM[];
  localhost: LocalVM[];
  servers: ServerVM[];
  killable: boolean;
  archivedCount: number;
}

/** Native messaging host that lists/kills dev servers (see native-host/). */
const NATIVE_HOST = "com.tab_butler.host";
/** Command prefixes we treat as dev servers — so we never offer to kill macOS
 *  services (Control Center on :5000/:7000), Discord, etc. */
const DEV_CMDS = ["node", "deno", "bun", "python", "ruby", "php", "rails", "puma", "vite", "next", "webpack", "ng", "cargo", "go", "dotnet", "java", "gradle", "flask", "gunicorn", "uvicorn"];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function hostCall(msg: { action: string; port?: number }): Promise<any> {
  return new Promise((resolve) => {
    if (!IS_EXT || !chrome.runtime?.sendNativeMessage) return resolve(null);
    try {
      chrome.runtime.sendNativeMessage(NATIVE_HOST, msg, (r) => {
        resolve(chrome.runtime.lastError ? null : r);
      });
    } catch {
      resolve(null);
    }
  });
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
  localhost: [
    { id: 1, port: "3007", title: "counsel-post", idle: 1 },
    { id: 2, port: "3000", title: "healing-tides", idle: 4 },
    { id: 3, port: "6006", title: "Storybook", idle: 60 },
  ],
  killable: true,
  servers: [
    { port: 3007, command: "node", hasTab: true },
    { port: 3000, command: "node", hasTab: true },
    { port: 6006, command: "node", hasTab: true },
    { port: 8787, command: "python", hasTab: false },
  ],
  archivedCount: 6,
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

  const localhost: LocalVM[] = tabs
    .filter((t) => t.url && isLocalhost(t.url) && t.id != null)
    .map((t) => {
      let port = "";
      try { port = new URL(t.url!).port || "80"; } catch { /* ignore */ }
      return { id: t.id!, port, title: t.title ?? "", idle: idleMinutes(t, now) };
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

  const archive = (await chrome.storage.local.get(CONFIG.ARCHIVE_KEY))[CONFIG.ARCHIVE_KEY] as unknown[] | undefined;
  const smart = Boolean((await chrome.storage.local.get(CONFIG.SMART_ENABLED_KEY))[CONFIG.SMART_ENABLED_KEY]);

  const hostList = await hostCall({ action: "list" });
  const killable = !!hostList?.ok;
  const servers: ServerVM[] = killable
    ? (hostList.servers as { port: number; command: string }[])
        .filter((s) => localhost.some((l) => Number(l.port) === s.port) || DEV_CMDS.some((c) => (s.command || "").toLowerCase().startsWith(c)))
        .map((s) => ({ port: s.port, command: s.command, hasTab: localhost.some((l) => Number(l.port) === s.port) }))
    : [];

  return { smart, pressure, mem, idleCount: archivableTabs(tabs, now).length, groups, localhost, servers, killable, archivedCount: archive?.length ?? 0 };
}

function gib(bytes: number): number {
  return Math.round((bytes / 1073741824) * 10) / 10;
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

/** Memory card = system memory ONLY. No tab actions here, to avoid implying that
 *  closing tabs moves the system-memory number (it may not, on stable Chrome). */
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

/** Tab-cleanup actions, kept separate from the memory gauge. */
function actionsRow(d: ViewData): string {
  const archive = d.idleCount > 0
    ? `<button class="btn primary" data-action="reclaim">${ICON.archive} Archive ${d.idleCount} idle tab${d.idleCount === 1 ? "" : "s"}</button>`
    : `<span class="dim" style="align-self:center">No idle tabs to archive yet</span>`;
  return `<div style="display:flex;gap:8px;align-items:center;margin-top:12px">${archive}<button class="btn" data-action="advise">${ICON.sparkles} Suggest cleanup</button></div>`;
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

function localRow(l: LocalVM): string {
  const active = l.idle != null && l.idle < 30;
  const status = active
    ? `<span class="status" style="color:var(--green)"><span class="dot" style="background:var(--green)"></span>Active</span>`
    : `<span class="status muted">${esc(idleLabel(l.idle))}</span>`;
  return `<div class="li"><div class="sq" style="background:#1c1f26;color:var(--green)">${ICON.terminal}</div>
    <div class="grow click" role="button" tabindex="0" data-action="focus-tab" data-id="${l.id}" style="cursor:pointer">
      <div class="name trunc">localhost:${esc(l.port)}${l.title ? " · " + esc(l.title) : ""}</div>
      <div class="sub">dev server tab</div></div>
    ${status}<button class="act danger" data-action="close-tab" data-id="${l.id}">Close tab</button></div>`;
}

function serverRow(s: ServerVM): string {
  return `<div class="li"><div class="sq" style="background:#1c1f26;color:var(--green)">${ICON.terminal}</div>
    <div class="grow"><div class="name trunc">localhost:${s.port}${s.command ? " · " + esc(s.command) : ""}</div><div class="sub">${s.hasTab ? "running · open in a tab" : "running · no tab"}</div></div>
    <button class="act danger" data-action="kill-server" data-port="${s.port}">Kill</button></div>`;
}

function render(d: ViewData): string {
  const groups = d.groups.length
    ? `<div class="list">${d.groups.map(groupRow).join("")}</div>`
    : `<div class="list"><div class="empty">No groups yet — hit “Group ${d.smart ? "with Claude" : "by site"}”.</div></div>`;
  const local = d.killable && d.servers.length
    ? `<div class="sec"><h2>Localhost · servers running</h2><span class="dim">${d.servers.length} running</span></div><div class="list">${d.servers.map(serverRow).join("")}</div>`
    : d.localhost.length
      ? `<div class="sec"><h2>Localhost · dev servers</h2><span class="dim">${d.localhost.length} open · run install.sh to kill</span></div><div class="list">${d.localhost.map(localRow).join("")}</div>`
      : "";
  return `
  <header class="row-flex between">
    <div class="row-flex gap10"><div class="sq" style="background:var(--blue)">${ICON.layout}</div><div class="brand">Tab Butler</div></div>
    <div class="row-flex gap12">
      <span class="pill" title="Based on total system memory"><span class="dot" style="background:${d.pressure.color}"></span>${esc(d.pressure.label)}</span>
      <span class="muted" style="font-size:11.5px">Smart</span>
      <label class="switch"><input type="checkbox" id="smart" aria-label="Smart mode — use Claude for grouping and cleanup" ${d.smart ? "checked" : ""}/><span class="track"><span class="knob"></span></span></label>
    </div>
  </header>
  ${memCard(d)}
  ${actionsRow(d)}
  <div class="sec"><h2>Tab groups</h2><button class="act" data-action="group">${d.smart ? "Group with Claude" : "Group by site"}</button></div>
  ${groups}
  ${local}
  <div class="sec"><h2>Search</h2></div>
  <div class="search">${ICON.search}<input id="q" placeholder="Search open tabs…" autocomplete="off"/><span class="kbd">↵ open</span></div>
  <div id="results"></div>
  <div class="footer-actions">
    <button class="btn" data-action="archived">${ICON.archive} Archived (${d.archivedCount})</button>
    <button class="btn" data-action="undo">${ICON.undo} Undo</button>
  </div>
  <div class="note">${ICON.lock}<div>RAM is reported at the process level — browsers can't split memory cleanly per tab. Closing tabs won't necessarily move the system gauge. Smart features are opt-in and send tab titles/URLs only.</div></div>`;
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

function send<T>(msg: Message): Promise<T> {
  return chrome.runtime.sendMessage(msg) as Promise<T>;
}

async function refresh() {
  app.innerHTML = render(await getData());
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
        toast("Asking Claude…");
        const r = await send<AdviceResult>({ type: "ADVISE_NOW" });
        renderRecs(r);
        toast("");
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
        const results = document.getElementById("results")!;
        results.innerHTML = arch.length
          ? `<div class="list" style="margin-top:8px">${arch.slice(0, 12).map((a) => `<div class="li"><div class="grow"><div class="name trunc">${esc(a.title || "(untitled)")}</div></div></div>`).join("")}</div>`
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
      case "close-tab": {
        if (id == null) return;
        await chrome.tabs.remove(id);
        await refresh();
        break;
      }
      case "kill-server": {
        const port = el.dataset.port ? Number(el.dataset.port) : NaN;
        if (!Number.isFinite(port)) return;
        toast(`Killing :${port}…`);
        const res = await hostCall({ action: "kill", port });
        if (res?.ok) {
          const all = await chrome.tabs.query({});
          for (const t of all) {
            try {
              if (t.id != null && t.url && new URL(t.url).port === String(port)) await chrome.tabs.remove(t.id);
            } catch { /* ignore */ }
          }
          await refresh();
          toast(`Killed :${port} (${res.killed?.length ?? 0} process).`);
        } else {
          toast(res?.error ? `Couldn't kill :${port}: ${res.error}` : "Killer helper not installed — run native-host/install.sh.");
        }
        break;
      }
      case "apply-rec": {
        const i = Number(el.dataset.idx);
        const rec = lastRecs?.recommendations[i];
        if (!rec) return;
        toast(`Applying: ${rec.title}…`);
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
    }
  } catch (err) {
    console.error("action failed", el.dataset.action, err);
    toast("Something went wrong — try again.");
  }
}

let lastRecs: AdviceResult | null = null;

function recVerb(kind: string): string {
  return kind === "archive" ? "Archive" : kind === "bookmark" ? "Save" : kind === "regroup" ? "Regroup" : "Close";
}

function renderRecs(r: AdviceResult) {
  lastRecs = r;
  const results = document.getElementById("results")!;
  if (!r.recommendations.length) {
    results.innerHTML = `<div class="empty">${esc(r.summary || "No suggestions right now.")}</div>`;
    return;
  }
  const dot = (c: string) => (c === "high" ? "var(--green)" : c === "medium" ? "var(--amber)" : "var(--t2)");
  results.innerHTML =
    `<div class="dim" style="margin:8px 4px 6px">${esc(r.summary)}</div><div class="list">` +
    r.recommendations
      .map((rec, i) => `<div class="li"><div class="sq" style="background:#1c1f26;color:${dot(rec.confidence)}">${ICON.sparkles}</div>
        <div class="grow"><div class="name">${esc(rec.title)}</div><div class="sub">${esc(rec.detail)}</div></div>
        <button class="btn" data-action="apply-rec" data-idx="${i}" style="padding:6px 12px;font-size:12px">${recVerb(rec.kind)}</button>
        <button class="act" data-action="dismiss-rec" data-idx="${i}" aria-label="Dismiss suggestion">✕</button></div>`)
      .join("") +
    `</div>`;
}

let searchTabs: chrome.tabs.Tab[] = [];
async function onInput(e: Event) {
  const target = e.target as HTMLElement;
  if (target.id !== "q" || !IS_EXT) return;
  const q = (target as HTMLInputElement).value.trim().toLowerCase();
  const results = document.getElementById("results")!;
  if (!q) { results.innerHTML = ""; return; }
  if (!searchTabs.length) searchTabs = await chrome.tabs.query({ currentWindow: true });
  const hits = searchTabs
    .filter((t) => (t.title ?? "").toLowerCase().includes(q) || (t.url ?? "").toLowerCase().includes(q))
    .slice(0, 8);
  results.innerHTML = hits.length
    ? `<div class="list" style="margin-top:8px">${hits.map((t) => `<div class="li click" role="button" tabindex="0" data-action="focus-tab" data-id="${t.id}"><div class="grow"><div class="name trunc">${esc(t.title ?? "")}</div><div class="sub trunc">${esc(t.url ?? "")}</div></div></div>`).join("")}</div>`
    : `<div class="empty">No matches.</div>`;
}

async function onChange(e: Event) {
  const target = e.target as HTMLInputElement;
  if (target.id !== "smart" || !IS_EXT) return;
  await chrome.storage.local.set({ [CONFIG.SMART_ENABLED_KEY]: target.checked });
  await refresh();
  toast(target.checked ? "Smart mode on — Claude will group & advise." : "Smart mode off — local only.");
}

function onClick(e: Event) {
  const el = (e.target as HTMLElement).closest<HTMLElement>("[data-action]");
  if (el && IS_EXT) void dispatch(el);
}

function onKeydown(e: KeyboardEvent) {
  if (!IS_EXT) return;
  const target = e.target as HTMLElement;
  // Enter in the search box → open the first result.
  if (target.id === "q" && e.key === "Enter") {
    const first = document.querySelector<HTMLElement>('#results [data-action="focus-tab"]');
    if (first) { e.preventDefault(); void dispatch(first); }
    return;
  }
  // Enter/Space on a focusable role=button row (real <button>s fire via click).
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
