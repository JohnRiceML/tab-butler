export const CONFIG = {
  /** Archive unpinned tabs after this many minutes idle. 12h is Arc's default. */
  IDLE_THRESHOLD_MIN: 12 * 60,
  /** Don't auto-archive at all until there are at least this many open tabs. */
  MIN_TABS_BEFORE_ARCHIVE: 8,

  SCAN_ALARM: "tab-butler-scan",
  /** chrome.alarms minimum is 0.5 min; we scan every few minutes. */
  SCAN_PERIOD_MIN: 5,

  /** Your deployed proxy. Defaults to local dev (dedicated port to avoid the
   *  common :3000 collision — keep in sync with proxy's `dev` script + manifest). */
  PROXY_BASE_URL: "http://localhost:3210",

  // storage.local keys
  SMART_ENABLED_KEY: "smartEnabled", // privacy opt-in — Claude calls are gated on this
  ARCHIVE_KEY: "archive", // ArchivedTab[]
  UNDO_KEY: "lastArchiveBatch", // ArchivedTab[] from the most recent archive pass
  AUTO_DEDUPE_KEY: "autoDedupe", // background duplicate-tab merge (default on)
  ANTHROPIC_KEY_KEY: "anthropicKey", // BYO key — lets Smart run with no proxy
  X_COPILOT_KEY: "xCopilotEnabled", // X reply copilot on/off (default on)
  X_NICHE_KEY: "xNiche", // what posts are worth replying to
  X_VOICE_KEY: "xVoice", // reply voice / examples
  X_PRODUCT_KEY: "xProduct", // legacy single-product string (fallback)
  X_PRODUCTS_KEY: "xProducts", // ProductItem[] — the user's products, for relevance-tagged promotion
  X_DEFAULT_ANGLE_KEY: "xDefaultAngle", // preferred default reply angle ("" = auto, else a REPLY_ANGLES id)
  X_DEFAULT_PRODUCT_KEY: "xDefaultProduct", // preferred product to promote ("" = auto best-fit, else product name)
  TWTTR_KEY_KEY: "twttrKey", // BYO RapidAPI key for the Twttr X-data API (read-only enrichment)
  TWTTR_HOST: "twitter241.p.rapidapi.com", // fixed provider host — the parsers are written for this shape. Not a secret, not user-set.
  X_MY_HANDLE_KEY: "xMyHandle", // the user's own X handle — powers voice-learning + the reach sweet-spot
  X_MY_FOLLOWERS_KEY: "xMyFollowers", // the user's own follower count, for the reach sweet-spot ratio
  X_REPLY_LOG_KEY: "xReplyLog", // cross-session reply-reputation log (rate + repeat-author + duplicate-reply guards)
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
