import { CONFIG, isLocalhost } from "./config";
import { idleMinutes } from "./heuristics";
import { ADVISE_SYSTEM, CLASSIFY_SYSTEM, RECALL_SYSTEM } from "./prompts";
import type { AdviceResult, ClassifyResult, TabInput } from "./types";

/**
 * Smart features run one of two ways, gated on the `smartEnabled` opt-in:
 *  - BYO-key: the user's Anthropic key is in storage → call the API directly
 *    (no server to run). This is the default, simplest path.
 *  - Proxy: no key set → fall back to the managed-tier proxy.
 * Either way we only ever send id/title/url/idle — never page content.
 */

export async function isSmartEnabled(): Promise<boolean> {
  return Boolean((await chrome.storage.local.get(CONFIG.SMART_ENABLED_KEY))[CONFIG.SMART_ENABLED_KEY]);
}

export async function getKey(): Promise<string | null> {
  return ((await chrome.storage.local.get(CONFIG.ANTHROPIC_KEY_KEY))[CONFIG.ANTHROPIC_KEY_KEY] as string) || null;
}

async function authHeader(): Promise<Record<string, string>> {
  // TODO(prod): real auth token for the managed tier.
  return { Authorization: "Bearer dev-placeholder-token" };
}

function toTabInput(t: chrome.tabs.Tab, now: number): TabInput | null {
  if (t.id == null || !t.url) return null;
  return { id: t.id, title: t.title ?? "", url: t.url, lastAccessedMinutes: idleMinutes(t, now) };
}

export function tabsToInputs(tabs: chrome.tabs.Tab[]): TabInput[] {
  const now = Date.now();
  return tabs.map((t) => toTabInput(t, now)).filter((x): x is TabInput => x !== null);
}

function tabsToText(tabs: TabInput[]): string {
  return tabs.map((t) => `#${t.id} | idle ${t.lastAccessedMinutes ?? "?"}m | ${t.title} | ${t.url}`).join("\n");
}

/** Direct Anthropic call (BYO-key). Returns parsed JSON, or throws. */
async function callDirect<T>(key: string, model: string, system: string, userContent: string): Promise<T> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
      "content-type": "application/json",
    },
    body: JSON.stringify({ model, max_tokens: 4096, system, messages: [{ role: "user", content: userContent }] }),
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}`);
  const data = await res.json();
  const text = (data.content || []).filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join("");
  return JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as T;
}

export async function classify(tabs: chrome.tabs.Tab[]): Promise<ClassifyResult> {
  const inputs = tabsToInputs(tabs);
  const key = await getKey();
  if (key) {
    return callDirect<ClassifyResult>(key, "claude-haiku-4-5", CLASSIFY_SYSTEM, `Organize these ${inputs.length} tabs:\n\n${tabsToText(inputs)}`);
  }
  const res = await fetch(`${CONFIG.PROXY_BASE_URL}/api/classify`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeader()) },
    body: JSON.stringify({ tabs: inputs }),
  });
  if (!res.ok) throw new Error(`classify: proxy ${res.status}`);
  return (await res.json()) as ClassifyResult;
}

export async function advise(tabs: chrome.tabs.Tab[]): Promise<AdviceResult> {
  const now = Date.now();
  const inputs = tabsToInputs(tabs);
  const key = await getKey();
  if (key) {
    return callDirect<AdviceResult>(key, "claude-haiku-4-5", ADVISE_SYSTEM, `Tabs:\n${tabsToText(inputs)}`);
  }
  const localhost = tabs
    .filter((t) => t.url && isLocalhost(t.url))
    .map((t) => {
      let port = 0;
      try { port = Number(new URL(t.url!).port) || 0; } catch { /* ignore */ }
      return { port, title: t.title, idleMinutes: idleMinutes(t, now) };
    });
  const res = await fetch(`${CONFIG.PROXY_BASE_URL}/api/advise`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeader()) },
    body: JSON.stringify({ tabs: inputs, localhost }),
  });
  if (!res.ok) throw new Error(`advise: proxy ${res.status}`);
  return (await res.json()) as AdviceResult;
}

/* ---------- semantic recall (BYO-key) ---------- */

export interface Candidate { title: string; url: string; source: string; }
export interface RankedResult extends Candidate { why: string; }

/** Claude-ranked search over a candidate set (open tabs + archive + history). */
export async function recall(query: string, candidates: Candidate[]): Promise<RankedResult[]> {
  const key = await getKey();
  if (!key) throw new Error("no-key");
  const numbered = candidates.map((c, i) => `${i}. ${c.title} | ${c.url}`).join("\n");
  const raw = await callDirect<{ results: { i: number; why: string }[] }>(
    key,
    "claude-haiku-4-5",
    RECALL_SYSTEM,
    `Query: ${query}\n\nPages:\n${numbered}`,
  );
  return (raw.results || [])
    .map((r) => (candidates[r.i] ? { ...candidates[r.i], why: r.why } : null))
    .filter((x): x is RankedResult => x !== null);
}
