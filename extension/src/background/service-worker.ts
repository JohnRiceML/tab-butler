import { CONFIG } from "../lib/config";
import { archiveAndClose, undoLast, getArchive } from "../lib/archive";
import { advise, classify, isSmartEnabled } from "../lib/claude-client";
import { archivableTabs, groupByDomain } from "../lib/heuristics";
import type { AdviceResult, ClassifyResult, GroupSuggestion, Message } from "../lib/types";

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
