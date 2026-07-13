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
  X_PAUSED_KEY: "xPaused", // temporary pause — halts scanning/surfacing/API + the on-page actions until resumed
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
  X_IDEAS_KEY: "xIdeas", // persisted post-ideas drafts queue (working + shipped), survives reloads
  X_MY_POSTS_KEY: "xMyPosts", // cached: the user's own recent original posts (for idea de-dupe + voice), ~24h TTL
  X_GOOBI_SEEN_KEY: "goobiLastSeen", // last time you actively used Goobi (powers the neglect / welcome-back beat)
  X_GOOBI_FED_KEY: "goobiFed", // playground: which replies Goobi has eaten (ids) + lifetime total, so fed treats don't reappear
  X_LEARN_STATS_KEY: "xLearnStats", // engagement learning loop: own-post trend snaps + cached rest_id + daily-scan gates (per-account aggregates are derived live from the reply log)
  X_SUPPORTERS_KEY: "xSupporters", // reciprocity engine: who engages with ME (reply/mention events harvested from the notifications page DOM), device-local
  X_THREADS_DONE_KEY: "xThreadsDone", // reply postIds the user has explicitly marked DONE in "tend your threads" (device-local; pruned to the live harvest)
  X_TARGETS_KEY: "xTargets", // "Target accounts" mode: large in-reach niche accounts to comment on early, device-local
  X_AUTHOR_REACH_KEY: "xAuthorReach", // persisted author-reach cache (PUBLIC data: followers/following/bio per handle) — compounds target-selection coverage across sessions
  X_HEAVY_HITTERS_KEY: "xHeavyHitters", // persisted heavy-hitter engagement rates, stamped with the niche that produced them
  X_PROFILE_KEY: "xProfile", // own-profile harvest (pinned post id + bio length) — the profile coach's $0 input
  X_PREMIUM_KEY: "xPremium", // the user's X Premium tier ("", "premium", "premium+") — an honest covariate, NEVER a score input
  X_LEARN_LOOP_KEY: "xLearnLoop", // close-the-loop flag: when on, MEASURED per-account/per-angle outcomes influence ranking + the drafter's default angle (default OFF until the backtest proves the signal is predictive). Reversible kill switch.
  X_DEBUG_KEY: "xDebug", // dev-only: exposes window.__goobiExport() to dump the learning data (reply log + trend snaps) for backtesting. No effect on the product.
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
