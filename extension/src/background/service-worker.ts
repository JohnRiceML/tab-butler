import { CONFIG } from "../lib/config";
import { shouldShowXOnboarding } from "../lib/x-onboarding";
import { archiveAndClose, undoLast } from "../lib/archive";
import { advise, classify, draftDm, draftLinkedInComment, draftReply, generatePostIdeaRewrite, generatePostIdeas, isSmartEnabled, scorePosts } from "../lib/claude-client";
import { archivableTabs, groupByDomain, normalizeUrl } from "../lib/heuristics";
import { governedFetch, readMeter, type GovResult } from "../lib/twttr-governor";
import { buildDraftContext } from "../lib/draft-context";
import { allowedTwttrPath } from "../lib/twttr-policy";
import { normalizeDailyGoals } from "../lib/daily-goals";
import { dueReminderCount } from "../lib/schedule";
import { replyPostUrl, statusIdFromPath } from "../lib/reply-handoff";
import { isPersonalPostingModel, postingModelCommunityGuidance, postingModelIdeasGuidance } from "../lib/posting-analytics";
import { LI_BROKER_PROTOCOL, LI_CONSENT_VERSION, canUseLinkedInBroker, hasSupportedLinkedInSenderUrl, isSupportedLinkedInUrl, sanitizeLinkedInDraftPayload, sanitizeLinkedInScorePayload } from "../lib/linkedin-policy";
import { dismissCommentReview, markCommentPosted, normalizeCommentLog, startCommentReview, undoLatestComment, type CommentLog, type CommentLogEntry } from "../lib/linkedin-state";
import { linkedInStrategyConfigured, linkedInStrategyPrompt, normalizeLinkedInStrategy, type LinkedInStrategyV1 } from "../lib/linkedin-strategy";
import { canUseXBroker, hasSupportedXSenderUrl, sanitizeXDraftPayload, sanitizeXScorePayload } from "../lib/x-policy";
import { findContributionAnchor } from "../lib/contribution-evidence";
import { selectAuthorContinuity } from "../lib/author-continuity";
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
    ["typesafeKey", K.TYPESAFE_KEY_KEY],
    ["rapidApiKey", K.TWTTR_KEY_KEY],
    ["handle", K.X_MY_HANDLE_KEY],
    ["niche", K.X_NICHE_KEY],
    ["voice", K.X_VOICE_KEY],
    ["soul", K.X_SOUL_KEY],
    ["defaultAngle", K.X_DEFAULT_ANGLE_KEY],
    ["defaultProduct", K.X_DEFAULT_PRODUCT_KEY],
    ["premium", K.X_PREMIUM_KEY],
  ];
  const cur = await chrome.storage.local.get([...strMap.map(([, to]) => to), K.X_MY_FOLLOWERS_KEY, K.X_PRODUCTS_KEY, K.X_DAILY_GOALS_KEY, K.JEV_REVIEW_MODE_KEY, K.JEV_REVIEW_CONSENT_KEY]);
  const set: Record<string, unknown> = {};
  for (const [from, to] of strMap) {
    const v = cfg[from];
    if (typeof v === "string" && v.trim() && !(cur[to] as string | undefined) && (from !== "typesafeKey" || cur[to] === undefined)) {
      set[to] = from === "handle" ? v.trim().replace(/^@+/, "") : v.trim();
    }
  }
  const followers = cfg["followers"];
  // Explicit local opt-in only; never undo a saved "off" preference.
  if (cur[K.JEV_REVIEW_MODE_KEY] === undefined && cfg["jevReviewMode"] === "shadow" && cfg["jevReviewConsent"] === "v1") {
    set[K.JEV_REVIEW_MODE_KEY] = "shadow";
    set[K.JEV_REVIEW_CONSENT_KEY] = "v1";
  }
  if (typeof followers === "number" && followers > 0 && !cur[K.X_MY_FOLLOWERS_KEY]) set[K.X_MY_FOLLOWERS_KEY] = Math.round(followers);
  const prods = cfg["products"];
  if (Array.isArray(prods) && !((cur[K.X_PRODUCTS_KEY] as ProductItem[] | undefined)?.length)) {
    const clean: ProductItem[] = prods
      .filter((p): p is { name: string; url?: unknown; blurb?: unknown } => !!p && typeof (p as { name?: unknown }).name === "string" && !!(p as { name: string }).name.trim())
      .map((p) => ({ name: p.name.trim(), url: typeof p.url === "string" ? p.url.trim() : "", blurb: typeof p.blurb === "string" ? p.blurb.trim() : "" }));
    if (clean.length) set[K.X_PRODUCTS_KEY] = clean;
  }
  if (cfg["dailyGoals"] && typeof cfg["dailyGoals"] === "object" && !cur[K.X_DAILY_GOALS_KEY]) set[K.X_DAILY_GOALS_KEY] = normalizeDailyGoals(cfg["dailyGoals"]);
  if (Object.keys(set).length) await chrome.storage.local.set(set);
}

