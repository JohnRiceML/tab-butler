import { CONFIG } from "../lib/config";
import { archiveAndClose, undoLast } from "../lib/archive";
import { advise, classify, draftReply, generatePostIdeaRewrite, generatePostIdeas, isSmartEnabled, scorePosts } from "../lib/claude-client";
import { archivableTabs, groupByDomain, normalizeUrl } from "../lib/heuristics";
import { governedFetch, readMeter } from "../lib/twttr-governor";
import { buildDraftContext } from "../lib/draft-context";
import type { AdviceResult, ClassifyResult, GroupSuggestion, Message, ProductItem, RecommendationKind } from "../lib/types";

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

/** Seed settings from an OPTIONAL, gitignored `goobi.local.json` bundled into dist/ by the build.
 *  Solves the unpacked-extension pain: a remove+re-add wipes chrome.storage.local, forcing every
 *  key / voice / product to be re-typed by hand. On install/startup this fills ONLY EMPTY keys —
 *  it never overwrites live in-app edits, so the side panel stays the source of truth once set.
 *  The file holds real secrets in plaintext: it is gitignored (and dist/ is too), machine-local
 *  only. Values are never logged. Template: goobi.local.example.json. */
async function seedFromLocalFile(): Promise<void> {
  let cfg: Record<string, unknown>;
  try {
    const res = await fetch(chrome.runtime.getURL("goobi.local.json"));
    if (!res.ok) return;
    cfg = (await res.json()) as Record<string, unknown>;
  } catch {
    return; // no seed bundled (or unparseable) → nothing to do
  }
  const K = CONFIG;
  const strMap: Array<[from: string, to: string]> = [
    ["anthropicKey", K.ANTHROPIC_KEY_KEY],
    ["rapidApiKey", K.TWTTR_KEY_KEY],
    ["handle", K.X_MY_HANDLE_KEY],
    ["niche", K.X_NICHE_KEY],
    ["voice", K.X_VOICE_KEY],
    ["defaultAngle", K.X_DEFAULT_ANGLE_KEY],
    ["defaultProduct", K.X_DEFAULT_PRODUCT_KEY],
    ["premium", K.X_PREMIUM_KEY],
  ];
  const cur = await chrome.storage.local.get([...strMap.map(([, to]) => to), K.X_MY_FOLLOWERS_KEY, K.X_PRODUCTS_KEY]);
  const set: Record<string, unknown> = {};
  for (const [from, to] of strMap) {
    const v = cfg[from];
    if (typeof v === "string" && v.trim() && !(cur[to] as string | undefined)) {
      set[to] = from === "handle" ? v.trim().replace(/^@+/, "") : v.trim();
    }
  }
  const followers = cfg["followers"];
  if (typeof followers === "number" && followers > 0 && !cur[K.X_MY_FOLLOWERS_KEY]) set[K.X_MY_FOLLOWERS_KEY] = Math.round(followers);
  const prods = cfg["products"];
  if (Array.isArray(prods) && !((cur[K.X_PRODUCTS_KEY] as ProductItem[] | undefined)?.length)) {
    const clean: ProductItem[] = prods
      .filter((p): p is { name: string; url?: unknown; blurb?: unknown } => !!p && typeof (p as { name?: unknown }).name === "string" && !!(p as { name: string }).name.trim())
      .map((p) => ({ name: p.name.trim(), url: typeof p.url === "string" ? p.url.trim() : "", blurb: typeof p.blurb === "string" ? p.blurb.trim() : "" }));
    if (clean.length) set[K.X_PRODUCTS_KEY] = clean;
  }
  if (Object.keys(set).length) await chrome.storage.local.set(set);
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(CONFIG.SCAN_ALARM, {
    periodInMinutes: CONFIG.SCAN_PERIOD_MIN,
  });
  void seedFromLocalFile(); // fresh install (or reload): restore any empty settings from the local seed
});
chrome.runtime.onStartup.addListener(() => void seedFromLocalFile());

// Clicking the toolbar icon opens Tab Butler as a right-edge, full-height side
// panel (a drawer) instead of a small popup. Idempotent + persists across sessions.
chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => { /* older Chrome without sidePanel */ });

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
  const found = await chrome.bookmarks.search({ title: "Goobi" });
  const folder = found.find((b) => !b.url);
  return folder ?? chrome.bookmarks.create({ title: "Goobi" });
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

