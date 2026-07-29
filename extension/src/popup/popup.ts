import { CONFIG } from "../lib/config";
import { archivableTabs, idleMinutes, normalizeUrl } from "../lib/heuristics";
import { recall, type RankedResult } from "../lib/claude-client";
import { REPLY_ANGLES } from "../lib/prompts";
import { reputationStatus, REPLY_HARD_PER_HOUR, REPLY_SOFT_PER_HOUR, type RepLevel } from "../lib/reply-hygiene";
import { mountGoobi, type GoobiHandle } from "../lib/goobi";
import { parseUser, pickVoiceSamples, buildVoiceProfile } from "../lib/twttr";
import { DEFAULT_DAILY_GOALS, normalizeDailyGoals, type DailyGoals } from "../lib/daily-goals";
import { normalizeSoul, SOUL_TEMPLATE } from "../lib/soul";
import type { AdviceResult, Message, ProductItem } from "../lib/types";

const IS_EXT = typeof chrome !== "undefined" && !!chrome.tabs;

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
}

/** Product icon: renders a colored letter chip immediately, then upgrades to the
 *  real favicon (Chrome's built-in `_favicon` cache — no network, no CORS) IF it
 *  loads. Never goes blank: if `_favicon` is unavailable (the "favicon" permission
 *  isn't granted yet, or the site isn't in Chrome's cache) the letter chip stays.
 *  Call hydrateProductIcons() after the rows are in the DOM. */
function productIconHTML(p?: ProductItem): string {
  const n = (p?.name || "").trim();
  const ch = (n[0] || "✦").toUpperCase();
  let h = 0; for (let i = 0; i < n.length; i++) h = (h * 31 + n.charCodeAt(i)) >>> 0;
  const bg = n ? `hsl(${h % 360} 55% 42%)` : "#5a4a36";
  const style = `flex:0 0 auto;width:16px;height:16px;border-radius:4px;display:inline-flex;align-items:center;justify-content:center;font-size:9px;font-weight:700;color:#fff;overflow:hidden;background:${bg}`;
  let favAttr = "";
  const url = (p?.url || "").trim();
  if (url && !/^(javascript|data|blob|vbscript):/i.test(url)) {
    try {
      const norm = url.startsWith("http") ? url : `https://${url}`;
      if (new URL(norm).hostname) favAttr = ` data-fav="${esc(chrome.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent(norm)}&size=32`))}"`;
    } catch { /* no usable URL — letter chip only */ }
  }
  return `<span class="picon"${favAttr} style="${style}">${esc(ch)}</span>`;
}

/** Upgrade letter chips to real favicons wherever Chrome has one cached. Idempotent
 *  (each chip is wired at most once); on load failure the letter chip is left alone. */