chrome.runtime.onInstalled.addListener((details) => {
  chrome.alarms.create(CONFIG.SCAN_ALARM, {
    periodInMinutes: CONFIG.SCAN_PERIOD_MIN,
  });
  chrome.alarms.create(CONFIG.IDEA_REMIND_ALARM, {
    periodInMinutes: CONFIG.IDEA_REMIND_PERIOD_MIN,
  });
  void (async () => {
    await seedFromLocalFile();
    if (details.reason !== "install") return;
    const store = await chrome.storage.local.get(null);
    if (shouldShowXOnboarding(store)) {
      await chrome.tabs.create({ url: chrome.runtime.getURL("popup.html?onboarding=1") });
    }
  })().catch(() => { /* Toolbar setup remains available if the welcome tab cannot open. */ });
});
chrome.runtime.onStartup.addListener(() => void seedFromLocalFile());

/* ---------- post-idea reminders: the toolbar badge ----------
 * Count the drafts whose remind-me time has arrived and mirror the number on the
 * chrome.action badge. Badge-only by design: NO chrome.notifications (a new permission
 * = forced remove+re-add for every user), no tab opening, no composer — the in-dock
 * highlight + this count are the entire surface, and every next step is a user click.
 * Persistence is the existing X_IDEAS_KEY records; the alarm just re-reads them. */
async function refreshIdeaReminderBadge(): Promise<void> {
  try {
    const store = await chrome.storage.local.get(CONFIG.X_IDEAS_KEY);
    const n = dueReminderCount(store[CONFIG.X_IDEAS_KEY], Date.now());
    await chrome.action.setBadgeText({ text: n ? String(n) : "" });
    if (n) await chrome.action.setBadgeBackgroundColor({ color: "#e89a3c" }); // the warning amber the dock uses
  } catch { /* badge is best-effort — never let it break the worker */ }
}
void refreshIdeaReminderBadge(); // every SW wake re-syncs the badge (covers missed alarms)
chrome.storage.onChanged.addListener((changes, area) => {
  // Set/clear/ship in any tab updates the badge immediately — no waiting on the alarm.
  if (area === "local" && changes[CONFIG.X_IDEAS_KEY]) void refreshIdeaReminderBadge();
});

/* ---------- dev hot-reload (unpacked watch-mode builds ONLY) ----------
 * `npm run dev` (build.mjs --watch) writes dist/dev-reload.json with a fresh id on every
 * successful rebuild; a distributable `npm run build` DELETES that file (check-dist enforces
 * absence). So outside a dev build the first fetch 404s and this whole block stays inert —
 * no polling, no behavior change. In a dev build: poll the beacon (unpacked extensions serve
 * runtime.getURL resources from disk, so the fetch sees the new file without a reload), and on
 * a bump mark a pending flag + chrome.runtime.reload(); the FRESH worker sees the flag and
 * refreshes open X/LinkedIn tabs, replacing the orphaned content script (whose global
 * context-invalidated catch-all has already torn it down quietly). Together that removes both
 * manual dev steps: the chrome://extensions reload click AND the per-tab refresh. */
const DEV_RELOAD_URL = chrome.runtime.getURL("dev-reload.json");
async function devReloadId(): Promise<number | null> {
  try {
    const r = await fetch(`${DEV_RELOAD_URL}?t=${Date.now()}`, { cache: "no-store" });
    if (!r.ok) return null;
    const j = (await r.json()) as { id?: number };
    return typeof j.id === "number" ? j.id : null;
  } catch {
    return null;
  }
}
async function devHotReloadInit(): Promise<void> {
  // Finish the previous cycle first: if the old worker queued a reload, refresh social tabs now so
  // the new content script takes over. Runs before the beacon check so the flag can't strand.
  try {
    const flag = (await chrome.storage.local.get("devReloadPending")) as { devReloadPending?: boolean };
    if (flag.devReloadPending) {
      await chrome.storage.local.remove("devReloadPending");
      const tabs = await chrome.tabs.query({ url: ["https://x.com/*", "https://twitter.com/*", "https://www.linkedin.com/*"] });
      for (const t of tabs) if (t.id != null) void chrome.tabs.reload(t.id);
      console.log(`[goobi dev] hot-reloaded; refreshed ${tabs.length} X/LinkedIn tab(s)`);
    }
  } catch { /* storage/tabs unavailable — never let dev plumbing break the worker */ }
  const first = await devReloadId();
  if (first == null) return; // not a watch-mode build — stay inert forever
  let last = first;
  setInterval(() => {
    void devReloadId().then(async (id) => {
      if (id != null && id !== last) {
        last = id;
        await chrome.storage.local.set({ devReloadPending: true });
        chrome.runtime.reload();
      }
    });
  }, 1000);
}
void devHotReloadInit();

