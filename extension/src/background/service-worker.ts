import { CONFIG } from "../lib/config";
import { archiveAndClose, undoLast, getArchive } from "../lib/archive";
import { advise, classify, draftReply, isSmartEnabled, scorePosts } from "../lib/claude-client";
import { archivableTabs, groupByDomain, normalizeUrl } from "../lib/heuristics";
import type { AdviceResult, ClassifyResult, GroupSuggestion, Message, RecommendationKind } from "../lib/types";

const HEURISTIC_COLORS: chrome.tabGroups.ColorEnum[] = [
  "blue",
  "green",
  "purple",
  "cyan",
  "orange",
  "pink",
  "yellow",
  "red",
];

/* ---------- lifecycle ---------- */

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(CONFIG.SCAN_ALARM, {
    periodInMinutes: CONFIG.SCAN_PERIOD_MIN,
  });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === CONFIG.SCAN_ALARM) void runIdleArchive();
});

/**
 * Auto-dedupe: when a tab finishes loading and an OLDER tab in the same window
 * already points at the same URL, switch to the older one and close the new
 * copy. Low-regret (the original stays open). Default on; toggle in the popup.
 */
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete" || tab.pinned || !tab.url || !tab.url.startsWith("http")) return;
  void (async () => {
    const enabled = (await chrome.storage.local.get(CONFIG.AUTO_DEDUPE_KEY))[CONFIG.AUTO_DEDUPE_KEY];
    if (enabled === false) return; // default on
    const key = normalizeUrl(tab.url!);
    const tabs = await chrome.tabs.query({ windowId: tab.windowId });
    const twin = tabs.find(
      (t) => t.id != null && t.id !== tabId && t.id < tabId && !t.pinned && t.url && normalizeUrl(t.url) === key,
    );
    if (twin?.id != null) {
      await chrome.tabs.update(twin.id, { active: true });
      await chrome.tabs.remove(tabId);
    }
  })();
});

/* ---------- core actions ---------- */

async function currentWindowTabs(): Promise<chrome.tabs.Tab[]> {
  return chrome.tabs.query({ currentWindow: true });
}

/** Heuristic, always-on, no network. Archives idle tabs (archive-not-delete). */
async function runIdleArchive(): Promise<number> {
  const tabs = await currentWindowTabs();
  const stale = archivableTabs(tabs, Date.now());
  if (stale.length === 0) return 0;
  return archiveAndClose(stale);
}

/** Apply a set of group suggestions to the live tab strip. */
async function applyGroups(groups: GroupSuggestion[]): Promise<number> {
  let applied = 0;
  for (const g of groups) {
    const tabIds = g.tabIds.filter((id) => Number.isInteger(id));
    if (tabIds.length < 2) continue;
    try {
      const groupId = await chrome.tabs.group({ tabIds });
      await chrome.tabGroups.update(groupId, { title: g.name, color: g.color });
      applied++;
    } catch (err) {
      console.warn("applyGroups: failed for", g.name, err);
    }
  }
  return applied;
}

/** Heuristic fallback grouping when the smart tier is off. */
function heuristicGroups(tabs: chrome.tabs.Tab[]): GroupSuggestion[] {
  const byDomain = groupByDomain(tabs);
  const out: GroupSuggestion[] = [];
  let i = 0;
  for (const [domain, tabIds] of byDomain) {
    out.push({
      name: domain,
      color: HEURISTIC_COLORS[i % HEURISTIC_COLORS.length],
      tabIds,
      reason: "same site",
    });
    i++;
  }
  return out;
}

async function groupNow(): Promise<{ applied: number; smart: boolean }> {
  const tabs = await currentWindowTabs();
  const smart = await isSmartEnabled();
  let result: ClassifyResult;
  if (smart) {
    try {
      result = await classify(tabs);
    } catch (err) {
      console.warn("smart classify failed, falling back to heuristics", err);
      result = { groups: heuristicGroups(tabs) };
    }
  } else {
    result = { groups: heuristicGroups(tabs) };
  }
  const applied = await applyGroups(result.groups);
  return { applied, smart };
}

async function adviseNow(): Promise<AdviceResult> {
  const tabs = await currentWindowTabs();
  if (!(await isSmartEnabled())) {
    return {
      summary: "Smart suggestions are off. Enable them in settings to let Claude review your tabs.",
      recommendations: [],
    };
  }
  try {
    return await advise(tabs);
  } catch (err) {
    console.warn("advise failed", err);
    return { summary: "Couldn't reach the suggestion service.", recommendations: [] };
  }
}

async function ensureBookmarkFolder(): Promise<chrome.bookmarks.BookmarkTreeNode> {
  const found = await chrome.bookmarks.search({ title: "Tab Butler" });
  const folder = found.find((b) => !b.url);
  return folder ?? chrome.bookmarks.create({ title: "Tab Butler" });
}

/**
 * Execute one Claude recommendation. Everything is reversible: http(s) tabs are
 * archived (restorable via Undo), throwaway pages (chrome://newtab) are closed,
 * bookmarks are filed before the tab is cleared. We never stop a dev server.
 */
