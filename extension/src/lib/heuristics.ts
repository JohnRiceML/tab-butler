import { hostnameOf, isAllowlistedHost, CONFIG } from "./config";

/**
 * Offline, on-device heuristics. These ship in v1 and run with NO network —
 * they're the always-on base layer beneath the optional Claude "smart" layer.
 */

/** Naive registrable domain: last two labels (good enough for grouping). */
function registrableDomain(url: string): string {
  const host = hostnameOf(url);
  if (!host) return "";
  const parts = host.split(".");
  return parts.length <= 2 ? host : parts.slice(-2).join(".");
}

/** Normalize a URL for duplicate detection (strip hash, trailing slash, utm_*). */
export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    for (const k of [...u.searchParams.keys()]) {
      if (k.startsWith("utm_") || k === "ref" || k === "fbclid") {
        u.searchParams.delete(k);
      }
    }
    let s = u.toString();
    if (s.endsWith("/")) s = s.slice(0, -1);
    return s;
  } catch {
    return url;
  }
}

/** Group tabs by registrable domain. Returns domain -> tab ids (size >= 2). */
export function groupByDomain(
  tabs: chrome.tabs.Tab[],
): Map<string, number[]> {
  const byDomain = new Map<string, number[]>();
  for (const t of tabs) {
    if (t.id == null || !t.url) continue;
    const d = registrableDomain(t.url);
    if (!d) continue;
    const ids = byDomain.get(d) ?? [];
    ids.push(t.id);
    byDomain.set(d, ids);
  }
  for (const [d, ids] of byDomain) {
    if (ids.length < 2) byDomain.delete(d);
  }
  return byDomain;
}

/**
 * Which tabs are safe to auto-archive right now: idle past the threshold and
 * not pinned/active/audible/allowlisted. This is the conservative gate that
 * keeps the product trustworthy.
 */
export function archivableTabs(
  tabs: chrome.tabs.Tab[],
  now: number,
  thresholdMin = CONFIG.IDLE_THRESHOLD_MIN,
): chrome.tabs.Tab[] {
  if (tabs.length < CONFIG.MIN_TABS_BEFORE_ARCHIVE) return [];
  return tabs.filter((t) => {
    if (t.id == null || !t.url) return false;
    if (t.pinned || t.active || t.audible) return false;
    if (!t.url.startsWith("http")) return false; // leave chrome://, file://, etc.
    if (isAllowlistedHost(t.url)) return false;
    const lastAccessed = (t as chrome.tabs.Tab & { lastAccessed?: number }).lastAccessed;
    if (lastAccessed == null) return false; // unknown → don't touch
    const idleMin = (now - lastAccessed) / 60000;
    return idleMin >= thresholdMin;
  });
}

/** Minutes since a tab was last active (undefined if unknown). */
export function idleMinutes(t: chrome.tabs.Tab, now: number): number | undefined {
  const lastAccessed = (t as chrome.tabs.Tab & { lastAccessed?: number }).lastAccessed;
  if (lastAccessed == null) return undefined;
  return Math.round((now - lastAccessed) / 60000);
}