// Clicking the toolbar icon opens Tab Butler as a right-edge, full-height side
// panel (a drawer) instead of a small popup. Idempotent + persists across sessions.
chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => { /* older Chrome without sidePanel */ });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === CONFIG.SCAN_ALARM) void runIdleArchive();
  if (alarm.name === CONFIG.IDEA_REMIND_ALARM) void refreshIdeaReminderBadge();
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
 *  (local safety meter + adaptive shared queue + provider headers + degradation + coalescing). */
async function twttrFetch(path: string, query?: Record<string, string>, intent = false): Promise<GovResult> {
  if (!allowedTwttrPath(path)) return { ok: false, error: "endpoint-not-allowed" };
  const store = await chrome.storage.local.get(CONFIG.TWTTR_KEY_KEY);
  const key = (store[CONFIG.TWTTR_KEY_KEY] as string) || "";
  if (!key) return { ok: false, error: "no-twttr-config" };
  return governedFetch(CONFIG.TWTTR_HOST, key, path, query, intent);
}

/* ---------- popup messaging ---------- */

function supportedLinkedInSender(sender: chrome.runtime.MessageSender): boolean {
  if (sender.id !== chrome.runtime.id) return false;
  if (sender.tab?.id == null || (sender.frameId !== undefined && sender.frameId !== 0)) return false;
  // Chrome versions differ on whether a content-script message exposes the
  // LinkedIn document URL or the extension script URL in sender.url. The tab
  // snapshot may also briefly lag during SPA navigation. Accept either trusted
  // sender snapshot when it is an exact supported LinkedIn surface.
  const frameUrl = typeof sender.url === "string" && sender.url ? sender.url : undefined;
  const tabUrl = typeof sender.tab.url === "string" ? sender.tab.url : undefined;
  return hasSupportedLinkedInSenderUrl(frameUrl, tabUrl);
}

function supportedXSender(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id && sender.tab?.id != null
    && (sender.frameId === undefined || sender.frameId === 0)
    && hasSupportedXSenderUrl(sender.url, sender.tab.url);
}

async function xBrokerProfile(sender: chrome.runtime.MessageSender): Promise<Record<string, unknown>> {
  if (!supportedXSender(sender)) throw new Error("unsupported-x-sender");
  const profile = await chrome.storage.local.get([
    CONFIG.X_DATA_CONSENT_KEY, CONFIG.X_COPILOT_KEY, CONFIG.X_PAUSED_KEY,
    CONFIG.ANTHROPIC_KEY_KEY, CONFIG.X_NICHE_KEY, CONFIG.X_VOICE_KEY,
    CONFIG.X_SOUL_KEY, CONFIG.X_MY_HANDLE_KEY, CONFIG.X_POSTING_MODEL_KEY,
    CONFIG.X_PRODUCT_KEY, CONFIG.X_PRODUCTS_KEY, CONFIG.X_MY_POSTS_KEY,
  ]);
  const key = profile[CONFIG.ANTHROPIC_KEY_KEY];
  if (typeof key !== "string" || !key.trim()) throw new Error("no-key");
  if (!canUseXBroker(profile[CONFIG.X_DATA_CONSENT_KEY], profile[CONFIG.X_COPILOT_KEY],
    key, profile[CONFIG.X_PAUSED_KEY])) throw new Error("x-disabled");
  return profile;
}