function hydrateProductIcons(): void {
  document.querySelectorAll<HTMLElement>("span.picon[data-fav]").forEach((el) => {
    const fav = el.getAttribute("data-fav"); el.removeAttribute("data-fav");
    if (!fav) return;
    const img = new Image();
    img.onload = () => { el.textContent = ""; el.style.background = "transparent"; img.style.cssText = "width:16px;height:16px;object-fit:contain;display:block"; el.appendChild(img); };
    img.src = fav;
  });
}
/** One editable product row: separate Name / URL / Description fields. */
function productRow(p?: ProductItem): string {
  const ist = "width:100%;box-sizing:border-box;background:var(--row);border:.5px solid var(--line-strong);border-radius:8px;color:var(--t1);padding:7px;font-family:inherit;font-size:12px;outline:none";
  return `<div class="prodrow" style="border:.5px solid var(--line-strong);border-radius:10px;padding:8px;margin-bottom:8px">
    <div style="display:flex;gap:6px;align-items:center">
      ${productIconHTML(p)}
      <input class="pname" aria-label="Product name" placeholder="Product name" value="${esc(p?.name ?? "")}" style="${ist}"/>
      <button data-action="del-product" title="Remove product" aria-label="Remove product" style="flex:0 0 auto;background:none;border:0;color:#b6a892;font-size:14px;cursor:pointer;padding:7px">✕</button>
    </div>
    <input class="purl" aria-label="Product URL" placeholder="https://yourproduct.com (optional)" value="${esc(p?.url ?? "")}" style="${ist};margin-top:6px"/>
    <input class="pdesc" aria-label="Product description" placeholder="One-liner: what it does, who it's for" value="${esc(p?.blurb ?? "")}" style="${ist};margin-top:6px"/>
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
/** Human data size for the Twttr budget meter ("142 MB", "1.84 GB"). */
function fmtData(bytes: number): string {
  const mb = bytes / 1048576;
  return mb < 1024 ? `${mb.toFixed(mb < 10 ? 1 : 0)} MB` : `${(mb / 1024).toFixed(2)} GB`;
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
  xConsent: boolean;
  xEnabled: boolean;
  xNiche: string;
  xVoice: string;
  xSoul: string;
  dailyGoals: DailyGoals;
  products: ProductItem[];
  xDefaultAngle: string;
  xDefaultProduct: string;
  xInsertEnabled: boolean;
  twttrKey: string;
  xMyHandle: string;
  xPremium: string;
  twttrMeter: { requests: number; bytes: number } | null;
  replyStats: { today: number; week: number; total: number; days: { label: string; count: number; today: boolean }[] };
  safety: { level: RepLevel; label: string; repliesThisHour: number; accountsToday: number };
  todaySent: string[]; // snippets of today's sent replies — the playground treats
  signals: { measureDay: string; settled: number; fitN: number; backs: number; inboundN: number; inboundAgeD: number | null; ownAgeH: number | null; profileAgeD: number | null; reachN: number; heavyN: number } | null;
}

/** Local YYYY-MM-DD — must match the content script's dayKey() so the popup reads
 *  the same per-day buckets. */
function dayKeyOf(ts: number): string {
  const d = new Date(ts); const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function computeReplyStats(daily: Record<string, number>, total: number): ViewData["replyStats"] {
  const now = Date.now(), DAY = 86_400_000, lab = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
  const days: { label: string; count: number; today: boolean }[] = [];
  let week = 0;
  for (let i = 6; i >= 0; i--) {
    const ts = now - i * DAY, c = daily[dayKeyOf(ts)] || 0;
    week += c;
    days.push({ label: lab[new Date(ts).getDay()], count: c, today: i === 0 });
  }
  return { today: daily[dayKeyOf(now)] || 0, week, total: total || 0, days };
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
  xConsent: false,
  xEnabled: false,
  xNiche: "",
  xVoice: "",
  xSoul: "",
  dailyGoals: DEFAULT_DAILY_GOALS,
  products: [],
  xDefaultAngle: "",
  xDefaultProduct: "",
  xInsertEnabled: true,
  twttrKey: "",
  xMyHandle: "",
  xPremium: "",
  twttrMeter: { requests: 1240, bytes: 142 * 1024 * 1024 },
  signals: null,
  replyStats: { today: 7, week: 35, total: 142, days: [
    { label: "Mo", count: 5, today: false }, { label: "Tu", count: 3, today: false },
    { label: "We", count: 8, today: false }, { label: "Th", count: 4, today: false },
    { label: "Fr", count: 6, today: false }, { label: "Sa", count: 2, today: false },
    { label: "Su", count: 7, today: true },
  ] },
  safety: { level: "healthy", label: "healthy pace", repliesThisHour: 6, accountsToday: 5 },
  todaySent: ["Retention beats acquisition — the cost is already sunk", "Ship daily, measure weekly", "WhatsApp groups are underrated for GTM"],
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

  const store = await chrome.storage.local.get([CONFIG.ARCHIVE_KEY, CONFIG.SMART_ENABLED_KEY, CONFIG.AUTO_DEDUPE_KEY, CONFIG.ANTHROPIC_KEY_KEY, CONFIG.X_COPILOT_KEY, CONFIG.X_DATA_CONSENT_KEY, CONFIG.X_NICHE_KEY, CONFIG.X_VOICE_KEY, CONFIG.X_SOUL_KEY, CONFIG.X_DAILY_GOALS_KEY, CONFIG.X_PRODUCT_KEY, CONFIG.X_PRODUCTS_KEY, CONFIG.X_DEFAULT_ANGLE_KEY, CONFIG.X_DEFAULT_PRODUCT_KEY, CONFIG.X_REPLY_INSERT_KEY, CONFIG.TWTTR_KEY_KEY, CONFIG.X_MY_HANDLE_KEY, CONFIG.X_PREMIUM_KEY, CONFIG.X_REPLY_LOG_KEY, CONFIG.X_LEARN_STATS_KEY, CONFIG.X_SUPPORTERS_KEY, CONFIG.X_PROFILE_KEY, CONFIG.X_MY_POSTS_KEY, CONFIG.X_AUTHOR_REACH_KEY, CONFIG.X_HEAVY_HITTERS_KEY]);
  const productsArr = (store[CONFIG.X_PRODUCTS_KEY] as ProductItem[]) || [];
  const archive = store[CONFIG.ARCHIVE_KEY] as unknown[] | undefined;
  const log = store[CONFIG.X_REPLY_LOG_KEY] as { daily?: Record<string, number>; total?: number; times?: number[]; sent?: { at: number; author?: string; snippet?: string; score?: number; outcome?: { likes?: number; replies?: number; authorReplied?: boolean } }[] } | undefined;
  const dailySum = log?.daily ? Object.values(log.daily).reduce((a, b) => a + (b || 0), 0) : 0;
  const replyStats = computeReplyStats(log?.daily || {}, log?.total ?? dailySum);
  const repliesThisHour = (log?.times || []).filter((t) => now - t < 3_600_000).length;
  const midnight = new Date(now); midnight.setHours(0, 0, 0, 0);
  const sentToday = (log?.sent || []).filter((s) => s.at >= midnight.getTime());
  const accountsToday = new Set(sentToday.filter((s) => s.author).map((s) => s.author)).size;
  const todaySent = sentToday.filter((s) => s.snippet).map((s) => s.snippet as string).slice(-30);
  const safety = { ...reputationStatus(repliesThisHour), repliesThisHour, accountsToday };

  let twttrMeter: { requests: number; bytes: number } | null = null;
  if (store[CONFIG.TWTTR_KEY_KEY]) {
    try { twttrMeter = await send<{ requests: number; bytes: number }>({ type: "GET_TWTTR_METER" }); } catch { twttrMeter = null; }
  }

  return {
    smart: Boolean(store[CONFIG.SMART_ENABLED_KEY]),
    pressure,
    mem,
    idleCount: archivableTabs(tabs, now).length,
    groups,
    archivedCount: archive?.length ?? 0,
    dedupe: store[CONFIG.AUTO_DEDUPE_KEY] !== false,
    hasKey: Boolean(store[CONFIG.ANTHROPIC_KEY_KEY]),
    xConsent: store[CONFIG.X_DATA_CONSENT_KEY] === "v1",
    xEnabled: store[CONFIG.X_DATA_CONSENT_KEY] === "v1" && Boolean(store[CONFIG.ANTHROPIC_KEY_KEY]) && store[CONFIG.X_COPILOT_KEY] !== false,
    xNiche: (store[CONFIG.X_NICHE_KEY] as string) || "",
    xVoice: (store[CONFIG.X_VOICE_KEY] as string) || "",
    xSoul: normalizeSoul(store[CONFIG.X_SOUL_KEY]),
    dailyGoals: normalizeDailyGoals(store[CONFIG.X_DAILY_GOALS_KEY]),
    products: productsArr.length ? productsArr : (store[CONFIG.X_PRODUCT_KEY] ? [{ name: "", blurb: store[CONFIG.X_PRODUCT_KEY] as string }] : []),
    xDefaultAngle: (store[CONFIG.X_DEFAULT_ANGLE_KEY] as string) || "",
    xDefaultProduct: (store[CONFIG.X_DEFAULT_PRODUCT_KEY] as string) || "",
    xInsertEnabled: store[CONFIG.X_REPLY_INSERT_KEY] !== false,
    twttrKey: (store[CONFIG.TWTTR_KEY_KEY] as string) || "",
    xMyHandle: (store[CONFIG.X_MY_HANDLE_KEY] as string) || "",
    xPremium: (store[CONFIG.X_PREMIUM_KEY] as string) || "",
    twttrMeter,
    replyStats,
    safety,
    todaySent,
    signals: (() => {
      // Signal health: the honest gates make panels legitimately QUIET — this makes the silence
      // inspectable (how much data each learner has, how fresh each harvest is) so "quiet" and
      // "broken" stop looking identical.
      const sent = log?.sent ?? [];
      const measured = sent.filter((r) => r.outcome && (r.outcome.likes != null || r.outcome.replies != null));
      const learnS = store[CONFIG.X_LEARN_STATS_KEY] as { measureDay?: string } | undefined;
      const inboundArr = (store[CONFIG.X_SUPPORTERS_KEY] as { at: number }[] | undefined) ?? [];
      const prof = store[CONFIG.X_PROFILE_KEY] as { at?: number } | undefined;
      const own = store[CONFIG.X_MY_POSTS_KEY] as { at?: number } | undefined;
      const reach = store[CONFIG.X_AUTHOR_REACH_KEY] as Record<string, unknown> | undefined;
      const heavy = store[CONFIG.X_HEAVY_HITTERS_KEY] as { entries?: Record<string, unknown> } | undefined;
      const now = Date.now(), DAY = 86_400_000;
      const lastInbound = inboundArr.length ? Math.max(...inboundArr.map((e) => e.at)) : null;
      return {
        measureDay: learnS?.measureDay || "never",
        settled: measured.length,
        fitN: measured.filter((r) => r.score != null).length,
        backs: sent.filter((r) => r.outcome?.authorReplied).length,
        inboundN: inboundArr.length,
        inboundAgeD: lastInbound ? Math.round((now - lastInbound) / DAY) : null,
        ownAgeH: own?.at ? Math.round((now - own.at) / 3_600_000) : null,
        profileAgeD: prof?.at ? Math.round((now - prof.at) / DAY) : null,
        reachN: reach ? Object.keys(reach).length : 0,
        heavyN: heavy?.entries ? Object.keys(heavy.entries).length : 0,
      };
    })(),
  };
}

/** "Replies sent" showcase — totals + a 7-day trend. Pure read of the per-day
 *  tally (no API). The "what's working" panel comes once the measure pass lands. */
function replyShowcaseHTML(s: ViewData["replyStats"]): string {
  const max = Math.max(1, ...s.days.map((d) => d.count));
  const bars = s.days.map((d) => {
    const h = Math.max(2, Math.round((d.count / max) * 52));
    const fill = d.count ? (d.today ? "var(--green)" : "var(--brand)") : "var(--line-strong)";
    return `<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:4px">
      <div title="${d.count} on ${esc(d.label)}" style="width:100%;height:${h}px;background:${fill};border-radius:3px 3px 0 0"></div>
      <div style="font-size:11px;color:${d.today ? "var(--green)" : "var(--t3)"}">${esc(d.label)}</div>
    </div>`;
  }).join("");
  const tile = (n: number, l: string) =>
    `<div style="flex:1;background:var(--row);border-radius:9px;padding:9px 10px">
      <div style="font-size:21px;font-weight:500;line-height:1">${n}</div>
      <div style="font-size:10.5px;color:var(--t3);margin-top:3px">${l}</div></div>`;
  const hint = s.total ? "" : `<div class="dim" style="font-size:10.5px;margin-top:8px">Draft a reply, post it on X, then confirm it in Goobi — your count starts there.</div>`;
  return `<div class="li" style="display:block">
    <div class="name" style="margin-bottom:8px">Replies sent <span class="dim" style="font-weight:400">— how the copilot is helping</span></div>
    <div style="display:flex;gap:8px">${tile(s.today, "today")}${tile(s.week, "this week")}${tile(s.total, "all time")}</div>
    <div style="display:flex;align-items:flex-end;gap:7px;height:64px;margin-top:10px">${bars}</div>
    ${hint}
  </div>`;
}

/** "Account safety" — surfaces the reputation/anti-spam protection so it's a
 *  visible feature, not silent plumbing. Reads the same numbers the nudges use. */
/** "Signal health" — why the honest panels are quiet, in numbers: each learner's data volume,
 *  each harvest's freshness, and the distance to the gates that unlock measured claims. */
function signalHealthHTML(g: ViewData["signals"]): string {
  if (!g) return "";
  const row = (k: string, v: string, hint: string) => `<div style="display:flex;justify-content:space-between;gap:8px;font-size:11px;padding:2px 0" title="${k}"><span class="dim">${k}</span><span style="color:var(--t1);text-align:right">${v}${hint ? ` <span class="dim">${hint}</span>` : ""}</span></div>`;
  const today = dayKeyOf(Date.now());
  return `<div class="li" style="display:block">
    <div class="name" style="margin-bottom:4px">Signal health <span class="dim" style="font-weight:400">— why quiet panels are quiet</span></div>
    ${row("Outcome measure pass", g.measureDay === today ? "ran today ✓" : g.measureDay === "never" ? "never" : g.measureDay, g.measureDay === "never" ? "(needs the RapidAPI key + a dock open)" : "")}
    ${row("Measured reply outcomes", String(g.settled), `(fit-validity check unlocks at 12 — ${Math.min(g.fitN, 12)}/12)`)}
    ${row("↩ Engaged-back credits", String(g.backs), g.inboundN ? "" : "(visit /notifications to feed this)")}
    ${row("Notifications harvest", g.inboundN ? `${g.inboundN} events` : "empty", g.inboundAgeD != null ? `(last ${g.inboundAgeD === 0 ? "today" : `${g.inboundAgeD}d ago`})` : "(visit your notifications page)")}
    ${row("Own-posts cache", g.ownAgeH != null ? `${g.ownAgeH}h old` : "empty", g.ownAgeH == null ? "(open the dock on x.com)" : "")}
    ${row("Profile-coach harvest", g.profileAgeD != null ? `${g.profileAgeD === 0 ? "today" : `${g.profileAgeD}d ago`}` : "never", g.profileAgeD == null ? "(visit your own profile once)" : "")}
    ${row("Coverage caches", `${g.reachN} authors · ${g.heavyN} heavy hitters`, "")}
    <div class="dim" style="font-size:10px;margin-top:5px">Every learner stays silent below its min-N gate rather than guessing — these numbers are the distance to each gate.</div>
  </div>`;
}

function accountSafetyHTML(s: ViewData["safety"]): string {
  const HEX: Record<RepLevel, string> = { healthy: "#4fae6a", caution: "#e89a3c", easeoff: "#d6604a" };
  const CAP: Record<RepLevel, string> = { healthy: "Healthy", caution: "Caution", easeoff: "Ease off" };
  const SUB: Record<RepLevel, string> = {
    healthy: "Keep replies specific, varied, and relevant to real conversations.",
    caution: "Goobi's conservative pace guard is approaching — slow down and favor warm conversations.",
    easeoff: "Goobi's hourly guard is reached — take a real break before replying more.",
  };
  const c = HEX[s.level];
  const pacePct = Math.min(100, Math.round((s.repliesThisHour / REPLY_HARD_PER_HOUR) * 100));
  const cautionPct = Math.round((REPLY_SOFT_PER_HOUR / REPLY_HARD_PER_HOUR) * 100);
  // Emoji glyphs (no icon font is bundled, so Tabler <i class="ti …"> rendered as tofu).
  const row = (icon: string, color: string, title: string, detail: string, extra = "") =>
    `<div style="display:flex;align-items:flex-start;gap:10px;padding:9px 0;border-top:.5px solid var(--line)">
      <span style="flex:0 0 auto;width:24px;height:24px;border-radius:6px;background:${color}24;display:inline-flex;align-items:center;justify-content:center;font-size:13px" aria-hidden="true">${icon}</span>
      <div style="flex:1"><div style="font-size:12px;font-weight:500;color:var(--t1)">${title}</div><div style="font-size:10.5px;color:var(--t3);margin-top:2px;line-height:1.35">${detail}</div>${extra}</div>
    </div>`;
  const bar = `<div style="height:5px;border-radius:3px;background:var(--row);margin-top:6px;position:relative;overflow:hidden">
    <div style="height:100%;width:${pacePct}%;background:${c};border-radius:3px"></div>
    <div style="position:absolute;top:-2px;bottom:-2px;left:${cautionPct}%;width:1.5px;background:var(--t3)" title="Goobi's caution line (${REPLY_SOFT_PER_HOUR}/hr)"></div></div>`;
  return `<div class="li" style="display:block">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:5px">
      <div class="name">Account safety</div>
      <span style="font-size:10.5px;font-weight:500;color:${c};background:${c}24;padding:3px 9px;border-radius:999px">● ${CAP[s.level]}</span>
    </div>
    <div style="font-size:10.5px;color:var(--t3);line-height:1.4">${SUB[s.level]}</div>
    ${row("⏱️", c, "Reply pace", `${s.repliesThisHour} in the last hour · Goobi pauses at ${REPLY_HARD_PER_HOUR}/hr; X publishes no guaranteed safe rate`, bar)}
    ${row("👥", "#4fae6a", "Spread across accounts", `${s.accountsToday} different ${s.accountsToday === 1 ? "account" : "accounts"} today, not hammering one thread`)}
    ${row("✅", "#4fae6a", "Replies stay clean", "Civil tone, no copy-paste duplicates — the two things X deboosts hardest")}
    ${row("🖐️", "#c68a4e", "You stay in control", "Like + insert fills the selected reply box after your click; copy + open is optional. Goobi never auto-submits.")}
  </div>`;
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
    return `<div class="li"><div class="grow"><div class="name">Anthropic key</div><div class="sub">✓ stored locally · calls Anthropic directly</div></div><button class="act danger" data-action="clear-key">Remove</button></div>`;
  }
  return `<div class="li" style="display:block"><label class="field" for="keyinput">Anthropic key <span class="field-hint">— required for Smart</span></label>
    <div class="input-action"><input class="control" id="keyinput" type="password" placeholder="sk-ant-..." autocomplete="off"/><button class="btn" data-action="save-key">Save</button></div></div>`;
}

let expanded = false;
type PanelTab = "tabs" | "x";
// The X copilot is the product today; the tab manager remains available as the
// secondary surface. Starting on Tabs made the first-run path contradict that.
let activeTab: PanelTab = "x";
let playground = false;                 // Goobi's playground screen (click the mascot to open)
let pgGoobi: GoobiHandle | null = null; // the big playground Goobi
let pgTotal = 0;                        // treats to feed = replies sent today

/** Goobi's playground — feed him today's replies (one treat each) and pet him. */
function renderPlayground(d: ViewData): string {
  const n = d.replyStats.today;
  const treats = Array.from({ length: n }, (_, i) => d.todaySent[i] || "a reply you sent");
  const treatsHtml = treats.length
    ? treats.map((s) => `<button class="pg-treat" data-action="pg-feed" data-snip="${esc(s)}" title="${esc(s)}" aria-label="Feed a treat"></button>`).join("")
    : `<div class="dim" style="font-size:12px;text-align:center">No treats yet — reply to a post and Goobi gets a snack.</div>`;
  return `
  <button class="pg-back" data-action="pg-close">‹ Back</button>
  <div class="pg-stage" role="button" tabindex="0" data-action="pg-pet" title="Tap to pet Goobi" aria-label="Pet Goobi">
    <div class="pg-shadow"></div>
    <div id="goobi-pg"></div>
  </div>
  <div class="pg-msg" id="pg-msg" role="status" aria-live="polite">${n ? "Feed Goobi today's replies — tap a treat." : "Reply to a post and come feed Goobi."}</div>
  <div class="pg-meter" role="progressbar" aria-label="Goobi's belly" aria-valuemin="0" aria-valuemax="${n}" aria-valuenow="0"><div class="pg-fill" id="pg-fill" style="width:0%"></div></div>
  <div class="pg-meterlbl"><span>Goobi's belly</span><span id="pg-count">0 / ${n}</span></div>
  <div class="pg-treats" id="pg-treats">${treatsHtml}</div>
  <div class="dim" style="font-size:11px;text-align:center;margin-top:12px">Tap Goobi to pet him · ${n} ${n === 1 ? "reply" : "replies"} today</div>`;
}

function render(d: ViewData): string {
  if (playground) return renderPlayground(d);
  const all = d.groups;
  const shown = expanded ? all : all.slice(0, 3);
  const groupsList = shown.length
    ? `<div class="list">${shown.map(groupRow).join("")}</div>`
    : `<div class="list"><div class="empty">No groups yet — hit “Group ${d.smart ? "with Claude" : "by site"}”.</div></div>`;
  const groupCount = !expanded && all.length > 3 ? `3 of ${all.length} groups` : `${all.length} group${all.length === 1 ? "" : "s"}`;
  const expandRow = all.length > 3
    ? `<button class="btn" data-action="${expanded ? "collapse" : "expand"}" style="width:100%;margin-top:8px">${expanded ? "Collapse" : `Expand · view all ${all.length} groups`}</button>`
    : "";
  const setupReady = d.hasKey && d.xConsent && !!d.xNiche.trim();
  return `
  <header class="row-flex between">
    <div class="row-flex gap10"><button class="sq" id="goobi-face" data-action="open-playground" aria-label="Open Goobi's playground" title="Open Goobi's playground">${ICON.layout}</button><div class="wordmark"><div class="brand">Goobi</div><div class="tagline">Find the right words on X.</div></div></div>
    <span class="pill"><span class="dot" style="background:${d.xEnabled && setupReady ? "var(--green)" : "var(--t3)"}"></span>${!d.xEnabled ? "X copilot off" : setupReady ? "Ready for X" : "Finish setup"}</span>
  </header>

  <div class="vtabs" role="tablist" aria-label="Goobi tools">
    <button class="vtab${activeTab === "tabs" ? " on" : ""}" id="tab-tabs" role="tab" aria-selected="${activeTab === "tabs"}" aria-controls="view-tabs" data-action="switch-tab" data-tab="tabs">Tab tools</button>
    <button class="vtab${activeTab === "x" ? " on" : ""}" id="tab-x" role="tab" aria-selected="${activeTab === "x"}" aria-controls="view-x" data-action="switch-tab" data-tab="x">X replies</button>
  </div>

  <div id="view-tabs" role="tabpanel" aria-labelledby="tab-tabs"${activeTab === "tabs" ? "" : " hidden"}>
  <label class="sr-only" for="q">Search tabs, archive and history</label><div class="search" style="margin-top:12px">${ICON.search}<input id="q" placeholder="Search tabs, archive &amp; history…" autocomplete="off"/><span class="kbd">↵ search</span></div>

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
    <div class="li"><div class="grow"><div class="name">Claude grouping &amp; cleanup</div><div class="sub">opt in to AI grouping, suggestions, and archive search</div></div>
      <label class="switch"><input type="checkbox" id="smart" aria-label="Use Claude for tab grouping and cleanup" ${d.smart ? "checked" : ""}/><span class="track"><span class="knob"></span></span></label></div>
    <div class="li"><div class="grow"><div class="name">Auto-merge duplicate tabs</div><div class="sub">switch to the open tab instead of a copy</div></div>
      <label class="switch"><input type="checkbox" id="dedupe" aria-label="Auto-merge duplicate tabs" ${d.dedupe ? "checked" : ""}/><span class="track"><span class="knob"></span></span></label></div>
    ${d.smart ? keyRow(d) : ""}
  </div>

  <div class="footer-actions">
    <button class="btn" data-action="archived">${ICON.archive} Archived (${d.archivedCount})</button>
    <button class="btn" data-action="undo">${ICON.undo} Undo</button>
  </div>
  <div class="note">${ICON.lock}<div>RAM is system-wide (per-process detail lives in the <code>tb</code> CLI). Smart features are opt-in and send page titles + URLs to Claude — search also includes recent history.</div></div>
  </div>

  <div id="view-x" role="tabpanel" aria-labelledby="tab-x"${activeTab === "x" ? "" : " hidden"}>
  <div class="sec"><h2>X reply copilot</h2><label class="switch" title="${d.xConsent ? "Turn the X copilot on or off" : "Review and accept the data disclosure first"}"><input type="checkbox" id="xon" aria-label="X reply copilot" ${d.xEnabled ? "checked" : ""} ${d.xConsent ? "" : "disabled"}/><span class="track"><span class="knob"></span></span></label></div>
  <div class="setup">
    <div class="setup-title">${setupReady ? "You're ready to find a good conversation" : "Set up your reply copilot"}</div>
    <div class="setup-sub">${setupReady ? "Open x.com, then open Goobi to find and draft worthwhile replies. You always review and post yourself." : d.hasKey ? "Tell Goobi which conversations matter to you. Voice examples are helpful, but optional." : "First, connect Claude for scoring and drafting. Your key stays in this browser and calls Anthropic directly."}</div>
    ${d.xConsent ? "" : `<div class="data-disclosure"><b>Before Goobi reads X</b>While the copilot is on, public post text and author handles are sent to Anthropic automatically as you scroll so Goobi can score reply opportunities. Reply drafts and Ideas send the selected public content plus your voice, SOUL.md, and context only when you click; DMs send the selected voice and conversation context, not SOUL.md. Optional X-data features send handles and search queries to RapidAPI. Activity, drafts, DM notes, goals, SOUL.md, and growth history stay in Chrome local storage; Goobi has no analytics or production server.<label class="data-consent"><input type="checkbox" id="xdataconsent"/> <span>I agree to this data use.</span></label>${d.hasKey ? `<button class="btn primary" data-action="accept-x-data" style="margin-top:9px">Agree and enable</button>` : ""}</div>`}
    ${d.hasKey ? `<div class="ready-line"><span class="ready-check">✓ Anthropic key stored</span><button class="act danger" data-action="clear-key">Remove key</button></div>` : `<label class="field" for="xkeyinput" style="margin-top:12px">Anthropic API key</label><div class="input-action"><input class="control" id="xkeyinput" type="password" placeholder="sk-ant-..." autocomplete="off" aria-describedby="xkeyhelp"/><button class="btn primary" data-action="save-x-key">Save key</button></div><div class="field-hint" id="xkeyhelp" style="display:block;margin-top:6px">Stored locally in Chrome. Goobi never sends it to its own server.</div>`}
    <div class="setup-steps">
      <div class="setup-step${d.hasKey && d.xConsent ? " done" : ""}">${d.hasKey && d.xConsent ? "✓" : "1"} Connect + agree</div>
      <div class="setup-step${d.xNiche.trim() ? " done" : ""}">${d.xNiche.trim() ? "✓" : "2"} Set your focus</div>
      <div class="setup-step${d.xVoice.trim() || d.xSoul.trim() ? " done" : ""}">${d.xVoice.trim() || d.xSoul.trim() ? "✓" : "3"} Voice + soul <span aria-hidden="true">·</span> optional</div>
    </div>
  </div>
  <details class="fold profile-fold"${setupReady ? "" : " open"}>
    <summary>${setupReady ? "Edit focus, voice &amp; SOUL.md" : "Complete your profile"} <span class="field-hint">${d.xSoul.trim() ? "creative brief saved" : "voice and soul are optional"}</span></summary>
  <div class="list">
    <div class="li" style="display:block">
      <label class="field" for="xniche">Your focus <span class="field-hint">— topics and conversations to find</span></label>
      <textarea class="control" id="xniche" rows="2" placeholder="AI SaaS, indie founders, practical build lessons…">${esc(d.xNiche)}</textarea>
    </div>
    <div class="li" style="display:block">
      <label class="field" for="xvoice">Your reply voice <span class="field-hint">— optional tone notes or 2–3 examples</span></label>
      <textarea class="control" id="xvoice" rows="3" placeholder="Paste replies you're proud of, or describe your tone…">${esc(d.xVoice)}</textarea>
    </div>
    <div class="li" style="display:block">
      <label class="field" for="xsoul">Your SOUL.md <span class="field-hint">— what you believe, know, return to, and refuse to sound like</span></label>
      <textarea class="control soul-control" id="xsoul" rows="9" maxlength="6000" spellcheck="true" placeholder="# What I believe&#10;- Specific beats polished&#10;&#10;# What I have earned the right to talk about&#10;- …">${esc(d.xSoul)}</textarea>
      <div class="soul-foot"><span>Voice controls style. SOUL.md supplies your point of view and creative boundaries.</span><button class="act" data-action="soul-template">${d.xSoul.trim() ? "Replace with template" : "Start with template"}</button></div>
    </div>
    <div class="li" style="display:block">
      <div class="field">Daily goals <span class="field-hint">— zero turns a goal off</span></div>
      <div class="goal-inputs">
        <label><span>Replies</span><input class="control" id="xgoalreplies" type="number" min="0" max="30" inputmode="numeric" value="${d.dailyGoals.replies}"/></label>
        <label><span>Posts</span><input class="control" id="xgoalposts" type="number" min="0" max="5" inputmode="numeric" value="${d.dailyGoals.posts}"/></label>
        <label><span>DM people</span><input class="control" id="xgoaldms" type="number" min="0" max="5" inputmode="numeric" value="${d.dailyGoals.dms}"/></label>
      </div>
      <div class="field-hint" style="margin-top:7px">The X dock counts verified replies, detected/marked posts, and unique people you explicitly mark as DM'd. Safety limits still win over goals.</div>
      <button class="btn primary" data-action="save-x" style="margin-top:10px">${setupReady ? "Save changes" : "Save profile"}</button>
    </div>
  </div>
  </details>

  <details class="fold">
    <summary>Optional personalization <span class="field-hint">products &amp; draft defaults</span></summary>
    <div class="list">
    <div class="li"><div class="grow"><div class="name">Like + insert reply</div><div class="sub">On your click, like the selected post and fill X's reply box. You still review and submit it.</div></div>
      <label class="switch"><input type="checkbox" id="xinsert" aria-label="Like the post and insert the reply into X" ${d.xInsertEnabled ? "checked" : ""}/><span class="track"><span class="knob"></span></span></label></div>
    <div class="li" style="display:block">
      <div class="field">Your products <span class="field-hint">— name, link &amp; a one-liner each</span></div>
      <div id="prodrows">${(d.products.length ? d.products : [undefined]).map((p) => productRow(p)).join("")}</div>
      <button class="btn" data-action="add-product" style="padding:6px 11px;font-size:12px">+ Add product</button>
      <div class="field-hint" style="margin-top:6px">On a “drop your product” post, the copilot tags the best-fit product and drafts with it.</div>
    </div>
    <div class="li" style="display:block">
      <div class="field">Draft defaults <span class="field-hint">— what each draft opens with</span></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <label class="sr-only" for="xdefangle">Default reply angle</label><select class="control" id="xdefangle" style="flex:1;min-width:130px">
          <option value="">Angle: Auto (per post)</option>
          ${REPLY_ANGLES.map((a) => `<option value="${a.id}" ${d.xDefaultAngle === a.id ? "selected" : ""}>Angle: ${esc(a.label)}</option>`).join("")}
        </select>
        ${d.products.some((p) => p.name) ? `<label class="sr-only" for="xdefproduct">Default product</label><select class="control" id="xdefproduct" style="flex:1;min-width:130px">
          <option value="">Product: Auto (best fit)</option>
          ${d.products.filter((p) => p.name).map((p) => `<option value="${esc(p.name)}" ${d.xDefaultProduct === p.name ? "selected" : ""}>Product: ${esc(p.name)}</option>`).join("")}
        </select>` : ""}
      </div>
    </div>
    </div>
  </details>

  <details class="fold">
    <summary>X data features <span class="field-hint">optional · reach, search &amp; learning</span></summary>
    <div class="list">
    <div class="li" style="display:block">
      <label class="field" for="twttrkey">RapidAPI key <span class="field-hint">— for reach, search &amp; voice learning</span></label>
      <input class="control" id="twttrkey" type="password" autocomplete="off" placeholder="${d.twttrKey ? "Stored — leave blank to keep, or paste a new key" : "x-rapidapi-key from RapidAPI"}" value=""/>
      ${d.twttrKey ? `<div class="dim" style="font-size:10.5px;margin-top:4px;color:var(--green)">✓ Key stored. The field stays blank for safety — leave it blank to keep the saved key.</div>` : ""}
      <div class="dim" style="font-size:10.5px;margin-top:6px">Uses a third-party X data provider (twitter241 on RapidAPI), not X's official API. Programmatic X data access is outside X's API terms, so opt in knowingly. Stays off until you add a key.</div>
      ${d.twttrMeter ? `<div class="dim" style="font-size:10.5px;margin-top:6px">This month: <b style="color:var(--t1)">${fmtData(d.twttrMeter.bytes)}</b> / 10 GB · ${d.twttrMeter.requests.toLocaleString()} / 100k requests</div>` : ""}
    </div>
    <div class="li" style="display:block">
      <label class="field" for="xmyhandle">Your X handle <span class="field-hint">— for reach ranking &amp; voice learning</span></label>
      <div class="input-action">
        <input class="control" id="xmyhandle" placeholder="@yourhandle" value="${esc(d.xMyHandle)}"/>
        <button class="btn" data-action="learn-voice">Learn my voice</button>
      </div>
      <div class="dim" style="font-size:10.5px;margin-top:6px">Reads your recent replies (needs the RapidAPI key above) and fills the voice box in setup. Also sizes the “in reach” tag on the dock.</div>
      <div style="display:flex;align-items:center;gap:8px;margin-top:8px">
        <label class="field-hint" for="xpremium" style="white-space:nowrap">X Premium tier</label>
        <select class="control" id="xpremium" style="flex:1">
          <option value="" ${d.xPremium === "" ? "selected" : ""}>(not set)</option>
          <option value="free" ${d.xPremium === "free" ? "selected" : ""}>Free</option>
          <option value="premium" ${d.xPremium === "premium" ? "selected" : ""}>Premium</option>
          <option value="premium+" ${d.xPremium === "premium+" ? "selected" : ""}>Premium+</option>
        </select>
      </div>
      <div class="dim" style="font-size:10.5px;margin-top:4px">An honest context flag — never changes any score. External data shows tier is the largest reach covariate, so Goobi factors it into its coaching copy only.</div>
    </div>
    </div>
  </details>

  <details class="fold"${d.safety.level !== "healthy" ? " open" : ""}>
    <summary>Progress &amp; account safety <span class="field-hint">${d.replyStats.week} replies this week · ${esc(d.safety.label)}</span></summary>
    <div class="list">${replyShowcaseHTML(d.replyStats)}${accountSafetyHTML(d.safety)}</div>
  </details>

  <details class="fold">
    <summary>Data diagnostics <span class="field-hint">why learning panels may be quiet</span></summary>
    <div class="list">${signalHealthHTML(d.signals)}</div>
  </details>
  <div class="note" style="margin-top:6px">${ICON.lock}<div>On x.com, timeline text is sent to Claude to score &amp; draft. Like + insert may fill X's reply box after your click, but Goobi never submits or posts for you.</div></div>
  </div>`;
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
  const d = await getData();
  app.innerHTML = render(d);
  if (playground) {
    pgTotal = d.replyStats.today;
    const stage = document.getElementById("goobi-pg");
    if (stage) { pgGoobi = mountGoobi(stage, { cell: 4, playful: true }); pgGoobi.setMood("idle"); }
    return;
  }
  hydrateProductIcons();
  const face = document.getElementById("goobi-face");
  if (face) mountGoobi(face).setMood(d.safety.level === "easeoff" ? "worn" : "idle"); // header Goobi mirrors your pace
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

/** Best-effort: resolve the user's own follower count and store it, so the
 *  on-page dock can size the "in reach" sweet-spot. Never throws. */
async function resolveMyFollowers(handle: string): Promise<void> {
  try {
    const res = await send<{ ok?: boolean; data?: unknown }>({ type: "TWTTR_GET", path: "user", query: { username: handle }, intent: true });
    const u = res?.ok ? parseUser(res.data) : null;
    if (u) await chrome.storage.local.set({ [CONFIG.X_MY_FOLLOWERS_KEY]: u.followers });
  } catch { /* best-effort */ }
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
        toast("Key saved — Smart now calls Anthropic directly.");
        break;
      }
      case "save-x-key": {
        const input = document.getElementById("xkeyinput") as HTMLInputElement | null;
        const val = input?.value.trim();
        if (!val) { toast("Paste your Anthropic key first."); return; }
        const consent = document.getElementById("xdataconsent") as HTMLInputElement | null;
        const alreadyConsented = (await chrome.storage.local.get(CONFIG.X_DATA_CONSENT_KEY))[CONFIG.X_DATA_CONSENT_KEY] === "v1";
        if (!alreadyConsented && !consent?.checked) { toast("Review the X data disclosure and agree before connecting Claude."); return; }
        await chrome.storage.local.set({ [CONFIG.ANTHROPIC_KEY_KEY]: val, [CONFIG.X_DATA_CONSENT_KEY]: "v1", [CONFIG.X_COPILOT_KEY]: true });
        await refresh();
        toast("Claude connected — set your focus, then reload X. Voice is optional.");
        break;
      }
      case "accept-x-data": {
        const consent = document.getElementById("xdataconsent") as HTMLInputElement | null;
        if (!consent?.checked) { toast("Check the agreement box first."); return; }
        await chrome.storage.local.set({ [CONFIG.X_DATA_CONSENT_KEY]: "v1", [CONFIG.X_COPILOT_KEY]: true });
        await refresh();
        toast("X data use accepted — reload X to start Goobi.");
        break;
      }
      case "clear-key": {
        await chrome.storage.local.remove([CONFIG.ANTHROPIC_KEY_KEY, CONFIG.SMART_ENABLED_KEY]);
        await chrome.storage.local.set({ [CONFIG.X_COPILOT_KEY]: false });
        await refresh();
        toast("Key removed — reload X to stop the copilot on open pages.");
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
      case "switch-tab": {
        activeTab = el.dataset.tab === "x" ? "x" : "tabs";
        document.getElementById("view-tabs")?.toggleAttribute("hidden", activeTab !== "tabs");
        document.getElementById("view-x")?.toggleAttribute("hidden", activeTab !== "x");
        document.querySelectorAll<HTMLElement>(".vtab").forEach((b) => {
          const selected = b.dataset.tab === activeTab;
          b.classList.toggle("on", selected);
          b.setAttribute("aria-selected", String(selected));
        });
        break;
      }
      case "open-playground": { playground = true; await refresh(); break; }
      case "pg-close": { playground = false; await refresh(); break; }
      case "pg-feed": {
        const snip = el.dataset.snip || "a reply you sent";
        const stage = document.querySelector<HTMLElement>(".pg-stage");
        const r = el.getBoundingClientRect();
        el.remove(); // pull it from the row now; the chomp + belly update land when it arrives
        const arrive = () => {
          pgGoobi?.setMood("love"); // heart eyes + floating hearts
          setTimeout(() => pgGoobi?.setMood("idle"), 1500);
          const remaining = document.querySelectorAll("#pg-treats .pg-treat").length;
          const fed = pgTotal - remaining;
          const fill = document.getElementById("pg-fill"); if (fill) fill.style.width = `${pgTotal ? Math.round((fed / pgTotal) * 100) : 0}%`;
          const meter = document.querySelector<HTMLElement>(".pg-meter"); if (meter) meter.setAttribute("aria-valuenow", String(fed));
          const cnt = document.getElementById("pg-count"); if (cnt) cnt.textContent = `${fed} / ${pgTotal}`;
          const msg = document.getElementById("pg-msg");
          if (msg) msg.textContent = remaining === 0 ? "Goobi's stuffed and happy ♥" : `nom! "${snip.length > 38 ? snip.slice(0, 38) + "…" : snip}"`;
        };
        if (stage && typeof (el as HTMLElement).animate === "function" && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
          const sr = stage.getBoundingClientRect();
          const fly = document.createElement("div");
          fly.style.cssText = `position:fixed;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;border-radius:50%;background:radial-gradient(circle at 35% 30%,#f0b07e,#c25e3f);box-shadow:0 1px 3px rgba(0,0,0,.35);z-index:9999;pointer-events:none`;
          document.body.appendChild(fly);
          const dx = sr.left + sr.width / 2 - (r.left + r.width / 2);
          const dy = sr.top + sr.height * 0.6 - (r.top + r.height / 2);
          const a = fly.animate([
            { transform: "translate(0,0) scale(1)", opacity: 1 },
            { transform: `translate(${dx * 0.5}px, ${dy * 0.5 - 34}px) scale(.85)`, opacity: 1, offset: 0.55 },
            { transform: `translate(${dx}px, ${dy}px) scale(.2)`, opacity: 0 },
          ], { duration: 440, easing: "cubic-bezier(.5,0,.6,1)" });
          a.onfinish = () => { fly.remove(); arrive(); };
        } else { arrive(); }
        break;
      }
      case "pg-pet": {
        pgGoobi?.setMood("cheer"); // poppy squish-shimmy
        setTimeout(() => pgGoobi?.setMood("idle"), 1200);
        const msg = document.getElementById("pg-msg"); if (msg) { const lines = ["hehe ♥", "boop!", "that tickles", "♥♥♥"]; msg.textContent = lines[Math.floor(Math.random() * lines.length)]; }
        break;
      }
      case "soul-template": {
        const ta = document.getElementById("xsoul") as HTMLTextAreaElement | null;
        if (!ta) break;
        if (ta.value.trim() && !window.confirm("Replace your current SOUL.md with the starter template?")) break;
        ta.value = SOUL_TEMPLATE; ta.focus(); ta.scrollIntoView({ block: "center" });
        break;
      }
      case "save-x": {
        const niche = (document.getElementById("xniche") as HTMLTextAreaElement | null)?.value ?? "";
        const voice = (document.getElementById("xvoice") as HTMLTextAreaElement | null)?.value ?? "";
        const soul = normalizeSoul((document.getElementById("xsoul") as HTMLTextAreaElement | null)?.value ?? "");
        const dailyGoals = normalizeDailyGoals({
          replies: (document.getElementById("xgoalreplies") as HTMLInputElement | null)?.value,
          posts: (document.getElementById("xgoalposts") as HTMLInputElement | null)?.value,
          dms: (document.getElementById("xgoaldms") as HTMLInputElement | null)?.value,
        });
        const defAngle = (document.getElementById("xdefangle") as HTMLSelectElement | null)?.value ?? "";
        const defProduct = (document.getElementById("xdefproduct") as HTMLSelectElement | null)?.value ?? "";
        const typedKey = ((document.getElementById("twttrkey") as HTMLInputElement | null)?.value ?? "").trim();
        const myHandle = ((document.getElementById("xmyhandle") as HTMLInputElement | null)?.value ?? "").trim().replace(/^@+/, "");
        const premium = (document.getElementById("xpremium") as HTMLSelectElement | null)?.value ?? "";
        const prev = await chrome.storage.local.get([CONFIG.X_MY_HANDLE_KEY, CONFIG.TWTTR_KEY_KEY]);
        const prevHandle = ((prev[CONFIG.X_MY_HANDLE_KEY] as string) || "").toLowerCase();
        const storedKey = (prev[CONFIG.TWTTR_KEY_KEY] as string) || "";
        const set: Record<string, unknown> = { [CONFIG.X_NICHE_KEY]: niche, [CONFIG.X_VOICE_KEY]: voice, [CONFIG.X_SOUL_KEY]: soul, [CONFIG.X_DAILY_GOALS_KEY]: dailyGoals, [CONFIG.X_DEFAULT_ANGLE_KEY]: defAngle, [CONFIG.X_DEFAULT_PRODUCT_KEY]: defProduct, [CONFIG.X_MY_HANDLE_KEY]: myHandle, [CONFIG.X_PREMIUM_KEY]: premium };
        if (typedKey) set[CONFIG.TWTTR_KEY_KEY] = typedKey; // the key field isn't pre-filled, so only overwrite when a new one is typed
        if (!myHandle || myHandle.toLowerCase() !== prevHandle) set[CONFIG.X_MY_FOLLOWERS_KEY] = 0; // drop a stale follower base for a new/cleared handle
        await chrome.storage.local.set(set);
        const products = await saveProducts();
        toast(`Copilot settings saved${products.length ? ` (${products.length} product${products.length === 1 ? "" : "s"})` : ""}.`);
        if (myHandle && (typedKey || storedKey)) void resolveMyFollowers(myHandle); // best-effort, sizes the reach sweet-spot
        await refresh(); // re-render so the product favicon previews update
        break;
      }
      case "learn-voice": {
        // Feedback goes to toasts + this button + the voice box (all near the button),
        // NOT to #toparea at the top of the popup — that scrolls out of view down here.
        const btn = el as HTMLButtonElement;
        const handle = ((document.getElementById("xmyhandle") as HTMLInputElement | null)?.value ?? "").trim().replace(/^@+/, "");
        if (!handle) { toast("Type your X handle in the field first, then Learn my voice."); return; }
        // Persist any just-typed key first, so the SW sees it without a separate Save.
        const liveKey = ((document.getElementById("twttrkey") as HTMLInputElement | null)?.value ?? "").trim();
        if (liveKey) await chrome.storage.local.set({ [CONFIG.TWTTR_KEY_KEY]: liveKey });
        const orig = btn.textContent;
        btn.disabled = true; btn.textContent = "Reading…";
        toast(`Reading @${handle}'s recent replies…`);
        try {
          const ures = await send<{ ok?: boolean; status?: number; data?: unknown; error?: string }>({ type: "TWTTR_GET", path: "user", query: { username: handle }, intent: true });
          if (ures?.error === "no-twttr-config") { toast("No RapidAPI key saved yet — paste it above, then try again."); return; }
          if (ures?.error?.startsWith("budget-")) { toast("Monthly X-data budget nearly used — voice-learning is paused. It resets on the 1st."); return; }
          if (!ures?.ok) { toast(`Couldn't reach the X API${ures?.status ? ` (HTTP ${ures.status})` : ""}. ${ures?.status === 401 || ures?.status === 403 ? "Key invalid or not subscribed to twitter241." : "Check your RapidAPI key."}${ures?.error ? ` — ${ures.error}` : ""}`); return; }
          const user = parseUser(ures.data);
          if (!user?.id) {
            let raw = ""; try { raw = JSON.stringify(ures.data).slice(0, 200); } catch { /* ignore */ }
            console.warn("[goobi] /user found no user for", handle, raw || ures.data); // log the JSON, not [object Object]
            toast(`Couldn't find @${handle} via the API. Confirm the exact handle (copy it from your profile URL).${raw ? ` API said: ${raw}` : ""}`);
            return;
          }
          await chrome.storage.local.set({ [CONFIG.X_MY_HANDLE_KEY]: user.handle, [CONFIG.X_MY_FOLLOWERS_KEY]: user.followers });
          const hEl = document.getElementById("xmyhandle") as HTMLInputElement | null;
          if (hEl) hEl.value = user.handle; // reflect the canonical handle so a later Save persists it (not the raw typed value)
          const rres = await send<{ ok?: boolean; status?: number; data?: unknown; error?: string }>({ type: "TWTTR_GET", path: "user-replies-v2", query: { user: user.id, count: "40" }, intent: true });
          if (rres?.error?.startsWith("budget-")) { toast("Monthly X-data budget nearly used — voice-learning is paused. It resets on the 1st."); return; }
          if (!rres?.ok) { toast(`Found @${user.handle} but couldn't read replies${rres?.status ? ` (HTTP ${rres.status})` : ""}.`); return; }
          const samples = pickVoiceSamples(rres.data, user.id, 12);
          if (!samples.length) { toast(`@${user.handle} (${user.followers.toLocaleString()} followers): no recent replies to learn from. Reply to a few posts, then retry.`); return; }
          const voice = buildVoiceProfile(user.handle, samples);
          const ta = document.getElementById("xvoice") as HTMLTextAreaElement | null;
          if (ta) { ta.value = voice; ta.scrollIntoView({ block: "center" }); }
          await chrome.storage.local.set({ [CONFIG.X_VOICE_KEY]: voice });
          toast(`Learned your voice from ${samples.length} repl${samples.length === 1 ? "y" : "ies"} by @${user.handle}. Review the voice box, then Save.`);
        } catch {
          toast("Voice-learning failed. Check your RapidAPI key.");
        } finally {
          btn.disabled = false; btn.textContent = orig ?? "Learn my voice";
        }
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
    if (target.checked && !(await chrome.storage.local.get(CONFIG.ANTHROPIC_KEY_KEY))[CONFIG.ANTHROPIC_KEY_KEY]) {
      target.checked = false;
      toast("Add your Anthropic key before turning on Smart mode.");
      return;
    }
    await chrome.storage.local.set({ [CONFIG.SMART_ENABLED_KEY]: target.checked });
    await refresh();
    toast(target.checked ? "Smart mode on — Claude will group & advise." : "Smart mode off — local only.");
  } else if (target.id === "dedupe") {
    await chrome.storage.local.set({ [CONFIG.AUTO_DEDUPE_KEY]: target.checked });
    toast(target.checked ? "Auto-merge duplicates on." : "Auto-merge off.");
  } else if (target.id === "xon") {
    if (target.checked) {
      const gate = await chrome.storage.local.get([CONFIG.X_DATA_CONSENT_KEY, CONFIG.ANTHROPIC_KEY_KEY]);
      if (gate[CONFIG.X_DATA_CONSENT_KEY] !== "v1") {
        target.checked = false; toast("Review and accept the X data disclosure first."); return;
      }
      if (!gate[CONFIG.ANTHROPIC_KEY_KEY]) {
        target.checked = false; toast("Add your Anthropic key before turning on the X copilot."); return;
      }
    }
    await chrome.storage.local.set({ [CONFIG.X_COPILOT_KEY]: target.checked });
    toast(target.checked ? "X copilot on — reload x.com to apply." : "X copilot off — reload x.com.");
  } else if (target.id === "xinsert") {
    await chrome.storage.local.set({ [CONFIG.X_REPLY_INSERT_KEY]: target.checked });
    toast(target.checked ? "Like + insert is on." : "Like + insert is off — replies will use copy + open.");
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

// The side panel can stay open while the x.com content script confirms a reply.
// Re-read the shared ledger so totals, pace, and Goobi's state update immediately.
if (IS_EXT) {
  let replyRefreshTimer: number | undefined;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[CONFIG.X_REPLY_LOG_KEY]) return;
    if (replyRefreshTimer) clearTimeout(replyRefreshTimer);
    replyRefreshTimer = window.setTimeout(() => { replyRefreshTimer = undefined; void refresh(); }, 60);
  });
}

void refresh();