async function applyRec(
  kind: RecommendationKind,
  tabIds: number[],
): Promise<{ done: number; label: string }> {
  if (kind === "regroup") {
    const r = await groupNow();
    return { done: r.applied, label: "regrouped" };
  }

  const tabs = (
    await Promise.all(tabIds.map((id) => chrome.tabs.get(id).catch(() => null)))
  ).filter((t): t is chrome.tabs.Tab => !!t && !t.pinned);

  if (kind === "bookmark") {
    const folder = await ensureBookmarkFolder();
    for (const t of tabs) {
      if (t.url?.startsWith("http")) {
        await chrome.bookmarks.create({ parentId: folder.id, title: t.title ?? t.url, url: t.url });
      }
    }
  }

  // Clear the tabs: archive the restorable ones, close throwaway pages.
  const restorable = tabs.filter((t) => t.url?.startsWith("http"));
  const throwaway = tabs.filter((t) => t.id != null && !t.url?.startsWith("http")).map((t) => t.id!);
  let done = 0;
  if (restorable.length) done += await archiveAndClose(restorable);
  if (throwaway.length) { await chrome.tabs.remove(throwaway); done += throwaway.length; }

  const label = kind === "bookmark" ? "saved" : kind === "archive" ? "archived" : "closed";
  return { done, label };
}

/* ---------- favicons ---------- */

/** Fetch product favicons (google s2) and inline as data URLs so the content
 *  script can render them under x.com's CSP. Cached for the SW's lifetime. */
const faviconMem = new Map<string, string>();
async function fetchFavicons(hosts: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  await Promise.all((hosts || []).map(async (host) => {
    if (faviconMem.has(host)) { out[host] = faviconMem.get(host)!; return; }
    let data = "";
    try {
      const res = await fetch(`https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`);
      const ct = res.headers.get("content-type") || "";
      if (res.ok && ct.startsWith("image/")) {
        const bytes = new Uint8Array(await res.arrayBuffer());
        let bin = "";
        for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        data = `data:${ct};base64,${btoa(bin)}`;
      }
    } catch { /* ignore */ }
    faviconMem.set(host, data); // cache success or negative ("") so we don't refetch a bad host
    out[host] = data;
  }));
  return out;
}

/* ---------- Twttr (RapidAPI) X-data client ---------- */

/** Call the Twttr RapidAPI endpoint. Read-only enrichment (profiles, tweets,
 *  search). The host is fixed (CONFIG.TWTTR_HOST); only the BYO key lives in
 *  storage (popup settings) and is never bundled. */
async function twttrFetch(path: string, query?: Record<string, string>): Promise<{ ok: boolean; status?: number; data?: unknown; error?: string }> {
  const store = await chrome.storage.local.get(CONFIG.TWTTR_KEY_KEY);
  const key = (store[CONFIG.TWTTR_KEY_KEY] as string) || "";
  if (!key) return { ok: false, error: "no-twttr-config" };
  const host = CONFIG.TWTTR_HOST;
  const qs = query && Object.keys(query).length ? "?" + new URLSearchParams(query).toString() : "";
  try {
    const res = await fetch(`https://${host}/${path.replace(/^\//, "")}${qs}`, {
      headers: { "Content-Type": "application/json", "x-rapidapi-key": key, "x-rapidapi-host": host },
    });
    if (!res.ok) {
      // Surface the provider's rejection text (e.g. "You are not subscribed to this API.")
      // so the user can tell a wrong/unsubscribed key from a rate limit, etc.
      let detail = "";
      try { detail = (await res.text()).replace(/\s+/g, " ").trim().slice(0, 160); } catch { /* ignore */ }
      console.warn("[tab-butler] twttr", path, res.status, detail);
      return { ok: false, status: res.status, error: detail || `twttr ${res.status}` };
    }
    return { ok: true, data: await res.json() };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/* ---------- popup messaging ---------- */

chrome.runtime.onMessage.addListener((msg: Message, _sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case "GROUP_NOW":
        sendResponse(await groupNow());
        break;
      case "ADVISE_NOW":
        sendResponse(await adviseNow());
        break;
      case "ARCHIVE_IDLE_NOW":
        sendResponse({ archived: await runIdleArchive() });
        break;
      case "UNDO_LAST":
        sendResponse({ restored: await undoLast() });
        break;
      case "APPLY_REC":
        sendResponse(await applyRec(msg.kind, msg.tabIds));
        break;
      case "SCORE_POSTS":
        try {
          const niche = ((await chrome.storage.local.get(CONFIG.X_NICHE_KEY))[CONFIG.X_NICHE_KEY] as string) || "";
          const products = ((await chrome.storage.local.get(CONFIG.X_PRODUCTS_KEY))[CONFIG.X_PRODUCTS_KEY] as { name: string; blurb?: string }[]) || [];
          sendResponse({ scores: await scorePosts(msg.posts, niche, products) });
        } catch (e) {
          sendResponse({ scores: [], error: (e as Error).message });
        }
        break;
      case "DRAFT_REPLY":
        try {
          const voice = ((await chrome.storage.local.get(CONFIG.X_VOICE_KEY))[CONFIG.X_VOICE_KEY] as string) || "";
          // The content script resolves the relevant product(s) and sends them; fall back to the legacy single-product string.
          const product = msg.product ?? (((await chrome.storage.local.get(CONFIG.X_PRODUCT_KEY))[CONFIG.X_PRODUCT_KEY] as string) || "");
          sendResponse({ reply: await draftReply({ author: msg.author, text: msg.text, context: msg.context }, voice, msg.angle, product) });
        } catch (e) {
          sendResponse({ error: (e as Error).message });
        }
        break;
      case "GET_FAVICONS":
        sendResponse({ favicons: await fetchFavicons(msg.hosts) });
        break;
      case "TWTTR_GET":
        sendResponse(await twttrFetch(msg.path, msg.query));
        break;
      case "GET_STATE":
        sendResponse({
          smart: await isSmartEnabled(),
          archived: (await getArchive()).length,
        });
        break;
      default:
        sendResponse({ error: "unknown message" });
    }
  })();
  return true; // keep the channel open for the async response
});