type CommentPlatform = "x" | "linkedin";
const commentRequests: Record<CommentPlatform, Set<AbortController>> = { x: new Set(), linkedin: new Set() };
const commentContextKeys: Record<CommentPlatform, Set<string>> = {
  x: new Set([CONFIG.ANTHROPIC_KEY_KEY, CONFIG.TYPESAFE_KEY_KEY, CONFIG.ANALYSIS_PROVIDER_KEY, CONFIG.JEV_ANALYSIS_CONSENT_KEY, CONFIG.JEV_REVIEW_MODE_KEY, CONFIG.JEV_REVIEW_CONSENT_KEY, CONFIG.X_DATA_CONSENT_KEY, CONFIG.X_COPILOT_KEY,
    CONFIG.X_PAUSED_KEY, CONFIG.X_NICHE_KEY, CONFIG.X_VOICE_KEY, CONFIG.X_SOUL_KEY,
    CONFIG.X_MY_HANDLE_KEY, CONFIG.X_POSTING_MODEL_KEY, CONFIG.X_PRODUCT_KEY, CONFIG.X_PRODUCTS_KEY, CONFIG.X_MY_POSTS_KEY]),
  linkedin: new Set([CONFIG.ANTHROPIC_KEY_KEY, CONFIG.TYPESAFE_KEY_KEY, CONFIG.ANALYSIS_PROVIDER_KEY, CONFIG.JEV_ANALYSIS_CONSENT_KEY, CONFIG.JEV_REVIEW_MODE_KEY, CONFIG.JEV_REVIEW_CONSENT_KEY, CONFIG.LI_DATA_CONSENT_KEY, CONFIG.LI_COPILOT_KEY,
    CONFIG.LI_PAUSED_KEY, CONFIG.X_NICHE_KEY, CONFIG.X_VOICE_KEY, CONFIG.X_SOUL_KEY,
    CONFIG.LI_VOICE_KEY, CONFIG.LI_STRATEGY_KEY, CONFIG.X_MY_HANDLE_KEY, CONFIG.X_MY_POSTS_KEY]),
};
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  for (const platform of ["x", "linkedin"] as const) {
    if (!Object.keys(changes).some((key) => commentContextKeys[platform].has(key))) continue;
    for (const controller of commentRequests[platform]) controller.abort(new Error("social-context-changed"));
  }
});

/** Register before reading settings, so context changes also cancel work waiting at the gate. */
async function runCommentRequest<T>(platform: CommentPlatform, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  commentRequests[platform].add(controller);
  try {
    const result = await work(controller.signal);
    if (controller.signal.aborted) throw new Error("social-context-changed");
    return result;
  } finally {
    commentRequests[platform].delete(controller);
  }
}

async function linkedInActivityAllowed(sender: chrome.runtime.MessageSender): Promise<boolean> {
  if (!supportedLinkedInSender(sender)) return false;
  const store = await chrome.storage.local.get([CONFIG.LI_DATA_CONSENT_KEY, CONFIG.LI_COPILOT_KEY]);
  return store[CONFIG.LI_DATA_CONSENT_KEY] === LI_CONSENT_VERSION && store[CONFIG.LI_COPILOT_KEY] === true;
}

async function linkedInBrokerProfile(sender: chrome.runtime.MessageSender): Promise<{
  ok: true;
  niche: string;
  voice: string;
  linkedInVoice: string;
  soul: string;
  ownPosts: unknown;
  ownHandle: unknown;
  strategy: LinkedInStrategyV1;
} | { ok: false; error: string }> {
  if (!supportedLinkedInSender(sender)) return { ok: false, error: "unsupported-linkedin-sender" };
  const store = await chrome.storage.local.get([
    CONFIG.LI_DATA_CONSENT_KEY,
    CONFIG.LI_COPILOT_KEY,
    CONFIG.LI_PAUSED_KEY,
    CONFIG.ANTHROPIC_KEY_KEY,
    CONFIG.X_NICHE_KEY,
    CONFIG.X_VOICE_KEY,
    CONFIG.LI_VOICE_KEY,
    CONFIG.LI_STRATEGY_KEY,
    CONFIG.X_SOUL_KEY,
    CONFIG.X_MY_POSTS_KEY,
    CONFIG.X_MY_HANDLE_KEY,
  ]);
  const key = store[CONFIG.ANTHROPIC_KEY_KEY];
  if (typeof key !== "string" || !key.trim()) return { ok: false, error: "no-key" };
  if (store[CONFIG.LI_PAUSED_KEY] === true || !canUseLinkedInBroker(store[CONFIG.LI_DATA_CONSENT_KEY], store[CONFIG.LI_COPILOT_KEY], key)) {
    return { ok: false, error: "linkedin-disabled" };
  }
  const niche = typeof store[CONFIG.X_NICHE_KEY] === "string" ? store[CONFIG.X_NICHE_KEY].trim() : "";
  const strategy = normalizeLinkedInStrategy(store[CONFIG.LI_STRATEGY_KEY]);
  if (!niche && !linkedInStrategyConfigured(strategy)) return { ok: false, error: "no-focus" };
  return {
    ok: true,
    niche,
    voice: typeof store[CONFIG.X_VOICE_KEY] === "string" ? store[CONFIG.X_VOICE_KEY].slice(0, 6_000) : "",
    linkedInVoice: typeof store[CONFIG.LI_VOICE_KEY] === "string" ? store[CONFIG.LI_VOICE_KEY].slice(0, 2_400) : "",
    soul: typeof store[CONFIG.X_SOUL_KEY] === "string" ? store[CONFIG.X_SOUL_KEY].slice(0, 6_000) : "",
    ownPosts: store[CONFIG.X_MY_POSTS_KEY],
    ownHandle: store[CONFIG.X_MY_HANDLE_KEY],
    strategy,
  };
}

