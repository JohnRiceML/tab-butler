export const CONFIG = {
  /** Archive unpinned tabs after this many minutes idle. 12h is Arc's default. */
  IDLE_THRESHOLD_MIN: 12 * 60,
  /** Don't auto-archive at all until there are at least this many open tabs. */
  MIN_TABS_BEFORE_ARCHIVE: 8,

  SCAN_ALARM: "tab-butler-scan",
  /** chrome.alarms minimum is 0.5 min; we scan every few minutes. */
  SCAN_PERIOD_MIN: 5,

  /** Your deployed proxy. Defaults to local dev. */
  PROXY_BASE_URL: "http://localhost:3000",

  // storage.local keys
  SMART_ENABLED_KEY: "smartEnabled", // privacy opt-in — Claude calls are gated on this
  ARCHIVE_KEY: "archive", // ArchivedTab[]
  UNDO_KEY: "lastArchiveBatch", // ArchivedTab[] from the most recent archive pass
} as const;

/**
 * Apps that lose unsaved state on reload — never auto-archive/discard these.
 * This list is the single most important trust guardrail; grow it deliberately.
 */
export const WEBAPP_ALLOWLIST = [
  "figma.com",
  "notion.so",
  "notion.site",
  "slack.com",
  "docs.google.com",
  "sheets.google.com",
  "slides.google.com",
  "mail.google.com",
  "calendar.google.com",
  "linear.app",
  "overleaf.com",
  "canva.com",
];

export function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** True for anything we must never auto-archive on hostname grounds. */
export function isAllowlistedHost(url: string): boolean {
  const host = hostnameOf(url);
  return WEBAPP_ALLOWLIST.some((d) => host === d || host.endsWith("." + d));
}

/** localhost / loopback / private dev hosts. */
export function isLocalhost(url: string): boolean {
  const host = hostnameOf(url);
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "0.0.0.0" ||
    host.endsWith(".local")
  );
}
