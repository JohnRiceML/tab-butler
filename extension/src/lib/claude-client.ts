import { CONFIG, isLocalhost } from "./config";
import { idleMinutes } from "./heuristics";
import type { AdviceResult, ClassifyResult, TabInput } from "./types";

/**
 * Talks to the managed-tier proxy. ALL of this is gated on the user's explicit
 * privacy opt-in (`smartEnabled`). We only ever send id/title/url/idle —
 * never page content.
 */

export async function isSmartEnabled(): Promise<boolean> {
  const got = await chrome.storage.local.get(CONFIG.SMART_ENABLED_KEY);
  return Boolean(got[CONFIG.SMART_ENABLED_KEY]);
}

/** TODO(prod): real auth token for the managed tier. */
async function authHeader(): Promise<Record<string, string>> {
  return { Authorization: "Bearer dev-placeholder-token" };
}

function toTabInput(t: chrome.tabs.Tab, now: number): TabInput | null {
  if (t.id == null || !t.url) return null;
  return {
    id: t.id,
    title: t.title ?? "",
    url: t.url,
    lastAccessedMinutes: idleMinutes(t, now),
  };
}

export function tabsToInputs(tabs: chrome.tabs.Tab[]): TabInput[] {
  const now = Date.now();
  return tabs.map((t) => toTabInput(t, now)).filter((x): x is TabInput => x !== null);
}

export async function classify(tabs: chrome.tabs.Tab[]): Promise<ClassifyResult> {
  const res = await fetch(`${CONFIG.PROXY_BASE_URL}/api/classify`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeader()) },
    body: JSON.stringify({ tabs: tabsToInputs(tabs) }),
  });
  if (!res.ok) throw new Error(`classify: proxy ${res.status}`);
  return (await res.json()) as ClassifyResult;
}

export async function advise(tabs: chrome.tabs.Tab[]): Promise<AdviceResult> {
  const now = Date.now();
  const localhost = tabs
    .filter((t) => t.url && isLocalhost(t.url))
    .map((t) => {
      let port = 0;
      try {
        port = Number(new URL(t.url!).port) || 0;
      } catch {
        /* ignore */
      }
      return { port, title: t.title, idleMinutes: idleMinutes(t, now) };
    });

  const res = await fetch(`${CONFIG.PROXY_BASE_URL}/api/advise`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeader()) },
    body: JSON.stringify({ tabs: tabsToInputs(tabs), localhost }),
  });
  if (!res.ok) throw new Error(`advise: proxy ${res.status}`);
  return (await res.json()) as AdviceResult;
}