let linkedInLogMutation: Promise<void> = Promise.resolve();

function mutateLinkedInLog<T>(mutate: (current: CommentLog) => Promise<T> | T): Promise<T> {
  const run = linkedInLogMutation.then(async () => {
    const stored = (await chrome.storage.local.get(CONFIG.LI_COMMENT_LOG_KEY))[CONFIG.LI_COMMENT_LOG_KEY];
    return mutate(normalizeCommentLog(stored));
  });
  linkedInLogMutation = run.then(() => undefined, () => undefined);
  return run;
}

const LI_POST_ID_MAX = 180;
const LI_AUTHOR_MAX = 120;
const LI_AUTHOR_KEY_MAX = 300;
const LI_PERMALINK_MAX = 2_048;

function boundedLinkedInText(value: unknown, max: number): string | null {
  if (typeof value !== "string" || value.length > max || /[\u0000-\u001F\u007F]/.test(value)) return null;
  const cleaned = value.replace(/\s+/g, " ").trim();
  return cleaned || null;
}

/** Undefined means absent; null means present but invalid. */
function linkedInReviewPermalink(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  const cleaned = boundedLinkedInText(value, LI_PERMALINK_MAX);
  if (!cleaned || !isSupportedLinkedInUrl(cleaned)) return null;
  const url = new URL(cleaned);
  url.search = "";
  url.hash = "";
  return url.toString();
}

function linkedInReviewMetadata(value: { postId?: unknown; author?: unknown; permalink?: unknown }): {
  postId: string;
  author: string;
  permalink?: string;
} | null {
  const postId = boundedLinkedInText(value.postId, LI_POST_ID_MAX);
  const author = boundedLinkedInText(value.author, LI_AUTHOR_MAX);
  const permalink = linkedInReviewPermalink(value.permalink);
  if (!postId || !author || permalink === null) return null;
  return permalink ? { postId, author, permalink } : { postId, author };
}

function linkedInAuthorKey(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  const cleaned = boundedLinkedInText(value, LI_AUTHOR_KEY_MAX)?.toLowerCase();
  return cleaned && /^\/(?:in|company)\/[a-z0-9._~-]+$/i.test(cleaned) ? cleaned : null;
}