/** Resolve product favicons from Chrome's built-in `_favicon` cache (no network,
 *  no CORS) and inline as data URLs so the content script can render them under
 *  x.com's CSP. Empty string = no favicon (content script shows a letter chip).
 *  Cached for the SW's lifetime. Requires the "favicon" permission. */
const faviconMem = new Map<string, string>();
async function fetchFavicons(hosts: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  await Promise.all((hosts || []).map(async (host) => {
    if (faviconMem.has(host)) { out[host] = faviconMem.get(host)!; return; }
    let data = "";
    try {
      const url = chrome.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent(`https://${host}`)}&size=64`);
      const res = await fetch(url);
      const ct = res.headers.get("content-type") || "";
      if (res.ok && ct.startsWith("image/")) {
        const bytes = new Uint8Array(await res.arrayBuffer());
        let bin = "";
        for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        data = `data:${ct};base64,${btoa(bin)}`;
      }
    } catch { /* ignore — fall back to the letter chip */ }
    faviconMem.set(host, data); // cache success or negative ("") so we don't refetch a bad host
    out[host] = data;
  }));
  return out;
}

/* ---------- Twttr (RapidAPI) X-data client ---------- */

/** Call the Twttr RapidAPI endpoint. Read-only enrichment (profiles, tweets,
 *  search). The host is fixed (CONFIG.TWTTR_HOST); only the BYO key lives in
 *  storage (popup settings) and is never bundled. Routed through the governor
 *  (monthly budget meter + 8/sec token bucket + degradation + coalescing). */
async function twttrFetch(path: string, query?: Record<string, string>, intent = false): Promise<{ ok: boolean; status?: number; data?: unknown; error?: string }> {
  const store = await chrome.storage.local.get(CONFIG.TWTTR_KEY_KEY);
  const key = (store[CONFIG.TWTTR_KEY_KEY] as string) || "";
  if (!key) return { ok: false, error: "no-twttr-config" };
  return governedFetch(CONFIG.TWTTR_HOST, key, path, query, intent);
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
          // Stage-1 draft context (niche + scorer rationale + author line): specificity is a ranked
          // variable in the 2026 pipeline (LLM reply grading + slop score), and these strings are
          // already known — user-message only, X_DRAFT_SYSTEM stays byte-stable.
          const niche = ((await chrome.storage.local.get(CONFIG.X_NICHE_KEY))[CONFIG.X_NICHE_KEY] as string) || "";
          const extra = buildDraftContext({ niche, reason: msg.reason, category: msg.category, authorLine: msg.authorLine });
          sendResponse({ reply: await draftReply({ author: msg.author, text: msg.text, context: msg.context }, voice, msg.angle, product, msg.steer, extra) });
        } catch (e) {
          sendResponse({ error: (e as Error).message });
        }
        break;
      case "GET_FAVICONS":
        sendResponse({ favicons: await fetchFavicons(msg.hosts) });
        break;
      case "TWTTR_GET":
        sendResponse(await twttrFetch(msg.path, msg.query, msg.intent));
        break;
      case "GET_TWTTR_METER":
        sendResponse(await readMeter());
        break;
      case "POST_IDEAS":
        try {
          const voice = ((await chrome.storage.local.get(CONFIG.X_VOICE_KEY))[CONFIG.X_VOICE_KEY] as string) || "";
          const niche = ((await chrome.storage.local.get(CONFIG.X_NICHE_KEY))[CONFIG.X_NICHE_KEY] as string) || "";
          sendResponse({ ideas: await generatePostIdeas(msg.posts, voice, niche, msg.ownPosts, msg.followers, msg.shapeLine) });
        } catch (e) {
          sendResponse({ error: (e as Error).message });
        }
        break;
      case "POST_IDEA_REWRITE":
        try {
          const voice = ((await chrome.storage.local.get(CONFIG.X_VOICE_KEY))[CONFIG.X_VOICE_KEY] as string) || "";
          sendResponse({ text: await generatePostIdeaRewrite(msg.text, msg.steer, voice, msg.source, msg.pattern) });
        } catch (e) {
          sendResponse({ error: (e as Error).message });
        }
        break;
      default:
        sendResponse({ error: "unknown message" });
    }
  })();
  return true; // keep the channel open for the async response
});