chrome.runtime.onMessage.addListener((msg: Message, sender, sendResponse) => {
  if (!msg || typeof msg !== "object" || typeof msg.type !== "string") {
    sendResponse({ error: "invalid-message" });
    return false;
  }
  (async () => {
    switch (msg.type) {
      case "OPEN_SIDE_PANEL": {
        const tabId = sender.tab?.id;
        if (tabId == null || !chrome.sidePanel?.open) { sendResponse({ ok: false }); break; }
        try { await chrome.sidePanel.open({ tabId }); sendResponse({ ok: true }); }
        catch { sendResponse({ ok: false }); }
        break;
      }
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
      case "LI_BROKER_STATUS":
        sendResponse({ protocol: LI_BROKER_PROTOCOL });
        break;
      case "LI_SCORE_POSTS": {
        const payload = sanitizeLinkedInScorePayload(msg);
        if (!payload) { sendResponse({ scores: [], error: "invalid-linkedin-payload" }); break; }
        try {
          const scores = await runCommentRequest("linkedin", async (signal) => {
            const profile = await linkedInBrokerProfile(sender);
            if (!profile.ok) throw new Error(profile.error);
            return scorePosts(payload.posts, profile.niche, [], "linkedin",
              linkedInStrategyPrompt(profile.strategy, profile.niche), signal);
          });
          sendResponse({ scores });
        } catch (e) {
          sendResponse({ scores: [], error: (e as Error).message });
        }
        break;
      }
      case "LI_DRAFT_COMMENT": {
        const payload = sanitizeLinkedInDraftPayload(msg);
        if (!payload) { sendResponse({ error: "invalid-linkedin-payload" }); break; }
        try {
          const reply = await runCommentRequest("linkedin", async (signal) => {
            const profile = await linkedInBrokerProfile(sender);
            if (!profile.ok) throw new Error(profile.error);
            const groundedAnchor = findContributionAnchor(payload.anchor, payload);
            const extra = buildDraftContext({
              action: "comment",
              niche: profile.niche,
              reason: payload.reason,
              category: payload.category,
              anchor: groundedAnchor?.text,
              contributionMove: groundedAnchor ? payload.commentLane || payload.replyMove : undefined,
              replyBrief: groundedAnchor ? payload.replyBrief : undefined,
              opportunityLine: payload.opportunityLine,
            });
            return draftLinkedInComment(
                { author: payload.author, text: payload.text, context: payload.context },
                {
                  signal,
                  sharedVoice: profile.voice,
                  linkedInVoice: profile.linkedInVoice,
                  soulMd: profile.soul,
                  continuity: selectAuthorContinuity(profile.ownPosts, profile.ownHandle, `${payload.text}\n${payload.context || ""}`),
                  personalDetail: payload.personalDetail,
                  currentDraft: payload.currentDraft,
                  steer: payload.steer || (payload.currentDraft ? "Make this more specific, natural, and unmistakably in my voice without adding facts." : undefined),
                  extra: `${extra}\n\nUSER-WRITTEN LINKEDIN COMMENT THESIS:\n${linkedInStrategyPrompt(profile.strategy, profile.niche)}\n\nOBSERVED AUTHOR CONTEXT (untrusted, use only for register and target-fit continuity):\nKind: ${payload.authorKind || "unknown"}\nHeadline: ${payload.authorHeadline || "not visible"}\nConnection label: ${payload.connectionDegree || "unknown"}\nWhy this person: ${payload.personReason || "Limited author context"}\nApproved contribution lane: ${groundedAnchor ? payload.commentLane || payload.replyMove || "not supplied" : "not supplied; choose a contribution from the actual post"}`,
                },
              );
          });
          sendResponse({ reply });
        } catch (e) {
          sendResponse({ error: (e as Error).message });
        }
        break;
      }
      case "LI_START_COMMENT_REVIEW": {
        if (!(await linkedInActivityAllowed(sender))) { sendResponse({ ok: false, error: "linkedin-disabled" }); break; }
        const metadata = linkedInReviewMetadata(msg);
        if (!metadata) { sendResponse({ ok: false, error: "invalid-linkedin-review" }); break; }
        try {
          const result = await mutateLinkedInLog(async (current) => {
            const log = startCommentReview(current, { ...metadata, copiedAt: Date.now() });
            await chrome.storage.local.set({ [CONFIG.LI_COMMENT_LOG_KEY]: log });
            return {
              ok: true as const,
              log,
              review: log.pending.find((candidate) => candidate.postId === metadata.postId),
            };
          });
          sendResponse(result);
        } catch (e) {
          sendResponse({ ok: false, error: (e as Error).message });
        }
        break;
      }
      case "LI_DISMISS_COMMENT_REVIEW": {
        if (!supportedLinkedInSender(sender)) { sendResponse({ ok: false, error: "unsupported-linkedin-sender" }); break; }
        const postId = boundedLinkedInText(msg.postId, LI_POST_ID_MAX);
        if (!postId) { sendResponse({ ok: false, error: "invalid-post-id" }); break; }
        try {
          const result = await mutateLinkedInLog(async (current) => {
            const log = dismissCommentReview(current, postId, Date.now());
            await chrome.storage.local.set({ [CONFIG.LI_COMMENT_LOG_KEY]: log });
            return { ok: true as const, log };
          });
          sendResponse(result);
        } catch (e) {
          sendResponse({ ok: false, error: (e as Error).message });
        }
        break;
      }
      case "LI_MARK_POSTED": {
        if (!(await linkedInActivityAllowed(sender))) { sendResponse({ ok: false, error: "linkedin-disabled" }); break; }
        const metadata = linkedInReviewMetadata(msg);
        const authorKey = linkedInAuthorKey(msg.authorKey);
        if (!metadata || authorKey === null) { sendResponse({ ok: false, error: "invalid-linkedin-review" }); break; }
        try {
          const result = await mutateLinkedInLog(async (current) => {
            const event: CommentLogEntry = { ...metadata, ...(authorKey ? { authorKey } : {}), postedAt: Date.now() };
            const log = markCommentPosted(current, event);
            await chrome.storage.local.set({ [CONFIG.LI_COMMENT_LOG_KEY]: log });
            return { ok: true as const, log, event: log.entries.find((entry) => entry.postId === metadata.postId) ?? event };
          });
          sendResponse(result);
        } catch (e) {
          sendResponse({ ok: false, error: (e as Error).message });
        }
        break;
      }
      case "LI_UNDO_POSTED": {
        if (!supportedLinkedInSender(sender)) { sendResponse({ ok: false, error: "unsupported-linkedin-sender" }); break; }
        const postId = boundedLinkedInText(msg.postId, LI_POST_ID_MAX);
        const postedAt = msg.postedAt;
        const author = msg.author === undefined ? undefined : boundedLinkedInText(msg.author, LI_AUTHOR_MAX);
        const permalink = linkedInReviewPermalink(msg.permalink);
        if (!postId || !Number.isSafeInteger(postedAt) || postedAt < 0 || author === null || permalink === null || (permalink !== undefined && author === undefined)) {
          sendResponse({ ok: false, error: "invalid-linkedin-undo" });
          break;
        }
        try {
          const result = await mutateLinkedInLog(async (current) => {
            const exact = current.entries.some((entry) => entry.postId === postId && entry.postedAt === postedAt);
            if (!exact) return { ok: false as const, log: current, error: "stale-undo" };
            const event = { postId, postedAt, ...(author ? { author } : {}), ...(permalink ? { permalink } : {}) };
            // `undoLatestComment` removes the exact confirmed event and, when metadata is
            // supplied, restores its in-review receipt in this same state transition/write.
            const log = undoLatestComment(current, event, Date.now());
            await chrome.storage.local.set({ [CONFIG.LI_COMMENT_LOG_KEY]: log });
            return {
              ok: true as const,
              log,
              review: author ? log.pending.find((candidate) => candidate.postId === postId) : undefined,
            };
          });
          sendResponse(result);
        } catch (e) {
          sendResponse({ ok: false, error: (e as Error).message });
        }
        break;
      }
      case "SCORE_POSTS": {
        const payload = sanitizeXScorePayload(msg);
        if (!payload) { sendResponse({ scores: [], error: "invalid-x-payload" }); break; }
        try {
          const scores = await runCommentRequest("x", async (signal) => {
            const profile = await xBrokerProfile(sender);
            const niche = (profile[CONFIG.X_NICHE_KEY] as string) || "";
            const products = (profile[CONFIG.X_PRODUCTS_KEY] as { name: string; blurb?: string }[]) || [];
            return scorePosts(payload.posts, niche, products, "x", undefined, signal);
          });
          sendResponse({ scores });
        } catch (e) {
          sendResponse({ scores: [], error: (e as Error).message });
        }
        break;
      }
      case "DRAFT_REPLY": {
        const payload = sanitizeXDraftPayload(msg);
        if (!payload) { sendResponse({ error: "invalid-x-payload" }); break; }
        try {
          const reply = await runCommentRequest("x", async (signal) => {
            const profile = await xBrokerProfile(sender);
            const groundedAnchor = findContributionAnchor(payload.anchor, payload);
            const voice = (profile[CONFIG.X_VOICE_KEY] as string) || "";
            const soul = (profile[CONFIG.X_SOUL_KEY] as string) || "";
            const sharedProducts = Array.isArray(profile[CONFIG.X_PRODUCTS_KEY])
              ? (profile[CONFIG.X_PRODUCTS_KEY] as { name?: string; url?: string; blurb?: string }[])
                  .filter((item) => item?.name?.trim())
                  .map((item) => `${item.name!.trim()}${item.blurb?.trim() ? ` — ${item.blurb.trim()}` : ""}${item.url?.trim() ? ` (${item.url.trim()})` : ""}`)
                  .join("\n")
              : "";
            const product = payload.product ?? (sharedProducts || ((profile[CONFIG.X_PRODUCT_KEY] as string) || ""));
            // Stage-1 draft context (niche + scorer rationale + author line): specificity is a ranked
            // variable in the 2026 pipeline (LLM reply grading + slop score), and these strings are
            // already known — user-message grounding stays separate from the reusable draft rules.
            const niche = (profile[CONFIG.X_NICHE_KEY] as string) || "";
            const storedModel = profile[CONFIG.X_POSTING_MODEL_KEY];
            const personalReplyLine = payload.style === "community-spark" && isPersonalPostingModel(storedModel)
              ? postingModelCommunityGuidance(storedModel, (profile[CONFIG.X_MY_HANDLE_KEY] as string) || "")
              : "";
            const extra = buildDraftContext({ action: "reply", niche, reason: payload.reason, category: payload.category, anchor: groundedAnchor?.text, replyBrief: groundedAnchor ? payload.replyBrief : undefined, authorLine: payload.authorLine, threadLine: payload.threadLine, opportunityLine: payload.opportunityLine, measuredLine: personalReplyLine || undefined });
            const continuity = selectAuthorContinuity(profile[CONFIG.X_MY_POSTS_KEY], profile[CONFIG.X_MY_HANDLE_KEY], `${payload.text}\n${payload.context || ""}`);
            return draftReply({ author: payload.author, text: payload.text, context: payload.context }, voice, payload.angle, product, payload.steer, payload.style, extra, soul, "x", signal, continuity);
          });
          sendResponse({ reply });
        } catch (e) {
          sendResponse({ error: (e as Error).message });
        }
        break;
      }
      case "OPEN_REPLY_POST": {
        if (!/^\d+$/.test(msg.postId)) { sendResponse({ ok: false, error: "invalid-post-id" }); break; }
        const post = { postId: msg.postId, author: String(msg.author || "").replace(/^@+/, "") };
        try {
          const xTabs = await chrome.tabs.query({ url: ["https://x.com/*", "https://twitter.com/*"] });
          const existing = xTabs.find((candidate) => {
            try { return statusIdFromPath(new URL(candidate.url || "").pathname) === post.postId; }
            catch { return false; }
          });
          const tab = existing?.id != null
            ? await chrome.tabs.update(existing.id, { active: true })
            : await chrome.tabs.create({ url: replyPostUrl(post), active: true });
          sendResponse({ ok: true, tabId: tab.id });
        } catch (e) {
          sendResponse({ ok: false, error: (e as Error).message });
        }
        break;
      }
      case "DRAFT_DM":
        try {
          const voice = ((await chrome.storage.local.get(CONFIG.X_VOICE_KEY))[CONFIG.X_VOICE_KEY] as string) || "";
          sendResponse({ text: await draftDm(msg, voice) });
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
          const profile = await chrome.storage.local.get([CONFIG.X_VOICE_KEY, CONFIG.X_SOUL_KEY, CONFIG.X_NICHE_KEY, CONFIG.X_MY_HANDLE_KEY, CONFIG.X_POSTING_MODEL_KEY]);
          const voice = (profile[CONFIG.X_VOICE_KEY] as string) || "";
          const soul = (profile[CONFIG.X_SOUL_KEY] as string) || "";
          const niche = (profile[CONFIG.X_NICHE_KEY] as string) || "";
          const storedModel = profile[CONFIG.X_POSTING_MODEL_KEY];
          const postingModelLine = isPersonalPostingModel(storedModel)
            ? postingModelIdeasGuidance(storedModel, (profile[CONFIG.X_MY_HANDLE_KEY] as string) || "")
            : "";
          sendResponse({ ideas: await generatePostIdeas(msg.posts, voice, niche, msg.ownPosts, msg.followers, msg.shapeLine, msg.strategyLine, soul, postingModelLine) });
        } catch (e) {
          sendResponse({ error: (e as Error).message });
        }
        break;
      case "POST_IDEA_REWRITE":
        try {
          const profile = await chrome.storage.local.get([CONFIG.X_VOICE_KEY, CONFIG.X_SOUL_KEY]);
          const voice = (profile[CONFIG.X_VOICE_KEY] as string) || "";
          const soul = (profile[CONFIG.X_SOUL_KEY] as string) || "";
          sendResponse({ text: await generatePostIdeaRewrite(msg.text, msg.steer, voice, msg.source, msg.pattern, soul) });
        } catch (e) {
          sendResponse({ error: (e as Error).message });
        }
        break;
      default:
        sendResponse({ error: "unknown message" });
    }
  })().catch((error: unknown) => {
    sendResponse({ error: error instanceof Error ? error.message : "broker-error" });
  });
  return true; // keep the channel open for the async response
});
